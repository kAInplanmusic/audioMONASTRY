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
//   POST /api/stop      -> löscht die Flotte sofort (Kosten stoppen)
//   Cron */5 * * * *    -> löscht die Flotte, sobald app-1 nach 20 min Idle
//                          (Idle-Auto-Shutdown) ausgeschaltet wurde.
// ============================================================================

const HETZNER = 'https://api.hetzner.cloud/v1';

const FLEET = [
  { name: 'samplemonk-app-1',    type: 'cx33', role: 'app' },
  { name: 'samplemonk-sfu-1',    type: 'cx33', role: 'sfu' },
  { name: 'samplemonk-ai-1',     type: 'cx33', role: 'ai' },
  { name: 'samplemonk-master-1', type: 'cx23', role: 'master' },
  { name: 'samplemonk-edge-1',   type: 'cx23', role: 'edge' },
];

const LOCATION = 'fsn1';
const IMAGE = 'ubuntu-24.04';
// OPS-Snapshot: Basis-Image-Name, von dem die Rollen-Snapshots abgeleitet werden.
// Snapshots kosten ~0,01 €/GB/Monat (Cent-Beträge) und beschleunigen den
// Flotten-Start deutlich (kein Docker-Build/cloud-init-Bootstrap je Knoten).
const SNAPSHOT_PREFIX = 'samplemonk-snapshot-';
const SNAPSHOT_RETENTION = 2; // je Rolle die letzten 2 Snapshots behalten
const REPO_URL = 'https://github.com/kAInplanmusic/audioMONASTRY.git';
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
    if (FLEET.some((f) => f.name === s.name)) map[s.name] = s;
  }
  return map;
}

// ---------------------------------------------------------------------------
// OPS-Snapshot: Rollen-Snapshots für schnellen Flotten-Start
// ---------------------------------------------------------------------------
function isFleetSnapshot(img) {
  return (
    img?.labels?.app === 'audioMONASTRY' ||
    String(img?.name ?? '').startsWith(SNAPSHOT_PREFIX) ||
    String(img?.description ?? '').startsWith(SNAPSHOT_PREFIX)
  );
}

function snapshotRoleOf(img) {
  return img?.labels?.role ?? null;
}

async function listSnapshots(env) {
  const data = await hzGet(env, '/images?type=snapshot&per_page=100&sort=created:desc');
  return (data.images ?? []).filter(isFleetSnapshot);
}

/** Neuesten verfügbaren Snapshot einer Rolle finden (oder null). */
function findSnapshot(images, role) {
  return (
    images.find(
      (img) =>
        img.status === 'available' &&
        snapshotRoleOf(img) === role &&
        (String(img.name ?? '').startsWith(`${SNAPSHOT_PREFIX}${role}`) ||
          String(img.description ?? '').startsWith(`${SNAPSHOT_PREFIX}${role}`)),
    ) ?? null
  );
}

async function createServerSnapshot(env, server, role) {
  const payload = {
    description: `${SNAPSHOT_PREFIX}${role}-${new Date().toISOString().slice(0, 10)}`,
    type: 'snapshot',
    labels: { app: 'audioMONASTRY', role, 'snapshot-of': server.name },
  };
  const result = await hzPost(env, `/servers/${server.id}/actions/create_image`, payload);
  return {
    server: server.name,
    role,
    description: payload.description,
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

async function refreshSnapshots(env) {
  const servers = await fleetServers(env);
  const running = Object.values(servers).filter((s) => s.status === 'running');
  if (running.length === 0) {
    return { ok: false, message: 'Keine laufenden Flotten-Server – Snapshots werden von laufenden Servern erzeugt.' };
  }

  const created = [];
  for (const server of running) {
    const role = server.labels?.role ?? null;
    if (!role) continue;
    created.push(await createServerSnapshot(env, server, role));
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
  if ((list.firewalls ?? []).length > 0) return list.firewalls[0].id;
  const created = await hzPost(env, '/firewalls', { name, rules });
  return created.firewall?.id ?? null;
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
mkdir -p /opt/samplemonk
apt-get update -qq
apt-get install -y -qq git curl rsync python3 python3-venv
curl -fsSL https://get.docker.com | sh
# P-4: Token NICHT in der Clone-URL (landet sonst in .git/config) – stattdessen
# als Einmal-Header übergeben und das Remote danach auf die saubere URL setzen.
GIT_AUTH_HEADER="AUTHORIZATION: basic $(printf 'x-access-token:%s' '${token}' | base64 -w0)"
git -c http.extraheader="$GIT_AUTH_HEADER" clone --depth 1 https://github.com/kAInplanmusic/audioMONASTRY.git /opt/samplemonk 2>/dev/null \\
  || git -C /opt/samplemonk pull
git -C /opt/samplemonk remote set-url origin https://github.com/kAInplanmusic/audioMONASTRY.git
cat > /opt/samplemonk/.env <<'ENVEOF'
${envLines}
ENVEOF
cd /opt/samplemonk
case "${role}" in
  app)
    # P-7b: Origin-TLS mit Cloudflare-Origin-Zertifikat (falls Secrets gesetzt).
    if [ -n "\${ORIGIN_CERT:-}" ] && [ -n "\${ORIGIN_KEY:-}" ]; then
      mkdir -p /opt/samplemonk/certs
      echo "\${ORIGIN_CERT}" | base64 -d > /opt/samplemonk/certs/origin.crt
      echo "\${ORIGIN_KEY}" | base64 -d > /opt/samplemonk/certs/origin.key
      chmod 600 /opt/samplemonk/certs/origin.key
      cp scripts/hetzner/Caddyfile.origin Caddyfile
    fi
    docker compose -f docker-compose.hetzner.yml up -d caddy sample-monk
    ;;
  sfu)
    echo "SFU_ANNOUNCED_IP=$(hostname -I | awk '{print $1}')" >> .env
    docker compose -f docker-compose.hetzner.yml -f docker-compose.sfu.yml up -d caddy sample-monk
    ;;
  master)
    docker compose -f docker-compose.hetzner.yml up -d master-player
    ;;
  edge)
    docker compose -f docker-compose.hetzner.yml -f docker-compose.monitoring.yml up -d
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
Description=sampleMONK stem-ai (Demucs CPU-Fallback)
After=network.target
[Service]
Type=simple
WorkingDirectory=/opt/samplemonk/services/stem-ai
Environment=AI_DEVICE=cpu
ExecStart=/opt/samplemonk/services/stem-ai/.venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000
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
  bash /opt/samplemonk/scripts/hetzner/install-idle-shutdown.sh || true
fi
touch /root/.samplemonk-bootstrap-done
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

function studioCookie(env) {
  return `studio=${encodeURIComponent(env.STUDIO_ACCESS_TOKEN)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400; Secure`;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------
async function computeStatus(env) {
  const servers = await fleetServers(env);
  const existing = Object.values(servers);
  if (existing.length === 0) return { state: 'off', created: 0, total: FLEET.length };

  const app = servers['samplemonk-app-1'];
  const running = existing.filter((s) => s.status === 'running').length;

  if (app && app.status === 'running') {
    const ip = app.public_net?.ipv4?.ip;
    if (ip) {
      try {
        // Health-Check über die Domain (Host/SNI = Domain, Origin-Zertifikat)
        // und resolveOverride direkt auf die Origin-IP – kein Host=IP,
        // kein HTTP-Redirect auf https://IP.
        const healthUrl = `https://${PORTAL_DOMAIN}/api/health`;
        const res = await fetch(healthUrl, { cf: { resolveOverride: ORIGIN_HOST } });
        if (res.ok) {
          return { state: 'ready', created: existing.length, total: FLEET.length, running, url: '/', appIp: ip };
        }
        return { state: 'starting-app', created: existing.length, total: FLEET.length, running, appIp: ip, healthError: `HTTP ${res.status}` };
      } catch (err) {
        /* App antwortet noch nicht */
        return { state: 'starting-app', created: existing.length, total: FLEET.length, running, appIp: ip, healthError: String((err && err.message) || err) };
      }
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
async function startFleet(env) {
  const servers = await fleetServers(env);
  if (Object.keys(servers).length > 0) return { started: false, message: 'Flotte existiert bereits.' };

  const sshKeyId = await ensureSshKey(env);
  const cfIps = await cloudflareIpRanges();
  const snapshots = await listSnapshots(env);
  const created = [];
  const usedSnapshots = {};
  const fallbackRoles = [];

  for (const item of FLEET) {
    const fwName = `samplemonk-${item.role}`;
    const fwId = await ensureFirewall(env, fwName, firewallRules(item.role, item.role === 'app' ? cfIps : []));
    // OPS-Snapshot: zuerst das Rollen-Snapshot-Image verwenden (schneller
    // Start, kein cloud-init-Bootstrap). Fallback: Basis-Image + cloud-init.
    const snap = findSnapshot(snapshots, item.role);
    const payload = {
      name: item.name,
      server_type: item.type,
      image: snap ? snap.id : IMAGE,
      location: LOCATION,
      firewalls: fwId ? [{ firewall: fwId }] : [],
      labels: { app: 'audioMONASTRY', 'managed-by': 'portal-worker', role: item.role },
    };
    if (snap) {
      usedSnapshots[item.role] = { image: snap.id, description: snap.description ?? snap.name ?? '' };
    } else {
      payload.user_data = userData(env, item.role);
      fallbackRoles.push(item.role);
    }
    if (sshKeyId) payload.ssh_keys = [sshKeyId];
    const result = await hzPost(env, '/servers', payload);
    if (result.server?.id) created.push(item.name);
  }

  // FLEET-WIRING: Sobald alle Server angelegt sind (app-1-IP bekannt), die
  // Firewalls für master/ai um app-IP-beschränkte Service-Ports ergänzen.
  if (created.length === FLEET.length) {
    try { await openFleetPorts(env); } catch (e) { console.warn('[portal] openFleetPorts:', e?.message ?? e); }
  }

  return { started: true, created, usedSnapshots, fallbackRoles };
}

/**
 * Öffnet die Flotten-Service-Ports (master-player 8000, stem-ai 8000,
 * Ollama 11434) NUR für die aktuelle app-1-IP – idempotent und bei
 * IP-Wechsel aktualisierend.
 */
async function openFleetPorts(env) {
  const servers = await fleetServers(env);
  const appIp = servers['samplemonk-app-1']?.public_net?.ipv4?.ip ?? '';
  if (!appIp) return { ok: false, message: 'app-1 hat noch keine IP.' };

  const portsByRole = {
    'samplemonk-master': ['8000'],
    'samplemonk-ai': ['8000', '11434'],
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

async function stopFleet(env) {
  const servers = await fleetServers(env);
  const deleted = [];
  for (const s of Object.values(servers)) {
    await hzDelete(env, `/servers/${s.id}`);
    deleted.push(s.name);
  }
  // Auch Floating-IPs löschen, damit wirklich 0 € Kosten entstehen
  // (Floating-IPs werden sonst weiter reserviert und abgerechnet).
  const fips = await hzGet(env, '/floating_ips?per_page=100');
  const fipDeleted = [];
  for (const fip of fips.floating_ips ?? []) {
    await hzDelete(env, `/floating_ips/${fip.id}`);
    fipDeleted.push(fip.name ?? fip.ip);
  }
  return { deleted, fipDeleted };
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

async function poll() {
  try {
    const res = await fetch('/api/status');
    const status = await res.json();
    if (status.state === 'off') {
      $('login').style.display = '';
      $('loading').style.display = 'none';
      return;
    }
    $('login').style.display = 'none';
    $('loading').style.display = '';
    renderSteps(status);
    if (status.state === 'ready') {
      $('loadErr').textContent = '✓ Bereit – Weiterleitung …';
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
            'set-cookie': [sessionCookie(env, session), studioCookie(env)],
          },
        });
      }

      if (url.pathname === '/api/wake' && request.method === 'POST') {
        if (!(await checkSession(env, request))) return json({ error: 'nicht eingeloggt' }, 401);
        const result = await startFleet(env);
        return json(result);
      }

      if (url.pathname === '/api/status') {
        if (!(await checkSession(env, request))) return json({ state: 'off', locked: true });
        return json(await computeStatus(env));
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
        return json(await openFleetPorts(env));
      }

      // OPS-Snapshot: erzeugt je laufendem Flotten-Server einen Snapshot
      // (POST /servers/{id}/actions/create_image) und löscht alte Snapshots
      // (Auto-Retention: letzte 2 je Rolle). Nur mit Session-Cookie.
      if (url.pathname === '/api/refresh-snapshots' && request.method === 'POST') {
        if (!(await checkSession(env, request))) return json({ error: 'nicht eingeloggt' }, 401);
        return json(await refreshSnapshots(env));
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
    const app = servers['samplemonk-app-1'];
    if (app && app.status === 'running' && app.public_net?.ipv4?.ip) {
      // Proxy mit ORIGINAL-URL (Host + SNI = Domain, kein Host=IP → kein
      // Cloudflare-Fehler 1003). resolveOverride lenkt die Verbindung auf die
      // Hetzner-Origin-IP, ohne Host/SNI zu verändern.
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
    const app = servers['samplemonk-app-1'];
    const existing = Object.keys(servers);

    if (existing.length === 0) return;

    const shouldDeleteAll = !app || app.status === 'off';
    if (shouldDeleteAll) {
      await stopFleet(env);
      console.log(`[portal] Flotte gelöscht (${existing.length} Server).`);
    }
  },
};
