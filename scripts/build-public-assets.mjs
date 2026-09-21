// =============================================================================
// build-public-assets.mjs – public/ -> dist/ kopieren, schwere Medien ausnehmen
// -----------------------------------------------------------------------------
// BEFUND (Tiefen-Optimierung 2026-09-21): `vite build` kopiert den KOMPLETTEN
// publicDir nach dist/. Das sind hier 3,7 GB (public/data/orchestral 3,0 GB,
// public/music 382 MB, public/models 291 MB). Gemessen: ein Build brauchte
// 5:45 min Wanduhr bei nur 25 s CPU-Zeit – also fast nur Warten auf die Platte
// (ROTA-Disk), fuer eine Kopie, die niemand braucht:
//
//   * Im Image fehlen genau diese Baeume per .dockerignore (dist ist 52 MB).
//   * Im Betrieb mountet docker-compose.media.yml sie schreibgeschuetzt nach
//     /app/dist/... (Medien-Overlay, scripts/hetzner/deliver-media.sh).
//   * Im Dev-Build liefert Vite public/ direkt aus – ohne Kopie.
//
// Deshalb: vite.config.ts setzt `build.copyPublicDir: false`, und hier wird
// public/ danach selbst kopiert – OHNE die Overlay-Baeume. Die werden statt
// dessen als relativer Symlink in dist/ angelegt, WENN sie lokal existieren
// (dann laeuft `npm start` lokal weiter wie vorher, inkl. Medien, zu 0 Byte
// Kopierkosten). Fehlen sie (Docker-Build: aus dem Kontext ausgeschlossen),
// wird nichts angelegt – im Betrieb erledigt das der Mount, der die Pfade
// selbst erzeugt.
//
// Aufruf: node scripts/build-public-assets.mjs
// =============================================================================
import { readdirSync, mkdirSync, copyFileSync, symlinkSync, lstatSync, rmSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/**
 * Baeume, die per Medien-Overlay kommen (docker-compose.media.yml) und deshalb
 * NICHT mitkopiert werden. `rel` ist relativ zu public/ (und zu dist/), `mount`
 * ist das Ziel im Container – die Zuordnung ist der Vertrag mit dem Compose-File
 * und wird in tests/buildPublicAssets.test.ts gegen docker-compose.media.yml
 * geprueft (Drift-Schutz).
 */
export const OVERLAY_DIRS = [
  // `media` = Verzeichnisname im Medien-Store auf dem Knoten (<deploy>/media/<media>);
  // der Zielpfad in dist/ darf davon abweichen (orchestral -> data/orchestral).
  { rel: 'data/orchestral', media: 'orchestral', mount: '/app/dist/data/orchestral', why: 'CC0-Orchester-Library (~3,0 GB)' },
  { rel: 'models', media: 'models', mount: '/app/dist/models', why: 'htdemucs.onnx fuer den lokalen Stem-Pfad (~291 MB)' },
  { rel: 'music', media: 'music', mount: '/app/dist/music', why: 'Demo-Tracks (~382 MB, nur mit Betreiberentscheidung)' },
];

/** Alle Verzeichnisse/Eintraege unterhalb von public/, rekursiv, POSIX-Pfade. */
function walk(dir, base = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push({ rel, dir: true });
      out.push(...walk(path.join(dir, entry.name), rel));
    } else if (entry.isFile()) {
      out.push({ rel, dir: false });
    }
  }
  return out;
}

/**
 * Rein (kein Dateisystem-Zugriff ausser Lesen der Quelle): was wird kopiert,
 * was wird verlinkt, was wird uebersprungen? Fuer Tests und Dry-Run.
 */
export function planAssetCopy(publicDir, entries = OVERLAY_DIRS) {
  const overlay = new Set(entries.map((e) => e.rel));
  const copies = [];
  const links = [];
  const skipped = [];

  for (const item of walk(publicDir)) {
    // Ein Overlay-Pfad wird samt Inhalt ausgelassen: entweder wird der ganze
    // Baum verlinkt ('models') oder nur ein Teilbaum ('data/orchestral').
    const taken = [...overlay].some((rel) => item.rel === rel || item.rel.startsWith(`${rel}/`));
    if (taken) {
      if (overlay.has(item.rel)) skipped.push(item.rel); // nur die Wurzel melden, nicht jeden Unterpfad
      continue;
    }
    if (item.dir) copies.push({ rel: item.rel, kind: 'dir' });
    else copies.push({ rel: item.rel, kind: 'file' });
  }

  for (const entry of entries) {
    const abs = path.join(publicDir, entry.rel);
    if (!existsSync(abs)) {
      // Docker-Build: Inhalt ist per .dockerignore aus dem Kontext. Kein Fehler,
      // der Mount erzeugt die Pfade im Betrieb.
      continue;
    }
    links.push({ ...entry, abs });
  }
  return { copies, links, skipped };
}

/** Ziel-Pfad aufraeumen: Alt-Kopien (auch 3,7 GB) entfernen, Symlinks nur entlinken. */
function clearTarget(dest) {
  let st;
  try {
    st = lstatSync(dest);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) {
    rmSync(dest); // nur die Verknuepfung, NICHT das Ziel
    return;
  }
  rmSync(dest, { recursive: true, force: true });
}

/**
 * Fuehrt den Plan aus: kopiert public/ -> dist/ ohne die Overlay-Baeume und legt
 * fuer vorhandene Overlay-Baeume einen relativen Symlink an. Exportiert, damit
 * tests/buildPublicAssets.test.ts genau diesen Code prueft (nicht `ln`).
 */
export function copyPublicAssets(publicDir, distDir, entries = OVERLAY_DIRS) {
  if (!existsSync(publicDir)) {
    throw new Error(`[public-assets] ${publicDir} fehlt`);
  }
  mkdirSync(distDir, { recursive: true });

  const plan = planAssetCopy(publicDir, entries);

  for (const dir of plan.copies.filter((c) => c.kind === 'dir')) {
    mkdirSync(path.join(distDir, dir.rel), { recursive: true });
  }
  let bytes = 0;
  for (const file of plan.copies.filter((c) => c.kind === 'file')) {
    const from = path.join(publicDir, file.rel);
    const to = path.join(distDir, file.rel);
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
    bytes += statSync(from).size;
  }

  for (const link of plan.links) {
    const to = path.join(distDir, link.rel);
    clearTarget(to);
    mkdirSync(path.dirname(to), { recursive: true });
    // Relativer Symlink: dist/ bleibt verschiebbar (Container-Kopien, rsync).
    symlinkSync(path.relative(path.dirname(to), link.abs), to);
  }

  const mb = Number((bytes / 1024 / 1024).toFixed(1));
  console.log(`[public-assets] kopiert: ${plan.copies.length} Eintraege (${mb} MB)`);
  for (const link of plan.links) {
    console.log(`[public-assets] verlinkt (Overlay): ${link.rel} -> ${link.why}`);
  }
  const absent = entries.filter((e) => !plan.links.some((l) => l.rel === e.rel)).map((e) => e.rel);
  if (absent.length > 0) {
    console.log(`[public-assets] nicht vorhanden (Image-Build/Overlay liefert): ${absent.join(', ')}`);
  }
  return { ...plan, bytes, mb, absent };
}

function main() {
  const result = copyPublicAssets(path.join(ROOT, 'public'), path.join(ROOT, 'dist'));
  // Der eigentliche Zweck: die Kopie muss die Overlay-Medien NICHT enthalten.
  if (result.mb > 200) {
    console.error(`[public-assets] unerwartet viel kopiert (${result.mb} MB) - Ausnahmeliste pruefen`);
    process.exit(1);
  }
}

// Nur ausfuehren, wenn direkt aufgerufen (Import in Tests bleibt nebenwirkungsfrei).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error('[public-assets] Fehler:', error);
    process.exit(1);
  }
}
