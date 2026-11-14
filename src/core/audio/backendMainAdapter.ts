import type { PluginAudioBlock } from '../../plugins/plugin_interface';
import { PLUGIN_AI_ROLE, type PluginDelegation } from '../session/pluginDelegation';

/** Only independent source channels may be sent as contributions; processors and buses must not be duplicated. */
export const BACKEND_MAIN_ADAPTERS = {
  mixer: { classification: 'mixer', tapSource: null, status: 'none', reason: 'The mixer is the shared bus, not an independent source.' },
  drop: { classification: 'source', tapSource: 'channel1', status: 'available' },
  song: { classification: 'source', tapSource: 'channel2', status: 'available' },
  effect: { classification: 'processor', tapSource: null, status: 'unsupported', reason: 'Effect output is a processed bus, not an independent source.' },
  syntisampler: { classification: 'source', tapSource: 'channel4', status: 'available' },
  drumsampler: { classification: 'source', tapSource: 'channel3', status: 'available' },
  instru: { classification: 'source', tapSource: 'channel5', status: 'available' },
  biblio: { classification: 'library', tapSource: null, status: 'none', reason: 'The library has no independent playback output.' },
  voice: { classification: 'source', tapSource: 'channel6', status: 'available' },
  sound: { classification: 'source', tapSource: 'channel7', status: 'available' },
  stem: { classification: 'source', tapSource: 'channel8', status: 'available' },
  spatial: { classification: 'processor', tapSource: null, status: 'unsupported', reason: 'Spatial output is a processed bus, not an independent source.' },
  eq: { classification: 'processor', tapSource: null, status: 'unsupported', reason: 'EQ output is a processed bus, not an independent source.' },
  dsp: { classification: 'processor', tapSource: null, status: 'unsupported', reason: 'DSP output is a processed bus, not an independent source.' },
  master: { classification: 'processor', tapSource: null, status: 'unsupported', reason: 'Master output is the shared bus, not an independent source.' },
  record: { classification: 'sink', tapSource: null, status: 'none', reason: 'Recorder consumes the shared bus and has no independent source.' },
} as const;
export type BackendMainPluginId = keyof typeof BACKEND_MAIN_ADAPTERS;
export type BackendMainSourceChannel = `channel${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`;
export interface BackendMainAuthority {
  mode: 'OFF' | 'PRO' | 'AUTO_AI';
  userId: string;
  holderId: string | null;
  delegation: PluginDelegation | null;
}
export interface BackendMainAdapterDependencies {
  openTransport: (pluginId: BackendMainPluginId) => Promise<{ send: (block: PluginAudioBlock) => void; close: () => void }>;
  openTap: (channel: BackendMainSourceChannel, onBlock: (block: PluginAudioBlock) => void) => () => void;
  now?: () => number;
  onError?: (error: unknown) => void;
}

/** Connects an already-existing source tap to an injected transport outside the DSP process path. */
export class BackendMainAdapter {
  private epoch = 0;
  private key = '';
  private stopTap: (() => void) | null = null;
  private transport: Awaited<ReturnType<BackendMainAdapterDependencies['openTransport']>> | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private authority: BackendMainAuthority | null = null;
  constructor(readonly pluginId: BackendMainPluginId, private readonly deps: BackendMainAdapterDependencies) {}
  private valid(a: BackendMainAuthority): boolean {
    if (!a.userId) return false;
    if (a.mode === 'PRO') return a.holderId === a.userId;
    const d = a.delegation;
    return a.mode === 'AUTO_AI' && a.holderId === null && !!d && d.pluginId === this.pluginId && d.delegatedBy === a.userId && d.aiRole === PLUGIN_AI_ROLE[this.pluginId] && !!d.generationId && d.issuedAt <= (this.deps.now?.() ?? Date.now()) && d.expiresAt > (this.deps.now?.() ?? Date.now());
  }
  updateAuthority(authority: BackendMainAuthority): void {
    if (this.disposed) return;
    const d = authority.delegation;
    const key = JSON.stringify([authority.mode, authority.userId, authority.holderId, d?.pluginId, d?.delegatedBy, d?.aiRole, d?.generationId, d?.issuedAt, d?.expiresAt]);
    this.authority = { ...authority, delegation: d ? { ...d } : null };
    if (key === this.key && this.valid(authority)) return;
    this.stop(); this.key = key;
    const entry = BACKEND_MAIN_ADAPTERS[this.pluginId];
    if (entry.status !== 'available' || !this.valid(authority)) return;
    const epoch = this.epoch;
    if (authority.mode === 'AUTO_AI' && d) {
      this.expiry = setTimeout(() => { if (this.epoch === epoch) { this.stop(); this.key = ''; } }, Math.max(0, d.expiresAt - (this.deps.now?.() ?? Date.now())));
    }
    void this.deps.openTransport(this.pluginId).then(transport => {
      if (this.disposed || this.epoch !== epoch || !this.authority || !this.valid(this.authority)) { transport.close(); return; }
      this.transport = transport;
      try {
        const stopTap = this.deps.openTap(entry.tapSource, block => {
          if (this.epoch !== epoch || !this.authority || !this.valid(this.authority)) { if (this.epoch === epoch) this.stop(); return; }
          transport.send(block);
        });
        if (this.epoch !== epoch) stopTap();
        else this.stopTap = stopTap;
      } catch (error) { this.stop(); this.deps.onError?.(error); }
    }).catch(error => { if (this.epoch === epoch) { this.stop(); this.deps.onError?.(error); } });
  }
  private stop(): void {
    this.epoch++;
    if (this.expiry !== null) clearTimeout(this.expiry);
    this.expiry = null;
    this.stopTap?.(); this.stopTap = null;
    this.transport?.close(); this.transport = null;
  }
  /** Stop the current connection without preventing a later explicit activation. */
  suspend(): void { if (!this.disposed) { this.stop(); this.authority = null; } }
  dispose(): void { if (!this.disposed) { this.disposed = true; this.stop(); this.authority = null; } }
}
