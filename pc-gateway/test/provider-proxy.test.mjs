import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {QwenSpeech} from '../src/qwen-speech.mjs';
import {OmniRealtime} from '../src/omni-realtime.mjs';

test('both provider transports use the configured HTTP CONNECT proxy without local DNS', async t => {
 const seen=[];
 const proxy=http.createServer();
 proxy.on('connect',(req,socket)=>{seen.push(req.url);socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');});
 proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
 const old=process.env.HTTPS_PROXY;
 process.env.HTTPS_PROXY=`http://127.0.0.1:${proxy.address().port}`;
 t.after(()=>{if(old===undefined)delete process.env.HTTPS_PROXY;else process.env.HTTPS_PROXY=old;proxy.close();});
 for(const client of [new QwenSpeech(),new OmniRealtime()]) {
  const socket=client.socketFactory('wss://provider.invalid/test',{handshakeTimeout:1000});
  await new Promise(resolve=>{socket.on('error',resolve);socket.on('unexpected-response',(_,res)=>{res.resume();socket.terminate();resolve();});});
  client.close();
 }
 assert.deepEqual(seen,['provider.invalid:443','provider.invalid:443']);
});
