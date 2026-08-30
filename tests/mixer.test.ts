import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('mixer native loader', () => {
  it('meldet kontrolliert, dass die NAPI-Binary nicht eingecheckt ist (F9-Fix)', () => {
    // F9: Die Binary wird nicht mehr committet, sondern im Dockerfile.multistage
    // aus dem Rust-Quellcode gebaut. Ohne Binary muss der Loader eine klare,
    // kontrollierte Fehlermeldung werfen (kein stiller Crash).
    expect(() => require('../services/mixer/index.js')).toThrowError(/Failed to load native binding|Unsupported OS|Cannot find module/);
  });
});
