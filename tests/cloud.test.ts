import { describe, expect, it } from 'vitest';
import { cloudHealth, trimTrailingSlash } from '../server/cloud';

describe('cloudHealth', () => {
  it('meldet not-configured ohne Keys', async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE;
    delete process.env.SUPABASE_ANON_PUB;
    delete process.env.SUPABASE_PUBLISHABLE;
    delete process.env.CFR2_ACCOUNT_ID;
    delete process.env.CFR2_ACCESS_KEY_ID;
    delete process.env.CFR2_SECRET_ACCESS_KEY;
    delete process.env.CFR2_BUCKET;

    const health = await cloudHealth();
    expect(health.supabase).toBe('not-configured');
    expect(health.r2.status).toBe('not-configured');
  });
});

describe('trimTrailingSlash', () => {
  it('entfernt abschließende Slashes', () => {
    expect(trimTrailingSlash('https://example.com/')).toBe('https://example.com');
    expect(trimTrailingSlash('https://example.com///')).toBe('https://example.com');
    expect(trimTrailingSlash('https://example.com')).toBe('https://example.com');
    expect(trimTrailingSlash('/')).toBe('/');
  });
});
