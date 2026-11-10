import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACTIVE_RUNPOD_POD_IDS, AI_RESIDENT_FLEET, AI_MAX_AI_EUR_PER_HOUR, AI_MAX_FLEET_EUR_PER_HOUR, residentVramGb } from '../src/config/aiInfrastructure';

const fleet = JSON.parse(readFileSync('deploy/runpod/pod-fleet.json', 'utf8'));
const manifest = JSON.parse(readFileSync('services/audiomonastry-ai-runtime/model_manifest.json', 'utf8'));
const pods = [...fleet.pods, fleet.visPod];

describe('Eight-role heterogeneous RunPod resident SSOT', () => {
  it('models all eight roles (7 AI plus vis)', () => {
    expect(fleet.visPod.enabled).toBe(true);
    expect(AI_RESIDENT_FLEET.map(x => x.id)).toEqual([...ACTIVE_RUNPOD_POD_IDS]);
    expect(pods.map((p: any) => p.role)).toEqual([...ACTIVE_RUNPOD_POD_IDS]);
    expect(fleet.visPod.models).toEqual(['universr','mel-roformer-dereverb']);
  });

  it('takes each role model footprint exclusively from the manifest', () => {
    const models = new Map<string, number>(manifest.models.map((m: any) => [m.id, m.estimatedVRAM]));
    for (const pod of pods) {
      const instance = AI_RESIDENT_FLEET.find(x => x.id === pod.role)!;
      const expectedModelGb = pod.models.reduce((sum: number,id:string) => sum + models.get(id)!, 0);
      expect(residentVramGb(instance), pod.role).toBe(expectedModelGb);
      const gpu = fleet.gpuPools[pod.gpuPool].find((g:any) => g.id === pod.gpuPoolId);
      expect(expectedModelGb + pod.vramReserveGb + pod.vramSafetyMarginGb).toBeLessThanOrEqual(gpu.vramGb);
    }
  });

  it('uses the SSOT hard hourly budget, not retired 5/6/10 EUR limits', () => {
    expect(fleet.budget.maxEurPerHour).toBe(8);
    expect(AI_MAX_FLEET_EUR_PER_HOUR).toBe(8);
    expect(AI_MAX_AI_EUR_PER_HOUR).toBe(8);
    expect(fleet.budget.allowedGpus).toContain('NVIDIA RTX PRO 6000 Blackwell Server Edition');
  });
});
