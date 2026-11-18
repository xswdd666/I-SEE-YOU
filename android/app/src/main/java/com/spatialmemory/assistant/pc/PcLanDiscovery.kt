package com.spatialmemory.assistant.pc

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Network
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.util.UUID

class PcLanDiscovery(context: Context) {
    private val manager=context.applicationContext.getSystemService(ConnectivityManager::class.java)
    private fun localNetworks()=manager.allNetworks.filter { network ->
        val capabilities=manager.getNetworkCapabilities(network)
        capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)==true||capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)==true
    }.take(2)
    fun networkFor(host: String): Network? {
        if(!PcLanPolicy.privateHost(host))return null
        val networks=localNetworks()
        val target=host.split('.').fold(0L) { value,part -> (value shl 8) or part.toLong() }
        return networks.firstOrNull { network -> manager.getLinkProperties(network)?.linkAddresses.orEmpty().any { link ->
            if(link.address !is Inet4Address)return@any false
            val ip=link.address.address.fold(0L) { value,byte -> (value shl 8) or (byte.toLong() and 255) }
            val mask=(0xffffffffL shl (32-link.prefixLength)) and 0xffffffffL
            (target and mask)==(ip and mask)
        } }?:networks.firstOrNull()
    }
    suspend fun find(paired: PcProfile,known: List<String>): List<PcProfile> = withContext(Dispatchers.IO) {
        val found=linkedMapOf<String,PcProfile>()
        val networks=localNetworks()
        for(network in networks){
            currentCoroutineContext().ensureActive()
            val links=manager.getLinkProperties(network)?.linkAddresses.orEmpty().filter { it.address is Inet4Address&&it.prefixLength in 8..30 }
            if(links.isEmpty())continue
            val broadcasts=links.map { link ->
                val ip=link.address.address.fold(0L) { value,byte -> (value shl 8) or (byte.toLong() and 255) }
                val mask=(0xffffffffL shl (32-link.prefixLength)) and 0xffffffffL
                val address=(ip and mask) or (mask xor 0xffffffffL)
                InetAddress.getByAddress(ByteArray(4) { index -> ((address shr (24-index*8)) and 255).toByte() })
            }
            val targets=(broadcasts+listOfNotNull(paired.host.takeIf { PcLanPolicy.privateHost(it) }) .plus(known.filter { PcLanPolicy.privateHost(it) }.take(4)).map { InetAddress.getByName(it) }).distinctBy { it.hostAddress }
            val nonce=UUID.randomUUID().toString().replace("-","")
            val bytes=JSONObject().put("protocol",PcLanPolicy.PROTOCOL).put("nonce",nonce).toString().toByteArray(Charsets.UTF_8)
            DatagramSocket().use { socket ->
                network.bindSocket(socket);socket.broadcast=true
                for(address in targets)runCatching { socket.send(DatagramPacket(bytes,bytes.size,address,PcLanPolicy.PORT)) }
                val deadline=System.nanoTime()+700_000_000L
                var replies=0
                while(System.nanoTime()<deadline&&replies++<24){
                    currentCoroutineContext().ensureActive();socket.soTimeout=((deadline-System.nanoTime())/1_000_000L).toInt().coerceIn(1,700)
                    val packet=DatagramPacket(ByteArray(2048),2048)
                    try { socket.receive(packet) } catch(_: SocketTimeoutException){break}
                    val body=runCatching { JSONObject(String(packet.data,packet.offset,packet.length,Charsets.UTF_8)) }.getOrNull()?:continue
                    val host=packet.address.hostAddress?:continue
                    val port=body.optInt("port",0)
                    if(PcLanPolicy.acceptOffer(host,port,body.optString("protocol"),body.optString("nonce"),nonce,body.optString("fingerprint"),paired.fingerprint)){
                        found[host]=paired.copy(host=host,port=port)
                    }
                }
            }
            if(found.isNotEmpty())break
        }
        found.values.toList()
    }
}
