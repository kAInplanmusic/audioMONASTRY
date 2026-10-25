/**
 * audioMONASTRY · Automation Transport Bridge (ZUK-005)
 * ======================================================
 * Verbindet die `AutomationTimeline` (über den `V2NodeAutomationCoalescer`)
 * mit dem Audio-Transport. Liefert pro Tick die Lane-Werte an die Parameter.
 *
 * Reine Funktionen / Klasse ohne DOM / AudioContext / Tone.js – offline testbar.
 */
import type { V2NodeAutomationCoalescer } from './v2NodeAutomation';

/**
 * Bridge-Konfiguration.
 */
export interface AutomationTransportBridgeOptions {
  /** Der Coalescer, der die Timeline hält und auf die Nodes anwendet. */
  coalescer: V2NodeAutomationCoalescer;
  /**
   * Monotonie-Schwelle in Sekunden. Wenn der neue Transport-Zeitwert
   * um mehr als `maxBackwardSec` RÜCKWÄRTS springt, wird der Tick ignoriert.
   * Default: 0 (jeder Rückwärtssprung wird verworfen).
   * Bei 0.01 (10 ms) würde ein kleiner Jitter toleriert.
   */
  maxBackwardSec?: number;
}

/**
 * Ergebnis eines `tick()`-Aufrufs.
 */
export interface AutomationTransportBridgeResult {
  /** Anzahl der Parameter, denen ein Lane-Wert zugewiesen wurde (>= 0). */
  applied: number;
  /** Der Transport-Zeitwert, der verwendet wurde (nach Clamping/Guard). */
  transportSec: number;
  /** `true`, wenn der Tick wegen Monotonie-Guard verworfen wurde. */
  rejected: boolean;
}

/**
 * Transport-Brücke für Automations-Lanes.
 *
 * - Hält den letzten akzeptierten Transport-Zeitwert (monotonic guard).
 * - Ruft pro Tick `coalescer.applyAtTime(transportSec)` auf.
 * - Liefert Anzahl der erreichten Parameter zurück.
 * - Hard No-Op, wenn keine Timeline / keine Lanes existieren.
 */
export class AutomationTransportBridge {
  private readonly coalescer: V2NodeAutomationCoalescer;
  private readonly maxBackwardSec: number;
  private lastAcceptedTimeSec = -Infinity;
  private isInitialized = false;

  constructor(options: AutomationTransportBridgeOptions) {
    this.coalescer = options.coalescer;
    this.maxBackwardSec = options.maxBackwardSec ?? 0;
  }

  /**
   * Setzt den Monotonie-Guard zurück (z. B. beim Transport-Neustart,
   * Seek, Loop). Danach wird der nächste `tick()` immer akzeptiert.
   */
  reset(): void {
    this.lastAcceptedTimeSec = -Infinity;
    this.isInitialized = false;
  }

  /**
   * Führt einen Transport-Tick aus.
   *
   * @param transportSec Aktuelle Transport-Position in Sekunden (>= 0).
   * @returns Wie viele Parameter einen Lane-Wert erhielten, und ob der Tick akzeptiert wurde.
   */
  tick(transportSec: number): AutomationTransportBridgeResult {
    // Harte Validierung: Transport-Zeit muss endlich und >= 0 sein.
    if (!Number.isFinite(transportSec) || transportSec < 0) {
      return { applied: 0, transportSec: 0, rejected: true };
    }

    // Monotonie-Guard: Keine älteren Zeiten nach neueren akzeptieren.
    // Ausnahme: Erster Tick nach reset() / Konstruktor (lastAcceptedTimeSec = -Infinity).
    if (this.isInitialized) {
      const backwardJump = this.lastAcceptedTimeSec - transportSec;
      if (backwardJump > this.maxBackwardSec) {
        // Zeit sprang zurück (Seek, Loop, Jitter > Schwelle) → Tick verwerfen.
        return {
          applied: 0,
          transportSec,
          rejected: true,
        };
      }
    }

    // Timeline vorhanden? Wenn nicht: harter No-Op (V2-Parität unberührt).
    const timeline = this.coalescer.timeline;
    if (!timeline) {
      this.lastAcceptedTimeSec = transportSec;
      this.isInitialized = true;
      return { applied: 0, transportSec, rejected: false };
    }

    // Gibt es überhaupt Lanes?
    let hasLanes = false;
    timeline.forEachLane(() => {
      hasLanes = true;
    });
    if (!hasLanes) {
      this.lastAcceptedTimeSec = transportSec;
      this.isInitialized = true;
      return { applied: 0, transportSec, rejected: false };
    }

    // Lane-Werte zum aktuellen Transport-Zeitpunkt anwenden.
    const applied = this.coalescer.applyAtTime(transportSec);

    this.lastAcceptedTimeSec = transportSec;
    this.isInitialized = true;

    return { applied, transportSec, rejected: false };
  }

  /** Liefert den letzten akzeptierten Transport-Zeitwert (für Tests/Diagnose). */
  getLastAcceptedTime(): number {
    return this.lastAcceptedTimeSec;
  }

  /** Prüft, ob der Bridge ein Timeline-Coalescer zugrunde liegt. */
  hasTimeline(): boolean {
    return this.coalescer.timeline !== null;
  }
}

/**
 * Factory für schnelle Instanziierung (optional, für Tests bequem).
 */
export function createAutomationTransportBridge(
  coalescer: V2NodeAutomationCoalescer,
  maxBackwardSec = 0,
): AutomationTransportBridge {
  return new AutomationTransportBridge({ coalescer, maxBackwardSec });
}