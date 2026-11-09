import {describe,it,expect} from 'vitest';
import {V2MonitorGraph} from '../src/core/audio/V2MonitorGraph';
import {V2PreStereoSpatialBus} from '../src/core/spatial/v2/v2PreStereoSpatialBus';
import {planClubSpeakers} from '../src/core/spatial/v2/clubPlanner';
import {planMonitorRouting} from '../src/core/audio/monitorRouting';
describe('V2 real pre-stereo spatial source bus',()=>{
 const ctx={sampleRate:48000,bufferSize:128,quantum:128/48000,currentTime:0};
 it('renders a real source tap into independent spatial channels',()=>{
  const studio=new V2MonitorGraph(48000,128);
  const spatial=new V2PreStereoSpatialBus(planClubSpeakers({widthM:8,depthM:8,satellites:32}));
  spatial.setTrackPosition('channel1',{x:3,y:0});
  studio.setSourceBuffer('channel1',[new Float32Array(128).fill(0.2)]);
  studio.render(ctx);
  const channels=spatial.renderFromProcessedGraph(studio,128);
  expect(channels).toHaveLength(32);
  expect(channels.filter(ch=>ch.some(v=>Math.abs(v)>1e-8)).length).toBeGreaterThan(0);
  expect(channels.filter(ch=>ch.some(v=>Math.abs(v)>1e-8)).length).toBeLessThanOrEqual(2);
 });
 it('respects MON local cue policy without changing shared master output',()=>{
  const studio=new V2MonitorGraph(48000,128);
  const spatial=new V2PreStereoSpatialBus(planClubSpeakers({widthM:8,depthM:8,satellites:16}));
  studio.setSourceBuffer('channel2',[new Float32Array(128).fill(0.1)]);
  studio.setMonitorRouting(planMonitorRouting({source:'MON',mon:'MON2',baseMix:{channel2:1}}));
  studio.render(ctx);
  const channels=spatial.renderFromProcessedGraph(studio,128);
  expect(channels.some(ch=>ch.some(v=>v!==0))).toBe(true);
  expect(studio.monitorPlan.mainMonitorGain).toBe(0);
 });
});
