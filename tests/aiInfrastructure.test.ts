import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  AI_MAX_FLEET_EUR_PER_HOUR,
  AI_MAX_GPU_ENDPOINTS,
  AI_MAX_STORAGE_EUR_PER_MONTH,
  GPU_ENDPOINT_ROLES,
  GPU_ROLE_IDS,
  LEGACY_GPU_ENDPOINTS,
  assertFleetHourlyBudget,
  assertGpuEndpointBudget,
  assertStorageBudget,
  endpointNameForRole,
  estimateFleetEurPerHour,
} from '../src/config/aiInfrastructure';

describe('AI-Infrastruktur (Rollen + Budgets)', () => {
  const original = process.env.AI_MAX_GPU_ENDPOINTS;

  afterEach(() => {
    if (original === undefined) delete process.env.AI_MAX_GPU_ENDPOINTS;
    else process.env.AI_MAX_GPU_ENDPOINTS = original;
    vi.resetModules();
  });

  it('führt alle acht Flotten-Rollen', () => {
    expect(GPU_ROLE_IDS).toEqual([
      'brain',
      'ears',
      'voiceGen',
      'music',
      'imageHq',
      'videoReal',
      'videoAbstract',
      'orchestrator',
    ]);
    // Seit der 8-Instanzen-Architektur sind Visuals echte Manifest-Rollen –
    // es gibt keine manifestfreien Zusatz-Rollen mehr.
    expect(GPU_ENDPOINT_ROLES).toEqual([...GPU_ROLE_IDS]);
    // Betreiber-Freigabe 2026-09-15: Vollausbau auf acht Instanzen.
    expect(AI_MAX_GPU_ENDPOINTS).toBe(8);
    expect(LEGACY_GPU_ENDPOINTS).toContain('audiomonastry-ai');
    expect(() => assertGpuEndpointBudget()).not.toThrow();
  });

  it('leitet die Endpoint-Namen aus der Rolle ab', () => {
    expect(endpointNameForRole('brain')).toBe('audiomonastry-ai-brain');
    expect(endpointNameForRole('ears')).toBe('audiomonastry-ai-ears');
    expect(endpointNameForRole('voiceGen')).toBe('audiomonastry-ai-voice');
    expect(endpointNameForRole('music')).toBe('audiomonastry-ai-music');
    expect(endpointNameForRole('imageHq')).toBe('audiomonastry-ai-image');
    expect(endpointNameForRole('videoReal')).toBe('audiomonastry-ai-video-real');
    expect(endpointNameForRole('videoAbstract')).toBe('audiomonastry-ai-video-abstract');
    expect(endpointNameForRole('orchestrator')).toBe('audiomonastry-ai-orchestrator');
  });

  it('wirft, wenn mehr als acht GPU-Endpoints erlaubt werden', async () => {
    process.env.AI_MAX_GPU_ENDPOINTS = '9';
    vi.resetModules();
    const mod = await import('../src/config/aiInfrastructure');
    expect(() => mod.assertGpuEndpointBudget()).toThrow(/zwischen 1 und 8/);
  });

  it('wirft bei 0 GPU-Endpoints', async () => {
    process.env.AI_MAX_GPU_ENDPOINTS = '0';
    vi.resetModules();
    const mod = await import('../src/config/aiInfrastructure');
    expect(() => mod.assertGpuEndpointBudget()).toThrow(/zwischen 1 und 8/);
  });

  it('hält die Flotte im Stundennbudget (10 €/h)', () => {
    // Vollausbau: acht A6000-Instanzen à 0,49 €/h = 3,92 €/h.
    expect(estimateFleetEurPerHour([...GPU_ROLE_IDS])).toBeCloseTo(3.92, 2);
    expect(() => assertFleetHourlyBudget([...GPU_ROLE_IDS])).not.toThrow();
    // Mit Hetzner-Instanzen zusätzlich bleibt es unter 10 €/h …
    expect(() => assertFleetHourlyBudget([...GPU_ROLE_IDS], 6)).not.toThrow();
    // … aber nicht, wenn die Stunde teurer würde.
    expect(() => assertFleetHourlyBudget([...GPU_ROLE_IDS], 20)).toThrow(
      /übersteigen das Budget/,
    );
    expect(AI_MAX_FLEET_EUR_PER_HOUR).toBe(10);
  });

  it('hält Speicher/Snapshots im Monatsbudget (5 €/Monat)', () => {
    expect(() => assertStorageBudget(4)).not.toThrow();
    expect(() => assertStorageBudget(6)).toThrow(/übersteigen das Budget/);
    expect(() => assertStorageBudget(-1)).toThrow(/nicht-negative/);
    expect(AI_MAX_STORAGE_EUR_PER_MONTH).toBe(5);
  });
});
