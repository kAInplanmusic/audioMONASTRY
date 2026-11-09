import {describe,it,expect} from 'vitest';
import {planClubSpeakers,adjacentPan2D,createChannelProbeSchedule,SPATIAL_CLUB_COUNTS} from '../src/core/spatial/v2/clubPlanner';

describe('spatialMONK club plan, X/Y independent',()=>{
  for(const n of SPATIAL_CLUB_COUNTS){
    for(const [w,d] of [[4,12],[6,6],[8,4],[12,20]]){
      it(n+' satellites for '+w+'x'+d,()=>{
        const p=planClubSpeakers({widthM:w,depthM:d,satellites:n});
        expect(p.satellites).toHaveLength(n);
        expect(p.totalRequiredOutputs).toBe(n);
        expect(p.satellites.filter(s=>s.wall==='corner')).toHaveLength(n===12?0:4);
        expect(p.satellites.filter(s=>s.wall==='front')).toHaveLength(n===12||n===16?3:n===24?5:7);
        expect(p.satellites.every(s=>Math.abs(s.positionM.x)<=w/2&&Math.abs(s.positionM.y)<=d/2)).toBe(true);
        expect(p.satellites.every(s=>s.geometricDelayMs>=0&&Number.isFinite(s.theoreticalTrimDb))).toBe(true);
        expect(p.angularGapsDeg.reduce((a,b)=>a+b,0)).toBeCloseTo(360,3);
        expect(p.measurementRequired).toBe(true);
        const schedule=createChannelProbeSchedule(p);
        expect(schedule).toHaveLength(n);
        expect(schedule.every((x,i)=>x.channel===i&&x.peakDbfs===-30)).toBe(true);
        const pan=adjacentPan2D(p,{x:0.3,y:0.9});
        expect(pan.gainFirst**2+pan.gainSecond**2).toBeCloseTo(1,8);
      });
    }
  }
  it('locks two real stereo positions without increasing channel count',()=>{
    const fixedSpeakers=[{id:'L',positionM:{x:-2.1,y:5.4}},{id:'R',positionM:{x:1.8,y:5.1}}];
    const p=planClubSpeakers({widthM:4.5,depthM:12,satellites:24,fixedSpeakers,subwoofers:2});
    expect(p.satellites).toHaveLength(24);
    expect(p.totalRequiredOutputs).toBe(26);
    for(const sp of fixedSpeakers)expect(p.satellites.find(s=>s.id===sp.id)?.positionM).toEqual(sp.positionM);
  });
  it('rejects invalid room, counts, duplicate speakers and unsafe probes',()=>{
    expect(()=>planClubSpeakers({widthM:4,depthM:0,satellites:12})).toThrow();
    expect(()=>planClubSpeakers({widthM:4,depthM:4,satellites:18 as 12})).toThrow();
    expect(()=>planClubSpeakers({widthM:4,depthM:4,satellites:12,fixedSpeakers:[
      {id:'L',positionM:{x:-1,y:2}},{id:'L',positionM:{x:1,y:2}}]})).toThrow();
    const p=planClubSpeakers({widthM:4,depthM:4,satellites:12});
    expect(()=>createChannelProbeSchedule(p,-3)).toThrow();
  });
});
