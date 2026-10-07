import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AI_MAX_AI_EUR_PER_HOUR,
  AI_RESIDENT_FLEET,
  GPU_ROLE_IDS,
  RESIDENT_USABLE_VRAM_GB,
  assertResidentFleetBudget,
  estimateResidentFleetEurPerHour,
  residentVramGb,
} from '../src/config/aiInfrastructure';

interface ManifestModel { id: string; estimatedVRAM: number; exclusiveGroup?: string }
const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../services/audiomonastry-ai-runtime/model_manifest.json', import.meta.url)), 'utf8'),
) as { runtime: { vramBudgetGb: number; vramSafetyMarginGb: number }; models: ManifestModel[] };
const byId = new Map(manifest.models.map((m) => [m.id, m]));
const all = AI_RESIDENT_FLEET.flatMap((i) => [...i.models]);

describe('Residente 6×48-GB-Flotte (SSOT 2026-10-07)', () => {
  it('hat 6 Instanzen und deckt jede der 8 bestehenden Rollen genau einmal ab', () => {
    expect(AI_RESIDENT_FLEET).toHaveLength(6);
    expect(AI_RESIDENT_FLEET.flatMap((i) => [...i.covers]).sort()).toEqual([...GPU_ROLE_IDS].sort());
  });

  it('nutzt dieselbe Nutzgrenze wie das Manifest (48 GB − Marge)', () => {
    expect(RESIDENT_USABLE_VRAM_GB).toBe(manifest.runtime.vramBudgetGb - manifest.runtime.vramSafetyMarginGb);
  });

  it('lädt kein Modell doppelt', () => {
    expect(new Set(all.map((m) => m.id)).size).toBe(all.length);
  });

  it('passt je Instanz komplett resident in den nutzbaren VRAM', () => {
    for (const inst of AI_RESIDENT_FLEET) {
      expect(residentVramGb(inst), `${inst.id}`).toBeLessThanOrEqual(RESIDENT_USABLE_VRAM_GB);
    }
  });

  it('Manifest-Modelle: Schätzung stimmt mit dem Manifest überein, keine exclusiveGroup (kein Verdrängen)', () => {
    for (const m of all.filter((x) => x.status === 'manifest')) {
      const mf = byId.get(m.id);
      expect(mf, `${m.id} fehlt im Manifest`).toBeDefined();
      expect(m.vramGb, m.id).toBe(mf!.estimatedVRAM);
      expect(mf!.exclusiveGroup, m.id).toBeUndefined();
    }
  });

  it('neue Modelle stehen noch nicht im Manifest (Revision-Pin offen) – sonst Status auf manifest setzen', () => {
    for (const m of all.filter((x) => x.status === 'neu')) expect(byId.has(m.id), m.id).toBe(false);
  });

  it('enthält keine Nicht-kommerziell-Lizenz; Lizenz-Vorbehalte sind bewusst gelistet', () => {
    for (const m of all) expect(m.license, m.id).not.toMatch(/non-commercial|CC-BY-NC|research/i);
    expect(all.filter((m) => 'licenseCheck' in m && m.licenseCheck).map((m) => m.id).sort()).toEqual(
      ['essentia', 'ltx-2.3-22b-distilled', 'pyannote-diarization', 'stable-audio-open-1.0'],
    );
  });

  it('bleibt mit Pods (A40/A6000) unter dem AI-Budget von 4 €/h', () => {
    expect(AI_MAX_AI_EUR_PER_HOUR).toBe(4);
    expect(() => assertResidentFleetBudget('pod', 'A40')).not.toThrow();
    expect(() => assertResidentFleetBudget('pod', 'A6000')).not.toThrow();
    expect(estimateResidentFleetEurPerHour('pod', 'A6000')).toBeCloseTo(2.93, 2);
  });

  it('sprengt das Budget als Serverless-Flex – die 0,50-€-Annahme gilt nur für Pods', () => {
    expect(() => assertResidentFleetBudget('serverlessFlex', 'A6000')).toThrow(/4 €\/h/);
    expect(estimateResidentFleetEurPerHour('serverlessFlex', 'A6000')).toBeCloseTo(6.73, 2);
  });
});
