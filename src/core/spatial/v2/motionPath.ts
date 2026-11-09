/** Deterministic, serializable spatial automation (seconds, normalized XY). */
export interface MotionPoint { time: number; x: number; y: number }
export interface MotionPath { version: 1; duration: number; points: MotionPoint[] }
const clamp=(n:number)=>Math.max(-1,Math.min(1,n));
export function normalizeMotionPath(value:unknown):MotionPath|null {
  if(!value||typeof value!=='object')return null;
  const v=value as Partial<MotionPath>;
  if(v.version!==1||!Array.isArray(v.points)||v.points.length<1||v.points.length>36000)return null;
  if(typeof v.duration!=='number'||!Number.isFinite(v.duration)||v.duration<0||v.duration>3600)return null;
  let previous=-1;
  const points:MotionPoint[]=[];
  for(const p of v.points){
    if(!p||typeof p.time!=='number'||!Number.isFinite(p.time)||p.time<0||p.time>v.duration||
      p.time<=previous||typeof p.x!=='number'||!Number.isFinite(p.x)||
      typeof p.y!=='number'||!Number.isFinite(p.y))return null;
    points.push({time:p.time,x:clamp(p.x),y:clamp(p.y)});
    previous=p.time;
  }
  return {version:1,duration:v.duration,points};
}
export function positionAt(path:MotionPath,seconds:number,loop=false):{x:number;y:number}{
  const points=path.points;
  if(points.length===0)return {x:0,y:0};
  if(!Number.isFinite(seconds))seconds=0;
  const t=loop&&path.duration>0?((seconds%path.duration)+path.duration)%path.duration:Math.max(0,Math.min(seconds,path.duration));
  if(t<=points[0].time)return {x:points[0].x,y:points[0].y};
  let low=0,high=points.length-1;
  while(low<high){const mid=(low+high+1)>>1;if(points[mid].time<=t)low=mid;else high=mid-1;}
  const a=points[low],b=points[Math.min(low+1,points.length-1)];
  if(a===b)return {x:a.x,y:a.y};
  const fraction=(t-a.time)/(b.time-a.time);
  return {x:a.x+(b.x-a.x)*fraction,y:a.y+(b.y-a.y)*fraction};
}
