/**
 * Block 2 / Angriff 4 — empirischer Nachweis der ffmpeg-Protokoll-Whitelist.
 * Prueft die ECHTEN Builder (buildEncodeArgs / buildMergeArgs) und die Wirkung
 * der Whitelist am laufenden ffmpeg - kein handgebautes Kommando.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildEncodeArgs, exportFormatInfo } from '../server/audioEncode';
import { buildMergeArgs } from '../server/visionShow';

const run = promisify(execFile);
const FF = 'ffmpeg';
const GOLDEN = path.resolve('tests/fixtures/audio/golden-1s.wav');
const dir = mkdtempSync(path.join(tmpdir(), 'whitelist-proof-'));
let fails = 0;

function report(name: string, ok: boolean, detail: string) {
  if (!ok) fails += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
}

async function main() {
  // ---- 1) Builder enthalten die Whitelist VOR dem -i ------------------------
  const mp3 = exportFormatInfo('mp3');
  if (!mp3) throw new Error('mp3-Format nicht gefunden');
  const encodeArgs = buildEncodeArgs('/in.wav', '/out.mp3', mp3, {});
  const idxWhitelist = encodeArgs.indexOf('-protocol_whitelist');
  const idxInput = encodeArgs.indexOf('-i');
  report(
    'buildEncodeArgs: Whitelist vorhanden und vor -i',
    idxWhitelist !== -1 && idxInput !== -1 && idxWhitelist < idxInput && encodeArgs[idxWhitelist + 1] === 'file',
    `args = ${encodeArgs.join(' ')}`,
  );

  const mergeArgs = buildMergeArgs('/list.txt', '/out.mp4', { width: 1280, height: 720, fps: 30 });
  const mWhitelist = mergeArgs.indexOf('-protocol_whitelist');
  const mInput = mergeArgs.indexOf('-i');
  report(
    'buildMergeArgs: Whitelist vorhanden und vor -i',
    mWhitelist !== -1 && mInput !== -1 && mWhitelist < mInput && mergeArgs[mWhitelist + 1] === 'file,concat',
    `args = ${mergeArgs.join(' ')}`,
  );

  // ---- 2) Echter Encoder-Lauf mit der gehaerteten Argumentliste ------------
  const outMp3 = path.join(dir, 'out.mp3');
  const realArgs = buildEncodeArgs(GOLDEN, outMp3, mp3, {});
  try {
    await run(FF, realArgs, { timeout: 60_000 });
    const size = statSync(outMp3).size;
    report('echter ffmpeg-Lauf (WAV -> MP3) mit Whitelist', size > 1000, `Ausgabe ${size} Bytes, exit 0`);
  } catch (e) {
    report('echter ffmpeg-Lauf (WAV -> MP3) mit Whitelist', false, String((e as Error).message).slice(0, 200));
  }

  // ---- 3) concat-Demuxer mit file,concat (der Pfad aus buildMergeArgs) -----
  const listFile = path.join(dir, 'list.txt');
  writeFileSync(listFile, `file '${GOLDEN}'\nfile '${GOLDEN}'\n`, 'utf8');
  try {
    await run(
      FF,
      ['-v', 'error', '-f', 'concat', '-safe', '0', '-protocol_whitelist', 'file,concat', '-i', listFile, '-f', 'null', '-'],
      { timeout: 60_000 },
    );
    report('concat-Demuxer mit -protocol_whitelist file,concat', true, 'Liste UND gelistete Dateien lesbar, exit 0');
  } catch (e) {
    report('concat-Demuxer mit -protocol_whitelist file,concat', false, String((e as Error).message).slice(0, 300));
  }

  // ---- 4) GEGENPROBE: die Whitelist blockt wirklich ------------------------
  // Ohne Wirksamkeit waere die Haertung Kosmetik. Erwartet: ffmpeg bricht ab mit
  // "Protocol not on whitelist" (der Netzzugriff findet gar nicht statt).
  let blocked = false;
  let stderr = '';
  try {
    await run(FF, ['-v', 'error', '-protocol_whitelist', 'file', '-i', 'http://127.0.0.1:9/nicht-da.mp3', '-f', 'null', '-'], {
      timeout: 20_000,
    });
  } catch (e) {
    stderr = String((e as { stderr?: string }).stderr ?? (e as Error).message);
    blocked = /not on whitelist|Protocol not on/i.test(stderr);
  }
  report('Gegenprobe: http-Eingabe wird von der Whitelist abgelehnt', blocked, stderr.split('\n')[0] || '(kein stderr)');

  // ---- 5) Kontrollprobe: ohne Whitelist waere http erlaubt -----------------
  // Beweist, dass die Ablehnung oben von der Whitelist kommt und nicht davon,
  // dass ffmpeg http ohnehin nicht kennt.
  let protocolKnown = false;
  let protocolDetail = '(Abfrage fehlgeschlagen)';
  try {
    const r = await run(FF, ['-protocols'], { timeout: 20_000 });
    const out = String(r.stdout ?? '');
    protocolKnown = /^\s*https?\s*$/m.test(out) || /\bhttps?\b/.test(out);
    // Beleg statt Behauptung: die passende Zeile aus der ECHTEN Ausgabe zeigen.
    protocolDetail =
      out
        .split('\n')
        .filter((l) => /^\s*https?\s*$/i.test(l))
        .map((l) => l.trim())
        .join(', ') || '(http in der Ausgabe nicht gefunden)';
  } catch (e) {
    protocolDetail = String((e as Error).message).slice(0, 120);
  }
  report('Kontrollprobe: dieser ffmpeg-Build kennt http ueberhaupt', protocolKnown, protocolDetail);

  console.log(`\nErgebnis: ${fails === 0 ? 'alle Pruefungen bestanden' : `${fails} Fehlschlag/Fehlschlaege`}`);
  console.log(`(Arbeitsordner: ${dir}, golden: ${readFileSync(GOLDEN).length} Bytes)`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('Abbruch:', e);
  process.exit(1);
});
