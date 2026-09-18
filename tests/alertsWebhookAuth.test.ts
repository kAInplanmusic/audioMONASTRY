import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';

/**
 * PROD-P1-004: Alarmzustellung. Der Alertmanager ist ein Maschinen-Client und
 * kann kein Studio-Cookie halten - live belegt (2026-09-18) scheiterte jede
 * Zustellung mit 401 "STUDIO_TOKEN_REQUIRED", Alarme kamen also nie bei
 * Discord/Slack/Telegram an.
 *
 * Geprueft wird, dass NUR die Route POST /api/alerts/webhook und NUR mit dem
 * dedizierten ALERT_WEBHOOK_TOKEN durchgelassen wird - ohne Token bleibt alles
 * fail-closed ueber die Studio-Auth.
 */
let server: Server;
let baseUrl = '';

const STUDIO = 'studio-token-fuer-alert-test';
const ALERT_TOKEN = 'alert-webhook-token-1234567890';

beforeAll(async () => {
  process.env.VITEST = 'true';
  process.env.STUDIO_ACCESS_TOKEN = STUDIO;
  process.env.ALERT_WEBHOOK_TOKEN = ALERT_TOKEN;
  const mod = await import('../server');
  server = mod.app.listen(0);
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('kein Port');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.ALERT_WEBHOOK_TOKEN;
});

const alertBody = JSON.stringify({ alerts: [{ status: 'firing', labels: { alertname: 'TestAlarm', severity: 'critical' } }] });

const post = (headers: Record<string, string>) =>
  fetch(`${baseUrl}/api/alerts/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: alertBody });

describe('PROD-P1-004 · Alertmanager-Zustellung an /api/alerts/webhook', () => {
  it('ohne Token: 401 (fail-closed)', async () => {
    const res = await post({});
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('STUDIO_TOKEN_REQUIRED');
  });

  it('mit falschem Token: 401', async () => {
    expect((await post({ 'x-alert-token': 'falsch-falsch-falsch' })).status).toBe(401);
  });

  it('mit ALERT_WEBHOOK_TOKEN als Header: durchgelassen', async () => {
    const res = await post({ 'x-alert-token': ALERT_TOKEN });
    expect(res.status).toBe(202);
  });

  it('mit ALERT_WEBHOOK_TOKEN als Bearer (Alertmanager-http_config): durchgelassen', async () => {
    const res = await post({ authorization: `Bearer ${ALERT_TOKEN}` });
    expect(res.status).toBe(202);
  });

  it('das Token gilt NUR fuer diese Route - andere POSTs bleiben geschuetzt', async () => {
    const res = await fetch(`${baseUrl}/api/audit`, { method: 'POST', headers: { 'x-alert-token': ALERT_TOKEN } });
    expect(res.status).toBe(401);
  });
});
