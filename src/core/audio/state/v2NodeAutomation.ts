/**
 * audioMONASTRY · V2 Node Automation (Phase 5)
 * ============================================
 * Bindet den bestehenden `AutomationCoalescer` an backend-unabhängige V2-Nodes.
 *
 * V2-Nodes besitzen `AudioParameter`-Objekte. Dieses Modul erlaubt es,
 * hochfrequente Automation (`push`) zu bündeln und nach Ablauf des Intervalls
 * gezielt auf `node.getParameter(paramId)` anzuwenden – ohne dass die
 * Audio-Engine oder die UI die Node-Implementierung kennen muss.
 */
import { AutomationCoalescer } from './automationCoalescer';
import type { IAudioNode, IAudioParameter } from '../types';

/** V2-Node, dessen Parameter über einen sprechenden Param-ID automatisierbar sind. */
export interface AutomatableV2Node extends IAudioNode {
  getParameter(paramId: string): IAudioParameter | undefined;
}

export interface V2NodeAutomationOptions {
  intervalMs?: number;
}

export class V2NodeAutomationCoalescer {
  private readonly coalescer: AutomationCoalescer;

  constructor(
    private readonly nodes: ReadonlyMap<string, AutomatableV2Node>,
    options: V2NodeAutomationOptions = {},
  ) {
    const intervalMs = options.intervalMs ?? 16;
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

  /** Sofort alle ausstehenden Automationen anwenden. */
  flushNow(): void {
    this.coalescer.flushNow();
  }

  dispose(): void {
    this.coalescer.dispose();
  }
}
