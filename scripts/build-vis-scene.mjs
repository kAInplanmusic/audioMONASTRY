// Bündelt den Pod-Einstieg (src/core/visual/podScene.ts) für headless Chromium.
// Das Ergebnis wird eingecheckt: der Docker-Kontext des Images enthält kein src/.
// `--check` baut in den Speicher und vergleicht mit der eingecheckten Datei.
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = root + 'services/audiomonastry-ai-runtime/visual/scene.js';

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

if (import.meta.url === `file://${process.argv[1]}`) {
  const text = await bundle();
  if (process.argv.includes('--check')) {
    if (readFileSync(out, 'utf8') !== text) {
      console.error('visual/scene.js ist veraltet: npm run build:vis-scene');
      process.exit(1);
    }
    console.log('visual/scene.js ist aktuell');
  } else {
    writeFileSync(out, text);
    console.log('geschrieben:', out, text.length, 'Bytes');
  }
}
