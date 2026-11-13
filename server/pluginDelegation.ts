import { randomUUID } from 'node:crypto';
import { resolveCanonicalPluginId } from '../src/plugins/legacyAliases';
import { PLUGIN_AI_ROLE, type PluginDelegation } from '../src/core/session/pluginDelegation';
import type { AuthoritativeSession } from '../src/core/session/authoritativeSession';

/** One coordinator owns both transactions. Redis/multi-coordinator operation is
 * explicitly denied until a distributed atomic delegation store is configured.
 * Delegations are intentionally not restored across process/session restarts.
 */
export class PluginDelegationAuthority {
  private records = new Map<string, PluginDelegation>();
  onChange: (pluginId: string, reason: string) => void = () => {};
  constructor(private session: () => AuthoritativeSession, private singleCoordinator: () => boolean) {}
  start(pluginId: string, actorId: string, ttlMs = 600000, now = Date.now()): PluginDelegation {
    if (!this.singleCoordinator()) throw new Error('Shared lock backend requires an atomic shared delegation store');
    if (!actorId || resolveCanonicalPluginId(pluginId) !== pluginId || !PLUGIN_AI_ROLE[pluginId]) throw new Error('Invalid delegation target');
    const session = this.session();
    if (session.lockOwner(pluginId, now) !== actorId) throw new Error('Only the current holder can delegate');
    if (!Number.isFinite(ttlMs) || ttlMs < 1000 || ttlMs > 3600000) throw new Error('Invalid delegation lifetime');
    this.revoke(pluginId, 'replaced');
    const record: PluginDelegation = { pluginId, delegatedBy: actorId, aiRole: PLUGIN_AI_ROLE[pluginId],
      generationId: randomUUID(), issuedAt: now, expiresAt: now + ttlMs };
    const changed = session.applyEvent({ id: randomUUID(), type: 'plugin-state', senderUserId: actorId, pluginId, state: 'AUTO_AI' }, now);
    if (!changed.accepted || !session.releaseLock(pluginId, actorId, now)) throw new Error('Delegation transaction rejected');
    this.records.set(pluginId, record);
    this.onChange(pluginId, 'started');
    return { ...record };
  }
  get(pluginId: string): PluginDelegation | null {
    const record = this.records.get(pluginId);
    return record && this.valid(record, record.delegatedBy, pluginId) ? { ...record } : null;
  }
  valid(proof: Pick<PluginDelegation, 'pluginId' | 'generationId'> | null | undefined, actorId: string, target: string, now = Date.now()): boolean {
    if (!proof || !proof.generationId || proof.pluginId !== target || resolveCanonicalPluginId(target) !== target) return false;
    const record = this.records.get(target);
    if (!record || record.generationId !== proof.generationId || record.delegatedBy !== actorId) return false;
    const session = this.session();
    if (!this.singleCoordinator() || record.expiresAt <= now || session.lockOwner(target, now)
      || session.snapshot(now).modules[target]?.state !== 'AUTO_AI') {
      this.revoke(target, 'expired-or-revoked'); return false;
    }
    return true;
  }
  all(): PluginDelegation[] { return [...this.records.keys()].flatMap(id => { const record = this.get(id); return record ? [record] : []; }); }
  revoke(pluginId: string, reason = 'revoked'): boolean {
    const record = this.records.get(pluginId); if (!record) return false;
    this.records.delete(pluginId);
    const session = this.session();
    if (session.snapshot().modules[pluginId]?.state === 'AUTO_AI') session.applyEvent({
      id: randomUUID(), type: 'plugin-state', senderUserId: session.lockOwner(pluginId) ?? record.delegatedBy, pluginId, state: 'OFF',
    });
    this.onChange(pluginId, reason); return true;
  }
  revokeUser(actorId: string): void { for (const record of [...this.records.values()]) if (record.delegatedBy === actorId) this.revoke(record.pluginId, 'actor-left'); }
  clear(): void { for (const id of [...this.records.keys()]) this.revoke(id, 'session-ended'); }
}
