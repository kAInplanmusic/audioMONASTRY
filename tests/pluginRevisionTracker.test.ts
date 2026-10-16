// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createPluginRevisionTracker } from '../src/core/session/pluginRevisionTracker';

// ---------------------------------------------------------------------------
// COLLAB-P0-005: das Client-Gedaechtnis fuer die Basisrevision. Die Verdrahtung
// mit dem Netz steht in tests/webrtcManager.test.ts; hier wird die reine
// Entscheidung geprueft — inklusive der beiden Faelle, die in der Analyse als
// eigene Punkte standen: schnelle Folge-Sends desselben Nutzers (Punkt 7) und
// die Deckelung bei verlorenen Bestaetigungen.
// ---------------------------------------------------------------------------

describe('pluginRevisionTracker – Basis und Gedaechtnis', () => {
  it('startet ohne Wissen bei Basis 0', () => {
    const t = createPluginRevisionTracker();
    expect(t.revisionFor('eq')).toBe(0);
    expect(t.baseFor('eq')).toBe(0);
  });

  it('uebernimmt eine beobachtete Revision als Basis', () => {
    const t = createPluginRevisionTracker();
    t.observe('eq', 5);
    expect(t.revisionFor('eq')).toBe(5);
    expect(t.baseFor('eq')).toBe(5);
  });

  it('senkt eine bekannte Revision nicht (verspaetete Nachricht)', () => {
    const t = createPluginRevisionTracker();
    t.observe('eq', 9);
    t.observe('eq', 4);
    expect(t.revisionFor('eq')).toBe(9);
  });

  it('haelt Plugins auseinander', () => {
    const t = createPluginRevisionTracker();
    t.observe('eq', 3);
    t.observe('delay', 11);
    expect(t.baseFor('eq')).toBe(3);
    expect(t.baseFor('delay')).toBe(11);
  });

  it('ignoriert leere oder ungueltige Plugin-IDs ohne Ausnahme', () => {
    const t = createPluginRevisionTracker();
    expect(() => t.observe('', 5)).not.toThrow();
    expect(() => t.observe('   ', 5)).not.toThrow();
    expect(() => t.observe(undefined as never, 5)).not.toThrow();
    expect(() => t.observe('eq', Number.NaN)).not.toThrow();
    expect(t.baseFor('')).toBe(0);
    expect(t.beginLocalWrite('')).toBe(0);
    expect(t.snapshot()).toEqual({});
  });
});

describe('pluginRevisionTracker – Punkt 7: schnelle Folge-Sends desselben Nutzers', () => {
  it('zaehlt die eigene, noch unbestaetigte Aenderung mit', () => {
    const t = createPluginRevisionTracker();
    t.observe('eq', 5);
    // Erster Klick: Basis 5, danach ist ein Schreibvorgang in Flug.
    expect(t.beginLocalWrite('eq')).toBe(5);
    // Zweiter Klick, bevor die Bestaetigung da ist. Ohne die optimistische
    // Erhoehung stuende hier wieder 5 und der Server lehnte ab, obwohl kein
    // fremder Nutzer dazwischen gefunkt hat.
    expect(t.beginLocalWrite('eq')).toBe(6);
  });

  it('faellt nach der Bestaetigung auf den Serverstand zurueck', () => {
    const t = createPluginRevisionTracker();
    t.observe('eq', 5);
    t.beginLocalWrite('eq');
    t.beginLocalWrite('eq');
    expect(t.baseFor('eq')).toBe(7);
    // Der Server meldet nach dem ersten Send Revision 6, nach dem zweiten 7.
    t.confirmLocalWrite('eq', 6);
    expect(t.baseFor('eq')).toBe(6 + 1); // eine Bestaetigung steht noch aus
    t.confirmLocalWrite('eq', 7);
    expect(t.baseFor('eq')).toBe(7);
    expect(t.snapshot().eq).toEqual({ revision: 7, pendingLocalWrites: 0 });
  });

  it('deckelt den Zuwachs bei verlorenen Bestaetigungen', () => {
    // Geht eine Bestaetigung verloren, darf die Basis nicht unbegrenzt steigen —
    // sonst waere jeder weitere Send abgelehnt.
    const t = createPluginRevisionTracker({ maxPendingLocalWrites: 2 });
    t.observe('eq', 5);
    t.beginLocalWrite('eq');
    t.beginLocalWrite('eq');
    expect(t.baseFor('eq')).toBe(7); // 2 in Flug -> Deckel erreicht
    t.beginLocalWrite('eq');
    expect(t.baseFor('eq')).toBe(7); // kein weiterer Zuwachs
  });
});

describe('pluginRevisionTracker – Ablehnung: wiederholen oder aufgeben', () => {
  it('wiederholt beim ersten Mal mit dem kanonischen Stand', () => {
    const t = createPluginRevisionTracker();
    t.observe('eq', 5);
    t.beginLocalWrite('eq');
    const d = t.rejectLocalWrite('eq', 9);
    expect(d).toEqual({ action: 'retry', baseRevision: 9 });
    // Der offene Schreibvorgang ist entwertet, die kanonische Revision uebernommen.
    expect(t.revisionFor('eq')).toBe(9);
    expect(t.baseFor('eq')).toBe(9);
    expect(t.retryCount('eq')).toBe(1);
  });

  it('gibt nach ausgeschoepften Wiederholungen auf (keine Schleife)', () => {
    const t = createPluginRevisionTracker();
    t.beginLocalWrite('eq');
    expect(t.rejectLocalWrite('eq', 3).action).toBe('retry');
    t.beginLocalWrite('eq');
    expect(t.rejectLocalWrite('eq', 4)).toEqual({
      action: 'give-up',
      baseRevision: 4,
      reason: 'retries-exhausted',
    });
  });

  it('erlaubt mehrere Wiederholungen, wenn konfiguriert', () => {
    const t = createPluginRevisionTracker({ maxRetries: 3 });
    expect(t.rejectLocalWrite('eq', 1).action).toBe('retry');
    expect(t.rejectLocalWrite('eq', 2).action).toBe('retry');
    expect(t.rejectLocalWrite('eq', 3).action).toBe('retry');
    expect(t.rejectLocalWrite('eq', 4).action).toBe('give-up');
  });

  it('nimmt die kanonische Revision nicht rueckwaerts (veralteter Resync)', () => {
    const t = createPluginRevisionTracker();
    t.observe('eq', 10);
    t.beginLocalWrite('eq');
    const d = t.rejectLocalWrite('eq', 4);
    expect(d.action).toBe('retry');
    expect(t.revisionFor('eq')).toBe(10);
  });
});

describe('pluginRevisionTracker – reset', () => {
  it('verwirft Revisionen, offene Schreibvorgaenge und Wiederholungszaehler', () => {
    const t = createPluginRevisionTracker();
    t.observe('eq', 7);
    t.beginLocalWrite('eq');
    t.rejectLocalWrite('eq', 8);
    expect(t.snapshot()).not.toEqual({});
    t.reset();
    expect(t.snapshot()).toEqual({});
    expect(t.baseFor('eq')).toBe(0);
    expect(t.retryCount('eq')).toBe(0);
  });
});
