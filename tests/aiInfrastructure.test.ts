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

  it('führt die drei Audio-Rollen und zusätzlich die Vision-Rolle', () => {
    expect(GPU_ROLE_IDS).toEqual(['brain', 'ears', 'voiceGen']);
    expect(GPU_ENDPOINT_ROLES).toEqual(['brain', 'ears', 'voiceGen', 'vision']);
    // Betreiber-Freigabe 2026-09-11: eine vierte Instanz ist erlaubt.
    expect(AI_MAX_GPU_ENDPOINTS).toBe(4);
    expect(LEGACY_GPU_ENDPOINTS).toContain('samplemonk-ai');
    expect(() => assertGpuEndpointBudget()).not.toThrow();
  });

  it('leitet die Endpoint-Namen aus der Rolle ab', () => {
    expect(endpointNameForRole('brain')).toBe('samplemonk-ai-brain');
    expect(endpointNameForRole('ears')).toBe('samplemonk-ai-ears');
    expect(endpointNameForRole('voiceGen')).toBe('samplemonk-ai-voice');
    expect(endpointNameForRole('vision')).toBe('samplemonk-ai-vision');
  });

  it('wirft, wenn mehr als vier GPU-Endpoints erlaubt werden', async () => {
    process.env.AI_MAX_GPU_ENDPOINTS = '5';
    vi.resetModules();
    const mod = await import('../src/config/aiInfrastructure');
    expect(() => mod.assertGpuEndpointBudget()).toThrow(/zwischen 1 und 4/);
  });

  it('wirft bei 0 GPU-Endpoints', async () => {
    process.env.AI_MAX_GPU_ENDPOINTS = '0';
    vi.resetModules();
    const mod = await import('../src/config/aiInfrastructure');
    expect(() => mod.assertGpuEndpointBudget()).toThrow(/zwischen 1 und 4/);
  });

  it('hält die Flotte im Stundennbudget (10 €/h)', () => {
    expect(estimateFleetEurPerHour(['brain', 'ears', 'voiceGen', 'vision'])).toBeCloseTo(1.96, 2);
    expect(() => assertFleetHourlyBudget(['brain', 'ears', 'voiceGen', 'vision'])).not.toThrow();
    // Mit 5 Hetzner-Instanzen zusätzlich bleibt es unter 10 €/h …
    expect(() => assertFleetHourlyBudget(['brain', 'ears', 'voiceGen', 'vision'], 6)).not.toThrow();
    // … aber nicht, wenn die Stunde teurer würde.
    expect(() => assertFleetHourlyBudget(['brain', 'ears', 'voiceGen', 'vision'], 20)).toThrow(
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
