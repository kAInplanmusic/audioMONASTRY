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
 it('mutes DJ Main plus selected PFL and stays muted on PFL release', () => {
  const { state } = fixture();
  state.setMonitorSource('MAIN');
  state.setChannelPfl('channel3', true);
  const withCue = state.getPlan();
  expect(withCue.source).toBe('MIX');
  expect(withCue.mainMonitorGain).toBe(1);
  expect(withCue.cueGain).toBe(1);
  expect(withCue.cueTracks.channel3).toBe(1);
  expect(withCue.cueTracks.channel1).toBe(0);

  state.setLocalMonitorGain(0);
  expect(state.getPlan()).toMatchObject({ source: 'MIX', mainMonitorGain: 0, cueGain: 0 });

  state.setChannelPfl('channel3', false);
  expect(state.getPlan()).toMatchObject({ source: 'MAIN', mainMonitorGain: 0, cueGain: 0 });
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
