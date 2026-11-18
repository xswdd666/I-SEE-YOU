import {AutomaticMemory} from './automatic-memory.mjs';
import {SpeechPreparation} from './speech-preparation.mjs';
import {CandidateContinuity} from './tracking.mjs';
import {PhoneLatest} from '../vendor/plan-b/g06-phone-source.mjs';
import {check,text,uuid,hash,safeError} from './util.mjs';
import {labelFor} from './memory.mjs';
import {parseIntent,spokenSearchEnd,validateSemantic,certainLocalIntent} from './intent.mjs';
import {pythonJson} from './archive.mjs';
import {validBox} from './providers.mjs';
import {rankCandidates} from './candidates.mjs';
import {detectionLabels} from './object-names.mjs';
import {SceneDialogue} from './scene-dialogue.mjs';
import {appearanceConfig} from './appearance-config.mjs';
import {cleanObjectName,validObjectName,matchingObjects} from './object-names.mjs';
import {identityReply,identityQuestion} from './memory-dialogue.mjs';
import {visualReply,featureMatch,visibleQuestion} from './visual-choice.mjs';
import {stageFor,isRetake} from './flows.mjs';
import {locationWords} from './found-location.mjs';

const comparisonRetryMessage='还没确认，请说“核对现在这件”重试。';
const sceneRetryMessage='请说“描述眼前”再试一次。';
const comparisonRetry=/^(?:请|帮我)?(?:核对(?:一下)?(?:现在|当前)(?:这件|这个|这只|这副)|重新核对|再核对一下|再看一眼|再认一下|重试|再试一次|再试一下)(?:吧)?[。！!\s]*$/;

const overlap=(a,b)=>{const i=Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]));return i/Math.max(1e-9,(a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-i);};
export class Session {
 constructor({memory,backup,providers,detector,emit=()=>{},now=Date.now,crop=null,searchTimeoutMs=30_000,automaticMemory=false}={}){
  Object.assign(this,{memory,backup,providers,detector,emit,now,focus:null,task:null,serial:0,generation:0,source:new PhoneLatest(),state:'IDLE',lastAnalyzed:null,lastFrameKey:null,active:new Set(),commands:new Map(),choices:null,rejections:[],lastReview:0,reviewing:false,lastConfirmed:null,cloudRequests:0,lastTarget:null});
  this.sceneDialogue=new SceneDialogue({now:this.now});
  this.speechPrep=new SpeechPreparation({source:this.source,now:this.now,interpret:raw=>this.readIntent(raw),describe:(...args)=>this.providers.describe(...args),locate:(frame,intent,signal)=>this.locateScene(frame,intent,signal),diagnostic:e=>this.emit(e)});
  this.memoryWork=new Map();
  this.flow=null;this.currentSave=null;
  this.automatic=automaticMemory?new AutomaticMemory({memory,providers,now,emit,changed:()=>this.emit({type:'memory.changed'})}):null;
  this.autoWorking=false;
  this.pendingFeedback=null;
  this.searchTimeoutMs=searchTimeoutMs;
  this.searchDeadline=null;
  this.crop=crop??(async(frame,box)=>{const r=await pythonJson('../python/image.py',{jpeg:frame.jpeg.toString('base64'),box,paddingFraction:this.providers.backend==='appearance_mvp'?(this.providers.cropPaddingFraction??.05):0},{limit:4*1024*1024});return {...r,jpeg:Buffer.from(r.jpeg,'base64')};});
 }
 start(source='PHONE'){this.pendingFeedback=null;this.lastReply=null;this.lastComparison=null;this.searchDeadline=null;this.flow=null;this.currentSave=null;this.preparingUtterance=null;this.sceneDialogue.clear();this.cancel(false);check(['PHONE','ESP32'].includes(source),'invalid_source');this.cameraSource=source;this.source.start();return {generation:this.source.generation};}
 stop(){this.pendingFeedback=null;this.lastReply=null;this.lastComparison=null;this.searchDeadline=null;this.flow=null;this.currentSave=null;this.preparingUtterance=null;this.sceneDialogue.clear();this.speechPrep.reset();this.serial++;this.intentController?.abort();this.providers.reset?.();this.cancel(false);this.source.stop();this.emit({type:'state',state:'IDLE',message:'观察已结束'});}
 bindConversation(conversationId) {
  check(typeof conversationId === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(conversationId), 'invalid_conversation');
  if(this.conversationId === conversationId) return;
  this.searchDeadline=null;
  this.preparingUtterance=null;this.speechPrep.reset();this.intentController?.abort();this.providers.reset?.();
  this.flow=null;this.currentSave=null;
  this.sceneDialogue.clear();
  this.serial++;
  this.cancel(false);
  this.source.stop();
  this.focus = null;
  this.lastTarget = null;
  this.rejections = [];
  this.commands.clear();
  this.lastAnalyzed = null;
  this.lastFrameKey = null;
  this.lastReview = 0;
  this.cloudRequests = 0;
  this.lastComparison=null;
  this.lastReply=null;
  this.pendingFeedback=null;
  this.conversationId = conversationId;
  this.update('新会话已开始');
 }
 frame(jpeg,generation,sequence,capturedAtMs,ageMs=0){check(Number.isSafeInteger(capturedAtMs)&&capturedAtMs>=0&&Number.isFinite(ageMs)&&ageMs>=0&&ageMs<2000,'stale_frame');const f=this.source.accept(jpeg,generation,sequence);f.capturedAtMs=Math.min(capturedAtMs,this.now());f.cameraSource=this.cameraSource;f.clientFrameId=sequence;f.receivedMs-=ageMs;f.receivedAtMs=this.now()-ageMs;return f;}
 frozen(){const f=this.source.fresh();check(f,'fresh_frame_required');return {...f,jpeg:Buffer.from(f.jpeg)};}
 clearAcknowledgement(){clearTimeout(this.ackTimer);this.ackTimer=null;}
 acknowledge(message,serial=this.serial){
  this.clearAcknowledgement();
  this.ackTimer=setTimeout(()=>{if(serial===this.serial)this.say(message,serial,'ack');},120);
  this.ackTimer.unref?.();
 }
 say(message,serial=this.serial,kind='result'){
  if(serial!==this.serial)return;
  if(kind!=='ack'){this.clearAcknowledgement();this.lastReplySerial=serial;this.lastReply=message;}
  this.emit({type:'reply',eventId:uuid(),serial,commandId:this.commandId,kind,message:text(message,2000,false),objectId:this.focus?.id??null});
  if(this.turnStarted!=null&&!this.turnMetrics?.has(kind)){
   this.turnMetrics??=new Set();this.turnMetrics.add(kind);
   this.emit({type:'diagnostic',operation:kind==='ack'?'ack_ready':kind==='progress'?'progress_ready':'result_ready',serial,durationMs:Math.round(performance.now()-this.turnStarted)});
  }
 }
 update(message=''){this.emit({type:'state',serial:this.serial,commandId:this.commandId,state:this.state,target:this.task?.target??null,objectId:this.focus?.id??null,message});}
 changed(){this.backup?.schedule();this.emit({type:'memory.changed'});}
 abortWork(keepMemory=false){
  for(const controller of this.active){
   if(keepMemory&&this.memoryWork.has(controller))continue;
   controller.abort();this.active.delete(controller);
   const receipt=this.memoryWork.get(controller);if(!receipt)continue;
   const capture=this.memory.get(receipt.objectId)?.captures.find(c=>c.id===receipt.captureId);
   if(capture?.status==='CAPTURED')try{this.memory.finish(receipt,{failureKind:'ANALYSIS_INTERRUPTED'});this.changed();}catch{/* A newer saved revision must never be overwritten. */}
  }
 }
 cancel(reply=true){if(reply){this.pendingFeedback=null;this.searchDeadline=null;this.flow=null;this.currentSave=null;}this.speechPrep.clear();this.clearAcknowledgement();this.generation++;this.abortWork();this.detector?.reset?.();this.task=null;this.choices=null;this.reviewing=false;this.state='IDLE';this.lastConfirmed=null;this.reviewTrack=null;this.update();if(reply)this.say('好，先停这儿。');}
 prepareSpeech(id,raw=''){
  text(id,160,false);text(raw,600);if(!this.source.generation)return {accepted:false};
  if(this.preparingUtterance!==id){this.preparingUtterance=id;const started=performance.now();void Promise.resolve().then(()=>this.providers.warm?.()).then(()=>this.emit({type:'diagnostic',operation:'speech_connection_ready',durationMs:Math.round(performance.now()-started)})).catch(error=>this.emit({type:'diagnostic',operation:'speech_connection',code:safeError(error)}));}
  this.speechPrep.prepare(id,raw);return {accepted:true};
 }
 async command(command){
  const commandId=text(command.commandId,160,false);if(this.commands.has(commandId))return this.commands.get(commandId);
  const run=this.execute(command);this.commands.set(commandId,run);while(this.commands.size>128)this.commands.delete(this.commands.keys().next().value);return run;
 }
 freshFeedback(){
  const pending=this.pendingFeedback;
  if(!pending||pending.generation!==this.source.generation||this.now()>pending.expiresAt)return null;
  const object=this.memory.get(pending.objectId);
  return object&&this.memory.referenceVersion(object)===pending.referenceVersion?pending:null;
 }
 submitSearchFeedback(correct){
  const pending=this.freshFeedback();
  if(!pending)return null;
  const changed=this.memory.recordSearchFeedback(pending,correct);
  if(changed&&!correct&&pending.retrieved)this.changed();
  if(changed)this.emit({type:'diagnostic',operation:'search_feedback',code:correct?'confirmed':'corrected',taskId:pending.taskId,objectId:pending.objectId,...this.memory.searchProfile(this.memory.get(pending.objectId))});
  return pending;
 }
 readIntent(raw){
  if(this.freshFeedback()){
   const reply=raw.trim().replace(/[。！!]+$/,'');
   if(/^(?:对[，,]?|是的[，,]?)?(?:就?是(?:它|这个|这件|我要找的(?:那个|这个|那件)))$/.test(reply)||/^(?:对|对的|是的|找对了)$/.test(reply))return {action:'accept'};
   if(/^(?:不是[，,]?)?(?:你)?认错了(?:[，,]?(?:这|这个|它)是[^，,。！？!?]{1,16})?$/.test(reply))return {action:'reject'};
  }
  const scene=this.sceneDialogue.fresh(this.source.generation);
  const focus=scene?scene.focus:this.task?.target??this.focus?.name??this.lastTarget;
  if(this.searchDeadline!==null){
   const finish=spokenSearchEnd(raw,this.task?.target??this.focus?.name??this.lastTarget,true);
   if(finish)return finish;
  }
  const parsed=this.searchIntent(parseIntent(raw,focus,scene?.focus??this.lastConfirmed?.observation?.target??null),raw);
  if(parsed?.action==='complete')return parsed;
  const retry=this.choices;
  if(retry?.kind==='retry_identify'&&retry.generation===this.source.generation&&this.now()<retry.expiresAt&&comparisonRetry.test(raw.trim()))return {...retry.intent,liveComparison:true};
  const comparison=this.lastComparison;
  if(comparison&&comparison.generation===this.source.generation&&this.now()<comparison.expiresAt&&
     (/^(?:不是[，,\s]*(?:认错了)?|不对|认错了|你认错了|再看一下|重新核对|再核对一下|核对(?:一下)?(?:现在|当前)(?:这件|这个|这只|这副))[。！!\s]*$/.test(raw.trim())||comparisonRetry.test(raw.trim()))){
   return {...comparison.intent,liveComparison:true,correction:/不是|不对|认错/.test(raw)};
  }
  if(['ask_target','scan'].includes(parsed?.action))return parsed;
  if(parsed?.action==='continue'){
   if(this.flow==='scene_search'&&this.lastTarget)return {action:'scan',target:this.lastTarget};
   if(scene?.focus)return {action:'scan',target:scene.focus};
  }
  if(this.choices?.kind==='search_target'&&this.now()<this.choices.expiresAt&&!parsed){
   const name=cleanObjectName(raw.trim().replace(/^(?:我想找|我要找|我想要|就是|是)/,''));
   if(validObjectName(name)&&name.length<=24&&!/想|帮|取消|算了|记得|记忆|怎么|什么|一下|吗|请问/.test(name))return {action:'scan',target:name};
  }
  // Explicit current observation/save requests must never answer a historical choice.
  if(['remember','describe','locate'].includes(parsed?.action))return this.sceneDialogue.route(raw,parsed,this.source.generation);
  const save=this.freshSave();
  if(save&&isRetake(raw))return {action:'remember',target:save.target,objectId:save.objectId};
  const visual=visualReply(raw,parsed,this.choices);if(visual)return visual;
  const reply=this.choices?.kind==='identity'?identityReply(raw,parsed,this.choices,this.memory.all(),this.now()):null;
  if(reply)return reply;
  const savedPronoun=/(?:^|[，,\s]|有没有|是否有|是否是|找|看看|记住|记得|画面中|画面里)(?:它|他|她|这件|那件|这个|那个|该物品)(?=的|上次|之前|现在|在|放|长|外观|样子|是不是|是否是|吗|呢|了|[。！？!?，,\s]|$)/.test(raw);
  // A confirmed saved identity takes precedence over transient scene pronouns.
  if(this.focus&&this.task&&/^(?:它|这件|那件|那个|这个)(?:现在)?(?:在哪|在哪里|在哪儿)/.test(raw.trim()))return {action:'find',target:this.focus.name,objectId:this.focus.id};
  if(!scene&&!this.choices&&this.focus&&savedPronoun&&['identify','find','history','check','appearance','update'].includes(parsed?.action)&&parsed.target===this.focus.name)return {...parsed,objectId:this.focus.id};
  return this.sceneDialogue.route(raw,parsed,this.source.generation);
 }
 searchIntent(intent,raw){
  if(intent?.action!=='find')return intent;
  // A named current-view target never inherits a saved identity merely because
  // the library has a similar name. A pronoun can still refer to recalled memory.
  const saved=/我的|记住|记得|记录|保存|记忆库|上次|以前/.test(raw.replace(/我的(?:镜头|画面)/g,''));
  const pronoun=/(?:找|有没有|是否有|看看)(?:一下)?(?:它|他|她|该物品|这件|那件|这个|那个)[。！？!?吗呢吧\s]*$/.test(raw.trim());
  if(saved||this.focus&&(pronoun||/之前说过的|刚才说的/.test(raw)||/^(?:(?:可以|好|好的|哦|嗯|你)[，,。\s]*)*(?:现在呢|这样呢|看一下|看看|看一看|再看一下)[。！？!?]*$/.test(raw.trim())))return intent;
  if(!intent.target)return {action:'ask_target'};
  if(/有没有|是否有|有无|还在不在|是否还在/.test(raw))return {action:'locate',target:intent.target,question:raw};
  if(/找|寻/.test(raw))return {action:'scan',target:cleanObjectName(intent.target.replace(/^(?:(?:当前)?画面[中里上]?|镜头[中里]|桌[面子]?上)[的上]?/,''))};
  return {action:'locate',target:intent.target,question:raw};
 }
 locateScene(frame,intent,signal){return this.providers.locate?this.providers.locate(frame,{target:intent.target,question:intent.question},signal):this.providers.describe(frame,null,'只看当前画面，回答'+intent.target+'的相对位置：'+intent.question,signal);}
 async execute(command){
  const justExpired=this.expireSearch();
  const searchWasOpen=this.searchDeadline!==null;
  const previousTask=this.task,previousChoices=this.choices,previousConfirmed=this.lastConfirmed;
  const scene=this.sceneDialogue.fresh(this.source.generation);
  const context=scene?scene.focus:previousTask?.target??this.focus?.name??this.lastTarget;
  const raw=text(command.text??'',600);
  let intent=command.action?{action:command.action,target:command.target,objectId:command.objectId,index:command.index,question:command.question}:this.readIntent(raw);
  if(justExpired&&!command.action&&/^(?:对|对的|是|是的|确认)[。！!\s]*$/.test(raw.trim())){
   intent={action:'clarify',answer:'刚才的找物任务已过期，请重新告诉我要找哪件物品。'};
  }
  if(command.action==='find'&&!command.objectId)intent={action:command.target?'scan':'ask_target',target:command.target};
  if(intent?.action==='ignore')return;
  const comparison=this.lastComparison&&this.lastComparison.generation===this.source.generation&&this.now()<this.lastComparison.expiresAt?this.lastComparison:null;
  const retry=previousChoices?.kind==='retry_identify'&&previousChoices.generation===this.source.generation&&this.now()<previousChoices.expiresAt?previousChoices.intent:null;
  const routeContext={pendingSearchResult:this.freshFeedback()?{target:this.memory.get(this.pendingFeedback.objectId).name}:null,task:this.flow,currentTarget:scene?.focus??previousTask?.target??null,
   lastReply:this.lastReply?.slice(0,240)??null,
   previousComparison:(retry??comparison?.intent)?{target:(retry??comparison.intent).target,visibleTarget:(retry??comparison.intent).visibleTarget}:null,
   currentSave:this.freshSave()?.target??null,
   pendingQuestion:previousChoices&&this.now()<previousChoices.expiresAt?previousChoices.kind:null};
  const expiredClarification=intent?.action==='clarify'&&(justExpired||previousChoices&&this.now()>previousChoices.expiresAt);
  const localCertain=command.action||expiredClarification||certainLocalIntent(raw,intent);
  if(!localCertain&&(this.providers.intent||['remember','update'].includes(intent?.action)&&/不要|不用|别|不想/.test(raw)))intent=null;
  const routeStarted=performance.now();
  this.lastComparison=null;
  const userSpokeAt=this.now();
  this.searchDeadline=null;
  const serial=++this.serial,started=performance.now();
  this.intentController?.abort();this.clearAcknowledgement();this.commandId=command.commandId;this.turnStarted=started;this.turnMetrics=new Set();
  try {
  // Retire foreground work BEFORE awaiting interpretation of the new command.
  // Only an explicit read-only query may let an existing memory save finish silently.
  this.emit({type:'speech.clear',serial,commandId:this.commandId});
  const query=['history','check','appearance'].includes(intent?.action);
  this.abortWork(query);this.generation++;this.task=null;this.choices=null;this.reviewing=false;this.lastConfirmed=null;this.reviewTrack=null;this.state='IDLE';this.update('正在处理这次提问');
  this.emit({type:'diagnostic',operation:'turn_boundary',serial,disposition:query?'query':['continue','reject','features','accept','select','visual_reply'].includes(intent?.action)?'followup':'replace'});
  this.focus=this.focus?this.memory.get(this.focus.id):null;let snapshot=null;try{snapshot=this.frozen();}catch{}
  if(!intent&&this.providers.intent){
   const c=new AbortController();this.intentController=c;
   try{
    const related=this.memory.matching(context??'');
    const names=(related.length?related:this.memory.all()).slice(0,40).map(o=>o.name);
    intent=validateSemantic(await this.providers.intent(raw,context,names,c.signal,routeContext),raw,context);
    if(serial!==this.serial||c.signal.aborted)return;
    if(['accept','reject'].includes(intent?.action)&&!this.freshFeedback())intent={action:'clarify',answer:'你说的是哪次找物结果？'};
    if(intent?.action==='retry_identify'){
     const previous=retry??comparison?.intent;
     intent=previous?{...previous,liveComparison:true,correction:/不是|不对|认错|不准/.test(raw)}:{action:'clarify',answer:'你想重新核对哪件物品？'};
    }else if(intent?.action==='choice_reply'){
     intent=identityReply(raw,{action:'features',description:intent.description},previousChoices,this.memory.all(),this.now())??
       visualReply(raw,{action:'features',description:intent.description},previousChoices)??{action:'clarify',answer:'你指的是哪件物品？'};
    }else if(intent?.referenceScope!=='saved'){
     intent=this.sceneDialogue.route(raw,this.searchIntent(intent,raw),this.source.generation);
    }
    this.emit({type:'diagnostic',operation:'intent_route',code:'model',action:intent?.action,durationMs:Math.round(performance.now()-routeStarted),serial});
   }catch(error){this.emit({type:'diagnostic',operation:'intent_route',code:'model_error',durationMs:Math.round(performance.now()-routeStarted),serial});}
   if(serial!==this.serial)return;
  }else this.emit({type:'diagnostic',operation:'intent_route',code:'local',action:intent?.action,durationMs:Math.round(performance.now()-routeStarted),serial});
  if(intent?.action==='identify'&&raw&&!intent.liveComparison){
   // A follow-up points to the object we just spoke about. Explicit requests
   // about the live view always use the frame captured for this new question.
   const subject=previousConfirmed?.observation??scene?.observation;
   const age=subject?this.now()-subject.frame.receivedAtMs:Infinity;
   const requested=cleanObjectName(intent.visibleTarget||intent.target||'');
   const sameSubject=subject&&(cleanObjectName(subject.target)===requested||
    matchingObjects([{name:subject.target,aliases:[]}],requested).length===1);
   if(sameSubject&&age>=0&&age<=120000&&subject.frame.sourceGeneration===this.source.generation&&
      /这|它|刚才|刚刚|^(?:是|跟|和|与)/.test(raw.trim())&&!/现在|当前|眼前|镜头|画面|换了|另外|另一/.test(raw)){
    snapshot={...subject.frame,comparisonSubject:subject};
   }
  }
  const prepared=this.speechPrep.take(command.utteranceId,intent);
  if(!intent){this.flow=null;this.currentSave=null;this.say(context?'这次没能理解这句提问。你可以说“继续找'+context+'”“上次'+context+'在哪里”，或直接说新的要求。':'你希望我帮你看什么，或者记住哪件物品？',serial);return;}
   if(intent.target&&['scan','identify','find','remember','history','check','appearance','update'].includes(intent.action)){
    intent.target=cleanObjectName(intent.target);
    if(!validObjectName(intent.target))intent={action:'clarify',answer:'我没有听清物品名，请说“白色手提袋”或“手机”这样的名称。'};
    else this.lastTarget=intent.target;
   }
  if(intent.action==='ignore')return;
  if(!['accept','reject','complete'].includes(intent.action))this.pendingFeedback=null;
  const searchRequest=['ask_target','scan','find','identify'].includes(intent.action);
  const followup=searchWasOpen&&(['continue','reject','features','accept','select','visual_reply','locate'].includes(intent.action)||intent.identityChoice);
  if(searchRequest||followup)this.searchDeadline=userSpokeAt+60_000;
  if(intent.action==='locate')intent.question??=raw||intent.target+'在哪里';
  if(!['describe','locate','clarify'].includes(intent.action))this.sceneDialogue.clear();
  this.emit({type:'diagnostic',operation:'intent_resolved',serial,action:intent.action});
  if(previousTask&&['continue','reject','features','accept'].includes(intent.action)){this.task={...previousTask,serial,generation:this.generation,lastDetectionKey:null};if(intent.action==='reject')this.lastConfirmed=previousConfirmed;this.state='SEARCHING';}
  if(intent.action==='visual_reply'){this.choices=previousChoices;return await this.answerAppearance(intent,serial);}
  if(intent.action==='select')this.choices=previousChoices;
  if(['chat','clarify'].includes(intent.action)){
   this.currentSave=null;if(!intent.identityChoice)this.flow=null;
   if(intent.identityChoice){this.choices=intent.identityChoice;this.emitIdentityChoices();}
   this.say(intent.answer,serial);return;
  }
  if(['identify','find','remember','history','check','appearance','locate','update'].includes(intent.action)&&!intent.target&&!intent.objectId){this.say('你说的是哪件物品？',serial);return;}
  if(intent.action==='select'&&this.choices?.kind==='identity'&&this.now()>this.choices.expiresAt){this.choices=null;this.say('咱们接着来，你想找哪件？',serial);return;}
  if(intent.action==='select'){check(this.choices&&Number.isInteger(intent.index)&&this.choices.ids[intent.index],'invalid_choice');const choice=this.choices;this.choices=null;if(choice.kind==='appearance')return this.selectAppearance(choice,intent.index,serial);return await this.executeIntent({...choice.intent,objectId:choice.ids[intent.index]},choice.intent.action==='identify'?choice.snapshot:(choice.kind==='identity'?snapshot:choice.snapshot),serial,command.commandId);}
  return await this.executeIntent(intent,snapshot,serial,command.commandId,prepared);
  }catch(error){
   this.emit({type:'diagnostic',operation:'command',code:safeError(error)});
   if(serial!==this.serial||this.lastReplySerial===serial)return;
   const message=['fresh_frame_required','stale_frame'].includes(error.message)?'还没有新的画面，请先打开镜头。':error.message==='object_name_invalid'?'请告诉我要记住哪件物品，例如“水杯”或“手机”。':error.message==='invalid_choice'?'你指的是哪一件？':error.message==='memory_changed'?'这件物品刚刚有了新记录，请再试一次。':['describe','locate'].includes(intent?.action)?sceneRetryMessage:'这次还没处理好，请稍后再说一次。';
   this.say(message,serial);
  }finally{this.emit({type:'diagnostic',operation:'turn',serial,durationMs:Math.round(performance.now()-started)});}
 }
 resolve(intent,snapshot){
  check(['identify','find','history','check','appearance','update'].includes(intent.action),'historical_resolution_not_allowed');
  if(intent.objectId){const o=this.memory.get(intent.objectId);check(o,'object_missing');this.focus=o;return o;}
  let list=this.memory.matching(intent.target??'');
  if(!list.length&&intent.action==='identify'&&intent.referenceKind)list=this.memory.matching(intent.referenceKind);
  this.emit({type:'diagnostic',operation:'memory_lookup',code:list.length===1?'found':list.length?'ambiguous':'missing',serial:this.serial,matchCount:list.length});
  if(intent.action==='identify'&&list.length>1)return list;
  if(['find','history','check','appearance','update'].includes(intent.action)&&(list.length>1||list.length===1&&intent.action!=='identify'&&this.focus?.id!==list[0].id&&cleanObjectName(list[0].name).toLowerCase()!==cleanObjectName(intent.target).toLowerCase())){
   this.choices={kind:'identity',ids:list.map(o=>o.id),intent,snapshot,expiresAt:this.now()+120_000,excluded:[]};
   this.emitIdentityChoices();this.say(identityQuestion(list,intent.action));return undefined;
  }
  if(list.length===1){this.focus=list[0];return list[0];}
  return null;
 }
 freshSave(){const save=this.currentSave;return this.flow==='save'&&save&&save.sourceGeneration===this.source.generation&&this.now()-save.at>=0&&this.now()-save.at<=120_000&&this.memory.get(save.objectId)?save:null;}
 resolveCurrentSave(intent){
  if(intent.objectId){const object=this.memory.get(intent.objectId);check(object,'object_missing');return object;}
  if(intent.newIdentity)return null;
  const save=this.freshSave(),object=save?this.memory.get(save.objectId):null;
  // Only the already designated object in this same save interaction can be reused.
  // Matching old names/categories in the rest of the library is not a save prerequisite.
  return object&&matchingObjects([object],intent.target??'').length===1?object:null;
 }
 emitIdentityChoices(){const items=this.choices.ids.map(id=>this.memory.get(id)).filter(Boolean);this.emit({type:'choices',serial:this.serial,commandId:this.commandId,action:this.choices.intent.action,voiceOnly:true,items:items.map(o=>({id:o.id,name:o.name,detail:o.description??''}))});}
 async executeIntent(intent,snapshot,serial,commandId,prepared=null){
  if(intent.action==='update'){
   check(snapshot,'fresh_frame_required');
   const object=this.resolve(intent,snapshot);if(object===undefined)return;
   if(!object){this.say('没有找到要更新的物品记录，请说出保存时的名称，或说“记住”新增物品。',serial);return;}
   return this.executeIntent({action:'remember',target:object.name,objectId:object.id},snapshot,serial,commandId);
  }
  if(intent.action==='auto_remember'){
   if(!this.automatic)return;
   const controller=new AbortController();this.active.add(controller);
   try{await this.automatic.statement(intent,snapshot,AbortSignal.any([controller.signal,AbortSignal.timeout(12000)]),()=>!controller.signal.aborted&&serial===this.serial&&snapshot?.sourceGeneration===this.source.generation);}
   catch{this.automatic.log('statement_skipped');}finally{this.active.delete(controller);if(serial===this.serial)this.update();}return;
  }
  const action=intent.action;
  const stage=stageFor(action);if(stage){this.flow=stage;if(stage!=='save')this.currentSave=null;this.emit({type:'diagnostic',operation:'flow_entered',code:stage,serial});}
  if(action==='ask_target'){
   this.cancel(false);this.focus=null;this.lastTarget=null;this.flow=null;this.currentSave=null;
   this.choices={kind:'search_target',expiresAt:this.now()+120000};this.say('你想找什么物品？',serial);return;
  }
  if(action==='scan'){
   this.cancel(false);this.focus=null;this.flow='scene_search';this.currentSave=null;this.lastTarget=intent.target;
   this.task={mode:'scene',target:intent.target,serial,searchStartedAt:this.now()};this.state='SEARCHING';this.update();
   this.acknowledge('收到，找'+intent.target+'！',serial);void this.tick();return;
  }
  if(action==='cancel'){this.cancel();return;}
  if(action==='complete'){
   const feedback=intent.retrieved!==false?this.submitSearchFeedback(true):null;
   const taken=intent.retrieved!==false&&(feedback?this.memory.get(feedback.objectId):this.focus);
   if(taken&&!feedback?.retrieved){const eventId=this.memory.recordRetrieved(taken.id);if(feedback)feedback.retrieved=eventId;this.changed();}
   this.finishSearch(taken?'好，收工！':'好，先停这儿。');
   return;
  }
  if(action==='reject'||action==='continue'||action==='features'){
   const feedback=action==='reject'?this.submitSearchFeedback(false):null;
   this.pendingFeedback=null;
   if(feedback&&!this.task){const object=this.memory.get(feedback.objectId);return this.executeIntent({action:'find',target:object.name,objectId:object.id},snapshot,serial,commandId);}
   if(!this.task){if(action==='continue'&&(this.focus||this.lastTarget))return this.executeIntent({action:'find',target:this.focus?.name??this.lastTarget,objectId:this.focus?.id},snapshot,serial,commandId);this.say('请先说要找哪件物品。');return;}if(action==='reject'&&this.lastConfirmed)this.rejections.push({box:this.lastConfirmed.box,frameHash:this.lastConfirmed.frameHash,generation:this.source.generation,at:this.now()});
   const features=action==='features'?text(intent.description,120,false):this.task.features;this.generation++;this.task={...this.task,id:uuid(),matchEvidence:null,features,found:false,notices:new Set(),appearanceAnnounced:false,appearanceEvidence:null,generation:this.generation,searchStartedAt:this.now(),lastDetectionKey:null};this.abortWork();this.reviewing=false;this.lastConfirmed=null;this.state='SEARCHING';this.lastReview=0;this.cloudRequests=0;this.update();this.task.serial=serial;this.acknowledge(action==='reject'?'收到，我重新认。':'好，接着找。',serial);void this.tick();return;
  }
  if(action==='accept'){this.submitSearchFeedback(true);if(this.task?.found){this.state='COMPLETED';this.update('本轮已返回结果，等待你的下一条指令。');}this.say('好，认对啦。');return;}
  if(action==='describe'||action==='locate'){
   check(snapshot,'fresh_frame_required');this.cancel(false);this.focus=null;this.lastTarget=null;this.acknowledge('好，我看一下。',serial);this.update('正在看眼前的画面');const c=prepared?.controller??new AbortController();this.active.add(c);
   try{let r,observedFrame=snapshot;if(prepared){const cached=await prepared.promise;if(cached.result){r=cached.result;observedFrame=prepared.snapshot;this.emit({type:'diagnostic',operation:'speech_vision_reused',frameId:prepared.snapshot.frameId,durationMs:Math.round(this.now()-prepared.started)});}}
    if(!r&&!c.signal.aborted)r=action==='locate'?await this.locateScene(snapshot,intent,c.signal):await this.providers.describe(snapshot,null,intent.question??'眼前有什么',c.signal);
    if(!c.signal.aborted&&serial===this.serial){this.sceneDialogue.remember(observedFrame,r,action==='locate'?intent.target:null);this.say(r.answer?.trim()||(r.i?.length?'当前画面可以看到：'+r.i.join('、')+'。':'我还看不清，请把镜头稍微移近一些。'),serial);}
   }finally{this.active.delete(c);}return;
  }
  if(action==='remember'){
   check(snapshot,'fresh_frame_required');const target=text(intent.target,40,false);const object=this.resolveCurrentSave(intent);
   const prior=this.memory.all().find(o=>o.captures.some(c=>c.id===commandId));if(prior){this.focus=prior;this.say(this.memory.receipt(prior.id).message,serial);return;}
   this.cancel(false);const receipt=this.memory.capture(target,snapshot,{objectId:object?.id,captureId:commandId});this.currentSave={objectId:receipt.objectId,target,at:this.now(),sourceGeneration:this.source.generation};this.focus=this.memory.get(receipt.objectId);this.state='LEARNING';this.changed();this.update('正在记住'+target+'的样子和位置');this.acknowledge('我正在记'+target+'的样子，稍等一下。',serial);
   if(this.providers.singlePassMemory)return this.rememberObservation(receipt,snapshot,intent,serial);
   const controller=new AbortController();this.active.add(controller);this.memoryWork.set(controller,receipt);let saved=null,announced=false;
   try{
    // Both helpers see the command's frozen frame. Never substitute a later detection.
    let candidate=null,earlyResult=null;
    const earlyReview=(async()=>{
     const label=labelFor(target);if(!label||!this.detector?.ready)return null;
     const until=performance.now()+500;while(this.detector.busy&&performance.now()<until&&!controller.signal.aborted)await new Promise(r=>setTimeout(r,10));
     if(this.detector.busy||controller.signal.aborted)return null;
     const labels=detectionLabels(target,label);const detected=await this.detector.run(snapshot,{target:label,targets:labels});
     const found=detected.frameId===snapshot.frameId?(detected.detections??[]).filter(x=>labels.includes(x.label)&&x.score>=.5&&validBox(x.box)):[];
     if(found.length!==1||controller.signal.aborted)return null;
     const box=found[0].box,photo=await this.crop(snapshot,box);candidate={box,photo};
     if(controller.signal.aborted)return null;
     const result=await this.providers.review(snapshot,{target,memory:true,proposalBox:box,crop:photo.jpeg},controller.signal);
     earlyResult={box,photo,result};return earlyResult;
    })().catch(error=>{this.emit({type:'diagnostic',operation:'early_review',code:safeError(error)});return null;});
    let words=null;try{words=await this.providers.describe(snapshot,target,'描述并定位用户要记住的物品，说明其可见相对位置',controller.signal);}catch(error){this.emit({type:'diagnostic',operation:'memory_describe',code:safeError(error),frameId:snapshot.frameId});}
    if(controller.signal.aborted)return;
    const d=words?.v?words:null;
    const proposalBox=candidate?.box??(validBox(d?.b)?d.b:null);
    let proposedPhoto=candidate?.photo??null;if(proposalBox&&!proposedPhoto)try{proposedPhoto=await this.crop(snapshot,proposalBox);}catch{}
    if(controller.signal.aborted)return;
    const negative=r=>r&&(r.visible<=.1||r.clear<=.1||(typeof r.candidateMatch==='number'&&r.candidateMatch<=.1));
    // Durable observation is useful memory even when the independent check is uncertain.
    // The original scene is the reference when an isolated crop cannot be produced.
    if(d?.d&&d?.l&&!negative(earlyResult?.result)){
     saved=this.memory.finish(receipt,{appearance:proposedPhoto,description:d.d,suggestedLocation:d.l,failureKind:'REVIEW_PENDING'});
     this.changed();if(serial===this.serial){this.focus=this.memory.get(saved.objectId);this.state='IDLE';this.update();this.say(saved.message,serial);announced=true;}
    }
    const fast=await earlyReview;if(controller.signal.aborted)return;
    let r=fast?.result??null;
    let rejected=negative(r);
    if(!rejected&&(!r?.box||!r?.location))try{r=await this.providers.review(snapshot,{target,memory:true,description:d?.d??'',proposalBox:proposedPhoto?proposalBox:null,crop:proposedPhoto?.jpeg??null,proposalLocation:d?.l??'',proposalAnchor:d?.a??''},controller.signal);}catch(error){this.emit({type:'diagnostic',operation:'memory_review',code:safeError(error)});}
    let appearance=null,failureKind=r?.failureKind??'REVIEW_UNAVAILABLE';
    rejected=negative(r);
    if(r?.box){try{appearance=proposedPhoto&&r.box.every((v,i)=>Math.abs(v-proposalBox[i])<.00001)?proposedPhoto:await this.crop(snapshot,r.box);}catch{failureKind='CROP_UNAVAILABLE';}}
    if(controller.signal.aborted)return;let result;
    if(rejected)failureKind='REVIEW_REJECTED';else if(saved)failureKind=r?.box&&r?.location?'':r?'REVIEW_UNCERTAIN':'REVIEW_UNAVAILABLE';
    try{result=this.memory.finish(saved??receipt,{appearance:rejected?null:appearance,description:rejected?null:d?.d,suggestedLocation:d?.l,location:rejected?null:r?.location,failureKind,review:!!saved});}catch(error){if(appearance&&error.message!=='memory_changed')result=this.memory.finish(saved??receipt,{description:d?.d,suggestedLocation:d?.l,location:r?.location,failureKind:saved?'REVIEW_UNCERTAIN':'PHOTO_WRITE_FAILED',review:!!saved});else throw error;}
    if(intent.location){this.memory.addLocation(result.objectId,intent.location);result=this.memory.receipt(result.objectId);result.message+=' 另已记录你提供的位置：'+intent.location+'。';}
    this.changed();if(serial===this.serial){this.focus=this.memory.get(result.objectId);this.state='IDLE';this.update();if(!announced)this.say(result.message,serial);}return result;
   }catch(error){if(!controller.signal.aborted){try{this.memory.finish(saved??receipt,{failureKind:saved?'REVIEW_UNAVAILABLE':'ANALYSIS_FAILED',review:!!saved});this.changed();}catch{}this.emit({type:'diagnostic',operation:'memory',code:safeError(error)});if(!announced)this.say('这次没能记全'+target+'，请调整一下镜头再试一次。',serial);}}finally{this.active.delete(controller);this.memoryWork.delete(controller);}
   return;
  }
  if(action==='identify'&&!snapshot){this.say('请把镜头对准要核对的物品，再问我是不是之前那件。',serial);return;}
  if(!['identify','find','history','check','appearance','update'].includes(action)){this.say('请告诉我这次想观察、记住、查询还是寻找什么物品。',serial);return;}
  const object=this.resolve(intent,snapshot);if(object===undefined)return;
  if(['check','history','appearance'].includes(action)){
   if(!object){this.say('这件我还没记过。',serial);return;}
   this.say(action==='check'?this.memory.receipt(object.id).message:action==='history'?(object.description?'已保存的外观：'+object.description+'。':'')+this.memory.history(object.id):object.description?'已保存的外观描述是：'+object.description+'。':object.appearances.length?'已经保存了目标参考照片，尚无文字外观描述。':'还没有保存这件物品的目标外观照片。',serial);return;
  }
  if(action==='identify'){await this.identifyOnce(intent,object,snapshot,serial);return;}
  if(action==='find'){
   if(this.providers.localOnlyReview&&!object){this.searchDeadline=null;this.cancel(false);this.say('记忆里还没有找到“'+intent.target+'”的物品记录。请说出保存时的物品名，或先让我记住这件物品。',serial);return;}
   if(this.providers.localOnlyReview&&object&&!this.memory.photos(object).length){this.searchDeadline=null;this.cancel(false);this.focus=object;this.say(this.memory.receipt(object.id).message,serial);return;}
   const target=text(object?.name??intent.target,40,false);this.cancel(false);this.focus=object;this.rejections=[];this.lastReview=0;this.cloudRequests=0;this.lastTarget=target;this.task={id:uuid(),target,label:object?.yoloLabel??labelFor(object?.name??target),labels:detectionLabels(object?.name??target,object?.yoloLabel??labelFor(target)),objectId:object?.id??null,features:'',generation:this.generation,serial};this.state='SEARCHING';this.update();if(object&&!this.memory.references(object).length)this.say('我还没记清它的样子，先让我记一下吧。',serial);else this.acknowledge('收到，找'+target+'！',serial);void this.tick();return;
  }
  this.say('请再明确一下要进行的操作。',serial);
 }
 async identifyOnce(intent,object,frame,serial){
  if(!object){this.say('这件我还没记过。',serial);return;}
  const objects=Array.isArray(object)?object:[object];
  const references=objects.map(item=>({object:item,photos:this.memory.photos(item).slice(-3).reverse()}));
  const missingCount=references.filter(item=>!item.photos.length).length;
  if(missingCount)this.emit({type:'diagnostic',operation:'identify_references',code:'missing_photos',serial,matchCount:missingCount,referenceCount:references.length-missingCount});
  if(references.every(item=>!item.photos.length)){this.say('我还没记清它的样子，先让我记一下吧。',serial);return;}
  this.lastComparison={intent:{...intent},generation:frame.sourceGeneration,expiresAt:this.now()+120000};
  const controller=new AbortController();this.active.add(controller);
  const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(18000)]);
  let localizationFailure='target_unconfirmed';
  try{
   const name=intent.visibleTarget||intent.target;
   const subject=frame.comparisonSubject;
   const origin=subject?'刚才描述的':'提问时画面里的';
   let photo;
   if(subject?.confirmed){
    photo=subject.cropJpeg?{jpeg:Buffer.from(subject.cropJpeg,'base64')}:await this.crop(frame,subject.box);
   }else if(this.providers.targetLocator){
    const locate=observedBox=>this.providers.targetLocator.locate(frame,name,{signal,timeoutMs:7000,comparison:true,observedBox,onFailure:code=>{localizationFailure=code;this.emit({type:'diagnostic',operation:'identify_localization',code,frameId:frame.frameId,serial});}});
    photo=(await locate(subject?.box))?.photo;
    if(!photo&&!signal.aborted&&this.providers.locate&&!subject?.box){
     // Another view of the same frozen image can ground a small target. Only a
     // unique box independently checked against its cropped pixels is usable.
     const scene=await this.providers.locate(frame,{target:name,question:'只看这幅画面，定位'+name+'的本体；有多个无法区分时不要返回目标框。'},signal);
     if(scene.v&&validBox(scene.targetBox))photo=(await locate(scene.targetBox))?.photo;
    }
   }else{
    const observation=await this.providers.describe(frame,name,'只定位提问所指的物品，多件无法区分时返回不可确认。',signal);
    if(observation.v&&validBox(observation.b))photo=await this.crop(frame,observation.b);
   }
   if(serial!==this.serial||controller.signal.aborted)return;
   signal.throwIfAborted();
   if(!photo){
    this.choices={kind:'retry_identify',generation:frame.sourceGeneration,expiresAt:this.now()+120000,intent:{...intent,...(objects.length===1?{objectId:objects[0].id}:{})}};
    this.emit({type:'diagnostic',operation:'identify_target',code:localizationFailure,frameId:frame.frameId,serial});
    this.say(comparisonRetryMessage,serial);return;}
   const verdicts=[];
   for(const {object:item,photos} of references){
    if(!photos.length){verdicts.push({object:item,verdict:'MISSING_REFERENCE'});continue;}
    const result=await this.providers.review(frame,{oneShot:true,target:name,objectId:item.id,crop:photo.jpeg,references:photos.map(p=>this.memory.image(p.image)),referenceIds:photos.map(p=>p.image),candidates:[{box:[0,0,1,1],cropJpeg:photo.jpeg.toString('base64')}]},signal);
    if(serial!==this.serial||controller.signal.aborted||frame.sourceGeneration!==this.source.generation)return;
    signal.throwIfAborted();
    const rejectionThreshold=result.minBaseScore??appearanceConfig.minBaseScore;
    const threshold=Math.max(.65,rejectionThreshold);
    const candidate=result.selected??result.candidates?.[0];
    // One-shot acceptance uses base similarity, so select one whole pair by that score.
    const pairs=candidate?.referencePairs?.filter(pair=>Number.isFinite(pair.scores?.base))??[];
    const best=pairs.reduce((best,pair)=>!best||pair.scores.base>best.scores.base?pair:best,null);
    const selected=best?{...candidate,...best}:candidate;
    const score=selected?.scores?.base;
    let verdict=result.decision;
    if(['LIKELY_MATCH','NO_MATCH'].includes(result.status)&&Number.isFinite(score)){
     verdict=score>=threshold?'CONFIRM':score<rejectionThreshold?'REJECT':'UNCERTAIN';
     if(objects.length===1)this.publishAppearance({...result,selected,minBaseScore:threshold,frameId:frame.frameId},serial,verdict==='CONFIRM'?'LIKELY_MATCH':verdict==='REJECT'?'NO_MATCH':'RECHECKING');
    }
    verdicts.push({object:item,verdict:result.status==='MODEL_ERROR'?'UNCERTAIN':verdict});
   }
   if(serial!==this.serial||controller.signal.aborted||frame.sourceGeneration!==this.source.generation)return;
   if(objects.some(item=>this.memory.get(item.id)?.updatedAtMs!==item.updatedAtMs)){
    this.say('记录刚更新，咱们再核对一次。',serial);return;
   }
   const matches=verdicts.filter(item=>item.verdict==='CONFIRM');
   const missingReference=verdicts.some(item=>item.verdict==='MISSING_REFERENCE');
   const uncertain=verdicts.some(item=>!['CONFIRM','REJECT','MISSING_REFERENCE'].includes(item.verdict));
   let answer='还没认准，靠近一点让我看看。';
   if(matches.length===1&&!uncertain){
    this.focus=matches[0].object;
    answer='是，看起来是之前记住的“'+matches[0].object.name+'”。'+origin+'这件物品与它的参考照片外观相符。';
   }else if(matches.length===0&&!uncertain&&missingReference){
    answer='与已有参考照片的记录相比，'+origin+'这件物品外观不相符。';
   }else if(matches.length===0&&!uncertain){
    answer='不是，'+origin+'这件物品与'+(objects.length===1?'记忆库里“'+objects[0].name+'”的参考照片':'这些已保存的同类物品参考照片')+'外观不相符。';
   }else if(matches.length>1){
    answer='这几件太像了，靠近些，让我看看特别的地方。';
   }
   if(intent.correction&&matches.length)answer='还是很像，靠近些，再说“核对现在这件”。';
   this.say(answer,serial);
  }catch(error){
   this.emit({type:'diagnostic',operation:'identify',code:safeError(error),frameId:frame.frameId,serial});
   if(serial===this.serial&&!controller.signal.aborted)this.say(comparisonRetryMessage,serial);
  }
  finally{this.active.delete(controller);}
 }
 async rememberObservation(receipt,snapshot,intent,serial) {
  const controller=new AbortController();this.active.add(controller);this.memoryWork.set(controller,receipt);
  const started=performance.now();
  try {
   const localized=this.providers.targetLocator?await this.providers.targetLocator.locate(snapshot,intent.target,{signal:controller.signal,timeoutMs:8000}):null;
   const d=localized??await this.providers.describe(snapshot,intent.target,'描述并定位用户要记住的物品，说明其可见相对位置',controller.signal);
   if(controller.signal.aborted)return;
   let appearance=localized?.photo??null;
   if(!this.providers.targetLocator&&d.v&&validBox(d.b))try{appearance=await this.crop(snapshot,d.b);}catch(error){this.emit({type:'diagnostic',operation:'memory_crop',code:safeError(error)});}
   if(controller.signal.aborted)return;
   // A single Omni observation is not an independent verification. Keep existing
   // v2 provenance semantics so old tablets and backups can read these records.
   let result=this.memory.finish(receipt,{appearance,name:d.v?d.n:null,description:d.v?d.d:null,suggestedLocation:d.v?d.l:null,failureKind:d.v?'REVIEW_UNCERTAIN':'TARGET_UNCERTAIN'});
   if(intent.location){this.memory.addLocation(result.objectId,intent.location);result=this.memory.receipt(result.objectId);}
   this.emit({type:'diagnostic',operation:'memory_saved',serial,code:result.referenceReady?'reference_ready':d.v?'text_only':'scene_only',referenceCount:this.memory.photos(this.memory.get(result.objectId)).length});
   this.changed();
   if(serial===this.serial){this.focus=this.memory.get(result.objectId);this.state='IDLE';this.update();this.say(result.message,serial);}
   return result;
  } catch(error) {
   if(!controller.signal.aborted){
    try{this.memory.finish(receipt,{failureKind:'ANALYSIS_FAILED'});this.changed();}catch{}
    this.emit({type:'diagnostic',operation:'omni_memory',code:safeError(error)});
    if(serial===this.serial){this.state='IDLE';this.update();this.say('照片收到了，样子和位置还得再认一认。',serial);}
   }
  } finally {this.active.delete(controller);this.memoryWork.delete(controller);this.emit({type:'diagnostic',operation:'omni_memory',frameId:snapshot.frameId,durationMs:Math.round(performance.now()-started)});}
 }
 finishSearch(message){
  this.lastComparison=null;
  this.searchDeadline=null;
  this.intentController?.abort();
  this.serial++;
  this.flow=null;this.currentSave=null;this.focus=null;this.lastTarget=null;
  this.rejections=[];this.sceneDialogue.clear();
  this.cancel(false);
  this.emit({type:'speech.clear',serial:this.serial,commandId:this.commandId});
  this.state='COMPLETED';this.update(message);this.say(message);
 }
 expireSearch(){
  if(this.searchDeadline===null||this.now()<this.searchDeadline)return false;
  this.finishSearch('这轮先停这儿，想找时再叫我。');
  return true;
 }
 async tick(){
  if(this.expireSearch())return;
  if(this.state==='LEARNING'||this.task?.found)return;
  if(this.task&&['SEARCHING','VERIFYING'].includes(this.state)&&this.choices?.kind!=='appearance'){
   this.task.searchStartedAt??=this.now();
   if(this.now()-this.task.searchStartedAt>=this.searchTimeoutMs&&this.task.mode==='scene'){
    const target=this.task.target;this.cancel(false);this.say('这轮还没看到'+target+'。你可以移动镜头，再说“继续找”。');return;
   }
   if(this.now()-this.task.searchStartedAt>=this.searchTimeoutMs){const target=this.task.target,serial=this.task.serial;this.cancel(false);if(this.providers.backend==='appearance_mvp')this.publishAppearance({status:'SEARCH_ENDED',durationMs:0},serial);this.emit({type:'diagnostic',operation:'search_paused',serial,code:'search_timeout'});this.say('这轮还没找到'+target+'。想再找就说“继续”。',serial);return;}
  }
   const frame=this.source.fresh();
  if(this.task?.mode==='scene'){
   const task=this.task;
   if(!frame||task.checking||frame.frameId===task.frameId||this.now()<(task.nextCheck??0))return;
   task.checking=true;task.frameId=frame.frameId;
   const controller=new AbortController();this.active.add(controller);
   try{
    const question='当前画面有没有'+task.target+'？看到就说明具体位置。';
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(8000)]);
    const seen=await this.locateScene(frame,{target:task.target,question},signal);
    if(signal.aborted||this.task!==task)return;
    if(seen.v===true&&seen.answer?.trim()){
     task.found=true;this.state='COMPLETED';this.sceneDialogue.remember(frame,seen,task.target);
     this.say(seen.answer,task.serial);this.update();
    }else if(!task.notified){task.notified=true;this.say('这次画面里还没看清'+task.target+'，我会继续看。',task.serial,'progress');}
   }catch(error){
    if(!controller.signal.aborted&&this.task===task){
     this.emit({type:'diagnostic',operation:'scene_search',code:safeError(error)});
     if(!task.warned){task.warned=true;this.say('这次画面分析没有完成，我会用下一幅画面再试。',task.serial,'progress');}
    }
   }
   finally{this.active.delete(controller);task.checking=false;task.nextCheck=this.now()+1500;}
   return;
  }
  if(!frame||!this.detector?.ready||this.detector.busy)return;
  const key=`${frame.sourceGeneration}:${frame.frameId}`;
  const cached=this.lastAnalyzed?.key===key?this.lastAnalyzed:null;
  if(cached&&(!this.task||this.task.lastDetectionKey===key))return;
  this.lastFrameKey=key;
  const generation=this.generation;
  try{const result=cached??await this.detector.run(frame,{target:this.task?.label,targets:this.task?.labels,objectTarget:this.task?.target});if(frame.sourceGeneration!==this.source.generation||generation!==this.generation||this.task?.found)return;
   const task=this.task;
   if(task)task.lastDetectionKey=key;
   this.reviewTrack?.update(frame,result,this.now());
   this.lastAnalyzed={...result,key,at:cached?.at??this.now()};this.emit({type:'detections',clientFrameId:frame.clientFrameId,frameId:frame.frameId,inferenceMs:result.inferenceMs,detections:result.reportedDetections??result.detections});
   if(!task&&this.automatic&&!this.autoWorking&&!this.choices&&!this.active.size){
    this.autoWorking=true;const serial=this.serial,controller=new AbortController();this.active.add(controller);
    void this.automatic.observe(frame,result.candidates??[],AbortSignal.any([controller.signal,AbortSignal.timeout(7000)]),()=>!controller.signal.aborted&&serial===this.serial&&frame.sourceGeneration===this.source.generation)
     .catch(()=>this.automatic.log('observation_skipped')).finally(()=>{this.active.delete(controller);this.autoWorking=false;});
   }
   if(!task||task.serial!==this.serial||this.task!==task||task.found||this.choices?.kind==='appearance'||this.reviewing||this.now()-this.lastReview<(this.providers.localOnlyReview?600:3000))return;
   const object=task.objectId?this.memory.get(task.objectId):null;
   const eligibleCandidates=(result.candidates??[]).filter(c=>(!task.labels?.length||task.labels.includes(c.label))&&validBox(c.box)&&!this.rejections.some(r=>r.generation===frame.sourceGeneration&&this.now()-r.at<30000&&overlap(r.box,c.box)>.65));
   const candidates=this.providers.backend==='appearance_mvp'?eligibleCandidates.slice(0,8):rankCandidates(eligibleCandidates,object?this.memory.photos(object):[]);
   const candidate=candidates[0]??null;if(!candidate&&task.label){this.searchNotice(task,'no_candidate','还没看到'+task.target+'，慢慢挪一下镜头。');}if(!candidate&&this.now()-this.lastReview<6000)return;
   if(this.cloudRequests>=60)return;
   if(this.providers.localOnlyReview&&!candidate&&this.providers.backend!=='appearance_mvp')return;
   if(this.providers.localOnlyReview&&!object){if(this.providers.backend==='appearance_mvp')this.emit({type:'experiment.match',provider:'appearance_mvp',serial:this.serial,status:'NO_REFERENCE',durationMs:0});this.searchNotice(task,'no_reference','我还没记清它的样子，先让我记一下吧。');return;}
   const references=object?(this.providers.localOnlyReview?this.memory.photos(object):this.memory.references(object)):[];
   if(task.objectId&&!references.length){if(this.providers.backend==='appearance_mvp')this.emit({type:'experiment.match',provider:'appearance_mvp',serial:this.serial,status:'NO_REFERENCE',durationMs:0});this.searchNotice(task,'no_reference','有文字记录，再让我记一下它的样子吧。');return;}
   this.lastReview=this.now();this.reviewing=true;this.cloudRequests++;void this.verify(frame,candidate,task,this.providers.localOnlyReview?candidates:null).finally(()=>{if(this.task===task)this.reviewing=false;});
  }catch(error){this.emit({type:'diagnostic',code:safeError(error)});}
 }
 searchNotice(task,code,message){if(this.task!==task)return;task.notices??=new Set();if(task.notices.has(code))return;task.notices.add(code);this.say(message,this.serial,['no_candidate','expired','candidate_changed','track_lost','rejected'].includes(code)?'progress':'result');}
 publishAppearance(result,serial,status=result.status,code=null){
  const {requestId,...value}=result;
  this.emit({...value,type:'experiment.match',provider:'appearance_mvp',serial,commandId:this.commandId,status,minBaseScore:result.minBaseScore??appearanceConfig.minBaseScore,...(code?{code}:{})});
  const scores=result.selected?.scores??result.candidates?.[0]?.scores;
  this.emit({type:'diagnostic',operation:'appearance_decision',serial,frameId:result.frameId,status,durationMs:result.durationMs,minBaseScore:result.minBaseScore??appearanceConfig.minBaseScore,candidateCount:result.candidates?.length,baseScore:scores?.base,appearanceScore:scores?.appearance,colorScore:scores?.color,ratioScore:scores?.ratio,totalScore:scores?.total,...(code?{code}:{})});
 }
 appearanceCurrent(frame,candidate){
  const current=this.source.fresh(),analyzed=this.lastAnalyzed;
  if(!current||current.sourceGeneration!==frame.sourceGeneration||!analyzed||this.now()-analyzed.at>1500)return null;
  if(!candidate)return this.now()-frame.receivedAtMs<=3000?true:null;
  const matches=analyzed.detections.filter(d=>d.label===candidate.label&&Number.isSafeInteger(candidate.trackId)&&d.trackId===candidate.trackId);
  if(matches.length===1&&!analyzed.detections.some(d=>d!==matches[0]&&d.label===candidate.label&&overlap(d.box,matches[0].box)>.25))return matches[0].box;
  // Some injected/legacy detectors lack track IDs: only the original fresh frame is safe.
  if(!Number.isSafeInteger(candidate.trackId)&&this.now()-frame.receivedAtMs<=1500&&analyzed.frameId===frame.frameId&&analyzed.detections.some(d=>d.label===candidate.label&&overlap(d.box,candidate.box)>.8))return candidate.box;
  return null;
 }
 async finishFound(task,result,prefix,serial,observation=null){
  if(this.task!==task||serial!==this.serial||task.found)return;
  // Stop comparison immediately, even while the bounded landmark lookup runs.
  task.found=true;task.searchStartedAt=null;this.lastConfirmed={...result,at:this.now()};
  this.choices=null;this.reviewing=false;this.reviewTrack=null;this.state='COMPLETED';this.clearAcknowledgement();
  let detail=null;const frame=observation?.frame,box=observation?.box??result.box;
  if(frame&&validBox(box)){
   this.lastConfirmed.observation={target:task.target,frame,box,cropJpeg:observation?.cropJpeg,confirmed:true};
  }
  if(frame&&this.providers.describeFoundLocation){
   const controller=new AbortController();this.active.add(controller);const started=performance.now();let timer;
   this.update('已发现外观相符的物品，正在补充附近参照。');
   try{
    const timeout=new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(null);},3200);});
    const analyzed=this.lastAnalyzed;
    const nearbyDetections=analyzed?.key===frame.sourceGeneration+':'+frame.frameId?(analyzed.reportedDetections??analyzed.detections):[];
    detail=await Promise.race([this.providers.describeFoundLocation(frame,box,controller.signal,nearbyDetections),timeout]);
   }catch(error){if(!controller.signal.aborted)this.emit({type:'diagnostic',operation:'found_location',code:safeError(error),serial});}
   finally{clearTimeout(timer);this.active.delete(controller);this.emit({type:'diagnostic',operation:'found_location',code:detail?'described':'region_only',serial,durationMs:Math.round(performance.now()-started)});}
   if(controller.signal.aborted&&serial!==this.serial)return;
  }
  if(this.task!==task||serial!==this.serial||this.flow!=='compare')return;
  const object=task.objectId?this.memory.get(task.objectId):null;
  const evidence=task.matchEvidence;
  if(object&&task.id&&(!evidence||evidence.referenceVersion===this.memory.referenceVersion(object))){
   this.pendingFeedback={...evidence,taskId:task.id,objectId:object.id,referenceVersion:this.memory.referenceVersion(object),generation:this.source.generation,expiresAt:this.now()+120000};
   if(this.memory.searchProfile(object).familiar)prefix='匹配到'+task.target+'，';
  }
  this.say(prefix+locationWords(box,detail,{snapshot:!!frame&&!!this.providers.describeFoundLocation}),serial);
  this.update('本轮已找到外观相符的物品，等待你的下一条指令。');
 }
 confirmAppearance(task,candidate,box,serial,selected=false,frame=null){
  const prefix=selected?(task.voiceDescriptor?'好，就找你确认的这件：'+task.voiceDescriptor.replace(/[。！？!?]+$/,'')+'。它':'好，就找你确认的这件物品，'):'发现一件外观相符的'+task.target+'，';
  return this.finishFound(task,{box,trackId:candidate.trackId??null,label:candidate.label,source:candidate.source},prefix,serial,frame?{frame,box:candidate.box,cropJpeg:candidate.cropJpeg}:null);
 }
 async handleAppearance(result,frame,task,batch,serial){
  if(task.found)return;
  const status=result.status;
  const publish=(finalStatus=status,code=null)=>this.publishAppearance({...result,frameId:frame.frameId},serial,finalStatus,code);
  if(['NO_REFERENCE','MODEL_ERROR','STALE_FRAME'].includes(status)){
   publish();
   const words={NO_REFERENCE:'我还没记清它的样子，先让我记一下吧。',MODEL_ERROR:'这次没认出来，稍等一下再试。',STALE_FRAME:'刚才没跟上，我再看看。'};
   this.searchNotice(task,status,words[status]);return;
  }
  if(this.now()-frame.receivedAtMs>3000||!this.appearanceCurrent(frame,null)){
   publish('STALE_FRAME','frame_expired');this.searchNotice(task,'expired','刚才没跟上，我再看看。');return;
  }
  if(status==='NO_MATCH'){task.appearanceEvidence=null;publish(status,result.candidates?.length?'below_threshold':'no_candidate');this.searchNotice(task,task.appearanceAnnounced?'reconfirming':'no_match',task.appearanceAnnounced?'刚才没看清，我再看看。':'还没认出你的'+task.target+'，我再看看。');return;}
  const chosen=result.selected,candidate=batch[chosen?.candidateIndex];
  check(candidate&&validBox(chosen.box)&&chosen.box.every((v,i)=>Math.abs(v-candidate.box[i])<1e-6),'appearance_candidate_invalid');
  const box=this.appearanceCurrent(frame,candidate);
  if(!box){publish('STALE_FRAME','candidate_changed');this.searchNotice(task,'candidate_changed','刚才那件出画面了，我再找找。');return;}
  if(status==='AMBIGUOUS'){
   const candidates=result.choices.map(c=>batch[c.candidateIndex]);check(candidates.length>=2&&candidates.every(Boolean),'appearance_choices_invalid');
   publish();
   if(task.voiceQuestionFailedAt&&this.now()-task.voiceQuestionFailedAt<6000)return;
   this.state='SEARCHING';this.update('正在看清候选物品的外观');
   this.choices={kind:'appearance',ids:candidates.map((c,i)=>'appearance-'+i),candidates,frame,task,paths:this.memory.searchPhotos(this.memory.get(task.objectId)).map(p=>p.image),descriptors:[],cursor:0,expiresAt:this.now()+120_000,questionReady:false};
   await this.askAppearance(this.choices,serial);return;
  }
  check(status==='LIKELY_MATCH','appearance_status_invalid');
  const saved=task.objectId?this.memory.get(task.objectId):null;
  const corrected=saved&&this.memory.searchProfile(saved).recheck;
  if(chosen.scores?.base<.65||corrected){
   const previous=task.appearanceEvidence;
   const repeated=previous&&previous.frameId!==frame.frameId&&this.now()-previous.at<=4000&&previous.trackId===candidate.trackId&&previous.label===candidate.label&&overlap(previous.box,box)>.35;
   task.appearanceEvidence={trackId:candidate.trackId,label:candidate.label,box,frameId:frame.frameId,at:this.now()};
   if(!repeated){publish('RECHECKING',corrected?'confirming_after_correction':'confirming_low_score');this.update('已发现相似候选，正在连续核对。');return;}
  }
  publish();await this.confirmAppearance(task,candidate,box,serial,false,frame);
 }
 async askAppearance(choice,serial){
  const controller=new AbortController();this.active.add(controller);
  choice.questionReady=false;
  try{
   const candidate=choice.candidates[choice.cursor];
   const descriptor=choice.descriptors[choice.cursor]??await this.providers.describeCandidate?.(choice.frame,candidate,controller.signal);
   if(controller.signal.aborted||serial!==this.serial||this.choices!==choice)return;
   if(!descriptor||!this.appearanceCurrent(choice.frame,candidate)){
    choice.task.voiceQuestionFailedAt=this.now();this.choices=null;this.state='SEARCHING';this.update('需要看清物品特征');
    this.searchNotice(choice.task,'voice_details_unavailable','细节还没看清，让它完整入镜吧。');return;
   }
   choice.descriptors[choice.cursor]=descriptor;choice.questionReady=true;choice.expiresAt=this.now()+120_000;
   this.emit({type:'choices',serial,commandId:this.commandId,action:'find',voiceOnly:true,items:[{id:choice.ids[choice.cursor],name:descriptor.description,detail:'请直接用语音回答，无需操作屏幕'}]});
   this.say(visibleQuestion(descriptor),serial);
  }catch(error){
   if(!controller.signal.aborted&&serial===this.serial&&this.choices===choice){
    choice.task.voiceQuestionFailedAt=this.now();this.choices=null;this.state='SEARCHING';this.update('需要看清物品特征');
    this.searchNotice(choice.task,'voice_details_unavailable','细节还没看清，慢慢挪一下镜头。');
    this.emit({type:'diagnostic',operation:'candidate_description',code:safeError(error)});
   }
  }finally{this.active.delete(controller);}
 }
 async answerAppearance(intent,serial){
  const choice=this.choices;
  if(!choice||choice.kind!=='appearance')return;
  if(this.now()>choice.expiresAt){this.choices=null;this.say('咱们接着来，你想找哪件？',serial);return;}
  choice.task={...choice.task,serial,generation:this.generation,lastDetectionKey:null};this.task=choice.task;this.state='SEARCHING';
  if(intent.mode==='confirm'){
   if(!choice.questionReady){this.say('我还没看清物品特征，请稍微调整镜头后再让我看一下。',serial);this.choices=null;return;}
   this.choices=null;return this.selectAppearance(choice,choice.cursor,serial);
  }
  if(intent.mode==='feature'){
   const matches=featureMatch(intent.description,choice.descriptors).filter(index=>index>=choice.cursor);
   const remainingKnown=choice.candidates.slice(choice.cursor).every((_,index)=>!!choice.descriptors[choice.cursor+index]);
   if(!intent.rejectCurrent&&remainingKnown&&choice.questionReady&&matches.length===1&&matches[0]===choice.cursor){this.choices=null;return this.selectAppearance(choice,matches[0],serial);}
   if((intent.rejectCurrent||!matches.includes(choice.cursor))&&choice.questionReady&&choice.cursor+1<choice.candidates.length){
    this.rejections.push({box:choice.candidates[choice.cursor].box,generation:choice.frame.sourceGeneration,at:this.now()});
    choice.cursor++;await this.askAppearance(choice,serial);return;
   }
   this.emit({type:'choices',serial,commandId:this.commandId,action:'find',voiceOnly:true,items:[{id:choice.ids[choice.cursor],name:choice.descriptors[choice.cursor]?.description??'待确认物品',detail:'请用外观特征回答'}]});
   this.say('我还不能把你说的特征和当前候选对应起来。'+(choice.descriptors[choice.cursor]?'刚才看清的是：'+choice.descriptors[choice.cursor].description+'。这是你要找的吗？':'请调整镜头，让我再看清一些。'),serial);return;
  }
  if(intent.mode==='reject'||intent.mode==='reject_all'){
   const rejected=intent.mode==='reject_all'?choice.candidates:[choice.candidates[choice.cursor]];
   for(const candidate of rejected)this.rejections.push({box:candidate.box,generation:choice.frame.sourceGeneration,at:this.now()});
   choice.cursor=intent.mode==='reject_all'?choice.candidates.length:choice.cursor+1;
   if(choice.cursor>=choice.candidates.length){this.choices=null;this.task.searchStartedAt=this.now();this.lastReview=0;this.update('继续寻找其他候选');this.say('这几件都对不上，我继续找。',serial);return;}
   await this.askAppearance(choice,serial);return;
  }
  if(choice.questionReady){
   this.emit({type:'choices',serial,commandId:this.commandId,action:'find',voiceOnly:true,items:[{id:choice.ids[choice.cursor],name:choice.descriptors[choice.cursor].description,detail:'请直接回答是的或不是'}]});
   this.say(visibleQuestion(choice.descriptors[choice.cursor]),serial);
  }else await this.askAppearance(choice,serial);
 }
 selectAppearance(choice,index,serial){
  const candidate=choice.candidates[index],object=this.memory.get(choice.task.objectId);
  check(object&&JSON.stringify(this.memory.searchPhotos(object).map(p=>p.image))===JSON.stringify(choice.paths),'memory_changed');
  const box=this.appearanceCurrent(choice.frame,candidate);
  if(!box){this.emit({type:'experiment.match',provider:'appearance_mvp',serial,status:'STALE_FRAME',durationMs:0});this.say('刚才的候选画面已失效，请保持镜头稳定，再说一次“帮我找'+choice.task.target+'”。',serial);return;}
  const task={...choice.task,serial,generation:this.generation,voiceDescriptor:choice.descriptors?.[index]?.description};this.task=task;this.focus=object;return this.confirmAppearance(task,candidate,box,serial,true,choice.frame);
 }
 async verify(frame,candidate,task,candidateBatch=null){
  const c=new AbortController();this.active.add(c);const serial=this.serial,generation=task.generation,started=performance.now();this.state='VERIFYING';this.update();
  const track=this.providers.trackCandidates?new CandidateContinuity(candidate,frame,this.now()):null;this.reviewTrack=track;
  try{const object=task.objectId?this.memory.get(task.objectId):null;const getPaths=()=>{const o=task.objectId?this.memory.get(task.objectId):null;return o?(this.providers.localOnlyReview?this.memory.searchPhotos(o).map(p=>p.image):this.memory.references(o)):[];};const paths=getPaths(),refs=paths.map(path=>this.memory.image(path));const r=await this.providers.review(frame,{target:task.target,...(this.providers.backend==='appearance_mvp'?{}:{description:object?.description??'',features:task.features}),objectId:task.objectId,serial,referenceIds:paths,referencesCurrent:()=>JSON.stringify(getPaths())===JSON.stringify(paths),crop:candidate?Buffer.from(candidate.cropJpeg,'base64'):null,candidates:candidateBatch??undefined,references:refs},c.signal);
   if(c.signal.aborted||this.task!==task||this.generation!==generation||serial!==this.serial||task.found)return;
   task.matchEvidence=object?{referenceVersion:this.memory.referenceVersion(object),referenceId:paths.includes(r.selected?.referenceId)?r.selected.referenceId:null,score:r.selected?.scores?.base,durationMs:Math.round(performance.now()-started),frameId:frame.frameId}:null;
   if(this.providers.backend==='appearance_mvp'){await this.handleAppearance(r,frame,task,candidateBatch??[],serial);return;}
   if(candidateBatch&&this.providers.backend!=='appearance_mvp'){check(Number.isInteger(r.candidateIndex)&&!!candidateBatch[r.candidateIndex],'xfeat_candidate_invalid');candidate=candidateBatch[r.candidateIndex];}
   this.emit({type:'diagnostic',operation:'review_decision',serial,frameId:frame.frameId,decision:r.decision,provider:r.provider??'unknown',durationMs:Math.round(performance.now()-started)});
   const current=this.source.fresh(),tracked=track?.current(this.now());if(!current||current.sourceGeneration!==frame.sourceGeneration||(this.now()-frame.receivedAtMs>3000&&!tracked)){this.emit({type:'diagnostic',operation:'find_review',code:'review_frame_expired',frameId:frame.frameId,durationMs:Math.round(performance.now()-started)});this.searchNotice(task,'expired',r.decision==='CONFIRM'?'刚才的画面中看到了与参考相符的'+task.target+'，但结果返回时画面已过期，正在继续确认当前位置。':'这次对比返回时画面已过期，正在继续寻找'+task.target+'。');return;}
   if(candidate&&!tracked&&(!this.lastAnalyzed||this.now()-this.lastAnalyzed.at>1500||!this.lastAnalyzed.detections.some(d=>(task.labels?.includes(d.label)||d.label===candidate.label)&&overlap(d.box,candidate.box)>.5))){this.emit({type:'diagnostic',operation:'find_review',code:'candidate_changed',frameId:frame.frameId});this.searchNotice(task,'candidate_changed','候选已离开刚才的位置，继续寻找'+task.target+'。');return;}
   if(track&&Number.isSafeInteger(track.id)&&!track.valid){this.searchNotice(task,'track_lost','刚才没跟上，我再看看。');return;}
   if(r.decision==='REJECT'&&candidate){this.rejections.push({box:candidate.box,frameHash:hash(frame.jpeg),generation:frame.sourceGeneration,at:this.now()});this.searchNotice(task,'rejected','这件对不上，我再找找。');}
   if(r.decision==='UNCERTAIN'){
    const box=tracked??candidate?.box,center=box?(box[0]+box[2])/2:null;
    const zone=center===null?'':center<1/3?'左侧':center>2/3?'右侧':'中央';
    const message=r.visible===true&&r.clear===true?'画面'+zone+'能看到'+task.target+'，但暂时不能确认是否是你记录的那件。':r.visible===false?'这次画面中还没有确认看到'+task.target+'，我会继续查找。':r.visible===true?'看到了疑似'+task.target+'，但细节还不清楚，暂时无法确认。':'看到了相近的候选，但还不能确认是'+task.target+'。请保持镜头稳定或稍微靠近。';
    this.searchNotice(task,'uncertain',message);
   }
   if(r.decision==='CONFIRM'){
    const currentBox=tracked??candidate?.box;
    await this.finishFound(task,{box:currentBox??[0,0,1,1],trackId:candidate?.trackId??null,label:candidate?.label??task.label,frameHash:hash(frame.jpeg)},'发现'+(object?'与你保存的参考相符的':'一件')+task.target+'，',serial,currentBox?{frame,box:candidate?.box??currentBox}:null);
   }
  }catch(error){this.emit({type:'diagnostic',operation:'find_review',code:safeError(error),frameId:frame.frameId,durationMs:Math.round(performance.now()-started)});if(!c.signal.aborted&&serial===this.serial)this.searchNotice(task,'review_failed','刚才没认清，我再试试。');}finally{if(this.reviewTrack===track)this.reviewTrack=null;this.active.delete(c);if(this.task===task&&this.state==='VERIFYING'){this.state='SEARCHING';this.update();}}
 }
}
