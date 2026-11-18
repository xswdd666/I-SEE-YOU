import test from 'node:test';
import assert from 'node:assert/strict';
import {Session} from '../src/session.mjs';
import {memory,frame,picture} from './helpers.mjs';
import {uuid} from '../src/util.mjs';
const flush=()=>new Promise(r=>setImmediate(r));
const wait=async predicate=>{const end=Date.now()+3000;while(!predicate()){assert(Date.now()<end,'expected completed observation');await new Promise(r=>setTimeout(r,5));}};
const candidate=(trackId=1,box=[.1,.1,.4,.8])=>({label:'cell phone',trackId,box,score:.95,cropJpeg:picture.toString('base64')});
function setup(t,{omni=false}={}){
 const m=memory(t),events=[];const r=m.capture('手机',frame());m.finish(r,{appearance:{jpeg:picture,embedding:Buffer.alloc(192).toString('base64')},description:'银色外壳'});
 let batch=[candidate()],detectCalls=0,compareCalls=0,now=Date.now();
 const detector={ready:true,busy:false,run:async f=>{detectCalls++;return {frameId:f.frameId,detections:batch,candidates:batch};}};
 const providers=omni?{review:async()=>{compareCalls++;return {decision:'CONFIRM'};}}:{backend:'appearance_mvp',localOnlyReview:true,review:async()=>{compareCalls++;return {status:'LIKELY_MATCH',selected:{candidateIndex:0,box:batch[0].box,scores:{base:.85,total:.85}}};}};
 const s=new Session({memory:m,providers,detector,now:()=>now,emit:e=>events.push(e)});t.after(()=>s.stop());s.start();let seq=0;
 const feed=()=>s.frame(picture,s.source.generation,++seq,now);feed();
 return {s,m,events,detector,providers,send:text=>s.command({commandId:uuid(),text}),feed,setBatch:value=>batch=value,advance:ms=>now+=ms,calls:()=>({detect:detectCalls,compare:compareCalls})};
}
for(const omni of [false,true])test((omni?'Omni':'local appearance')+' result returns once; camera movement, disappearance and expiry never restart it',async t=>{
 const x=setup(t,{omni}),before=x.m.all(),sourceGeneration=x.s.source.generation;
 await x.send('找之前记住的手机');await wait(()=>x.s.state==='COMPLETED');const calls=x.calls(),start=x.events.length,observation={...x.s.lastConfirmed};
 for(const batch of [[candidate(9,[.6,.1,.9,.8])],[],[candidate(100)]]){x.setBatch(batch);x.feed();await x.s.tick();}
 x.advance(59000);await x.s.tick();await flush();
 assert.equal(x.s.state,'COMPLETED');assert.equal(x.s.task.found,true);assert.deepEqual(x.s.lastConfirmed,observation);assert.deepEqual(x.calls(),calls);
 assert(!x.events.slice(start).some(e=>['reply','speech.clear'].includes(e.type)||e.status==='RECHECKING'||e.status==='STALE_FRAME'));
 assert.equal(x.events.filter(e=>e.type==='reply'&&/发现/.test(e.message)).length,1);
 assert.equal(x.s.source.generation,sourceGeneration);assert.deepEqual(x.m.all(),before);
});
test('explicit continue starts a fresh comparison and can return the same target again',async t=>{
 const x=setup(t);await x.send('找之前记住的手机');await wait(()=>x.s.state==='COMPLETED');const count=x.calls().compare;
 x.setBatch([candidate(2,[.6,.1,.9,.8])]);x.feed();await x.send('继续找');await wait(()=>x.s.state==='COMPLETED'&&x.calls().compare>count);
 assert.equal(x.calls().compare,count+1);assert.equal(x.s.lastConfirmed.trackId,2);
 assert.equal(x.events.filter(e=>e.type==='reply'&&/发现一件/.test(e.message)).length,2);
});
test('a negative correction after completion resumes search and excludes the returned candidate',async t=>{
 const x=setup(t);await x.send('找之前记住的手机');await wait(()=>x.s.state==='COMPLETED');const first=x.s.lastConfirmed.box;
 x.setBatch([candidate(2,[.6,.1,.9,.8])]);x.feed();await x.send('不是这个');await wait(()=>!!x.s.task.appearanceEvidence);
 assert.equal(x.s.task.found,false);x.advance(1600);x.feed();await x.s.tick();await wait(()=>x.s.state==='COMPLETED'&&x.s.lastConfirmed.trackId===2);
 assert(x.s.rejections.some(r=>JSON.stringify(r.box)===JSON.stringify(first)));assert.equal(x.calls().compare,3);
});
test('returning a result never records retrieval; only the user saying they have it does',async t=>{
 const x=setup(t),before=x.m.all();await x.send('找之前记住的手机');await wait(()=>x.s.state==='COMPLETED');assert.deepEqual(x.m.all(),before);
 await x.send('拿到了');assert.equal(x.m.all()[0].events.length,before[0].events.length+1);
 assert.match(x.events.filter(e=>e.type==='reply').at(-1).message,/^好，收工！$/);
});
test('confirming an already returned result does not silently restart search',async t=>{
 const x=setup(t);await x.send('找之前记住的手机');await wait(()=>x.s.state==='COMPLETED');const before=x.calls();
 await x.send('就是它');assert.equal(x.s.state,'COMPLETED');assert.equal(x.s.task.found,true);
 x.feed();await x.s.tick();assert.deepEqual(x.calls(),before);
});
test('a detector already running when a result arrives cannot undo the returned result',async t=>{
 const x=setup(t);let finishReview;x.providers.review=()=>new Promise(r=>finishReview=r);await x.send('找之前记住的手机');await wait(()=>!!finishReview);
 let finishDetect;x.detector.run=()=>new Promise(r=>finishDetect=r);x.feed();const inFlight=x.s.tick();await wait(()=>!!finishDetect);
 finishReview({status:'LIKELY_MATCH',selected:{candidateIndex:0,box:candidate().box,scores:{base:.85,total:.85}}});await wait(()=>x.s.state==='COMPLETED');
 const start=x.events.length;finishDetect({detections:[],candidates:[]});await inFlight;assert.equal(x.s.state,'COMPLETED');assert.equal(x.events.slice(start).length,0);
});

test('a follow-up compares the completed search crop to the saved reference even when the camera moved',async t=>{
 const x=setup(t);await x.send('找之前记住的手机');await wait(()=>x.s.state==='COMPLETED');
 const first=x.calls();x.feed();let compared;
 x.providers.review=async(f,options)=>{compared={f,options};return {status:'NO_MATCH',candidates:[{scores:{base:.21}}]};};
 await x.send('是我之前保存的那部吗');
 assert.equal(compared.f.frameId,1);assert.deepEqual(compared.options.crop,picture);assert.deepEqual(compared.options.references,[picture]);
 assert.deepEqual(x.calls(),first);assert.equal(x.s.task,null);
 assert.match(x.events.filter(e=>e.kind==='result').at(-1).message,/刚才描述的.*外观不相符/);
});

test('spoken discovery ends a saved search without recording a pickup or resuming a stale target',async t=>{
 const x=setup(t),before=x.m.all();
 for(const phrase of ['找到了','我已经找到了，谢谢','手机找到了','我找到手机了','找着啦']){
  await x.send('找之前记住的手机');await wait(()=>x.s.task?.found);
  await x.send(phrase);
  assert.equal(x.s.task,null,phrase);assert.equal(x.s.focus,null);assert.equal(x.s.searchDeadline,null);
  assert.match(x.events.filter(e=>e.type==='reply').at(-1).message,/^好，先停这儿。$/);
 }
 assert.deepEqual(x.m.all(),before);
 await x.send('继续找');assert.equal(x.s.task,null);
});
test('a user continuation renews the one-minute deadline; frames and result delivery do not',async t=>{
 const x=setup(t);await x.send('找之前记住的手机');await wait(()=>x.s.task?.found);
 x.advance(59_999);await x.s.tick();assert.ok(x.s.task?.found);
 x.feed();await x.send('我还没找到');await wait(()=>x.s.task?.found);
 x.advance(59_999);x.feed();await x.s.tick();assert.ok(x.s.task?.found);
 x.advance(1);await x.s.tick();assert.equal(x.s.task,null);assert.equal(x.s.lastTarget,null);
 await x.s.tick();assert.equal(x.events.filter(e=>e.type==='reply'&&e.message.includes('这轮先停这儿')).length,1);
});
test('silence ends paused and pending-target searches but switching to history disarms expiration',async t=>{
 const x=setup(t);x.setBatch([]);await x.send('找之前记住的手机');
 x.advance(30_001);await x.s.tick();assert.equal(x.s.task,null);assert.ok(x.s.searchDeadline);
 x.advance(29_999);await x.s.tick();assert.equal(x.s.focus,null);assert.equal(x.s.searchDeadline,null);
 await x.send('帮我找东西');assert.equal(x.s.choices.kind,'search_target');
 x.advance(60_000);await x.s.tick();assert.equal(x.s.choices,null);
 await x.send('帮我找杯子');await x.send('上次手机在哪里');assert.equal(x.s.searchDeadline,null);
 const count=x.events.length;x.advance(60_000);await x.s.tick();assert.equal(x.events.length,count);
});

test('everyday spoken endings clear the current target and only an explicit pickup records retrieval',async t=>{
 const x=setup(t);
 const phrases=['行了，不用找了','东西找着了','先不找了','好嘞，找着啦，谢谢你','算了吧','不用再帮我找了','可以了','就这样吧','停止这次找物任务','我摸到它了','嗯，我看见了','手机找着了','我拿到手里了','结束任务','不需要再找了'];
 for(const phrase of phrases){
  await x.send('找之前记住的手机');await wait(()=>x.s.task?.found);
  const count=x.m.all()[0].events.length;
  await x.send(phrase);
  assert.equal(x.s.task,null,phrase);assert.equal(x.s.searchDeadline,null,phrase);
  assert.equal(x.s.lastTarget,null,phrase);
  assert.equal(x.m.all()[0].events.length,count+Number(phrase==='我拿到手里了'),phrase);
  assert.match(x.events.filter(e=>e.type==='reply').at(-1).message,/^好，(?:先停这儿。|收工！)$/,phrase);
 }
});
test('uncertainty, negative replies and follow-up requests do not match spoken endings',async t=>{
 const x=setup(t);await x.send('帮我找手机');
 for(const phrase of ['还没找到','找到了吗？','我拿到了吗','是不是找着了','我看见桌子了','我摸到了吗','如果我找到了怎么办','找到了，再帮我找钥匙','不用找了吧？']){
  assert.notEqual(x.s.readIntent(phrase)?.action,'complete',phrase);
 }
 for(const phrase of ['我还没找着呢','找着了吗？','还没摸到','找到了吗？']){
  await x.send(phrase);assert.equal(x.s.task?.target,'手机',phrase);assert.ok(x.s.searchDeadline,phrase);
 }
 await x.send('帮我找东西');await x.send('先不找了');assert.equal(x.s.choices,null);
 assert.notEqual(x.s.readIntent('可以了')?.action,'complete');
});
