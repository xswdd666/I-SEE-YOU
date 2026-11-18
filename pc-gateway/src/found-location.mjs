import {validBox} from './providers.mjs';
import {check} from './util.mjs';
import {orderedPosition} from './spatial-order.mjs';
const center=b=>[(b[0]+b[2])/2,(b[1]+b[3])/2];
const overlap=(a,b)=>Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]));
const label=value=>typeof value==='string'&&(value.length>=2||/^[书笔灯碗盘锅筐篮床桌椅包柜架刀]$/.test(value))&&value.length<=18&&!/[。！？!?；;\r\n]|第一|第二|第几|厘米|毫米|米远|伸手|走|转身|左转|右转|你的|用户|之前|上次|已保存|已记住|厨房|卧室|客厅|房间/.test(value);
export function frameRegion(box){
 if(!validBox(box))return '当前画面中';
 const [x,y]=center(box),horizontal=x<1/3?'左侧':x>2/3?'右侧':'中央',vertical=y<1/3?'偏上':y>2/3?'偏下':'中部';
 return '当前画面'+horizontal+(horizontal==='中央'&&vertical==='中部'?'':vertical);
}
export function relativeAnchor(target,anchor){
 if(!validBox(target)||!validBox(anchor))return null;
 // Overlapping boxes do not establish left/right or prove a support relation.
 if(overlap(target,anchor)>Math.min((target[2]-target[0])*(target[3]-target[1]),(anchor[2]-anchor[0])*(anchor[3]-anchor[1]))*.15)return null;
 const [tx,ty]=center(target),[ax,ay]=center(anchor),dx=tx-ax,dy=ty-ay;
 if(Math.abs(dx)<.06&&Math.abs(dy)<.06)return null;
 if(Math.abs(dx)>Math.abs(dy)*1.4)return dx<0?'左侧':'右侧';
 if(Math.abs(dy)>Math.abs(dx)*1.4)return dy<0?'上方':'下方';
 return (dx<0?'左':'右')+(dy<0?'上方':'下方');
}
export function parseFoundLocation(value,frameId,box){
 check(value&&value.f===frameId&&value.visible===true&&Array.isArray(value.target_box)&&value.target_box.length===4&&value.target_box.every((n,i)=>typeof n==='number'&&Math.abs(n-box[i])<.00001),'found_location_context_invalid');
 check(Array.isArray(value.anchors)&&value.anchors.length<=3,'found_location_invalid');
 const [tx,ty]=center(box);
 const distance=b=>{const [x,y]=center(b);return Math.hypot(x-tx,y-ty);};
 const anchors=value.anchors.filter(a=>a&&label(a.name)&&validBox(a.box)&&relativeAnchor(box,a.box)&&distance(a.box)<.75).map(a=>({name:a.name,box:a.box,...(['sharp','fragile'].includes(a.caution)?{caution:a.caution}:{})})).sort((a,b)=>distance(a.box)-distance(b.box));
 let surface=null;
 const a=value.surface;
 if(a&&label(a.name)&&/(?:桌面|桌子|托盘|盘子|盒子|篮子|架子|抽屉|柜子|床|沙发|椅子|地面|包)$/.test(a.name)&&validBox(a.box)&&['on','inside'].includes(a.relation)){
  const [x,y]=center(box);if(x>=a.box[0]&&x<=a.box[2]&&y>=a.box[1]&&y<=a.box[3]&&(a.box[2]-a.box[0])*(a.box[3]-a.box[1])>=(box[2]-box[0])*(box[3]-box[1]))surface={name:a.name,relation:a.relation};
 }
 return {anchors,surface};
}
export function locationWords(box,detail=null,{snapshot=false}={}){
 let direction=frameRegion(box);
 if(validBox(box)){
  const edges=[[box[0],'左'],[1-box[2],'右'],[box[1],'上'],[1-box[3],'下']].sort((a,b)=>a[0]-b[0]);
  if(edges[0][0]<.08&&(box[2]-box[0])<.8&&(box[3]-box[1])<.8)direction+='，靠近画面'+edges[0][1]+'边缘';
 }
 const surface=detail?.surface;
 const anchor=detail?.anchors?.find(a=>relativeAnchor(box,a.box));
 const position=orderedPosition({
  direction,
  support:surface?surface.name+(surface.relation==='inside'?'里':'上'):'',
  neighbor:anchor?anchor.name+'的'+relativeAnchor(box,anchor.box):''
 });
 const spoken=position.replace(/^当前画面/,snapshot?'刚才的镜头画面':'当前镜头画面');
 const caution=detail?.anchors?.filter(a=>validBox(a.box)&&relativeAnchor(box,a.box)&&
  Math.hypot(...center(a.box).map((v,i)=>v-center(box)[i]))<.4&&
  (a.caution==='sharp'&&/^(?:[黑白银灰]色)?(?:剪刀|菜刀|水果刀|美工刀|刀)$/.test(a.name)||a.caution==='fragile'&&/^(?:透明|[红蓝黄白黑绿灰紫粉橙]色)?玻璃(?:杯|瓶)$/.test(a.name)))
  .sort((a,b)=>(a.caution==='sharp'?0:1)-(b.caution==='sharp'?0:1))[0];
 return '在'+spoken+'。'+(anchor?'':'附近可作参照的物品还没辨认清楚。')+(caution?'拿取时注意旁边的'+caution.name+'。':'');
}
