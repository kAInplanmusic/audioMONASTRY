// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { PromptStore } from '../src/core/ai/orchestrator/promptStore';
import { EvaluationStore } from '../src/core/ai/orchestrator/evaluationStore';
import { EVAL_PLUGIN_IDS, minScoreFor } from '../src/core/ai/orchestrator/evalMatrix';
import { gradePlanAnswer } from '../src/core/ai/orchestrator/evalGrading';
import { PLUGIN_COMMAND_CATALOG } from '../src/utils/prompts';
import {
  ROLE_PROMPT_SPECS,
  VISUAL_GPU_ROLE_IDS,
  roleCoverageGaps,
  roleCoverageRows,
} from '../src/core/ai/orchestrator/promptRoles';
import { buildMotionPrompt, buildVisionPrompt, motionStyleHintFor, VISION_STYLE_SUFFIX, type VisionStyle } from '../src/core/ai/vision/visionPrompt';

describe('PromptStore (Versionierung)', () => {
  it('legt Versionen an und liefert die aktivste', () => {
    const store = new PromptStore();
    store.upsert('mixer', 'v1: Mische Pegel', { role: 'system' });
    const v2 = store.upsert('mixer', 'v2: Mische Pegel + Pan', { role: 'system' });
    expect(store.highestVersion('mixer')).toBe(2);
    expect(store.getActive('mixer')?.id).toBe(v2.id);
    expect(store.listVersions('mixer')).toHaveLength(2);
  });

  it('deaktiviert Versionen und wechselt die aktive', () => {
    const store = new PromptStore();
    store.upsert('synth', 'v1', { version: 1 });
    store.upsert('synth', 'v2', { version: 2 });
    store.disable('synth', 2);
    expect(store.getActive('synth')?.version).toBe(1);
  });

  it('nimmt die Katalog-Fassung (v2) als aktive Version je Rolle an', () => {
    const store = new PromptStore();
    for (const roleId of EVAL_PLUGIN_IDS) {
      const spec = ROLE_PROMPT_SPECS[roleId];
      store.upsert(roleId, spec.systemPrompt, { version: spec.version });
      expect(store.getActive(roleId)?.content).toBe(spec.systemPrompt);
      expect(store.getActive(roleId)?.version).toBe(spec.version);
    }
  });
});

describe('EvaluationStore (AuditEval/AuditScore)', () => {
  it('berechnet Score und Run-Status', () => {
    const store = new EvaluationStore();
    store.record({ pluginId: 'mixer', task: 'gain', promptVersion: 1, model: 'moa', provider: 'deepseek', input: {}, output: {}, score: 4.5, metrics: { mos: 4.5 } });
    store.record({ pluginId: 'mixer', task: 'pan', promptVersion: 1, model: 'moa', provider: 'deepseek', input: {}, output: {}, score: 3.0, metrics: { mos: 3.0 } });
    const run = store.startRun('mixer');
    expect(store.averageScore('mixer')).toBeCloseTo(3.75);
    const done = store.finishRun(run.runId, 4);
    expect(done.status).toBe('FAIL');
    expect(done.count).toBe(2);
  });
});

/**
 * Der Eval-Datensatz je Rolle wird hier OHNE Modellaufruf durchgespielt: die
 * erwarteten Antworten kommen deterministisch aus dem Katalog, bewertet wird
 * mit dem echten Grader (`gradePlanAnswer`) – dieselbe Funktion, die
 * `scripts/eval-ai.ts` auf echte Modellantworten anwendet.
 */
describe('Rollen-Eval-Datensatz: Katalog → Grader, offline und deterministisch', () => {
  it('jeder Rollen-Eval-Fall liefert genau den erwarteten Score', () => {
    for (const roleId of EVAL_PLUGIN_IDS) {
      for (const evalCase of ROLE_PROMPT_SPECS[roleId].evalCases) {
        const answer = evalCase.negative
          ? JSON.stringify({ pluginId: roleId, command: evalCase.forbiddenCommand })
          : JSON.stringify({ pluginId: roleId, command: evalCase.expectedCommand });
        const grade = gradePlanAnswer(roleId, PLUGIN_COMMAND_CATALOG[roleId], answer);
        expect(grade.score, `${evalCase.id}: ${grade.reason}`).toBe(evalCase.expectedScore);
      }
    }
  });

  it('kein Eval-Fall bestraft ein Katalog-Kommando, keiner belohnt ein erfundenes', () => {
    for (const roleId of EVAL_PLUGIN_IDS) {
      const cases = ROLE_PROMPT_SPECS[roleId].evalCases;
      const exakt = cases.filter((c) => c.expect === 'plan-exakt');
      expect(exakt, `plan-exakt fehlt: ${roleId}`).toHaveLength(1);
      expect(exakt[0].expectedScore).toBeGreaterThanOrEqual(minScoreFor(roleId));
      for (const negative of cases.filter((c) => c.negative)) {
        expect(negative.expectedScore, `${negative.id} liegt nicht unter dem Gate`).toBeLessThan(minScoreFor(roleId));
      }
    }
  });

  it('ein Lauf über den Gate-Fall (plan-exakt) ergibt PASS, der Negativ-Fall FAIL', () => {
    for (const roleId of EVAL_PLUGIN_IDS) {
      const spec = ROLE_PROMPT_SPECS[roleId];
      const gate = minScoreFor(roleId);

      // Genau der Fall, den `scripts/eval-ai.ts` je Rolle stellt: ein Plan.
      const passStore = new EvaluationStore();
      const passRun = passStore.startRun(roleId);
      for (const evalCase of spec.evalCases.filter((c) => c.expect === 'plan-exakt')) {
        const answer = JSON.stringify({ pluginId: roleId, command: evalCase.expectedCommand });
        const grade = gradePlanAnswer(roleId, PLUGIN_COMMAND_CATALOG[roleId], answer);
        passStore.record({
          pluginId: roleId, task: evalCase.task, promptVersion: spec.version,
          model: 'katalog-deterministisch', provider: 'offline',
          input: evalCase.input, output: answer, score: grade.score,
          metrics: { exactMatch: grade.exactMatch, reason: grade.reason },
        });
      }
      const pass = passStore.finishRun(passRun.runId, gate);
      expect(pass.status, `${roleId} (Gate ${gate}): ${pass.avgScore}`).toBe('PASS');
      expect(pass.avgScore, `${roleId}-Gate-Fall`).toBe(5);

      // Die übrigen Katalog-Kommandos sind gültige Pläne (4.0) – ausdrücklich
      // NICHT Teil des Gates (sonst würde ein 4.5-Gate am zweiten Kommando scheitern).
      const altStore = new EvaluationStore();
      const altRun = altStore.startRun(roleId);
      for (const evalCase of spec.evalCases.filter((c) => c.expect === 'plan-alternativ')) {
        const answer = JSON.stringify({ pluginId: roleId, command: evalCase.expectedCommand });
        const grade = gradePlanAnswer(roleId, PLUGIN_COMMAND_CATALOG[roleId], answer);
        altStore.record({
          pluginId: roleId, task: evalCase.task, promptVersion: spec.version,
          model: 'katalog-deterministisch', provider: 'offline',
          input: evalCase.input, output: answer, score: grade.score,
          metrics: { exactMatch: grade.exactMatch, reason: grade.reason },
        });
      }
      if (altStore.listByPlugin(roleId).length > 0) {
        expect(altStore.finishRun(altRun.runId, gate).avgScore, `${roleId}-Alternativfälle`).toBe(4);
      }

      const failStore = new EvaluationStore();
      const failRun = failStore.startRun(roleId);
      const negative = spec.evalCases.find((c) => c.negative);
      const badAnswer = JSON.stringify({ pluginId: roleId, command: negative?.forbiddenCommand });
      const badGrade = gradePlanAnswer(roleId, PLUGIN_COMMAND_CATALOG[roleId], badAnswer);
      failStore.record({
        pluginId: roleId, task: 'plan', promptVersion: spec.version,
        model: 'katalog-deterministisch', provider: 'offline',
        input: String(negative?.input), output: badAnswer, score: badGrade.score,
        metrics: { exactMatch: badGrade.exactMatch },
      });
      const fail = failStore.finishRun(failRun.runId, gate);
      expect(fail.status, `${roleId}: erfundenes Kommando wurde nicht bestraft`).toBe('FAIL');
    }
  });

  it('Bild-/Video-Eval-Fälle prüfen den Prompt-Bauer (Stil landet im Prompt)', () => {
    for (const roleId of VISUAL_GPU_ROLE_IDS) {
      for (const evalCase of ROLE_PROMPT_SPECS[roleId].evalCases) {
        const style = evalCase.style as VisionStyle;
        expect(style, `${evalCase.id} ohne Stil`).toBeTruthy();
        if (roleId === 'imageHq') {
          const built = buildVisionPrompt({ style, energy: 0.5 });
          expect(built).toContain(VISION_STYLE_SUFFIX[style]);
        } else {
          const built = buildMotionPrompt({ style, energy: 0.5 });
          // Bewegung kommt aus dem Bewegungs-Hinweis des Stils, nicht aus dem Bild-Stil.
          expect(built).toContain(String(motionStyleHintFor(style)));
          expect(built).toContain('keep the subject and composition identical');
        }
      }
    }
  });

  it('Abdeckung: keine Lücken, keine erfundenen Scores', () => {
    expect(roleCoverageGaps()).toEqual([]);
    for (const row of roleCoverageRows()) {
      expect(['PASS', 'FAIL', 'UNCHECKED']).toContain(row.status);
      expect(row.status).toBe('UNCHECKED'); // ohne echten Report kein Score
      expect(row.systemPromptChars).toBeGreaterThan(40);
    }
  });
});
