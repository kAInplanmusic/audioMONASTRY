/**
 * audioMONASTRY · 4.2.2 – Modell-Registry (lokal + remote, Hot-Swap)
 * ==================================================================
 * Zentrale Versionsverwaltung für KI-Modelle. Modelle können zur Laufzeit
 * ausgetauscht werden (Hot-Swap), ohne die App neu zu starten.
 */
export type ModelKind = 'embedding' | 'stems' | 'voice' | 'llm';

export interface ModelEntry {
  id: string;
  kind: ModelKind;
  version: string;
  /** 'local' | 'remote' | 'deterministic' */
  backend: string;
  /** URL/Pfad oder Provider-ID. */
  location: string;
  /** Qualitätsstufen, für die das Modell geeignet ist. */
  qualities: ('preview' | 'standard' | 'high')[];
  loadedAt?: number;
}

export class ModelRegistry {
  private models = new Map<string, ModelEntry>();
  private active = new Map<ModelKind, string>();

  register(entry: ModelEntry): void {
    this.models.set(entry.id, entry);
    if (!this.active.has(entry.kind)) this.active.set(entry.kind, entry.id);
  }

  /** Hot-Swap: aktives Modell eines Typs wechseln. */
  activate(kind: ModelKind, id: string): boolean {
    const entry = this.models.get(id);
    if (!entry || entry.kind !== kind) return false;
    this.active.set(kind, id);
    const model = this.models.get(id)!;
    model.loadedAt = Date.now();
    return true;
  }

  activeModel(kind: ModelKind): ModelEntry | undefined {
    const id = this.active.get(kind);
    return id ? this.models.get(id) : undefined;
  }

  list(kind?: ModelKind): ModelEntry[] {
    const all = [...this.models.values()];
    return kind ? all.filter((m) => m.kind === kind) : all;
  }
}

export const modelRegistry = new ModelRegistry();
