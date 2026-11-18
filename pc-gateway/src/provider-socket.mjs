import {WebSocket} from 'ws';
import {HttpsProxyAgent} from 'https-proxy-agent';

// ws does not use HTTP_PROXY/HTTPS_PROXY automatically, unlike the existing CLI tools.
export function providerSocket(url,options) {
 const proxy=process.env.HTTPS_PROXY||process.env.HTTP_PROXY;
 return new WebSocket(url,{...options,...(proxy?{agent:new HttpsProxyAgent(proxy)}:{})});
}
