/** Synthetic full mixer + real packet/worker handoff comparison; not an App proof. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { BackendMainMixer } from '../../server/backendMainMixer';
import { BackendMainWorkerClient, type WorkerBlock } from '../../server/backendMainWorkerClient';
import { mainThreadCpu } from '../../server/backendMainCpu';
import type { MainProcessorSnapshot } from '../../server/backendMainProcessors';
const directory = process.env.R14_OVERHEAD_DIR!; if (!directory) throw new Error('Fresh R14_OVERHEAD_DIR required'); mkdirSync(directory);
const ids = ['drop','song','drumsampler','syntisampler','instru','voice','sound','stem'];
const parameters = {eq:{low:18,mid:-12,high:12},dsp:{cutoff:250,resonance:.8,depth:1,drive:.8,oversampling:1},effect:{wet:1,feedback:.6,rate:1,depth:.8},spatial:{pan:.8,width:.3},mixer:{sources:Object.fromEntries(ids.map(id=>[id,{gain:.4,sendEffect:1,sendSpatial:1}]))},master:{gain:.4}};
const snapshot: MainProcessorSnapshot = Object.fromEntries(Object.entries(parameters).map(([id,parameters])=>[id,{active:true,parameters,epoch:1}]));
const pcm=Buffer.alloc(960*6);for(let i=0;i<960;i++){pcm.writeIntLE(Math.round(.1*Math.sin(i*.13)*8388608),i*6,3);pcm.writeIntLE(Math.round(.1*Math.cos(i*.1)*8388608),i*6+3,3);}
const quantiles=(a:number[])=>{a.sort((a,b)=>a-b);return{count:a.length,p50:a[Math.floor(a.length*.5)],p95:a[Math.ceil(a.length*.95)-1],max:a.at(-1)}};
const cpuDelta=(a:ReturnType<typeof mainThreadCpu>,b:ReturnType<typeof mainThreadCpu>)=>a&&b?{userTicks:b.userTicks-a.userTicks,systemTicks:b.systemTicks-a.systemTicks}:null;
async function run(mode:'direct'|'worker'){
 const records:any[]=[],render:number[]=[],errors:string[]=[];let worker:BackendMainWorkerClient|undefined,metric:any;
 const mixer=mode==='direct'?new BackendMainMixer(96000,()=>snapshot):null;
 if(mode==='worker'){
  worker=new BackendMainWorkerClient(96000,{block:(b:WorkerBlock)=>{if(b.startFrame>=192000)render.push(b.renderMs);worker!.ack(b.pcm.byteLength);},metrics:v=>{metric=v;},error:e=>errors.push(String(e))});
  await worker.ready;worker.snapshot(snapshot);
 }
 const origin=performance.now();let packet=0,nextMetric=2000;let feeding=false;
 const timer=setInterval(()=>{if(feeding)return;feeding=true;try{
  const elapsed=performance.now()-origin;const due=Math.floor(elapsed/10);
  while(packet<due){const frame=96000+packet*960;for(const id of ids){if(worker)void worker.enqueue(id,packet,frame,pcm).catch(e=>errors.push(String(e)));else mixer!.enqueue(id,packet,frame,pcm);}packet++;}
  if(mixer){const dueFrame=Math.floor(elapsed/100)*9600;while(mixer.frame<dueFrame){const start=performance.now();const b=mixer.mix(9600);if(b.startFrame>=192000)render.push(performance.now()-start);}}
  if(elapsed>=nextMetric){records.push({elapsedMs:elapsed,main:mainThreadCpu(),worker:metric});nextMetric+=1000;}
 }catch(error){errors.push(String(error));}finally{feeding=false;}},2);
 await new Promise(resolve=>setTimeout(resolve,12200));clearInterval(timer);await new Promise(resolve=>setTimeout(resolve,100));worker?.close();
 const first=records[0],last=records.at(-1);return{mode,packetsPerSource:packet,errors,renderMs:quantiles(render),records,measuredMs:last.elapsedMs-first.elapsedMs,mainCpuTicks:cpuDelta(first.main,last.main),workerCpuTicks:mode==='worker'?cpuDelta(first.worker?.cpu,last.worker?.cpu):null};
}
const results=[];for(const mode of ['direct','worker']as const)results.push(await run(mode));
writeFileSync(`${directory}/overhead.json`,JSON.stringify({scope:'Synthetic 8-source full mixer,6processors,800input packets/s +10mixed blocks/s; transfer includes safe slab materialization, excludes WS/auth/browser/SRC/codec',clockTicksPerSecond:'host getconf CLK_TCK required',results},null,2));
console.log(JSON.stringify(results.map(({records,...summary})=>({...summary,recordCount:records.length}))));
if(results.some(r=>r.errors.length))process.exitCode=1;
