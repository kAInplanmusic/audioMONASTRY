import { describe, expect, it } from 'vitest';
import { AiOrchestrator } from '../src/core/ai/orchestrator/aiOrchestrator';
import { SessionManager } from '../src/core/ai/orchestrator/sessionManager';
import { ModelManager, type EndpointClient } from '../src/core/ai/orchestrator/modelManager';
import { type AiProviderId, type AiTask, type IAiProvider } from '../src/core/ai/orchestrator/types';

/**
 * AI-E2E-Szenario (AITodo Phase 24–26): Wake → Cold-Start → Load → Request
 * → Switch → Scale-to-Zero als deterministischer, serverloser Test.
 * Echte GPU/Netz sind durch Mock-Provider/-EndpointClient ersetzt.
 */

function fakeEndpointClient(): EndpointClient & { loadCalls: string[]; unloadCalls: string[] } {
  const loadCalls: string[] = [];
  const unloadCalls: string[] = [];
  return {
    loadCalls,
    unloadCalls,
    async loadModel(id: string): Promise<void> {
      loadCalls.push(id);
    },
    async unloadModel(id: string): Promise<void> {
      unloadCalls.push(id);
    },
    async listModels(): Promise<Array<{ id: string; loaded: boolean }>> {
      const loaded = new Set(loadCalls.filter((c) => !unloadCalls.includes(c)));
      return [...loaded].map((id) => ({ id, loaded: true }));
    },
  };
}

/** Mock-GPU-Provider mit interner Cold-Start-Behandlung (wie HfEndpointProvider). */
function gpuProvider(): IAiProvider & { wakeCount: number; requestCount: number } {
  const state = { wakeCount: 0, requestCount: 0, warm: false };
  return {
    id: 'mock-gpu' as AiProviderId,
    get available() { return true; },
    canRun(task: AiTask) { return task === 'audio.classify'; },
    estimateCostUsd() { return 0.0001; },
    async run(task: AiTask, _model: string, input: unknown) {
      state.requestCount += 1;
      if (!state.warm) {
        state.warm = true;
        state.wakeCount += 1;
        await new Promise((r) => setTimeout(r, 5)); // GPU-Wake (Scale-to-Zero)
      }
      return { task, input, coldStarted: state.wakeCount > 0 && state.requestCount === 1 };
    },
    get wakeCount() { return state.wakeCount; },
    get requestCount() { return state.requestCount; },
  };
}

/** Zweiter Mock-Provider für den Task-Switch (anderer Task). */
function transcribeProvider(): IAiProvider & { requestCount: number } {
  const state = { requestCount: 0 };
  return {
    id: 'mock-transcribe' as AiProviderId,
    get available() { return true; },
    canRun(task: AiTask) { return task === 'audio.transcribe'; },
    estimateCostUsd() { return 0.0002; },
    async run(task: AiTask, _model: string, input: unknown) {
      state.requestCount += 1;
      return { task, text: 'transkribiert', input };
    },
    get requestCount() { return state.requestCount; },
  };
}

describe('AI-E2E-Szenario: Wake → Cold-Start → Load → Request → Switch → Scale-to-Zero', () => {
  it('durchläuft den kompletten Lifecycle deterministisch', async () => {
    // 1) WAKE: Session-Zustandsmaschine (CREATED → … → ACTIVE).
    const scaleToZeroCalls: string[] = [];
    const session = new SessionManager('e2e-session', {
      idleTimeoutMs: 30_000,
      onScaleToZero: async (s) => { scaleToZeroCalls.push(s.sessionId); },
    });
    expect(session.getState()).toBe('CREATED');
    session.transition('STARTING');
    session.transition('WAKING_GPU');
    session.transition('LOADING_MODELS');
    session.transition('READY');
    session.transition('ACTIVE');
    expect(session.getState()).toBe('ACTIVE');

    // 2) LOAD: Modell über den EndpointClient laden (VRAM/Tracking).
    const endpoint = fakeEndpointClient();
    const models = new ModelManager(endpoint, { vramBudgetGb: 80, vramSafetyMarginGb: 0 });
    await models.load('ast-audioset');
    expect(models.isLoaded('ast-audioset')).toBe(true);
    expect(endpoint.loadCalls).toContain('ast-audioset');

    // 3) REQUEST (Cold-Start): erster Request weckt die GPU, zweiter ist warm.
    const gpu = gpuProvider();
    const transcriber = transcribeProvider();
    const orchestrator = new AiOrchestrator({ endpointClient: endpoint });
    orchestrator.registerProvider(transcriber);
    orchestrator.registerProvider(gpu);

    const cold = await orchestrator.orchestrate({
      userId: 'u1', task: 'audio.classify', model: 'ast-audioset', input: { audio: 'x' }, sessionId: session.get().sessionId,
    });
    expect(cold.job.status).toBe('COMPLETED');
    expect(cold.provider).toBe('mock-gpu');
    expect(gpu.wakeCount).toBe(1);

    const warm = await orchestrator.orchestrate({
      userId: 'u1', task: 'audio.classify', model: 'ast-audioset', input: { audio: 'y' }, sessionId: session.get().sessionId,
    });
    expect(warm.job.status).toBe('COMPLETED');
    expect(gpu.wakeCount).toBe(1); // warm: kein zweiter Wake
    expect(gpu.requestCount).toBe(2);

    // 4) SWITCH: anderer Task läuft über den passenden zweiten Provider.
    const switched = await orchestrator.orchestrate({
      userId: 'u1', task: 'audio.transcribe', model: 'whisper-large-v3', input: { audio: 'z' }, sessionId: session.get().sessionId,
    });
    expect(switched.job.status).toBe('COMPLETED');
    expect(switched.provider).toBe('mock-transcribe');
    expect(transcriber.requestCount).toBe(1);

    // 5) SCALE-TO-ZERO: kontrolliertes Herunterfahren ruft onScaleToZero.
    await session.shutdown();
    expect(session.getState()).toBe('CLOSED');
    expect(scaleToZeroCalls).toEqual(['e2e-session']);
  });

  it('Session wird nach Jobs IDLE (kein Leerlauf-Request blockiert Scale-to-Zero)', async () => {
    const session = new SessionManager('e2e-idle', { idleTimeoutMs: 30_000 });
    session.transition('STARTING');
    session.transition('WAKING_GPU');
    session.transition('LOADING_MODELS');
    session.transition('READY');
    session.transition('ACTIVE');
    session.jobStarted('ast-audioset');
    expect(session.get().activeJobs).toBe(1);
    session.jobFinished('ast-audioset');
    expect(session.getState()).toBe('IDLE');
    expect(session.get().activeJobs).toBe(0);
  });
});
