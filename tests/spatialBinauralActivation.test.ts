import {describe,expect,it} from 'vitest';
import {shouldRunSpatialBinaural} from '../src/audio/spatial/shouldRunSpatialBinaural';

const enabled={channel1:{x:0,y:0,on:true}};
describe('spatial binaural activation policy',()=>{
  it('does not activate when the session plugin is OFF or unknown',()=>{
    expect(shouldRunSpatialBinaural('OFF',enabled)).toBe(false);
    expect(shouldRunSpatialBinaural(undefined,enabled)).toBe(false);
  });
  it('activates only with active sources and a running module',()=>{
    expect(shouldRunSpatialBinaural('PRO',enabled)).toBe(true);
    expect(shouldRunSpatialBinaural('AUTO_AI',enabled)).toBe(true);
    expect(shouldRunSpatialBinaural('PRO',{channel1:{x:0,y:0,on:false}})).toBe(false);
    expect(shouldRunSpatialBinaural('PRO',{})).toBe(false);
  });
  it('ignores non-audio object keys',()=>{
    expect(shouldRunSpatialBinaural('PRO',{unknown:{x:0,y:0,on:true}})).toBe(false);
  });
});
