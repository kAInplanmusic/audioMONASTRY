import { describe, expect, it, vi, afterEach } from 'vitest';
import { AI_MAX_GPU_ENDPOINTS, SINGLE_GPU_ENDPOINT_NAME, LEGACY_GPU_ENDPOINTS, assertSingleGpuEndpoint } from '../src/config/aiInfrastructure';

describe('AI-Infrastruktur (GPU-Konsolidierung)', () => {
  const original = process.env.AI_MAX_GPU_ENDPOINTS;

  afterEach(() => {
    if (original === undefined) delete process.env.AI_MAX_GPU_ENDPOINTS;
    else process.env.AI_MAX_GPU_ENDPOINTS = original;
    vi.resetModules();
  });

  it('erlaubt genau 1 GPU-Endpoint (Kostenregel)', () => {
    expect(AI_MAX_GPU_ENDPOINTS).toBe(1);
    expect(SINGLE_GPU_ENDPOINT_NAME).toBe('samplemonk-ai');
    expect(LEGACY_GPU_ENDPOINTS).toContain('samplemonk-ai-pilot');
    expect(LEGACY_GPU_ENDPOINTS).toContain('samplemonk-ai-clap');
    expect(() => assertSingleGpuEndpoint()).not.toThrow();
  });

  it('wirft, wenn AI_MAX_GPU_ENDPOINTS > 1 gesetzt ist', async () => {
    process.env.AI_MAX_GPU_ENDPOINTS = '2';
    vi.resetModules();
    const mod = await import('../src/config/aiInfrastructure');
    expect(() => mod.assertSingleGpuEndpoint()).toThrow(/AI_MAX_GPU_ENDPOINTS muss 1 sein/);
  });
});
