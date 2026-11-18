const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../app/src/main/assets/www/index.html'),'utf8');
const start=html.indexOf('function reportPreviewLayout(){');
const end=html.indexOf('new ResizeObserver(',start);
let sent;
const context=vm.createContext({inGuide:false,records:false,ended:false,suspended:false,innerWidth:360,
 document:{querySelector:()=>({getBoundingClientRect:()=>({x:14,y:170,width:332,height:420})})},
 getComputedStyle:()=>({borderRadius:'20px'}),call:(name,value)=>{sent={name,...JSON.parse(value)}}});
vm.runInContext(html.slice(start,end),context);
vm.runInContext('reportPreviewLayout()',context);
assert.equal(sent.visible,true);assert.equal(sent.width,332);assert.equal(sent.viewport,360);
for(const flag of ['inGuide','records','ended','suspended']){
 vm.runInContext(`${flag}=true;reportPreviewLayout();${flag}=false`,context);assert.equal(sent.visible,false);
}
assert.ok(html.includes("if(event==='nativePreview')"));
console.log('PASS: native preview geometry and hidden screen states');
