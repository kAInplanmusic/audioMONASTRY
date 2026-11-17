import {describe,expect,it,vi} from 'vitest';
import {MonitorRoutingState} from '../src/audio/monitorRoutingFacade';
import type {V2LiveSink} from '../src/core/audio/backends/V2LiveSink';
import type {MonitorRoutingDeps} from '../src/audio/monitorRoutingFacade';

function fixture(){
 const sink={isConnected:true,setMonitorRouting:vi.fn()} as unknown as V2LiveSink;
 const deps:MonitorRoutingDeps={getSink:()=>sink,ensureInitialized:()=>{},getCount:()=>4};
 return {state:new MonitorRoutingState(deps),sink};
}
describe('local headphone gain parity across monitor modes',()=>{
 it.each(['MAIN','MON','PLUGIN','MIX'] as const)('%s obeys local gain and does not change routing policy',mode=>{
  const {state,sink}=fixture();
  state.setMonitorSource(mode,'MON2','channel2');
  const before=state.getPlan();
  state.setLocalMonitorGain(0.25);
  const after=state.getPlan();
  expect(after.source).toBe(mode);
  expect(after.cueTracks).toEqual(before.cueTracks);
  expect(after.mainMonitorGain).toBeCloseTo(before.mainMonitorGain*0.25);
  expect(after.cueGain).toBeCloseTo(before.cueGain*0.25);
  expect(sink.setMonitorRouting).toHaveBeenCalled();
 });
 it('mutes PFL and does not unmute it on source change',()=>{
  const {state}=fixture();
  state.setChannelPfl('channel3',true);
  state.setLocalMonitorGain(0);
  expect(state.getPlan().source).toBe('MON');
  expect(state.getPlan().mainMonitorGain).toBe(0);
  expect(state.getPlan().cueGain).toBe(0);
  state.setChannelPfl('channel3',false);
  expect(state.getPlan().mainMonitorGain).toBe(0);
 });
 it('keeps each user local state independent',()=>{
  const a=fixture().state,b=fixture().state;
  a.setMonitorSource('MON','MON1');b.setMonitorSource('MIX','MON4','channel8');
  a.setLocalMonitorGain(0);
  b.setLocalMonitorGain(0.8);
  expect(a.getPlan().cueGain).toBe(0);
  expect(b.getPlan().cueGain).toBeCloseTo(0.8);
 });
});
