/**
 * PERF-P1-002 · public/ -> dist/ ohne die Overlay-Medien (Tiefen-Optimierung 2026-09-21)
 * =====================================================================================
 * Befund: `vite build` kopierte den kompletten publicDir (3,7 GB) nach dist/. Gemessen
 * 5:45 min Wanduhr bei 25 s CPU – fast nur Plattenarbeit, fuer Baeume, die im Image
 * (.dockerignore) fehlen und im Betrieb per Medien-Overlay gemountet werden.
 *
 * Diese Tests halten zwei Dinge fest:
 *   1. die Auswahl (Overlay-Baeume werden verlinkt, alles andere kopiert, fehlende
 *      Quellen – Docker-Build – werden still uebersprungen),
 *   2. den Vertrag mit docker-compose.media.yml: die verlinkten Pfade MUESSEN genau
 *      den Mount-Zielen entsprechen. Sonst laeuft dist/ und der Mount auseinander,
 *      und der Fehler faellt erst im Betrieb auf.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, lstatSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OVERLAY_DIRS, planAssetCopy } from '../scripts/build-public-assets.mjs';

const ROOT = path.resolve(__dirname, '..');
let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'am-public-assets-'));
  // Realitaetsnahes Mini-public/: Overlay-Baeume + normale Assets
  mkdirSync(path.join(tmp, 'public/models'), { recursive: true });
  writeFileSync(path.join(tmp, 'public/models/htdemucs.onnx'), 'x'.repeat(64));
  mkdirSync(path.join(tmp, 'public/data/orchestral/strings'), { recursive: true });
  writeFileSync(path.join(tmp, 'public/data/orchestral/strings/violin.wav'), 'x'.repeat(32));
  writeFileSync(path.join(tmp, 'public/data/instruments.json'), '{}');
  mkdirSync(path.join(tmp, 'public/assets'), { recursive: true });
  writeFileSync(path.join(tmp, 'public/assets/app.css'), 'body{}');
  writeFileSync(path.join(tmp, 'public/favicon.ico'), 'i');
  // music bewusst NICHT angelegt -> Fall "Docker-Build: Inhalt fehlt"
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('planAssetCopy', () => {
  it('laesst die Overlay-Baeume aus dem Kopierplan heraus', () => {
    const plan = planAssetCopy(path.join(tmp, 'public'));
    const copied = plan.copies.map((c) => c.rel);
    expect(copied).not.toContain('models/htdemucs.onnx');
    expect(copied).not.toContain('data/orchestral/strings/violin.wav');
    expect(copied.some((r) => r.startsWith('data/orchestral'))).toBe(false);
    // Der Nachbarteil von data/ wird weiterhin kopiert (nur der Overlay-Zweig faellt raus)
    expect(copied).toContain('data/instruments.json');
    expect(copied).toContain('assets/app.css');
    expect(copied).toContain('favicon.ico');
  });

  it('meldet vorhandene Overlay-Baeume als Symlink-Kandidaten, fehlende gar nicht', () => {
    const plan = planAssetCopy(path.join(tmp, 'public'));
    const rels = plan.links.map((l) => l.rel);
    expect(rels).toContain('models');
    expect(rels).toContain('data/orchestral');
    expect(rels).not.toContain('music'); // Quelle fehlt (Image-Build) -> kein Link, kein Fehler
    expect(plan.skipped).toEqual(expect.arrayContaining(['models', 'data/orchestral']));
  });

  it('haelt den Vertrag mit docker-compose.media.yml (Drift-Schutz)', () => {
    const compose = readFileSync(path.join(ROOT, 'docker-compose.media.yml'), 'utf8');
    const mounts = [...compose.matchAll(/-\s+\.\/media\/([^:]+):(\/app\/dist\/[^:\s]+):/g)].map((m) => ({
      source: m[1],
      target: m[2].replace('/app/dist/', ''),
    }));
    expect(mounts.length).toBeGreaterThanOrEqual(3);
    for (const mount of mounts) {
      // Jeder Mount muss in der Ausnahmeliste stehen ...
      expect(OVERLAY_DIRS.map((e) => e.rel)).toContain(mount.target);
      // ... und die Liste darf keine Baume ausnehmen, die gar nicht gemountet werden.
    }
    for (const entry of OVERLAY_DIRS) {
      expect(mounts.some((m) => m.target === entry.rel)).toBe(true);
      const declared = mounts.find((m) => m.target === entry.rel)!;
      // Quelle im Medien-Store (<deploy>/media/<media>) - darf vom Zielpfad abweichen
      expect(declared.source).toBe(entry.media);
      expect(entry.mount).toBe(`/app/dist/${entry.rel}`);
    }
  });

  it('schaltet die Vite-Kopie ab – sonst waere die Auswahl hier wirkungslos', () => {
    const viteConfig = readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf8');
    expect(viteConfig).toMatch(/copyPublicDir:\s*false/);
  });

  it('ist im npm-Build verdrahtet', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.build).toContain('scripts/build-public-assets.mjs');
    // Reihenfolge: erst Vite (dist/ anlegen), dann Worklets (schreiben public/
    // UND dist/ frisch), dann die Assets – sonst ueberschreibt die Kopie die
    // frisch gebauten Worklets mit alten aus public/.
    const build = pkg.scripts.build as string;
    expect(build.indexOf('vite build')).toBeLessThan(build.indexOf('build-worklets.mjs'));
    expect(build.indexOf('build-worklets.mjs')).toBeLessThan(build.indexOf('build-public-assets.mjs'));
  });

  it('ersetzt eine Alt-Kopie durch einen relativen Symlink und kopiert den Rest', async () => {
    const { copyPublicAssets } = await import('../scripts/build-public-assets.mjs');
    const fixtureDist = path.join(tmp, 'dist');
    // Zustand VOR der Optimierung nachstellen: echter Ordner mit voller Kopie
    mkdirSync(path.join(fixtureDist, 'models'), { recursive: true });
    writeFileSync(path.join(fixtureDist, 'models/htdemucs.onnx'), 'alte volle Kopie');
    mkdirSync(path.join(fixtureDist, 'data/orchestral'), { recursive: true });
    writeFileSync(path.join(fixtureDist, 'data/orchestral/alt.wav'), 'alt');

    const result = copyPublicAssets(path.join(tmp, 'public'), fixtureDist);

    // Overlay-Baeume: Symlink statt Kopie, Alt-Inhalt ist weg
    const modelsLink = path.join(fixtureDist, 'models');
    expect(lstatSync(modelsLink).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(modelsLink, 'htdemucs.onnx'))).toBe(true); // ueber den Link erreichbar
    expect(existsSync(path.join(fixtureDist, 'data/orchestral/alt.wav'))).toBe(false);
    expect(lstatSync(path.join(fixtureDist, 'data/orchestral')).isSymbolicLink()).toBe(true);
    // Der Symlink ist relativ -> dist/ bleibt verschiebbar
    expect(readlinkSync(modelsLink).startsWith('/')).toBe(false);
    // Normale Assets werden kopiert, fehlende Overlay-Quelle (music) still uebersprungen
    expect(readFileSync(path.join(fixtureDist, 'assets/app.css'), 'utf8')).toBe('body{}');
    expect(readFileSync(path.join(fixtureDist, 'data/instruments.json'), 'utf8')).toBe('{}');
    expect(result.links.map((l: { rel: string }) => l.rel)).not.toContain('music');
    expect(result.absent).toContain('music');
    // Quelle bleibt unberuehrt (nichts verschoben)
    expect(readFileSync(path.join(tmp, 'public/models/htdemucs.onnx'), 'utf8').length).toBe(64);
  });
});
