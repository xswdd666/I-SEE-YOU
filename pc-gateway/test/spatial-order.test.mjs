import test from 'node:test';
import assert from 'node:assert/strict';
import {OmniProviders} from '../src/omni.mjs';
import {historicalPosition,orderedPosition} from '../src/spatial-order.mjs';
import {locationWords} from '../src/found-location.mjs';
const slots={neighbor:'台灯旁边',direction:'画面左侧',support:'白色桌面上'};
test('scene location and save receipt use the same order, retaining the saved appearance',async()=>{
 const answer={f:1,v:true,n:'红杯',d:'带把手，红色杯身',b:null,l:'台灯旁边',a:'台灯',spatial:slots,answer:'杯子在台灯旁。',items:['红杯']};
 const p=new OmniProviders({client:{request:async()=>JSON.stringify(answer)},prepare:async()=>Buffer.alloc(0)});
 const f={frameId:1,jpeg:Buffer.alloc(0)};
 assert.equal((await p.locate(f,{target:'红杯'})).answer,'红杯在画面左侧，白色桌面上，台灯旁边。');
 const saved=await p.describe(f,'红杯','记住外观和位置');assert.equal(saved.d,answer.d);assert.equal(saved.l,'画面左侧，白色桌面上，台灯旁边');
});
test('partial cues and archived observations never invent a missing direction or relation',()=>{
 assert.equal(orderedPosition({direction:'您的左前方',neighbor:'台灯旁边'}),'台灯旁边');
 assert.equal(historicalPosition('台灯旁边，桌面上，画面左侧'),'画面左侧，桌面上，台灯旁边');
 assert.equal(historicalPosition('以前在柜子里，但后来可能放在桌上'),'以前在柜子里，但后来可能放在桌上');
 assert.equal(historicalPosition('抽屉里'),'抽屉里');
 assert.match(locationWords([.01,.1,.2,.32],{surface:{name:'白色桌面',relation:'on'},anchors:[{name:'台灯',box:[.3,.1,.5,.32]}]}),/左侧偏上.*左边缘.*桌面上.*台灯的左侧/);
});
