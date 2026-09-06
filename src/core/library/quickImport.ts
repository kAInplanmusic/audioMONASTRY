/**
 * audioMONASTRY · biblioMONK Quick-Import (Stick/Laufwerk)
 * ========================================================
 * Reine Kernlogik (keine Platform-APIs – Boundary-konform):
 *   - Dateinamen parsen (Interpret – Titel), Genre/Tags ableiten
 *   - Einträge erzeugen, die der UI-Layer mit URL/Blob + Persistenz füllt
 *   - Duplikat-Erkennung über Dateiname+Größe
 */

export interface QuickImportEntry {
  id: string;
  name: string;
  artist: string;
  tags: string[];
  fileName: string;
  sizeBytes: number;
  importedAt: string;
}

const GENRE_KEYWORDS: [RegExp, string][] = [
  [/techno|acid|berlin/i, 'techno'],
  [/house|garage/i, 'house'],
  [/drum ?n ?bass|dnb|jungle/i, 'drum-and-bass'],
  [/orchestr|orchester|streicher|geige|violin|strings|harp|flute|piano|celli|brass|woodwind|choir/i, 'orchestral'],
  [/guitar|rock|metal/i, 'guitar'],
  [/jazz|swing/i, 'jazz'],
  [/ambient|drone|pad/i, 'ambient'],
  [/vocal|vocals|choir|sing/i, 'vocal'],
  [/kick|808|909|drum/i, 'drums'],
  [/bass/i, 'bass'],
  [/synth|lead|arp/i, 'synth'],
  [/loop/i, 'loop'],
  [/sfx|effect|foley/i, 'sfx'],
];

/** "Kraft und Licht (Ostgut Ton).wav" → { artist:'', title:'Kraft und Licht' } */
export function parseFileName(fileName: string): { artist: string; title: string } {
  const base = (fileName || '').replace(/\.[A-Za-z0-9]{1,5}$/, '').trim();
  const parts = base.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  return { artist: '', title: base };
}

export function inferTags(fileName: string): string[] {
  const tags = new Set<string>();
  for (const [re, tag] of GENRE_KEYWORDS) if (re.test(fileName)) tags.add(tag);
  if (tags.size === 0) tags.add('unbekannt');
  return [...tags];
}

function hash(fileName: string, size: number): string {
  let h = 2166136261;
  const s = `${fileName}:${size}`;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

/** Baut Import-Einträge für eine Liste von Dateien (Name+Größe genügen). */
export function buildQuickImportEntries(
  files: { name: string; size: number }[],
  now = new Date().toISOString(),
): QuickImportEntry[] {
  return files.map((f) => {
    const { artist, title } = parseFileName(f.name);
    const tags = inferTags(f.name);
    return {
      id: hash(f.name, f.size),
      name: title || f.name,
      artist,
      tags,
      fileName: f.name,
      sizeBytes: f.size,
      importedAt: now,
    };
  });
}

/** Duplikate innerhalb des Imports erkennen (gleiche Datei/Größe). */
export function dedupeEntries(entries: QuickImportEntry[]): QuickImportEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => {
    const key = `${e.fileName}:${e.sizeBytes}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
