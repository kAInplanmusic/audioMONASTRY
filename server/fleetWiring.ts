/**
 * audioMONASTRY · Flotten-Verdrahtung (ARCH-P2-002)
 * =====================================================================
 * Beim Start holt die App die Adressen der Flotten-Knoten vom Portal-Worker
 * (`/api/fleet-map`, geschützt über den Studio-Token) und überschreibt damit die
 * Default-/Env-Ziele. Reihenfolge bewusst: explizit gesetzt (Env) > Flotten-Map >
 * interner Default.
 *
 * Bis hierher lag das als modulweiter Zustand (`fleetTargets`, `FLEET_MAP_URL`)
 * in server.ts; jetzt ist es ein Objekt mit genau einer Aufgabe. Die Ziele
 * werden als **Getter** veröffentlicht: eine Wertkopie würde die Ziele einfrieren
 * und die Verdrahtung still wirkungslos machen (genau dieser Fehler ist bei einer
 * früheren Extraktion in dieser Datei schon einmal passiert).
 */
export interface FleetTargets {
  masterPlayer: string;
  ollama: string;
  stemAi: string;
}

export interface FleetWiring {
  readonly targets: FleetTargets;
  /** Holt die Flotten-Map und aktualisiert die Ziele (best effort). */
  wire(): Promise<void>;
}

/** S-9: Fleet-Map-URL validieren (https-only, sonst Default). */
export function resolveFleetMapUrl(raw = process.env.FLEET_MAP_URL): string {
  let url = 'https://anunnakitools.de/api/fleet-map';
  try {
    const u = new URL(String(raw || '').trim() || url);
    if (u.protocol === 'https:') url = u.toString();
  } catch { /* Default behalten */ }
  return url;
}

/** Validiert einen Fleet-Knoten (Hostname/IP, optional :port) gegen SSRF-/Injection-Werte. */
export function buildFleetTarget(raw: unknown, defaultPort: number): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value || value.length > 255) return '';
  if (/[\s/@\\?&#]/.test(value)) return '';
  const withoutScheme = value.replace(/^https?:\/\//i, '');
  const portIndex = withoutScheme.lastIndexOf(':');
  let host = withoutScheme;
  let port = defaultPort;
  if (portIndex !== -1) {
    const portPart = withoutScheme.slice(portIndex + 1);
    if (!/^\d{1,5}$/.test(portPart)) return '';
    host = withoutScheme.slice(0, portIndex);
    port = Number(portPart);
  }
  if (!host || host.length > 253) return '';
  // Hostname oder IPv4, keine Wildcards/Unterstriche/Pfade.
  if (!/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return '';
  if (port < 1 || port > 65535) return '';
  return `http://${host}:${port}`;
}

/**
 * NOMEN-P1-001: Die Flotte heisst `audiomonastry-*`. Die Fleet-Map ist nach dem
 * Server-/Firewall-Namen verschluesselt, und eine LAUFENDE Installation kann noch
 * die alten Namen tragen (der Portal-Worker bildet sie inzwischen auf den neuen
 * Namen ab, aber nicht jede Installation ist aktualisiert). Deshalb: neuer Name
 * zuerst, Altname als Fallback - so verdrahten sich beide Flotten.
 */
const FLEET_LEGACY_NAME_PREFIX = 'samplemonk-';

export function fleetNodeAddress(
  map: Record<string, string>,
  node: string,
): string | undefined {
  const direct = map[node];
  if (direct) return direct;
  const legacy = node.startsWith('audiomonastry-')
    ? `${FLEET_LEGACY_NAME_PREFIX}${node.slice('audiomonastry-'.length)}`
    : '';
  return legacy ? map[legacy] : undefined;
}

export function createFleetWiring(options: {
  fleetMapUrl?: string;
  studioToken?: string;
  fleetOllamaPort?: number;
  log?: (message: string) => void;
  warn?: (message: string, error?: unknown) => void;
} = {}): FleetWiring {
  const log = options.log ?? ((message: string) => console.log(message));
  const warn = options.warn ?? ((message: string, error?: unknown) => console.warn(message, error ?? ''));
  const targets: FleetTargets = { masterPlayer: '', ollama: '', stemAi: '' };
  return {
    get targets() { return targets; },
    async wire(): Promise<void> {
      const token = (options.studioToken ?? process.env.STUDIO_ACCESS_TOKEN ?? '').trim();
      if (!token) return; // Lokal/Test: keine Flotten-Verdrahtung.
      try {
        const resp = await fetch(options.fleetMapUrl ?? resolveFleetMapUrl(), {
          headers: { 'x-studio-token': token },
          signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok) return;
        const data = (await resp.json()) as { fleet?: Record<string, string> };
        const f = data.fleet ?? {};
        const masterTarget = buildFleetTarget(fleetNodeAddress(f, 'audiomonastry-master-1'), 8000);
        if (masterTarget) targets.masterPlayer = masterTarget;
        const aiTarget = buildFleetTarget(fleetNodeAddress(f, 'audiomonastry-ai-1'), 8000);
        if (aiTarget) {
          const ollamaPort = Number(options.fleetOllamaPort ?? process.env.FLEET_OLLAMA_PORT ?? 11434);
          const ollamaTarget = buildFleetTarget(
            fleetNodeAddress(f, 'audiomonastry-ai-1'),
            Number.isFinite(ollamaPort) ? ollamaPort : 11434,
          );
          targets.ollama = ollamaTarget || '';
          targets.stemAi = aiTarget;
        }
        log(`[fleet] Knoten verdrahtet: ${JSON.stringify({ ...targets })}`);
      } catch (e) {
        warn('[fleet] Fleet-Map nicht erreichbar:', (e as Error).message);
      }
    },
  };
}
