import test from 'node:test';
import assert from 'node:assert/strict';
import {Memory} from '../src/memory.mjs';
import {Session} from '../src/session.mjs';
import {AppearanceProviders,AppearanceClient} from '../src/appearance.mjs';
import {parseIntent} from '../src/intent.mjs';
import {directory,picture,frame} from './helpers.mjs';
import {uuid} from '../src/util.mjs';
const offline={warm:async()=>{},reset(){},close(){},request:async()=>{throw Error('Unexpected cloud identity review');}};
const waitUntil=async fn=>{const until=Date.now()+20000;while(!fn()){assert(Date.now()<until,'flow timed out');await new Promise(r=>setTimeout(r,20));}};

test('saved appearance/location recall is local and never parsed as remembering',()=>{
 for(const raw of ['你之前记住的手机的外观和位置是什么','上次保存的蓝色水杯的样子和位置'])assert.equal(parseIntent(raw,'耳机').action,'history');
 for(const raw of ['记住手机的外观和位置','再记住之前那部手机的外观和位置'])assert.equal(parseIntent(raw,'耳机').action,'remember');
 assert.equal(parseIntent('这个是不是我上次让你记住的那个','手机').action,'identify');
});

test('four flows: transient scene, explicit durable save, restart recall and real local comparison',async t=>{
 const root=directory(),events=[];let saves=0,sceneCalls=0;
 const m=new Memory(root);let open=true;t.after(()=>{if(open)m.close();});
 const appearance=new AppearanceClient({env:{...process.env,ISEEYOU_RUNTIME:directory()}});
 const providers=new AppearanceProviders({appearance,client:offline,intentClient:offline});t.after(()=>providers.close());await appearance.started;
 providers.describe=async(f,target)=>{sceneCalls++;return target?{v:true,n:'蓝色水杯',d:'蓝色圆柱杯身，浅色杯盖',l:'键盘左侧',b:[.2,.1,.8,.9]}:{v:true,answer:'画面中有水杯、耳机和手机。',items:['水杯','耳机','手机']};};
 providers.locate=async()=>({v:true,answer:'耳机在手机右侧。',items:['水杯','耳机','手机']});
 const candidate={label:'cup',trackId:1,score:.9,box:[.2,.1,.8,.9],cropJpeg:picture.toString('base64')};
 const s=new Session({memory:m,providers,backup:{schedule(){saves++;}},crop:async()=>({jpeg:picture,embedding:Buffer.alloc(192).toString('base64')}),detector:{ready:true,busy:false,run:async f=>({frameId:f.frameId,detections:[candidate],candidates:[candidate]})},emit:e=>events.push(e)});t.after(()=>s.stop());
 const feed=()=>s.frame(picture,s.source.generation,(s.source.fresh()?.clientFrameId??0)+1,Date.now());
 const command=text=>s.command({commandId:uuid(),text});s.start();feed();
 await command('当前画面有什么');feed();await command('这个耳机的位置在哪里');
 assert.equal(m.all().length,0);assert.equal(saves,0);assert.match(events.filter(e=>e.kind==='result').at(-1).message,/手机右侧/);
 feed();await command('记住水杯');assert.equal(m.all().length,1);const object=m.all()[0];assert.equal(m.photos(object).length,1);assert.match(m.history(object.id),/键盘左侧/);
 const before=m.all(),saveCount=saves,calls=sceneCalls;
 feed();await command('这个是不是上次让你记住的那个');
 assert.match(events.filter(e=>e.kind==='result').at(-1).message,/参考照片外观相符/);
 assert.equal(s.task,null);assert.deepEqual(m.all(),before);assert.equal(saves,saveCount);assert.equal(sceneCalls,calls+1);
 s.stop();m.close();open=false;
 const restored=new Memory(root);t.after(()=>restored.close());const recalled=[];
 const read=new Session({memory:restored,providers:{describe(){throw Error('Recall must not call camera');},review(){throw Error('Recall must not match');}},emit:e=>recalled.push(e)});t.after(()=>read.stop());
 await read.command({commandId:uuid(),text:'你之前记住的水杯的外观和位置是什么'});
 assert.match(recalled.filter(e=>e.kind==='result').at(-1).message,/你说的是.*蓝色水杯/);
 await read.command({commandId:uuid(),text:'是的'});
 const answer=recalled.filter(e=>e.kind==='result').at(-1).message;assert.match(answer,/蓝色圆柱杯身/);assert.match(answer,/键盘左侧/);assert.deepEqual(restored.all(),before);
});
