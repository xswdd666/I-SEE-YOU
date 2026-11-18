import {appendFileSync,existsSync,statSync,renameSync} from 'node:fs';
import {resolve} from 'node:path';
export function diagnosticLog(root) {
 const file=resolve(root,'diagnostics.jsonl');
 return event=>{
  if(event.type!=='diagnostic')return;
  const row={at:new Date().toISOString()};
  for(const k of ['operation','code','action','decision','provider','disposition','status'])if(/^[A-Za-z0-9_]{1,80}$/.test(event[k]??''))row[k]=event[k];
  for(const k of ['serial','frameId','durationMs'])if(Number.isSafeInteger(event[k])&&event[k]>=0)row[k]=event[k];
  if(Number.isSafeInteger(event.candidateCount)&&event.candidateCount>=0&&event.candidateCount<=8)row.candidateCount=event.candidateCount;
  for(const k of ['matchCount','referenceCount'])if(Number.isSafeInteger(event[k])&&event[k]>=0&&event[k]<=500)row[k]=event[k];
  for(const k of ['minBaseScore','baseScore','appearanceScore','colorScore','ratioScore','totalScore'])if(Number.isFinite(event[k])&&event[k]>=0&&event[k]<=1.1)row[k]=Math.round(event[k]*10000)/10000;
  try{
   if(existsSync(file)&&statSync(file).size>512*1024)renameSync(file,file+'.previous');
   appendFileSync(file,JSON.stringify(row)+'\n',{mode:0o600});
  }catch{/* Diagnostics must not interrupt capture or memory persistence. */}
 };
}
