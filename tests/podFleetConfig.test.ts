import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AI_RESIDENT_FLEET, RESIDENT_USABLE_VRAM_GB, residentVramGb } from '../src/config/aiInfrastructure';

/**
 * Drift-Guard Deploy-Quelle (deploy/runpod/pod-fleet.json) ↔ Zielbild
 * (AI_RESIDENT_FLEET) ↔ Manifest, Betreiber-Entscheid 2026-10-12
 * (docs/AI_FLEET_STARTPLAN.md, AGENTS.md 2.3).
 *
 * `models` = heute ausgerollt (AI_ROLE_MODELS des Pods), `target` = Entscheid.
 * Kein stiller Modellwechsel: was ausgerollt ist, aber nicht im Ziel steht,
 * braucht ein Abloese-Ticket; Zielmodelle ohne Handler stehen mit status "neu"
 * im Manifest und in keiner Rolle.
 */
interface Target {
  models: string[];
  vramGb: number;
  reservesGb?: Record<string, number>;
  retireAfter?: Record<string, string>;
  /** Manifest-Modell mit Pin, aber noch in keiner Rolle des Pods (Ticket). */
  pendingRole?: Record<string, string>;
  params?: Record<string, unknown>;
}
interface Pod {
  role: string;
  aiRole: string;
  startTrigger: string;
  models: string[];
  covers: string[];
  tasks?: string[];
  target?: Target;
}
interface ManifestModel { id: string; estimatedVRAM: number; status?: string; revision: string; license: string }
interface Manifest { roles: Record<string, { models: string[]; preloadModels: string[] }>; models: ManifestModel[] }

const read = <T,>(rel: string): T => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')) as T;
const fleet = read<{ pods: Pod[] }>('../deploy/runpod/pod-fleet.json');
const manifest = read<Manifest>('../services/audiomonastry-ai-runtime/model_manifest.json');
const byId = new Map(manifest.models.map((m) => [m.id, m]));
const pod = (role: string): Pod => fleet.pods.find((p) => p.role === role)!;
const vram = (ids: readonly string[]) => ids.reduce((s, id) => s + (byId.get(id)?.estimatedVRAM ?? Number.NaN), 0);
const FLEET_TICKET = /^FLEET-P1-0\d\d$/;

describe('pod-fleet.json: Start-Trigger (AGENTS.md 2.3)', () => {
  it('RP1 brain und RP2 ears immer an, RP3 music und RP4 voice bei AI-Generierung, RP5 stems beim stemMONK', () => {
    expect(Object.fromEntries(fleet.pods.map((p) => [p.role, p.startTrigger]))).toEqual({
      brain: 'always',
      ears: 'always',
      voice: 'aiGeneration',
      stems: 'stemMONK',
      music: 'aiGeneration',
    });
  });
});

describe('pod-fleet.json: ausgerollter Stand (models)', () => {
  it('nutzt nur Manifest-Modelle aus der Rolle des Pods, keines mit status "neu"', () => {
    for (const p of fleet.pods) {
      const roleModels = new Set(p.aiRole.split('+').flatMap((r) => manifest.roles[r]?.models ?? []));
      for (const id of p.models) {
        expect(byId.has(id), `${p.role}: ${id} fehlt im Manifest`).toBe(true);
        expect(roleModels.has(id), `${p.role}: ${id} liegt nicht in der Rolle ${p.aiRole}`).toBe(true);
        expect(byId.get(id)!.status ?? 'ready', `${p.role}: ${id} hat noch keinen Handler`).not.toBe('neu');
      }
    }
  });

  it('passt je Pod in den nutzbaren VRAM (Manifest-Schätzung)', () => {
    for (const p of fleet.pods) expect(vram(p.models), p.role).toBeLessThanOrEqual(RESIDENT_USABLE_VRAM_GB);
  });

  it('LEGO-Modell acestep-v15-xl-base liegt auf dem voice-Pod, nicht auf music', () => {
    expect(pod('voice').models).toContain('acestep-v15-xl-base');
    expect(pod('music').models).not.toContain('acestep-v15-xl-base');
    expect(manifest.roles.music.preloadModels).not.toContain('acestep-v15-xl-base');
  });

  it('htdemucs-6s bleibt als Alias nur auf dem stems-Pod, bis der RP5-Handler existiert', () => {
    expect(pod('stems').models).toEqual(['htdemucs-6s']);
    expect(pod('voice').models).not.toContain('htdemucs-6s');
    expect(manifest.roles.voiceGen.preloadModels).not.toContain('htdemucs-6s');
    expect(manifest.roles.voiceGen.models).toContain('htdemucs-6s');
  });
});

describe('pod-fleet.json: Zielbild (target) ↔ AI_RESIDENT_FLEET ↔ Manifest', () => {
  it('RP1 brain hat kein target (unverändert), alle anderen Pods haben eines', () => {
    expect(pod('brain').target).toBeUndefined();
    for (const p of fleet.pods.filter((x) => x.role !== 'brain')) expect(p.target, p.role).toBeDefined();
  });

  it('target.models entspricht AI_RESIDENT_FLEET je Pod', () => {
    for (const inst of AI_RESIDENT_FLEET.filter((i) => i.id !== 'brain')) {
      expect([...pod(inst.id).target!.models].sort(), inst.id).toEqual(inst.models.map((m) => m.id).sort());
    }
  });

  it('target.vramGb = Summe aus AI_RESIDENT_FLEET (inkl. Reserven) und <= 42 GB', () => {
    for (const inst of AI_RESIDENT_FLEET.filter((i) => i.id !== 'brain')) {
      const t = pod(inst.id).target!;
      expect(t.vramGb, inst.id).toBe(residentVramGb(inst));
      expect(t.vramGb, inst.id).toBeLessThanOrEqual(RESIDENT_USABLE_VRAM_GB);
      const reserves = Object.values(t.reservesGb ?? {}).reduce((s, n) => s + n, 0);
      expect(vram(t.models) + reserves, `${inst.id}: Manifest-Schätzungen`).toBe(t.vramGb);
    }
  });

  it('jedes Zielmodell steht im Manifest; ohne Handler mit status "neu"', () => {
    for (const p of fleet.pods.filter((x) => x.target)) {
      for (const id of p.target!.models) {
        const mf = byId.get(id);
        expect(mf, `${p.role}: ${id} fehlt im Manifest`).toBeDefined();
        const roleModels = new Set(p.aiRole.split('+').flatMap((r) => manifest.roles[r]?.models ?? []));
        if (roleModels.has(id) || mf!.status === 'neu') continue;
        expect(p.target!.pendingRole?.[id], `${p.role}: ${id} ohne Rolle braucht status "neu" oder pendingRole`).toMatch(FLEET_TICKET);
      }
    }
  });

  it('kein stiller Modellwechsel: ausgerollt, aber nicht im Ziel -> Abloese-Ticket in retireAfter', () => {
    for (const p of fleet.pods.filter((x) => x.target)) {
      const t = p.target!;
      const leaving = p.models.filter((id) => !t.models.includes(id)).sort();
      expect(Object.keys(t.retireAfter ?? {}).sort(), p.role).toEqual(leaving);
      for (const ticket of Object.values(t.retireAfter ?? {})) expect(ticket, p.role).toMatch(FLEET_TICKET);
    }
  });

  it('PIN-ERFORDERLICH nur bei status "neu"; neue Modelle stehen in keiner Rolle', () => {
    const roleModels = new Set(Object.values(manifest.roles).flatMap((r) => r.models));
    for (const m of manifest.models) {
      if (m.revision === 'PIN-ERFORDERLICH') expect(m.status, m.id).toBe('neu');
      if (m.status === 'neu') expect(roleModels.has(m.id), `${m.id} steht in einer Rolle`).toBe(false);
      if (m.status === 'neu' && m.revision !== 'PIN-ERFORDERLICH') expect(m.revision, m.id).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('MERT ist laut HF cc-by-nc-4.0 (korrigiert), bark-small und Stable Audio sind nicht im Ziel', () => {
    expect(byId.get('mert-v1-330m')!.license).toBe('CC-BY-NC-4.0');
    const targets = fleet.pods.flatMap((p) => p.target?.models ?? []);
    for (const gone of ['bark-small', 'stable-audio-open-1.0', 'stable-audio-3-medium', 'htdemucs-6s']) expect(targets).not.toContain(gone);
    expect(pod('music').target!.params).toMatchObject({ musicGenerateModel: 'acestep-v15-xl-sft' });
  });
});
