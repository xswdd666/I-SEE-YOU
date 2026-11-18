import test from 'node:test';
import assert from 'node:assert/strict';
import {memory,frame,picture} from './helpers.mjs';
import {validateSemantic} from '../src/intent.mjs';
const photo={jpeg:picture,embedding:Buffer.alloc(192).toString('base64')};
test('temporary records are bounded, expire, and explicit recapture promotes them',t=>{
 const m=memory(t);let now=Date.now();m.now=()=>now;
 for(let i=0;i<5;i++)assert(m.captureAutomatic('鼠标'+i,frame(),photo,'黑色','桌上'));
 assert.equal(m.captureAutomatic('第六个物品',frame(),photo,'黑色','桌上'),null);
 const first=m.all()[0];const r=m.capture(first.name,frame(),{objectId:first.id});m.finish(r,{appearance:photo});
 now+=24*60*60*1000+1;assert.equal(m.all().length,1);assert.equal(m.all()[0].id,first.id);
});
test('automatic observations merge repeats and keep manually recorded positions',t=>{
 const m=memory(t);let now=Date.now();m.now=()=>now;const r=m.capture('鼠标',frame());m.finish(r,{appearance:photo});m.addLocation(r.objectId,'书桌上');
 let o=m.get(r.objectId);assert(m.observeAutomatic(o.id,'沙发上',now,o.updatedAtMs));
 o=m.get(o.id);assert.equal(m.observeAutomatic(o.id,'沙发上',now+1,o.updatedAtMs),false);
 assert.equal(m.get(o.id).locations.length,1);assert.equal(m.locationHistory(o.id)[0].location,'沙发上');
 assert.match(m.history(o.id),/上次.*画面里看到/);
 assert.equal(m.observeAutomatic(o.id,'床上',now,o.updatedAtMs-1),false);
});
test('auto-memory statements require first-person assertion, never questions or hypotheticals',()=>{
 for(const raw of ['这副耳机是我的','我把钥匙放这个盒子里了'])assert.equal(validateSemantic({action:'auto_remember',target:'物品',autoKind:'ownership',evidence:raw},raw,'耳机')?.action,'auto_remember');
 for(const raw of ['这是我的耳机吗','如果我把钥匙放这里','这不是我的鼠标','这是他的水杯','我以前把钥匙放这里'])assert.equal(validateSemantic({action:'auto_remember',target:'钥匙',autoKind:'placement',evidence:raw},raw,null),null);
});

import {AutomaticMemory} from '../src/automatic-memory.mjs';
import {Session} from '../src/session.mjs';
import {uuid} from '../src/util.mjs';
import {exportArchive,readArchive} from '../src/archive.mjs';
import {account} from './helpers.mjs';
function provider(){return {targetLocator:{locate:async()=>({photo,box:[.1,.1,.4,.4],d:'黑色外壳'})},review:async()=>({status:'LIKELY_MATCH',selected:{scores:{base:.9}}}),describeFoundLocation:async()=>({surface:{name:'沙发',relation:'on'},anchors:[]})};}
test('natural ownership saves silently through the normal command entry point',async t=>{
 const m=memory(t),events=[],p=provider();const raw='这个耳机是我的';p.intent=async()=>({action:'auto_remember',target:'耳机',autoKind:'ownership',evidence:raw});
 const s=new Session({memory:m,providers:p,automaticMemory:true,emit:e=>events.push(e)});s.start();t.after(()=>s.stop());s.frame(picture,s.source.generation,1,Date.now());
 await s.command({commandId:uuid(),text:raw});assert.equal(m.all().length,1);assert.ok(m.all()[0].autoExpiresAtMs);
 assert.equal(events.filter(e=>e.type==='reply').length,0);assert.match(m.records()[0].capture_status_label,/自动记录/);
});
test('passive observation requires two distinct frames, deduplicates, and rejects ambiguity',async t=>{
 const m=memory(t);const r=m.capture('鼠标',frame());m.finish(r,{appearance:photo});let now=Date.now();m.now=()=>now;
 const p=provider(),a=new AutomaticMemory({memory:m,providers:p,now:()=>now});
 const candidate={label:'mouse',box:[.1,.1,.4,.4],cropJpeg:picture.toString('base64')};const f=frame();
 await a.observe(f,[candidate],undefined,()=>true);assert.equal(m.locationHistory(r.objectId).length,0);
 now+=8001;await a.observe({...f,frameId:2},[candidate],undefined,()=>true);assert.equal(m.locationHistory(r.objectId).length,1);
 now+=8001;await a.observe({...f,frameId:3},[candidate,candidate],undefined,()=>true);assert.equal(m.locationHistory(r.objectId).length,1);
 assert.equal(m.get(r.objectId).appearances.length,1);
});
test('a cancelled or deleted object is not written after asynchronous analysis',async t=>{
 const m=memory(t),p=provider(),a=new AutomaticMemory({memory:m,providers:p});
 await a.statement({target:'鼠标',autoKind:'ownership'},frame(),undefined,()=>false);assert.equal(m.all().length,0);
 const r=m.capture('鼠标',frame());m.finish(r,{appearance:photo});
 p.describeFoundLocation=async()=>{const o=m.get(r.objectId);m.delete({id:o.id,recorded_at:new Date(o.updatedAtMs).toISOString()});return {surface:{name:'沙发',relation:'on'}};};
 await a.statement({target:'鼠标',autoKind:'ownership'},frame(),undefined,()=>true);assert.equal(m.all().length,0);
});
test('temporary entries and local observations do not break legacy backup formats',async t=>{
 const m=memory(t);m.bindAccount(account);m.captureAutomatic('临时耳机',frame(),photo,'白色',null);
 const r=m.capture('鼠标',frame());m.finish(r,{appearance:photo});const o=m.get(r.objectId);m.observeAutomatic(o.id,'沙发上',Date.now(),o.updatedAtMs);
 const archive=await exportArchive(m,account);const bytes=archive.bytes;
 const restored=await readArchive(bytes,account);assert.equal(restored.objects.length,1);assert.equal(restored.objects[0].autoObservations,undefined);
});
