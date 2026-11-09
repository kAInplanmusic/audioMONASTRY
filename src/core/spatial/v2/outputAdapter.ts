/**
 * Hardware-agnostic spatial output contract.
 * No AudioWorklet, browser or USB-specific assumptions leak into DSP.
 * An adapter is activated only after explicit channel and clock validation.
 */
export type SpatialOutputTransport='virtual'|'alsa'|'pipewire'|'network'|'custom';
export type SpatialChannelCount=12|16|24|32;
export interface SpatialOutputCapabilities {
  id:string;
  label:string;
  transport:SpatialOutputTransport;
  maxDiscreteChannels:number;
  supportedSampleRates:readonly number[];
  sampleFormats:readonly ('f32'|'s24'|'s32')[];
  supportsExclusive:boolean;
  clockDomain:string;
  online:boolean;
}
export interface SpatialOutputConfig {
  logicalChannels:SpatialChannelCount;
  sampleRate:number;
  blockSize:number;
  /** Zero-based hardware channel for each logical satellite. */
  channelMap:readonly number[];
  deviceId:string;
}
export interface SpatialOutputAdapter {
  readonly transport:SpatialOutputTransport;
  probe():Promise<SpatialOutputCapabilities[]>;
  open(config:SpatialOutputConfig):Promise<void>;
  /** Exactly one block, planar Float32Array samples, one per logical channel. */
  write(block:readonly Float32Array[]):Promise<void>;
  close():Promise<void>;
}
export function validateSpatialOutput(config:SpatialOutputConfig,cap:SpatialOutputCapabilities):void {
  if(!cap.online||cap.id!==config.deviceId)throw new Error('Device unavailable/mismatched');
  if(![12,16,24,32].includes(config.logicalChannels))throw new Error('Invalid satellite count');
  if(!Number.isSafeInteger(config.blockSize)||config.blockSize<16||config.blockSize>8192)
    throw new Error('Invalid block size');
  if(!cap.supportedSampleRates.includes(config.sampleRate))throw new Error('Unsupported sample rate');
  if(!cap.sampleFormats.includes('f32'))throw new Error('Float PCM unsupported by this adapter');
  if(config.channelMap.length!==config.logicalChannels)throw new Error('Incomplete channel map');
  const unique=new Set<number>();
  for(const ch of config.channelMap){
    if(!Number.isSafeInteger(ch)||ch<0||ch>=cap.maxDiscreteChannels||unique.has(ch))
      throw new Error('Invalid or colliding output channel');
    unique.add(ch);
  }
}
export function createIdentitySpatialOutputMap(channels:SpatialChannelCount):number[]{
  return Array.from({length:channels},(_,i)=>i);
}
export class VirtualOutputAdapter implements SpatialOutputAdapter {
  readonly transport='virtual' as const;
  private active:SpatialOutputConfig|null=null;
  private sequence=0;
  private readonly id:string;
  private lastBlock:Float32Array[]=[];
  constructor(id='spatial-virtual-32'){this.id=id;}
  async probe():Promise<SpatialOutputCapabilities[]>{
    return [{id:this.id,label:'spatialMONK Virtual 32',transport:'virtual',
      maxDiscreteChannels:32,supportedSampleRates:[44100,48000,96000],
      sampleFormats:['f32'],supportsExclusive:false,clockDomain:'virtual',
      online:true}];
  }
  async open(config:SpatialOutputConfig):Promise<void>{
    const [cap]=await this.probe();
    validateSpatialOutput(config,cap);
    this.active={...config,channelMap:[...config.channelMap]};
    this.sequence=0;this.lastBlock=[];
  }
  async write(block:readonly Float32Array[]):Promise<void>{
    if(!this.active)throw new Error('Output not open');
    if(block.length!==this.active.logicalChannels||
      block.some(ch=>ch.length!==this.active!.blockSize))
      throw new Error('Invalid PCM frame dimensions');
    // Prototype: copy to prevent a reused AudioWorklet ring buffer
    // from mutating the observed frame. Replace with a bounded RT ring.
    this.lastBlock=block.map(ch=>{
      const copy=new Float32Array(ch.length);
      for(let i=0;i<ch.length;i++){
        if(!Number.isFinite(ch[i]))throw new Error('Nonfinite PCM sample');
        copy[i]=ch[i];
      }
      return copy;
    });
    this.sequence++;
  }
  snapshot():{sequence:number;channels:readonly Float32Array[]}{
    return {sequence:this.sequence,channels:this.lastBlock};
  }
  async close():Promise<void>{this.active=null;this.lastBlock=[];}
}
/**
 * The bridge owns the active device. Switching devices must be explicit,
 * stop/close the previous adapter, validate new capabilities and channel
 * mapping, then open the next. No automatic fallback to DJ stereo.
 */
export class SpatialOutputRouter {
  private adapter:SpatialOutputAdapter|null=null;
  async activate(adapter:SpatialOutputAdapter,config:SpatialOutputConfig):Promise<void>{
    const capabilities=await adapter.probe();
    const cap=capabilities.find(x=>x.id===config.deviceId);
    if(!cap)throw new Error('Selected device not found');
    validateSpatialOutput(config,cap);
    if(this.adapter){await this.adapter.close();this.adapter=null;}
    await adapter.open(config);
    this.adapter=adapter;
  }
  async send(block:readonly Float32Array[]):Promise<void>{
    if(!this.adapter)throw new Error('No active spatial output');
    await this.adapter.write(block);
  }
  async stop():Promise<void>{
    if(this.adapter)await this.adapter.close();
    this.adapter=null;
  }
}
