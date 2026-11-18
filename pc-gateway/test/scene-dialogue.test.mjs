import test from 'node:test';
import assert from 'node:assert/strict';
import {Session} from '../src/session.mjs';
import {SceneDialogue} from '../src/scene-dialogue.mjs';
import {parseIntent,validateSemantic} from '../src/intent.mjs';
import {memory,picture,frame} from './helpers.mjs';
import {uuid} from '../src/util.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const flush=()=>new Promise(r=>setImmediate(r));
function setup(t,extra={}){
 const m=memory(t),events=[],calls=[],saved=m.capture('手机',frame());m.finish(saved,{description:'银色手机',suggestedLocation:'昨天的柜子里',failureKind:'REVIEW_UNCERTAIN'});
 const before=m.all();let now=Date.now(),backups=0;
 const providers={describe:async(f,target)=>{calls.push({kind:'describe',frame:f.frameId,target});return {v:true,answer:'桌上有手机、耳机和水杯。',items:['手机','耳机','水杯']};},locate:async(f,intent)=>{calls.push({kind:'locate',frame:f.frameId,...intent});return {v:true,answer:'耳机在画面右侧，手机旁边。',items:['手机','耳机','水杯']};},...extra};
 const s=new Session({memory:m,providers,backup:{schedule:()=>{backups++;}},now:()=>now,emit:e=>events.push(e)});
 s.start();s.frame(picture,s.source.generation,1,now);s.focus=m.get(saved.objectId);
 const command=text=>s.command({commandId:uuid(),text});
 const feed=()=>s.frame(picture,s.source.generation,(s.source.fresh()?.frameId??0)+1,now);
 return {s,m,events,calls,command,feed,before,backups:()=>backups,advance:ms=>now+=ms};
}
test('scene then earphone location uses a newer current frame, with zero persistent or backup writes',async t=>{
 const x=setup(t);await x.command('现在桌面上有什么');x.feed();await x.command('这个耳机的位置在哪里');
 assert.deepEqual(x.calls.map(c=>[c.kind,c.frame]),[['describe',1],['locate',2]]);assert.equal(x.calls[1].target,'耳机');
 assert.match(x.events.filter(e=>e.kind==='result').at(-1).message,/画面右侧/);
 assert.equal(x.s.focus,null);assert.equal(x.s.task,null);assert.equal(x.backups(),0);assert.deepEqual(x.m.all(),x.before);
 assert.ok(!x.events.some(e=>e.type==='memory.changed'));
 await x.command('拿到了');assert.deepEqual(x.m.all(),x.before);
});
test('pronouns refer to the last current-view subject, never a saved phone from another task',async t=>{
 const x=setup(t);await x.command('桌面有什么');await x.command('耳机在哪里');x.feed();await x.command('它旁边有什么');
 assert.equal(x.calls.at(-1).target,'耳机');assert.match(x.calls.at(-1).question,/旁边有什么/);
 assert.deepEqual(x.m.all(),x.before);
});
test('an ambiguous pronoun after a scene with several objects asks which object without another inference',async t=>{
 const x=setup(t);await x.command('桌面有什么');await x.command('它在哪里');assert.equal(x.calls.length,1);
 assert.match(x.events.filter(e=>e.kind==='result').at(-1).message,/哪件物品/);assert.deepEqual(x.m.all(),x.before);
});
test('explicit past-location questions still read saved records after a current scene',async t=>{
 const x=setup(t);await x.command('桌面有什么');await x.command('手机上次在哪里');
 assert.equal(x.calls.length,1);assert.match(x.events.filter(e=>e.kind==='result').at(-1).message,/昨天的柜子里/);assert.deepEqual(x.m.all(),x.before);
});
test('only an explicit remember command promotes an observed earphone to persistent memory',async t=>{
 const x=setup(t,{singlePassMemory:true,describe:async(f,target)=>target?{v:true,n:'白色耳机',d:'白色无线耳机',l:'手机右侧',b:null}:{v:true,answer:'有手机和耳机',items:['手机','耳机']}});
 await x.command('桌面有什么');await x.command('这个耳机在哪里');assert.deepEqual(x.m.all(),x.before);
 await x.command('帮我记住它的位置');assert.equal(x.m.all().length,2);assert.equal(x.m.all()[1].name,'白色耳机');assert.match(x.m.history(x.m.all()[1].id),/手机右侧/);assert.equal(x.backups(),2);
});
test('a pending scene or location response cannot resurrect context after a newer task or new conversation',async t=>{
 const old=deferred();const x=setup(t,{locate:()=>old.promise});await x.command('桌面有什么');const pending=x.command('耳机在哪里');
 await x.command('手机上次在哪里');old.resolve({v:true,answer:'过时的耳机位置',items:['耳机']});await pending;
 assert.equal(x.s.sceneDialogue.fresh(x.s.source.generation),null);assert.ok(!x.events.some(e=>e.message==='过时的耳机位置'));
 x.s.bindConversation('new-scene-session');assert.equal(x.s.sceneDialogue.value,null);assert.deepEqual(x.m.all(),x.before);
});
test('current location requires a fresh frame and cannot fall back to a saved old position',async t=>{
 const x=setup(t);await x.command('桌面有什么');x.s.source.stop();await x.command('这个手机在哪里');
 assert.equal(x.calls.length,1);assert.doesNotMatch(x.events.filter(e=>e.kind==='result').at(-1).message,/柜子里/);assert.match(x.events.filter(e=>e.kind==='result').at(-1).message,/打开镜头/);
});
test('partial speech can analyze a read-only location and final transcription reuses it once',async t=>{
 const work=deferred();let locations=0;const x=setup(t,{locate:()=>{locations++;return work.promise;}});await x.command('桌面有什么');
 x.s.prepareSpeech('earphones','这个耳机在哪里');await flush();assert.equal(locations,1);
 const pending=x.s.command({commandId:uuid(),utteranceId:'earphones',text:'这个耳机在哪里？'});
 work.resolve({v:true,answer:'耳机在手机右侧',items:['耳机','手机']});await pending;
 assert.equal(locations,1);assert.ok(x.events.some(e=>e.operation==='speech_vision_reused'));assert.deepEqual(x.m.all(),x.before);assert.equal(x.backups(),0);
});
test('expired pronouns require clarification while a named current-scene question stays separate from memory',async t=>{
 const x=setup(t);await x.command('桌面有什么');await x.command('耳机在哪里');x.advance(120001);x.feed();await x.command('它在哪里');
 assert.match(x.events.filter(e=>e.kind==='result').at(-1).message,/哪件物品/);await x.command('手机在哪里');assert.equal(x.calls.at(-1).kind,'locate');assert.equal(x.calls.at(-1).target,'手机');
 assert.doesNotMatch(x.events.filter(e=>e.kind==='result').at(-1).message,/柜子里/);assert.deepEqual(x.m.all(),x.before);
});
test('local routing recognizes ordinary relative-position questions and preserves explicit search commands',()=>{
 const scene=new SceneDialogue();scene.remember(frame(),{items:['手机','耳机']});const generation=scene.value.generation;
 for(const q of ['这个耳机的位置在哪里','这副耳机在什么位置','耳机在手机的哪一边','这个耳机旁边有什么','现在耳机在哪','耳机的位置']){
  const r=scene.route(q,parseIntent(q),generation);assert.equal(r.action,'locate',q);assert.equal(r.target,'耳机',q);
 }
 assert.equal(scene.route('帮我找手机',parseIntent('帮我找手机'),generation).action,'find');
 assert.equal(scene.route('手机上次在哪里',parseIntent('手机上次在哪里'),generation).action,'history');
 assert.equal(validateSemantic({action:'remember',target:'耳机'},'不要记住耳机',null),null);
});
