import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AI_RESIDENT_FLEET, AI_MAX_AI_EUR_PER_HOUR, RESIDENT_USABLE_VRAM_GB, residentVramGb } from '../src/config/aiInfrastructure';

const fleet = JSON.parse(readFileSync('deploy/runpod/pod-fleet.json', 'utf8'));
const manifest = JSON.parse(readFileSync('services/audiomonastry-ai-runtime/model_manifest.json', 'utf8'));

describe('8xA40-SSOT: residente Modell- und Gewichtsverteilung', () => {
  it('enthaelt genau sieben KI-Pods und einen aktivierten Visual-Pod', () => {
    expect(AI_RESIDENT_FLEET.length).toBe(7);
    expect(fleet.visPod.enabled).toBe(true);
    expect(fleet.visPod.models).toEqual(['music-flamingo']);
  });
  it('erzwingt 42GB Planungsgrenze mit 6GB Reserve', () => {
    expect(RESIDENT_USABLE_VRAM_GB).toBe(42);
    expect(manifest.runtime.vramBudgetGb - manifest.runtime.vramSafetyMarginGb).toBe(42);
    for (const p of AI_RESIDENT_FLEET) expect(residentVramGb(p), p.id).toBeLessThanOrEqual(42);
    expect(Object.fromEntries(AI_RESIDENT_FLEET.map(p => [p.id, residentVramGb(p)]))).toEqual({
      brain: 29, ears: 26, voice: 39, music: 37, studio: 36, 'audio-brain': 28, song: 27,
    });
  });
  it('prueft GPU-Klasse und Stundenbudget gegen Manifest', () => {
    expect(AI_MAX_AI_EUR_PER_HOUR).toBe(6);
    expect(fleet.budget.allowedGpus).toEqual(['NVIDIA A40']);
    expect(fleet.pods.length + Number(fleet.visPod.enabled)).toBe(8);
  });
});
