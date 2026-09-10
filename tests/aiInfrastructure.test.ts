import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  AI_MAX_GPU_ENDPOINTS,
  GPU_ROLE_IDS,
  LEGACY_GPU_ENDPOINTS,
  assertGpuEndpointBudget,
  endpointNameForRole,
} from '../src/config/aiInfrastructure';

describe('AI-Infrastruktur (3-Rollen-GPU-Flotte)', () => {
  const original = process.env.AI_MAX_GPU_ENDPOINTS;

  afterEach(() => {
    if (original === undefined) delete process.env.AI_MAX_GPU_ENDPOINTS;
    else process.env.AI_MAX_GPU_ENDPOINTS = original;
    vi.resetModules();
  });

  it('erlaubt genau die drei Flotten-Rollen als GPU-Endpoints', () => {
    expect(GPU_ROLE_IDS).toEqual(['brain', 'ears', 'voiceGen']);
    expect(AI_MAX_GPU_ENDPOINTS).toBe(3);
    expect(LEGACY_GPU_ENDPOINTS).toContain('samplemonk-ai');
    expect(() => assertGpuEndpointBudget()).not.toThrow();
  });

  it('leitet die Endpoint-Namen aus der Rolle ab', () => {
    expect(endpointNameForRole('brain')).toBe('samplemonk-ai-brain');
    expect(endpointNameForRole('ears')).toBe('samplemonk-ai-ears');
    expect(endpointNameForRole('voiceGen')).toBe('samplemonk-ai-voice');
  });

  it('wirft, wenn mehr GPU-Endpoints erlaubt werden als es Rollen gibt', async () => {
    process.env.AI_MAX_GPU_ENDPOINTS = '5';
    vi.resetModules();
    const mod = await import('../src/config/aiInfrastructure');
    expect(() => mod.assertGpuEndpointBudget()).toThrow(/zwischen 1 und 3/);
  });

  it('wirft bei 0 GPU-Endpoints', async () => {
    process.env.AI_MAX_GPU_ENDPOINTS = '0';
    vi.resetModules();
    const mod = await import('../src/config/aiInfrastructure');
    expect(() => mod.assertGpuEndpointBudget()).toThrow(/zwischen 1 und 3/);
  });
});
