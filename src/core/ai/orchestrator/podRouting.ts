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
 *   music               → music
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

/** Pod, der eine Aufgabe dieser GPU-Rolle ausführt (null = keine Instanz dafür). */
export function podRoleFor(role: GpuRoleId, task?: AiTask): PodRoleId | null {
  switch (role) {
    case 'brain':
    case 'orchestrator':
      return 'brain';
    case 'ears':
      return 'ears';
    case 'voiceGen':
      return task === 'stem.separate' ? 'stems' : 'voice';
    case 'music':
      return 'music';
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
