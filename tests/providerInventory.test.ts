import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function inventory(routes: Record<string, { body: unknown; status?: number }>) {
  const source = `const routes=${JSON.stringify(routes)};
    globalThis.fetch=async url=>{const path=new URL(url).pathname;const r=routes[path];if(!r)throw new Error('unexpected request');return new Response(JSON.stringify(r.body),{status:r.status??200})};
    await import('./scripts/audit/provider-inventory.mjs');`;
  const output = execFileSync(process.execPath, ['--input-type=module', '--eval', source], {
    encoding: 'utf8', env: { ...process.env, PROVIDER_ENV_FILE: '', PROVIDER_HETZNER_ALIAS: '',
      HCLOUD_TOKEN: 'inventory-fixture-hz', HETZNER_TOKEN: '', VAST_API_KEY: 'inventory-fixture-vast', RUNPOD_API_KEY: 'inventory-fixture-rp' },
  });
  return JSON.parse(output);
}
describe('A1b read-only projection and unknown-cost contracts', () => {
  const empty = {
    '/v1/servers': { body: { servers: [], meta: { pagination: { next_page: null } } } },
    '/v1/pricing': { body: { pricing: { currency: 'EUR', server_types: [] } } },
    '/api/v1/instances/': { body: { success: true, instances: [], total_instances: 0, next_token: null } },
    '/v1/pods': { body: [] },
  };
  it('only establishes zero when all supplied accounts actually return complete empty lists', () => {
    const r = inventory(empty);
    expect(r.gpuTotal).toBe(0); expect(r.costsPerHour.vast.total).toBe(0);
    expect(r.requests.every(x => x.method === 'GET')).toBe(true);
    expect(r.ipAssignments['77.42.8.166'].status).toBe('unknown host, not in queried own accounts');
  });
  it('keeps HTTP errors and malformed list structures unknown rather than empty', () => {
    const r = inventory({ ...empty, '/api/v1/instances/': { body: { success: false, error: 'unauthorized' }, status: 401 } });
    expect(r.providers.vast.complete).toBe(false); expect(r.gpuTotal).toBeNull(); expect(r.costsPerHour.vast.total).toBeNull();
    expect(r.requests.find(x => x.provider === 'vast')).toMatchObject({ status: 401, error: 'unauthorized' });
    expect(r.ipAssignments['77.42.8.166'].status).toContain('remaining accounts unknown');
  });
  it('marks an incomplete page count unknown and never exports unselected raw credential fields', () => {
    const r = inventory({ ...empty, '/api/v1/instances/': { body: { success: true,
      instances: [{ id: 1, num_gpus: 2, dph_total: .5, jupyter_token: 'fixture-must-not-escape', extra_env: [['SECRET', 'fixture-must-not-escape']] }],
      total_instances: 2, next_token: null } } });
    expect(r.providers.vast.complete).toBe(false); expect(r.costsPerHour.vast.total).toBeNull();
    expect(JSON.stringify(r)).not.toContain('fixture-must-not-escape');
  });
});
