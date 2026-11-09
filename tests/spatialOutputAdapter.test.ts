import {describe,it,expect} from 'vitest';
import {VirtualOutputAdapter,SpatialOutputRouter,createIdentitySpatialOutputMap,
  validateSpatialOutput} from '../src/core/spatial/v2/outputAdapter';
describe('spatial output adapter contract',()=>{
  it('can activate virtual 32ch, write frames and stop without hardware',async()=>{
    const v=new VirtualOutputAdapter();
    const router=new SpatialOutputRouter();
    await router.activate(v,{deviceId:'spatial-virtual-32',logicalChannels:32,
      sampleRate:48000,blockSize:128,channelMap:createIdentitySpatialOutputMap(32)});
    const frames=Array.from({length:32},(_,i)=>new Float32Array(128).fill(i/32));
    await router.send(frames);
    expect(v.snapshot().sequence).toBe(1);
    expect(v.snapshot().channels[31][0]).toBeCloseTo(31/32);
    frames[31][0]=0;
    expect(v.snapshot().channels[31][0]).toBeCloseTo(31/32);
    await router.stop();
    await expect(router.send(frames)).rejects.toThrow();
  });
  it('rejects collisions, offline device, channel mismatch',async()=>{
    const v=new VirtualOutputAdapter();
    const [cap]=await v.probe();
    const config={deviceId:cap.id,logicalChannels:12 as const,sampleRate:48000,
      blockSize:128,channelMap:createIdentitySpatialOutputMap(12)};
    expect(()=>validateSpatialOutput({...config,channelMap:[0,0,...Array.from({length:10},(_,i)=>i+2)]},cap)).toThrow();
    expect(()=>validateSpatialOutput({...config,deviceId:'not-found'},cap)).toThrow();
    expect(()=>validateSpatialOutput({...config,sampleRate:12345},cap)).toThrow();
    expect(()=>validateSpatialOutput(config,{...cap,online:false})).toThrow();
  });
});
