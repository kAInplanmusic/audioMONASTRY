import {describe,it,expect} from 'vitest';
import {planClubSpeakers} from '../src/core/spatial/v2/clubPlanner';
import {VirtualBinauralRenderer} from '../src/core/spatial/v2/virtualBinauralRenderer';

describe('spatial virtual channel-map integrity',()=>{
  it('reserves explicit speaker channels before assigning unmapped speakers',()=>{
    const plan=planClubSpeakers({
      widthM:8,depthM:8,satellites:12,
      fixedSpeakers:[{id:'fixed-L',positionM:{x:-2,y:3},outputChannel:0}]
    });
    const renderer=new VirtualBinauralRenderer(plan);
    expect(renderer.channelCount).toBe(12);
    const blocks=Array.from({length:12},()=>new Float32Array(128));
    blocks[0].fill(0.2);
    const [left,right]=renderer.process(blocks);
    expect(left.some(v=>v!==0)||right.some(v=>v!==0)).toBe(true);
  });
  it('rejects duplicated explicit speaker output channels',()=>{
    const plan=planClubSpeakers({
      widthM:8,depthM:8,satellites:16,
      fixedSpeakers:[
        {id:'fixed-L',positionM:{x:-2,y:3},outputChannel:4},
        {id:'fixed-R',positionM:{x:2,y:3},outputChannel:4}
      ]
    });
    expect(()=>new VirtualBinauralRenderer(plan)).toThrow(/mapping/);
  });
  it('rejects out-of-range explicit channel assignments',()=>{
    const plan=planClubSpeakers({
      widthM:8,depthM:8,satellites:12,
      fixedSpeakers:[{id:'fixed-L',positionM:{x:-2,y:3},outputChannel:20}]
    });
    expect(()=>new VirtualBinauralRenderer(plan)).toThrow(/mapping/);
  });
});
