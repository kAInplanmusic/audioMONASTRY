/**
 * audioMONASTRY · Zentrale MOA-Historie
 * =====================================
 * Sammelt alle MOA/MCP-Läufe (pluginübergreifend) für Session + UI.
 * DCT-106: Persistenz über IndexedDB (großer State), Schreibzugriffe
 * fire-and-forget – der Audio-Pfad wartet niemals darauf.
 */
import { largeGetJson, largeSetJson } from '../../utils/indexedDB';
import { suggestNextForPlugin, type AutomationSuggestion } from './parameterPrediction';

export interface MoaHistoryEntry {
  pluginId: string;
  task: string;
  provider: string;
  results: string[];
  at: number;
}

const STORAGE_KEY = 'moa-history';
const MAX_ENTRIES = 20;

export class MoaHistoryStore {
  private entries: MoaHistoryEntry[] = [];
  private listeners = new Set<() => void>();

  constructor() {
    // Async-Load aus IndexedDB; UI subscribed und rendert nach dem Laden.
    void largeGetJson<MoaHistoryEntry[]>(STORAGE_KEY).then((loaded) => {
      if (loaded && Array.isArray(loaded)) {
        this.entries = loaded.slice(-MAX_ENTRIES);
        this.listeners.forEach((cb) => cb());
      }
    });
  }

  add(entry: MoaHistoryEntry): void {
    this.entries = [...this.entries, entry].slice(-MAX_ENTRIES);
    void largeSetJson(STORAGE_KEY, this.entries);
    this.listeners.forEach((cb) => cb());
  }

  list(pluginId?: string): MoaHistoryEntry[] {
    const all = [...this.entries].reverse();
    return pluginId ? all.filter((e) => e.pluginId === pluginId) : all;
  }

  clear(): void {
    this.entries = [];
    void largeSetJson(STORAGE_KEY, this.entries);
    this.listeners.forEach((cb) => cb());
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** AM-E6-4: Heuristischer Automation-Vorschlag aus der Historie. */
  suggest(pluginId: string): AutomationSuggestion | null {
    return suggestNextForPlugin(this.entries, pluginId);
  }
}

export const moaHistory = new MoaHistoryStore();
