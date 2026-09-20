// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { MosHarness } from '../src/core/ai/orchestrator/mosHarness';
import {
  resolveVoiceModel,
  voiceModelCandidates,
  voiceModelGateStatus,
} from '../src/core/ai/orchestrator/voiceModelGate';

/**
 * INFRA-AI-007: Das MOS-Gate wurde gepflegt, hatte aber keinen Abnehmer –
 * `gateFor()`/`summaryFor()` las nur der Test. Hier hängt die erste echte
 * Entscheidung daran: die Wahl des TTS-Modells der Rolle voiceGen.
 */
/**
 * Wertet ein Modell mit `hearers` VERSCHIEDENEN Hörern.
 *
 * Achtung: `MosHarness.add` validiert ohne Toleranz - der Score muss eine ganze
 * Zahl 1..5 sein (mosHarness.ts:147). Deshalb schlägt der Helfer hier laut fehl,
 * statt eine abgelehnte Wertung still zu verschlucken (genau dieser Fehler hat
 * beim ersten Anlauf der Tests für „unrated" statt „ok" gesorgt).
 */
function rate(harness: MosHarness, modelId: string, score: number, hearers: number, offset = 0): void {
  expect(Number.isInteger(score) && score >= 1 && score <= 5, `Score ${score} ist keine ganze Zahl 1..5`).toBe(true);
  for (let i = 0; i < hearers; i += 1) {
    // `offset` haelt die Hoerer-IDs ueber mehrere Aufrufe auseinander - sonst
    // zaehlt das Gate dieselbe Person nur einmal (es zaehlt HOERER, nicht Wertungen).
    const result = harness.add({ modelId, language: 'DE', score, evaluatorId: `hoerer-${modelId}-${offset + i}` });
    // `in`-Narrowing statt `!result.ok`: robust gegen die Diskriminierung des Unions.
    if ('error' in result) throw new Error(`Wertung abgelehnt: ${result.error}`);
  }
}

describe('INFRA-AI-007 · MOS-Gate entscheidet ueber das TTS-Modell', () => {
  it('leitet die Kandidaten aus dem Rollen-Manifest ab (keine zweite Modell-Liste)', () => {
    const candidates = voiceModelCandidates();
    expect(candidates).toContain('qwen3-tts-17b');
    expect(candidates.every((model) => model.startsWith('qwen3-tts'))).toBe(true);
  });

  it('laesst ungeratete und teilbewertete Modelle zu (kein erfundenes MOS)', () => {
    const harness = new MosHarness();
    expect(voiceModelGateStatus(harness.summaryFor('qwen3-tts-17b'))).toBe('unrated');

    rate(harness, 'qwen3-tts-17b', 5, 1); // 1 Hörer von 3 – unvollständig, nicht schlecht
    expect(voiceModelGateStatus(harness.summaryFor('qwen3-tts-17b'))).toBe('provisional');

    rate(harness, 'qwen3-tts-17b', 5, 2, 1); // jetzt 3 verschiedene Hörer, Score >= 4
    expect(voiceModelGateStatus(harness.summaryFor('qwen3-tts-17b'))).toBe('ok');
  });

  it('blockiert ein durchgefallenes Modell und wechselt auf einen erlaubten Kandidaten', () => {
    const harness = new MosHarness();
    rate(harness, 'qwen3-tts-17b', 1, 3); // genug Hörer, Score unter der Schwelle

    const decision = resolveVoiceModel('qwen3-tts-17b', {
      candidates: ['qwen3-tts-17b', 'qwen3-tts-voicedesign'],
      harness,
    });

    expect(decision.requested).toBe('qwen3-tts-17b');
    expect(decision.status).not.toBe('blocked');
    expect(decision.switched).toBe(true);
    expect(decision.model).toBe('qwen3-tts-voicedesign');
    expect(decision.reason).toMatch(/durch das MOS-Gate gefallen/);
    // Das durchgefallene Modell taucht als `blocked` im Bericht auf.
    expect(decision.considered.find((c) => c.model === 'qwen3-tts-17b')?.status).toBe('blocked');
  });

  it('bevorzugt ein OK-Modell vor einem ungerateten (bessere Evidenz)', () => {
    const harness = new MosHarness();
    rate(harness, 'qwen3-tts-17b', 1, 3);      // blocked
    rate(harness, 'qwen3-tts-voicedesign', 5, 3); // ok

    const decision = resolveVoiceModel('qwen3-tts-17b', {
      candidates: ['qwen3-tts-17b', 'qwen3-tts-voicedesign'],
      harness,
    });
    expect(decision.model).toBe('qwen3-tts-voicedesign');
    expect(decision.status).toBe('ok');
  });

  it('lehnt ab (blocked), wenn ALLE Kandidaten durchgefallen sind – keine stille Ersatzwahl', () => {
    const harness = new MosHarness();
    rate(harness, 'qwen3-tts-17b', 1, 3);
    rate(harness, 'qwen3-tts-voicedesign', 2, 3);

    const decision = resolveVoiceModel('qwen3-tts-17b', {
      candidates: ['qwen3-tts-17b', 'qwen3-tts-voicedesign'],
      harness,
    });

    expect(decision.status).toBe('blocked');
    expect(decision.switched).toBe(false);
    expect(decision.model).toBe('qwen3-tts-17b');
    expect(decision.reason).toMatch(/alle TTS-Modelle/);
    expect(decision.considered.every((c) => c.status === 'blocked')).toBe(true);
  });

  it('prüft auch ein angefordertes Modell, das nicht im Rollen-Preload steht', () => {
    const harness = new MosHarness();
    rate(harness, 'mms-tts-deu', 1, 3);

    const decision = resolveVoiceModel('mms-tts-deu', {
      candidates: ['qwen3-tts-17b', 'qwen3-tts-voicedesign'],
      harness,
    });
    // Es steht vorn in der Prüfung, fällt durch und es wird gewechselt.
    expect(decision.considered[0].model).toBe('mms-tts-deu');
    expect(decision.considered[0].status).toBe('blocked');
    expect(decision.switched).toBe(true);
  });
});
