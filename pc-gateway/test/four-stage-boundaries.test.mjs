import test from 'node:test';
import assert from 'node:assert/strict';
import {Session} from '../src/session.mjs';
import {identityReply} from '../src/memory-dialogue.mjs';
import {parseIntent,validateSemantic} from '../src/intent.mjs';
import {isRetake} from '../src/flows.mjs';
import {memory,frame,picture} from './helpers.mjs';
import {uuid} from '../src/util.mjs';
const flush=()=>new Promise(r=>setImmediate(r));
const wait=async predicate=>{const end=Date.now()+3000;while(!predicate()){assert(Date.now()<end,'flow did not finish');await new Promise(r=>setTimeout(r,5));}};
function seed(m,name,description){
 const r=m.capture(name,frame());m.finish(r,{description,suggestedLocation:'以前的柜子里',failureKind:'REVIEW_UNCERTAIN',appearance:{jpeg:picture,embedding:Buffer.alloc(192).toString('base64')}});return m.get(r.objectId);
}
function setup(t,extra={}){
 const m=memory(t),events=[],calls=[];
 const oldCup=seed(m,'水杯','白色杯身，有把手'),oldBottle=seed(m,'蓝色水杯','浅蓝色半透明塑料材质，圆柱形瓶身'),phone=seed(m,'银色手机','银色机身，黑色屏幕');
 m.rename(phone.id,'手机');const old=m.all();
 const c={label:'cup',trackId:1,score:.95,box:[.2,.1,.6,.9],cropJpeg:picture.toString('base64')};
 const providers={singlePassMemory:true,localOnlyReview:true,backend:'appearance_mvp',intent:async()=>({action:'clarify',answer:'请告诉我这次要观察、记住还是查询什么物品。'}),
  describe:async(f,target)=>{calls.push({kind:'describe',frameId:f.frameId,target});return target?{v:true,n:'白色饮料杯',d:'白色杯身，印有红色图案',l:'键盘右侧',b:c.box}:{v:true,answer:'桌面上有手机、耳机和饮料杯。',items:['手机','耳机','饮料杯']};},
  locate:async(f,options)=>{calls.push({kind:'locate',frameId:f.frameId,...options});return {v:true,answer:'耳机在画面右侧，手机旁边。',items:['耳机','手机']};},
  review:async(f,options)=>{calls.push({kind:'compare',frameId:f.frameId,objectId:options.objectId,references:options.references.length});return {status:'LIKELY_MATCH',selected:{candidateIndex:0,box:c.box,scores:{base:.85,total:.85}}};},...extra};
 let backups=0;
 const s=new Session({memory:m,providers,crop:async()=>({jpeg:picture,embedding:Buffer.alloc(192).toString('base64')}),backup:{schedule(){backups++;}},detector:{ready:true,busy:false,run:async f=>({frameId:f.frameId,detections:[c],candidates:[c]})},emit:e=>events.push(e)});
 t.after(()=>s.stop());s.start();let seq=0;const feed=()=>s.frame(picture,s.source.generation,++seq,Date.now());feed();
 return {s,m,old,oldCup,oldBottle,phone,events,calls,providers,feed,backups:()=>backups,send:text=>s.command({commandId:uuid(),text}),answer:()=>events.filter(e=>e.kind==='result').at(-1)?.message};
}
test('reported conversation: describe, ask relative location, remember drink cup, retake using phone, recall and compare',async t=>{
 const x=setup(t);await x.send('帮我描述一下这个桌面上有什么。');x.feed();await x.send('这个耳机的位置在哪里');
 assert.equal(x.s.flow,'scene');assert.match(x.answer(),/耳机.*手机旁边/);assert.equal(x.calls[1].frameId,2);assert.equal(x.calls[1].target,'耳机');assert.deepEqual(x.m.all(),x.old);assert.equal(x.backups(),0);
 x.feed();const saveStart=x.events.length;await x.send('帮我记住这个饮料杯的位置。');
 assert.equal(x.s.flow,'save');assert.equal(x.s.choices,null);assert.equal(x.m.all().length,4);assert.equal(x.calls.at(-1).target,'饮料杯');assert.equal(x.calls.at(-1).frameId,3);
 assert(!x.events.slice(saveStart).some(e=>e.type==='choices'||/我记过几件|你要找的那件/.test(e.message??'')));
 const cup=x.s.focus;assert.equal(cup.name,'白色饮料杯');assert.equal(x.m.photos(cup).length,1);assert.match(x.m.history(cup.id),/键盘右侧/);
 x.feed();await x.send('拍一下，手机拍一下这个。');assert.equal(x.s.focus.id,cup.id);assert.equal(x.m.all().length,4);assert.equal(x.calls.at(-1).target,'饮料杯');assert.equal(x.m.get(cup.id).captures.length,2);
 assert.deepEqual(x.m.get(x.phone.id),x.old.find(o=>o.id===x.phone.id));assert.deepEqual(x.m.get(x.oldCup.id),x.old.find(o=>o.id===x.oldCup.id));assert.deepEqual(x.m.get(x.oldBottle.id),x.old.find(o=>o.id===x.oldBottle.id));
 const saved=x.m.all(),callCount=x.calls.length,backups=x.backups();await x.send('白色饮料杯上次在哪里');
 assert.equal(x.s.flow,'recall');assert.match(x.answer(),/白色杯身.*红色图案/);assert.match(x.answer(),/键盘右侧/);assert.equal(x.calls.length,callCount);assert.deepEqual(x.m.all(),saved);
 x.feed();await x.send('当前画面中有没有刚才记住的白色饮料杯');await wait(()=>x.s.state==='COMPLETED');
 assert.equal(x.s.flow,'compare');assert.equal(x.calls.at(-1).kind,'compare');assert.equal(x.calls.at(-1).objectId,cup.id);assert.equal(x.calls.at(-1).references,2);assert.deepEqual(x.m.all(),saved);assert.equal(x.backups(),backups);
});
test('saving a same-name current object after a scene does not overwrite old records or ask to recall them',async t=>{
 const x=setup(t);await x.send('桌上有什么');x.feed();await x.send('记住这个水杯的位置');
 assert.equal(x.m.all().length,4);assert(!x.old.some(o=>o.id===x.s.focus.id));assert.deepEqual(x.m.all().slice(0,3),x.old);assert.equal(x.s.choices,null);
});
test('pending recall stays read-only and incidental camera/phone wording cannot select another stored object',async t=>{
 const x=setup(t);await x.send('水杯上次在哪里');assert.equal(x.s.flow,'recall');assert.equal(x.s.choices.kind,'identity');assert.match(x.answer(),/已存外观/);assert.match(x.answer(),/你想查询/);
 await x.send('拍一下，手机拍一下这个。');assert.equal(x.s.choices,null);assert.equal(x.calls.length,0);assert.deepEqual(x.m.all(),x.old);assert.equal(x.backups(),0);assert.doesNotMatch(x.answer(),/银色手机.*已经记住/);
});
test('a new explicit save leaves a pending historical question and observes the current object directly',async t=>{
 const x=setup(t);await x.send('水杯上次在哪里');assert(x.s.choices);x.feed();await x.send('帮我记住这个饮料杯的位置');
 assert.equal(x.s.flow,'save');assert.equal(x.s.choices,null);assert.equal(x.m.all().length,4);assert.equal(x.calls.at(-1).target,'饮料杯');assert.deepEqual(x.m.all().slice(0,3),x.old);
});
test('a confirmed recalled identity carries into current-view comparison through a pronoun without another old-record question',async t=>{
 const x=setup(t);await x.send('水杯上次在哪里');await x.send('白色的，有把手的');
 assert.equal(x.s.focus.id,x.oldCup.id);assert.equal(x.s.choices,null);assert.equal(x.s.flow,'recall');const before=x.m.all();
 x.feed();await x.send('当前画面中有没有它');await wait(()=>x.s.state==='COMPLETED');
 assert.equal(x.s.task.objectId,x.oldCup.id);assert.equal(x.s.choices,null);assert.equal(x.calls.at(-1).objectId,x.oldCup.id);assert.deepEqual(x.m.all(),before);
 x.feed();await x.send('当前画面中有没有该物品');await wait(()=>x.s.state==='COMPLETED');assert.equal(x.s.task.objectId,x.oldCup.id);
});
test('a camera-only followup cannot resurrect saving after cancellation, a new scene or a new conversation',async t=>{
 for(const change of ['取消','桌上有什么','new-conversation']){
  const x=setup(t);await x.send('记住饮料杯');
  if(change==='new-conversation')x.s.bindConversation('fresh-conversation');else await x.send(change);
  const before=x.m.all();await x.send('手机拍一下这个');assert.deepEqual(x.m.all(),before);assert.equal(x.s.currentSave,null);
 }
});
test('retake while save analysis is pending stays bound to the cup; late old analysis cannot change it to a phone',async t=>{
 const x=setup(t);let firstReply,firstSignal,requests=0;
 x.providers.describe=async(f,target,question,signal)=>{requests++;if(requests===1){firstSignal=signal;return await new Promise(r=>firstReply=r);}return {v:true,n:'白色饮料杯',d:'白色杯身，红色图案',l:'键盘右侧',b:[.2,.1,.6,.9]};};
 const first=x.send('记住这个饮料杯的位置');await wait(()=>!!firstReply);const cupId=x.s.currentSave.objectId;x.feed();await x.send('拍一下，手机拍一下这个。');assert(firstSignal.aborted);
 firstReply({v:true,n:'手机',d:'迟到的手机描述',l:'错误旧位置',b:[.2,.1,.6,.9]});await first;await flush();
 assert.equal(x.s.focus.id,cupId);assert.equal(x.m.all().length,4);assert.doesNotMatch(JSON.stringify(x.m.get(cupId)),/迟到的手机描述|错误旧位置/);assert.deepEqual(x.m.get(x.phone.id),x.old.find(o=>o.id===x.phone.id));
});
test('old-record feature answers cannot escape their candidate records or inherit a save action',()=>{
 const cup={id:'cup',name:'水杯',aliases:[],description:'白色，有把手'},phone={id:'phone',name:'手机',aliases:[],description:'银色机身'};
 const choice={kind:'identity',ids:['cup'],intent:{action:'history',target:'水杯'},expiresAt:Date.now()+10000,excluded:[]};
 assert.equal(identityReply('银色的',null,choice,[cup,phone],Date.now()).action,'clarify');
 assert.equal(identityReply('拍一下，手机拍一下这个',null,choice,[cup,phone],Date.now()).action,'clarify');
 assert.equal(identityReply('手机',null,{...choice,intent:{action:'remember',target:'水杯'}},[cup,phone],Date.now()),null);
});
test('explicit saves outrank scene clauses; status/history questions remain read-only; model cannot supply object IDs',()=>{
 for(const raw of ['桌上有什么我看到了，帮我记住这个饮料杯的位置','帮我记住这个饮料杯的位置','你帮我记住这个杯子的外观'])assert.equal(parseIntent(raw,'手机').action,'remember',raw);
 for(const raw of ['你记住这个杯子了吗','你还记得之前杯子放在哪里吗'])assert.notEqual(parseIntent(raw,'饮料杯')?.action,'remember',raw);
 assert.equal(validateSemantic({action:'remember',target:'饮料杯',objectId:'old-phone'},'记住饮料杯',null).objectId,undefined);
 assert(isRetake('拍一下，手机拍一下这个。'));assert(!isRetake('记住这个手机'));assert(!isRetake('手机上次在哪里'));
});
