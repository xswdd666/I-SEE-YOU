"""Local official DINOv2 CLS + optional XFeat detail, with rebuildable sidecar cache."""
import os
os.environ['OMP_NUM_THREADS']='2'
os.environ['MKL_NUM_THREADS']='2'
import sys,io,base64,hashlib,json,time,socket
from pathlib import Path
from collections import OrderedDict
from contextlib import redirect_stdout
import numpy as np
import torch,cv2
from PIL import Image,ImageOps
from appearance_core import normalize,color_histogram,aspect_ratio

ROOT=Path(__file__).resolve().parents[1]
Image.MAX_IMAGE_PIXELS=2_000_000
torch.set_num_threads(2)
torch.set_num_interop_threads(1)
cv2.setNumThreads(1)

def decode(value):
    if not isinstance(value,str) or len(value)>3_000_000:raise ValueError('image_limit')
    raw=base64.b64decode(value,validate=True)
    im=Image.open(io.BytesIO(raw));im.load()
    if im.width*im.height>2_000_000:raise ValueError('pixel_limit')
    return ImageOps.exif_transpose(im).convert('RGB'),hashlib.sha256(raw).hexdigest()

def preprocess(image):
    # Color and aspect are measured BEFORE this neutral letterbox.
    scale=224/max(image.size)
    size=tuple(max(1,round(x*scale)) for x in image.size)
    canvas=Image.new('RGB',(224,224),(127,127,127))
    canvas.paste(image.resize(size,Image.Resampling.BICUBIC),((224-size[0])//2,(224-size[1])//2))
    x=torch.from_numpy(np.array(canvas)).permute(2,0,1).float()/255.
    return (x-torch.tensor([.485,.456,.406])[:,None,None])/torch.tensor([.229,.224,.225])[:,None,None]

class AppearanceModel:
    def __init__(self,config,cache_root):
        if not torch.cuda.is_available():raise RuntimeError("cuda_unavailable")
        self.device=torch.device("cuda:0")
        self.config=config;self.cache_root=Path(cache_root);self.cache_root.mkdir(parents=True,exist_ok=True)
        self.cache=OrderedDict();self.registry={};self.detail=None;self.detail_error=None;self.detail_sha='unavailable'
        sys.path.insert(0,str(ROOT/'vendor/dinov2'))
        weights=ROOT/'models/dinov2_vits14_pretrain.pth'
        self.weight_sha=hashlib.sha256(weights.read_bytes()).hexdigest()
        manifest=json.loads((ROOT/'models/dinov2-manifest.json').read_text())
        if self.weight_sha!=manifest['sha256']:raise ValueError('model_checksum_mismatch')
        with redirect_stdout(sys.stderr):
            from dinov2.hub.backbones import dinov2_vits14
            self.net=dinov2_vits14(pretrained=False)
            self.net.load_state_dict(torch.load(weights,map_location='cpu',weights_only=True),strict=True)
            self.net.to(self.device).eval()
            try:
                sys.path.insert(0,str(ROOT/'vendor/xfeat'))
                from modules.xfeat import XFeat
                detail_weights=ROOT/'vendor/xfeat/weights/xfeat.pt'
                self.detail_sha=hashlib.sha256(detail_weights.read_bytes()).hexdigest()
                self.detail=XFeat(weights=str(detail_weights),top_k=512)
            except Exception:self.detail_error='optional_detail_unavailable'
        with torch.inference_mode():self.net.forward_features(torch.zeros(1,3,224,224,device=self.device))
        def deny(*args,**kwargs):raise OSError('appearance model is local-only')
        socket.socket.connect=deny;socket.socket.connect_ex=deny

    def key(self,image_sha):
        return hashlib.sha256(f"{image_sha}:dinov2_vits14:{self.weight_sha}:{self.config['preprocessVersion']}:xfeat:{self.detail_sha}:{bool(self.detail)}:512-edge320-v1".encode()).hexdigest()

    def invalidate(self,target):
        for key in self.registry.pop(target,set()):
            self.cache.pop(key,None)
            (self.cache_root/(key+'.npz')).unlink(missing_ok=True)

    def sync(self,target,keys):
        old=self.registry.get(target,set())
        for key in old-set(keys):
            self.cache.pop(key,None);(self.cache_root/(key+'.npz')).unlink(missing_ok=True)
        self.registry[target]=set(keys)
        # Crash/restart recovery: registry never contains executable/pickled data.
        (self.cache_root/'registry.json').write_text(json.dumps({k:sorted(v) for k,v in self.registry.items()}))

    def restore_registry(self):
        try:self.registry={k:set(v) for k,v in json.loads((self.cache_root/'registry.json').read_text()).items()}
        except (OSError,ValueError):pass

    def detail_features(self,image):
        if self.detail is None:return dict(points=np.empty((0,2),np.float32),descriptors=np.empty((0,64),np.float32))
        try:
            w,h=image.size;scale=min(1,320/max(w,h));size=(max(32,round(w*scale)),max(32,round(h*scale)))
            x=torch.from_numpy(np.array(image.resize(size))).permute(2,0,1).float()[None]/255
            data=self.detail.detectAndCompute(x)[0]
            return dict(points=data['keypoints'].cpu().numpy(),descriptors=data['descriptors'].cpu().numpy())
        except Exception:return dict(points=np.empty((0,2),np.float32),descriptors=np.empty((0,64),np.float32))

    @torch.inference_mode()
    def encode(self,images):
        vectors=self.net.forward_features(torch.stack([preprocess(im) for im in images]).to(self.device))['x_norm_clstoken'].cpu().numpy()
        return [dict(vector=normalize(v),color=color_histogram(im),ratio=aspect_ratio(*im.size),**self.detail_features(im)) for im,v in zip(images,vectors)]

    def load(self,key):
        if key in self.cache:self.cache.move_to_end(key);return self.cache[key]
        try:
            with np.load(self.cache_root/(key+'.npz'),allow_pickle=False) as data:
                result={k:data[k] for k in ['vector','color','points','descriptors']};result['ratio']=float(data['ratio'])
            if result['vector'].shape!=(384,) or result['color'].shape!=(48,) or not np.isfinite(result['vector']).all():raise ValueError('bad_cache')
            self.remember(key,result);return result
        except (OSError,ValueError,KeyError):return None

    def remember(self,key,data):
        self.cache[key]=data;self.cache.move_to_end(key)
        while len(self.cache)>64:self.cache.popitem(last=False)

    def references(self,items,target):
        decoded=[decode(item['image']) for item in items];keys=[self.key(sha) for _,sha in decoded]
        self.sync(target,keys)
        results=[self.load(key) for key in keys];missing=[i for i,r in enumerate(results) if r is None]
        if missing:
            for i,data in zip(missing,self.encode([decoded[i][0] for i in missing])):
                results[i]=data;self.remember(keys[i],data)
                # Safe, rebuildable new sidecar; legacy memory embedding is untouched.
                np.savez_compressed(self.cache_root/(keys[i]+'.npz'),**data)
        return results,decoded,len(items)-len(missing)

    @torch.inference_mode()
    def valid_matches(self,ref,candidate):
        if self.detail is None or min(len(ref['points']),len(candidate['points']))<4:return 0
        try:
            ia,ib=self.detail.match(torch.from_numpy(ref['descriptors']).to(self.device),torch.from_numpy(candidate['descriptors']).to(self.device),min_cossim=.82)
            p=ref['points'][ia.cpu().numpy()];q=candidate['points'][ib.cpu().numpy()]
            if len(p)<4:return 0
            cv2.setRNGSeed(42)
            _,mask=cv2.findHomography(p,q,cv2.RANSAC,3,maxIters=2000,confidence=.995)
            return int(mask.sum()) if mask is not None else 0
        except Exception:return 0
