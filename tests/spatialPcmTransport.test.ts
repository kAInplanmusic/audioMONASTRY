import {describe,it,expect} from 'vitest';
import {createSpatialPcmShared,SpatialPcmTransport} from '../src/core/spatial/v2/spatialPcmTransport';
describe('SPSC source-aware spatial PCM transport',()=>{
 it.each([12,16,24,32] as const)('transfers real %i-channel planar PCM without per-block allocation',channels=>{
  const shared=createSpatialPcmShared(channels,48000);
  const producer=new SpatialPcmTransport(shared),consumer=new SpatialPcmTransport(shared);
  const pcm=Array.from({length:channels},(_,i)=>new Float32Array(128).fill(i===7?0.25:0));
  producer.publish(pcm);
  const first=consumer.consume();
  expect(first).toHaveLength(channels);
  expect(first[7][0]).toBeCloseTo(0.25);
  expect(first[6][0]).toBe(0);
  const second=consumer.consume();
  expect(second).toBe(first);
  expect(second[7][0]).toBe(0); // no stale replay
  producer.publish(pcm);
  expect(consumer.consume()).toBe(first);
  expect(first[7][0]).toBeCloseTo(0.25);
 });
 it('rejects wrong channel count and frames',()=>{
  const producer=new SpatialPcmTransport(createSpatialPcmShared(32,48000));
  expect(()=>producer.publish(Array.from({length:16},()=>new Float32Array(128)))).toThrow();
  expect(()=>producer.publish(Array.from({length:32},()=>new Float32Array(64)))).toThrow();
 });
 it('returns only the newest completed block when producer is ahead',()=>{
  const shared=createSpatialPcmShared(12,48000);
  const producer=new SpatialPcmTransport(shared),consumer=new SpatialPcmTransport(shared);
  for(let i=1;i<=5;i++)producer.publish(Array.from({length:12},()=>new Float32Array(128).fill(i/10)));
  expect(consumer.consume()[0][0]).toBeCloseTo(0.5);
 });
});
