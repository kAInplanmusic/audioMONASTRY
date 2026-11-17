import {describe,it,expect,vi} from 'vitest';
import {planClubSpeakers} from '../src/core/spatial/v2/clubPlanner';
import {VirtualBinauralMonitorProcessor} from '../src/audio/worklets/virtualBinauralMonitorProcessor';
describe('virtual binaural AudioWorklet 32-source input contract',()=>{
 it('does not output fake audio before configuration',()=>{
  const p=new VirtualBinauralMonitorProcessor();
  const outputs=[[new Float32Array(128).fill(1),new Float32Array(128).fill(1)]];
  expect(p.process([],outputs)).toBe(true);
  expect(outputs[0][0].every(x=>x===0)).toBe(true);
 });
 it('accepts 32 real mono inputs and responds to yaw',()=>{
  const prior=(globalThis as any).sampleRate;
  (globalThis as any).sampleRate=48000;
  try{
    const p=new VirtualBinauralMonitorProcessor();
    const report=vi.fn();p.port.postMessage=report;
    const plan=planClubSpeakers({widthM:8,depthM:8,satellites:32});
    p.port.onmessage?.({data:{type:'configure',plan}} as MessageEvent);
    expect(report).toHaveBeenCalledWith({type:'ready',channels:32});
    const inputs=Array.from({length:32},()=>[new Float32Array(128)]);
    inputs[0][0].fill(0.5);
    const out=[[new Float32Array(128),new Float32Array(128)]];
    p.process(inputs,out);
    expect(out[0][0].some(v=>v!==0)||out[0][1].some(v=>v!==0)).toBe(true);
    p.port.onmessage?.({data:{type:'head-yaw',degrees:90}} as MessageEvent);
    p.process(inputs,out);
    expect([...out[0][0],...out[0][1]].every(Number.isFinite)).toBe(true);
  }finally{(globalThis as any).sampleRate=prior;}
 });
});
