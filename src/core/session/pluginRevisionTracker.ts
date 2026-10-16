/**
 * audioMONASTRY · Revisionsgedächtnis für Plugin-Zustandswechsel (COLLAB-P0-005)
 * =============================================================================
 * Der serverseitige Session-State (`authoritativeSession.ts`) lehnt einen
 * Schreibvorgang ab, dessen `baseRevision` nicht zum Stand DIESES Plugins passt
 * — damit zwei Clients, die denselben Stand gesehen haben, sich nicht mehr
 * still gegenseitig überschreiben. Damit das greift, muss der Client die Basis
 * überhaupt kennen und mitschicken. Genau das leistet dieses Modul.
 *
 * Es ist bewusst REIN: kein Socket, kein Timer, kein I/O. Die Entscheidung
 * (welche Basis geht raus, wird wiederholt oder aufgegeben) liegt hier und ist
 * deshalb direkt testbar; die Verdrahtung mit dem Netz liegt in
 * `src/utils/WebRTCManager.ts`.
 *
 * ── Warum nicht einfach "letzte gesehene Revision" ───────────────────────────
 * Punkt 7 aus der Analyse: schnelle Folge-Sends DESSELBEN Nutzers am DESSELBEN
 * Plugin. Send 1 geht mit Basis 5 raus; bevor die Bestätigung zurück ist, klickt
 * der Nutzer erneut. Seine zuletzt GESEHENE Revision ist immer noch 5, während
 * der Server nach dem ersten Send schon bei 6 steht. Der zweite Send trüge also
 * eine veraltete Basis und würde abgelehnt, obwohl gar kein fremder Nutzer
 * dazwischen gefunkt hat — die Oberfläche fühlte sich beim schnellen Klicken
 * hakelig an. Deshalb zählt die Basis eigene, noch unbestätigte Schreibvorgänge
 * mit: `gesehen + inFlug`.
 *
 * ── Warum die Zahl gedeckelt wird ───────────────────────────────────────────
 * Geht eine Bestätigung verloren (Verbindung weg, Ack verschluckt), bliebe der
 * Zähler "in Flug" für immer stehen und die Basis liefe unbegrenzt nach oben —
 * jeder weitere Send wäre abgelehnt. Ab `maxPendingLocalWrites` fällt die Basis
 * deshalb auf die bestätigte Revision zurück (siehe `baseFor`).
 */

/** Wie oft ein abgelehnter Send höchstens wiederholt wird. */
const DEFAULT_MAX_RETRIES = 1;
/** Obergrenze gleichzeitig unbestätigter eigener Schreibvorgänge je Plugin. */
const DEFAULT_MAX_PENDING_LOCAL_WRITES = 8;

export interface PluginRevisionTrackerOptions {
  /** Wie oft ein abgelehnter Send hoechstens wiederholt wird. Default 1. */
  maxRetries?: number;
  /** Obergrenze gleichzeitig un-bestaetigter eigener Schreibvorgaenge je Plugin. Default 8. */
  maxPendingLocalWrites?: number;
}

export interface PluginRevisionState {
  /** Zuletzt vom Server bestaetigte Revision fuer dieses Plugin (0 = nie gesehen). */
  revision: number;
  /** Eigene, noch nicht bestaetigte Schreibvorgaenge (in Flug). */
  pendingLocalWrites: number;
}

export type PluginWriteRejection =
  | { action: 'retry'; baseRevision: number }
  | { action: 'give-up'; baseRevision: number; reason: 'retries-exhausted' };

export interface PluginRevisionTracker {
  /** Server-Revision eines Plugins zur Kenntnis nehmen (aus session-state, Broadcast, Ack, Rejected). */
  observe(pluginId: string, revision: number): void;
  /** Zuletzt bestaetigte Revision (0 = nie gesehen). */
  revisionFor(pluginId: string): number;
  /** Basis fuer den NAECHSTEN Send = bestaetigt + in Flug. */
  baseFor(pluginId: string): number;
  /** Vor dem Senden aufrufen: zaehlt einen Schreibvorgang als 'in Flug' und liefert die zu sendende Basis. */
  beginLocalWrite(pluginId: string): number;
  /** Bestaetigung (Ack oder eigener Broadcast). `revision` = die vom Server gemeldete neue Revision. */
  confirmLocalWrite(pluginId: string, revision?: number): void;
  /** Ablehnung durch den Server: entscheidet Wiederholung oder Aufgabe. */
  rejectLocalWrite(pluginId: string, canonicalRevision: number): PluginWriteRejection;
  /** Anzahl bereits verbrauchter Wiederholungen fuer dieses Plugin (Diagnose/Tests). */
  retryCount(pluginId: string): number;
  /** Alles zuruecksetzen (Session-Wechsel). */
  reset(): void;
  /** Diagnose. */
  snapshot(): Record<string, PluginRevisionState>;
}

/** Leere/ungueltige Plugin-IDs werden ignoriert statt zu werfen (Netz-Eingabe). */
function normalizePluginId(pluginId: unknown): string {
  return typeof pluginId === 'string' ? pluginId.trim() : '';
}

export function createPluginRevisionTracker(options: PluginRevisionTrackerOptions = {}): PluginRevisionTracker {
  const maxRetries = Number.isFinite(options.maxRetries) && (options.maxRetries as number) >= 0
    ? Math.floor(options.maxRetries as number)
    : DEFAULT_MAX_RETRIES;
  const maxPending = Number.isFinite(options.maxPendingLocalWrites) && (options.maxPendingLocalWrites as number) > 0
    ? Math.floor(options.maxPendingLocalWrites as number)
    : DEFAULT_MAX_PENDING_LOCAL_WRITES;

  const revisions = new Map<string, number>();
  const pending = new Map<string, number>();
  const retries = new Map<string, number>();

  const pendingOf = (pluginId: string): number => pending.get(pluginId) ?? 0;

  // Als lokale Funktionen, nicht ueber `this`: die Methoden bleiben damit auch
  // dann korrekt, wenn ein Aufrufer sie destrukturiert (`const { baseFor } = t`).
  const observeRevision = (pluginId: unknown, revision: number): void => {
    const id = normalizePluginId(pluginId);
    if (!id || !Number.isFinite(revision)) return;
    // Nie senken: eine verspätete Nachricht darf einen neueren Stand nicht
    // zurückdrehen. Gleichstand ist erlaubt (idempotent).
    const known = revisions.get(id) ?? 0;
    if (revision > known) revisions.set(id, revision);
  };

  const baseForPlugin = (pluginId: unknown): number => {
    const id = normalizePluginId(pluginId);
    if (!id) return 0;
    const confirmed = revisions.get(id) ?? 0;
    // Der Deckel sitzt in `beginLocalWrite` (dort waechst `pending` nicht
    // weiter); hier wird nur gerechnet. Eine Deckelung AN DIESER STELLE waere
    // falsch: sie schaltete den Zuwachs genau beim Erreichen der Grenze ab,
    // statt ihn auf die Grenze zu begrenzen.
    return confirmed + pendingOf(id);
  };

  return {
    observe: observeRevision,

    revisionFor(pluginId) {
      const id = normalizePluginId(pluginId);
      if (!id) return 0;
      return revisions.get(id) ?? 0;
    },

    baseFor: baseForPlugin,

    beginLocalWrite(pluginId) {
      const id = normalizePluginId(pluginId);
      if (!id) return 0;
      const base = baseForPlugin(id);
      const inFlight = pendingOf(id);
      // Nur zaehlen, solange der Deckel nicht erreicht ist (gleiche Regel wie baseFor).
      if (inFlight < maxPending) pending.set(id, inFlight + 1);
      return base;
    },

    confirmLocalWrite(pluginId, revision) {
      const id = normalizePluginId(pluginId);
      if (!id) return;
      const inFlight = pendingOf(id);
      if (inFlight > 0) pending.set(id, inFlight - 1);
      // Die gemeldete Revision nur uebernehmen, nie senken (siehe observe).
      if (typeof revision === 'number') observeRevision(id, revision);
    },

    rejectLocalWrite(pluginId, canonicalRevision) {
      const id = normalizePluginId(pluginId);
      // Ablehnung entwertet den offenen Schreibvorgang: der Server hat nichts
      // uebernommen, also ist nichts mehr "in Flug".
      const inFlight = pendingOf(id);
      if (inFlight > 0) pending.set(id, inFlight - 1);
      if (Number.isFinite(canonicalRevision)) observeRevision(id, canonicalRevision);
      const base = revisions.get(id) ?? 0;

      const used = retries.get(id) ?? 0;
      if (used >= maxRetries) return { action: 'give-up', baseRevision: base, reason: 'retries-exhausted' };
      retries.set(id, used + 1);
      return { action: 'retry', baseRevision: base };
    },

    retryCount(pluginId) {
      return retries.get(normalizePluginId(pluginId)) ?? 0;
    },

    reset() {
      revisions.clear();
      pending.clear();
      retries.clear();
    },

    snapshot() {
      const out: Record<string, PluginRevisionState> = {};
      for (const [id, revision] of revisions) {
        out[id] = { revision, pendingLocalWrites: pendingOf(id) };
      }
      // Plugins mit offenem Schreibvorgang, aber noch nie bestaetigter Revision,
      // fehlen sonst in der Diagnose.
      for (const [id, inFlight] of pending) {
        if (!out[id]) out[id] = { revision: 0, pendingLocalWrites: inFlight };
      }
      return out;
    },
  };
}
