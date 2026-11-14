import { describe, expect, it, vi } from 'vitest';
import { BACKEND_MAIN_ADAPTERS, BackendMainAdapter, type BackendMainPluginId, type BackendMainAuthority } from '../src/core/audio/backendMainAdapter';
import { PLUGIN_AI_ROLE } from '../src/core/session/pluginDelegation';
import type { PluginAudioBlock } from '../src/plugins/plugin_interface';

const block: PluginAudioBlock = { channels: [new Float32Array([0.25]), new Float32Array([-0.25])], frameCount: 1, sampleRate: 96000, timestamp: 0 };
const human: BackendMainAuthority = { mode: 'PRO', userId: 'alice', holderId: 'alice', delegation: null };
function fixture(id: BackendMainPluginId) {
  let callback: ((value: PluginAudioBlock) => void) | undefined;
  const send = vi.fn(), close = vi.fn(), stop = vi.fn();
  const openTap = vi.fn((_channel, cb: (value: PluginAudioBlock) => void) => { callback = cb; return stop; });
  const openTransport = vi.fn(async () => ({ send, close }));
  const adapter = new BackendMainAdapter(id, { openTap, openTransport, now: () => 100 });
  return { adapter, openTap, openTransport, send, close, stop, emit: () => callback?.(block) };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
for (const id of Object.keys(BACKEND_MAIN_ADAPTERS) as BackendMainPluginId[]) {
  describe(`Backend Main ${id}`, () => {
    const entry = BACKEND_MAIN_ADAPTERS[id];
    it('connects only an authorized human source and stops on OFF', async () => {
      const f = fixture(id); f.adapter.updateAuthority(human); await settle(); f.emit();
      if (entry.status === 'available') {
        expect(f.openTap).toHaveBeenCalledWith(entry.tapSource, expect.any(Function));
        expect(f.send).toHaveBeenCalledWith(block);
      } else {
        expect(entry.reason).toBeTruthy(); expect(f.openTransport).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
      }
      f.adapter.updateAuthority({ ...human, mode: 'OFF' }); f.emit();
      expect(f.send).toHaveBeenCalledTimes(entry.status === 'available' ? 1 : 0);
      f.adapter.dispose();
    });
    it('accepts only current delegated AI and stops after revocation', async () => {
      const f = fixture(id);
      const delegation = { pluginId: id, delegatedBy: 'alice', aiRole: PLUGIN_AI_ROLE[id] ?? '', generationId: 'generation', issuedAt: 0, expiresAt: 1000 };
      f.adapter.updateAuthority({ mode: 'AUTO_AI', userId: 'alice', holderId: null, delegation }); await settle(); f.emit();
      expect(f.send).toHaveBeenCalledTimes(entry.status === 'available' ? 1 : 0);
      f.adapter.updateAuthority({ mode: 'AUTO_AI', userId: 'alice', holderId: null, delegation: null }); f.emit();
      expect(f.send).toHaveBeenCalledTimes(entry.status === 'available' ? 1 : 0);
      f.adapter.dispose();
    });
    it('rejects foreign ownership and fences pending setup after holder change', async () => {
      const f = fixture(id); f.adapter.updateAuthority({ ...human, holderId: 'bob' }); await settle();
      expect(f.openTransport).not.toHaveBeenCalled();
      f.adapter.updateAuthority(human); f.adapter.updateAuthority({ ...human, holderId: 'bob' }); await settle(); f.emit();
      expect(f.openTap).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
      if (entry.status === 'available') expect(f.close).toHaveBeenCalledOnce();
      f.adapter.dispose(); f.adapter.dispose();
    });
  });
}

it('suspends a failed connection and permits an explicit OFF/ON restart', async () => {
  const f = fixture('drop'); f.adapter.updateAuthority(human); await settle(); f.emit();
  f.adapter.suspend(); f.emit(); expect(f.stop).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledOnce(); expect(f.send).toHaveBeenCalledOnce();
  f.adapter.updateAuthority({ ...human, mode: 'OFF' }); f.adapter.updateAuthority(human); await settle(); f.emit();
  expect(f.openTransport).toHaveBeenCalledTimes(2); expect(f.send).toHaveBeenCalledTimes(2); f.adapter.dispose();
});
it('closes stale asynchronous transport after foreign takeover or AI revocation', async () => {
  const callbacks: Array<(value: { send: (block: PluginAudioBlock) => void; close: () => void }) => void> = [];
  const openTap = vi.fn(() => vi.fn()), close = vi.fn(), send = vi.fn();
  const adapter = new BackendMainAdapter('drop', { openTap, openTransport: () => new Promise(resolve => callbacks.push(resolve)), now: () => 100 });
  adapter.updateAuthority(human); adapter.updateAuthority({ ...human, holderId: 'bob' }); callbacks.shift()?.({ send, close }); await settle();
  expect(close).toHaveBeenCalledOnce(); expect(openTap).not.toHaveBeenCalled();
  const delegation = { pluginId: 'drop', delegatedBy: 'alice', aiRole: PLUGIN_AI_ROLE.drop, generationId: 'g', issuedAt: 0, expiresAt: 1000 };
  adapter.updateAuthority({ mode: 'AUTO_AI', userId: 'alice', holderId: null, delegation });
  adapter.updateAuthority({ mode: 'AUTO_AI', userId: 'alice', holderId: null, delegation: null }); callbacks.shift()?.({ send, close }); await settle();
  expect(close).toHaveBeenCalledTimes(2); expect(openTap).not.toHaveBeenCalled(); adapter.dispose();
});
it('cleans up after tap setup fails and can restart after error suspension', async () => {
  const close = vi.fn(), onError = vi.fn(), openTap = vi.fn().mockImplementationOnce(() => { throw new Error('tap failed'); }).mockReturnValue(vi.fn());
  const adapter = new BackendMainAdapter('drop', { openTap, openTransport: async () => ({ send: vi.fn(), close }), onError });
  adapter.updateAuthority(human); await settle(); expect(close).toHaveBeenCalledOnce(); expect(onError).toHaveBeenCalledOnce();
  adapter.suspend(); adapter.updateAuthority(human); await settle(); expect(openTap).toHaveBeenCalledTimes(1);
  adapter.updateAuthority({ ...human, mode: 'OFF' }); adapter.updateAuthority(human); await settle(); expect(openTap).toHaveBeenCalledTimes(2); adapter.dispose(); expect(close).toHaveBeenCalledTimes(2);
});
