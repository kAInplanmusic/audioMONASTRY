// @vitest-environment node
/**
 * Drift-Schutz ACE-Step: Task -> Modell -> Pod (Betreiber 2026-10-13)
 * ===================================================================
 * Regel (AGENTS.md 2.3, docs/AI_FLEET_STARTPLAN.md):
 *   - acestep-v15-xl-sft   = Standard fuer music.generate, music.remix (Cover)
 *                            und music.repaint                      -> RP3 music
 *   - acestep-v15-xl-turbo = Drops/Loops (8 Schritte, music.drop)    -> RP3 music
 *   - acestep-v15-xl-base  = NUR music.lego / extract / complete     -> RP4 voice
 *   - acestep-5hz-lm-4b    = Planer (repaint lmModel)                -> RP3 music
 *
 * Geprueft wird jede Stelle, die ein Standardmodell traegt: MCP-Runtime,
 * Kontext-Werkzeuge, Pod-Routing, /api/voice/song, Drop-Audio-Route, MoA-
 * Katalog (Python), ComfyUI-Adapter (Python) und die ausgerollten Pod-Modelle.
 * Aendert jemand eine Stelle, ohne die Regel zu aendern, wird dieser Test rot.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CostTracker } from '../src/core/ai/orchestrator/costTracker';
import { createDefaultMcpRuntime } from '../src/core/ai/orchestrator/mcpRuntime';
import {
  ACE_STEP_BASE_MODEL,
  ACE_STEP_LM_PLANNER,
  ACE_STEP_REPAINT_MODELS,
  ACE_STEP_SFT_MODEL,
  ACE_STEP_TURBO_MODEL,
  MUSIC_CONTEXT_DEFAULT_MODEL,
  type MusicLibraryPort,
} from '../src/core/ai/orchestrator/musicContextTools';
import { LEGO_BASE_MODEL, podRoleFor, type PodRoleId } from '../src/core/ai/orchestrator/podRouting';
import { DROP_AUDIO_MODEL } from '../server/dropAudio';

const SFT = 'acestep-v15-xl-sft';
const TURBO = 'acestep-v15-xl-turbo';
const BASE = 'acestep-v15-xl-base';
const LM = 'acestep-5hz-lm-4b';

/** Die festgeschriebene Zuordnung. */
const RULE: Array<{ tool: string; model: string; pod: PodRoleId; aceTask?: string }> = [
  { tool: 'music.generate', model: SFT, pod: 'music' },
  { tool: 'music.remix', model: SFT, pod: 'music' },
  { tool: 'music.repaint', model: SFT, pod: 'music', aceTask: 'repaint' },
  { tool: 'music.drop', model: TURBO, pod: 'music' },
  { tool: 'music.lego', model: BASE, pod: 'voice', aceTask: 'lego' },
  { tool: 'music.extract', model: BASE, pod: 'voice', aceTask: 'extract' },
  { tool: 'music.complete', model: BASE, pod: 'voice', aceTask: 'complete' },
];

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const json = <T,>(rel: string): T => JSON.parse(src(rel)) as T;

const ARGS: Record<string, Record<string, unknown>> = {
  'music.generate': { prompt: 'techno' },
  'music.remix': { prompt: 'cover' },
  'music.drop': { prompt: 'drop' },
  'music.lego': { contextIds: ['drums-1'], track: 'bass', prompt: 'bass dazu' },
  'music.extract': { sourceId: 'mix-1', track: 'vocals' },
  'music.complete': { contextIds: ['drums-1'], tracks: ['bass'], prompt: 'x' },
  'music.repaint': { sourceId: 'mix-1', start: 0, end: 8, prompt: 'x' },
};

function runtimeWithCapture() {
  const calls: Array<{ task: string; model: string; input: Record<string, unknown> }> = [];
  const library: MusicLibraryPort = {
    resolveAudio: async (id) => ({ id, name: id, audioBase64: 'AA==', bytes: 1 }),
    save: async () => ({ id: 'saved-1' }),
  };
  const runtime = createDefaultMcpRuntime({
    runTask: async (task, model, input) => {
      calls.push({ task, model, input: input as Record<string, unknown> });
      return { audioBase64: 'UklGRg==' };
    },
    getSessionState: () => ({}),
    searchSamples: () => [],
    getRuntimeStatus: () => ({}),
    loadModel: async () => {},
    unloadModel: async () => {},
    musicContext: { getLibrary: () => library, costs: new CostTracker(), getSessionId: () => 's' },
  });
  return { runtime, calls };
}

describe('ACE-Step: Task -> Modell -> Pod (Drift-Schutz)', () => {
  it.each(RULE)('$tool nimmt ohne model-Angabe $model und laeuft auf Pod $pod', async ({ tool, model, pod, aceTask }) => {
    const { runtime, calls } = runtimeWithCapture();
    const res = await runtime.invoke(tool, { ...ARGS[tool], permission: 'EXECUTION' });
    expect(res.ok, res.error).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].task).toBe('song');
    expect(calls[0].model).toBe(model);
    if (aceTask) expect(calls[0].input.aceTask).toBe(aceTask);
    expect(podRoleFor('music', 'song', calls[0].model, calls[0].input)).toBe(pod);
  });

  it('repaint traegt den 5Hz-LM-4B als Planer (RP3)', async () => {
    const { runtime, calls } = runtimeWithCapture();
    await runtime.invoke('music.repaint', { ...ARGS['music.repaint'], permission: 'EXECUTION' });
    expect(calls[0].input.lmModel).toBe(LM);
    expect(ACE_STEP_LM_PLANNER).toBe(LM);
  });

  it('Konstanten stimmen mit der Regel ueberein', () => {
    expect(ACE_STEP_SFT_MODEL).toBe(SFT);
    expect(ACE_STEP_TURBO_MODEL).toBe(TURBO);
    expect(ACE_STEP_BASE_MODEL).toBe(BASE);
    expect(LEGO_BASE_MODEL).toBe(BASE);
    expect(MUSIC_CONTEXT_DEFAULT_MODEL).toEqual({ lego: BASE, extract: BASE, complete: BASE, repaint: SFT });
    // xl-base ist fuer repaint nicht waehlbar (gehoert ausschliesslich zu RP4/LEGO).
    expect([...ACE_STEP_REPAINT_MODELS]).not.toContain(BASE);
  });

  it('xl-base ist NUR fuer lego/extract/complete im Einsatz (kein anderes Werkzeug defaultet darauf)', () => {
    const baseTools = RULE.filter((r) => r.model === BASE).map((r) => r.tool).sort();
    expect(baseTools).toEqual(['music.complete', 'music.extract', 'music.lego']);
  });

  it('Drop-Audio-Route (dropMONK) nutzt xl-turbo auf RP3', () => {
    expect(DROP_AUDIO_MODEL).toBe(TURBO);
    expect(podRoleFor('music', 'song', DROP_AUDIO_MODEL, { inferenceSteps: 8 })).toBe('music');
  });

  it('/api/voice/song nimmt xl-sft (server/routes/voiceRoutes.ts ROLE_TASK_MODEL)', () => {
    const block = /const ROLE_TASK_MODEL[\s\S]*?\n};/.exec(src('../server/routes/voiceRoutes.ts'))?.[0] ?? '';
    expect(/\bsong:\s*'([^']+)'/.exec(block)?.[1]).toBe(SFT);
  });

  it('MoA-Katalog (moa_orchestrator.py TOOL_CATALOG) folgt der Regel', () => {
    const py = src('../services/audiomonastry-ai-runtime/moa_orchestrator.py');
    const modelOf = (tool: string) =>
      new RegExp(`"${tool.replace('.', '\\.')}":\\s*\\{[^}]*"model":\\s*"([^"]+)"`).exec(py)?.[1];
    expect(modelOf('music.generate')).toBe(SFT);
    expect(modelOf('music.remix')).toBe(SFT);
    expect(modelOf('music.drop')).toBe(TURBO);
    // LEGO braucht serverseitige Bibliotheks-Vorspuren und steht deshalb nicht im MoA-Katalog.
    expect(modelOf('music.lego')).toBeUndefined();
  });

  it('ComfyUI-Adapter: Standardmodell der Musik-Rolle ist xl-sft', () => {
    const py = src('../services/audiomonastry-ai-runtime/comfyui_adapter.py');
    expect(/"music":\s*\{[^}]*"defaultModel":\s*"([^"]+)"/.exec(py)?.[1]).toBe(SFT);
  });

  it('jedes Modell liegt ausgerollt auf seinem Pod (deploy/runpod/pod-fleet.json)', () => {
    const fleet = json<{ pods: Array<{ role: string; models: string[] }> }>('../deploy/runpod/pod-fleet.json');
    const models = (role: string) => fleet.pods.find((p) => p.role === role)?.models ?? [];
    for (const { model, pod } of RULE) expect(models(pod), `${model} auf ${pod}`).toContain(model);
    expect(models('music')).toContain(LM);
    // Nicht beide im selben Pod: xl-base nicht auf RP3, sft/turbo nicht auf RP4.
    expect(models('music')).not.toContain(BASE);
    expect(models('voice')).not.toContain(SFT);
    expect(models('voice')).not.toContain(TURBO);
  });

  it('Manifest: Preload der Rolle music ohne xl-base, voiceGen fuehrt xl-base', () => {
    const manifest = json<{ roles: Record<string, { models: string[]; preloadModels: string[] }> }>(
      '../services/audiomonastry-ai-runtime/model_manifest.json',
    );
    expect(manifest.roles.music.preloadModels).toEqual(expect.arrayContaining([SFT, TURBO, LM]));
    expect(manifest.roles.music.preloadModels).not.toContain(BASE);
    expect(manifest.roles.voiceGen.models).toContain(BASE);
  });
});
