import {describe,it,expect,vi} from 'vitest';
import {SpatialProcessor} from '../src/audio/worklets/spatialProcessor';
describe('spatial worklet slot negotiation',()=>{
 it('allocates 32 source slots when requested',()=>{
  const p=new SpatialProcessor({processorOptions:{maxSources:32}} as AudioWorkletNodeOptions);
  // Node fallback port dispatches command messages into processor.
  for(let id=1;id<=32;id++)
   p.port.onmessage?.({data:{cmd:'addSource',id,az:0,dist:1,gain:1}} as MessageEvent);
  const listener=vi.fn();
  p.port.postMessage=listener;
  p.port.onmessage?.({data:{cmd:'metricsRequest'}} as MessageEvent);
  expect(listener).toHaveBeenCalledWith(expect.objectContaining({activeSources:32}));
 });
});
