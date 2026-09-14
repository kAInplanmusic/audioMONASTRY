#!/usr/bin/env node
// PROD-P0-002: Off-Site-Backup auf S3-kompatiblen Speicher + Restore.
// =============================================================================
// Ziel-Reihenfolge der Credentials (erste vollstaendige gewinnt):
//   BACKUP_S3_*  ->  HOS_S3_* (Hetzner Object Storage)  ->  CFS3_*/CFR2_* (R2)
// Damit ist der Backup-Pfad unabhaengig vom App-Upload-Ziel (R2 fuer Samples).
//
//   node scripts/r2-backup.mjs list [prefix]
//   node scripts/r2-backup.mjs upload <datei> [remote-key]
//   node scripts/r2-backup.mjs restore <remote-key> <ziel>
// =============================================================================
import 'dotenv/config';
import {
  S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command,
  ListBucketsCommand,
} from '@aws-sdk/client-s3';
import { readFileSync, createWriteStream, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';

const env = (name) => (process.env[name] || '').trim();

function resolveTarget() {
  const accessKeyId = env('BACKUP_S3_ACCESS_KEY') || env('HOS_S3_ACCESS_KEY') || env('CFS3_ACCESS_KEY') || env('CFR2_ACCESS_KEY_ID');
  const secretAccessKey = env('BACKUP_S3_SECRET_KEY') || env('HOS_S3_SECRET_KEY') || env('CFS3_SECRET_KEY') || env('CFR2_SECRET_ACCESS_KEY');
  const accountId = env('CFR2_ACCOUNT_ID');
  const rawEndpoint = env('BACKUP_S3_ENDPOINT') || env('HOS_S3_ENDPOINT')
    || env('CFS3_ENDPOINT') || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '');
  const endpoint = rawEndpoint.replace(/\/+$/, '');
  const bucket = env('BACKUP_S3_BUCKET') || env('HOS_S3_BUCKET') || env('CFS3_BUCKET') || env('CFR2_BUCKET') || 'audiomonastrysamples';
  return { accessKeyId, secretAccessKey, endpoint, bucket };
}

const target = resolveTarget();

function resolveRegion(endpoint) {
  // Hetzner Object Storage verlangt region = Location (nbg1/fsn1/hel1);
  // Cloudflare R2 erwartet 'auto'. Region aus dem Endpoint ableiten.
  const explicit = env('BACKUP_S3_REGION') || env('HOS_S3_REGION');
  if (explicit) return explicit;
  const m = endpoint.match(/\/\/\(?([a-z]{3}[0-9])\./) || endpoint.match(/\/\/([a-z0-9-]+)\./);
  return /your-objectstorage\.com/.test(endpoint) && m ? m[1] : 'auto';
}

function client() {
  if (!target.accessKeyId || !target.secretAccessKey || !target.endpoint) {
    console.error('S3-BACKUP: Zugangsdaten fehlen (BACKUP_S3_* / HOS_S3_* / CFS3_*).');
    process.exit(2);
  }
  // Flexible CRC32-Checksum-Header lehnen manche S3-kompatiblen Dienste ab
  // (SignatureDoesNotMatch); WHEN_REQUIRED = nur wenn der Dienst es verlangt.
  return new S3Client({
    region: resolveRegion(target.endpoint),
    endpoint: target.endpoint,
    credentials: { accessKeyId: target.accessKeyId, secretAccessKey: target.secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

const [, , cmd, arg, arg2] = process.argv;

try {
  if (cmd === 'buckets') {
    const res = await client().send(new ListBucketsCommand({}));
    console.log(`S3-BACKUP: ${(res.Buckets ?? []).length} Bucket(s) @ ${target.endpoint}`);
    for (const b of res.Buckets ?? []) console.log(`  ${b.Name}  ${b.CreationDate?.toISOString?.() ?? ''}`);
  } else if (cmd === 'make-bucket') {
    const { CreateBucketCommand } = await import('@aws-sdk/client-s3');
    const name = arg || target.bucket;
    await client().send(new CreateBucketCommand({ Bucket: name }));
    console.log(`S3-BACKUP: Bucket angelegt ${name} @ ${target.endpoint}`);
  } else if (cmd === 'list') {
    const prefix = arg || 'backups/';
    const res = await client().send(new ListObjectsV2Command({ Bucket: target.bucket, Prefix: prefix }));
    const items = res.Contents ?? [];
    console.log(`S3-BACKUP: ${items.length} Objekt(e) unter ${prefix} @ ${target.endpoint}/${target.bucket}`);
    for (const o of items) console.log(`  ${o.Key}  ${o.Size} bytes  ${o.LastModified?.toISOString?.() ?? ''}`);
  } else if (cmd === 'upload') {
    const file = arg;
    const key = arg2 || `backups/${file.split('/').pop()}`;
    const size = statSync(file).size;
    const c = client();
    // Buffer statt Stream: der Projekt-Uploadpfad macht es genauso; Streams
    // scheitern an manchen Endpoints (STREAMING-UNSIGNED-PAYLOAD-TRAILER).
    await c.send(new PutObjectCommand({ Bucket: target.bucket, Key: key, Body: readFileSync(file) }));
    const head = await c.send(new HeadObjectCommand({ Bucket: target.bucket, Key: key }));
    if (head.ContentLength !== size) {
      console.error(`S3-BACKUP: Groessenabweichung lokal=${size} remote=${head.ContentLength}`);
      process.exit(3);
    }
    console.log(`S3-BACKUP: ok ${key} (${size} bytes, etag=${head.ETag})`);
  } else if (cmd === 'restore') {
    const key = arg;
    const dest = arg2;
    if (!key || !dest) { console.error('restore <key> <ziel>'); process.exit(2); }
    const obj = await client().send(new GetObjectCommand({ Bucket: target.bucket, Key: key }));
    if (!obj.Body) { console.error('S3-BACKUP: kein Body'); process.exit(3); }
    await pipeline(obj.Body, createWriteStream(dest));
    console.log(`S3-BACKUP: restore ok ${key} -> ${dest} (${statSync(dest).size} bytes)`);
  } else {
    console.error('Verwendung: r2-backup.mjs list [prefix] | upload <datei> [key] | restore <key> <ziel>');
    process.exit(2);
  }
} catch (e) {
  console.error('S3-BACKUP FAIL', e?.Code || e?.name, e?.message);
  process.exit(1);
}
