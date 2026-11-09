import {describe,it,expect,vi} from 'vitest';
import {connectLocalV2SpatialPcm} from '../src/audio/spatial/connectLocalV2SpatialPcm';
import {planClubSpeakers} from '../src/core/spatial/v2/clubPlanner';
import type {V2LiveSink} from '../src/core/audio/backends/V2LiveSink';
import type {LocalBinauralMonitor} from '../src/audio/spatial/localBinauralMonitor';

describe('V2 local spatial PCM handshake',()=>{
 const plan=planClubSpeakers({widthM:8,depthM:8,satellites:32});
 function setup(failSource=false){
  const events:string[]=[];
  const sink={
   attachSpatialPcmTransport:vi.fn(async()=>{
    events.push('source-ack');
    if(failSource)throw new Error('source refused');
   }),
   detachSpatialPcmTransport:vi.fn(()=>events.push('source-detach')),
  } as unknown as V2LiveSink;
  const monitor={
   channelCount:32,
   attachSharedSpatialPcm:vi.fn(async()=>{events.push('monitor-ack');}),
   detachSharedSpatialPcm:vi.fn(()=>events.push('monitor-detach')),
  } as unknown as LocalBinauralMonitor;
  return {sink,monitor,events};
 }
 it('waits for monitor before source and passes the same SAB',async()=>{
  const {sink,monitor,events}=setup();
  const shared=await connectLocalV2SpatialPcm(sink,monitor,plan,48000);
  expect(events).toEqual(['monitor-ack','source-ack']);
  expect(vi.mocked(monitor.attachSharedSpatialPcm)).toHaveBeenCalledWith(shared);
  expect(vi.mocked(sink.attachSpatialPcmTransport).mock.calls[0][0]).toBe(shared);
 });
 it('rolls back both sides when source refuses',async()=>{
  const {sink,monitor,events}=setup(true);
  await expect(connectLocalV2SpatialPcm(sink,monitor,plan,48000)).rejects.toThrow('source refused');
  expect(events).toEqual(['monitor-ack','source-ack','monitor-detach','source-detach']);
 });
});
