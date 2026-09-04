// =============================================================================
// download-orchestral.mjs – Orchester-CC0-Library (VSCO 2 CE) laden
// -----------------------------------------------------------------------------
// Lädt das VSCO 2 Community Edition ZIP (Lizenz CC0) und entpackt alle
// Audio-/SFZ-Dateien nach `public/data/orchestral/`.
//
// Quelle: https://github.com/sgossner/VSCO-2-CE (CC0, SFZ-Konvertierung)
//
// Aufruf:
//   npm run download:orchestral
//   node scripts/download-orchestral.mjs --url https://…/VSCO-2-CE.zip
//
// Hinweis: Die Datei ist groß (~2,3 GB). Der Download läuft gestreamt auf
// Platte; entpackt wird ebenfalls gestreamt (unzipper), damit auch ZIPs
// über 2 GiB funktionieren.
// =============================================================================
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import unzipper from 'unzipper';

const DEFAULT_URL = process.env.VSCO_CE_URL ?? 'https://github.com/sgossner/VSCO-2-CE/archive/refs/tags/1.1.0.zip';
const args = process.argv.slice(2);
const urlIdx = args.indexOf('--url');
const ZIP_URL = urlIdx >= 0 ? args[urlIdx + 1] : DEFAULT_URL;

const OUT_DIR = path.resolve(process.cwd(), 'public/data/orchestral');
const ZIP_PATH = path.resolve(process.cwd(), 'test-results/vsco2ce.zip');

// GitHub-Source-ZIP enthält den Ordner <repo>-<tag>/ – Prefix beim Entpacken entfernen.
const ZIP_ROOT_PREFIX = 'VSCO-2-CE-1.1.0/';

async function extractZip() {
  const dir = await unzipper.Open.file(ZIP_PATH);
  let extracted = 0;
  for (const entry of dir.files) {
    if (entry.type === 'Directory') continue;
    const name = entry.path.replace(/\\/g, '/');
    const rel = name.startsWith(ZIP_ROOT_PREFIX) ? name.slice(ZIP_ROOT_PREFIX.length) : name;
    if (!rel) continue;
    if (!/\.(wav|ogg|flac|mp3|sfz)$/i.test(rel)) continue;
    const dest = path.join(OUT_DIR, rel);
    if (path.relative(OUT_DIR, dest).startsWith('..')) continue;
    mkdirSync(path.dirname(dest), { recursive: true });
    await pipeline(entry.stream(), createWriteStream(dest));
    extracted += 1;
    if (extracted % 200 === 0) console.log(`   ${extracted} Dateien …`);
  }
  return extracted;
}

async function downloadZip() {
  const res = await fetch(ZIP_URL, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    console.error(`❌ Download fehlgeschlagen (HTTP ${res.status}).`);
    console.error('   Bitte aktuelle ZIP-URL prüfen: https://github.com/sgossner/VSCO-2-CE/releases');
    process.exit(1);
  }
  const total = Number(res.headers.get('content-length') ?? 0);
  const mb = (b) => (b / 1024 / 1024).toFixed(1);
  console.log(`   Größe: ${total ? mb(total) + ' MB' : 'unbekannt'} → ${ZIP_PATH}`);
  mkdirSync(path.dirname(ZIP_PATH), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), createWriteStream(ZIP_PATH));
}

async function main() {
  console.log(`▶ Lade ${ZIP_URL} …`);
  if (existsSync(ZIP_PATH)) {
    const { stat } = await import('node:fs/promises');
    const size = (await stat(ZIP_PATH)).size;
    if (size > 1_000_000_000) {
      console.log(`   ZIP bereits vorhanden (${(size / 1024 / 1024).toFixed(0)} MB) – überspringe Download.`);
    } else {
      await downloadZip();
    }
  } else {
    await downloadZip();
  }
  console.log('▶ Entpacke Instrumente (gestreamt) …');

  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const extracted = await extractZip();
  console.log(`✅ ${extracted} Dateien nach ${OUT_DIR} entpackt (CC0).`);
  console.log('   Lizenzhinweis: VSCO 2 Community Edition = CC0 (keine Namensnennung nötig).');
}

main().catch((e) => { console.error(e); process.exit(1); });
