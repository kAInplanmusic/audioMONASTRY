// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  decideContextRecovery,
  isInterruptionState,
  PLAY_INTENT_AFTER_USER_STOP,
} from '../src/core/audio/live/contextRecovery';

// ---------------------------------------------------------------------------
// Die Entscheidung des Context-Statushandlers war bis 2026-10-16 eine if/else-
// Kette in `audioEngine.init()` und damit untestbar. Zwei Fehler lagen genau
// dort: `interrupted` (iOS) wurde nicht behandelt, und der gesicherte
// Wiedergabewunsch wurde bei JEDEM Wechsel ueberschrieben. Hier wird die
// Entscheidung als reine Funktion geprueft — inklusive des Ablaufs, den ein
// iOS-Anruf wirklich erzeugt.
// ---------------------------------------------------------------------------

describe('contextRecovery – Unterbrechungszustaende', () => {
  it('erkennt suspended UND interrupted als Unterbrechung', () => {
    expect(isInterruptionState('suspended')).toBe(true);
    expect(isInterruptionState('interrupted')).toBe(true);
    expect(isInterruptionState('running')).toBe(false);
    expect(isInterruptionState('closed')).toBe(false);
    expect(isInterruptionState(undefined)).toBe(false);
  });

  it('haelt den Transport bei interrupted an, wenn gerade gespielt wird (iOS-Anruf)', () => {
    // Genau dieser Fall fehlte: `interrupted` lief ins leere else und der
    // Worklet-Transport lief stumm weiter.
    expect(decideContextRecovery('interrupted', true, false)).toBe('interrupt');
  });

  it('haelt den Transport bei suspended an, wenn gerade gespielt wird', () => {
    expect(decideContextRecovery('suspended', true, false)).toBe('interrupt');
  });

  it('startet neu, wenn der Context aus einer Unterbrechung zurueckkommt', () => {
    expect(decideContextRecovery('running', false, true)).toBe('resume');
  });

  it('tut nichts, wenn nie gespielt wurde', () => {
    expect(decideContextRecovery('running', false, false)).toBe('none');
    expect(decideContextRecovery('suspended', false, false)).toBe('none');
    expect(decideContextRecovery('interrupted', false, false)).toBe('none');
  });

  it('tut bei unbekannten Zustaenden nichts', () => {
    expect(decideContextRecovery('closed', true, true)).toBe('none');
    expect(decideContextRecovery(undefined, true, true)).toBe('none');
  });
});

describe('contextRecovery – Ablauf einer iOS-Unterbrechung', () => {
  /**
   * Spielt die Zustandsfolge durch, die der Handler wirklich sieht, und
   * zaehlt Anhalten/Wiederaufnahmen. Ohne den Fix laeuft 'suspended' nach
   * 'interrupted' noch einmal durch den Unterbrechungszweig und setzt den
   * Wiedergabewunsch auf false — dann gibt es KEINE Wiederaufnahme (0 statt 1).
   */
  const runSequence = (states: readonly string[]) => {
    let isPlaying = true;
    let intent = false;
    let interrupts = 0;
    let resumes = 0;
    for (const state of states) {
      const action = decideContextRecovery(state, isPlaying, intent);
      if (action === 'interrupt') {
        interrupts += 1;
        intent = true;
        isPlaying = false;
      } else if (action === 'resume') {
        resumes += 1;
        intent = false;
        isPlaying = true;
      }
    }
    return { interrupts, resumes, isPlaying, intent };
  };

  it('interrupted -> suspended -> running: genau EIN Anhalten, EINE Wiederaufnahme', () => {
    const r = runSequence(['interrupted', 'suspended', 'running']);
    expect(r.interrupts).toBe(1);
    expect(r.resumes).toBe(1);
    expect(r.isPlaying).toBe(true);
    expect(r.intent).toBe(false);
  });

  it('suspended -> interrupted -> running: ebenso genau einmal', () => {
    const r = runSequence(['suspended', 'interrupted', 'running']);
    expect(r.interrupts).toBe(1);
    expect(r.resumes).toBe(1);
    expect(r.isPlaying).toBe(true);
  });

  it('mehrfacher Wechsel innerhalb der Unterbrechung verliert den Wunsch nicht', () => {
    const r = runSequence([
      'interrupted', 'suspended', 'interrupted', 'suspended', 'interrupted', 'running',
    ]);
    expect(r.interrupts).toBe(1);
    expect(r.resumes).toBe(1);
    expect(r.isPlaying).toBe(true);
  });

  it('ein Nutzer-Stop waehrend der Unterbrechung verhindert die Wiederaufnahme', () => {
    let isPlaying = true;
    let intent = false;

    // Der Context bricht weg (Anruf) -> Wunsch gesichert, Transport angehalten.
    expect(decideContextRecovery('interrupted', isPlaying, intent)).toBe('interrupt');
    intent = true;
    isPlaying = false;

    // Der Nutzer drueckt ausdruecklich Stop: Widerruf des Wunsches.
    intent = PLAY_INTENT_AFTER_USER_STOP;
    expect(intent).toBe(false);

    // Rueckkehr nach running: KEIN Auto-Start.
    expect(decideContextRecovery('running', isPlaying, intent)).toBe('none');
  });
});
