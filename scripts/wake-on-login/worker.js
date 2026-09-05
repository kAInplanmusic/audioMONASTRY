/**
 * audioMONASTRY – Wake-on-Login (Cloudflare Worker)
 * ============================================================
 * Läuft KOSTENLOS auf Cloudflare (immer erreichbar, auch wenn alle
 * Hetzner-Server aus sind). Ablauf:
 *   1. GET  /        -> Login-Seite
 *   2. POST /login   -> Passwort prüfen (SHA-256), Hetzner-Flotte poweron
 *   3. GET  /status  -> prüft https://anunnakitools.de/api/health
 *                       (Browser pollt, bis ready, dann Redirect)
 *
 * Sicherheit: Passwort nur als SHA-256-Hash im Code, Hetzner-Token wird beim
 * Deploy injiziert (scripts/wake-on-login/deploy.sh). Repo enthält nur
 * Platzhalter. Login-Rate-Limit: max. 5 Versuche/5 min pro IP (in-memory).
 *
 * Deploy:  bash scripts/wake-on-login/deploy.sh
 */
const HETZNER_TOKEN = '__HETZNER_TOKEN__';
const PASSWORD_SHA256 = '__PASSWORD_SHA256__';
const APP_URL = 'https://anunnakitools.de';
const HETZNER_API = 'https://api.hetzner.cloud/v1';

// In-Memory-Rate-Limit (Worker-Isolates sind kurzlebig; reicht als Bremse)
const attempts = new Map();

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function powerOnFleet() {
  const res = await fetch(`${HETZNER_API}/servers?per_page=50`, {
    headers: { Authorization: `Bearer ${HETZNER_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Hetzner API ${res.status}`);
  const data = await res.json();
  const servers = data.servers || [];
  const off = servers.filter(
    (s) => s.labels && s.labels['managed-by'] === 'samplemonk-provision' && s.status === 'off',
  );
  const results = await Promise.all(off.map(async (s) => {
    const r = await fetch(`${HETZNER_API}/servers/${s.id}/actions/poweron`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${HETZNER_TOKEN}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    return { name: s.name, ok: r.ok };
  }));
  return { started: results.filter(r => r.ok).length, names: results.map(r => r.name) };
}

const LOGIN_PAGE = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>audioMONASTRY – Wake</title>
<style>
  :root { --monk:#7c3aed; --monk2:#22d3ee; --bg:#0a0a12; --fg:#e5e7eb; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:radial-gradient(1200px 600px at 50% -10%, #1e1b3a 0%, var(--bg) 55%);
         color:var(--fg); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .card { width:min(92vw,420px); padding:2.2rem; border:1px solid #ffffff1a; border-radius:18px;
          background:#ffffff08; backdrop-filter:blur(12px); box-shadow:0 30px 80px #00000080; }
  h1 { margin:0 0 .35rem; font-size:1.35rem; letter-spacing:.08em; }
  h1 b { color:var(--monk2); }
  p.sub { margin:0 0 1.8rem; color:#9ca3af; font-size:.85rem; line-height:1.5; }
  input { width:100%; padding:.9rem 1rem; border-radius:10px; border:1px solid #ffffff22;
          background:#00000055; color:var(--fg); font:inherit; outline:none; }
  input:focus { border-color:var(--monk); box-shadow:0 0 0 3px #7c3aed33; }
  button { width:100%; margin-top:1rem; padding:.95rem; border:0; border-radius:10px; cursor:pointer;
           font:inherit; font-weight:700; letter-spacing:.06em; color:white;
           background:linear-gradient(90deg,var(--monk),var(--monk2)); }
  button:disabled { opacity:.55; cursor:wait; }
  #msg { margin-top:1rem; font-size:.85rem; min-height:1.2em; }
  .err { color:#f87171; } .ok { color:#34d399; }
  .spinner { display:inline-block; width:1em; height:1em; border:2px solid #ffffff44;
             border-top-color:#fff; border-radius:50%; animation:spin .8s linear infinite; vertical-align:-.2em; }
  @keyframes spin { to { transform:rotate(360deg); } }
</style>
</head>
<body>
<div class="card">
  <h1>audio<b>MONASTRY</b></h1>
  <p class="sub">Die Flotte ist im Standby (0 €/h).<br>Login startet die Hetzner-Server – danach geht's automatisch in die App.</p>
  <input id="pw" type="password" placeholder="Access-Passwort" autocomplete="current-password" autofocus>
  <button id="go">Server starten</button>
  <div id="msg"></div>
</div>
<script>
const msg = document.getElementById('msg');
const go = document.getElementById('go');
const pw = document.getElementById('pw');
async function doLogin() {
  if (!pw.value) { msg.textContent = 'Passwort eingeben.'; msg.className = 'err'; return; }
  go.disabled = true;
  msg.className = 'ok';
  msg.innerHTML = '<span class="spinner"></span> Starte Flotte …';
  try {
    const res = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw.value }),
    });
    if (res.status === 401) { msg.textContent = 'Falsches Passwort.'; msg.className = 'err'; go.disabled = false; return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    msg.textContent = data.started > 0 ? data.started + ' Server starten …' : 'Server starten …';
    pollStatus();
  } catch (e) {
    msg.textContent = 'Fehler: ' + e.message; msg.className = 'err'; go.disabled = false;
  }
}
async function pollStatus() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('/status?t=' + Date.now());
      const s = await r.json();
      if (s.ready) { window.location.href = '${APP_URL}/'; return; }
      msg.textContent = s.note || ('Warte auf Server … (' + Math.round(i * 5 / 60) + ' min)');
    } catch (e) { /* pollt weiter */ }
    await new Promise(r => setTimeout(r, 5000));
  }
  msg.textContent = 'Timeout – bitte gleich nochmal probieren.'; msg.className = 'err'; go.disabled = false;
}
go.addEventListener('click', doLogin);
pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
</script>
</body>
</html>`;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

    if (url.pathname === '/login' && request.method === 'POST') {
      const now = Date.now();
      const entry = attempts.get(ip) || { count: 0, reset: now + 300000 };
      if (entry.reset < now) { entry.count = 0; entry.reset = now + 300000; }
      entry.count += 1;
      attempts.set(ip, entry);
      if (entry.count > 5) {
        return new Response(JSON.stringify({ error: 'Zu viele Versuche. 5 min warten.' }), { status: 429, headers: { 'Content-Type': 'application/json' } });
      }
      let body = {};
      try { body = await request.json(); } catch { /* noop */ }
      const hash = await sha256Hex(String(body.password || ''));
      if (hash !== PASSWORD_SHA256) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      }
      attempts.delete(ip);
      try {
        const result = await powerOnFleet();
        return new Response(JSON.stringify({ ok: true, started: result.started, servers: result.names }), { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 502, headers: { 'Content-Type': 'application/json' } });
      }
    }

    if (url.pathname === '/status') {
      try {
        const r = await fetch(`${APP_URL}/api/health`, { headers: { 'Cache-Control': 'no-cache' } });
        const text = await r.text();
        const ready = r.ok && text.includes('"ok"');
        return new Response(JSON.stringify({ ready, note: ready ? 'ready' : 'Server booten …' }), { headers: { 'Content-Type': 'application/json' } });
      } catch {
        return new Response(JSON.stringify({ ready: false, note: 'Server noch nicht erreichbar …' }), { headers: { 'Content-Type': 'application/json' } });
      }
    }

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(LOGIN_PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  },
};
