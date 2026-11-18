"""Offline GPU check using a generated image; creates only temporary caches."""
import json, sys, tempfile
from pathlib import Path
import numpy as np
import torch
from PIL import Image
from ultralytics import YOLO

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'python'))
from appearance_model import AppearanceModel

assert torch.version.cuda and torch.cuda.is_available(), 'CUDA GPU required'
image=Image.fromarray(np.random.default_rng(42).integers(0,256,(320,320,3),dtype=np.uint8))
yolo=YOLO(str(ROOT/'models/yolo11s.pt'))
yolo.predict(image,device=0,verbose=False)
assert yolo.predictor.device.type=='cuda'
assert next(yolo.predictor.model.backend.model.parameters()).is_cuda
with tempfile.TemporaryDirectory() as cache:
    model=AppearanceModel(json.loads((ROOT/'appearance-config.json').read_text()),cache)
    assert next(model.net.parameters()).is_cuda
    assert model.detail is not None, model.detail_error
    assert next(model.detail.net.parameters()).is_cuda
    result=model.encode([image])[0]
    assert result['vector'].shape==(384,) and np.isfinite(result['vector']).all()
    assert len(result['points'])>=4, 'XFeat features missing'
    assert model.valid_matches(result,result)>=4, 'XFeat matching failed'
print(json.dumps({'passed':True,'gpu':torch.cuda.get_device_name(0),'torch':torch.__version__,'cuda':torch.version.cuda,'models':['YOLO','DINOv2','XFeat']}))
