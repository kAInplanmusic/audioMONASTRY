/**
 * audioMONASTRY · MappingStore (Persistenz)
 * =========================================
 * Speichert Mapping-Regeln dauerhaft (IndexedDB via Adapter, In-Memory-Fallback)
 * und unterstützt Export/Import. Mappings überleben Reloads und sind
 * transportagnostisch – sie referenzieren NIE physische Geräte.
 */
import { MappingEngine, MappingRule } from './MappingEngine';
import { largeGetJson, largeSetJson } from '../../utils/indexedDB';

const MAPPINGS_KEY = 'audiomonastry_control_mappings';

export interface MappingBundle {
  version: 1;
  rules: MappingRule[];
  exportedAt?: number;
}

export class MappingStore {
  private engine = new MappingEngine();
  private loaded = false;

  get engineRef(): MappingEngine {
    return this.engine;
  }

  /** Lädt Regeln (idempotent; In-Memory-Fallback ohne IndexedDB). */
  async load(): Promise<MappingRule[]> {
    if (this.loaded) return this.engine.listRules();
    try {
      const stored = await largeGetJson<MappingBundle>(MAPPINGS_KEY);
      if (stored && Array.isArray(stored.rules)) {
        this.engine.clear();
        for (const rule of stored.rules) this.engine.addRule(rule);
      }
    } catch { /* Fallback: leer starten */ }
    this.loaded = true;
    return this.engine.listRules();
  }

  /** Fügt eine Regel hinzu und persistiert. */
  async addRule(rule: MappingRule): Promise<void> {
    this.engine.addRule(rule);
    await this.persist();
  }

  /** Entfernt eine Regel und persistiert. */
  async removeRule(ruleId: string): Promise<void> {
    this.engine.removeRule(ruleId);
    await this.persist();
  }

  /** Ersetzt alle Regeln und persistiert. */
  async replaceAll(rules: MappingRule[]): Promise<void> {
    this.engine.clear();
    for (const rule of rules) this.engine.addRule(rule);
    await this.persist();
  }

  /** Export als JSON-String (Backup/Transfer). */
  exportJson(): string {
    return JSON.stringify(this.bundle(), null, 2);
  }

  /** Import aus JSON-String (validiert die Grundstruktur). */
  async importJson(json: string): Promise<number> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error('Mapping-JSON ist ungültig.');
    }
    const bundle = parsed as MappingBundle;
    if (!bundle || !Array.isArray(bundle.rules)) {
      throw new Error('Mapping-JSON hat kein gültiges `rules`-Array.');
    }
    await this.replaceAll(bundle.rules);
    return bundle.rules.length;
  }

  private bundle(): MappingBundle {
    return { version: 1, rules: this.engine.listRules(), exportedAt: Date.now() };
  }

  private async persist(): Promise<void> {
    await largeSetJson(MAPPINGS_KEY, this.bundle()).catch(() => { /* Quota – In-Memory bleibt aktiv */ });
  }
}

export const mappingStore = new MappingStore();
