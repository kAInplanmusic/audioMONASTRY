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
 *   4. BEFUND (Betreiberentscheidung offen, bewusst NICHT umgebaut): der Wake
 *      VERENGT eine fuer 0.0.0.0/0 offene Vertrags-Regel auf die Knoten-IP und
 *      verliert dabei deren `description`; firewall-ensure laesst eine offene
 *      Regel bewusst stehen ("Bedeutungsaenderung, kein IP-Wechsel").
 *   5. BEFUND (Sicherheit, Betreiberentscheidung offen): ist die
 *      Cloudflare-IP-Liste nicht abrufbar, faellt `firewallRules('app')` auf
 *      `0.0.0.0/0` zurueck - der Kommentar an `cloudflareIpRanges()` behauptet
 *      dagegen "App-Firewall bleibt zu". Der Test pinnt das TATSAECHLICHE
 *      Verhalten, damit die Abweichung nicht unbemerkt verschwindet.
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

  it('ist ergebnis-idempotent: der zweite Lauf erzeugt denselben Regelzustand', async () => {
    const firewalls = fleetFirewalls();
    const { writes } = setupFetchMock({ firewalls });
    const worker = await loadWorker();
    const env = createEnv();

    await wireFleet(worker, env);
    const nachErstem = JSON.parse(JSON.stringify(firewalls));
    const writesErsterLauf = writes.length;
    await wireFleet(worker, env);

    expect(firewalls).toEqual(nachErstem);
    // DOKUMENTIERTE ABWEICHUNG zu firewall-ensure.py: der Wake schreibt auch beim
    // zweiten Lauf erneut (kein Diff, keine Gegenprobe) - "zweiter Lauf = kein
    // Schreibzugriff" gilt fuer firewall-ensure, NICHT fuer den Portal-Wake.
    expect(writesErsterLauf).toBe(3); // app + ai + master
    expect(writes.length).toBe(6);
  });

  it('BEFUND: verengt eine offene Regel (0.0.0.0/0) auf die app-1-IP und verliert die description', async () => {
    // firewall-ensure.py laesst eine offene Regel bewusst stehen (Test
    // `test_offene_regel_wird_nicht_eingeschraenkt`). Der Wake tut das Gegenteil:
    // er filtert den Port heraus und baut ihn mit genau einer Quelle neu.
    const firewalls = fleetFirewalls();
    firewalls[1].rules[2] = {
      direction: 'in', protocol: 'tcp', port: '8000',
      source_ips: ['0.0.0.0/0', '::/0'], description: 'bewusst fuer alle offen',
    };
    setupFetchMock({ firewalls });
    const worker = await loadWorker();
    await wireFleet(worker, createEnv());

    const rule = ruleOf(firewalls, 'audiomonastry-ai', '8000');
    expect(rule.source_ips).toEqual([`${IPS.app}/32`]);        // verengt
    expect(rule.description).toBeUndefined();                  // Beschreibung verloren
  });

  it('BEFUND: faellt ohne Cloudflare-IP-Liste auf 0.0.0.0/0 fuer 80/443 zurueck', async () => {
    // cloudflareIpRanges() faengt den Fehler ab und laesst den Cache leer; der
    // Kommentar dort sagt "App-Firewall bleibt zu (sicherer Ausfall)", tatsaechlich
    // oeffnet firewallRules('app', []) HTTP/HTTPS fuer das ganze Internet.
    const firewalls = fleetFirewalls();
    setupFetchMock({ firewalls, cfIpsMissing: true });
    const worker = await loadWorker();
    await wireFleet(worker, createEnv());

    expect(ruleOf(firewalls, 'audiomonastry-app', '80').source_ips).toEqual(['0.0.0.0/0', '::/0']);
    expect(ruleOf(firewalls, 'audiomonastry-app', '443').source_ips).toEqual(['0.0.0.0/0', '::/0']);
  });

  it('der Metrik-Port 8080 kommt nur von edge-1 (kein Fremdzugriff auf die App)', async () => {
    const firewalls = fleetFirewalls();
    setupFetchMock({ firewalls });
    const worker = await loadWorker();
    await wireFleet(worker, createEnv());

    expect(ruleOf(firewalls, 'audiomonastry-app', '8080').source_ips).toEqual([`${IPS.edge}/32`]);
  });
});
