/**
 * audioMONASTRY · AI Orchestrator – Provider Router
 * ==================================================
 * Zentrale Provider-Wahl. Vast AI ist der primäre GPU-Provider.
 * Lokaler Provider bleibt als Fallback.
 */
import { llmRouter } from '../LlmRouter';
import { aiLogger } from './aiLogger';
import { assertGpuEndpointBudget } from '../../../config/aiInfrastructure';
import { CircuitBreaker } from './circuitBreaker';
import { GPU_ROLE_LIST, auditRoleEndpointIds } from './endpointRegistry';
import { isPreemptionError } from './podJobQueue';
import { VastProvider } from './vastProvider';
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
      // Bestehender lokaler/deterministischer Pfad wird über den LlmRouter abgedeckt.
      throw new AiProviderError(this.id, 'LOCAL_LLM_NOT_DIRECT', 'LLM lokal über LlmRouter', false);
    }
    return { provider: 'local', text: prompt, hint: 'deterministischer Fallback' };
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export class ProviderRouter {
  // 8-Rollen-GPU-Flotte auf Vast AI.
  private providers: IAiProvider[] = [
    ...GPU_ROLE_LIST.map((role) => new VastProvider(role.role)),
    new LocalProvider(),
  ];
  private breakers = new Map<string, CircuitBreaker>();

  constructor() {
    // Harte Kostenregel: höchstens so viele GPU-Endpoints wie Flotten-Rollen.
    assertGpuEndpointBudget();
    // INFRA-VAST-007: Wächter gegen doppelt belegte Endpoint-IDs. Der
    // dokumentierte Legacy-Migrationspfad (RP_ENDPOINT_ID biegt alle acht Rollen
    // auf EINEN Endpoint) ist erlaubt und wird nur laut gemeldet; zwei EXPLIZITE
    // Rollen-IDs auf derselben ID sind eine Fehlkonfiguration und brechen hier ab
    // – lieber beim Start als mit doppelt abgerechneten Endpoints im Betrieb.
    auditRoleEndpointIds();
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
      return { provider: completion.provider, result: completion };
    }
    const ranked = this.candidates(task);
    if (ranked.length === 0) throw new AiProviderError('local', 'NO_PROVIDER', `kein Provider für Task ${task}`, false);
    let lastError: Error | null = null;
    for (const provider of ranked) {
      const breaker = this.breakers.get(provider.id) ?? new CircuitBreaker(provider.id);
      this.breakers.set(provider.id, breaker);
      // FLEET-P1-009: Eine Unterbrechung zugunsten von TTS ist kein Provider-
      // Fehler (Breaker zählt sie nicht) und darf NICHT auf den lokalen
      // Fallback fallen – sonst endete ein LEGO-Auftrag still mit Text statt
      // Audio. Der Aufrufer bekommt die Wiederholungsmeldung.
      let preempted: unknown = null;
      try {
        const result = await breaker.call(async () => {
          try {
            return await provider.run(task, model, input, signal);
          } catch (error) {
            if (!isPreemptionError(error)) throw error;
            preempted = error;
            return null;
          }
        });
        if (preempted) throw preempted;
        return { provider: provider.id, result };
      } catch (error) {
        if (isPreemptionError(error)) throw error;
        lastError = error as Error;
        aiLogger.warn('provider failed, trying next', { provider: provider.id, task, model, error: (error as Error).message });
      }
    }
    throw lastError ?? new AiProviderError('local', 'ALL_PROVIDERS_FAILED', `alle Provider für ${task} fehlgeschlagen`, true);
  }
}
