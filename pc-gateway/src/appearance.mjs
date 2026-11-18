import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {OmniProviders} from './omni.mjs';
import {appearanceConfig} from './appearance-config.mjs';

export const referenceVersion=refs=>createHash('sha256').update(JSON.stringify(refs.map(r=>[r.id,createHash('sha256').update(r.image).digest('hex')]))).digest('hex');
export class AppearanceClient {
 constructor({python=process.env.APPEARANCE_PYTHON??process.env.ISEEYOU_PYTHON??'python',env=process.env}={}){
  this.ready=false;this.pending=null;this.queued=null;this.controls=[];this.closed=false;
  this.child=spawn(python,['-u',fileURLToPath(new URL('../python/appearance-worker.py',import.meta.url))],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...env,PYTHONDONTWRITEBYTECODE:'1'}});
  this.started=new Promise((resolve,reject)=>{this.startResolve=resolve;this.startReject=reject;});this.started.catch(()=>{});
  this.startTimer=setTimeout(()=>this.fail(Error('appearance_start_timeout')),90000);
  this.child.on('error',()=>this.fail(Error('appearance_start_failed')));this.child.on('exit',()=>this.fail(Error('appearance_stopped')));
  this.child.stdin.on('error',()=>this.fail(Error('appearance_pipe_closed')));this.child.stderr.on('data',()=>{});
  createInterface({input:this.child.stdout}).on('line',line=>{
   try{
    if(line.length>500000)throw Error('appearance_output_limit');const value=JSON.parse(line);
    if(value.ready){this.ready=value.modelReady;clearTimeout(this.startTimer);this.startResolve(value);return;}
    const p=this.pending;if(!p||p.id!==value.requestId)return;
    this.pending=null;clearTimeout(p.timer);p.cleanup();
    if(!p.aborted){
     if(p.data.operation!=='invalidate'&&['frameId','sourceGeneration','targetId','referenceVersion'].some(k=>value[k]!==p.data[k]))p.reject(Error('appearance_context_mismatch'));
     else p.resolve(value);
    }
    this.drain();
   }catch{this.fail(Error('appearance_output_invalid'));}
  });
 }
 fail(error){
  this.ready=false;clearTimeout(this.startTimer);this.startReject(error);
  for(const p of [this.pending,this.queued,...this.controls])if(p){clearTimeout(p.timer);p.cleanup();p.reject(error);}
  this.pending=this.queued=null;this.controls=[];this.child.kill();
 }
 async run(data,signal){
  await this.started;if(signal?.aborted)throw Error('operation_cancelled');if(this.closed)throw Error('appearance_closed');
  return new Promise((resolve,reject)=>{
   const p={id:randomUUID(),data,resolve,reject,signal,aborted:false};
   const abort=()=>{p.aborted=true;reject(Error('operation_cancelled'));if(this.queued===p){this.queued=null;p.cleanup();}};
   p.cleanup=()=>signal?.removeEventListener('abort',abort);signal?.addEventListener('abort',abort,{once:true});
   // Never accumulate old frames; one running request and one latest waiter.
   if(data.operation==='invalidate')this.controls.push(p);
   else {if(this.queued){this.queued.cleanup();this.queued.reject(Error('appearance_superseded'));}this.queued=p;}
   this.drain();
  });
 }
 drain(){
  if(this.pending||(!this.queued&&!this.controls.length)||this.closed)return;
  const p=this.controls.shift()??this.queued;if(p===this.queued)this.queued=null;
  if(p.aborted){p.cleanup();this.drain();return;}
  if(p.data.operation!=='invalidate'&&Date.now()>p.data.deadlineAtMs){p.cleanup();p.resolve({status:'STALE_FRAME',provider:'appearance_mvp'});this.drain();return;}
  this.pending=p;p.timer=setTimeout(()=>this.fail(Error('appearance_timeout')),12000);
  this.child.stdin.write(JSON.stringify({requestId:p.id,...p.data})+'\n');
 }
 close(){if(this.closed)return;this.closed=true;this.fail(Error('appearance_closed'));}
}

export class AppearanceProviders extends OmniProviders {
 constructor(options={}){super(options);this.appearance=options.appearance??new AppearanceClient();this.backend='appearance_mvp';this.cropPaddingFraction=appearanceConfig.cropPaddingFraction;this.localOnlyReview=true;this.trackCandidates=false;this.onDiagnostic=()=>{};this.versions=new Map();}
 invalidate(targetId){this.versions.delete(targetId);return this.appearance.run({operation:'invalidate',targetId}).catch(()=>{});}
 async review(frame,options,signal){
  if(options.memory)return super.review(frame,options,signal);
  const refs=(options.references??[]).slice(0,3).map((image,i)=>({id:options.referenceIds?.[i]??String(i),image:Buffer.from(image)}));
  const targetId=options.objectId??options.target,version=referenceVersion(refs);
  this.versions.set(targetId,version);
  const data={frameId:frame.frameId,sourceGeneration:frame.sourceGeneration,targetId,referenceVersion:version,
   deadlineAtMs:options.oneShot?Date.now()+8000:(frame.receivedAtMs??Date.now())+3000,
   references:refs.map(r=>({id:r.id,image:r.image.toString('base64')})),
   candidates:(options.candidates??[]).slice(0,8).map((c,i)=>({id:String(c.trackId??i),box:c.box,image:c.cropJpeg}))};
  let result;
  try{result=await this.appearance.run(data,signal);}catch(error){if(signal?.aborted||/cancelled|superseded/.test(error.message))throw error;result={status:'MODEL_ERROR',provider:this.backend,code:'model_worker_unavailable'};}
  if(signal?.aborted)throw Error('operation_cancelled');
  if(this.versions.get(targetId)!==version)throw Error('memory_changed');
  if(options.referencesCurrent&&!options.referencesCurrent())throw Error('memory_changed');
  // Session publishes the final verdict AFTER frame/target validity checks.
  return {...result,minBaseScore:appearanceConfig.minBaseScore,candidateIndex:result.selected?.candidateIndex??null,referenceCompared:!!refs.length};
 }
 close(){this.appearance.close();super.close();}
}
