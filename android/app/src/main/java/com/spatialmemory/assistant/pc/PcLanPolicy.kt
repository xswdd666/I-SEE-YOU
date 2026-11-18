package com.spatialmemory.assistant.pc

/** Discovery suggests endpoints; authenticated pinned TLS establishes trust. */
object PcLanPolicy {
    const val PROTOCOL="iseeyou-discover/v1"
    const val PORT=8766
    fun privateHost(host: String,allowUsb: Boolean=false): Boolean {
        val parts=host.split('.').map { it.toIntOrNull() ?: return false }
        if(parts.size!=4||parts.any { it !in 0..255 }||parts.joinToString(".")!=host)return false
        return allowUsb&&host=="127.0.0.1"||parts[0]==10||parts[0]==192&&parts[1]==168||parts[0]==172&&parts[1] in 16..31
    }
    fun acceptOffer(host: String,port: Int,protocol: String,nonce: String,expectedNonce: String,fingerprint: String,expectedFingerprint: String): Boolean =
        privateHost(host)&&port in 1024..65535&&protocol==PROTOCOL&&nonce==expectedNonce&&
        Regex("[a-f0-9]{32}").matches(nonce)&&Regex("[a-f0-9]{64}").matches(fingerprint)&&fingerprint==expectedFingerprint
}

class PcEndpointResolver(
    private val discover: suspend (PcProfile)->List<PcProfile>,
    private val remembered: (PcProfile)->List<String>,
    private val probe: suspend (PcProfile)->Boolean,
    private val save: (PcProfile)->Unit,
) {
    suspend fun resolve(paired: PcProfile): PcProfile {
        val offered=discover(paired).filter { it.fingerprint==paired.fingerprint&&it.token==paired.token&&PcLanPolicy.privateHost(it.host) }
        val lan=buildList {
            addAll(offered)
            if(paired.host!="127.0.0.1")add(paired)
            addAll(remembered(paired).filter { PcLanPolicy.privateHost(it) }.take(8).map { paired.copy(host=it) })
        }
        val candidates=lan.distinctBy { it.host to it.port }.take(4)+paired.copy(host="127.0.0.1")
        for(candidate in candidates)if(probe(candidate)){
            if(candidate!=paired)save(candidate)
            return candidate
        }
        throw java.io.IOException("未能连接已配对的电脑。请确认电脑服务已开启，局域网允许设备互访；同一Wi-Fi名称不代表网络一定互通。应用会自动重试。")
    }
}
