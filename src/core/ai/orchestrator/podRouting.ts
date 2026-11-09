/**
 * audioMONASTRY – aktives RunPod-Routing: 7 KI-Pods auf NVIDIA A40 48 GB.
 * Achter Pod ist der dedizierte vis-Renderer, nicht Teil des AI-Job-Routings.
 * Pod-Modelle/SSOT: deploy/runpod/pod-fleet.json.
 */
import type { GpuRoleId } from '../../../config/aiInfrastructure';
import type { AiTask } from './types';

export const POD_ROLE_IDS = ['brain','ears','voice','music','studio','audio-brain','song'] as const;
export type PodRoleId = (typeof POD_ROLE_IDS)[number];

export type FleetMode = 'serverless' | 'pods';

export const POD_PORT = 8000;

function env(name: string): string {
  if (typeof process === 'undefined' || !process.env) return '';
  return (process.env[name] ?? '').trim();
}

/** Der freigegebene RunPod-Deploy setzt AI_FLEET_MODE=pods. Ohne Deploy-Env keine automatische Laufzeitmigration. */
export function fleetMode(): FleetMode {
  return env('AI_FLEET_MODE').toLowerCase() === 'pods' ? 'pods' : 'serverless';
}

/** Alle sieben KI-Pods sind beim Session-Start bereit; der achte visPod wird vom Flottenmanager angelegt. */
export type PodStartTrigger = 'always' | 'aiGeneration' | 'stemMONK';

export const POD_START_TRIGGERS: Readonly<Record<PodRoleId, PodStartTrigger>> = {
  "brain": 'always',
  "ears": 'always',
  "voice": 'always',
  "music": 'always',
  "studio": 'always',
  "audio-brain": 'always',
  "song": 'always',
};

/** Pods, die ein Trigger startet (in der Reihenfolge von POD_ROLE_IDS). */
export function podsForTrigger(trigger: PodStartTrigger): PodRoleId[] {
  return POD_ROLE_IDS.filter((pod) => POD_START_TRIGGERS[pod] === trigger);
}

/** Tasks, die als „AI-Generierung“ zählen (music.*, voice.*, song, tts, sfx). */
const GENERATION_TASKS: ReadonlySet<AiTask> = new Set<AiTask>(['tts', 'sing', 'song', 'audio.generate']);

export function isAiGenerationTask(task: AiTask | undefined): boolean {
  return task !== undefined && GENERATION_TASKS.has(task);
}

/**
 * LEGO-Modell (FLEET-P1-009): lego/extract/complete laufen nur mit dem
 * ACE-Step-Base-Modell, und das liegt auf dem voice-Pod. Spiegel von
 * `ACE_STEP_BASE_MODEL` in musicContextTools.ts (Test prüft Gleichheit).
 */
export const LEGO_BASE_MODEL = 'acestep-v15-xl-base';
export const LEGO_ACE_TASKS: readonly string[] = ['lego', 'extract', 'complete'];

function aceTaskOf(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const value = (input as { aceTask?: unknown }).aceTask;
  return typeof value === 'string' ? value : '';
}

/**
 * Ist das ein LEGO-Auftrag für den voice-Pod? `song` mit aceTask
 * lego/extract/complete oder mit dem Base-Modell. `repaint` bleibt auf dem
 * music-Pod, ebenso jeder song mit sft/turbo.
 */
export function isLegoJob(task: AiTask | undefined, model?: string, input?: unknown): boolean {
  if (task !== 'song') return false;
  const aceTask = aceTaskOf(input);
  if (aceTask === 'repaint') return false;
  if (LEGO_ACE_TASKS.includes(aceTask)) return true;
  return model === LEGO_BASE_MODEL;
}

/** Pod, der eine Aufgabe dieser GPU-Rolle ausführt (null = keine Instanz dafür). */
export function podRoleFor(role: GpuRoleId | 'studio' | 'audioBrain' | 'song', task?: AiTask, model?: string, input?: unknown): PodRoleId | null {
  switch (role) {
    case 'brain':
    case 'orchestrator':
      return 'brain';
    case 'ears':
      return 'ears';
    case 'voiceGen':
      return task === 'stem.separate' ? 'studio' : 'voice';
    case 'music':
      // ACE-Step xl-base/LEGO liegt auf voice; MiniMax Music3 auf song; alle anderen ACE-Step-Auftraege auf music.
      return isLegoJob(task, model, input) ? 'voice' : model === 'minimax-music3' ? 'song' : 'music';
    case 'studio':
      return 'studio';
    case 'audioBrain':
      return 'audio-brain';
    case 'song':
      return 'song';
    case 'audio-gen':
      return null;
    default:
      return null;
  }
}

/** Basis-URL eines Pods ('' = nicht konfiguriert). Nur https, kein Pfad-Anhang. */
export function podBaseUrl(pod: PodRoleId): string {
  const key = pod.toUpperCase().replace(/-/g, '_');
  const explicit = env(`RP_POD_URL_${key}`).replace(/\/+$/, '');
  if (explicit) return /^https:\/\//.test(explicit) ? explicit : '';
  const id = env(`RP_POD_ID_${key}`);
  return /^[a-z0-9]{6,40}$/i.test(id) ? `https://${id}-${POD_PORT}.proxy.runpod.net` : '';
}

/** Gemeinsames Geheimnis Server ↔ Pods (`AI_POD_TOKEN`, mindestens 32 Zeichen). */
export function podToken(): string {
  const token = env('AI_POD_TOKEN');
  return token.length >= 32 ? token : '';
}
