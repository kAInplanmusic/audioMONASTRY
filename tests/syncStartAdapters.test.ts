// @vitest-environment node
/**
 * UI2-P0-003-F1: SYNC-Start für song, voice und stem
 * ===================================================
 * Die SYNC-Taste gehört auch zu song/voice/stem. Vorher hatten diese Adapter
 * keine Abspiel-/Startlogik, an die sich ein taktgenauer Start hängen ließ.
 * Jetzt hat jeder einen `play`/`start`-Befehl, der über `scheduleSyncStart`
 * läuft: SYNC aus → sofort, SYNC an → taktgleich (geplant).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SongPluginAdapter } from '../src/plugins/adapters/SongPluginAdapter';
import { VoicePluginAdapter } from '../src/plugins/adapters/VoicePluginAdapter';
import { StemPluginAdapter } from '../src/plugins/adapters/StemPluginAdapter';
import type { PluginRuntimeContext } from '../src/plugins/plugin_interface';
import { isSyncPlugin, setPluginSync } from '../src/core/session/pluginSync';

function makeContext(triggerEvent: (track: string, velocity: number) => void): PluginRuntimeContext {
  return {
    audio: {
      id: 'test-audio',
      init: async () => undefined,
      play: async () => undefined,
      stop: () => undefined,
      setTempo: () => undefined,
      getTempo: () => 120,
      loadTrackSample: async () => undefined,
      triggerEvent: triggerEvent as never,
      setChannelGain: () => undefined,
      setChannelPan: () => undefined,
      setChannelEQ: () => undefined,
      setMasterVolume: () => undefined,
      onStepUpdate: () => () => undefined,
    },
    userId: 'User1',
    requestLock: () => true,
    releaseLock: () => undefined,
    isLockedByOther: () => false,
    log: () => undefined,
  };
}

const CASES = [
  ['song', () => new SongPluginAdapter(), 'channel2'],
  ['voice', () => new VoicePluginAdapter(), 'channel6'],
  ['stem', () => new StemPluginAdapter(), 'channel8'],
] as const;

/**
 * SYNC umschalten: die UI-Wahrheit (pluginSync) gewinnt, wenn das Plugin dort
 * geführt ist; der adaptereigene Wert deckt headless/Nicht-Sync-Plugins ab.
 */
function setSync(pluginId: string, on: boolean): void {
  if (isSyncPlugin(pluginId)) setPluginSync(pluginId, on);
}

describe('UI2-P0-003-F1 · SYNC-Start je Adapter', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  for (const [name, make, track] of CASES) {
    it(`${name}: SYNC aus startet sofort, SYNC an plant taktgleich`, async () => {
      const calls: string[] = [];
      const adapter = make();
      await adapter.initialize(makeContext((t) => calls.push(t)));

      // SYNC aus → sofort.
      setSync(adapter.manifest.id, false);
      const immediate = await adapter.handleCommand({ name: 'play' });
      expect(immediate).toMatchObject({ ok: true, track });
      expect(calls).toEqual([track]);

      // SYNC an → nicht sofort, sondern geplant (taktgleich zu Main).
      calls.length = 0;
      setSync(adapter.manifest.id, true);
      await adapter.handleCommand({ name: 'play' });
      expect(calls).toEqual([]);
      vi.advanceTimersByTime(5000);
      expect(calls).toEqual([track]);

      await adapter.dispose();
    });
  }
});
