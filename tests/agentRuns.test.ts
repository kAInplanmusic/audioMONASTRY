import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MoaAgent, type MoaStepResult, type MoaPlan } from '../src/core/ai/MoaAgent';
import {
  AgentRunStore,
  ResumableAgentRunner,
  agentRunSummary,
  type ResumableAgent,
} from '../src/core/ai/agentRuns';

/**
 * AI-P1-006: Ein Auftrag durchlaeuft planen -> ausfuehren -> pruefen, laesst sich
 * abbrechen und wiederaufnehmen, und Ergebnis + Kosten sind sichtbar.
 *
 * Der Loop selbst ist `MoaAgent` (bestehend seit AI-P1-003 P5) - hier wird die
 * ERWEITERUNG geprueft: Kostenausweis, kooperativer Abbruch, Teil-Fortsetzung ab
 * dem Abbruchpunkt und die Persistenz des Laufs. Planer und Executor sind Fakes,
 * damit ohne LLM und ohne GPU geprueft werden kann.
 */

const plan = (steps: Array<{ pluginId: string; command: string }>): MoaPlan => ({
  task: 'Test',
  provider: 'test' as never,
  steps: steps.map((s) => ({ ...s, prompt: '' })),
  raw: '',
  createdAt: 1,
});

/** Planer/Executor-Fake: liefert Plaene der Reihe nach und zaehlt Ausfuehrungen. */
function fakeAgent(plans: MoaPlan[], stepDelayMs = 0): {
  agent: ResumableAgent;
  executed: string[];
  planCalls: () => number;
} {
  const executed: string[] = [];
  let planIndex = 0;
  const run: ResumableAgent['run'] = async (_task, opts = {}) => {
    planIndex += 1;
    return new MoaAgent(
      async () => ({ provider: 'test' as never, text: JSON.stringify(plans[Math.min(planIndex - 1, plans.length - 1)].steps.map((s) => ({ pluginId: s.pluginId, command: s.command, prompt: s.prompt }))), latencyMs: 1 }),
      {
        execute: async (_u, command) => { await sleepMs(stepDelayMs); executed.push(command); return { handled: true, pluginId: 'p' }; },
        executePluginCommand: async (_u, pluginId, command) => { await sleepMs(stepDelayMs); executed.push(`${pluginId}:${command}`); return { handled: true, pluginId }; },
      },
      () => 0.001,
    ).run(_task, { ...opts, confirmWrite: () => true });
  };
  const runPlan: ResumableAgent['runPlan'] = async (givenPlan, opts = {}, userId = 'u') =>
    new MoaAgent(
      async () => ({ provider: 'test' as never, text: '[]', latencyMs: 1 }),
      {
        execute: async (_u, command) => { await sleepMs(stepDelayMs); executed.push(command); return { handled: true, pluginId: 'p' }; },
        executePluginCommand: async (_u, pluginId, command) => { await sleepMs(stepDelayMs); executed.push(`${pluginId}:${command}`); return { handled: true, pluginId }; },
      },
      () => 0.001,
    ).runPlan(givenPlan, { ...opts, confirmWrite: () => true }, userId);
  return { agent: { run, runPlan }, executed, planCalls: () => planIndex };
}

const sleepMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const silent = () => {};
const plan3 = plan([
  { pluginId: 'mixer', command: 'setChannelGain(0.5)' },
  { pluginId: 'eq', command: 'setLow(2)' },
  { pluginId: 'master', command: 'setVolume(-6)' },
]);

describe('AI-P1-006 · MoaAgent: Kosten, Abbruch, Teil-Fortsetzung', () => {
  it('weist Kosten getrennt nach Planung und Korrektur aus (Schaetzung markiert)', async () => {
    const agent = new MoaAgent(
      async () => ({ provider: 'test' as never, text: '[{"pluginId":"mixer","command":"setChannelGain(0.5)"}]', latencyMs: 1 }),
      { execute: async () => ({ handled: true, pluginId: 'mixer' }) },
      () => 0.002,
    );
    const result = await agent.run('Aufgabe', { confirmWrite: () => true });
    expect(result.succeeded).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(result.cost.planningUsd).toBeCloseTo(0.002, 6);
    expect(result.cost.correctionsUsd).toBe(0);
    expect(result.costUsd).toBeCloseTo(0.002, 6);
    expect(result.cost.estimated).toBe(true);
  });

  it('bricht kooperativ ab: kein Schritt nach dem Abbruch, Ergebnis bleibt erhalten', async () => {
    const controller = new AbortController();
    const executed: string[] = [];
    const agent = new MoaAgent(
      async () => ({
        provider: 'test' as never,
        text: JSON.stringify(plan3.steps.map((s) => ({ pluginId: s.pluginId, command: s.command, prompt: '' }))),
        latencyMs: 1,
      }),
      {
        execute: async () => ({ handled: true, pluginId: 'p' }),
        executePluginCommand: async (_u, pluginId, command) => {
          executed.push(`${pluginId}:${command}`);
          if (executed.length === 1) controller.abort(); // Nutzer stoppt nach Schritt 1
          return { handled: true, pluginId };
        },
      },
      () => 0.001,
    );
    const result = await agent.run('Aufgabe', { signal: controller.signal, confirmWrite: () => true });
    expect(result.cancelled).toBe(true);
    expect(result.succeeded).toBe(false); // ein Abbruch ist kein Erfolg
    // Genau EIN Schritt lief (der Abbruch wirkt VOR dem naechsten).
    expect(executed).toEqual(['mixer:setChannelGain(0.5)']);
    expect(result.steps).toHaveLength(1);
  });

  it('setzt mit startIndex/priorResults nur die offenen Schritte fort (kein zweiter Vollauf)', async () => {
    const executed: string[] = [];
    const agent = new MoaAgent(
      async () => ({ provider: 'test' as never, text: '[]', latencyMs: 1 }),
      {
        execute: async () => ({ handled: true, pluginId: 'p' }),
        executePluginCommand: async (_u, pluginId, command) => {
          executed.push(`${pluginId}:${command}`);
          return { handled: true, pluginId };
        },
      },
      () => 0.001,
    );
    const aborter = new AbortController();
    aborter.abort();
    const first = await agent.runPlan(plan3, {
      startIndex: 0,
      priorResults: [],
      signal: aborter.signal,
      confirmWrite: () => true,
    });
    // Abbruch vor dem ersten Schritt: nichts ausgefuehrt.
    expect(first.cancelled).toBe(true);
    expect(executed).toEqual([]);

    const priorResults: MoaStepResult[] = [
      { step: plan3.steps[0], handled: true, pluginId: 'mixer' },
      { step: plan3.steps[1], handled: true, pluginId: 'eq' },
    ];
    const resumed = await agent.runPlan(plan3, { startIndex: 2, priorResults, confirmWrite: () => true });
    expect(resumed.cancelled).toBe(false);
    expect(resumed.succeeded).toBe(true);
    // Nur Schritt 3 wurde ausgefuehrt, die ersten beiden kamen aus priorResults.
    expect(executed).toEqual(['master:setVolume(-6)']);
    expect(resumed.steps).toHaveLength(3);
  });
});

describe('AI-P1-006 · ResumableAgentRunner (Abbruch + Wiederaufnahme + Persistenz)', () => {
  /** Wartet, bis der Lauf persistiert ist - danach kommt in der Realitaet der
   *  Cancel-Request (die Route antwortet erst, wenn der Lauf angelegt ist). */
  const waitForRun = async (runner: ResumableAgentRunner, runId: string) => {
    for (let i = 0; i < 50; i += 1) {
      const found = await runner.get(runId);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`Lauf ${runId} wurde nicht persistiert`);
  };

  it('setzt nach Abbruch an der Abbruchstelle fort und summiert die Kosten', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'agentruns-'));
    try {
      const store = new AgentRunStore(dir);
      // 20 ms je Schritt: der Cancel-Request kommt waehrend der Ausfuehrung an
      // (in der Realitaet dauert ein Schritt Sekunden, nicht Millisekunden).
      const { agent, executed } = fakeAgent([plan3], 20);
      const runner = new ResumableAgentRunner({ agent, store, log: silent });

      const promise = runner.start({ task: 'Aufgabe', userId: 'u1', runId: 'r2', allowWrite: true });
      await waitForRun(runner, 'r2');
      await runner.cancel('r2');
      const cancelled = await promise;

      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.executedCount).toBeLessThan(3);

      // Fortsetzen: nur die offenen Schritte laufen, der Plan bleibt derselbe.
      const before = executed.length;
      const resumed = await runner.resume('r2');
      expect(resumed.status).toBe('done');
      expect(resumed.succeeded).toBe(true);
      expect(resumed.steps).toHaveLength(3);
      expect(resumed.executedCount).toBe(3);
      // Genau die fehlenden Schritte wurden nachgeholt.
      expect(executed.length).toBe(before + (3 - cancelled.executedCount));
      // Kosten ueber beide Runden: Gesamt = Planung + Korrekturen.
      expect(resumed.cost.totalUsd).toBeCloseTo(resumed.cost.planningUsd + resumed.cost.correctionsUsd, 6);
    } finally {
      await new Promise((r) => setTimeout(r, 25));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('findet einen abgebrochenen Lauf nach einem Prozess-Neustart wieder (Store auf Platte)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'agentruns3-'));
    try {
      const store = new AgentRunStore(dir);
      const { agent } = fakeAgent([plan3], 20);
      const runner = new ResumableAgentRunner({ agent, store, log: silent });
      const promise = runner.start({ task: 'Aufgabe', userId: 'u1', runId: 'r3', allowWrite: true });
      await waitForRun(runner, 'r3');
      await runner.cancel('r3');
      const stopped = await promise;
      expect(stopped.status).toBe('cancelled');

      // "Neustart": neue Runner-Instanz, gleicher Store.
      const { agent: agent2, executed: executed2 } = fakeAgent([plan3], 0);
      const runnerAfterRestart = new ResumableAgentRunner({ agent: agent2, store, log: silent });
      const loaded = await runnerAfterRestart.get('r3');
      expect(loaded?.status).toBe('cancelled');
      const resumed = await runnerAfterRestart.resume('r3');
      expect(resumed.status).toBe('done');
      // Es wurde nur der Rest ausgefuehrt (nicht von vorn).
      expect(executed2.length).toBe(3 - (loaded?.executedCount ?? 0));
    } finally {
      await new Promise((r) => setTimeout(r, 25));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('verweigert Fortsetzen bei fertigem Lauf und kennt unbekannte Laeufe', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'agentruns4-'));
    try {
      const store = new AgentRunStore(dir);
      const { agent } = fakeAgent([plan3]);
      const runner = new ResumableAgentRunner({ agent, store, log: silent });
      await runner.start({ task: 'Aufgabe', userId: 'u1', runId: 'r4', allowWrite: true });
      await expect(runner.resume('r4')).rejects.toThrowError(/vollstaendig ausgefuehrt|kann nicht fortgesetzt/);
      await expect(runner.resume('gibt-es-nicht')).rejects.toThrowError(/unbekannter Lauf/);
      await expect(runner.cancel('gibt-es-nicht')).rejects.toThrowError(/unbekannter Lauf/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('zeigt im Summary Status, Schritte und Kosten', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'agentruns5-'));
    try {
      const store = new AgentRunStore(dir);
      const { agent } = fakeAgent([plan3]);
      const runner = new ResumableAgentRunner({ agent, store, log: silent });
      const record = await runner.start({ task: 'Aufgabe', userId: 'u1', runId: 'r5', allowWrite: true });
      const summary = agentRunSummary(record);
      expect(summary.runId).toBe('r5');
      expect(summary.status).toBe('done');
      expect(summary.phase).toBe('verify');
      expect(summary.steps.map((s) => s.command)).toEqual(['setChannelGain(0.5)', 'setLow(2)', 'setVolume(-6)']);
      expect(summary.cost.totalUsd).toBeGreaterThan(0);
      expect(summary.succeeded).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('AI-P1-006 · WRITE-Gate bleibt aktiv', () => {
  it('ohne allowWrite werden Schreib-Schritte abgelehnt (kein stiller Schreibzugriff)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'agentruns6-'));
    try {
      // Hier wird der ECHTE MoaAgent geprueft (kein Fake-Executor), damit das
      // WRITE-Gate selbst wirkt.
      const realAgent = new MoaAgent(
        async () => ({ provider: 'test' as never, text: JSON.stringify(plan3.steps.map((s) => ({ pluginId: s.pluginId, command: s.command, prompt: '' }))), latencyMs: 1 }),
        { execute: async () => ({ handled: true, pluginId: 'p' }) },
        () => 0.001,
      );
      const runnerReal = new ResumableAgentRunner({ agent: realAgent, store: new AgentRunStore(dir), log: silent });
      const denied = await runnerReal.start({ task: 'Aufgabe', userId: 'u1', runId: 'r6' });
      expect(denied.succeeded).toBe(false);
      expect(denied.steps.every((s) => String(s.error ?? '').includes('WRITE nicht bestätigt'))).toBe(true);
      // Mit Freigabe laeuft derselbe Auftrag durch.
      const allowed = await runnerReal.start({ task: 'Aufgabe', userId: 'u1', runId: 'r7', allowWrite: true });
      expect(allowed.status).toBe('done');
      expect(allowed.succeeded).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('AI-P1-006 · Abbruch waehrend der Planung', () => {
  it('ist fortsetzbar: es wurde nichts ausgefuehrt, also wird neu geplant', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'agentruns8-'));
    try {
      const store = new AgentRunStore(dir);
      // Planung "dauert": der Planer wartet 60 ms, in dieser Zeit kommt der Abbruch.
      const executed: string[] = [];
      let planCalls = 0;
      // Echter MoaAgent, aber der PLANER wartet: so kommt der Abbruch mitten in
      // der Planung an (mit einem LLM dauert genau das Sekunden).
      const realFactory = () => new MoaAgent(
        async () => {
          planCalls += 1;
          await sleepMs(60);
          return {
            provider: 'test' as never,
            text: JSON.stringify(plan3.steps.map((s) => ({ pluginId: s.pluginId, command: s.command, prompt: '' }))),
            latencyMs: 1,
          };
        },
        {
          execute: async (_u: string, command: string) => { executed.push(command); return { handled: true, pluginId: 'p' }; },
          executePluginCommand: async (_u: string, pluginId: string, command: string) => {
            executed.push(`${pluginId}:${command}`);
            return { handled: true, pluginId };
          },
        } as never,
        () => 0.001,
      );
      const agent: ResumableAgent = {
        run: ((task: string, opts = {}) => realFactory().run(task, { ...opts, confirmWrite: () => true } as never)) as never,
        runPlan: ((givenPlan: MoaPlan, opts = {}, userId = 'u') =>
          realFactory().runPlan(givenPlan, { ...opts, confirmWrite: () => true } as never, userId)) as never,
      };
      const runner = new ResumableAgentRunner({ agent, store, log: silent });
      const promise = runner.start({ task: 'Aufgabe', userId: 'u1', runId: 'r8', allowWrite: true });
      await sleepMs(10); // mitten in der Planung
      await runner.cancel('r8');
      const stopped = await promise;
      expect(stopped.status).toBe('cancelled');
      // Nichts wurde ausgefuehrt - nur geplant (der Plan darf existieren).
      expect(stopped.executedCount).toBe(0);

      const resumed = await runner.resume('r8');
      expect(resumed.status).toBe('done');
      // Der beim Abbrechen bereits erzeugte Plan wird WIEDERVERWENDET - kein
      // zweiter Planungsaufruf (und damit keine doppelten LLM-Kosten). Gibt es
      // gar keinen Plan (Abbruch vor der ersten Antwort), plant der Lauf neu.
      expect(planCalls).toBe(1);
      expect(executed).toHaveLength(3);
    } finally {
      await sleepMs(20);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('AI-P1-006 · Leerer Plan ist kein Erfolg', () => {
  it('meldet bei null Schritten keinen Erfolg und plant in der Korrekturrunde nach', async () => {
    let calls = 0;
    const executed: string[] = [];
    const agent = new MoaAgent(
      async () => {
        calls += 1;
        // Erste Antwort: NUR Denktext (kein JSON-Array) - genau der Live-Fall.
        if (calls === 1) return { provider: 'test' as never, text: 'We need answer JSON array only. Need infer the task…', latencyMs: 1 };
        return {
          provider: 'test' as never,
          text: JSON.stringify(plan3.steps.map((s) => ({ pluginId: s.pluginId, command: s.command, prompt: '' }))),
          latencyMs: 1,
        };
      },
      {
        execute: async (_u: string, command: string) => { executed.push(command); return { handled: true, pluginId: 'p' }; },
        executePluginCommand: async (_u: string, pluginId: string, command: string) => {
          executed.push(`${pluginId}:${command}`);
          return { handled: true, pluginId };
        },
      } as never,
      () => 0.001,
    );

    const result = await agent.run('Aufgabe', { confirmWrite: () => true, maxCorrections: 1 });
    expect(calls).toBe(2); // Erstantwort leer -> Korrekturrunde
    expect(result.succeeded).toBe(true);
    expect(result.steps).toHaveLength(3);
    expect(executed).toHaveLength(3);
  });

  it('bleibt erfolglos, wenn auch die Korrekturrunde keinen Plan liefert', async () => {
    const agent = new MoaAgent(
      async () => ({ provider: 'test' as never, text: 'kein JSON hier', latencyMs: 1 }),
      { execute: async () => ({ handled: true, pluginId: 'p' }) } as never,
      () => 0.001,
    );
    const result = await agent.run('Aufgabe', { maxCorrections: 1 });
    expect(result.succeeded).toBe(false); // kein stiller Leer-Erfolg
    expect(result.steps).toHaveLength(0);
    expect(result.cost.correctionsUsd).toBeGreaterThan(0); // die Runde wurde bezahlt
  });
});

describe('AI-P1-006 · Zeitlimit der Planung', () => {
  it('bricht einen haengenden Planungsaufruf mit klarer Meldung ab', async () => {
    // Live belegt: ein haengender LLM-Aufruf liess den Lauf endlos "running" sein.
    const agent = new MoaAgent(
      () => new Promise(() => { /* antwortet nie */ }) as never,
      { execute: async () => ({ handled: true, pluginId: 'p' }) } as never,
      () => 0.001,
      40, // 40 ms Zeitlimit
    );
    await expect(agent.run('Aufgabe')).rejects.toThrowError(/Zeitlimit/);
  });

  it('laesst schnelle Antworten unberuehrt', async () => {
    const agent = new MoaAgent(
      async () => ({ provider: 'test' as never, text: '[]', latencyMs: 1 }),
      { execute: async () => ({ handled: true, pluginId: 'p' }) } as never,
      () => 0.001,
      1000,
    );
    const result = await agent.run('Aufgabe');
    expect(result.steps).toHaveLength(0);
    expect(result.succeeded).toBe(false); // leere Planung ist kein Erfolg
  });
});
