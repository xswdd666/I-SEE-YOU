import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {AppearanceClient,AppearanceProviders} from '../src/appearance.mjs';
import {Session} from '../src/session.mjs';
import {parseIntent} from '../src/intent.mjs';
import {SceneDialogue} from '../src/scene-dialogue.mjs';
import {memory,frame,picture,directory} from './helpers.mjs';
import {uuid} from '../src/util.mjs';
const flush=()=>new Promise(r=>setImmediate(r));
const waitUntil=async fn=>{const start=Date.now();while(!fn()){assert(Date.now()-start<15000);await new Promise(r=>setTimeout(r,15));}};
const c=(i=0)=>({label:'cell phone',trackId:i+1,score:.9,box:i?[.6,.1,.9,.8]:[.05,.1,.35,.8],cropJpeg:picture.toString('base64')});
function setup(t,result){
 const m=memory(t),events=[];const receipt=m.capture('手机',frame());m.finish(receipt,{appearance:{jpeg:picture,embedding:Buffer.alloc(192).toString('base64')},location:{location:'过去的位置在抽屉里',anchor:'桌子'}});
 const batch=[c(),c(1)];let calls=0,options;
 const providers={backend:'appearance_mvp',localOnlyReview:true,describeCandidate:async(_,c)=>c.trackId===1?{description:'银色机身，外壳带贴纸',features:['银色','贴纸']}:{description:'黑色机身，表面有条纹',features:['黑色','条纹']},review:async(f,o,signal)=>{calls++;options=o;return typeof result==='function'?await result(f,o,signal):result;}};
 const s=new Session({memory:m,providers,emit:e=>events.push(e),detector:{ready:true,busy:false,run:async f=>({frameId:f.frameId,detections:batch,candidates:batch})}});t.after(()=>s.stop());
 s.start();s.frame(picture,s.source.generation,1,Date.now());
 return {s,m,events,batch,calls:()=>calls,options:()=>options,command:text=>s.command({commandId:uuid(),text})};
}
const selected=i=>({candidateIndex:i,box:c(i).box,scores:{base:.85,total:.85,detailBonus:0}});
test('is-this-before phrases compare images; history stays read only',()=>{
 for(const raw of ['这个是不是我上次让你记住的那个','这部手机是之前那部吗','这个跟上次记住的一样吗']){
  const intent=parseIntent(raw,'手机');assert.equal(intent?.action,'identify',raw);
  assert.equal(new SceneDialogue().route(raw,intent,'g').action,'identify');
 }
 assert.equal(parseIntent('你还记得之前我手机放在哪里吗','手机').action,'history');
 assert.equal(parseIntent('再寄出一件白色耳机','耳机').action,'clarify');
 assert.equal(parseIntent('再记住一件白色耳机','耳机').action,'remember');
 assert.equal(parseIntent('再记住一件白色耳机','耳机').newIdentity,true);
});
test('zero detail likely match guides to selected current box without writing memory',async t=>{
 const x=setup(t,{status:'LIKELY_MATCH',selected:selected(1),durationMs:20});const before=x.m.all();
 await x.command('帮我找之前记住的手机');await waitUntil(()=>x.s.state==='COMPLETED');
 assert.deepEqual(x.s.lastConfirmed.box,c(1).box);assert.deepEqual(x.m.all(),before);
 assert(!Object.hasOwn(x.options(),'description'));assert(!Object.hasOwn(x.options(),'features'));
 assert.match(x.events.filter(e=>e.kind==='result').at(-1).message,/外观相符.*右侧/);
 assert(!x.events.some(e=>e.type==='reply'&&/抽屉/.test(e.message)));
 const n=x.calls();await x.command('上次手机在哪里');assert.equal(x.calls(),n);assert.match(x.events.filter(e=>e.kind==='result').at(-1).message,/抽屉/);
});
test('ambiguity asks user; selecting a fresh tracked candidate guides without archiving',async t=>{
 const x=setup(t,{status:'AMBIGUOUS',selected:selected(0),choices:[selected(0),selected(1)]});const before=x.m.all();
 await x.command('找之前记住的手机');await waitUntil(()=>x.s.choices?.questionReady);
 assert.equal(x.s.state,'SEARCHING');assert.equal(x.events.filter(e=>e.type==='choices').at(-1).voiceOnly,true);assert.match(x.events.filter(e=>e.kind==='result').at(-1).message,/银色.*贴纸/);assert(!x.events.filter(e=>e.type==='reply').some(e=>/第[一二0-9]+[件个]/.test(e.message)));
 assert.equal(x.s.lastConfirmed,null);await x.command('不是');await x.command('黑色的');assert.equal(x.s.state,'COMPLETED');assert.deepEqual(x.s.lastConfirmed.box,c(1).box);assert.deepEqual(x.m.all(),before);
});
test('expired ambiguous selection cannot announce current found',async t=>{
 const x=setup(t,{status:'AMBIGUOUS',selected:selected(0),choices:[selected(0),selected(1)]});await x.command('找之前记住的手机');await waitUntil(()=>x.s.choices?.questionReady);
 x.s.lastAnalyzed.at-=2000;await x.command('是的');assert.equal(x.s.lastConfirmed,null);assert.match(x.events.filter(e=>e.kind==='result').at(-1).message,/已失效/);
});
for(const status of ['NO_MATCH','NO_REFERENCE','MODEL_ERROR','STALE_FRAME'])test('status remains distinct: '+status,async t=>{
 const x=setup(t,{status});await x.command('找之前记住的手机');await waitUntil(()=>x.events.some(e=>e.operation==='appearance_decision'));
 assert.equal(x.events.find(e=>e.operation==='appearance_decision').status,status);assert.equal(x.s.lastConfirmed,null);assert.notEqual(x.s.state,'COMPLETED');
});
test('newer question discards an old likely result and stale frame never guides',async t=>{
 let complete;const x=setup(t,()=>new Promise(r=>complete=r));await x.command('找之前记住的手机');await waitUntil(()=>!!complete);
 await x.command('上次手机在哪里');complete({status:'LIKELY_MATCH',selected:selected(0)});await flush();
 assert.equal(x.s.lastConfirmed,null);assert(!x.events.some(e=>e.type==='reply'&&/发现一件/.test(e.message)));
 const y=setup(t,async()=>{y.s.lastAnalyzed.at-=2000;return {status:'LIKELY_MATCH',selected:selected(0)};});
 await y.command('找之前记住的手机');await waitUntil(()=>y.events.some(e=>e.status==='STALE_FRAME'));assert.equal(y.s.lastConfirmed,null);
 assert(!y.events.some(e=>e.type==='experiment.match'&&e.status==='LIKELY_MATCH'));
 assert.equal(y.events.filter(e=>e.type==='experiment.match').at(-1).minBaseScore,.4);
});
test('model scores are not shown as a verdict until Session validates the camera',async t=>{
 const offline={warm:async()=>{},reset(){},close(){},request:async()=>{throw Error('cloud_identity_forbidden');}};
 const providers=new AppearanceProviders({client:offline,intentClient:offline,appearance:{run:async()=>({status:'LIKELY_MATCH',selected:selected(0)}),close(){}}});t.after(()=>providers.close());
 let rawEvents=0;providers.onDiagnostic=()=>rawEvents++;
 const result=await providers.review(frame(),{objectId:'phone',target:'手机',references:[picture],candidates:[c()],serial:1});
 assert.equal(result.status,'LIKELY_MATCH');assert.equal(result.minBaseScore,.4);assert.equal(rawEvents,0);
});
test('a returned match stays finished when the target leaves the camera',async t=>{
 const x=setup(t,{status:'LIKELY_MATCH',selected:selected(0)});await x.command('找之前记住的手机');await waitUntil(()=>x.s.state==='COMPLETED');
 x.batch.splice(0);x.s.frame(picture,x.s.source.generation,2,Date.now());await x.s.tick();
 const event=x.events.filter(e=>e.type==='experiment.match').at(-1);
 assert.equal(event.status,'LIKELY_MATCH');assert.equal(x.s.state,'COMPLETED');assert.equal(x.s.task.found,true);assert.deepEqual(x.s.lastConfirmed.box,c(0).box);
});

test('a low score above 0.4 needs repeated current appearance evidence before announcing found',async t=>{
 const chosen={...selected(0),scores:{base:.45,total:.45,detailBonus:0}};
 const x=setup(t,{status:'LIKELY_MATCH',selected:chosen});const before=x.m.all();
 await x.command('找之前记住的手机');await waitUntil(()=>x.events.some(e=>e.code==='confirming_low_score'));
 assert.equal(x.s.lastConfirmed,null);assert(!x.events.some(e=>e.type==='reply'&&/发现一件/.test(e.message)));
 x.s.frame(picture,x.s.source.generation,2,Date.now());x.s.lastReview=0;await x.s.tick();await waitUntil(()=>x.s.state==='COMPLETED');
 assert.deepEqual(x.m.all(),before);assert.equal(x.events.filter(e=>e.type==='reply'&&/发现一件/.test(e.message)).length,1);
});

test('different candidate cannot supply the second low-score confirmation',async t=>{
 const chosen={...selected(0),scores:{base:.45,total:.45,detailBonus:0}};
 const x=setup(t,{status:'LIKELY_MATCH',selected:chosen});await x.command('找之前记住的手机');await waitUntil(()=>x.events.some(e=>e.code==='confirming_low_score'));
 x.batch[0]={...x.batch[0],trackId:99};x.s.frame(picture,x.s.source.generation,2,Date.now());x.s.lastReview=0;await x.s.tick();await flush();
 assert.equal(x.s.lastConfirmed,null);assert(!x.events.some(e=>e.type==='reply'&&/发现一件/.test(e.message)));
});
test('real DINO worker: scores, cache, errors, latest-only queue, invalidation, batch timing',async t=>{
 const root=directory(),client=new AppearanceClient({env:{...process.env,ISEEYOU_RUNTIME:root,ISEEYOU_APPEARANCE_DEBUG:'1'}});t.after(()=>client.close());
 assert.equal((await client.started).modelReady,true);
 const image=picture.toString('base64');
 const data={frameId:1,sourceGeneration:'g',targetId:'phone',referenceVersion:'v1',deadlineAtMs:Date.now()+30000,references:[{id:'ref',image}],candidates:[{id:'c',image,box:[.1,.1,.9,.9]}]};
 const one=await client.run(data);assert.equal(one.status,'LIKELY_MATCH');assert(one.selected.scores.base>.99);assert.equal(one.referenceCacheHits,0);
 const two=await client.run({...data,frameId:2});assert.equal(two.referenceCacheHits,1);
 assert.equal((await client.run({...data,references:[]})).status,'NO_REFERENCE');
 assert.equal((await client.run({...data,deadlineAtMs:1})).status,'STALE_FRAME');
 assert.equal((await client.run({...data,candidates:[{...data.candidates[0],image:'invalid'}]})).status,'MODEL_ERROR');
 const active=client.run({...data,candidates:Array.from({length:8},(_,i)=>({...data.candidates[0],id:String(i)}))});
 await waitUntil(()=>!!client.pending);const old=client.run({...data,frameId:3});const oldCheck=assert.rejects(old,/superseded/);
 const latest=client.run({...data,frameId:4});await oldCheck;const multi=await active;assert.equal((await latest).frameId,4);
 assert.equal(multi.status,'AMBIGUOUS');assert.equal(multi.candidates.length,8);
 await client.run({operation:'invalidate',targetId:'phone'});assert.equal(readdirSync(resolve(root,'appearance-cache')).filter(x=>x.endsWith('.npz')).length,0);
 const cold=await client.run({...data,deadlineAtMs:Date.now()+30000});assert.equal(cold.referenceCacheHits,0);
 assert(existsSync(resolve(root,'appearance-debug/index.html')));
 client.close();
 const restarted=new AppearanceClient({env:{...process.env,ISEEYOU_RUNTIME:root,ISEEYOU_APPEARANCE_DEBUG:'1'}});t.after(()=>restarted.close());await restarted.started;
 const restored=await restarted.run({...data,deadlineAtMs:Date.now()+30000});assert.equal(restored.referenceCacheHits,1);assert.equal(restored.status,'LIKELY_MATCH');
 console.log(JSON.stringify({realDinoMs:one.durationMs,cachedMs:two.durationMs,eightCandidatesMs:multi.durationMs}));
});
