import test from 'node:test';
import assert from 'node:assert/strict';
import {Session} from '../src/session.mjs';
import {parseIntent} from '../src/intent.mjs';
import {memory,frame,picture} from './helpers.mjs';
import {uuid} from '../src/util.mjs';
function setup(t,status='LIKELY_MATCH',base=.88){
 const m=memory(t),events=[],reviews=[],seen=[];
 for(const name of ['蓝色杯子','红色杯子']){
  const r=m.capture(name,frame());
  m.finish(r,{description:name,appearance:{jpeg:picture,embedding:Buffer.alloc(192).toString('base64')}});
 }
 const s=new Session({memory:m,providers:{targetLocator:{async locate(f,name){seen.push([f.frameId,name]);return {photo:{jpeg:picture}};}},review:async(f,o)=>{reviews.push(o);return {status,selected:{scores:{base}}};}},emit:e=>events.push(e)});
 s.start();s.frame(picture,s.source.generation,1,Date.now());t.after(()=>s.stop());
 return {s,m,events,reviews,seen,send:text=>s.command({commandId:uuid(),text}),answer:()=>events.filter(e=>e.kind==='result').at(-1)?.message};
}
const phrase='你帮我看一下桌面上这个红色杯子，是不是我之前记住的那个杯子。';
test('named red cup is compared with its saved photograph once, without starting search',async t=>{
 const x=setup(t),before=x.m.all();assert.equal(parseIntent(phrase).target,'红色杯子');await x.send(phrase);
 assert.match(x.answer(),/红色杯子.*参考照片外观相符/);assert.equal(x.reviews.length,1);assert.equal(x.reviews[0].objectId,before[1].id);assert.deepEqual(x.reviews[0].references,[picture]);assert.deepEqual(x.seen,[[1,'红色杯子']]);assert.equal(x.s.task,null);assert.deepEqual(x.m.all(),before);
});
test('multiple references are compared against the same frozen subject without a selection prompt',async t=>{
 const x=setup(t);await x.send('这个杯子是不是上次记住的那个杯子');
 assert.equal(x.s.choices,null);assert.equal(x.reviews.length,2);assert.equal(x.seen.length,1);
 assert.equal(x.seen[0][0],1);assert.equal(x.s.task,null);assert.match(x.answer(),/^(?:还没认准|这几件太像了)/);
 assert(!x.events.some(e=>/想用来核对/.test(e.message??'')));
});

for(const [status,base,expected]of [['NO_MATCH',0,/外观不相符/],['LIKELY_MATCH',.52,/还没认准/],['MODEL_ERROR',0,/还没认准/]])test('returns one explicit verdict '+status+base,async t=>{
 const x=setup(t,status,base);await x.send(phrase);assert.match(x.answer(),expected);assert.equal(x.s.task,null);
 const event=x.events.find(e=>e.type==='experiment.match');
 if(status==='MODEL_ERROR')assert.equal(event,undefined);
 else {assert.equal(event.selected.scores.base,base);assert.equal(event.minBaseScore,.65);assert.equal(event.status,base>=.4?'RECHECKING':'NO_MATCH');}
 assert.doesNotMatch(x.answer(),/匹配分|门槛|[0-9]/);
});

test('earphone comparison keeps the described subject and compares it to the stored photo, even if the camera moves',async t=>{
 const x=setup(t),r=x.m.capture('白色耳机',frame());
 x.m.finish(r,{description:'白色的耳机',appearance:{jpeg:picture,embedding:Buffer.alloc(192).toString('base64')}});
 const box=[.1,.2,.3,.4];
 x.s.providers.locate=async()=>({v:true,items:['白色耳机'],targetBox:box,answer:'白色耳机在桌面左侧。'});
 x.s.providers.targetLocator.locate=async(f,target,options)=>{
  x.seen.push({frame:f.frameId,target,box:options.observedBox});
  return f.frameId===1?{photo:{jpeg:picture}}:null;
 };
 await x.send('这个白色耳机的位置在哪里');
 x.s.frame(picture,x.s.source.generation,2,Date.now());
 await x.send('这个和之前保存的物品是否一致');
 assert.deepEqual(x.seen,[{frame:1,target:'白色耳机',box}]);
 assert.equal(x.reviews[0].objectId,r.objectId);assert.deepEqual(x.reviews[0].references,[picture]);
 assert.match(x.answer(),/刚才描述的.*外观相符/);
 await x.send('核对现在这件');
 assert.equal(x.seen[1].frame,2);assert.equal(x.seen[1].box,undefined);assert.equal(x.reviews.length,1);
 assert.match(x.answer(),/核对现在这件/);
});

test('the visible white earphones and the specified saved black earphones stay distinct',async t=>{
 const x=setup(t);
 for(const name of ['黑色耳机','白色耳机']){
  const r=x.m.capture(name,frame());
  x.m.finish(r,{description:name,appearance:{jpeg:picture,embedding:Buffer.alloc(192).toString('base64')}});
 }
 x.s.providers.locate=async()=>({v:true,items:['白色耳机'],answer:'白色耳机在桌上。'});
 await x.send('这个白色耳机的位置在哪里');
 x.s.frame(picture,x.s.source.generation,2,Date.now());
 await x.send('这副和之前保存的黑色耳机是否一致');
 assert.deepEqual(x.seen,[[1,'白色耳机']]);assert.equal(x.reviews[0].objectId,x.m.matching('黑色耳机')[0].id);
});

test('a clear blue cup is compared with the transparent reference, using the same frame on a second localization',async t=>{
 const x=setup(t,'LIKELY_MATCH',.65),r=x.m.capture('透明塑料杯',frame());
 x.m.finish(r,{appearance:{jpeg:picture,embedding:Buffer.alloc(192).toString('base64')}});
 const box=[.2,.3,.6,.7],seen=[];
 x.s.providers.targetLocator.locate=async(f,target,options)=>{
  seen.push([f.frameId,target,options.observedBox]);return options.observedBox?{photo:{jpeg:picture}}:null;
 };
 x.s.providers.locate=async(f,{target})=>{assert.equal(f.frameId,1);assert.equal(target,'蓝色水杯');return {v:true,targetBox:box};};
 await x.send('这个蓝色的水杯是不是之前那个透明的水杯');
 assert.deepEqual(seen,[[1,'蓝色水杯',undefined],[1,'蓝色水杯',box]]);
 assert.equal(x.reviews[0].objectId,r.objectId);assert.deepEqual(x.reviews[0].references,[picture]);
 assert.equal(x.events.find(e=>e.type==='experiment.match').status,'LIKELY_MATCH');
 assert.match(x.answer(),/外观相符/);assert.equal(x.events.filter(e=>e.type==='reply').length,1);
 x.s.focus=x.m.get(r.objectId);
 const next=x.s.readIntent('这个是不是之前那个透明的水杯');
 assert.equal(next.visibleTarget,'水杯');assert.equal(next.target,'透明水杯');
});
test('no usable current crop emits no score; a retry keeps the visible cup distinct from the saved cup',async t=>{
 const x=setup(t);x.s.providers.targetLocator.locate=async()=>null;
 await x.send('这个蓝色杯子是不是之前保存的红色杯子');assert.equal(x.reviews.length,0);
 assert(!x.events.some(e=>e.type==='experiment.match'));x.s.frame(picture,x.s.source.generation,2,Date.now());
 x.s.providers.targetLocator.locate=async(f,name)=>{assert.equal(f.frameId,2);assert.equal(name,'蓝色杯子');return {photo:{jpeg:picture}};};
 await x.send('核对现在这件');assert.equal(x.reviews[0].objectId,x.m.matching('红色杯子')[0].id);
});

for (const [scores,expected] of [[[.1,.2],/^不是/],[[.9,.1],/^是/],[[.9,.88],/^(?:还没认准|这几件太像了)/]]) test('automatically compare every mouse reference '+scores,async t=>{
 const x=setup(t),ids=[];
 for(const name of ['粉色无线鼠标','粉色有线鼠标']){
  const r=x.m.capture(name,frame());ids.push(r.objectId);
  x.m.finish(r,{description:name,appearance:{jpeg:picture,embedding:Buffer.alloc(192).toString('base64')}});
 }
 let calls=0;x.s.providers.review=async(f,o)=>{x.reviews.push(o);return {status:'LIKELY_MATCH',selected:{scores:{base:scores[calls++]}}};};
 const before=x.m.all();
 await x.send('这个黑色鼠标是不是我上次让你记住的那个鼠标');
 assert.match(x.answer(),expected);assert.equal(calls,2);assert.equal(x.seen.length,1);
 assert.deepEqual(x.reviews.map(r=>r.objectId),ids);assert.equal(x.s.choices,null);
 assert.deepEqual(x.m.all(),before);assert.equal(x.events.filter(e=>e.type==='reply').length,1);
});
test('explicit black reference keeps current pink subject separate',()=>{
 const intent=parseIntent('这个粉色鼠标和我上次让你记住的那个黑色鼠标是不是同一个鼠标');
 assert.equal(intent.action,'identify');assert.equal(intent.target,'黑色鼠标');assert.equal(intent.visibleTarget,'粉色鼠标');
});
test('missing reference photos prevent a false all-rejected result',async t=>{
 const x=setup(t,'NO_MATCH',.1);
 for(const name of ['粉色无线鼠标','粉色有线鼠标']){
  const r=x.m.capture(name,frame());
  if(name.includes('无线'))x.m.finish(r,{appearance:{jpeg:picture,embedding:Buffer.alloc(192).toString('base64')}});
 }
 await x.send('这个鼠标是不是上次记住的那个鼠标');
 assert.match(x.answer(),/^与已有参考照片的记录相比.*外观不相符/);assert.doesNotMatch(x.answer(),/其余|缺少参考照片|无法完成全部核对/);assert.ok(x.events.some(e=>e.operation==='identify_references'&&e.code==='missing_photos'&&e.matchCount===1&&e.referenceCount===1));assert.equal(x.reviews.length,1);
});

test('model failure among references prevents a definite yes',async t=>{
 const x=setup(t);let calls=0;
 x.s.providers.review=async()=>++calls===1?{status:'LIKELY_MATCH',selected:{scores:{base:.9}}}:{status:'MODEL_ERROR'};
 await x.send('这个杯子是不是之前那个杯子');assert.equal(calls,2);assert.match(x.answer(),/^(?:还没认准|这几件太像了)/);
});
test('changing an earlier reference during later comparisons invalidates the final verdict',async t=>{
 const x=setup(t);let first;let calls=0;
 x.s.providers.review=async(f,o)=>{if(++calls===1)first=o.objectId;else x.m.delete({id:first,recorded_at:new Date(x.m.get(first).updatedAtMs).toISOString()});return {status:'NO_MATCH',selected:{scores:{base:.1}}};};
 await x.send('这个杯子是不是之前那个杯子');assert.match(x.answer(),/记录刚更新/);
});

for(const missingFirst of [true,false])test('same-name incomplete record does not hide a confirmed reference '+missingFirst,async t=>{
 const x=setup(t);let complete;
 for(const missing of [missingFirst,!missingFirst]){
  const r=x.m.capture('黑色鼠标',frame());
  if(!missing){complete=r.objectId;x.m.finish(r,{appearance:{jpeg:picture,embedding:Buffer.alloc(192).toString('base64')}});}
 }
 const before=x.m.all();await x.send('帮我看一下眼前的这个鼠标，是之前让你记住的那个黑色鼠标吗');
 assert.match(x.answer(),/^是，看起来/);assert.doesNotMatch(x.answer(),/其余|缺少参考照片|无法完成全部核对/);assert.ok(x.events.some(e=>e.operation==='identify_references'&&e.code==='missing_photos'&&e.matchCount===1&&e.referenceCount===1));
 assert.equal(x.reviews.length,1);assert.equal(x.reviews[0].objectId,complete);
 assert.equal(x.s.focus.id,complete);assert.deepEqual(x.m.all(),before);
});
test('all references missing remain explicitly unavailable',async t=>{
 const x=setup(t);x.m.capture('黑色鼠标',frame());x.m.capture('黑色鼠标',frame());
 await x.send('这个鼠标是不是之前那个黑色鼠标');
 assert.match(x.answer(),/^我还没记清它的样子/);assert.equal(x.reviews.length,0);
});
