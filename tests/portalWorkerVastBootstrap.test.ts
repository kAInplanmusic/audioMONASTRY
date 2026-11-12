import { afterEach, describe, expect, it, vi } from 'vitest';
import portalWorker, { envFile, bootstrapSourceRef, syncServiceDns } from '../services/portal-worker/src/index.js';

function parsed(env: Record<string, string>, role: string) {
  return Object.fromEntries(envFile(env, role).split('\n').filter((x: string) => x && !x.startsWith('#')).map((x: string) => {
    const i = x.indexOf('='); return [x.slice(0, i), x.slice(i + 1)];
  }));
}

describe('Portal cold start uses the migrated application configuration', () => {
  it('passes Vast credentials only to the app and selects its existing provider', () => {
    const input = { VAST_API_KEY: 'vast-test-only', AI_POD_TOKEN: 'pod-test-only',
      GHCR_USERNAME: 'registry-user', GHCR_PASSWORD: 'registry-test-only', HF_TOKEN: 'hf-test-only' };
    const app = parsed(input, 'app');
    expect(app).toMatchObject({ ...input, AI_GPU_PROVIDER: 'vast', AI_FLEET_MODE: 'pods',
      AI_MAX_AI_EUR_PER_HOUR: '8', AI_MAX_FLEET_EUR_PER_HOUR: '8' });
    for (const role of ['sfu', 'media', 'master', 'edge']) {
      const other = parsed(input, role);
      for (const key of Object.keys(input)) expect(other[key]).toBeUndefined();
    }
  });
  it('uses the migration branch by default and permits an explicit release ref', () => {
    expect(bootstrapSourceRef({})).toBe('fix/model-weight-provisioning-20261110');
    expect(bootstrapSourceRef({ DEPLOY_REF: 'release/2026.11' })).toBe('release/2026.11');
  });
  it('rejects shell syntax and ambiguous refs before generating cloud-init', () => {
    for (const ref of ["main'; touch /tmp/unwanted; #", '$(command)', '-other', 'a..b', 'a//b']) {
      expect(() => bootstrapSourceRef({ DEPLOY_REF: ref })).toThrow('Invalid deployment ref');
    }
  });
});


describe('New-domain routing and dynamic service DNS', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('redirects www to the canonical HTTPS origin without waking a fleet', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const res = await portalWorker.fetch(new Request('https://www.hallerbans.de/portal?next=studio'), {});
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('https://hallerbans.de/portal?next=studio');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('creates service DNS only from observed service IPs, without proxying media traffic', async () => {
    const created: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/zones')) return Response.json({ success: true, result: [{ id: 'zone' }] });
      if (init.method === 'POST') {
        created.push(JSON.parse(String(init.body)));
        return Response.json({ success: true, result: { id: 'record' } });
      }
      return Response.json({ success: true, result: [] });
    }));
    const result = await syncServiceDns({ CLOUDFLARE_API_TOKEN: 'test-only' }, {
      'audiomonastry-sfu-1': { public_net: { ipv4: { ip: '198.51.100.7' } } },
      'audiomonastry-media-1': { public_net: { ipv4: { ip: '203.0.113.8' } } },
    });
    expect(result.ok).toBe(true);
    expect(created).toEqual([
      { type: 'A', name: 'sfu.hallerbans.de', content: '198.51.100.7', proxied: false, ttl: 300 },
      { type: 'A', name: 'master.hallerbans.de', content: '203.0.113.8', proxied: false, ttl: 300 },
    ]);
  });
});
