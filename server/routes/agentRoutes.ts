/**
 * audioMONASTRY · Agent-Loop-Routen (AI-P1-006)
 * =====================================================================
 *   POST /api/ai/agent/runs          -> Lauf starten (Antwort: Sofortzustand)
 *   GET  /api/ai/agent/runs          -> letzte Läufe (Status/Kosten)
 *   GET  /api/ai/agent/runs/:runId   -> Zustand eines Laufs
 *   POST /api/ai/agent/runs/:runId/cancel
 *   POST /api/ai/agent/runs/:runId/resume
 *
 * Planen/Ausfuehren/Pruefen dauern mit einem echten LLM Sekunden bis Minuten -
 * ein synchroner Request waere hier falsch. `start()`/`resume()` laufen deshalb
 * im Hintergrund, der Client fragt den Zustand ueber GET ab. Die Routen liegen
 * unter `/api/ai/...` und damit hinter der Kostenbremse; genau fuer solche
 * Auftraege existiert sie.
 */
import { agentRunSummary, type ResumableAgentRunner } from '../../src/core/ai/agentRuns';
import type { Express } from 'express';

export interface AgentRoutesDeps {
  runner: ResumableAgentRunner;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

const MAX_TASK_LENGTH = 500;

export function registerAgentRoutes(app: Express, deps: AgentRoutesDeps): void {
  const { runner } = deps;

  const statusOf = (error: unknown): number => {
    const message = (error as Error).message ?? '';
    if (message.includes('unbekannter Lauf')) return 404;
    if (message.includes('kann nicht fortgesetzt')) return 409;
    return 400;
  };

  const fail = (res: import('express').Response, error: unknown, code: string) =>
    res.status(statusOf(error)).json({ status: 'error', code, message: (error as Error).message });

  app.post('/api/ai/agent/runs', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const task = String(body.task ?? '').trim().slice(0, MAX_TASK_LENGTH);
    if (!task) return res.status(400).json({ status: 'error', code: 'EMPTY_TASK', message: 'task fehlt' });
    const maxCorrections = Number(body.maxCorrections);
    try {
      // begin() legt den Lauf an und kehrt SOFORT zurueck - der Loop laeuft im
      // Hintergrund weiter (sonst waere ein Abbruch waehrend des Laufs unmoeglich).
      const record = await runner.begin({
        task,
        userId: String((req as unknown as { userId?: string }).userId ?? 'localUser').slice(0, 64),
        context: typeof body.context === 'string' ? body.context.slice(0, 2000) : undefined,
        maxCorrections: Number.isFinite(maxCorrections) ? Math.max(0, Math.min(3, maxCorrections)) : undefined,
        // Schreibzugriffe sind opt-in: der Aufrufer (UI) bestaetigt damit die
        // WRITE-Schritte des Plans. Ohne Flag bleibt das WRITE-Gate aktiv.
        allowWrite: body.allowWrite === true,
      });
      return res.status(202).json({ status: 'ok', run: agentRunSummary(record) });
    } catch (error) {
      return fail(res, error, 'AGENT_START_FAILED');
    }
  });

  app.get('/api/ai/agent/runs', async (_req, res) => {
    try {
      const runs = await runner.list();
      return res.json({ status: 'ok', runs: runs.slice(0, 20).map(agentRunSummary) });
    } catch (error) {
      return fail(res, error, 'AGENT_LIST_FAILED');
    }
  });

  app.get('/api/ai/agent/runs/:runId', async (req, res) => {
    try {
      const record = await runner.get(String(req.params.runId));
      if (!record) return res.status(404).json({ status: 'error', code: 'UNKNOWN_RUN', message: 'unbekannter Lauf' });
      return res.json({ status: 'ok', run: agentRunSummary(record) });
    } catch (error) {
      return fail(res, error, 'AGENT_GET_FAILED');
    }
  });

  app.post('/api/ai/agent/runs/:runId/cancel', async (req, res) => {
    try {
      const record = await runner.cancel(String(req.params.runId));
      return res.json({ status: 'ok', run: agentRunSummary(record) });
    } catch (error) {
      return fail(res, error, 'AGENT_CANCEL_FAILED');
    }
  });

  app.post('/api/ai/agent/runs/:runId/resume', async (req, res) => {
    const runId = String(req.params.runId);
    try {
      const record = await runner.beginResume(runId);
      return res.status(202).json({ status: 'ok', run: agentRunSummary(record) });
    } catch (error) {
      return fail(res, error, 'AGENT_RESUME_FAILED');
    }
  });
}
