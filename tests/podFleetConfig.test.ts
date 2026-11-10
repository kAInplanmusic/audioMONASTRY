import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const fleet = json('deploy/runpod/pod-fleet.json');
const manifest = json('services/audiomonastry-ai-runtime/model_manifest.json');
const pods = [...fleet.pods, fleet.visPod];
const expectedRoles = ['brain', 'ears', 'voice', 'music', 'studio', 'audio-brain', 'song', 'vis'];
const byId = new Map<string, any>(manifest.models.map((m: any) => [m.id, m]));

describe('RunPod production SSOT 2026-11-10', () => {
  it('declares precisely eight active roles in canonical order', () => {
    expect(pods.map((p: any) => p.role)).toEqual(expectedRoles);
    expect(fleet.visPod.enabled).toBe(true);
    expect(new Set(pods.map((p: any) => p.aiRole)).size).toBe(8);
    expect(fleet.deploymentStatus).toBe('PLANNED_NOT_GPU_VERIFIED');
  });

  it('enforces the hard fleet-wide budget with tax and reserve', () => {
    expect(fleet.budget.maxEurPerHour).toBe(8);
    const totalUsd = pods.reduce((sum: number, p: any) => {
      const gpu = fleet.gpuPools[p.gpuPool].find((g: any) => g.id === p.gpuPoolId);
      expect(gpu, p.role).toBeDefined();
      return sum + gpu.usdPerHour;
    }, 0);
    const gross = totalUsd * fleet.budget.usdToEur *
      fleet.budget.taxMultiplier + fleet.budget.unbilledEurPerHourReserve;
    expect(gross).toBeLessThanOrEqual(8);
  });

  it('maps exact model membership, GPU metadata and tasks for each active role', () => {
    for (const pod of pods) {
      const role = manifest.roles[pod.aiRole];
      expect(role, pod.role).toBeDefined();
      expect(role.models, pod.role).toEqual(pod.models);
      expect(role.gpuId, pod.role).toBe(pod.gpuPoolId);
      expect(pod.gpuPriority[0], pod.role).toBe(pod.gpuPoolId);
      for (const candidate of pod.gpuPriority) {
        expect(fleet.budget.allowedGpus, candidate).toContain(candidate);
        const gpu = fleet.gpuPools[pod.gpuPool].find((g: any) => g.id === candidate);
        expect(gpu, candidate).toBeDefined();
        const modelGb = pod.models.reduce((sum: number, id: string) =>
          sum + byId.get(id)!.estimatedVRAM, 0);
        const reserveGb = pod.vramReserveGb + pod.vramSafetyMarginGb;
        expect(modelGb + reserveGb, `${pod.role} / ${candidate}`).toBeLessThanOrEqual(gpu.vramGb);
      }
      expect(new Set(pod.models).size).toBe(pod.models.length);
      for (const id of pod.models) {
        const m = byId.get(id);
        expect(m, id).toBeDefined();
        expect(m.repository, id).toBeTruthy();
        expect(m.task, id).toBeTruthy();
        expect(m.framework, id).toBeTruthy();
        // Explicitly track the known partial BVE commit; it is NOT GPU-ready.
        if (id === 'mel-roformer-bve') {
          expect(m.revision).toBe('c73a679a87e568133b7e7387f58c9d3186a51ad4');
        } else {
          expect(m.revision, id).toMatch(/^[a-f0-9]{40}$|^cpu-only$/);
        }
      }
    }
  });

  it('does not silently reintroduce retired roles or music-flamingo', () => {
    for (const p of pods) {
      expect(fleet.retiredRoles).not.toContain(p.role);
      expect(p.models).not.toContain('music-flamingo');
    }
    expect(fleet.visPod.models).toEqual(['universr', 'mel-roformer-dereverb']);
  });
});
