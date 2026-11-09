import {describe,it,expect} from 'vitest';
import {VirtualSpatialInterface,mapVirtualMeters} from '../src/core/spatial/v2/virtualInterface';
describe('virtual spatial interface',()=>{
 for(const count of [12,16,24,32] as const){
  it('reports only actual active output for '+count,()=>{
   const sink=new VirtualSpatialInterface({channels:count});
   const block=Array.from({length:count},()=>new Float32Array(128));
   block[count-1].fill(0.5);
   const f=sink.process(block);
   expect(f.channels.filter(c=>c.active).map(c=>c.channel)).toEqual([count-1]);
   expect(f.channels[count-1].rms).toBeCloseTo(0.5);
   expect(f.channels[0].peak).toBe(0);
   const speakers=Array.from({length:count},(_,i)=>({
     id:'sat-'+i,outputChannel:i,positionM:{x:i,y:0}
   }));
   expect(mapVirtualMeters(f,speakers).filter(x=>x.active).map(x=>x.id)).toEqual(['sat-'+(count-1)]);
  });
 }
 it('detects clipping, invalid frame, and channel collisions',()=>{
  const sink=new VirtualSpatialInterface({channels:12});
  const block=Array.from({length:12},()=>new Float32Array(64));
  block[2][3]=1.5;
  const f=sink.process(block);
  expect(f.channels[2].clipped).toBe(true);
  expect(()=>sink.process(block.slice(1))).toThrow();
  expect(()=>mapVirtualMeters(f,[{id:'a',outputChannel:2,positionM:{x:0,y:0}},
    {id:'b',outputChannel:2,positionM:{x:1,y:0}}])).toThrow();
 });
});
