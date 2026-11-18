import {diagnosticLog} from './diagnostics.mjs';
import https from 'node:https';
import {networkInterfaces} from 'node:os';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {WebSocketServer} from 'ws';
import {Memory} from './memory.mjs';
import {OmniProviders} from './omni.mjs';
import {AppearanceProviders} from './appearance.mjs';
import {appearanceConfig} from './appearance-config.mjs';
import {QwenSpeech,SPEECH_MODEL,SPEECH_VOICE,SPEECH_RATE} from './qwen-speech.mjs';
import {SupabaseMemory} from './supabase.mjs';
import {Session} from './session.mjs';
import {Yolo} from './yolo.mjs';
import {TargetLocator,TargetDetector} from './target-locator.mjs';
import {startDiscovery} from './discovery.mjs';
import {pythonJson,readArchive,exportArchive} from './archive.mjs';
import {check,text,uuid,safeError,MAX_ARCHIVE} from './util.mjs';

export const isLan=ip=>ip==='127.0.0.1'||ip==='::1'||/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
const currentLanAddresses=()=>[...new Set(Object.values(networkInterfaces()).flat().filter(i=>i.family==='IPv4'&&!i.internal&&isLan(i.address)).map(i=>i.address))].slice(0,8);
export async function createGateway({root=resolve(dirname(fileURLToPath(import.meta.url)),'../runtime'),port=8765,host='0.0.0.0',detector=null,providers=null,speech=null,backupOptions={},discoveryPort=port===8765&&host==='0.0.0.0'?8766:null,python=process.env.ISEEYOU_PYTHON||'python'}={}){
 mkdirSync(root,{recursive:true});const addresses=['127.0.0.1',...Object.values(networkInterfaces()).flat().filter(i=>i.family==='IPv4'&&!i.internal&&isLan(i.address)).map(i=>i.address)];
 const tls=await pythonJson('../python/tls.py',{directory:root,addresses},{python,limit:2000});const tokenFile=resolve(root,'pair-token');if(!existsSync(tokenFile))writeFileSync(tokenFile,randomBytes(32).toString('base64url'),{flag:'wx',mode:0o600});const token=readFileSync(tokenFile,'utf8').trim();check(/^[A-Za-z0-9_-]{43}$/.test(token),'pair_token_invalid');
 const memory=new Memory(resolve(root,'memory'));let socket=null,rpc=new Map(),discovery=null;const send=message=>{if(socket?.readyState===1)socket.send(JSON.stringify(message));};
 const backup=new SupabaseMemory(memory,{...backupOptions,sessionChanged:async value=>{await clientRequest('session.updated',value);}});
 const clientRequest=(operation,data)=>new Promise((resolve,reject)=>{if(socket?.readyState!==1){reject(Error('phone_not_connected'));return;}const requestId=uuid(),timer=setTimeout(()=>{rpc.delete(requestId);reject(Error('client_response_timeout'));},operation==='intent'?3500:15000);rpc.set(requestId,{resolve,reject,timer});send({type:'client.request',requestId,operation,data});});
 const backend=process.env.ISEEYOU_MATCHER??appearanceConfig.backend;check(['appearance_mvp','omni'].includes(backend),'matcher_invalid');
 const models=providers??(backend==='appearance_mvp'?new AppearanceProviders():new OmniProviders());
 const instanceMatcher=models.backend??'omni';
 const narrator=speech??new QwenSpeech();
 const log=diagnosticLog(root);const yolo=detector??new Yolo({python,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',ISEEYOU_CROP_PADDING:instanceMatcher==='appearance_mvp'?String(appearanceConfig.cropPaddingFraction):'0',ISEEYOU_APPEARANCE_DEBUG:process.env.ISEEYOU_APPEARANCE_DEBUG??'0'}});
 const locator=!detector&&instanceMatcher==='appearance_mvp'?new TargetLocator():null;
 if(locator)models.targetLocator=locator;
 const session=new Session({memory,backup,automaticMemory:true,providers:models,detector:locator?new TargetDetector(yolo,locator,{diagnostic:log}):yolo,emit:event=>{log(event);send(event);}});models.onDiagnostic=event=>session.emit(event);
 const json=(res,code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}).end(JSON.stringify(data));};
 const authorized=req=>{const peer=req.socket.remoteAddress?.replace(/^::ffff:/,'');if(!isLan(peer))return false;const got=Buffer.from((req.headers.authorization||'').replace(/^Bearer /,'')),expected=Buffer.from(token);return got.length===expected.length&&timingSafeEqual(got,expected);};
 const server=https.createServer({key:readFileSync(resolve(root,'server-key.pem')),cert:readFileSync(resolve(root,'server-cert.pem')),minVersion:'TLSv1.2'},async(req,res)=>{
  if(req.method==='GET'&&req.url==='/health'){json(res,200,{app:'I SEE YOU PC',version:'0.20.11',voiceChoices:true,stopAfterMatch:true,fourStageFlows:true,detailedFoundLocation:true,orderedSpatialSpeech:true,searchIdleSeconds:60,voiceSearchEnd:true,sandbox:false,discoveryReady:!!discovery?.ready,discoveryPort:discovery?.port??null,instanceMatcher,minBaseScore:appearanceConfig.minBaseScore,matcherReady:instanceMatcher==='appearance_mvp'?!!models.appearance?.ready:true,visionProvider:'omni',visionModel:'qwen3.8-omni-flash-realtime',speechProvider:'qwen',speechVoice:SPEECH_VOICE,speechModel:SPEECH_MODEL,yoloReady:yolo.ready});return;}
  if(!authorized(req)){json(res,401,{code:'pair_required'});return;}
  try{
   if(req.method==='GET'&&req.url==='/v1/status'){
    const latest=session.source.fresh();json(res,200,{app:'I SEE YOU PC',sandbox:false,instanceMatcher,minBaseScore:appearanceConfig.minBaseScore,matcherReady:instanceMatcher==='appearance_mvp'?!!models.appearance?.ready:true,yoloReady:yolo.ready,state:session.state,currentFrameId:latest?.frameId??null,frameAgeMs:latest?Date.now()-latest.receivedAtMs:null,objectCount:memory.all().length,target:session.task?.target??null,detections:(session.lastAnalyzed?.detections??[]).map(d=>({label:d.label,score:d.score,box:d.box}))});return;
   }
   if(req.method==='POST'&&req.url==='/v1/speech'){
    const parts=[];let size=0;for await(const part of req){size+=part.length;check(size<=16000,'speech_input_limit');parts.push(part);}
    const body=JSON.parse(Buffer.concat(parts).toString('utf8'));check(body&&Object.keys(body).length===1&&Object.hasOwn(body,'text'),'speech_input_invalid');const words=text(body.text,2000,false);
    const controller=new AbortController(),abort=()=>controller.abort();res.once('close',abort);
    try{const result=await narrator.stream(words,chunk=>{if(controller.signal.aborted)throw Error('operation_cancelled');if(!res.headersSent)res.writeHead(200,{'Content-Type':'application/octet-stream','Cache-Control':'no-store','X-Speech-Provider':'qwen','X-Speech-Model':SPEECH_MODEL,'X-Speech-Voice':SPEECH_VOICE,'X-Audio-Format':'pcm_s16le','X-Audio-Sample-Rate':String(SPEECH_RATE)});res.write(chunk);},{signal:controller.signal});res.end();log({type:'diagnostic',operation:'speech_synthesis',provider:'qwen',code:'completed',durationMs:result.durationMs});}
    catch(error){log({type:'diagnostic',operation:'speech_synthesis',provider:'qwen',code:safeError(error)});if(res.headersSent)res.destroy();else if(!res.destroyed)json(res,503,{code:safeError(error)});}
    finally{res.removeListener('close',abort);}return;
   }
   if(req.method==='POST'&&req.url==='/v1/import'){
    check(backup.credentials,'backup_login_required');const parts=[];let size=0;for await(const c of req){size+=c.length;check(size<=MAX_ARCHIVE,'archive_limit');parts.push(c);}
    const archive=await readArchive(Buffer.concat(parts),backup.credentials.userId);const old=memory.db.prepare("SELECT value FROM meta WHERE key='android-import'").get()?.value;let result;
    if(old===archive.digest)result={restored:0,kept:archive.objects.length,unchanged:true};else{result=memory.importObjects(archive.objects,archive.files,{preferNewer:true});memory.db.prepare("INSERT INTO meta VALUES('android-import',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(archive.digest);}
    session.changed();json(res,200,result);return;
   }
   if(req.method==='GET'&&req.url==='/v1/export'){check(backup.credentials,'backup_login_required');const archive=await exportArchive(memory,backup.credentials.userId);res.writeHead(200,{'Content-Type':'application/zip','Content-Length':archive.bytes.length,'Cache-Control':'no-store'}).end(archive.bytes);return;}
   json(res,404,{code:'not_found'});
  }catch(error){json(res,400,{code:safeError(error)});}
 });
 server.requestTimeout=30000;server.headersTimeout=10000;
 const wss=new WebSocketServer({noServer:true,maxPayload:3*1024*1024});
 server.on('upgrade',(req,connection,head)=>{if(req.url!=='/v1/session'||!authorized(req)){connection.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
  if(socket){const previous=socket;socket=null;session.stop();backup.clear();for(const p of rpc.values()){clearTimeout(p.timer);p.reject(Error('phone_reconnected'));}rpc.clear();previous.terminate();}
  wss.handleUpgrade(req,connection,head,ws=>wss.emit('connection',ws,req));});
 wss.on('connection',ws=>{
  socket=ws;let initialized=false;ws.isAlive=true;
  ws.on('pong',()=>{ws.isAlive=true;});
  ws.on('message',bytes=>{void(async()=>{
   let m;try{
    m=JSON.parse(bytes.toString('utf8'));check(typeof m.requestId==='string'&&m.requestId.length<=160,'request_invalid');
    if(m.type==='client.result'){const pending=rpc.get(m.requestId);if(pending){clearTimeout(pending.timer);rpc.delete(m.requestId);if(m.error)pending.reject(Error('client_operation_failed'));else pending.resolve(m.result);}return;}
    let result;
    if(m.type==='hello'){
     check(!initialized,'already_initialized');if(m.session)backup.setSession(m.session);// Older tablets may send openrouterKey; it is deliberately ignored.
     // On a fresh PC, load the cloud snapshot BEFORE importing the old tablet copy.
     // A failed initial restore cannot publish an incomplete replacement snapshot.
     if(m.session&&!memory.db.prepare("SELECT value FROM meta WHERE key='cloud-bootstrap'").get()){
      await backup.restore();memory.db.prepare("INSERT INTO meta VALUES('cloud-bootstrap',?)").run(m.session.userId);
     }
     if(m.conversationId)session.bindConversation(m.conversationId);
     initialized=true;result={account:memory.account(),version:'0.20.11',voiceChoices:true,stopAfterMatch:true,fourStageFlows:true,detailedFoundLocation:true,orderedSpatialSpeech:true,searchIdleSeconds:60,voiceSearchEnd:true,sandbox:false,lanAddresses:currentLanAddresses(),instanceMatcher,minBaseScore:appearanceConfig.minBaseScore,matcherReady:instanceMatcher==='appearance_mvp'?!!models.appearance?.ready:true,visionProvider:'omni',visionModel:'qwen3.8-omni-flash-realtime',conversationSessions:true,speechPreparation:true,yoloReady:yolo.ready,imported:!!memory.db.prepare("SELECT value FROM meta WHERE key='android-import'").get()};
    }else{check(initialized,'hello_required');
     if(m.type==='start')result=session.start(m.source);
     else if(m.type==='stop'){session.stop();result={ok:true};}
     else if(m.type==='conversation.reset'){session.bindConversation(m.conversationId);result={ok:true};}
     else if(m.type==='frame'){check(typeof m.jpeg==='string'&&m.jpeg.length<280000,'frame_limit');const f=session.frame(Buffer.from(m.jpeg,'base64'),m.generation,m.sequence,m.capturedAtMs,m.ageMs);result={frameId:f.frameId};}
     else if(m.type==='speech.prepare')result=session.prepareSpeech(m.utteranceId,m.text??'');
     else if(m.type==='command'){const work=session.command(m.command);if(m.async===true){void work.catch(error=>session.emit({type:'diagnostic',operation:'command',code:safeError(error)}));result={accepted:true};}else result=await work;}
     else if(m.type==='records')result=memory.records();
     else if(m.type==='history'){const object=memory.get(m.objectId);check(object,'object_missing');result=[...memory.locationHistory(m.objectId),...(object.events??[]).map(e=>({id:e.id,location:'用户已拿到，之后放置的位置未记录',anchor:'用户确认',observedAtMs:null,confirmed:false,recordedAtMs:e.recordedAtMs,source:'USER_STATEMENT',placeId:null}))].sort((a,b)=>b.recordedAtMs-a.recordedAtMs);}
     else if(m.type==='edit'){memory.edit(m.item);if(session.task?.objectId===m.item.id)session.cancel(false);await models.invalidate?.(m.item.id);session.changed();result={ok:true};}
     else if(m.type==='delete'){if(session.focus?.id===m.item.id||session.task?.objectId===m.item.id)session.cancel(false);memory.delete(m.item);await models.invalidate?.(m.item.id);session.changed();result={ok:true};}
     else if(m.type==='backup'){result=await backup.backup();session.say(result.objectCount?'已备份 '+result.objectCount+' 件物品，上传内容已下载核对。':'目前没有可备份的物品。');}
     else if(m.type==='restore'){session.cancel(false);result=await backup.restore();session.say('已补回 '+result.restored+' 件物品，保留 '+result.kept+' 件现有记录。恢复的是历史记忆。');session.changed();}
     else if(m.type==='backup.status')result={loggedIn:!!backup.credentials,lastSuccess:backup.lastSuccess};
     else if(m.type==='session.refresh'){backup.setSession(m.session);backup.schedule();result={ok:true};}
     else if(m.type==='session.clear'){backup.clear();result={ok:true};}
     else throw Error('unsupported_operation');
    }
    if(ws.readyState===1)ws.send(JSON.stringify({type:'result',requestId:m.requestId,result:result??null}));
   }catch(error){if(ws.readyState===1)ws.send(JSON.stringify({type:'result',requestId:m?.requestId??'',error:safeError(error)}));}
  })();});
  ws.on('error',()=>{});ws.on('close',()=>{if(socket!==ws)return;session.stop();socket=null;backup.clear();for(const p of rpc.values()){clearTimeout(p.timer);p.reject(Error('phone_disconnected'));}rpc.clear();});
 });
 const timer=setInterval(()=>{void session.tick();},150);timer.unref();const heartbeat=setInterval(()=>{if(socket){if(!socket.isAlive)socket.terminate();else{socket.isAlive=false;socket.ping();}}},10000);heartbeat.unref();
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});const actualPort=server.address().port;
 if(discoveryPort!==null)try{discovery=await startDiscovery({port:actualPort,fingerprint:tls.fingerprint,discoveryPort,host});}catch{log({type:'diagnostic',operation:'lan_discovery',code:'discovery_unavailable'});}
 const links=addresses.map(ip=>`iseeyou-pc://pair?host=${ip}&port=${actualPort}&fingerprint=${tls.fingerprint}&token=${token}`);writeFileSync(resolve(root,'pairing-links.txt'),links.join('\n'),{mode:0o600});
 return {server,memory,backup,session,yolo,links,token,fingerprint:tls.fingerprint,port:actualPort,discovery,async close(){clearInterval(timer);clearInterval(heartbeat);await discovery?.close();narrator.close?.();session.stop();locator?.close();backup.clear();for(const p of rpc.values()){clearTimeout(p.timer);p.reject(Error('gateway_closed'));}rpc.clear();socket?.terminate();await new Promise(resolve=>wss.close(resolve));await new Promise(resolve=>server.close(resolve));models.close?.();yolo.close();memory.close();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(!process.env.DASHSCOPE_API_KEY&&!process.env.QWEN_API_KEY)console.log('Omni Realtime 尚未配置：请在电脑环境或 pc-gateway/.env 设置 DASHSCOPE_API_KEY；已有记忆仍可读取。');
 const gateway=await createGateway({root:process.env.ISEEYOU_RUNTIME||undefined,port:Number(process.env.ISEEYOU_PORT||8765)});
 console.log('I SEE YOU 电脑处理中心已启动。配对地址保存在 runtime/pairing-links.txt（仅在本应用中导入）。');
 console.log('状态：https://127.0.0.1:'+gateway.port+'/health');gateway.yolo.started.then(()=>console.log('本地 YOLO 已就绪。')).catch(()=>console.log('YOLO 尚未启动，请检查 Python、模型和设备配置；已有记忆仍保留。'));
 let closing=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(closing)return;closing=true;await gateway.close();process.exit(0);});
}
