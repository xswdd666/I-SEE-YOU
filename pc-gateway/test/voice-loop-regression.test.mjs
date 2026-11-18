import test from 'node:test';
import assert from 'node:assert/strict';
import {Session} from '../src/session.mjs';
import {parseIntent} from '../src/intent.mjs';
import {TargetLocator} from '../src/target-locator.mjs';
import {memory,frame,picture} from './helpers.mjs';
import {uuid} from '../src/util.mjs';
const photo={jpeg:picture,embedding:Buffer.alloc(192).toString('base64'),width:60,height:60};
function setup(t,names=['黑色鼠标']){
 const m=memory(t),events=[],seen=[];
 for(const name of names){const r=m.capture(name,frame());m.finish(r,{appearance:photo});}
 const providers={singlePassMemory:true,targetLocator:{locate:async(f)=>{seen.push(f.frameId);return {photo,v:true,n:'黑色鼠标',d:'黑色外壳',l:'桌上'};}},review:async()=>({status:'LIKELY_MATCH',minBaseScore:.4,selected:{scores:{base:.9}}})};
 const s=new Session({memory:m,providers,emit:e=>events.push(e)});s.start();s.frame(picture,s.source.generation,1,Date.now());t.after(()=>s.stop());
 return {m,s,providers,events,seen,send:text=>s.command({commandId:uuid(),text}),answer:()=>events.filter(e=>e.kind==='result').at(-1)?.message};
}
test('prescribed retry works without focus and uses a new frame',async t=>{
 const x=setup(t,['黑色有线鼠标','黑色无线鼠标']);x.providers.targetLocator.locate=async()=>null;
 await x.send('这个鼠标是不是之前那个黑色鼠标');assert(x.s.choices);
 x.providers.targetLocator.locate=async f=>{x.seen.push(f.frameId);return {photo}};
 x.s.frame(picture,x.s.source.generation,2,Date.now());await x.send('核对现在这件');
 assert.deepEqual(x.seen,[2]);assert.doesNotMatch(x.answer(),/没能理解/);
});
test('correction uses fresh pixels and does not overwrite the saved identity',async t=>{
 const x=setup(t);await x.send('这个鼠标是不是之前那个黑色鼠标');const before=x.m.all();
 x.providers.review=async()=>({status:'NO_MATCH',minBaseScore:.4,selected:{scores:{base:.1}}});
 x.s.frame(picture,x.s.source.generation,2,Date.now());await x.send('不是，认错了');
 assert.deepEqual(x.seen,[1,2]);assert.match(x.answer(),/^不是/);assert.deepEqual(x.m.all(),before);
});
test('comparison correction expires and is cleared by another task',async t=>{
 const x=setup(t);await x.send('这个鼠标是不是之前那个黑色鼠标');
 x.s.now=()=>Date.now()+121000;assert.notEqual(x.s.readIntent('认错了')?.action,'identify');
 x.s.now=Date.now;await x.send('取消');assert.notEqual(x.s.readIntent('认错了')?.action,'identify');
});
test('borderline similarity stays uncertain',async t=>{
 const x=setup(t);x.providers.review=async()=>({status:'LIKELY_MATCH',minBaseScore:.4,selected:{scores:{base:.52}}});
 await x.send('这个鼠标是不是之前那个黑色鼠标');assert.match(x.answer(),/^还没认准/);
});
test('one-shot checks the highest-base whole reference pair',async t=>{
 const x=setup(t);x.providers.review=async()=>({status:'LIKELY_MATCH',minBaseScore:.4,selected:{scores:{base:.64,total:.69},referencePairs:[{referenceId:'a',scores:{base:.64,total:.69}},{referenceId:'b',scores:{base:.66,total:.66}}]}});
 await x.send('这个鼠标是不是之前那个黑色鼠标');assert.match(x.answer(),/^是/);
 assert.equal(x.events.find(e=>e.type==='experiment.match').selected.referenceId,'b');
});
test('update appearance appends to a uniquely selected existing object',async t=>{
 const x=setup(t);const old=x.m.all()[0];assert.equal(parseIntent('更新这只鼠标的外观').action,'update');
 x.s.frame(picture,x.s.source.generation,2,Date.now()+1);await x.send('更新这只黑色鼠标的外观');
 assert.equal(x.m.all().length,1);assert.equal(x.m.all()[0].id,old.id);assert.equal(x.m.all()[0].captures.length,2);
});
test('ambiguous update requires spoken identity selection; missing record never creates one',async t=>{
 const x=setup(t,['黑色鼠标','粉色鼠标']);await x.send('更新鼠标的外观');assert.equal(x.s.choices?.kind,'identity');
 assert.equal(x.m.all().reduce((n,o)=>n+o.captures.length,0),2);
 x.s.frame(picture,x.s.source.generation,2,Date.now()+1);await x.send('黑色的');assert.equal(x.m.all().find(o=>o.name==='黑色鼠标').captures.length,2);
 await x.send('更新白色耳机的外观');assert.equal(x.m.all().length,2);assert.match(x.answer(),/没有.*记录/);
});
for(const [description,crop,verdict,reason] of [
 [{v:false},photo,{match:true,clear:true},'target_unconfirmed'],
 [{v:true,b:null},photo,{match:true,clear:true},'invalid_box'],
 [{v:true,b:[0,0,.5,.5]},{...photo,width:10},{match:true,clear:true},'target_too_small'],
 [{v:true,b:[0,0,.5,.5]},photo,{match:false,clear:true},'category_mismatch'],
 [{v:true,b:[0,0,.5,.5]},photo,{match:true,clear:false},'crop_unclear']
])test('localization reports '+reason,async()=>{
 const reasons=[];const locator=new TargetLocator({provider:{reset(){},close(){},describe:async()=>description,prepare:async()=>picture,client:{request:async()=>JSON.stringify({f:1,...verdict})}},crop:async()=>crop});
 assert.equal(await locator.locate(frame(),'鼠标',{onFailure:code=>reasons.push(code)}),null);assert.deepEqual(reasons,[reason]);locator.close();
});

test('borderline reply can be retried by the suggested words without selected focus',async t=>{
 const x=setup(t,['黑色有线鼠标','黑色无线鼠标']);x.providers.review=async()=>({status:'LIKELY_MATCH',minBaseScore:.4,selected:{scores:{base:.52}}});
 await x.send('这个鼠标是不是之前那个黑色鼠标');x.s.frame(picture,x.s.source.generation,2,Date.now());await x.send('核对现在这件');
 assert.deepEqual(x.seen,[1,2]);assert.match(x.answer(),/^还没认准/);
});
test('explicit update variants stay write operations and negative requests never update',()=>{
 assert.equal(parseIntent('帮我更新一下这个鼠标的外观').action,'update');
 assert.notEqual(parseIntent('不要更新这个鼠标的外观')?.action,'update');
 assert.notEqual(parseIntent('这个鼠标的外观更新了吗')?.action,'update');
});

for (const reason of ['target_unconfirmed','invalid_box','target_too_small','category_mismatch','crop_unclear','localization_timeout','localization_error']) {
 test('comparison retry speech is unified while logging '+reason,async t=>{
  const x=setup(t);
  x.providers.targetLocator.locate=async (f,name,options)=>{
   options.onFailure(reason);
   if(reason==='localization_timeout'||reason==='localization_error')throw Error(reason);
   return null;
  };
  await x.send('这个鼠标是不是之前那个黑色鼠标');
  assert.equal(x.answer(),'还没确认，请说“核对现在这件”重试。');
  assert.ok(x.events.some(e=>e.operation==='identify_localization'&&e.code===reason));
  x.providers.targetLocator.locate=async f=>{x.seen.push(f.frameId);return {photo}};
  x.s.frame(picture,x.s.source.generation,2,Date.now());
  await x.send('核对现在这件');
  assert.deepEqual(x.seen,[2]);
  assert.match(x.answer(),/^是/);
 });
}

test('comparison provider failure uses retry speech and retains its diagnostic',async t=>{
 const x=setup(t);
 x.providers.review=async()=>{throw Error('provider_network_failed')};
 await x.send('这个鼠标是不是之前那个黑色鼠标');
 assert.equal(x.answer(),'还没确认，请说“核对现在这件”重试。');
 assert.ok(x.events.some(e=>e.operation==='identify'&&e.code==='provider_network_failed'));
});
