/**
 * Bounded SPSC spatial PCM transport between two AudioWorklets.
 * One producer, one consumer, same sample-rate and 128-frame quantum.
 * Latest-block semantics: stale/contended reads fail closed to silence.
 * No allocation or MessagePort PCM transfer in render callbacks.
 */
export interface SpatialPcmShared {
  control:SharedArrayBuffer;
  pcm:SharedArrayBuffer;
  channels:12|16|24|32;
  sampleRate:number;
}
const FRAMES=128;
const SLOTS=3;
const HEADER=4; // published sequence, slot0 guard, slot1 guard, slot2 guard
export function createSpatialPcmShared(channels:12|16|24|32,sampleRate:number):SpatialPcmShared {
  if(![12,16,24,32].includes(channels)||!Number.isFinite(sampleRate)||sampleRate<8000||sampleRate>192000)
    throw new RangeError('Invalid spatial PCM transport format');
  if(typeof SharedArrayBuffer==='undefined')throw new Error('SharedArrayBuffer unavailable');
  return {channels,sampleRate,control:new SharedArrayBuffer(HEADER*4),
    pcm:new SharedArrayBuffer(SLOTS*channels*FRAMES*4)};
}
export class SpatialPcmTransport {
  readonly channels:number;
  readonly sampleRate:number;
  private readonly state:Int32Array;
  private readonly pcm:Float32Array;
  private writeSequence=0;
  private readSequence=0;
  private readonly zero=new Float32Array(FRAMES);
  private readonly view:Float32Array[];
  constructor(shared:SpatialPcmShared){
    const {channels,sampleRate,control,pcm}=shared;
    if(![12,16,24,32].includes(channels)||!Number.isFinite(sampleRate)||
      control.byteLength!==HEADER*4||pcm.byteLength!==SLOTS*channels*FRAMES*4)
      throw new RangeError('Invalid shared spatial PCM buffer');
    this.channels=channels;this.sampleRate=sampleRate;
    this.state=new Int32Array(control);this.pcm=new Float32Array(pcm);
    this.view=Array.from({length:channels},()=>new Float32Array(FRAMES));
  }
  /** Producer only. Must be called once per source-engine render quantum. */
  publish(block:readonly Float32Array[]):void{
    if(block.length!==this.channels||block.some(ch=>ch.length!==FRAMES))
      throw new RangeError('Invalid spatial PCM shape');
    const seq=this.writeSequence+1;
    const slot=seq%SLOTS;
    const guard=slot+1;
    Atomics.store(this.state,guard,seq*2-1); // write in progress
    const base=slot*this.channels*FRAMES;
    for(let c=0;c<this.channels;c++){
      const input=block[c],offset=base+c*FRAMES;
      for(let i=0;i<FRAMES;i++)this.pcm[offset+i]=Number.isFinite(input[i])?input[i]:0;
    }
    Atomics.store(this.state,guard,seq*2);
    Atomics.store(this.state,0,seq);
    this.writeSequence=seq;
  }
  /** Consumer only. Copies latest completed block, or returns silence if unavailable.
   * Duplicate reads do not replay old audio.
   */
  consume():readonly Float32Array[]{
    const seq=Atomics.load(this.state,0);
    if(seq===0||seq===this.readSequence){this.clear();return this.view;}
    const slot=seq%SLOTS,guard=slot+1;
    if(Atomics.load(this.state,guard)!==seq*2){this.clear();return this.view;}
    const base=slot*this.channels*FRAMES;
    for(let c=0;c<this.channels;c++){
      const output=this.view[c],offset=base+c*FRAMES;
      for(let i=0;i<FRAMES;i++)output[i]=this.pcm[offset+i];
    }
    if(Atomics.load(this.state,guard)!==seq*2||Atomics.load(this.state,0)!==seq){
      this.clear();return this.view;
    }
    this.readSequence=seq;
    return this.view;
  }
  private clear():void{for(const out of this.view)out.set(this.zero);}
}
