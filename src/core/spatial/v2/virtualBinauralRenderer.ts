import type {ClubPlan} from './clubPlanner';
import {speakerHeadDirection} from './binauralGeometry';

/**
 * Channel-aware binaural downmix of an actual planar 12/16/24/32-channel
 * spatial PCM block. Each speaker has its own position relative to the
 * listener, rather than attempting to reconstruct positions from stereo.
 *
 * This is an explicitly approximate ITD/ILD headphone renderer, NOT a measured
 * HRTF or a substitute for a calibrated SOFA/HRIR dataset.
 * Construct on the control thread, reuse per audio block.
 */
export class VirtualBinauralRenderer {
  readonly channelCount:number;
  private readonly channels:readonly {channel:number;az:number;distance:number}[];
  private readonly delayLines:Float32Array[];
  private readonly writePositions:Uint16Array;
  private readonly output:[Float32Array,Float32Array];
  private readonly sampleRate:number;
  private headYaw=0;
  private readonly delayCapacity=256;
  constructor(plan:ClubPlan,sampleRate=48000,blockSize=128){
    if(!Number.isFinite(sampleRate)||sampleRate<8000||sampleRate>192000)
      throw new RangeError('Invalid sample rate');
    if(!Number.isSafeInteger(blockSize)||blockSize<1||blockSize>4096)
      throw new RangeError('Invalid block size');
    this.channelCount=plan.satellites.length;
    if(![12,16,24,32].includes(this.channelCount))throw new RangeError('Invalid speaker count');
    const used=new Set<number>();
    const reserved=new Set(plan.satellites.map(s=>s.outputChannel).filter((n):n is number=>n!==null&&n!==undefined));
    let fallback=0;
    this.channels=plan.satellites.map((s)=>{
      while(reserved.has(fallback)||used.has(fallback))fallback++;
      const channel=s.outputChannel??fallback;
      if(!Number.isSafeInteger(channel)||channel<0||channel>=this.channelCount||used.has(channel))
        throw new RangeError('Invalid speaker channel mapping');
      used.add(channel);
      const direction=speakerHeadDirection(s.positionM,plan.listenerM);
      return {channel,az:direction.azimuthDeg,distance:direction.distanceM};
    });
    this.sampleRate=sampleRate;
    this.delayLines=Array.from({length:this.channelCount},()=>new Float32Array(this.delayCapacity));
    this.writePositions=new Uint16Array(this.channelCount);
    this.output=[new Float32Array(blockSize),new Float32Array(blockSize)];
  }
  setHeadYaw(degrees:number):void{
    if(!Number.isFinite(degrees))throw new RangeError('Invalid head yaw');
    this.headYaw=((degrees+180)%360+360)%360-180;
  }
  /** Reuses output buffers; consumer must read before next process(). */
  process(input:readonly Float32Array[]):readonly [Float32Array,Float32Array]{
    if(input.length!==this.channelCount||input.some(ch=>ch.length!==this.output[0].length))
      throw new RangeError('Invalid PCM block shape');
    const [left,right]=this.output;left.fill(0);right.fill(0);
    for(const s of this.channels){
      const pcm=input[s.channel],line=this.delayLines[s.channel];
      let w=this.writePositions[s.channel];
      const rad=(s.az-this.headYaw)*Math.PI/180;
      const pan=Math.sin(rad);
      const gain=1/Math.sqrt(this.channelCount);
      const lg=Math.sqrt((1-pan)*0.5)*gain;
      const rg=Math.sqrt((1+pan)*0.5)*gain;
      const itd=Math.min(this.delayCapacity-1,Math.round(Math.abs(pan)*0.00063*this.sampleRate));
      const ld=pan>0?itd:0,rd=pan<0?itd:0;
      for(let i=0;i<pcm.length;i++){
        const x=pcm[i];
        line[w]=Number.isFinite(x)?x:0;
        left[i]+=line[(w-ld+this.delayCapacity)%this.delayCapacity]*lg;
        right[i]+=line[(w-rd+this.delayCapacity)%this.delayCapacity]*rg;
        w=(w+1)%this.delayCapacity;
      }
      this.writePositions[s.channel]=w;
    }
    return this.output;
  }
  reset():void{for(const line of this.delayLines)line.fill(0);this.writePositions.fill(0);}
}
