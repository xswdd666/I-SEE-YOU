package com.spatialmemory.assistant.hardware

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.ParcelUuid
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.content.ContextCompat
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.random.Random

// shortcut: deployed firmware uses the legacy encrypted GATT service; migrate both ends for official Security1/2 + PoP validation.
class Esp32Provisioner(private val context: Context) : DeviceProvisioner {
    private val mutableState = MutableStateFlow(ProvisionState.IDLE)
    private val devices = ConcurrentHashMap<String, ScanResult>()
    private var gatt: BluetoothGatt? = null
    private var connectionCallback: ProvisionCallback? = null
    private var connectedDeviceId: String? = null
    private val gattOperations = Mutex()
    override val state = mutableState.asStateFlow()

    @SuppressLint("MissingPermission")
    override suspend fun scan(): List<DeviceCandidate> {
        requireBlePermissions()
        val scanner = adapter().bluetoothLeScanner ?: error("蓝牙未开启")
        devices.clear()
        mutableState.value = ProvisionState.SCANNING
        val callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) { devices[result.device.address] = result }
            override fun onBatchScanResults(results: MutableList<ScanResult>) { results.forEach { devices[it.device.address] = it } }
            override fun onScanFailed(errorCode: Int) { mutableState.value = ProvisionState.FAILED }
        }
        try {
            scanner.startScan(
                listOf(ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE_UUID)).build()),
                ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(),
                callback,
            )
            delay(5_000)
            check(mutableState.value != ProvisionState.FAILED) { "蓝牙扫描失败，请重试" }
        } finally { scanner.stopScan(callback) }
        mutableState.value = ProvisionState.IDLE
        return devices.values.sortedByDescending { it.rssi }.map {
            DeviceCandidate(it.device.address, it.scanRecord?.deviceName ?: "视障相机", it.rssi)
        }
    }

    @SuppressLint("MissingPermission")
    suspend fun connect(deviceId: String) {
        requireBlePermissions()
        cancel()
        val result = devices[deviceId] ?: error("请先扫描并选择设备")
        mutableState.value = ProvisionState.CONNECTING
        val callback = ProvisionCallback()
        try {
            val connection = result.device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE)
                ?: error("无法建立蓝牙连接")
            gatt = connection
            connectionCallback = callback
            withTimeout(10_000) { callback.ready.await() }
            // Use the default MTU so connection readiness never races an MTU callback.
            connectedDeviceId = deviceId
            mutableState.value = ProvisionState.BLE_CONNECTED
        } catch (error: Throwable) {
            cancel()
            mutableState.value = ProvisionState.FAILED
            throw error
        }
    }

    @SuppressLint("MissingPermission")
    override suspend fun provision(deviceId: String, ssid: String, password: CharArray): ProvisionResult {
        return gattOperations.withLock { try {
            require(ssid.isNotBlank() && ssid.toByteArray(Charsets.UTF_8).size <= 32) { "WiFi 名称无效" }
            require(password.isEmpty() || validWifiPassword(java.nio.CharBuffer.wrap(password))) { "WiFi 密码格式无效" }
            if (connectedDeviceId != deviceId) connect(deviceId)
            val connected = checkNotNull(gatt)
            val callback = checkNotNull(connectionCallback)
            val before = readNetwork(connected, callback)
            check(!before.optBoolean("connected")) { "设备已经配网。如需更换 WiFi，请先将设备重置到配网模式" }
            writeChunks(connected, callback, SSID_UUID, ssid.toByteArray(Charsets.UTF_8))
            val passwordBytes = ByteArray(password.size) { password[it].code.toByte() }
            try { writeChunks(connected, callback, PASSWORD_UUID, passwordBytes) } finally { passwordBytes.fill(0) }
            writeChunks(connected, callback, COMMAND_UUID, "commit".toByteArray())
            val network = readNetwork(connected, callback)
            check(network.optBoolean("connected") && network.optString("ip") != "0.0.0.0") {
                when (network.optInt("wifiStatus", -1)) {
                    1 -> "设备找不到该 WiFi，请确认名称正确且已开启 2.4 GHz"
                    4 -> "WiFi 认证失败，请检查密码或 WPA 认证方式"
                    else -> "设备未连上 WiFi，请检查密码与 2.4 GHz 网络"
                }
            }
            mutableState.value = ProvisionState.CONNECTED
            ProvisionResult.Success(network.optString("deviceId", deviceId), "http://${network.getString("ip")}", network.optString("token"))
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            mutableState.value = ProvisionState.FAILED
            ProvisionResult.Failure(error.message ?: "BLE 配网失败")
        } finally {
            password.fill('\u0000')
            closeConnection()
        } }
    }

    suspend fun isWifiConnected(): Boolean {
        val network = readNetwork(checkNotNull(gatt), checkNotNull(connectionCallback))
        return network.optBoolean("connected") && network.optString("ip").let { it.isNotBlank() && it != "0.0.0.0" }
    }

    /** Returns the current IP/token over encrypted BLE; null means Wi-Fi is not connected. */
    suspend fun readConnection(deviceId: String): Esp32Connection? = gattOperations.withLock {
        try {
            if (connectedDeviceId != deviceId) connect(deviceId)
            val info = readNetwork(checkNotNull(gatt), checkNotNull(connectionCallback))
            val ip = info.optString("ip")
            if (!info.optBoolean("connected") || ip.isBlank() || ip == "0.0.0.0") return@withLock null
            val token = info.optString("token")
            check(token.isNotBlank()) { "设备未返回视频访问凭证" }
            Esp32Connection("http://$ip", "http://$ip:81/stream", info.optString("deviceId"), token)
        } finally { closeConnection() }
    }

    suspend fun setLed(deviceId: String, on: Boolean) = gattOperations.withLock {
        if (connectedDeviceId != deviceId) connect(deviceId)
        val connected = checkNotNull(gatt)
        val callback = checkNotNull(connectionCallback)
        try {
            writeChunks(connected, callback, COMMAND_UUID, (if (on) "led_on" else "led_off").toByteArray(Charsets.UTF_8))
            val state = readNetwork(connected, callback)
            check(state.has("ledOn")) { "固件不支持控灯，请烧录新版喵喵固件" }
            check(state.getBoolean("ledOn") == on) { "设备未确认灯状态，请重试" }
        } finally { closeConnection() }
    }

    @SuppressLint("MissingPermission")
    private suspend fun readNetwork(gatt: BluetoothGatt, callback: ProvisionCallback): org.json.JSONObject {
        val characteristic = gatt.getService(SERVICE_UUID)?.getCharacteristic(NETWORK_UUID) ?: error("设备缺少网络信息")
        callback.nextRead = CompletableDeferred()
        check(gatt.readCharacteristic(characteristic)) { "无法读取设备网络信息" }
        return org.json.JSONObject(String(withTimeout(5_000) { callback.nextRead.await() }, Charsets.UTF_8))
    }

    @SuppressLint("MissingPermission")
    override suspend fun cancel() {
        closeConnection()
        mutableState.value = ProvisionState.IDLE
    }

    @SuppressLint("MissingPermission")
    private fun closeConnection() {
        connectionCallback?.ready?.cancel()
        gatt?.disconnect(); gatt?.close(); gatt = null
        connectionCallback = null; connectedDeviceId = null
    }

    @SuppressLint("MissingPermission")
    private suspend fun writeChunks(gatt: BluetoothGatt, callback: ProvisionCallback, uuid: UUID, payload: ByteArray) {
        val characteristic = gatt.getService(SERVICE_UUID)?.getCharacteristic(uuid) ?: error("设备配网协议不完整")
        // Default ATT payload is 20 bytes, including our 10-byte packet header.
        val packets = provisionPackets(payload, Random.nextInt(), 10)
        try {
        packets.forEach { data ->
            callback.nextWrite = CompletableDeferred()
            val accepted = if (Build.VERSION.SDK_INT >= 33) {
                gatt.writeCharacteristic(characteristic, data, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == BluetoothStatusCodes.SUCCESS
            } else {
                @Suppress("DEPRECATION")
                characteristic.value = data
                @Suppress("DEPRECATION")
                gatt.writeCharacteristic(characteristic)
            }
            check(accepted) { "BLE 写入未被设备接受" }
            withTimeout(if (uuid == COMMAND_UUID) 25_000 else 5_000) { callback.nextWrite.await() }
        }
        } finally { packets.forEach { it.fill(0) } }
    }

    private fun adapter(): BluetoothAdapter = (context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter

    private fun requireBlePermissions() {
        val permissions = if (Build.VERSION.SDK_INT >= 31) arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT) else arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
        check(permissions.all { ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED }) { "请先授予附近设备权限" }
    }

    private class ProvisionCallback : BluetoothGattCallback() {
        private var cacheRefreshAttempted = false
        private val handler = Handler(Looper.getMainLooper())
        val ready = CompletableDeferred<Unit>()
        var nextWrite = CompletableDeferred<Unit>()
        var nextRead = CompletableDeferred<ByteArray>()
        @SuppressLint("MissingPermission")
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) ready.completeExceptionally(IllegalStateException("BLE 连接失败：$status"))
            else if (newState == BluetoothGatt.STATE_CONNECTED) gatt.discoverServices()
            else if (newState == BluetoothGatt.STATE_DISCONNECTED) {
                val error = IllegalStateException("BLE 已断开，请重新搜索设备")
                ready.completeExceptionally(error)
                nextRead.completeExceptionally(error)
                nextWrite.completeExceptionally(error)
            }
        }
        @SuppressLint("MissingPermission")
        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            if (ready.isCompleted) return
            val service = gatt.getService(SERVICE_UUID)
            val complete = service != null && listOf(SSID_UUID, PASSWORD_UUID, COMMAND_UUID, NETWORK_UUID).all { service.getCharacteristic(it) != null }
            if (status == BluetoothGatt.GATT_SUCCESS && complete) {
                Log.i("BV-GATT", "camera service ready; cacheRefreshed=$cacheRefreshAttempted")
                ready.complete(Unit)
                return
            }
            Log.w("BV-GATT", "service discovery status=$status UUIDs=${gatt.services.map { it.uuid }}")
            if (status == BluetoothGatt.GATT_SUCCESS && !cacheRefreshAttempted) {
                cacheRefreshAttempted = true
                // Android can cache the previous firmware's GATT table under the same ESP32 MAC.
                val refreshed = runCatching { gatt.javaClass.getMethod("refresh").invoke(gatt) == true }.getOrDefault(false)
                if (refreshed) {
                    handler.postDelayed({
                        if (!ready.isCompleted && !gatt.discoverServices()) {
                            ready.completeExceptionally(IllegalStateException("无法重新发现设备服务，请关闭再打开手机蓝牙后重试"))
                        }
                    }, 800)
                    return
                }
            }
            ready.completeExceptionally(IllegalStateException("未发现完整视障相机配网服务（状态 $status），请关闭再打开手机蓝牙后重新扫描"))
        }
        override fun onCharacteristicWrite(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS) nextWrite.complete(Unit)
            else nextWrite.completeExceptionally(IllegalStateException("BLE 写入失败：$status"))
        }
        @Deprecated("Deprecated in Java")
        override fun onCharacteristicRead(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            @Suppress("DEPRECATION")
            completeRead(characteristic.value ?: ByteArray(0), status)
        }
        override fun onCharacteristicRead(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray, status: Int) = completeRead(value, status)
        private fun completeRead(value: ByteArray, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS) nextRead.complete(value)
            else nextRead.completeExceptionally(IllegalStateException("BLE 读取失败：$status"))
        }
    }

    companion object {
        val SERVICE_UUID: UUID = UUID.fromString("62f10000-7a2e-4b79-9c81-a64e5532b001")
        val SSID_UUID: UUID = UUID.fromString("62f10002-7a2e-4b79-9c81-a64e5532b001")
        val PASSWORD_UUID: UUID = UUID.fromString("62f10003-7a2e-4b79-9c81-a64e5532b001")
        val COMMAND_UUID: UUID = UUID.fromString("62f10004-7a2e-4b79-9c81-a64e5532b001")
        val NETWORK_UUID: UUID = UUID.fromString("62f10006-7a2e-4b79-9c81-a64e5532b001")
    }
}
