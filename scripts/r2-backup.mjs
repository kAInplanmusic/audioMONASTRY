#!/usr/bin/env node
// PROD-P0-002: Off-Site-Backup nach R2 (S3-kompatibel) + Restore-Download.
// =============================================================================
// Nutzt dieselben Credentials wie der Sample-Upload (CFS3_* bzw. CFR2_*).
// Der lokale tar.gz aus scripts/backup.sh wird hochgeladen und per HeadObject
// (Groesse) verifiziert; `restore` laedt ihn zurueck, damit der Restore-Drill
// gegen den echten Off-Site-Pfad laeuft.
//
//   node scripts/r2-backup.mjs upload <datei> [remote-key]
//   node scripts/r2-backup.mjs restore <remote-key> <ziel>
// =============================================================================
import 'dotenv/config';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { readFileSync, createWriteStream, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';

const env = (name) => (process.env[name] || '').trim();
const accessKeyId = env('CFS3_ACCESS_KEY') || env('CFR2_ACCESS_KEY_ID');
const secretAccessKey = env('CFS3_SECRET_KEY') || env('CFR2_SECRET_ACCESS_KEY');
const accountId = env('CFR2_ACCOUNT_ID');
const endpoint = (env('CFS3_ENDPOINT') || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '')).replace(/\/+$/, '');
const bucket = env('CFS3_BUCKET') || env('CFR2_BUCKET') || 'audiomonastrysamples';

function client() {
  if (!accessKeyId || !secretAccessKey || !endpoint) {
    console.error('R2-BACKUP: CFS3_ACCESS_KEY/CFS3_SECRET_KEY/CFS3_ENDPOINT (oder CFR2_*) fehlen.');
    process.exit(2);
  }
  // R2 lehnt die flexiblen CRC32-Checksum-Header des SDK v3 ab
  // (SignatureDoesNotMatch); der Projekt-Pfad server/cloud.ts setzt dieselben
  // Optionen nicht und funktioniert. WHEN_REQUIRED = nur wenn der Dienst es
  // zwingend braucht.
  return new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

const [, , cmd, arg, arg2] = process.argv;

if (cmd === 'upload') {
  const file = arg;
  const key = arg2 || `backups/${file.split('/').pop()}`;
  const size = statSync(file).size;
  const c = client();
  // Buffer statt Stream: der S3-Stack des Projekts (server/cloud.ts) verifiziert
  // exakt diesen Pfad; Stream-Uploads scheitern am Custom-Endpoint
  // (STREAMING-UNSIGNED-PAYLOAD-TRAILER).
  await c.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: readFileSync(file) }));
  const head = await c.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  if (head.ContentLength !== size) {
    console.error(`R2-BACKUP: Groessenabweichung lokal=${size} remote=${head.ContentLength}`);
    process.exit(3);
  }
  console.log(`R2-BACKUP: ok ${key} (${size} bytes, ${head.ETag})`);
} else if (cmd === 'restore') {
  const key = arg;
  const dest = arg2;
  if (!key || !dest) { console.error('restore <key> <ziel>'); process.exit(2); }
  const c = client();
  const obj = await c.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!obj.Body) { console.error('R2-BACKUP: kein Body'); process.exit(3); }
  await pipeline(obj.Body, createWriteStream(dest));
  console.log(`R2-BACKUP: restore ok ${key} -> ${dest} (${statSync(dest).size} bytes)`);
} else {
  console.error('Verwendung: r2-backup.mjs upload <datei> [key] | restore <key> <ziel>');
  process.exit(2);
}
