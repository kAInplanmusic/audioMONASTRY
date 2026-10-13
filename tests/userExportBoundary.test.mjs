import { describe, expect, it } from 'vitest';
import { runBoundaryScan, scanSource, USER_EXPORT_FILES } from '../scripts/validate-interface-boundaries.mjs';

// ---------------------------------------------------------------------------
// STORE-P1-001: Allowlist der Gerätespeicher-Ausnahmen im Boundary-Scan.
// Datei-Export/-Import NUR in src/utils/userExport.ts; Browser-Speicher
// (localStorage/sessionStorage/IndexedDB/OPFS) bleibt überall verboten.
// ---------------------------------------------------------------------------

const EXPORT_CODE = [
  'const h = await window.showSaveFilePicker({ suggestedName: "a.wav" });',
  'const [f] = await window.showOpenFilePicker();',
  'a.download = "preset.json";',
  "a.setAttribute('download', 'x.wav');",
].join('\n');

describe('Boundary-Scan – Nutzerexport-Ausnahme', () => {
  it('die Allowlist enthält genau die Export-Datei', () => {
    expect([...USER_EXPORT_FILES]).toEqual(['utils/userExport.ts']);
  });

  it('Ausnahme: Datei-Dialoge und Download in utils/userExport.ts sind erlaubt', () => {
    expect(scanSource('utils/userExport.ts', EXPORT_CODE)).toEqual([]);
  });

  it('sonst Verstoß: dieselben Aufrufe in einem Terminal oder Adapter', () => {
    const v = scanSource('components/RecorderTerminal.tsx', EXPORT_CODE);
    expect(v).toHaveLength(4);
    expect(v.every((x) => x.rule.includes('Nutzerexport'))).toBe(true);
    // Auch Adapter-Dateien (ALLOWED) bekommen die Ausnahme nicht.
    expect(scanSource('utils/storage.ts', 'a.download = "x";')).toHaveLength(1);
  });

  it('Browser-Speicher bleibt auch in der Export-Datei verboten', () => {
    for (const line of [
      "localStorage.setItem('k', 'v');",
      "sessionStorage.setItem('k', 'v');",
      "indexedDB.open('db');",
      'const root = await navigator.storage.getDirectory();',
    ]) {
      const v = scanSource('utils/userExport.ts', line);
      expect(v.map((x) => x.rule)).toContain('direct Storage');
    }
  });

  it('Vergleich und Kommentare lösen keinen Verstoß aus', () => {
    expect(scanSource('components/X.tsx', 'if (a.download == b) {}')).toEqual([]);
    expect(scanSource('components/X.tsx', '// showSaveFilePicker nur in userExport.ts')).toEqual([]);
  });

  it('der echte Quellbaum hat 0 Verstöße', async () => {
    const { violations } = await runBoundaryScan();
    expect(violations).toEqual([]);
  });
});
