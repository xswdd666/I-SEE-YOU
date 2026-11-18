import test from 'node:test';
import assert from 'node:assert/strict';
import {TargetLocator,TargetDetector} from '../src/target-locator.mjs';
import {picture,frame,memory} from './helpers.mjs';
import {Session} from '../src/session.mjs';
import {uuid} from '../src/util.mjs';
const box=[.3,.3,.5,.5],photo={jpeg:picture,embedding:Buffer.alloc(192).toString('base64'),width:70,height:70};
function provider(verdict={f:1,match:true,clear:true}){
 return {reset(){},close(){},prepare:async image=>image,describe:async()=>({f:1,v:true,b:box,n:'白色耳机盒',d:'椭圆形',l:'桌上'}),client:{request:async()=>JSON.stringify(verdict)}};
}
test('memory crop is checked against its own pixels, not a plausible full-scene description',async()=>{
 const wrong=provider({f:1,match:false,clear:true});const locator=new TargetLocator({provider:wrong,crop:async()=>photo});
 assert.equal(await locator.locate(frame(),'白色耳机盒'),null);locator.close();
 const good=new TargetLocator({provider:provider(),crop:async()=>photo});assert.deepEqual((await good.locate(frame(),'白色耳机盒')).box,box);good.close();
});
test('wrong validation frame, too-small reference and cancellation cannot save a crop',async()=>{
 const stale=new TargetLocator({provider:provider({f:2,match:true,clear:true}),crop:async()=>photo});await assert.rejects(stale.locate(frame(),'耳机'),/target_crop_response_invalid/);stale.close();
 const tiny=new TargetLocator({provider:provider(),crop:async()=>({...photo,width:20})});assert.equal(await tiny.locate(frame(),'耳机'),null);tiny.close();
 const cancelled=new TargetLocator({provider:provider(),crop:async()=>photo});const controller=new AbortController();controller.abort();await assert.rejects(cancelled.locate(frame(),'耳机',{signal:controller.signal}),/operation_cancelled/);cancelled.close();
});
test('unsupported target uses a current-image proposal and never treats a bottle as the target',async()=>{
 const bottle={label:'bottle',trackId:4,score:.9,box:[.6,.2,.8,.7]};let calls=0,visible=true;
 const detector=new TargetDetector({ready:true,busy:false,run:async()=>({detections:[bottle],candidates:[bottle]})},{locate:async()=>{calls++;return visible?{box,photo}:null;},reset(){}});
 const f=frame();const first=await detector.run(f,{objectTarget:'白色耳机盒'});
 assert.equal(first.candidates.length,1);assert.equal(first.candidates[0].source,'target_locator');assert.deepEqual(first.reportedDetections,[bottle]);
 const second=await detector.run(f,{objectTarget:'白色耳机盒'});assert.equal(second.candidates[0].trackId,first.candidates[0].trackId);
 visible=false;assert.deepEqual((await detector.run(f,{objectTarget:'白色耳机盒'})).candidates,[]);
 const supported=await detector.run(f,{target:'bottle',targets:['bottle'],objectTarget:'水瓶'});assert.deepEqual(supported.candidates,[bottle]);assert.equal(calls,3);
});
test('a newer task or source does not inherit the old target track',async()=>{
 const detector=new TargetDetector({ready:true,busy:false,run:async()=>({detections:[],candidates:[]})},{locate:async()=>({box,photo}),reset(){}});
 const first=await detector.run(frame(),{objectTarget:'耳机盒'});detector.reset();
 const second=await detector.run(frame(),{objectTarget:'耳机盒'});assert.notEqual(first.candidates[0].trackId,second.candidates[0].trackId);
});

test('an unvalidated crop is never written as a long-term reference',async t=>{
 const m=memory(t),events=[];
 const s=new Session({memory:m,providers:{singlePassMemory:true,targetLocator:{locate:async()=>null},describe:async()=>({v:true,n:'白色耳机盒',d:'白色椭圆形',l:'桌面左侧',b:box})},crop:async()=>{throw Error('must_not_save_unchecked_crop');},emit:event=>events.push(event)});t.after(()=>s.stop());
 s.start();s.frame(picture,s.source.generation,1,Date.now());await s.command({commandId:uuid(),text:'记住这个白色耳机盒'});
 assert.equal(m.all().length,1);assert.equal(m.photos(m.all()[0]).length,0);assert.equal(m.all()[0].captures.length,1);
 assert.match(events.filter(event=>event.type==='reply').at(-1).message,/再让我拍清/);
});

test('semantic localization snaps to the same-frame tight detection, not surrounding furniture',async()=>{
 const tight={label:'mouse',trackId:2,box,cropJpeg:picture.toString('base64')};
 const table={label:'dining table',trackId:3,box:[0,0,1,1],cropJpeg:picture.toString('base64')};
 const detector=new TargetDetector({ready:true,busy:false,run:async()=>({detections:[tight,table],candidates:[tight,table]})},{locate:async()=>({box:[.29,.29,.51,.51],photo}),reset(){}});
 const result=await detector.run(frame(),{objectTarget:'耳机盒'});
 assert.deepEqual(result.candidates[0].box,box);assert.equal(result.candidates[0].cropJpeg,tight.cropJpeg);assert.equal(result.candidates.length,1);
});
