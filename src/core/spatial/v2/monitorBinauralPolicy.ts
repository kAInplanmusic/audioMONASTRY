import type {MonitorRoutingPlan,MonitorUser} from '../../audio/monitorRouting';
import {MONITOR_USERS} from '../../audio/monitorRouting';
/**
 * Pure local headphone post-insert policy. Never modifies monitor routing or main.
 * HRTF DSP activation is intentionally separate from this policy.
 */
export interface LocalBinauralPreference {
  user:MonitorUser;
  requested:boolean;
  spatialActive:boolean;
  headphonesAvailable:boolean;
  hrtfReady:boolean;
}
export interface BinauralMonitorDecision {
  user:MonitorUser;
  enabled:boolean;
  reason:'ready'|'disabled'|'spatial-inactive'|'headphones-unavailable'|'hrtf-unavailable';
  monitorSource:MonitorRoutingPlan['source'];
}
export function decideBinauralMonitor(
  plan:MonitorRoutingPlan,pref:LocalBinauralPreference
):BinauralMonitorDecision {
  if(!MONITOR_USERS.includes(pref.user)||plan.mon!==pref.user)
    throw new Error('Binaural monitor user does not match local routing plan');
  const reason: BinauralMonitorDecision['reason'] =
    !pref.requested?'disabled':
    !pref.spatialActive?'spatial-inactive':
    !pref.headphonesAvailable?'headphones-unavailable':
    !pref.hrtfReady?'hrtf-unavailable':'ready';
  return {user:pref.user,enabled:reason==='ready',reason,monitorSource:plan.source};
}
