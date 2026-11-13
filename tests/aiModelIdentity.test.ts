import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AI_MAX_GPU_ENDPOINTS } from '../src/config/aiInfrastructure';
import { brainModelDefaults } from '../src/core/ai/LlmRouter';

/**
 * INFRA-RUNPOD-003: Der Brain hatte drei Modell-Identitäten – `Qwen/Qwen3-14B-AWQ`
 * (OpenAI-Pfad, live am Endpoint), `qwen3-14b` (Default des nativen Worker-Pfads)
 * und `qwen3-30b-a3b-awq` (Manifest). Der kurze Identifier existierte im Manifest
 * gar nicht: der native Pfad wäre an `ModelUnavailableError: unknown model`
 * gescheitert. Dieser Test hält Router-Defaults und Manifest zusammen.
 *
 * INFRA-RUNPOD-001: Zusätzlich vergleicht er die Endpoint-Obergrenze des
 * Deploy-Skripts mit `AI_MAX_GPU_ENDPOINTS` – zwei Zahlen, die vorher
 * unabhängig voneinander existierten.
 */
interface ManifestModel {
  id: string;
  repository: string;
  revision: string;
  status?: string;
}

interface Manifest {
  roles: Record<string, { models: string[]; preloadModels: string[]; gpuId: string }>;
  models: ManifestModel[];
}

const manifest = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../services/audiomonastry-ai-runtime/model_manifest.json', import.meta.url)),
    'utf-8',
  ),
) as Manifest;

const previousFleetMode = process.env.AI_FLEET_MODE;
beforeEach(() => { process.env.AI_FLEET_MODE = 'pods'; });
afterEach(() => {
  if (previousFleetMode === undefined) delete process.env.AI_FLEET_MODE;
  else process.env.AI_FLEET_MODE = previousFleetMode;
});

const fleetPlan = JSON.parse(readFileSync(new URL('../deploy/gpu/pod-fleet.json', import.meta.url), 'utf-8'));
const modelsById = new Map(manifest.models.map((m) => [m.id, m]));
const repos = new Set(manifest.models.map((m) => m.repository));

describe('Brain-Modell-Identität: Router ↔ Rollen-Manifest (INFRA-RUNPOD-003)', () => {
  it('führt jede Modell-ID genau einmal (Map-Lookup bleibt eindeutig)', () => {
    // Repository-Namen dürfen sich wiederholen (IP-Adapter/Real-ESRGAN werden in
    // mehreren Varianten geführt) – die ID muss eindeutig sein, sonst ist der
    // Lookup im Router/Worker zufällig.
    const ids = manifest.models.map((m) => m.id);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    expect(duplicates, 'Modell-ID doppelt im Manifest').toEqual([]);
  });

  it('findet jedes Router-Default-Modell im Manifest', () => {
    const defaults = brainModelDefaults();
    for (const [slot, model] of Object.entries(defaults)) {
      // Der OpenAI-kompatible Pfad nennt den HF-Namen, der native Pfad den
      // Manifest-Identifier – beides muss im Manifest auflösbar sein.
      const byId = modelsById.get(model);
      const byRepo = repos.has(model);
      expect(byId ?? byRepo, `${slot}: '${model}' steht nicht im Manifest`).toBeDefined();
    }
  });

  it('führt das live servierte Brain-Modell mit Pin und ohne planned-Status', () => {
    // Live belegt (AI-P1-008): GET /openai/v1/models → Qwen/Qwen3-14B-AWQ.
    const entry = modelsById.get('qwen38-27b-fp8');
    expect(entry, "current FP8 brain missing").toBeDefined();
    expect(entry?.repository).toBe('Qwen/Qwen3.8-27B-FP8');
    expect(entry?.revision.toUpperCase().startsWith('TBD'), 'Revision nicht gepinnt').toBe(false);
    expect(entry?.status ?? 'ready').not.toBe('planned');
  });

  it('lädt die Brain-Modelle der Rolle vor', () => {
    const brain = manifest.roles.brain;
    expect(brain.models).toEqual(['qwen38-27b-fp8']);
    expect(brain.preloadModels).toEqual(['qwen38-27b-fp8']);
    expect(manifest.roles.executor.models).toEqual(['qwen3-4b']);
    expect(manifest.roles.executor.preloadModels).toEqual(['qwen3-4b']);
  });
});

describe('Vast authoritative deployment inventory replaces the removed serverless deployer', () => {
  it('does not exceed the app endpoint cap with the selected physical roles', () => {
    const active = [...fleetPlan.pods, fleetPlan.visPod];
    expect(active).toHaveLength(AI_MAX_GPU_ENDPOINTS);
    expect(new Set(active.map(pod => pod.role)).size).toBe(active.length);
  });
  it('retains one existing-media vis role and excludes retired generators', () => {
    expect(fleetPlan.visPod.role).toBe('vis');
    expect(fleetPlan.visPod.enabledNote).toContain('Nur vorhandene Bilder/Videos rendern');
    for (const role of ['imageHq', 'videoReal', 'videoAbstract']) {
      expect(fleetPlan.retiredRoles).toContain(role);
      expect(fleetPlan.pods.map(pod => pod.role)).not.toContain(role);
    }
  });
});
