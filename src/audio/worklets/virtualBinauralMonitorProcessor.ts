/**
 * Local 12/16/24/32 mono-stem -> stereo headphone monitor worklet.
 * Input i is canonical spatial speaker channel i; never connect a stereo mix
 * to these inputs. This is an approximate ITD/ILD fallback, NOT measured HRTF.
 */
import {VirtualBinauralRenderer} from '../../core/spatial/v2/virtualBinauralRenderer';
import type {ClubPlan} from '../../core/spatial/v2/clubPlanner';

const Base: typeof AudioWorkletProcessor =
  (typeof AudioWorkletProcessor === 'undefined'
    ? class {port={onmessage:null as ((e:MessageEvent)=>void)|null,postMessage:(_m:unknown)=>{}};}
    : AudioWorkletProcessor) as typeof AudioWorkletProcessor;

export class VirtualBinauralMonitorProcessor extends Base {
  private renderer:VirtualBinauralRenderer|null=null;
  private channelCount=0;
  private readonly silent=new Float32Array(128);
  private readonly inputs:Float32Array[]=Array.from({length:32},()=>this.silent);
  constructor(){
    super();
    this.port.onmessage=(e:MessageEvent)=>{
      const m=e.data;
      if(m?.type==='configure'){
        try{
          const plan=m.plan as ClubPlan;
          const renderer=new VirtualBinauralRenderer(plan,sampleRate,128);
          this.renderer=renderer;
          this.channelCount=renderer.channelCount;
          this.port.postMessage({type:'ready',channels:this.channelCount});
        }catch(err){
          this.renderer=null;this.channelCount=0;
          this.port.postMessage({type:'error',reason:String(err)});
        }
      }else if(m?.type==='head-yaw'){
        try{this.renderer?.setHeadYaw(m.degrees);}catch{/* invalid orientation: retain prior */}
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
    for(let i=0;i<this.channelCount;i++)this.inputs[i]=inputs[i]?.[0]?.length===128?inputs[i][0]:this.silent;
    const stereo=this.renderer.process(this.inputs.slice(0,this.channelCount));
    l.set(stereo[0]);r.set(stereo[1]);
    return true;
  }
}
if(typeof registerProcessor!=='undefined')
  registerProcessor('virtual-binaural-monitor',VirtualBinauralMonitorProcessor as any);
