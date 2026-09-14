/**
 * audioMONASTRY · Admin-/Debug-Route (ARCH-P2-002, Extraktion aus server.ts)
 * ==========================================================================
 *   GET /api/admin/debug  (nur mit ADMIN_TOKEN, z. B. fuer Root-Debugging)
 *     Liefert Service-, Metrik- und Umgebungsstatus (keine Secrets).
 * 
 * Gereicht werden: metrics (Zaehler), safeTokenEqual (konstantzeit-Vergleich des
 * Tokens, bleibt in server.ts) und getStemActiveJobs - der Zaehler wird vom
 * Stem-Modul gefuehrt und hier ueber den Getter gelesen (Wertkopie wuerde einfrieren).
 * 
 * Der Code wurde 1:1 verschoben; die Einrueckung ist die einzige Aenderung.
 */
import { llmRouter } from '../../src/core/ai/LlmRouter';
import type { Express } from 'express';

/** Zaehler aus server.ts; hier nur gelesen (Debug-Ausgabe). */
export interface AdminMetrics {
  startedAt: number;
}
/** Von server.ts gereichte Abhaengigkeiten (siehe Modul-Kommentar). */
export interface AdminDeps {
  getStemActiveJobs: () => number;
  metrics: AdminMetrics;
  safeTokenEqual: (a: string, b: string) => boolean;
}


export function registerAdminRoutes(app: Express, deps: AdminDeps): void {
  const { getStemActiveJobs, metrics, safeTokenEqual } = deps;

  // --- Admin/Root-Debug (nur mit ADMIN_TOKEN, z. B. fuer Root-Debugging) -------
  app.get('/api/admin/debug', (req, res) => {
    const adminToken = (process.env.ADMIN_TOKEN || '').trim();
    const supplied = String(req.headers['x-admin-token'] ?? '');
    if (!adminToken || !safeTokenEqual(supplied, adminToken)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    res.json({
      service: 'audioMONASTRY',
      uptimeSec: Math.round((Date.now() - metrics.startedAt) / 1000),
      metrics,
      stemActiveJobs: getStemActiveJobs(),
      stemAiProvider: (process.env.STEM_AI_PROVIDER || 'fallback').trim(),
      replicateActive: Boolean((process.env.REPLICATE_API_TOKEN || '').trim()),
      llmProviders: llmRouter.providerIds(),
      node: process.version,
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    });
  });
}
