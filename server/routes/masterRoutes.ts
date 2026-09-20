/**
 * audioMONASTRY · /api/master-Routen (ARCH-P2-002, Extraktion aus server.ts)
 * =========================================================================
 * master-player (nativer Mixing/Mastering-Dienst, FFmpeg+NumPy):
 *   POST /api/master/mix      → Spuren mischen (Gain/Pan/3-Band-EQ)
 *   POST /api/master/master   → Mastering-Kette (EQ/Kompressor/Limiter/LUFS)
 *   POST /api/master/analyze  → Peak/RMS/LUFS/True-Peak/LRA
 *   GET  /api/master/health   → Service-Healthcheck
 *   GET  /api/master/selftest → Selbsttest des Dienstes
 * Der Dienst läuft separat (docker-compose: master-player, Port 8000 intern).
 *
 * Bewusst als Factory: die Ziel-URL kommt aus `getMasterPlayerUrl()` in server.ts.
 * Sie wird dort auch von /api/upload/sample für den Analyse-Schritt gebraucht,
 * kann also nicht mitwandern und wird deshalb übergeben - ein Import aus
 * server.ts wäre zirkulär.
 *
 * Der Code wurde 1:1 verschoben; die Einrückung ist die einzige Änderung.
 *
 * ---------------------------------------------------------------------------
 * FIX F3 (2026-09-20): Der Audio-Weg hatte die 256-kB-Hülle des globalen
 * `JsonObjectBodySchema` geerbt und lehnte damit jede realistische Spur ab
 * (2 Spuren à 1 s 48-kHz-Stereo-WAV = ~260 kB Base64-JSON → HTTP 400).
 * Jetzt gilt für genau die drei POST-Routen die eigene Master-Grenze
 * (64 MB / 8 Spuren / 120 s je Spur, siehe `src/types/masterPayload.ts`):
 *
 *   1. `installMasterBodyParser()` - eigener JSON-Parser für diese Pfade. Er MUSS
 *      vor dem globalen `express.json({ limit: '50mb' })` registriert werden,
 *      sonst hätte der globale Parser den Body bereits abgewiesen. Das globale
 *      `JsonObjectBodySchema` bleibt unverändert - es schützt weiter alle anderen
 *      Proxy-Routen.
 *   2. `inspectMasterPayload()` im Handler - mal die echten Zahlen aus dem Body
 *      (Größe, Spurzahl, längste WAV-Spur) und antwortet mit 413/400 + Klartext.
 */
import express from 'express';
import type { Express } from 'express';
import { JsonObjectEnvelopeSchema } from '../../src/types/zod/schemas';
import {
  MASTER_PAYLOAD_LIMITS,
  describeMasterPayloadViolation,
  masterViolationResponse,
  type MasterPayloadLimits,
} from '../../src/types/masterPayload';
import { inspectMasterPayload } from '../masterPayload';

export interface MasterRouteDeps {
  /** Basis-URL des Master-Players (Env MASTER_PLAYER_URL > Flotten-Ziel > Default). */
  getMasterPlayerUrl(): string;
  /** Grenzen für den Audio-Weg (Default: `MASTER_PAYLOAD_LIMITS`). */
  limits?: MasterPayloadLimits;
}

/** POST-Routen mit Audio-Body - genau sie bekommen die eigene, größere Grenze. */
export const MASTER_BODY_PATHS = ['/api/master/mix', '/api/master/master', '/api/master/analyze'];

/**
 * Eigener Body-Weg für die Master-POST-Routen. Aufzurufen VOR dem globalen
 * `express.json()` (siehe server.ts, Middleware-Kette).
 */
export function installMasterBodyParser(app: Express, limits: MasterPayloadLimits = MASTER_PAYLOAD_LIMITS): void {
  // (1) Vorprüfung über Content-Length: lehnt zu große Uploads ab, BEVOR 64 MB
  //     gepuffert werden, und nennt dabei die Zahlen. Der Body-Parser selbst
  //     antwortet nur mit „request entity too large" (ohne Werte).
  //     Bewusst OHNE Logzeile: diese Middleware läuft (wie der globale Parser)
  //     VOR der Auth - eine Logzeile hier wäre für unauthentifizierte Aufrufer
  //     frei spammbar. Die Handler-Prüfung (nach Auth/Rate-Limit) protokolliert.
  app.use(MASTER_BODY_PATHS, (req, res, next) => {
    const declared = Number(req.headers['content-length'] ?? '');
    if (Number.isFinite(declared) && declared > limits.maxBytes) {
      const violation = describeMasterPayloadViolation({ bytes: declared, tracks: null }, limits);
      if (violation) {
        res.status(violation.status).json(masterViolationResponse(violation));
        return;
      }
    }
    next();
  });

  // (2) Eigener JSON-Parser mit der Master-Grenze. Ein zweiter `express.json()`
  //     weiter unten ist dann ein No-op (body-parser merkt sich `req._body`),
  //     und für alle anderen Pfade bleibt der globale 50-MB-Deckel bestehen.
  app.use(MASTER_BODY_PATHS, express.json({ limit: limits.maxBytes }));
}

export function registerMasterRoutes(app: Express, deps: MasterRouteDeps): void {
  const { getMasterPlayerUrl } = deps;
  const limits = deps.limits ?? MASTER_PAYLOAD_LIMITS;

  async function proxyMasterPlayer(pathName: string, req: express.Request, res: express.Response) {
    let forwardBody: string | undefined;
    if (req.method !== 'GET') {
      // Hülle prüfen (Objekt mit kurzen Schlüsseln) - die GRÖSSE prüft der Guard
      // mit Zahlen im Klartext, deshalb hier NICHT mehr `JsonObjectBodySchema`
      // (dessen 256 kB sind für Audio unbrauchbar, siehe Modulkopf).
      const parsed = JsonObjectEnvelopeSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ status: 'error', message: parsed.error.issues[0]?.message ?? 'invalid payload' });
        return;
      }
      const forward = parsed.data as Record<string, unknown>;
      // Einmal serialisieren: dieselbe Zeichenkette wird gemessen und gesendet,
      // damit die gemeldeten Zahlen zur übertragenen Größe passen.
      forwardBody = JSON.stringify(forward);
      const violation = inspectMasterPayload(forward, forwardBody.length, limits);
      if (violation) {
        // Logzeile mit Zahlen, ohne jeden Nutzdaten-Anteil (Größen- UND
        // Datenschutz: Base64-Audio darf nie in Logs/Telemetrie landen).
        console.warn(
          `[master] ${pathName} abgewiesen: ${violation.code} `
          + `(bytes=${violation.actual.bytes}, tracks=${violation.actual.tracks ?? 'unbekannt'}, `
          + `maxBytes=${limits.maxBytes}, maxTracks=${limits.maxTracks}, maxSeconds=${limits.maxSecondsPerTrack})`,
        );
        res.status(violation.status).json(masterViolationResponse(violation));
        return;
      }
    }
    try {
      const resp = await fetch(getMasterPlayerUrl() + pathName, {
        method: req.method,
        headers: { 'Content-Type': 'application/json' },
        body: req.method === 'GET' ? undefined : forwardBody,
      });
      const data = await resp.json() as any;
      res.status(resp.status).json(data);
    } catch (e) {
      res.status(502).json({ status: 'error', message: 'master-player Proxy fehlgeschlagen: ' + ((e as Error).message ?? '') });
    }
  }

  app.get('/api/master/health', async (req, res) => proxyMasterPlayer('/health', req, res));
  app.get('/api/master/selftest', async (req, res) => proxyMasterPlayer('/selftest', req, res));
  app.post('/api/master/mix', async (req, res) => proxyMasterPlayer('/mix', req, res));
  app.post('/api/master/master', async (req, res) => proxyMasterPlayer('/master', req, res));
  app.post('/api/master/analyze', async (req, res) => proxyMasterPlayer('/analyze', req, res));
}
