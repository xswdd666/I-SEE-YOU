import test from 'node:test';
import assert from 'node:assert/strict';
import {Memory} from '../src/memory.mjs';
import {memory,directory,frame,picture} from './helpers.mjs';
import {uuid} from '../src/util.mjs';
function save(m,objectId=null,sequence=0){
 const receipt=m.capture('黑色鼠标',{...frame(),capturedAtMs:Date.now()-100+sequence},{objectId});
 m.finish(receipt,{appearance:{jpeg:picture,embedding:Buffer.alloc(192).toString('base64')}});
 return m.get(receipt.objectId);
}
function result(m,object,referenceId){return {taskId:uuid(),objectId:object.id,referenceVersion:m.referenceVersion(object),referenceId,score:.8,durationMs:120,frameId:1};}

test('successful references are prioritized with bounded history and corrections reverse the credit',t=>{
 const m=memory(t);let object=save(m);
 for(let i=1;i<4;i++)object=save(m,object.id,i);
 const oldest=m.photos(object)[0].image,r=result(m,object,oldest);
 assert(!m.searchPhotos(object).some(p=>p.image===oldest));
 assert.equal(m.recordSearchFeedback(r,true),true);assert.equal(m.recordSearchFeedback(r,true),false);
 assert.equal(m.searchPhotos(object)[0].image,oldest);
 m.recordSearchFeedback(r,false);assert.equal(m.searchFeedback(object).length,1);assert.equal(m.searchProfile(object).recheck,true);
 assert.notEqual(m.searchPhotos(object)[0].image,oldest);
 for(let i=0;i<51;i++)m.recordSearchFeedback(result(m,object),true);
 assert.equal(m.searchFeedback(object).length,50);assert.equal(m.searchProfile(object).familiar,true);
});

test('feedback survives service restart; new references reset evidence and deleted objects remove feedback',()=>{
 const root=directory();let m=new Memory(root);
 try{
  const object=save(m),r=result(m,object,m.photos(object)[0].image);
  m.recordSearchFeedback(r,true);m.close();m=new Memory(root);
  assert.equal(m.searchProfile(m.get(object.id)).confirmed,1);
  const updated=save(m,object.id,10);
  assert.equal(m.searchProfile(updated).confirmed,0);
  assert.equal(m.recordSearchFeedback(r,true),false);
  m.delete({id:updated.id,recorded_at:new Date(updated.updatedAtMs).toISOString()});
  assert.equal(m.db.prepare('SELECT COUNT(*) AS n FROM search_feedback').get().n,0);
  assert.equal(m.recordSearchFeedback(r,true),false);
 }finally{m.close();}
});

test('semantic feedback requires verbatim evidence and rejects questions or tentative attribution',async()=>{
 const {validateSemantic}=await import('../src/intent.mjs');
 for(const raw of ['这是我的吗','如果找对了','好像是我的','他说明明找对了']){
  assert.equal(validateSemantic({action:'accept',evidence:raw},raw,'鼠标'),null);
 }
 assert.equal(validateSemantic({action:'accept',evidence:'不是我的'},'不是我的','鼠标'),null);
 assert.equal(validateSemantic({action:'accept',evidence:'找对了'},'继续找','鼠标'),null);
 assert.equal(validateSemantic({action:'accept',evidence:'找对了'},'找对了','鼠标').action,'accept');
});
