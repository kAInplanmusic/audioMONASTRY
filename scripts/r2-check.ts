import 'dotenv/config';
import { S3Client, ListBucketsCommand, DeleteBucketCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';

const endpoint = process.env.CFR2_URL!.trim();
const client = new S3Client({
  region: 'auto',
  endpoint,
  credentials: {
    accessKeyId: process.env.CFR2_ACCESS_KEY_ID || process.env.CFR2_ACCESS_KEY || '',
    secretAccessKey: process.env.CFR2_SECRET_ACCESS_KEY || '',
  },
});

(async () => {
  // überflüssigen, gerade erzeugten Bucket entfernen (falls leer)
  try { await client.send(new DeleteBucketCommand({ Bucket: 'audio-monastry-samples' })); console.log('DELETED audio-monastry-samples'); } catch { console.log('delete skipped (nicht leer oder nicht vorhanden)'); }

  const target = process.env.CFR2_BUCKET!.trim();
  const list = await client.send(new ListBucketsCommand({}));
  console.log('BUCKETS:', JSON.stringify((list.Buckets ?? []).map((b) => b.Name)));

  const objs = await client.send(new ListObjectsV2Command({ Bucket: target, MaxKeys: 5 }));
  console.log('OBJECTS in', target, ':', (objs.Contents ?? []).length);

  await client.send(new PutObjectCommand({ Bucket: target, Key: 'uploads/health-check.txt', Body: 'audioMONASTRY health-check', ContentType: 'text/plain' }));
  console.log('PUT ok:', target + '/uploads/health-check.txt');
})().catch((e) => { console.error('R2-ERROR', e.name, e.message); process.exit(1); });
