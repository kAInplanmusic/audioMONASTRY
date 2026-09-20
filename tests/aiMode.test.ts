import { describe, expect, it, afterEach } from 'vitest';
import { currentAiMode, isAiModeActive, setAiModeActive, setAiModeFromModuleState } from '../src/core/ai/aiMode';
import { __resetAiGate, getAiOperatingMode } from '../src/core/ai/aiGate';

/**
 * NEW-D1-3 + INFRA-FEAT-001: `aiMode` ist seit dem Umbau nur noch die
 * Client-Fassade des Betriebsmodus aus `aiGate.ts`. Der Default folgt der
 * Konstitution (§2): „AI an“ mit Visuals nur bei Abruf.
 */
describe('NEW-D1-3: AI-Modus (Client-Fassade des Betriebsmodus)', () => {
  afterEach(() => {
    __resetAiGate();
  });

  it('kann aktiviert/deaktiviert werden', () => {
    // Default laut Konstitution: AI an, Visual-Rollen gesperrt.
    expect(getAiOperatingMode()).toBe('on-no-visuals');
    expect(isAiModeActive()).toBe(true);

    setAiModeActive(false);
    expect(isAiModeActive()).toBe(false);
    expect(getAiOperatingMode()).toBe('off');

    setAiModeActive(true);
    expect(isAiModeActive()).toBe(true);
    expect(getAiOperatingMode()).toBe('on-no-visuals');
  });

  it('stuft ein aktives PRO nicht auf „ohne Visuals“ zurück', () => {
    setAiModeActive(true); // idempotent: PR
    setAiModeFromModuleState('PRO');
    expect(currentAiMode()).toBe('on-with-visuals');
    expect(isAiModeActive()).toBe(true);

    // `setAiModeActive(true)` darf die Visual-Freigabe nicht kassieren.
    setAiModeActive(true);
    expect(currentAiMode()).toBe('on-with-visuals');
  });

  it('bildet den Modul-Zustand auf den Betriebsmodus ab', () => {
    expect(setAiModeFromModuleState('AUTO_AI')).toBe('on-no-visuals');
    expect(setAiModeFromModuleState('PRO')).toBe('on-with-visuals');
    expect(setAiModeFromModuleState('OFF')).toBe('off');
    expect(isAiModeActive()).toBe(false);
  });
});
