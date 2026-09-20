# audioMONASTRY auf Hetzner deployen – empfohlene Konfiguration

> Verbindliche Zahlen: siehe docs/INFRA_KONSTITUTION.md.

Stand: 2026-08-25 · Ziel: **günstig testen, später skalieren**, für
Linux-Laptops + iPhones/iPads (Querformat).

---

## 1. Welches Hetzner-Produkt?

Nimm einen **Hetzner Cloud Server** – der ist **ohne Setup-Gebühr** und wird
**stündlich abgerechnet** (mit Monats-Deckel: du zahlst nie mehr als den
Monatspreis). Das ist genau das Modell für günstiges Testen und Event-Betrieb.

> **Preisstand 15.06.2026** (Hetzner hat 2026 zweimal erhöht – die alten
> CPX41/CCX33-Preise in älteren Doku-Ständen sind überholt).

| Produkt | Specs | Preis (netto/Monat) | Für uns |
|---|---|---|---|
| **CX23** (Test/App, x86) | 2 vCPU, 4 GB, 40 GB, 20 TB | **5,49 €** ≈ 0,0088 €/h | Caddy + App + master-player (kein SFU) |
| **CX33** (App+SFU, x86) | 4 vCPU, 8 GB, 80 GB, 20 TB | **8,49 €** ≈ 0,0136 €/h | App + Mediasoup-SFU + Builds |
| **CAX21** (Preis-Leistungs-Sieger, ARM) | 4 vCPU, 8 GB, 80 GB, 20 TB | **10,49 €** ≈ 0,0168 €/h | App-/Master-/Redis-Knoten (kein SFU!) |
| **CAX31** (ARM, mehr RAM) | 8 vCPU, 16 GB, 160 GB, 20 TB | **20,99 €** ≈ 0,0336 €/h | Stem-CPU/AI-Knoten |
| **CPX42** (x86, EU-Nachfolger CPX41) | 8 vCPU, 16 GB, 240 GB, 20 TB | **69,49 €** ≈ 0,1114 €/h | x86-Power, falls ARM nicht geht |
| CCX33 (dediziert) | 8 vCPU, 32 GB, 240 GB, 30 TB | **138,49 €** ≈ 0,2219 €/h | nur noch Spezialfall (Preis +122 %) |

**Empfehlung 2026:**
- **App/Master/Redis/Edge → CAX21** (ARM): beste Preis-Leistung (~3,4× günstiger
  pro GB RAM als CCX33). Node/Python/Caddy/Redis laufen nativ auf ARM64.
- **SFU-Knoten → CX33 oder CPX42 (x86)**: `mediasoup-worker` liefert offizielle
  x86_64-Prebuilds; auf ARM müsste der Worker aus Source gebaut werden
  (machbar, aber mehr Aufwand).
- **Stündlich rechnet sich das richtig**: 4-Stunden-Session auf CAX31 =
  ~0,13 € statt Monatspreis. Deshalb: Idle-Auto-Shutdown nutzen.

> ⚠️ **IPv4 kostet zusätzlich ca. 0,50 €/Monat** (IPv6 ist kostenlos). Cloud-Server
> werden stündlich/minutengenau abgerechnet; löscht du die Instanz, zahlst du nur
> die genutzte Zeit. Skalieren kannst du später jederzeit per Resize oder durch
> zusätzliche Instanzen.

### 1, 2 oder 3 Instanzen?

**Fürs Testen reicht 1 Instanz (CX23 x86).** Auf der einen Box laufen dann
Caddy (HTTPS), audiomonastry (App + API + Signaling), master-player und optional
Redis. Mehr Instanzen brauchst du erst, wenn du Last hast – dann skaliert man
horizontal (Load Balancer, Redis-Signaling, getrennte Services) oder vertikal
(CX23 → CX33/CAX21).

**Flottenrahmen (Stand 2026-09-20):** Die **laufende** Flotte umfasst
**max. 5 Hetzner-Server** – Rollen `app` (Caddy + API + Signaling),
`sfu` (mediasoup, RTP 40000–40099), `ai` (CPU-Fallback/Stem),
`master` (master-player/FFmpeg) und `edge` (Monitoring-Stack); Typen per
`FLEET_TYPE_<ROLLE>`-Env überschreibbar (CLI-Default `cx23`; Portal-Worker-Fallback
`cx33` für app/sfu/ai, `cx23` für master/edge – verbindliche Tabelle:
`docs/SERVER_FLEET.md`). GPU-Inferenz läuft **nicht**
auf diesen Knoten, sondern auf **max. 8 RunPod-Rollen-Endpoints**.
Laufende Flottenkosten (Hetzner + RunPod zusammen) **max. 10 €/h**, Zielband
**5–7,5 €/h**; nur Hetzner bei „AI aus" ≈ 0,054 €/h
(`docs/INFRA_KONSTITUTION.md`).

---

## 2. Instanz automatisch anlegen (empfohlen)

Voraussetzungen: Hetzner-Konto + API-Token (Console → Security → API Tokens),
lokaler SSH-Key (`~/.ssh/id_ed25519.pub`), Python 3.

```bash
# Im Repo audiomonastry/:
HCLOUD_TOKEN=dein-token python3 scripts/hetzner/provision.py

# SFU-Knoten (öffnet zusätzlich RTP-Ports 40000-40099):
HCLOUD_TOKEN=dein-token ROLE=sfu SERVER_NAME=audiomonastry-sfu python3 scripts/hetzner/provision.py

# Ohne Floating IP (z. B. ai-/master-/edge-Knoten):
HCLOUD_TOKEN=dein-token FLOATING_IP_NAME=none SERVER_NAME=audiomonastry-ai python3 scripts/hetzner/provision.py
```

Das Skript erstellt idempotent:

1. SSH-Key in Hetzner Cloud
2. Firewall (nur 22/80/443 + ICMP; bei `ROLE=sfu` zusätzlich UDP/TCP 40000–40099)
3. **Floating IP** (`audiomonastry-floating`, fsn1) – feste IP, überlebt Instanz-Wechsel
   (`FLOATING_IP_NAME=none` überspringt das)
4. Server **CX23**, **Ubuntu 24.04**, **fsn1 (Falkenstein)** (per `SERVER_TYPE`/`LOCATION` änderbar)
5. Floating IP wird dem Server zugewiesen
6. Cloud-Init: Docker, Docker Compose v2, UFW, fail2ban, chrony, zram
   + **Echtzeit-/WebRTC-Sysctl-Tuning** (BBR, große UDP-Buffer für Mediasoup,
   hohe File-Limits für Socket.io)
7. **Floating-IP im OS konfigurieren** (`configure-floating-ip.sh`) – wichtig!
   Hetzner routet Floating-IPs **ohne NAT**; der Server muss die IP selbst auf
   `eth0` haben, sonst antwortet er nicht (Ping/SSH/HTTP timeouten).
8. Wartet auf SSH **und** Cloud-Init-Abschluss (Docker bereit) und gibt die
   Deploy-Befehle aus

### DNS einmalig einrichten (Cloud API)

```bash
# Zone + A/CNAME/TXT idempotent setzen (Floating IP als Ziel):
HCLOUD_TOKEN=dein-token TARGET_IP=91.98.104.74 \
  python3 scripts/hetzner/dns_setup.py --domain anunnakitools.de
```

> **Zwei DNS-Pfade – nicht gleichzeitig produktiv (INFRA-HETZNER-003):** Dieses
> Skript schreibt die Zone bei **Hetzner DNS** (`api.hetzner.cloud`, seit
> 27.05.2026 die gültige Console-API). Im Portalbetrieb läuft der Verkehr
> dagegen über den **Cloudflare-Worker**: `anunnakitools.de` → Worker →
> `origin.anunnakitools.de` (A-Record auf die aktuelle app-1-IP, synchronisiert
> `POST /api/wire-fleet`). Wer den Worker-Pfad fährt, braucht dieses Skript
> nicht; wer den Hetzner-Pfad fährt, braucht den Worker nicht.

Beim Registrar müssen die Hetzner-Nameserver gesetzt sein:

```text
hydrogen.ns.hetzner.com.
oxygen.ns.hetzner.com.
helium.ns.hetzner.de.
```

Manuell geht es natürlich auch:

1. Hetzner Console → **Cloud → Servers → Create Server**
2. **CX23**, Ubuntu 24.04, fsn1/nbg1, SSH-Key hinterlegen
3. Firewall: nur 22, 80, 443 offen
4. Danach:

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y docker.io docker-compose-v2 git ufw
sudo usermod -aG docker $USER   # danach neu einloggen
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw enable
```

---

## 3. Deploy (ein Befehl vom Laptop)

```bash
# Im Repo audiomonastry/ (Floating IP + Domain sind vorbereitet):
DEPLOY_HOST=91.98.104.74 \
DEPLOY_DOMAIN=anunnakitools.de \
DEPLOY_SYNC_ENV=1 \
bash deploy.sh
```

Was `deploy.sh` macht (Default `DEPLOY_MODE=docker`):

1. **Lokaler Image-Build** – `Dockerfile.hetzner` (App) + `services/master-player`
   (kein `npm ci` mehr auf dem Laptop oder VPS)
2. Remote-Rollback-Image sichern (`audiomonastry:hetzner-rollback`)
3. Images per **`docker save | ssh docker load`** übertragen (kein Remote-Build,
   deutlich schneller für stündlich abgerechnete Instanzen)
4. Config (`docker-compose.hetzner.yml`, Services, Skripte) per rsync — **ohne
   `Caddyfile`** (INFRA-HETZNER-002: die Datei auf app-1 ist die Origin-TLS-Variante
   `Caddyfile.origin` des Portal-Workers; ein rsync würde sie auf ACME zurückdrehen.
   Bewusster Wechsel: `DEPLOY_INSTALL_CADDYFILE=1`)
5. `.env` bleibt unangetastet, `DOMAIN=...` wird gesetzt. Upload der lokalen `.env`
   nur mit `DEPLOY_SYNC_ENV=1` (INFRA-HETZNER-001 — der Default ist `0`, weil die
   Knoten-`.env` rollen-skopiert vom Portal-Worker kommt; bei `1` sichert das Skript
   die vorhandene Remote-`.env` vorher nach `.env.bak-predeploy`)
6. `docker compose up -d --no-build` (App + master-player) + Caddy
7. **Health-Wait** auf `/api/health` + Smoke-Test + **Commit-Paritaet**
   (seit PROD-P1-F4: der Container meldet `commit`/`buildTime`; weicht er vom Repo-Stand ab,
   endet der Deploy mit Exit 1 – bewusster Ausweg: `DEPLOY_ALLOW_STALE=1`)

Wichtige Variablen:

| Variable | Default | Zweck |
|---|---|---|
| `DEPLOY_MODE` | `docker` | `docker` (Image-Transfer) oder `node` (start-prod.sh) |
| `DEPLOY_REMOTE_BUILD` | `0` | `1` = Remote-Build statt Image-Transfer (Fallback ohne lokales Docker) |
| `DEPLOY_PLATFORM` | leer | z. B. `linux/amd64` für Cross-Build (Apple Silicon → Hetzner x86) via buildx |
| `DEPLOY_SMOKE` | `1` | Smoke-Test nach Deploy |
| `DEPLOY_SYNC_ENV` | `0` | lokale `.env` hochladen — **überschreibt die rollen-skopierte Knoten-`.env`** (Portal-Worker), nur für frische Knoten ohne Portal setzen |
| `DEPLOY_INSTALL_CADDYFILE` | `0` | `1` = Repo-Caddyfile (ACME) auf den Knoten laden und damit Origin-TLS ersetzen |
| `DEPLOY_PRINT_CONFIG` | `0` | `1` = nur effektive Konfiguration ausgeben (Trockenlauf, kein Build/SSH) |
| `DEPLOY_VERSION` | `package.json` | Versionsstempel im Image (`/api/health` → `version`) |
| `DEPLOY_COMMIT` | `git rev-parse --short HEAD` | Commitstempel im Image (`/api/health` → `commit`). Überschreiben **nur** zur Kennzeichnung eines bewusst abweichenden Stands – der Code kommt weiter aus dem Arbeitsbaum (Rollback: `docs/ORIGIN_TLS_DNS_RUNBOOK.md` §7.1) |
| `DEPLOY_ALLOW_STALE` | `0` | `1` = eine belegte Commit-Abweichung blockiert den Deploy **nicht** (Meldung bleibt laut). Nur mit Begründung |

Die drei Stempel (`BUILD_VERSION`/`BUILD_COMMIT`/`BUILD_TIME`) gehen als Build-Args in
`Dockerfile.hetzner` und sind damit auch im Compose-Build gesetzt
(`docker-compose.hetzner.yml` liest `AUDIOMONASTRY_VERSION`/`AUDIOMONASTRY_COMMIT`/`AUDIOMONASTRY_BUILD_TIME`).

Rollback:

```bash
ssh root@IP 'docker tag audiomonastry:hetzner-rollback audiomonastry:hetzner && \
  cd /opt/audiomonastry && docker compose -f docker-compose.hetzner.yml up -d --no-build --force-recreate audiomonastry'
```

> Nach einem Rollback läuft der Knoten **absichtlich** auf einem anderen Commit als das Repo:
> Preflight, Portal-Wake und `deploy.sh` melden dann `Flotte laeuft Stand <alt>, Repo ist <neu>` und
> blockieren ohne Freigabe (`--allow-stale` / `DEPLOY_ALLOW_STALE=1` / Worker-Variable
> `ALLOW_STALE="1"`). Prüfen, welcher Stand läuft:
> `curl -s https://anunnakitools.de/api/health | python3 -m json.tool` → `commit`/`buildTime`.

> Ohne `DEPLOY_DOMAIN` wird nur HTTP auf der IP getestet – das geht im Desktop-Browser,
> aber **nicht** mit iPhone/iPad-Mikrofon (HTTPS-Pflicht).

### Pflicht-Werte in `.env`

Kopie von `.env.hetzner.example` (oder deine lokale `.env`):

```env
PORT=8080
NODE_ENV=production
DOMAIN=audiomonastry.example          # Pflicht für HTTPS/iOS

# --- Externe Datenbanken (Supabase + R2) ---
SUPABASE_URL=https://DEIN-PROJEKT.supabase.co
SUPABASE_SERVICE_ROLE=sb_secret_...
SUPABASE_PUBLISHABLE=sb_publishable_...
VITE_SUPABASE_URL=https://DEIN-PROJEKT.supabase.co
VITE_SUPABASE_ANON_PUB=eyJ...

CFR2_ACCOUNT_ID=...
CFR2_ACCESS_KEY_ID=...
CFR2_SECRET_ACCESS_KEY=...
CFR2_BUCKET=audiomonastrysamples
VITE_CFR2_ACCOUNT_ID=...
VITE_CFR2_BUCKET=audiomonastrysamples

MASTER_PLAYER_URL=http://master-player:8000
UPLOAD_MAX_MB=100
```

### Datenbank / Storage – Stand

- **Supabase** (Metadaten: `samples`, `music_tracks`, `sample_tags`, `library_links`)
  ist eingerichtet; `database/schema.sql` wurde ausgeführt und die Preset-Bibliothek
  ist bereits synchronisiert.
- **Cloudflare R2** (Bucket `audiomonastrysamples`) ist eingerichtet und per S3-API
  erreichbar.
- Falls du ein frisches Projekt aufsetzt: `database/schema.sql` einmalig im
  Supabase SQL Editor ausführen, dann `POST /api/cloud/sync` aufrufen.

---

## 4. Domain + HTTPS

1. DNS **A-Record** der Domain auf die Hetzner-IPv4 setzen (AAAA optional auf IPv6).
2. In der Server-`.env` `DOMAIN=deine-domain.example` setzen – fertig.
   Das Caddyfile nutzt `{$DOMAIN}` (ohne `:80`-Suffix) → Caddy aktiviert damit
   **automatisches HTTPS** inkl. HTTP→HTTPS-Redirect und Let's-Encrypt.
3. Ohne Domain (`DOMAIN=` leer) fällt Caddy auf `:80` zurück – reiner HTTP-Test
   über `http://IP` (Desktop-Browser only).

> Ohne HTTPS (nur `http://IP:8080`) funktioniert die App zwar im Browser,
> aber **getUserMedia (Mikrofon/WebRTC) wird auf iPhone/iPad blockiert**.

### 4a. Fleet-Wake & Cloudflare-Portal (Produktionssetup anunnakitools.de)

Die Produktionsdomain läuft **hinter dem Cloudflare-Portal-Worker** (`audiomonastry-portal`).
Der Worker bedient `anunnakitools.de/*` und proxied App-Traffic an `origin.anunnakitools.de`
(DNS-Record, der auf die **app-1-Floating-IP** zeigen muss). Zwei Fallstricke und ihre
Lösung – beide am 2026-09-06 live verifiziert:

**1) LE-ACME (http-01) kann hinter dem Worker nicht validieren:**
Der Worker fängt `/.well-known/acme-challenge/*` ab und liefert 521/525 → Let's Encrypt
bricht ab. Caddy loggt `acme_client … challenge failed … 521`.

**Lösung: Cloudflare-Origin-Zertifikat statt LE.** Die Secrets dafür liegen im
Worker-Store (`ORIGIN_CERT`/`ORIGIN_KEY`, base64-kodiert, siehe `.env.portal`).
Installation auf app-1 (manuell oder automatisch – der Worker macht genau das in
`userData()` für neue Knoten).
`scripts/hetzner/Caddyfile.origin` ist dabei der **Rollen-Default** (Portal-Worker-Cloud-Init
*und* `deploy.sh`); das ACME-`Caddyfile` kommt nur noch bewusst auf den Knoten
(`DEPLOY_INSTALL_CADDYFILE=1`). Der komplette Betreiberweg – Cloudflare-Token
(`Zone:DNS:Edit`), Zustandsprüfung per `bash scripts/hetzner/fleet-preflight.sh dns`,
`origin`-A-Record, Zertifikat, Verifikation über die Domain – steht in
**`docs/ORIGIN_TLS_DNS_RUNBOOK.md`**.

```bash
# Rechte: Verzeichnis 700, Schlüsseldateien 600 (nichts anderes darf sie lesen)
# Zertifikate aus .env.portal dekodieren und auf app-1 legen:
ssh root@<app-1-ip> 'mkdir -p /opt/audiomonastry/certs && chmod 700 /opt/audiomonastry/certs'
echo "$ORIGIN_CERT" | base64 -d | ssh root@<app-1-ip> 'cat > /opt/audiomonastry/certs/origin.crt'
echo "$ORIGIN_KEY"  | base64 -d | ssh root@<app-1-ip> 'cat > /opt/audiomonastry/certs/origin.key && chmod 600 /opt/audiomonastry/certs/origin.crt /opt/audiomonastry/certs/origin.key'
# Caddyfile.origin installieren (Default: tls-Direktive auf das CF-Origin-Paar) + Caddy neu starten:
ssh root@<app-1-ip> 'cp /opt/audiomonastry/scripts/hetzner/Caddyfile.origin /opt/audiomonastry/Caddyfile && cd /opt/audiomonastry && docker compose -f docker-compose.hetzner.yml up -d caddy && docker compose -f docker-compose.hetzner.yml restart caddy'
```

**2) origin.anunnakitools.de zeigt nach Fleet-Neuaufbau auf eine alte IP:**
Der Worker löst `ORIGIN_HOST` per DNS auf. Nach jedem provision-Wurf (neue IPs)
muss der A-Record `origin` auf die neue app-1-IP gesetzt werden – das macht
normalerweise `POST /api/wire-fleet` am Portal (Login + „ANMELDEN & STARTEN"),
alternativ manuell über die Cloudflare-API:

```bash
# Zone-ID via /zones?name=anunnakitools.de, dann:
curl -X PATCH "https://api.cloudflare.com/client/v4/zones/<zone>/dns_records/<rec-id>" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" -d '{"content": "<neue-app-1-ip>"}'
```

Nach dem Wake: `curl https://anunnakitools.de/api/health` → `{"status":"ok"}`
(mit Token-Header für geschützte Pfade, siehe Stress-/Smoke-Tests).

**SFU-Knoten (sfu-1) zusätzlich:** Damit der Browser→SFU-Media-Pfad hinter
Cloudflare/NAT funktioniert, stehen in der Remote-`.env` auf sfu-1:

```text
SIGNALING_ALLOWED_ORIGINS=*     # nur für Test-Clients aus beliebigen Kontexten
ENABLE_SFU=1
SFU_ANNOUNCED_IP=<öffentliche-IP-von-sfu-1>   # Mediasoup ICE-Kandidaten
SFU_SIGNALING_PATH=/sfu-signaling
SFU_SIGNALING_URL=http://<öffentliche-IP-von-sfu-1>
TURN_REALM=anunnakitools.de
TURN_URLS=turn:<ip>:3478?transport=udp,turn:<ip>:3478?transport=tcp
TURN_TTL_SECONDS=3600
```

Diese Werte werden **nicht mehr von Hand** gesetzt: `wire-rtc.sh` ermittelt die
öffentliche IP zur Laufzeit und schreibt sie idempotent (Details im nächsten
Abschnitt).

---

## 4b. SFU + TURN im Standardpfad (F6, 2026-09-20)

Vorher war die RTC-Strecke nur „vorbereitet" (Befund F6 aus
`docs/FIXPLAN_2026-09-20_externer_apptest.md`):

* `/api/webrtc-config` lieferte **nur STUN** (Mozilla/Cloudflare), keinen
  `turn:`-Eintrag → Full-Mesh über NAT war für 2–8 Spieler nicht tragfähig.
* Der Client verband die SFU-Signalisierung **same-origin** gegen den
  App-Knoten (`ENABLE_SFU` dort leer) → die socket.io-Anfrage landete in der
  SPA-Auslieferung und der Fehler war nur ein generisches `xhr poll error`.
* `SFU_ANNOUNCED_IP` war auf sfu-1 leer; der Portal-Pfad schrieb dort die
  **private** 10.x-Adresse aus `hostname -I` → von aussen unerreichbare
  ICE-Kandidaten.
* coturn war im Repo vorhanden, wurde aber von **keinem** Flottenskript
  installiert.

### Verdrahtung (ein Befehl je Rolle)

```bash
# auf sfu-1 (Repo unter /opt/audiomonastry)
TURN_STATIC_AUTH_SECRET=<secret> bash scripts/hetzner/wire-rtc.sh sfu
docker compose -f docker-compose.hetzner.yml -f docker-compose.sfu.yml \
               -f docker-compose.turn.yml up -d caddy audiomonastry coturn

# auf app-1 (dieselbe Secret-Quelle; SFU_PUBLIC_IP = öffentliche IP von sfu-1)
SFU_PUBLIC_IP=<sfu-1-ip> TURN_STATIC_AUTH_SECRET=<secret> \
  bash scripts/hetzner/wire-rtc.sh app
docker compose -f docker-compose.hetzner.yml up -d audiomonastry
```

`bash scripts/hetzner/bring-up-fleet.sh` macht genau das automatisch (Schritt
6/8, inkl. Kontrolle von `/api/webrtc-config`). Fehlt
`TURN_STATIC_AUTH_SECRET` in `.env.deploy`, erzeugt der Flottenstart EINES und
sagt laut, dass es beim nächsten Start rotiert (dauerhaft in `.env.deploy`
ablegen).

### Trockenläufe (ohne Netz, ohne Secret — so ist es hier belegt)

```bash
bash scripts/hetzner/wire-rtc.sh sfu --print-config        # ENABLE_SFU/SFU_ANNOUNCED_IP/TURN_*
bash scripts/hetzner/wire-rtc.sh app --print-config        # ENABLE_SFU=0 + SFU-Adresse + TURN
bash scripts/hetzner/bring-up-fleet.sh --print-config      # Rolle + Ports + Schritte
bash -n scripts/hetzner/lib/rtc-fleet.sh scripts/hetzner/wire-rtc.sh
docker compose -f docker-compose.hetzner.yml -f docker-compose.sfu.yml -f docker-compose.turn.yml config --quiet
```

### Ports (eine Quelle: `services/turn/turnserver.conf`)

| Port | Protokoll | Wofür | Firewall der Rolle `sfu` |
|---|---|---|---|
| 3478 | udp + tcp | TURN/STUN (coturn) | ja |
| 49152-49201 | udp + tcp | TURN-Relay-Ports (50 Allokationen) | ja |
| 40000-40099 | udp + tcp | Mediasoup-RTP (SFU) | ja |
| 22, 80, 443 | tcp | SSH/HTTP/HTTPS | ja |

Die Zahlen stehen identisch in `scripts/hetzner/lib/rtc-fleet.sh`,
`scripts/hetzner/provision.py`, `services/portal-worker/src/index.js` und hier;
`tests/test_hetzner_scripts.py` hält sie gegeneinander.

### Umgebungsvariablen

| Variable | Rolle | Bedeutung |
|---|---|---|
| `ENABLE_SFU` | sfu | `1` startet Mediasoup + `/sfu-signaling` in der App |
| `SFU_ANNOUNCED_IP` | sfu | öffentliche IP für ICE-Kandidaten. Leer = der Server ermittelt sie beim Start selbst (Metadata → Cloud-Init-Datei → `api.ipify.org`); eine private Adresse wird nie akzeptiert |
| `SFU_SIGNALING_URL` | app + sfu | absolute Basis-URL der Signalisierung. **Ohne sie verbindet der Client nicht mehr same-origin**, sondern meldet die Ursache |
| `SFU_PUBLIC_URL` | Aufrufer von `wire-rtc.sh` | setzt `SFU_SIGNALING_URL` explizit, z. B. `https://sfu.anunnakitools.de` |
| `TURN_URLS` | app + sfu | CSV mit `turn:`-URLs (UDP **und** TCP) |
| `TURN_STATIC_AUTH_SECRET` | app + sfu | Secret des coturn-REST-Verfahrens; bleibt serverseitig, der Client bekommt nur kurzlebige Credentials |
| `TURN_TTL_SECONDS` | app + sfu | Gültigkeit der Credentials (Default 3600) |
| `TURN_REALM` | sfu | coturn-Realm (Default `anunnakitools.de`) |

### Produktion: SFU über HTTPS (Mixed Content)

`http://<sfu-ip>` funktioniert nur in lokalen/HTTP-Testaufbauten. Die
Produktions-App läuft über HTTPS (Cloudflare) — der Browser blockiert ein
`http://`-Ziel dann als Mixed Content. Für den Produktivbetrieb deshalb:

```bash
# auf sfu-1: DNS-Record (A, DNS-only) sfu.anunnakitools.de -> <sfu-1-ip> anlegen
TURN_STATIC_AUTH_SECRET=<secret> SFU_PUBLIC_URL=https://sfu.anunnakitools.de \
  bash scripts/hetzner/wire-rtc.sh sfu     # setzt auch DOMAIN=<sfu-host> für Caddy/ACME
```

`wire-rtc.sh` warnt laut, wenn nur `http://` gesetzt ist; der Client meldet den
Mixed-Content-Fall in Klartext (`SettingsDialog` → „SFU nicht erreichbar" +
Grund). Der DNS-Eintrag muss **DNS-only** (kein Cloudflare-Proxy) sein, sonst
landet WebRTC-UDP am Edge.

### Verifikation

```bash
# 1) Vertrag: /api/webrtc-config enthält turn: + die SFU-Adresse
curl -s https://<domain>/api/webrtc-config -H "x-studio-token: <token>" | python3 -m json.tool
#    erwartet: iceServers mit turn:... (+ username/credential), turn.available=true, sfu.ready=true

# 2) Relay läuft und antwortet (auf sfu-1)
docker logs audiomonastry-coturn | tail -20          # "Relay ports initialization done"
docker exec audiomonastry-coturn turnutils_stunclient 127.0.0.1
ss -lun | grep :3478 ; ss -ltn | grep :3478

# 3) SFU-Medienpfad
BASE_URL=http://<sfu-1-ip> node scripts/hetzner/sfu-rtp-run.mjs   # erwartet ok:true, bytes>0
```

Nicht offline belegbar und deshalb als Restnachweis offen: **zwei Browser
außerhalb des LANs** (echter TURN-Relay-Pfad) sowie die ACME-Zertifikatskette
für `sfu.<domain>`.

---

## 5. Start & Betrieb

```bash
# Status / Logs:
ssh root@IP 'docker compose -f /opt/audiomonastry/docker-compose.hetzner.yml ps'
ssh root@IP 'docker compose -f /opt/audiomonastry/docker-compose.hetzner.yml logs -f audiomonastry'

# Updates:
git pull
DEPLOY_HOST=1.2.3.4 DEPLOY_DOMAIN=audiomonastry.example bash deploy.sh
```

### Smoke-Test

```bash
bash scripts/hetzner/smoke-test.sh https://audiomonastry.example
# oder manuell:
curl -s https://audiomonastry.example/api/health
curl -s https://audiomonastry.example/api/cloud/health
curl -s https://audiomonastry.example/api/master/health
```

---

## 6. Was in der Compose-Datei für Sicherheit sorgt

| Maßnahme | Effekt |
|---|---|
| **Caddy als einziger öffentlicher Port** (80/443) | App + master-player sind intern (`expose`), kein direkter Zugriff |
| Automatisches **HTTPS** (wenn `DOMAIN` gesetzt) | Mikrofon/WebRTC auf iOS, verschlüsselte Uploads |
| **HSTS + Security-Header** (nosniff, DENY, Permissions-Policy) | Browser-Härtung |
| `init: true` (**tini**) | Kein Zombie-Prozess, saubere Signal-Weiterleitung |
| `cap_drop: [ALL]` + `no-new-privileges: true` | Container ohne Linux-Capabilities |
| **`read_only: true` + tmpfs `/tmp`** | Root-Dateisystem unveränderlich |
| **Ressourcen-Limits + Reservations** (memory/cpus) | Kein Dienst kann den Server lahmlegen |
| **Log-Rotation** (10 MB × 3 Dateien) | Festplatte läuft nicht voll |
| `restart: unless-stopped` + **Healthchecks** | Automatischer Neustart bei Absturz |
| `ulimits: nofile 65536` | Viele parallele WebSockets möglich |
| **fail2ban** (Host, via Cloud-Init) | SSH-Brute-Force-Schutz |
| Nur 22/80/443 in der Firewall | Angriffsfläche minimal |

---

## 7. Optionale Integrationen (High-End)

### Redis (Multi-Instanz-Signaling)

Ab 2 App-Knoten teilen sich die Instanzen die Socket.io-Räume über Redis:

```bash
# Auf einem Knoten (z. B. app-1 oder eigener kleiner Knoten):
docker compose -f docker-compose.hetzner.yml --profile fleet up -d redis

# In der .env aller App-Knoten:
REDIS_URL=redis://<redis-host>:6379
```

**Verifiziert (2026-08-29):** Cross-Instanz-Signaling über den Redis-Adapter
(Offer/Answer-Relay zwischen zwei `audiomonastry`-Instanzen) läuft; Test:
`tail -n +2 scripts/hetzner/fleet-redis-test.mjs | docker exec -i -w /app audiomonastry node --input-type=module -`
(Zweite Instanz: `docker-compose.fleet-test.yml` mit `--profile fleet`).

### Monitoring (Prometheus + Grafana + cAdvisor + node-exporter)

```bash
# Auf edge-1 (Rolle edge; NUR der Monitoring-Stack - explizite Service-Liste,
# sonst starten caddy/audiomonastry/master-player aus der Basisdatei mit):
docker compose -f docker-compose.hetzner.yml -f docker-compose.monitoring.yml \
  up -d node-exporter cadvisor prometheus alertmanager grafana

# App-Metriken: /api/metrics (JSON) bzw. /api/metrics?format=prometheus
# (Prometheus scrapt automatisch das Prometheus-Format)
# Grafana: nur auf 127.0.0.1 des Knotens veröffentlicht -> SSH-Tunnel:
#   ssh -L 3000:127.0.0.1:3000 root@<edge-1-ip>   ->   http://127.0.0.1:3000
#   (kein 3000er-Port in der Hetzner-Firewall, kein öffentlicher Listener)
```

Das Grafana-Provisioning (`scripts/hetzner/grafana-provisioning/` + `grafana-dashboards/`)
richtet Datasource und das Dashboard **audioMONASTRY Overview** automatisch ein.

### Lokale KI (Ollama) + Stem-AI

Auf dem ai-1-Knoten (siehe `docs/SERVER_FLEET.md`) die kommentierten
`ollama`-/`stem-ai`-Blöcke in `docker-compose.hetzner.yml` aktivieren.

### Auto-Shutdown (stündliche Abrechnung sparen)

```bash
ssh root@IP 'sudo bash /opt/audiomonastry/scripts/hetzner/install-idle-shutdown.sh'
# IDLE_MINUTES=60 CHECK_INTERVAL=5 sudo -E bash scripts/hetzner/install-idle-shutdown.sh
```

Der systemd-Timer fährt die Instanz herunter, wenn über `IDLE_MINUTES` keine
Aktivität messbar ist (offene WebSockets, SSH, CPU-Load, aktive Container-Jobs).

---

## 8. Troubleshooting kurz

| Symptom | Ursache/Lösung |
|---|---|
| `supabase: error (service_role)` | `SUPABASE_SERVICE_ROLE` falsch/Platzhalter → echten `sb_secret_...`-Key eintragen |
| `r2: not-configured` | R2-Keys prüfen (Access = 32 Hex, Secret = 64 Hex), Bucket-Name in `CFR2_BUCKET` |
| Upload `413` | `UPLOAD_MAX_MB` erhöhen **und** `request_body.max_size` in Caddyfile anpassen |
| iPhone: Mikrofon verweigert | Kein HTTPS → `DOMAIN` in `.env` prüfen, DNS/Let's-Encrypt prüfen |
| master-player offline | `docker compose ... ps` → Container-Logs; Healthcheck wartet 20 s nach Start |
| stem-ai OOM | Nicht auf CX23 betreiben; erst auf CX33 oder eigener Instanz aktivieren |
| Docker-Build OOM auf CX23 | `DEPLOY_MODE=node` testen oder auf CX33 resizen |

## OPS – Hetzner Load Balancer (LB11) erst bei Skalierung (dokumentiert 2026-09-03)

**Trigger:** LB11 erst installieren, wenn **≥ 2 App-Knoten** laufen
(Multi-Session, > 4 User/Session oder HA/Zero-Downtime-Deploys). Für den
aktuellen Betrieb (1× app-1 hinter Cloudflare, max. 4 User/Session) bewusst
NICHT aktiv.

**Architektur (Zielbild):**
```
Cloudflare → Hetzner LB11 (sticky WebSocket-Sessions) → app-1 / app-2
```
- Socket.io-Räume über Redis-Adapter teilen (`REDIS_URL`)
- Mediasoup/SFU nur auf einem dedizierten Knoten
- Session-State/Locking bleiben über den bestehenden Server-Pfad synchron

**Kosten (Stand 04/2026, Europa netto):**
- **0,012 €/h** stundenbasiert, Deckel **7,49 €/Monat**
- 20 TB Traffic inklusive
- Stundenabrechnung → Kosten entstehen nur, solange der LB existiert

**Prüfpunkt (offen, Live):** 2 App-Knoten hinter LB, 4-User-E2E grün
(State-Sync, Locking, Main-Stream stabil); Failover-Test (ein Knoten weg).

## NOMEN-P1-001 · Umbenennung der Ops-Ressourcen (`samplemonk` → `audiomonastry`)

Der Repo- und Flottenname ist seit längerem `audiomonastry` (Endpoints
`audiomonastry-ai-*`, Image `ghcr.io/kainplanmusic/audiomonastry-ai-runtime-runpod`).
Die **Ops-Ressourcen** waren bewusst zurückgestellt, weil sie laufende
Infrastruktur berühren — jetzt sind sie mit umbenannt, **mit Kompatibilität für
den Bestand**:

| Bereich | vorher | jetzt |
|---|---|---|
| Prometheus-Metriken | `samplemonk_http_requests_total`, `samplemonk_ai_cost_usd`, `samplemonk_telemetry_*` | `audiomonastry_*` (27 Zeitreihen inkl. Latenz-Histogramm) |
| Scrape-Job | `job_name: samplemonk` | `job_name: audiomonastry` |
| Alarme/Recording-Rules | `SamplemonkAppDown`, `SamplemonkSloAvailabilityBreach`, … | `AudiomonastryAppDown`, `AudiomonastrySloAvailabilityBreach`, … |
| Dashboard | `samplemonk-overview.json` / uid `samplemonk-overview` | `audiomonastry-overview.json` / uid `audiomonastry-overview` |
| Compose-Service + Container | `sample-monk` / `samplemonk`, `samplemonk-master`, `samplemonk-redis` | `audiomonastry`, `audiomonastry-master`, `audiomonastry-redis` |
| Images | `samplemonk:hetzner`, `samplemonk-master-player:hetzner` | `audiomonastry:hetzner`, `audiomonastry-master-player:hetzner` |
| Deploy-Verzeichnis / Bootstrap | `/opt/samplemonk`, `/root/.samplemonk-bootstrap-done` | `/opt/audiomonastry`, `/root/.audiomonastry-bootstrap-done` |
| systemd/Timer/Logs | `samplemonk-idle-check`, `samplemonk-floating-ip.service`, `samplemonk-*.log` | `audiomonastry-*` |
| Snapshot-Präfix (Hetzner) | `samplemonk-snapshot-` | `audiomonastry-snapshot-` |
| Firewalls | `samplemonk-app/-master/-ai/-sfu` | `audiomonastry-app/-master/-ai/-sfu` |
| Flotten-Servernamen (neu angelegt) | `samplemonk-app-1`, … | `audiomonastry-app-1`, … |
| Container-Pfad/User (Runtime-Image) | `/opt/samplemonk-ai`, User `samplemonk` | `/opt/audiomonastry-ai`, uid 10001 |

**Kompatibilität für den Bestand (nichts bricht durch das Update):**

- `services/portal-worker`: bildet alte Servernamen auf den kanonischen Namen ab
  (`canonicalFleetName`) — eine Flotte, die noch `samplemonk-*` heißt, bleibt über
  `/api/fleet-map`, Status und Stop bedienbar. Alt-Snapshots
  (`samplemonk-snapshot-*`) werden weiter **gefunden** (schneller Start) und
  weiter **aufgeräumt** (Retention); neu angelegt wird mit dem neuen Präfix.
- `server.ts` (`fleetNodeAddress`): liest die Fleet-Map unter dem neuen Namen,
  fällt auf den Altnamen zurück.
- `scripts/hetzner/fleet-names.sh` (`fleet_name`/`fleet_candidates`): löst den
  tatsächlichen Knotennamen auf; `fleet-status.sh` prüft beide Schreibweisen,
  `delete-fleet.sh`/`lifecycle.sh` räumen **beide** auf (sonst bliebe ein
  Alt-Server kostenpflichtig stehen).
- `Dockerfile.manifest` patcht ein Basis-Image: Pfad ist Build-Argument
  (`WORKER_HOME`), Rechte laufen über uid/gid 10001 — damit funktioniert es mit
  dem alten `:8roles-v2` (`--build-arg WORKER_HOME=/opt/samplemonk-ai`) und mit
  dem neuen Basis-Image.

**Was der Betreiber tun muss:**

1. **App neu ausrollen** (neuer Image-Name, neuer Service-Name):
   `docker compose -f docker-compose.hetzner.yml up -d --force-recreate --remove-orphans`
   — `--remove-orphans` entfernt den alten `sample-monk`-Container, sonst laufen
   beide und binden Ports doppelt.
2. **Monitoring neu ausrollen** (Configs/Alarme/Dashboards kommen aus dem Repo):
   Prometheus neu starten, dann `up{job="audiomonastry"}` prüfen. Eigene
   Dashboards/Alarme, die `samplemonk_*` abfragen, auf `audiomonastry_*` umstellen —
   die alten Zeitreihen enden mit dem Update (Metriknamen sind keine Aliase).
3. **Server/Firewalls**: neue Flotten entstehen als `audiomonastry-*`. Bestehende
   `samplemonk-*`-Server dürfen bleiben (Auflösung oben) oder per
   `hcloud server rename <id> audiomonastry-app-1` umbenannt werden — danach die
   Firewall-Namen anpassen.
4. **Snapshots**: `samplemonk-snapshot-*` wird weiter aufgeräumt, aber nur im
   Rahmen der Retention (2 je Rolle). Empfehlung: Restbestand einmalig sichten
   und löschen (`GET /images?type=snapshot`).
5. **Runtime-Image**: das neue Image nutzt `/opt/audiomonastry-ai` und uid 10001 —
   beim Rollout `AI_MODEL_MANIFEST=/opt/audiomonastry-ai/model_manifest.json`
   setzen. Solange alte Images laufen, bleibt der alte Pfad richtig (Paar
   Image+Env gemeinsam wechseln).
6. **Hosts, die noch `/opt/samplemonk` nutzen**: neu provisionieren
   (`provision-fleet.sh` legt `audiomonastry-*` an) — die Skripte sind ab jetzt
   auf den neuen Pfad ausgelegt.

**Regressionsschutz:** `tests/namingConventions.test.ts` prüft **jede** getrackte
Datei auf beide historischen Schreibweisen (`samplemonk`, `sample-monk`) und
lässt nur eine begründete Ausnahmeliste zu (Bestands-Kompatibilität,
Kompatibilitäts-Fixtures, historische SSOT-Notizen). Zusätzlich halten Tests fest,
dass Metriken/Jobs/Alarme/Dashboards den neuen Präfix tragen und dass eine
Altflotte weiter bedient und aufgeräumt wird.
