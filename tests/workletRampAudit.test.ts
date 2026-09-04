// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const WORKLETS_DIR = resolve(__dirname, '../src/audio/worklets');

const workletFiles = readdirSync(WORKLETS_DIR).filter((f) => f.endsWith('.ts'));

/** Extrahiert den `process(inputs, outputs)`-Body eines Worklets (grob). */
function processBody(source: string): string {
  const m = source.match(/process\s*\([^)]*\)\s*\{/);
  if (!m) return '';
  const start = m.index! + m[0].length;
  const end = source.indexOf('\n  }\n', start);
  return end > start ? source.slice(start, end) : '';
}

describe('AM-E2-3: Worklet-Automation-Audit (statisch, ohne Allokationen im Hot-Path)', () => {
  it('findet alle Worklet-Dateien', () => {
    expect(workletFiles.length).toBeGreaterThanOrEqual(9);
  });

  it('jede Worklet-Datei registriert einen Processor', () => {
    for (const file of workletFiles) {
      const source = readFileSync(resolve(WORKLETS_DIR, file), 'utf8');
      expect(source, `${file} ohne registerProcessor`).toMatch(/registerProcessor\(/);
    }
  });

  it('Automation-fähige Worklets (dsp/eq/effect/mastering) behandeln automate-Meldungen', () => {
    const automationWorklets = ['dspProcessor.ts', 'eqProcessor.ts', 'effectProcessor.ts', 'masteringProcessor.ts'];
    for (const file of automationWorklets) {
      const source = readFileSync(resolve(WORKLETS_DIR, file), 'utf8');
      expect(source, `${file} ohne automate-Handler`).toContain("'automate'");
    }
  });

  it('process()-Hot-Path der Automation-Worklets enthält keine per-Sample-Allokationen', () => {
    const automationWorklets = ['dspProcessor.ts', 'eqProcessor.ts', 'effectProcessor.ts', 'masteringProcessor.ts'];
    for (const file of automationWorklets) {
      const source = readFileSync(resolve(WORKLETS_DIR, file), 'utf8');
      const body = processBody(source);
      expect(body.length).toBeGreaterThan(0);
      // AM-E1-2/AM-E1-6: keine neuen Arrays/Math.pow im Render-Quantum.
      expect(body, `${file} allokiert im process(): new Array`).not.toMatch(/new Array/);
      expect(body, `${file} allokiert im process(): Math.pow`).not.toMatch(/Math\.pow/);
      // .push( ist nur als einmalige Delay-Line-Initialisierung erlaubt
      // (nicht pro Sample) – masteringProcessor nutzt this.delayLine.push.
      const pushCount = (body.match(/\.push\(/g) ?? []).length;
      const delayLinePush = (body.match(/this\.delayLine\.push\(/g) ?? []).length;
      expect(pushCount, `${file} hat unerwartete .push(-Aufrufe im process()`).toBe(delayLinePush);
    }
  });
});
