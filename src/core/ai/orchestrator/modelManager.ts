/**
 * audioMONASTRY · AI Orchestrator – Model Manager (Client-Sicht)
 * ==============================================================
 * Verwaltet den Modell-Zustand des HF-Endpoints vom Hetzner-Server aus:
 * - load()/unload()/isLoaded()/getStatus()/getMemoryUsage()/getModelInfo()
 * - Dedupliziert parallele Load-Requests (SingleFlight)
 * - VRAM-Guard: available = budget - used - safetyMargin; bei Engpass
 *   LRU-Eviction (nie CORE) → Retry → kontrollierter Fehler
 *
 * Die eigentliche Modell-Ausführung liegt im Container (services/samplemonk-ai-runtime);
 * dieser Manager steuert sie über die Runtime-API (POST /mcp/tools/model.load …).
 */
import { aiLogger } from './aiLogger';
import { getModelDefinition, modelsByLoadClass } from './modelRegistry';
import type { ModelDefinition, ModelLoadClass } from './types';

export interface EndpointClient {
  loadModel(modelId: string): Promise<void>;
  unloadModel(modelId: string): Promise<void>;
  listModels(): Promise<Array<{ id: string; loaded: boolean }>>;
}

export interface VramStatus {
  available: boolean;
  device: string;
  totalGb: number;
  usedGb: number;
}

export class ModelManager {
  private loaded = new Set<string>();
  private loading = new Set<string>();
  private lastUsed = new Map<string, number>();
  private errors = new Map<string, string>();
  private budgetGb: number;
  private safetyMarginGb: number;
  private usedGb = 0;
  private gpu: VramStatus = { available: false, device: 'unknown', totalGb: 80, usedGb: 0 };

  constructor(
    private endpoint: EndpointClient,
    options: { vramBudgetGb?: number; vramSafetyMarginGb?: number } = {},
  ) {
    this.budgetGb = options.vramBudgetGb ?? Number(process.env.AI_MAX_VRAM ?? 80);
    this.safetyMarginGb = options.vramSafetyMarginGb ?? 6;
  }

  // ------------------------------------------------------------- GPU-Zustand
  setGpuStatus(status: VramStatus): void {
    this.gpu = status;
    if (status.totalGb > 0) this.budgetGb = status.totalGb;
    this.usedGb = status.usedGb;
  }

  getMemoryUsage(): VramStatus & { budgetGb: number; safetyMarginGb: number; availableGb: number } {
    return { ...this.gpu, budgetGb: this.budgetGb, safetyMarginGb: this.safetyMarginGb, availableGb: this.availableVram() };
  }

  private availableVram(): number {
    return Math.max(0, this.budgetGb - this.usedGb - this.safetyMarginGb);
  }

  // ------------------------------------------------------------- Sync
  async sync(): Promise<void> {
    const models = await this.endpoint.listModels();
    this.loaded = new Set(models.filter((m) => m.loaded).map((m) => m.id));
    this.usedGb = [...this.loaded].reduce((sum, id) => sum + (getModelDefinition(id)?.estimatedVRAM ?? 0), 0);
  }

  // ------------------------------------------------------------- Load/Unload
  isLoaded(modelId: string): boolean {
    return this.loaded.has(modelId);
  }

  async load(modelId: string): Promise<void> {
    const definition = getModelDefinition(modelId);
    if (!definition) throw new Error(`unknown model: ${modelId}`);
    if (this.loaded.has(modelId)) {
      this.lastUsed.set(modelId, Date.now());
      return;
    }
    if (this.loading.has(modelId)) {
      throw new Error(`model already loading: ${modelId}`);
    }
    this.loading.add(modelId);
    try {
      await this.loadWithEviction(definition, 0);
    } finally {
      this.loading.delete(modelId);
    }
  }

  private async loadWithEviction(definition: ModelDefinition, attempt: number): Promise<void> {
    const required = definition.estimatedVRAM;
    if (required > this.availableVram()) {
      const evicted = this.evictFor(required);
      if (evicted) await new Promise((r) => setTimeout(r, 200));
      if (required > this.availableVram()) {
        if (attempt === 0 && evicted) return this.loadWithEviction(definition, 1);
        throw new Error(`VRAM exhausted for ${definition.id} (required ${required} GB, available ${this.availableVram().toFixed(1)} GB)`);
      }
    }
    await this.endpoint.loadModel(definition.id);
    this.loaded.add(definition.id);
    this.lastUsed.set(definition.id, Date.now());
    this.usedGb += required;
    this.errors.delete(definition.id);
    aiLogger.info('model loaded', { model: definition.id, task: definition.task });
  }

  async unload(modelId: string): Promise<void> {
    if (!this.loaded.has(modelId)) return;
    await this.endpoint.unloadModel(modelId);
    const definition = getModelDefinition(modelId);
    this.loaded.delete(modelId);
    this.lastUsed.delete(modelId);
    this.usedGb = Math.max(0, this.usedGb - (definition?.estimatedVRAM ?? 0));
    aiLogger.info('model unloaded', { model: modelId });
  }

  /** LRU-Eviction (nie CORE), bis `requiredGb` frei ist. */
  private evictFor(requiredGb: number): boolean {
    const candidates = [...this.lastUsed.entries()]
      .filter(([id]) => getModelDefinition(id)?.loadClass !== 'CORE')
      .sort((a, b) => a[1] - b[1]);
    let evicted = false;
    for (const [id] of candidates) {
      if (requiredGb <= this.availableVram()) break;
      void this.unload(id);
      evicted = true;
    }
    return evicted;
  }

  // ------------------------------------------------------------- Preload/Warmup
  async preload(): Promise<void> {
    for (const loadClass of ['CORE', 'FREQUENT'] as ModelLoadClass[]) {
      for (const definition of modelsByLoadClass(loadClass)) {
        try {
          await this.load(definition.id);
        } catch (error) {
          this.errors.set(definition.id, (error as Error).message);
          aiLogger.warn('preload failed', { model: definition.id, error: (error as Error).message });
        }
      }
    }
  }

  async warmup(modelId: string): Promise<void> {
    if (!this.loaded.has(modelId)) await this.load(modelId);
    this.lastUsed.set(modelId, Date.now());
  }

  // ------------------------------------------------------------- Status
  getStatus(): Record<'core' | 'frequent' | 'onDemand' | 'rare', string> {
    const byClass: Record<string, string[]> = { CORE: [], FREQUENT: [], ON_DEMAND: [], RARE: [] };
    for (const definition of modelsByLoadClass('CORE').concat(modelsByLoadClass('FREQUENT'), modelsByLoadClass('ON_DEMAND'), modelsByLoadClass('RARE'))) {
      const state = this.loaded.has(definition.id) ? 'loaded' : this.errors.has(definition.id) ? 'error' : 'available';
      byClass[definition.loadClass].push(state);
    }
    const worst = (states: string[]) => {
      const order = ['available', 'loaded', 'error'];
      return states.reduce((a, b) => (order.indexOf(b) > order.indexOf(a) ? b : a), 'available');
    };
    return {
      core: worst(byClass.CORE),
      frequent: worst(byClass.FREQUENT),
      onDemand: worst(byClass.ON_DEMAND),
      rare: worst(byClass.RARE),
    };
  }

  getModelInfo(): Array<{ id: string; loaded: boolean; loadClass: ModelLoadClass; estimatedVRAM: number }> {
    return [...modelsByLoadClass('CORE'), ...modelsByLoadClass('FREQUENT'), ...modelsByLoadClass('ON_DEMAND'), ...modelsByLoadClass('RARE')].map((m) => ({
      id: m.id,
      loaded: this.loaded.has(m.id),
      loadClass: m.loadClass,
      estimatedVRAM: m.estimatedVRAM,
    }));
  }
}
