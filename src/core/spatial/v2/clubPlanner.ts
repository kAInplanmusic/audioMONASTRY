import type { SpatialVec2, SpatialSpeakerV2 } from './model';

/** Spatial-Main only: 12/16/24/32 ear-height satellites; subs separate. */
export type SpatialClubCount = 12 | 16 | 24 | 32;
export const SPATIAL_CLUB_COUNTS = [12, 16, 24, 32] as const;
export const SOUND_SPEED_MPS = 343.2;
export type Wall = 'front' | 'right' | 'rear' | 'left' | 'corner' | 'fixed';
export interface LockedSpeaker { id: string; positionM: SpatialVec2; outputChannel?: number | null }
export interface ClubLayoutInput {
  widthM: number; depthM: number; satellites: SpatialClubCount;
  listenerM?: SpatialVec2;
  fixedSpeakers?: readonly LockedSpeaker[];
  subwoofers?: 0 | 1 | 2;
}
export interface ClubSpeaker extends SpatialSpeakerV2 {
  wall: Wall;
  azimuthDeg: number;
  distanceM: number;
  geometricDelayMs: number;
  /** Relative inverse-distance estimate only, not measured SPL correction. */
  theoreticalTrimDb: number;
}
export interface ClubPlan {
  room: { widthM: number; depthM: number };
  listenerM: SpatialVec2;
  satellites: ClubSpeaker[];
  subwoofers: SpatialSpeakerV2[];
  angularGapsDeg: number[];
  maxAngularGapDeg: number;
  totalRequiredOutputs: number;
  /** Theoretical propagation only; never applied without measurement. */
  measurementRequired: true;
}
const round = (n: number) => Math.round(n * 1e6) / 1e6;
const finite = (n: number) => Number.isFinite(n);
const azimuth = (p: SpatialVec2, l: SpatialVec2) =>
  (Math.atan2(p.x - l.x, p.y - l.y) * 180 / Math.PI + 360) % 360;
const dist = (p: SpatialVec2, l: SpatialVec2) => Math.hypot(p.x-l.x,p.y-l.y);
const make = (id: string, positionM: SpatialVec2, wall: Wall, outputChannel: number|null = null):
  ClubSpeaker => ({ id, positionM, wall, outputChannel, role: 'satellite',
    trimDb: 0, delayMs: 0, polarity: 1, azimuthDeg: 0,
    distanceM: 0, geometricDelayMs: 0, theoreticalTrimDb: 0 });

/**
 * Fixed wall quotas:
 * 12 = 3 per wall;
 * 16 = 3 per wall + 4 corners;
 * 24 = 5 per wall + 4 corners;
 * 32 = 7 per wall + 4 corners.
 * Corners are counted ONCE. L/R locked speakers replace nearest slots,
 * never increase total count. Locked coordinates may be inside the room.
 */
export function planClubSpeakers(input: ClubLayoutInput): ClubPlan {
  const { widthM:w, depthM:d, satellites:n } = input;
  if (!finite(w)||!finite(d)||w<1||d<1||w>100||d>100)
    throw new RangeError('Room X/Y must be finite and 1..100 m');
  if (!SPATIAL_CLUB_COUNTS.includes(n)) throw new RangeError('Only 12, 16, 24, 32');
  const subs=input.subwoofers??0;
  if (![0,1,2].includes(subs)) throw new RangeError('0..2 subwoofers');
  const listener=input.listenerM??{x:0,y:0};
  if (!finite(listener.x)||!finite(listener.y)||
    Math.abs(listener.x)>=w/2||Math.abs(listener.y)>=d/2)
    throw new RangeError('Listener must be strictly inside room');
  const fixed=input.fixedSpeakers??[];
  if (fixed.length>2) throw new RangeError('At most two locked front speakers');
  const ids=new Set<string>();
  for (const sp of fixed) {
    if (!sp.id||ids.has(sp.id)||!finite(sp.positionM.x)||!finite(sp.positionM.y)||
      Math.abs(sp.positionM.x)>w/2||Math.abs(sp.positionM.y)>d/2||
      dist(sp.positionM,listener)<0.1)
      throw new RangeError('Invalid/duplicate fixed speaker');
    if (sp.outputChannel!==undefined&&sp.outputChannel!==null&&
      (!Number.isSafeInteger(sp.outputChannel)||sp.outputChannel<0))
      throw new RangeError('Invalid output channel');
    ids.add(sp.id);
  }
  const perWall=n===12||n===16?3:n===24?5:7;
  const slots: ClubSpeaker[]=[];
  const frontY=d/2,rearY=-d/2,rightX=w/2,leftX=-w/2;
  for(let i=1;i<=perWall;i++){
    const t=i/(perWall+1);
    slots.push(make('front-'+i,{x:-w/2+w*t,y:frontY},'front'));
    slots.push(make('right-'+i,{x:rightX,y:d/2-d*t},'right'));
    slots.push(make('rear-'+i,{x:w/2-w*t,y:rearY},'rear'));
    slots.push(make('left-'+i,{x:leftX,y:-d/2+d*t},'left'));
  }
  if(n!==12){
    slots.push(make('corner-FL',{x:leftX,y:frontY},'corner'));
    slots.push(make('corner-FR',{x:rightX,y:frontY},'corner'));
    slots.push(make('corner-RR',{x:rightX,y:rearY},'corner'));
    slots.push(make('corner-RL',{x:leftX,y:rearY},'corner'));
  }
  // Replace a slot close to the fixed speaker's bearing, prioritising the
  // front wall. The fixed speaker's real coordinates remain untouched.
  for(const locked of fixed){
    const desired=azimuth(locked.positionM,listener);
    let best=-1,bestScore=Infinity;
    for(let i=0;i<slots.length;i++){
      const a=azimuth(slots[i].positionM,listener);
      const gap=Math.abs(((a-desired+540)%360)-180);
      const score=gap+(slots[i].wall==='front'?0:20);
      if(score<bestScore){best=i;bestScore=score;}
    }
    if(best<0)throw new Error('No free speaker slot');
    slots.splice(best,1);
  }
  const all=[...fixed.map(sp=>make(sp.id,{...sp.positionM},'fixed',sp.outputChannel??null)),...slots];
  if(all.length!==n)throw new Error('Internal channel count mismatch');
  const distances=all.map(s=>dist(s.positionM,listener));
  const farthest=Math.max(...distances);
  for(let i=0;i<all.length;i++){
    const sp=all[i];
    sp.azimuthDeg=round(azimuth(sp.positionM,listener));
    sp.distanceM=round(distances[i]);
    sp.geometricDelayMs=round((farthest-distances[i])/SOUND_SPEED_MPS*1000);
    sp.theoreticalTrimDb=round(20*Math.log10(distances[i]/farthest));
  }
  all.sort((a,b)=>a.azimuthDeg-b.azimuthDeg||a.id.localeCompare(b.id));
  const gaps=all.map((s,i)=>round((all[(i+1)%n].azimuthDeg-s.azimuthDeg+360)%360));
  const subwoofers=Array.from({length:subs},(_,i):SpatialSpeakerV2=>({
    id:'sub-'+(i+1),role:'subwoofer',outputChannel:null,trimDb:0,
    delayMs:0,polarity:1,
    positionM:{x:subs===1?0:(i===0?-w/4:w/4),y:d/2},
  }));
  return {room:{widthM:w,depthM:d},listenerM:{...listener},satellites:all,
    subwoofers,angularGapsDeg:gaps,maxAngularGapDeg:Math.max(...gaps),
    totalRequiredOutputs:n+subs,measurementRequired:true};
}

/** Adjacent-azimuth constant-power gains. No LFE routing, no allocations in DSP. */
export function adjacentPan2D(plan: ClubPlan, positionM: SpatialVec2): {
  first: number; second: number; gainFirst: number; gainSecond: number
} {
  const speakers=plan.satellites;
  const angle=azimuth(positionM,plan.listenerM);
  for(let i=0;i<speakers.length;i++){
    const j=(i+1)%speakers.length;
    const start=speakers[i].azimuthDeg;
    const width=(speakers[j].azimuthDeg-start+360)%360;
    const delta=(angle-start+360)%360;
    if(width>1e-8&&delta<=width+1e-8){
      const t=Math.max(0,Math.min(1,delta/width));
      return {first:i,second:j,gainFirst:Math.cos(t*Math.PI/2),gainSecond:Math.sin(t*Math.PI/2)};
    }
  }
  throw new Error('Invalid angular speaker coverage');
}

export interface ChannelProbe { channel: number; speakerId: string; peakDbfs: number; durationMs: number }
/** No playback: generate a safe, explicit per-channel test schedule. */
export function createChannelProbeSchedule(plan: ClubPlan, peakDbfs=-30, durationMs=350): ChannelProbe[] {
  if(!finite(peakDbfs)||peakDbfs> -18||peakDbfs< -80||
    !finite(durationMs)||durationMs<100||durationMs>2000)
    throw new RangeError('Unsafe probe level/duration');
  return [...plan.satellites,...plan.subwoofers].map((sp,i)=>({
    channel:i,speakerId:sp.id,peakDbfs,durationMs,
  }));
}
