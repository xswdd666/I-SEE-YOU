import test from 'node:test';
import assert from 'node:assert/strict';
import {Session} from '../src/session.mjs';
import {parseIntent,validateSemantic} from '../src/intent.mjs';
import {OmniProviders} from '../src/omni.mjs';
import {memory,frame,picture} from './helpers.mjs';
import {uuid} from '../src/util.mjs';
function setup(t,meaning){
 const m=memory(t),events=[],requests=[];
 const providers={singlePassMemory:true,intent:async(...args)=>{requests.push(args);return typeof meaning==='function'?meaning(...args):{...meaning}},describe:async()=>({v:true,n:'鼠标',d:'黑色外壳',l:'桌上'}),targetLocator:{locate:async()=>({v:true,n:'鼠标',d:'黑色外壳',l:'桌上',photo:{jpeg:picture,embedding:Buffer.alloc(192).toString('base64')}})},review:async()=>({status:'LIKELY_MATCH',minBaseScore:.4,selected:{scores:{base:.9}}})};
 const s=new Session({memory:m,providers,emit:e=>events.push(e)});s.start();s.frame(picture,s.source.generation,1,Date.now());t.after(()=>s.stop());
 return {s,m,events,requests,send:text=>s.command({commandId:uuid(),text}),answer:()=>events.filter(e=>e.kind==='result').at(-1)?.message};
}
test('natural explicit save can pass semantic validation without fixed trigger words',async t=>{
 const text='替我存一份这个鼠标的样子，以后帮我认';
 const x=setup(t,{action:'remember',target:'鼠标',writeIntent:'explicit',evidence:text});await x.send(text);
 assert.equal(x.m.all().length,1);assert.equal(x.requests.length,1);
});
test('broad appearance rule yields to semantic update intent',async t=>{
 const text='把这个鼠标的外观换成眼前这次的';
 const x=setup(t,{action:'update',target:'鼠标',writeIntent:'explicit',evidence:text});const r=x.m.capture('鼠标',frame());x.m.finish(r,{description:'旧外观'});
 await x.send(text);assert.equal(x.requests.length,1);assert.equal(x.m.all().length,1);assert.equal(x.m.all()[0].captures.length,2);
});
test('explicit cancel and canonical scene command remain local',async t=>{
 const x=setup(t,()=>{throw Error('model must not run')});await x.send('画面里面有什么');await x.send('取消');assert.equal(x.requests.length,0);
});
test('negative save and historical question cannot become writes',async t=>{
 for(const raw of ['别把这个鼠标存起来','你上次替我存过鼠标的样子吗']){
  const x=setup(t,{action:'remember',target:'鼠标',writeIntent:'explicit',evidence:raw});await x.send(raw);assert.equal(x.m.all().length,0);
 }
});
test('model receives structured context and retry binds only the program-held reference',async t=>{
 const x=setup(t,{action:'retry_identify',objectId:'invented'});const r=x.m.capture('黑色鼠标',frame());x.m.finish(r,{appearance:{jpeg:picture,embedding:Buffer.alloc(192).toString('base64')}});
 await x.send('这个鼠标是不是之前那个黑色鼠标');x.s.frame(picture,x.s.source.generation,2,Date.now());
 await x.send('你刚才认得不准，换这一眼重新确认');
 const context=x.requests.at(-1)[4];assert.equal(context.previousComparison.target,'黑色鼠标');assert.ok(context.lastReply);assert.match(x.answer(),/^是|^还是很像/);
});
test('unavailable model cannot execute a questionable parsed write',async t=>{
 const x=setup(t,()=>{throw Error('timeout')});await x.send('记住鼠标了吗');assert.equal(x.m.all().length,0);
});
test('semantic result strips executable state and separates reference from current target',()=>{
 const r=validateSemantic({action:'identify',target:'黑色鼠标',visibleTarget:'粉色鼠标',objectId:'injected',identityChoice:{ids:['injected']},liveComparison:true},'这只跟先前那只一样不',null);
 assert.equal(r.visibleTarget,'粉色鼠标');assert.equal(r.objectId,undefined);assert.equal(r.identityChoice,undefined);assert.equal(r.liveComparison,undefined);
});
test('intent prompt supports update, retry and structured task context',async()=>{
 let prompt;const p=new OmniProviders({client:{},intentClient:{request:async text=>{prompt=text;return JSON.stringify({action:'retry_identify'})}}});
 assert.equal((await p.interpret('再核实一眼',null,[],undefined,{task:'compare'})).action,'retry_identify');assert.match(prompt,/retry_identify/);assert.match(prompt,/"task":"compare"/);
});


test('friendly continue prompts accept natural local replies but not negations or questions',()=>{
 for(const raw of ['继续','继续找','接着找','再找找','再找一次','帮我继续找吧']){
  assert.equal(parseIntent(raw,'鼠标')?.action,'continue',raw);
 }
 for(const raw of ['别继续','不要接着找','继续吗','继续？','他说继续','如果继续']){
  assert.notEqual(parseIntent(raw,'鼠标')?.action,'continue',raw);
 }
});

test('comparison retry synonyms are scoped to a fresh comparison and camera generation',t=>{
 const x=setup(t,()=>{throw Error('local retry must not invoke the model')});
 const intent={action:'identify',target:'黑色鼠标',objectId:'kept-reference'};
 for(const kind of ['retry_identify','previous']){
  x.s.choices=kind==='retry_identify'?{kind,generation:x.s.source.generation,expiresAt:Date.now()+10000,intent}:null;
  x.s.lastComparison=kind==='previous'?{generation:x.s.source.generation,expiresAt:Date.now()+10000,intent}:null;
  for(const raw of ['核对现在这件','重试','再试一次','再看一眼','帮我再认一下吧']){
   const result=x.s.readIntent(raw);assert.equal(result?.action,'identify',raw);assert.equal(result.objectId,intent.objectId);assert.equal(result.liveComparison,true);
  }
  for(const raw of ['不要重试','先别核对','再试一次？','如果再试一次','他说重试'])assert.notEqual(x.s.readIntent(raw)?.liveComparison,true,raw);
 }
 x.s.lastComparison.expiresAt=0;
 assert.notEqual(x.s.readIntent('重试')?.liveComparison,true);
 x.s.lastComparison={generation:'old-camera',expiresAt:Date.now()+10000,intent};
 assert.notEqual(x.s.readIntent('重试')?.liveComparison,true);
 x.s.lastComparison=null;x.s.choices=null;
 assert.notEqual(x.s.readIntent('再试一次')?.liveComparison,true);
});


test('friendly save receipts remain program-owned and cannot be invented by chat routing',()=>{
 for(const answer of ['记住啦，鼠标在书桌上。','描述记下了。','记住了鼠标。']){
  assert.equal(validateSemantic({action:'chat',answer},'眼前有什么',null),null);
 }
 assert.equal(validateSemantic({action:'clarify',answer:'你想找哪件？'},'找一下',null)?.action,'clarify');
});
