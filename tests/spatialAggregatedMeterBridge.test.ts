import {describe,it,expect,vi} from 'vitest';
import {SpatialMeterBridge} from '../src/core/spatial/v2/meterBridge';
describe('per-user spatial worklet meter ingestion',()=>{
 it('accepts measured 32-channel aggregates without synthetic PCM',()=>{
  const bridge=new SpatialMeterBridge();bridge.configure(32,48000);
  const listener=vi.fn();bridge.subscribe(listener);
  const peak=Array(32).fill(0),rms=Array(32).fill(0);
  peak[7]=0.5;rms[7]=0.25;
  const frame=bridge.ingestAggregatedPCM({channels:32,frameLength:2048,peak,rms});
  expect(frame.channels[7]).toMatchObject({channel:7,peak:0.5,rms:0.25,active:true,clipped:false});
  expect(frame.channels[6].active).toBe(false);
  expect(frame.sampleRate).toBe(48000);
  expect(listener).toHaveBeenCalledTimes(2);
 });
 it('rejects invalid packets without overwriting previous meter state',()=>{
  const bridge=new SpatialMeterBridge();bridge.configure(12);
  const peak=Array(12).fill(0.1),rms=Array(12).fill(0.05);
  const good=bridge.ingestAggregatedPCM({channels:12,frameLength:128,peak,rms});
  expect(()=>bridge.ingestAggregatedPCM({channels:16,frameLength:128,peak,rms})).toThrow();
  expect(()=>bridge.ingestAggregatedPCM({channels:12,frameLength:128,peak:[...peak.slice(0,3),NaN,...peak.slice(4)],rms})).toThrow();
  expect(bridge.snapshot()).toBe(good);
 });
 it('keeps two local user meter bridges independent',()=>{
  const a=new SpatialMeterBridge(),b=new SpatialMeterBridge();a.configure(16);b.configure(16);
  a.ingestAggregatedPCM({channels:16,frameLength:2048,peak:Array(16).fill(0.1),rms:Array(16).fill(0.05)});
  expect(b.snapshot()).toBeNull();
 });
});
