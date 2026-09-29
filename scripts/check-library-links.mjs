/**
 * Link-Pruefung der Bibliothek (Nutzerwunsch: "mach die Links wieder richtig").
 *
 * Gemessen wird, was WIRKLICH in der Datenbank steht - nicht was dastehen sollte:
 *   1. Welche music_tracks-Zeilen haben eine URL, die ein Browser oeffnen kann?
 *   2. Liegt zu jeder Zeile ein Objekt in R2?
 *   3. Welche Zeilen zeigen auf einen lokalen /music/-Pfad?
 *
 * Ausgabe nennt Dateinamen, aber keine Zugangsdaten.
 */
import { readFileSync } from 'node:fs';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

const env = {};
for (const zeile of readFileSync('.env', 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(zeile.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const SUPABASE_URL = env.VITE_SUPABASE_URL;
const ANON = env.VITE_SUPABASE_ANON_PUB;
const PUBLIC = (env.CFR2_PUBLIC_URL || env.CFS3_PUBLIC_URL || '').replace(/\/+$/, '');
const BUCKET = env.CFS3_BUCKET;

if (!SUPABASE_URL || !ANON) throw new Error('Supabase-Zugang fehlt in der .env');

const s3 = new S3Client({
  region: 'auto',
  endpoint: env.CFS3_ENDPOINT,
  credentials: { accessKeyId: env.CFS3_ACCESS_KEY, secretAccessKey: env.CFS3_SECRET_KEY },
});

// --- 1) Zeilen lesen (anon darf music_tracks per RLS lesen) ------------------
const res = await fetch(`${SUPABASE_URL}/rest/v1/music_tracks?select=id,name,url&order=name`, {
  headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
});
if (!res.ok) throw new Error(`PostgREST ${res.status}: ${(await res.text()).slice(0, 200)}`);
const zeilen = await res.json();

// --- 2) Alle R2-Schluessel einmal einlesen (schneller als 500 Einzelabfragen) --
const schluessel = new Set();
let token;
do {
  const r = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, MaxKeys: 1000, ContinuationToken: token }));
  for (const o of r.Contents || []) schluessel.add(o.Key);
  token = r.IsTruncated ? r.NextContinuationToken : undefined;
} while (token);

const schluesselNachBasis = new Map();
for (const k of schluessel) {
  const basis = k.split('/').pop().toLowerCase();
  if (!schluesselNachBasis.has(basis)) schluesselNachBasis.set(basis, k);
}

// --- 3) Jede Zeile bewerten --------------------------------------------------
const ergebnis = { oeffentlichOk: [], s3Pfad: [], lokalPfad: [], keinObjekt: [] };

for (const z of zeilen) {
  const url = z.url || '';
  if (url.startsWith('http')) {
    const key = decodeURIComponent(url.split('/').slice(3).join('/'));
    const inR2 = schluessel.has(key);
    const oeffentlich = PUBLIC ? `${PUBLIC}/${key.split('/').map(encodeURIComponent).join('/')}` : '';
    ergebnis.s3Pfad.push({ id: z.id, name: z.name, key, inR2, oeffentlich });
    if (oeffentlich) {
      const head = await fetch(oeffentlich, { method: 'HEAD' }).catch(() => null);
      if (head && head.ok) ergebnis.oeffentlichOk.push(z.id);
    }
  } else if (url.startsWith('/music/')) {
    const basis = url.replace('/music/', '').toLowerCase();
    const inR2 = schluesselNachBasis.get(basis);
    ergebnis.lokalPfad.push({ id: z.id, name: z.name, r2Key: inR2 || null });
    if (!inR2) ergebnis.keinObjekt.push(`${z.name} (lokal, kein R2-Objekt)`);
  } else {
    ergebnis.keinObjekt.push(`${z.name} (keine URL: "${url.slice(0, 40)}")`);
  }
}

console.log(`music_tracks gesamt        : ${zeilen.length}`);
console.log(`  http-URLs (S3-Pfad)      : ${ergebnis.s3Pfad.length}`);
console.log(`    davon Objekt in R2     : ${ergebnis.s3Pfad.filter((r) => r.inR2).length}`);
console.log(`    davon oeffentlich 200  : ${ergebnis.oeffentlichOk.length}`);
console.log(`  lokale /music/-Pfade     : ${ergebnis.lokalPfad.length}`);
console.log(`    davon Objekt in R2     : ${ergebnis.lokalPfad.filter((r) => r.r2Key).length}`);
console.log(`  ohne verwertbare URL     : ${ergebnis.keinObjekt.length}`);
console.log(`R2-Objekte im Eimer        : ${schluessel.size}`);
console.log(`oeffentliche Basis         : ${PUBLIC || '(LEER - keine oeffentliche URL konfiguriert!)'}`);

// Beispielzeilen fuer die Feinarbeit
console.log('\n--- 5 Beispiele S3-Pfad-Zeilen ---');
for (const r of ergebnis.s3Pfad.slice(0, 5)) {
  console.log(`  ${r.name.slice(0, 45).padEnd(46)} key=${r.key.slice(0, 40).padEnd(41)} R2=${r.inR2 ? 'ja' : 'NEIN'}`);
}
console.log('\n--- 5 Beispiele lokale Pfade ---');
for (const r of ergebnis.lokalPfad.slice(0, 5)) {
  console.log(`  ${r.name.slice(0, 45).padEnd(46)} R2-Key=${r.r2Key ? r.r2Key.slice(0, 40) : 'FEHLT'}`);
}
if (ergebnis.keinObjekt.length) {
  console.log('\n--- Zeilen ohne verwertbare URL ---');
  for (const z of ergebnis.keinObjekt.slice(0, 10)) console.log('  ' + z);
}
