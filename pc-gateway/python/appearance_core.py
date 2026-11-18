"""Pure appearance scoring; no world position, pixel area or model downloading."""
import math
import numpy as np

def normalize(vector):
    vector=np.asarray(vector,dtype=np.float32)
    if not np.isfinite(vector).all():raise ValueError('invalid_features')
    norm=float(np.linalg.norm(vector))
    if norm<1e-12:raise ValueError('empty_features')
    return vector/norm

def color_histogram(image):
    pixels=np.asarray(image.convert('RGB'),dtype=np.uint8)
    return normalize(np.concatenate([np.histogram(pixels[:,:,c],bins=16,range=(0,256))[0] for c in range(3)]))

def aspect_ratio(width,height):
    if min(width,height)<=0:raise ValueError('invalid_dimensions')
    return max(width,height)/min(width,height)

def pair_scores(reference,candidate,valid_matches,config):
    a=float(np.clip(np.dot(reference['vector'],candidate['vector']),0,1))
    c=float(np.clip(np.dot(reference['color'],candidate['color']),0,1))
    r=float(min(reference['ratio'],candidate['ratio'])/max(reference['ratio'],candidate['ratio']))
    w=config['weights'];base=w['appearance']*a+w['color']*c+w['ratio']*r
    n=max(0,int(valid_matches));bonus=config['maxDetailBonus']*min(n/config['detailSaturationMatches'],1.)
    return dict(appearance=a,color=c,ratio=r,base=float(base),validDetailMatches=n,detailBonus=bonus,total=base+bonus)

def best_reference(pairs,config):
    # Every score comes from ONE complete reference pair. Never splice maxima.
    eligible=[p for p in pairs if p['scores']['base']>=config['minBaseScore']]
    pool=eligible or pairs
    if not pool:raise ValueError('no_reference_pairs')
    best=max(pool,key=lambda p:p['scores']['total'])
    return dict(**best,eligible=bool(eligible),referencePairs=pairs)

def decide_match(candidates,config):
    eligible=sorted((c for c in candidates if c['eligible']),key=lambda c:c['scores']['total'],reverse=True)
    ranked=eligible+sorted((c for c in candidates if not c['eligible']),key=lambda c:c['scores']['total'],reverse=True)
    if not eligible:return dict(status='NO_MATCH',candidates=ranked,selected=None,choices=[])
    top=eligible[0]
    nearby=[c for c in eligible if top['scores']['total']-c['scores']['total']<config['ambiguityMargin']]
    status='AMBIGUOUS' if len(nearby)>1 else 'LIKELY_MATCH'
    return dict(status=status,candidates=ranked,selected=top,choices=nearby if status=='AMBIGUOUS' else [])

def validate_config(config):
    if config['model']!='dinov2_vits14':raise ValueError('unsupported_model')
    w=config['weights']
    if set(w)!=set(['appearance','color','ratio']) or any(not math.isfinite(v) or v<0 for v in w.values()) or abs(sum(w.values())-1)>1e-6:raise ValueError('invalid_weights')
    for k in ['minBaseScore','ambiguityMargin','maxDetailBonus']:
        if not 0<=config[k]<=1:raise ValueError('invalid_'+k)
    if not 1<=config['maxReferences']<=3 or not 1<=config['maxCandidates']<=8 or config['detailSaturationMatches']<=0:raise ValueError('invalid_limits')
    if not 0<=config['cropPaddingFraction']<=.2:raise ValueError('invalid_padding')
