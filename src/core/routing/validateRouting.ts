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

/**
 * P2-4-Prüfpunkt: findet ungenutzte bzw. doppelte Pfade im Audio-Graph selbst –
 * Knoten ohne jede Verbindung, Verbindungen auf unbekannte Knoten und
 * mehrfach vorhandene Kanten.
 */
export function findUnusedGraphPaths(graph: GraphStateLike): string[] {
  const problems: string[] = [];
  const nodeIds = new Set((graph.nodes ?? []).map((n) => n.id));
  const connected = new Set<string>();
  const seen = new Set<string>();

  for (const c of graph.connections ?? []) {
    const key = `${c.source}->${c.target}`;
    if (seen.has(key)) problems.push(`doppelter Verbindungs-Pfad '${key}' im Audio-Graph`);
    seen.add(key);
    if (!nodeIds.has(c.source)) problems.push(`Verbindung '${key}' zeigt auf unbekannten Quell-Node '${c.source}'`);
    if (!nodeIds.has(c.target)) problems.push(`Verbindung '${key}' zeigt auf unbekannten Ziel-Node '${c.target}'`);
    connected.add(c.source);
    connected.add(c.target);
  }

  for (const id of nodeIds) {
    if (!connected.has(id)) problems.push(`ungenutzter Node '${id}' im Audio-Graph (keine Verbindung)`);
  }

  return problems;
}
