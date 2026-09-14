import { describe, expect, it } from 'vitest';
import {
  RELAY_PLUGIN_STATES,
  buildPluginStateRelayPayload,
} from '../src/core/session/pluginStateRelay';

/**
 * COLLAB-P0-002: Der Server relayed Plugin-States als `plugin-state` an die
 * Session. Diese Tests sichern den Client-Vertrag ab, an dem der Relay-Pfad
 * vorher stumm gescheitert ist (Zod strippte type/senderId/timestamp aus dem
 * gespreadeten Payload).
 */
describe('buildPluginStateRelayPayload', () => {
  const base = {
    pluginId: 'eq',
    state: 'PRO',
    senderUserId: 'user-abc123',
    senderRole: 'member',
    revision: 7,
    eventId: 'user-abc123:eq:xyz:1',
  };

  it('setzt type auf PLUGIN_STATE_UPDATE (sonst verwirft dispatchDataMessage)', () => {
    const payload = buildPluginStateRelayPayload(base);
    expect(payload.type).toBe('PLUGIN_STATE_UPDATE');
    // Genau dieser Fallstrick: der Socket-Event-Name ist 'plugin-state'.
    expect(payload.type).not.toBe('plugin-state');
  });

  it('setzt senderId autoritativ aus der Session-Zuordnung', () => {
    const payload = buildPluginStateRelayPayload({
      ...base,
      senderUserId: 'user-server-side',
    });
    // Nicht der (nicht deklarierte) Client-Wert, sondern die Session-Identität:
    // nur so greifen Lock-Schatten-Filter und LWW-Dedupe im Client.
    expect(payload.senderId).toBe('user-server-side');
  });

  it('liefert einen nutzbaren timestamp, auch ohne Sender-Zeitstempel', () => {
    const withTs = buildPluginStateRelayPayload({ ...base, timestamp: 1_700_000_000_000 });
    expect(withTs.timestamp).toBe(1_700_000_000_000);

    const withoutTs = buildPluginStateRelayPayload({ ...base, now: 42 });
    expect(withoutTs.timestamp).toBe(42);

    // Ungültige Werte dürfen nicht durchrutschen (Client prüft Number.isFinite).
    const invalid = buildPluginStateRelayPayload({ ...base, timestamp: Number.NaN, now: 7 });
    expect(invalid.timestamp).toBe(7);
  });

  it('reicht Revision, Event-ID und Sequenz für Dedupe/Ordnung durch', () => {
    const payload = buildPluginStateRelayPayload({ ...base, sequence: 3 });
    expect(payload.revision).toBe(7);
    expect(payload.eventId).toBe(base.eventId);
    expect(payload.sequence).toBe(3);
    expect(payload.senderRole).toBe('member');

    // Ohne Sequenz bleibt das Feld weg (kein undefined im JSON).
    const noSeq = buildPluginStateRelayPayload(base);
    expect('sequence' in noSeq).toBe(false);
  });

  it('erfüllt alle Pflichtfelder, die der Client prüft', () => {
    const payload = buildPluginStateRelayPayload(base);
    // WebRTCManager.dispatchDataMessage: type ist ein nicht-leerer String.
    expect(typeof payload.type).toBe('string');
    expect(payload.type.length).toBeGreaterThan(0);
    // ModuleStateContext: pluginId, senderId, state, timestamp müssen gültig sein.
    expect(payload.pluginId.length).toBeGreaterThan(0);
    expect(payload.senderId.length).toBeGreaterThan(0);
    expect(RELAY_PLUGIN_STATES).toContain(payload.state);
    expect(Number.isFinite(payload.timestamp)).toBe(true);
    expect(payload.timestamp).toBeGreaterThanOrEqual(0);
  });
});
