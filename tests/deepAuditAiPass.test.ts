/**
 * DEEP-AUDIT-P1-001 · KI-Pass: Zeilen-Belege und Gesamt-Budget
 * ============================================================
 * Zwei Defekte, die zusammen einen Lauf erzeugen, der wie ein Hänger aussieht:
 *
 *   1. Der Code ging OHNE Zeilennummern an das Modell — es musste die Zeile
 *      schätzen. Gemessen am 2026-10-03: 6 von 6 hf-qwen-Findings lagen um
 *      ~63 Zeilen daneben, mit Titeln, die auf echten Code passten.
 *   2. Es gab kein Gesamt-Budget. Ein Request-Timeout begrenzt nur EINEN
 *      Aufruf, der Pass konnte also `Batches x Timeout` laufen (120 Dateien x
 *      5 min ≈ 10 h) — und gab dabei keine Zeile Fortschritt aus.
 */
import { describe, expect, it } from 'vitest';
import { numberLines } from '../scripts/deep-audit/files';
import { parseAiFindings, runAiPass } from '../scripts/deep-audit/ai';
import type { FileBatch, SelectedFile } from '../scripts/deep-audit/files';
import type { AuditConfig, ProviderConfig } from '../scripts/deep-audit/types';

const provider: ProviderConfig = {
  baseUrl: 'https://example.invalid',
  model: 'test-model',
  apiKeyEnv: ['NOPE'],
  temperature: 0,
  maxTokens: 16,
};

function batchFor(filePath: string, lines: number): FileBatch {
  const file: SelectedFile = { path: filePath, risk: 'hot', size: 10 };
  return { files: [file], content: 'x', lineCounts: { [filePath]: lines } };
}

function configWith(maxAiTotalMs: number): AuditConfig {
  return { maxAiTotalMs } as unknown as AuditConfig;
}

describe('DEEP-AUDIT-P1-001 · KI-Pass', () => {
  it('nummeriert jede Zeile mit ihrer echten Nummer', () => {
    expect(numberLines('a\nb')).toBe('   1| a\n   2| b');
  });

  it('verwirft Zeilenangaben außerhalb des gesendeten Textes', () => {
    const findings = parseAiFindings(
      [
        { file: 'a.ts', line: 42, severity: 'high', category: 'bug', title: 'passt', message: 'x' },
        { file: 'a.ts', line: 999, severity: 'high', category: 'bug', title: 'zu weit', message: 'x' },
        { file: 'a.ts', line: 0, severity: 'high', category: 'bug', title: 'zu klein', message: 'x' },
      ],
      'hf-qwen',
      'a.ts',
      ['a.ts'],
      { 'a.ts': 100 },
    );

    expect(findings[0].line).toBe(42);
    expect(findings[1].line).toBeNull();
    expect(findings[2].line).toBeNull();
  });

  it('lässt Zeilen stehen, wenn die Zeilenzahl unbekannt ist', () => {
    const findings = parseAiFindings(
      [{ file: 'a.ts', line: 999, severity: 'low', category: 'other', title: 't', message: 'm' }],
      'hf-qwen',
      'a.ts',
      ['a.ts'],
    );

    expect(findings[0].line).toBe(999);
  });

  it('meldet Fortschritt je Batch und übernimmt gültige Findings', async () => {
    const progress: number[] = [];
    const stage = await runAiPass('hf-qwen', provider, [batchFor('a.ts', 100)], configWith(10_000), '', {
      chat: async () =>
        JSON.stringify({
          findings: [
            { file: 'a.ts', line: 7, severity: 'high', category: 'bug', title: 'T', message: 'M' },
          ],
        }),
      onProgress: (info) => progress.push(info.done),
    });

    expect(progress).toEqual([1]);
    expect(stage.findings).toHaveLength(1);
    expect(stage.findings[0].line).toBe(7);
    expect(stage.status).toBe('warn');
  });

  it('bricht bei erschöpftem Gesamt-Budget ab und meldet die Übersprungenen', async () => {
    let clock = 0;
    const progress: number[] = [];
    const stage = await runAiPass(
      'hf-qwen',
      provider,
      [batchFor('a.ts', 10), batchFor('b.ts', 10), batchFor('c.ts', 10)],
      configWith(100),
      '',
      {
        now: () => clock,
        chat: async () => {
          clock += 50; // jede Antwort "kostet" 50 ms
          return '{"findings":[]}';
        },
        onProgress: (info) => progress.push(info.done),
      },
    );

    // Der dritte Batch startet nicht mehr: 100 ms Budget sind nach zwei Batches weg.
    expect(progress).toEqual([1, 2]);
    expect(stage.status).toBe('error');
    expect(stage.summary).toContain('Budget erschoepft');
    expect(stage.summary).toContain('1 von 3');
  });
});
