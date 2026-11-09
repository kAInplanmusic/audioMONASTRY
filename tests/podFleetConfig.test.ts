import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AI_RESIDENT_FLEET, residentVramGb } from '../src/config/aiInfrastructure';

const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const fleet = read('deploy/runpod/pod-fleet.json');
const manifest = read('services/audiomonastry-ai-runtime/model_manifest.json');
const models = new Map<string, { estimatedVRAM: number; revision: string; status?: string }>(manifest.models.map((m: any) => [m.id, m]));
const roles = ['brain', 'ears', 'voice', 'music', 'studio', 'audio-brain', 'song'];

describe('RunPod SSOT: 7 AI + vis, A40 48GB', () => {
  it('konfiguriert genau acht Pods, ohne andere GPU-Typen oder Modellkonfigurationen', () => {
    expect(fleet.pods.map((p: any) => p.role)).toEqual(roles);
    expect(fleet.visPod.enabled).toBe(true);
    expect(fleet.visPod.role).toBe('vis');
    expect(fleet.gpuPools).toEqual({ '48gb': [{ id: 'NVIDIA A40', usdPerHour: 0.35 }] });
    expect(fleet.budget.allowedGpus).toEqual(['NVIDIA A40']);
    expect([...fleet.pods, fleet.visPod].every((p: any) => p.gpuPoolId === 'NVIDIA A40' && p.gpuPool === '48gb')).toBe(true);
    expect(fleet.activation).toBeUndefined();
  });
  it('die Modellgewichte sind gepinnt, resident und unter 42GB inklusive Cache', () => {
    expect(manifest.runtime.vramBudgetGb - manifest.runtime.vramSafetyMarginGb).toBe(42);
    for (const p of fleet.pods) {
      expect(p.startTrigger).toBe('always');
      expect(p.target).toBeUndefined();
      expect(new Set(p.models).size).toBe(p.models.length);
      for (const id of p.models) {
        const m = models.get(id);
        expect(m, id).toBeDefined();
        expect(m!.status, id).not.toBe('neu');
        expect(m!.revision, id).toMatch(/^[a-f0-9]{40}$|^cpu-cache$/);
        expect(p.aiRole.split('+').some((r: string) => manifest.roles[r]?.models.includes(id)), id).toBe(true);
      }
      const weight = p.models.reduce((sum: number, id: string) => sum + models.get(id)!.estimatedVRAM, 0);
      const extra = p.role === 'music' ? 6 : 0;
      expect(weight + extra, p.role).toBeLessThanOrEqual(42);
      expect(residentVramGb(AI_RESIDENT_FLEET.find(i => i.id === p.role)!), p.role).toBe(weight + extra);
    }
    expect(fleet.visPod.models).toEqual(['music-flamingo']);
        expect(manifest.roles.vis.preloadModels).toEqual(['music-flamingo']);
        expect(manifest.roles.song.preloadModels).toEqual(['minimax-music3']);
        expect(fleet.visPod.estimatedVRAM + models.get('music-flamingo')!.estimatedVRAM).toBeLessThanOrEqual(42);
    expect(AI_RESIDENT_FLEET.map(i => i.id)).toEqual(roles);
  });
});
