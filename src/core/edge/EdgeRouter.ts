/**
 * audioMONASTRY · 7.2.2 – Edge-Routing (Anycast/Latenz-Auswahl)
 * =============================================================
 * Wählt den nächstgelegenen Edge-Knoten anhand gemessener Latenz und
 * deklariert Standby-Knoten für Failover.
 */
export interface EdgeNode {
  id: string;
  url: string;
  region: string;
  /** Zuletzt gemessene Latenz in ms. */
  latencyMs: number;
  healthy: boolean;
}

export class EdgeRouter {
  private nodes: EdgeNode[] = [];

  register(node: EdgeNode): void {
    const idx = this.nodes.findIndex((n) => n.id === node.id);
    if (idx >= 0) this.nodes[idx] = node;
    else this.nodes.push(node);
  }

  /** Pingt alle Knoten (HTTP-HEAD mit Timeout) und aktualisiert die Latenzen. */
  async measureLatencies(timeoutMs = 2000): Promise<void> {
    await Promise.all(this.nodes.map(async (node) => {
      const started = performance.now();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        await fetch(node.url, { method: 'HEAD', signal: controller.signal });
        clearTimeout(timer);
        node.latencyMs = performance.now() - started;
        node.healthy = true;
      } catch {
        node.latencyMs = Number.POSITIVE_INFINITY;
        node.healthy = false;
      }
    }));
  }

  /** Wählt den schnellsten gesunden Knoten (Anycast-Prinzip). */
  selectActive(): EdgeNode | null {
    const healthy = this.nodes.filter((n) => n.healthy && Number.isFinite(n.latencyMs));
    if (!healthy.length) return null;
    return healthy.reduce((best, n) => (n.latencyMs < best.latencyMs ? n : best), healthy[0]);
  }

  /** Standby-Kette: alle anderen gesunden Knoten, nach Latenz sortiert. */
  selectStandby(): EdgeNode[] {
    return this.nodes
      .filter((n) => n.healthy && Number.isFinite(n.latencyMs))
      .sort((a, b) => a.latencyMs - b.latencyMs)
      .slice(1);
  }

  list(): EdgeNode[] {
    return [...this.nodes];
  }
}

export const edgeRouter = new EdgeRouter();
