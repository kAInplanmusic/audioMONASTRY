import { afterEach, describe, expect, it, vi } from 'vitest';
import { VastProvider } from '../src/core/ai/orchestrator/vastProvider';
import { gpuAction, gpuControlUrl } from '../src/core/ai/orchestrator/gpuControl';
import { LlmRouter, brainModelDefaults } from '../src/core/ai/LlmRouter';
import { podBaseUrl } from '../src/core/ai/orchestrator/podRouting';
import { podFleetEurPerHour } from '../src/core/ai/orchestrator/podStartTriggers';
import { assertFleetHourlyBudget, fleetBudgetReport } from '../src/config/aiInfrastructure';

afterEach(() => {
  vi.restoreAllMocks();
  for (const name of ['AI_GPU_PROVIDER', 'VAST_POD_URL_BRAIN', 'RP_POD_URL_BRAIN',
    'VAST_POD_EUR_PER_HOUR_BRAIN', 'AI_FLEET_MODE', 'RUNPOD_EXECUTOR_MODEL',
    'RUNPOD_BRAIN_MODEL', 'RUNPOD_BRAIN_OPENAI_MODEL', 'AI_POD_TOKEN']) delete process.env[name];
});
describe('Vast preserves the role API without paid-provider fallback', () => {
  it('routes typed DAW execution through the actual 4B GUI task and canonical app catalog', async () => {
    process.env.AI_GPU_PROVIDER='vast';
    process.env.VAST_POD_URL_BRAIN='https://brain.example';
    process.env.AI_POD_TOKEN='test-vast-token-with-at-least-32-characters';
    const run=vi.spyOn(VastProvider.prototype,'run').mockResolvedValue({text:'{"commands":[{"pluginId":"transport","command":"set_tempo(128)"}]}'});
    const provider=new LlmRouter().rankProviders('simple').find(p=>p.id==='vast-local');
    const result=await provider!.complete({prompt:'Set tempo',complexity:'simple',execution:'daw-commands'});
    expect(result.model).toBe('qwen3-4b');
    expect(run.mock.calls[0].slice(0,2)).toEqual(['gui.execute','qwen3-4b']);
    expect(run.mock.calls[0][2]).toMatchObject({format:'daw_commands',allowedPluginCommands:{transport:expect.stringContaining('set_tempo')}});
  });
  it('fails closed until a TLS endpoint is ready', () => {
    process.env.AI_GPU_PROVIDER = 'vast';
    process.env.RP_POD_URL_BRAIN = 'https://legacy.example';
    expect(podBaseUrl('brain')).toBe('');
    process.env.VAST_POD_URL_BRAIN = 'http://example.com';
    expect(podBaseUrl('brain')).toBe('');
    process.env.VAST_POD_URL_BRAIN = 'https://example.com:1234';
    expect(podBaseUrl('brain')).toBe('https://example.com:1234');
  });
  it('keeps general LLM requests on the selected Brain despite stale legacy overrides', () => {
    delete process.env.AI_GPU_PROVIDER;
    process.env.AI_FLEET_MODE = 'serverless';
    process.env.RUNPOD_EXECUTOR_MODEL = 'retired-executor';
    process.env.RUNPOD_BRAIN_MODEL = 'retired-brain';
    process.env.RUNPOD_BRAIN_OPENAI_MODEL = 'retired-openai';
    process.env.VAST_POD_URL_BRAIN = 'https://brain.example';
    process.env.AI_POD_TOKEN = 'test-vast-token-with-at-least-32-characters';
    expect(brainModelDefaults()).toEqual({ executor: 'qwen3-4b', standard: 'qwen38-27b-fp8', openAiCompat: 'Qwen/Qwen3.8-27B-FP8' });
    const provider = new LlmRouter().rankProviders('simple').find(p => p.id === 'vast-local');
    expect(provider).toBeDefined();
    expect(provider?.streamModel?.({ prompt: 'hello', complexity: 'simple' })).toBe('qwen38-27b-fp8');
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
  it('reports Hetzner separately without counting it against the Vast cap', () => {
    process.env.AI_GPU_PROVIDER = 'vast';
    expect(() => assertFleetHourlyBudget([], 100)).not.toThrow();
    const report = fleetBudgetReport([], 100);
    expect(report.totalEurPerHour).toBe(100);
    expect(report.hourly.value).toBe(0);
    expect(report.hourly.withinLimit).toBe(true);
  });
});
