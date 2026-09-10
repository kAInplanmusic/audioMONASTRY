import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GPU_ROLE_IDS, endpointNameForRole } from '../src/config/aiInfrastructure';
import { GPU_ROLE_LIST } from '../src/core/ai/orchestrator/endpointRegistry';

/**
 * Drift-Guard: Der TS-Spiegel der Flotte (`endpointRegistry.ts`) und das
 * Python-Rollen-Manifest (`services/samplemonk-ai-runtime/model_manifest.json`)
 * müssen dieselben Rollen, Budgets und Preload-Sätze beschreiben. Ohne diesen
 * Test können beide Seiten auseinanderlaufen, ohne dass ein Gate anschlägt.
 */
interface ManifestModel {
  id: string;
  revision: string;
  preload?: boolean;
  status?: string;
}

interface ManifestRole {
  label?: string;
  gpuPoolId: string;
  gpuCount: number;
  vramBudgetGb: number;
  preloadModels: string[];
  models: string[];
}

interface Manifest {
  runtime: Record<string, unknown>;
  roles: Record<string, ManifestRole>;
  models: ManifestModel[];
}

const manifestPath = fileURLToPath(
  new URL('../services/samplemonk-ai-runtime/model_manifest.json', import.meta.url),
);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Manifest;
const modelsById = new Map(manifest.models.map((m) => [m.id, m]));

describe('Rollen-Manifest ↔ TS-Flotten-Registry (Drift-Guard)', () => {
  it('kennt exakt dieselben Rollen', () => {
    expect(Object.keys(manifest.roles).sort()).toEqual([...GPU_ROLE_IDS].sort());
    expect(GPU_ROLE_LIST.map((r) => r.role)).toEqual([...GPU_ROLE_IDS]);
  });

  it('stimmt bei Endpoint-Namen, GPU-Pool, GPU-Anzahl und VRAM-Budget überein', () => {
    for (const role of GPU_ROLE_LIST) {
      const spec = manifest.roles[role.role];
      expect(spec, `Rolle ${role.role} fehlt im Manifest`).toBeDefined();
      expect(role.endpointName).toBe(endpointNameForRole(role.role));
      expect(role.gpuPoolId).toBe(spec.gpuPoolId);
      expect(role.gpuCount).toBe(spec.gpuCount);
      expect(role.vramBudgetGb).toBe(spec.vramBudgetGb);
    }
  });

  it('hat identische Preload-Sätze auf beiden Seiten', () => {
    for (const role of GPU_ROLE_LIST) {
      const spec = manifest.roles[role.role];
      expect(role.preload).toEqual(spec.preloadModels);
    }
  });

  it('referenziert nur existierende Modelle und lädt keine geplanten vor', () => {
    for (const [role, spec] of Object.entries(manifest.roles)) {
      for (const modelId of spec.models) {
        expect(modelsById.has(modelId), `${role}: unbekanntes Modell ${modelId}`).toBe(true);
      }
      for (const modelId of spec.preloadModels) {
        const model = modelsById.get(modelId);
        expect(spec.models, `${role}: Preload ${modelId} liegt außerhalb der Rolle`).toContain(modelId);
        expect(model?.status ?? 'ready', `${role}: ${modelId} ist geplant und darf nicht vorgeladen werden`).not.toBe('planned');
        expect(
          model?.revision.toUpperCase().startsWith('TBD'),
          `${role}: ${modelId} hat keinen echten Revisions-Pin (${model?.revision})`,
        ).toBe(false);
      }
    }
  });

  it('führt geplante Modelle mit TBD-Revision und ohne Preload', () => {
    const planned = manifest.models.filter((m) => m.status === 'planned');
    expect(planned.length).toBeGreaterThan(0);
    for (const model of planned) {
      expect(model.revision.toUpperCase().startsWith('TBD'), `${model.id} braucht eine TBD-Revision`).toBe(true);
      expect(model.preload ?? false, `${model.id} ist geplant und darf nicht preload=true sein`).toBe(false);
    }
  });

  it('validiert ungepinnte Revisionen nur bei status="planned"', () => {
    for (const model of manifest.models) {
      expect(model.revision.trim().length, `${model.id}: Revision fehlt`).toBeGreaterThan(0);
      expect(model.revision.toLowerCase(), `${model.id}: 'latest' ist verboten`).not.toBe('latest');
      if (!model.revision.toUpperCase().startsWith('TBD')) continue;
      expect(model.status, `${model.id}: TBD-Revision nur mit status="planned"`).toBe('planned');
    }
  });
});
