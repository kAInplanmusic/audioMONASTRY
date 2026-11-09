/**
 * Local 12/16/24/32 mono-stem -> stereo headphone monitor worklet.
 * Input i is canonical spatial speaker channel i; never connect a stereo mix
 * to these inputs. This is an approximate ITD/ILD fallback, NOT measured HRTF.
 */
import {VirtualBinauralRenderer} from '../../core/spatial/v2/virtualBinauralRenderer';
import type {ClubPlan} from '../../core/spatial/v2/clubPlanner';
import {SpatialPcmTransport,type SpatialPcmShared} from '../../core/spatial/v2/spatialPcmTransport';

const Base: typeof AudioWorkletProcessor =
  (typeof AudioWorkletProcessor === 'undefined'
    ? class {port={onmessage:null as ((e:MessageEvent)=>void)|null,postMessage:(_m:unknown)=>{}};}
    : AudioWorkletProcessor) as typeof AudioWorkletProcessor;

export class VirtualBinauralMonitorProcessor extends Base {
  private renderer:VirtualBinauralRenderer|null=null;
  private sharedPcm:SpatialPcmTransport|null=null;
  private channelCount=0;
  private readonly silent=new Float32Array(128);
  private inputs:Float32Array[]=[];
  private meterPeak=new Float32Array(0);
  private meterEnergy=new Float32Array(0);
  private meterFrames=0;
  private meterEnabled=false;
  private readonly meterIntervalFrames=2048;
  constructor(){
    super();
    this.port.onmessage=(e:MessageEvent)=>{
      const m=e.data;
      if(m?.type==='configure'){
        try{
          const plan=m.plan as ClubPlan;
          const renderer=new VirtualBinauralRenderer(plan,typeof sampleRate==='number'?sampleRate:48000,128);
          this.sharedPcm=null;
          this.renderer=renderer;
          this.channelCount=renderer.channelCount;
          this.inputs=Array.from({length:this.channelCount},()=>this.silent);
          this.meterPeak=new Float32Array(this.channelCount);
          this.meterEnergy=new Float32Array(this.channelCount);
          this.meterFrames=0;
          this.port.postMessage({type:'ready',channels:this.channelCount});
        }catch(err){
          this.renderer=null;this.channelCount=0;this.inputs=[];
          this.meterPeak=new Float32Array(0);this.meterEnergy=new Float32Array(0);this.meterFrames=0;
          this.port.postMessage({type:'error',reason:String(err)});
        }
      }else if(m?.type==='spatial-pcm-transport'){
        try{
          const shared=m.shared as SpatialPcmShared;
          if(shared.sampleRate!==(typeof sampleRate==='number'?sampleRate:48000)||
            shared.channels!==this.channelCount||!this.renderer)
            throw new RangeError('Spatial monitor PCM format mismatch');
          this.sharedPcm=new SpatialPcmTransport(shared);
          this.port.postMessage({type:'spatial-pcm-ready',channels:this.channelCount});
        }catch(e){
          this.sharedPcm=null;
          this.port.postMessage({type:'spatial-pcm-error',reason:String(e)});
        }
      }else if(m?.type==='spatial-pcm-disable'){
        this.sharedPcm=null;
      }else if(m?.type==='head-yaw'){
        try{this.renderer?.setHeadYaw(m.degrees);}catch{/* invalid orientation: retain prior */}
      }else if(m?.type==='meter-enabled'){
        this.meterEnabled=m.enabled===true;
        this.meterFrames=0;
        this.meterPeak.fill(0);this.meterEnergy.fill(0);
      }else if(m?.type==='reset'){
        this.renderer?.reset();
      }
    };
  }
  process(inputs:Float32Array[][],outputs:Float32Array[][]):boolean{
    const l=outputs[0]?.[0],r=outputs[0]?.[1];
    if(!l||!r)return true;
    l.fill(0);r.fill(0);
    if(!this.renderer||l.length!==128||r.length!==128)return true;
    const shared=this.sharedPcm?.consume();
    for(let i=0;i<this.channelCount;i++)this.inputs[i]=shared?.[i]??(inputs[i]?.[0]?.length===128?inputs[i][0]:this.silent);
    if(this.meterEnabled){
      for(let c=0;c<this.channelCount;c++){
        const pcm=this.inputs[c];let peak=this.meterPeak[c],energy=this.meterEnergy[c];
        for(let j=0;j<pcm.length;j++){
          const x=Number.isFinite(pcm[j])?pcm[j]:0;
          const a=Math.abs(x);if(a>peak)peak=a;
          energy+=x*x;
        }
        this.meterPeak[c]=peak;this.meterEnergy[c]=energy;
      }
      this.meterFrames+=128;
      if(this.meterFrames>=this.meterIntervalFrames){
        const peak=Array.from(this.meterPeak);
        const rms=Array.from(this.meterEnergy,v=>Math.sqrt(v/this.meterFrames));
        this.port.postMessage({type:'spatial-meter',channels:this.channelCount,
          frameLength:this.meterFrames,peak,rms});
        this.meterFrames=0;this.meterPeak.fill(0);this.meterEnergy.fill(0);
      }
    }
    const stereo=this.renderer.process(this.inputs);
    l.set(stereo[0]);r.set(stereo[1]);
    return true;
  }
}
if(typeof registerProcessor!=='undefined')
  registerProcessor('virtual-binaural-monitor',VirtualBinauralMonitorProcessor as any);
