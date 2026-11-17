import {V2_CHANNELS,type V2Channel} from '../../audio/V2StudioGraph';
import type {V2MonitorGraph} from '../../audio/V2MonitorGraph';
import type {ClubPlan} from './clubPlanner';
import {assignSpatialOutputChannels} from './channelMapping';
import {adjacentPan2D} from './clubPlanner';
import type {SpatialVec2} from './model';

/**
 * Genuine source-aware spatial bus, built from the already-rendered V2 channel
 * strip taps BEFORE main/cue stereo summation. No re-render of the V2 graph.
 * Output is planar N-channel PCM and is only valid until the next render.
 * Master inserts are intentionally not represented in this pre-master bus.
 */
export class V2PreStereoSpatialBus {
  readonly channelCount:number;
  private readonly plan:ClubPlan;
  private readonly positions=new Map<V2Channel,SpatialVec2>();
  private output:Float32Array[]=[];
  private blockSize=0;
  constructor(plan:ClubPlan){
    this.plan=assignSpatialOutputChannels(plan);
    this.channelCount=this.plan.satellites.length;
  }
  setTrackPosition(track:V2Channel,position:SpatialVec2):void{
    if(!V2_CHANNELS.includes(track)||!Number.isFinite(position.x)||!Number.isFinite(position.y))
      throw new RangeError('Invalid spatial track position');
    this.positions.set(track,{...position});
  }
  /** Requires studio.render(ctx) to have completed for the current block. */
  renderFromProcessedGraph(studio:V2MonitorGraph,frames:number):readonly Float32Array[]{
    if(!Number.isSafeInteger(frames)||frames<1||frames>4096)throw new RangeError('Invalid quantum');
    if(this.blockSize!==frames){
      this.output=Array.from({length:this.channelCount},()=>new Float32Array(frames));
      this.blockSize=frames;
    }
    for(const out of this.output)out.fill(0);
    const policy=studio.monitorPlan;
    const mainGain=policy.mainMonitorGain;
    const cueGain=policy.cueGain;
    if(mainGain===0&&cueGain===0)return this.output;
    for(const track of V2_CHANNELS){
      const pos=this.positions.get(track)??this.plan.listenerM;
      const p=adjacentPan2D(this.plan,pos);
      const first=this.plan.satellites[p.first].outputChannel as number;
      const second=this.plan.satellites[p.second].outputChannel as number;
      // MAIN: post-fader, pre-stereo-pan mono tap; CUE: pre-fader gain.
      const main=studio.gains.get(track)?.outputs[0].buffer?.[0];
      const cue=studio.cueGains.get(track)?.outputs[0].buffer?.[0];
      const a=this.output[first],b=this.output[second];
      for(let i=0;i<frames;i++){
        const x=(mainGain*(main?.[i]??0))+(cueGain*(cue?.[i]??0));
        const safe=Number.isFinite(x)?x:0;
        a[i]+=safe*p.gainFirst;
        b[i]+=safe*p.gainSecond;
      }
    }
    return this.output;
  }
}
