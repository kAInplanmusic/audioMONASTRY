/**
 * S3/R2 Presigned-URLs (SigV4, Query-Signatur) ohne zusätzliches Paket
 * ====================================================================
 * Spiegel von `scripts/s3lite.py` → `S3Target.presign` (gleiche Kanonisierung,
 * gleicher Testvektor aus der AWS-Doku, siehe tests/s3Presign.test.ts und
 * tests/test_s3lite.py). Gebraucht für FLEET-P1-006: der stems-Pod lädt die
 * fertigen Stems per PUT direkt in R2, statt sie als riesiges Base64 in der
 * Job-Antwort zu schicken. Der Pod bekommt nur zeitlich begrenzte URLs, nie
 * Schlüssel (Keys bleiben serverseitig, AGENTS.md §4.5).
 */
import { createHash, createHmac } from 'node:crypto';

export interface PresignTarget {
  /** z. B. https://<account>.r2.cloudflarestorage.com (ohne Bucket). */
  endpoint: string;
  /** Pfad-Stil; leer = Bucket steckt schon im Endpoint (virtueller Host). */
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  service?: string;
}

/** RFC-3986-Kodierung wie `urllib.parse.quote(v, safe="-_.~")`. */
function quote(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function hmac(key: Buffer | string, msg: string): Buffer {
  return createHmac('sha256', key).update(msg, 'utf8').digest();
}

function amzDates(now: Date): { amzDate: string; date: string } {
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { amzDate: iso, date: iso.slice(0, 8) };
}

/** Presigned URL für `method` auf `key` (Gültigkeit `expires` Sekunden, max. 7 Tage). */
export function presignUrl(target: PresignTarget, method: string, key: string, expires = 3600, now = new Date()): string {
  if (!Number.isInteger(expires) || expires < 1 || expires > 604_800) throw new Error('expires muss 1..604800 s sein');
  const region = target.region || 'auto';
  const service = target.service || 's3';
  const url = new URL(target.endpoint.replace(/\/+$/, ''));
  const base = url.pathname.replace(/\/+$/, '');
  const keyPart = key.replace(/^\/+/, '').split('/').map(quote).join('/');
  const path = target.bucket ? `${base}/${quote(target.bucket)}/${keyPart}` : `${base}/${keyPart}`;
  const { amzDate, date } = amzDates(now);
  const scope = `${date}/${region}/${service}/aws4_request`;
  const query: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${target.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${quote(k)}=${quote(query[k])}`)
    .join('&');
  const host = url.host;
  const canonicalRequest = [method.toUpperCase(), path, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  let signingKey = hmac(`AWS4${target.secretAccessKey}`, date);
  signingKey = hmac(signingKey, region);
  signingKey = hmac(signingKey, service);
  signingKey = hmac(signingKey, 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  return `${url.protocol}//${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
