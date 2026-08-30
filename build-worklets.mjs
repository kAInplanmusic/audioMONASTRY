import * as esbuild from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';
import { readdir, mkdir, copyFile } from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WORKLETS_DIR = path.resolve(__dirname, 'src/audio/worklets');

// Prod: server.ts serviert dist/ statisch -> /worklets/*.js zeigt auf dist/worklets
const DIST_OUTPUT = path.resolve(__dirname, 'dist/worklets');
// Dev: Vite serviert public/ als Root -> /worklets/*.js zeigt auf public/worklets
const PUBLIC_OUTPUT = path.resolve(__dirname, 'public/worklets');

async function buildWorklets() {
  for (const OUTPUT_DIR of [DIST_OUTPUT, PUBLIC_OUTPUT]) {
    await mkdir(OUTPUT_DIR, { recursive: true });
    const files = await readdir(WORKLETS_DIR);

    for (const file of files) {
      if (file.endsWith('.ts')) {
        const inputPath = path.join(WORKLETS_DIR, file);
        const outputPath = path.join(OUTPUT_DIR, file.replace('.ts', '.js'));
        console.log(`Building ${inputPath} -> ${outputPath}`);
        await esbuild.build({
          entryPoints: [inputPath],
          bundle: true,
          outfile: outputPath,
          format: 'esm', // Web Worklets sind ES Modules
          platform: 'browser',
          sourcemap: false,
          minify: true,
        });
      }
    }
  }
  console.log('Worklets built successfully (dist/worklets + public/worklets)!');
}

buildWorklets().catch((error) => {
  console.error('Error building worklets:', error);
  process.exit(1);
});
