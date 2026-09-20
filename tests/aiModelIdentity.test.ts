import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
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
  roles: Record<string, { models: string[]; preloadModels: string[]; gpuPoolId: string }>;
  models: ManifestModel[];
}

const manifest = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../services/audiomonastry-ai-runtime/model_manifest.json', import.meta.url)),
    'utf-8',
  ),
) as Manifest;

const deployScript = readFileSync(fileURLToPath(new URL('../scripts/runpod-deploy.py', import.meta.url)), 'utf-8');
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
    const entry = modelsById.get('qwen3-14b');
    expect(entry, "qwen3-14b fehlt im Manifest").toBeDefined();
    expect(entry?.repository).toBe('Qwen/Qwen3-14B-AWQ');
    expect(entry?.revision.toUpperCase().startsWith('TBD'), 'Revision nicht gepinnt').toBe(false);
    expect(entry?.status ?? 'ready').not.toBe('planned');
  });

  it('lädt die Brain-Modelle der Rolle vor', () => {
    const brain = manifest.roles.brain;
    for (const id of ['qwen3-30b-a3b-awq', 'qwen3-14b', 'qwen3-4b']) {
      expect(brain.models, `brain.models ohne ${id}`).toContain(id);
      expect(brain.preloadModels, `brain.preloadModels ohne ${id}`).toContain(id);
    }
  });
});

describe('Endpoint-Obergrenze: Deploy-Skript ↔ App (INFRA-RUNPOD-001)', () => {
  it('deklariert dieselbe Grenze wie AI_MAX_GPU_ENDPOINTS', () => {
    const match = deployScript.match(/ENDPOINT_LIMIT_DEFAULT\s*=\s*(\d+)/);
    expect(match, 'ENDPOINT_LIMIT_DEFAULT fehlt in scripts/runpod-deploy.py').toBeTruthy();
    expect(Number(match![1])).toBe(AI_MAX_GPU_ENDPOINTS);
  });

  it('prüft das Konto vor dem Anlegen (Guard vorhanden und verdrahtet)', () => {
    expect(deployScript).toMatch(/def plan_endpoint_budget\(/);
    // Der Preflight muss im Deploy-Pfad hängen, nicht nur definiert sein.
    expect(deployScript).toMatch(/plan_endpoint_budget\(live_names, planned\)/);
  });

  it('überlässt den GPU-Pool den Rollen-Defaults (kein globaler CI-Override)', () => {
    const workflow = readFileSync(
      fileURLToPath(new URL('../.github/workflows/runpod-deploy.yml', import.meta.url)),
      'utf-8',
    );
    expect(workflow).not.toMatch(/^\s*RUNPOD_GPU_ID:/m);
    expect(workflow).not.toMatch(/^\s*RUNPOD_IDLE_TIMEOUT:/m);
  });
});
