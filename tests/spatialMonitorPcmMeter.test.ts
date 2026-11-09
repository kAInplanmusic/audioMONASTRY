import {describe,it,expect,vi} from 'vitest';
import {planClubSpeakers} from '../src/core/spatial/v2/clubPlanner';
import {VirtualBinauralMonitorProcessor} from '../src/audio/worklets/virtualBinauralMonitorProcessor';
describe('spatial monitor actual PCM meter telemetry',()=>{
 it('emits throttled 32-channel peak and RMS from real input samples',()=>{
  const p=new VirtualBinauralMonitorProcessor();
  const send=vi.fn();p.port.postMessage=send;
  p.port.onmessage?.({data:{type:'configure',plan:planClubSpeakers({widthM:8,depthM:8,satellites:32})}} as MessageEvent);
  p.port.onmessage?.({data:{type:'meter-enabled',enabled:true}} as MessageEvent);
  const input=Array.from({length:32},()=>[new Float32Array(128)]);
  input[7][0].fill(0.25);
  const output=[[new Float32Array(128),new Float32Array(128)]];
  for(let i=0;i<15;i++)p.process(input,output);
  expect(send.mock.calls.some(([m])=>m.type==='spatial-meter')).toBe(false);
  p.process(input,output);
  const packet=send.mock.calls.map(([m])=>m).find(m=>m.type==='spatial-meter');
  expect(packet).toBeDefined();
  expect(packet.channels).toBe(32);
  expect(packet.frameLength).toBe(2048);
  expect(packet.peak[7]).toBeCloseTo(0.25);
  expect(packet.rms[7]).toBeCloseTo(0.25);
  expect(packet.peak[6]).toBe(0);
  expect(packet.rms[6]).toBe(0);
 });
 it('does not emit meter packets when disabled',()=>{
  const p=new VirtualBinauralMonitorProcessor();
  const send=vi.fn();p.port.postMessage=send;
  p.port.onmessage?.({data:{type:'configure',plan:planClubSpeakers({widthM:8,depthM:8,satellites:12})}} as MessageEvent);
  const input=Array.from({length:12},()=>[new Float32Array(128).fill(0.1)]);
  const output=[[new Float32Array(128),new Float32Array(128)]];
  for(let i=0;i<32;i++)p.process(input,output);
  expect(send.mock.calls.some(([m])=>m.type==='spatial-meter')).toBe(false);
 });
});
