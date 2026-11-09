import {VirtualSpatialInterface,type VirtualChannelCount,type VirtualFrame} from './virtualInterface';

/**
 * Non-real-time observable meter boundary for spatialMONK UI.
 * Feed only POST-render / POST-routing planar PCM from the real audio graph.
 * Never invoke this synchronously from the AudioWorklet render callback.
 * AudioWorklet integration must send bounded/throttled snapshots via port/ring.
 */
export class SpatialMeterBridge {
  private meter:VirtualSpatialInterface|null=null;
  private frame:VirtualFrame|null=null;
  private listeners=new Set<(frame:VirtualFrame|null)=>void>();
  private channels:VirtualChannelCount|null=null;
  configure(channels:VirtualChannelCount,sampleRate=48000):void {
    if(this.channels!==channels||this.meter?.sampleRate!==sampleRate){
      this.channels=channels;
      this.meter=new VirtualSpatialInterface({channels,sampleRate});
      this.frame=null;
      this.notify();
    }
  }
  ingestPostRoutingPCM(block:readonly Float32Array[]):VirtualFrame {
    if(!this.meter)throw new Error('Spatial meter not configured');
    this.frame=this.meter.process(block);
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
