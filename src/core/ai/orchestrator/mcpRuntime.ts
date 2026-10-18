/**
 * audioMONASTRY · AI Orchestrator – MCP Runtime (Server-seitig)
 * ==============================================================
 * Production-grade Tool-Registry mit Permissions READ/WRITE/EXECUTION/DESTRUCTIVE.
 *
 * Regel: Es werden NUR tatsächlich existierende, serverseitig verfügbare
 * audioMONASTRY-Funktionen exponiert. Keine Fake-Tools.
 * DAW-/Plugin-Zustand (project/track/mixer/plugin) liegt client-seitig und wird
 * bewusst NICHT über das Server-MCP gefälscht – dafür existiert die
 * `pluginCommandRegistry` (VoiceControlService) im Client-Pfad.
 */
import { aiLogger } from './aiLogger';
import { CostTracker } from './costTracker';
import { listModels } from './modelRegistry';
import {
  MusicContextGuard,
  resolveMusicContextLimits,
  runMusicContextTool,
  type MusicContextDeps,
  type MusicContextTask,
} from './musicContextTools';
import type { AiTask, McpPermission } from './types';
import { MCP_PERMISSION_LEVEL } from './types';
import { isToolArgsFailure, validateToolArgs } from '../toolArgs';
import { UpstreamError, upstreamFailure } from '../upstreamErrors';
import { PLUGIN_COMMAND_CATALOG } from '../../../utils/prompts';

export interface McpToolSpec {
  name: string;
  category: 'project' | 'track' | 'mixer' | 'plugin' | 'audio' | 'sample' | 'generation' | 'analysis' | 'session';
  permission: McpPermission;
  description: string;
}

export interface McpToolResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

type ToolHandler = (payload: Record<string, unknown>) => Promise<unknown> | unknown;

export class McpRuntime {
  private tools = new Map<string, McpToolSpec & { handler: ToolHandler }>();

  register(spec: McpToolSpec, handler: ToolHandler): void {
    this.tools.set(spec.name, { ...spec, handler });
  }

  listTools(): McpToolSpec[] {
    return [...this.tools.values()].map(({ handler: _h, ...spec }) => spec).sort((a, b) => a.name.localeCompare(b.name));
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  async invoke(name: string, payload: Record<string, unknown> = {}): Promise<McpToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, error: `unknown tool: ${name}` };

    // Autorisierung VOR dem Payload: eine fehlende Berechtigung darf nicht als
    // Argumentfehler erscheinen (und umgekehrt).
    const granted = String(payload?.permission ?? 'READ').toUpperCase() as McpPermission;
    const grantedLevel = MCP_PERMISSION_LEVEL[granted] ?? 0;
    if (grantedLevel < MCP_PERMISSION_LEVEL[tool.permission]) {
      return { ok: false, error: `permission denied: ${name} requires ${tool.permission}` };
    }

    // DA-2026-10-17-018: Argumente kommen aus LLM-Antworten (Agent-Plan,
    // `command(param, …)`). Vor der Ausfuehrung gegen die Parameter-Allowlist
    // des Werkzeugs pruefen: unbekannte Schluessel werden verworfen,
    // Laengen/Typen begrenzt - kein freies Durchreichen in das RunPod-`input`.
    const checked = validateToolArgs(name, payload);
    if (isToolArgsFailure(checked)) {
      aiLogger.warn('mcp tool args rejected', { model: name, error: checked.error });
      return { ok: false, error: `invalid arguments: ${checked.error}` };
    }
    const args = checked.args;
    if (checked.dropped.length > 0) {
      aiLogger.warn('mcp tool args pruned', { model: name, dropped: checked.dropped.join(',') });
    }
    // DA-2026-09-29-049 (F41): Hier stand eine zweite Pruefung
    // (`tool.permission === 'DESTRUCTIVE' && granted !== 'DESTRUCTIVE'`) - sie
    // konnte nie greifen, weil die Stufenpruefung darueber alles unter Stufe 4
    // schon abweist. Die Regel "DESTRUCTIVE nur mit Stufe 4" steckt damit
    // genau einmal hier und kann nicht mehr zu sich selbst in Widerspruch
    // geraten (dieselbe Bereinigung wie in der Python-Runtime).
    try {
      const result = await tool.handler(args);
      aiLogger.info('mcp tool executed', { model: name });
      return { ok: true, result };
    } catch (error) {
      // DA-2026-10-17-014: Handler-Fehler koennen Upstream-Bodies enthalten.
      // NUR `UpstreamError` wird zur generischen Meldung; lokale
      // Validierungsfehler (z. B. Zod) bleiben fachlich sichtbar.
      if (error instanceof UpstreamError) {
        const failure = upstreamFailure(name, error);
        return { ok: false, error: `${name}: Ausfuehrung fehlgeschlagen (${failure.correlationId})` };
      }
      aiLogger.warn('mcp tool failed', { model: name, error: (error as Error).message });
      return { ok: false, error: (error as Error).message };
    }
  }
}

/** Baut die Default-Registry mit realen Server-Funktionen. */
export function createDefaultMcpRuntime(deps: {
  runTask: (task: AiTask, model: string, input: unknown) => Promise<unknown>;
  getSessionState: () => Record<string, unknown>;
  searchSamples: (query: string) => Array<{ id: string; name: string; category: string }>;
  getRuntimeStatus: () => Record<string, unknown>;
  loadModel: (modelId: string) => Promise<void>;
  unloadModel: (modelId: string) => Promise<void>;
  /** P3-2: geplantes Plugin-Kommando an den Client-Pfad durchreichen. */
  recordPluginCommand?: (cmd: { pluginId: string; action: string; parameters: Record<string, unknown> }) => void;
  /** GPU-Flotten-Status (nur registriert, wenn der Aufrufer ihn liefert). */
  getFleetStatus?: () => Record<string, unknown>;
  /** Session-Wake der GPU-Flotte (workersMin + Warmup). */
  wakeFleet?: () => Promise<unknown>;
  /**
   * LEGO-P1-001: Bibliothek, Kostenbuch und Session fuer die Kontext-Werkzeuge
   * (music.lego/extract/complete/repaint). Ohne Angabe sind die Werkzeuge
   * registriert, melden aber klar "Bibliothek nicht angebunden".
   */
  musicContext?: Omit<MusicContextDeps, 'runTask' | 'guard' | 'limits'>;
}): McpRuntime {
  const runtime = new McpRuntime();

  runtime.register({ name: 'session.getState', category: 'session', permission: 'READ', description: 'AI-Session-Zustand' }, () => deps.getSessionState());
  runtime.register({ name: 'runtime.status', category: 'session', permission: 'READ', description: 'GPU/Runtime/Metrik-Status' }, () => deps.getRuntimeStatus());
  if (deps.getFleetStatus) {
    runtime.register(
      { name: 'fleet.status', category: 'session', permission: 'READ', description: 'GPU-Flotten-Rollen (Endpoint, VRAM, Tasks, Preload)' },
      () => deps.getFleetStatus?.(),
    );
  }
  if (deps.wakeFleet) {
    runtime.register(
      { name: 'fleet.wake', category: 'session', permission: 'EXECUTION', description: 'GPU-Flotte wecken (workersMin + Warmup-Jobs)' },
      () => deps.wakeFleet?.(),
    );
  }
  runtime.register({ name: 'models.list', category: 'session', permission: 'READ', description: 'Modell-Registry (geladen/verfügbar)' }, () => listModels().map((m) => ({ id: m.id, task: m.task, loadClass: m.loadClass, license: m.license })));
  runtime.register({ name: 'model.load', category: 'session', permission: 'EXECUTION', description: 'Modell laden' }, (p) => deps.loadModel(String(p.model ?? '')));
  runtime.register({ name: 'model.unload', category: 'session', permission: 'EXECUTION', description: 'Modell entladen' }, (p) => deps.unloadModel(String(p.model ?? '')));

  runtime.register({ name: 'audio.classify', category: 'analysis', permission: 'EXECUTION', description: 'Audio-Klassifikation (AST)' }, (p) => deps.runTask('audio.classify', String(p.model ?? 'ast-audioset'), p));
  runtime.register({ name: 'audio.transcribe', category: 'analysis', permission: 'EXECUTION', description: 'Speech-to-Text (Whisper)' }, (p) => deps.runTask('audio.transcribe', String(p.model ?? 'whisper-large-v3'), p));
  runtime.register({ name: 'audio.embed', category: 'analysis', permission: 'EXECUTION', description: 'Audio-Embeddings (CLAP/MERT)' }, (p) => deps.runTask('audio.embed', String(p.model ?? 'clap-music'), p));
  runtime.register({ name: 'audio.analyze', category: 'analysis', permission: 'EXECUTION', description: 'Musik-Analyse: BPM/Key/Genre/Struktur (Essentia)' }, (p) => deps.runTask('audio.analyze', String(p.model ?? 'essentia'), p));
  runtime.register({ name: 'audio.diarize', category: 'analysis', permission: 'EXECUTION', description: 'Sprechertrennung (PyAnnote)' }, (p) => deps.runTask('audio.diarize', String(p.model ?? 'pyannote-diarization'), p));
  runtime.register({ name: 'audio.understand', category: 'analysis', permission: 'EXECUTION', description: 'Audio-Understanding (Qwen2-Audio)' }, (p) => deps.runTask('audio.understand', String(p.model ?? 'qwen2-audio-7b'), p));
  // FLEET-P1-008 (offen): moss-soundeffect-v2.0 erst, wenn sein Handler existiert -
  // solange laeuft der Task ueber den Stable-Audio-Handler (siehe voiceRoutes.ts).
  runtime.register({ name: 'audio.generate', category: 'generation', permission: 'EXECUTION', description: 'SFX/Sound-Erzeugung (Stable Audio)' }, (p) => deps.runTask('audio.generate', String(p.model ?? 'stable-audio-open-1.0'), p));
  // FLEET-P1-006: RP5-Hauptmodell BS-RoFormer SW (6 Modell-Stems -> 5 stemMONK-Stems); `htdemucs-6s` bleibt per `model` waehlbar (Alias).
  runtime.register({ name: 'stem.separate', category: 'audio', permission: 'EXECUTION', description: 'Stem-Separation: 5 Stems (Vocals, Lows, Mids, Highs, Melodie) per BS-RoFormer SW' }, (p) => deps.runTask('stem.separate', String(p.model ?? 'bs-roformer-sw-6stem'), p));
  runtime.register({ name: 'sample.search', category: 'sample', permission: 'READ', description: 'Sample-Suche in der lokalen Bibliothek' }, (p) => deps.searchSamples(String(p.query ?? '')));

  // ---------------------------------------------------------------------------
  // 8-Instanzen-Architektur (docs/runpod-8-instances-complete-plan.md):
  // eigene MCP-Tools je Spezial-Instanz. `image.*`/`video_*.*` erreichen die
  // vorgefertigten ComfyUI-/Hub-Worker (Rolle imageHq/videoReal/videoAbstract),
  // `music.*` die ACE-Step-Musik-Instanz, `agent.*` den MoA-Orchestrator.
  // ---------------------------------------------------------------------------
  const generationTools: Array<{ name: string; task: AiTask; model: string; description: string }> = [
    // Betreiber-Entscheid 2026-10-12: xl-base liegt auf RP4 (LEGO), RP3 traegt sft/turbo.
    { name: 'music.generate', task: 'song', model: 'acestep-v15-xl-sft', description: 'Track generieren (ACE-Step XL SFT)' },
    { name: 'music.remix', task: 'song', model: 'acestep-v15-xl-sft', description: 'Remix / Stil-Transfer (ACE-Step XL SFT)' },
    { name: 'music.drop', task: 'song', model: 'acestep-v15-xl-turbo', description: 'Drop generieren (ACE-Step XL Turbo, 8 Schritte)' },
    { name: 'image.generate', task: 'image.generate', model: 'flux1-dev', description: 'Bild generieren (FLUX.1-dev komprimiert)' },
    { name: 'image.img2img', task: 'image.generate', model: 'qwen-image-2512', description: 'Bild zu Bild (Qwen-Image-2512)' },
    { name: 'image.keyframes', task: 'image.generate', model: 'flux1-dev', description: 'Keyframes pro Track-Abschnitt (FLUX.1-dev komprimiert)' },
    { name: 'image.upscale', task: 'image.generate', model: 'realesrgan-x4', description: 'Bild hochskalieren (Real-ESRGAN 4x)' },
    { name: 'video_real.text2video', task: 'video.generate', model: 'wan22-t2v-a14b', description: 'Text zu Video (Wan 2.2 A14B)' },
    { name: 'video_real.img2video', task: 'video.generate', model: 'wan22-t2v-a14b', description: 'Bild zu Video (Wan 2.2 A14B)' },
    { name: 'video_real.loop', task: 'video.generate', model: 'wan22-t2v-a14b', description: 'Nahtloser Video-Loop (Wan 2.2)' },
    { name: 'video_abstract.text2video', task: 'video.abstract', model: 'ltx-video-13b', description: 'Text zu abstraktem Video (LTXVideo 13B)' },
    { name: 'video_abstract.img2video', task: 'video.abstract', model: 'ltx-video-13b', description: 'Bild zu abstraktem Video (LTXVideo 13B)' },
    { name: 'video_abstract.glitch', task: 'video.abstract', model: 'ltx-video-13b', description: 'Glitch-Effekt, audio-synchron' },
    { name: 'agent.orchestrate', task: 'agent.orchestrate', model: 'qwen3-4b', description: 'MoA-Pipeline planen und ausführen (Classifier → Planner → Aggregator)' },
  ];
  for (const tool of generationTools) {
    runtime.register(
      { name: tool.name, category: 'generation', permission: 'EXECUTION', description: tool.description },
      (p) => deps.runTask(tool.task, String(p.model ?? tool.model), p),
    );
  }

  // ---------------------------------------------------------------------------
  // LEGO-P1-001: Kontext-Layering (Konzept ACE-Step, eigener Code). Vorspuren
  // kommen als Bibliotheks-IDs, werden serverseitig aufgeloest und als
  // Kontext-Audio an die Musik-Rolle gereicht; jede Ausgabe landet still in der
  // Bibliothek. Argumente per Zod validiert, Rate-/Budget-Bremse je Session.
  // Details und ACE-Step-Vertrag: musicContextTools.ts.
  // ---------------------------------------------------------------------------
  const musicLimits = resolveMusicContextLimits();
  const musicGuard = new MusicContextGuard(musicLimits);
  const musicDeps: MusicContextDeps = {
    runTask: deps.runTask,
    getLibrary: deps.musicContext?.getLibrary ?? (() => null),
    costs: deps.musicContext?.costs ?? new CostTracker(),
    getSessionId: deps.musicContext?.getSessionId ?? (() => 'default'),
    limits: musicLimits,
    guard: musicGuard,
  };
  const contextTools: Array<{ task: MusicContextTask; description: string }> = [
    { task: 'lego', description: 'Neue Spur zu Vorspuren erzeugen (contextIds, track, prompt, bpm?, key?) – ACE-Step lego, Base-Modell' },
    { task: 'extract', description: 'Spur aus einer Quelle isolieren (sourceId, track) – ACE-Step extract, Base-Modell' },
    { task: 'complete', description: 'Vorspuren um Spurtypen vervollstaendigen (contextIds, tracks, prompt) – ACE-Step complete, Base-Modell' },
    { task: 'repaint', description: 'Zeitbereich neu malen (sourceId, start, end, mode conservative|balanced|aggressive, prompt)' },
  ];
  for (const tool of contextTools) {
    runtime.register(
      { name: `music.${tool.task}`, category: 'generation', permission: 'EXECUTION', description: tool.description },
      (p) => runMusicContextTool(tool.task, p, musicDeps),
    );
  }

  // ---------------------------------------------------------------------------
  // P3-2: Plugin-MCP-Tools (serverseitige Planung, client-seitige Ausführung).
  // Der Server kennt den kanonischen Kommando-Katalog (src/utils/prompts.ts) und
  // validiert pluginId/action. Die tatsächliche Audio-Ausführung passiert im
  // Client über die pluginCommandRegistry – hier wird das Kommando nur geplant
  // und an den Client-Pfad durchgereicht (keine Fake-Audio-Tools).
  // ---------------------------------------------------------------------------
  const catalogCommands = Object.entries(PLUGIN_COMMAND_CATALOG).flatMap(([pluginId, cmds]) =>
    cmds.split(',').map((part) => ({ pluginId, action: part.trim().split('(')[0].trim() })).filter((c) => c.action),
  );

  for (const { pluginId, action } of catalogCommands) {
    runtime.register(
      {
        name: `${pluginId}.${action}`,
        category: 'plugin',
        permission: 'WRITE',
        description: `Plant ${pluginId}:${action} (Ausführung client-seitig via pluginCommandRegistry)`,
      },
      (p) => {
        deps.recordPluginCommand?.({ pluginId, action, parameters: { ...p, permission: undefined } });
        return { pluginId, action, planned: true };
      },
    );
  }

  // Explizite Tool-Aliase aus P3-2 (mixer.set_channel, syntisampler.play_note, …).
  const PLUGIN_TOOL_ALIASES: Record<string, { pluginId: string; action: string }> = {
    'mixer.set_channel': { pluginId: 'mixer', action: 'channel' },
    'synth.play_note': { pluginId: 'syntisampler', action: 'note' },
    'synthesizer.play_note': { pluginId: 'syntisampler', action: 'note' },
    'sequencer.load_pattern': { pluginId: 'syntisampler', action: 'pattern_four' },
    'mcp.load_pattern': { pluginId: 'syntisampler', action: 'pattern_four' },
  };
  for (const [toolName, target] of Object.entries(PLUGIN_TOOL_ALIASES)) {
    runtime.register(
      {
        name: toolName,
        category: 'plugin',
        permission: 'WRITE',
        description: `Alias für ${target.pluginId}.${target.action}`,
      },
      (p) => {
        deps.recordPluginCommand?.({ pluginId: target.pluginId, action: target.action, parameters: { ...p, permission: undefined } });
        return { pluginId: target.pluginId, action: target.action, planned: true };
      },
    );
  }

  runtime.register(
    {
      name: 'plugin.command',
      category: 'plugin',
      permission: 'WRITE',
      description: 'Plugin-Kommando planen (pluginId, action, parameters)',
    },
    (p) => {
      const pluginId = String(p.pluginId ?? '');
      const action = String(p.action ?? '');
      const known = catalogCommands.some((c) => c.pluginId === pluginId && c.action === action);
      if (!pluginId || !action || !known) {
        throw new Error(`unknown plugin command: ${pluginId}:${action}`);
      }
      deps.recordPluginCommand?.({ pluginId, action, parameters: { ...p, permission: undefined } });
      return { pluginId, action, planned: true };
    },
  );

  return runtime;
}
