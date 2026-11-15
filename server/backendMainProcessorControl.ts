import type { AuthoritativeSession } from '../src/core/session/authoritativeSession';
import type { PluginDelegationAuthority } from './pluginDelegation';
import type { MainProcessorSnapshot } from './backendMainProcessors';

export const MAIN_PROCESSOR_IDS = ['eq', 'dsp', 'effect', 'spatial', 'mixer', 'master'] as const;

/** Reads existing authoritative decisions. It neither issues grants nor changes locks. */
export function mainProcessorSnapshot(session: AuthoritativeSession, delegations: PluginDelegationAuthority): MainProcessorSnapshot {
  const snapshot = session.snapshot();
  return Object.fromEntries(MAIN_PROCESSOR_IDS.map(id => {
    const module = snapshot.modules[id];
    const owner = session.lockOwner(id);
    const grant = module?.state === 'AUTO_AI' ? delegations.get(id) : null;
    const manual = Boolean(owner) && (module?.state === 'PRO' || id === 'mixer');
    const delegated = Boolean(grant && delegations.valid(grant, grant.delegatedBy, id));
    // R16 §P4: masterMONK is authorized by its own holder or its own delegation.
    // The mixerMONK keeps its Main-Out invariant, but no longer gates Mastering.
    const saved = snapshot.pluginSettings[id]?.settings.backendMain;
    const parameters = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved as Record<string, unknown> : {};
    return [id, { active: manual || delegated, parameters,
      epoch: `${module?.revision ?? 0}:${owner ?? ''}:${grant?.generationId ?? ''}` }];
  }));
}
