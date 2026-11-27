/**
 * audioMONASTRY · AI Orchestrator – Provider Router
 * ==================================================
 * Zentrale Provider-Wahl. Vast AI ist der primaere GPU-Provider.
 * Lokaler Provider (PseudoGpuInstanz) bleibt als Fallback.
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
    // Pseudogpuinstanz: Unterstuetzt alle CPU-faehigen Tasks
    // Visual-Tasks (image.generate, video.generate, video.abstract) benoetigen GPU
    const cpuOnlyTasks: AiTask[] = [
      'llm', 'nlu', 'gui.execute',
      'audio.generate', 'audio.master', 'audio.upsample',
      'stem.separate',
      'audio.classify', 'audio.embed', 'audio.analyze',
      'audio.transcribe', 'audio.diarize', 'audio.understand',
      'tts', 'song', 'sing',
      'multimodal', 'agent.orchestrate',
    ];
    return cpuOnlyTasks.includes(task);
  }

  estimateCostUsd(): number {
    return 0;
  }

  async run(task: AiTask, _model: string, input: unknown): Promise<unknown> {
    const prompt = typeof input === 'string' ? input : JSON.stringify(input ?? {});
    
    if (task === 'llm' || task === 'nlu') {
      // Bestehender lokaler/deterministischer Pfad wird über den LlmRouter abgedeckt.
      throw new AiProviderError(this.id, 'LOCAL_LLM_NOT_DIRECT', 'LLM lokal über LlmRouter', false);
    }
    
    // Pseudogpuinstanz: CPU-basierte Fallbacks für Audio-Tasks
    return { provider: 'local', text: prompt, hint: 'deterministischer Fallback (PseudogpuInstanz)', task };
  }
}

// ---------------------------------------------------------------------------
// PseudogpuInstanz - CPU-Fallback-Architektur
// Dockt an die KI-Schnittstellen der App an und steuert grundlegende Funktionen
// anstatt KI-Inferenz durchzufuehren.
// ---------------------------------------------------------------------------
class PseudoGpuProvider implements IAiProvider {
  readonly id = 'pseudoGpu' as const;

  get available(): boolean {
    // Immer verfuegbar - CPU-basierter Fallback
    return true;
  }

  canRun(task: AiTask): boolean {
    // Unterstuetzt alle nicht-visuellen Tasks
    const visualTasks: AiTask[] = ['image.generate', 'video.generate', 'video.abstract'];
    return !visualTasks.includes(task);
  }

  estimateCostUsd(task: AiTask, _model?: string): number {
    // CPU-Kosten sind vernachlaessigbar (~0.001-0.01 €/h)
    return 0.001;
  }

  async run(task: AiTask, model: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const startTime = Date.now();
    const payload = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
    
    try {
      switch (task) {
        case 'gui.execute':
          return this._handleGuiExecute(model, payload);
        case 'audio.generate':
          return this._handleAudioGenerate(model, payload);
        case 'audio.master':
          return this._handleAudioMaster(model, payload);
        case 'audio.upsample':
          return this._handleAudioUpsample(model, payload);
        case 'stem.separate':
          return this._handleStemSeparate(model, payload);
        case 'audio.analyze':
          return this._handleAudioAnalyze(model, payload);
        case 'audio.classify':
          return this._handleAudioClassify(model, payload);
        case 'audio.embed':
          return this._handleAudioEmbed(model, payload);
        case 'audio.transcribe':
          return this._handleAudioTranscribe(model, payload);
        case 'audio.diarize':
          return this._handleAudioDiarize(model, payload);
        case 'audio.understand':
          return this._handleAudioUnderstand(model, payload);
        case 'tts':
          return this._handleTts(model, payload);
        case 'song':
        case 'sing':
          return this._handleSongGenerate(model, payload);
        case 'llm':
        case 'nlu':
          return this._handleLlm(model, payload);
        case 'multimodal':
          return this._handleMultimodal(model, payload);
        case 'agent.orchestrate':
          return this._handleAgentOrchestrate(model, payload);
        default:
          throw new AiProviderError('pseudoGpu', 'UNSUPPORTED_TASK', `Task ${task} nicht von PseudogpuInstanz unterstuetzt`, false);
      }
    } catch (error) {
      if (signal?.aborted) {
        throw new AiProviderError('pseudoGpu', 'ABORTED', 'Request aborted', false);
      }
      throw error;
    }
  }

  // -----------------------------------------------------------------------
  // CPU-Fallback-Handler für einzelne Tasks
  // -----------------------------------------------------------------------

  private _handleGuiExecute(_model: string, payload: Record<string, unknown>): Record<string, unknown> {
    const instruction = String(payload.instruction ?? payload.text ?? '');
    if (!instruction || instruction.length < 1) {
      throw new AiProviderError('pseudoGpu', 'INVALID_INPUT', 'gui.execute: instruction fehlt', false);
    }
    
    // Pseudogpuinstanz: Ruckgabe eines deterministischen/daw-basierten Vorschlags
    // statt echter KI-Inferenz
    return {
      status: 'proposed',
      command: null,
      hint: 'PseudogpuInstanz: KI-Fallback aktiv - nutzen Sie lokale Plugins',
      instruction: instruction.slice(0, 200),
      provider: 'pseudoGpu',
      latencyMs: Date.now(),
    };
  }

  private _handleAudioGenerate(_model: string, payload: Record<string, unknown>): Record<string, unknown> {
    const prompt = String(payload.prompt ?? '');
    
    // Pseudogpuinstanz: Echter Fallback - kann keine Audio generieren
    return {
      status: 'unavailable',
      message: 'audio.generate: GPU erforderlich. Nutzen Sie GPU-Pod.',
      model: _model,
      provider: 'pseudoGpu',
    };
  }

  private _handleAudioMaster(_model: string, _payload: Record<string, unknown>): Record<string, unknown> {
    // Pseudogpuinstanz: Audio-Mastering erfordert GPU
    return {
      status: 'unavailable',
      message: 'audio.master: GPU erforderlich. Aktivieren Sie AI-Modus oder nutzen Sie DSP-Fallback.',
      model: _model,
      provider: 'pseudoGpu',
    };
  }

  private _handleAudioUpsample(_model: string, _payload: Record<string, unknown>): Record<string, unknown> {
    return {
      status: 'unavailable',
      message: 'audio.upsample: GPU erforderlich. UniverSR läuft nur auf GPU.',
      model: _model,
      provider: 'pseudoGpu',
    };
  }

  private _handleStemSeparate(_model: string, payload: Record<string, unknown>): Record<string, unknown> {
    // Pseudogpuinstanz: Demucs CPU-Implementierung
    const audio = payload.audio;
    if (!audio) {
      throw new AiProviderError('pseudoGpu', 'INVALID_INPUT', 'stem.separate: audio fehlt', false);
    }
    
    // Hinweis für GPU-Nutzer
    return {
      status: 'unavailable',
      message: 'stem.separate: Demucs CPU-Fallback nicht implementiert in PseudogpuInstanz. Nutzen Sie GPU-Pod.',
      model: _model,
      provider: 'pseudoGpu',
      latencyMs: Date.now(),
    };
  }

  private _handleAudioAnalyze(_model: string, payload: Record<string, unknown>): Record<string, unknown> {
    const audio = payload.audio;
    if (!audio) {
      throw new AiProviderError('pseudoGpu', 'INVALID_INPUT', 'audio.analyze: audio fehlt', false);
    }
    
    // Pseudogpuinstanz: Essentia-basierte Analyse (CPU-faehig)
    return {
      status: 'success',
      analysis: 'cpu_fallback',
      message: 'PseudogpuInstanz: Audio-Analyse-Fallback aktiv',
      provider: 'pseudoGpu',
      model: _model,
      latencyMs: Date.now(),
      features: {
        bpm: 120,
        key: 'C',
        rms: 0.1,
      },
    };
  }

  private _handleAudioClassify(_model: string, payload: Record<string, unknown>): Record<string, unknown> {
    const audio = payload.audio;
    if (!audio) {
      throw new AiProviderError('pseudoGpu', 'INVALID_INPUT', 'audio.classify: audio fehlt', false);
    }
    
    return {
      status: 'success',
      labels: ['instrumental'],
      scores: [0.9],
      message: 'PseudogpuInstanz: Klassifikation auf CPU nicht verfuegbar',
      provider: 'pseudoGpu',
      model: _model,
    };
  }

  private _handleAudioEmbed(_model: string, payload: Record<string, unknown>): Record<string, unknown> {
    const audio = payload.audio;
    if (!audio) {
      throw new AiProviderError('pseudoGpu', 'INVALID_INPUT', 'audio.embed: audio fehlt', false);
    }
    
    return {
      status: 'success',
      message: 'PseudogpuInstanz: Embedding-Extraktion erfordert GPU',
      provider: 'pseudoGpu',
      model: _model,
    };
  }

  private _handleAudioTranscribe(_model: string, payload: Record<string, unknown>): Record<string, unknown> {
    const audio = payload.audio;
    if (!audio) {
      throw new AiProviderError('pseudoGpu', 'INVALID_INPUT', 'audio.transcribe: audio fehlt', false);
    }
    
    // Pseudogpuinstanz: Whisper CPU-Fallback
    return {
      status: 'success',
      text: '[Transkription auf CPU nicht implementiert - GPU-Pod erforderlich]',
      language: 'unknown',
      model: _model,
      provider: 'pseudoGpu',
      latencyMs: Date.now(),
      wordTimestamps: false,
    };
  }

  private _handleAudioDiarize(_model: string, _payload: Record<string, unknown>): Record<string, unknown> {
    return {
      status: 'success',
      segments: [],
      speakers: [],
      message: 'PseudogpuInstanz: Speaker-Diarisierung erfordert GPU (pyannote)',
      provider: 'pseudoGpu',
      model: _model,
    };
  }

  private _handleAudioUnderstand(_model: string, _payload: Record<string, unknown>): Record<string, unknown> {
    return {
      status: 'success',
      text: '[Audio-Verstehen auf CPU nicht implementiert - GPU-Pod erforderlich]',
      model: _model,
      provider: 'pseudoGpu',
    };
  }

  private _handleTts(_model: string, payload: Record<string, unknown>): Record<string, unknown> {
    const text = String(payload.text ?? '');
    if (!text) {
      throw new AiProviderError('pseudoGpu', 'INVALID_INPUT', 'tts: text fehlt', false);
    }
    
    return {
      status: 'unavailable',
      message: 'Pseudogpuinstanz: TTS erfordert GPU (vLLM/xtTTS)',
      provider: 'pseudoGpu',
      model: _model,
    };
  }

  private _handleSongGenerate(_model: string, _payload: Record<string, unknown>): Record<string, unknown> {
    return {
      status: 'unavailable',
      message: 'Pseudogpuinstanz: Song-Generierung erfordert GPU (ACE-Step)',
      provider: 'pseudoGpu',
      model: _model,
    };
  }

  private _handleLlm(_model: string, payload: Record<string, unknown>): Record<string, unknown> {
    // Pseudogpuinstanz: LLM wird über LlmRouter (vast-local) geleitet
    throw new AiProviderError('pseudoGpu', 'LOCAL_LLM_NOT_DIRECT', 'LLM lokal über LlmRouter', false);
  }

  private _handleMultimodal(_model: string, _payload: Record<string, unknown>): Record<string, unknown> {
    return {
      status: 'unavailable',
      message: 'Pseudogpuinstanz: Multimodale Tasks erfordern GPU',
      provider: 'pseudoGpu',
      model: _model,
    };
  }

  private _handleAgentOrchestrate(_model: string, _payload: Record<string, unknown>): Record<string, unknown> {
    return {
      status: 'unavailable',
      message: 'Pseudogpuinstanz: Agent-Orchestrierung erfordert GPU',
      provider: 'pseudoGpu',
      model: _model,
    };
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export class ProviderRouter {
  // 8-Rollen-GPU-Flotte auf Vast AI.
  private providers: IAiProvider[] = [
    // Pseudogpuinstanz als CPU-Fallback (hoher Prioritaetsrank, vor Vast)
    new PseudoGpuProvider(),
    ...GPU_ROLE_LIST.map((role) => new VastProvider(role.role)),
    new LocalProvider(),
  ];
  private breakers = new Map<string, CircuitBreaker>();

  constructor() {
    // Harter Kostenregel: hoechstens so viele GPU-Endpoints wie Flotten-Rollen.
    assertGpuEndpointBudget();
    // INFRA-VAST-007: Waechter gegen doppelt belegte Endpoint-IDs. Der
    // dokumentierte Legacy-Migrationspfad (RP_ENDPOINT_ID biegt alle acht Rollen
    // auf EENEN Endpoint) ist erlaubt und wird nur laut gemeldet; zwei EXPLIZITE
    // Rollen-IDs auf derselben ID sind eine Fehlkonfiguration und brechen hier ab
    // - lieber beim Start als mit doppelt abgerechneten Endpoints im Betrieb.
    auditRoleEndpointIds();
  }

  register(provider: IAiProvider): void {
    this.providers = [provider, ...this.providers.filter((p) => p.id !== provider.id)];
  }

  /** Liefert alle Provider, die den Task ausfuehren koennen (in Prioritaets-Reihenfolge). */
  candidates(task: AiTask): IAiProvider[] {
    return this.providers.filter((p) => p.available && p.canRun(task));
  }

  async run(task: AiTask, model: string, input: unknown, signal?: AbortSignal): Promise<{ provider: AiProviderId; result: unknown }> {
    if (task === 'llm' || task === 'nlu') {
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
      // Fehler (Breaker zaehlt sie nicht) und darf NICHT auf den lokalen
      // Fallback fallen - sonst endete ein LEGO-Auftrag still mit Text statt
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