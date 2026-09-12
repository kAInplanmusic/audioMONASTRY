/**
 * audioMONASTRY · AI Orchestrator – Provider Router
 * ==================================================
 * Zentrale Provider-Wahl. Stand nach dem RunPod-Cutover (2026-09-12):
 * Replicate und HuggingFace sind als Provider ENTFERNT – der einzige
 * Cloud-Pfad ist die 3-Rollen-GPU-Flotte auf RunPod (brain/ears/voiceGen),
 * ergänzt um Cerebras (NLU/Struktur) und den deterministischen Lokal-Pfad.
 *
 * - `llm`            → LlmRouter (bestehend, Kosten-Ranking)
 * - `stem.separate`  → RunPod voiceGen (demucs, live verifiziert)
 * - `tts/sing/song`  → RunPod voiceGen
 * - `audio.*`        → RunPod ears
 *
 * Revertierbar: die Provider-Klassen liegen in der Git-Historie
 * (Commit vor dem Cutover).
 */
import { llmRouter } from '../LlmRouter';
import { aiLogger } from './aiLogger';
import { assertGpuEndpointBudget } from '../../../config/aiInfrastructure';
import { CircuitBreaker } from './circuitBreaker';
import { CerebrasProvider } from './cerebrasProvider';
import { GPU_ROLE_LIST } from './endpointRegistry';
import { RunPodProvider } from './runpodProvider';
import { AiProviderError, type AiProviderId, type AiTask, type IAiProvider } from './types';

// ---------------------------------------------------------------------------
// Local/Deterministischer Provider (DAW bleibt ohne Cloud nutzbar)
// ---------------------------------------------------------------------------
class LocalProvider implements IAiProvider {
  readonly id = 'local' as const;

  get available(): boolean {
    return true;
  }

  canRun(task: AiTask): boolean {
    return ['llm', 'tts', 'song'].includes(task);
  }

  estimateCostUsd(): number {
    return 0;
  }

  async run(task: AiTask, _model: string, input: unknown): Promise<unknown> {
    const prompt = typeof input === 'string' ? input : JSON.stringify(input ?? {});
    if (task === 'llm') {
      // Bestehender Ollama-/deterministischer Pfad wird über den LlmRouter abgedeckt.
      throw new AiProviderError(this.id, 'LOCAL_LLM_NOT_DIRECT', 'LLM lokal über LlmRouter', false);
    }
    return { provider: 'local', text: prompt, hint: 'deterministischer Fallback' };
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export class ProviderRouter {
  // 3-Rollen-GPU-Flotte: brain (LLM) / ears (Audio-Intelligence) / voiceGen
  // (TTS, Gesang, Song, SFX, Stems). Jede Rolle ist ein eigener Serverless-
  // Endpoint mit eigener Endpoint-ID und disjunkter Task-Menge – die Reihenfolge
  // hier ist die Provider-Priorität, nicht die Rollen-Reihenfolge.
  private providers: IAiProvider[] = [
    ...GPU_ROLE_LIST.map((role) => new RunPodProvider(role.role)),
    new CerebrasProvider(), // NLU/Struktur – schnell & kostengestaffelt
    new LocalProvider(),
  ];
  private breakers = new Map<string, CircuitBreaker>();

  constructor() {
    // Harte Kostenregel: höchstens so viele GPU-Endpoints wie Flotten-Rollen.
    assertGpuEndpointBudget();
  }

  register(provider: IAiProvider): void {
    this.providers = [provider, ...this.providers.filter((p) => p.id !== provider.id)];
  }

  /** Liefert alle Provider, die den Task ausführen können (in Prioritäts-Reihenfolge). */
  candidates(task: AiTask): IAiProvider[] {
    return this.providers.filter((p) => p.available && p.canRun(task));
  }

  async run(task: AiTask, model: string, input: unknown, signal?: AbortSignal): Promise<{ provider: AiProviderId; result: unknown }> {
    if (task === 'llm') {
      const completion = await llmRouter.complete({
        prompt: String((input as { prompt?: string })?.prompt ?? input ?? ''),
        complexity: (input as { complexity?: 'simple' | 'moderate' | 'complex' })?.complexity ?? 'moderate',
      });
      return { provider: completion.provider as AiProviderId, result: completion };
    }
    const ranked = this.candidates(task);
    if (ranked.length === 0) throw new AiProviderError('local', 'NO_PROVIDER', `kein Provider für Task ${task}`, false);
    let lastError: Error | null = null;
    for (const provider of ranked) {
      const breaker = this.breakers.get(provider.id) ?? new CircuitBreaker(provider.id);
      this.breakers.set(provider.id, breaker);
      try {
        const result = await breaker.call(() => provider.run(task, model, input, signal));
        return { provider: provider.id, result };
      } catch (error) {
        lastError = error as Error;
        aiLogger.warn('provider failed, trying next', { provider: provider.id, task, model, error: (error as Error).message });
      }
    }
    throw lastError ?? new AiProviderError('local', 'ALL_PROVIDERS_FAILED', `alle Provider für ${task} fehlgeschlagen`, true);
  }
}
