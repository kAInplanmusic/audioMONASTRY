#!/usr/bin/env node
/**
 * validate-interface-boundaries.mjs
 * ==================================
 * Import-/Nutzungs-Analyse der Phase-1-Abstraktionsschichten (Aufgabe 1.1):
 * Die 16 Kernmodule dürfen KEINE direkten Browser-/Plattform-APIs verwenden,
 * sondern müssen über die Interfaces (IAudioBackend, IAIRuntime,
 * IComputeBackend, ISpatialRenderer, IHardwareAdapter, ITransport) laufen.
 *
 * Als "erlaubte Adapter-Schicht" gelten nur die Referenzimplementierungen
 * und die bestehenden Infrastruktur-Module. Alles andere ist ein Verstoß.
 *
 * Aufruf: node scripts/validate-interface-boundaries.mjs
 * Exit-Code: 0 = keine Verstöße, 1 = Verstöße gefunden.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

/** Dateien/Verzeichnisse, die die Plattform-APIs kapseln dürfen. */
const ALLOWED = new Set([
  'utils/audioEngine.ts',          // zentraler Web-Audio-Wrapper (IAudioBackend-Referenz)
  'core/audio/compat/nativeAudioKit.ts', // Tone-kompatibler WebAudio-Adapter (V1-Ruhestand)
  'utils/WebRTCManager.ts',        // ITransport-Referenz (WebRTC)
  'utils/opfs.ts',                 // Storage-Adapter (OPFS)
  'utils/LocalEmbeddingProvider.ts', // IAIRuntime-lokal (transformers.js)
  'utils/storage.ts',              // localStorage-Adapter
  'utils/indexedDB.ts',            // IndexedDB-Adapter
  'utils/mediaDevices.ts',         // getUserMedia/enumerateDevices-Adapter
  'utils/midiAccess.ts',          // Web-MIDI-Adapter (IHardwareAdapter)
  'utils/workerFactory.ts',        // Worker-Factory (IComputeBackend-Auslagerung)
  'utils/audioContextFactory.ts',  // AudioContext-Factory (Analyse/Diagnose)
  'core/WebAudioBackend.ts',       // IAudioBackend-Referenz
  'core/audio/backends/WebAudioBackend.ts', // IAudioGraphBackend-Referenz (WebAudio)
  'core/adapters.ts',              // alle Referenz-Adapter
  'core/transport/MediasoupTransport.ts',
  'core/workers/WorkerPool.ts',    // IComputeBackend-Referenz
  'hooks/useMIDI.ts',              // IHardwareAdapter-Anbindung
  'hooks/useHID.ts',
  'hooks/useWebRTC.ts',            // ITransport-Anbindung (WebRTC-Hook)
  'config/runtime.ts',             // Konfigurations-Schicht (Vite-Env erlaubt)
  'config/webrtc.ts',              // Konfigurations-Schicht (Vite-Env erlaubt)
  'core/edge/EdgeDspClient.ts',    // Edge-Transport-Adapter (WebSocket)
  'context/AudioContext.tsx',      // App-Initialisierung (bewusst)
  'lib/supabaseClient.ts',         // Datenbank-Client (Cloud-Anbindung)
  'lib/cloudConfig.ts',
  'workers/visualizerWorker.ts',   // Web-Worker (Compute-Auslagerung)
]);

/**
 * STORE-P1-001 (AGENTS.md §2.2, Betreiber 2026-10-12): Ausnahmen von „Nichts
 * auf den Geräten" – eigene Presets, recordMONK-Aufnahmen, weitere Nutzer-
 * exporte – NUR als ausdrückliche Nutzeraktion per Datei. Datei-Dialoge und
 * Download-Anker sind ausschließlich in dieser Datei erlaubt. Die Ausnahme
 * gilt nur für diese Regel: Browser-Speicher bleibt auch dort verboten.
 */
export const USER_EXPORT_FILES = new Set([
  'utils/userExport.ts',
]);

/**
 * Regeln, die für ALLE Dateien gelten (auch Adapter-Dateien aus ALLOWED);
 * ausgenommen sind nur die Dateien in `allowIn`.
 */
const STRICT = [
  {
    re: /\bshowSaveFilePicker\b|\bshowOpenFilePicker\b|\bshowDirectoryPicker\b|\.download\s*=(?!=)|setAttribute\(\s*['"]download['"]/,
    name: 'Nutzerexport außerhalb von utils/userExport.ts',
    allowIn: USER_EXPORT_FILES,
  },
];

/** Verbotene Plattform-Muster (Kernmodule). */
const FORBIDDEN = [
  { re: /\bnew\s+AudioContext\b|\bwebkitAudioContext\b|window\.AudioContext/, name: 'direct AudioContext' },
  { re: /navigator\.mediaDevices|getUserMedia\(/, name: 'direct getUserMedia' },
  { re: /navigator\.requestMIDIAccess|requestMIDIAccess\(/, name: 'direct WebMIDI' },
  { re: /\bRTCPeerConnection\b|new\s+WebSocket\(/, name: 'direct WebRTC/WebSocket' },
  { re: /new\s+Worker\(/, name: 'direct Worker-Instanziierung' },
  { re: /localStorage\.|indexedDB\.|\bsessionStorage\b|navigator\.storage\b|\.getDirectory\(/, name: 'direct Storage' },
  { re: /import\.meta\.env/, name: 'direct Vite-Env-Zugriff' },
];

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'worklets') continue;
      yield* walk(p);
    } else if (/\.(ts|tsx)$/.test(e.name)) {
      yield p;
    }
  }
}

/**
 * Schlüsselwörter, nach denen ein `/` ein Regex-Literal beginnen kann
 * (`return /x/`, `typeof /x/` …). Alles andere nach einem Bezeichner ist
 * Division.
 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
]);

/**
 * Entscheidet, ob an der aktuellen Position ein `/` ein Regex-Literal
 * beginnen kann (Heuristik über das letzte signifikante Zeichen). `<`/`>`
 * sind bewusst NICHT enthalten, damit JSX-Schließtags (`</div>`) nicht als
 * Regex-Anfang gelesen werden.
 */
function regexAllowedAfter(out) {
  let j = out.length - 1;
  while (j >= 0 && /\s/.test(out[j])) j--;
  if (j < 0) return true; // Dateianfang
  const ch = out[j];
  if ('([{,;:?=!&|+-*%^~'.includes(ch)) return true;
  if (ch === '}') return true; // Blockende, z. B. `if (x) {} /re/.test(s)`
  if (ch === ')' || ch === ']' || ch === '/' || ch === '.') return false;
  if (/[\w$]/.test(ch)) {
    let k = j;
    while (k >= 0 && /[\w$]/.test(out[k])) k--;
    return REGEX_PRECEDING_KEYWORDS.has(out.slice(k + 1, j + 1));
  }
  return false; // Quote/Backtick/usw. → Division
}

/**
 * Entfernt Block- und Zeilenkommentare mit einem zustandsbehafteten
 * Tokenizer (linear, ohne ReDoS-Anfälligkeit).
 *
 * AUDIT-2026-10-30-P2-004: `//` und `/*` dürfen nur im Code-Zustand als
 * Kommentaranfang gelten. Vorher beendete jedes `//` die Zeile – auch
 * innerhalb eines Strings (`'http://…'`), eines Template-Literals
 * (`` `ws://…` ``) oder eines Regex-Literals. Dadurch verschwanden
 * Plattform-Aufrufe, die hinter einer solchen URL auf derselben Zeile
 * standen, aus dem Scan (Falsch-Negative).
 *
 * Zustände: code, Zeilen-/Blockkommentar, '…'/"…" (mit Escapes),
 * Template-Literal inkl. `${…}` (Klammer-Tiefe je Interpolation) und
 * Regex-Literal (nur wo ein Ausdruck beginnen kann).
 * String-/Template-/Regex-Inhalte bleiben im Ergebnis erhalten, damit
 * Regeln wie `setAttribute('download', …)` weiterhin greifen.
 */
export function stripComments(code) {
  const len = code.length;
  let out = '';
  let i = 0;
  /** @type {'code'|'line'|'block'|'single'|'double'|'template'|'regex'} */
  let state = 'code';
  /** Offene `${ … }`-Interpolationen: Klammer-Tiefe je Rahmen. */
  const interpolation = [];
  let inRegexClass = false;

  while (i < len) {
    const c = code[i];

    if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        out += c;
      }
      i++;
      continue;
    }

    if (state === 'block') {
      if (c === '*' && code[i + 1] === '/') {
        state = 'code';
        i += 2;
        continue;
      }
      if (c === '\n') out += c; // Zeilennummern bleiben stabil
      i++;
      continue;
    }

    if (state === 'single' || state === 'double') {
      if (c === '\\') {
        out += code.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === (state === 'single' ? "'" : '"')) {
        state = 'code';
      } else if (c === '\n') {
        state = 'code'; // unterminierter String: zurück in den Code
      }
      out += c;
      i++;
      continue;
    }

    if (state === 'template') {
      if (c === '\\') {
        out += code.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === '`') {
        state = 'code';
        out += c;
        i++;
        continue;
      }
      if (c === '$' && code[i + 1] === '{') {
        interpolation.push(0);
        state = 'code';
        out += '${';
        i += 2;
        continue;
      }
      out += c;
      i++;
      continue;
    }

    if (state === 'regex') {
      if (c === '\\') {
        out += code.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === '\n') {
        state = 'code'; // unterminiertes Regex-Literal
        out += c;
        i++;
        continue;
      }
      if (c === '[') inRegexClass = true;
      else if (c === ']') inRegexClass = false;
      else if (c === '/' && !inRegexClass) {
        state = 'code';
        out += c;
        i++;
        continue;
      }
      out += c;
      i++;
      continue;
    }

    // state === 'code'
    if (c === '/' && code[i + 1] === '/') {
      state = 'line';
      i += 2;
      continue;
    }
    if (c === '/' && code[i + 1] === '*') {
      state = 'block';
      i += 2;
      continue;
    }
    if (c === '/' && regexAllowedAfter(out)) {
      state = 'regex';
      inRegexClass = false;
      out += c;
      i++;
      continue;
    }
    if (c === "'") {
      state = 'single';
    } else if (c === '"') {
      state = 'double';
    } else if (c === '`') {
      state = 'template';
    } else if (c === '{' && interpolation.length > 0) {
      interpolation[interpolation.length - 1]++;
    } else if (c === '}' && interpolation.length > 0) {
      const top = interpolation[interpolation.length - 1];
      if (top === 0) {
        interpolation.pop();
        state = 'template'; // Ende von ${ … }
      } else {
        interpolation[interpolation.length - 1] = top - 1;
      }
    }
    out += c;
    i++;
  }

  return out;
}

/**
 * Prüft eine Quelldatei (Pfad relativ zu src/, mit `/`). Für Tests und den
 * Scan wiederverwendbar.
 */
export function scanSource(rel, code) {
  const violations = [];
  const lines = stripComments(code).split('\n');
  const rules = [
    ...(ALLOWED.has(rel) ? [] : FORBIDDEN),
    ...STRICT.filter((r) => !r.allowIn.has(rel)),
  ];
  for (let i = 0; i < lines.length; i++) {
    for (const rule of rules) {
      if (rule.re.test(lines[i])) {
        violations.push({ file: rel, line: i + 1, rule: rule.name });
      }
    }
  }
  return violations;
}

/** Führt den eigentlichen Boundary-Scan aus (für Tests und CLI wiederverwendbar). */
export async function runBoundaryScan() {
  const violations = [];
  let filesScanned = 0;

  for await (const file of walk(SRC)) {
    filesScanned++;
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    const code = await readFile(file, 'utf8');
    violations.push(...scanSource(rel, code));
  }

  return { filesScanned, violations };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { filesScanned, violations } = await runBoundaryScan();
  console.log(`Interface-Boundary-Scan: ${filesScanned} Dateien geprüft (${ALLOWED.size} Adapter-Dateien ausgenommen).`);
  if (violations.length === 0) {
    console.log('✅ Keine direkten Plattform-API-Zugriffe in den Kernmodulen.');
    process.exit(0);
  } else {
    console.log(`❌ ${violations.length} Verstoß/Vorstöße gefunden:`);
    for (const v of violations) {
      console.log(`   - ${v.file}:${v.line} → ${v.rule}`);
    }
    process.exit(1);
  }
}
