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
}): McpRuntime {
  const runtime = new McpRuntime();

  runtime.register({ name: 'session.getState', category: 'session', permission: 'READ', description: 'AI-Session-Zustand' }, () => deps.getSessionState());
  runtime.register({ name: 'runtime.status', category: 'session', permission: 'READ', description: 'GPU/Runtime/Metrik-Status' }, () => deps.getRuntimeStatus());
  runtime.register({ name: 'models.list', category: 'session', permission: 'READ', description: 'Modell-Registry (geladen/verfügbar)' }, () => listModels().map((m) => ({ id: m.id, task: m.task, loadClass: m.loadClass, license: m.license })));
  runtime.register({ name: 'model.load', category: 'session', permission: 'EXECUTION', description: 'Modell laden' }, (p) => deps.loadModel(String(p.model ?? '')));
  runtime.register({ name: 'model.unload', category: 'session', permission: 'EXECUTION', description: 'Modell entladen' }, (p) => deps.unloadModel(String(p.model ?? '')));

  runtime.register({ name: 'audio.classify', category: 'analysis', permission: 'EXECUTION', description: 'Audio-Klassifikation (AST)' }, (p) => deps.runTask('audio.classify', String(p.model ?? 'ast-audioset'), p));
  runtime.register({ name: 'audio.transcribe', category: 'analysis', permission: 'EXECUTION', description: 'Speech-to-Text (Whisper)' }, (p) => deps.runTask('audio.transcribe', String(p.model ?? 'whisper-large-v3'), p));
  runtime.register({ name: 'audio.embed', category: 'analysis', permission: 'EXECUTION', description: 'Audio-Embeddings (CLAP)' }, (p) => deps.runTask('audio.embed', String(p.model ?? 'clap-music'), p));
  runtime.register({ name: 'audio.analyze', category: 'analysis', permission: 'EXECUTION', description: 'Audio-Analyse (Diariation)' }, (p) => deps.runTask('audio.analyze', String(p.model ?? 'pyannote-diarization'), p));
  runtime.register({ name: 'audio.generate', category: 'generation', permission: 'EXECUTION', description: 'Audio-/Musik-Generierung' }, (p) => deps.runTask('audio.generate', String(p.model ?? 'musicgen-small'), p));
  runtime.register({ name: 'stem.separate', category: 'audio', permission: 'EXECUTION', description: 'Stem-Separation (Replicate)' }, (p) => deps.runTask('stem.separate', String(p.model ?? 'cjwbw/demucs'), p));
  runtime.register({ name: 'sample.search', category: 'sample', permission: 'READ', description: 'Sample-Suche in der lokalen Bibliothek' }, (p) => deps.searchSamples(String(p.query ?? '')));

  return runtime;
}
