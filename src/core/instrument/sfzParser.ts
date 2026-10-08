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
 * `matchRegion()` (Region-Auswahl) wird aus `sfzRegion.ts` re-exportiert.
 * Läuft nur im Main-Thread (RT-AUDIT-P1-010): der Audio-Thread bekommt fertige
 * Regionen-Tabellen und importiert dieses Modul nicht. Pure TS → serverlos testbar.
 */

import type { SfzRegion } from './sfzRegion';

// RT-AUDIT-P1-010: Regionen-Typ und `matchRegion()` liegen parserfrei in
// `sfzRegion.ts` (der Audio-Thread braucht sie, den Text-Parser nicht).
export { matchRegion, type RegionMatchOptions, type SfzRegion } from './sfzRegion';

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
