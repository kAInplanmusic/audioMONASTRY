import {describe,it,expect} from 'vitest';
import {planClubSpeakers} from '../src/core/spatial/v2/clubPlanner';
import {assignSpatialOutputChannels} from '../src/core/spatial/v2/channelMapping';
import {mapVirtualMeters,VirtualSpatialInterface} from '../src/core/spatial/v2/virtualInterface';
import {VirtualBinauralRenderer} from '../src/core/spatial/v2/virtualBinauralRenderer';
describe('canonical spatial channel mapping',()=>{
 it.each([12,16,24,32] as const)('maps %i speakers once and does not mutate plan',n=>{
  const plan=planClubSpeakers({widthM:8,depthM:8,satellites:n,
    fixedSpeakers:[{id:'fixed',positionM:{x:-2,y:3},outputChannel:n-1}]});
  const mapped=assignSpatialOutputChannels(plan);
  expect(mapped.satellites.map(s=>s.outputChannel).sort((a,b)=>(a as number)-(b as number)))
    .toEqual(Array.from({length:n},(_,i)=>i));
  expect(plan.satellites.find(s=>s.id!=='fixed')?.outputChannel).toBeNull();
  const frame=new VirtualSpatialInterface({channels:n}).process(
    Array.from({length:n},(_,i)=>new Float32Array(128).fill(i===n-1?0.25:0)));
  const views=mapVirtualMeters(frame,mapped.satellites);
  expect(views.find(v=>v.id==='fixed')?.peak).toBeCloseTo(0.25);
  const renderer=new VirtualBinauralRenderer(mapped);
  const out=renderer.process(Array.from({length:n},(_,i)=>new Float32Array(128).fill(i===n-1?0.25:0)));
  expect(out[0].some(v=>v!==0)||out[1].some(v=>v!==0)).toBe(true);
 });
 it('fails closed for duplicated explicit channels',()=>{
  const plan=planClubSpeakers({widthM:8,depthM:8,satellites:16,fixedSpeakers:[
    {id:'left',positionM:{x:-2,y:3},outputChannel:0},
    {id:'right',positionM:{x:2,y:3},outputChannel:0}]});
  expect(()=>assignSpatialOutputChannels(plan)).toThrow();
 });
});
