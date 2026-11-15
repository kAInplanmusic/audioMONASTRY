import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { BackendMainProcessors: Before } = await import(pathToFileURL(process.env.R14_BASELINE_PROCESSORS!).href);
import { BackendMainProcessors as After } from '../../server/backendMainProcessors';
let checked = 0;
const ids = ['drop','song','drumsampler','syntisampler','instru','voice','sound','stem'];
for (const rate of [48000,96000,192000]) {
 const before = new Before(rate), after = new After(rate);
 for (let step = 0; step < 24; step++) {
  const count = [4,6,8,0][step % 4], frames = [128,480,9600][Math.floor(step / 4) % 3];
  const sources = new Map(ids.slice(0,count).map((id,j) => [id,Float32Array.from({length:frames*2},(_,i)=>.21*Math.sin(i*.13+j+step))]));
  const cfg:any={};
  for(const id of ['eq','dsp','effect','spatial','mixer','master']) cfg[id]={active:step%5!==0,epoch:Math.floor(step/7),parameters:{}};
  cfg.eq.parameters={low:6,mid:-3,high:2,targets:step%2?[]:['drop']};
  cfg.dsp.parameters={cutoff:2200,resonance:.4,depth:.6,drive:.2,oversampling:step%2?1:2};
  cfg.effect.parameters={wet:.6,depth:.5,feedback:.4,rate:.3,bits:8};
  cfg.spatial.parameters={pan:.4,width:.6};
  cfg.master.parameters={gain:step%3?.4:1.3};
  cfg.mixer.parameters={sources:Object.fromEntries(ids.map((id,j)=>[id,{gain:.4,pan:step%2?.2:0,mute:step%6===0&&j===0,sendEffect:.5,sendSpatial:.3}]))};
  const a=before.process(sources,cfg,frames),b=after.process(sources,cfg,frames);
  assert.deepEqual(b,a,`sample mismatch ${rate}/${step}`);
  assert.deepEqual(after.lastReport,before.lastReport,`report mismatch ${rate}/${step}`);checked++;
 }
}
console.log(JSON.stringify({status:'pass',exactFloat32OutputAndStageReports:true,blocks:checked,rates:[48000,96000,192000],sourceCounts:[0,4,6,8],frames:[128,480,9600],includesModeEpochAndParameterChanges:true}));
