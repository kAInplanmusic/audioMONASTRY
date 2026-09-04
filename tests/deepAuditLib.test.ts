import { describe, expect, it } from 'vitest';
import { dedupeFindings, findNextTodoId } from '../scripts/deep-audit/report';
import { parseAiFindings } from '../scripts/deep-audit/ai';
import { fingerprintFinding, globToRegExp, matchesAny } from '../scripts/deep-audit/pattern';
import { normalizeSeverity, SEVERITY_ORDER } from '../scripts/deep-audit/types';
import type { Finding } from '../scripts/deep-audit/types';

function sampleFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    file: 'src/a.ts',
    line: 1,
    severity: 'high',
    category: 'security',
    title: 'Test',
    message: 'Testbefund',
    source: 'deepseek-flash',
    fingerprint: 'fp',
    ...overrides,
  };
}

describe('deep-audit pattern', () => {
  it('matcht Glob-Muster mit **', () => {
    expect(matchesAny(['server/**'], 'server/index.ts')).toBe(true);
    expect(matchesAny(['server/**'], 'src/server/index.ts')).toBe(false);
    expect(matchesAny(['**/*.ts'], 'src/a.ts')).toBe(true);
    expect(globToRegExp('*.ts').test('a.ts')).toBe(true);
  });

  it('erzeugt stabile Fingerprints', () => {
    const a = fingerprintFinding({ file: 'a.ts', line: 3, category: 'bug', message: 'Fehler', source: 'x' });
    const b = fingerprintFinding({ file: 'a.ts', line: 3, category: 'bug', message: 'Fehler', source: 'y' });
    const c = fingerprintFinding({ file: 'a.ts', line: 4, category: 'bug', message: 'Fehler', source: 'y' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('deep-audit findings', () => {
  it('dedupliziert Findings nach Datei/Zeile/Kategorie/Meldung', () => {
    const merged = dedupeFindings([
      sampleFinding({ source: 'deepseek-flash' }),
      sampleFinding({ source: 'hf-qwen' }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toContain('deepseek-flash');
    expect(merged[0].source).toContain('hf-qwen');
  });

  it('behält schwereren Severity beim Dedupe', () => {
    const merged = dedupeFindings([
      sampleFinding({ severity: 'medium', source: 'eslint' }),
      sampleFinding({ severity: 'high', source: 'semgrep' }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].severity).toBe('high');
  });

  it('parst AI-JSON-Findings mit Fallback-Datei', () => {
    const findings = parseAiFindings(
      [{ file: 'server.ts', line: 42, severity: 'high', category: 'security', title: 'X', message: 'Y' }],
      'hf-qwen',
      'default.ts',
      ['server.ts', 'src/a.ts'],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe('server.ts');
    expect(findings[0].source).toBe('hf-qwen');
  });

  it('normalisiert Severity-Werte', () => {
    expect(normalizeSeverity('KRITISCH')).toBe('critical');
    expect(normalizeSeverity('Hoch')).toBe('high');
    expect(normalizeSeverity('unbekannt')).toBe('medium');
  });
});

describe('deep-audit todo', () => {
  it('vergibt fortlaufende DA-IDs ohne Duplikate', () => {
    const todo = '- [ ] **DA-2026-09-04-001**\n';
    expect(findNextTodoId(todo, '2026-09-04')).toBe('DA-2026-09-04-002');
    expect(findNextTodoId('', '2026-09-04')).toBe('DA-2026-09-04-001');
  });
});

describe('deep-audit severity', () => {
  it('ordnet Severity', () => {
    expect(SEVERITY_ORDER.critical).toBeGreaterThan(SEVERITY_ORDER.high);
    expect(SEVERITY_ORDER.high).toBeGreaterThan(SEVERITY_ORDER.medium);
    expect(SEVERITY_ORDER.low).toBeGreaterThan(SEVERITY_ORDER.info);
  });
});
