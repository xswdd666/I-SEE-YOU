import {historicalPosition} from './spatial-order.mjs';
import {detectionLabel,matchingObjects,cleanObjectName,validObjectName,applyObjectName,observationName} from './object-names.mjs';
import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
import {mkdirSync,readFileSync,existsSync,unlinkSync} from 'node:fs';
import {check,id,text,time,uuid,hash,jpeg,writeNew} from './util.mjs';

export const labelFor=detectionLabel;
export const statusLabel={CAPTURED:'当时画面已保存，分析未完成',SCENE_ONLY:'当时画面已保存，外观和位置待确认',APPEARANCE_ONLY:'外观已保存，位置待确认',LOCATION_ONLY:'位置已保存，目标照片待补充',COMPLETE:'外观和位置均已保存'};
export class Memory {
 constructor(root,{now=Date.now}={}){
  this.root=resolve(root);this.now=now;mkdirSync(this.root,{recursive:true});
  this.db=new DatabaseSync(resolve(root,'memory.sqlite'));this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS objects(id TEXT PRIMARY KEY,body TEXT NOT NULL);');
  this.db.exec('CREATE TABLE IF NOT EXISTS search_feedback(task_id TEXT PRIMARY KEY,object_id TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,body TEXT NOT NULL); CREATE INDEX IF NOT EXISTS search_feedback_object ON search_feedback(object_id);');
  this.getRow=this.db.prepare('SELECT body FROM objects WHERE id=?');this.allRows=this.db.prepare('SELECT body FROM objects ORDER BY rowid');
  this.putRow=this.db.prepare('INSERT INTO objects(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body');
 }
 account(){return this.db.prepare("SELECT value FROM meta WHERE key='account'").get()?.value??null;}
 bindAccount(account){check(/^[a-f0-9-]{36}$/.test(account),'invalid_account');check(!this.account()||this.account()===account,'account_conflict');this.db.prepare("INSERT OR IGNORE INTO meta VALUES('account',?)").run(account);}
 pruneAutomatic(){
  const objects=this.allRows.all().map(row=>JSON.parse(row.body));
  const expired=objects.filter(o=>o.autoExpiresAtMs&&o.autoExpiresAtMs<=this.now());
  if(!expired.length)return;
  const expiredIds=new Set(expired.map(o=>o.id));
  const retained=new Set(objects.filter(o=>!expiredIds.has(o.id)).flatMap(o=>[...o.appearances,...o.captures].map(p=>p.image)));
  for(const o of expired){this.db.prepare('DELETE FROM objects WHERE id=?').run(o.id);for(const p of [...o.appearances,...o.captures])if(!retained.has(p.image))try{unlinkSync(this.file(p.image));}catch{}}
 }
 all(){this.pruneAutomatic();return this.allRows.all().map(row=>JSON.parse(row.body));}
 get(key){this.pruneAutomatic();const row=this.getRow.get(id(key));return row?JSON.parse(row.body):null;}
 matching(name){return matchingObjects(this.all(),name);}
 photos(object){return object.appearances.filter(p=>!object.captures.some(c=>c.capturedAtMs===p.capturedAtMs&&c.failureKind==='REVIEW_REJECTED'));}
 referenceVersion(object){return hash(JSON.stringify(this.photos(object).map(p=>[p.image,p.sha256]).sort()));}
 searchFeedback(object){
  const version=this.referenceVersion(object);
  return this.db.prepare('SELECT body FROM search_feedback WHERE object_id=? ORDER BY rowid DESC LIMIT 50').all(object.id).map(row=>JSON.parse(row.body)).filter(row=>row.referenceVersion===version);
 }
 searchProfile(object){
  const feedback=this.searchFeedback(object);
  const firstNegative=feedback.findIndex(row=>!row.correct);
  const streak=firstNegative<0?feedback.length:firstNegative;
  return {confirmed:feedback.filter(row=>row.correct).length,corrected:feedback.filter(row=>!row.correct).length,streak,familiar:streak>=3,recheck:firstNegative>=0&&streak<3};
 }
 searchPhotos(object){
  const weights=new Map();
  for(const row of this.searchFeedback(object))if(row.referenceId)weights.set(row.referenceId,(weights.get(row.referenceId)??0)+(row.correct?1:-2));
  return this.photos(object).slice().reverse().sort((a,b)=>(weights.get(b.image)??0)-(weights.get(a.image)??0)).slice(0,3);
 }
 recordSearchFeedback(result,correct){
  const object=this.get(result.objectId);
  if(!object||this.referenceVersion(object)!==result.referenceVersion)return false;
  id(result.taskId);check(typeof correct==='boolean','feedback_invalid');
  const previous=this.db.prepare('SELECT object_id,body FROM search_feedback WHERE task_id=?').get(result.taskId);
  if(previous){check(previous.object_id===object.id,'feedback_task_conflict');if(JSON.parse(previous.body).correct===correct)return false;}
  const referenceId=this.photos(object).some(p=>p.image===result.referenceId)?result.referenceId:null;
  const entry={taskId:result.taskId,referenceVersion:result.referenceVersion,referenceId,correct,recordedAtMs:this.now(),score:Number.isFinite(result.score)?result.score:null,durationMs:Number.isFinite(result.durationMs)?result.durationMs:null,frameId:result.frameId??null};
  this.db.exec('BEGIN IMMEDIATE');
  try{
   if(!correct&&result.retrieved&&object.events?.some(event=>event.id===result.retrieved)){
    object.events=object.events.filter(event=>event.id!==result.retrieved);
    object.updatedAtMs=Math.max(this.now(),object.updatedAtMs+1);this.put(object);
   }
   this.db.prepare('INSERT INTO search_feedback(task_id,object_id,body) VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET body=excluded.body').run(result.taskId,object.id,JSON.stringify(entry));
   this.db.prepare('DELETE FROM search_feedback WHERE object_id=? AND task_id NOT IN (SELECT task_id FROM search_feedback WHERE object_id=? ORDER BY rowid DESC LIMIT 50)').run(object.id,object.id);
   this.db.exec('COMMIT');return true;
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 references(object){const photos=this.photos(object).slice(0,3).map(p=>p.image);const scene=object.captures.filter(c=>c.description&&(this.observation(c)||['COMPLETE','LOCATION_ONLY'].includes(c.status))).at(-1);if(!photos.length)return scene?[scene.image]:[];if(scene&&this.observation(scene))return [...photos.slice(0,2),scene.image];return photos;}
 observation(c){return c&&['REVIEW_PENDING','REVIEW_UNCERTAIN','REVIEW_UNAVAILABLE'].includes(c.failureKind);}
 locationHistory(key){
  const o=this.get(key);check(o,'object_missing');
  const observed=o.captures.filter(c=>this.observation(c)&&c.suggestedLocation&&!c.verifiedLocation).map(c=>({id:c.id,placeId:null,location:c.suggestedLocation,anchor:'当时画面观察',observedAtMs:c.capturedAtMs,recordedAtMs:c.recordedAtMs,confirmed:false,source:'CAMERA_OBSERVED'}));
  return [...o.locations,...observed,...(o.autoObservations??[])].sort((a,b)=>(b.observedAtMs??b.recordedAtMs)-(a.observedAtMs??a.recordedAtMs)||b.recordedAtMs-a.recordedAtMs);
 }
 put(object){this.putRow.run(object.id,JSON.stringify(object));return object;}
 file(name){check(/^(photos|scenes)\/[A-Za-z0-9][A-Za-z0-9_-]{0,159}\.jpg$/.test(name),'invalid_image_path');return resolve(this.root,name);}
 image(name){return readFileSync(this.file(name));}
 capture(name,frame,{objectId=null,captureId=uuid()}={}){
  name=cleanObjectName(name);check(validObjectName(name),'object_name_invalid');
  text(name,40,false);jpeg(frame.jpeg);time(frame.capturedAtMs);time(frame.frameId);check(['PHONE','ESP32'].includes(frame.cameraSource),'invalid_source');
  const existing=objectId?this.get(objectId):null;check(!objectId||existing,'object_missing');check(this.all().length<500||existing,'memory_limit');
  const now=Math.max(this.now(),frame.capturedAtMs),oid=existing?.id??uuid();
  const object=existing??{id:oid,name,aliases:[],yoloLabel:labelFor(name),description:null,createdAtMs:now,updatedAtMs:now,appearances:[],locations:[],captures:[],events:[]};
  check(object.captures.length<20,'capture_limit');
  delete object.autoExpiresAtMs;
  const capture={id:id(captureId),image:`scenes/${captureId}.jpg`,sha256:hash(frame.jpeg),frameId:frame.frameId,cameraSource:frame.cameraSource,capturedAtMs:frame.capturedAtMs,recordedAtMs:now,status:'CAPTURED',description:null,suggestedLocation:null,verifiedLocation:null,failureKind:''};
  writeNew(this.file(capture.image),frame.jpeg);object.captures.push(capture);object.updatedAtMs=Math.max(now,object.updatedAtMs+1);this.put(object);
  return {objectId:oid,captureId,revision:object.updatedAtMs};
 }
 finish(receipt,{appearance=null,description=null,suggestedLocation=null,location=null,failureKind='',review=false,name=null}={}){
  const object=this.get(receipt.objectId);check(object&&object.updatedAtMs===receipt.revision,'memory_changed');
  const capture=object.captures.find(x=>x.id===receipt.captureId);check(capture&&(capture.status==='CAPTURED'||review&&capture.failureKind==='REVIEW_PENDING'),'capture_changed');
  if(!review)capture.previousDescription=object.description;
  let sample=null;
  if(appearance){sample=object.appearances.find(p=>p.sha256===hash(appearance.jpeg)&&p.capturedAtMs===capture.capturedAtMs)??null;}
  if(appearance&&!sample&&object.appearances.length<6){
   const sid=uuid(),bytes=jpeg(appearance.jpeg);const used=object.appearances.map(x=>x.viewIndex);const viewIndex=[0,1,2,3,4,5].find(x=>!used.includes(x));
   const embedding=appearance.embedding;check(typeof embedding==='string'&&Buffer.from(embedding,'base64').length===48*4,'appearance_descriptor_missing');
   sample={id:sid,image:`photos/${sid}.jpg`,sha256:hash(bytes),embedding,viewIndex,capturedAtMs:capture.capturedAtMs};
   writeNew(this.file(sample.image),bytes);object.appearances.push(sample);
  }
  if(location){text(location.location,600,false);object.locations.push({id:uuid(),placeId:null,location:location.location,anchor:text(location.anchor||'',600),observedAtMs:capture.capturedAtMs,confirmed:true,recordedAtMs:this.now(),source:'CAMERA_VERIFIED'});capture.verifiedLocation=location.location;}
  capture.description=description?text(description,2000):capture.description;capture.suggestedLocation=suggestedLocation?text(suggestedLocation,600):capture.suggestedLocation;capture.failureKind=text(failureKind,80);
  capture.status=sample?(location?'COMPLETE':'APPEARANCE_ONLY'):(location?'LOCATION_ONLY':'SCENE_ONLY');
  if(capture.description)object.description=capture.description;
  const observedName=observationName(object.name,name);if(observedName&&failureKind!=='REVIEW_REJECTED')applyObjectName(object,observedName);
  if(failureKind==='REVIEW_REJECTED')object.description=capture.previousDescription??null;
  object.updatedAtMs=Math.max(this.now(),object.updatedAtMs+1);this.put(object);return this.receipt(object.id);
 }
 receipt(key){
  const object=this.get(key);check(object,'object_missing');const capture=object.captures.at(-1);const photos=this.photos(object),photo=photos.length>0;const place=this.locationHistory(key)[0];
  const observed=this.observation(capture),appearance=photo||!!(observed&&capture.description),complete=photo&&!!place;
  const currentReferenceReady=!!capture&&photos.some(p=>p.capturedAtMs===capture.capturedAtMs);
  let message;if(capture?.status==='COMPLETE'&&photo)message=`记住啦，${object.description||object.name}当时在${historicalPosition(capture.verifiedLocation)}。`;
  else if(capture?.failureKind==='ANALYSIS_INTERRUPTED')message=`${object.name}上次没记全，照片还在，咱们再记一次吧。`;
  else if(capture?.status==='CAPTURED')message=this.now()-capture.recordedAtMs<30_000?`我还在记${object.name}，稍等一下。`:`${object.name}上次没记全，照片还在。`;
  else if(capture?.failureKind==='REVIEW_REJECTED')message=`这次没认准，原记录还在。你指的是哪件${object.name}？`;
  else if(capture?.failureKind==='REVIEW_PENDING'&&capture.description&&capture.suggestedLocation)message=`${object.name}的描述记下了，照片和位置还在核对。`;
  else if(!photo&&object.description&&place)message=`${object.name}的描述和上次位置记下了，再让我拍清它的样子吧。`;
  else if(!photo&&object.description)message=`${object.name}的描述记下了，再让我拍清样子和位置吧。`;
  else if(!photo&&place)message=`${object.name}的位置记下了，当时在${historicalPosition(place.location)}。样子还没看清，再让我拍拍吧。`;
  else if(observed&&capture.description&&capture.suggestedLocation)message=`${object.name}的描述记下了，当时看着在${historicalPosition(capture.suggestedLocation)}，位置还得核对。`;
  else if(complete)message=`${object.name}的样子已经记住，${place.observedAtMs===capture?.capturedAtMs?'这次记录在':'上次记录在'}${historicalPosition(place.location)}。`;
  else if(capture?.status==='LOCATION_ONLY')message=`${object.name}的位置记下了，当时在${historicalPosition(capture.verifiedLocation)}。靠近点，让我看看它的样子。`;
  else if(capture?.status==='APPEARANCE_ONLY')message=`${object.name}的样子记住了，镜头拉远点，让我看看它放哪儿。`;
  else if(capture)message=['ANALYSIS_FAILED','REVIEW_UNAVAILABLE'].includes(capture.failureKind)?`${object.name}的照片收到了，样子和位置还得再认一认。`:`${object.name}的照片收到了，样子和位置还得再认一认。`;
  else message=photo?`已有${object.name}的记录和外观照片${place?'、位置历史':''}，没有本次画面。`:`${object.name}的名字记下了，再让我看看它吧。`;
  return {objectId:object.id,captureId:capture?.id,revision:object.updatedAtMs,status:capture?.status??'LEGACY',appearance,referenceReady:photo,currentReferenceReady,complete,observed,sceneCount:object.captures.length,location:place?.location??null,message};
 }
 history(key){
  const object=this.get(key);check(object,'object_missing');const place=this.locationHistory(key)[0];const event=object.events?.at(-1);
  if(event?.type==='retrieved'&&(!place||event.recordedAtMs>=place.recordedAtMs))return `你拿到${object.name}后，放哪儿我还没记到。`;
  if(!place)return `${object.name}在哪儿，我还没摸清。`;
  return `上次${place.confirmed?'在画面中确认':place.source==='CAMERA_OBSERVED'?'画面里看到':'你告诉我'}${object.name}在${historicalPosition(place.location)}，记录时间是${new Date(place.observedAtMs??place.recordedAtMs).toLocaleString('zh-CN')}。现在是否还在那里需要重新查看。`;
 }
 recordRetrieved(key){const object=this.get(key);check(object,'object_missing');const event={id:uuid(),type:'retrieved',recordedAtMs:this.now(),source:'USER_STATEMENT'};(object.events??=[]).push(event);object.updatedAtMs=Math.max(this.now(),object.updatedAtMs+1);this.put(object);return event.id;}
 rename(key,name,revision){const object=this.get(key);check(object,'object_missing');check(revision===undefined||revision===object.updatedAtMs,'memory_changed');applyObjectName(object,name);object.updatedAtMs=Math.max(this.now(),object.updatedAtMs+1);this.put(object);return object;}
 addLocation(key,location){const object=this.get(key);check(object,'object_missing');object.locations.push({id:uuid(),placeId:null,location:text(location,600,false),anchor:'用户提供',observedAtMs:null,confirmed:false,recordedAtMs:this.now(),source:'USER_STATEMENT'});object.updatedAtMs=Math.max(this.now(),object.updatedAtMs+1);this.put(object);}
 records(){return this.all().map(o=>{const c=o.captures.at(-1),l=this.locationHistory(o.id)[0],e=o.events?.at(-1),r=this.receipt(o.id);return {id:o.id,name:o.name,appearance:o.description??'',sample_count:this.photos(o).length,reference_ready:r.referenceReady,appearance_observed:r.appearance,scene_count:o.captures.length,capture_status_label:o.autoExpiresAtMs?'自动记录，24小时有效':c?.failureKind==='REVIEW_REJECTED'?'本次观察有分歧，原记录已保留':!r.referenceReady&&o.description?(l?'文字描述和位置已保存，缺参考照片':'文字描述已保存，缺参考照片'):r.complete?(r.observed?'外观和位置已记录（相机观察）':'外观和位置已保存'):statusLabel[c?.status]??'',suggested_location:c&&!c.verifiedLocation&&!this.observation(c)?c.suggestedLocation??'':'',recorded_at:new Date(o.updatedAtMs).toISOString(),created_at:new Date(o.createdAtMs).toISOString(),location:e?.type==='retrieved'&&(!l||e.recordedAtMs>=l.recordedAtMs)?'已拿到，之后的位置未记录':l?.location??'尚未记录位置',location_source:l?.source??'',location_recorded_at:l?.recordedAtMs??0,aliases:o.aliases,relations:[]};});}
 edit(p){const o=this.get(p.id);check(o&&new Date(o.updatedAtMs).toISOString()===p.recorded_at,'memory_changed');applyObjectName(o,text(p.name,40,false));o.description=text(p.appearance,150);const loc=text(p.location,600,false);if(loc!=='尚未记录位置'&&loc!==this.records().find(x=>x.id===p.id).location)o.locations.push({id:uuid(),placeId:null,location:loc,anchor:'用户提供',observedAtMs:null,confirmed:false,recordedAtMs:this.now(),source:'USER_STATEMENT'});o.updatedAtMs=Math.max(this.now(),o.updatedAtMs+1);this.put(o);}
 delete(p){const o=this.get(p.id);check(o&&new Date(o.updatedAtMs).toISOString()===p.recorded_at,'memory_changed');this.db.prepare('DELETE FROM objects WHERE id=?').run(o.id);/* Original photographs and immutable cloud snapshots are retained. */}
 importObjects(objects,files,{preferNewer=false}={}){
  let restored=0,kept=0,updated=0;this.db.exec('BEGIN IMMEDIATE');try{for(const object of objects){const existing=this.get(object.id);if(existing&&(!preferNewer||existing.updatedAtMs>=object.updatedAtMs)){kept++;continue;}for(const entry of [...object.appearances,...object.captures]){const bytes=files.get(entry.image);check(bytes&&hash(bytes)===entry.sha256,'image_hash_invalid');const path=this.file(entry.image);if(existsSync(path))check(hash(readFileSync(path))===entry.sha256,'image_conflict');else writeNew(path,bytes);}this.put({...object,events:object.events??[]});if(existing)updated++;else restored++;}this.db.exec('COMMIT');return updated?{restored,kept,updated}:{restored,kept};}catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 captureAutomatic(name,frame,appearance,description,location){
  if(this.all().filter(o=>o.autoExpiresAtMs).length>=5)return null;
  jpeg(appearance.jpeg);check(typeof appearance.embedding==='string'&&Buffer.from(appearance.embedding,'base64').length===48*4,'appearance_descriptor_missing');
  if(description)text(description,2000);if(location)text(location,600,false);
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const receipt=this.capture(name,frame);
   this.finish(receipt,{appearance,description,failureKind:'REVIEW_UNCERTAIN'});
   if(location)this.addLocation(receipt.objectId,location);
   const object=this.get(receipt.objectId);object.autoExpiresAtMs=this.now()+24*60*60*1000;this.put(object);
   this.db.exec('COMMIT');return object;
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 observeAutomatic(key,location,observedAtMs,revision){
  const o=this.get(key);if(!o||o.updatedAtMs!==revision||!location)return false;
  text(location,600,false);time(observedAtMs);
  const prior=o.autoObservations?.at(-1);
  if(prior&&this.now()-prior.recordedAtMs<60000)return false;
  const manual=o.locations.at(-1);if(manual&&manual.location===location)return false;
  const entry={id:uuid(),placeId:null,location,anchor:'自动观察',observedAtMs,confirmed:false,recordedAtMs:Math.max(this.now(),o.updatedAtMs+1),source:'CAMERA_OBSERVED'};
  o.autoObservations=[...(prior?.location===location?o.autoObservations.slice(0,-1):o.autoObservations??[]),entry].slice(-12);
  o.updatedAtMs=Math.max(this.now(),o.updatedAtMs+1);this.put(o);return true;
 }
 close(){this.db.close();}
}
