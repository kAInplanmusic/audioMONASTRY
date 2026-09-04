// =============================================================================
// download-orchestral.mjs – Orchester-CC0-Library (VSCO 2 CE) laden
// -----------------------------------------------------------------------------
// Lädt das VSCO 2 Community Edition ZIP (Lizenz CC0, https://vis.versilstudios.com)
// und entpackt die wichtigsten Instrumente nach `public/data/orchestral/`.
//
// Aufruf:
//   npm run download:orchestral
//   node scripts/download-orchestral.mjs --url https://…/VSCO-2-CE.zip
//
// Hinweis: Die Datei ist groß (~1–2 GB). Der Download läuft gestreamt auf
// Platte; nur die unten aufgelisteten Instrumente werden entpackt.
// =============================================================================
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import AdmZip from 'adm-zip';

const DEFAULT_URL = process.env.VSCO_CE_URL ?? 'https://versilian-studios.com/VCSL/VCSLCE_Inst.zip';
const args = process.argv.slice(2);
const urlIdx = args.indexOf('--url');
const ZIP_URL = urlIdx >= 0 ? args[urlIdx + 1] : DEFAULT_URL;

const OUT_DIR = path.resolve(process.cwd(), 'public/data/orchestral');
const ZIP_PATH = path.resolve(process.cwd(), 'test-results/vsco2ce.zip');

// Kuratierte Auswahl (CC0): Streicher/Bläser/Brass – Pfad-Präfixe im VSCO-ZIP.
const INSTRUMENT_PREFIXES = [
  'VSCO 2 CE/Strings',
  'VSCO 2 CE/Winds',
  'VSCO 2 CE/Brass',
  'VSCO 2 CE/Percussion',
];

async function main() {
  console.log(`▶ Lade ${ZIP_URL} …`);
  const res = await fetch(ZIP_URL, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    console.error(`❌ Download fehlgeschlagen (HTTP ${res.status}).`);
    console.error('   Bitte aktuelle ZIP-URL prüfen: https://vis.versilstudios.com/vsco-community.html');
    process.exit(1);
  }
  const total = Number(res.headers.get('content-length') ?? 0);
  const mb = (b) => (b / 1024 / 1024).toFixed(1);
  console.log(`   Größe: ${total ? mb(total) + ' MB' : 'unbekannt'} → ${ZIP_PATH}`);

  mkdirSync(path.dirname(ZIP_PATH), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), createWriteStream(ZIP_PATH));
  console.log('▶ Entpacke Instrumente …');

  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const zip = new AdmZip(ZIP_PATH);
  const entries = zip.getEntries();
  let extracted = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const name = entry.entryName.replace(/\\/g, '/');
    if (!INSTRUMENT_PREFIXES.some((p) => name.startsWith(p))) continue;
    const rel = name.split('/').slice(2).join('/'); // ohne "VSCO 2 CE/<Sektion>"
    const dest = path.join(OUT_DIR, rel);
    if (path.relative(OUT_DIR, dest).startsWith('..')) continue;
    mkdirSync(path.dirname(dest), { recursive: true });
    // WAV/OGG/FLAC übernehmen, Rest (NKI/DS/etc.) überspringen.
    if (!/\.(wav|ogg|flac|mp3)$/i.test(rel)) continue;
    zip.extractEntryTo(entry, path.dirname(dest), false, true);
    extracted += 1;
    if (extracted % 100 === 0) console.log(`   ${extracted} Dateien …`);
  }
  console.log(`✅ ${extracted} Audiodateien nach ${OUT_DIR} entpackt (CC0).`);
  console.log('   Lizenzhinweis: VSCO 2 Community Edition = CC0 (keine Namensnennung nötig).');
}

main().catch((e) => { console.error(e); process.exit(1); });
