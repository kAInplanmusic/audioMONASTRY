import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('mixer native loader', () => {
  it('lässt sich ohne Fehler laden', () => {
    expect(() => require('../services/mixer/index.js')).not.toThrow();
  });
});
