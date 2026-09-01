/**
 * audioMONASTRY · Routing-Validierung (P2-4)
 * ===========================================
 * Vergleicht eine routing.json-Beschreibung mit einem exportierten
 * AudioGraphState und liefert eine Liste von Differenzen.
 */

export interface RoutingNodeLike {
  id: string;
  type?: string;
}

export interface RoutingConnectionLike {
  source: string;
  target: string;
}

export interface RoutingJsonLike {
  nodes?: RoutingNodeLike[];
  connections?: RoutingConnectionLike[];
}

export interface GraphStateLike {
  nodes?: Array<{ id: string; type?: string }>;
  connections?: Array<{ source: string; target: string }>;
}

export function validateRoutingAgainstGraph(routing: RoutingJsonLike, graph: GraphStateLike): string[] {
  const errors: string[] = [];
  const graphNodeIds = new Set((graph.nodes ?? []).map((n) => n.id));
  const graphConns = new Set((graph.connections ?? []).map((c) => `${c.source}->${c.target}`));

  for (const n of routing.nodes ?? []) {
    if (!graphNodeIds.has(n.id)) errors.push(`routing node '${n.id}' fehlt im Audio-Graph`);
  }
  for (const c of routing.connections ?? []) {
    if (!graphConns.has(`${c.source}->${c.target}`)) {
      errors.push(`routing connection '${c.source}->${c.target}' fehlt im Audio-Graph`);
    }
  }
  // Doppelte Verbindungen erkennen
  const seen = new Set<string>();
  for (const c of routing.connections ?? []) {
    const key = `${c.source}->${c.target}`;
    if (seen.has(key)) errors.push(`doppelte Verbindung '${key}' in routing.json`);
    seen.add(key);
  }
  return errors;
}
