import {cleanObjectName,matchingObjects} from './object-names.mjs';
import {featureMatch} from './visual-choice.mjs';

const tidy=s=>String(s??'').replace(/[，,。！？!?\s]/g,'');
const yes=s=>/^(?:好|好的|对|对的|是|是的|没错|确认|就是它|就是这个|(?:对|是的|没错)?(?:就是|是)(?:它|那台|这台|那个|这个))$/.test(s);
export function identityQuestion(objects,action='history'){
 if(objects.length===1)return '你说的是上次让我记住的“'+objects[0].name+'”'+(objects[0].description?'，已存外观是'+objects[0].description.slice(0,80):'')+'，对吗？';
 return '我记过几件可能符合的物品，已存外观包括：'+objects.slice(0,3).map(o=>o.description?.slice(0,65)||o.name).join('；')+'。'+(action==='identify'?'你想用来核对':action==='find'?'你要找':action==='update'?'你想更新':'你想查询')+'的那件有什么颜色、形状或图案？';
}
function describedObjects(objects,raw){
 let query=cleanObjectName(cleanObjectName(raw.replace(/^(?:(?:对|是的|没错|就是|是)[，,\s]*)+/,''))).replace(/(?:那台|这台|那个|这个)$/,'');
 query=cleanObjectName(query).toLowerCase();
 if(query.length<2||/不是|不对|并非|不要|不用|拍|摄像|镜头|相机|记住|记录|保存/.test(query))return [];
 const named=matchingObjects(objects,query);
 if(named.length)return named;
 const featureIds=featureMatch(raw,objects.map(o=>({description:[o.name,o.description??''].join('，'),features:[]})));
 return objects.filter((o,index)=>featureIds.includes(index)||[o.name,...(o.aliases??[]),o.description??''].some(value=>{
  const name=cleanObjectName(value).toLowerCase();
  return name.length>=2&&name.includes(query);
 }));
}
// Only an explicit pending question can interpret a bare yes or an appearance
// fragment as selecting a saved identity. New tasks keep their normal routing.
export function identityReply(raw,parsed,choice,objects,now){
 if(choice?.kind!=='identity'||!['identify','find','history','check','appearance','update'].includes(choice.intent?.action))return null;
 // A new operation outranks the old question, even if its sentence starts with yes/no.
 if(['identify','remember','describe','locate','update'].includes(parsed?.action))return null;
 const s=tidy(raw);
 if(now>choice.expiresAt){
  if(yes(s)||parsed?.action==='select')return {action:'clarify',answer:'咱们接着来，你想找哪件？'};
  return null;
 }
 if(parsed?.action==='select')return parsed;
 if(/拍(?:一)?下|拍照|拍一张|镜头|摄像头/.test(raw))return {action:'clarify',answer:'你是想记住眼前的物品吗？请告诉我要记住什么。'};
 if(/^(?:取消|算了|不用了|先不用|不用找了|别找了)$/.test(s))return {action:'cancel'};
 if(/^(?:不是|不对|并非|不要这个|不要那台)/.test(s)){
  const named=objects.filter(o=>choice.ids.includes(o.id)&&s.includes(cleanObjectName(o.name))).map(o=>o.id);
  const rejected=named.length?named:choice.ids;
  return {action:'clarify',answer:'你要找的那件，有什么特别的？',identityChoice:{...choice,ids:choice.ids.filter(id=>!rejected.includes(id)),excluded:[...new Set([...(choice.excluded??[]),...rejected])],expiresAt:now+120_000}};
 }
 if(yes(s))return choice.ids.length===1?{action:'select',index:0}:{action:'clarify',answer:choice.ids.length?'有几件可能符合，请告诉我物品的颜色、形状或图案。':'请补充你要找的那件物品的颜色、品牌或名称。',identityChoice:choice};
 const statement=/^(?:对|是的|没错|就是|是)/.test(s)&&!/[？?]|是不是|是否|在哪|哪里/.test(raw);
 if(parsed&&!['features','accept','reject'].includes(parsed.action)&&!statement)return null;
 const cupContext=choice.intent.action==='identify'&&/杯/.test(choice.intent.target)&&!objects.some(o=>choice.ids.includes(o.id)&&/被子/.test(o.name));
 const replyText=cupContext?raw.replace(/^(?:呃|嗯)[，,\s]*/,'').replace(/([红蓝黄白黑绿]色的?)被子/g,'$1杯子'):raw;
 const candidates=describedObjects(objects.filter(o=>choice.ids.includes(o.id)&&!(choice.excluded??[]).includes(o.id)),parsed?.action==='features'?parsed.description:replyText);
 if(candidates.length===1){
  const index=choice.ids.indexOf(candidates[0].id);
  return {action:'select',index};
 }
 if(candidates.length>1)return {action:'clarify',answer:identityQuestion(candidates,choice.intent.action),identityChoice:{...choice,ids:candidates.map(o=>o.id),expiresAt:now+120_000}};
 return {action:'clarify',answer:'还没认准，你记得它有什么特别的地方吗？',identityChoice:choice};
}
