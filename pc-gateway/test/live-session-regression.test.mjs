import test from 'node:test';
import assert from 'node:assert/strict';
import {parseIntent} from '../src/intent.mjs';
import {parseOmniReview} from '../src/omni.mjs';
import {Session} from '../src/session.mjs';
import {memory,picture,frame} from './helpers.mjs';
import {uuid} from '../src/util.mjs';
const flush=()=>new Promise(r=>setImmediate(r));
test('actual 17:45–17:46 utterances distinguish current search from history and scene questions',()=>{
 for(const q of ['嗯，帮我找到手机在哪里。','根据我现在的画面，帮我找到我的上次我手机在哪里。'])assert.deepEqual(parseIntent(q,'手机'),{action:'find',target:'手机'});
 for(const q of ['现在这个桌面有什么？','现在桌面上面有什么','描述一下这桌上面有什么。'])assert.equal(parseIntent(q,'手机').action,'describe');
 for(const q of ['你还记得之前我手机放在哪里吗','你还记得我的手机之前放在哪里吗','你还记得之前我的手机放在哪里吗'])assert.deepEqual(parseIntent(q,'手机'),{action:'history',target:'手机'});
 assert.equal(parseIntent('手机上次在哪里','手机').action,'history');
 assert.equal(parseIntent('我的手机在哪','手机').action,'find');
});
test('asking for a scene while searching phones invokes scene analysis rather than another phone review',async t=>{
 const m=memory(t),events=[];let descriptions=0;
 const s=new Session({memory:m,providers:{describe:async()=>{descriptions++;return {answer:'桌上有电脑和手机。'};}},emit:e=>events.push(e)});
 s.start();s.frame(picture,s.source.generation,1,Date.now());
 await s.command({commandId:uuid(),text:'帮我找之前记住的手机'});
 await s.command({commandId:uuid(),text:'现在这个桌面有什么？'});
 assert.equal(descriptions,1);assert.equal(s.task,null);assert.equal(s.state,'IDLE');assert.equal(events.filter(e=>e.kind==='result').at(-1).message,'桌上有电脑和手机。');
});
test('history and ordinary conversation end an active search instead of silently leaving a stalled search screen',async t=>{
 const m=memory(t);const c=m.capture('手机',frame());m.finish(c,{description:'黑色手机',suggestedLocation:'电脑左边',failureKind:'REVIEW_UNCERTAIN'});
 const events=[];const s=new Session({memory:m,providers:{},emit:e=>events.push(e)});
 await s.command({commandId:uuid(),text:'帮我找之前记住的手机'});assert.ok(s.task);
 await s.command({commandId:uuid(),text:'手机的样子'});
 assert.equal(s.task,null);assert.equal(s.state,'IDLE');assert.match(events.filter(e=>e.kind==='result').at(-1).message,/黑色手机/);
 await s.command({commandId:uuid(),text:'继续找'});assert.ok(s.task);assert.equal(s.task.objectId,c.objectId);
});
test('generic visibility can confirm a category without claiming personal identity; personal matches remain strict',()=>{
 const raw=JSON.stringify({f:1,visible:true,clear:true,distinctive:false,same:'UNCERTAIN',evidence:'画面中有一块棕色纸板'});
 assert.equal(parseOmniReview(raw,1,false).decision,'CONFIRM');assert.equal(parseOmniReview(raw,1,true).decision,'UNCERTAIN');
 assert.equal(parseOmniReview(raw,1,true).visible,true);assert.equal(parseOmniReview(raw,1,true).clear,true);
});
test('a visible phone with unproven personal identity gets a useful current-view answer without a false match',async t=>{
 const m=memory(t);const c=m.capture('手机',frame());m.finish(c,{description:'黑色手机',suggestedLocation:'桌上',failureKind:'REVIEW_UNCERTAIN'});
 const phone={label:'cell phone',score:.9,box:[.1,.1,.3,.7],cropJpeg:picture.toString('base64')},events=[];
 const s=new Session({memory:m,providers:{review:async()=>({decision:'UNCERTAIN',visible:true,clear:true,provider:'omni'})},detector:{ready:true,busy:false,run:async()=>({detections:[phone],candidates:[phone]})},emit:e=>events.push(e)});
 s.start();s.frame(picture,s.source.generation,1,Date.now());await s.command({commandId:uuid(),text:'帮我找之前记住的手机'});await s.tick();await flush();
 const answer=events.filter(e=>e.kind==='result').at(-1).message;
 assert.match(answer,/画面左侧能看到手机/);assert.match(answer,/不能确认是否是你记录/);assert.doesNotMatch(answer,/参考相符/);assert.equal(s.state,'SEARCHING');assert.equal(s.lastConfirmed,null);
 assert.ok(events.some(e=>e.operation==='review_decision'&&e.decision==='UNCERTAIN'));
});
