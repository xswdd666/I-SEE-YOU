// Names resolve records; category and coarse colour only narrow candidates, never prove identity.
const groups = [
 ['cup', ['保温杯','马克杯','水杯','茶杯','杯子','杯']],
 ['bottle', ['矿泉水瓶','水瓶','瓶子']], ['mouse', ['鼠标']],
 ['remote', ['遥控器']], ['cell phone', ['手机']], ['book', ['书本','书']],
 ['bus', ['公交车']], ['car', ['汽车']], ['fan', ['小风扇','风扇']],
 ['earphones', ['蓝牙耳机','无线耳机','耳机']],
 ['bag', ['手提袋','购物袋','塑料袋','纸袋','袋子','袋']],
 ['laptop', ['笔记本电脑','手提电脑','计算机','电脑','笔电','苹果笔记本','联想笔记本','华为笔记本','戴尔笔记本','惠普笔记本','MacBook']],
];
export function cleanObjectName(value='') {
 let name=value.trim().replace(/^[，,。！？!?：:\s]+|[，,。！？!?：:\s]+$/g,'');
 const prefix=/^(?:请|麻烦你|帮我|帮忙|替我|给我|把|将|这是|那是|我的|(?:我|你)?(?:之前|上次|刚才|刚刚|以前)(?:我|你)?(?:让你)?(?:帮我)?(?:(?:记住|记录|保存|说过|说|看到|看见|提到)(?:过|了)?)?的?|(?:这|那)(?:一)?(?:个|只|件|部|台|副|瓶|支|块|本|把)|另(?:一)?(?:个|只|件|部|台|副)|一(?:个|只|件|部|台|副))/;
 for(let n=0;n<12;n++){const next=name.replace(prefix,'').trim();if(next===name)break;name=next;}
 return name.replace(/(?:的外观和位置|的样子和位置|的位置|的外观|的样子|的)$/,'').replace(/(色|透明|边框|外壳)的/g,'$1').trim();
}
export function validObjectName(value='') {
 return value.length>0&&value.length<=40&&!/^(?:它|他|她|这个|那个|这|那|东西|物品)$/.test(value)&&
  !/[，,。！？!?\r\n]|帮我|记住|记录的|保存的|之前|上次|刚才|有没有|是否有|在哪里|在哪儿|哪里|哪儿|位于|放在|左侧|右侧/.test(value);
}
export function observationName(requested,proposed) {
 if(typeof proposed!=='string')return null;
 const name=cleanObjectName(proposed),q=objectName(requested),p=objectName(name);
 const words=groups.find(([category])=>category===q.category)?.[1]??[];
 if(q.colour&&p.colour&&q.colour!==p.colour||words.includes(p.name)&&!words.includes(q.name)||q.category==='cell phone'&&/屏幕/.test(name))return null;
 return validObjectName(name)&&name.length<=24&&(!q.category||q.category===p.category)?name:null;
}
export function applyObjectName(object,value) {
 const name=cleanObjectName(value);if(!validObjectName(name))throw Error('object_name_invalid');
 const aliases=[...(object.aliases??[]),object.name].map(cleanObjectName).filter(n=>n!==name&&validObjectName(n));
 object.name=name;object.aliases=[...new Set(aliases)].slice(0,20);object.yoloLabel=detectionLabel(name);return object;
}
export function objectName(value='') {
 const name=cleanObjectName(value);
 const group=groups.find(([,words])=>words.some(w=>name.toLowerCase().endsWith(w.toLowerCase())));
 const colour=/(蓝(?!牙)|红|白|黑|绿|黄|紫|粉|橙|灰|棕|透明|银|金)/.exec(name)?.[1]??null;
 return {name,category:group?.[0]??null,colour};
}
export function detectionLabel(value) {
 const category=objectName(value).category;
 return ['fan','earphones','bag'].includes(category)?null:category;
}
export function matchingObjects(objects, query) {
 const q=objectName(query);if(!q.name)return [];
 const exact=objects.filter(o=>[o.name,...o.aliases].some(n=>objectName(n).name.toLowerCase()===q.name.toLowerCase()));
 // A generic query must include all members, even when one old record is named just "水杯".
 const notebook=q.name==='笔记本';
 const generic=notebook||q.category&&!q.colour&&(q.category==='laptop'?['电脑','计算机','笔记本电脑','手提电脑','笔电']:groups.find(([c])=>c===q.category)[1]).some(n=>n.toLowerCase()===q.name.toLowerCase());
 if(exact.length&&!generic)return exact;
 return objects.filter(o=>[o.name,...o.aliases].some(n=>{
  const p=objectName(n);
  return p.name.toLowerCase()===q.name.toLowerCase()||notebook&&(p.name.includes('笔记本')||p.category==='laptop')||q.category&&q.category===p.category&&(!q.colour||q.colour===p.colour);
 }));
}

// Everyday “water cup” can be a capped bottle. This broadens only the shortlist;
// the saved identity and Jev reference comparison still decide the individual.
export function detectionLabels(name, primary=detectionLabel(name)) {
 return /水杯|保温杯|随行杯|运动杯/.test(name)?['cup','bottle']:primary?[primary]:[];
}
