/**
 * PROD-P1-F4 · Build-Metadaten und Commit-Paritaet (Server-/Testseite)
 * ====================================================================
 * Anlass (real gemessen am 2026-09-20): `/api/health` nannte nur
 * `{"status":"ok","version":"1.210.001"}`. Diese Version aendert sich nicht mit
 * jedem Commit - auf app-1 lief deshalb ein Image vom 18.09. unbemerkt weiter,
 * waehrend das Repo auf `ae5e749` (20.09.) stand.
 *
 * Der Test haelt die vier Regeln fest, die das Staleness-Gate ausmachen, und
 * genau die Schreibweise, die auch der Portal-Worker
 * (tests/portalWorkerStaleness.test.ts) und die Shell
 * (scripts/hetzner/lib/build-parity.sh, geprueft in
 * tests/test_hetzner_scripts.py) benutzen:
 *   1. gleich             -> ok
 *   2. kurz trifft lang   -> ok (Prefix, beide Richtungen)
 *   3. abweichend         -> nicht ok (belegte Abweichung)
 *   4. fehlend            -> NICHT pruefbar: ok=false gibt es nicht, nur
 *                            checked=false - ein vor F4 gebautes Image darf
 *                            keinen Alarm ausloesen.
 */
import { describe, expect, it } from 'vitest';
import {
  compareCommits,
  FALLBACK_BUILD_VERSION,
  normalizeCommit,
  readBuildInfo,
  UNKNOWN_BUILD_VALUE,
} from '../server/buildInfo';

describe('readBuildInfo (Build-Stempel im Image)', () => {
  it('liest Version, Commit und Build-Zeit aus der Umgebung', () => {
    const info = readBuildInfo({
      AUDIOMONASTRY_VERSION: '1.210.001',
      AUDIOMONASTRY_COMMIT: 'ae5e749',
      AUDIOMONASTRY_BUILD_TIME: '2026-09-20T15:04:05Z',
    });
    expect(info).toEqual({
      version: '1.210.001',
      commit: 'ae5e749',
      buildTime: '2026-09-20T15:04:05Z',
    });
  });

  it('nennt ohne Stempel dev/unknown statt zu luegen', () => {
    expect(readBuildInfo({})).toEqual({
      version: FALLBACK_BUILD_VERSION,
      commit: UNKNOWN_BUILD_VALUE,
      buildTime: UNKNOWN_BUILD_VALUE,
    });
  });

  it('behandelt leere und nur aus Leerzeichen bestehende Werte als fehlend', () => {
    expect(readBuildInfo({
      AUDIOMONASTRY_VERSION: '   ',
      AUDIOMONASTRY_COMMIT: '',
      AUDIOMONASTRY_BUILD_TIME: '  ',
    })).toEqual({
      version: FALLBACK_BUILD_VERSION,
      commit: UNKNOWN_BUILD_VALUE,
      buildTime: UNKNOWN_BUILD_VALUE,
    });
  });
});

describe('normalizeCommit', () => {
  it('macht Angaben vergleichbar (Kleinschreibung, getrimmt, gekuerzt)', () => {
    expect(normalizeCommit('  AE5E749 ')).toBe('ae5e749');
    expect(normalizeCommit('a'.repeat(64))).toHaveLength(40);
  });

  it('verwirft Platzhalter - sie sind keine Commits', () => {
    for (const value of ['', '   ', null, undefined, 'unknown', 'UNKNOWN', 'dev', 'none', 'null']) {
      expect(normalizeCommit(value as string)).toBe('');
    }
  });
});

describe('compareCommits (Staleness-Regel)', () => {
  it('gleicher Commit ist Paritaet', () => {
    const parity = compareCommits('ae5e749', 'ae5e749');
    expect(parity).toMatchObject({ ok: true, checked: true, expected: 'ae5e749', actual: 'ae5e749' });
    expect(parity.message).toContain('Commit-Paritaet ok');
  });

  it('kurzer SHA trifft langen - in beide Richtungen', () => {
    const short = compareCommits('ae5e749', 'ae5e7491234567890abcdef1234567890abcdef12');
    expect(short.ok).toBe(true);
    expect(short.checked).toBe(true);
    const long = compareCommits('ae5e7491234567890abcdef1234567890abcdef12', 'ae5e749');
    expect(long.ok).toBe(true);
  });

  it('abweichender Commit ist eine belegte Abweichung mit Klartextmeldung', () => {
    const parity = compareCommits('ae5e749', 'deadbee');
    expect(parity).toMatchObject({ ok: false, checked: true, expected: 'ae5e749', actual: 'deadbee' });
    expect(parity.message).toBe('Flotte laeuft Stand deadbee, Repo ist ae5e749.');
  });

  it('ein Praefix-Treffer allein genuegt NICHT bei echtem Unterschied', () => {
    // Gleiche Laenge, kein Prefix -> Abweichung (kein "irgendwie aehnlich").
    expect(compareCommits('ae5e749', 'ae5e750').ok).toBe(false);
    expect(compareCommits('ae5e749', 'be5e749').ok).toBe(false);
  });

  it('fehlender gemeldeter Commit blockiert NICHT, wird aber gemeldet', () => {
    const parity = compareCommits('ae5e749', undefined, 'health');
    expect(parity.ok).toBe(true);
    expect(parity.checked).toBe(false);
    expect(parity.actual).toBeNull();
    expect(parity.message).toContain('nicht pruefbar');
    expect(parity.message).toContain('ae5e749');
  });

  it('Image ohne commit-Feld (unknown) gilt ebenfalls als nicht pruefbar', () => {
    const parity = compareCommits('ae5e749', 'unknown');
    expect(parity).toMatchObject({ ok: true, checked: false, actual: null });
  });

  it('ohne Erwartung wird keine Paritaet behauptet', () => {
    const parity = compareCommits('', 'ae5e749');
    expect(parity).toMatchObject({ ok: true, checked: false, expected: null, actual: 'ae5e749' });
    expect(parity.message).toContain('nicht vergleichbar');
  });

  it('die Quelle des gemeldeten Stands steht im Klartext', () => {
    expect(compareCommits('ae5e749', undefined, 'snapshot').message).toContain('snapshot');
  });
});
