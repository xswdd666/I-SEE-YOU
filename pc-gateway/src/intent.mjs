import {text} from './util.mjs';
import {cleanObjectName,validObjectName} from './object-names.mjs';
function rememberIntent(s,target){
 const newIdentity=/另(?:一)?[件个只]|新增|新的一件|再记住一/.test(s);
 // Speech transcripts can contain a camera-adjustment clause before the actual
 // command. Start at an explicit imperative, never a historical “让我记住的”.
 const start=/(?:^|[，,。！？!?])\s*(?:(?:嗯+|哦+|好的?|那|然后|请|你|帮我|替我|给我|再|重新|再次|现在)\s*)*(?=(?:记住|记录|保存|记一下|记下))/.exec(s);
 const clean=start?s.slice(start.index+start[0].length):s.replace(/^现在/,'').replace(/^(?:(?:请|帮我|再|重新|再次))+/,'');
 let m=/^(?:记住|记录)(.{1,40}?)(?:[，,]\s*(?:它|这[个件只])?|它)?(?:现在)?(?:的位置是|的位置在|放在|在)(.{1,600})$/.exec(clean);
 if(m&&!/可能|应该|好像|也许|大概|不确定/.test(s)&&!/^(?:哪里|哪儿|什么地方|什么位置)$/.test(m[2]))return {action:'remember',target:target(m[1]),location:m[2],newIdentity};
 m=/^(?:记住|记录|保存|记一下|记下)(.{1,60}?)(?:的外观和位置|的样子和位置|外观和位置|的外观|的样子|的位置)?$/.exec(clean);
 if(m)return {action:'remember',target:target(m[1]),newIdentity};
 m=/^(?:把)?(.{1,40}?)(?:也)?(?:记住|保存下来|保存一下|记下来|存下来|存一下|记一下)$/.exec(clean);
 if(m)return {action:'remember',target:target(m[1]),newIdentity};
 return null;
}
// Short acknowledgements like “行了” only end an open search. Match the whole
// utterance so a question, correction or second request keeps its own meaning.
export function spokenSearchEnd(raw,focus,searchOpen=false){
 if(/[？?]/.test(raw))return null;
 const words=raw.trim().replace(/[，,。.!！、\\s]/g,'')
  .replace(/^(?:(?:嗯+|哦+|好嘞|好的|好啦|那就|那))+/,'')
  .replace(/(?:谢谢你了|谢谢你|谢谢|谢啦|辛苦了)+$/,'');
 const end=(retrieved=false)=>({action:'complete',retrieved});
 const stop=/^(?:(?:我|我们|你)?(?:就|先)?(?:不找了|(?:不用|不需要)(?:再|继续)?(?:帮我)?找了?|别(?:再|继续)?找了?|不要(?:再|继续)?找了?)|(?:结束|停止|取消)(?:本次|这次|当前)?(?:找物任务|寻找任务|找物|寻找|搜索|任务)|(?:算了|先这样|就这样|到这儿|到这里|停下|结束吧|行了|好了|可以了|不用了))(?:吧|啊|呀|啦)?$/;
 const filler=/^(?:行了|好了|可以了|好啦|算了|好|行)/;
 const plain=words.replace(filler,'');
 if(searchOpen&&(stop.test(words)||stop.test(plain)))return end();
 const result=words.replace(filler,'').replace(/(?:不用(?:再)?找了|别找了)$/,'')
  .replace(/^(?:我这边|我)?(?:已经|总算|终于|刚刚|刚才|刚)?/,'').replace(/(?:啊|呀|哈|哦|喽|哟)$/,'');
 const names=[focus,'它','这个','这件',...(searchOpen?['东西','那东西','这个东西','我要的东西']:[])].filter(Boolean);
 function reports(verbs){
  return verbs.some(verb=>['了','啦','咯','喽'].some(suffix=>
   result===verb+suffix||names.some(name=>result===verb+name+suffix||
    result===verb+suffix+name||result===name+verb+suffix)));
 }
 if(reports(['拿到','取到',...(searchOpen?['拿在手里','拿到手','拿到手里']:[])])||/^(?:我)?(?:已经)?(?:拿到|取到)$/.test(words))return end(true);
 if(reports(['找到','找着',...(searchOpen?['摸到','看见','看到','找见','找回来']:[])])||/^(?:我)?已经找到$/.test(words))return end();
 if(/^(?:结束寻找|结束找物|结束当前找物任务)$/.test(words))return end();
 return null;
}
export function parseIntent(raw,focus=null,visualFocus=focus){
 const s=text(raw,600,false).replace(/^(?:(?:嗯+|哦+|啊+|好的?|那|然后)[，,。\s]+)+/,'').replace(/[。！？!?]+$/,'').trim().replace(/^(?:请问|我想问一下|我想知道|帮我看看|帮我看一下)[，,\s]*/, '');
 const target=v=>{const n=cleanObjectName(v);return ['它','他','她','这个','那个','这件','那件','该物品','物品','东西',''].includes(n)?focus:n;};
 const update=/^(?:请|帮我)?(?:更新|补拍|重新拍摄)(?:一下)?(.{1,40}?)(?:的)?(?:外观|参考照片|照片)$/.exec(s);
 if(update)return {action:'update',target:target(update[1])};
 // An explicit save clause must not be swallowed by an earlier scene clause.
 // A status question such as "记住杯子了吗" remains a read operation.
 const imperative=rememberIntent(s,target);
 if(imperative&&!/(?:记住|记得|保存).*(?:了吗|了没有|没有|吗)$/.test(s))return imperative;
 // Observed ASR confusion: “再记住一件” → “再寄出一件”. Do not silently
 // reinterpret an uncertain write request as either finding or saving an object.
 if(/^(?:请|帮我|再|重新)*寄出(?:一[件个只部])?/.test(s))return {action:'clarify',answer:'你是想记住这件物品，还是找这件物品？请说“记住白色耳机”或“帮我找白色耳机”。'};
 if(focus&&/^(?:请|帮我)?核对(?:一下)?(?:现在|当前)(?:这件|这个|这副|这只|这台)$/.test(s))return {action:'identify',target:focus,visibleTarget:focus};
 // Explicit visual re-identification precedes history/check, including pronoun follow-ups.
 const comparison=s.match(/(?:是不是|是否是|是|跟|和|与)(?=.{0,12}(?:之前|上次|以前|刚才|记忆库|记住|保存过))/);
 if(comparison&&!/^(?:你|我)?(?:还)?(?:记得|记住|保存)/.test(s)&&/(?:是不是|是否是|是.*(?:那部|那只|那个|那件|那台|那副).*(?:吗|么|嘛)$|一样|一致|同一|相同)/.test(s)){
  const head=s.slice(0,comparison.index).replace(/^.*(?:这个|这只|这部|这台|这件|这支|这本|这副)/,'').replace(/[，,。\s]+$/,'');
  const namePattern=/((?:(?:半?透明|[红蓝黄白黑绿灰银紫粉橙]色)(?:的)?)?(?:塑料|玻璃|陶瓷|金属|不锈钢)?)(笔记本电脑|耳机盒|饮料杯|保温杯|鼠标|手机|水杯|杯子|杯|耳机|盒子|箱子|钥匙|背包|电脑|玉米)/;
  const named=head.match(namePattern)?.[0]??(validObjectName(head)&&!/帮我|看看|看一下|这个|桌面|画面/.test(head)?head:null);
  const referenceMention=s.slice(comparison.index).match(namePattern);
  const current=cleanObjectName(named??visualFocus??referenceMention?.[2]??focus??'')||null;
  const historical=referenceMention?cleanObjectName(referenceMention[0]).replace(/透明的/g,'透明'):null;
  // The visible subject and the saved reference can have different features.
  // A generic reference to the same kind can use the spoken colour as a hint.
  const sameKind=historical&&current?.endsWith(historical);
  const reference=historical&&!sameKind?historical:current??historical;
  return {action:'identify',target:reference??null,visibleTarget:current??reference,...(sameKind&&historical!==reference?{referenceKind:historical}:{})};
 }
 if(/^(?:(?:现在|请|你|能不能|能否|可以|帮我|帮忙|给我|麻烦你|我想|我要|开始|启动|开启|进入)\s*)*(?:找物(?:品|助手|模式|任务)?|找(?:一下)?(?:一[件个样]|个)?(?:物品|东西)|找一下|找)(?:吧|呀|啊|吗|么)?$/.test(s))return {action:'ask_target'};
 // Common follow-ups stay local even when the online intent service is unavailable.
 const follow=s.replace(/^(?:(?:可以|好的|好|哦|嗯)[，,。\s]*)+/,'').replace(/^你[，,\s]*/,'');
 if(/^(?:在哪(?:里|儿)?|放哪(?:里|儿)?)(?:呀|啊|呢)?(?:[，,。？?\s]*告诉我)?$/.test(follow))return {action:'history',target:focus};
 if(/^(?:看一下|看看|看一看|再看一下|再看下|现在呢|这样呢)$/.test(follow))return {action:'find',target:focus};
 if(/^(?:现在)?(?:帮我)?找(?:一下)?$/.test(follow))return {action:'find',target:focus};
 const yesNo=/^(?:.*?(?:画面(?:里|中)?|镜头(?:里|中)?|桌面上?|桌上|眼前|这里))有(.{1,40}?)(?:吗|么|嘛)$/.exec(follow);
 if(yesNo&&!/有什么|有哪些|有啥|有没有|是否有|记住|保存|记录|我的/.test(follow))return {action:'locate',target:target(yesNo[1]),question:s};
 const savedCheck=/^(?:你)?(?:有没有|是否)(?:记住|记得|保存)(.{1,40})$/.exec(follow);
 if(savedCheck)return {action:'check',target:target(savedCheck[1])};
 const present=/(?:有没有|是否有|有无|是否还在|还在不在)/.exec(follow);
 if(present){
  const tail=follow.slice(present.index+present[0].length).replace(/^(?:之前说过的|之前记住的|上次记住的|刚才说的|我的|那个|这个)+/,'').replace(/(?:吗|呢|呀|啊)$/,'').trim();
  const name=target(tail);
  return name&&!validObjectName(name)?{action:'clarify',answer:'我没有听清要找的物品名，请说“帮我找白色手提袋”这样的名称。'}:{action:'find',target:name};
 }
 if(/^(?:嗯+|啊+|哦+|好的?|好吧|谢谢|我操|卧槽|唉|呃+|知道了)$/.test(s))return {action:'ignore'};
 if(/^(?:你(?:能)?|现在)?看(?:到|见)(?:了)?(?:什么|哪些|啥)|^(?:还有什么|还有呢|再详细说说|说详细一点)$/.test(s))return {action:'describe',question:s};
 if(/^(取消|不用找了|别找了|停止找物|关闭摄像头)$/.test(s))return {action:'cancel'};
 // Match whole replies; a negation, question or new request must not finish a search.
 const outcome=s.replace(/^(?:(?:好(?:的)?|嗯+|哦+)[，,\s]*)+/,'').replace(/[，,\s]*(?:谢谢(?:你)?|不用找了)$/,'');
 const statusQuestion=/^(?:你)?(?:找到|找着|摸到|拿到)(?:了)?(?:吗|么|没|没有)$/.test(outcome)||
  /[？?]/.test(raw)&&/^(?:你)?(?:找到|找着|摸到|拿到)了?$/.test(outcome);
 const stillLooking=/^(?:我)?(?:还|还是)?(?:没|没有)(?:找到|找着|拿到|摸到|看见|看到)(?:它)?(?:呢|啊|呀)?$/.test(outcome);
 if(statusQuestion||stillLooking)return {action:'continue'};
 const finished=spokenSearchEnd(raw,focus);if(finished)return finished;
 if(/^(不对|不是这个|不是它|这不是我的)$/.test(s))return {action:'reject'};
 if(!/[？?]/.test(raw)&&/^(?:请|帮我)?(?:继续|继续找|继续寻找|接着找|再找找|再找一次|再看一下|再看下|现在呢|这样呢|没找到|没有看到)(?:吧|呀)?$/.test(s))return {action:'continue'};
 if(/^(就是它|就是这个)$/.test(s))return {action:'accept'};
 let m=/^(?:它是|特征是|颜色是)(.{1,120})$/.exec(s);if(m)return {action:'features',description:m[1]};
 if(/(?:桌子?上(?:面)?|桌面(?:上(?:面)?)?|面前|眼前|周围|当前画面|画面里|这里|镜头里|前面).*(?:有什么|有哪些|有啥|是什么|看到了什么)/.test(s)||/^(?:描述|介绍|说说|看看).*(?:画面|场景|周围|桌面)/.test(s)||/^(?:这|那|你看见的).*(?:什么|颜色|形状|样子|几个|多少)/.test(s)||['这是什么','这是什么东西','看看周围'].includes(s))return {action:'describe',question:s};
 // Explicit current-search commands outrank a generic "where" suffix.
 const search=s.replace(/^(?:根据|按照)(?:我)?(?:现在|当前)?的?画面[，,\s]*/,'').replace(/^(?:(?:现在|请|帮我|麻烦你|替我|给我|再|重新)[，,\s]*)+/,'');
 m=/^(?:找到|找一下|找一找|找|寻找)(.{1,60}?)(?:现在)?(?:在哪里|在哪儿|在哪|放哪了|的位置)?(?:呀|啊|呢|吗)?$/.exec(search);
 if(m)return {action:'find',target:target(m[1])};
 m=/^(?:你)?(?:还)?(?:记住|记得)(?:了)?(.{0,40}?)(?:了)?(?:吗|没有)$/.exec(s);if(m&&!/哪里|哪儿|在哪|放哪/.test(m[1]))return {action:'check',target:target(m[1])};
 const remember=rememberIntent(s,target);if(remember)return remember;
 const clean=s.replace(/^现在/,'').replace(/^(?:(?:请|帮我|再|重新|再次))+/,'');
 m=/^(?:你知道|你记得|告诉我)?(.{1,40}?)(?:的外观是什么|的外观|的样子是什么|的样子|长什么样|是什么样子)(?:吗)?$/.exec(s);if(m)return {action:'appearance',target:target(m[1])};
 m=/^(?:查询|查看|查)?(.{1,40}?)(?:的位置历史|位置历史|的历史位置|上次放哪了|上次在哪里|上次在哪儿|上次在哪|以前放在哪里)$/.exec(s)||/^(?:我)?(?:之前|上次|以前)(?:的)?(.{1,40}?)(?:是)?(?:放在|放|在)?(?:哪里|哪儿|哪)(?:了|吗|了吗)?$/.exec(s)||/^(?:你)?(?:还)?(?:记住|记得|知道)(.{1,40}?)(?:是)?(?:放在|放|在)?(?:哪里|哪儿|哪)(?:了|吗|了吗)?$/.exec(s);if(m)return {action:'history',target:target(m[1].replace(/是$/,'').replace(/(?:之前|上次|以前|刚才)$/,''))};
 m=/^第?([一二三四五六七八九十0-9]+)(?:件|个|只)?$/.exec(s);if(m)return {action:'select',index:/^\d+$/.test(m[1])?Number(m[1])-1:'一二三四五六七八九十'.indexOf(m[1])};
 if(/上次|之前|以前|记忆|记得|记住的|记录的|保存的/.test(s)&&!/现在|当前|眼前|画面|镜头/.test(s)){
  const recall=/^(.{1,60}?)(?:的)?(?:外观和位置|样子和位置)(?:是什么|是怎样的|呢|吗|告诉我)?$/.exec(s);
  if(recall)return {action:'history',target:target(recall[1].replace(/^(?:你)?(?:还)?(?:记得|知道)/,''))};
 }
 m=/^(?:找(?:一下)?|寻找|看看)(.{1,40})$/.exec(clean);if(m)return {action:'find',target:target(m[1])};
 m=/^(.{1,40}?)(?:现在)?(?:在哪里|在哪儿|在哪|放哪了)(?:呀|啊|呢)?$/.exec(clean);if(m&&!/[，,。！？!?]|帮我|画面|找到/.test(m[1]))return {action:/现在|我的/.test(s)?'find':'history',target:target(m[1].replace(/现在$/,''))};
 return null;
}
// Broad pattern matches are hints; only complete, unambiguous commands bypass semantics.
export function certainLocalIntent(raw,intent){
 if(!intent)return false;
 if(intent.liveComparison||intent.objectId||intent.identityChoice||intent.action==='visual_reply')return true;
 const s=raw.trim().replace(/[。！!？?]+$/,'');
 if(['ignore','cancel','complete','ask_target','select','accept','reject','continue'].includes(intent.action))return s.length<=24;
 if(/不要|不用|不需要|别(?:再|给|帮|把|记|存|更新)|算了/.test(s))return false;
 if(/[，,；;]/.test(s)&&!/^(?:嗯|哦|好|好的)[，,]/.test(s))return false;
 if(intent.target&&(!validObjectName(intent.target)||/更新|替换|换成|存一|留一|收好|改成|以后|这次|能不能/.test(intent.target)))return false;
 if(['remember','update'].includes(intent.action))return !/吗|没有|是否|能否|能不能|可不可以/.test(s);
 if(['history','appearance','check'].includes(intent.action))return !/更新|换成|改成|存一|留一|替我|重新/.test(s);
 if(intent.action==='describe')return !/记住|保存|更新|存一|留一|以后/.test(s);
 return ['identify','find','scan','locate','features'].includes(intent.action);
}

export function validateSemantic(input,raw,focus){
 if(!input||!['accept','reject','auto_remember','identify','retry_identify','update','find','remember','history','check','appearance','describe','locate','continue','cancel','complete','choice_reply','hint','chat','clarify','ignore'].includes(input.action))return null;
 // Reconstruct the allowed payload. IDs, pending choices and execution flags stay program-owned.
 const intent={action:input.action};
 for(const key of ['target','visibleTarget','answer','question','description','location','writeIntent','evidence','autoKind'])if(typeof input[key]==='string')intent[key]=input[key];
 if(['saved','current'].includes(input.referenceScope))intent.referenceScope=input.referenceScope;
 if(intent.action==='complete'){const explicit=parseIntent(raw,focus);return explicit?.action==='complete'?explicit:null;}
 if(['accept','reject'].includes(intent.action)){
  if(!intent.evidence||intent.evidence.length<2||!raw.includes(intent.evidence)||/[？?]|吗|是否|是不是|如果|假如|要是|可能|也许|好像|他说|她说|上次|以前/.test(raw))return null;
  if(intent.action==='accept'&&/不是|不对|认错|没找到|没拿到/.test(raw))return null;
 }

 if(['chat','clarify'].includes(intent.action)&&!(typeof intent.answer==='string'&&intent.answer.trim()&&intent.answer.length<=240&&!/已(?:经)?(?:记住|保存)|保存成功|记住[了啦]|记下[了啦]|我记得/.test(intent.answer)))return null;
 if(intent.action==='auto_remember'){
  if(!['ownership','placement'].includes(intent.autoKind)||!intent.evidence||!raw.includes(intent.evidence)||!/(?:我|俺|本人)/.test(intent.evidence))return null;
  if(/[？?]|吗|是否|是不是|如果|假如|要是|可能|也许|不是我的|不属于我|他的|她的|别人的|你的|不要|别记|别存|以前|上次|之前/.test(raw))return null;
 }
 if(['remember','update'].includes(intent.action)){
  const explicit=parseIntent(raw,focus);
  const evidence=intent.evidence;
  const semanticRequest=intent.writeIntent==='explicit'&&typeof evidence==='string'&&evidence.length>=4&&evidence.length<=600&&raw.includes(evidence);
  if(!(explicit?.action===intent.action&&certainLocalIntent(raw,explicit))&&!semanticRequest)return null;
  if(/(?:不要|不用|别|不需要|不想)(?:再|帮我|替我|给我|把|将|这个|这只|它|鼠标)*.{0,20}(?:记|存|保存|记录|更新)|(?:之前|上次|以前).*(?:吗|没有|了没)[。？?]*$/.test(raw))return null;
 }
 if(['auto_remember','identify','find','remember','update','history','check','appearance','locate'].includes(intent.action)){
  if(typeof intent.target!=='string'||!intent.target.trim()||intent.target.length>80)return null;
  intent.target=cleanObjectName(intent.target);
  if(['它','他','她','这个','那个','物品','东西',''].includes(intent.target))intent.target=focus;
  if(!intent.target||!validObjectName(intent.target))return null;
 }
 if(intent.visibleTarget){intent.visibleTarget=cleanObjectName(intent.visibleTarget);if(!validObjectName(intent.visibleTarget))return null;}
 if(intent.action==='choice_reply'&&(!intent.description||intent.description.length>120))return null;
 if(intent.location&&(!raw.includes(intent.location)||/可能|应该|好像|也许|大概|不确定/.test(raw)))delete intent.location;
 if(input.newIdentity&&/另|新增|新的一|再记住一/.test(raw))intent.newIdentity=true;
 return intent;
}
