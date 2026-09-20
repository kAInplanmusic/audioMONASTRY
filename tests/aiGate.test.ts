import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AiGateError,
  __resetAiGate,
  aiGateStatus,
  aiOperatingModeForModuleState,
  assertRoleAllowed,
  blockMessage,
  defaultAiOperatingMode,
  getAiOperatingMode,
  isAiDisabled,
  isRoleAllowed,
  onAiOperatingModeChange,
  parseAiOperatingMode,
  roleBlockCode,
  setAiOperatingMode,
  setAiOperatingModeForModuleState,
  visualsEnabled,
} from '../src/core/ai/aiGate';
import { llmRouter } from '../src/core/ai/LlmRouter';

const ENV_KEYS = [
  'AI_MODE',
  'AI_OPERATING_MODE',
  'RP_AGENT_KEY',
  'RP_API_KEY',
  'RUNPOD_API_KEY',
  'RP_ENDPOINT_ID_BRAIN',
  'RUNPOD_ENDPOINT_ID_BRAIN',
  'RP_BRAIN_OPENAI_URL',
  'RUNPOD_BRAIN_OPENAI_URL',
  'OLLAMA_URL',
  'OLLAMA_MODEL',
  'AI_ALLOW_EXTERNAL_LLM',
] as const;

const ALWAYS_ON_ROLES = ['brain', 'ears', 'voiceGen', 'music', 'orchestrator'] as const;
const VISUAL_ROLES = ['imageHq', 'videoReal', 'videoAbstract'] as const;
const ALL_ROLES = [...ALWAYS_ON_ROLES, ...VISUAL_ROLES] as const;

let calls: string[] = [];

function mockFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ status: 'COMPLETED', output: { text: 'x' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

describe('AI-Betriebsmodus (aiGate)', () => {
  beforeEach(() => {
    calls = [];
    __resetAiGate();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetAiGate();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it('liest den Modus aus Strings (env und API)', () => {
    expect(parseAiOperatingMode('off')).toBe('off');
    expect(parseAiOperatingMode('AUS')).toBe('off');
    expect(parseAiOperatingMode('on')).toBe('on-no-visuals');
    expect(parseAiOperatingMode('no-visuals')).toBe('on-no-visuals');
    expect(parseAiOperatingMode('full')).toBe('on-with-visuals');
    expect(parseAiOperatingMode('visuals')).toBe('on-with-visuals');
    expect(parseAiOperatingMode('quatsch')).toBeNull();
    expect(parseAiOperatingMode('')).toBeNull();
  });

  it('startet ohne env im Modus „AI an, ohne Visualisierung“', () => {
    expect(defaultAiOperatingMode()).toBe('on-no-visuals');
    expect(getAiOperatingMode()).toBe('on-no-visuals');
    expect(isAiDisabled()).toBe(false);
    expect(visualsEnabled()).toBe(false);
  });

  it('nimmt den Modus aus AI_MODE (harter Server-Schalter)', () => {
    process.env.AI_MODE = 'off';
    __resetAiGate();
    expect(getAiOperatingMode()).toBe('off');
    expect(isAiDisabled()).toBe(true);

    process.env.AI_MODE = 'on-with-visuals';
    __resetAiGate();
    expect(getAiOperatingMode()).toBe('on-with-visuals');
    expect(visualsEnabled()).toBe(true);

    process.env.AI_MODE = 'unsinn';
    __resetAiGate();
    expect(getAiOperatingMode()).toBe('on-no-visuals');
  });

  it('bildet den aiMONK-Modul-Zustand auf den Modus ab', () => {
    expect(aiOperatingModeForModuleState('OFF')).toBe('off');
    expect(aiOperatingModeForModuleState('AUTO_AI')).toBe('on-no-visuals');
    expect(aiOperatingModeForModuleState('PRO')).toBe('on-with-visuals');

    expect(setAiOperatingModeForModuleState('OFF')).toBe('off');
    expect(getAiOperatingMode()).toBe('off');
    expect(setAiOperatingModeForModuleState('PRO')).toBe('on-with-visuals');
    expect(getAiOperatingMode()).toBe('on-with-visuals');
  });

  it('erlaubt Rollen je Modus (Matrix)', () => {
    setAiOperatingMode('off', { source: 'test' });
    expect(ALL_ROLES.every((role) => !isRoleAllowed(role))).toBe(true);

    setAiOperatingMode('on-no-visuals', { source: 'test' });
    expect(ALWAYS_ON_ROLES.every((role) => isRoleAllowed(role))).toBe(true);
    expect(VISUAL_ROLES.every((role) => !isRoleAllowed(role))).toBe(true);
    expect(VISUAL_ROLES.every((role) => roleBlockCode(role) === 'AI_VISUALS_OFF')).toBe(true);

    setAiOperatingMode('on-with-visuals', { source: 'test' });
    expect(ALL_ROLES.every((role) => isRoleAllowed(role))).toBe(true);
    expect(ALL_ROLES.every((role) => roleBlockCode(role) === null)).toBe(true);
  });

  it('wirft beim Sperren einen nicht wiederholbaren AiGateError', () => {
    setAiOperatingMode('on-no-visuals', { source: 'test' });
    try {
      assertRoleAllowed('imageHq', 'vision');
      throw new Error('assertRoleAllowed hätte werfen müssen');
    } catch (error) {
      expect(error).toBeInstanceOf(AiGateError);
      const gateError = error as AiGateError;
      expect(gateError.code).toBe('AI_VISUALS_OFF');
      expect(gateError.role).toBe('imageHq');
      expect(gateError.retryable).toBe(false);
      expect(gateError.message).toMatch(/Visual-Rolle/);
    }

    setAiOperatingMode('off', { source: 'test' });
    expect(() => assertRoleAllowed('brain', 'runpod')).toThrow(/AI ist ausgeschaltet/);
    // Immer-Rollen laufen bei „AI an ohne Visuals“ ohne Fehler.
    setAiOperatingMode('on-no-visuals', { source: 'test' });
    expect(() => assertRoleAllowed('brain', 'runpod')).not.toThrow();
  });

  it('liefert Klartext-Meldungen zu jedem Sperrgrund', () => {
    expect(blockMessage('AI_DISABLED', 'brain', 'runpod')).toMatch(/nur die Hetzner-Kosten/);
    expect(blockMessage('AI_VISUALS_OFF', 'videoReal', 'vision')).toMatch(/Visual-Rolle/);
  });

  it('meldet Moduswechsel an Zuhörer (und räumt sie beim Reset ab)', () => {
    const seen: string[] = [];
    const off = onAiOperatingModeChange((mode) => seen.push(mode));

    setAiOperatingMode('off', { source: 'test' });
    setAiOperatingMode('off', { source: 'test' }); // unverändert → keine Meldung
    setAiOperatingMode('on-with-visuals', { source: 'test' });
    expect(seen).toEqual(['off', 'on-with-visuals']);

    off();
    setAiOperatingMode('on-no-visuals', { source: 'test' });
    expect(seen).toEqual(['off', 'on-with-visuals']);

    // Ein defekter Zuhörer darf den Schalter nicht blockieren.
    onAiOperatingModeChange(() => { throw new Error('kaputt'); });
    expect(() => setAiOperatingMode('off', { source: 'test' })).not.toThrow();
    expect(getAiOperatingMode()).toBe('off');
  });

  it('fasst den Status (Rollen, Sperren, Quelle) zusammen', () => {
    const status = aiGateStatus(ALL_ROLES);
    expect(status.mode).toBe('on-no-visuals');
    expect(status.source).toBe('default');
    expect(status.allowedRoles).toEqual([...ALWAYS_ON_ROLES]);
    expect(status.blockedRoles).toEqual([...VISUAL_ROLES]);

    setAiOperatingMode('off', { source: 'api' });
    expect(aiGateStatus(ALL_ROLES).source).toBe('api');
    expect(aiGateStatus(ALL_ROLES).allowedRoles).toEqual([]);
  });
});

/**
 * INFRA-FEAT-001: Der Schalter muss den GPU-Verkehr wirklich stoppen. Der
 * Beweis läuft über den LlmRouter (der Pfad, den die App für Brain-Aufrufe
 * nutzt): bei „AI aus“ darf kein einziger Request an api.runpod.ai gehen.
 */
describe('LlmRouter respektiert den AI-Schalter', () => {
  beforeEach(() => {
    calls = [];
    __resetAiGate();
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.RP_AGENT_KEY = 'rp_test';
    process.env.RP_ENDPOINT_ID_BRAIN = 'brain-ep';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetAiGate();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it('bietet bei „AI an ohne Visuals“ den GPU-Provider an', () => {
    const ranked = llmRouter.rankProviders('moderate').map((p) => p.id);
    expect(ranked).toContain('runpod-local');
  });

  it('nimmt bei „AI aus“ den GPU-Provider aus der Kette – und feuert nichts', async () => {
    mockFetch();
    setAiOperatingMode('off', { source: 'test' });

    expect(llmRouter.rankProviders('moderate').map((p) => p.id)).not.toContain('runpod-local');

    // Ohne GPU-Provider und ohne Ollama bleibt kein Provider → klarer Fehler
    // statt eines stillen RunPod-Aufrufs.
    await expect(llmRouter.complete({ prompt: 'hallo', complexity: 'moderate' })).rejects.toThrow(
      /Kein LLM-Provider verfügbar/,
    );
    expect(calls.filter((url) => url.includes('runpod.ai'))).toHaveLength(0);
  });
});
