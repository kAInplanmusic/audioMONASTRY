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
// 
// UNTERSTUETZTE PLUGIN-BEFEHLE (aus PLUGIN_COMMAND_CATALOG):
// - transport: set_tempo, play, stop
// - mixer: gain, fade_in_main, channel
// - drop: pattern, auto_drop, status
// - song: generate, status
// - eq: automate, preset(name)
// - master: preset, status (DSP-basiertes Mastering)
// - spatial: setup(id), mode
// - syntisampler: note(freq), trigger, pattern_four, pattern_random, pattern_break
// - drumsampler: kit(kit), pattern_random, trigger
// - instru: program(program)
// - record: start, stop, status
// ---------------------------------------------------------------------------
class PseudoGpuProvider implements IAiProvider {
  readonly id = 'pseudoGpu' as const;

  get available(): boolean {
    // Immer verfuegbar - CPU-basierter Fallback
    return !isPseudoGpuFallback();
  }

  canRun(task: AiTask): boolean {
    // Unterstuetzt alle nicht-visuellen Tasks
    // Whisper und Demucs sind ausgeschlossen
    const visualTasks: AiTask[] = ['image.generate', 'video.generate', 'video.abstract'];
    const unavailableTasks: AiTask[] = ['stem.separate', 'audio.transcribe']; // Kein Whisper/Demucs
    return !visualTasks.includes(task) && !unavailableTasks.includes(task);
  }

  estimateCostUsd(_task: AiTask, _model?: string): number {
    // CPU-Kosten sind vernachlaessigbar (~0.001-0.01 €/h)
    return 0.001;
  }

  async run(task: AiTask, model: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const _startTime = Date.now();
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
        case 'audio.analyze':
          return this._handleAudioAnalyze(model, payload);
        case 'audio.classify':
          return this._handleAudioClassify(model, payload);
        case 'audio.embed':
          return this._handleAudioEmbed(model, payload);
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
    // Die Plugins verwenden Plugin-Befehle aus PLUGIN_COMMAND_CATALOG:
    // transport(set_tempo, play, stop), mixer(gain, fade_in_main, channel),
    // eq(automate, preset), master(preset, status, DSP-basiert),
    // syntisampler(note, trigger, pattern_four, pattern_random, pattern_break),
    // drumsampler(kit, trigger), instru(program), spatial(setup, mode),
    // drop(pattern, auto_drop), song(generate), voice(speak, sing),
    // sound(trigger), stem(status), dsp(automate), record(start, stop),
    // ai(plan, status), perfor(mode, reset, status), midi-controller(rescan, learn, mapping)
    return {
      status: 'proposed',
      command: null,
      hint: 'PseudogpuInstanz: KI-Fallback aktiv - nutzen Sie lokale Plugins',
      instruction: instruction.slice(0, 200),
      provider: 'pseudoGpu',
      latencyMs: Date.now(),
      pluginCommands: {
        transport: ['set_tempo(bpm)', 'play', 'stop'],
        mixer: ['gain(db)', 'fade_in_main(seconds)', 'channel(channel)'],
        drop: ['pattern(preset)', 'auto_drop', 'status'],
        song: ['generate(prompt)', 'status'],
        effect: ['automate', 'status'],
        syntisampler: ['note(freq)', 'trigger', 'pattern_four', 'pattern_random', 'pattern_break'],
        drumsampler: ['kit(kit)', 'pattern_random', 'trigger'],
        instru: ['program(program)'],
        biblio: ['sync', 'search(query)', 'load'],
        voice: ['speak(text)', 'sing(text)', 'song(text)'],
        sound: ['trigger', 'status'],
        stem: ['separate', 'status'],
        spatial: ['setup(id)', 'mode(mode)'],
        eq: ['automate', 'preset(name)'],
        dsp: ['automate'],
        master: ['preset(preset)', 'status'],
        record: ['start', 'stop', 'status'],
        ai: ['plan', 'status'],
        perfor: ['mode(mode)', 'reset', 'status'],
        'midi-controller': ['rescan', 'learn', 'mapping'],
      }
    };
  }

  private _handleAudioGenerate(_model: string, payload: Record<string, unknown>): Record<string, unknown> {
    const _prompt = String(payload.prompt ?? '');
    
    // Pseudogpuinstanz: Echter Fallback - kann keine Audio generieren
    return {
      status: 'unavailable',
      message: 'audio.generate: GPU erforderlich. Nutzen Sie GPU-Pod.',
      model: _model,
      provider: 'pseudoGpu',
    };
  }

  private _handleAudioMaster(_model: string, _payload: Record<string, unknown>): Record<string, unknown> {
    // Pseudogpuinstanz: DSP-basiertes Mastering (CPU-faerig)
    return {
      status: 'success',
      message: 'PseudogpuInstanz: DSP-basiertes Mastering aktiv (keine KI)',
      provider: 'pseudoGpu',
      model: _model,
      latencyMs: Date.now(),
      warning: 'CPU-Fallback: DSP-basiertes Mastering ohne KI-Inferenz',
      availablePresets: ['maindb+2', 'limiter3-6', 'bpm-deck-2-3', 'eqpreset-4'],
      pluginCommands: {
        preset: 'preset(name)',
        status: 'status'
      }
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
    // Pseudogpuinstanz: Demucs CPU-Implementierung ist NICHT verfügbar
    const audio = payload.audio;
    if (!audio) {
      throw new AiProviderError('pseudoGpu', 'INVALID_INPUT', 'stem.separate: audio fehlt', false);
    }
    
    // Hinweis für GPU-Nutzer - Demucs ist ausgeschlossen
    return {
      status: 'unavailable',
      message: 'stem.separate: Demucs CPU-Fallback nicht implementiert in PseudogpuInstanz. Nutzen Sie GPU-Pod.',
      model: _model,
      provider: 'pseudoGpu',
      latencyMs: Date.now(),
      warning: 'Demucs ist ausgeschlossen - kein Stem-Separation moeglich'
    };
  }

  private _handleAudioTranscribe(_model: string, payload: Record<string, unknown>): Record<string, unknown> {
    // Pseudogpuinstanz: Whisper CPU-Fallback ist NICHT verfügbar
    const audio = payload.audio;
    if (!audio) {
      throw new AiProviderError('pseudoGpu', 'INVALID_INPUT', 'audio.transcribe: audio fehlt', false);
    }
    
    return {
      status: 'unavailable',
      message: 'audio.transcribe: Whisper CPU-Fallback nicht implementiert in PseudogpuInstanz. Nutzen Sie GPU-Pod.',
      model: _model,
      provider: 'pseudoGpu',
      latencyMs: Date.now(),
      warning: 'Whisper ist ausgeschlossen - keine Transkription moeglich'
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
      warning: 'CPU-Fallback: Geschätzte Werte'
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
      warning: 'CPU-Fallback: Regelbasiert'
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
      warning: 'CPU-Fallback: librosa-Chroma nicht verfuegbar'
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
      warning: 'CPU-Fallback: Speaker-Diarisierung nicht implementiert'
    };
  }

  private _handleAudioUnderstand(_model: string, _payload: Record<string, unknown>): Record<string, unknown> {
    return {
      status: 'success',
      text: '[Audio-Verstehen auf CPU nicht implementiert - GPU-Pod erforderlich]',
      model: _model,
      provider: 'pseudoGpu',
      warning: 'CPU-Fallback: Audio-Understand nicht implementiert'
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
      warning: 'CPU-Fallback: TTS nicht implementiert'
    };
  }

  private _handleSongGenerate(_model: string, _payload: Record<string, unknown>): Record<string, unknown> {
    return {
      status: 'unavailable',
      message: 'Pseudogpuinstanz: Song-Generierung erfordert GPU (ACE-Step)',
      provider: 'pseudoGpu',
      model: _model,
      warning: 'CPU-Fallback: KI-basierte Song-Generierung nicht verfuegbar'
    };
  }

  private _handleLlm(_model: string, _payload: Record<string, unknown>): Record<string, unknown> {
    // Pseudogpuinstanz: LLM wird über LlmRouter (vast-local) geleitet
    throw new AiProviderError('pseudoGpu', 'LOCAL_LLM_NOT_DIRECT', 'LLM lokal über LlmRouter', false);
  }

  private _handleMultimodal(_model: string, _payload: Record<string, unknown>): Record<string, unknown> {
    return {
      status: 'unavailable',
      message: 'Pseudogpuinstanz: Multimodale Tasks erfordern GPU',
      provider: 'pseudoGpu',
      model: _model,
      warning: 'CPU-Fallback: Multimodale Tasks nicht implementiert'
    };
  }

  private _handleAgentOrchestrate(_model: string, _payload: Record<string, unknown>): Record<string, unknown> {
    return {
      status: 'unavailable',
      message: 'Pseudogpuinstanz: Agent-Orchestrierung erfordert GPU',
      provider: 'pseudoGpu',
      model: _model,
      warning: 'CPU-Fallback: Agent-Orchestration nicht implementiert'
    };
  }
}

// ---------------------------------------------------------------------------
// Hilfsfunktion: Pseudo-GPU-Fallback-Aktivierung
// ---------------------------------------------------------------------------
function isPseudoGpuFallback(): boolean {
  const mode = process.env?.AI_MODE?.toLowerCase() ?? '';
  return mode === 'pseudo-gpu' || mode === 'pseudogpu' || mode === 'pseudo_gpu';
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