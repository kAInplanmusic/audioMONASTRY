/**
 * AUDIO-2026-11-06-002 (a) · Transpose-/Oktav-Validierung
 * =======================================================
 * Belege fuer drei Fehlerbilder aus dem Ticket:
 *  - `InstrumentBackend.setParam` schrieb JEDEN Wert ungeprueft und
 *    `transpose()` rechnete ohne Integer-/Finite-/Bereichspruefung
 *    (transpose 1.5 → "undefined4", Infinity → "undefinedNaN").
 *  - `ItSynthBank.config` uebernahm `def.transpose` ungeprueft und LIESS den
 *    alten Wert stehen, wenn das naechste Def keinen hat; NaN/Infinity machten
 *    die Stimme ganz stumm (Math.pow(2, NaN/12) → NaN → Ausgabe 0).
 *  - `Tone.Frequency(-440)` lieferte NaN (MIDI = 69 + 12·log2(−1)).
 *
 * Notennamen A3/C5/G2/Bb4 und die Oktavformel sind mit 228b0057 schon korrekt
 * (AUDIO-2026-11-06-001); die Tests halten sie als Regressionsschutz fest.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ItSynthBank } from '../src/core/instrument/itSynthVoice';
import type { InstrumentPitchDef } from '../src/core/instrument/itSynthVoice';
import { Frequency } from '../src/core/audio/compat/nativeAudioKit';

const { instrumentNote, playSynthesisInstrument } = vi.hoisted(() => ({
  instrumentNote: vi.fn(),
  playSynthesisInstrument: vi.fn(),
}));

vi.mock('../src/utils/audioEngine', () => ({
  audioEngine: {
    loadInstrument: async () => {},
    instrumentNote,
    instrumentRelease: vi.fn(),
    playSynthesisInstrument,
  },
}));

import { InstrumentBackend } from '../src/core/instrument/InstrumentBackend';

const SR = 48000;

/** Backend auf einem Synthesizer-Patch (id > 50 → playSynthesisInstrument). */
async function synthBackend(): Promise<InstrumentBackend> {
  const backend = new InstrumentBackend();
  await backend.load(102);
  return backend;
}

/** noteOn und die tatsaechlich an die Engine gereichte Note zurueckgeben. */
async function playedNote(backend: InstrumentBackend, note: number | string): Promise<number | string> {
  playSynthesisInstrument.mockClear();
  backend.noteOn(note, 1);
  await vi.waitFor(() => expect(playSynthesisInstrument).toHaveBeenCalled());
  return playSynthesisInstrument.mock.calls.at(-1)![1] as number | string;
}

// ---------------------------------------------------------------------------
// Frequenz-Messung fuer die itSynth-Stimme (Nulldurchgaenge eines Sinus)
// ---------------------------------------------------------------------------
function zeroCrossingFreq(buffer: Float32Array): number {
  let crossings = 0;
  for (let i = 1; i < buffer.length; i++) {
    if ((buffer[i - 1] <= 0 && buffer[i] > 0) || (buffer[i - 1] >= 0 && buffer[i] < 0)) crossings++;
  }
  return (crossings / 2) * (SR / buffer.length);
}

function itDef(extra: Partial<InstrumentPitchDef> = {}): InstrumentPitchDef {
  return { id: 1, name: 'test', kind: 'synth', osc: 'sine', attack: 0.001, release: 0.05, ...extra };
}

function renderNote(note: number | string, def: InstrumentPitchDef): Float32Array {
  const bank = new ItSynthBank();
  bank.config(def);
  bank.noteOn(note, 1);
  const out = new Float32Array(8192);
  for (let b = 0; b < 4; b++) bank.renderBlock(out.subarray(b * 2048, (b + 1) * 2048));
  return out;
}

function freqOf(note: number | string, def: InstrumentPitchDef = itDef()): number {
  return zeroCrossingFreq(renderNote(note, def));
}

function expectFreq(actual: number, expected: number): void {
  expect(Math.abs(actual - expected), `${actual.toFixed(2)} Hz statt ${expected.toFixed(2)} Hz`).toBeLessThan(5);
}

describe('InstrumentBackend · Transpose-Validierung (Notennamen)', () => {
  beforeEach(() => playSynthesisInstrument.mockClear());

  it('transponiert um genau einen Halbton (C4 +1 = C#4, kein Oktavsprung)', async () => {
    const backend = await synthBackend();
    backend.setParam('transpose', 1);
    expect(await playedNote(backend, 'C4')).toBe('C#4');
  });

  it('rechnet in beide Richtungen und ueber Oktavgrenzen', async () => {
    const backend = await synthBackend();
    backend.setParam('transpose', -1);
    expect(await playedNote(backend, 'C4')).toBe('B3');
    backend.setParam('transpose', 12);
    expect(await playedNote(backend, 'C4')).toBe('C5');
    backend.setParam('transpose', -12);
    expect(await playedNote(backend, 'C4')).toBe('C3');
  });

  it('weist Nicht-Integer ab, statt "undefined4" zu erzeugen', async () => {
    const backend = await synthBackend();
    backend.setParam('transpose', 1.5);
    expect(backend.getParams().transpose).toBe(0);
    expect(await playedNote(backend, 'C4')).toBe('C4');
    // Auch ein bereits gueltiger Wert bleibt nach 1.5 unveraendert.
    backend.setParam('transpose', 2);
    backend.setParam('transpose', 1.5);
    expect(backend.getParams().transpose).toBe(2);
  });

  it('weist NaN und Infinity ab; der letzte gueltige Wert bleibt', async () => {
    const backend = await synthBackend();
    backend.setParam('transpose', 3);
    backend.setParam('transpose', Number.NaN);
    backend.setParam('transpose', Number.POSITIVE_INFINITY);
    backend.setParam('transpose', Number.NEGATIVE_INFINITY);
    expect(backend.getParams().transpose).toBe(3);
    expect(await playedNote(backend, 'C4')).toBe('D#4');
  });

  it('begrenzt transpose auf ±48 Halbtoene', async () => {
    const backend = await synthBackend();
    backend.setParam('transpose', 1000);
    expect(backend.getParams().transpose).toBe(48);
    backend.setParam('transpose', -1000);
    expect(backend.getParams().transpose).toBe(-48);
  });

  it('klemmt Notennamen auf den MIDI-Bereich 0..127 (kein Name ausserhalb)', async () => {
    const backend = await synthBackend();
    backend.setParam('transpose', 12);
    expect(await playedNote(backend, 'G9')).toBe('G9');
    backend.setParam('transpose', -12);
    expect(await playedNote(backend, 'C-1')).toBe('C-1');
  });

  it('laesst unbekannte Notennamen unveraendert', async () => {
    const backend = await synthBackend();
    backend.setParam('transpose', 7);
    expect(await playedNote(backend, 'H4')).toBe('H4');
    expect(await playedNote(backend, 'C4foo')).toBe('C4foo');
  });

  it('A3/C5/G2/Bb4 bleiben ohne Transpose unveraendert (Oktavformel, Septime)', async () => {
    const backend = await synthBackend();
    for (const name of ['A3', 'C5', 'G2', 'Bb4']) {
      expect(await playedNote(backend, name)).toBe(name);
    }
  });

  it('A3/C5/G2/Bb4 mit +12 landen genau eine Oktave hoeher', async () => {
    const backend = await synthBackend();
    backend.setParam('transpose', 12);
    expect(await playedNote(backend, 'A3')).toBe('A4');
    expect(await playedNote(backend, 'C5')).toBe('C6');
    expect(await playedNote(backend, 'G2')).toBe('G3');
    expect(await playedNote(backend, 'Bb4')).toBe('A#5');
  });
});

describe('InstrumentBackend · Transpose-Validierung (MIDI-Zahlen)', () => {
  it('verschiebt MIDI-Zahlen und klemmt sie auf 0..127', async () => {
    const backend = await synthBackend();
    expect(await playedNote(backend, 60)).toBe(60);
    backend.setParam('transpose', 7);
    expect(await playedNote(backend, 60)).toBe(67);
    expect(await playedNote(backend, 127)).toBe(127);
    backend.setParam('transpose', -7);
    expect(await playedNote(backend, 0)).toBe(0);
  });

  it('weist NaN/Infinity als Note ab, ohne die Engine mit NaN zu fuellen', async () => {
    const backend = await synthBackend();
    backend.setParam('transpose', 2);
    playSynthesisInstrument.mockClear();
    backend.noteOn(Number.NaN, 1);
    backend.noteOn(Number.POSITIVE_INFINITY, 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(playSynthesisInstrument).not.toHaveBeenCalled();
    expect(instrumentNote).not.toHaveBeenCalled();
  });
});

describe('InstrumentBackend · setParam klemmt die uebrigen Preset-Werte', () => {
  async function velocityArg(backend: InstrumentBackend): Promise<number> {
    playSynthesisInstrument.mockClear();
    // Ohne explizite Velocity → preset.velocity wird benutzt.
    backend.noteOn(60);
    await vi.waitFor(() => expect(playSynthesisInstrument).toHaveBeenCalled());
    return playSynthesisInstrument.mock.calls.at(-1)![2] as number;
  }

  it('gain/pan/velocity werden geklemmt und NaN/Infinity abgewiesen', async () => {
    const backend = await synthBackend();
    backend.setParam('gain', 5);
    expect(backend.getParams().gain).toBe(1.5);
    backend.setParam('pan', 3);
    expect(backend.getParams().pan).toBe(1);
    backend.setParam('pan', -3);
    expect(backend.getParams().pan).toBe(-1);
    backend.setParam('velocity', -1);
    expect(backend.getParams().velocity).toBe(0);

    backend.setParam('gain', Number.NaN);
    backend.setParam('pan', Number.POSITIVE_INFINITY);
    expect(backend.getParams().gain).toBe(1.5);
    expect(backend.getParams().pan).toBe(-1);

    expect(await velocityArg(backend)).toBe(0);
  });
});

describe('ItSynthBank · def.transpose (Kleben, NaN, Bereich)', () => {
  it('transponiert die Note um ganze Halbtoene (C4 +12 = C5)', () => {
    expectFreq(freqOf('C4'), 261.63);
    expectFreq(freqOf('C4', itDef({ transpose: 1 })), 277.18);
    expectFreq(freqOf('C4', itDef({ transpose: 12 })), 523.25);
  });

  it('setzt transpose zurueck, wenn das naechste Def keinen hat (kein Kleben)', () => {
    const stuck = new ItSynthBank();
    stuck.config(itDef({ transpose: 12 }));
    stuck.config(itDef());
    stuck.noteOn('C4', 1);
    const out = new Float32Array(8192);
    for (let b = 0; b < 4; b++) stuck.renderBlock(out.subarray(b * 2048, (b + 1) * 2048));
    expectFreq(zeroCrossingFreq(out), 261.63);
  });

  it('verwirft NaN/Infinity/Nicht-Integer statt die Stimme stumm zu schalten', () => {
    expectFreq(freqOf('C4', itDef({ transpose: Number.NaN })), 261.63);
    expectFreq(freqOf('C4', itDef({ transpose: Number.POSITIVE_INFINITY })), 261.63);
    expectFreq(freqOf('C4', itDef({ transpose: 1.5 })), 261.63);
  });

  it('begrenzt def.transpose auf ±48 Halbtoene', () => {
    expectFreq(freqOf('C4', itDef({ transpose: 48 })), 261.63 * 2 ** 4);
    expectFreq(freqOf('C4', itDef({ transpose: 1000 })), 261.63 * 2 ** 4);
  });

  it('liest A3/C5/G2/Bb4 als 57/72/43/70 (Name = MIDI-Zahl)', () => {
    const pairs: Array<[string, number]> = [['A3', 57], ['C5', 72], ['G2', 43], ['Bb4', 70]];
    for (const [name, midi] of pairs) {
      expect(renderNote(name, itDef())).toEqual(renderNote(midi, itDef()));
    }
  });
});

describe('nativeAudioKit · Frequency-Guard', () => {
  const MIDI_MIN_HZ = 440 * 2 ** ((0 - 69) / 12);   // 8,1758 Hz
  const MIDI_MAX_HZ = 440 * 2 ** ((127 - 69) / 12); // 12543,85 Hz

  it('liefert fuer negative, unendliche und NaN-Frequenzen einen endlichen Wert', () => {
    for (const bad of [-440, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const hz = Frequency(bad).toFrequency();
      expect(Number.isFinite(hz), `${bad} → ${hz}`).toBe(true);
      expect(hz).toBeGreaterThanOrEqual(MIDI_MIN_HZ - 1e-6);
      expect(hz).toBeLessThanOrEqual(MIDI_MAX_HZ + 1e-6);
    }
  });

  it('klemmt 0 Hz und zu hohe Frequenzen auf den MIDI-Bereich', () => {
    expect(Frequency(0).toFrequency()).toBeCloseTo(MIDI_MIN_HZ, 6);
    expect(Frequency(1e9).toFrequency()).toBeCloseTo(MIDI_MAX_HZ, 2);
  });

  it('laesst gueltige Frequenzen und Notennamen unveraendert', () => {
    expect(Frequency(261.63).toFrequency()).toBeCloseTo(261.63, 6);
    expect(Frequency('C4').toFrequency()).toBeCloseTo(261.63, 1);
    expect(Frequency('Bb4').toFrequency()).toBeCloseTo(466.16, 1);
    expect(Frequency(60, 'midi').toFrequency()).toBeCloseTo(261.63, 1);
  });

  it('klemmt Notennamen ausserhalb des MIDI-Bereichs und NaN in der MIDI-Einheit', () => {
    const high = Frequency('C99').toFrequency();
    expect(Number.isFinite(high)).toBe(true);
    expect(high).toBeLessThanOrEqual(MIDI_MAX_HZ + 1e-6);
    const midiNaN = Frequency(Number.NaN, 'midi').toFrequency();
    expect(Number.isFinite(midiNaN)).toBe(true);
  });
});
