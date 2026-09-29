#!/usr/bin/env node
/**
 * Demo-GIF erzeugen (VISUAL-P1-011).
 *
 * WARUM ES DIESES SKRIPT GIBT
 * ---------------------------
 * Die Startanweisung nennt einen 15-Sekunden-GIF im README als hoechsten ROI.
 * Der Punkt stand auf BLOCKED mit der Begruendung "keine laufende Instanz, die
 * Flotte ist aus". Das stimmt fuer eine echte 4-Nutzer-Sitzung - aber fuer ein
 * GIF braucht es keine Flotte: die App laeuft lokal, und Playwright kann die
 * Aufnahme machen. Statt den Punkt weiter zu blockieren, ist er damit erfuellbar.
 *
 * WAS HIER ENTSTEHT
 *   docs/media/audioMONASTRY-demo.gif   (~15 s, aus einer echten lokalen Sitzung)
 *
 * AUFNAHME IST EHRLICH: das GIF zeigt die App auf diesem Rechner, ohne
 * 4-Nutzer-Sitzung und ohne Flotte. Was es NICHT zeigt, steht als Bildunterschrift
 * im README - ein Demo, das mehr verspricht, als es zeigt, waere schlechter als
 * keines.
 *
 * AUFRUF
 *   npm run dev                      # in einem zweiten Terminal
 *   node scripts/make-demo-gif.mjs   # aufnehmen + umwandeln
 *   node scripts/make-demo-gif.mjs --recon   # nur zeigen, was auf der Seite steht
 *
 * Umgebung: DEMO_URL (Vorgabe http://127.0.0.1:4321), DEMO_SEKUNDEN (Vorgabe 15)
 */
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const URL_ = process.env.DEMO_URL ?? 'http://127.0.0.1:4321';
const SEKUNDEN = Number(process.env.DEMO_SEKUNDEN ?? 15);
const RECON = process.argv.includes('--recon');
// WICHTIG: fileURLToPath, nicht URL.pathname.
// GEFUNDEN AM 2026-09-24: `new URL(import.meta.url).pathname` liefert einen
// PROZENT-KODIERTEN Pfad. Bei einem Repo-Pfad mit Leerzeichen wird daraus
// "AnunnakiTools%20Projekte" - das GIF landete in einem Ordner mit diesem
// Namen, und das Skript meldete trotzdem Erfolg. Ein Pfad, den man aus einer
// URL ableitet, muss durch fileURLToPath.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIDEO_DIR = path.join(REPO, '.demo-video');
const ZIEL = path.join(REPO, 'docs', 'media', 'audioMONASTRY-demo.gif');

/** Kurz warten - Aufnahmen wirken mit menschlichen Pausen lesbarer. */
const pause = (seite, ms) => seite.waitForTimeout(ms);

/** Klickt ein Element, wenn es da ist. Nie hart scheitern: die Oberflaeche aendert sich. */
async function klickWennDa(seite, kandidaten, beschreibung) {
  for (const auswahl of kandidaten) {
    try {
      const el = seite.locator(auswahl).first();
      if (await el.isVisible({ timeout: 1500 })) {
        await el.click({ timeout: 4000 });
        console.log(`  geklickt: ${beschreibung}`);
        return true;
      }
    } catch {
      /* naechster Kandidat */
    }
  }
  console.log(`  uebersprungen (nicht gefunden): ${beschreibung}`);
  return false;
}

const browser = await chromium.launch();
const kontext = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
  recordVideo: RECON ? undefined : { dir: VIDEO_DIR, size: { width: 1280, height: 720 } },
});
const seite = await kontext.newPage();
const konsolenfehler = [];
seite.on('console', (m) => {
  if (m.type() === 'error') konsolenfehler.push(m.text().slice(0, 140));
});

console.log(`Lade ${URL_} …`);
await seite.goto(URL_, { waitUntil: 'networkidle', timeout: 60000 });
await pause(seite, 2500);

const titel = await seite.title();
console.log(`Titel: ${titel}`);

if (RECON) {
  const text = (await seite.locator('body').innerText()).replace(/\n{2,}/g, '\n').slice(0, 900);
  console.log('--- SICHTBARER TEXT ---');
  console.log(text);
  const knoepfe = await seite.locator('button, [role="button"]').allInnerTexts();
  console.log(`--- KNOEPFE (${knoepfe.length}) ---`);
  console.log(knoepfe.slice(0, 20).map((k) => '  ' + k.replace(/\s+/g, ' ').slice(0, 44)).join('\n'));
  console.log(`--- KONSOLENFEHLER: ${konsolenfehler.length} ---`);
  konsolenfehler.slice(0, 5).forEach((f) => console.log('  ' + f));
  await browser.close();
  process.exit(0);
}

// --- Aufnahme ---------------------------------------------------------------
console.log('\nAufnahme laeuft …');
const start = Date.now();

// 1) Startbildschirm stehen lassen (der Betrachter soll den Namen lesen).
await pause(seite, 3000);

// 2) In das Studio.
await klickWennDa(seite, ['button:has-text("Studio betreten")', 'text=Studio betreten'], 'Studio betreten');
await pause(seite, 3500);

// 3) Module oeffnen und Parameter bewegen - das ist der Teil, der "DAW" zeigt.
await klickWennDa(seite, ['button:has-text("mixerMONK")', '[title*="mixerMONK" i]', 'text=mixerMONK'], 'mixerMONK');
await pause(seite, 1800);
await klickWennDa(seite, ['button:has-text("biblioMONK")', '[title*="biblioMONK" i]', 'text=biblioMONK'], 'biblioMONK');
await pause(seite, 2500);

// Regler bewegen, wenn welche da sind (sichtbare Bewegung im GIF).
try {
  const regler = seite.locator('input[type="range"]');
  const anzahl = await regler.count();
  if (anzahl > 0) {
    console.log(`  ${anzahl} Regler gefunden - bewege die ersten beiden`);
    for (const i of [0, Math.min(1, anzahl - 1)]) {
      const r = regler.nth(i);
      const box = await r.boundingBox();
      if (!box) continue;
      await seite.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
      await seite.mouse.down();
      await seite.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 18 });
      await seite.mouse.up();
      await pause(seite, 900);
    }
  } else {
    console.log('  keine Regler auf dieser Ansicht');
  }
} catch (e) {
  console.log(`  Regler uebersprungen: ${String(e).slice(0, 80)}`);
}

// 4) Restzeit auffuellen, ohne dass es steht.
const rest = SEKUNDEN * 1000 - (Date.now() - start);
if (rest > 0) await pause(seite, Math.min(rest, 6000));

const video = seite.video();
await kontext.close();
await browser.close();

const videoPfad = await video.path();
console.log(`Aufnahme: ${videoPfad} (${(statSync(videoPfad).size / 1048576).toFixed(1)} MB)`);
console.log(`Konsolenfehler waehrend der Aufnahme: ${konsolenfehler.length}`);
konsolenfehler.slice(0, 3).forEach((f) => console.log('  ' + f));

// --- Umwandeln --------------------------------------------------------------
mkdirSync(path.dirname(ZIEL), { recursive: true });

// Zwei Durchlaeufe: erst eine Palette aus dem Video, dann mit dieser Palette
// schreiben. Ein einzelner ffmpeg-Aufruf liefert bei Bildschirmaufnahmen
// sichtbare Farbstufen.
const palette = path.join(VIDEO_DIR, 'palette.png');
const fps = 12;
const breite = 900;

execFileSync('ffmpeg', [
  '-hide_banner', '-nostdin', '-v', 'error', '-y',
  '-i', videoPfad,
  '-vf', `fps=${fps},scale=${breite}:-1:flags=lanczos,palettegen=stats_mode=diff`,
  palette,
]);

execFileSync('ffmpeg', [
  '-hide_banner', '-nostdin', '-v', 'error', '-y',
  '-i', videoPfad,
  '-i', palette,
  '-lavfi', `fps=${fps},scale=${breite}:-1:flags=lanczos[v];[v][1:v]paletteuse=dither=bayer:bayer_scale=3`,
  '-loop', '0',
  ZIEL,
]);

const groesse = statSync(ZIEL).size;
console.log(`\nGIF: ${path.relative(REPO, ZIEL)} (${(groesse / 1048576).toFixed(1)} MB)`);

// Die Zwischenaufnahme nicht liegen lassen.
try {
  rmSync(VIDEO_DIR, { recursive: true, force: true });
} catch {
  /* egal */
}
if (groesse > 6 * 1048576) {
  console.log('Hinweis: groesser als 6 MB - DEMO_SEKUNDEN senken oder Breite anpassen.');
}
