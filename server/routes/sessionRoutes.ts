/**
 * audioMONASTRY · Session-Routen (ARCH-P2-002, Extraktion aus server.ts)
 * =======================================================================
 *   POST /api/session/reset    → autoritativen Session-State zurücksetzen
 *                                (E2E/Dev-Hook; Production: 404)
 *   POST /api/session/autosave → idempotenter Remote-Sink für den
 *                                Session-Autosave (R2, PutObject je Key)
 *
 * Die Routen brauchen server.ts-Modul-Scope (Session, Auth-Helfer, R2) –
 * deshalb als Factory mit explizitem `SessionRoutesDeps`-Kontext.
 *
 * Begruendungen (unveraendert aus server.ts uebernommen):
 * - /reset ist ein E2E/Dev-Hook: die In-Memory-Session lebt ueber einzelne
 *   Browser-Kontexte hinaus, Tests brauchen einen deterministischen Start bei
 *   OFF/Lock-frei. Production bleibt fail-closed (404).
 * - /autosave ist der Remote-Sink fuer den Session-Autosave: der Umschlag
 *   traegt einen stabilen idempotencyKey, wiederholtes Senden schreibt also
 *   DASSELBE R2-Objekt (PutObject ist idempotent je Key), nie eine neue
 *   Revision.
 */
import type { Express } from 'express';
import { AuthoritativeSession } from '../../src/core/session/authoritativeSession';
import { SessionAutosaveEnvelopeSchema } from '../../src/types/zod/schemas';

export interface SessionRoutesDeps {
  isProductionEnv: boolean;
  studioAccessToken: string;
  /**
   * Expliziter Dev-/Test-Modus (server.ts: AUDIOMONASTRY_DEV_NO_AUTH=1 bzw.
   * VITEST/NODE_ENV=test). Dann ist auch dieser Dev-only-Hook offen - sonst
   * scheiterten die E2E-Session-Tests in der CI am Reset mit 401
   * STUDIO_TOKEN_REQUIRED, obwohl API und Socket bereits offen waren.
   */
  authOpen?: boolean;
  tokenFromRequest(req: unknown): string;
  safeTokenEqual(a: string, b: string): boolean;
  newSession(): AuthoritativeSession;
  replaceSession(session: AuthoritativeSession): void;
  clearSaveTimer(): void;
  serverIo: { to(room: string): { emit(event: string, payload: unknown): void } } | null;
  uploadToR2(key: string, body: Buffer, contentType: string): Promise<{ url: string }>;
}

export function registerSessionRoutes(app: Express, deps: SessionRoutesDeps): void {
  app.post('/api/session/reset', (req, res) => {
    if (deps.isProductionEnv) {
      res.status(404).end();
      return;
    }
    const token = deps.tokenFromRequest(req);
    const tokenOk = Boolean(token) && deps.safeTokenEqual(token, deps.studioAccessToken);
    if (!tokenOk && !deps.authOpen) {
      res.status(401).json({ error: 'unauthorized', code: 'STUDIO_TOKEN_REQUIRED' });
      return;
    }
    deps.replaceSession(deps.newSession());
    deps.clearSaveTimer();
    deps.serverIo?.to('session:studio-session').emit('session-reset', { ts: Date.now() });
    res.json({ status: 'reset' });
  });

  app.post('/api/session/autosave', async (req, res) => {
    try {
      const parsed = SessionAutosaveEnvelopeSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({
          ok: false,
          error: 'invalid autosave payload',
          details: parsed.error.issues.slice(0, 5),
        });
      }
      const envelope = parsed.data;
      const objectKey = `autosaves/${envelope.idempotencyKey}.json`;
      const body = Buffer.from(JSON.stringify(envelope), 'utf8');
      const result = await deps.uploadToR2(objectKey, body, 'application/json');
      res.json({ ok: true, idempotent: true, key: objectKey, url: result.url });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'unknown';
      if (message.includes('R2 not configured') || message.includes('CFS3_BUCKET missing')) {
        return res.status(503).json({ ok: false, error: 'r2-not-configured' });
      }
      console.error('[session] /api/session/autosave fehlgeschlagen:', e);
      res.status(502).json({ ok: false, error: 'session-autosave-failed' });
    }
  });
}
