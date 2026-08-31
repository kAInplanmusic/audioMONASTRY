# audioMONASTRY Portal (Weg A) – Start/Stopp über anunnakitools.de · 0 €/Monat

> Cloudflare Worker als Weck-Portal: Login auf `anunnakitools.de` → Flotte wird
> automatisch hochgefahren → Ladebildschirm mit großer Zeit → Weiterleitung ins
> Studio. Nach 20 Minuten ohne Nutzung wird die Flotte automatisch **gelöscht**
> (nur Löschen stoppt die Hetzner-Kosten – Aus reicht nicht).

## Was läuft wo?

| Komponente | Ort | Kosten |
|---|---|---|
| Login/Ladebildschirm + Reverse-Proxy | Cloudflare Worker (anunnakitools.de) | **0 €** |
| Hetzner-Flotte (app/sfu/ai/master/edge) | nur bei Bedarf, wird nach 20 min Idle gelöscht | ~39 €/Monat nur solange sie existiert |
| Hetzner Floating-IP | optional, für Weg A nicht nötig | 3 €/Monat (kann gelöscht werden) |

## Voraussetzungen (einmalig)

1. **Cloudflare-Account** (habt ihr schon wegen R2) und Zone `anunnakitools.de`
   bei Cloudflare anlegen (DNS-Umzug: Nameserver beim Registrar/Hetzner auf die
   beiden Cloudflare-Nameserver ändern).
2. **Cloudflare-API-Token** mit Rechten `Workers Scripts: Edit` + `Account Settings: Read`:
   Dashboard → My Profile → API Tokens → Create Token → „Edit Cloudflare Workers".
3. **DNS-Record** in Cloudflare: Typ `A`, Name `@`, Inhalt z. B. `192.0.2.1`
   (Platzhalter), **Proxy aktiv (orange Wolke)**. Der Worker übernimmt danach
   alle Anfragen für die Domain.

## Deploy (einmalig)

```bash
cd services/portal-worker
npm install -g wrangler        # falls nicht vorhanden

# Secrets setzen (Werte aus .env.portal / .env / .env.deploy):
wrangler secret put ADMIN_USER          # admin
wrangler secret put ADMIN_PASSWORD      # Passwort aus .env.portal
wrangler secret put SESSION_SECRET      # aus .env.portal
wrangler secret put STUDIO_ACCESS_TOKEN # Zufallstoken (z. B. openssl rand -hex 32) – schützt /api + Socket.io
wrangler secret put HCLOUD_TOKEN        # aus .env.deploy
wrangler secret put SSH_PUBLIC_KEY      # Inhalt von ~/.ssh/id_ed25519.pub
wrangler secret put GITHUB_TOKEN        # Personal Access Token (repo-Lesen reicht)
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE
wrangler secret put SUPABASE_ANON_PUB
wrangler secret put CFR2_ACCOUNT_ID
wrangler secret put CFR2_ACCESS_KEY_ID
wrangler secret put CFR2_SECRET_ACCESS_KEY
wrangler secret put CFR2_BUCKET
wrangler secret put CFR2_PUBLIC_URL
wrangler secret put REPLICATE_API_TOKEN
# optional: DEEPSEEK_API_KEY, HF_API_KEY, GROQ_API_KEY, MISTRAL_API_KEY

wrangler deploy
```

## Benutzung

1. Browser: `https://anunnakitools.de`
   - Flotte aus → Login-Seite → **ANMELDEN & STARTEN**
   - Ladebildschirm zeigt große Zeit + Schritte (Server erstellen, Docker,
     Deploy, App-Start, Weiterleitung)
   - Sobald bereit: automatische Weiterleitung ins Studio
2. **Stopp (sofort):** `https://anunnakitools.de/portal` → dort im Status oder
   per `POST /api/stop` (eingeloggt). Ansonsten löscht der Cron die Flotte,
   sobald app-1 nach 20 min ohne Nutzung ausgeschaltet wurde.
3. **Admin-Login:** `ADMIN_USER` / `ADMIN_PASSWORD` (Werte liegen in `.env.portal`,
   Passwort wurde separat mitgeteilt).

## Sicherheit & Hinweise

- Session-Cookie ist HMAC-signiert (24 h gültig, `HttpOnly`, `Secure`).
- `GITHUB_TOKEN` braucht nur `repo`-Leserechte für den privaten Repo-Clone im
  cloud-init der Server (empfohlen: eigenes feingranulares Token nur für
  `audioMONASTRY`).
- SFU/WebRTC (Mediasoup, UDP 40000–40099) läuft weiter **direkt** über die
  Server-IP – Cloudflare proxyt nur HTTP/WebSocket.
- Der lokale Weg funktioniert weiterhin:
  `bash scripts/hetzner/bring-up-fleet.sh` bzw. `delete-fleet.sh`.

---

## Fehler 1003 (Direct IP access not allowed) – Checkliste

Ursache: Der Browser erreicht Cloudflare mit einer **IP als Host** (oder die
DNS-/Worker-Route-Konfiguration passt nicht). Reihenfolge der Prüfung:

1. **URL:** immer `https://anunnakitools.de` verwenden – niemals die Hetzner-IP.
2. **DNS (Cloudflare → DNS):** A-Record `@` auf die **Hetzner-app-1-IP** zeigen,
   **Proxy-Status = Orange (proxied)**. Kein Cloudflare-Anycast-IP eintragen.
3. **Worker-Route:** Cloudflare → Workers & Pages → Portal-Worker → Settings →
   **Routes** muss `anunnakitools.de/*` (und `anunnakitools.de`) enthalten –
   sonst läuft der Worker nie und Cloudflare geht direkt zum Origin.
4. **Worker-Code (Proxy):** Proxy nutzt jetzt Original-Host + `resolveOverride`
   auf die Origin-IP (kein Host=IP mehr) – nach dem Deploy des Workers
   (`wrangler deploy`) verschwindet 1003.
