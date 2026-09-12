import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * AUDIO-P1-003 · Guard: keine No-Op-Audio-Knoten im Live-Signalweg
 * ================================================================
 * Die Tone-kompatible Facade `core/audio/compat/nativeAudioKit` bildet Tone-Klassen
 * als No-Op-Objekte nach: `connect()`, `chain()`, `start()`, `stop()` tun nichts.
 * Im V2-only-Betrieb ist der hörbare Pfad V2StudioGraph / V2OutputGraph /
 * V2MonitorGraph / V2LiveSink / WorkletGraphRuntime samt Worklet-Prozessoren.
 * Ein `new Tone.Gain(…)` in diesem Pfad würde Audio vortäuschen, das nie klingt
 * (AUDIT-AUDIO-006 „kein No-Op im Live-Signalweg").
 *
 * Dieser Test (a) verbietet No-Op-Knoten im Live-Pfad, (b) hält die verbleibende
 * Nutzung als exakte, dokumentierte Ausnahmeliste fest und (c) prüft die
 * Live-Pfad-Liste selbst auf Existenz – damit der Scan nicht still ins Leere
 * greift und grün wird, weil eine Datei umbenannt wurde.
 *
 * Bewusst NICHT gescannt: die generierten Bundles `public/worklets/*.js` und
 * `dist/worklets/*.js` (Build-Artefakte aus `src/audio/worklets/*.ts`, siehe
 * build-worklets.mjs).
 */

const ROOT_URL = new URL('..', import.meta.url);

const readRel = (rel: string): string => readFileSync(new URL(rel, ROOT_URL), 'utf8');

const existsRel = (rel: string): boolean => {
  try {
    readFileSync(new URL(rel, ROOT_URL));
    return true;
  } catch {
    return false;
  }
};

/** Klassen der Facade, die einen Audio-Knoten nur vortäuschen (No-Op). */
const NOOP_NODE_CLASSES = [
  'NodeBase', 'Volume', 'Gain', 'Panner', 'Filter', 'FeedbackDelay', 'Compressor',
  'Limiter', 'MultibandCompressor', 'Analyser', 'Oscillator', 'Noise',
  'AmplitudeEnvelope', 'Synth', 'MembraneSynth', 'MetalSynth', 'NoiseSynth',
  'MonoSynth', 'Player', 'ToneAudioBuffer',
] as const;

/** Die Facade selbst – Definitionsort der No-Op-Klassen, kein Nutzer. */
const FACADE_FILE = 'src/core/audio/compat/nativeAudioKit.ts';

/** Der hörbare V2-Signalweg. Hier darf kein No-Op-Knoten entstehen. */
const LIVE_PATH_MODULES = [
  'src/core/audio/V2StudioGraph.ts',
  'src/core/audio/V2OutputGraph.ts',
  'src/core/audio/V2MonitorGraph.ts',
  'src/core/audio/WorkletGraphRuntime.ts',
  'src/core/audio/backends/V2LiveSink.ts',
  'src/core/audio/backends/WebAudioWorkletBridge.ts',
  'src/core/audio/backends/WorkletAdapter.ts',
] as const;

/** Verzeichnisse des Live-Pfads (rekursiv gescannt). */
const LIVE_PATH_DIRS = [
  'src/core/audio/',
  'src/audio/worklets/',
] as const;

/** Ausgenommen vom Live-Pfad-Scan: die Facade selbst. */
const LIVE_PATH_EXCLUDES = ['src/core/audio/compat/'] as const;

/**
 * Bewusste, dokumentierte Ausnahmen: Zustandsträger der Terminal-Facade.
 * Diese Module bauen Tone-Objekte als *Zustand* auf (Fader/Pan/Master-Pegel,
 * Instrument-Fallbacks); hörbar wird das erst über die Spiegelung in den
 * V2-Graph (`syncV2FromV1`) bzw. über den Worklet-Pfad.
 */
const ALLOWED_NOOP_USERS = [
  'src/audio/instrumentSynth.ts',
  'src/utils/audioEngine.ts',
] as const;

function collectSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(new URL(dir, ROOT_URL), { withFileTypes: true })) {
    const rel = `${dir}${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...collectSources(`${rel}/`));
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Entfernt Block- und reine Zeilenkommentare, damit eine erklärende Notiz
 * ("hier bewusst kein `new Tone.…`") nicht als Fund zählt. Code-Zeilen bleiben
 * unangetastet – auch ein nachgestellter Kommentar wird gescannt, damit die
 * Regel nicht durch Auskommentieren umgangen werden kann.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ');
}

/** Findet `new Tone.<Klasse>(…)` für No-Op-Knotenklassen. */
function noopConstructions(source: string): string[] {
  const found = new Set<string>();
  for (const match of stripComments(source).matchAll(/new\s+Tone\.([A-Za-z0-9_]+)/g)) {
    if ((NOOP_NODE_CLASSES as readonly string[]).includes(match[1])) found.add(match[1]);
  }
  return [...found].sort();
}

/** Alle Dateien unter src/, die No-Op-Knoten erzeugen (ohne die Facade). */
function filesWithNoopConstructions(): string[] {
  return collectSources('src/')
    .filter((rel) => !rel.startsWith('src/core/audio/compat/'))
    .filter((rel) => noopConstructions(readRel(rel)).length > 0)
    .sort();
}

const livePathFiles = [
  ...LIVE_PATH_MODULES,
  ...LIVE_PATH_DIRS.flatMap((d) => collectSources(d).filter(
    (rel) => !LIVE_PATH_EXCLUDES.some((ex) => rel.startsWith(ex)),
  )),
];

describe('AUDIO-P1-003 · No-Op-Facade im Live-Signalweg', () => {
  it('überwacht einen nicht-leeren, tatsächlich existierenden Live-Pfad', () => {
    for (const rel of LIVE_PATH_MODULES) {
      expect(existsRel(rel), `Live-Pfad-Modul fehlt: ${rel}`).toBe(true);
    }
    for (const rel of livePathFiles) {
      expect(existsRel(rel), `Live-Pfad-Datei fehlt: ${rel}`).toBe(true);
    }
    // Der Live-Pfad hat Substanz: Module plus die Worklet-Quellen.
    expect(livePathFiles.length).toBeGreaterThanOrEqual(LIVE_PATH_MODULES.length);
    expect(livePathFiles.some((f) => f.startsWith('src/audio/worklets/'))).toBe(true);
    // Und der src/-Scan sieht überhaupt Dateien.
    expect(collectSources('src/').length).toBeGreaterThan(100);
  });

  it('erzeugt im Live-Signalweg keine No-Op-Audio-Knoten', () => {
    const violations = livePathFiles
      .map((rel) => ({ rel, classes: noopConstructions(readRel(rel)) }))
      .filter((v) => v.classes.length > 0)
      .map((v) => `${v.rel}: ${v.classes.join(', ')}`);
    expect(violations, `No-Op-Knoten im Live-Pfad:\n${violations.join('\n')}`).toEqual([]);
  });

  it('nutzt die No-Op-Knoten in src/ nur in den dokumentierten Ausnahmen', () => {
    const users = filesWithNoopConstructions();
    expect(users).toEqual([...ALLOWED_NOOP_USERS].sort());
  });

  it('legt keine Ausnahmedatei in den Live-Signalweg', () => {
    for (const rel of ALLOWED_NOOP_USERS) {
      expect(existsRel(rel), `Ausnahmedatei fehlt: ${rel}`).toBe(true);
      expect(livePathFiles).not.toContain(rel);
      expect(rel.startsWith('src/core/audio/')).toBe(false);
    }
  });

  it('deklariert alle überwachten No-Op-Klassen in der Facade (Listen-Drift)', () => {
    const facade = readRel(FACADE_FILE);
    const declared = new Set([...facade.matchAll(/\bclass\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]));
    expect(declared.size).toBeGreaterThanOrEqual(NOOP_NODE_CLASSES.length);
    const missing = NOOP_NODE_CLASSES.filter((c) => !declared.has(c));
    expect(missing, `Nicht mehr in ${FACADE_FILE} deklariert: ${missing.join(', ')}`).toEqual([]);
  });
});
