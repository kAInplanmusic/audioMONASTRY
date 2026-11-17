/** Read-only A1b projection. Never persist raw responses or credential values. */
import { readFileSync, statSync } from 'node:fs';
import dotenv from 'dotenv';

const path = process.env.PROVIDER_ENV_FILE;
const file = path ? dotenv.parse(readFileSync(path)) : {};
const secret = name => process.env[name] || file[name] || '';
function redact(text) {
  for (const value of Object.values(file)) if (value.length >= 8) text = text.split(value).join('[REDACTED]');
  for (const name of ['HCLOUD_TOKEN', 'HETZNER_TOKEN', 'VAST_API_KEY', 'RUNPOD_API_KEY']) {
    const value = process.env[name]; if (value) text = text.split(value).join('[REDACTED]');
  }
  return text;
}
const report = { at: new Date().toISOString(), credentialSource: path ? 'explicit env file outside repository' : 'process environment',
  fileMode: path ? (statSync(path).mode & 0o777).toString(8) : null,
  present: Object.fromEntries(['HCLOUD_TOKEN', 'HETZNER_TOKEN', 'VAST_API_KEY', 'RUNPOD_API_KEY', 'SSH_AUTH_SOCK'].map(k => [k, Boolean(secret(k))])),
  requests: [], providers: {}, ipAssignments: {}, gpuTotal: null, costsPerHour: null };
const safeNumber = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
async function query(provider, endpoint, token) {
  try {
    const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(25000), redirect: 'error' });
    const data = await response.json().catch(() => null);
    report.requests.push({ provider, method: 'GET', path: new URL(endpoint).pathname, status: response.status,
      success: response.ok, responseKeys: data && typeof data === 'object' ? Object.keys(data).sort() : [],
      error: response.ok ? null : redact(String(data?.error?.code ?? data?.error ?? data?.msg ?? 'HTTP error')).slice(0, 250) });
    return response.ok ? data : null;
  } catch {
    // Fetch error strings can embed URLs/headers. Only fixed classifications leave memory.
    report.requests.push({ provider, method: 'GET', path: new URL(endpoint).pathname, status: null, success: false, error: 'network/timeout/redirect error' });
    return null;
  }
}

const hzAlias = process.env.PROVIDER_HETZNER_ALIAS;
if (hzAlias && !['HCLOUD_TOKEN', 'HETZNER_TOKEN', 'HetznerPRAIN'].includes(hzAlias)) throw new Error('Unsupported Hetzner credential alias');
const hzToken = hzAlias ? secret(hzAlias) : secret('HCLOUD_TOKEN') || secret('HETZNER_TOKEN');
report.hetznerCredentialAlias = hzAlias ?? 'HCLOUD_TOKEN or HETZNER_TOKEN';
if (hzToken) {
  const servers = []; let page = 1, complete = true;
  do {
    const data = await query('hetzner', `https://api.hetzner.cloud/v1/servers?per_page=50&page=${page}`, hzToken);
    if (!Array.isArray(data?.servers)) { complete = false; break; }
    servers.push(...data.servers); page = data.meta?.pagination?.next_page ?? null;
  } while (page);
  const pricing = complete ? await query('hetzner', 'https://api.hetzner.cloud/v1/pricing', hzToken) : null;
  report.providers.hetzner = { complete, currency: pricing?.pricing?.currency ?? null,
    rows: servers.map(s => {
      const location = s.datacenter?.location?.name;
      const prices = pricing?.pricing?.server_types?.find(t => t.id === s.server_type?.id)?.prices?.find(p => p.location === location);
      return { id: s.id, name: s.name, status: s.status, type: s.server_type?.name ?? null,
        region: location ?? null, publicIpv4: s.public_net?.ipv4?.ip ?? null,
        // A label is an operator assignment, not a service-health assertion.
        roleLabel: s.labels?.role ?? null, gpuCount: null,
        gpuCountMethod: 'no GPU enumeration supplied by this server response; SSH GPU probe required',
        hourlyNet: prices?.price_hourly?.net ?? null, hourlyGross: prices?.price_hourly?.gross ?? null,
        priceScope: 'API server-type/location tariff; not invoice, excludes IPs/volumes/snapshots/traffic and other accounts' };
    }) };
} else report.providers.hetzner = { complete: false, error: 'credential missing', rows: [] };

const vastToken = secret('VAST_API_KEY');
if (vastToken) {
  // Official v1 contract: max25, after_token <- next_token. v0 returns HTTP410.
  const rows = []; const cursors = new Set(); let cursor = null, complete = true, expected = null;
  do {
    const url = new URL('https://console.vast.ai/api/v1/instances/'); url.searchParams.set('limit', '25');
    if (cursor) url.searchParams.set('after_token', cursor);
    const data = await query('vast', url.toString(), vastToken);
    if (data?.success !== true || !Array.isArray(data.instances)) { complete = false; break; }
    if (expected === null) expected = data.total_instances;
    rows.push(...data.instances); cursor = data.next_token;
    if (cursor && cursors.has(cursor)) { complete = false; break; }
    if (cursor) { cursors.add(cursor); await new Promise(r => setTimeout(r, 1100)); }
  } while (cursor);
  if (typeof expected === 'number' && rows.length !== expected) complete = false;
  report.providers.vast = { complete, totalInstancesReported: expected, currency: 'USD', rows: rows.map(s => ({
    id: s.id, label: s.label ?? null, status: s.actual_status ?? s.cur_state ?? null,
    gpuType: s.gpu_name ?? null, gpuCount: safeNumber(s.num_gpus), hourly: safeNumber(s.dph_total),
    publicIpv4: s.public_ipaddr ?? null, sshHost: s.ssh_host ?? null, sshPort: s.ssh_port ?? null,
    priceScope: 'API dph_total; not invoice or EUR exchange conversion',
  })) };
} else report.providers.vast = { complete: false, error: 'credential missing', rows: [] };

const rpToken = secret('RUNPOD_API_KEY');
if (rpToken) {
  const data = await query('runpod', 'https://rest.runpod.io/v1/pods', rpToken);
  const rows = Array.isArray(data) ? data : null;
  report.providers.runpod = { complete: rows !== null, currency: 'USD', rows: (rows ?? []).map(s => ({
    id: s.id, name: s.name ?? null, status: s.desiredStatus ?? null,
    gpuType: s.machine?.gpuDisplayName ?? s.gpuTypeId ?? null, gpuCount: safeNumber(s.gpuCount),
    hourly: safeNumber(s.costPerHr), publicIpv4: s.publicIp ?? null,
  })) };
} else report.providers.runpod = { complete: false, error: 'credential missing', rows: [] };

for (const ip of ['135.181.111.103', '135.181.251.14', '77.42.8.166']) {
  const matches = Object.entries(report.providers).flatMap(([provider, data]) => data.rows
    .filter(row => row.publicIpv4 === ip).map(row => ({ provider, id: row.id, roleLabel: row.roleLabel ?? row.label ?? null })));
  report.ipAssignments[ip] = { matches, status: matches.length ? 'present in queried account; role is label only'
    : Object.values(report.providers).every(p => p.complete) ? 'unknown host, not in queried own accounts' : 'not found in completed queries; remaining accounts unknown' };
}
// Partial account access cannot establish a global count or a global cost.
if (Object.values(report.providers).every(p => p.complete) && Object.values(report.providers).every(p => p.rows.every(r => r.gpuCount !== null))) {
  report.gpuTotal = Object.values(report.providers).reduce((n, p) => n + p.rows.reduce((s, r) => s + r.gpuCount, 0), 0);
}
report.costsPerHour = Object.fromEntries(Object.entries(report.providers).map(([name, p]) => [name, {
  currency: p.currency ?? null, total: p.complete && p.rows.every(r => safeNumber(Number(r.hourlyNet ?? r.hourly)) !== null && (r.hourlyNet ?? r.hourly) !== null)
    ? p.rows.reduce((n, r) => n + Number(r.hourlyNet ?? r.hourly), 0) : null,
  scope: 'listed resources only; excludes other chargeable services; no currency conversion',
}]));
console.log(redact(JSON.stringify(report, null, 2)));
