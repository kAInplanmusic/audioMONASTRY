/**
 * audioMONASTRY · Socket-Liveness (F8-Fix: Ghost-Sockets)
 * ======================================================
 * Befund (docs/FIXPLAN_2026-09-20_externer_apptest.md, F8): `/api/online` meldete
 * **3 Clients bei 1 echten** — nach abgebrochenen Verbindungen blieb der Zähler
 * stehen. Ursache der Bauform: ein freistehender Integer-Zähler, der bei
 * `connection` hoch- und nur im ersten `disconnect`-Handler heruntergezählt wird.
 * Jeder verlorene/nie gefeuerte Disconnect driftet damit dauerhaft nach oben.
 *
 * Dieser Baustein dreht die Richtung um:
 *
 *   1. **Der Messwert kommt aus dem Socket-Registry** (`io.sockets.sockets`), nicht
 *      aus einem Zähler. Er kann deshalb strukturell nicht driften: existiert der
 *      Socket dort nicht (oder ist `connected === false`), zählt er nicht.
 *   2. **Die Liveness-Map ist die einzige zweite Buchhaltung** — sie trägt je
 *      Socket den Zeitpunkt der letzten Aktivität (`touch`). Sie ist die Grundlage
 *      für idle-basiertes Trennen, ersetzt den früheren Timer PRO Verbindung
 *      (dessen Refresh-Pfade an 20 Stellen hingen) und wird bei jedem Sweep gegen
 *      das Registry abgeglichen: Einträge ohne Registry-Socket sind **Geister**
 *      und werden entfernt.
 *   3. **Der Sweep ist intervallgetrieben** (`setInterval`, `unref()`), kein
 *      Busy-Loop: pro Lauf EINE Auswertung, höchstens einmal je Idle-Zeit ein
 *      `disconnect` pro Socket (`forceRetryMs` verhindert Wiederholungs-Hämmern
 *      an einem Socket, der sich nicht trennen lässt).
 *
 * Alles ist rein und mit Stub-Sockets testbar (`evaluateSocketLiveness`) bzw. über
 * injizierte Getter/Disconnect-Callbacks ohne Netz prüfbar
 * (`createSocketLivenessMonitor`, siehe tests/socketLiveness.test.ts).
 */

/** Sicht auf einen Socket im Socket.io-Registry (Stub-fähig). */
export interface SocketRegistryView {
  id: string;
  /** `false` = getrennt; `true`/`undefined` = im Registry als verbunden geführt. */
  connected?: boolean;
}

/** Buchhaltung je Socket: wann war er zuletzt aktiv, wann wurde er zuletzt getrennt? */
export interface SocketLivenessEntry {
  id: string;
  lastSeenAt: number;
  /** Zeitpunkt eines erzwungenen Disconnects (verhindert Wiederholungs-Hämmern). */
  forcedAt?: number;
}

export interface SocketLivenessEvaluation {
  /** Der Messwert: Sockets, die im Registry wirklich verbunden sind. */
  online: number;
  /** Liveness-Einträge ohne Registry-Socket → Reste abgebrochener Verbindungen. */
  ghosts: string[];
  /** Registry-Sockets jenseits des Idle-Timeouts → Kandidaten für Disconnect. */
  idle: string[];
  /** Registry-Sockets ohne Liveness-Eintrag (zählen als online, ohne Idle-Frist). */
  unattached: string[];
}

export interface SocketLivenessEvaluateInput {
  now: number;
  idleTimeoutMs: number;
  registry: Iterable<SocketRegistryView>;
  liveness: Iterable<SocketLivenessEntry>;
  /**
   * Wartezeit, bevor derselbe Socket erneut zwangsgetrennt wird. Default =
   * `idleTimeoutMs` (ein weiteres volles Idle-Fenster), damit ein Socket, der auf
   * `disconnect` nicht reagiert, nicht im Sekundentakt getrennt wird.
   */
  forceRetryMs?: number;
}

/**
 * Reine Auswertung: Registry ist die Wahrheit über "verbunden", die Liveness-Map
 * nur über "zuletzt aktiv". Keine Seiteneffekte.
 */
export function evaluateSocketLiveness(input: SocketLivenessEvaluateInput): SocketLivenessEvaluation {
  const forceRetryMs = Math.max(0, Number(input.forceRetryMs ?? input.idleTimeoutMs));
  const entries = new Map<string, SocketLivenessEntry>();
  for (const entry of input.liveness) entries.set(entry.id, entry);

  const live = new Set<string>();
  const ghosts: string[] = [];
  const idle: string[] = [];
  const unattached: string[] = [];
  let online = 0;

  for (const socket of input.registry) {
    if (!socket?.id || socket.connected === false) continue;
    live.add(socket.id);
    online += 1;
    const entry = entries.get(socket.id);
    if (!entry) {
      unattached.push(socket.id);
      continue;
    }
    if (input.now - entry.lastSeenAt <= input.idleTimeoutMs) continue;
    const forcedRecently = entry.forcedAt !== undefined && input.now - entry.forcedAt < forceRetryMs;
    if (!forcedRecently) idle.push(socket.id);
  }

  for (const id of entries.keys()) {
    if (!live.has(id)) ghosts.push(id);
  }

  return { online, ghosts, idle, unattached };
}

export interface SocketLivenessMonitorDeps {
  /** Aktueller Socket.io-Zustand (`io.sockets.sockets.values()`). */
  getRegistry: () => Iterable<SocketRegistryView>;
  /** Trennt einen Socket hart (`socket.disconnect(true)`). */
  disconnect: (id: string) => void;
  idleTimeoutMs: number;
  sweepIntervalMs: number;
  forceRetryMs?: number;
  now?: () => number;
  onSweep?: (result: SocketLivenessEvaluation) => void;
  log?: (message: string) => void;
}

export interface SocketLivenessMonitor {
  attach(id: string, now?: number): void;
  touch(id: string, now?: number): void;
  detach(id: string): void;
  /** Auswertung ohne Seiteneffekte (Messwert für /api/online). */
  evaluate(): SocketLivenessEvaluation;
  /** Auswertung MIT Seiteneffekten: Geister entfernen, Idle-Sockets trennen. */
  sweep(): SocketLivenessEvaluation;
  /** Der veröffentlichte Messwert (Registry-Wahrheit, driftfrei). */
  online(): number;
  /** Anzahl geführter Liveness-Einträge (Diagnose/Tests). */
  entryCount(): number;
  lastEvaluation(): SocketLivenessEvaluation | null;
  start(): void;
  stop(): void;
}

/**
 * Laufzeit-Hülle: hält die Liveness-Map, den Sweep-Timer und den Messwert.
 * Bewusst ohne Kenntnis von socket.io — alles kommt über die Getter/Callbacks.
 */
export function createSocketLivenessMonitor(deps: SocketLivenessMonitorDeps): SocketLivenessMonitor {
  const readNow = deps.now ?? (() => Date.now());
  const idleTimeoutMs = Math.max(1, Number(deps.idleTimeoutMs) || 1);
  const sweepIntervalMs = Math.max(1, Number(deps.sweepIntervalMs) || 1);
  const liveness = new Map<string, SocketLivenessEntry>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let last: SocketLivenessEvaluation | null = null;

  const compute = (): SocketLivenessEvaluation => evaluateSocketLiveness({
    now: readNow(),
    idleTimeoutMs,
    registry: deps.getRegistry(),
    liveness: liveness.values(),
    forceRetryMs: deps.forceRetryMs,
  });

  const monitor: SocketLivenessMonitor = {
    attach(id, now = readNow()) {
      if (!id) return;
      liveness.set(id, { id, lastSeenAt: now });
    },
    touch(id, now = readNow()) {
      const entry = liveness.get(id);
      if (entry) {
        entry.lastSeenAt = now;
        return;
      }
      // Aktivität von einem Socket ohne Eintrag: anlegen statt verwerfen — sonst
      // hätte genau dieser Socket keine Idle-Frist.
      if (id) liveness.set(id, { id, lastSeenAt: now });
    },
    detach(id) {
      liveness.delete(id);
    },
    evaluate: compute,
    online() {
      return compute().online;
    },
    sweep() {
      const now = readNow();
      const result = evaluateSocketLiveness({
        now,
        idleTimeoutMs,
        registry: deps.getRegistry(),
        liveness: liveness.values(),
        forceRetryMs: deps.forceRetryMs,
      });
      // 1. Geister: Einträge, für die es keinen verbundenen Socket mehr gibt.
      //    Genau diese Reste haben den früheren Zähler dauerhaft zu hoch stehen
      //    lassen (F8: 3 statt 1).
      for (const id of result.ghosts) liveness.delete(id);
      // 2. Idle: erst markieren, dann trennen — so wird ein Socket, der auf
      //    `disconnect` nicht reagiert, nicht bei jedem Sweep erneut getrennt.
      for (const id of result.idle) {
        const entry = liveness.get(id);
        if (entry) entry.forcedAt = now;
        deps.disconnect(id);
      }
      last = result;
      deps.onSweep?.(result);
      if (result.ghosts.length > 0 || result.idle.length > 0) {
        deps.log?.(`[signaling] Socket-Sweep: online=${result.online} geister-entfernt=${result.ghosts.length} idle-getrennt=${result.idle.length}`);
      }
      return result;
    },
    entryCount: () => liveness.size,
    lastEvaluation: () => last,
    start() {
      if (timer) return;
      timer = setInterval(() => { monitor.sweep(); }, sweepIntervalMs);
      // Kein Haltepunkt für den Prozess: der Sweep ist Wartung, kein Betrieb.
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };

  return monitor;
}
