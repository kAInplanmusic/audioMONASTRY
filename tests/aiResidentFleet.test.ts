import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AI_MAX_AI_EUR_PER_HOUR,
  AI_RESIDENT_FLEET,
  AI_RESIDENT_SHARED_MODELS,
  AI_RETIRED_VISUAL_ROLES,
  GPU_ROLE_IDS,
  RESIDENT_USABLE_VRAM_GB,
  assertResidentFleetBudget,
  estimateResidentFleetEurPerHour,
  residentVramGb,
} from '../src/config/aiInfrastructure';

interface ManifestModel { id: string; estimatedVRAM: number; exclusiveGroup?: string; status?: string; revision: string }
const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../services/audiomonastry-ai-runtime/model_manifest.json', import.meta.url)), 'utf8'),
) as { runtime: { vramBudgetGb: number; vramSafetyMarginGb: number }; models: ManifestModel[] };
const byId = new Map(manifest.models.map((m) => [m.id, m]));
const all = AI_RESIDENT_FLEET.flatMap((i) => [...i.models]);

describe('Residente 6×48-GB-Flotte (SSOT 2026-10-07)', () => {
  it('hat 5 Instanzen (max. 6), deckt alle Nicht-Visual-Rollen genau einmal ab, Visuals haben keine GPU', () => {
    expect(AI_RESIDENT_FLEET.map((i) => i.id)).toEqual(['brain', 'ears', 'voice', 'stems', 'music']);
    expect(AI_RESIDENT_FLEET.length).toBeLessThanOrEqual(6);
    const covered = AI_RESIDENT_FLEET.flatMap((i) => [...i.covers]);
    expect(new Set(covered).size).toBe(covered.length);
    expect([...covered, ...AI_RETIRED_VISUAL_ROLES].sort()).toEqual([...GPU_ROLE_IDS].sort());
  });

  it('enthält kein Bild-/Video-Generierungsmodell', () => {
    const forbidden = /flux|qwen-image|sdxl|stable-diffusion|wan2|ltx|hunyuan|video|controlnet|ip-adapter|esrgan|rife/i;
    for (const m of all) expect(m.id, m.id).not.toMatch(forbidden);
  });

  it('nutzt dieselbe Nutzgrenze wie das Manifest (48 GB − Marge)', () => {
    expect(RESIDENT_USABLE_VRAM_GB).toBe(manifest.runtime.vramBudgetGb - manifest.runtime.vramSafetyMarginGb);
  });

  it('lädt kein Modell doppelt in einer Instanz; mehrfach nur die bewusst geteilten', () => {
    for (const inst of AI_RESIDENT_FLEET) {
      const ids = inst.models.map((m) => m.id);
      expect(new Set(ids).size, inst.id).toBe(ids.length);
    }
    const counts = new Map<string, number>();
    for (const m of all) counts.set(m.id, (counts.get(m.id) ?? 0) + 1);
    const shared = [...counts].filter(([, n]) => n > 1).map(([id]) => id).sort();
    expect(shared).toEqual([...AI_RESIDENT_SHARED_MODELS].sort());
  });

  it('geteilte Modelle haben auf jeder Instanz dieselbe Schätzung und Lizenz', () => {
    for (const id of AI_RESIDENT_SHARED_MODELS) {
      const variants = all.filter((m) => m.id === id);
      expect(new Set(variants.map((m) => `${m.vramGb}|${m.license}|${m.status}`)).size, id).toBe(1);
    }
  });

  it('Betreiber-Entscheid 2026-10-12: Summen je Pod (Schätzung) und Ausschlüsse', () => {
    const sum = Object.fromEntries(AI_RESIDENT_FLEET.map((i) => [i.id, residentVramGb(i)]));
    expect(sum).toEqual({ brain: 36, ears: 40, voice: 39, stems: 16, music: 37 });
    const ids = new Set<string>(all.map((m) => m.id));
    for (const gone of ['bark-small', 'stable-audio-3-medium', 'stable-audio-open-1.0', 'htdemucs-6s', 'whisper-large-v3', 'qwen2-audio-7b', 'pyannote-diarization', 'moss-audio-8b-thinking']) {
      expect(ids.has(gone), gone).toBe(false);
    }
    // xl-base (LEGO) liegt auf RP4 voice, nicht auf RP3 music.
    const at = (id: string) => AI_RESIDENT_FLEET.filter((i) => i.models.some((m) => m.id === id)).map((i) => i.id);
    expect(at('acestep-v15-xl-base')).toEqual(['voice']);
    expect(at('beat-this')).toEqual(['ears', 'stems']);
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

  it('neue Modelle (ohne Handler) stehen mit status "neu" und gleicher Schätzung im Manifest – außer RP1 (unverändert)', () => {
    // Betreiber-Entscheid 2026-10-12: Revision per HF-API gepinnt oder PIN-ERFORDERLICH;
    // der Eintrag steht in keiner Rolle und wird erst mit seinem Handler geladen.
    const notInManifest = ['qwen3.6-35b-a3b-fp8'];
    for (const m of all.filter((x) => x.status === 'neu')) {
      const mf = byId.get(m.id);
      if (notInManifest.includes(m.id)) {
        expect(mf, `${m.id}: RP1-Zielmodell steht nicht im Manifest (Widerspruch dokumentiert)`).toBeUndefined();
        continue;
      }
      expect(mf, `${m.id} fehlt im Manifest`).toBeDefined();
      expect(mf!.status, m.id).toBe('neu');
      expect(m.vramGb, m.id).toBe(mf!.estimatedVRAM);
    }
  });

  it('Manifest-Modelle mit status "neu" sind alle im Zielbild eingeplant', () => {
    const planned = new Set<string>(all.map((m) => m.id));
    for (const mf of manifest.models.filter((x) => x.status === 'neu')) expect(planned.has(mf.id), mf.id).toBe(true);
  });

  it('Nicht-kommerzielle Modelle sind bewusst markiert (Forschung/privat), alle anderen frei nutzbar', () => {
    const isNc = (license: string) => /non-commercial|nicht kommerziell|CC-BY-NC/i.test(license);
    for (const m of all) expect('nonCommercial' in m && m.nonCommercial === true, m.id).toBe(isNc(m.license));
    expect(all.filter((m) => 'nonCommercial' in m && m.nonCommercial).map((m) => m.id).sort()).toEqual(
      ['mert-v1-330m'],
    );
  });

  it('Lizenz-Vorbehalte (Gating/AGPL) sind bewusst gelistet', () => {
    const flagged = [...new Set(all.filter((m) => 'licenseCheck' in m && m.licenseCheck).map((m) => m.id))].sort();
    expect(flagged).toEqual([
      'beat-this',
      'bs-roformer-sw-6stem',
      'essentia',
      'mel-roformer-dereverb',
      'mel-roformer-karaoke',
      'pyannote-community-1',
      'scnet-xl-ihf',
      'songformer',
    ]);
  });

  it('bleibt mit Pods (A40) unter dem AI-Budget von 4 €/h', () => {
    expect(AI_MAX_AI_EUR_PER_HOUR).toBe(4);
    expect(() => assertResidentFleetBudget('pod', 'A40')).not.toThrow();
    expect(estimateResidentFleetEurPerHour('pod', 'A40')).toBeCloseTo(2.25, 2);
  });

  it('sprengt das Budget als Serverless-Flex – die 0,50-€-Annahme gilt nur für Pods', () => {
    expect(() => assertResidentFleetBudget('serverlessFlex', 'A40')).toThrow(/4 €\/h/);
    expect(estimateResidentFleetEurPerHour('serverlessFlex', 'A40')).toBeCloseTo(5.61, 2);
  });
});
