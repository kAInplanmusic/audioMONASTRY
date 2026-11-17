import type {ClubPlan} from './clubPlanner';

/** Canonical per-speaker output indices for a spatial club plan.
 * Explicit assignments reserve their indices before automatic allocation.
 * Returns a new plan; the caller's plan is never mutated.
 */
export function assignSpatialOutputChannels(plan:ClubPlan):ClubPlan {
  const n=plan.satellites.length;
  if(![12,16,24,32].includes(n))throw new RangeError('Unsupported spatial speaker count');
  const reserved=new Set<number>();
  for(const speaker of plan.satellites){
    const ch=speaker.outputChannel;
    if(ch===null||ch===undefined)continue;
    if(!Number.isSafeInteger(ch)||ch<0||ch>=n||reserved.has(ch))
      throw new RangeError('Invalid speaker channel mapping');
    reserved.add(ch);
  }
  const used=new Set(reserved);
  let next=0;
  const satellites=plan.satellites.map(sp=>{
    if(sp.outputChannel!==null&&sp.outputChannel!==undefined)return {...sp};
    while(used.has(next))next++;
    if(next>=n)throw new RangeError('No free spatial channel');
    const outputChannel=next;
    used.add(next++);
    return {...sp,outputChannel};
  });
  return {...plan,satellites};
}
