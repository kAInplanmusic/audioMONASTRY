import { describe, expect, it } from 'vitest';
import {
  MoaAgent,
  correctionPromptFor,
  isWriteCommand,
  type MoaStep,
} from '../src/core/ai/MoaAgent';
import type { LlmCompletion, LlmRequest } from '../src/core/ai/LlmRouter';

/**
 * AI-P1-003 P5: Der Agent-Loop (planen → WRITE-gate → ausführen → prüfen →
 * korrigieren) wird mit Fakes getestet – deterministisch, kein Netz, keine GPU.
 */

const STEP = (pluginId: string, command: string): MoaStep => ({ pluginId, command, prompt: `${pluginId} ${command}` });

function fakeCompletion(handler: (req: LlmRequest) => MoaStep[]): (req: LlmRequest) => Promise<LlmCompletion> {
  return async (req) => ({ provider: 'runpod-local', text: JSON.stringify(handler(req)), latencyMs: 1 });
}

function fakeExecutor(failCommands: string[] = []) {
  const executed: string[] = [];
  return {
    executed,
    executor: {
      async execute(_userId: string, command: string) {
        return failCommands.includes(command)
          ? { handled: false, pluginId: 'unknown', error: 'simulierter Fehler' }
          : { handled: true, pluginId: 'unknown' };
      },
      async executePluginCommand(_userId: string, pluginId: string, command: string) {
        executed.push(`${pluginId}:${command}`);
        return failCommands.includes(command)
          ? { handled: false, pluginId, error: 'simulierter Fehler' }
          : { handled: true, pluginId };
      },
    },
  };
}

describe('MoaAgent-Loop (AI-P1-003 P5)', () => {
  it('führt eine 3-Schritt-Aufgabe fehlerfrei aus (planen → ausführen → prüfen)', async () => {
    const { executor, executed } = fakeExecutor();
    const agent = new MoaAgent(fakeCompletion(() => [
      STEP('mixer', 'gain(db)'),
      STEP('voice', 'speak(text)'),
      STEP('mixer', 'status'),
    ]), executor);

    const result = await agent.run('Pegel anheben und Ansage', { confirmWrite: () => true, userId: 'u1' });

    expect(result.succeeded).toBe(true);
    expect(result.corrections).toBe(0);
    expect(executed).toEqual(['mixer:gain(db)', 'voice:speak(text)', 'mixer:status']);
  });

  it('korrigiert einen fehlgeschlagenen Schritt und führt ihn erneut aus', async () => {
    const { executor, executed } = fakeExecutor(['kaputt']);
    const agent = new MoaAgent(fakeCompletion((req) =>
      req.prompt.includes('Korrigiere')
        ? [STEP('mixer', 'gain(db)')]
        : [STEP('mixer', 'kaputt'), STEP('mixer', 'status')],
    ), executor);

    const result = await agent.run('Mixer setzen', { confirmWrite: () => true, userId: 'u1' });

    expect(result.corrections).toBe(1);
    expect(result.succeeded).toBe(true);
    // Erster Lauf: kaputt (fail) + status (ok). Korrektur: gain(db) ersetzt kaputt.
    expect(executed).toEqual(['mixer:kaputt', 'mixer:status', 'mixer:gain(db)']);
  });

  it('führt WRITE-Schritte ohne Bestätigung nicht aus (Bestätigungspflicht)', async () => {
    const { executor, executed } = fakeExecutor();
    const agent = new MoaAgent(fakeCompletion(() => [STEP('mixer', 'gain(db)')]), executor);

    const result = await agent.run('Pegel ändern', { userId: 'u1' }); // kein confirmWrite

    expect(result.succeeded).toBe(false);
    expect(executed).toEqual([]); // nichts wurde ausgeführt
    expect(result.steps[0].error).toBe('WRITE nicht bestätigt');
  });

  it('führt WRITE-Schritte mit Bestätigung aus, Lese-Schritte ohne', async () => {
    const confirmed: string[] = [];
    const { executor, executed } = fakeExecutor();
    const agent = new MoaAgent(fakeCompletion(() => [
      STEP('mixer', 'gain(db)'),
      STEP('mixer', 'status'),
    ]), executor);

    const result = await agent.run('Setzen und prüfen', {
      userId: 'u1',
      confirmWrite: async (step) => {
        confirmed.push(step.command);
        return true;
      },
    });

    expect(result.succeeded).toBe(true);
    expect(executed).toEqual(['mixer:gain(db)', 'mixer:status']);
    // Bestätigung wurde nur für den Schreib-Schritt erfragt.
    expect(confirmed).toEqual(['gain(db)']);
  });

  it('respektiert die Korrekturgrenze (maxCorrections)', async () => {
    const { executor } = fakeExecutor(['kaputt']);
    const agent = new MoaAgent(fakeCompletion(() => [STEP('mixer', 'kaputt')]), executor);

    const result = await agent.run('x', { confirmWrite: () => true, maxCorrections: 0 });

    expect(result.corrections).toBe(0);
    expect(result.succeeded).toBe(false);
    expect(result.steps[0].error).toBe('simulierter Fehler');
  });

  it('klassifiziert Schreib-Kommandos deterministisch (unbekannt = WRITE, fail-safe)', () => {
    expect(isWriteCommand('status')).toBe(false);
    expect(isWriteCommand('search(query)')).toBe(false);
    expect(isWriteCommand('gain(db)')).toBe(true);
    expect(isWriteCommand('unbekannt')).toBe(true);
  });

  it('baut den Korrektur-Prompt nur aus den fehlgeschlagenen Schritten', () => {
    const prompt = correctionPromptFor([
      { step: STEP('mixer', 'kaputt'), handled: false, pluginId: 'mixer', error: 'Fehler A' },
      { step: STEP('mixer', 'status'), handled: true, pluginId: 'mixer' },
    ]);
    expect(prompt).toContain('Korrigiere');
    expect(prompt).toContain('kaputt');
    expect(prompt).toContain('Fehler A');
    expect(prompt).not.toContain('status');
  });
});
