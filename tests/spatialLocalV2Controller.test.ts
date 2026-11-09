import {describe,it,expect,vi,beforeEach} from 'vitest';
import {LocalV2SpatialMonitorController} from '../src/audio/spatial/localV2SpatialMonitorController';
import {planClubSpeakers} from '../src/core/spatial/v2/clubPlanner';
import type {V2LiveSink} from '../src/core/audio/backends/V2LiveSink';

const fakeMonitor={
 connectHeadphones:vi.fn(),disconnectHeadphones:vi.fn(),dispose:vi.fn(),
 attachMeterBridge:vi.fn(),
};
vi.mock('../src/audio/spatial/localBinauralMonitor',()=>({
 LocalBinauralMonitor:{create:vi.fn(async()=>fakeMonitor)}
}));
vi.mock('../src/audio/spatial/connectLocalV2SpatialPcm',()=>({
 connectLocalV2SpatialPcm:vi.fn(async()=>({}))
}));

describe('local V2 spatial headphone lifecycle',()=>{
 const plan=planClubSpeakers({widthM:8,depthM:8,satellites:32});
 let sink:V2LiveSink;
 let dryInsert:ReturnType<typeof vi.fn>;
 let gainNode:{gain:{value:number};connect:ReturnType<typeof vi.fn>;disconnect:ReturnType<typeof vi.fn>;context:unknown};
 beforeEach(()=>{
  vi.clearAllMocks();
  const ctx={sampleRate:48000,destination:null as unknown,
    createGain:vi.fn()};
  ctx.destination={context:ctx};
  gainNode={gain:{value:1},connect:vi.fn(),disconnect:vi.fn(),context:ctx};
  ctx.createGain.mockReturnValue(gainNode);
  dryInsert=vi.fn().mockReturnValue(true);
  sink={isConnected:true,getAudioContext:()=>ctx,setLocalMonitorInsert:dryInsert,
    detachSpatialPcmTransport:vi.fn()} as unknown as V2LiveSink;
 });
 it('mutes dry only after shared PCM is ready, then restores dry on stop',async()=>{
  const controller=new LocalV2SpatialMonitorController(sink);
  await controller.start(plan);
  expect(controller.isActive).toBe(true);
  expect(gainNode.gain.value).toBe(0);
  expect(dryInsert).toHaveBeenCalledWith(gainNode);
  expect(fakeMonitor.connectHeadphones).toHaveBeenCalled();
  controller.stop();
  expect(controller.isActive).toBe(false);
  expect(fakeMonitor.disconnectHeadphones).toHaveBeenCalled();
  expect(dryInsert).toHaveBeenLastCalledWith(null);
  expect(gainNode.disconnect).toHaveBeenCalled();
 });
 it('does not mute dry when sink is disconnected',async()=>{
  const disconnected={...sink,isConnected:false} as V2LiveSink;
  const controller=new LocalV2SpatialMonitorController(disconnected);
  await expect(controller.start(plan)).rejects.toThrow();
  expect(dryInsert).not.toHaveBeenCalled();
 });
});
