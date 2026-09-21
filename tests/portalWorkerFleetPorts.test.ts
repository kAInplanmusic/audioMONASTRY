/**
 * Vertragstest Portal-Wake <-> firewall-ensure.py (INFRA-HETZNER-014).
 * =====================================================================
 * ZWEI SCHREIBER, DIESELBEN REGELN: der Portal-Wake setzt die Cross-Node-Regeln
 * selbst (`syncAppFirewall` + `openFleetPorts`, aufgerufen in /api/wake und
 * /api/wire-fleet), und `scripts/hetzner/firewall-ensure.py` gleicht dieselben
 * vier Ports im Flottenstart ab (Schritt 3/9). Dieser Test faehrt den ECHTEN
 * Worker-Codepfad (`POST /api/wire-fleet`) gegen eine Fake-Hetzner-API mit
 * echtem Zustand ("Fake-API": merkt sich Regeln, quittiert set_rules) und pinnt:
 *
 *   1. Der Wake setzt genau die Vertrags-Ports (geparst aus firewall-ensure.py)
 *      auf die IP des zustaendigen Knotens - beide Quellen bleiben deckungsgleich.
 *   2. Fremde Regeln (ICMP, SSH, Cloudflare-Bereiche auf 80/443) bleiben
 *      zeichengleich - der Wake ist NICHT destruktiv gegenueber Dritt-Regeln.
 *   3. Ein zweiter Lauf erzeugt DENSELBEN Regelzustand (ergebnis-idempotent).
 *   4. VERTRAG (Betreiberentscheid 2026-09-22, SSOT PROD-P2-PORTAL-DRIFT): eine
 *      fuer 0.0.0.0/0 (bzw. ::/0) offene Vertrags-Regel wird NICHT mehr auf die
 *      Knoten-IP verengt und ihre `description` nicht mehr verworfen - der Wake
 *      MERGT die app-1-IP in die vorhandene Quellliste (bei einer offenen Regel
 *      passiert nichts), genau wie firewall-ensure.py.
 *   5. FAIL-CLOSED (Betreiberentscheid 2026-09-22, SSOT PROD-P0-PORTAL-FAILOPEN):
 *      ist die Cloudflare-IP-Liste nicht abrufbar, wird die 80/443-Regel
 *      WEGGELASSEN - der Origin bleibt zu, der Grund wird laut gemeldet
 *      (`appFirewall.ok=false` + `message`/Log). Ein Rueckfall auf 0.0.0.0/0 als
 *      Ausfallverhalten gibt es nicht mehr. Vorher setzte genau dieser Pfad den
 *      Origin bei jedem Cloudflare-Ausfall weltweit offen, obwohl der Kommentar
 *      "App-Firewall bleibt zu (sicherer Ausfall)" behauptete.
 *   6. Punkt c des Entscheids: KEIN Schreibaufruf, wenn der Zielzustand schon
 *      erreicht ist. Vorher schrieb der Wake bei jedem Lauf dieselben Regeln neu
 *      (der zweite Lauf erzeugte drei weitere set_rules-Aufrufe).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const REPO = path.resolve(__dirname, '..');
const FIREWALL_ENSURE = path.join(REPO, 'scripts', 'hetzner', 'firewall-ensure.py');

/** Knoten-IPs des Testszenarios (RFC 5737, identisch mit test_hetzner_scripts.py). */
const IPS: Record<string, string> = {
  app: '203.0.113.5',
  sfu: '203.0.113.6',
  ai: '203.0.113.7',
  master: '203.0.113.8',
  edge: '198.51.100.7',
};
const CF_RANGE = '172.64.0.0/13';
/** app-1-IP der VORHERIGEN Flotte (Befund INFRA-HETZNER-014, identisch mit tests/test_hetzner_scripts.py). */
const ALTE_APP_IP = '142.132.229.71';

interface Rule {
  direction: string;
  protocol: string;
  port?: string;
  source_ips: string[];
  description?: string;
}
interface Firewall {
  id: number;
  name: string;
  rules: Rule[];
}

function appFirewallRules(edgeIp = IPS.edge): Rule[] {
  return [
    { direction: 'in', protocol: 'icmp', source_ips: ['0.0.0.0/0', '::/0'], description: 'ICMP' },
    { direction: 'in', protocol: 'tcp', port: '22', source_ips: ['0.0.0.0/0', '::/0'], description: 'SSH' },
    { direction: 'in', protocol: 'tcp', port: '80', source_ips: [CF_RANGE], description: 'HTTP (Cloudflare)' },
    { direction: 'in', protocol: 'tcp', port: '443', source_ips: [CF_RANGE], description: 'HTTPS (Cloudflare)' },
    { direction: 'in', protocol: 'tcp', port: '8080', source_ips: [`${edgeIp}/32`], description: 'App-Metriken' },
  ];
}
function aiFirewallRules(appIp = IPS.app): Rule[] {
  return [
    { direction: 'in', protocol: 'icmp', source_ips: ['0.0.0.0/0', '::/0'], description: 'ICMP' },
    { direction: 'in', protocol: 'tcp', port: '22', source_ips: ['0.0.0.0/0', '::/0'], description: 'SSH' },
    { direction: 'in', protocol: 'tcp', port: '8000', source_ips: [`${appIp}/32`], description: 'Stem-AI' },
    { direction: 'in', protocol: 'tcp', port: '11434', source_ips: [`${appIp}/32`], description: 'Ollama' },
  ];
}
function masterFirewallRules(appIp = IPS.app): Rule[] {
  return [
    { direction: 'in', protocol: 'icmp', source_ips: ['0.0.0.0/0', '::/0'], description: 'ICMP' },
    { direction: 'in', protocol: 'tcp', port: '8000', source_ips: [`${appIp}/32`], description: 'master-player' },
  ];
}

function fleetFirewalls(): Firewall[] {
  return [
    { id: 4711, name: 'audiomonastry-app', rules: appFirewallRules() },
    { id: 4712, name: 'audiomonastry-ai', rules: aiFirewallRules() },
    { id: 4713, name: 'audiomonastry-master', rules: masterFirewallRules() },
    { id: 4714, name: 'audiomonastry-sfu', rules: [{ direction: 'in', protocol: 'udp', port: '3478', source_ips: ['0.0.0.0/0'] }] },
  ];
}

function fleetServers() {
  return Object.entries(IPS).map(([role, ip], index) => ({
    id: 1000 + index,
    name: `audiomonastry-${role}-1`,
    status: 'running',
    public_net: { ipv4: { ip } },
  }));
}

/** Fake-Hetzner-API mit echtem Zustand + Fake-Cloudflare (netzfrei). */
function setupFetchMock(opts: { firewalls: Firewall[]; cfIpsMissing?: boolean }) {
  const writes: { path: string; rules: Rule[] }[] = [];
  const fetchMock = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';

    if (url.hostname === 'api.cloudflare.com') {
      if (url.pathname === '/client/v4/ips') {
        // cfIpsMissing = die Liste kommt leer zurueck (Token/Netzproblem).
        return Response.json(opts.cfIpsMissing ? { success: false, result: {} } : { result: { ipv4_cidrs: [CF_RANGE], ipv6_cidrs: [] } });
      }
      if (url.pathname === '/client/v4/zones') {
        return Response.json({ success: true, result: [{ id: 'zone-1', name: 'anunnakitools.de' }] });
      }
      if (/^\/client\/v4\/zones\/[^/]+\/dns_records/.test(url.pathname)) {
        if (method === 'PATCH' || method === 'POST') return Response.json({ success: true, result: { id: 'rec-1' } });
        return Response.json({ success: true, result: [{ id: 'rec-1', type: 'A', name: 'origin.anunnakitools.de', content: '9.9.9.9' }] });
      }
      return Response.json({ success: true, result: {} });
    }

    if (url.pathname === '/v1/servers' && method === 'GET') {
      return Response.json({ servers: fleetServers() });
    }
    if (url.pathname === '/v1/firewalls' && method === 'GET') {
      // Der Wake fragt per ?name=... ODER mit per_page=100 - beides beantworten.
      const name = url.searchParams.get('name');
      const list = name ? opts.firewalls.filter((fw) => fw.name === name) : opts.firewalls;
      return Response.json({ firewalls: list });
    }
    const write = /^\/v1\/firewalls\/(\d+)\/actions\/set_rules$/.exec(url.pathname);
    if (write && method === 'POST') {
      const payload = JSON.parse(String(init.body ?? '{}')) as { rules?: Rule[] };
      const fw = opts.firewalls.find((entry) => String(entry.id) === write[1]);
      if (!fw) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
      writes.push({ path: url.pathname, rules: JSON.parse(JSON.stringify(payload.rules ?? [])) });
      fw.rules = payload.rules ?? []; // echter Zustand: die API merkt sich den Schreibvorgang
      return Response.json({ actions: [{ id: 1, status: 'success' }] });
    }
    return Response.json({});
  });

  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, writes };
}

function createEnv(): Record<string, unknown> {
  return {
    ADMIN_USER: 'admin',
    ADMIN_PASSWORD: 'geheim',
    SESSION_SECRET: 'session-secret',
    HCLOUD_TOKEN: 'hcloud-token',
    STUDIO_ACCESS_TOKEN: 'studio-token',
    CLOUDFLARE_API_TOKEN: 'cf-token',
    APP_DOMAIN: 'anunnakitools.de',
    SFU_SIGNALING_URL: 'https://sfu.anunnakitools.de',
    TURN_URLS: `turn:${IPS.sfu}:3478?transport=udp`,
    TURN_STATIC_AUTH_SECRET: 'turn-secret',
  };
}

async function makeSessionCookie(secret: string, user = 'admin'): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const payload = `${user}.${exp}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const hex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `portal=${encodeURIComponent(`${payload}.${hex}`)}`;
}

/** Frischer Modul-Load je Test: der Cloudflare-IP-Cache des Workers ist modulweit. */
async function loadWorker() {
  vi.resetModules();
  const mod = await import('../services/portal-worker/src/index.js');
  return mod.default as { fetch: (request: Request, env: Record<string, unknown>) => Promise<Response> };
}

async function wireFleet(worker: { fetch: (r: Request, e: Record<string, unknown>) => Promise<Response> }, env: Record<string, unknown>) {
  const cookie = await makeSessionCookie(String(env.SESSION_SECRET));
  const response = await worker.fetch(
    new Request('https://portal.anunnakitools.de/api/wire-fleet', { method: 'POST', headers: { cookie } }),
    env,
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

/** Soll-Vertrag, unabhaengig aus dem Python-Werkzeug gelesen (eine Quelle). */
function contractFromPython(): { firewall: string; port: string; role: string }[] {
  const text = readFileSync(FIREWALL_ENSURE, 'utf8');
  // Der Block endet mit einer schliessenden Klammer in Spalte 0; innere Klammern
  // (die Tupel) duerfen nicht als Ende gelten.
  const block = /CONTRACT = \(([\s\S]*?)\n\)/.exec(text)?.[1] ?? '';
  return [...block.matchAll(/\("([a-z]+)",\s*"(\d+)",\s*"([a-z]+)"\)/g)].map((m) => ({
    firewall: `audiomonastry-${m[1]}`,
    port: m[2],
    role: m[3],
  }));
}

function ruleOf(firewalls: Firewall[], name: string, port: string): Rule {
  const rule = firewalls.find((fw) => fw.name === name)?.rules.find((entry) => String(entry.port ?? '') === port);
  if (!rule) throw new Error(`keine Regel tcp/${port} auf ${name}`);
  return rule;
}

describe('Portal-Wake <-> firewall-ensure (Cross-Node-Firewall-Regeln)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('setzt genau die Vertrags-Ports aus firewall-ensure.py auf die Knoten-IP', async () => {
    const firewalls = fleetFirewalls();
    setupFetchMock({ firewalls });
    const worker = await loadWorker();
    const { status, body } = await wireFleet(worker, createEnv());

    expect(status).toBe(200);
    const contract = contractFromPython();
    // Vier Vertrags-Zeilen - sonst prueft der Test etwas anderes als der Betrieb.
    expect(contract.map((entry) => `${entry.firewall}/tcp/${entry.port}`)).toEqual([
      'audiomonastry-app/tcp/8080',
      'audiomonastry-ai/tcp/8000',
      'audiomonastry-ai/tcp/11434',
      'audiomonastry-master/tcp/8000',
    ]);
    for (const entry of contract) {
      const rule = ruleOf(firewalls, entry.firewall, entry.port);
      expect(rule.source_ips, `${entry.firewall} tcp/${entry.port}`).toEqual([`${IPS[entry.role]}/32`]);
    }
    // Der Wake meldet die Zuordnung zurueck (Betreiber-Sicht im Ladebildschirm).
    expect(body.ports.appIp).toBe(IPS.app);
    expect(body.ports.detail['audiomonastry-ai'].rules).toContain(`in/tcp/11434→${IPS.app}/32`);
    expect(body.appFirewall.ok).toBe(true);
  });

  it('laesst fremde Regeln zeichengleich (nicht destruktiv gegenueber Dritt-Regeln)', async () => {
    const firewalls = fleetFirewalls();
    setupFetchMock({ firewalls });
    const worker = await loadWorker();
    await wireFleet(worker, createEnv());

    // ICMP/SSH bleiben offen, 80/443 tragen weiter NUR die Cloudflare-Bereiche,
    // die sfu-Firewall wird von diesem Pfad gar nicht angefasst.
    const app = firewalls.find((fw) => fw.name === 'audiomonastry-app') as Firewall;
    expect(app.rules.find((r) => r.protocol === 'icmp')?.source_ips).toEqual(['0.0.0.0/0', '::/0']);
    expect(ruleOf(firewalls, 'audiomonastry-app', '80').source_ips).toEqual([CF_RANGE]);
    expect(ruleOf(firewalls, 'audiomonastry-app', '443').source_ips).toEqual([CF_RANGE]);
    expect(firewalls.find((fw) => fw.name === 'audiomonastry-sfu')?.rules).toEqual([
      { direction: 'in', protocol: 'udp', port: '3478', source_ips: ['0.0.0.0/0'] },
    ]);
  });

  it('ist ergebnis-idempotent UND schreibt im zweiten Lauf nichts (Entscheid Punkt c)', async () => {
    const firewalls = fleetFirewalls();
    // Ausgangszustand = Zustand einer FRUEHEREN Flotte (die alte app-1-IP aus dem
    // Befund, identisch mit tests/test_hetzner_scripts.py). So hat der erste Lauf
    // echte Aenderungen und der zweite keine mehr.
    firewalls[1].rules[2].source_ips = [`${ALTE_APP_IP}/32`];
    firewalls[1].rules[3].source_ips = [`${ALTE_APP_IP}/32`];
    firewalls[2].rules[1].source_ips = [`${ALTE_APP_IP}/32`];
    const { writes } = setupFetchMock({ firewalls });
    const worker = await loadWorker();
    const env = createEnv();

    const erster = await wireFleet(worker, env);
    const nachErstem = JSON.parse(JSON.stringify(firewalls));
    const writesErsterLauf = writes.length;
    const zweiter = await wireFleet(worker, env);

    expect(firewalls).toEqual(nachErstem);
    // Erster Lauf: ai (8000+11434) und master (8000) - die app-Firewall ist
    // bereits korrekt (Cloudflare-Bereiche + 8080 von edge-1).
    expect(writesErsterLauf).toBe(2);
    // Zweiter Lauf: Zielzustand erreicht -> KEIN Schreibaufruf (Punkt c).
    expect(writes.length).toBe(2);
    expect(zweiter.body.ports.updated).toEqual({});
    expect(zweiter.body.ports.unchanged).toEqual({
      'audiomonastry-ai': 'unchanged',
      'audiomonastry-master': 'unchanged',
    });
    expect(zweiter.body.ports.ok).toBe(true);
    expect(erster.body.ports.ok).toBe(true);
  });

  it('verengt eine offene Regel NICHT mehr und behaelt die description (Vertrag)', async () => {
    // Betreiberentscheid 2026-09-22 (SSOT PROD-P2-PORTAL-DRIFT): die Politik von
    // firewall-ensure.py ist der Vertrag. Eine fuer ALLE offene Regel bleibt
    // unangetastet - vorher verengte der Wake sie auf die app-1-IP/32 und warf
    // die `description` weg. Der Vorgang wird gemeldet (Punkt c).
    const firewalls = fleetFirewalls();
    firewalls[1].rules[2] = {
      direction: 'in', protocol: 'tcp', port: '8000',
      source_ips: ['0.0.0.0/0', '::/0'], description: 'bewusst fuer alle offen',
    };
    const { writes } = setupFetchMock({ firewalls });
    const worker = await loadWorker();
    const { body } = await wireFleet(worker, createEnv());

    const rule = ruleOf(firewalls, 'audiomonastry-ai', '8000');
    expect(rule.source_ips).toEqual(['0.0.0.0/0', '::/0']);   // NICHT verengt
    expect(rule.description).toBe('bewusst fuer alle offen');  // NICHT verloren
    // Der Zustand ist erreicht: kein Schreibaufruf, aber eine laute Meldung.
    expect(writes.length).toBe(0);
    expect(JSON.stringify(body.ports.notes)).toContain('fuer ALLE offen');
  });

  it('MERGT die Knoten-IP in eine vorhandene Quellliste (statt sie zu ersetzen)', async () => {
    // Alt-Fall: die Regel trug noch die IP der VORHERIGEN Flotte. Der Wake
    // ergaenzt die aktuelle app-1-IP und laesst die alten Quellen stehen - er
    // ersetzt nicht und verwirft die `description` nicht.
    const firewalls = fleetFirewalls();
    firewalls[1].rules[2].source_ips = [`${ALTE_APP_IP}/32`];
    firewalls[2].rules[1].source_ips = [`${ALTE_APP_IP}/32`];
    setupFetchMock({ firewalls });
    const worker = await loadWorker();
    await wireFleet(worker, createEnv());

    const ai = ruleOf(firewalls, 'audiomonastry-ai', '8000');
    expect(ai.source_ips).toEqual([`${ALTE_APP_IP}/32`, `${IPS.app}/32`]);
    expect(ai.description).toBe('Stem-AI');                    // erhalten
    expect(ruleOf(firewalls, 'audiomonastry-master', '8000').source_ips)
      .toEqual([`${ALTE_APP_IP}/32`, `${IPS.app}/32`]);
  });

  it('fail-closed: ohne Cloudflare-IP-Liste wird 80/443 WEGGELASSEN und laut gemeldet', async () => {
    // Betreiberentscheid 2026-09-22 (SSOT PROD-P0-PORTAL-FAILOPEN): faellt die
    // Cloudflare-IP-Liste aus, bleibt die App ZU. Vorher fiel firewallRules('app', [])
    // auf 0.0.0.0/0 + ::/0 zurueck - der Origin stand weltweit offen, waehrend
    // der Kommentar "App-Firewall bleibt zu (sicherer Ausfall)" behauptete.
    const firewalls = fleetFirewalls();
    const { writes } = setupFetchMock({ firewalls, cfIpsMissing: true });
    const worker = await loadWorker();
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    let body: Record<string, any>;
    try {
      ({ body } = await wireFleet(worker, createEnv()));
    } finally {
      spy.mockRestore();
    }

    const app = firewalls.find((fw) => fw.name === 'audiomonastry-app') as Firewall;
    expect(app.rules.some((rule) => String(rule.port ?? '') === '80')).toBe(false);
    expect(app.rules.some((rule) => String(rule.port ?? '') === '443')).toBe(false);
    // Alles andere bleibt - inklusive der Beschreibungen (kein Neuaufbau der Liste).
    expect(app.rules.map((rule) => String(rule.port ?? rule.protocol))).toEqual(['icmp', '22', '8080']);
    expect(app.rules.map((rule) => rule.description)).toEqual(['ICMP', 'SSH', 'App-Metriken']);
    // Laut gemeldet: Worker-Log, appFirewall-Grund und Verdrahtungs-Zusammenfassung.
    expect(logs.join('\n')).toContain('FAIL-CLOSED');
    expect(body.appFirewall.ok).toBe(false);
    expect(body.appFirewall.failClosed).toBe(true);
    expect(String(body.appFirewall.message)).toContain('Cloudflare-IP-Liste');
    // /api/wire-fleet liefert die Zusammenfassung auf oberster Ebene (ok/message).
    expect(body.ok).toBe(false);
    expect(String(body.message)).toContain('app-Firewall');
    // Der Metrik-Pfad ist davon unberuehrt (eigener Port, eigene Quelle).
    expect(ruleOf(firewalls, 'audiomonastry-app', '8080').source_ips).toEqual([`${IPS.edge}/32`]);
    // Geschrieben wird nur die app-Firewall (80/443 entfernt), nichts sonst.
    expect(writes.length).toBe(1);
  });

  it('fail-closed: ist 80/443 schon weg, entsteht kein Schreibaufruf (Punkt c)', async () => {
    const firewalls = fleetFirewalls();
    firewalls[0].rules = firewalls[0].rules.filter((rule) => !['80', '443'].includes(String(rule.port ?? '')));
    const { writes } = setupFetchMock({ firewalls, cfIpsMissing: true });
    const worker = await loadWorker();
    const { body } = await wireFleet(worker, createEnv());

    expect(writes.length).toBe(0);
    expect(body.appFirewall.unchanged).toBe(true);
    // Die Verdrahtung ist trotzdem NICHT vollstaendig - der Grund bleibt laut.
    expect(body.appFirewall.ok).toBe(false);
    expect(body.ok).toBe(false);
  });

  it('der Metrik-Port 8080 kommt nur von edge-1 (kein Fremdzugriff auf die App)', async () => {
    const firewalls = fleetFirewalls();
    setupFetchMock({ firewalls });
    const worker = await loadWorker();
    await wireFleet(worker, createEnv());

    expect(ruleOf(firewalls, 'audiomonastry-app', '8080').source_ips).toEqual([`${IPS.edge}/32`]);
  });
});
