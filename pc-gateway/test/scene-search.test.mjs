import test from 'node:test';
import assert from 'node:assert/strict';
import {Session} from '../src/session.mjs';
import {memory,frame,picture} from './helpers.mjs';
import {uuid} from '../src/util.mjs';

function setup(t){
 const m=memory(t),events=[],observations=[];
 for(const name of ['红色杯子','蓝色杯子']){
  const r=m.capture(name,frame());
  m.finish(r,{description:name,appearance:{jpeg:picture,embedding:Buffer.alloc(192).toString('base64')}});
 }
 let visible=false,now=Date.now(),sequence=0;
 const providers={localOnlyReview:true,locate:async(f,intent)=>{
  observations.push([f.frameId,intent.target]);
  return {v:visible,answer:visible?'画面左侧，白色桌面上有红色杯子。':'当前画面还没看到红色杯子。',items:visible?['红色杯子']:[]};
 },targetLocator:{locate:async()=>({photo:{jpeg:picture}})},review:async()=>({status:'NO_MATCH',candidates:[{scores:{base:.21}}]})};
 const s=new Session({memory:m,providers,now:()=>now,emit:e=>events.push(e)});
 const feed=()=>s.frame(picture,s.source.generation,++sequence,now);
 s.start();feed();t.after(()=>s.stop());
 return {s,m,events,observations,send:text=>s.command({text,commandId:uuid()}),setVisible:()=>visible=true,advance:()=>{now+=2000;feed();},reply:()=>events.filter(e=>e.kind==='result').at(-1)?.message};
}
test('ask what to find, accept a spoken noun, keep checking new frames and stop at the first sighting',async t=>{
 const x=setup(t);
 for(const q of ['可以帮我找东西吗','帮我找物']){await x.send(q);assert.equal(x.reply(),'你想找什么物品？');}
 await x.send('红色杯子');
 assert.equal(x.s.task.mode,'scene');assert.deepEqual(x.observations,[[1,'红色杯子']]);
 assert.equal(x.events.some(e=>e.operation==='memory_lookup'),false);
 x.setVisible();x.advance();await x.s.tick();assert.equal(x.s.state,'COMPLETED');assert.match(x.reply(),/桌面上有红色杯子/);
 x.advance();await x.s.tick();assert.equal(x.observations.length,2);
 await x.send('这只是不是之前保存的那个红色杯子');assert.match(x.reply(),/外观不相符/);
});
test('a current-view question interrupts a saved-record choice and never selects a stored cup',async t=>{
 const x=setup(t);await x.send('找之前记住的杯子');assert.equal(x.s.choices.ids.length,2);
 const count=x.events.filter(e=>e.operation==='memory_lookup').length;
 for(const question of ['帮我找画面中是否有红色杯子','眼前有没有红色杯子','画面里有红色杯子吗']){
  await x.send(question);assert.equal(x.s.choices,null);assert.equal(x.s.task,null);
  assert.match(x.reply(),/当前画面还没看到红色杯子/);assert.equal(x.observations.at(-1)[1],'红色杯子');
 }
 assert.equal(x.events.filter(e=>e.operation==='memory_lookup').length,count);
 await x.send('帮我找杯子');assert.equal(x.s.task.mode,'scene');assert.equal(x.s.choices,null);
});
