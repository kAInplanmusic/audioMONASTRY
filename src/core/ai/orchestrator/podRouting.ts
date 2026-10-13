/**
 * audioMONASTRY · Pod-Routing (Betreiber 2026-10-07: Pods statt Serverless)
 * =======================================================================
 * Mit `AI_FLEET_MODE=pods` laufen die AI-Rollen auf fünf dauerhaft geladenen
 * RunPod-Pods (deploy/runpod/pod-fleet.json). Die Pods sprechen dieselben Pfade
 * wie Serverless (`/runsync`, `/run`, `/status/{id}`), deshalb tauscht der
 * Provider nur Basis-URL und Token.
 *
 * Zuordnung GPU-Rolle → Pod:
 *   brain, orchestrator → brain   (ein Pod, `AI_ROLE=brain+orchestrator`)
 *   ears                → ears
 *   voiceGen            → voice, Stem-Trennung → stems (eigener Pod)
 *   music               → music; LEGO/extract/complete (acestep-v15-xl-base)
 *                         → voice (FLEET-P1-009, xl-base liegt auf RP4)
 *   imageHq, videoReal, videoAbstract → keiner (keine Visual-Generierung)
 *
 * Pod-Adresse je Rolle: `RP_POD_URL_<ROLLE>` oder `RP_POD_ID_<ROLLE>`
 * (→ https://<id>-8000.proxy.runpod.net). Ausgegeben von `scripts/runpod-pods.py up`.
 */
import type { GpuRoleId } from '../../../config/aiInfrastructure';
import type { AiTask } from './types';

export const POD_ROLE_IDS = ['brain', 'ears', 'voice', 'stems', 'music'] as const;
export type PodRoleId = (typeof POD_ROLE_IDS)[number];

export type FleetMode = 'serverless' | 'pods';

export const POD_PORT = 8000;

function env(name: string): string {
  if (typeof process === 'undefined' || !process.env) return '';
  return (process.env[name] ?? '').trim();
}

/** Betriebsart der Flotte; Standard bleibt Serverless, bis umgeschaltet wird. */
export function fleetMode(): FleetMode {
  return env('AI_FLEET_MODE').toLowerCase() === 'pods' ? 'pods' : 'serverless';
}

/**
 * Start-Trigger je Pod (Betreiber 2026-10-12, docs/AI_FLEET_STARTPLAN.md).
 * Quelle ist `startTrigger` in deploy/runpod/pod-fleet.json; diese Tabelle ist
 * ihr Spiegel (Drift-Test: tests/podStartTriggers.test.ts).
 *   always       RP1 brain, RP2 ears: beim Session-Start
 *   aiGeneration RP3 music, RP4 voice: bei der ersten AI-Generierung
 *   stemMONK     RP5 stems: wenn der stemMONK gestartet wird (Modus nicht OFF)
 */
export type PodStartTrigger = 'always' | 'aiGeneration' | 'stemMONK';

export const POD_START_TRIGGERS: Readonly<Record<PodRoleId, PodStartTrigger>> = {
  brain: 'always',
  ears: 'always',
  voice: 'aiGeneration',
  stems: 'stemMONK',
  music: 'aiGeneration',
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
 * ACE-Step-Base-Modell, und das liegt auf RP4 voice. Spiegel von
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
 * music-Pod (LM-Planer auf RP3), ebenso jeder song mit sft/turbo.
 */
export function isLegoJob(task: AiTask | undefined, model?: string, input?: unknown): boolean {
  if (task !== 'song') return false;
  const aceTask = aceTaskOf(input);
  if (aceTask === 'repaint') return false;
  if (LEGO_ACE_TASKS.includes(aceTask)) return true;
  return model === LEGO_BASE_MODEL;
}

/** Pod, der eine Aufgabe dieser GPU-Rolle ausführt (null = keine Instanz dafür). */
export function podRoleFor(role: GpuRoleId, task?: AiTask, model?: string, input?: unknown): PodRoleId | null {
  switch (role) {
    case 'brain':
    case 'orchestrator':
      return 'brain';
    case 'ears':
      return 'ears';
    case 'voiceGen':
      return task === 'stem.separate' ? 'stems' : 'voice';
    case 'music':
      // FLEET-P1-009: xl-base (LEGO) liegt auf RP4 voice, nicht auf RP3 music.
      return isLegoJob(task, model, input) ? 'voice' : 'music';
    default:
      return null;
  }
}

/** Basis-URL eines Pods ('' = nicht konfiguriert). Nur https, kein Pfad-Anhang. */
export function podBaseUrl(pod: PodRoleId): string {
  const key = pod.toUpperCase();
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
