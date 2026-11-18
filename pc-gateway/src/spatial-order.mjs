// The camera does not measure the user's body orientation. Each slot is optional.
export const spatialInstruction='只在描述位置时按方位、放置面或容器、相邻参照物的顺序自然表达。方位以本次镜头为准，例如画面左前方应表述为画面左侧，不把画面上方当作前方。不推测用户朝向、不可见物体、距离或路线。来自拍摄画面的方向使用“画面”作为基准。只写清楚可见的层，缺失层用空字符串；不补猜，不追加问题。';
export const spatialSchema='"spatial":{"direction":"画面方位","support":"放置面或容器，如白色桌面上","neighbor":"目标相对于附近可见物品的位置，如台灯右侧"}';

export function orderedPosition(slots){
 if(!slots||typeof slots!=='object')return '';
 const parts=['direction','support','neighbor'].map(key=>{
  const value=slots[key];
  if(typeof value!=='string'||value.length>48||/[。！？；;\n]|(?:您|你|身体|用户)的?[左右前后]|伸手|厘米|毫米|不清楚|无法确认|未知|看不清/.test(value))return '';
  let part=value.trim().replace(/^(?:位于|放在|在)/,'').replace(/[，,。]+$/,'');
  if(/^(?:无|无明确参照物|无参照物|不适用|null|none)$/i.test(part))return '';
  if(key==='direction'&&part&&!/^(?:当前|本次)?(?:画面|镜头)/.test(part))return '';
  return part;
 });
 return [...new Set(parts.filter(Boolean))].join('，');
}

// Reorder only self-contained clauses. Keep ambiguous legacy prose and user
// statements intact rather than detaching a qualifier or inventing a missing slot.
export function historicalPosition(location){
 if(typeof location!=='string')return location;
 const parts=location.split(/[，,；;]/).map(v=>v.trim());
 if(parts.length<2||parts.some(v=>!v||/不|可能|也许|或者|但|刚才|后来|原来|然后|如果|它的/.test(v)))return location;
 const rank=v=>{
  if(/^(?:在|位于)?(?:当时|当前|本次)?(?:画面|镜头|您的|你的)/.test(v))return 0;
  if(/(?:上面|里面|里边|内侧|内|上|里)$/.test(v))return 1;
  if(/(?:旁边|附近|旁|左侧|右侧|左边|右边|上方|下方|前方|后方)$/.test(v))return 2;
  return -1;
 };
 if(parts.some(v=>rank(v)<0))return location;
 return parts.sort((a,b)=>rank(a)-rank(b)).join('，');
}
