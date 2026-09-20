// ============================================================================
// audioMONASTRY Portal Worker – Login/Wake/Ladebildschirm/Proxy/Auto-Delete
// ============================================================================
// Laufzeit: Cloudflare Workers (kostenlos). Kein Server, 0 € Fixkosten.
// Verhalten:
//   GET  /              -> Flotte AN: Proxy auf app-1 · Flotte AUS: Login-Seite
//   GET  /portal        -> Portal-Seite (Login oder Ladebildschirm/Status)
//   POST /api/login     -> Admin-Login, setzt signiertes Session-Cookie
//   POST /api/wake      -> erstellt die 5 Hetzner-Server (cloud-init bootstrappt)
//   GET  /api/status    -> Flotten-Status (für Ladebildschirm-Polling)
//   POST /api/stop      -> zieht je Knoten einen Snapshot und löscht DANN die
//                          Flotte (Kosten stoppen); ohne bestätigten Snapshot
//                          bleibt der Knoten stehen (INFRA-HETZNER-008)
//   Cron */5 * * * *    -> löscht die Flotte, sobald app-1 nach 20 min Idle
//                          (Idle-Auto-Shutdown) ausgeschaltet wurde.
// ============================================================================

const HETZNER = 'https://api.hetzner.cloud/v1';

// NOMEN-P1-001: Die Flotte heisst `audiomonastry-*`. Laufende Installationen
// koennen noch die alten Knoten-/Firewall-/Snapshot-Namen tragen, deshalb
// akzeptiert der Worker BEIDE Schreibweisen (Altname nur fuer Bestandsressourcen,
// angelegt wird immer mit dem neuen Namen). Der Altpraefix steht genau hier.
//
// INFRA-HETZNER-007: `type` ist der FALLBACK der Rolle. Der produktive Pfad liest
// dieselben Overrides wie die CLI (FLEET_TYPE_APP/SFU/AI/MASTER/EDGE, siehe
// fleetServerType) - vorher waren die Env-Vorgaben im Portalbetrieb wirkungslos,
// weil nur provision-fleet.sh sie las. Die Fallbacks selbst sind eine
// Betreiber-Entscheidung: der Snapshot-Bestand vom 2026-09-18 zeigt fuer
// app/sfu/ai 80-GB-Disks (cx33) und fuer master/edge 40 GB (cx23).
const FLEET = [
  { name: 'audiomonastry-app-1',    type: 'cx33', role: 'app' },
  { name: 'audiomonastry-sfu-1',    type: 'cx33', role: 'sfu' },
  { name: 'audiomonastry-ai-1',     type: 'cx33', role: 'ai' },
  { name: 'audiomonastry-master-1', type: 'cx23', role: 'master' },
  { name: 'audiomonastry-edge-1',   type: 'cx23', role: 'edge' },
];

// INFRA-HETZNER-006: edge-1 startet NUR den Monitoring-Stack - die explizite
// Service-Liste ist Pflicht. Ohne Liste zieht die Basisdatei zusaetzlich `caddy`
// (128M) + `audiomonastry` (2G) + `master-player` (1G) mit: 4672 MiB deklarierte
// Speicher-Limits auf einem cx23 mit 4096 MiB RAM, plus ein zweiter Caddy fuer
// dieselbe Domain. Die Liste entspricht exakt docker-compose.monitoring.yml
// (1472 MiB) und muss mit scripts/hetzner/bring-up-fleet.sh (MONITORING_SERVICES)
// deckungsgleich bleiben - tests/test_hetzner_scripts.py prueft das.
const MONITORING_SERVICES = ['node-exporter', 'cadvisor', 'prometheus', 'alertmanager', 'grafana'];
// Achtung (Ehrlichkeitsgrenze): dieser Pfad greift nur beim Kaltstart mit
// user_data. Wird edge-1 aus einem ALTEN Rollen-Snapshot gebootet, zieht Docker
// dort per `restart: unless-stopped` die damals gestarteten Container wieder
// hoch (caddy/audiomonastry/master-player) - der Wake-Pfad fuehrt dann kein
// Compose aus. Einmalige Bereinigung auf dem Knoten:
//   docker compose -f docker-compose.hetzner.yml -f docker-compose.monitoring.yml \
//     stop caddy audiomonastry master-player
// und danach ein frisches edge-Snapshot ziehen (bring-up-fleet.sh macht den
// Stop fuer den CLI-Pfad automatisch).

/** Formpruefung fuer Hetzner-Servertypen (z. B. `cx23`, `cax31`). */
const SERVER_TYPE_PATTERN = /^[a-z]{2,4}[0-9]{1,3}$/;

/**
 * Servertyp einer Rolle (INFRA-HETZNER-007).
 *
 * Die Variable heisst wie in der CLI `FLEET_TYPE_<ROLLE>` (Grossschreibung),
 * z. B. `FLEET_TYPE_APP=cx43` fuer app-1. Damit sind die Overrides der
 * Konstitution (docs/INFRA_KONSTITUTION.md §1.2) im Portalbetrieb wirksam und
 * nicht mehr nur im CLI-Pfad. Ein leerer oder formal ungueltiger Wert wird
 * gemeldet und faellt auf den Rollen-Fallback zurueck (keine stillen Typen).
 *
 * Der Export ist die einzige Named-Export-Ausnahme der Datei: er macht die
 * Aufloesung ohne Cloudflare-Laufzeit pruefbar (node -e 'import(...)').
 */
export function fleetServerType(env, role) {
  const fallback = FLEET.find((f) => f.role === role)?.type ?? '';
  const key = `FLEET_TYPE_${String(role).toUpperCase()}`;
  const override = String(env?.[key] ?? '').trim().toLowerCase();
  if (!override) return fallback;
  if (!SERVER_TYPE_PATTERN.test(override)) {
    console.warn(`[portal] ${key}="${override}" ist kein Hetzner-Servertyp - nutze ${fallback}`);
    return fallback;
  }
  return override;
}

const NAME_PREFIX = 'audiomonastry-';
/** Altpraefix aus der Zeit vor der Umbenennung (nur lesend/Bestand). */
const LEGACY_NAME_PREFIX = 'samplemonk-';

/** Kanonischer Flotten-Name zu einem (moeglicherweise alten) Servernamen. */
function canonicalFleetName(name) {
  const raw = String(name ?? '');
  if (FLEET.some((f) => f.name === raw)) return raw;
  if (!raw.startsWith(LEGACY_NAME_PREFIX)) return '';
  const candidate = `${NAME_PREFIX}${raw.slice(LEGACY_NAME_PREFIX.length)}`;
  return FLEET.some((f) => f.name === candidate) ? candidate : '';
}

const LOCATION = 'fsn1';
const IMAGE = 'ubuntu-24.04';
// OPS-Snapshot: Basis-Image-Name, von dem die Rollen-Snapshots abgeleitet werden.
// Snapshots kosten ~0,01 €/GB/Monat (Cent-Beträge) und beschleunigen den
// Flotten-Start deutlich (kein Docker-Build/cloud-init-Bootstrap je Knoten).
const SNAPSHOT_PREFIX = 'audiomonastry-snapshot-';
/**
 * Altbestand: Snapshots, die vor der Umbenennung entstanden sind. Sie werden
 * weiter gefunden (schneller Flotten-Start) und weiter aufgeraeumt (Retention) -
 * sonst blieben sie unbemerkt liegen und kosten Speicher.
 */
const LEGACY_SNAPSHOT_PREFIXES = ['samplemonk-snapshot-'];
const ALL_SNAPSHOT_PREFIXES = [SNAPSHOT_PREFIX, ...LEGACY_SNAPSHOT_PREFIXES];
const SNAPSHOT_RETENTION = 2; // je Rolle die letzten 2 Snapshots behalten
const PORTAL_DOMAIN = 'anunnakitools.de';
const ORIGIN_HOST = 'origin.anunnakitools.de';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

async function hz(env, method, path, payload) {
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${env.HCLOUD_TOKEN}`,
      'Content-Type': 'application/json',
    },
  };
  if (payload) init.body = JSON.stringify(payload);
  const res = await fetch(HETZNER + path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status < 500) {
    data.__http = res.status;
  }
  return data;
}

const hzGet = (env, path) => hz(env, 'GET', path);
const hzPost = (env, path, payload) => hz(env, 'POST', path, payload);
const hzDelete = (env, path) => hz(env, 'DELETE', path);

async function fleetServers(env) {
  const data = await hzGet(env, '/servers?per_page=50');
  const map = {};
  for (const s of data.servers ?? []) {
    // Schluessel ist der kanonische Name; Altinstallationen liefern ihre alten
    // Servernamen und werden darauf abgebildet (sonst waere die Flotte fuer den
    // Portal-Worker unsichtbar, obwohl sie laeuft).
    const key = canonicalFleetName(s.name);
    if (key) map[key] = s;
  }
  return map;
}

// ---------------------------------------------------------------------------
// OPS-Snapshot: Rollen-Snapshots für schnellen Flotten-Start
// ---------------------------------------------------------------------------
function hasFleetSnapshotPrefix(img) {
  return ALL_SNAPSHOT_PREFIXES.some(
    (prefix) =>
      String(img?.name ?? '').startsWith(prefix) ||
      String(img?.description ?? '').startsWith(prefix),
  );
}

function isFleetSnapshot(img) {
  return img?.labels?.app === 'audioMONASTRY' || hasFleetSnapshotPrefix(img);
}

function snapshotRoleOf(img) {
  const fromLabel = img?.labels?.role;
  if (fromLabel) return fromLabel;
  // LIVE-BEFUND 2026-09-18: Die Portal-Snapshots tragen KEIN Label und KEINEN
  // Namen - nur die Beschreibung ("samplemonk-snapshot-app-2026-09-18[-live]").
  // Mit der reinen Label-Abfrage fand `findSnapshot()` nie etwas, jeder Wake
  // lief deshalb als Kaltstart mit cloud-init + Build (gemessen: statt
  // Snapshot-Start; `usedSnapshots: {}`). Die Rolle wird daher aus Name/
  // Beschreibung abgeleitet, wenn das Label fehlt.
  const text = `${img?.name ?? ''} ${img?.description ?? ''}`;
  for (const prefix of ALL_SNAPSHOT_PREFIXES) {
    const match = text.match(new RegExp(`${prefix}(app|sfu|ai|master|edge)(?![a-z])`));
    if (match) return match[1];
  }
  return null;
}

async function listSnapshots(env) {
  const data = await hzGet(env, '/images?type=snapshot&per_page=100&sort=created:desc');
  return (data.images ?? []).filter(isFleetSnapshot);
}

/** Neuesten verfügbaren Snapshot einer Rolle finden (oder null). */
function findSnapshot(images, role) {
  const candidates = images.filter((img) => img.status === 'available' && snapshotRoleOf(img) === role);
  const matches = (img, prefix) =>
    String(img.name ?? '').startsWith(`${prefix}${role}`) ||
    String(img.description ?? '').startsWith(`${prefix}${role}`);
  // Reihenfolge = ALL_SNAPSHOT_PREFIXES: der neue Name gewinnt, der Altbestand
  // bleibt nutzbar (eine Umbenennung darf den schnellen Start nicht verhindern).
  for (const prefix of ALL_SNAPSHOT_PREFIXES) {
    const hit = candidates.find((img) => matches(img, prefix));
    if (hit) return hit;
  }
  return null;
}

async function createServerSnapshot(env, server, role, meta = {}) {
  const payload = {
    description: `${SNAPSHOT_PREFIX}${role}-${new Date().toISOString().slice(0, 10)}`,
    type: 'snapshot',
    labels: {
      app: 'audioMONASTRY',
      role,
      'snapshot-of': server.name,
      ...(meta.commit ? { commit: String(meta.commit).slice(0, 40) } : {}),
      ...(meta.version ? { version: String(meta.version).slice(0, 40) } : {}),
    },
  };
  const result = await hzPost(env, `/servers/${server.id}/actions/create_image`, payload);
  return {
    server: server.name,
    role,
    description: payload.description,
    commit: meta.commit ?? null,
    version: meta.version ?? null,
    action: result.action?.id ?? null,
    error: result.__http ? `HTTP ${result.__http}` : null,
  };
}

/**
 * Auto-Retention: pro Rolle nur die letzten `keepPerRole` Snapshots behalten.
 * Ältere Snapshots werden gelöscht (Snapshots kosten ~0,01 €/GB/Monat).
 */
async function pruneSnapshots(env, keepPerRole = SNAPSHOT_RETENTION) {
  const images = await listSnapshots(env);
  const byRole = {};
  for (const img of images) {
    const role = snapshotRoleOf(img);
    if (!role) continue;
    (byRole[role] ??= []).push(img);
  }
  const deleted = [];
  for (const [role, list] of Object.entries(byRole)) {
    const sorted = list.sort((a, b) => String(b.created ?? '').localeCompare(String(a.created ?? '')));
    for (const img of sorted.slice(keepPerRole)) {
      const res = await hzDelete(env, `/images/${img.id}`);
      deleted.push({
        image: img.id,
        role,
        description: img.description ?? img.name ?? '',
        ok: !res.__http,
        ...(res.__http ? { http: res.__http } : {}),
      });
    }
  }
  return deleted;
}

async function refreshSnapshots(env, meta = {}) {
  const servers = await fleetServers(env);
  const running = Object.values(servers).filter((s) => s.status === 'running');
  if (running.length === 0) {
    return { ok: false, message: 'Keine laufenden Flotten-Server – Snapshots werden von laufenden Servern erzeugt.' };
  }

  const created = [];
  for (const server of running) {
    const role = server.labels?.role ?? null;
    if (!role) continue;
    created.push(await createServerSnapshot(env, server, role, meta));
  }

  const deleted = await pruneSnapshots(env);
  return {
    ok: created.length > 0,
    created,
    deleted,
    retention: { keepPerRole: SNAPSHOT_RETENTION, hint: 'Letzte 2 Snapshots je Rolle bleiben erhalten.' },
  };
}

async function ensureSshKey(env) {
  const pub = (env.SSH_PUBLIC_KEY ?? '').trim();
  if (!pub) return null;
  const list = await hzGet(env, '/ssh_keys?per_page=100');
  const existing = (list.ssh_keys ?? []).find((k) => k.public_key.trim() === pub);
  if (existing) return existing.id;
  const created = await hzPost(env, '/ssh_keys', { name: 'audioMONASTRY-portal', public_key: pub });
  return created.ssh_key?.id ?? null;
}

// P-7: Cloudflare-IP-Ranges (öffentlicher Endpoint) mit 1h-Cache. Für app-1
// werden 80/443 NUR für Cloudflare geöffnet – der Origin ist dann nicht mehr
// direkt erreichbar und der Hop Cloudflare→Origin läuft nicht mehr offen ins
// Internet (nur Cloudflare-Edge kann den App-Server erreichen).
let cfIpCache = { ips: [], at: 0 };

async function cloudflareIpRanges() {
  if (cfIpCache.ips.length > 0 && Date.now() - cfIpCache.at < 60 * 60 * 1000) {
    return cfIpCache.ips;
  }
  try {
    const res = await fetch('https://api.cloudflare.com/client/v4/ips');
    const data = await res.json();
    const v4 = (data.result?.ipv4_cidrs ?? []).filter((c) => c.includes('.'));
    const v6 = (data.result?.ipv6_cidrs ?? []).filter((c) => c.includes(':'));
    cfIpCache = { ips: [...v4, ...v6], at: Date.now() };
  } catch {
    /* Fallback: Cache leer lassen -> App-Firewall bleibt zu (sicherer Ausfall). */
  }
  return cfIpCache.ips;
}

function firewallRules(role, cloudflareIps = []) {
  const base = [
    { direction: 'in', protocol: 'icmp', source_ips: ['0.0.0.0/0', '::/0'] },
    { direction: 'in', protocol: 'tcp', port: '22', source_ips: ['0.0.0.0/0', '::/0'] },
  ];
  if (role === 'app') {
    // Nur Cloudflare-Edge darf HTTP(S) erreichen (Proxy-Hop abgesichert).
    const cf = cloudflareIps.length > 0 ? cloudflareIps : ['0.0.0.0/0', '::/0'];
    base.push({ direction: 'in', protocol: 'tcp', port: '80', source_ips: cf });
    base.push({ direction: 'in', protocol: 'tcp', port: '443', source_ips: cf });
  } else {
    base.push({ direction: 'in', protocol: 'tcp', port: '80', source_ips: ['0.0.0.0/0', '::/0'] });
    base.push({ direction: 'in', protocol: 'tcp', port: '443', source_ips: ['0.0.0.0/0', '::/0'] });
  }
  if (role === 'sfu') {
    base.push({ direction: 'in', protocol: 'udp', port: '40000-40099', source_ips: ['0.0.0.0/0', '::/0'] });
    base.push({ direction: 'in', protocol: 'tcp', port: '40000-40099', source_ips: ['0.0.0.0/0', '::/0'] });
  }
  return base;
}

async function ensureFirewall(env, name, rules) {
  const list = await hzGet(env, `/firewalls?name=${encodeURIComponent(name)}`);
  if ((list.firewalls ?? []).length > 0) {
    // Firewall existiert bereits → Regeln aktualisieren (Cloudflare-IP-Listen
    // ändern sich; sonst kann Cloudflare den Origin nicht mehr erreichen).
    const fw = list.firewalls[0];
    await hz(env, 'POST', `/firewalls/${fw.id}/actions/set_rules`, { rules });
    return fw.id;
  }
  const created = await hzPost(env, '/firewalls', { name, rules });
  return created.firewall?.id ?? null;
}

// ---------------------------------------------------------------------------
// F1 – Cloudflare-Verdrahtung: jeder Fehlschlag hat einen Klartextgrund
// ---------------------------------------------------------------------------
// BEFUND 2026-09-20 (live gemessen): alle Cloudflare-Credentials in .env.portal
// antworteten mit `9109 Invalid access token`. syncOriginDns() meldete daraufhin
// nur "Cloudflare-Zone nicht gefunden" - der ECHTE Grund (ungueltiger oder zu
// enger Token) war unsichtbar; die Domain lief dauerhaft in HTTP 522, waehrend
// das Portal im Ladebildschirm "startet..." zeigte. Deshalb wird hier jede
// Cloudflare-Antwort in einen Klartextgrund uebersetzt (Fehlercode + Message +
// Betreiberhinweis) und das Ergebnis in /api/wake, /api/wire-fleet UND
// /api/status zurueckgegeben. Der Token selbst wird NIE ausgegeben.
const CF_API = 'https://api.cloudflare.com/client/v4';
/** Codes, die auf ein Token-/Berechtigungsproblem deuten (kein Zonenproblem). */
const CF_AUTH_ERROR_CODES = ['9109', '10000', '6003'];

/** Cloudflare-Fehlerantwort -> Klartextgrund (message + optionaler Hinweis). */
function cloudflareFailure(label, http, data) {
  const errors = Array.isArray(data?.errors) ? data.errors : [];
  const codes = errors.map((e) => String(e?.code ?? '').trim()).filter(Boolean);
  const messages = errors.map((e) => String(e?.message ?? '').trim()).filter(Boolean);
  const detail = [
    codes.length > 0 ? `[${codes.join(', ')}]` : '',
    messages.join('; '),
  ].filter(Boolean).join(' ');
  const authProblem = http === 401 || http === 403 || codes.some((c) => CF_AUTH_ERROR_CODES.includes(c));
  return {
    codes,
    http: http ?? null,
    message: [label, http ? `HTTP ${http}` : '', detail || 'ohne Detail'].filter(Boolean).join(': '),
    ...(authProblem ? {
      hint: `DNS-Verdrahtung fehlt: Token ohne Zone:DNS:Edit (${codes.join(', ') || `HTTP ${http}`}) - Betreiber-Schritte: docs/ORIGIN_TLS_DNS_RUNBOOK.md`,
    } : {}),
  };
}

/**
 * Cloudflare-API-Aufruf (GET/PATCH) mit Klartextfehler.
 * `success === false` zaehlt als Fehler; ein fehlendes `success`-Feld ist bei
 * den von uns gelesenen Endpunkten die Ausnahme und wird als OK gewertet
 * (nur HTTP-Fehler schlagen dann durch). Netz-/Timeoutfehler werden ebenfalls
 * als Klartextgrund zurueckgegeben - kein stilles Scheitern.
 */
async function cloudflareRequest(env, method, path, payload) {
  const token = String(env?.CLOUDFLARE_API_TOKEN ?? '').trim();
  if (!token) {
    return {
      ok: false,
      code: 'token-missing',
      message: `DNS-Verdrahtung fehlt: ${method} ${path} ohne CLOUDFLARE_API_TOKEN im Worker`,
      hint: 'Betreiber-Schritte: docs/ORIGIN_TLS_DNS_RUNBOOK.md',
    };
  }
  const init = { method, headers: { Authorization: `Bearer ${token}` } };
  if (payload) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(payload);
  }
  let res;
  let data = {};
  try {
    res = await fetch(`${CF_API}${path}`, init);
    data = await res.json().catch(() => ({}));
  } catch (err) {
    return {
      ok: false,
      code: 'cloudflare-unreachable',
      message: `Cloudflare-API nicht erreichbar (${method} ${path}): ${String(err?.message ?? err)}`,
    };
  }
  if (!res.ok || data?.success === false) {
    return { ok: false, code: 'cloudflare-error', ...cloudflareFailure(`${method} ${path}`, res.status, data) };
  }
  return { ok: true, http: res.status, data };
}

const cloudflareGet = (env, path) => cloudflareRequest(env, 'GET', path);

/**
 * Synchronisiert den DNS-Record `origin.anunnakitools.de` auf die aktuelle
 * app-1-IP. Die Hetzner-IPs wechseln bei jedem Wake; der Worker-Proxy nutzt
 * ORIGIN_HOST als resolveOverride, daher muss der DNS-Record stimmen.
 *
 * Mit `{ dryRun: true }` wird NICHTS geschrieben, sondern nur der Ist-Zustand
 * gemeldet - so kann /api/status dieselbe Diagnose zeigen, ohne bei jedem
 * Poll einen Schreibzugriff auszuloesen.
 *
 * Ergebnis (immer mit `code` + Klartext-`message`):
 *   ok:false, code: token-missing | no-app-ip | zone-missing | record-missing |
 *                  record-mismatch | cloudflare-error | cloudflare-unreachable
 *   ok:true,  code: ok  (+ changed, record, content)
 */
async function syncOriginDns(env, appIp, options = {}) {
  const dryRun = options.dryRun === true;
  if (!appIp) {
    return { ok: false, code: 'no-app-ip', message: 'origin-DNS nicht gesetzt: app-1 hat noch keine oeffentliche IPv4.' };
  }

  const zone = await cloudflareGet(env, `/zones?name=${PORTAL_DOMAIN}`);
  if (!zone.ok) return { ok: false, ...zone, step: 'zone' };
  const zoneId = zone.data?.result?.[0]?.id;
  if (!zoneId) {
    return {
      ok: false,
      code: 'zone-missing',
      step: 'zone',
      message: `Cloudflare-Zone ${PORTAL_DOMAIN} nicht gefunden (Cloudflare-Antwort ohne Zone)`,
      hint: 'Gehoert der Token zur richtigen Zone? Betreiber-Schritte: docs/ORIGIN_TLS_DNS_RUNBOOK.md',
    };
  }

  const recs = await cloudflareGet(env, `/zones/${zoneId}/dns_records?name=${ORIGIN_HOST}`);
  if (!recs.ok) return { ok: false, ...recs, step: 'record', zoneId };
  const rec = recs.data?.result?.[0];
  if (!rec) {
    return {
      ok: false,
      code: 'record-missing',
      step: 'record',
      zoneId,
      message: `DNS-Record ${ORIGIN_HOST} fehlt in Zone ${PORTAL_DOMAIN}`,
      hint: `A-Record (DNS only) auf die app-1-IPv4 anlegen - Betreiber-Schritte: docs/ORIGIN_TLS_DNS_RUNBOOK.md`,
    };
  }
  const record = { id: rec.id, name: rec.name, type: rec.type, content: rec.content, proxied: rec.proxied === true };

  if (dryRun) {
    const problems = [];
    if (rec.type !== 'A') problems.push(`type=${rec.type} statt A`);
    if (rec.proxied === true) problems.push('proxied=true (Cloudflare-Proxy statt DNS-only)');
    if (rec.content !== appIp) problems.push(`zeigt auf ${rec.content} statt auf app-1 ${appIp}`);
    if (problems.length === 0) {
      return { ok: true, code: 'ok', dryRun, record, message: `origin-DNS ok: ${ORIGIN_HOST} -> ${appIp} (A, DNS-only)` };
    }
    return {
      ok: false,
      code: 'record-mismatch',
      step: 'record',
      dryRun,
      zoneId,
      record,
      message: `origin-DNS falsch verdrahtet: ${ORIGIN_HOST} ${problems.join(', ')}`,
      hint: 'POST /api/wire-fleet korrigiert den Record; Betreiber-Schritte: docs/ORIGIN_TLS_DNS_RUNBOOK.md',
    };
  }

  const needsPatch = rec.content !== appIp || rec.proxied === true;
  if (!needsPatch) {
    return { ok: true, code: 'ok', changed: false, record, content: appIp, message: `origin-DNS ok: ${ORIGIN_HOST} -> ${appIp} (A, DNS-only)` };
  }
  // `proxied: false` wird mitgeschrieben, wenn der Record proxied ist: der
  // Worker proxied selbst per resolveOverride - ein proxied Record loest auf
  // Cloudflare-IPs auf und laeuft in denselben 522-Pfad zurueck (Befund F1).
  const body = { content: appIp, ...(rec.proxied === true ? { proxied: false } : {}) };
  const patched = await cloudflareRequest(env, 'PATCH', `/zones/${zoneId}/dns_records/${rec.id}`, body);
  if (!patched.ok) return { ok: false, ...patched, step: 'patch', zoneId, record };
  return {
    ok: true,
    code: 'ok',
    changed: true,
    recordId: rec.id,
    record: { ...record, content: appIp, proxied: false },
    content: appIp,
    message: `origin-DNS gesetzt: ${ORIGIN_HOST} -> ${appIp} (A, DNS-only)`,
  };
}

// Derselbe Aufruf, aber schreibfrei - mit kurzem Cache, weil der Ladebildschirm
// /api/status alle 4 s pollt und der Cloudflare-GET sonst mitpollen wuerde.
let originDiagnosisCache = { key: '', at: 0, value: null };
const ORIGIN_DIAGNOSIS_TTL_MS = 15000;

async function cachedOriginDiagnosis(env, appIp) {
  const key = String(appIp);
  if (originDiagnosisCache.value && originDiagnosisCache.key === key && Date.now() - originDiagnosisCache.at < ORIGIN_DIAGNOSIS_TTL_MS) {
    return { ...originDiagnosisCache.value, cached: true };
  }
  const value = await syncOriginDns(env, appIp, { dryRun: true });
  originDiagnosisCache = { key, at: Date.now(), value };
  return value;
}

/** Klartext-Zusammenfassung der Verdrahtung (ok + Grund) fuer die API-Antworten. */
function wiringSummary(wiring) {
  const missing = [];
  if (!wiring?.appFirewall?.ok) missing.push(`app-Firewall: ${wiring?.appFirewall?.message ?? 'Zustand unbekannt'}`);
  if (!wiring?.dns?.ok) missing.push(`origin-DNS: ${wiring?.dns?.message ?? 'Zustand unbekannt'}`);
  if (!wiring?.ports?.ok) missing.push(`Flotten-Ports: ${wiring?.ports?.message ?? 'Zustand unbekannt'}`);
  if (missing.length === 0) return { ok: true, message: 'Flotten-Verdrahtung vollstaendig (Firewall, origin-DNS, Ports).' };
  return {
    ok: false,
    message: `Flotten-Verdrahtung unvollstaendig - ${missing.join(' | ')}`,
    hint: wiring?.dns?.hint ?? 'Betreiber-Schritte: docs/ORIGIN_TLS_DNS_RUNBOOK.md',
  };
}

/** Aktualisiert die app-Firewall auf die aktuellen Cloudflare-IP-Ranges. */
async function syncAppFirewall(env) {
  const cfIps = await cloudflareIpRanges();
  // Firewall des Bestands kann noch den Altnamen tragen -> beide probieren.
  let fw = null;
  for (const name of [`${NAME_PREFIX}app`, `${LEGACY_NAME_PREFIX}app`]) {
    const list = await hzGet(env, `/firewalls?name=${name}`);
    fw = (list.firewalls ?? [])[0] ?? null;
    if (fw) break;
  }
  if (!fw) return { ok: false, message: 'app-Firewall nicht gefunden' };
  const rules = firewallRules('app', cfIps);
  const result = await hz(env, 'POST', `/firewalls/${fw.id}/actions/set_rules`, { rules });
  return { ok: Array.isArray(result.actions), appFirewallId: fw.id };
}

// ---------------------------------------------------------------------------
// Cloud-Init: bootstrapet einen Server komplett (Docker + Repo + .env + Rolle)
// ---------------------------------------------------------------------------
// P-4: Rollen-spezifische Secrets – jeder Knoten bekommt NUR, was er braucht.
// (app = voll, sfu/master/edge/ai = ohne Supabase/R2/Replicate/AI-Keys.)
const ROLE_ENV_KEYS = {
  app: [
    'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE', 'SUPABASE_ANON_PUB',
    'CFR2_ACCOUNT_ID', 'CFR2_ACCESS_KEY_ID', 'CFR2_SECRET_ACCESS_KEY', 'CFR2_BUCKET', 'CFR2_PUBLIC_URL',
    'REPLICATE_API_TOKEN', 'DEEPSEEK_API_KEY', 'HF_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY',
    'OLLAMA_URL', 'OLLAMA_MODEL', 'STEM_AI_URL', 'MASTER_PLAYER_URL',
  ],
  sfu: ['SIGNALING_ALLOWED_ORIGINS'],
  master: [],
  edge: ['GF_SECURITY_ADMIN_PASSWORD'],
  ai: ['OLLAMA_URL', 'OLLAMA_MODEL', 'STEM_AI_URL'],
};

function envFile(env, role) {
  const lines = [
    // Origin-TLS (P-7b): app-1 dient HTTPS mit Cloudflare-Origin-Zertifikat.
    `DOMAIN=${role === 'app' ? (env.APP_DOMAIN || 'anunnakitools.de') : ''}`,
    'SIGNALING_ALLOWED_ORIGINS=*',
  ];
  if (role === 'app') {
    lines.push('VOICE_PROVIDER=replicate', 'STEM_AI_PROVIDER=replicate', 'ENABLE_SFU=0');
    // P-1: Studio-Token nur auf den App-Knoten (der einzige mit /api + Socket.io).
    if (env.STUDIO_ACCESS_TOKEN) {
      lines.push(`STUDIO_ACCESS_TOKEN=${env.STUDIO_ACCESS_TOKEN}`);
      lines.push('TRUST_PROXY=1');
    }
  }
  for (const key of ROLE_ENV_KEYS[role] ?? []) {
    const v = env[key];
    if (v && String(v).trim()) lines.push(`${key}=${String(v).trim()}`);
  }
  return lines.join('\n');
}

// EHRLICHKEITSGRENZE (F1): `userData` laeuft NUR beim Kaltstart (kein Rollen-
// Snapshot vorhanden). Wird app-1 aus einem Rollen-Snapshot gebootet, kommt
// Caddyfile/Zertifikat NICHT von hier - dann ist `deploy.sh` (Origin-Default)
// bzw. der Betreiber-Pfad in docs/ORIGIN_TLS_DNS_RUNBOOK.md zustaendig.
function userData(env, role) {
  const token = env.GITHUB_TOKEN ?? '';
  const originCert = String(env.ORIGIN_CERT ?? '');
  const originKey = String(env.ORIGIN_KEY ?? '');
  const envLines = envFile(env, role).replace(/\\/g, '\\\\').replace(/`/g, '\\`');
  return `#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
ORIGIN_CERT='${originCert}'
ORIGIN_KEY='${originKey}'
mkdir -p /opt/audiomonastry
apt-get update -qq
apt-get install -y -qq git curl rsync python3 python3-venv
curl -fsSL https://get.docker.com | sh
# P-4: Token NICHT in der Clone-URL (landet sonst in .git/config) – stattdessen
# als Einmal-Header übergeben und das Remote danach auf die saubere URL setzen.
GIT_AUTH_HEADER="AUTHORIZATION: basic $(printf 'x-access-token:%s' '${token}' | base64 -w0)"
git -c http.extraheader="$GIT_AUTH_HEADER" clone --depth 1 https://github.com/kAInplanmusic/audioMONASTRY.git /opt/audiomonastry 2>/dev/null \\
  || git -C /opt/audiomonastry pull
git -C /opt/audiomonastry remote set-url origin https://github.com/kAInplanmusic/audioMONASTRY.git
cat > /opt/audiomonastry/.env <<'ENVEOF'
${envLines}
ENVEOF
cd /opt/audiomonastry
case "${role}" in
  app)
    # P-7b / F1: Origin-TLS ist der DEFAULT des App-Knotens. Deshalb wird das
    # Caddyfile IMMER als Caddyfile.origin installiert - die ACME-Variante ist
    # im Origin-Betrieb KEIN Rollen-Default: hinter der Cloudflare-Worker-Route
    # kann Let's Encrypt nicht validieren (http-01/tls-alpn-01 landen auf dem
    # Worker), Caddy laeuft dann in eine Retry-Schleife und liefert nie ein
    # Zertifikat (Live-Befund 2026-09-20: /opt/audiomonastry/certs leer und ACME-
    # Caddyfile deployt -> dauerhaft 522).
    mkdir -p /opt/audiomonastry/certs
    chmod 700 /opt/audiomonastry/certs
    cp scripts/hetzner/Caddyfile.origin Caddyfile
    if [ -n "\${ORIGIN_CERT:-}" ] && [ -n "\${ORIGIN_KEY:-}" ]; then
      umask 077
      printf '%s' "\${ORIGIN_CERT}" | base64 -d > /opt/audiomonastry/certs/origin.crt
      printf '%s' "\${ORIGIN_KEY}" | base64 -d > /opt/audiomonastry/certs/origin.key
      chmod 600 /opt/audiomonastry/certs/origin.crt /opt/audiomonastry/certs/origin.key
      # Pruefung VOR dem Caddy-Start: ein unlesbares Paar wuerde Caddy in eine
      # Restart-Schleife schicken, sichtbar erst im Container-Log.
      if command -v openssl >/dev/null 2>&1 && ! openssl x509 -noout -in /opt/audiomonastry/certs/origin.crt >/dev/null 2>&1; then
        echo "[portal] WARNUNG: certs/origin.crt ist kein lesbares X.509-Zertifikat - Caddy kann nicht starten." >&2
      else
        echo "[portal] Origin-Zertifikat installiert: certs/origin.crt + certs/origin.key (600)"
      fi
    else
      echo "[portal] FEHLER: ORIGIN_CERT/ORIGIN_KEY fehlen im Portal-Secret - app-1 kann kein Origin-TLS terminieren." >&2
      echo "[portal] Caddy startet mit Caddyfile.origin ohne Zertifikate -> Restart-Schleife." >&2
      echo "[portal] Betreiber-Schritte: docs/ORIGIN_TLS_DNS_RUNBOOK.md (Zertifikate nach /opt/audiomonastry/certs)." >&2
    fi
    docker compose -f docker-compose.hetzner.yml up -d caddy audiomonastry
    ;;
  sfu)
    echo "SFU_ANNOUNCED_IP=$(hostname -I | awk '{print $1}')" >> .env
    docker compose -f docker-compose.hetzner.yml -f docker-compose.sfu.yml up -d caddy audiomonastry
    ;;
  master)
    docker compose -f docker-compose.hetzner.yml up -d master-player
    ;;
  edge)
    # INFRA-HETZNER-006: NUR der Monitoring-Stack (explizite Service-Liste).
    # Ohne Liste startet die Basisdatei zusaetzlich caddy + audiomonastry +
    # master-player: 4672 MiB Speicher-Limits auf einem 4-GB-cx23.
    docker compose -f docker-compose.hetzner.yml -f docker-compose.monitoring.yml up -d ${MONITORING_SERVICES.join(' ')}
    ;;
  ai)
    curl -fsSL https://ollama.com/install.sh | sh || true
    # FLEET-WIRING: Ollama muss von app-1 aus erreichbar sein (Firewall
    # begrenzt den Zugriff auf die app-1-IP, siehe /api/wire-fleet).
    mkdir -p /etc/systemd/system/ollama.service.d
    printf '[Service]\\nEnvironment="OLLAMA_HOST=0.0.0.0:11434"\\n' > /etc/systemd/system/ollama.service.d/override.conf
    systemctl daemon-reload
    systemctl enable --now ollama || true
    systemctl restart ollama || true
    ollama pull qwen2.5:7b || true
    cd services/stem-ai
    python3 -m venv .venv 2>/dev/null || { apt-get install -y -qq python3.12-venv; python3 -m venv .venv; }
    . .venv/bin/activate
    pip install --quiet -r requirements.txt || true
    cat > /etc/systemd/system/stem-ai.service <<'UNIT'
[Unit]
Description=audioMONASTRY stem-ai (Demucs CPU-Fallback)
After=network.target
[Service]
Type=simple
WorkingDirectory=/opt/audiomonastry/services/stem-ai
Environment=AI_DEVICE=cpu
ExecStart=/opt/audiomonastry/services/stem-ai/.venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000
Restart=on-failure
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
    systemctl daemon-reload
    systemctl enable --now stem-ai || true
    ;;
esac
# Idle-Auto-Shutdown nur auf app-1 (misst /api/online der App)
if [ "${role}" = "app" ]; then
  bash /opt/audiomonastry/scripts/hetzner/install-idle-shutdown.sh || true
fi
touch /root/.audiomonastry-bootstrap-done
`;
}

// ---------------------------------------------------------------------------
// Auth (signiertes Session-Cookie)
// ---------------------------------------------------------------------------
// P-3-Fix: Portal ist ohne ADMIN_PASSWORD/SESSION_SECRET nicht betriebsbereit.
function portalConfigProblems(env) {
  const problems = [];
  if (!env.ADMIN_USER || !env.ADMIN_PASSWORD || env.ADMIN_PASSWORD === 'change-me') {
    problems.push('ADMIN_USER/ADMIN_PASSWORD fehlt oder ist Platzhalter');
  }
  if (!env.SESSION_SECRET || env.SESSION_SECRET === 'change-me') {
    problems.push('SESSION_SECRET fehlt oder ist Platzhalter');
  }
  if (!env.HCLOUD_TOKEN) problems.push('HCLOUD_TOKEN fehlt');
  if (!env.STUDIO_ACCESS_TOKEN || env.STUDIO_ACCESS_TOKEN === 'change-me') {
    problems.push('STUDIO_ACCESS_TOKEN fehlt oder ist Platzhalter');
  }
  return problems;
}

async function hmacHex(env, data) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Konstantzeit-Vergleich über HMAC-Digests (kein direktes Passwort-Equals). */
async function safeEqual(env, a, b) {
  const [ha, hb] = await Promise.all([hmacHex(env, String(a)), hmacHex(env, String(b))]);
  if (ha.length !== hb.length) return false;
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

async function makeSession(env, user) {
  const exp = Math.floor(Date.now() / 1000) + 86400;
  const payload = `${user}.${exp}`;
  const sig = await hmacHex(env, payload);
  return `${payload}.${sig}`;
}

async function checkSession(env, request) {
  const cookie = (request.headers.get('cookie') ?? '');
  const m = cookie.match(/(?:^|;\s*)portal=([^;]+)/);
  if (!m) return false;
  const parts = decodeURIComponent(m[1]).split('.');
  if (parts.length !== 3) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || Date.now() / 1000 > exp) return false;
  const expected = await hmacHex(env, payload);
  return expected === parts[2];
}

function sessionCookie(env, session) {
  return `portal=${encodeURIComponent(session)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400; Secure`;
}

/**
 * SEC-P2-002: Kurzlebiges Studio-Session-Token statt des Master-Tokens.
 *
 * Vorher stand hier `env.STUDIO_ACCESS_TOKEN` im Cookie (24 h, ohne
 * serverseitige Ablauffrist) – ein erbeutetes Cookie war damit ein dauerhafter
 * Zugang (Befund F-1 in docs/SECURITY_COOKIES.md).
 *
 * Format/Ableitung ist identisch zum Server (`src/core/session/studioSession.ts`):
 * Signatur = HMAC-SHA256(SESSION_SECRET, `v1.<exp>`) als Hex.
 * Der Server prüft dasselbe mit seinem `SESSION_SECRET`.
 *
 * Rollout ist zweistufig und rückwärtskompatibel:
 *   1. Server: `SESSION_SECRET` setzen (gleicher Wert wie hier).
 *   2. Portal: `STUDIO_SESSION_MODE=session` setzen → ab dann kurzlebige Token.
 * Ohne Schritt 2 bleibt das Verhalten exakt wie vorher (Master-Token-Cookie),
 * ohne Schritt 1 würde der Server die Session-Token ablehnen (fail-closed) —
 * deshalb erst 1, dann 2.
 */
async function studioSessionToken(env) {
  const ttlS = Math.max(60, Number(env.STUDIO_SESSION_TTL_S) || 900);
  const exp = Math.floor(Date.now() / 1000) + ttlS;
  const signature = await hmacHex(env, `v1.${exp}`);
  return { token: `v1.${exp}.${signature}`, ttlS };
}

async function studioCookie(env) {
  const useSession = String(env.STUDIO_SESSION_MODE || '').trim().toLowerCase() === 'session';
  if (!useSession) {
    return `studio=${encodeURIComponent(env.STUDIO_ACCESS_TOKEN)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400; Secure`;
  }
  const { token, ttlS } = await studioSessionToken(env);
  return `studio=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ttlS}; Secure`;
}

// ---------------------------------------------------------------------------
// Commit-Paritaet / Staleness-Gate (PROD-P1-F4)
// ---------------------------------------------------------------------------
// Anlass (real gemessen am 2026-09-20): app-1 lief auf einem Image vom 18.09.,
// das Repo stand zwei Tage weiter (ae5e749). /api/health nannte nur
// `{"status":"ok","version":"1.210.001"}` - eine Version, die sich nicht mit
// jedem Commit aendert. Der Wake hielt die Flotte trotzdem fuer "ready".
//
// Dieses Gate vergleicht den ERWARTETEN Commit (Repo/Release) mit dem
// GEMELDETEN Stand der Flotte:
//   * Snapshot-Label `commit`  - beim Wake: welchen Stand bootet der Knoten?
//   * /api/health `commit`     - im Betrieb: welcher Stand dient? (beides aus F4
//     im Image gestempelt, siehe server/buildInfo.ts)
// "ready" gibt es nur, wenn Health UND Paritaet stimmen; eine Abweichung wird
// als state 'stale' zurueckgegeben und im Ladebildschirm laut angezeigt.
// Bewusst veraltet fahren: `allowStale` (Wake-Body / ?allowStale=1) bzw.
// `--allow-stale` in scripts/hetzner/fleet-preflight.sh.
//
// Erwarteter Commit, in dieser Reihenfolge:
//   1. Request (Wake-Body `expectedCommit`, Status-Query `?expected=`)
//   2. Worker-Variable `EXPECTED_COMMIT` (wrangler.toml, Betreiber-Pin)
// Ohne (1)/(2) ist die Paritaet NICHT pruefbar - das wird gemeldet, aber nicht
// als Abweichung behauptet (kein falscher Alarm, z. B. fuer vor F4 gebaute
// Images ohne commit-Feld).
const ENV_EXPECTED_COMMIT = 'EXPECTED_COMMIT';
const ENV_ALLOW_STALE = 'ALLOW_STALE';

/**
 * Commit-Angabe auf die Vergleichsform bringen (leer = nicht verwertbar).
 * Gleiche Regel wie `normalizeCommit` in server/buildInfo.ts und
 * `normalize_commit` in scripts/hetzner/lib/build-parity.sh.
 * @param {string|null|undefined} value
 * @returns {string} */
export function normalizeCommit(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw || raw === 'unknown' || raw === 'dev' || raw === 'none' || raw === 'null') return '';
  return raw.slice(0, 40);
}

/** Zwei Commit-Angaben auf denselben Stand pruefen (kurzer trifft langen SHA).
 * @param {string|null|undefined} a
 * @param {string|null|undefined} b
 * @returns {boolean} */
export function sameCommit(a, b) {
  const left = normalizeCommit(a);
  const right = normalizeCommit(b);
  return Boolean(left) && Boolean(right) && (left.startsWith(right) || right.startsWith(left));
}

/**
 * Vergleichsregel (Spiegel von `compareCommits` in `server/buildInfo.ts` -
 * der Worker kann kein TypeScript importieren, beide Seiten muessen dieselbe
 * Antwort liefern; tests/portalWorkerStaleness.test.ts haelt das fest).
 *
 * Rueckgabe: { ok, checked, expected, actual, allowStale, source, message }
 *   checked=false -> es fehlt eine Seite; es wird KEINE Abweichung behauptet
 *   (ok=true) - "nicht pruefbar" darf keinen Alarm ausloesen.
 *
 * @param {{ expected?: (string|null), actual?: (string|null), source?: string, allowStale?: boolean }} [input]
 * @returns {{ ok: boolean, checked: boolean, expected: (string|null), actual: (string|null), allowStale: boolean, source: string, message: string }}
 */
export function commitParity({ expected, actual, source = 'health', allowStale = false } = {}) {
  const want = normalizeCommit(expected);
  const have = normalizeCommit(actual);
  if (!want) {
    return {
      ok: true,
      checked: false,
      expected: null,
      actual: have || null,
      allowStale,
      source,
      message: 'Kein erwarteter Commit gesetzt - Stand der Flotte nicht vergleichbar.',
    };
  }
  if (!have) {
    return {
      ok: true,
      checked: false,
      expected: want,
      actual: null,
      allowStale,
      source,
      message: `Flotte meldet keinen Commit (${source}) - erwartet ${want}, nicht pruefbar.`,
    };
  }
  const ok = sameCommit(want, have);
  return {
    ok,
    checked: true,
    expected: want,
    actual: have,
    allowStale,
    source,
    message: ok ? `Commit-Paritaet ok (${want}).` : `Flotte laeuft Stand ${have}, Repo ist ${want}.`,
  };
}

/** Erwarteter Commit aus Request bzw. Worker-Variable (1 schlaegt 2). */
function expectedCommitFrom(env, explicit) {
  const fromRequest = explicit === undefined || explicit === null ? '' : String(explicit).trim();
  return normalizeCommit(fromRequest !== '' ? fromRequest : env?.[ENV_EXPECTED_COMMIT]);
}

/** Bewusste Freigabe ("--allow-stale") aus Request bzw. Worker-Variable. */
function allowStaleFrom(env, explicit) {
  if (explicit === true || explicit === 1 || explicit === '1' || explicit === 'true') return true;
  const raw = String(env?.[ENV_ALLOW_STALE] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/** Ein Feld aus einer JSON-Antwort lesen (ohne Exception-Pfad). */
function jsonField(value, field) {
  if (!value || typeof value !== 'object') return null;
  const raw = value[field];
  if (raw === undefined || raw === null || raw === '') return null;
  return String(raw).slice(0, 60);
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------
// F1: "ready" heisst ab jetzt "die App antwortet ueber die Domain mit JSON 200".
// Vorher galt JEDE 2xx-Antwort als bereit - auch die HTML-Seite, die die
// Cloudflare-Worker-Route im Fehlerfall ausliefert, haette den Ladebildschirm
// weitergeleitet (der Nutzer landet dann auf einer Fehlerseite statt im Studio).
const HEALTH_TIMEOUT_MS = 5000;

/** fetch mit Deadline (Bounded Wait) - Haenger duerfen den Status nicht blockieren. */
async function fetchWithDeadline(url, init, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, controller ? { ...init, signal: controller.signal } : init);
    const text = await res.text();
    return { res, text };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Health-Check ueber die Domain (Host/SNI = Domain, Origin-Zertifikat) mit
 * resolveOverride auf den origin-Host - genau der Pfad, den der Browser nutzt.
 * Bereit ist nur: HTTP 200 UND ein JSON-Body mit `status: 'ok'`.
 */
async function appHealth() {
  const started = Date.now();
  try {
    const { res, text } = await fetchWithDeadline(
      `https://${PORTAL_DOMAIN}/api/health`,
      { cf: { resolveOverride: ORIGIN_HOST } },
      HEALTH_TIMEOUT_MS,
    );
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* kein JSON - z. B. HTML-Fehlerseite, 522-Seite oder Login-Redirect */
    }
    const ms = Date.now() - started;
    if (res.ok && body && (body.status === 'ok' || body.ok === true)) {
      // PROD-P1-F4: Commit und Build-Zeit kommen additiv mit - ohne sie ist
      // "laeuft die Flotte auf dem Repo-Stand?" nicht beantwortbar.
      return {
        ok: true,
        http: res.status,
        ms,
        version: body.version ?? null,
        commit: body.commit ?? null,
        buildTime: body.buildTime ?? null,
      };
    }
    const reason = body
      ? `HTTP ${res.status}, aber Body ohne status:"ok"`
      : `HTTP ${res.status} liefert kein JSON (HTML-Fehlerseite statt /api/health?)`;
    return { ok: false, http: res.status, ms, message: reason };
  } catch (err) {
    return {
      ok: false,
      ms: Date.now() - started,
      message: `keine Antwort auf https://${PORTAL_DOMAIN}/api/health (Timeout/522): ${String(err?.message ?? err)}`,
    };
  }
}

async function computeStatus(env, options = {}) {
  const servers = await fleetServers(env);
  const existing = Object.values(servers);
  if (existing.length === 0) return { state: 'off', created: 0, total: FLEET.length };

  const app = servers['audiomonastry-app-1'];
  const running = existing.filter((s) => s.status === 'running').length;
  // PROD-P1-F4: erwarteter Commit + bewusste Freigabe je Aufruf (Request schlaegt
  // Worker-Variable). Ohne Erwartung bleibt alles wie vorher.
  const expectedCommit = expectedCommitFrom(env, options.expectedCommit);
  const allowStale = allowStaleFrom(env, options.allowStale);

  if (app && app.status === 'running') {
    const ip = app.public_net?.ipv4?.ip;
    if (ip) {
      // Health zuerst: im Normalfall (bereit) kostet der Status keinen
      // Cloudflare-Aufruf. Erst wenn die Domain NICHT bereit ist, wird die
      // origin-DNS schreibfrei diagnostiziert und als Grund mitgeliefert.
      const health = await appHealth();
      if (health.ok) {
        // PROD-P1-F4: Health ist die eine Haelfte, die Commit-Paritaet die
        // andere. Eine Abweichung wird NICHT als "ready" verkauft - der
        // Ladebildschirm bleibt stehen und nennt beide Staende.
        const parity = commitParity({
          expected: expectedCommit,
          actual: health.commit,
          source: 'health',
          allowStale,
        });
        const common = {
          created: existing.length,
          total: FLEET.length,
          running,
          appIp: ip,
          expectedCommit: expectedCommit || null,
          allowStale,
          url: '/',
          health,
          parity,
        };
        if (parity.checked && !parity.ok && !allowStale) {
          return { ...common, state: 'stale', stale: true };
        }
        return { ...common, state: 'ready', stale: parity.checked ? !parity.ok : false };
      }
      const dns = await cachedOriginDiagnosis(env, ip);
      return {
        state: 'starting-app',
        created: existing.length,
        total: FLEET.length,
        running,
        appIp: ip,
        healthError: health.message,
        dns,
        // Ein Feld mit Klartextgrund fuer den Ladebildschirm (F1): enthaelt den
        // Cloudflare-Fehlercode, wenn die Verdrahtung fehlt.
        wiringError: dns.ok ? null : `${dns.message}${dns.hint ? ` - ${dns.hint}` : ''}`,
      };
    }
    return { state: 'starting-app', created: existing.length, total: FLEET.length, running };
  }

  return {
    state: 'creating',
    created: existing.length,
    total: FLEET.length,
    running,
    states: existing.map((s) => `${s.name}:${s.status}`),
  };
}

// ---------------------------------------------------------------------------
// Fleet-Aktionen
// ---------------------------------------------------------------------------
async function startFleet(env, options = {}) {
  const servers = await fleetServers(env);
  // PROD-P1-F4: Das Wake-Gate kennt den erwarteten Stand nur, wenn der Aufrufer
  // (fleet-preflight.sh / Portal-Body) oder die Worker-Variable EXPECTED_COMMIT
  // ihn nennt. Ohne Erwartung bleibt der Start wie bisher moeglich - /api/status
  // meldet die Paritaet dann als "nicht pruefbar" statt sie zu behaupten.
  const expectedCommit = expectedCommitFrom(env, options.expectedCommit);
  const allowStale = allowStaleFrom(env, options.allowStale);
  if (Object.keys(servers).length > 0) {
    return {
      started: false,
      message: 'Flotte existiert bereits.',
      expectedCommit: expectedCommit || null,
      allowStale,
    };
  }

  const sshKeyId = await ensureSshKey(env);
  const cfIps = await cloudflareIpRanges();
  const snapshots = await listSnapshots(env);
  const created = [];
  const usedSnapshots = {};
  const fallbackRoles = [];
  const failed = [];
  // INFRA-HETZNER-007: die tatsaechlich verwendeten Typen je Rolle mitschicken -
  // so ist im Wake-Ergebnis belegbar, welcher Typ (Fallback oder Override) lief.
  const types = Object.fromEntries(FLEET.map((f) => [f.role, fleetServerType(env, f.role)]));

  for (const item of FLEET) {
    const fwName = `audiomonastry-${item.role}`;
    const fwId = await ensureFirewall(env, fwName, firewallRules(item.role, item.role === 'app' ? cfIps : []));
    // INFRA-HETZNER-007: Typ je Rolle aus FLEET_TYPE_<ROLLE> (Fallback = Tabelle).
    const serverType = fleetServerType(env, item.role);
    // OPS-Snapshot: zuerst das Rollen-Snapshot-Image verwenden (schneller
    // Start, kein cloud-init-Bootstrap). Fallback: Basis-Image + cloud-init.
    const snap = findSnapshot(snapshots, item.role);
    const payload = {
      name: item.name,
      server_type: serverType,
      image: snap ? snap.id : IMAGE,
      location: LOCATION,
      firewalls: fwId ? [{ firewall: fwId }] : [],
      labels: { app: 'audioMONASTRY', 'managed-by': 'portal-worker', role: item.role },
    };
    if (snap) {
      usedSnapshots[item.role] = {
        image: snap.id,
        description: snap.description ?? snap.name ?? '',
        // PROD-P1-F4: Das Snapshot-Label aus POST /api/refresh-snapshots nennt
        // den Commit, der im Image steckt. Beim Wake ist das der einzige
        // verfuegbare Stand (der Container bootet noch) - Grundlage des Gates.
        commit: normalizeCommit(snap.labels?.commit) || null,
      };
    } else {
      payload.user_data = userData(env, item.role);
      fallbackRoles.push(item.role);
    }
    if (sshKeyId) payload.ssh_keys = [sshKeyId];
    const result = await hzPost(env, '/servers', payload);
    if (result.server?.id) {
      created.push(item.name);
    } else {
      failed.push({
        name: item.name,
        role: item.role,
        error: result.error?.message ?? result.message ?? null,
        http: result.__http ?? (result.error ? (result.error.code ?? null) : null),
      });
    }
  }

  // FLEET-WIRING: Auf die app-1-IP warten (bis ~30 s), dann DNS + Firewalls
  // synchronisieren (master/ai-Ports, origin-DNS, app-Firewall).
  //
  // LIVE-BEFUND 2026-09-18: das Ergebnis wurde nur ins Worker-Log geschrieben
  // (`console.warn`). Starb die DNS-Verdrahtung (abgelaufener Cloudflare-Token),
  // blieb das Portal dauerhaft in 'starting-app' mit HTTP 522 - ohne jeden Hinweis
  // fuer den Betreiber; genau daran ist ein Live-Wake gescheitert. Jetzt wird das
  // Ergebnis zurueckgegeben und im Ladebildschirm sichtbar gemacht.
  let wiring = null;
  if (created.length === FLEET.length) {
    try {
      let appIp = '';
      for (let i = 0; i < 15 && !appIp; i++) {
        const m = await fleetServers(env);
        appIp = m['audiomonastry-app-1']?.public_net?.ipv4?.ip ?? '';
        if (!appIp) await new Promise((r) => setTimeout(r, 2000));
      }
      const appFirewall = await syncAppFirewall(env);
      const dns = appIp
        ? await syncOriginDns(env, appIp)
        : { ok: false, code: 'no-app-ip', message: 'app-1 hat noch keine IP.' };
      const ports = await openFleetPorts(env);
      // F1: ok + Klartextgrund auf oberster Ebene - so sieht der Betreiber im
      // Wake-Ergebnis sofort, WELCHER Teil der Verdrahtung fehlt.
      wiring = { appIp, appFirewall, dns, ports, ...wiringSummary({ appFirewall, dns, ports }) };
      if (!dns.ok) console.warn('[portal] fleet-wiring: DNS nicht gesetzt –', dns.message);
    } catch (e) {
      wiring = { ok: false, error: String(e?.message ?? e), appFirewall: null, dns: null, ports: null };
      console.warn('[portal] fleet-wiring:', e?.message ?? e);
    }
  }

  // PROD-P1-F4: Wake-Gate. Beim Start ist /api/health noch nicht erreichbar
  // (der Container bootet), deshalb wird hier der SNAPSHOT-Stand geprueft - das
  // ist genau der Stand, der gleich dienen wird. Kaltstart ohne Snapshot oder
  // Snapshots ohne Label liefern "nicht pruefbar" (checked=false); der laufende
  // Betrieb wird dann ueber /api/status (Health-Commit) geprueft.
  const appSnapshotCommit = usedSnapshots?.app?.commit ?? null;
  const parity = commitParity({ expected: expectedCommit, actual: appSnapshotCommit, source: 'snapshot', allowStale });
  const staleRoles = expectedCommit
    ? Object.entries(usedSnapshots)
        .filter(([, snap]) => snap.commit && !sameCommit(snap.commit, expectedCommit))
        .map(([role, snap]) => `${role}:${snap.commit}`)
    : [];
  if (staleRoles.length > 0) {
    // Laut ins Worker-Log - ein veralteter Snapshot-Start war bisher nur an
    // fehlenden Features zu merken (Live-Befund 2026-09-20).
    console.warn(`[portal] STALE-Flotte: ${parity.message} (Snapshots: ${staleRoles.join(', ')})`);
  }

  return {
    started: true,
    created,
    types,
    usedSnapshots,
    fallbackRoles,
    failed,
    wiring,
    expectedCommit: expectedCommit || null,
    allowStale,
    parity,
    staleRoles,
  };
}

/**
 * Öffnet die Flotten-Service-Ports (master-player 8000, stem-ai 8000,
 * Ollama 11434) NUR für die aktuelle app-1-IP – idempotent und bei
 * IP-Wechsel aktualisierend.
 */
async function openFleetPorts(env) {
  const servers = await fleetServers(env);
  const appIp = servers['audiomonastry-app-1']?.public_net?.ipv4?.ip ?? '';
  if (!appIp) return { ok: false, message: 'app-1 hat noch keine IP.' };

  const portsByRole = {
    'audiomonastry-master': ['8000'],
    'audiomonastry-ai': ['8000', '11434'],
  };
  const list = await hzGet(env, '/firewalls?per_page=100');
  const updated = {};
  for (const fw of list.firewalls ?? []) {
    const ports = portsByRole[fw.name];
    if (!ports || ports.length === 0) continue;
    // Vorhandene Regeln ohne unsere Service-Ports behalten; Service-Ports
    // werden mit der aktuellen app-1-IP ersetzt (IP-Wechsel-sicher).
    const baseRules = (fw.rules ?? []).filter(
      (r) => !(r?.protocol === 'tcp' && ports.includes(String(r?.port ?? ''))),
    );
    const extra = ports.map((p) => ({
      direction: 'in',
      protocol: 'tcp',
      port: p,
      source_ips: [`${appIp}/32`],
    }));
    const result = await hz(env, 'POST', `/firewalls/${fw.id}/actions/set_rules`, { rules: [...baseRules, ...extra] });
    updated[fw.name] = Array.isArray(result.actions) && result.actions.length > 0 ? 'ok' : { ok: false, raw: result };
  }
  // Debug-/Betriebssicht: Regeln + Server-Zuordnung zurückgeben.
  const after = await hzGet(env, '/firewalls?per_page=100');
  const detail = {};
  for (const fw of after.firewalls ?? []) {
    detail[fw.name] = {
      applied_to: (fw.applied_to ?? []).map((a) => a.server?.id ?? a.label_selector?.selector ?? '?'),
      rules: (fw.rules ?? []).map((r) => `${r.direction}/${r.protocol}/${r.port}→${(r.source_ips ?? []).join(',')}`),
    };
  }
  return { ok: Object.keys(updated).length > 0, updated, appIp, detail };
}

// ---------------------------------------------------------------------------
// Stop-Pfad: Snapshot VOR dem Loeschen (INFRA-HETZNER-008)
// ---------------------------------------------------------------------------
// Vorher loeschte stopFleet() die Server ohne Sicherung - ein Stop (oder der
// Auto-Stop-Cron) war damit unwiederbringlich, waehrend der CLI-Pfad
// (scripts/hetzner/lifecycle.sh) schon immer einen Snapshot zog. Jetzt gilt fuer
// BEIDE Pfade dieselbe Regel: erst Snapshot, dann loeschen - und nur loeschen,
// wenn der Snapshot nachweislich fertig ist (sonst laeuft der Server weiter; das
// wird laut gemeldet statt still Daten zu verlieren). Die Snapshots sind
// gleichzeitig der schnelle Start-Pfad des naechsten Wake (findSnapshot()).
//
// Rolle eines Servers: Label des Portal-Workers; fuer die Bestandsflotte ohne
// Label wird sie aus dem Namen abgeleitet (Praefix + app|sfu|ai|master|edge).
function serverRole(server) {
  const label = String(server?.labels?.role ?? '').trim();
  if (label) return label;
  const name = String(server?.name ?? '');
  for (const prefix of [NAME_PREFIX, LEGACY_NAME_PREFIX]) {
    const match = name.match(new RegExp(`^${prefix}(app|sfu|ai|master|edge)(?![a-z])`));
    if (match) return match[1];
  }
  return null;
}

/** Action-Status bis `deadline` pollen (Hetzner: running|success|error). */
async function waitForAction(env, actionId, deadline) {
  // Bewusst begrenzt: der Stop-Pfad wird auch aus dem Cron aufgerufen, ein
  // unbegrenztes Warten wuerde den Lauf dort abschneiden (Worker-Wall-Clock).
  const pollMs = Number(env.SNAPSHOT_POLL_MS ?? 5000);
  for (;;) {
    const data = await hzGet(env, `/actions/${actionId}`);
    const status = String(data?.action?.status ?? 'unknown');
    if (status === 'success' || status === 'error') return status;
    if (data?.__http) return `http-${data.__http}`;
    // Deadline erreicht: Abbruch (der Snapshot laeuft serverseitig weiter) -
    // geloescht wird dann NICHT.
    if (Date.now() + pollMs > deadline) return 'timeout';
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Snapshot je Server anlegen und auf Abschluss warten (Budget: `env`-Sekunden). */
async function snapshotFleet(env) {
  const servers = await fleetServers(env);
  const list = Object.values(servers);
  const budgetMs = Number(env.STOP_SNAPSHOT_TIMEOUT_S ?? 600) * 1000;
  const entries = [];
  for (const server of list) {
    const role = serverRole(server);
    if (!role) {
      entries.push({ server: server.name, role: null, action: null, ok: false, error: 'keine Rolle ermittelbar' });
      continue;
    }
    // Alle create_image-Aufrufe zuerst (die Snapshots laufen serverseitig
    // parallel) - so kostet das Warten das Maximum, nicht die Summe.
    const snap = await createServerSnapshot(env, server, role);
    entries.push({ ...snap, ok: false });
  }
  const deadline = Date.now() + budgetMs;
  for (const entry of entries) {
    if (!entry.action) {
      entry.error = entry.error ?? 'kein Action-Id (Snapshot-Anlage fehlgeschlagen)';
      continue;
    }
    const status = await waitForAction(env, entry.action, deadline);
    entry.status = status;
    entry.ok = status === 'success';
    if (!entry.ok) entry.error = entry.error ?? `Snapshot-Status ${status}`;
  }
  return { entries, budgetS: budgetMs / 1000 };
}

async function stopFleet(env) {
  const servers = await fleetServers(env);
  const list = Object.values(servers);

  // 1. Snapshots anlegen und bestaetigen lassen (INFRA-HETZNER-008).
  const { entries: snapshots, budgetS } = await snapshotFleet(env);
  const snapByServer = new Map(snapshots.map((s) => [s.server, s]));

  // 2. Nur Server mit FERTIGEM Snapshot loeschen; alles andere bleibt stehen und
  //    wird gemeldet (kein stiller Datenverlust).
  const deleted = [];
  const skipped = [];
  for (const s of list) {
    const snap = snapByServer.get(s.name);
    if (!snap?.ok) {
      skipped.push({ server: s.name, reason: snap?.error ?? 'Snapshot nicht bestaetigt' });
      continue;
    }
    await hzDelete(env, `/servers/${s.id}`);
    deleted.push(s.name);
  }

  // 3. Floating-IPs nur loeschen, wenn wirklich KEIN Server uebrig ist - sonst
  //    zeigt die DNS auf eine IP, die noch von einem laufenden Knoten genutzt wird.
  const fipDeleted = [];
  if (skipped.length === 0) {
    const fips = await hzGet(env, '/floating_ips?per_page=100');
    for (const fip of fips.floating_ips ?? []) {
      await hzDelete(env, `/floating_ips/${fip.id}`);
      fipDeleted.push(fip.name ?? fip.ip);
    }
  }

  // 4. Retention wie im CLI-Pfad: letzten SNAPSHOT_RETENTION je Rolle behalten.
  const pruned = await pruneSnapshots(env);
  return {
    deleted,
    fipDeleted,
    skipped,
    snapshots,
    pruned,
    retention: {
      keepPerRole: SNAPSHOT_RETENTION,
      snapshotTimeoutS: budgetS,
      hint: 'Stop zieht je Knoten einen Snapshot und behaelt die letzten 2 je Rolle.',
    },
  };
}

// ---------------------------------------------------------------------------
// HTML (Login + Ladebildschirm mit großer Zeit)
// ---------------------------------------------------------------------------
const PAGE_HTML = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>audioMONASTRY · Studio starten</title>
<style>
  :root { --bg:#050607; --teal:#14b8c9; --cyan:#22d3ee; --fuchsia:#d946ef; --edge:rgba(255,255,255,0.08); }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:radial-gradient(1000px 500px at 50% -10%, #0c1116 0%, #050607 60%);
         color:#e8eaed; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; }
  .card { width:min(560px, 92vw); background:rgba(15,17,20,0.9); border:1px solid var(--edge);
          border-radius:1rem; padding:2rem; text-align:center; box-shadow:0 30px 80px -30px rgba(0,0,0,0.9); }
  h1 { font-size:1.4rem; letter-spacing:0.25em; color:#fff; margin:0 0 .4rem; }
  .sub { font-size:0.65rem; letter-spacing:0.3em; color:#6b7280; text-transform:uppercase; }
  .timer { font-size:4.5rem; font-weight:900; color:var(--cyan); letter-spacing:0.05em;
           text-shadow:0 0 30px rgba(34,211,238,0.45); margin:1.2rem 0; font-variant-numeric:tabular-nums; }
  .steps { text-align:left; margin:1.2rem auto 0; max-width:420px; }
  .step { display:flex; align-items:center; gap:0.6rem; padding:0.5rem 0; border-bottom:1px solid rgba(255,255,255,0.04);
          font-size:0.75rem; color:#9ca3af; }
  .step .dot { width:8px; height:8px; border-radius:50%; background:#374151; flex:none; }
  .step.done { color:#6ee7b7; } .step.done .dot { background:#34d399; box-shadow:0 0 8px #34d39988; }
  .step.active { color:#67e8f9; } .step.active .dot { background:var(--cyan); animation:pulse 1s infinite; }
  @keyframes pulse { 50% { box-shadow:0 0 12px var(--cyan); } }
  input { width:100%; padding:0.8rem; margin:0.5rem 0; background:#0b0d0f; border:1px solid var(--edge);
          border-radius:0.6rem; color:#fff; font:inherit; text-align:center; }
  input:focus { outline:2px solid var(--cyan); }
  button { width:100%; margin-top:1rem; padding:0.9rem; border-radius:0.6rem; border:1px solid rgba(34,211,238,0.5);
           background:rgba(34,211,238,0.12); color:#a5f3fc; font:inherit; font-weight:700; letter-spacing:0.2em;
           cursor:pointer; transition:all .2s; }
  button:hover { background:rgba(34,211,238,0.25); }
  .err { color:#fca5a5; font-size:0.7rem; min-height:1rem; margin-top:.5rem; }
  .hint { font-size:0.6rem; color:#4b5563; margin-top:1rem; }
</style>
</head>
<body>
<div class="card">
  <h1>AUDIO MONASTRY</h1>
  <div class="sub">Studio · Flotten-Start</div>

  <!-- Login -->
  <div id="login">
    <input id="user" type="text" placeholder="Admin-User" autocomplete="username" />
    <input id="pass" type="password" placeholder="Passwort" autocomplete="current-password" />
    <button id="loginBtn">ANMELDEN &amp; STARTEN</button>
    <div class="err" id="err"></div>
    <div class="hint">Nach dem Login wird die Hetzner-Flotte automatisch hochgefahren.</div>
  </div>

  <!-- Ladebildschirm -->
  <div id="loading" style="display:none">
    <div class="sub">Das Studio wird hochgefahren</div>
    <div class="timer" id="timer">00:00</div>
    <div class="steps" id="steps"></div>
    <div class="err" id="loadErr"></div>
    <div class="hint">Die Seite leitet dich automatisch weiter, sobald alles bereit ist.</div>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);
const startedAt = Date.now();

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60), r = s % 60;
  return String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
}
setInterval(() => { $('timer').textContent = fmt(Date.now() - startedAt); }, 500);

const STEPS = [
  ['server', 'Hetzner-Server erstellen (n/5)'],
  ['docker', 'Docker + System-Tuning installieren'],
  ['deploy', 'Repo klonen + Rollen deployen (app/sfu/ai/master/edge)'],
  ['app', 'App starten + Health-Check'],
  ['ready', 'Studio bereit – Weiterleitung'],
];

function renderSteps(status) {
  const steps = $('steps');
  steps.innerHTML = '';
  STEPS.forEach(([key, label], i) => {
    const d = document.createElement('div');
    d.className = 'step';
    let state = 'pending';
    if (status.state === 'ready') state = 'done';
    else if (status.state === 'starting-app' && key !== 'ready') state = 'done';
    else if (status.state === 'starting-app' && key === 'ready') state = 'active';
    else if (status.state === 'stale') {
      // PROD-P1-F4: Health ist da, aber die Flotte laeuft auf einem anderen
      // Commit als das Repo. Kein Weiterleiten - der Betreiber muss neu
      // deployen (oder bewusst mit --allow-stale starten).
      state = key === 'ready' ? 'active' : 'done';
      if (key === 'ready') label = 'Stand veraltet – Neu-Deploy noetig';
    }
    else if (status.state === 'creating') {
      if (key === 'server') state = 'active';
      if (i === 0) label = 'Hetzner-Server erstellen (' + (status.created ?? 0) + '/' + (status.total ?? 5) + ')';
    }
    if (state === 'done') { d.classList.add('done'); label = '✓ ' + label; }
    if (state === 'active') { d.classList.add('active'); label = '▶ ' + label; }
    d.innerHTML = '<span class="dot"></span>' + label;
    steps.appendChild(d);
  });
}

// PROD-P1-F4: Der erwartete Commit kommt aus der Wake-Antwort (bzw. aus der
// Worker-Variable EXPECTED_COMMIT) und wird bei jedem Poll mitgeschickt - nur so
// kann der Server "Flotte laeuft Stand X, Repo ist Y" melden.
let expectedCommit = '';

function statusUrl() {
  return expectedCommit ? '/api/status?expected=' + encodeURIComponent(expectedCommit) : '/api/status';
}

async function poll() {
  try {
    const res = await fetch(statusUrl());
    const status = await res.json();
    if (status.state === 'off') {
      $('login').style.display = '';
      $('loading').style.display = 'none';
      return;
    }
    $('login').style.display = 'none';
    $('loading').style.display = '';
    renderSteps(status);
    if (status.parity && status.parity.expected) expectedCommit = status.parity.expected;
    // F1: einen Verdrahtungsfehler (z. B. origin-DNS/Cloudflare-Token) im
    // Klartext anzeigen - sonst haengt der Ladebildschirm ohne Grund.
    if (status.wiringError) $('loadErr').textContent = '⚠️ ' + status.wiringError;
    if (status.state === 'stale') {
      $('loadErr').textContent = '⏸ ' + (status.parity && status.parity.message
        ? status.parity.message
        : 'Die Flotte laeuft auf einem anderen Stand als das Repo.') +
        ' Bitte neu deployen (scripts/hetzner/fleet-preflight.sh apply) - oder bewusst mit --allow-stale starten.';
      setTimeout(poll, 4000);
      return;
    }
    if (status.state === 'ready') {
      if (status.stale) {
        // Bewusst freigegeben (allow-stale): weiterleiten, aber sichtbar.
        $('loadErr').textContent = '⚠️ ' + (status.parity && status.parity.message ? status.parity.message : 'Stand abweichend') + ' (bewusst erlaubt)';
      } else if (status.parity && status.parity.checked === false && status.parity.message) {
        $('loadErr').textContent = '⚠️ ' + status.parity.message;
      } else {
        $('loadErr').textContent = '✓ Bereit – Weiterleitung …';
      }
      setTimeout(() => { location.href = '/'; }, 1200);
      return;
    }
    setTimeout(poll, 4000);
  } catch (e) {
    $('loadErr').textContent = 'Status nicht erreichbar – erneut …';
    setTimeout(poll, 4000);
  }
}

$('loginBtn').onclick = async () => {
  $('err').textContent = '';
  const res = await fetch('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: $('user').value, pass: $('pass').value }),
  });
  const data = await res.json();
  if (!res.ok) { $('err').textContent = data.error || 'Login fehlgeschlagen'; return; }
  const wake = await fetch('/api/wake', { method: 'POST' });
  const wd = await wake.json();
  if (!wake.ok) { $('err').textContent = wd.error || 'Start fehlgeschlagen'; return; }
  // PROD-P1-F4: erwarteten Stand merken und die Commit-Paritaet des Wake laut
  // anzeigen (Snapshot-Label vs. Repo) - das ist der Stand, der gleich bootet.
  if (wd.expectedCommit) expectedCommit = wd.expectedCommit;
  // Verdrahtung (Firewall/DNS/Ports) sichtbar machen: ohne DNS bleibt der
  // Health-Check ueber die Domain bei 522 stehen und der Start wirkt "haengend".
  if (wd.wiring && wd.wiring.dns && wd.wiring.dns.ok === false) {
    $('loadErr').textContent = 'Achtung: Domain-Verdrahtung fehlgeschlagen – ' + (wd.wiring.dns.message || 'unbekannt');
  }
  if (wd.parity && wd.parity.checked && wd.parity.ok === false) {
    const hint = wd.allowStale ? ' (bewusst erlaubt: allow-stale)' : ' - bitte neu deployen, der Stand ist veraltet.';
    $('loadErr').textContent = '⚠️ ' + wd.parity.message + hint;
  }
  $('login').style.display = 'none';
  $('loading').style.display = '';
  renderSteps({ state: 'creating', created: 0, total: 5 });
  poll();
};

poll();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // P-3-Fix: ohne Konfiguration sofort 503 (kein offener Wake-Pfad).
    const configProblems = portalConfigProblems(env);
    if (configProblems.length > 0) {
      return json({ error: 'Portal nicht konfiguriert: ' + configProblems.join('; ') }, 503);
    }

    // API-Routen
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/login' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const user = String(body.user ?? '');
        const pass = String(body.pass ?? '');
        if (!user || !pass) return json({ error: 'Login fehlgeschlagen' }, 401);
        const userOk = await safeEqual(env, user, env.ADMIN_USER);
        const passOk = await safeEqual(env, pass, env.ADMIN_PASSWORD);
        if (!userOk || !passOk) return json({ error: 'Login fehlgeschlagen' }, 401);
        const session = await makeSession(env, user);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            // P-1: Studio-Cookie gleich mitsetzen – die App verlangt es später.
            'set-cookie': [sessionCookie(env, session), await studioCookie(env)],
          },
        });
      }

      if (url.pathname === '/api/wake' && request.method === 'POST') {
        if (!(await checkSession(env, request))) return json({ error: 'nicht eingeloggt' }, 401);
        // PROD-P1-F4: Der Wake nimmt den erwarteten Commit mit (`expectedCommit`)
        // und optional die bewusste Freigabe (`allowStale`) - fleet-preflight.sh
        // schickt beides, die Portal-Seite kann es aus der Worker-Variable
        // EXPECTED_COMMIT bekommen. Das Ergebnis enthaelt die Paritaetspruefung
        // gegen die Snapshot-Labels (laut, siehe startFleet).
        const body = await request.json().catch(() => ({}));
        const result = await startFleet(env, {
          expectedCommit: body?.expectedCommit,
          allowStale: body?.allowStale,
        });
        if (result.staleRoles?.length > 0 && !result.allowStale) {
          console.warn(`[portal] Wake startet eine veraltete Flotte: ${result.parity?.message ?? ''}`);
        }
        return json(result);
      }

      if (url.pathname === '/api/status') {
        if (!(await checkSession(env, request))) return json({ state: 'off', locked: true });
        // Erwarteter Commit aus der Abfrage (Portal-Ladebildschirm traegt ihn
        // aus der Wake-Antwort weiter) oder aus EXPECTED_COMMIT.
        return json(await computeStatus(env, {
          expectedCommit: url.searchParams.get('expected'),
          allowStale: url.searchParams.get('allowStale'),
        }));
      }

      if (url.pathname === '/api/stop' && request.method === 'POST') {
        if (!(await checkSession(env, request))) return json({ error: 'nicht eingeloggt' }, 401);
        return json(await stopFleet(env));
      }

      // FLEET-MAP: liefert die öffentlichen IPv4-Adressen aller Flotten-Knoten.
      // Geschützt über den Studio-Token – die App (app-1) ruft das beim Start
      // auf und verdrahtet master-player/ollama/stem-ai damit zur Laufzeit.
      if (url.pathname === '/api/fleet-map') {
        const token = (request.headers.get('x-studio-token') ?? '').trim();
        if (!token || token !== env.STUDIO_ACCESS_TOKEN) {
          return json({ error: 'nicht autorisiert' }, 401);
        }
        const servers = await fleetServers(env);
        const fleet = {};
        for (const [name, s] of Object.entries(servers)) {
          fleet[name] = s.public_net?.ipv4?.ip ?? '';
        }
        return json({ fleet });
      }

      // FLEET-WIRING: Firewalls für master/ai auf die aktuelle app-1-IP
      // verdrahten (master-player 8000, stem-ai 8000, Ollama 11434).
      if (url.pathname === '/api/wire-fleet' && request.method === 'POST') {
        if (!(await checkSession(env, request))) return json({ error: 'nicht eingeloggt' }, 401);
        const servers = await fleetServers(env);
        const appIp = servers['audiomonastry-app-1']?.public_net?.ipv4?.ip ?? '';
        const appFirewall = await syncAppFirewall(env);
        const dns = appIp
          ? await syncOriginDns(env, appIp)
          : { ok: false, code: 'no-app-ip', message: 'app-1 hat noch keine IP.' };
        const ports = await openFleetPorts(env);
        // F1: derselbe Klartextgrund wie im Wake-Ergebnis - ein fehlender oder
        // abgelaufener Cloudflare-Token darf hier nicht still bleiben.
        return json({ ...wiringSummary({ appFirewall, dns, ports }), appFirewall, dns, ports });
      }

      // OPS-Snapshot: erzeugt je laufendem Flotten-Server einen Snapshot
      // (POST /servers/{id}/actions/create_image) und löscht alte Snapshots
      // (Auto-Retention: letzte 2 je Rolle). Nur mit Session-Cookie.
      // Optionaler Body { commit, version } wird als Label am Snapshot
      // gespeichert – so kann ein Preflight prüfen, ob der Snapshot den
      // aktuellen Release-Stand enthält.
      if (url.pathname === '/api/refresh-snapshots' && request.method === 'POST') {
        if (!(await checkSession(env, request))) return json({ error: 'nicht eingeloggt' }, 401);
        const body = await request.json().catch(() => ({}));
        const meta = {
          commit: String(body?.commit ?? '').trim(),
          version: String(body?.version ?? '').trim(),
        };
        return json(await refreshSnapshots(env, meta));
      }

      // OPS-Snapshot: aktuelle Rollen-Snapshots auflisten (Session-Cookie).
      if (url.pathname === '/api/snapshots') {
        if (!(await checkSession(env, request))) return json({ error: 'nicht eingeloggt' }, 401);
        const images = await listSnapshots(env);
        return json({
          snapshots: images.map((img) => ({
            id: img.id,
            name: img.name ?? '',
            description: img.description ?? '',
            created: img.created ?? '',
            status: img.status ?? '',
            disk_size: img.disk_size ?? null,
            role: snapshotRoleOf(img),
            commit: img.labels?.commit ?? null,
            version: img.labels?.version ?? null,
          })),
        });
      }

      // Unbekannte /api/*-Routen NICHT blockieren – sie gehören der App
      // (z. B. /api/health, /api/ai/*, /api/metrics) und werden unten
      // durch den Proxy an den Origin weitergereicht.
    }

    // Portal-Seite immer unter /portal erreichbar
    if (url.pathname === '/portal' || url.pathname.startsWith('/portal/')) {
      return new Response(PAGE_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    // Hauptdomain: wenn Flotte bereit -> Proxy auf app-1, sonst Portal-Seite
    const servers = await fleetServers(env);
    const app = servers['audiomonastry-app-1'];
    if (app && app.status === 'running' && app.public_net?.ipv4?.ip) {
      // Proxy mit ORIGINAL-URL (Host + SNI = Domain, kein Host=IP → kein
      // Cloudflare-Fehler 1003). resolveOverride über den origin-Host
      // (DNS wird bei jedem Wake auf die aktuelle app-1-IP synchronisiert).
      const proxied = new Request(request.url, request);
      return fetch(proxied, { cf: { resolveOverride: ORIGIN_HOST } });
    }

    return new Response(PAGE_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  },

  async scheduled(event, env) {
    // P-3-Fix: ohne Konfiguration nichts tun.
    if (portalConfigProblems(env).length > 0) return;

    // Auto-Stopp: Sobald app-1 (nach 20 min Idle) ausgeschaltet wurde, löschen.
    const servers = await fleetServers(env);
    const app = servers['audiomonastry-app-1'];
    const existing = Object.keys(servers);

    if (existing.length === 0) return;

    const shouldDeleteAll = !app || app.status === 'off';
    if (shouldDeleteAll) {
      await stopFleet(env);
      console.log(`[portal] Flotte gelöscht (${existing.length} Server).`);
    }
  },
};
