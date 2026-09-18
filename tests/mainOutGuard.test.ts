// P0-1 (revidiert): Main-Out-Guard – KEIN Admin-Fallback, nur Lock-Owner.
// Deckt: Main-Out-Plugin-Menge, Owner-Auflösung (Bootstrap-Pin),
// Berechtigung und Payload-Validierung für `main-out-update`.
import { describe, it, expect } from 'vitest';
import {
  MAIN_OUT_PARAM_SPECS,
  MAIN_OUT_PLUGINS,
  MIXER_NEVER_CLOSES,
  canControlMainOut,
  canSetModuleState,
  validateMainOutPayload,
  isMainOutPlugin,
  parseMainOutUpdate,
  resolveMainOutUserId,
} from '../src/core/session/mainOutGuard';

describe('mainOutGuard: Plugin-Menge', () => {
  it('mixer und master sind Main-Out-Plugins', () => {
    expect(isMainOutPlugin('mixer')).toBe(true);
    expect(isMainOutPlugin('master')).toBe(true);
  });

  it('andere Plugins sind keine Main-Out-Plugins', () => {
    for (const id of ['eq', 'dsp', 'record', 'stem', 'song', '']) {
      expect(isMainOutPlugin(id)).toBe(false);
    }
    expect([...MAIN_OUT_PLUGINS].sort()).toEqual(['master', 'mixer']);
  });
});

describe('mainOutGuard: canControlMainOut (revidiert: kein Admin)', () => {
  it('nur der Lock-Owner darf steuern', () => {
    expect(canControlMainOut('mixer-1', 'mixer-1')).toBe(true);
    expect(canControlMainOut('someone-else', 'mixer-1')).toBe(false);
  });

  it('ohne Owner bleibt der Main-Out geschützt – unabhängig von Rolle', () => {
    expect(canControlMainOut('u-admin', '')).toBe(false);
    expect(canControlMainOut('u-admin', null)).toBe(false);
    expect(canControlMainOut('u-admin', undefined)).toBe(false);
    expect(canControlMainOut('u-admin')).toBe(false);
  });

  it('Bootstrap-Pin gewinnt nur, wenn exakt passend', () => {
    expect(canControlMainOut('pin-1', 'pin-1')).toBe(true);
    expect(canControlMainOut('u-guest', 'pin-1')).toBe(false);
  });
});

describe('mainOutGuard: resolveMainOutUserId', () => {
  it('gepinnter Owner wird übernommen, wenn er Mitglied ist', () => {
    const roles: Array<[string, string]> = [['u-a', 'admin'], ['mixer-1', 'guest']];
    expect(resolveMainOutUserId('mixer-1', roles)).toBe('mixer-1');
  });

  it('gepinnter Owner, der nicht Mitglied ist, wird ignoriert → leer', () => {
    const roles: Array<[string, string]> = [['u-a', 'admin']];
    expect(resolveMainOutUserId('ghost', roles)).toBe('');
  });

  it('ohne Pin gibt es KEINEN Owner (kein Admin-Fallback)', () => {
    const roles = new Map<string, string>([['u-admin', 'admin'], ['u-guest', 'guest']]);
    expect(resolveMainOutUserId(null, roles.entries())).toBe('');
  });

  it('ohne Pin und ohne Mitglieder → leer', () => {
    expect(resolveMainOutUserId(undefined, [])).toBe('');
  });
});

describe('mainOutGuard: parseMainOutUpdate', () => {
  it('akzeptiert gültige Zahl-/String-/Bool-/Null-Werte', () => {
    expect(parseMainOutUpdate({ param: 'masterVolume', value: 0.8 })).toEqual({ param: 'masterVolume', value: 0.8 });
    expect(parseMainOutUpdate({ param: 'fadeInSeconds', value: 3 })).toEqual({ param: 'fadeInSeconds', value: 3 });
    expect(parseMainOutUpdate({ param: 'mute', value: true })).toEqual({ param: 'mute', value: true });
    expect(parseMainOutUpdate({ param: 'label', value: 'live' })).toEqual({ param: 'label', value: 'live' });
    expect(parseMainOutUpdate({ param: 'reset', value: null })).toEqual({ param: 'reset', value: null });
  });

  it('lehnt ungültige Params/Objekte ab', () => {
    expect(parseMainOutUpdate(null)).toBeNull();
    expect(parseMainOutUpdate(undefined)).toBeNull();
    expect(parseMainOutUpdate({ param: '', value: 1 })).toBeNull();
    expect(parseMainOutUpdate({ param: 'a b', value: 1 })).toBeNull();
    expect(parseMainOutUpdate({ param: 'x'.repeat(65), value: 1 })).toBeNull();
    expect(parseMainOutUpdate({ param: 'ok', value: { nested: true } })).toBeNull();
    expect(parseMainOutUpdate({ param: 'ok', value: Number.NaN })).toBeNull();
  });
});

// COLLAB-P0-004 (Betreiberentscheidung 2026-09-17): mixerMONK ist die einzige
// Main-Einspeisung ("die anderen spielen zu, mixerMONK entscheidet") und darf nie
// geschlossen werden - OFF trennt die Signalkette und stoppt Main UND Clock
// (pluginAudioRouter.deactivatePlugin). Freiwillig darf es aktiv werden.
describe('mainOutGuard: canSetModuleState (mixerMONK nie schliessen)', () => {
  it('OFF fuer mixerMONK wird abgelehnt - auch fuer den Halter', () => {
    const asOwner = canSetModuleState(MIXER_NEVER_CLOSES, 'OFF', { isMainOutOwner: true });
    const asOther = canSetModuleState(MIXER_NEVER_CLOSES, 'OFF', { isMainOutOwner: false });
    expect(asOwner.allowed).toBe(false);
    expect(asOther.allowed).toBe(false);
    expect(asOwner.reason).toMatch(/Main-Out/);
    expect(asOwner.reason).toMatch(/Main und Clock/);
  });

  it('aktivieren ist erlaubt, aber weiterhin nur fuer den Halter', () => {
    for (const state of ['AUTO_AI', 'PRO']) {
      expect(canSetModuleState(MIXER_NEVER_CLOSES, state, { isMainOutOwner: true }).allowed).toBe(true);
      expect(canSetModuleState(MIXER_NEVER_CLOSES, state, { isMainOutOwner: false }).allowed).toBe(false);
    }
  });

  it('masterMONK bleibt schliessbar - aber nur fuer den Halter', () => {
    expect(canSetModuleState('master', 'OFF', { isMainOutOwner: true }).allowed).toBe(true);
    expect(canSetModuleState('master', 'OFF', { isMainOutOwner: false }).allowed).toBe(false);
  });

  it('alle uebrigen Module sind frei, auch fuer Nicht-Halter', () => {
    for (const id of ['eq', 'drop', 'voice', 'instru', 'perfor']) {
      expect(canSetModuleState(id, 'OFF', { isMainOutOwner: false }).allowed).toBe(true);
      expect(canSetModuleState(id, 'AUTO_AI', { isMainOutOwner: false }).allowed).toBe(true);
    }
  });
});
/**
 * COLLAB-P1-005: Main-Out-Parameter laufen server-inspizierbar. Der Server
 * prueft zwei Dinge getrennt - BERECHTIGUNG ueber `canControlMainOut` (nur der
 * mixerMONK-Halter, oben getestet) und PAYLOAD ueber `validateMainOutPayload`
 * (Allow-List + Bereich). Vorher fehlte die Payload-Pruefung komplett: jeder
 * formal gueltige name/Wert wurde an alle Peers gespiegelt.
 */
describe('mainOutGuard: validateMainOutPayload (COLLAB-P1-005)', () => {
  it('laesst die erlaubten Parameter in ihren Bereichen durch', () => {
    expect(validateMainOutPayload({ param: 'masterVolume', value: 0 }))
      .toEqual({ ok: true, param: 'masterVolume', value: 0 });
    expect(validateMainOutPayload({ param: 'masterVolume', value: 2 }))
      .toEqual({ ok: true, param: 'masterVolume', value: 2 });
    expect(validateMainOutPayload({ param: 'masterVolumeDb', value: -48 }))
      .toEqual({ ok: true, param: 'masterVolumeDb', value: -48 });
    expect(validateMainOutPayload({ param: 'masterVolumeDb', value: 12 }))
      .toEqual({ ok: true, param: 'masterVolumeDb', value: 12 });
    expect(validateMainOutPayload({ param: 'fadeInSeconds', value: 3 }))
      .toEqual({ ok: true, param: 'fadeInSeconds', value: 3 });
  });

  it('erlaubt genau diese drei Parameter (Allow-List)', () => {
    expect(Object.keys(MAIN_OUT_PARAM_SPECS).sort()).toEqual(['fadeInSeconds', 'masterVolume', 'masterVolumeDb']);
    // Formal gueltiger Payload, aber kein Main-Out-Parameter.
    expect(validateMainOutPayload({ param: 'bpm', value: 128 })).toEqual({ ok: false, reason: 'unknown-param' });
    expect(validateMainOutPayload({ param: 'channelGain', value: 1 })).toEqual({ ok: false, reason: 'unknown-param' });
  });

  it('weist Werte ausserhalb des Bereichs ab (kein stilles Clamping)', () => {
    expect(validateMainOutPayload({ param: 'masterVolume', value: 2.5 }))
      .toEqual({ ok: false, reason: 'value-out-of-range' });
    expect(validateMainOutPayload({ param: 'masterVolumeDb', value: 99 }))
      .toEqual({ ok: false, reason: 'value-out-of-range' });
    expect(validateMainOutPayload({ param: 'masterVolumeDb', value: -49 }))
      .toEqual({ ok: false, reason: 'value-out-of-range' });
    // Zahl erwartet: ein String-Wert ist kein Pegel.
    expect(validateMainOutPayload({ param: 'masterVolume', value: '1' }))
      .toEqual({ ok: false, reason: 'value-out-of-range' });
    expect(validateMainOutPayload({ param: 'masterVolume', value: true }))
      .toEqual({ ok: false, reason: 'value-out-of-range' });
    // NaN/Infinity fallen schon in parseMainOutUpdate durch (kein gueltiger Payload).
    expect(validateMainOutPayload({ param: 'masterVolume', value: Number.NaN }))
      .toEqual({ ok: false, reason: 'invalid-payload' });
    expect(validateMainOutPayload({ param: 'masterVolume', value: Number.POSITIVE_INFINITY }))
      .toEqual({ ok: false, reason: 'invalid-payload' });
  });

  it('weist kaputte Payloads ab', () => {
    expect(validateMainOutPayload(null)).toEqual({ ok: false, reason: 'invalid-payload' });
    expect(validateMainOutPayload({ param: 'a b', value: 1 })).toEqual({ ok: false, reason: 'invalid-payload' });
    expect(validateMainOutPayload({ value: 1 })).toEqual({ ok: false, reason: 'invalid-payload' });
    expect(validateMainOutPayload({ param: 'masterVolume', value: { nested: true } }))
      .toEqual({ ok: false, reason: 'invalid-payload' });
  });
});
