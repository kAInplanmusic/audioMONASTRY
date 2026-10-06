import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// UI2-P3-001: installierbare Web-App (iPhone/iPad: Teilen → Zum Home-Bildschirm).
const root = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(root, rel));

/** Breite/Höhe aus dem PNG-IHDR-Block. */
function pngSize(rel: string): { w: number; h: number } {
  const b = read(rel);
  expect(b.subarray(1, 4).toString('ascii')).toBe('PNG');
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

describe('Web-App-Manifest', () => {
  const manifest = JSON.parse(read('public/manifest.webmanifest').toString('utf8'));

  it('beschreibt eine eigenständige App mit Start auf /', () => {
    expect(manifest.name).toBe('audioMONASTRY');
    expect(manifest.start_url).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.lang).toBe('de');
  });

  it('liefert 192er, 512er und maskierbares Icon in echter Größe', () => {
    const icons = manifest.icons as { src: string; sizes: string; purpose: string }[];
    expect(icons.map((i) => `${i.sizes}/${i.purpose}`).sort()).toEqual(['192x192/any', '512x512/any', '512x512/maskable']);
    for (const icon of icons) {
      const [w, h] = icon.sizes.split('x').map(Number);
      expect(pngSize(`public${icon.src}`)).toEqual({ w, h });
    }
  });
});

describe('index.html', () => {
  const html = read('index.html').toString('utf8');

  it('verlinkt Manifest und Apple-Touch-Icon (180 px)', () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(html).toContain('<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png" />');
    expect(pngSize('public/assets/apple-touch-icon.png')).toEqual({ w: 180, h: 180 });
    expect(html).toContain('apple-mobile-web-app-capable');
  });

  it('trägt keine feste Versionsnummer im Titel (Quelle: package.json)', () => {
    expect(html).toMatch(/<title>[^<]*%APP_VERSION%[^<]*<\/title>/);
    expect(html).not.toMatch(/<title>[^<]*\d+\.\d+\.\d+/);
  });
});
