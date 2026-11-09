import {describe,expect,it} from 'vitest';
import {normalizeMotionPath,positionAt} from '../src/core/spatial/v2/motionPath';
describe('spatial recorded motion paths',()=>{
  const raw={version:1,duration:2,points:[{time:0,x:-1,y:0},{time:2,x:1,y:0}]};
  it('interpolates deterministically and clamps end points',()=>{
    const p=normalizeMotionPath(raw)!;
    expect(positionAt(p,1)).toEqual({x:0,y:0});
    expect(positionAt(p,10)).toEqual({x:1,y:0});
    expect(positionAt(p,2.5,true)).toEqual({x:-0.5,y:0});
  });
  it('rejects duplicate timestamps, invalid numbers and unbounded recordings',()=>{
    expect(normalizeMotionPath({...raw,points:[raw.points[0],raw.points[0]]})).toBeNull();
    expect(normalizeMotionPath({...raw,points:[{time:0,x:Infinity,y:0}]})).toBeNull();
    expect(normalizeMotionPath({...raw,duration:3601})).toBeNull();
  });
  it('clamps imported XY to safe room coordinates',()=>{
    expect(normalizeMotionPath({...raw,points:[{time:0,x:5,y:-5}]} )?.points[0]).toEqual({time:0,x:1,y:-1});
  });
});
