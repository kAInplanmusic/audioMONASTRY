/**
 * audioMONASTRY · SFZ-Regionen (parserfrei)
 * =========================================
 * RT-AUDIT-P1-010: Regionen-Tabelle und Region-Auswahl ohne Text-Parser. Der
 * Audio-Thread (`v2SinkProcessor`) bekommt nur fertige Regionen und braucht
 * deshalb nur dieses Modul; `parseSfz()` (`sfzParser.ts`) läuft im Main-Thread.
 *
 * `matchRegion()`: deterministische Region-Auswahl nach Note, Velocity und
 * Round-Robin-Zähler (LinuxSampler-Vorbild: Velocity-Layer, Round-Robin,
 * Key-Ranges). Pure TS → serverlos testbar.
 */

export interface SfzRegion {
  sample?: string;
  lokey?: number;
  hikey?: number;
  key?: number;
  pitchKeycenter?: number;
  lovel?: number;
  hivel?: number;
  loopMode?: 'no_loop' | 'one_shot' | 'loop_continuous' | 'loop_sustain';
  loopStart?: number;
  loopEnd?: number;
  offset?: number;
  end?: number;
  volume?: number;
  pan?: number;
  tune?: number;
  group?: number;
  offBy?: number;
  seqLength?: number;
  seqPosition?: number;
  /** Unbekannte Opcodes bleiben erhalten (Transparenz). */
  raw: Record<string, string>;
}

export interface RegionMatchOptions {
  /** Round-Robin-Zähler (0-basiert); wird für seq_length/seq_position genutzt. */
  roundRobin?: number;
}

/** Wählt die passende Region für Note + Velocity + Round-Robin. */
export function matchRegion(
  regions: readonly SfzRegion[],
  note: number,
  velocity = 100,
  options: RegionMatchOptions = {},
): SfzRegion | null {
  const candidates = regions.filter((r) => {
    if (r.key !== undefined && r.key !== note) return false;
    if (r.lokey !== undefined && note < r.lokey) return false;
    if (r.hikey !== undefined && note > r.hikey) return false;
    if (r.lovel !== undefined && velocity < r.lovel) return false;
    if (r.hivel !== undefined && velocity > r.hivel) return false;
    return true;
  });

  // Round-Robin: Regionen mit seq_length>1 bilden eine Kette.
  const rr = Math.max(0, Math.floor(options.roundRobin ?? 0));
  const roundRobinCandidates = candidates.filter(
    (r) => r.seqLength !== undefined && r.seqLength > 1,
  );
  if (roundRobinCandidates.length > 0) {
    const seq = rr % roundRobinCandidates.length;
    return roundRobinCandidates[seq] ?? candidates[0] ?? null;
  }
  return candidates[0] ?? null;
}
