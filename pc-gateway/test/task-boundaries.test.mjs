import test from 'node:test';
import assert from 'node:assert/strict';
import {Session} from '../src/session.mjs';
import {memory,picture} from './helpers.mjs';
import {uuid} from '../src/util.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const flush=()=>new Promise(r=>setImmediate(r));
function setup(t,providers,detector){
 const m=memory(t),events=[],s=new Session({memory:m,providers,detector,emit:e=>events.push(e)});
 s.start();s.frame(picture,s.source.generation,1,Date.now());
 const command=text=>s.command({commandId:uuid(),text});
 return {s,m,events,command};
}
test('a new question aborts old vision before its slower interpretation finishes',async t=>{
 const old=deferred(),meaning=deferred();let oldSignal;
 const x=setup(t,{describe:(_,__,___,signal)=>{oldSignal=signal;return old.promise;},intent:()=>meaning.promise});
 const first=x.command('眼前有什么');
 const second=x.command('我想听个笑话');
 assert.equal(oldSignal.aborted,true);assert.equal(x.s.state,'IDLE');assert.equal(x.s.task,null);
 old.resolve({answer:'旧画面里有手机'});await first;
 assert.equal(x.events.filter(e=>e.type==='reply').length,0);
 meaning.resolve({action:'chat',answer:'这是新问题的回答。'});await second;
 assert.deepEqual(x.events.filter(e=>e.type==='reply').map(e=>e.message),['这是新问题的回答。']);
});
test('an unclear new command retires the old search instead of leaving a stalled old target',async t=>{
 const meaning=deferred();const x=setup(t,{intent:()=>meaning.promise});
 await x.command('帮我找之前记住的手机');const next=x.command('换个那个试一下');
 assert.equal(x.s.task,null);assert.equal(x.s.state,'IDLE');
 meaning.resolve(null);await next;
 assert.equal(x.s.task,null);assert.equal(x.s.state,'IDLE');
 await x.command('继续找');assert.equal(x.s.task.target,'手机');
});
test('superseded memory keeps its scene, reports interruption, and cannot write a late result',async t=>{
 const old=deferred();let signal;
 const x=setup(t,{singlePassMemory:true,describe:(_,target,__,sig)=>{if(target){signal=sig;return old.promise;}return Promise.resolve({answer:'新画面'});}});
 const first=x.command('记住手机');const id=x.m.all()[0].id;
 await x.command('眼前有什么');assert.equal(signal.aborted,true);
 assert.match(x.m.receipt(id).message,/上次没记全/);assert.equal(x.m.get(id).captures.length,1);
 old.resolve({v:true,d:'不应写入的旧手机',l:'不应写入的位置',b:[.1,.1,.5,.8]});await first;
 assert.equal(x.m.get(id).description,null);assert.equal(x.m.locationHistory(id).length,0);
 assert.deepEqual(x.events.filter(e=>e.kind==='result').map(e=>e.message),['新画面']);
});
test('a status query lets the same pending memory finish silently, without replacing the newer answer',async t=>{
 const old=deferred();let signal;
 const x=setup(t,{singlePassMemory:true,describe:(_,__,___,sig)=>{signal=sig;return old.promise;}});
 const first=x.command('记住手机');await x.command('你记住它了吗');
 assert.equal(signal.aborted,false);assert.match(x.events.filter(e=>e.kind==='result').at(-1).message,/我还在记/);
 const boundary=x.events.length;
 old.resolve({v:true,d:'黑色手机',l:'电脑左边',b:null});await first;
 assert.equal(x.m.all()[0].description,'黑色手机');assert.match(x.m.history(x.m.all()[0].id),/电脑左边/);
 assert.ok(!x.events.slice(boundary).some(e=>['reply','state'].includes(e.type)));
});
test('late detector output from an earlier task cannot launch a review for the new target',async t=>{
 const detection=deferred();let reviews=0,busy=false;
 const x=setup(t,{review:async()=>{reviews++;return {decision:'CONFIRM'};}},{ready:true,get busy(){return busy;},run:()=>{busy=true;return detection.promise.finally(()=>{busy=false;});}});
 const tick=x.s.tick();await x.command('帮我找之前记住的钥匙');
 detection.resolve({detections:[],candidates:[]});await tick;await flush();
 assert.equal(reviews,0);assert.equal(x.s.task.target,'钥匙');
});
test('rapidly replacing A with B then C allows only C to answer and tag its interface state',async t=>{
 const a=deferred(),b=deferred();let calls=0;
 const x=setup(t,{describe:()=>[a.promise,b.promise,Promise.resolve({answer:'C的回答'})][calls++]});
 const first=x.command('眼前有什么'),second=x.command('眼前有什么');await x.command('眼前有什么');
 const current=x.s.commandId,boundary=x.events.length;
 b.resolve({answer:'B的迟到回答'});a.resolve({answer:'A的迟到回答'});await Promise.all([first,second]);
 assert.deepEqual(x.events.filter(e=>e.kind==='result').map(e=>e.message),['C的回答']);
 assert.ok(x.events.filter(e=>['state','choices'].includes(e.type)&&e.serial===x.s.serial).every(e=>e.commandId===current));
 assert.ok(!x.events.slice(boundary).some(e=>['state','choices','reply'].includes(e.type)));
});
test('a search pauses after thirty seconds, discards a delayed match and can explicitly restart',async t=>{
 const review=deferred();let signal,now=Date.now();
 const candidate={label:'cell phone',score:.9,box:[.1,.1,.3,.7],cropJpeg:picture.toString('base64')};
 const x=setup(t,{review:(_,__,sig)=>{signal=sig;return review.promise;}},{ready:true,busy:false,run:async()=>({detections:[candidate],candidates:[candidate]})});
 x.s.now=()=>now;
 await x.command('帮我找之前记住的手机');await flush();assert.equal(x.s.state,'VERIFYING');
 now+=30_001;await x.s.tick();assert.equal(signal.aborted,true);assert.equal(x.s.task,null);assert.equal(x.s.state,'IDLE');
 assert.match(x.events.filter(e=>e.kind==='result').at(-1).message,/想再找就说“继续”/);
 review.resolve({decision:'CONFIRM'});await flush();assert.equal(x.s.lastConfirmed,null);
 assert.ok(!x.events.some(e=>e.type==='reply'&&/发现.*手机/.test(e.message)));
 await x.command('继续找');assert.equal(x.s.task.target,'手机');assert.ok(x.s.task.searchStartedAt>=now);
});
