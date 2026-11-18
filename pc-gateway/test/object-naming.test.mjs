import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanObjectName,observationName,objectName} from '../src/object-names.mjs';
import {parseIntent,validateSemantic} from '../src/intent.mjs';
import {memory,frame,picture} from './helpers.mjs';
import {Session} from '../src/session.mjs';
import {uuid} from '../src/util.mjs';
test('demonstratives, remembered clauses and spoken commands never become an object name',()=>{
 for(const [raw,name] of [['那一个水杯','水杯'],['我之前记住的水杯','水杯'],['你刚刚记住的手机','手机'],['我上次让你保存的耳机','耳机'],['帮我把那一个绿色的水杯','绿色水杯'],['银色的手机','银色手机']])assert.equal(cleanObjectName(raw),name,raw);
 assert.equal(parseIntent('帮我记住那一个水杯的位置').target,'水杯');
 assert.equal(parseIntent('帮我看一下这个桌面上有没有我之前记住的手机。').target,'手机');
 assert.equal(parseIntent('记住我之前记住的水杯').target,'水杯');
 assert.equal(validateSemantic({action:'remember',target:'我之前记住的水杯'},'记住我之前记住的水杯',null).target,'水杯');
 assert.equal(objectName('蓝牙耳机').colour,null);
});
test('appearance names remain short, stay in the requested category and do not turn screen colour into body colour',()=>{
 assert.equal(observationName('手机','银色的手机'),'银色手机');
 assert.equal(observationName('水杯','绿色水杯'),'绿色水杯');
 for(const n of ['他','我之前记住的','手机在桌面左侧','绿色水杯','黑色屏幕手机'])assert.equal(observationName('手机',n),null,n);
 assert.equal(observationName('蓝色水杯','绿色水杯'),null);
 assert.equal(observationName('银色手机','手机'),null);
});
test('a visual save names the same persistent object from appearance and old generic names still retrieve it',async t=>{
 const m=memory(t),events=[];let descriptions=0;
 const s=new Session({memory:m,providers:{singlePassMemory:true,describe:async()=>{descriptions++;return {v:true,n:'银色的手机',d:'银色边框手机',l:'电脑左边',b:null};}},emit:e=>events.push(e)});
 s.start();s.frame(picture,s.source.generation,1,Date.now());await s.command({commandId:uuid(),text:'记住那一个手机的位置'});
 const o=m.all()[0];assert.equal(o.name,'银色手机');assert.ok(o.aliases.includes('手机'));assert.equal(o.captures.length,1);
 assert.match(m.history(o.id),/电脑左边/);await s.command({commandId:uuid(),text:'你还记得我之前记住的手机放在哪里吗'});
 assert.equal(descriptions,1);assert.match(events.filter(e=>e.kind==='result').at(-1).message,/电脑左边/);
 assert.equal(m.matching('那一个银色的手机')[0].id,o.id);
});
test('renaming existing records preserves every photo, location and identity and never merges same-name objects',t=>{
 const m=memory(t),r=m.capture('水杯',frame());m.finish(r,{description:'绿色水杯',location:{location:'书桌上',anchor:'书桌'},appearance:{jpeg:picture,embedding:Buffer.alloc(192).toString('base64')}});
 const before=m.get(r.objectId),other=m.capture('水杯',frame());
 const after=m.rename(r.objectId,'绿色的水杯',before.updatedAtMs);
 for(const k of ['id','createdAtMs','captures','appearances','locations','events','description'])assert.deepEqual(after[k],before[k]);
 assert.equal(after.name,'绿色水杯');assert.ok(after.aliases.includes('水杯'));assert.equal(m.all().length,2);assert.notEqual(other.objectId,after.id);
 assert.throws(()=>m.rename(after.id,'他'),/object_name_invalid/);
 assert.throws(()=>m.capture('他',frame()),/object_name_invalid/);
});
