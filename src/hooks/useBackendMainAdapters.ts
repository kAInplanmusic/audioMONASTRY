import { createBackendMainLazyPublisher } from '../core/audio/backendMainLazyPublisher';
import { readPluginTransport } from '../core/session/pluginTransport';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { BACKEND_MAIN_ADAPTERS, BackendMainAdapter, type BackendMainPluginId } from '../core/audio/backendMainAdapter';
import { openBackendMainPublisher } from '../core/audio/backendMainPublisher';
import { audioEngine } from '../utils/audioEngine';
import { webRTCManager } from '../utils/WebRTCManager';

/** Normal App wiring: server-replicated modes/locks select only this actor's sources. */
export function useBackendMainAdapters(enabled: boolean, modes: Record<string, string | undefined>, locks: Record<string, { lockedBy?: string | null; active?: boolean }>) {
  const adapters = useRef<Map<BackendMainPluginId, BackendMainAdapter>>(new Map());
  const grants = useSyncExternalStore(webRTCManager.subscribeDelegations, webRTCManager.getDelegations);
  useEffect(() => {
    if (!enabled) return;
    let sinkReady: Promise<boolean> | null = null;
    for (const id of Object.keys(BACKEND_MAIN_ADAPTERS) as BackendMainPluginId[]) {
      const fail = (error: unknown) => { sinkReady = null; adapter.suspend(); console.error(`[backend-main:${id}]`, error); };
      const adapter = new BackendMainAdapter(id, {
        openTransport: async plugin => {
          sinkReady ??= audioEngine.connectV2LiveOutput();
          if (!await sinkReady) throw new Error('Backend Main requires the live V2 source renderer');
          return createBackendMainLazyPublisher(() => openBackendMainPublisher({
            origin: location.href,
            requestTicket: target => webRTCManager.requestBackendMainTicket('contributor', target, webRTCManager.delegationProof(target)),
            createSocket: url => webRTCManager.createBackendMainSocket(url),
            onError: fail,
          }, plugin), error => fail(error));
        },
        openTap: (channel, callback) => {
          audioEngine.setBackendMainSourceAuthority(channel, true);
          let lastPlay = readPluginTransport(id).at;
          let stopTap: () => void;
          try { stopTap = audioEngine.v2LiveSink.subscribeBackendMainSource(channel, callback, fail); }
          catch (error) { audioEngine.setBackendMainSourceAuthority(channel, false); throw error; }
          const timer = setInterval(() => {
            const transport = readPluginTransport(id);
            if (transport.at > lastPlay) {
              lastPlay = transport.at;
              if (!audioEngine.isMainHolderActive()) {
                if (transport.playing) audioEngine.triggerEvent(channel, .9);
                else audioEngine.v2LiveSink.stopSample(channel);
              }
            }
          }, 100);
          return () => { clearInterval(timer); try { stopTap(); } finally { audioEngine.setBackendMainSourceAuthority(channel, false); } };
        },
        onError: fail,
      });
      adapters.current.set(id, adapter);
    }
    const active = adapters.current;
    return () => { for (const adapter of active.values()) adapter.dispose(); active.clear(); };
  }, [enabled]);
  useEffect(() => {
    for (const [id, adapter] of adapters.current) {
      const mode = modes[id];
      adapter.updateAuthority({ mode: mode === 'PRO' || mode === 'AUTO_AI' ? mode : 'OFF',
        userId: webRTCManager.userId, holderId: locks[id]?.active ? locks[id].lockedBy ?? null : null,
        delegation: grants[id] ?? null });
    }
  }, [enabled, modes, locks, grants]);
}
