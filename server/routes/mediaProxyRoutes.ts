/**
 * Same-origin-Auslieferung von R2-Objekten (`GET /api/media/r2/<key>`).
 * ====================================================================
 * Warum es diese Route gibt: Der Bucket war öffentlich (`pub-*.r2.dev`), damit
 * jede Datei per Direkt-URL erreichbar. Für die Produktion wird der Public
 * Access abgeschaltet (Gewichte, Autosaves, kommerzielle Musik liegen im selben
 * Bucket). Danach müssen Samples, Vision-Bilder und Stems über die App laufen.
 *
 * Eigenschaften:
 *  - Präfix-Whitelist (`samples/`, `uploads/`, `vision/`, `visuals/`, `stems/`),
 *    kein `..`, kein Backslash, Pfadlänge begrenzt.
 *  - Range wird durchgereicht (Audio-Seek im Browser), `206` + `Content-Range`.
 *  - `Cache-Control: private, max-age=3600` — die Datei darf im Browser-Cache
 *    liegen, nicht in Shared-Caches (token-geschützter Zugriff).
 *  - Presigned URL (300 s) nur serverseitig: die Schlüssel bleiben im Prozess.
 */
import { Readable } from 'node:stream';
import type { Express, Request, Response } from 'express';
import { resolveR2Config } from '../r2Config.ts';
import { presignUrl } from '../s3Presign.ts';

/** Nur diese Präfixe dürfen über die Route gelesen werden. */
const ALLOWED_PREFIXES = ['samples/', 'uploads/', 'vision/', 'visuals/', 'stems/', 'music/'] as const;

/** Endungen, die auch ohne Präfix (Bucket-Wurzel, Musik-Master) erlaubt sind. */
const ROOT_MEDIA_EXT = new Set([
  'mp3', 'flac', 'wav', 'aiff', 'aif', 'm4a', 'ogg', 'opus', 'mp4', 'webm', 'jpg', 'jpeg', 'png', 'webp',
]);

const MIME_BY_EXT: Record<string, string> = {
  mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav', aiff: 'audio/aiff',
  aif: 'audio/aiff', m4a: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/ogg',
  mp4: 'video/mp4', webm: 'video/webm', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png', webp: 'image/webp', json: 'application/json',
};

function mimeFor(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** Schlüssel aus dem Wildcard-Parameter, dekodiert und geprüft. */
export function r2KeyFromRequest(req: Request): string {
  const raw = String((req.params as Record<string, string>)[0] ?? '');
  let key: string;
  try {
    key = decodeURIComponent(raw);
  } catch {
    return '';
  }
  return key.replace(/^\/+/, '');
}

/** Whitelist-Prüfung. Exportiert, damit der Test sie direkt abdeckt. */
export function isAllowedR2Key(key: string): boolean {
  if (!key || key.length > 512) return false;
  if (key.includes('..') || key.includes('\\') || key.startsWith('/')) return false;
  if (ALLOWED_PREFIXES.some((p) => key.startsWith(p))) return true;
  // Musik-Master liegen teils direkt in der Bucket-Wurzel — dort nur Medien.
  if (!key.includes('/')) {
    const ext = key.split('.').pop()?.toLowerCase() ?? '';
    return ROOT_MEDIA_EXT.has(ext);
  }
  return false;
}

export function registerMediaProxyRoutes(app: Express): void {
  app.get('/api/media/r2/*', async (req: Request, res: Response) => {
    const key = r2KeyFromRequest(req);
    if (!isAllowedR2Key(key)) {
      return res.status(404).json({ error: 'unbekannter Pfad', code: 'MEDIA_KEY_NOT_ALLOWED' });
    }
    const cfg = resolveR2Config(process.env);
    if (!cfg.configured || !cfg.hasCredentials) {
      return res.status(503).json({ error: 'R2 nicht konfiguriert', code: 'R2_MISSING' });
    }

    const signed = presignUrl(
      {
        endpoint: cfg.endpoint,
        bucket: cfg.bucket,
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
        region: cfg.region,
      },
      'GET',
      key,
      300,
    );

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 20_000);
    res.on('close', () => abort.abort());
    try {
      const range = String(req.headers?.range ?? '');
      const upstream = await fetch(signed, {
        signal: abort.signal,
        headers: range ? { Range: range } : undefined,
      });
      if (upstream.status === 404) return res.status(404).end();
      if (upstream.status === 429) {
        res.setHeader('Retry-After', '2');
        return res.status(503).json({ error: 'R2 drosselt', code: 'R2_THROTTLED' });
      }
      if (upstream.status !== 200 && upstream.status !== 206) return res.status(502).end();

      res.status(upstream.status);
      res.setHeader('Content-Type', mimeFor(key));
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      for (const [header, target] of [
        ['content-length', 'Content-Length'],
        ['content-range', 'Content-Range'],
        ['etag', 'ETag'],
        ['last-modified', 'Last-Modified'],
      ] as const) {
        const v = upstream.headers.get(header);
        if (v) res.setHeader(target, v);
      }
      if (req.method === 'HEAD' || !upstream.body) return res.end();
      Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
      return undefined;
    } catch (e) {
      const aborted = (e as Error).name === 'AbortError';
      if (!res.headersSent) {
        return aborted
          ? res.status(504).json({ error: 'Zeitüberschreitung', code: 'MEDIA_TIMEOUT' })
          : res.status(502).json({ error: 'Datei nicht ladbar', code: 'MEDIA_FETCH_FAILED' });
      }
      return res.end();
    } finally {
      clearTimeout(timer);
    }
  });
}
