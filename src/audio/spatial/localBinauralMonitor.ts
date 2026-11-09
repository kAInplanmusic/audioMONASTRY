import type {ClubPlan} from '../../core/spatial/v2/clubPlanner';
/**
 * Per-user local spatial monitor branch. Connect actual mono spatial stems to
 * input(channel). Does NOT attach to V2LiveSink's already-summed stereo output.
 * Caller owns user/monitor-source authorization and must route the correct
 * selected stems. No implicit connection to the global main or Visuals Out.
 */
export class LocalBinauralMonitor {
  readonly node:AudioWorkletNode;
  readonly channelCount:number;
  private disposed=false;
  private ready=false;
  private readonly attachedStems=new Map<number,AudioNode>();
  private headphoneDestination:AudioNode|null=null;
  private constructor(node:AudioWorkletNode,channels:number){
    this.node=node;this.channelCount=channels;
  }
  static async create(ctx:AudioContext,plan:ClubPlan):Promise<LocalBinauralMonitor>{
    if(![12,16,24,32].includes(plan.satellites.length))throw new RangeError('Invalid channel count');
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
            clearTimeout(timeout);monitor.ready=true;resolve();
          }else if(e.data?.type==='error'){
            clearTimeout(timeout);reject(new Error(String(e.data.reason)));
          }
        };
        node.port.postMessage({type:'configure',plan});
      });
      return monitor;
    }catch(e){monitor.dispose();throw e;}
  }
  /** Connect a mono stem at canonical spatial output index. */
  connectStem(source:AudioNode,channel:number):void{
    if(this.disposed||!this.ready)throw new Error('Binaural monitor unavailable');
    if(!Number.isSafeInteger(channel)||channel<0||channel>=this.channelCount)
      throw new RangeError('Invalid spatial channel');
    if(source.context!==this.node.context)throw new Error('AudioContext mismatch');
    const previous=this.attachedStems.get(channel);
    if(previous)try{previous.disconnect(this.node,0,channel);}catch{/* already detached */}
    source.connect(this.node,0,channel);
    this.attachedStems.set(channel,source);
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
  setHeadYaw(degrees:number):void{
    if(this.disposed||!Number.isFinite(degrees))throw new RangeError('Invalid head yaw');
    this.node.port.postMessage({type:'head-yaw',degrees});
  }
  dispose():void{
    if(this.disposed)return;
    this.disposed=true;
    for(const channel of [...this.attachedStems.keys()])this.disconnectStem(channel);
    this.disconnectHeadphones();
    try{this.node.disconnect();}catch{/* already disconnected */}
    try{this.node.port.close();}catch{/* already closed */}
  }
}
