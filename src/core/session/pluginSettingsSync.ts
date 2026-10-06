/**
 * Beständige Plugins (Betreiber 2026-10-06)
 * =========================================
 * „Wenn User 3 aus dem EQ rausgeht und User 4 rein, muss die Einstellung
 * bleiben – für alle Plugins. So kann man switchen oder jemand anders kurz
 * übernehmen lassen."
 *
 * Der Stand eines Plugins liegt in der Session auf dem Server
 * (AuthoritativeSession.setPluginSettings, mit der Session gesichert):
 *
 *   - Öffnen (Halter, ON): das Terminal liest den letzten Stand → Einstiegsstand.
 *   - Ändern: kurz entprellt an den Server (nur der Halter darf schreiben).
 *   - Verlassen (ON → OFF, Mixer übergeben, Seite schließen): sofort senden.
 *   - Der Server verteilt jeden Stand, damit der nächste Halter ihn schon hat.
 *
 * Diese Datei ist der reine Speicher (ohne Socket/Browser), damit er testbar
 * ist. Die Anbindung macht `src/hooks/usePluginSettings.ts`.
 */

export type PluginSettings = Record<string, unknown>;

export interface PluginSettingsRecord {
  settings: PluginSettings;
  /** Session-Revision; ältere Stände überschreiben nie neuere. */
  revision: number;
  updatedBy: string;
}

export interface PluginSettingsTransport {
  send(pluginId: string, settings: PluginSettings): void;
  /** Hält dieser Nutzer das Plugin gerade? Nur dann wird gesendet. */
  isHolder(pluginId: string): boolean;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export const PLUGIN_SETTINGS_DEBOUNCE_MS = 250;

const isPlainObject = (v: unknown): v is PluginSettings => !!v && typeof v === 'object' && !Array.isArray(v);

export class PluginSettingsStore {
  private readonly records = new Map<string, PluginSettingsRecord>();
  private readonly pending = new Map<string, { settings: PluginSettings; timer: unknown }>();

  constructor(private readonly transport: PluginSettingsTransport, private readonly debounceMs = PLUGIN_SETTINGS_DEBOUNCE_MS) {}

  /** Stand vom Server übernehmen (Snapshot beim Beitritt oder Meldung eines Halters). */
  accept(pluginId: string, raw: unknown): boolean {
    if (!pluginId || !raw || typeof raw !== 'object') return false;
    const r = raw as Partial<PluginSettingsRecord>;
    if (!isPlainObject(r.settings)) return false;
    const revision = Number.isFinite(r.revision) ? Number(r.revision) : 0;
    const current = this.records.get(pluginId);
    if (current && current.revision > revision) return false;
    // Eigene, noch nicht gesendete Änderungen gewinnen gegen ältere Server-Stände.
    if (this.pending.has(pluginId)) return false;
    this.records.set(pluginId, { settings: r.settings, revision, updatedBy: typeof r.updatedBy === 'string' ? r.updatedBy : '' });
    return true;
  }

  /** Alle Stände aus einem Session-Snapshot (`pluginSettings`) übernehmen. */
  acceptSnapshot(snapshot: unknown): void {
    const map = (snapshot as { pluginSettings?: unknown } | null)?.pluginSettings;
    if (!isPlainObject(map)) return;
    for (const [pluginId, entry] of Object.entries(map)) this.accept(pluginId, entry);
  }

  /**
   * Letzter bekannter Stand eines Plugins (Einstiegsstand beim Öffnen). Mit
   * `section` der Teil eines Plugins mit mehreren Bereichen (z. B. syntisampler:
   * Sampler, MPC, Synth) – jeder Bereich speichert unabhängig.
   */
  read<T = PluginSettings>(pluginId: string, section?: string): T | null {
    const settings = this.records.get(pluginId)?.settings;
    if (!settings) return null;
    if (!section) return settings as T;
    const part = settings[section];
    return isPlainObject(part) ? (part as T) : null;
  }

  /**
   * Neuer Stand vom Terminal. Gleiche Werte werden ignoriert (das Terminal
   * meldet beim Öffnen oft den geladenen Stand zurück). Gesendet wird nur, wenn
   * dieser Nutzer das Plugin hält – eine versteckte Kopie schreibt nie.
   */
  write(pluginId: string, settings: PluginSettings, section?: string): void {
    if (!pluginId || !isPlainObject(settings)) return;
    if (!this.transport.isHolder(pluginId)) return;
    const current = this.records.get(pluginId);
    let copy: PluginSettings;
    try {
      const part = JSON.parse(JSON.stringify(settings)) as PluginSettings;
      copy = section ? { ...(current?.settings ?? {}), [section]: part } : part;
    } catch {
      return;
    }
    if (current && JSON.stringify(current.settings) === JSON.stringify(copy)) return;
    this.records.set(pluginId, { settings: copy, revision: current?.revision ?? 0, updatedBy: current?.updatedBy ?? '' });
    const prev = this.pending.get(pluginId);
    if (prev) this.transport.clearTimer(prev.timer);
    const timer = this.transport.setTimer(() => this.flush(pluginId), this.debounceMs);
    this.pending.set(pluginId, { settings: copy, timer });
  }

  /** Ausstehenden Stand sofort senden (Verlassen, Übergabe, Seite schließen). */
  flush(pluginId: string): void {
    const p = this.pending.get(pluginId);
    if (!p) return;
    this.transport.clearTimer(p.timer);
    this.pending.delete(pluginId);
    this.transport.send(pluginId, p.settings);
  }

  flushAll(): void {
    for (const id of [...this.pending.keys()]) this.flush(id);
  }

  hasPending(pluginId: string): boolean {
    return this.pending.has(pluginId);
  }
}

/**
 * Übernimmt aus einem gespeicherten Stand nur Felder, die es in den Standard-
 * werten gibt und die denselben Typ haben (Zahlen endlich). Ein Stand eines
 * anderen Nutzers oder einer älteren Version bricht so nie ein Terminal.
 */
export function mergeKnown<T extends object>(defaults: T, saved: unknown): T {
  const out = { ...defaults } as Record<string, unknown>;
  if (!isPlainObject(saved)) return out as T;
  for (const key of Object.keys(defaults)) {
    const value = saved[key];
    const def = (defaults as Record<string, unknown>)[key];
    if (value === undefined || typeof value !== typeof def) continue;
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    if (Array.isArray(def) !== Array.isArray(value)) continue;
    out[key] = value;
  }
  return out as T;
}
