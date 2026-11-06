import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression guard for the launch-blocking defect found on 2026-11-06:
 *
 * SEC-2026-11-06-002 removed `.env*` from the Docker build context (correctly).
 * Vite then has no `.env` to read, so every build-time value has to arrive as a
 * `--build-arg`. The node template (`.env.hetzner.example`) names the Supabase
 * values `VITE_SB_URL` / `VITE_SB_ANON_PUB`, while the local `.env` uses
 * `VITE_SUPABASE_*`. Only the latter were forwarded - so the production bundle
 * shipped WITHOUT the Supabase URL, `cloudEnabled` was false and the library /
 * cloud paths were dead. No error, no warning: a silent empty value.
 *
 * These tests pin the wiring on all three paths (compose, both Dockerfiles,
 * deploy.sh) and the .dockerignore contract that made it necessary.
 */
const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('Deploy: VITE-Build-Args (SEC-2026-11-06-002 + Launch-Fix 2026-11-06)', () => {
  const compose = read('docker-compose.hetzner.yml');
  const dockerfile = read('Dockerfile');
  const dockerfileHetzner = read('Dockerfile.hetzner');
  const deploySh = read('deploy.sh');
  const dockerignore = read('.dockerignore');

  it('compose reicht beide Namenspaare an den Build (mit Fallback auf das andere)', () => {
    // Vier Zeilen: zwei Namen, jeweils mit Fallback auf den Alias.
    expect(compose).toMatch(/VITE_SUPABASE_URL:\s*\$\{VITE_SUPABASE_URL:-\$\{VITE_SB_URL:-\}\}/);
    expect(compose).toMatch(/VITE_SB_URL:\s*\$\{VITE_SB_URL:-\$\{VITE_SUPABASE_URL:-\}\}/);
    expect(compose).toMatch(
      /VITE_SUPABASE_ANON_PUB:\s*\$\{VITE_SUPABASE_ANON_PUB:-\$\{VITE_SB_ANON_PUB:-\}\}/,
    );
    expect(compose).toMatch(
      /VITE_SB_ANON_PUB:\s*\$\{VITE_SB_ANON_PUB:-\$\{VITE_SUPABASE_ANON_PUB:-\}\}/,
    );
  });

  it('beide Dockerfiles deklarieren ARGs fuer alle vier Namen', () => {
    for (const [name, text] of [
      ['Dockerfile', dockerfile],
      ['Dockerfile.hetzner', dockerfileHetzner],
    ] as const) {
      for (const v of [
        'VITE_SUPABASE_URL',
        'VITE_SUPABASE_ANON_PUB',
        'VITE_SB_URL',
        'VITE_SB_ANON_PUB',
        'VITE_V2_AUDIO_MODE',
      ]) {
        expect(text, `${name} braucht ARG ${v}`).toMatch(new RegExp(`^ARG ${v}=`, 'm'));
      }
    }
  });

  it('deploy.sh gibt beide Namen als --build-arg weiter', () => {
    expect(deploySh).toMatch(/VITE_SUPABASE_URL:VITE_SB_URL/);
    expect(deploySh).toMatch(/VITE_SUPABASE_ANON_PUB:VITE_SB_ANON_PUB/);
    expect(deploySh).toMatch(/--build-arg "\$\{vite_key\}=\$\{vite_val\}"/);
  });

  it('.dockerignore haelt .env draussen und die Beispiele drin', () => {
    expect(dockerignore).toMatch(/^\.env$/m);
    expect(dockerignore).toMatch(/^\.env\.\*$/m);
    expect(dockerignore).toMatch(/^!\.env\.example$/m);
    expect(dockerignore).toMatch(/^!\.env\.hetzner\.example$/m);
    expect(dockerignore).toMatch(/^!\.env\.deploy\.example$/m);
  });

  it('die Knoten-Vorlage fuehrt die SB_-Namen (sonst greift der Fallback nie)', () => {
    const example = read('.env.hetzner.example');
    expect(example).toMatch(/^VITE_SB_URL=/m);
    expect(example).toMatch(/^VITE_SB_ANON_PUB=/m);
  });

  it('cloudConfig liest beide Namenspaare', () => {
    const cloudConfig = read('src/lib/cloudConfig.ts');
    expect(cloudConfig).toMatch(/VITE_SB_URL\s*\?\?\s*env\.VITE_SUPABASE_URL/);
    expect(cloudConfig).toMatch(/VITE_SB_ANON_PUB\s*\?\?\s*env\.VITE_SUPABASE_ANON_PUB/);
  });
});
