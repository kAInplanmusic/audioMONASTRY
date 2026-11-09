import type {ClubPlan} from '../../core/spatial/v2/clubPlanner';
import {SpatialMeterBridge} from '../../core/spatial/v2/meterBridge';
import {assignSpatialOutputChannels} from '../../core/spatial/v2/channelMapping';
import type {SpatialPcmShared} from '../../core/spatial/v2/spatialPcmTransport';
/**
 * Per-user local spatial monitor branch. Connect actual mono spatial stems to
 * input(channel). Does NOT attach to V2LiveSink's already-summed stereo output.
 * Caller owns user/monitor-source authorization and must route the correct
 * selected stems. No implicit connection to the global main or Visuals Out.
 */
export interface SpatialMonitorMeterPacket {type:'spatial-meter';channels:number;frameLength:number;peak:number[];rms:number[]}
export class LocalBinauralMonitor {
  readonly node:AudioWorkletNode;
  readonly channelCount:number;
  private disposed=false;
  private ready=false;
  private readonly attachedStems=new Map<number,AudioNode>();
  private headphoneDestination:AudioNode|null=null;
  private meterBridge:SpatialMeterBridge|null=null;
  private spatialBus:{source:AudioNode;splitter:ChannelSplitterNode}|null=null;
  onMeter:((packet:SpatialMonitorMeterPacket)=>void)|null=null;
  private constructor(node:AudioWorkletNode,channels:number){
    this.node=node;this.channelCount=channels;
  }
  static async create(ctx:AudioContext,plan:ClubPlan):Promise<LocalBinauralMonitor>{
    if(![12,16,24,32].includes(plan.satellites.length))throw new RangeError('Invalid channel count');
    const mappedPlan=assignSpatialOutputChannels(plan);
    await ctx.audioWorklet.addModule('/worklets/virtualBinauralMonitorProcessor.js');
    const node=new AudioWorkletNode(ctx,'virtual-binaural-monitor',{
      numberOfInputs:plan.satellites.length,numberOfOutputs:1,
      outputChannelCount:[2],channelCount:1,channelCountMode:'explicit'
    });
    const monitor=new LocalBinauralMonitor(node,plan.satellites.length);
    try{
      await new Promise<void>((resolve,reject)=>{
        const timeout=setTimeout(()=>reject(new Error('Binaural worklet readiness timeout')),3000);
        node.port.onmessage=(e:MessageEvent)=>{
          if(e.data?.type==='ready'&&e.data.channels===monitor.channelCount){
            clearTimeout(timeout);monitor.ready=true;
            node.port.onmessage=(msg:MessageEvent)=>{
              const data=msg.data;
              if(data?.type==='spatial-meter'&&data.channels===monitor.channelCount&&
                Array.isArray(data.peak)&&Array.isArray(data.rms)&&
                data.peak.length===monitor.channelCount&&data.rms.length===monitor.channelCount)
                {
                  const packet=data as SpatialMonitorMeterPacket;
                  if(monitor.meterBridge){
                    try{monitor.meterBridge.ingestAggregatedPCM(packet);}catch{/* reject malformed meter packet */}
                  }
                  monitor.onMeter?.(packet);
                }
            };
            resolve();
          }else if(e.data?.type==='error'){
            clearTimeout(timeout);reject(new Error(String(e.data.reason)));
          }
        };
        node.port.postMessage({type:'configure',plan:mappedPlan});
      });
      return monitor;
    }catch(e){monitor.dispose();throw e;}
  }
  /** Activate genuine PCM from the V2 source worklet, not from WebAudio inputs. */
  attachSharedSpatialPcm(shared:SpatialPcmShared):void{
    if(this.disposed||!this.ready)throw new Error('Binaural monitor unavailable');
    if(this.attachedStems.size||this.spatialBus)
      throw new Error('Disconnect WebAudio spatial inputs before attaching shared PCM');
    if(shared.channels!==this.channelCount||shared.sampleRate!==this.node.context.sampleRate)
      throw new RangeError('Spatial PCM format mismatch');
    this.node.port.postMessage({type:'spatial-pcm-transport',shared});
  }
  detachSharedSpatialPcm():void{
    if(!this.disposed)this.node.port.postMessage({type:'spatial-pcm-disable'});
  }
  /** Connect a mono stem at canonical spatial output index. */
  connectStem(source:AudioNode,channel:number):void{
    if(this.disposed||!this.ready)throw new Error('Binaural monitor unavailable');
    if(!Number.isSafeInteger(channel)||channel<0||channel>=this.channelCount)
      throw new RangeError('Invalid spatial channel');
    if(source.context!==this.node.context)throw new Error('AudioContext mismatch');
    if(this.spatialBus)throw new Error('Cannot mix multichannel bus and individual stems');
    const previous=this.attachedStems.get(channel);
    if(previous)try{previous.disconnect(this.node,0,channel);}catch{/* already detached */}
    source.connect(this.node,0,channel);
    this.attachedStems.set(channel,source);
  }
  /** Attach a real N-channel spatial AudioNode output (not stereo). */
  connectSpatialBus(source:AudioNode):void{
    if(this.disposed||!this.ready)throw new Error('Binaural monitor unavailable');
    if(source.context!==this.node.context)throw new Error('AudioContext mismatch');
    if(this.attachedStems.size)throw new Error('Cannot mix multichannel bus and individual stems');
    this.disconnectSpatialBus();
    const splitter=this.node.context.createChannelSplitter(this.channelCount);
    try{
      source.connect(splitter);
      for(let i=0;i<this.channelCount;i++)splitter.connect(this.node,i,i);
      this.spatialBus={source,splitter};
    }catch(e){
      try{source.disconnect(splitter);}catch{/* no connection */}
      try{splitter.disconnect();}catch{/* no connection */}
      throw e;
    }
  }
  disconnectSpatialBus():void{
    if(!this.spatialBus)return;
    const {source,splitter}=this.spatialBus;
    this.spatialBus=null;
    try{source.disconnect(splitter);}catch{/* already detached */}
    try{splitter.disconnect();}catch{/* already detached */}
  }
  disconnectStem(channel:number):void{
    const source=this.attachedStems.get(channel);
    if(!source)return;
    try{source.disconnect(this.node,0,channel);}catch{/* already detached */}
    this.attachedStems.delete(channel);
  }
  connectHeadphones(destination:AudioNode):void{
    if(this.disposed||!this.ready)throw new Error('Binaural monitor unavailable');
    if(destination.context!==this.node.context)throw new Error('AudioContext mismatch');
    if(this.headphoneDestination===destination)return;
    if(this.headphoneDestination){
      try{this.node.disconnect(this.headphoneDestination);}catch{/* already detached */}
    }
    this.node.connect(destination);
    this.headphoneDestination=destination;
  }
  disconnectHeadphones():void{
    if(!this.headphoneDestination)return;
    try{this.node.disconnect(this.headphoneDestination);}catch{/* already detached */}
    this.headphoneDestination=null;
  }
  /** Bind to an isolated meter bridge, never the shared singleton across users. */
  attachMeterBridge(bridge:SpatialMeterBridge|null):void{
    if(this.disposed||!this.ready)throw new Error('Binaural monitor unavailable');
    if(bridge)bridge.configure(this.channelCount as 12|16|24|32,this.node.context.sampleRate);
    this.meterBridge=bridge;
    this.setMeteringEnabled(bridge!==null||this.onMeter!==null);
  }
  setMeteringEnabled(enabled:boolean):void{
    if(this.disposed||!this.ready)throw new Error('Binaural monitor unavailable');
    this.node.port.postMessage({type:'meter-enabled',enabled});
  }
  setHeadYaw(degrees:number):void{
    if(this.disposed||!Number.isFinite(degrees))throw new RangeError('Invalid head yaw');
    this.node.port.postMessage({type:'head-yaw',degrees});
  }
  dispose():void{
    if(this.disposed)return;
    this.disposed=true;
    this.meterBridge?.clear();
    this.meterBridge=null;
    this.onMeter=null;
    this.disconnectSpatialBus();
    for(const channel of [...this.attachedStems.keys()])this.disconnectStem(channel);
    this.disconnectHeadphones();
    try{this.node.disconnect();}catch{/* already disconnected */}
    try{this.node.port.close();}catch{/* already closed */}
  }
}
