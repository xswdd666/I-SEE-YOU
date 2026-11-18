"""Persistent JSON worker: one complete scoring pair, no historical location input."""
import os,sys,json,time,html
from pathlib import Path
from appearance_core import pair_scores,best_reference,decide_match,validate_config
from appearance_model import AppearanceModel,decode,ROOT

config=json.loads((ROOT/'appearance-config.json').read_text());validate_config(config)
runtime=Path(os.environ.get('ISEEYOU_RUNTIME',str(ROOT/'runtime'))).resolve()
model=None;model_error=None
try:
    model=AppearanceModel(config,runtime/'appearance-cache');model.restore_registry()
except Exception as error:
    model_error=type(error).__name__;print('appearance model start failed: '+model_error,file=sys.stderr)

def debug(data,result,refs,candidates):
    # Fixed local latest artifact; no photograph upload or growing capture backlog.
    directory=runtime/'appearance-debug';directory.mkdir(parents=True,exist_ok=True)
    for old in directory.glob('*.jpg'):old.unlink()
    images=[]
    for kind,items in [('reference',refs),('candidate',candidates)]:
        for i,(image,_) in enumerate(items):
            filename=f'{kind}-{i}.jpg';image.save(directory/filename,quality=92)
            images.append(f'<figure><img src="{filename}" width="180"><figcaption>{kind} {i}</figcaption></figure>')
    (directory/'latest.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    (directory/'index.html').write_text('<meta charset="utf-8"><title>外观测试·本地结果</title><style>body{font:16px sans-serif;background:#fafafa}figure{display:inline-block}pre{white-space:pre-wrap}</style><h1>外观测试：'+html.escape(result['status'])+'</h1>'+''.join(images)+'<pre>'+html.escape(json.dumps(result,ensure_ascii=False,indent=2))+'</pre>',encoding='utf-8')
    log=directory/'decisions.jsonl'
    with log.open('a',encoding='utf-8') as stream:stream.write(json.dumps(result,ensure_ascii=False)+'\n')

def process(data):
    start=time.perf_counter()
    context={k:data.get(k) for k in ['requestId','frameId','sourceGeneration','targetId','referenceVersion']}
    def finish(status,**kwargs):return dict(**context,status=status,provider='appearance_mvp',minBaseScore=config['minBaseScore'],durationMs=round((time.perf_counter()-start)*1000),**kwargs)
    if data.get('operation')=='invalidate':
        if model:model.invalidate(str(data['targetId']));model.sync(str(data['targetId']),[])
        return finish('INVALIDATED')
    if time.time()*1000>data.get('deadlineAtMs',0):return finish('STALE_FRAME')
    if not data.get('references'):return finish('NO_REFERENCE')
    if model is None:return finish('MODEL_ERROR',code='model_unavailable')
    refs=data['references'][:config['maxReferences']];candidates=data.get('candidates',[])[:config['maxCandidates']]
    try:
        ref_features,ref_images,hits=model.references(refs,str(data['targetId']))
        ref_time=time.perf_counter();query_images=[decode(item['image']) for item in candidates]
        features=model.encode([im for im,_ in query_images]) if candidates else []
        encoded=time.perf_counter();outputs=[]
        for index,(item,feature) in enumerate(zip(candidates,features)):
            pairs=[dict(referenceIndex=i,referenceId=refs[i]['id'],scores=pair_scores(ref,feature,model.valid_matches(ref,feature),config)) for i,ref in enumerate(ref_features)]
            best=best_reference(pairs,config)
            outputs.append(dict(candidateIndex=index,candidateId=item['id'],box=item['box'],**best))
        result=decide_match(outputs,config)
        if time.time()*1000>data['deadlineAtMs']:result.update(status='STALE_FRAME',selected=None,choices=[])
        result=finish(**result,referenceCacheHits=hits,detailAvailable=model.detail is not None,
            timings=dict(referenceMs=round((ref_time-start)*1000),candidateEncodeMs=round((encoded-ref_time)*1000),detailMs=round((time.perf_counter()-encoded)*1000)))
        if os.environ.get('ISEEYOU_APPEARANCE_DEBUG')=='1':
            try:debug(data,result,ref_images,query_images)
            except OSError:pass
        return result
    except Exception as error:
        print('appearance request failed: '+type(error).__name__,file=sys.stderr)
        return finish('MODEL_ERROR',code='input_or_inference_failed')

print(json.dumps(dict(ready=True,modelReady=model is not None,provider='appearance_mvp',model=config['model'],detailAvailable=bool(model and model.detail),device=str(model.device) if model else 'unavailable',threads=2)),flush=True)
for line in sys.stdin:
    data={}
    try:
        if len(line)>36_000_000:raise ValueError('request_limit')
        data=json.loads(line);result=process(data)
    except Exception:result=dict(requestId=data.get('requestId'),status='MODEL_ERROR',provider='appearance_mvp')
    print(json.dumps(result,separators=(',',':')),flush=True)
