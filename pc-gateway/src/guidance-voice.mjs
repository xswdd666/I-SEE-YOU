export const boxZone=box=>(box[0]+box[2])/2<1/3?'左侧':(box[0]+box[2])/2>2/3?'右侧':'中央';
// Voice guidance tolerates detector/camera jitter; visual tracking still updates every frame.
export class GuidanceVoice {
 constructor(box,now){this.zone=boxZone(box);this.lastAt=now;this.pending=null;}
 observe(box,now){
  const x=(box[0]+box[2])/2;
  const next=this.zone==='左侧'?(x>.4?(x>.72?'右侧':'中央'):'左侧'):
   this.zone==='右侧'?(x<.6?(x<.28?'左侧':'中央'):'右侧'):(x<.28?'左侧':x>.72?'右侧':'中央');
  if(next===this.zone){this.pending=null;return null;}
  if(!this.pending||this.pending.zone!==next||now<this.pending.since){this.pending={zone:next,since:now,count:1};return null;}
  this.pending.count++;
  if(this.pending.count<3||now-this.pending.since<500||now-this.lastAt<3000)return null;
  this.zone=next;this.lastAt=now;this.pending=null;return next;
 }
}
