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
  /**
   * Wie die Rolle geweckt wird:
   *  - `task`     – der Worker kennt unseren `warmup`-Task und lädt die
   *                 Preload-Modelle in den VRAM (unser eigenes Image).
   *  - `endpoint` – fremder/vorgefertigter Worker (ComfyUI/Hub), der unser
   *                 Protokoll NICHT kennt: Wecken ist hier nur `workersMin=1`,
   *                 ein `warmup`-Job würde als ungültiger Request enden.
   */
  warmupMode: 'task' | 'endpoint';
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
    warmupMode: 'task',
    // Zwei Stufen, EINE Familie (Entscheidung 2026-09-11): `qwen3-4b` ist der
    // schnelle Ausführer für latenzkritische `simple`-Aufgaben, `qwen3-14b` das
    // Brain für Planung/`moderate`/`complex`. Beide sind `preload` und bleiben
    // gleichzeitig resident (30 + 9 GB < 48 GB Budget) – kein LRU-Wechsel.
    // Upgrade auf qwen3-32b / glm-4.5-air, sobald deren Revision gepinnt ist
    // (im Rollen-Manifest als status="planned" geführt).
    preload: ['qwen3-30b-a3b-awq', 'qwen3-4b'],
    brainModel: 'qwen3-30b-a3b-awq',
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
    warmupMode: 'task',
    // Full-Preload (Plan Instanz 2): alle sieben Analyse-Modelle sind fest
    // resident (~26 GB + 6 GB Puffer). Kein on-demand-Nachladen.
    preload: [
      'whisper-large-v3',
      'clap-music',
      'mert-v1-330m',
      'qwen2-audio-7b',
      'pyannote-diarization',
      'ast-audioset',
      'essentia',
    ],
  },
  voiceGen: {
    role: 'voiceGen',
    label: 'Voice & Generierung (TTS, Gesang, Song, SFX, Stems)',
    endpointName: endpointNameForRole('voiceGen'),
    endpointIdEnv: 'RP_ENDPOINT_ID_VOICE',
    gpuPoolId: 'AMPERE_48',
    gpuCount: 1,
    vramBudgetGb: 48,
    tasks: ['tts', 'audio.generate', 'stem.separate'],
    warmupMode: 'task',
    // Standard-TTS: qwen3-tts-17b (1,7B CustomVoice, DE/EN + 8 weitere
    // Sprachen, 9 Premium-Stimmen, Instruct-Steuerung). mms-tts-deu bleibt als
    // Fallback im Modell-Register, wird aber nicht mehr vorgeladen.
    // Full-Preload (Plan Instanz 3): CustomVoice + VoiceDesign + HTDemucs
    // 6-Stem + Stable Audio Open (~34 GB). `song` liegt jetzt bei `music`.
    preload: ['qwen3-tts-17b', 'qwen3-tts-voicedesign', 'htdemucs-6s', 'stable-audio-open-1.0'],
  },
  music: {
    role: 'music',
    label: 'Musik-Generierung (ACE-Step 1.5 XL + LM-Planer + Genre-LoRAs)',
    endpointName: endpointNameForRole('music'),
    endpointIdEnv: 'RP_ENDPOINT_ID_MUSIC',
    gpuPoolId: 'AMPERE_48',
    gpuCount: 1,
    vramBudgetGb: 48,
    tasks: ['song', 'sing'],
    // Vorgefertigter ACE-Step-ComfyUI-Worker (Hub): kennt unseren `warmup`-Task
    // nicht, wird nur per workersMin geweckt.
    warmupMode: 'endpoint',
    // Alle drei XL-Varianten teilen Tokenizer/VAE und bleiben zusammen mit dem
    // 4B-LM-Planer resident (~35 GB + LoRAs).
    preload: [
      'acestep-v15-xl-base',
      'acestep-v15-xl-sft',
      'acestep-v15-xl-turbo',
      'acestep-5hz-lm-4b',
    ],
  },
  imageHq: {
    role: 'imageHq',
    label: 'Bild-Generierung (FLUX.2 [dev] + Qwen-Image-2512 + ControlNet/IP-Adapter)',
    endpointName: endpointNameForRole('imageHq'),
    endpointIdEnv: 'RP_ENDPOINT_ID_IMAGE',
    gpuPoolId: 'AMPERE_48',
    gpuCount: 1,
    vramBudgetGb: 48,
    tasks: ['image.generate'],
    // Vorgefertigter ComfyUI-Worker: kennt unseren `warmup`-Task nicht.
    warmupMode: 'endpoint',
    // FLUX.2 (~32 GB) und Qwen-Image (~15 GB) passen nicht gleichzeitig in 48 GB;
    // beide liegen lokal vorkonfiguriert, der Wechsel dauert < 10 s. ControlNet,
    // IP-Adapter und Upscaler bleiben dauerhaft resident.
    preload: [
      'flux2-dev',
      'qwen-image-2512',
      'controlnet-depth',
      'controlnet-canny',
      'ip-adapter-image',
      'realesrgan-x4',
    ],
  },
  videoReal: {
    role: 'videoReal',
    label: 'Video photorealistisch (Wan 2.2 A14B)',
    endpointName: endpointNameForRole('videoReal'),
    endpointIdEnv: 'RP_ENDPOINT_ID_VIDEO_REAL',
    gpuPoolId: 'AMPERE_48',
    gpuCount: 1,
    vramBudgetGb: 48,
    tasks: ['video.generate'],
    // Vorgefertigter Wan2.2-Worker: kennt unseren `warmup`-Task nicht.
    warmupMode: 'endpoint',
    preload: [
      'wan22-t2v-a14b',
      'controlnet-depth-video',
      'controlnet-canny-video',
      'ip-adapter-video',
      'rife-interpolation',
      'realesrgan-video-x4',
    ],
  },
  videoAbstract: {
    role: 'videoAbstract',
    label: 'Video abstrakt/stylisiert (LTXVideo 13B)',
    endpointName: endpointNameForRole('videoAbstract'),
    endpointIdEnv: 'RP_ENDPOINT_ID_VIDEO_ABSTRACT',
    gpuPoolId: 'AMPERE_48',
    gpuCount: 1,
    vramBudgetGb: 48,
    tasks: ['video.abstract'],
    // Vorgefertigter ComfyUI-Worker: kennt unseren `warmup`-Task nicht.
    warmupMode: 'endpoint',
    preload: [
      'ltx-video-13b',
      'controlnet-depth-video',
      'controlnet-canny-video',
      'ip-adapter-video',
      'rife-interpolation',
      'realesrgan-video-x4',
    ],
  },
  orchestrator: {
    role: 'orchestrator',
    label: 'AI-Orchestrator (MoA aus 3 Modellfamilien + MCP-Tools)',
    endpointName: endpointNameForRole('orchestrator'),
    endpointIdEnv: 'RP_ENDPOINT_ID_ORCHESTRATOR',
    gpuPoolId: 'AMPERE_48',
    gpuCount: 1,
    vramBudgetGb: 48,
    tasks: ['agent.orchestrate'],
    warmupMode: 'task',
    // MoA: EIN starkes + EIN schnelles Modell, beide native Qwen3 (Apache-2.0,
    // oeffentlich, kein Repo-Code): qwen3-4b schnell fuer Classifier und
    // Planner B, qwen3-8b stark fuer Planner A und Aggregator.
    // Preload-VRAM 25 GB bei 48 GB Budget (6 GB Sicherheitsabstand).
    // Muss exakt dem `preloadModels`-Satz der Rolle `orchestrator` im
    // Python-Manifest entsprechen (Drift-Test tests/manifestRoles.test.ts).
    preload: [
      'qwen3-4b',
      'qwen3-8b',
    ],
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
  // Visual-Rollen: FLUX.2/Wan/LTX brauchen pro Bild bzw. Clip deutlich mehr
  // Zeit als das runsync-Fenster zulaesst (Diffusion ueber viele Schritte).
  'image.generate',
  'video.generate',
  'video.abstract',
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

