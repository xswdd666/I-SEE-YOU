// Visible features only. No target name or historical description is evidence.
const tidy=value=>String(value??'').replace(/[，,。！？!?\s]/g,'');
export function visualReply(raw,parsed,choice){
 if(choice?.kind!=='appearance')return null;
 const s=tidy(raw);
 if(/^(?:取消|算了|不用了|先不用|不用找了|别找了)$/.test(s))return {action:'cancel'};
 if(/^(?:是|是的|对|对的|没错|确认|就是它|就是这个|就是那台|就是这台|好的|好)$/.test(s))return {action:'visual_reply',mode:'confirm'};
 if(/^(?:不是|不对|不是它|不是这个|这不是我的|不是那台|不是这台|都不是|都不对)$/.test(s))return {action:'visual_reply',mode:s.startsWith('都')?'reject_all':'reject'};
 if(/^(?:再说一遍|没听清|什么特征|长什么样|什么样子)$/.test(s)||parsed?.action==='select')return {action:'visual_reply',mode:'repeat'};
 const correction=/^(?:不是|不对)[，,。\s]+(.+)$/.exec(raw.trim());
 if(correction)return {action:'visual_reply',mode:'feature',description:correction[1],rejectCurrent:true};
 if(parsed&&!['features','accept','reject','ignore'].includes(parsed.action))return null;
 if(!s||parsed?.action==='ignore')return null;
 return {action:'visual_reply',mode:'feature',description:parsed?.description??raw};
}
export function featureMatch(raw,descriptors){
 const s=tidy(raw).replace(/^(?:要|就是|是|找|那个|这个|那台|这台)+/,'').replace(/(?:的|那个|这个|那台|这台)$/,'');
 if(s.length<2||/不是|不对|没有|不要|别/.test(s))return [];
 return descriptors.flatMap((d,index)=>{
  if(!d)return [];
  const visible=d.description.replace(/(?:没有|无|不带|没有看到)[^，,。；;]*/g,'');
  const atoms=visible.match(/银色|黑色|白色|蓝色|红色|绿色|灰色|透明|圆形|方形|长方形|贴纸|把手|条纹|花纹|苹果标志/g)??[];
  const features=[...new Set([...(d.features??[]).filter(f=>visible.includes(f)),...atoms].map(tidy))].filter(f=>f.length>=2).sort((a,b)=>b.length-a.length);
  const hits=features.filter(f=>s.includes(f));
  // Extra discriminating words must not be silently ignored.
  const remaining=hits.reduce((v,f)=>v.replaceAll(f,''),s).replace(/(?:的|有|带着|带|一个|那台|这台|那个|这个|外壳|机身|那件|这件|它|和|并且|而且)/g,'');
  return hits.length&&remaining.length===0?[index]:[];
 });
}
export function visibleQuestion(descriptor){
 return '我看到一件物品，'+descriptor.description.replace(/[。！？!?]+$/,'')+'。这是你要找的那件吗？可以说“是的”“不是”，或告诉我它的外观特征。';
}
