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
 */
import express from 'express';
import type { Express } from 'express';
import { JsonObjectBodySchema } from '../../src/types/zod/schemas';

export interface MasterRouteDeps {
  /** Basis-URL des Master-Players (Env MASTER_PLAYER_URL > Flotten-Ziel > Default). */
  getMasterPlayerUrl(): string;
}

export function registerMasterRoutes(app: Express, deps: MasterRouteDeps): void {
  const { getMasterPlayerUrl } = deps;

  async function proxyMasterPlayer(pathName: string, req: express.Request, res: express.Response) {
    let forward: Record<string, unknown> = {};
    if (req.method !== 'GET') {
      const parsed = JsonObjectBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ status: 'error', message: parsed.error.issues[0]?.message ?? 'invalid payload' });
        return;
      }
      forward = parsed.data as Record<string, unknown>;
    }
    try {
      const resp = await fetch(getMasterPlayerUrl() + pathName, {
        method: req.method,
        headers: { 'Content-Type': 'application/json' },
        body: req.method === 'GET' ? undefined : JSON.stringify(forward),
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
