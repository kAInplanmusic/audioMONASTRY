/**
 * audioMONASTRY · JSON-Body-Grenzen und die Reihenfolge der Body-Verarbeitung
 * =====================================================================
 * AUDIT-2026-10-30-P1-005: `server.ts` montierte `express.json({ limit: '50mb' })`
 * GLOBAL und damit VOR der Auth-/Rate-Limit-Kette der `/api`-Routen. Ein
 * anonymer Client konnte also bis zu 50 MB JSON in den Parser schieben, bevor
 * irgendetwas geprueft hat, wer er ist (Speicher-/CPU-Kosten, DoS-Flaeche).
 *
 * Dieser Baustein dreht die Reihenfolge um und staffelt die Grenzen:
 *
 *   1. Aufruf erfolgt NACH Auth + Rate-Limit (siehe server.ts, Middleware-Kette).
 *   2. Ein KLEINES Default-Limit (1 MB) gilt fuer jeden JSON-Body; das deckt
 *      alle normalen Routen ab (Prompts, Metadaten, Telemetrie, Webhooks).
 *   3. Nur die Routen, die nachweislich grosse Payloads tragen, bekommen eine
 *      eigene, groessere Grenze (`LARGE_JSON_BODY_ROUTES` - die Liste nennt
 *      Grund und Zahl je Route).
 *   4. Der strukturierte Fehler-Handler (`createJsonBodyErrorHandler`) steht
 *      direkt hinter den Parsern, damit 400/413 weiter als JSON mit
 *      `requestId`/`cause` und ohne Stack antworten.
 *
 * Die Master-Routen (`/api/master/{mix,master,analyze}`, 64 MB) bringen ihren
 * eigenen Parser mit (`installMasterBodyParser` in routes/masterRoutes.ts); er
 * wird VOR diesem Modul montiert, damit die Vorpruefung ueber Content-Length
 * nicht vom 1-MB-Deckel abgefangen wird.
 *
 * Wichtig fuer neue Routen: wer einen grossen JSON-Body braucht (base64-Bild,
 * -Video, -Audio), traegt den Pfad hier ein - mit Begruendung. Ohne Eintrag
 * gilt 1 MB, und der Client bekommt 413 statt einer Chance, den Body zu senden.
 */
import express, { type Express } from 'express';
import { createJsonBodyErrorHandler, type BodyErrorLogger } from './httpBodyErrors.ts';

/** Default-Grenze fuer JSON-Bodies auf `/api` (alles ohne eigenen Eintrag). */
export const API_JSON_LIMIT_DEFAULT = '1mb';
/** Grenze der Routen mit nachweislich grossen Payloads (base64-Medien). */
export const API_JSON_LIMIT_LARGE = '50mb';
/** Grenze fuer den Session-Autosave: Umschlag mit unbegrenztem `payload`. */
export const API_JSON_LIMIT_AUTOSAVE = '10mb';

export interface LargeJsonBodyRoute {
  /** Pfad-Praefix, auf den der Parser angewendet wird. */
  path: string;
  /** Grenze genau dieser Route. */
  limit: string;
  /** Warum diese Route eine groessere Grenze braucht (Zahl aus dem Schema). */
  reason: string;
}

/**
 * Routen mit nachweislich grossen JSON-Bodies.
 *
 * Geprueft am 2026-10-30 gegen die Schemas in `shared/schemas.ts`:
 *   * `AiVideoSchema.imageBase64` erlaubt 20 000 000 Zeichen (~20 MB),
 *   * `AiShowMergeSchema` erlaubt 10 Clips x 4 000 000 Zeichen (~40 MB),
 *   * `CloudUploadJsonSchema.dataBase64` ist unbegrenzt (Audio als base64),
 *   * `SessionAutosaveEnvelopeSchema.payload` ist `z.unknown()` (Session-Snapshot
 *     mit Modulzustaenden und Audio-Graph waechst mit der Sitzung).
 *
 * Die binaeren Upload-Wege (`/api/upload/chunk/:id/:index`, `/api/cloud/upload`
 * mit `application/octet-stream`, `/api/library/search-audio`,
 * `/api/visual/frame`, `/api/upload/sample`, `/api/separate-stems`) sind NICHT
 * hier: sie bringen eigene `express.raw`-/Multipart-Parser mit und werden vom
 * JSON-Parser ohnehin nicht angefasst.
 */
export const LARGE_JSON_BODY_ROUTES: readonly LargeJsonBodyRoute[] = [
  {
    path: '/api/ai/vision/video',
    limit: API_JSON_LIMIT_LARGE,
    reason: 'AiVideoSchema.imageBase64 bis 20 MB (Bild -> Video)',
  },
  {
    path: '/api/ai/vision/show/merge',
    limit: API_JSON_LIMIT_LARGE,
    reason: 'AiShowMergeSchema: bis 10 Clips x 4 MB dataUri (~40 MB)',
  },
  {
    path: '/api/cloud/upload',
    limit: API_JSON_LIMIT_LARGE,
    reason: 'CloudUploadJsonSchema.dataBase64 (Audio als base64-JSON)',
  },
  {
    path: '/api/session/autosave',
    limit: API_JSON_LIMIT_AUTOSAVE,
    reason: 'Session-Umschlag: payload ist z.unknown() (Modulzustaende + Graph)',
  },
];

export interface ApiBodyParserOptions {
  /** Default-Grenze fuer alle uebrigen JSON-Bodies (Default: 1 MB). */
  defaultLimit?: string;
  /** Grosse Routen (Default: `LARGE_JSON_BODY_ROUTES`). */
  largeRoutes?: readonly LargeJsonBodyRoute[];
  /** Logger des strukturierten Body-Fehler-Handlers (Default: console.warn). */
  log?: BodyErrorLogger;
}

/**
 * Montiert die JSON-Parser fuer die API - NACH Auth/Rate-Limit aufzurufen.
 *
 * Der Pfad-Praefix der grossen Routen ist bewusst eng: `app.use(path, ...)`
 * trifft nur diesen Zweig, nicht `/api/ai/*` insgesamt.
 */
export function installApiBodyParsers(app: Express, options: ApiBodyParserOptions = {}): void {
  const defaultLimit = options.defaultLimit ?? API_JSON_LIMIT_DEFAULT;
  const largeRoutes = options.largeRoutes ?? LARGE_JSON_BODY_ROUTES;

  // 1) Grosse Routen zuerst, je Grenze ein Parser (body-parser merkt sich
  //    `req._body`; der Default-Parser weiter unten ist danach ein No-op).
  const pathsByLimit = new Map<string, string[]>();
  for (const route of largeRoutes) {
    const paths = pathsByLimit.get(route.limit) ?? [];
    paths.push(route.path);
    pathsByLimit.set(route.limit, paths);
  }
  for (const [limit, paths] of pathsByLimit) {
    app.use(paths, express.json({ limit }));
  }

  // 2) Kleines Default-Limit fuer ALLES andere (auch Nicht-/api-Pfade, damit
  //    sich am Verhalten von Dev-/Static-Middlewares nichts aendert - nur eben
  //    mit 1 MB statt 50 MB).
  app.use(express.json({ limit: defaultLimit }));

  // 3) Strukturierte Antworten fuer Parser-Fehler (400/413, kein Stack).
  app.use(createJsonBodyErrorHandler(options.log));
}
