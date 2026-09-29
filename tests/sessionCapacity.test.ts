/**
 * Die 4-Nutzer-Grenze — und warum es diesen Test seit 2026-09-24 gibt.
 *
 * BEFUND: die Grenze existierte bereits (`MAX_SESSION_USERS = 4`,
 * `server/realtime.ts`), war aber NIRGENDS geprueft. Sie stand als Zahl in einer
 * Kommentarzeile, und niemand konnte sagen, ob sie greift. Schlimmer: ich selbst
 * habe sie in PRINCIPLES.md als "nicht vorhanden" bezeichnet, weil mein
 * Suchmuster zu eng war (`MAX_USERS` trifft `MAX_SESSION_USERS` nicht).
 *
 * Ein Zugangsdeckel, den niemand nachgemessen hat, ist eine Behauptung. Diese
 * Datei macht aus der Behauptung eine Pruefung.
 *
 * Lauf: npx vitest run tests/sessionCapacity.test.ts
 */
import { describe, expect, it } from 'vitest';
import { MAX_SESSION_USERS, sessionCapacityCheck } from '../server/realtime';

describe('4-Nutzer-Grenze (sessionCapacityCheck)', () => {
  it('die Obergrenze ist genau 4 — eine Zahl, nicht mehrere', () => {
    expect(MAX_SESSION_USERS).toBe(4);
  });

  it('laesst den vierten Teilnehmer zu (3 andere anwesend)', () => {
    // Drei sind da, dieser waere der vierte: erlaubt.
    expect(sessionCapacityCheck(3).erlaubt).toBe(true);
    expect(sessionCapacityCheck(3).grund).toBe('OK');
  });

  it('weist den fuenften ab (4 andere anwesend)', () => {
    const ergebnis = sessionCapacityCheck(4);
    expect(ergebnis.erlaubt).toBe(false);
    expect(ergebnis.grund).toBe('SESSION_FULL');
  });

  it('weist auch bei mehr Anwesenden ab (kein Ueberlauf, kein Durchrutschen)', () => {
    for (const andere of [5, 8, 99]) {
      expect(sessionCapacityCheck(andere).erlaubt).toBe(false);
    }
  });

  it('laesst den ersten Teilnehmer immer zu (0 andere)', () => {
    expect(sessionCapacityCheck(0).erlaubt).toBe(true);
  });

  it('Ausspielwege zaehlen NICHT als Teilnehmer (Beamer und PA)', () => {
    // Szenario aus dem Code: vier iPads in der Session, dazu ein Laptop an der PA
    // (/master-out) und ein Beamer (/visual-out). Beide sind Ausspielwege, keine
    // Teilnehmer — sie duerfen die Grenze nicht verbrauchen und nicht an ihr
    // scheitern, auch nicht bei voller Session.
    for (const modus of ['master-out', 'visual-out']) {
      expect(sessionCapacityCheck(4, modus).erlaubt).toBe(true);
      expect(sessionCapacityCheck(99, modus).erlaubt).toBe(true);
      expect(sessionCapacityCheck(99, modus).grund).toBe('OK');
    }
  });

  it('die Grenze ist von aussen einstellbar, aber die Vorgabe gilt', () => {
    // Der dritte Parameter existiert fuer Tests, nicht fuer den Betrieb.
    expect(sessionCapacityCheck(2, 'member', 2).erlaubt).toBe(false);
    expect(sessionCapacityCheck(2, 'member').erlaubt).toBe(true);
  });

  it('unbekannte Modi werden als Teilnehmer behandelt (fail-closed)', () => {
    // Wichtig: ein Tippfehler im Modus darf keine zusaetzliche Tuer oeffnen.
    for (const modus of ['', 'gast', 'MASTER-OUT', 'master_out', 'member']) {
      expect(sessionCapacityCheck(4, modus).erlaubt).toBe(false);
    }
  });
});
