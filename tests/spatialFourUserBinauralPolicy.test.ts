import {describe,it,expect} from 'vitest';
import {defaultMonitorPlan,MONITOR_USERS,planMonitorRouting} from '../src/core/audio/monitorRouting';
import {decideBinauralMonitor} from '../src/core/spatial/v2/monitorBinauralPolicy';
describe('four local headphone binaural decisions',()=>{
 it('enables each user independently without mutating routing plans',()=>{
  const plans=MONITOR_USERS.map((mon,i)=>planMonitorRouting({
    mon,source:(['MAIN','MON','PLUGIN','MIX'] as const)[i],
    baseMix:{},track:'channel1'
  }));
  const before=JSON.stringify(plans);
  const decisions=plans.map((plan,i)=>decideBinauralMonitor(plan,{
    user:MONITOR_USERS[i],requested:i!==2,spatialActive:true,
    headphonesAvailable:true,hrtfReady:true
  }));
  expect(decisions.map(d=>d.enabled)).toEqual([true,true,false,true]);
  expect(decisions.map(d=>d.monitorSource)).toEqual(['MAIN','MON','PLUGIN','MIX']);
  expect(JSON.stringify(plans)).toBe(before);
 });
 it('fails safely if HRTF or spatial or headphones unavailable',()=>{
  const plan=defaultMonitorPlan('MON1');
  for(const key of ['spatialActive','headphonesAvailable','hrtfReady'] as const){
    const pref={user:'MON1' as const,requested:true,spatialActive:true,headphonesAvailable:true,hrtfReady:true};
    pref[key]=false;
    expect(decideBinauralMonitor(plan,pref).enabled).toBe(false);
  }
 });
 it('rejects mismatched user and monitor bus',()=>{
  expect(()=>decideBinauralMonitor(defaultMonitorPlan('MON1'),{
    user:'MON2',requested:true,spatialActive:true,headphonesAvailable:true,hrtfReady:true
  })).toThrow();
 });
});
