import { describe, expect, it } from 'vitest';
import {
  GPU_ROLES,
  GPU_ROLE_LIST,
  LONG_RUNNING_TASKS,
  requireRoleForTask,
  roleForTask,
  resolveGpuRoles,
} from '../src/core/ai/orchestrator/endpointRegistry';
import type { AiTask } from '../src/core/ai/orchestrator/types';

const ALL_TASKS: AiTask[] = [
  'llm', 'tts', 'sing', 'song', 'stem.separate', 'audio.classify', 'audio.transcribe',
  'audio.embed', 'audio.analyze', 'audio.diarize', 'audio.understand', 'audio.generate',
  'multimodal', 'nlu',
];

const ENDPOINT_ENV_KEYS = [
  'RUNPOD_ENDPOINT_ID',
  'RUNPOD_ENDPOINT_ID_BRAIN',
  'RUNPOD_ENDPOINT_ID_EARS',
  'RUNPOD_ENDPOINT_ID_VOICE',
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
    expect(roleForTask('song')).toBe('voiceGen');
    expect(roleForTask('stem.separate')).toBe('voiceGen');
  });

  it('weist jeder Rolle ein VRAM-Budget und eine GPU-Pool-ID zu', () => {
    for (const role of GPU_ROLE_LIST) {
      expect(role.vramBudgetGb).toBeGreaterThan(0);
      expect(role.gpuPoolId).toMatch(/^[A-Z0-9_]+$/);
      expect(role.endpointIdEnv).toMatch(/^RUNPOD_ENDPOINT_ID_/);
      expect(role.preload.length).toBeGreaterThan(0);
    }
    // ears und voiceGen brauchen 48 GB (resident + on-demand bzw. ACE-Step + Stems).
    expect(GPU_ROLES.ears.vramBudgetGb).toBe(48);
    expect(GPU_ROLES.voiceGen.vramBudgetGb).toBe(48);
  });

  it('markiert nur die langen Jobs als langlaufend', () => {
    expect([...LONG_RUNNING_TASKS].sort()).toEqual(
      ['audio.generate', 'sing', 'song', 'stem.separate'].sort(),
    );
    expect(LONG_RUNNING_TASKS.has('llm')).toBe(false);
    expect(LONG_RUNNING_TASKS.has('audio.transcribe')).toBe(false);
  });

  it('wirft für Tasks ohne Rolle', () => {
    expect(() => requireRoleForTask('unbekannt' as AiTask)).toThrow(/kein GPU-Rollen-Endpoint/);
  });

  it('fällt ohne Rollen-ID auf RUNPOD_ENDPOINT_ID zurück (Legacy-Modus)', () => {
    withEndpointEnv({ RUNPOD_ENDPOINT_ID: 'legacy-endpoint' }, () => {
      const roles = resolveGpuRoles();
      expect(roles).toHaveLength(3);
      for (const role of roles) {
        expect(role.endpointId).toBe('legacy-endpoint');
        expect(role.usingLegacyEndpoint).toBe(true);
      }
    });
  });

  it('bevorzugt die rollenspezifische Endpoint-ID', () => {
    withEndpointEnv(
      { RUNPOD_ENDPOINT_ID: 'legacy-endpoint', RUNPOD_ENDPOINT_ID_BRAIN: 'brain-endpoint' },
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
