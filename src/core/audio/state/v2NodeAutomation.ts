/**
 * audioMONASTRY · V2 Node Automation (Phase 5)
 * ============================================
 * Bindet den bestehenden `AutomationCoalescer` an backend-unabhängige V2-Nodes.
 *
 * V2-Nodes besitzen `AudioParameter`-Objekte. Dieses Modul erlaubt es,
 * hochfrequente Automation (`push`) zu bündeln und nach Ablauf des Intervalls
 * gezielt auf `node.getParameter(paramId)` anzuwenden – ohne dass die
 * Audio-Engine oder die UI die Node-Implementierung kennen muss.
 *
 * ZUK-005: Optional kann eine `AutomationTimeline` mitgegeben werden. Dann
 * liest der Coalescer den Wert aus der Lane zum Transport-Zeitpunkt
 * (`pushAtTime`, `applyAtTime`) statt eines konstanten Werts. Die bestehende
 * API (`push`, `flushNow`, `dispose`) bleibt unverändert: ohne Timeline
 * verhält sich das Modul exakt wie vorher.
 */
import { AutomationCoalescer } from './automationCoalescer';
import type { AutomationTimeline } from './automationTimeline';
import type { IAudioNode, IAudioParameter } from '../types';

/** V2-Node, dessen Parameter über einen sprechenden Param-ID automatisierbar sind. */
export interface AutomatableV2Node extends IAudioNode {
  getParameter(paramId: string): IAudioParameter | undefined;
}

export interface V2NodeAutomationOptions {
  intervalMs?: number;
  /**
   * Optionale Automations-Timeline (ZUK-005). Ist sie gesetzt, können
   * Aufrufer Lane-Werte zum Transport-Zeitpunkt anwenden. Fehlt sie, ist das
   * Verhalten identisch zu vorher (konstante Werte über `push`).
   */
  timeline?: AutomationTimeline;
}

export class V2NodeAutomationCoalescer {
  private readonly coalescer: AutomationCoalescer;
  /** Timeline mit den Lanes (ZUK-005); `null` = reiner Konstanten-Betrieb. */
  readonly timeline: AutomationTimeline | null;

  constructor(
    private readonly nodes: ReadonlyMap<string, AutomatableV2Node>,
    options: V2NodeAutomationOptions = {},
  ) {
    const intervalMs = options.intervalMs ?? 16;
    this.timeline = options.timeline ?? null;
    this.coalescer = new AutomationCoalescer((key, payload) => {
      const sep = key.indexOf('::');
      if (sep < 0) return;
      const nodeId = key.slice(0, sep);
      const paramId = key.slice(sep + 2);
      const node = this.nodes.get(nodeId);
      const param = node?.getParameter(paramId);
      if (!param) return;
      const value = Number(payload);
      if (!Number.isFinite(value)) return;
      param.setValue(value);
    }, intervalMs);
  }

  /** Meldet einen Parameterwert für die nächste gebündelte Automation an. */
  push(nodeId: string, paramId: string, value: number): void {
    this.coalescer.push(`${nodeId}::${paramId}`, value);
  }

  /**
   * ZUK-005 · Wert der Lane für `(nodeId, paramId)` zum Zeitpunkt `timeSec`.
   * `null`, wenn keine Timeline gesetzt ist oder keine Lane existiert – dann
   * gilt weiterhin der konstante Parameterwert.
   */
  readAutomationValue(nodeId: string, paramId: string, timeSec: number): number | null {
    if (!this.timeline) return null;
    if (!Number.isFinite(timeSec)) return null;
    return this.timeline.evaluateAt(nodeId, paramId, timeSec);
  }

  /**
   * ZUK-005 · Wie `push`, aber der Wert kommt aus der Lane zum Zeitpunkt
   * `timeSec` statt aus einem konstanten Argument. Existiert keine Lane, wird
   * `fallbackValue` verwendet (wenn angegeben) – ohne Lane und ohne Fallback
   * passiert nichts und die Methode liefert `false`.
   */
  pushAtTime(nodeId: string, paramId: string, timeSec: number, fallbackValue?: number): boolean {
    const laneValue = this.readAutomationValue(nodeId, paramId, timeSec);
    let value: number;
    if (laneValue !== null) {
      value = laneValue;
    } else if (fallbackValue !== undefined && Number.isFinite(fallbackValue)) {
      value = fallbackValue;
    } else {
      return false;
    }
    this.push(nodeId, paramId, value);
    return true;
  }

  /**
   * ZUK-005 · Transport-Tick: schreibt für jede Lane, deren Node und Parameter
   * im Graphen existieren, den Wert zum Zeitpunkt `timeSec` in den Coalescer.
   * Rückgabe: Anzahl der angestoßenen Parameter (0 = keine Timeline/Lanes).
   *
   * Der Flush bleibt beim Coalescer (Bündelung), damit ein 60-Hz-Transport
   * nicht mehr Port-/Parameter-Updates erzeugt als die Engine verträgt.
   */
  applyAtTime(timeSec: number): number {
    const timeline = this.timeline;
    if (!timeline || !Number.isFinite(timeSec)) return 0;
    let applied = 0;
    timeline.forEachLane((nodeId, paramId) => {
      if (!this.nodes.get(nodeId)?.getParameter(paramId)) return;
      const value = timeline.evaluateAt(nodeId, paramId, timeSec);
      if (value === null) return;
      this.push(nodeId, paramId, value);
      applied++;
    });
    return applied;
  }

  /** Sofort alle ausstehenden Automationen anwenden. */
  flushNow(): void {
    this.coalescer.flushNow();
  }

  dispose(): void {
    this.coalescer.dispose();
  }
}
