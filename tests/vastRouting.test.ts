import { afterEach, describe, expect, it } from 'vitest';
import { gpuAction, gpuControlUrl } from '../src/core/ai/orchestrator/gpuControl';
import { podBaseUrl } from '../src/core/ai/orchestrator/podRouting';
import { podFleetEurPerHour } from '../src/core/ai/orchestrator/podStartTriggers';

afterEach(() => {
  for (const name of ['AI_GPU_PROVIDER', 'VAST_POD_URL_BRAIN', 'RP_POD_URL_BRAIN',
    'VAST_POD_EUR_PER_HOUR_BRAIN']) delete process.env[name];
});
describe('Vast preserves the role API without paid-provider fallback', () => {
  it('fails closed until a TLS endpoint is ready', () => {
    process.env.AI_GPU_PROVIDER = 'vast';
    process.env.RP_POD_URL_BRAIN = 'https://legacy.example';
    expect(podBaseUrl('brain')).toBe('');
    process.env.VAST_POD_URL_BRAIN = 'http://example.com';
    expect(podBaseUrl('brain')).toBe('');
    process.env.VAST_POD_URL_BRAIN = 'https://example.com:1234';
    expect(podBaseUrl('brain')).toBe('https://example.com:1234');
  });
  it('uses the Vast control plane for resume and stop', () => {
    process.env.AI_GPU_PROVIDER = 'vast';
    expect(gpuControlUrl('123456')).toBe('https://console.vast.ai/api/v0/instances/123456/');
    expect(gpuAction('start')).toEqual({ method: 'PUT', body: '{"state":"running"}' });
    expect(gpuAction('stop')).toEqual({ method: 'PUT', body: '{"state":"stopped"}' });
  });
  it('requires observed Vast prices and includes only the GPU reserve', () => {
    process.env.AI_GPU_PROVIDER = 'vast';
    expect(podFleetEurPerHour(['brain'])).toBe(Number.POSITIVE_INFINITY);
    process.env.VAST_POD_EUR_PER_HOUR_BRAIN = '.75';
    expect(podFleetEurPerHour(['brain'])).toBeCloseTo(1.15);
  });
});
