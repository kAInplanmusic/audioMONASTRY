/**
 * audioMONASTRY · SFZ-Parser (Open-Source-Audio-Audit A-Klasse)
 * ==============================================================
 * Nativer, deterministischer SFZ-v1-Parser (kein Fremdcode, kein GPL-Code).
 * Unterstützt:
 *   * `<global>` / `<master>` / `<group>` / `<region>`-Hierarchie (Vererbung)
 *   * `sample`, `lokey`/`hikey`, `key`, `pitch_keycenter`
 *   * `lovel`/`hivel` (Velocity-Layer)
 *   * `loop_mode`, `loop_start`, `loop_end`
 *   * `offset`, `end`, `volume`, `pan`, `tune`
 *   * `seq_length`/`seq_position` (Round-Robin)
 *   * Kommentare (`//`) und Leerzeilen; unbekannte Opcodes bleiben als `raw` erhalten
 *
 * Zusätzlich `matchRegion()`: deterministische Region-Auswahl nach Note,
 * Velocity und Round-Robin-Zähler (LinuxSampler-Vorbild: Velocity-Layer,
 * Round-Robin, Key-Ranges). Pure TS → serverlos testbar.
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

export interface SfzParseResult {
  globals: Record<string, string>;
  regions: SfzRegion[];
  errors: string[];
}

const SECTION_RE = /^\s*<(global|master|group|region)>\s*(.*)$/i;

function toNumber(v: string): number | undefined {
  const trimmed = String(v).trim();
  if (trimmed === '') return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

/** Erzeugt eine Region aus den vererbten Opcodes. */
function buildRegion(base: Record<string, string>, section?: Record<string, string>): SfzRegion {
  const merged = { ...base, ...(section ?? {}) };
  const region: SfzRegion = {
    sample: merged.sample,
    lokey: toNumber(merged.lokey ?? ''),
    hikey: toNumber(merged.hikey ?? ''),
    key: toNumber(merged.key ?? ''),
    pitchKeycenter: toNumber(merged.pitch_keycenter ?? ''),
    lovel: toNumber(merged.lovel ?? ''),
    hivel: toNumber(merged.hivel ?? ''),
    loopStart: toNumber(merged.loop_start ?? ''),
    loopEnd: toNumber(merged.loop_end ?? ''),
    offset: toNumber(merged.offset ?? ''),
    end: toNumber(merged.end ?? ''),
    volume: toNumber(merged.volume ?? ''),
    pan: toNumber(merged.pan ?? ''),
    tune: toNumber(merged.tune ?? ''),
    group: toNumber(merged.group ?? ''),
    offBy: toNumber(merged.off_by ?? ''),
    seqLength: toNumber(merged.seq_length ?? ''),
    seqPosition: toNumber(merged.seq_position ?? ''),
    raw: merged,
  };
  if (merged.loop_mode) {
    const m = merged.loop_mode;
    if (m === 'no_loop' || m === 'one_shot' || m === 'loop_continuous' || m === 'loop_sustain') {
      region.loopMode = m;
    }
  }
  return region;
}

/** Parst eine SFZ-v1-Datei in Globals + Regionen. */
export function parseSfz(source: string): SfzParseResult {
  const errors: string[] = [];
  const globals: Record<string, string> = {};
  const regions: SfzRegion[] = [];
  let currentSection: 'global' | 'master' | 'group' | 'region' | null = null;
  let current = new Map<string, string>();
  let regionBase: Record<string, string> = {};

  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const comment = line.indexOf('//');
    if (comment >= 0) line = line.slice(0, comment);
    line = line.trim();
    if (!line) continue;

    const sectionMatch = SECTION_RE.exec(line);
    if (sectionMatch) {
      // Vorherige Sektion abschließen.
      if (currentSection === 'region') {
        regions.push(buildRegion(regionBase, Object.fromEntries(current)));
      } else if (currentSection === 'global') {
        Object.assign(globals, Object.fromEntries(current));
      }

      const section = sectionMatch[1].toLowerCase() as 'global' | 'master' | 'group' | 'region';
      currentSection = section;
      current = new Map<string, string>();

      // Opcodes auf derselben Zeile (<region> sample=… lokey=…) einlesen.
      const rest = sectionMatch[2].trim();
      if (rest) parseOpcodes(rest, current, errors, i + 1);

      // global/master/group wirken als neue Vererbungs-Basis für Regionen.
      if (section === 'global' || section === 'master' || section === 'group') {
        regionBase = { ...regionBase, ...Object.fromEntries(current) };
        if (section === 'global') {
          Object.assign(globals, Object.fromEntries(current));
        }
        current = new Map<string, string>();
      }
      continue;
    }

    if (currentSection) {
      parseOpcodes(line, current, errors, i + 1);
    } else {
      errors.push(`Zeile ${i + 1}: Opcodes außerhalb einer Sektion ignoriert: ${line.slice(0, 60)}`);
    }
  }
  if (currentSection === 'region') {
    regions.push(buildRegion(regionBase, Object.fromEntries(current)));
  }

  return { globals, regions, errors };
}

function parseOpcodes(line: string, target: Map<string, string>, errors: string[], lineNo: number): void {
  for (const token of line.split(/\s+/)) {
    if (!token) continue;
    const eq = token.indexOf('=');
    if (eq <= 0) {
      errors.push(`Zeile ${lineNo}: ungültiger Opcode übersprungen: ${token.slice(0, 60)}`);
      continue;
    }
    const key = token.slice(0, eq);
    let value = token.slice(eq + 1);
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    target.set(key, value);
  }
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
