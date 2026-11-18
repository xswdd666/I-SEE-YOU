import test from 'node:test';
import assert from 'node:assert/strict';
import {Session} from '../src/session.mjs';
import {Memory} from '../src/memory.mjs';
import {memory,frame,picture} from './helpers.mjs';
import {uuid} from '../src/util.mjs';

function save(m,name,description){
 const receipt=m.capture(name,frame());
 m.finish(receipt,{description,location:{location:'上次的书桌左边',anchor:'书桌'},appearance:{jpeg:picture,embedding:Buffer.alloc(192).toString('base64')}});
 return m.get(receipt.objectId);
}
function session(t,m,{now=Date.now}={}){
 const events=[];const s=new Session({memory:m,providers:{intent(){throw Error('Identity clarification must stay local');}},emit:e=>events.push(e),now});
 t.after(()=>s.stop());
 return {s,events,send:text=>s.command({commandId:uuid(),text}),answer:()=>events.filter(e=>e.type==='reply'&&e.kind==='result').at(-1)?.message};
}

test('reopened laptop memory connects personal-name paraphrases and aliases without modifying any records',async t=>{
 const initial=memory(t),apple=save(initial,'苹果笔记本','银色外壳，有苹果标志');
 const reopened=new Memory(initial.root);t.after(()=>reopened.close());const before=reopened.all();
 for(const phrase of ['我的笔记本在哪','我的笔记本在哪里呢','帮我找一下我的笔记本在哪','帮我找之前记住的电脑','寻找之前记住的macbook']){
  const {s,send,answer}=session(t,reopened);await send(phrase);
  assert.match(answer(),/你说的是.*苹果笔记本/);assert.equal(s.task,null);assert.equal(s.focus,null);
  await send('对，就是那台');assert.equal(s.task.objectId,apple.id);assert.equal(s.task.target,'苹果笔记本');assert.equal(s.task.label,'laptop');
  await send('它在哪');assert.equal(s.task.objectId,apple.id);assert.equal(s.task.target,'苹果笔记本');
 }
 assert.deepEqual(reopened.all(),before);
});

test('paper notebooks and computers stay separate until an appearance or ordinal distinguishes them',async t=>{
 const m=memory(t),apple=save(m,'苹果笔记本','银色外壳，有苹果标志'),paper=save(m,'纸质笔记本','蓝色纸质封面');
 const {s,send,answer}=session(t,m);await send('我的笔记本在哪');assert.equal(s.choices.ids.length,2);
 await send('是的');assert.equal(s.task,null);assert.match(answer(),/有几件/);
 await send('银色的');assert.equal(s.task.objectId,apple.id);
 await send('我的笔记本在哪');assert.equal(s.task,null);assert.equal(s.choices.ids.length,2);
 await send('第二个');assert.equal(s.task.objectId,paper.id);
});

test('an old selected computer never silently chooses between several new generic candidates',async t=>{
 const m=memory(t),apple=save(m,'苹果笔记本','银色外壳');save(m,'黑色工作电脑','黑色机身');
 const {s,send}=session(t,m);await send('找之前记住的苹果笔记本');assert.equal(s.focus.id,apple.id);
 await send('帮我找之前记住的电脑');assert.equal(s.task,null);assert.equal(s.choices.ids.length,2);
});

test('a negated candidate is never selected; a corrected feature retains the original search',async t=>{
 const m=memory(t);save(m,'苹果笔记本','银色外壳');const other=save(m,'工作电脑','黑色机身');
 const {s,send,answer}=session(t,m);await send('我的笔记本在哪');await send('不是那台苹果笔记本');
 assert.equal(s.task,null);assert.match(answer(),/有什么特别的/);await send('黑色的');assert.equal(s.task.objectId,other.id);assert.equal(s.task.target,'工作电脑');
});

test('a natural confirmation of the earlier saved laptop continues the pending search',async t=>{
 const m=memory(t),apple=save(m,'苹果笔记本','银色外壳');const {s,send}=session(t,m);
 await send('我的笔记本在哪');await send('是上次那台苹果笔记本');assert.equal(s.task.objectId,apple.id);
});

test('a current scene cannot replace a personal saved-object search or its confirmed pronoun',async t=>{
 const m=memory(t),apple=save(m,'苹果笔记本','银色外壳');const {s,send}=session(t,m);
 s.start();s.sceneDialogue.remember({sourceGeneration:s.source.generation},{items:['水杯','耳机']},'耳机');
 await send('我的笔记本在哪');assert.equal(s.choices.intent.action,'find');await send('对');assert.equal(s.task.objectId,apple.id);
 await send('它在哪里');assert.equal(s.task.objectId,apple.id);
});

test('cancel, a new conversation and an expired question cannot resume an old identity choice',async t=>{
 const m=memory(t);save(m,'苹果笔记本','银色外壳');let clock=Date.now();const {s,send,answer}=session(t,m,{now:()=>clock});
 await send('我的笔记本在哪');await send('取消');await send('对');assert.equal(s.task,null);assert.equal(s.choices,null);
 await send('我的笔记本在哪');clock+=120_001;await send('对');assert.equal(s.task,null);assert.match(answer(),/过期/);
 await send('我的笔记本在哪');s.bindConversation('another-conversation');assert.equal(s.choices,null);await send('是的');assert.equal(s.task,null);
});

test('explicit historical recall keeps its history action across clarification and does not need a camera',async t=>{
 const m=memory(t);save(m,'苹果笔记本','银色外壳');const before=m.all();const {s,send,answer}=session(t,m);
 await send('笔记本上次在哪里');assert.equal(s.choices.intent.action,'history');await send('是的');
 assert.equal(s.task,null);assert.match(answer(),/过去|上次/);assert.match(answer(),/书桌左边/);assert.deepEqual(m.all(),before);
});

test('a new scene question ends a pending identity question and never writes long-term memory',async t=>{
 const m=memory(t);save(m,'苹果笔记本','银色外壳');const before=m.all();const {s,send}=session(t,m);
 await send('我的笔记本在哪');await send('眼前有什么');assert.equal(s.choices,null);assert.equal(s.task,null);assert.deepEqual(m.all(),before);
});

test('a just-saved unique identity can be recalled directly under its older alias',async t=>{
 const m=memory(t),apple=save(m,'苹果笔记本','银色外壳');const {s,send,answer}=session(t,m);
 s.focus=apple;await send('电脑上次在哪里');assert.equal(s.choices,null);assert.match(answer(),/书桌左边/);
});
