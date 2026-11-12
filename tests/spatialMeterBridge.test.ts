import {describe,it,expect,vi} from 'vitest';
import {SpatialMeterBridge} from '../src/core/spatial/v2/meterBridge';
describe('spatial post-routing meter bridge',()=>{
 it('only reports actual ingested PCM, never simulated activity',()=>{
  const bridge=new SpatialMeterBridge();
  const cb=vi.fn();
  bridge.configure(32);
  const off=bridge.subscribe(cb);
  expect(bridge.snapshot()).toBeNull();
  const pcm=Array.from({length:32},()=>new Float32Array(128));
  pcm[19][7]=0.5;
  const frame=bridge.ingestPostRoutingPCM(pcm);
  expect(frame.channels.filter(x=>x.active).map(x=>x.channel)).toEqual([19]);
  expect(frame.channels[19].peak).toBeCloseTo(0.5);
  expect(cb).toHaveBeenCalledTimes(2);
  off();
  bridge.clear();
  expect(cb).toHaveBeenCalledTimes(2);
 });
 it('clears stale meters when changing channel count',()=>{
  const bridge=new SpatialMeterBridge();
  bridge.configure(12);
  bridge.ingestPostRoutingPCM(Array.from({length:12},()=>new Float32Array(64)));
  bridge.configure(24);
  expect(bridge.snapshot()).toBeNull();
  expect(()=>bridge.ingestPostRoutingPCM(Array.from({length:12},()=>new Float32Array(64)))).toThrow();
 });
});
