import { randomUUID } from 'node:crypto';

/**
 * R17: DJ-Override. The DJ is whoever currently holds mixerMONK; that authority is read
 * from the session on every request and never taken from a client field. A takeover is a
 * normal lock transfer (settings stay in the session, so the new holder inherits the exact
 * values). Nothing here issues or validates R5 delegations.
 */
export interface TakeoverRequest {
  id: string;
  pluginId: string;
  fromUserId: string;
  toUserId: string;
  deadline: number;
}

export type TakeoverOutcome = 'accepted' | 'denied' | 'timeout' | 'holder-offline';

export interface TakeoverDeps {
  /** Current lock holder, or null when the plugin is free. */
  ownerOf: (pluginId: string) => string | null;
  isMember: (userId: string) => boolean;
  transfer: (pluginId: string, fromUserId: string, toUserId: string) => Promise<{ ok: boolean }> | { ok: boolean };
  acquire: (pluginId: string, userId: string) => Promise<{ ok: boolean }> | { ok: boolean };
  release: (pluginId: string, userId: string) => Promise<boolean> | boolean;
  now?: () => number;
  timeoutMs?: number;
  cooldownMs?: number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  onChange?: (event: { kind: 'ask' | 'result' | 'returned'; request?: TakeoverRequest; pluginId?: string; fromUserId?: string; toUserId?: string; outcome?: TakeoverOutcome }) => void;
}

const COOLDOWN_MS = 10_000;
const HISTORY_LIMIT = 50;

export class PluginTakeoverCoordinator {
  private pending = new Map<string, { request: TakeoverRequest; timer: unknown }>();
  private byPlugin = new Map<string, string>();
  private cooldown = new Map<string, number>();
  private takenFrom = new Map<string, string>();
  private history: Array<{ at: number; pluginId: string; fromUserId: string; toUserId: string; outcome: TakeoverOutcome }> = [];

  constructor(private readonly deps: TakeoverDeps) {}

  private now(): number { return (this.deps.now ?? Date.now)(); }
  private timeout(): number { return this.deps.timeoutMs ?? 5000; }
  private schedule(fn: () => void, ms: number): unknown {
    return (this.deps.schedule ?? ((f, m) => setTimeout(f, m)))(fn, ms);
  }
  private cancel(handle: unknown): void {
    if (handle !== undefined) (this.deps.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(handle);
  }

  private record(pluginId: string, fromUserId: string, toUserId: string, outcome: TakeoverOutcome): void {
    const entry = { at: this.now(), pluginId, fromUserId, toUserId, outcome };
    this.history.push(entry);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.deps.onChange?.({ kind: 'result', pluginId, fromUserId, toUserId, outcome });
  }

  /** The DJ may ask for any canonical plugin except the mixer he already controls. */
  async request(requesterId: string, pluginId: string): Promise<{ outcome: 'pending' | TakeoverOutcome; requestId?: string; deadline?: number; reason?: string }> {
    const dj = this.deps.ownerOf('mixer');
    if (!dj || dj !== requesterId) return { outcome: 'denied', reason: 'not-dj' };
    if (!pluginId || pluginId === 'mixer') return { outcome: 'denied', reason: 'invalid-target' };
    if (this.byPlugin.has(pluginId)) return { outcome: 'denied', reason: 'already-pending' };
    const cooldownKey = `${pluginId}:${requesterId}`;
    const blockedUntil = this.cooldown.get(cooldownKey) ?? 0;
    if (blockedUntil > this.now()) return { outcome: 'denied', reason: 'cooldown' };
    const holder = this.deps.ownerOf(pluginId);
    if (holder === requesterId) return { outcome: 'denied', reason: 'already-owner' };

    if (!holder || !this.deps.isMember(holder)) {
      const moved = holder ? await this.deps.transfer(pluginId, holder, requesterId) : await this.deps.acquire(pluginId, requesterId);
      if (!moved.ok) return { outcome: 'denied', reason: 'transfer-refused' };
      this.takenFrom.set(pluginId, holder ?? '');
      this.record(pluginId, holder ?? '', requesterId, 'holder-offline');
      return { outcome: 'holder-offline' };
    }

    const request: TakeoverRequest = { id: randomUUID(), pluginId, fromUserId: holder, toUserId: requesterId, deadline: this.now() + this.timeout() };
    const timer = this.schedule(() => { void this.timeoutRequest(request.id); }, this.timeout());
    this.pending.set(request.id, { request, timer });
    this.byPlugin.set(pluginId, request.id);
    this.deps.onChange?.({ kind: 'ask', request });
    return { outcome: 'pending', requestId: request.id, deadline: request.deadline };
  }

  /** Only the addressed holder may answer; a deny needs no reason. */
  async answer(userId: string, requestId: string, accept: boolean): Promise<{ ok: boolean; outcome?: TakeoverOutcome; reason?: string }> {
    const entry = this.pending.get(requestId);
    if (!entry) return { ok: false, reason: 'unknown-request' };
    const { request } = entry;
    if (request.fromUserId !== userId) return { ok: false, reason: 'not-holder' };
    if (this.deps.ownerOf(request.pluginId) !== userId) return { ok: false, reason: 'holder-changed' };
    this.clear(request.id);
    if (!accept) {
      this.cooldown.set(`${request.pluginId}:${request.toUserId}`, this.now() + (this.deps.cooldownMs ?? COOLDOWN_MS));
      this.record(request.pluginId, request.fromUserId, request.toUserId, 'denied');
      return { ok: true, outcome: 'denied' };
    }
    const moved = await this.deps.transfer(request.pluginId, request.fromUserId, request.toUserId);
    if (!moved.ok) return { ok: false, reason: 'transfer-refused' };
    this.takenFrom.set(request.pluginId, request.fromUserId);
    this.record(request.pluginId, request.fromUserId, request.toUserId, 'accepted');
    return { ok: true, outcome: 'accepted' };
  }

  /** Deadline reached: the operator's rule is an automatic takeover. */
  async timeoutRequest(requestId: string): Promise<void> {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    const { request } = entry;
    this.clear(request.id);
    if (this.deps.ownerOf(request.pluginId) !== request.fromUserId) return;
    const moved = await this.deps.transfer(request.pluginId, request.fromUserId, request.toUserId);
    if (!moved.ok) { this.record(request.pluginId, request.fromUserId, request.toUserId, 'denied'); return; }
    this.takenFrom.set(request.pluginId, request.fromUserId);
    this.record(request.pluginId, request.fromUserId, request.toUserId, 'timeout');
  }

  /** Explicit return by the current holder; no automatic expiry. */
  async returnTo(pluginId: string, actorId: string): Promise<{ ok: boolean; outcome?: 'returned' | 'released'; reason?: string }> {
    if (this.deps.ownerOf(pluginId) !== actorId) return { ok: false, reason: 'not-holder' };
    const original = this.takenFrom.get(pluginId) ?? '';
    this.takenFrom.delete(pluginId);
    if (original && original !== actorId && this.deps.isMember(original)) {
      const moved = await this.deps.transfer(pluginId, actorId, original);
      if (!moved.ok) return { ok: false, reason: 'transfer-refused' };
      this.deps.onChange?.({ kind: 'returned', pluginId, fromUserId: actorId, toUserId: original });
      return { ok: true, outcome: 'returned' };
    }
    if (!await this.deps.release(pluginId, actorId)) return { ok: false, reason: 'release-refused' };
    this.deps.onChange?.({ kind: 'returned', pluginId, fromUserId: actorId, toUserId: '' });
    return { ok: true, outcome: 'released' };
  }

  /**
   * A disconnect ends the DJ's claims: pending asks are void, taken plugins go back to
   * their original holder when that member still exists, otherwise they are released.
   */
  async handleDisconnect(userId: string): Promise<void> {
    for (const [id, entry] of [...this.pending]) {
      if (entry.request.toUserId === userId) this.clear(id);
    }
    for (const [pluginId, original] of [...this.takenFrom]) {
      if (this.deps.ownerOf(pluginId) !== userId) continue;
      this.takenFrom.delete(pluginId);
      if (original && original !== userId && this.deps.isMember(original)) {
        await this.deps.transfer(pluginId, userId, original);
        this.deps.onChange?.({ kind: 'returned', pluginId, fromUserId: userId, toUserId: original });
      } else {
        await this.deps.release(pluginId, userId);
        this.deps.onChange?.({ kind: 'returned', pluginId, fromUserId: userId, toUserId: '' });
      }
    }
  }

  pendingFor(pluginId: string): TakeoverRequest | null {
    const id = this.byPlugin.get(pluginId);
    return id ? this.pending.get(id)?.request ?? null : null;
  }

  list(): TakeoverRequest[] { return [...this.pending.values()].map(entry => entry.request); }

  historyEntries(): typeof this.history { return [...this.history]; }

  private clear(requestId: string): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.cancel(entry.timer);
    this.pending.delete(requestId);
    if (this.byPlugin.get(entry.request.pluginId) === requestId) this.byPlugin.delete(entry.request.pluginId);
  }
}
