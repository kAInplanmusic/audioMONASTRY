import { Readable } from 'node:stream';
import type { ServerResponse } from 'node:http';

/**
 * Upstream-Body (R2) an die Antwort streamen — ohne den Prozess zu riskieren.
 *
 * PROD-BEFUND 2026-11-05: `Readable.fromWeb(body).pipe(res)` hat keinen
 * 'error'-Handler. Bricht der Client mitten im Stream ab (Tab zu, `video`-Seek,
 * Netz weg), feuert `res.on('close')` den AbortController der Route; der
 * Upstream-Body endet dann mit `AbortError`, das Readable emittiert 'error' —
 * unbehandelt, und Node beendet den GESAMTEN Prozess. Gemessen an
 * `node dist/server.cjs`: eine einzige abgebrochene Range-Anfrage auf
 * `/api/ai/vision/bank/m01a` beendete den Server (erst `Connection reset`,
 * danach `Connection refused` auf allen Routen inkl. `/api/health`).
 *
 * Deshalb hier: 'error' wird abgefangen und beendet nur diese eine Antwort,
 * und beim Schliessen der Antwort wird der Lese-Strom abgeraeumt. Der Aufrufer
 * bekommt `false`, wenn der Body fehlte (dann hat der Helfer `res.end()` schon
 * erledigt) — sonst `true`, damit die Route weiss, dass sie fertig ist.
 */
export function pipeUpstreamBody(
  body: ReadableStream<Uint8Array> | null | undefined,
  res: ServerResponse,
): boolean {
  if (!body) {
    res.end();
    return false;
  }

  const stream = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);

  // Ein Fehler im Lese-Strom ist ein Client-/Netz-Ereignis, kein Prozess-Notfall.
  stream.on('error', () => {
    if (!res.writableEnded) res.destroy();
  });
  // Antwort zu (Client weg, Timeout): Lese-Strom freigeben, damit der
  // AbortController den Upstream nicht ewig offen haelt.
  res.on('close', () => {
    if (!stream.destroyed) stream.destroy();
  });
  // `pipe` schliesst `res` am Ende; ein Fehler kommt ueber den Handler oben.
  stream.pipe(res);
  return true;
}
