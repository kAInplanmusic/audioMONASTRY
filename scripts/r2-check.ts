import 'dotenv/config';
import { S3Client, ListBucketsCommand, DeleteBucketCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';

const accountId = (process.env.CFR2_ACCOUNT_ID ?? '').trim();
const endpoint = (process.env.CFS3_ENDPOINT ?? `https://${accountId}.r2.cloudflarestorage.com`).trim();
if (!endpoint) throw new Error('CFS3_ENDPOINT fehlt');
const client = new S3Client({
  region: 'auto',
  endpoint,
  credentials: {
    accessKeyId: process.env.CFS3_ACCESS_KEY || process.env.CFR2_ACCESS_KEY_ID || process.env.CFR2_ACCESS_KEY || '',
    secretAccessKey: process.env.CFS3_SECRET_KEY || process.env.CFR2_SECRET_ACCESS_KEY || '',
  },
});

(async () => {
  // überflüssigen, gerade erzeugten Bucket entfernen (falls leer)
  try { await client.send(new DeleteBucketCommand({ Bucket: 'audio-monastry-samples' })); console.log('DELETED audio-monastry-samples'); } catch { console.log('delete skipped (nicht leer oder nicht vorhanden)'); }

  const target = (process.env.CFS3_BUCKET ?? process.env.CFR2_BUCKET ?? '').trim();
  if (!target) throw new Error('CFS3_BUCKET fehlt');
  const list = await client.send(new ListBucketsCommand({}));
  console.log('BUCKETS:', JSON.stringify((list.Buckets ?? []).map((b) => b.Name)));

  const objs = await client.send(new ListObjectsV2Command({ Bucket: target, MaxKeys: 5 }));
  console.log('OBJECTS in', target, ':', (objs.Contents ?? []).length);

  await client.send(new PutObjectCommand({ Bucket: target, Key: 'uploads/health-check.txt', Body: 'audioMONASTRY health-check', ContentType: 'text/plain' }));
  console.log('PUT ok:', target + '/uploads/health-check.txt');
})().catch((e) => { console.error('R2-ERROR', e.name, e.message); process.exit(1); });
