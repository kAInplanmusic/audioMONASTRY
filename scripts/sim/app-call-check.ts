/**
 * Verkabelungstest ueber den ECHTEN App-Code (VastProvider + podRouting), ohne GPU gegen die Ersatz-Pods
 * aus scripts/sim/run_fake_fleet.sh oder gegen echte Pods (dann kostet jeder Auftrag GPU-Zeit).
 *   Teil A: warmup() je GPU-Rolle  -> prueft die Vorladelisten (GPU_ROLES[*].preload) gegen die Pods.
 *   Teil B: ein Auftrag je Modell aus MODEL_POD mit der Rolle/Aufgabe, mit der die App es aufruft.
 * Aufruf: set -a; . sim/sim-runtime.env; set +a; npx tsx scripts/sim/app-call-check.ts sim/app-calls.jsonl
 * Auswertung: python3 scripts/sim/evaluate_wiring.py sim/requests.jsonl --app-calls sim/app-calls.jsonl --expect-models
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { GPU_ROLE_LIST } from '../../src/core/ai/orchestrator/endpointRegistry';
import { VastProvider } from '../../src/core/ai/orchestrator/vastProvider';
import type { GpuRoleId } from '../../src/config/aiInfrastructure';
import type { AiTask } from '../../src/core/ai/orchestrator/types';

/** [GPU-Rolle der App, Aufgabe, Modell, Eingabe-Zusatz] – so ruft die App die Modelle auf (Stand 2026-11-19). */
const CASES: ReadonlyArray<[GpuRoleId, AiTask, string, Record<string, unknown>?]> = [
  ['brain', 'llm', 'qwen38-27b-fp8'],
  ['brain', 'gui.execute', 'qwen3-4b'],
  ['ears', 'audio.understand', 'moss-music-8b-instruct'],
  ['ears', 'audio.classify', 'clap-music'],
  ['ears', 'audio.analyze', 'beat-this'],
  ['ears', 'audio.analyze', 'songformer'],
  ['ears', 'audio.analyze', 'dsp-analysis'],
  ['ears', 'audio.transcribe', 'basic-pitch'],
  ['voiceGen', 'tts', 'qwen3-tts-17b'],
  ['voiceGen', 'tts', 'qwen3-tts-voicedesign'],
  ['voiceGen', 'audio.generate', 'moss-soundeffect-v2.0'],
  ['voiceGen', 'song', 'acestep-v15-shared'],
  ['music', 'song', 'acestep-v15-xl-base', { aceTask: 'lego' }],
  ['music', 'song', 'acestep-v15-xl-turbo'],
  ['music', 'song', 'acestep-5hz-lm-4b'],
  ['music', 'song', 'acestep-v15-shared'],
  ['music', 'song', 'yue2-3b'],
  ['voiceGen', 'stem.separate', 'bs-roformer-sw-6stem'],
  ['voiceGen', 'stem.separate', 'mvsep-mega-53'],
  ['voiceGen', 'stem.separate', 'mel-roformer-bve'],
  ['voiceGen', 'audio.master', 'sonicmaster'],
  ['voiceGen', 'audio.upsample', 'universr'],
  ['voiceGen', 'audio.master', 'mel-roformer-dereverb'],
  ['audioBrain' as GpuRoleId, 'llm', 'qwen3-4b'],
];

const OUT = process.argv[2] || 'sim/app-calls.jsonl';
function line(row: Record<string, unknown>): void { appendFileSync(OUT, JSON.stringify(row) + '\n'); }

async function main(): Promise<void> {
  writeFileSync(OUT, '');
  for (const role of GPU_ROLE_LIST) {
    const result = await new VastProvider(role.role).warmup();
    line({ part: 'A', role: role.role, task: 'warmup', models: result.models, ok: result.ok, error: result.message ?? null });
  }
  for (const [role, task, model, extra] of CASES) {
    try {
      const out = await new VastProvider(role).run(task, model, { text: 'Test', prompt: 'Test', audioBase64: '', ...extra }) as { status?: string; error?: string };
      line({ part: 'B', role, task, model, ok: out?.status !== 'error', error: out?.status === 'error' ? String(out.error ?? '') : null });
    } catch (error) {
      line({ part: 'B', role, task, model, ok: false, error: String((error as Error).message).slice(0, 200) });
    }
  }
}

void main();
