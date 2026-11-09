import type {V2LiveSink} from '../../core/audio/backends/V2LiveSink';
import type {ClubPlan} from '../../core/spatial/v2/clubPlanner';
import {LocalBinauralMonitor} from './localBinauralMonitor';
import {connectLocalV2SpatialPcm} from './connectLocalV2SpatialPcm';
import {SpatialMeterBridge} from '../../core/spatial/v2/meterBridge';
import {LocalHeadphoneDevice} from './localHeadphoneDevice';

/** Local browser-only monitor coordinator. Each user/browser must create its own instance.
 * Does not authorize remote user streams, select a hardware device or replace the shared MAIN.
 */
export class LocalV2SpatialMonitorController {
  private monitor:LocalBinauralMonitor|null=null;
  private silence:GainNode|null=null;
  private context:AudioContext|null=null;
  private generation=0;
  private active=false;
  private device:LocalHeadphoneDevice|null=null;
  readonly meter=new SpatialMeterBridge();
  constructor(private readonly sink:V2LiveSink){}

  get isActive():boolean{return this.active;}
  /** Activate only on an already-connected V2 sink. Use the same AudioContext. */
  async start(plan:ClubPlan,destination?:AudioNode):Promise<void>{
    const generation=++this.generation;
    this.stopInternal();
    const ctx=this.sink.getAudioContext();
    if(!ctx||!this.sink.isConnected)throw new Error('Connect V2 sink before spatial monitor');
    const target=destination??ctx.destination;
    if(target.context!==ctx)throw new Error('Headphone destination AudioContext mismatch');
    const monitor=await LocalBinauralMonitor.create(ctx,plan);
    try{
      if(generation!==this.generation||this.sink.getAudioContext()!==ctx)
        throw new Error('Spatial monitor activation superseded');
      await connectLocalV2SpatialPcm(this.sink,monitor,plan,ctx.sampleRate);
      if(generation!==this.generation||this.sink.getAudioContext()!==ctx)
        throw new Error('Spatial monitor source replaced during activation');
      // Keep source worklet graph pulled while suppressing its audible stereo dry path.
      const silence=ctx.createGain();
      silence.gain.value=0;
      silence.connect(ctx.destination);
      if(!this.sink.setLocalMonitorInsert(silence)){
        silence.disconnect();
        throw new Error('Cannot suppress dry V2 monitor; refusing double audio');
      }
      this.silence=silence;
      this.context=ctx;
      this.monitor=monitor;
      try{
        monitor.connectHeadphones(target);
        monitor.attachMeterBridge(this.meter);
      }catch(e){
        this.stopInternal();
        throw e;
      }
      this.active=true;
    }catch(e){
      monitor.dispose();
      if(generation===this.generation)this.sink.detachSpatialPcmTransport();
      throw e;
    }
  }

  /** Select a real output device without redirecting the shared AudioContext.
   * Requires a browser user gesture for autoplay permission.
   */
  async startOnDevice(plan:ClubPlan,deviceId:string):Promise<void>{
    const ctx=this.sink.getAudioContext();
    if(!ctx||!this.sink.isConnected)throw new Error('Connect V2 sink first');
    const device=await LocalHeadphoneDevice.create(ctx,deviceId);
    try{
      await this.start(plan,device.destination);
      if(this.sink.getAudioContext()!==ctx||!this.active)
        throw new Error('Spatial output device activation superseded');
      this.device=device;
    }catch(error){
      device.dispose();
      throw error;
    }
  }

  /** Stop wet monitor before restoring dry stereo output. */
  stop():void{
    ++this.generation;
    this.stopInternal();
  }

  /** Call after sink reconnect/layout/device changes; never reuse stale SAB. */
  async refresh(plan:ClubPlan,destination?:AudioNode):Promise<void>{
    this.stop();
    await this.start(plan,destination);
  }

  private stopInternal():void{
    this.active=false;
    this.monitor?.disconnectHeadphones();
    this.device?.dispose();
    this.device=null;
    this.monitor?.dispose();
    this.monitor=null;
    this.sink.detachSpatialPcmTransport();
    if(this.silence){
      // Clear the insert even if the sink has reconnected to a new context.
      // Otherwise a stale zero-gain insert may keep a new sink silent.
      this.sink.setLocalMonitorInsert(null);
      try{this.silence.disconnect();}catch{/* already disconnected */}
      this.silence=null;
    }
    this.context=null;
    this.meter.clear();
  }
}
