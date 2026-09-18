import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { registerAgentRoutes } from '../server/routes/agentRoutes';
import { AgentRunStore, ResumableAgentRunner, type ResumableAgent } from '../src/core/ai/agentRuns';
import { MoaAgent, type MoaPlan } from '../src/core/ai/MoaAgent';

/**
 * AI-P1-006 · HTTP-Vertrag der Agent-Loop-Routen.
 *
 * Der Loop selbst braucht ein LLM - hier laeuft deshalb ein Fake-Agent, aber
 * durch die ECHTEN Routen und den ECHTEN Runner: Start (202 mit Zustand),
 * Status, Abbruch und Wiederaufnahme. Das ist der Vertrag, den die UI nutzt.
 */

let server: Server;
let baseUrl = '';
let dir = '';
let runner: ResumableAgentRunner;
const executed: string[] = [];

const plan: MoaPlan = {
  task: 'Test', provider: 'test' as never, createdAt: 1, raw: '',
  steps: [
    { pluginId: 'mixer', command: 'setChannelGain(0.5)', prompt: '' },
    { pluginId: 'eq', command: 'setLow(2)', prompt: '' },
  ],
};

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeAgent(delayMs: number): ResumableAgent {
  const complete = async () => ({
    provider: 'test' as never,
    text: JSON.stringify(plan.steps.map((s) => ({ pluginId: s.pluginId, command: s.command, prompt: s.prompt }))),
    latencyMs: 1,
  });
  const voice = {
    execute: async (_u: string, command: string) => { await sleepMs(delayMs); executed.push(command); return { handled: true, pluginId: 'p' }; },
    executePluginCommand: async (_u: string, pluginId: string, command: string) => {
      await sleepMs(delayMs);
      executed.push(`${pluginId}:${command}`);
      return { handled: true, pluginId };
    },
  };
  // MoaAgent wird hier direkt konstruiert (kein LLM): Planer und Executor sind Fakes.
  const agent = new MoaAgent(complete as never, voice as never, () => 0.001);
  return { run: agent.run.bind(agent), runPlan: agent.runPlan.bind(agent) };
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'agentroutes-'));
  runner = new ResumableAgentRunner({ agent: makeAgent(25), store: new AgentRunStore(dir) });
  const app = express();
  app.use(express.json());
  registerAgentRoutes(app, { runner, log: () => {} });
  server = app.listen(0);
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('kein Port');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await sleepMs(30);
  await rm(dir, { recursive: true, force: true });
});

/**
 * Der Limiter wird beim Modul-Import verdrahtet - fuer den Limiter-Test braucht es
 * deshalb eine frische Server-Instanz mit den engen Env-Werten.
 */
async function importFreshApp(): Promise<{ app: import('express').Express }> {
  const { vi } = await import('vitest');
  vi.resetModules();
  process.env.VITEST = 'true';
  const mod = await import('../server');
  return { app: mod.app as import('express').Express };
}

const post = (p: string, body?: unknown) =>
  fetch(`${baseUrl}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

const waitForStatus = async (runId: string, statuses: string[], attempts = 80) => {
  for (let i = 0; i < attempts; i += 1) {
    const res = await fetch(`${baseUrl}/api/ai/agent/runs/${runId}`);
    const body = await res.json() as { run?: { status?: string; executedCount?: number } };
    if (statuses.includes(String(body.run?.status))) return body.run;
    await sleepMs(15);
  }
  throw new Error(`Lauf ${runId} erreichte ${statuses.join('/')} nicht`);
};

describe('AI-P1-006 · Routen', () => {
  it('startet einen Lauf, zeigt Zustand + Kosten und laeuft im Hintergrund', async () => {
    const started = await post('/api/ai/agent/runs', { task: 'Session pruefen', allowWrite: true });
    expect(started.status).toBe(202);
    const body = await started.json() as { run: { runId: string; status: string; cost: { totalUsd: number } } };
    expect(body.run.runId).toBeTruthy();

    const done = await waitForStatus(body.run.runId, ['done']);
    expect(done.executedCount).toBe(2);

    const detail = await fetch(`${baseUrl}/api/ai/agent/runs/${body.run.runId}`);
    const detailBody = await detail.json() as { run: { status: string; phase: string; steps: unknown[]; cost: { totalUsd: number; planningUsd: number } } };
    expect(detailBody.run.status).toBe('done');
    expect(detailBody.run.phase).toBe('verify');
    expect(detailBody.run.steps).toHaveLength(2);
    // Kosten sichtbar und plausibel (Planung > 0, Gesamt = Planung + Korrekturen).
    expect(detailBody.run.cost.planningUsd).toBeGreaterThan(0);
    expect(detailBody.run.cost.totalUsd).toBeGreaterThanOrEqual(detailBody.run.cost.planningUsd);

    const list = await fetch(`${baseUrl}/api/ai/agent/runs`);
    const listBody = await list.json() as { runs: Array<{ runId: string }> };
    expect(listBody.runs.map((r) => r.runId)).toContain(body.run.runId);
  });

  it('bricht ab und setzt an der Abbruchstelle fort', async () => {
    const started = await post('/api/ai/agent/runs', { task: 'Abbruch-Test', allowWrite: true });
    const { run } = await started.json() as { run: { runId: string } };
    // Warten, bis der Lauf existiert und der erste Schritt laeuft, dann abbrechen.
    await waitForStatus(run.runId, ['running']);
    const cancelled = await (await post(`/api/ai/agent/runs/${run.runId}/cancel`)).json() as { run: { status: string; executedCount: number } };
    expect(cancelled.run.status).toBe('cancelled');
    expect(cancelled.run.executedCount).toBeLessThan(2);

    const before = executed.length;
    const resumedRes = await post(`/api/ai/agent/runs/${run.runId}/resume`);
    expect(resumedRes.status).toBe(202);
    const done = await waitForStatus(run.runId, ['done']);
    expect(done.executedCount).toBe(2);
    // Nur der offene Schritt wurde nachgeholt.
    expect(executed.length).toBe(before + (2 - cancelled.run.executedCount));
  });

  it('weist unbekannte Laeufe und leere Auftraege ab', async () => {
    expect((await fetch(`${baseUrl}/api/ai/agent/runs/gibt-es-nicht`)).status).toBe(404);
    expect((await post('/api/ai/agent/runs/gibt-es-nicht/cancel')).status).toBe(404);
    expect((await post('/api/ai/agent/runs/gibt-es-nicht/resume')).status).toBe(404);
    const empty = await post('/api/ai/agent/runs', { task: '   ' });
    expect(empty.status).toBe(400);
    expect((await empty.json() as { code: string }).code).toBe('EMPTY_TASK');
  });
});

/**
 * Live gefundener Konflikt (2026-09-18): Die Agent-Routen lagen hinter der
 * Kostenbremse. Ein laufender Lauf wird aber vom Client regelmaessig abgefragt -
 * das reine LESEN lief dadurch nach wenigen Polls in 429, obwohl es nichts kostet.
 * Dieser Test haelt fest, dass Statusabfragen ein eigenes Budget haben und von der
 * Kostenbremse ausgenommen sind.
 */
describe('AI-P1-006 · Statusabfrage vs. Kostenbremse', () => {
  it('erlaubt regelmaessiges Polling, auch wenn die Kostenbremse eng steht', async () => {
    // Enges Kostenlimit: 2 Anfragen - fuer den Start reicht es, fuer 10 Polls nicht.
    process.env.API_EXPENSIVE_RATE_LIMIT_MAX = '2';
    process.env.AI_AGENT_RATE_LIMIT_MAX = '1000';
    const { app: freshApp } = await importFreshApp();
    const server2 = freshApp.listen(0);
    const addr = server2.address() as { port: number };
    const base2 = `http://127.0.0.1:${addr.port}`;
    try {
      const started = await fetch(`${base2}/api/ai/agent/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'Polling-Test', allowWrite: true }),
      });
      expect(started.status).toBe(202);
      const { run } = await started.json() as { run: { runId: string } };
      // Zehn Statusabfragen (das macht die UI in ~15 s) duerfen NICHT 429 liefern.
      for (let i = 0; i < 10; i += 1) {
        const res = await fetch(`${base2}/api/ai/agent/runs/${run.runId}`);
        expect(res.status).not.toBe(429);
        expect(res.status).toBe(200);
      }
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
    }
  });
});
