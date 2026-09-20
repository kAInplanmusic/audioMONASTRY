// Asset-Gate: laedt die Studio-Startseite und meldet fehlende Assets (4xx/5xx).
// Schuetzt vor gebrochenen Bildpfaden nach public/-Umsortierungen.
//
// Stand 2026-09-20 (Produktionsreife-Lauf): das Gate meldete
//   "401 http://localhost:8080/api/webrtc-config?userId=…"
// als gebrochenes Asset. Das ist KEIN kaputtes Asset: /api/webrtc-config haengt
// wie alle /api/*-Routen an der Auth-Middleware (Ausnahmen: /api/health und die
// oeffentlichen Show-Assets). Die Route oeffentlich zu machen waere ein
// Sicherheitsregress - sie liefert TURN-Credentials. Richtig ist deshalb:
//   * 401/403 auf einer AUTH-PFLICHT-Route gilt als erwartet, solange keine
//     Session existiert (die Seite laeuft ohne Login).
//   * Mit STUDIO_ACCESS_TOKEN im env wird die Route ECHT geprueft: sie muss 200
//     liefern und gueltige ICE-Server enthalten (STUN immer, TURN wenn der
//     Knoten verdrahtet ist). So faellt auf, wenn die RTC-Konfiguration in
//     Produktion leer ist - der Fehler, den F6 behoben hat.
const { chromium } = require('playwright');

const BASE = process.env.GATE_URL || 'http://localhost:8080';
const TOKEN = (process.env.STUDIO_ACCESS_TOKEN || '').trim();
//: Routen, bei denen ein 401/403 ohne Session ERWARTET ist (Auth-Middleware).
const AUTH_ROUTES = [/^\/api\/webrtc-config(\?|$)/, /^\/api\/(cloud|online|metrics|idle-signal|session)\b/];

const isExpectedAuthRejection = (status, url) => {
  if (status !== 401 && status !== 403) return false;
  let path;
  try {
    path = new URL(url).pathname + (new URL(url).search || '');
  } catch {
    return false;
  }
  return AUTH_ROUTES.some((re) => re.test(path));
};

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const bad = [];
  const expectedAuth = [];
  page.on('response', (r) => {
    if (r.status() < 400) return;
    const entry = `${r.status()} ${r.url()}`;
    if (isExpectedAuthRejection(r.status(), r.url())) expectedAuth.push(entry);
    else bad.push(entry);
  });
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(8000);
  const images = await page.evaluate(() =>
    Array.from(document.images).map((i) => ({ src: i.getAttribute('src'), ok: i.complete && i.naturalWidth > 0 })),
  );
  const brokenImgs = images.filter((i) => !i.ok);

  // RTC-Konfiguration echt pruefen, wenn ein Token bereitsteht.
  let webrtc = { checked: false };
  if (TOKEN) {
    const resp = await page.request.get(`${BASE}/api/webrtc-config?userId=asset-gate`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Cookie: `studio=${TOKEN}` },
    });
    const body = await resp.json().catch(() => ({}));
    const urls = (body.iceServers || []).flatMap((s) => s.urls || []);
    webrtc = {
      checked: true,
      status: resp.status(),
      iceServers: (body.iceServers || []).length,
      stun: urls.filter((u) => String(u).startsWith('stun:')).length,
      turn: urls.filter((u) => String(u).startsWith('turn')).length,
      turnAvailable: body.turn ? body.turn.available : null,
    };
    if (resp.status() !== 200) bad.push(`RTC-Konfiguration nicht abrufbar: HTTP ${resp.status()}`);
    else if (webrtc.stun === 0) bad.push('RTC-Konfiguration ohne STUN-Server (iceServers leer)');
  }

  console.log(JSON.stringify({ badResponses: bad, expectedAuthRejections: expectedAuth, brokenImages: brokenImgs, webrtc }, null, 2));
  await browser.close();
  process.exit(bad.length === 0 && brokenImgs.length === 0 ? 0 : 4);
})().catch((e) => { console.error('ASSET-GATE-ABBRUCH:', e.message); process.exit(3); });
