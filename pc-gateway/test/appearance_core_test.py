import unittest,json,sys
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'python'))
from appearance_core import *
from appearance_model import preprocess
from PIL import Image
CONFIG=json.loads((Path(__file__).resolve().parents[1]/'appearance-config.json').read_text())
def pair(base,total=None,i=0):return dict(referenceIndex=i,referenceId=str(i),scores=dict(base=base,total=base if total is None else total))
class AppearanceContract(unittest.TestCase):
 def test_no_detail_does_not_veto(self):
  ref=dict(vector=np.array([1,0]),color=np.array([1,0]),ratio=2)
  scores=pair_scores(ref,ref,0,CONFIG)
  self.assertAlmostEqual(scores['base'],1);self.assertEqual(scores['detailBonus'],0)
  self.assertTrue(best_reference([dict(referenceId='r',scores=scores)],CONFIG)['eligible'])
 def test_detail_cannot_rescue_low_base(self):
  b=best_reference([pair(CONFIG['minBaseScore']-.001,CONFIG['minBaseScore']+.049)],CONFIG)
  self.assertFalse(b['eligible']);self.assertEqual(decide_match([b],CONFIG)['status'],'NO_MATCH')
 def test_complete_reference_pair(self):
  b=best_reference([pair(CONFIG['minBaseScore']+.01,CONFIG['minBaseScore']+.02,0),pair(CONFIG['minBaseScore']-.01,CONFIG['minBaseScore']+.04,1)],CONFIG)
  self.assertEqual(b['referenceIndex'],0)
 def test_new_threshold_accepts_04_but_not_0399(self):
  self.assertEqual(CONFIG['minBaseScore'],.4)
  self.assertTrue(best_reference([pair(.4)],CONFIG)['eligible'])
  self.assertFalse(best_reference([pair(.399,.449)],CONFIG)['eligible'])
 def test_ambiguity_and_order(self):
  c=[dict(candidateIndex=i,**best_reference([pair(v)],CONFIG)) for i,v in enumerate([.84,.82,.65])]
  self.assertEqual(decide_match(c,CONFIG)['status'],'AMBIGUOUS')
  self.assertEqual(len(decide_match(c,CONFIG)['choices']),2)
  c[1]=dict(candidateIndex=1,**best_reference([pair(.79)],CONFIG))
  self.assertEqual(decide_match(c,CONFIG)['status'],'LIKELY_MATCH')
 def test_color_and_ratio_before_letterbox(self):
  im=Image.new('RGB',(70,140),(255,0,0));self.assertEqual(aspect_ratio(*im.size),2)
  self.assertEqual(preprocess(im).shape,(3,224,224))
  self.assertEqual(np.count_nonzero(color_histogram(im)),3)
 def test_invalid_config(self):
  validate_config(CONFIG)
  with self.assertRaises(ValueError):validate_config(dict(CONFIG,maxCandidates=9))
if __name__=='__main__':unittest.main()
