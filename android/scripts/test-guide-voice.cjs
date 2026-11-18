const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'app/src/main/assets/www/index.html'), 'utf8');
const java = fs.readFileSync(path.join(root, 'app/src/main/java/com/iseeyou/demo/DevKitScreen.java'), 'utf8');
const nodes = new Map();
let recognition, calls = [], spoken = [];
const context = vm.createContext({
  $: id => { if (!nodes.has(id)) nodes.set(id, {open:false, value:'', dataset:{}, replaceChildren(){}, append(){}}); return nodes.get(id); },
  DeviceApp: {call(...args){calls.push(args)}},
  ISeeYouRecognition: class {constructor(){recognition=this} start(){} abort(){}},
  ISeeYouUtterance: class {constructor(text){this.text=text}},
  ISeeYouSpeech: {cancel(){}, speak(u){spoken.push(u.text); u.onend?.()}},
  document: {createElement(){return {}}}
});
vm.runInContext(html.slice(html.indexOf('const call = (name'), html.indexOf('function clearFrame(')), context);
for (const command of ['现在连','连吧','先别连接','再试一次','换一台','用手机','用设备','连接','暂不连接','使用手机相机','使用设备摄像头','下一台','重试','重新输入','复核密码','修改网络']) {
  vm.runInContext("showGuide('RETRY','请说重试')", context);
  const result = [{transcript:command.split('').join(' ')}]; result.isFinal=true;
  recognition.onresult({results:[result]});
  assert.equal(calls.at(-1)[1], command, `Chinese command must reach native flow: ${command}`);
}
vm.runInContext("showGuide('SEARCH','现在连吗')", context);
const question=[{transcript:'现在连？'}];question.isFinal=true;
recognition.onresult({results:[question]});
assert.equal(calls.at(-1)[1],'现在连？','Preserve questions for native intent matching');
for (const stage of ['SSID','PASSWORD']) {
  vm.runInContext(`showGuide('${stage}','请输入')`, context);
  const result=[{transcript:'Room WiFi 123'}]; result.isFinal=true;
  recognition.onresult({results:[result]});
  assert.equal(calls.at(-1)[1], 'Room WiFi 123', 'Network credentials must keep spaces');
}
vm.runInContext("showGuide('RETRY','请说重试')", context);
recognition.onerror({error:'no-speech'}); recognition.onend();
assert.ok(spoken.some(s => s.includes('刚才没听清')), 'Recognition failure must give audible feedback');
const second = recognition;
second.onerror({error:'no-speech'}); second.onend();
const third = recognition;
third.onerror({error:'no-speech'}); third.onend();
assert.equal(recognition, third, 'Stop after two automatic retries');
assert.ok(spoken.at(-1).includes('已暂停'), 'Explain when listening has stopped');
vm.runInContext("showGuide('RETRY','请说重试')", context);
const stale=recognition;
vm.runInContext("showGuide('SOURCE','请选择相机')", context);
const current=recognition;
stale.onerror({error:'no-speech'}); stale.onend();
assert.equal(recognition,current,'A stale error must not restart the previous guide');
assert.ok(!java.includes('offline.start(guideGrammar()'), 'Do not send unsegmented Chinese phrases as Vosk vocabulary tokens');
console.log('PASS: all guide commands, credential spaces, audible retry and Chinese recognition mode');

for (const [step,kind] of Object.entries({SEARCH:'voice',SCANNING:'bt',DEVICE:'bt',CONNECTING:'bt',SSID:'wifi',PASSWORD:'wifi',CONFIRM:'wifi',SENDING:'wifi',DONE:'done',SOURCE:'camera',RETRY:'voice'})) {
  vm.runInContext(`showGuide('${step}','提示')`,context);
  assert.equal(nodes.get('setup').dataset.kind,kind);
  assert.equal(nodes.get('setup').dataset.busy,String(['SCANNING','CONNECTING','SENDING'].includes(step)));
}
console.log('PASS: guide artwork follows every connection stage');
