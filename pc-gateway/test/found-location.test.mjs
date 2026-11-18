import test from 'node:test';
import assert from 'node:assert/strict';
import {Session} from '../src/session.mjs';
import {OmniProviders} from '../src/omni.mjs';
import {parseFoundLocation,frameRegion,locationWords,relativeAnchor} from '../src/found-location.mjs';
import {memory,frame,picture} from './helpers.mjs';
import {uuid} from '../src/util.mjs';
const target=[.75,.65,.95,.85];
const detail={anchors:[{name:'黑色手机',box:[.4,.65,.6,.85]}],surface:{name:'白色桌面',relation:'on'}};
const wait=async fn=>{const end=Date.now()+6000;while(!fn()){assert(Date.now()<end,'expected location answer');await new Promise(r=>setTimeout(r,5));}};
const reply=events=>events.filter(e=>e.type==='reply'&&e.kind==='result').at(-1)?.message;
function setup(t,describeFoundLocation){
 const m=memory(t),events=[],r=m.capture('黄色玉米',frame());m.finish(r,{description:'黄色颗粒表面',appearance:{jpeg:picture,embedding:Buffer.alloc(192).toString('base64')},suggestedLocation:'历史中厨房的柜子',failureKind:'REVIEW_UNCERTAIN'});
 const candidate={label:'carrot',trackId:1,box:target,cropJpeg:picture.toString('base64'),score:.9};let comparisons=0,detectorRuns=0;
 const providers={backend:'appearance_mvp',localOnlyReview:true,describeFoundLocation,review:async(f,options)=>{comparisons++;return {status:'LIKELY_MATCH',selected:{candidateIndex:0,referenceId:options.referenceIds?.[0],box:target,scores:{base:.9,total:.9}}};}};
 const s=new Session({memory:m,providers,detector:{ready:true,busy:false,run:async f=>{detectorRuns++;return {frameId:f.frameId,detections:[candidate],candidates:[candidate]};}},emit:e=>events.push(e)});t.after(()=>s.stop());
 s.start();let sequence=0;const feed=()=>s.frame(picture,s.source.generation,++sequence,Date.now());feed();
 return {s,m,events,feed,send:text=>s.command({commandId:uuid(),text}),counts:()=>({comparisons,detectorRuns})};
}
test('found result preserves appearance and name, adds vertical region, visible support and nearby anchor, and speaks once',async t=>{
 let inputs;const x=setup(t,async(f,box)=>{inputs={f,box};return detail;}),before=x.m.all();
 await x.send('找之前记住的黄色玉米');await wait(()=>!!reply(x.events));
 assert.match(reply(x.events),/^发现一件外观相符的黄色玉米，/);assert.match(reply(x.events),/画面右侧偏下.*白色桌面上.*黑色手机的右侧/);assert.doesNotMatch(reply(x.events),/没辨认清楚/);
 assert.deepEqual(inputs.box,target);assert.deepEqual(inputs.f.jpeg,picture);assert.deepEqual(x.m.all(),before);assert.doesNotMatch(reply(x.events),/厨房|柜子|厘米|伸手/);
 const count=x.counts(),start=x.events.length;x.feed();await x.s.tick();assert.deepEqual(x.counts(),count);assert.equal(x.s.state,'COMPLETED');assert(!x.events.slice(start).some(e=>e.type==='reply'));assert.equal(x.events.filter(e=>e.kind==='result').length,1);
});
test('lookup failure preserves a useful measured region and edge instead of losing the matched result',async t=>{
 const x=setup(t,async()=>{throw Error('omni_timeout');});await x.send('找之前记住的黄色玉米');await wait(()=>!!reply(x.events));
 assert.match(reply(x.events),/发现一件外观相符的黄色玉米.*右侧偏下.*右边缘/);assert.doesNotMatch(reply(x.events),/桌面|手机|厨房/);assert.equal(x.s.task.found,true);
});
test('bounded lookup never prevents result delivery or resumes tracking after timing out',async t=>{
 let signal;const x=setup(t,async(f,b,s)=>{signal=s;return await new Promise(()=>{});});await x.send('找之前记住的黄色玉米');await wait(()=>!!reply(x.events));
 assert(signal.aborted);assert.equal(x.s.state,'COMPLETED');assert.match(reply(x.events),/发现一件外观相符的黄色玉米/);assert.equal(x.events.filter(e=>e.kind==='result').length,1);
});
test('camera changes during landmark description do not restart search; answer is bound to the accepted snapshot',async t=>{
 let finish;const x=setup(t,async()=>await new Promise(r=>finish=r));await x.send('找之前记住的黄色玉米');await wait(()=>!!finish);const count=x.counts();
 x.feed();await x.s.tick();assert.deepEqual(x.counts(),count);finish(detail);await wait(()=>!!reply(x.events));assert.match(reply(x.events),/黑色手机的右侧/);assert.equal(x.s.state,'COMPLETED');
});
test('new question cancels a pending location answer; late details cannot overwrite the newer reply',async t=>{
 let finish,signal;const x=setup(t,async(f,b,s)=>{signal=s;return await new Promise(r=>finish=r);});await x.send('找之前记住的黄色玉米');await wait(()=>!!finish);
 await x.send('黄色玉米上次在哪里');assert(signal.aborted);const answer=reply(x.events);assert.match(answer,/历史|厨房|柜子/);finish(detail);await new Promise(r=>setImmediate(r));assert.equal(reply(x.events),answer);assert(!x.events.some(e=>e.type==='reply'&&/黑色手机/.test(e.message)));
});
test('measured position handles vertical regions and does not invent reference objects',()=>{
 assert.equal(frameRegion([.1,.1,.3,.25]),'当前画面左侧偏上');assert.equal(frameRegion([.4,.4,.6,.6]),'当前画面中央');
 assert.equal(relativeAnchor(target,[.4,.65,.6,.85]),'右侧');assert.equal(relativeAnchor(target,target),null);
 assert.match(locationWords(target),/右侧偏下.*右边缘/);assert.match(locationWords(target,null,{snapshot:true}),/刚才的镜头画面/);
});
test('wrong frame or target rectangle is rejected; overlapping, distant or invalid anchors cannot create a relation',()=>{
 const data={f:8,visible:true,target_box:target,anchors:[{name:'黑色手机',box:[.4,.65,.6,.85]},{name:'相同目标',box:target},{name:'厨房柜子',box:[.1,.1,.2,.2]}],surface:{name:'白色桌面',relation:'on',box:[0,0,1,1]}};
 assert.deepEqual(parseFoundLocation(data,8,target),detail);
 assert.throws(()=>parseFoundLocation({...data,f:9},8,target),/context_invalid/);assert.throws(()=>parseFoundLocation({...data,target_box:[.1,.1,.3,.3]},8,target),/context_invalid/);
 assert.equal(parseFoundLocation({...data,surface:{name:'白色桌面',relation:'on',box:[0,0,.3,.3]}},8,target).surface,null);
 assert.deepEqual(parseFoundLocation({...data,anchors:[],surface:null},8,target),{anchors:[],surface:null});
});
test('landmark model receives only the full accepted image and rectangle, with fresh isolated context',async()=>{
 let prompt,resets=0;const p=new OmniProviders({prepare:async(current,reference)=>{assert.deepEqual(current,picture);assert.equal(reference,undefined);return picture;},positionClient:{reset(){resets++;},request:async value=>{prompt=value;return JSON.stringify({f:8,visible:true,target_box:target,anchors:[{name:'黑色手机',box:[.4,.65,.6,.85]}],surface:null});}}});
 const nearby=[.4,.65,.6,.85];
 const r=await p.describeFoundLocation({...frame(),frameId:8},target,undefined,[{score:.9,box:target},{score:.4,box:nearby},{score:.9,box:nearby}]);assert.deepEqual(JSON.parse(prompt.split('请求数据：').at(-1)).nearby_boxes,[nearby]);assert.equal(resets,1);assert.equal(r.anchors[0].name,'黑色手机');assert.doesNotMatch(prompt,/历史中厨房的柜子|黄色颗粒表面|黄色玉米/);
});

test('centred corn reports available layers and explains a missing landmark once',()=>{
 const box=[.4,.4,.6,.6],surface={name:'白色桌面',box:[0,0,1,1],relation:'on'};
 const parse=anchors=>parseFoundLocation({f:8,visible:true,target_box:box,anchors,surface},8,box);
 assert.equal(locationWords(box,parse([]),{snapshot:true}),'在刚才的镜头画面中央，白色桌面上。附近可作参照的物品还没辨认清楚。');
 assert.equal(locationWords(box,parse([{name:'书',box:[.1,.4,.3,.6]}]),{snapshot:true}),'在刚才的镜头画面中央，白色桌面上，书的右侧。');
});

test('nearby caution is bounded to visible allowed anchors and appears only once',()=>{
 const box=[.45,.45,.6,.6];
 const parse=anchors=>parseFoundLocation({f:1,visible:true,target_box:box,anchors,surface:null},1,box);
 const scissors={name:'剪刀',box:[.65,.45,.8,.6],caution:'sharp'};
 const glass={name:'玻璃杯',box:[.2,.45,.35,.6],caution:'fragile'};
 const words=locationWords(box,parse([glass,scissors]));
 assert.match(words,/拿取时注意旁边的剪刀/);assert.equal((words.match(/拿取时注意/g)??[]).length,1);
 for(const anchor of [
  {...glass,name:'热水杯'}, {...glass,caution:'sharp'}, {...glass,caution:'unknown'},
  {...scissors,box:[0,0,.1,.1]}, {...scissors,box}
 ])assert.doesNotMatch(locationWords(box,parse([anchor])),/拿取时注意/);
 assert.match(locationWords(box,parse([glass])),/拿取时注意旁边的玻璃杯/);
});

test('found result appends the caution in the same single reply',async t=>{
 const x=setup(t,async()=>({anchors:[{name:'玻璃杯',box:[.45,.65,.6,.85],caution:'fragile'}],surface:null}));
 await x.send('找之前记住的黄色玉米');await wait(()=>!!x.s.pendingFeedback);
 assert.match(reply(x.events),/拿取时注意旁边的玻璃杯/);
 assert.equal(x.events.filter(e=>e.kind==='result').length,1);
});

test('retrieved feedback is positive and idempotent; three successful tasks shorten the next result',async t=>{
 const x=setup(t,async()=>detail),object=x.m.all()[0];
 for(let i=0;i<3;i++){
  x.feed();await x.send('找之前记住的黄色玉米');await wait(()=>!!x.s.pendingFeedback);
  assert.match(reply(x.events),/^发现一件外观相符/);
  await x.send('拿到了');await x.send('拿到了');
  assert.equal(x.m.searchProfile(x.m.get(object.id)).confirmed,i+1);
  assert.equal(x.m.searchFeedback(object)[0].referenceId,x.m.photos(object)[0].image);
 }
 assert.equal(x.m.get(object.id).events.length,3);
 x.feed();await x.send('找之前记住的黄色玉米');await wait(()=>!!x.s.pendingFeedback);
 assert.match(reply(x.events),/^匹配到黄色玉米/);
});

test('spoken confirmation can be corrected, resets familiarity and forces two distinct frames',async t=>{
 const x=setup(t,async()=>detail),object=x.m.all()[0];
 await x.send('找之前记住的黄色玉米');await wait(()=>!!x.s.pendingFeedback);
 await x.send('对，就是我要找的那个');assert.equal(x.m.searchProfile(object).confirmed,1);
 x.s.detector.ready=false;
 await x.send('认错了，这个是胡萝卜');
 assert.deepEqual(x.m.searchProfile(object),{confirmed:0,corrected:1,streak:0,familiar:false,recheck:true});
 const task=x.s.task,batch=[{label:'carrot',trackId:1,box:target,cropJpeg:picture.toString('base64')}];
 const r={status:'LIKELY_MATCH',selected:{candidateIndex:0,box:target,scores:{base:.9}}};
 x.feed();let f=x.s.frozen();x.s.lastAnalyzed={at:x.s.now(),frameId:f.frameId,detections:batch};
 await x.s.handleAppearance(r,f,task,batch,x.s.serial);assert.equal(task.found,false);
 await x.s.handleAppearance(r,f,task,batch,x.s.serial);assert.equal(task.found,false);
 x.feed();f=x.s.frozen();x.s.lastAnalyzed={at:x.s.now(),frameId:f.frameId,detections:batch};
 await x.s.handleAppearance(r,f,task,batch,x.s.serial);assert.equal(task.found,true);
 assert.match(reply(x.events),/^发现一件外观相符/);
});

test('feedback is cleared by another task or camera and stale or deleted results cannot train',async t=>{
 const x=setup(t,async()=>detail),object=x.m.all()[0];
 await x.send('找之前记住的黄色玉米');await wait(()=>!!x.s.pendingFeedback);
 await x.send('黄色玉米上次在哪里');await x.send('拿到了');assert.equal(x.m.searchProfile(object).confirmed,0);
 x.feed();await x.send('找之前记住的黄色玉米');await wait(()=>!!x.s.pendingFeedback);
 x.s.now=()=>Date.now()+121000;await x.send('拿到了');assert.equal(x.m.searchProfile(object).confirmed,0);
 x.s.now=Date.now;x.feed();await x.send('找之前记住的黄色玉米');await wait(()=>!!x.s.pendingFeedback);
 x.s.start('ESP32');await x.send('拿到了');assert.equal(x.m.searchProfile(object).confirmed,0);
});

test('a correction after retrieved retracts only that task retrieval event',async t=>{
 const x=setup(t,async()=>detail),object=x.m.all()[0];
 const prior=x.m.recordRetrieved(object.id);
 await x.send('找之前记住的黄色玉米');await wait(()=>!!x.s.pendingFeedback);
 await x.send('拿到了');assert.equal(x.m.get(object.id).events.length,2);
 x.s.detector.ready=false;await x.send('认错了');
 assert.equal(x.m.searchProfile(object).corrected,1);
 assert.deepEqual(x.m.get(object.id).events.map(e=>e.id),[prior]);
});

test('generic acknowledgements do not count and semantic feedback requires a current result',async t=>{
 const x=setup(t,async()=>detail),object=x.m.all()[0];
 await x.send('找之前记住的黄色玉米');await wait(()=>!!x.s.pendingFeedback);
 await x.send('好的');assert.equal(x.m.searchProfile(object).confirmed,0);
 x.s.providers.intent=async(raw,focus,names,signal,context)=>{
  assert.equal(context.pendingSearchResult.target,'黄色玉米');
  return {action:'accept',evidence:raw};
 };
 await x.send('没错，你给我找到的正是我要的那一个');assert.equal(x.m.searchProfile(object).confirmed,1);
 x.s.start();x.feed();x.s.providers.intent=async raw=>({action:'accept',evidence:raw});
 await x.send('没错，你给我找到的正是我要的那一个');assert.equal(x.m.searchProfile(object).confirmed,1);
 assert.match(reply(x.events),/哪次找物结果/);
});
