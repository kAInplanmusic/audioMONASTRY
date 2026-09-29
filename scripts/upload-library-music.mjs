/**
 * Die 45 Titel aus public/music nach R2 hochladen (idempotent).
 *
 * WARUM: Die Datenbank hat fuer diese Titel Zeilen mit dem Pfad /music/<datei>,
 * aber die AUDIODATEI liegt nur lokal (gemessen: 0 von 45 in R2). Solange das so
 * ist, kann public/music nicht weg - der Klang waere dann verloren.
 *
 * Schluessel: music/<sicherender-name>.<endung>  (gleiche Regel wie
 * UPLOAD_KINDS/safeName in server/routes/uploadRoutes.ts: klein, alles
 * Nicht-Alphanumerische wird zu '-'). Die Dateiendung bleibt erhalten.
 *
 * Nichts wird geloescht. Bereits vorhandene Schluessel werden uebersprungen.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { S3Client, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const env = {};
for (const zeile of readFileSync('.env', 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(zeile.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: env.CFS3_ENDPOINT,
  credentials: { accessKeyId: env.CFS3_ACCESS_KEY, secretAccessKey: env.CFS3_SECRET_KEY },
});
const BUCKET = env.CFS3_BUCKET;
const PUBLIC = (env.CFR2_PUBLIC_URL || env.CFS3_PUBLIC_URL || '').replace(/\/+$/, '');

/** Gleiche Regel wie safeName in server/routes/uploadRoutes.ts. */
function sichereName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const ordner = 'public/music';
const dateien = readdirSync(ordner).filter((f) => statSync(path.join(ordner, f)).isFile());
console.log(`Dateien in ${ordner}: ${dateien.length}`);

const vorhanden = new Set();
let hochgeladen = 0;
let uebersprungen = 0;
let fehler = 0;
const zuordnung = [];

for (const datei of dateien) {
  const endung = path.extname(datei).toLowerCase() || '.mp3';
  const basis = datei.slice(0, datei.length - path.extname(datei).length);
  const key = `music/${sichereName(basis)}${endung}`;
  zuordnung.push({ datei, key, oeffentlich: PUBLIC ? `${PUBLIC}/${key}` : null });

  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    vorhanden.add(key);
    uebersprungen += 1;
    continue;
  } catch {
    /* nicht vorhanden -> hochladen */
  }

  try {
    const body = readFileSync(path.join(ordner, datei));
    const typ = endung === '.wav' ? 'audio/wav' : endung === '.flac' ? 'audio/flac' : 'audio/mpeg';
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: typ }));
    hochgeladen += 1;
    process.stdout.write(`\r  hochgeladen: ${hochgeladen} | uebersprungen: ${uebersprungen}`);
  } catch (e) {
    fehler += 1;
    console.log(`\n  FEHLER bei ${datei}: ${e?.name}`);
  }
}

console.log(`\n\nhochgeladen: ${hochgeladen} | uebersprungen (schon da): ${uebersprungen} | Fehler: ${fehler}`);

// Zuordnung als JSON ablegen, damit der Datenbank-Abgleich denselben Schluessel nutzt.
const { writeFileSync } = await import('node:fs');
writeFileSync('/tmp/music-zuordnung.json', JSON.stringify(zuordnung, null, 2), 'utf8');
console.log(`Zuordnung geschrieben: /tmp/music-zuordnung.json (${zuordnung.length} Eintraege)`);

// Gegenprobe: 3 oeffentliche URLs wirklich abrufen
if (PUBLIC) {
  console.log('\nGegenprobe (oeffentliche URL, ohne Zugangsdaten):');
  for (const z of zuordnung.slice(0, 3)) {
    const r = await fetch(z.oeffentlich, { method: 'HEAD' }).catch(() => null);
    console.log(`  ${r?.status ?? 'Fehler'}  ${z.key}`);
  }
}
