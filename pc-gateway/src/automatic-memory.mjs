import {validBox} from './providers.mjs';

// Automatic writes require stronger evidence than a spoken tentative match.
export class AutomaticMemory {
 constructor({memory,providers,now=Date.now,emit=()=>{},changed=()=>{}}){Object.assign(this,{memory,providers,now,emit,changed,lastRun:0,previous:null,cursor:0});}
 log(code){this.emit({type:'diagnostic',operation:'automatic_memory',code});}
 async match(frame,photo,objects,signal){
  if(!objects.length||objects.length>5)return null;
  const scores=[];
  for(const object of objects){
   const refs=this.memory.photos(object).slice(-3).reverse();
   if(!refs.length)return null;
   const r=await this.providers.review(frame,{oneShot:true,target:object.name,objectId:object.id,crop:photo.jpeg,references:refs.map(p=>this.memory.image(p.image)),referenceIds:refs.map(p=>p.image),candidates:[{box:[0,0,1,1],cropJpeg:photo.jpeg.toString('base64')}]},signal);
   if(!['LIKELY_MATCH','NO_MATCH'].includes(r.status))return null;
   const c=r.selected??r.candidates?.[0];
   const values=c?.referencePairs?.map(p=>p.scores?.base)??[c?.scores?.base];
   if(values.some(v=>!Number.isFinite(v)))return null;
   scores.push({object,score:Math.max(...values)});
  }
  scores.sort((a,b)=>b.score-a.score);
  return scores[0]?.score>=.8&&(!scores[1]||scores[0].score-scores[1].score>=.08)?scores[0].object:null;
 }
 async position(frame,box,signal){
  if(!validBox(box)||!this.providers.describeFoundLocation)return null;
  const detail=await this.providers.describeFoundLocation(frame,box,signal);
  if(!detail?.surface)return null;
  const surface=detail.surface.name+(detail.surface.relation==='inside'?'里':'上');
  const anchor=detail.anchors?.[0]?.name;
  return surface+(anchor?'，靠近'+anchor:'');
 }
 async statement(intent,frame,signal,valid){
  if(!frame||this.now()-frame.receivedAtMs>3000||!this.providers.targetLocator)return;
  const located=await this.providers.targetLocator.locate(frame,intent.target,{signal,timeoutMs:7000});
  if(!located?.photo||signal?.aborted||!valid())return;
  const objects=this.memory.matching(intent.target);
  const object=objects.length?await this.match(frame,located.photo,objects,signal):null;
  if(objects.length&&!object){this.log('identity_uncertain');return;}
  const reported=intent.location&&!/^(?:这|那|这里|那里|这儿|那儿)$/.test(intent.location)?intent.location:null;
  const location=reported??await this.position(frame,located.box??located.b,signal);
  if(signal?.aborted||!valid())return;
  if(object){
   if(!location)return;
   // User-stated placement is retained as a statement, never upgraded to visual verification.
   if(reported){const current=this.memory.get(object.id);if(current?.updatedAtMs!==object.updatedAtMs)return;
    if(this.memory.locationHistory(object.id)[0]?.location===reported)return;
    this.memory.addLocation(object.id,reported);
   }else if(!this.memory.observeAutomatic(object.id,location,frame.capturedAtMs,object.updatedAtMs))return;
  }else{
   const created=this.memory.captureAutomatic(intent.target,frame,located.photo,located.d??null,reported);
   if(!created){this.log('temporary_limit');return;}
   if(location&&!reported)this.memory.observeAutomatic(created.id,location,frame.capturedAtMs,created.updatedAtMs);
  }
  this.changed();this.log('statement_saved');
 }
 async observe(frame,candidates,signal,valid){
  if(this.now()-this.lastRun<8000)return;this.lastRun=this.now();
  const objects=this.memory.all().filter(o=>!o.autoExpiresAtMs&&this.memory.photos(o).length);
  const eligible=candidates.filter(c=>validBox(c.box)&&c.cropJpeg&&candidates.filter(other=>other.label===c.label).length===1&&objects.some(o=>o.yoloLabel===c.label));
  if(!eligible.length){this.previous=null;return;}
  const candidate=eligible[this.cursor%eligible.length];
  const object=await this.match(frame,{jpeg:Buffer.from(candidate.cropJpeg,'base64')},objects.filter(o=>o.yoloLabel===candidate.label),signal);
  if(!object||signal?.aborted||!valid()){this.previous=null;this.cursor++;return;}
  const previous=this.previous;this.previous={id:object.id,revision:object.updatedAtMs,generation:frame.sourceGeneration,frameId:frame.frameId,at:this.now()};
  if(!previous||previous.id!==object.id||previous.revision!==object.updatedAtMs||previous.generation!==frame.sourceGeneration||previous.frameId===frame.frameId||this.now()-previous.at>20000)return;
  this.cursor++;
  if(this.now()-(object.autoObservations?.at(-1)?.recordedAtMs??0)<60000)return;
  const location=await this.position(frame,candidate.box,signal);
  if(signal?.aborted||!valid()||!location)return;
  if(this.memory.observeAutomatic(object.id,location,frame.capturedAtMs,object.updatedAtMs)){this.changed();this.log('location_observed');}
 }
}
