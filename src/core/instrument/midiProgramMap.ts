/**
 * audioMONASTRY · instrumentMONK – MIDI-Program-Change-Mapping (Plugin #9 / Task 2)
 * ================================================================================
 * Zentrale Zuordnung der 100 Instrumente (50 akustische Patches + 50 Synthese-
 * Presets) auf MIDI-Program-Nummern (0..127).
 *
 * Regeln:
 *  - Bereits vergebene, eindeutige `midiProgram`-Werte der Definitionen werden
 *    respektiert (deterministisch in Katalog-Reihenfolge).
 *  - Kollisionen und fehlende Werte werden auf die nächste freie Programmnummer
 *    gelegt. Dadurch ist die Tabelle vollständig eindeutig und reproduzierbar.
 *  - Keine UI darf diese Zuordnung selbst hart verdrahten; alle Module nutzen
 *    ausschließlich diese Tabelle.
 */
import { INSTRUMENT_CATALOG } from './catalog';
import type { InstrumentDefinition } from './types';

export const MAX_MIDI_PROGRAM = 127;

/** Programmnummer (0..127) → Instrument-ID. */
export const INSTRUMENT_PROGRAM_MAP: ReadonlyMap<number, number> = buildProgramMap();

/** Instrument-ID → Programmnummer (0..127). */
export const INSTRUMENT_TO_PROGRAM: ReadonlyMap<number, number> = (() => {
  const m = new Map<number, number>();
  INSTRUMENT_PROGRAM_MAP.forEach((instrumentId, program) => m.set(instrumentId, program));
  return m;
})();

/** Flache Tabelle für UI/Registry-Anzeigen (Programm → Instrument). */
export const PROGRAM_CHANGE_TABLE: { program: number; instrumentId: number; name: string }[] =
  INSTRUMENT_CATALOG.map((def) => ({
    program: INSTRUMENT_TO_PROGRAM.get(def.id) ?? -1,
    instrumentId: def.id,
    name: def.name,
  })).filter((row) => row.program >= 0)
    .sort((a, b) => a.program - b.program);

function buildProgramMap(): Map<number, number> {
  const programToId = new Map<number, number>();
  const idToProgram = new Map<number, number>();

  // 1) Eindeutige, bereits vergebene midiProgram-Werte übernehmen.
  for (const def of INSTRUMENT_CATALOG) {
    const p = def.midiProgram;
    if (
      typeof p === 'number' &&
      Number.isInteger(p) &&
      p >= 0 &&
      p <= MAX_MIDI_PROGRAM &&
      !programToId.has(p)
    ) {
      programToId.set(p, def.id);
      idToProgram.set(def.id, p);
    }
  }

  // 2) Restliche Instrumente auf die nächste freie Programmnummer legen.
  let next = 0;
  for (const def of INSTRUMENT_CATALOG) {
    if (idToProgram.has(def.id)) continue;
    while (programToId.has(next)) next++;
    programToId.set(next, def.id);
    idToProgram.set(def.id, next);
    next++;
  }

  return programToId;
}

/** Liefert das Instrument zu einer MIDI-Programmnummer (oder `undefined`). */
export function getInstrumentByProgram(program: number): InstrumentDefinition | undefined {
  const id = INSTRUMENT_PROGRAM_MAP.get(program);
  if (id === undefined) return undefined;
  return INSTRUMENT_CATALOG.find((def) => def.id === id);
}

/** Liefert die Programmnummer zu einer Instrument-ID (oder `undefined`). */
export function getProgramForInstrument(id: number): number | undefined {
  return INSTRUMENT_TO_PROGRAM.get(id);
}
