import {cleanObjectName,validObjectName} from './object-names.mjs';

const past=/上次|以前|历史|记忆库|还记得|你记得|(?:之前|刚才|刚刚).*(?:记住|记录|保存)|(?:记住|记得).*吗/;
const spatial=/哪里|哪儿|在哪|什么地方|位置|哪一边|哪边|哪侧|旁边|左边|右边|前面|后面|上面|下面|附近|靠近/;
const current=/这个|这只|这副|这部|这件|眼前|当前|现在|画面|镜头|(?:你)?(?:刚才|刚刚)?(?:说|描述|提到|看到)的/;
export class SceneDialogue {
 constructor({now=Date.now,ttlMs=120_000}={}){Object.assign(this,{now,ttlMs});}
 clear(){this.value=null;}
 fresh(generation){const v=this.value;if(!v||v.generation!==generation||this.now()-v.at<0){this.clear();return null;}if(this.now()-v.at>this.ttlMs)this.value={names:[],focus:null,generation,at:this.now()};return this.value;}
 remember(frame,result,target=null){
  const names=[...new Set((Array.isArray(result.items)?result.items:[]).filter(n=>typeof n==='string').map(cleanObjectName).filter(validObjectName))].slice(0,16);
  const focus=target??(names.length===1?names[0]:null);
  this.value={at:this.now(),generation:frame.sourceGeneration,names,focus,
   observation:focus&&result.v===true&&frame.jpeg?{target:focus,frame,box:result.targetBox}:null};
 }
 focus(generation){return this.fresh(generation)?.focus??null;}
 route(raw,intent,generation){
  const scene=this.fresh(generation),s=raw.trim().replace(/[。！？!?]+$/,'').replace(/^(?:(?:不用|不要|别)(?:记住|记录|保存)[，,\s]*)+/,'');
  if(past.test(s))return intent?.action==='locate'?{action:'history',target:intent.target}:intent;
  if(['remember','check','appearance','cancel','complete','select'].includes(intent?.action))return intent;
  const follow=scene&&/^(?:继续找|再看一下|再看下|现在呢|这样呢|看看|看一下|再看看|[它他她](?:呢|的位置呢))$/.test(s);
  if(!follow&&(!spatial.test(s)||!scene&&!current.test(s)))return intent;
  // Explicit personal-object search keeps its identity-comparison route.
  if(intent?.action==='find'&&/找|寻找|我的/.test(s)&&!follow)return intent;
  if(intent&&!['history','locate','find','describe'].includes(intent.action)&&!follow)return intent;
  let target=intent?.target;
  if(!target){
   const m=/^(?:(?:那|那么)[，,\s]*)?(?:(?:请|告诉我|你说的|刚才你说的|刚才描述的))*(.{1,40}?)(?:的)?(?:位置|现在)?(?:在哪里|在哪儿|在哪|在什么地方|在什么位置|在.+?哪一边|在.+?哪边|在.+?哪侧|在.+?旁边|旁边|左边|右边|前面|后面|上面|下面|附近)/.exec(s)||/^(.{1,40}?)(?:的位置|位置)(?:呢)?$/.exec(s);
   target=m?cleanObjectName(m[1]):null;
  }
  if(target&&/桌面|桌上|画面|场景|周围/.test(target))return intent;
  if(follow||!target||['它','他','她','这','那','这个','那个'].includes(target))target=scene?.focus??null;
  if(!target||!validObjectName(target))return {action:'clarify',answer:'你指的是画面里的哪件物品？可以说“耳机在哪里”。'};
  return {action:'locate',target,question:s};
 }
}
