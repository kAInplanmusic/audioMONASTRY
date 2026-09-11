import { describe, expect, it } from 'vitest';
import {
  LISTENER_MODES,
  SESSION_MODE_LABEL,
  isListenerMode,
  listenerModeForPath,
  normalizeSessionMode,
} from '../src/core/session/listenerMode';

describe('Session-Modus / Ghost-User', () => {
  it('akzeptiert genau die Listener-Modi', () => {
    expect(LISTENER_MODES).toEqual(['master-out', 'visual-out']);
    expect(normalizeSessionMode('master-out')).toBe('master-out');
    expect(normalizeSessionMode('visual-out')).toBe('visual-out');
    expect(normalizeSessionMode('member')).toBe('member');
  });

  it('fällt bei Unbekanntem/Leerem sicher auf member zurück', () => {
    expect(normalizeSessionMode(undefined)).toBe('member');
    expect(normalizeSessionMode(null)).toBe('member');
    expect(normalizeSessionMode('')).toBe('member');
    expect(normalizeSessionMode('admin')).toBe('member');
    expect(normalizeSessionMode('MASTER-OUT')).toBe('member'); // Groß-/Kleinschreibung ist kein Modus
    expect(normalizeSessionMode(' visual-out ')).toBe('visual-out'); // trim
  });

  it('erkennt Listener-Modi', () => {
    expect(isListenerMode('member')).toBe(false);
    expect(isListenerMode('master-out')).toBe(true);
    expect(isListenerMode('visual-out')).toBe(true);
  });

  it('leitet den Modus aus den fixen Andock-URLs ab', () => {
    expect(listenerModeForPath('/')).toBe('member');
    expect(listenerModeForPath('/master-out')).toBe('master-out');
    expect(listenerModeForPath('/ghost/5')).toBe('master-out');
    expect(listenerModeForPath('/visual-out')).toBe('visual-out');
    expect(listenerModeForPath('/ghost/6')).toBe('visual-out');
    expect(listenerModeForPath('/ghost/7')).toBe('member');
    expect(listenerModeForPath('')).toBe('member');
  });

  it('hat für jeden Modus ein Label', () => {
    for (const mode of ['member', ...LISTENER_MODES] as const) {
      expect(SESSION_MODE_LABEL[mode]).toBeTruthy();
    }
  });
});
