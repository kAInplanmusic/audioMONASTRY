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
import { listModels } from './modelRegistry';
import type { AiTask, McpPermission } from './types';
import { MCP_PERMISSION_LEVEL } from './types';
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

    const granted = String(payload.permission ?? 'READ').toUpperCase() as McpPermission;
    const grantedLevel = MCP_PERMISSION_LEVEL[granted] ?? 0;
    if (grantedLevel < MCP_PERMISSION_LEVEL[tool.permission]) {
      return { ok: false, error: `permission denied: ${name} requires ${tool.permission}` };
    }
    if (tool.permission === 'DESTRUCTIVE' && granted !== 'DESTRUCTIVE') {
      return { ok: false, error: 'destructive action requires explicit DESTRUCTIVE permission' };
    }
    try {
      const result = await tool.handler(payload);
      aiLogger.info('mcp tool executed', { model: name });
      return { ok: true, result };
    } catch (error) {
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
  runtime.register({ name: 'audio.generate', category: 'generation', permission: 'EXECUTION', description: 'SFX/Sound-Erzeugung (Stable Audio)' }, (p) => deps.runTask('audio.generate', String(p.model ?? 'stable-audio-open-1.0'), p));
  runtime.register({ name: 'stem.separate', category: 'audio', permission: 'EXECUTION', description: 'Stem-Separation (HTDemucs 6-Stem)' }, (p) => deps.runTask('stem.separate', String(p.model ?? 'htdemucs-6s'), p));
  runtime.register({ name: 'sample.search', category: 'sample', permission: 'READ', description: 'Sample-Suche in der lokalen Bibliothek' }, (p) => deps.searchSamples(String(p.query ?? '')));

  // ---------------------------------------------------------------------------
  // 8-Instanzen-Architektur (docs/runpod-8-instances-complete-plan.md):
  // eigene MCP-Tools je Spezial-Instanz. `image.*`/`video_*.*` erreichen die
  // vorgefertigten ComfyUI-/Hub-Worker (Rolle imageHq/videoReal/videoAbstract),
  // `music.*` die ACE-Step-Musik-Instanz, `agent.*` den MoA-Orchestrator.
  // ---------------------------------------------------------------------------
  const generationTools: Array<{ name: string; task: AiTask; model: string; description: string }> = [
    { name: 'music.generate', task: 'song', model: 'acestep-v15-xl-base', description: 'Track generieren (ACE-Step XL Base)' },
    { name: 'music.remix', task: 'song', model: 'acestep-v15-xl-sft', description: 'Remix / Stil-Transfer (ACE-Step XL SFT)' },
    { name: 'music.drop', task: 'song', model: 'acestep-v15-xl-turbo', description: 'Drop generieren (ACE-Step XL Turbo, 8 Schritte)' },
    { name: 'music.repaint', task: 'song', model: 'acestep-5hz-lm-4b', description: 'Teil-Repaint mit LM-Planer (ACE-Step 5Hz LM 4B)' },
    { name: 'image.generate', task: 'image.generate', model: 'flux2-dev', description: 'Bild generieren (FLUX.2 [dev])' },
    { name: 'image.img2img', task: 'image.generate', model: 'qwen-image-2512', description: 'Bild zu Bild (Qwen-Image-2512)' },
    { name: 'image.keyframes', task: 'image.generate', model: 'flux2-dev', description: 'Keyframes pro Track-Abschnitt' },
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
