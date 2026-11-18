import test from 'node:test';
import assert from 'node:assert/strict';
import {createSocket} from 'node:dgram';
import {once} from 'node:events';
import {discoveryReply,startDiscovery,DISCOVERY_PROTOCOL,localAddress} from '../src/discovery.mjs';
const nonce='a'.repeat(32),fingerprint='b'.repeat(64),options={port:8765,fingerprint};
const request=Buffer.from(JSON.stringify({protocol:DISCOVERY_PROTOCOL,nonce}));
test('discovery discloses only a known public certificate identity and challenge, never pairing credentials',()=>{
 const reply=JSON.parse(discoveryReply(request,{...options,token:'do-not-advertise',user:'private',memory:'private'},'192.168.2.5'));
 assert.deepEqual(reply,{protocol:DISCOVERY_PROTOCOL,nonce,port:8765,fingerprint});
 assert.equal(discoveryReply(Buffer.from(JSON.stringify({protocol:DISCOVERY_PROTOCOL,nonce,token:'injected'})),options,'192.168.2.5'),null);
});
test('untrusted, malformed and public-network discovery requests do not receive responses',()=>{
 for(const peer of ['8.8.8.8','198.18.0.1','169.254.1.1','999.1.1.1'])assert.equal(discoveryReply(request,options,peer),null,peer);
 for(const raw of ['null','[]','{',JSON.stringify({protocol:'other',nonce}),JSON.stringify({protocol:DISCOVERY_PROTOCOL,nonce:'bad'}),'x'.repeat(513)])assert.equal(discoveryReply(Buffer.from(raw),options,'10.1.1.2'),null,raw);
 assert(localAddress('172.16.9.231'));assert(localAddress('10.1.1.165'));
});
test('real UDP discovery replies on its socket, enforces rate limits and closes cleanly',async t=>{
 const service=await startDiscovery({...options,discoveryPort:0,host:'127.0.0.1'});t.after(()=>service.close());
 const client=createSocket('udp4');t.after(()=>client.close());client.bind(0,'127.0.0.1');await once(client,'listening');
 const reply=once(client,'message');client.send(request,service.port,'127.0.0.1');
 assert.deepEqual(JSON.parse((await reply)[0]),{protocol:DISCOVERY_PROTOCOL,nonce,port:8765,fingerprint});
 let count=0;client.on('message',()=>count++);
 for(let n=0;n<16;n++)client.send(request,service.port,'127.0.0.1');
 await new Promise(resolve=>setTimeout(resolve,100));assert(count<=7);assert.equal(service.ready,true);
});
test('a busy discovery port fails without leaving an extra live UDP socket',async t=>{
 const service=await startDiscovery({...options,discoveryPort:0,host:'127.0.0.1'});t.after(()=>service.close());
 await assert.rejects(startDiscovery({...options,discoveryPort:service.port,host:'127.0.0.1'}),/EADDRINUSE/);
});
