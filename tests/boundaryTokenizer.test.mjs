import { describe, expect, it } from 'vitest';
import {
  runBoundaryScan,
  scanSource,
  stripComments,
} from '../scripts/validate-interface-boundaries.mjs';

// ---------------------------------------------------------------------------
// AUDIT-2026-10-30-P2-004: Der Boundary-Scanner darf `//` innerhalb von
// Strings, Template-Literalen und Regex-Literalen nicht als Zeilenkommentar
// deuten. Sonst verschluckt er Plattform-Aufrufe, die hinter einer URL wie
// 'http://…' oder `ws://…` auf derselben Zeile stehen (Falsch-Negative).
// ---------------------------------------------------------------------------

const rules = (v) => v.map((x) => x.rule);

describe('Boundary-Scan – Tokenizer/StripComments', () => {
  it('Repro aus dem Ticket: Aufruf hinter einem URL-String wird gefunden', () => {
    const code = [
      "const base = 'http://localhost:8080/api'; new Worker('./w.js');",
      'const t = `ws://x/y`; navigator.mediaDevices.getUserMedia({});',
    ].join('\n');

    const v = scanSource('core/evil.ts', code);
    expect(rules(v)).toEqual(['direct Worker-Instanziierung', 'direct getUserMedia']);
    expect(v.map((x) => x.line)).toEqual([1, 2]);
  });

  it('stripComments erhält URL-Inhalte in Strings und Template-Literalen', () => {
    expect(stripComments("const base = 'http://localhost:8080/api';")).toContain(
      'http://localhost:8080/api',
    );
    expect(stripComments('const t = `ws://x/y`;')).toContain('ws://x/y');
    expect(stripComments('const d = "a // b";')).toContain('a // b');
  });

  it('echte Kommentare werden weiterhin entfernt', () => {
    expect(stripComments('// new Worker(1)\nconst a = 1;')).not.toContain('new Worker(');
    expect(stripComments('/* navigator.mediaDevices */ const a = 1;')).not.toContain(
      'navigator.mediaDevices',
    );
    // Kommentar hinter einem String: Code davor bleibt, Kommentar geht.
    const mixed = stripComments("const u = 'http://x'; // getUserMedia(\nconst b = 2;");
    expect(mixed).toContain("'http://x'");
    expect(mixed).not.toContain('getUserMedia');
  });

  it('Escapes in Strings beenden den String-Zustand nicht vorzeitig', () => {
    const single = "const s = 'it\\'s // kein Kommentar'; new Worker('./w.js');";
    const double = 'const s = "say \\"//\\" now"; new Worker("./w.js");';
    expect(rules(scanSource('core/evil.ts', single))).toEqual([
      'direct Worker-Instanziierung',
    ]);
    expect(rules(scanSource('core/evil.ts', double))).toEqual([
      'direct Worker-Instanziierung',
    ]);
    expect(stripComments(single)).toContain("it\\'s // kein Kommentar");
  });

  it('Template-Literale: `//` im Text zählt nicht, Code in ${…} schon', () => {
    const literal = 'const t = `ws://x/y // http://z`; new Worker("./w.js");';
    expect(rules(scanSource('core/evil.ts', literal))).toEqual([
      'direct Worker-Instanziierung',
    ]);

    const interpolated =
      'const t = `a // b ${navigator.mediaDevices ? 1 : 2}`; new Worker("./w.js");';
    expect(rules(scanSource('core/evil.ts', interpolated))).toEqual([
      'direct getUserMedia',
      'direct Worker-Instanziierung',
    ]);

    // Mehrzeiliges Template mit `${…}`, das `{`/`}` enthält.
    const nested =
      'const t = `x // y ${fn({ a: 1 })}`;\n navigator.mediaDevices.getUserMedia({});';
    expect(rules(scanSource('core/evil.ts', nested))).toEqual(['direct getUserMedia']);
  });

  it('Regex-Literale werden nicht als Kommentar oder Division verwechselt', () => {
    const code = [
      'const ratio = total / count; new Worker("./split.js");', // Division
      'const re = /^https?:\\/\\//; new Worker("./re.js");', // Regex-Literal
      'if (/\\/\\//.test(s)) { new Worker("./cls.js"); }', // Regex in Bedingung
    ].join('\n');

    const v = scanSource('core/evil.ts', code);
    expect(v.map((x) => x.line)).toEqual([1, 2, 3]);
    expect(rules(v)).toEqual([
      'direct Worker-Instanziierung',
      'direct Worker-Instanziierung',
      'direct Worker-Instanziierung',
    ]);
  });

  it('Blockkommentare über mehrere Zeilen verschieben die Zeilennummern nicht', () => {
    const code = ['/*', ' * new Worker(', ' */', "new Worker('./w.js');"].join('\n');
    const v = scanSource('core/evil.ts', code);
    expect(v).toHaveLength(1);
    expect(v[0].line).toBe(4);
  });

  it('der echte Quellbaum bleibt bei 0 Verstößen', async () => {
    const { filesScanned, violations } = await runBoundaryScan();
    expect(filesScanned).toBeGreaterThan(500);
    expect(violations).toEqual([]);
  });
});
