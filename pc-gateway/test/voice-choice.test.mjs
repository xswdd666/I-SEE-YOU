import test from 'node:test';
import assert from 'node:assert/strict';
import {Session} from '../src/session.mjs';
import {OmniProviders} from '../src/omni.mjs';
import {identityQuestion} from '../src/memory-dialogue.mjs';
import {featureMatch} from '../src/visual-choice.mjs';
import {memory,frame,picture} from './helpers.mjs';
import {uuid} from '../src/util.mjs';
const wait=async predicate=>{const end=Date.now()+3000;while(!predicate()){assert(Date.now()<end,'voice question did not complete');await new Promise(r=>setTimeout(r,5));}};
const looks=[{description:'银色机身，外壳带贴纸',features:['银色','贴纸']},{description:'黑色机身，表面有条纹',features:['黑色','条纹']}];
function setup(t,describeCandidate=async(_,c)=>looks[c.trackId-1]){
 const m=memory(t),events=[],receipt=m.capture('苹果笔记本电脑',frame());
 m.finish(receipt,{description:'历史图中有苹果标志',appearance:{jpeg:picture,embedding:Buffer.alloc(192).toString('base64')}});
 const batch=[{label:'laptop',trackId:1,box:[.1,.1,.4,.9],cropJpeg:picture.toString('base64')},{label:'laptop',trackId:2,box:[.6,.1,.9,.9],cropJpeg:picture.toString('base64')}];
 const pick=i=>({candidateIndex:i,box:batch[i].box,scores:{base:.55,total:.55}});
 const s=new Session({memory:m,providers:{backend:'appearance_mvp',localOnlyReview:true,describeCandidate,review:async()=>({status:'AMBIGUOUS',selected:pick(0),choices:[pick(0),pick(1)]})},detector:{ready:true,busy:false,run:async f=>({frameId:f.frameId,detections:batch,candidates:batch})},emit:e=>events.push(e)});
 t.after(()=>s.stop());s.start();s.frame(picture,s.source.generation,1,Date.now());
 return {s,m,events,send:text=>s.command({commandId:uuid(),text}),question:async()=>{await s.command({commandId:uuid(),text:'找之前记住的苹果笔记本电脑'});await wait(()=>s.choices?.questionReady);},answer:()=>events.filter(e=>e.kind==='result').at(-1)?.message};
}
test('spoken ambiguity uses actual surface features, never target brand, ordinals or screen selection',async t=>{
 const x=setup(t),before=x.m.all();await x.question();
 assert.match(x.answer(),/银色.*贴纸.*是你要找/);assert.doesNotMatch(x.answer(),/苹果|第一|第二|第几|点击|请选择/);
 assert(x.events.filter(e=>e.type==='choices').every(e=>e.voiceOnly&&e.items.every(i=>!/苹果|第[一二0-9]/.test(i.name))));
 await x.send('是的');assert.equal(x.s.state,'COMPLETED');assert.equal(x.s.lastConfirmed.trackId,1);assert.deepEqual(x.m.all(),before);
});
test('a negative answer advances the spoken feature question and a natural feature selects that candidate',async t=>{
 const x=setup(t);await x.question();await x.send('不是');assert.match(x.answer(),/黑色.*条纹/);
 await x.send('黑色的，有条纹的');assert.equal(x.s.lastConfirmed.trackId,2);
});
test('a corrected surface feature is not mistaken for confirmation of the preceding candidate',async t=>{
 const x=setup(t);await x.question();await x.send('不是，黑色的');assert.equal(x.s.lastConfirmed,null);assert.match(x.answer(),/黑色.*条纹/);
 await x.send('就是它');assert.equal(x.s.lastConfirmed.trackId,2);
});
test('ordinal input repeats the feature question instead of silently choosing a visual item',async t=>{
 const x=setup(t);await x.question();await x.send('第二件');assert.equal(x.s.lastConfirmed,null);assert.match(x.answer(),/银色.*贴纸/);assert.doesNotMatch(x.answer(),/第一|第二|第几/);
});
test('one colour cannot silently disambiguate an undescribed competing object',async t=>{
 const x=setup(t);await x.question();await x.send('银色的');assert.equal(x.s.lastConfirmed,null);assert.match(x.answer(),/银色.*贴纸.*是你要找/);
 await x.send('是的');assert.equal(x.s.lastConfirmed.trackId,1);assert.match(x.answer(),/银色.*贴纸/);
});
test('unclear candidate details ask for a better view without fabricating feature questions',async t=>{
 const x=setup(t,async()=>null);await x.send('找之前记住的苹果笔记本电脑');await wait(()=>x.events.some(e=>/细节还没看清/.test(e.message??'')));
 assert.equal(x.s.choices,null);assert.equal(x.s.lastConfirmed,null);assert(!x.events.some(e=>e.type==='choices'));
});
test('new questions cancel delayed feature descriptions and cannot revive old choices',async t=>{
 let finish,signal;const x=setup(t,(_,__,sig)=>{signal=sig;return new Promise(r=>finish=r);});
 await x.send('找之前记住的苹果笔记本电脑');await wait(()=>!!finish);await x.send('苹果笔记本电脑上次在哪里');assert(signal.aborted);
 finish(looks[0]);await new Promise(r=>setImmediate(r));assert.equal(x.s.choices,null);assert(!x.events.some(e=>e.type==='choices'));
});
test('both rejections resume scanning and cancel/expired questions never confirm a candidate',async t=>{
 const x=setup(t);await x.question();await x.send('都不是');assert.equal(x.s.choices,null);assert.equal(x.s.lastConfirmed,null);assert.match(x.answer(),/继续找/);
 const y=setup(t);await y.question();y.s.choices.expiresAt=1;await y.send('对');assert.equal(y.s.lastConfirmed,null);assert.match(y.answer(),/你想找哪件/);
 const z=setup(t);await z.question();await z.send('取消');assert.equal(z.s.choices,null);assert.equal(z.s.task,null);
});
test('unknown extra features and negated features never count as a match',()=>{
 assert.deepEqual(featureMatch('银色的，有贴纸的',looks),[0]);
 assert.deepEqual(featureMatch('银色的，有苹果标志',looks),[]);
 assert.deepEqual(featureMatch('不是银色的',looks),[]);
 assert.deepEqual(featureMatch('有贴纸的',[{description:'银色机身，没有贴纸',features:['银色','贴纸']}]),[]);
 assert.doesNotMatch(identityQuestion([{name:'水杯',description:'蓝色杯身，有把手'},{name:'水杯',description:'白色杯身，有花纹'}]),/第一|第二|第几|点击/);
});
test('visual feature request contains only current cropped pixels and validates frame/features',async()=>{
 let prompt;const f=frame();const p=new OmniProviders({prepare:async(c,ref)=>{assert.deepEqual(c,picture);assert.equal(ref,undefined);return picture;},candidateClient:{request:async value=>{prompt=value;return JSON.stringify({f:f.frameId,clear:true,...looks[0]});}}});
 assert.deepEqual(await p.describeCandidate(f,{cropJpeg:picture.toString('base64')}),looks[0]);
 assert.doesNotMatch(prompt,/苹果笔记本电脑|历史图中有苹果标志/);
 p.candidateClient.request=async()=>JSON.stringify({f:f.frameId+1,clear:true,...looks[0]});await assert.rejects(p.describeCandidate(f,{cropJpeg:picture.toString('base64')}),/frame_invalid/);
 p.candidateClient.request=async()=>JSON.stringify({f:f.frameId,clear:true,description:'银色机身',features:['苹果标志']});assert.equal(await p.describeCandidate(f,{cropJpeg:picture.toString('base64')}),null);
});
