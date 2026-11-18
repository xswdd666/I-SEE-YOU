import test from 'node:test';import assert from 'node:assert/strict';
import {GuidanceVoice} from '../src/guidance-voice.mjs';
const box=x=>[x-.05,.2,x+.05,.7];
test('a phone flickering near the left/center border does not repeat directions',()=>{
 const voice=new GuidanceVoice(box(.34),0),said=[];
 for(let t=0;t<12000;t+=150){const result=voice.observe(box(t%300?.32:.35),t);if(result)said.push(result);}
 assert.deepEqual(said,[]);
});
test('a real move requires stable frames and spaces voice updates',()=>{
 const voice=new GuidanceVoice(box(.5),0);
 assert.equal(voice.observe(box(.15),3100),null);assert.equal(voice.observe(box(.15),3350),null);
 assert.equal(voice.observe(box(.15),3650),'左侧');
 assert.equal(voice.observe(box(.8),3700),null);assert.equal(voice.observe(box(.8),4000),null);assert.equal(voice.observe(box(.8),4300),null);
 assert.equal(voice.observe(box(.8),6700),'右侧');
 for(let t=7000;t<12000;t+=200)assert.equal(voice.observe(box(.81),t),null);
});
test('one unstable frame cannot change the spoken direction',()=>{
 const voice=new GuidanceVoice(box(.2),0);
 voice.observe(box(.6),4000);voice.observe(box(.2),4200);
 assert.equal(voice.observe(box(.6),4500),null);assert.equal(voice.observe(box(.6),4800),null);
 assert.equal(voice.observe(box(.6),5100),'中央');
});
