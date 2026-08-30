import { describe, expect, it } from 'vitest';
import { stripComments } from '../scripts/validate-interface-boundaries.mjs';

describe('stripComments', () => {
  it('entfernt Block- und Zeilenkommentare', () => {
    const code = `
      // zeile
      const a = 1; /* block */
      const b = 2; // ende
    `;
    const out = stripComments(code);
    expect(out).not.toContain('zeile');
    expect(out).not.toContain('block');
    expect(out).not.toContain('ende');
    expect(out).toContain('const a = 1;');
    expect(out).toContain('const b = 2;');
  });

  it('behandelt nicht geschlossene Blockkommentare sicher', () => {
    const out = stripComments('const a = 1; /* offen');
    expect(out).toBe('const a = 1; ');
  });

  it('lässt normalen Code unverändert', () => {
    const code = 'const x = 42;\nconsole.log(x);\n';
    expect(stripComments(code)).toBe(code);
  });
});
