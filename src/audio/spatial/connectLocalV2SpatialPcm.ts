import type {V2LiveSink} from '../../core/audio/backends/V2LiveSink';
import type {ClubPlan} from '../../core/spatial/v2/clubPlanner';
import {assignSpatialOutputChannels} from '../../core/spatial/v2/channelMapping';
import {createSpatialPcmShared,type SpatialPcmShared} from '../../core/spatial/v2/spatialPcmTransport';
import type {LocalBinauralMonitor} from './localBinauralMonitor';

/** One SAB transport belongs to exactly one local V2 sink + monitor pair.
 * It is not a network stream and must never be shared across four users.
 */
export async function connectLocalV2SpatialPcm(
  sink:V2LiveSink,monitor:LocalBinauralMonitor,plan:ClubPlan,sampleRate:number,
):Promise<SpatialPcmShared> {
  if(typeof SharedArrayBuffer==='undefined'||typeof crossOriginIsolated!=='boolean'||!crossOriginIsolated)
    throw new Error('Spatial PCM requires cross-origin isolated SharedArrayBuffer');
  const mapped=assignSpatialOutputChannels(plan);
  const channels=mapped.satellites.length as 12|16|24|32;
  if(monitor.channelCount!==channels)throw new RangeError('Monitor speaker count mismatch');
  const shared=createSpatialPcmShared(channels,sampleRate);
  await monitor.attachSharedSpatialPcm(shared);
  try{
    await sink.attachSpatialPcmTransport(shared,mapped);
  }catch(error){
    monitor.detachSharedSpatialPcm();
    sink.detachSpatialPcmTransport();
    throw error;
  }
  return shared;
}
