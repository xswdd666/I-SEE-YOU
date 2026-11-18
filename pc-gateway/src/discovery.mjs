import {createSocket} from 'node:dgram';
import {isIP} from 'node:net';

export const DISCOVERY_PROTOCOL='iseeyou-discover/v1';
export const DISCOVERY_PORT=8766;
export const localAddress=ip=>isIP(ip)===4&&(ip==='127.0.0.1'||/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip));
export function discoveryReply(raw,{port,fingerprint},peer){
 if(!localAddress(peer)||raw.length>512)return null;
 let request;try{request=JSON.parse(raw.toString('utf8'));}catch{return null;}
 if(!request||Array.isArray(request)||Object.keys(request).sort().join(',')!=='nonce,protocol'||request.protocol!==DISCOVERY_PROTOCOL||!/^[a-f0-9]{32}$/.test(request.nonce))return null;
 if(!Number.isInteger(port)||port<1024||port>65535||!/^[a-f0-9]{64}$/.test(fingerprint))return null;
 // The known certificate identity is public. Never advertise a pairing token,
 // account, memory, image, computer username or arbitrary request properties.
 return Buffer.from(JSON.stringify({protocol:DISCOVERY_PROTOCOL,nonce:request.nonce,port,fingerprint}));
}
export async function startDiscovery({port,fingerprint,discoveryPort=DISCOVERY_PORT,host='0.0.0.0',now=Date.now}={}){
 const socket=createSocket('udp4'),peers=new Map();let ready=false;
 socket.on('message',(raw,peer)=>{
  const reply=discoveryReply(raw,{port,fingerprint},peer.address);if(!reply)return;
  const time=now(),previous=peers.get(peer.address);
  if(previous&&time-previous.at<1000&&previous.count>=8)return;
  if(peers.size>256)for(const [address,value]of peers)if(time-value.at>1000)peers.delete(address);
  if(peers.size>256&&!previous)return;
  peers.set(peer.address,{at:previous&&time-previous.at<1000?previous.at:time,count:previous&&time-previous.at<1000?previous.count+1:1});
  socket.send(reply,peer.port,peer.address,()=>{});
 });
 try{await new Promise((resolve,reject)=>{socket.once('error',reject);socket.bind(discoveryPort,host,resolve);});}
 catch(error){try{socket.close();}catch{}throw error;}
 ready=true;socket.removeAllListeners('error');socket.on('error',()=>{ready=false;});socket.unref();
 return {get ready(){return ready;},port:socket.address().port,async close(){ready=false;await new Promise(resolve=>{try{socket.close(resolve);}catch{resolve();}});}};
}
