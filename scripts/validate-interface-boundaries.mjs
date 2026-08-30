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
  'ai/localVoice.ts',              // KI-Adapter (Vite-Env erlaubt)
  'core/edge/EdgeDspClient.ts',    // Edge-Transport-Adapter (WebSocket)
  'context/AudioContext.tsx',      // App-Initialisierung (bewusst)
  'lib/supabaseClient.ts',         // Datenbank-Client (Cloud-Anbindung)
  'lib/cloudConfig.ts',
  'workers/visualizerWorker.ts',   // Web-Worker (Compute-Auslagerung)
]);

/** Verbotene Plattform-Muster (Kernmodule). */
const FORBIDDEN = [
  { re: /\bnew\s+AudioContext\b|\bwebkitAudioContext\b|window\.AudioContext/, name: 'direct AudioContext' },
  { re: /navigator\.mediaDevices|getUserMedia\(/, name: 'direct getUserMedia' },
  { re: /navigator\.requestMIDIAccess|requestMIDIAccess\(/, name: 'direct WebMIDI' },
  { re: /\bRTCPeerConnection\b|new\s+WebSocket\(/, name: 'direct WebRTC/WebSocket' },
  { re: /new\s+Worker\(/, name: 'direct Worker-Instanziierung' },
  { re: /localStorage\.|indexedDB\./, name: 'direct Storage' },
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

/** Entfernt Block- und Zeilenkommentare (linear, ohne ReDoS-Anfälligkeit). */
export function stripComments(code) {
  let out = '';
  let i = 0;
  while (i < code.length) {
    if (code.startsWith('/*', i)) {
      const end = code.indexOf('*/', i + 2);
      i = end === -1 ? code.length : end + 2;
    } else if (code.startsWith('//', i)) {
      const nl = code.indexOf('\n', i);
      i = nl === -1 ? code.length : nl;
    } else {
      out += code[i++];
    }
  }
  return out;
}

/** Führt den eigentlichen Boundary-Scan aus (für Tests und CLI wiederverwendbar). */
export async function runBoundaryScan() {
  const violations = [];
  let filesScanned = 0;

  for await (const file of walk(SRC)) {
    filesScanned++;
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    if (ALLOWED.has(rel)) continue;
    const code = await readFile(file, 'utf8');
    const codeNoComments = stripComments(code);
    const lines = codeNoComments.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const rule of FORBIDDEN) {
        if (rule.re.test(lines[i])) {
          violations.push({ file: rel, line: i + 1, rule: rule.name });
        }
      }
    }
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
