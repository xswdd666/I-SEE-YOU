import {parseIntent} from './intent.mjs';
const key=question=>question.replace(/[\s，,。！？!?]/g,'');
const requestKey=intent=>[intent.action,intent.target??'',key(intent.question??'')].join(':');
export class SpeechPreparation {
 constructor({source,describe,locate,interpret=parseIntent,now=Date.now,diagnostic=()=>{}}){Object.assign(this,{source,describe,locate,interpret,now,diagnostic,finished:new Set()});}
 clear(){this.current?.controller?.abort();this.current=null;}
 prepare(id,raw){
  if(this.finished.has(id))return;
  if(this.current?.id!==id){this.clear();this.current={id,attempts:0};}
  const intent=raw&&!/记住|记录|保存|删除|取消/.test(raw)?this.interpret(raw):null;
  // Partial text can only trigger read-only scene analysis. It never saves,
  // finds an individual, or returns a spoken answer before final transcription.
  if(!['describe','locate'].includes(intent?.action)){if(raw){this.current.controller?.abort();this.current.job=null;}return;}
  const c=this.current,question=intent.question??raw,k=requestKey({...intent,question});
  if(c.job?.key===k)return;
  c.controller?.abort();c.job=null;
  const f=this.source.fresh();if(!f||c.attempts>=2)return;
  const controller=new AbortController(),snapshot={...f,jpeg:Buffer.from(f.jpeg)},started=this.now();
  c.controller=controller;c.attempts++;
  const promise=Promise.resolve().then(()=>{if(controller.signal.aborted)throw Error('operation_cancelled');return intent.action==='locate'?this.locate(snapshot,intent,controller.signal):this.describe(snapshot,null,question,controller.signal);}).then(result=>({result}),()=>({failed:true}));
  c.job={key:k,snapshot,promise,controller,started};
  this.diagnostic({type:'diagnostic',operation:'speech_vision_started',frameId:f.frameId});
 }
 take(id,intent){
  if(id){this.finished.add(id);while(this.finished.size>32)this.finished.delete(this.finished.values().next().value);}
  const c=this.current,j=c?.job;
  const valid=j&&id===c.id&&['describe','locate'].includes(intent?.action)&&requestKey(intent)===j.key&&
   !j.controller.signal.aborted&&this.now()-j.snapshot.receivedAtMs>=0&&this.now()-j.snapshot.receivedAtMs<=1000&&
   this.source.fresh()?.sourceGeneration===j.snapshot.sourceGeneration;
  if(!valid){this.clear();return null;}
  this.current=null;return j;
 }
 reset(){this.clear();this.finished.clear();}
}
