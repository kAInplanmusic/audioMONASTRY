import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AI_RESIDENT_FLEET, AI_MAX_AI_EUR_PER_HOUR, RESIDENT_USABLE_VRAM_GB, residentVramGb } from '../src/config/aiInfrastructure';

const fleet = JSON.parse(readFileSync('deploy/runpod/pod-fleet.json', 'utf8'));
const manifest = JSON.parse(readFileSync('services/audiomonastry-ai-runtime/model_manifest.json', 'utf8'));

describe('Canonical eight-role resident fleet', () => {
  it('lists exactly the selected model IDs and roles', () => {
    const pods = [...fleet.pods, fleet.visPod];
    expect(AI_RESIDENT_FLEET.map(p => p.id)).toEqual(pods.map(p => p.role));
    for (const p of AI_RESIDENT_FLEET) {
      expect(p.models.map(m => m.id)).toEqual(pods.find(x => x.role === p.id).models);
    }
    expect(new Set(AI_RESIDENT_FLEET.flatMap(p => p.models.map(m => m.id))).size).toBe(22);
  });
  it('fits each actual GPU class including the 96-GB studio', () => {
    expect(RESIDENT_USABLE_VRAM_GB).toBe(42);
    for (const p of AI_RESIDENT_FLEET) {
      const pod = [...fleet.pods, fleet.visPod].find(x => x.role === p.id);
      const gpu = fleet.gpuPools[pod.gpuPool].find((g: any) => g.id === pod.gpuPoolId);
      expect(residentVramGb(p)).toBeLessThanOrEqual(gpu.vramGb-pod.vramSafetyMarginGb);
    }
  });
  it('uses the eight-euro whole-fleet cap', () => {
    expect(AI_MAX_AI_EUR_PER_HOUR).toBe(fleet.budget.maxEurPerHour);
    expect(fleet.pods.length + Number(fleet.visPod.enabled)).toBe(8);
    expect(manifest.models.length).toBe(22);
  });
});
