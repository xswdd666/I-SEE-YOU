import test from 'node:test';
import assert from 'node:assert/strict';
import {parseIntent} from '../src/intent.mjs';
import {cleanObjectName,detectionLabel} from '../src/object-names.mjs';
import {Session} from '../src/session.mjs';
import {Memory} from '../src/memory.mjs';
import {SceneDialogue} from '../src/scene-dialogue.mjs';
import {memory,frame,picture,directory} from './helpers.mjs';
import {uuid} from '../src/util.mjs';
const photo={jpeg:picture,embedding:Buffer.alloc(192).toString('base64')};

test('actual split-ASR search resolves only the saved bag name; garbled questions ask for clarification',()=>{
 for(const words of ['这个桌面上有没有？刚才我让你记录的白色手提袋的。','这个画面有没有，刚刚我让你记住的白色手提袋？','这个桌面上有没有我刚才让你记录的白色手提袋。']){
  const intent=parseIntent(words,'手机');assert.equal(intent.action,'find',words);assert.equal(intent.target,'白色手提袋',words);
 }
 assert.equal(cleanObjectName('？刚才我让你记录的白色手提袋的'),'白色手提袋');
 assert.equal(parseIntent('帮我看一下这个画面有没有审核有没有','深色饮料').action,'clarify');
});

test('explicit remembering appearance outranks an appearance query, including a leading camera clause',()=>{
 for(const words of ['记住这个白色袋子的样子','你帮我记住这个白色袋子的样子','嗯，我现在已将画面离近，你帮我记住这个白色袋子的样子。','请你帮我记住这个白色袋子的外观']){
  const intent=parseIntent(words,'手机');assert.equal(intent.action,'remember',words);assert.equal(intent.target,'白色袋子',words);
 }
 for(const words of ['你记住白色袋子的样子了吗','你还记得之前的白色袋子放在哪里吗','白色袋子长什么样'])assert.notEqual(parseIntent(words,'手机')?.action,'remember',words);
 assert.equal(parseIntent('记住这个物品的位置','白色手提袋').target,'白色手提袋');
 assert.equal(parseIntent('这个东西上次在哪里','白色手提袋').target,'白色手提袋');
 assert.equal(parseIntent('记住这个物品的位置',null).target,null);
});

test('recent historical location remains a memory query while current comparison remains finding',()=>{
 const dialogue=new SceneDialogue();
 const history=parseIntent('刚才我让你记住的白色袋子在哪里','白色袋子');
 assert.equal(history.action,'history');assert.equal(dialogue.route('刚才我让你记住的白色袋子在哪里',history,'g').action,'history');
 assert.equal(dialogue.route('当前画面有没有刚才我让你记住的白色袋子',parseIntent('当前画面有没有刚才我让你记住的白色袋子'),'g').action,'find');
});

test('description and observed location never claim a complete visual memory without a target photo',t=>{
 const m=memory(t),r=m.capture('白色手提袋',frame());
 const result=m.finish(r,{description:'白色纸袋，黑色提手',suggestedLocation:'椅子下面',failureKind:'REVIEW_UNCERTAIN'});
 assert.equal(result.referenceReady,false);assert.equal(result.currentReferenceReady,false);assert.equal(result.complete,false);
 assert.match(result.message,/描述和上次位置记下了/);assert.match(result.message,/再让我拍清/);assert.doesNotMatch(result.message,/已记住|样子已经记住/);
 assert.match(m.receipt(r.objectId).message,/再让我拍清/);assert.match(m.records()[0].capture_status_label,/缺参考照片/);
 assert.match(m.history(r.objectId),/椅子下面/);
});

test('a saved bag stays recognizable under spoken bag variants after reopening the DB',async t=>{
 const root=directory();let m=new Memory(root);const r=m.capture('白色手提袋',frame());
 m.finish(r,{appearance:photo,description:'白色纸袋',suggestedLocation:'地毯上',failureKind:'REVIEW_UNCERTAIN'});m.close();m=new Memory(root);t.after(()=>m.close());
 assert.equal(m.receipt(r.objectId).referenceReady,true);assert.equal(m.receipt(r.objectId).complete,true);
 for(const name of ['白色袋子','白色纸袋','白色塑料袋','白色手提袋'])assert.equal(m.matching(name)[0].id,r.objectId,name);
 assert.equal(detectionLabel('白色袋子'),null);
 const before=m.all(),events=[];let reviews=0;
 const s=new Session({memory:m,providers:{localOnlyReview:true,backend:'appearance_mvp',review:async()=>{reviews++;return {status:'NO_MATCH',candidates:[]};}},emit:event=>events.push(event),detector:{ready:true,busy:false,run:async()=>({detections:[],candidates:[]})}});t.after(()=>s.stop());
 s.start();s.frame(picture,s.source.generation,1,Date.now());
 await s.command({commandId:uuid(),text:'这个桌面上有没有？刚才我让你记录的白色手提袋的。'});
 assert.equal(s.task.objectId,r.objectId);assert.equal(s.task.target,'白色手提袋');
 assert(!events.some(event=>event.type==='reply'&&/进行外观比对需要|还没有找到.*物品记录/.test(event.message)));
 await new Promise(resolve=>setImmediate(resolve));assert(reviews>0);assert.deepEqual(m.all(),before);
});

test('missing record and existing text-only record are distinct and do not start pointless searches',async t=>{
 const m=memory(t),r=m.capture('白色手提袋',frame());m.finish(r,{description:'白色纸袋',suggestedLocation:'椅子下面',failureKind:'REVIEW_UNCERTAIN'});
 const before=m.all(),events=[];let reviews=0;
 const s=new Session({memory:m,providers:{localOnlyReview:true,backend:'appearance_mvp',review:()=>{reviews++;}},emit:event=>events.push(event)});t.after(()=>s.stop());s.start();s.frame(picture,s.source.generation,1,Date.now());
 await s.command({commandId:uuid(),text:'找之前记住的白色袋子'});assert.match(events.filter(event=>event.kind==='result').at(-1).message,/你说的是.*白色手提袋/);assert.equal(s.task,null);
 await s.command({commandId:uuid(),text:'是的'});const answer=events.filter(event=>event.kind==='result').at(-1).message;assert.match(answer,/再让我拍清/);assert.match(answer,/描述和上次位置记下了/);assert.equal(s.task,null);
 await s.command({commandId:uuid(),text:'找之前记住的红色钥匙'});assert.match(events.filter(event=>event.kind==='result').at(-1).message,/没有找到.*红色钥匙.*物品记录/);assert.equal(s.task,null);
 assert.equal(reviews,0);assert.deepEqual(m.all(),before);
});

test('a later incomplete observation keeps an older usable reference ready',t=>{
 const m=memory(t),first=m.capture('手机',frame());m.finish(first,{appearance:photo,description:'银边框',suggestedLocation:'电脑左侧',failureKind:'REVIEW_UNCERTAIN'});
 const second=m.capture('手机',{...frame(),capturedAtMs:frame().capturedAtMs+1},{objectId:first.objectId});m.finish(second,{description:'银边框',suggestedLocation:'电脑右侧',failureKind:'REVIEW_UNCERTAIN'});
 assert.equal(m.receipt(first.objectId).referenceReady,true);assert.equal(m.receipt(first.objectId).currentReferenceReady,false);assert.equal(m.photos(m.get(first.objectId)).length,1);
});

test('the actual close-camera sentence performs a durable save rather than querying an unknown name',async t=>{
 const m=memory(t),events=[];
 const s=new Session({memory:m,providers:{singlePassMemory:true,targetLocator:{locate:async()=>({v:true,n:'白色手提袋',d:'白色纸袋，黑色提手',l:'椅子下面',photo})},describe:()=>{throw Error('must_not_fall_back_to_appearance_query');}},emit:event=>events.push(event)});t.after(()=>s.stop());s.start();s.frame(picture,s.source.generation,1,Date.now());
 await s.command({commandId:uuid(),text:'嗯，我现在已将画面离近，你帮我记住这个白色袋子的样子。'});
 assert.equal(m.all().length,1);const item=m.all()[0];assert.equal(item.name,'白色手提袋');assert.equal(m.photos(item).length,1);assert.equal(m.receipt(item.id).referenceReady,true);
 await s.command({commandId:uuid(),text:'刚才我让你记住的白色袋子在哪里'});
 assert.match(events.filter(event=>event.kind==='result').at(-1).message,/椅子下面/);assert.equal(m.all().length,1);
});
