/**
 * spatialMONK virtual audio interface: deterministic 32-channel DSP sink.
 * No physical output, no ALSA registration. Connect via audio graph tap;
 * never infer meters from intended geometry or UI animation.
 */
export type VirtualChannelCount = 12|16|24|32;
export interface ChannelMeter { channel:number; peak:number; rms:number; active:boolean; clipped:boolean }
export interface VirtualFrame { sequence:number; sampleRate:number; frameLength:number; channels:ChannelMeter[] }
export interface VirtualInterfaceOptions { channels:VirtualChannelCount; sampleRate?:number; thresholdDbfs?:number }
export class VirtualSpatialInterface {
  readonly channels:VirtualChannelCount;
  readonly sampleRate:number;
  private readonly threshold:number;
  private sequence=0;
  constructor(opts:VirtualInterfaceOptions) {
    if(![12,16,24,32].includes(opts.channels))throw new RangeError('Unsupported channels');
    this.channels=opts.channels;
    this.sampleRate=opts.sampleRate??48000;
    if(!Number.isFinite(this.sampleRate)||this.sampleRate<8000||this.sampleRate>192000)
      throw new RangeError('Invalid sample rate');
    const db=opts.thresholdDbfs??-72;
    if(!Number.isFinite(db)||db>0||db< -160)throw new RangeError('Invalid meter threshold');
    this.threshold=Math.pow(10,db/20);
  }
  /** Accepts one Float32Array per physical satellite channel, same block length.
   * Metering MUST run on the post-render/post-routing signal. Never use as
   * audio-thread UI callback; aggregate/throttle outside the AudioWorklet.
   */
  process(block:readonly Float32Array[]):VirtualFrame {
    if(block.length!==this.channels)throw new RangeError('Channel mismatch');
    const len=block[0]?.length??0;
    if(!len||block.some(ch=>ch.length!==len))throw new RangeError('Frame mismatch');
    const channels=block.map((samples,i)=>{
      let peak=0,sum=0,clipped=false;
      for(let j=0;j<len;j++){
        const v=samples[j];
        if(!Number.isFinite(v))throw new RangeError('Non-finite sample');
        const abs=Math.abs(v);
        peak=Math.max(peak,abs);sum+=v*v;
        if(abs>=1)clipped=true;
      }
      return {channel:i,peak,rms:Math.sqrt(sum/len),active:peak>=this.threshold,clipped};
    });
    return {sequence:++this.sequence,sampleRate:this.sampleRate,frameLength:len,channels};
  }
}
export interface VirtualSpeakerView {id:string;channel:number; x:number;y:number; peak:number;rms:number;active:boolean;clipped:boolean}
export function mapVirtualMeters(frame:VirtualFrame, speakers:readonly {
 id:string;positionM:{x:number;y:number};outputChannel:number|null
}[]):VirtualSpeakerView[] {
 const seen=new Set<number>();
 return speakers.map(sp=>{
   if(sp.outputChannel===null)throw new Error('Unmapped speaker '+sp.id);
   const ch=sp.outputChannel;
   if(!Number.isSafeInteger(ch)||ch<0||ch>=frame.channels.length||seen.has(ch))
     throw new Error('Invalid or duplicated output channel '+ch);
   seen.add(ch);
   const meter=frame.channels[ch];
   return {id:sp.id,channel:ch,x:sp.positionM.x,y:sp.positionM.y,
     peak:meter.peak,rms:meter.rms,active:meter.active,clipped:meter.clipped};
 });
}
