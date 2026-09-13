/**
 * audioMONASTRY · AI-Orchestrator – GPU-Rollen-Registry
 * =====================================================
 * Einzige Quelle der Wahrheit darüber, welche Flotten-Rolle
 *   - welchen Serverless-Endpoint besitzt,
 *   - welches VRAM-Budget und welche RunPod-GPU-Pool-ID sie hat,
 *   - welche AI-Tasks sie bedienen darf,
 *   - welche Modelle sie vorlädt.
 *
 * Die Task-Mengen der Rollen sind DISJUNKT: pro Task gibt es genau eine
 * zuständige Rolle. Das hält das Routing eindeutig und verhindert, dass ein
 * Task versehentlich auf einem Endpoint landet, der sein Modell nicht hat.
 *
 * Migrationspfad: fehlt eine rollenspezifische Endpoint-ID, fällt JEDE Rolle
 * auf `RP_ENDPOINT_ID` zurück (Legacy-Single-Endpoint-Modus, z. B. der
 * bestehende H200-Endpoint). Der Cutover ist damit ohne Codeänderung möglich.
 */
import { GPU_ROLE_IDS, endpointNameForRole, type GpuRoleId } from '../../../config/aiInfrastructure';
import { aiLogger } from './aiLogger';
import type { AiTask } from './types';

/** Vollständige Beschreibung einer Flotten-Rolle. */
export interface GpuRoleDefinition {
  role: GpuRoleId;
  /** Menschenlesbares Label (Logs, perforMONK, Doku). */
  label: string;
  /** RunPod-Serverless-Endpoint-Name (Deploy-Namenskonvention). */
  endpointName: string;
  /** env-Variable, die die Endpoint-ID dieser Rolle hält. */
  endpointIdEnv: string;
  /** RunPod-GPU-POOL-ID (z. B. AMPERE_48 = A6000 48 GB). */
  gpuPoolId: string;
  /** GPUs pro Worker (1; nur der Brain-Upgrade-Pfad nutzt 2). */
  gpuCount: number;
  /** Physisches VRAM-Budget der Rolle in GB (Spiegel des Rollen-Manifests). */
  vramBudgetGb: number;
  /** Tasks, die ausschließlich diese Rolle ausführt. */
  tasks: readonly AiTask[];
  /** Modelle, die der Rollen-Worker beim Session-Wake vorlädt. */
  preload: readonly string[];
  /** Primäres LLM dieser Rolle (nur brain) – `moderate`/`complex`. */
  brainModel?: string;
  /** Schneller Ausführer derselben Familie (nur brain) – `simple`. */
  executorModel?: string;
}

/**
 * Task-Mengen sind disjunkt. `llm`/`nlu` gehören dem Gehirn, `audio.*` den
 * Ohren, Erzeugung/Trennung der Voice-/Generierungs-Rolle.
 */
export const GPU_ROLES: Record<GpuRoleId, GpuRoleDefinition> = {
  brain: {
    role: 'brain',
    label: 'aiMONK Gehirn (lokales LLM)',
    endpointName: endpointNameForRole('brain'),
    endpointIdEnv: 'RP_ENDPOINT_ID_BRAIN',
    gpuPoolId: 'AMPERE_48',
    gpuCount: 1,
    vramBudgetGb: 48,
    tasks: ['llm', 'nlu'],
    // Zwei Stufen, EINE Familie (Entscheidung 2026-09-11): `qwen3-4b` ist der
    // schnelle Ausführer für latenzkritische `simple`-Aufgaben, `qwen3-14b` das
    // Brain für Planung/`moderate`/`complex`. Beide sind `preload` und bleiben
    // gleichzeitig resident (30 + 9 GB < 48 GB Budget) – kein LRU-Wechsel.
    // Upgrade auf qwen3-32b / glm-4.5-air, sobald deren Revision gepinnt ist
    // (im Rollen-Manifest als status="planned" geführt).
    preload: ['qwen3-4b', 'qwen3-14b'],
    brainModel: 'qwen3-14b',
    executorModel: 'qwen3-4b',
  },
  ears: {
    role: 'ears',
    label: 'Audio-Intelligence (STT, Embeddings, Klassifikation)',
    endpointName: endpointNameForRole('ears'),
    endpointIdEnv: 'RP_ENDPOINT_ID_EARS',
    gpuPoolId: 'AMPERE_48',
    gpuCount: 1,
    vramBudgetGb: 48,
    tasks: [
      'audio.classify',
      'audio.transcribe',
      'audio.embed',
      'audio.analyze',
      'audio.diarize',
      'audio.understand',
      'multimodal',
    ],
    preload: ['ast-audioset', 'whisper-large-v3', 'clap-music'],
  },
  voiceGen: {
    role: 'voiceGen',
    label: 'Voice & Generierung (TTS, Gesang, Song, SFX, Stems)',
    endpointName: endpointNameForRole('voiceGen'),
    endpointIdEnv: 'RP_ENDPOINT_ID_VOICE',
    gpuPoolId: 'AMPERE_48',
    gpuCount: 1,
    vramBudgetGb: 48,
    tasks: ['tts', 'sing', 'song', 'audio.generate', 'stem.separate'],
    preload: ['qwen3-tts-06b', 'mms-tts-deu', 'demucs'],
  },
};

/**
 * Tasks, die länger als ein `runsync`-Fenster dauern können. Sie laufen über
 * `POST /run` + Polling auf `GET /status/{id}`.
 *
 * `llm` gehört dazu: ein kalter Brain-Worker lädt beim ersten Aufruf die
 * Gewichte (bei 14B fp16 zweistellige GB) – das sprengt das runsync-Fenster.
 * Warme Worker antworten zwar schneller, aber der Kalte Fall darf nicht brechen.
 */
export const LONG_RUNNING_TASKS: ReadonlySet<AiTask> = new Set<AiTask>([
  'llm',
  'song',
  'sing',
  'audio.generate',
  'stem.separate',
]);

/** Alle Rollen in Anzeige-Reihenfolge. */
export const GPU_ROLE_LIST: readonly GpuRoleDefinition[] = GPU_ROLE_IDS.map((id) => GPU_ROLES[id]);

/** Zuständige Rolle für einen Task (oder null, wenn keiner Rolle zugeordnet). */
export function roleForTask(task: AiTask): GpuRoleId | null {
  for (const role of GPU_ROLE_LIST) {
    if (role.tasks.includes(task)) return role.role;
  }
  return null;
}

/** Definitionsgemäß zuständige Rolle; wirft, wenn der Task unbekannt ist. */
export function requireRoleForTask(task: AiTask): GpuRoleDefinition {
  const role = roleForTask(task);
  if (!role) throw new Error(`kein GPU-Rollen-Endpoint für Task ${task}`);
  return GPU_ROLES[role];
}

/** Browser-sicher (siehe runpodProvider.env): im Client gibt es kein `process`. */
function env(name: string): string {
  if (typeof process === 'undefined' || !process.env) return '';
  return (process.env[name] ?? '').trim();
}

/** Aufgelöste Rolle mit konkreter Endpoint-ID. */
export interface ResolvedGpuRole extends GpuRoleDefinition {
  /** Endpoint-ID oder '' wenn nicht konfiguriert. */
  endpointId: string;
  /** true, wenn die Rolle auf RP_ENDPOINT_ID zurückfällt (Legacy-Modus). */
  usingLegacyEndpoint: boolean;
}

/**
 * Liest für jede Rolle die Endpoint-ID aus der Umgebung. Ohne
 * rollenspezifische ID wird `RP_ENDPOINT_ID` als gemeinsamer Fallback
 * verwendet (bestehender Endpoint bleibt damit lauffähig).
 */
export function resolveGpuRoles(): ResolvedGpuRole[] {
  const legacy = env('RP_ENDPOINT_ID') || env('RUNPOD_ENDPOINT_ID');
  return GPU_ROLE_LIST.map((role) => {
    const own = env(role.endpointIdEnv) || env(role.endpointIdEnv.replace(/^RP_/, 'RUNPOD_'));
    const usingLegacy = !own && Boolean(legacy);
    if (usingLegacy) {
      aiLogger.warn('gpu role using legacy single endpoint', {
        role: role.role,
        env: role.endpointIdEnv,
        fallback: 'RP_ENDPOINT_ID',
      });
    }
    return { ...role, endpointId: own || legacy, usingLegacyEndpoint: usingLegacy };
  });
}

