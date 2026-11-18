import test from 'node:test';
import assert from 'node:assert/strict';
import {Session} from '../src/session.mjs';
import {memory,picture} from './helpers.mjs';
const flush=()=>new Promise(r=>setImmediate(r));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function setup(t,describe){
 const events=[];let warms=0,now=Date.now();
 const s=new Session({memory:memory(t),now:()=>now,providers:{warm:async()=>{warms++;},describe},emit:e=>events.push(e)});
 s.start();s.frame(picture,s.source.generation,1,now);t.after(()=>s.stop());
 return {s,events,warms:()=>warms,advance:ms=>now+=ms};
}
test('speech start warms transport without sending an image or inventing an answer',async t=>{
 let images=0;const x=setup(t,async()=>{images++;});
 x.s.prepareSpeech('u');await flush();assert.equal(x.warms(),1);assert.equal(images,0);assert.equal(x.events.filter(e=>e.type==='reply').length,0);
 assert.equal(x.s.memory.all().length,0);
});
test('scene analysis runs during ASR and its pending result is reused by final transcription',async t=>{
 const d=deferred();let calls=0;const x=setup(t,()=>{calls++;return d.promise;});
 x.s.prepareSpeech('u','眼前有什么');await flush();assert.equal(calls,1);assert.equal(x.events.filter(e=>e.type==='reply').length,0);
 const final=x.s.command({commandId:'c',utteranceId:'u',text:'眼前有什么？'});
 d.resolve({answer:'桌上有一个杯子。'});await final;
 assert.equal(calls,1);assert.equal(x.events.filter(e=>e.kind==='result')[0].commandId,'c');
 assert.ok(x.events.some(e=>e.operation==='speech_vision_reused'));
});
test('a completed scene observation can answer immediately after final ASR without a second model request',async t=>{
 let calls=0;const x=setup(t,async()=>{calls++;return {answer:'有一把椅子。'};});
 x.s.prepareSpeech('u','眼前有什么');await flush();await x.s.command({commandId:'c',utteranceId:'u',text:'眼前有什么'});
 assert.equal(calls,1);assert.equal(x.events.filter(e=>e.type==='reply').length,1);
});
test('partial save, history, ordinary chat and ambiguous text never send images or mutate memory',async t=>{
 let calls=0;const x=setup(t,async()=>{calls++;});
 for(const [i,text] of ['记住蓝色水杯','杯子上次在哪','你好','我想问一下'].entries())x.s.prepareSpeech('u'+i,text);
 await flush();assert.equal(calls,0);assert.equal(x.s.memory.all().length,0);
});
test('a corrected question aborts the draft; only the final requested scene is answered',async t=>{
 let signal,calls=0;const d=deferred();const x=setup(t,(_,__,q,sig)=>{calls++;if(calls===1){signal=sig;return d.promise;}return Promise.resolve({answer:'新问题的答案'});});
 x.s.prepareSpeech('u','眼前有什么');await flush();
 await x.s.command({commandId:'c',utteranceId:'u',text:'桌上有哪些东西'});assert.ok(signal.aborted);
 d.resolve({answer:'旧问题的答案'});await flush();assert.deepEqual(x.events.filter(e=>e.kind==='result').map(e=>e.message),['新问题的答案']);
});
test('stale preview is discarded and final command obtains its own newer frame',async t=>{
 const frames=[];const x=setup(t,async f=>{frames.push(f.frameId);return {answer:'当前画面'};});
 x.s.prepareSpeech('u','眼前有什么');await flush();x.advance(1200);x.s.frame(picture,x.s.source.generation,2,Date.now());
 await x.s.command({commandId:'c',utteranceId:'u',text:'眼前有什么'});assert.deepEqual(frames,[1,2]);
});
test('stop clears preview and late ASR cannot resurrect a completed turn',async t=>{
 let signal,calls=0;const d=deferred();const x=setup(t,(_,__,___,s)=>{signal=s;calls++;return d.promise;});
 x.s.prepareSpeech('u','眼前有什么');await flush();x.s.stop();assert.ok(signal.aborted);
 d.resolve({answer:'迟到结果'});await flush();assert.equal(x.events.filter(e=>e.type==='reply').length,0);
 assert.deepEqual(x.s.prepareSpeech('u','眼前有什么'),{accepted:false});assert.equal(calls,1);
});
test('prefetch failure does not suppress a successful fresh request after final ASR',async t=>{
 let calls=0;const x=setup(t,async()=>{if(++calls===1)throw Error('omni_timeout');return {answer:'重新观察成功'};});
 x.s.prepareSpeech('u','眼前有什么');await flush();await x.s.command({commandId:'c',utteranceId:'u',text:'眼前有什么'});
 assert.equal(calls,2);assert.equal(x.events.filter(e=>e.kind==='result')[0].message,'重新观察成功');
});
test('late partial messages cannot restart a finalised utterance, and drafts are bounded',async t=>{
 let calls=0;const x=setup(t,async()=>{calls++;return {answer:'当前画面'};});
 x.s.prepareSpeech('u','眼前有什么');await flush();await x.s.command({commandId:'c',utteranceId:'u',text:'眼前有什么'});
 x.s.prepareSpeech('u','眼前有什么');await flush();assert.equal(calls,1);
 for(const text of ['眼前有什么','桌上有什么','周围有哪些东西','这里有什么']){x.s.prepareSpeech('v',text);await flush();}
 assert.equal(calls,3);
});
