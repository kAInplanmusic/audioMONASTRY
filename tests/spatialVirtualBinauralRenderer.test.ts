import {describe,it,expect} from 'vitest';
import {planClubSpeakers} from '../src/core/spatial/v2/clubPlanner';
import {VirtualBinauralRenderer} from '../src/core/spatial/v2/virtualBinauralRenderer';
describe('source-aware virtual binaural 32 to stereo',()=>{
 it.each([12,16,24,32] as const)('renders %i channels to stereo with finite samples',count=>{
  const plan=planClubSpeakers({widthM:8,depthM:12,satellites:count});
  const renderer=new VirtualBinauralRenderer(plan,48000,128);
  const block=Array.from({length:count},()=>new Float32Array(128));
  block[0][0]=1;
  const out=renderer.process(block);
  expect(out).toHaveLength(2);
  expect(out[0]).toHaveLength(128);
  expect([...out[0],...out[1]].every(Number.isFinite)).toBe(true);
  expect(out[0].some(v=>v!==0)||out[1].some(v=>v!==0)).toBe(true);
 });
 it('preserves per-speaker positioning and responds to listener yaw',()=>{
  const plan=planClubSpeakers({widthM:8,depthM:8,satellites:16});
  const r=new VirtualBinauralRenderer(plan,48000,128);
  const idx=plan.satellites.findIndex(s=>s.azimuthDeg>=60&&s.azimuthDeg<=120);
  expect(idx).toBeGreaterThanOrEqual(0);
  const block=Array.from({length:16},()=>new Float32Array(128));
  block[idx].fill(0.5);
  const [l1,r1]=r.process(block);
  const e1l=l1.reduce((a,v)=>a+v*v,0),e1r=r1.reduce((a,v)=>a+v*v,0);
  expect(e1r).toBeGreaterThan(e1l);
  r.reset();r.setHeadYaw(180);
  const [l2,r2]=r.process(block);
  const e2l=l2.reduce((a,v)=>a+v*v,0),e2r=r2.reduce((a,v)=>a+v*v,0);
  expect(e2l).toBeGreaterThan(e2r);
 });
 it('rejects mismatched input without modifying channel count',()=>{
  const r=new VirtualBinauralRenderer(planClubSpeakers({widthM:4,depthM:4,satellites:32}));
  expect(()=>r.process(Array.from({length:16},()=>new Float32Array(128)))).toThrow();
 });
});
