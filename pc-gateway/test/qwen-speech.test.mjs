import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import https from 'node:https';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {QwenSpeech,SPEECH_MODEL,SPEECH_VOICE} from '../src/qwen-speech.mjs';
import {createGateway} from '../src/server.mjs';
import {directory} from './helpers.mjs';
class Socket extends EventEmitter {
 constructor({voice=SPEECH_VOICE,hang=false}={}){super();Object.assign(this,{voice,hang,sent:[],readyState:1});queueMicrotask(()=>this.event({type:'session.created',session:{model:SPEECH_MODEL}}));}
 event(value){this.emit('message',Buffer.from(JSON.stringify(value)));}
 send(raw){const e=JSON.parse(raw);this.sent.push(e);queueMicrotask(()=>{
  if(e.type==='session.update')this.event({type:'session.updated',session:{voice:this.voice}});
  if(e.type==='input_text_buffer.commit'&&!this.hang){this.event({type:'response.created',response:{id:'speech-1',voice:this.voice}});this.event({type:'response.audio.delta',response_id:'speech-1',delta:Buffer.from([1,0,2,0]).toString('base64')});this.event({type:'response.done',response:{status:'completed',voice:this.voice}});}
 });}
 terminate(){if(this.readyState!==3){this.readyState=3;this.emit('close');}}
 close(){this.terminate();}
}
test('all text roles use one fixed Qwen voice and PCM stream, without audio or image input',async()=>{
 const sockets=[],speech=new QwenSpeech({key:()=> 'fake-key',socketFactory:(url,options)=>{assert.equal(new URL(url).searchParams.get('model'),SPEECH_MODEL);assert.equal(options.headers.Authorization,'Bearer fake-key');const s=new Socket();sockets.push(s);return s;}});
 try{for(const words of ['好，我看一下。','耳机在手机右侧。']){const chunks=[];const result=await speech.stream(words,b=>chunks.push(b));assert.equal(result.voice,'Cherry');assert.deepEqual(Buffer.concat(chunks),Buffer.from([1,0,2,0]));}
  assert.equal(sockets.length,2);for(const s of sockets){assert.deepEqual(s.sent.map(e=>e.type),['session.update','input_text_buffer.append','input_text_buffer.commit']);assert.equal(s.sent[0].session.voice,'Cherry');assert.equal(s.sent[0].session.sample_rate,24000);assert.equal(s.readyState,3);}
 }finally{speech.close();}
});
test('an unexpected speaker cannot play, and explicit cancellation discards delayed audio',async()=>{
 const wrong=new QwenSpeech({key:()=> 'fake-key',socketFactory:()=>new Socket({voice:'Different'})});await assert.rejects(wrong.stream('hello',()=>assert.fail('unexpected audio')),/voice_invalid/);wrong.close();
 let socket;const speech=new QwenSpeech({key:()=> 'fake-key',socketFactory:()=>socket=new Socket({hang:true})});const c=new AbortController(),chunks=[];const run=speech.stream('old',b=>chunks.push(b),{signal:c.signal});await new Promise(r=>setImmediate(r));c.abort();await assert.rejects(run,/operation_cancelled/);socket.event({type:'response.audio.delta',response_id:'speech-1',delta:'AQACAA=='});assert.equal(chunks.length,0);speech.close();
});
function request(g,root,body,authorized=true){return new Promise((done,reject)=>{const raw=Buffer.from(JSON.stringify(body));const r=https.request({hostname:'127.0.0.1',port:g.port,path:'/v1/speech',method:'POST',ca:readFileSync(resolve(root,'server-cert.pem')),headers:{'Content-Type':'application/json','Content-Length':raw.length,...(authorized?{Authorization:'Bearer '+g.token}:{})}},res=>{const parts=[];res.on('data',p=>parts.push(p));res.on('end',()=>done({status:res.statusCode,headers:res.headers,body:Buffer.concat(parts)}));});r.on('error',reject);r.end(raw);});}
test('paired tablet receives fixed-voice PCM over TLS and speech never writes object memory',async t=>{
 const root=directory();let calls=0;const speech={stream:async(words,audio)=>{calls++;assert.equal(words,'耳机在右边');audio(Buffer.from([1,0,2,0]));return {durationMs:1};},close(){}};
 const g=await createGateway({root,port:0,host:'127.0.0.1',speech,providers:{},detector:{ready:false,close(){}}});t.after(()=>g.close());
 const denied=await request(g,root,{text:'耳机在右边'},false);assert.equal(denied.status,401);assert.equal(calls,0);
 const result=await request(g,root,{text:'耳机在右边'});assert.equal(result.status,200);assert.equal(result.headers['x-speech-provider'],'qwen');assert.equal(result.headers['x-speech-voice'],'Cherry');assert.equal(result.headers['x-audio-sample-rate'],'24000');assert.deepEqual(result.body,Buffer.from([1,0,2,0]));assert.equal(g.memory.all().length,0);
 const invalid=await request(g,root,{text:'hi',voice:'Another'});assert.equal(invalid.status,400);assert.equal(calls,1);
});
