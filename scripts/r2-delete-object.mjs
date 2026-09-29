// Loescht ein Objekt aus dem R2-Bucket (Betriebswerkzeug).
// Entstanden am 2026-09-24, um die Polyglot-Beweisdatei aus SEC-P2-004/Angriff 5
// wieder zu entfernen - sie wurde als text/html ausgeliefert und durfte nicht
// liegen bleiben.
// Aufruf: node scripts/r2-delete-object.mjs <r2-key>
import { S3Client, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { readFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url),'utf8').split('\n').filter(l=>l.includes('=')&&!l.startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i), l.slice(i+1).replace(/^"|"$/g,'')];}));
const s3 = new S3Client({ region: 'auto', endpoint: env.CFS3_ENDPOINT, credentials: { accessKeyId: env.CFS3_ACCESS_KEY, secretAccessKey: env.CFS3_SECRET_KEY } });
const Key = process.argv[2];
if (!Key) { console.error('Aufruf: node scripts/r2-delete-object.mjs <r2-key>'); process.exit(2); }
await s3.send(new DeleteObjectCommand({ Bucket: env.CFS3_BUCKET, Key }));
console.log('  geloescht:', Key);
try { await s3.send(new HeadObjectCommand({ Bucket: env.CFS3_BUCKET, Key })); console.log('  ⚠ NOCH DA'); }
catch { console.log('  ✅ bestaetigt weg (HeadObject: NotFound)'); }
