import {VirtualSpatialInterface,type VirtualChannelCount,type VirtualFrame} from './virtualInterface';

/**
 * Non-real-time observable meter boundary for spatialMONK UI.
 * Feed only POST-render / POST-routing planar PCM from the real audio graph.
 * Never invoke this synchronously from the AudioWorklet render callback.
 * AudioWorklet integration must send bounded/throttled snapshots via port/ring.
 */
export interface SpatialMeterAggregate {channels:number;frameLength:number;peak:readonly number[];rms:readonly number[]}
export class SpatialMeterBridge {
  private meter:VirtualSpatialInterface|null=null;
  private frame:VirtualFrame|null=null;
  private listeners=new Set<(frame:VirtualFrame|null)=>void>();
  private channels:VirtualChannelCount|null=null;
  private sequence=0;
  configure(channels:VirtualChannelCount,sampleRate=48000):void {
    if(this.channels!==channels||this.meter?.sampleRate!==sampleRate){
      this.channels=channels;
      this.meter=new VirtualSpatialInterface({channels,sampleRate});
      this.frame=null;
      this.sequence=0;
      this.notify();
    }
  }
  ingestPostRoutingPCM(block:readonly Float32Array[]):VirtualFrame {
    if(!this.meter)throw new Error('Spatial meter not configured');
    this.frame=this.meter.process(block);
    this.sequence=this.frame.sequence;
    this.notify();
    return this.frame;
  }
  /** Main-thread ingestion of aggregated actual PCM statistics, never synthetic audio. */
  ingestAggregatedPCM(packet:SpatialMeterAggregate):VirtualFrame {
    if(!this.meter||this.channels===null)throw new Error('Spatial meter not configured');
    if(packet.channels!==this.channels||
      !Number.isSafeInteger(packet.frameLength)||packet.frameLength<1||
      packet.peak.length!==this.channels||packet.rms.length!==this.channels)
      throw new RangeError('Invalid spatial meter packet');
    const threshold=Math.pow(10,-72/20);
    const channels=packet.peak.map((peak,channel)=>{
      const rms=packet.rms[channel];
      if(!Number.isFinite(peak)||!Number.isFinite(rms)||peak<0||rms<0||rms>peak+1e-5)
        throw new RangeError('Invalid channel meter values');
      return {channel,peak,rms,active:peak>=threshold,clipped:peak>=1};
    });
    this.frame={sequence:++this.sequence,sampleRate:this.meter.sampleRate,
      frameLength:packet.frameLength,channels};
    this.notify();
    return this.frame;
  }
  snapshot():VirtualFrame|null{return this.frame;}
  subscribe(fn:(frame:VirtualFrame|null)=>void):()=>void {
    this.listeners.add(fn);
    fn(this.frame);
    return ()=>{this.listeners.delete(fn);};
  }
  clear():void {this.frame=null;this.notify();}
  private notify():void {for(const fn of this.listeners)fn(this.frame);}
}
export const spatialMeterBridge=new SpatialMeterBridge();
