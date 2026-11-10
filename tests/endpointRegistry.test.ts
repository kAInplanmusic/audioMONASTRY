import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  GPU_ROLES,
  GPU_ROLE_LIST,
  LONG_RUNNING_TASKS,
  requireRoleForTask,
  roleForTask,
  resolveGpuRoles,
} from '../src/core/ai/orchestrator/endpointRegistry';
import type { AiTask } from '../src/core/ai/orchestrator/types';

//: Muss exakt der `AiTask`-Union in `types.ts` entsprechen – die Registry muss
//: jeden Task genau einmal abdecken (disjunkte Task-Mengen).
const ALL_TASKS: AiTask[] = [
  'llm', 'tts', 'sing', 'song', 'stem.separate', 'audio.classify', 'audio.transcribe',
  'audio.embed', 'audio.analyze', 'audio.diarize', 'audio.understand', 'audio.generate',
  'multimodal', 'nlu',
  // 8-Instanzen-Architektur: Visuals + Orchestrator sind eigene Task-Klassen.
  'image.generate', 'video.generate', 'video.abstract', 'agent.orchestrate',
];

const ENDPOINT_ENV_KEYS = [
  'RP_ENDPOINT_ID',
  'RP_ENDPOINT_ID_BRAIN',
  'RP_ENDPOINT_ID_EARS',
  'RP_ENDPOINT_ID_VOICE',
  'RP_ENDPOINT_ID_MUSIC',
  'RP_ENDPOINT_ID_IMAGE',
  'RP_ENDPOINT_ID_VIDEO_REAL',
  'RP_ENDPOINT_ID_VIDEO_ABSTRACT',
  'RP_ENDPOINT_ID_ORCHESTRATOR',
  'RUNPOD_ENDPOINT_ID',
  'RUNPOD_ENDPOINT_ID_BRAIN',
  'RUNPOD_ENDPOINT_ID_EARS',
  'RUNPOD_ENDPOINT_ID_VOICE',
  'RUNPOD_ENDPOINT_ID_MUSIC',
  'RUNPOD_ENDPOINT_ID_IMAGE',
  'RUNPOD_ENDPOINT_ID_VIDEO_REAL',
  'RUNPOD_ENDPOINT_ID_VIDEO_ABSTRACT',
  'RUNPOD_ENDPOINT_ID_ORCHESTRATOR',
] as const;

type EndpointEnvKey = (typeof ENDPOINT_ENV_KEYS)[number];

/** Setzt Endpoint-Env für einen Test und stellt sie danach exakt wieder her. */
function withEndpointEnv(values: Partial<Record<EndpointEnvKey, string>>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of ENDPOINT_ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('GPU-Rollen-Registry', () => {
  it('deckt jeden bekannten Task genau einmal ab (disjunkte Task-Mengen)', () => {
    const seen = new Map<AiTask, string>();
    for (const role of GPU_ROLE_LIST) {
      for (const task of role.tasks) {
        expect(seen.has(task), `Task ${task} doppelt: ${seen.get(task)} und ${role.role}`).toBe(false);
        seen.set(task, role.role);
      }
    }
    expect([...seen.keys()].sort()).toEqual([...ALL_TASKS].sort());
  });

  it('ordnet die Tasks den richtigen Rollen zu', () => {
    expect(roleForTask('llm')).toBe('brain');
    expect(roleForTask('nlu')).toBe('brain');
    expect(roleForTask('audio.transcribe')).toBe('ears');
    expect(roleForTask('audio.understand')).toBe('ears');
    expect(roleForTask('tts')).toBe('voiceGen');
    expect(roleForTask('stem.separate')).toBe('voiceGen');
    // 8-Instanzen-Architektur: `song`/`sing` gehören der Musik-Instanz (ACE-Step),
    // `image.generate`/`video.*`/`agent.orchestrate` haben eigene Rollen.
    expect(roleForTask('song')).toBe('music');
    expect(roleForTask('sing')).toBe('music');
    expect(roleForTask('image.generate')).toBe('imageHq');
    expect(roleForTask('video.generate')).toBe('videoReal');
    expect(roleForTask('video.abstract')).toBe('videoAbstract');
    expect(roleForTask('agent.orchestrate')).toBe('orchestrator');
  });

  it('gleicht nur aktive Serverless-API-Adapter mit der Acht-Pod-SSOT ab', () => {
    // GPU_ROLES is a historical API namespace, not the active eight-Pod inventory.
    const fleet = JSON.parse(readFileSync('deploy/runpod/pod-fleet.json', 'utf8'));
    const activeMap: Record<string,string> = {brain:'brain',ears:'ears',voiceGen:'voice',music:'music'};
    for (const [legacy, current] of Object.entries(activeMap)) {
      const pod = fleet.pods.find((p: any) => p.role === current);
      const role = GPU_ROLES[legacy as keyof typeof GPU_ROLES];
      expect(role.gpuId, current).toBe(pod.gpuPoolId);
      expect(role.gpuCount, current).toBe(1);
      expect(role.preload, current).toEqual(pod.models.filter((id: string) => id !== 'dsp-analysis' && id !== 'basic-pitch'));
    }
    // These are API compatibility roles; do not launch them as physical Pods.
    for (const legacy of ['imageHq','videoReal','videoAbstract','orchestrator']) {
      expect(fleet.retiredRoles.includes(legacy) || !fleet.pods.some((p:any)=>p.role===legacy)).toBe(true);
    }
  });

  it('markiert die langlaufenden Jobs (llm wegen Kaltstart-Ladezeit)', () => {
    expect([...LONG_RUNNING_TASKS].sort()).toEqual(
      ['audio.generate', 'llm', 'sing', 'song', 'stem.separate', 'image.generate', 'video.generate', 'video.abstract'].sort(),
    );
    expect(LONG_RUNNING_TASKS.has('llm')).toBe(true);
    expect(LONG_RUNNING_TASKS.has('audio.transcribe')).toBe(false);
  });

  it('wirft für Tasks ohne Rolle', () => {
    expect(() => requireRoleForTask('unbekannt' as AiTask)).toThrow(/kein GPU-Rollen-Endpoint/);
  });

  it('fällt ohne Rollen-ID auf RP_ENDPOINT_ID zurück (Legacy-Modus)', () => {
    withEndpointEnv({ RP_ENDPOINT_ID: 'legacy-endpoint' }, () => {
      const roles = resolveGpuRoles();
      expect(roles).toHaveLength(GPU_ROLE_LIST.length);
      for (const role of roles) {
        expect(role.endpointId).toBe('legacy-endpoint');
        expect(role.usingLegacyEndpoint).toBe(true);
      }
    });
  });

  it('bevorzugt die rollenspezifische Endpoint-ID', () => {
    withEndpointEnv(
      { RP_ENDPOINT_ID: 'legacy-endpoint', RP_ENDPOINT_ID_BRAIN: 'brain-endpoint' },
      () => {
        const roles = resolveGpuRoles();
        const brain = roles.find((r) => r.role === 'brain');
        const ears = roles.find((r) => r.role === 'ears');
        expect(brain?.endpointId).toBe('brain-endpoint');
        expect(brain?.usingLegacyEndpoint).toBe(false);
        expect(ears?.endpointId).toBe('legacy-endpoint');
        expect(ears?.usingLegacyEndpoint).toBe(true);
      },
    );
  });
});
