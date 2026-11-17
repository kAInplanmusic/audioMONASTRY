// Bündelt den Pod-Einstieg (src/core/visual/podScene.ts) für headless Chromium und
// schreibt die Effektliste (visual/effects.json) aus derselben Registry.
// Beides wird eingecheckt: der Docker-Kontext des Images enthält kein src/.
// `--check` baut in den Speicher und vergleicht mit den eingecheckten Dateien.
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = root + 'services/audiomonastry-ai-runtime/visual/';

export async function bundle() {
  const result = await build({
    entryPoints: [root + 'src/core/visual/podScene.ts'],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'chrome110',
    platform: 'browser',
    legalComments: 'none',
    logLevel: 'silent',
  });
  return '// GENERIERT von scripts/build-vis-scene.mjs aus src/core/visual/podScene.ts - nicht von Hand aendern.\n'
    + result.outputFiles[0].text;
}

export async function effectsJson() {
  const result = await build({
    entryPoints: [root + 'src/core/visual/effects/registry.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const mod = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
  const effects = mod.EFFECTS.map(({ id, label, group }) => ({ id, label, group }));
  return JSON.stringify({ generatedBy: 'scripts/build-vis-scene.mjs', effects }, null, 2) + '\n';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = { 'scene.js': await bundle(), 'effects.json': await effectsJson() };
  if (process.argv.includes('--check')) {
    const stale = Object.entries(files).filter(([name, text]) => readFileSync(outDir + name, 'utf8') !== text);
    if (stale.length) {
      console.error('veraltet: ' + stale.map(([name]) => 'visual/' + name).join(', ') + ' - npm run build:vis-scene');
      process.exit(1);
    }
    console.log('visual/scene.js und visual/effects.json sind aktuell');
  } else {
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(outDir + name, text);
      console.log('geschrieben:', outDir + name, text.length, 'Bytes');
    }
  }
}
