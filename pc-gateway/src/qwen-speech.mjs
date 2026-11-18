import {providerSocket} from './provider-socket.mjs';
import {check,text,uuid} from './util.mjs';
export const SPEECH_MODEL='qwen3-tts-flash-realtime',SPEECH_VOICE='Cherry',SPEECH_RATE=24000,MAX_SPEECH_AUDIO=12*1024*1024;
export class QwenSpeech {
 constructor({key=()=>process.env.DASHSCOPE_API_KEY||process.env.QWEN_API_KEY,socketFactory=providerSocket,timeoutMs=20000}={}){Object.assign(this,{key,socketFactory,timeoutMs,active:new Set()});}
 async stream(words,onAudio,{signal}={}){
  text(words,2000,false);const token=this.key();check(typeof token==='string'&&token.length>0,'speech_not_configured');
  if(signal?.aborted)throw Error('operation_cancelled');
  const started=performance.now(),controller=new AbortController();this.active.add(controller);
  const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  try{return await new Promise((resolve,reject)=>{
   const ws=this.socketFactory('wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model='+SPEECH_MODEL,{headers:{Authorization:'Bearer '+token},handshakeTimeout:8000,maxPayload:1024*1024});
   let finished=false,configured=false,bytes=0,firstMs=null,responseId=null;
   const timer=setTimeout(()=>finish(Error('speech_timeout')),this.timeoutMs);
   const abort=()=>finish(Error('operation_cancelled'));
   const finish=(error)=>{if(finished)return;finished=true;clearTimeout(timer);combined.removeEventListener('abort',abort);ws.removeListener('message',message);if(error){ws.terminate();reject(error);}else{ws.close();resolve({provider:'qwen',model:SPEECH_MODEL,voice:SPEECH_VOICE,sampleRate:SPEECH_RATE,bytes,firstMs,durationMs:Math.round(performance.now()-started)});}};
   const send=data=>ws.send(JSON.stringify({event_id:uuid(),...data}));
   const message=raw=>{try{
    check(raw.length<=1024*1024,'speech_output_limit');const e=JSON.parse(raw.toString());
    if(e.type==='error')throw Error('speech_provider_error');
    if(e.type==='session.created'){check(e.session?.model===SPEECH_MODEL,'speech_model_invalid');send({type:'session.update',session:{voice:SPEECH_VOICE,mode:'commit',language_type:'Chinese',response_format:'pcm',sample_rate:SPEECH_RATE,speech_rate:1.0,pitch_rate:1.0}});}
    else if(e.type==='session.updated'){
     check(!configured,'speech_session_invalid');if(e.session?.voice)check(e.session.voice===SPEECH_VOICE,'speech_voice_invalid');configured=true;
     send({type:'input_text_buffer.append',text:words});send({type:'input_text_buffer.commit'});
    }else if(e.type==='response.created'){
     check(configured&&!responseId&&typeof e.response?.id==='string'&&e.response.id.length>0,'speech_response_invalid');check(e.response.voice===SPEECH_VOICE,'speech_voice_invalid');responseId=e.response.id;
    }else if(e.type==='response.audio.delta'){
     check(configured&&typeof e.delta==='string'&&/^[A-Za-z0-9+/]+={0,2}$/.test(e.delta),'speech_audio_invalid');
     check(responseId&&e.response_id===responseId,'speech_response_invalid');
     const chunk=Buffer.from(e.delta,'base64');bytes+=chunk.length;check(chunk.length>0&&chunk.length%2===0&&bytes<=MAX_SPEECH_AUDIO,'speech_audio_invalid');
     firstMs??=Math.round(performance.now()-started);onAudio(chunk);
    }else if(e.type==='response.done'){
     check(e.response?.status==='completed'&&bytes>0,'speech_incomplete');if(e.response.voice)check(e.response.voice===SPEECH_VOICE,'speech_voice_invalid');finish();
    }
   }catch(error){finish(error instanceof SyntaxError?Error('speech_json_invalid'):error);}};
   ws.on('message',message);ws.on('error',()=>finish(Error('speech_connection_failed')));ws.on('unexpected-response',(_,r)=>finish(Error('speech_http_'+r.statusCode)));ws.on('close',()=>{if(!finished)finish(Error('speech_connection_closed'));});
   combined.addEventListener('abort',abort,{once:true});if(combined.aborted)abort();
  });}finally{this.active.delete(controller);}
 }
 close(){for(const controller of this.active)controller.abort();this.active.clear();}
}
