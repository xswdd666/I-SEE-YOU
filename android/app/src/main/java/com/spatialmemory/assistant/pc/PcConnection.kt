package com.spatialmemory.assistant.pc

import android.content.Context
import android.net.Uri
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.Base64
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager
import okhttp3.OkHttpClient
import org.json.JSONObject
import org.json.JSONArray
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.CancellationException
import okhttp3.Request

data class PcProfile(val host: String,val port: Int,val fingerprint: String,val token: String) {
    val origin get()="https://$host:$port"
    override fun toString()="PcProfile(host=$host, port=$port, paired=true)"
    fun pairAddress(): String=Uri.Builder().scheme("iseeyou-pc").authority("pair").appendQueryParameter("host",host).appendQueryParameter("port",port.toString()).appendQueryParameter("fingerprint",fingerprint).appendQueryParameter("token",token).build().toString()
    fun http(): OkHttpClient {
        val trust=object: X509TrustManager {
            override fun getAcceptedIssuers()=emptyArray<X509Certificate>()
            override fun checkClientTrusted(chain: Array<X509Certificate>?,authType: String?) { error("Client certificates are not supported") }
            override fun checkServerTrusted(chain: Array<X509Certificate>?,authType: String?) {
                val certificate=chain?.firstOrNull() ?: error("Missing PC certificate")
                certificate.checkValidity()
                val actual=MessageDigest.getInstance("SHA-256").digest(certificate.encoded).joinToString("") { "%02x".format(it) }
                require(actual==fingerprint) { "电脑身份发生变化，请重新连接电脑" }
            }
        }
        val tls=SSLContext.getInstance("TLS").apply { init(null,arrayOf(trust),SecureRandom()) }
        return OkHttpClient.Builder().sslSocketFactory(tls.socketFactory,trust).hostnameVerifier { hostname,_ -> hostname==host }
            .followRedirects(false).followSslRedirects(false).connectTimeout(8,TimeUnit.SECONDS).readTimeout(0,TimeUnit.SECONDS).callTimeout(60,TimeUnit.SECONDS).pingInterval(5,TimeUnit.SECONDS).build()
    }
    companion object {
        fun parse(raw: String): PcProfile {
            val uri=Uri.parse(raw.trim())
            require(uri.scheme=="iseeyou-pc"&&uri.host=="pair"&&uri.userInfo==null&&uri.fragment==null&&uri.queryParameterNames==setOf("host","port","fingerprint","token")) { "电脑连接地址无效" }
            val host=uri.getQueryParameter("host").orEmpty()
            require(Regex("^(?:127\\.0\\.0\\.1|10\\.(?:[0-9]{1,3}\\.){2}[0-9]{1,3}|192\\.168\\.[0-9]{1,3}\\.[0-9]{1,3}|172\\.(?:1[6-9]|2[0-9]|3[01])\\.[0-9]{1,3}\\.[0-9]{1,3})$").matches(host)&&host.split('.').all { it.toInt() in 0..255 }) { "请使用电脑的局域网地址" }
            val port=uri.getQueryParameter("port")?.toIntOrNull() ?: error("电脑端口无效")
            val fingerprint=uri.getQueryParameter("fingerprint").orEmpty();val token=uri.getQueryParameter("token").orEmpty()
            require(port in 1024..65535&&fingerprint.matches(Regex("[a-f0-9]{64}"))&&token.matches(Regex("[A-Za-z0-9_-]{43}"))) { "电脑连接地址不完整" }
            return PcProfile(host,port,fingerprint,token)
        }
    }
}

/** Pairing is scoped to this app. No system certificates, proxy or Wi-Fi changes. */
class PcConnection(context: Context) {
    private val discovery=PcLanDiscovery(context)
    private val prefs=context.getSharedPreferences("pc-private",Context.MODE_PRIVATE)
    private val alias="iseeyou.pc.pairing"
    private fun secret(): SecretKey {
        val keys=KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        return (keys.getKey(alias,null) as? SecretKey) ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    fun save(raw: String) {
        PcProfile.parse(raw)
        val cipher=Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE,secret()) }
        val encrypted=cipher.doFinal(raw.toByteArray(Charsets.UTF_8))
        check(prefs.edit().putString("data",Base64.getEncoder().encodeToString(encrypted)).putString("iv",Base64.getEncoder().encodeToString(cipher.iv)).commit())
    }
    fun read(): PcProfile?=runCatching {
        val encrypted=prefs.getString("data",null) ?: return null
        val cipher=Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE,secret(),GCMParameterSpec(128,Base64.getDecoder().decode(prefs.getString("iv",null)))) }
        PcProfile.parse(String(cipher.doFinal(Base64.getDecoder().decode(encrypted)),Charsets.UTF_8))
    }.getOrNull()
    private fun knownHosts(profile: PcProfile): List<String> = runCatching {
        if(prefs.getString("lan-identity",null)!=profile.fingerprint)return emptyList()
        val entries=JSONArray(prefs.getString("lan-hosts","[]"))
        (0 until entries.length()).map { entries.getString(it) }.filter { PcLanPolicy.privateHost(it) }.distinct().take(8)
    }.getOrDefault(emptyList())
    fun rememberHosts(profile: PcProfile,entries: JSONArray?) {
        val hosts=buildList { if(PcLanPolicy.privateHost(profile.host))add(profile.host);if(entries!=null)for(index in 0 until entries.length())add(entries.optString(index)) }
            .filter { PcLanPolicy.privateHost(it) }.distinct().take(8)
        prefs.edit().putString("lan-identity",profile.fingerprint).putString("lan-hosts",JSONArray(hosts).toString()).apply()
    }
    fun http(profile: PcProfile): OkHttpClient {
        val base=profile.http()
        val network=discovery.networkFor(profile.host)?:return base
        return base.newBuilder().socketFactory(network.socketFactory).build()
    }
    fun networkHandle(profile: PcProfile): Long=discovery.networkFor(profile.host)?.networkHandle?:0L
    suspend fun resolve(): PcProfile {
        val paired=read()?:error("请先连接一次电脑进行配对；之后在同一可互通局域网可自动连接。")
        var probes=0
        val resolver=PcEndpointResolver(
            discover={ profile -> try { discovery.find(profile,knownHosts(profile)) } catch(error: CancellationException){throw error} catch(_: Exception){emptyList()} },
            remembered=::knownHosts,
            probe={ profile -> if(probes++>=5)false else withContext(Dispatchers.IO) {
                try {
                    val client=http(profile).newBuilder().connectTimeout(700,TimeUnit.MILLISECONDS).readTimeout(900,TimeUnit.MILLISECONDS).callTimeout(1200,TimeUnit.MILLISECONDS).build()
                    try { client.newCall(Request.Builder().url(profile.origin+"/v1/status").header("Authorization","Bearer "+profile.token).build()).execute().use { response ->
                        if(!response.isSuccessful)false else {
                            val body=JSONObject(response.body?.string().orEmpty())
                            body.optString("app")=="I SEE YOU PC"&&!body.optBoolean("sandbox",false)
                        }
                    } } finally { client.connectionPool.evictAll();client.dispatcher.executorService.shutdown() }
                } catch(error: CancellationException){throw error} catch(_: Exception){false}
            } },
            save={ profile -> save(profile.pairAddress()) },
        )
        return resolver.resolve(paired)
    }
}
