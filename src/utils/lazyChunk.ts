import { createContext, createElement, lazy, useContext, type ComponentProps, type ComponentType, type LazyExoticComponent } from 'react';

/**
 * UI-2026-11-06-001 · Nachladen von Modul-Chunks mit Netz-Aussetzern
 * =================================================================
 * Bisher kam ein `lazy(() => import(...))` mit GENAU EINEM Ladeversuch aus.
 * Fiel das Netz fuer einen Sekundenbruchteil weg (WLAN-Wechsel, Tunnel,
 * Server-Neustart), wurde der Chunk-Import sofort abgelehnt - und React
 * merkt sich diese Ablehnung fuer die gesamte Lebensdauer der
 * `lazy`-Instanz. Der "RETRY"-Knopf der Fehlergrenze setzte nur `hasError`
 * zurueck, warf beim naechsten Render aber sofort denselben Fehler: der
 * Ausweg war eine Attrappe.
 *
 * Dieser Helfer behebt beides:
 *  1. `importChunkWithRetry` versucht den Import mehrfach mit exponentiellem
 *     Backoff (250 ms → 500 ms → 1000 ms, gekappt bei 2 s). Ein kurzer
 *     Aussetzer kostet damit Sekundenbruchteile statt der Modul-UI.
 *  2. `lazyWithRetry` legt die `lazy`-Instanz in einem Cache ab, dessen
 *     Schluessel den Wiederherstellungsversuch der Fehlergrenze enthaelt
 *     (`ModuleBoundaryAttemptContext`). Ein RETRY (oder das `online`-Event in
 *     `SafeModuleBoundary`) erhoeht den Versuch → neue `lazy`-Instanz →
 *     echter neuer Ladeversuch, ohne Reload der Seite.
 *
 * Warum kein `useRef`/`useMemo` fuer die `lazy`-Instanz? Beim ERSTEN Mount
 * verwirft React den Render, sobald eine Komponente suspendiert - Hook-State
 * aus diesem Render existiert danach nicht mehr. Jeder neue Versuch haette
 * dann wieder eine frische `lazy`-Instanz erzeugt, die erneut suspendiert:
 * die Modul-UI blieb dauerhaft auf dem Suspense-Fallback stehen (gemessen).
 * Der Cache lebt deshalb ausserhalb des Renders.
 */

/** Versuch der umgebenden Modul-Fehlergrenze (0 = erster Anlauf). */
export const ModuleBoundaryAttemptContext = createContext(0);

export interface ChunkRetryOptions {
  /** Zusaetzliche Versuche NACH dem ersten (Default 3 → 4 Ladeversuche). */
  retries?: number;
  /** Wartezeit vor dem 2. Versuch; verdoppelt sich je weiterem Versuch. */
  baseDelayMs?: number;
  /** Obergrenze der Wartezeit zwischen zwei Versuchen. */
  maxDelayMs?: number;
  /** Eindeutiger Name: Cache-Schluessel und React-DevTools-Anzeige. */
  name?: string;
}

const DEFAULT_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 2_000;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Chunk-URL aus der Fehlermeldung eines gescheiterten `import()`.
 *
 * Chromium/Firefox melden "Failed to fetch dynamically imported module: <url>";
 * die URL ist der einzige Weg, den Chunk erneut anzufordern. Wichtig, weil der
 * Browser einen fehlgeschlagenen Modul-Fetch in der Module-Map mit `null`
 * festhaelt (HTML-Spezifikation): derselbe Spezifizierer scheitert fuer den
 * Rest der Seite SOFORT erneut, ohne noch einmal zu laden - gemessen mit
 * `tests`-Probe gegen den Dev-Server. Nur eine andere URL (Query-Parameter)
 * umgeht diesen Cache.
 */
const CHUNK_URL_PATTERN = /(?:dynamically imported module|module script)[^:]*:\s*(https?:\/\/\S+)/i;

export function chunkUrlFromError(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const match = message.match(CHUNK_URL_PATTERN);
  if (!match) return null;
  // Satzzeichen am Ende der Meldung abschneiden.
  return match[1].replace(/[),.;]+$/, '');
}

/**
 * Fortlaufender Zaehler fuer den Cache-Buster. Bewusst GLOBAL eindeutig und
 * nicht je Ladeversuch neu bei 1 beginnend: der Browser merkt sich JEDE
 * gescheiterte Chunk-URL. Wuerde ein spaeterer Wiederherstellungsversuch
 * dieselbe Query erneut verwenden, traefe er sofort den alten Fehler-Cache.
 */
let retryToken = 0;

/** Haengt einen Cache-Buster an die Chunk-URL (Umgehung der Module-Map). */
export function withRetryParam(url: string): string {
  retryToken += 1;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('am-chunk-retry', String(retryToken));
    return parsed.href;
  } catch {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}am-chunk-retry=${retryToken}`;
  }
}

/**
 * Laedt ein Modul-Chunk mit Retry + exponentiellem Backoff.
 * Der letzte Fehler wird weitergereicht, damit die Fehlergrenze ihn zeigt.
 */
export async function importChunkWithRetry<T>(
  load: () => Promise<T>,
  options: ChunkRetryOptions = {},
): Promise<T> {
  const retries = Math.max(0, options.retries ?? DEFAULT_RETRIES);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);

  // Erster Versuch: der buendler-sichtbare, statische Import. Ab dem zweiten
  // Versuch wird die Chunk-URL aus dem Fehler wiederverwendet (siehe oben) -
  // ein erneutes `load()` wuerde am Module-Map-Cache sofort scheitern.
  let chunkUrl: string | null = null;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      if (attempt === 0 || !chunkUrl) {
        return await load();
      }
      const url = withRetryParam(chunkUrl);
      return await (import(/* @vite-ignore */ url) as Promise<T>);
    } catch (error) {
      lastError = error;
      chunkUrl = chunkUrlFromError(error) ?? chunkUrl;
      if (attempt === retries) break;
      await delay(Math.min(baseDelayMs * 2 ** attempt, maxDelayMs));
    }
  }
  throw lastError;
}

/** `lazy`-Instanzen je (Loader, Wiederherstellungsversuch). */
const lazyInstances = new Map<string, LazyExoticComponent<ComponentType<any>>>();
let lazySequence = 0;

/**
 * Wie `lazy()`, aber mit Retry/Backoff und einem RETRY, das wirklich neu laedt.
 *
 * `pick` waehlt die Komponente aus dem Modul (die bisherigen Loader nutzten
 * `.then(m => ({ default: m.X }))`). Es wird fuer ALLE Versuche benutzt - auch
 * fuer den Cache-Buster-Nachladeversuch, der das Modul als rohes
 * Namespace-Objekt liefert (ohne `default`).
 */
export function lazyWithRetry<T extends ComponentType<any>>(
  load: () => Promise<unknown>,
  pick: (module: any) => T,
  options: ChunkRetryOptions = {},
): ComponentType<ComponentProps<T>> {
  const id = options.name ?? `lazyModule${(lazySequence += 1)}`;

  function LazyWithRetry(props: ComponentProps<T>) {
    // Versuch der umgebenden Fehlergrenze: steigt bei jedem RETRY / online-Event.
    const attempt = useContext(ModuleBoundaryAttemptContext);
    const cacheKey = `${id}#${attempt}`;

    let Component = lazyInstances.get(cacheKey);
    if (!Component) {
      Component = lazy(async () => ({ default: pick(await importChunkWithRetry(load, options)) }));
      lazyInstances.set(cacheKey, Component);
    }
    return createElement(Component, props);
  }

  LazyWithRetry.displayName = options.name ? `Lazy(${options.name})` : 'LazyModule';
  return LazyWithRetry;
}
