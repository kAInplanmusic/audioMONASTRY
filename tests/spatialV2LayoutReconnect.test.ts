import {describe,it,expect,vi} from 'vitest';
import {V2LiveSink} from '../src/core/audio/backends/V2LiveSink';

describe('V2 live sink layout change reconnect',()=>{
 it('preserves the existing AudioContext when disconnect clears the field',async()=>{
  const sink=new V2LiveSink({controlRing:false});
  const ctx={audioWorklet:{addModule:vi.fn().mockResolvedValue(undefined)},destination:{}} as unknown as AudioContext;
  const connect=vi.spyOn(sink,'connect').mockResolvedValue(true);
  const disconnect=vi.spyOn(sink,'disconnect').mockImplementation(()=>{
    (sink as unknown as {context:AudioContext|null}).context=null;
    (sink as unknown as {node:AudioWorkletNode|null}).node=null;
  });
  (sink as unknown as {context:AudioContext|null}).context=ctx;
  (sink as unknown as {node:AudioWorkletNode|null}).node={port:{postMessage:vi.fn()}} as unknown as AudioWorkletNode;
  expect(sink.setOutputLayout('2.1')).toBe(true);
  expect(disconnect).toHaveBeenCalledOnce();
  expect(connect).toHaveBeenCalledWith(ctx);
  await Promise.resolve();
 });
});
