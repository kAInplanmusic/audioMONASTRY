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

> **Zwei Image-Wege, ein Schalter (PERF-P1-005).** `deploy.sh` baut das Image
> entweder lokal und schiebt es hoch (`docker save | ssh docker load`) oder lässt
> es auf dem Knoten bauen (`DEPLOY_REMOTE_BUILD=1`). Der **Flottenstart**
> (`scripts/hetzner/bring-up-fleet.sh`, Schritt 5 ruft `deploy.sh`) setzt seit dem
> 2026-09-21 **`DEPLOY_REMOTE_BUILD=1` als Default**: gemessen ist die Leitung der
> Engpass, nicht der Build — ~1 MB/s hoch, ~2,65 GB Image-Tar (app 1,43 GB +
> master-player 1,22 GB) = **25–40 min je Knoten** gegenüber **~1 min** bei warmem
> Layer-Cache auf dem Knoten (zweimal live auf app-1 gefahren). Abschalten bewusst:
> `DEPLOY_REMOTE_BUILD=0` in der Umgebung. Beide Wege sichern den Rollback-Tag,
> nehmen das Medien-Overlay mit und setzen die Build-Stempel; der gewählte Weg
> steht im Trockenlauf und in Schritt 5 als Klartext im Log. Einzelheiten,
> Messungen und die Rolle des zweiten Images: Abschnitt „Deploy-Wege“ unten.

Wichtige Variablen:

| Variable | Default | Zweck |
|---|---|---|
| `DEPLOY_MODE` | `docker` | `docker` (Image-Transfer) oder `node` (start-prod.sh) |
| `DEPLOY_REMOTE_BUILD` | `0` (`deploy.sh`) / **`1` im Flottenstart** | `1` = Remote-Build statt Image-Transfer (rsync-Delta + Build auf dem Knoten). `deploy.sh` defaultet auf `0`; `bring-up-fleet.sh` reicht per Default `1` durch (PERF-P1-005), abschaltbar per Umgebung |
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
7/9, inkl. Kontrolle von `/api/webrtc-config`). Fehlt
`TURN_STATIC_AUTH_SECRET` in `.env.deploy`, erzeugt der Flottenstart EINES und
sagt laut, dass es beim nächsten Start rotiert (dauerhaft in `.env.deploy`
ablegen).

### Trockenläufe (ohne Netz, ohne Secret — so ist es hier belegt)

```bash
bash scripts/hetzner/wire-rtc.sh sfu --print-config        # ENABLE_SFU/SFU_ANNOUNCED_IP/TURN_*
bash scripts/hetzner/wire-rtc.sh app --print-config        # ENABLE_SFU=0 + SFU-Adresse + TURN
bash scripts/hetzner/bring-up-fleet.sh --print-config      # Rolle + Ports + Schritte + Firewall-Vertrag
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

**EINE Quelle der Metriknamen:** die App selbst. `server/routes/opsRoutes.ts` liefert
`/api/metrics?format=prometheus` (`audiomonastry_*`, Label `source`/`type`), das
Latenz-Histogramm kommt aus `src/core/observability/latencyHistogram.ts`, und
`scripts/hetzner/prometheus.yml` scrapt genau diese Route. Wer im Dashboard eine
Metrik einträgt, prüft sie mit `curl -s -H "Authorization: Bearer $SCRAPE_TOKEN"
'http://<app>:8080/api/metrics?format=prometheus' | grep '^audiomonastry_'` nach —
nicht am Code vorbei raten. Der Altpräfix `samplemonk_` existiert NIRGENDS mehr
(`tests/namingConventions.test.ts` verbietet ihn repo-weit, auch im Dashboard).

Der Vertrag des Dashboards (gültiges JSON, eine Ausdrucksform je Target, Klammern
balanciert, nur veröffentlichte Metriknamen) hängt an
`tests/grafanaDashboardContract.test.ts`. Anlass war der Defekt vom 2026-09-22: in
den Panels 19–22 hatte ein Generator jedes ZEICHEN des PromQL-Ausdrucks als eigenes
Target abgelegt (36/70/52/108 Ein-Zeichen-Targets) — das Dashboard war gültiges JSON,
blieb in Grafana aber leer. Sichtbar wurde das nur an den Panels, nicht am Parser;
der Vertragstest fällt auf genau diesem Stand (3 Tests rot, 270 Verstöße).

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

---

## F10 · Namespace-Parität: Compose-Projekt und Container auf `audiomonastry-*`

**Befund (externer App-Test 2026-09-20):** Auf `sfu-1` und `master-1` heißen
Container und Compose-**Projekt** noch `samplemonk-*`, während Repo und Flotte
`audiomonastry-*` führen. Ursache war kein vergessener String, sondern eine
**Ableitung**: `docker compose` leitet den Projektnamen aus dem Verzeichnis ab, in
dem es läuft. Auf einem Knoten, dessen Repo unter `/opt/samplemonk` liegt, entsteht
beim nächsten `up` ein **zweites** Projekt: eigene Volumes (`samplemonk_caddy_data`),
eigene Container-Labels — während die Container-Namen (`container_name`) gleich
bleiben. Ein Watchdog, der nur den neuen Namen kennt, findet dort nichts.

**Fix (drei Teile, ein Name):**

| Baustein | Datei | Wirkung |
|---|---|---|
| EINE Namensquelle | `scripts/hetzner/fleet-names.sh` | `FLEET_COMPOSE_PROJECT` / `LEGACY_COMPOSE_PROJECT`, `FLEET_HOME` / `LEGACY_FLEET_HOME`; `fleet_name_variants` (Server **und** Container **und** Projekt, neu zuerst), `fleet_compose_project`, `fleet_legacy_home`. Der Altname/Altpfad steht damit genau **einmal** im Repo. |
| Projektname deklarativ | `docker-compose.hetzner.yml` | top-level `name: audiomonastry` — der Projektname gilt auch für Handaufrufe und ist pfad-unabhängig. |
| Projektname explizit im Aufruf | `deploy.sh`, `scripts/hetzner/bring-up-fleet.sh`, `scripts/hetzner/fleet-deploy-live.sh`, `scripts/hetzner/auto-repair.sh`, Portal-Worker (`userData`, Kaltstart) | jeder `docker compose`-Aufruf setzt `COMPOSE_PROJECT_NAME=audiomonastry`; `cloud-init.yaml` legt `/opt/audiomonastry` idempotent an (Pfad = Name). |

**Health-/Snapshot-/Lifecycle-Skripte akzeptieren beide Schreibweisen**
(nicht nur den neuen Namen — sonst wären sie auf dem Bestand stumm):

* `fleet-status.sh`: App-Knoten-Muster kommen jetzt aus `FLEET_PREFIX`/`LEGACY_FLEET_PREFIX`;
  die Container-Liste zeigt das Compose-Projekt je Container (`{{.Label "com.docker.compose.project"}}`)
  und meldet ein Alt-Projekt laut mit Migrationstipp.
* `auto-repair.sh`: löst den laufenden Container zur Laufzeit über `fleet_name_variants`
  auf (App **und** Caddy) und repariert ihn im **kanonischen** Projekt; ein Altname
  erscheint als Klartext-Hinweis im Log.
* `fleet-deploy-live.sh`: der Guard liest das Compose-Arbeitsverzeichnis über beide
  Container-Schreibweisen; `LEGACY_REMOTE_DIR` kommt aus `fleet-names.sh`.
* `lifecycle.sh` (Snapshots) nutzt dieselbe Auflösung über `fleet_candidates`
  (= `fleet_name_variants`) bereits seit NOMEN-P1-001.

### Trockenlauf-Belege (offline, ohne Flotte)

```bash
# 1. Syntax aller geänderten Skripte
for f in deploy.sh scripts/hetzner/fleet-names.sh scripts/hetzner/provision-fleet.sh \
         scripts/hetzner/bring-up-fleet.sh scripts/hetzner/fleet-deploy-live.sh \
         scripts/hetzner/auto-repair.sh scripts/hetzner/fleet-status.sh \
         scripts/hetzner/migrate-project-name.sh; do bash -n "$f" && echo "OK $f"; done

# 2. Projektname in den Trockenläufen
bash scripts/hetzner/provision-fleet.sh --print-config
#   Projekt:   COMPOSE_PROJECT_NAME=audiomonastry   (Zielpfad /opt/audiomonastry)
bash scripts/hetzner/bring-up-fleet.sh --print-config
#   Projekt:   COMPOSE_PROJECT_NAME=audiomonastry   (Zielpfad /opt/audiomonastry, top-level 'name:' in docker-compose.hetzner.yml)
bash scripts/hetzner/fleet-deploy-live.sh --print-config
#   COMPOSE_PROJECT_NAME=audiomonastry   (aus scripts/hetzner/fleet-names.sh)
#   APP_CONTAINER=audiomonastry samplemonk
DEPLOY_PRINT_CONFIG=1 bash deploy.sh
#   DEPLOY_REMOTE_DIR=/opt/audiomonastry
#   COMPOSE_PROJECT_NAME=audiomonastry   (aus scripts/hetzner/fleet-names.sh)
bash scripts/hetzner/auto-repair.sh --print-config
#   App-Container akzeptiert:  audiomonastry samplemonk (neu zuerst, Aufloesung zur Laufzeit)
#   Compose-Projekt:           audiomonastry  (COMPOSE_PROJECT_NAME)
bash scripts/hetzner/migrate-project-name.sh --print-config
#   Compose-Projekt neu: audiomonastry | Compose-Projekt alt: samplemonk | Volumes: samplemonk_* -> audiomonastry_* (KOPIE)

# 3. Der Projektname hängt NICHT mehr am Verzeichnisnamen (Verzeichnis "f10-probe"):
mkdir -p /tmp/f10-probe && cp docker-compose.hetzner.yml docker-compose.monitoring.yml docker-compose.sfu.yml /tmp/f10-probe/
: > /tmp/f10-probe/.env   # nur damit env_file: .env auflösbar ist
cd /tmp/f10-probe && docker compose -f docker-compose.hetzner.yml config | head -3
#   name: audiomonastry
#   services:

# 4. Vertragstests
python3 tests/test_hetzner_scripts.py            # Ran 151 tests ... OK (skipped=1)
# (im Worktree: node_modules des Haupt-Repos nutzen - das Repo-Root hat keine eigene Installation)
/home/patrick/audioMONASTRY/node_modules/.bin/vitest run tests/namingConventions.test.ts   # 5 passed
/home/patrick/audioMONASTRY/node_modules/.bin/tsc --noEmit                                 # 0 Fehler
```

Beobachtet am 2026-09-20 auf dem Arbeitszweig `hermes/fix-F10`: Schritte 1–4 wie
oben, `tsc --noEmit` mit 0 Fehlern. Die Ausgaben sind **offline** erzeugt — kein
Hetzner-/Cloudflare-Aufruf, kein `docker compose up`, keine Knoten-Änderung.

### Deploy-Wege: Registry (GHCR), Remote-Build + `--delete`-Vertrag (PERF-P1-003/004, PROD-P2-REG 2026-09-21)

Gemessen: die Leitung Betreiber-Rechner → Knoten macht ~1 MB/s hoch. Das App-Image
ist 1,43 GB, das master-player-Image 1,22 GB — mit `docker save | ssh docker load`
sind das **25–40 min pro Knoten**, und jeder weitere Knoten zahlt denselben Preis
erneut (`zstd` holt davon nichts: die Layer sind schon gepackt). Deshalb gibt es
**drei** Image-Wege; der Default bleibt der bisherige (`local`), nichts schwenkt
still um:

| Weg | Schalter | Was der Weg tut | Was sonst gleich bleibt |
|---|---|---|---|
| **local** (Default) | `DEPLOY_IMAGE_SOURCE=local` | lokaler Build → `docker save \| ssh docker load` | Rollback-Tag, Medien-Overlay, Build-Stempel |
| **Registry (GHCR)** | `DEPLOY_IMAGE_SOURCE=registry` + `DEPLOY_REGISTRY_IMAGE[_MASTER]` | der **Knoten zieht**: Login → `docker pull` → `docker tag` auf die lokalen Namen. **Kein `docker save`** | Rollback-Tag, Medien-Overlay, Build-Stempel |
| **Remote-Build** | `DEPLOY_REMOTE_BUILD=1` | rsync-Delta + Build **auf** dem Knoten (4 vCPU) | Rollback-Tag, Medien-Overlay, Build-Stempel |

Beide Skripte (`deploy.sh` für App-Rolle + master-player, `scripts/hetzner/fleet-deploy-live.sh <ip>`
für Live-Beweise) fahren denselben Registry-Weg; die Umsetzung liegt **einmal** in
`scripts/hetzner/lib/registry.sh` (Name, Tag, Zugangsdaten, `registry_pull_images`).
Der Knoten zieht GHCR-seitig mit Backbone-Tempo — die langsame Betreiber-Leitung
wird **einmal** bezahlt (erster Push), nicht je Knoten.

#### 1. Einmal pushen: `scripts/hetzner/registry-push.sh`

```bash
bash scripts/hetzner/registry-push.sh --print-config     # Trockenlauf: kein Docker, kein Netz, kein Secret
bash scripts/hetzner/registry-push.sh                    # bauen + pushen (Tag = git-Kurzhash)
bash scripts/hetzner/registry-push.sh --skip-build       # Images liegen schon lokal (z. B. von deploy.sh)
bash scripts/hetzner/registry-push.sh --tag roll-2026-09-21 [--also-version] [--force]
```

* Refs: `ghcr.io/<owner>/audiomonastry:<tag>` und `ghcr.io/<owner>/audiomonastry-master-player:<tag>`.
  `<owner>` kommt aus dem git-Remote (`origin`), kleingeschrieben (GHCR lehnt
  Großbuchstaben ab) — überschreibbar per `REGISTRY_OWNER`, Namen per
  `REGISTRY_APP_NAME`/`REGISTRY_MASTER_NAME`.
* Tag: `git rev-parse --short HEAD`, ohne `.git` die `package.json`-Version;
  `--tag`/`REGISTRY_TAG` überschreibt bewusst.
* **Idempotent:** existiert der Tag in der Registry (`docker manifest inspect`),
  wird **nicht** erneut gepusht (Meldung „uebersprungen (Tag existiert schon)");
  `--force` ist der ausdrückliche Gegenweg.
* Zugangsdaten: `GHCR_USERNAME` + `GHCR_TOKEN` (ersatzweise `GHCR_PASSWORD`) liegen im
  Repo nur unter ihren **Namen** in der `.env`; gelesen werden sie aus der Umgebung oder
  aus `REGISTRY_ENV_FILE` (Default `<repo>/.env`, `none` = nur Umgebung). Der **Wert**
  wird nie ausgegeben und nie als Argument übergeben — er läuft ausschließlich per
  Pipe in `docker login --password-stdin` (auch auf dem Knoten).

#### 2. Ziehen: Registry-Modus des Deploys

```bash
# App-Rolle (App + master-player), Knoten zieht:
DEPLOY_HOST=<ip> DEPLOY_DOMAIN=<domain> \
DEPLOY_IMAGE_SOURCE=registry \
DEPLOY_REGISTRY_IMAGE=ghcr.io/<owner>/audiomonastry:<tag> \
DEPLOY_REGISTRY_IMAGE_MASTER=ghcr.io/<owner>/audiomonastry-master-player:<tag> \
bash deploy.sh

# Live-Beweis-Weg:
DEPLOY_IMAGE_SOURCE=registry DEPLOY_REGISTRY_IMAGE=ghcr.io/<owner>/audiomonastry:<tag> \
  bash scripts/hetzner/fleet-deploy-live.sh <ip>
```

Ohne `DEPLOY_REGISTRY_IMAGE` bildet der Deploy die Referenz selbst (Owner aus dem
git-Remote, Tag aus `git rev-parse --short HEAD`) — **derselbe Tag**, den
`registry-push.sh` gepusht hat, weil beide dieselbe Bibliothek nutzen. Ablauf pro
Knoten: Rollback-Tag `<image>-rollback` → Login (Token per stdin) → `docker pull` →
`docker tag <ref> <lokaler Name>` → `docker compose up -d --no-build [...]
--force-recreate`. Fehlt der Pull, endet der Deploy mit Exit 1, **bevor** ein
Container neu startet (der laufende Stand bleibt aktiv).

Trockenläufe ohne Flotte (beide zeigen die effektive Quelle + Referenz, kein Secret):

```bash
DEPLOY_PRINT_CONFIG=1 bash deploy.sh                    # DEPLOY_IMAGE_SOURCE / DEPLOY_REGISTRY_IMAGE[…]
bash scripts/hetzner/fleet-deploy-live.sh --print-config
```

#### 3. Wächter (Tests)

`RegistryWegTest` in `tests/test_hetzner_scripts.py` fährt den **echten** Codepfad mit
Fake-`docker`/`ssh`/`rsync`/`curl` (kein Netz, kein Knoten, kein Gigabyte):
Trockenlauf ohne Docker, Tag-/Owner-Bildung (Kurzhash → Version), Login **nur** per
stdin (Kanarienvogel-Wert darf weder in argv noch in einer Ausgabe stehen),
Idempotenz (derselbe Tag = kein zweiter Push, `--force` als Gegenprobe), der
komplette Live-Weg im Registry-Modus (**pull/tag, kein `docker save`**) und im
Default-Modus (weiterhin `docker save`, kein pull), plus die Abbruchpfade
(unbekannte Quelle, `registry` im `node`-Modus).

#### Flottenstart: Remote-Build ist dort der Default (PERF-P1-005, 2026-09-21)

Gemessen: die Leitung Betreiber-Rechner → Knoten macht ~1 MB/s hoch, das App-Image
ist 338 MB Tar (zstd holt davon 337 MB — die Layer sind schon gepackt) und
`docker save` überträgt **beide** Images unkomprimiert (~2,65 GB: app 1,43 GB +
master-player 1,22 GB) = 25–40 min je Knoten. Der rsync-Delta derselben Änderung
sind wenige MB, der Build auf dem Knoten mit warmem Layer-Cache ~1 min (zweimal
live auf app-1 gefahren). Deshalb bauen **alle** Deploy-Wege auf Wunsch auf dem
Knoten — und der Flottenstart tut das per Default:

| Weg | Schalter (Default) | Was sonst gleich bleibt |
|---|---|---|
| `deploy.sh` (App-Rolle, master-player) | `DEPLOY_REMOTE_BUILD` (`0`) | Rollback-Tag, Medien-Overlay, Build-Stempel |
| `scripts/hetzner/bring-up-fleet.sh` (Flottenstart, Schritt 5 → `deploy.sh`) | `DEPLOY_REMOTE_BUILD` (**`1`**, PERF-P1-005) | Rollback-Tag, Medien-Overlay, Build-Stempel |
| `scripts/hetzner/fleet-deploy-live.sh <ip>` (Live-Beweis-Deploy) | `DEPLOY_REMOTE_BUILD=1` | Rollback-Tag, Medien-Overlay, Build-Stempel |

Der Flottenstart setzt den Schalter in seinem `deploy.sh`-Aufruf
(`DEPLOY_REMOTE_BUILD="$DEPLOY_REMOTE_BUILD"`) und meldet den gewählten Weg als
Klartext — im Trockenlauf (`--print-config`) und in Schritt 5. So ist im Log
lesbar, **warum** es schnell (Remote-Build, ~1 min) oder langsam (Image-Transfer,
25–40 min) ist, statt nur einer Wartezeit. Abschalten: `DEPLOY_REMOTE_BUILD=0`
in der Umgebung von `bring-up-fleet.sh`.

Beide Image-Wege **sichern vorher** `audiomonastry:hetzner` als `…-rollback` und
geben die Build-Stempel (`AUDIOMONASTRY_VERSION/COMMIT/BUILD_TIME`) mit — ohne sie
stünde `unknown` in `/api/health` und die Commit-Parität (PROD-P1-F4) wäre nicht
prüfbar. Das Medien-Overlay (`-f docker-compose.media.yml`) wird in beiden Wegen
nur dann mitgenommen, wenn auf dem Knoten wirklich Inhalte unter `media/` liegen.

**Das zweite Image ist mit erfasst — ohne eigenen Schritt (PERF-P1-005).**
`audiomonastry-master-player:hetzner` hat einen eigenen Compose-Service mit eigenem
Build-Kontext (`build: ./services/master-player`, `Dockerfile` +
`requirements.lock`); beide Sync-Wege schließen `services/` **nicht** aus, der
Kontext liegt also auf dem Knoten. Der Remote-Build ruft Compose **ohne
Service-Liste** (`docker compose -f … up -d --build`) — damit baut Compose alle
Dienste des Default-Profils mit `build:` in **einem** Aufruf. Belegt ohne Flotte:

```bash
docker compose -f docker-compose.hetzner.yml config --services
# audiomonastry
# caddy
# master-player        <- nur caddy hat kein `build:`
```

Auf **master-1** gibt es gar keinen Transfer-Weg: der Flottenstart startet dort
`docker compose … up -d master-player` (bewusst ohne `--build`). Auf einem frischen
Knoten existiert kein Image, Compose baut es daher aus dem rsyncten Kontext.

> **Bewusst offen (begründet):** Ein erneuter Flottenstart gegen eine
> **Bestandsflotte** zieht einen geänderten `services/master-player`-Stand **nicht**
> nach — `up -d master-player` ohne `--build` lässt ein vorhandenes Image stehen.
> Ein `--build` dort wäre teuer (pip/ffmpeg-Layer auf jedem Knoten bei jedem Lauf)
> und der Flottenstart ist der Kaltstart-Pfad. Nachziehen bewusst explizit:
> `ssh root@<master-ip> 'cd /opt/audiomonastry && COMPOSE_PROJECT_NAME=audiomonastry docker compose -f docker-compose.hetzner.yml up -d --build master-player'`
> (so kommentiert in `bring-up-fleet.sh`).

**`--delete`-Vertrag:** Die Skripte `fleet-deploy-live.sh`, `bring-up-fleet.sh` und
`install-ai1.sh` spiegeln per `rsync --delete` auf den Knoten. Alles, was dort
liegt und nicht ausgeschlossen ist, wird **gelöscht**. Am 2026-09-21 auf der
Flotte gemessen — diese Pfade existieren nur auf dem Knoten:

| Pfad | Wo (gemessen) | warum er bleiben muss |
|---|---|---|
| `media/` | app-1, 3,3 GB | Overlay-Inhalt für `docker-compose.media.yml` (`deliver-media.sh`) — nicht reproduzierbar |
| `certs/` | app-1 (Origin-Paar), sfu-1/edge-1 (leer) | Origin-TLS-Zertifikat, wird per Pipe gesetzt |
| `Caddyfile` | alle Rollen | Knoten-Variante (INFRA-HETZNER-002), Repo-Version ist der ACME-Notausgang |
| `runtime/` | sfu-1, `runtime/coturn/turnserver.conf` (0640) | coturn-Konfig mit dem TURN-Secret, **auf dem Knoten** erzeugt (F6) |
| `public/{data/orchestral,models,music}` | lokal + Mount | Overlay-Bäume, Gigabytes — gehören nicht in den Sync |

Nachprüfbar **vor** jedem Deploy: `DEPLOY_DRY_RUN=2 bash scripts/hetzner/fleet-deploy-live.sh <ip>`
fährt den echten Sync als `--dry-run --itemize-changes` (nur lesend, dann Ende) und
zeigt den Löschplan; `--help` zeigt alle Schalter. Wächter im Repo:
`FleetSyncDeleteGuardTest` in `tests/test_hetzner_scripts.py` (Ausschlüsse für alle
drei Sync-Wege + Gegenprobe gegen den Stand vor dem Fix).

### Medien ohne zweiten Gigabyte-Transfer: R2 + `aria2c -x16` (2026-09-21)

Gemessen: EIN TCP-Strom Betreiber → Knoten macht ~1 MB/s (200 MB in 3:14) — die
3,7 GB Medien (`public/data/orchestral`, `public/models`, optional
`public/music`) sind so **~60 min pro Knoten und je Lieferung**. `rsync` kann das
nicht heilen (die Leitung ist der Engpass, zstd bringt bei den schon gepackten
Formaten wenig). Der neue Weg nutzt zwei Hebel:

| Hebel | Umsetzung | Datei |
|---|---|---|
| Mehrere Verbindungen | `aria2c -x16 -s16 -k1M` auf dem Knoten | `scripts/hetzner/lib/r2-node-fetch.sh` |
| Zwischenspeicher | deterministisches zstd-Archiv in R2, EIN Upload je Baum | `scripts/hetzner/parallel-transfer.sh`, `scripts/hetzner/lib/r2-sigv4.sh` |
| Nutzer-Schalter | `deliver-media.sh <ip> --via-r2` (rsync bleibt Default) | `scripts/hetzner/deliver-media.sh` |

```bash
bash scripts/hetzner/deliver-media.sh <ip> --via-r2                 # orchestral + models
bash scripts/hetzner/deliver-media.sh <ip> --via-r2 --with-music    # nur mit Freigabe
bash scripts/hetzner/parallel-transfer.sh <ip> --src public/models --dest /opt/audiomonastry/media
bash scripts/hetzner/parallel-transfer.sh <ip> --src public/models --dest /opt/audiomonastry/media --print-config
```

* **Deterministisch**: `tar --sort=name --mtime=@0 --owner=0 --group=0
  --numeric-owner | zstd -T0 -6` ⇒ gleicher Inhalt = gleicher Objekt-Schlüssel
  `transfer/<baum>/<sha256>.tar.zst` ⇒ der zweite Knoten lädt **nicht** erneut
  vom Betreiber-Host hoch (`--force-upload` erzwingt es).
* **Integrität**: SHA256 wird **vor** dem Auspacken geprüft (Exit 3 und *kein*
  Auspacken bei Abweichung), danach Dateizahlen (Exit 4). Raten/Dauer kommen
  aus dem Lauf auf dem Knoten.
* **Sicherheit**: Signatur entsteht auf dem Betreiber-Host (`CFS3_*` in `.env`);
  der Knoten bekommt nur eine presignierte GET-URL (TTL 12 h) per stdin in eine
  0600-Datei, die das Knoten-Skript danach löscht. Keine Schlüssel auf dem
  Knoten, kein aws-cli/boto3 (openssl reicht, Signatur ist per Python-Referenz
  im Test verifiziert).
* **Knoten-Voraussetzung**: `aria2c` + `zstd` (apt: `aria2`, `zstd`). Beide stehen
  seit 2026-09-21 in der **Provisionierung** (`scripts/hetzner/cloud-init.yaml`,
  `packages: aria2` + `zstd`, einmaliger apt-Lauf beim Server-Create) — auf einem
  **frischen** Knoten greift `--via-r2` deshalb sofort, ohne Nachinstallation im
  Lauf. Der `--install-missing`-Weg in `deliver-media.sh` bleibt als Rueckfall
  fuer Knoten aus einem Rollen-**Snapshot** bestehen (ein Snapshot bootet ohne
  cloud-init; `MEDIA_R2_NO_INSTALL=1` schaltet ihn ab); ohne `aria2c` laeuft der
  Rueckfall `curl -fL` mit **einem** Strom und sagt es laut. Beleg:
  `MedienWerkzeugeInDerProvisionierungTest` in `tests/test_hetzner_scripts.py`
  (Paketliste der Cloud-Init + Nachweis, dass das apt-Kommando im Knotenskript
  NUR im Wachter `command -v aria2c` steht, also nicht bei jedem Lauf).
* **Erwartungswert (hier NICHT gemessen)**: greift das Limit pro Verbindung,
  liegt die Rate mit 16 Verbindungen ein Vielfaches über 1 MB/s — 3,7 GB wären
  dann in Minuten (statt ~60 min) auf dem Knoten, und jeder weitere Knoten zieht
  dasselbe Objekt aus R2. Kosten: R2-Egress 0; Storage für 3,7 GB ≈ 0,06
  USD/Monat. Die echte Rate nennt der Lauf.
* **Überwachung/Unverändertes**: `docker-compose.media.yml` (READ-ONLY-Mounts)
  und die Überprüfung `du -sh`/`docker exec … ls /app/dist/...` bleiben
  identisch; `deliver-media.sh` liefert in beiden Wegen dasselbe `media/<baum>`.
* **Nachweis offline**: `bash -n` + `python3 tests/test_hetzner_scripts.py`
  (Klassen `ParallelTransferSigV4Test`, `ParallelTransferTrockenlaufTest`,
  `ParallelTransferKnotenVertragTest`, `ParallelTransferR2WegTest`,
  `DeliverMediaViaR2Test`).
* **Nachweis live (nur 39 Bytes)**: mit den echten `CFS3_*`-Schlüsseln aus dem
  Betreiber-`.env` lief am 2026-09-21 ein Selbsttest unter
  `transfer/_selbsttest/`: presigned PUT ok, HEAD 200 („schon vorhanden" greift
  gegen den echten Dienst), presigned GET byte-identisch, presigned DELETE 204,
  Objekt danach weg. Vorrang: eine exportierte `R2_ACCESS_KEY` überschreibt
  `.env` (dokumentiert in `lib/r2-sigv4.sh`) — für echte Läufe
  `env -u R2_ACCESS_KEY -u R2_SECRET_KEY …` benutzen.

### Migration der bestehenden Flotte (nummeriert, idempotent, mit Rückweg)

Das Skript `scripts/hetzner/migrate-project-name.sh` fasst **einen** Knoten an und
prüft jeden Schritt auf seinen Ausgangszustand; ein zweiter Lauf ist ein No-Op.
Es verschiebt **nichts unwiederbringlich**: die Volumes des Alt-Projekts werden
**kopiert**, der Alt-Stand bleibt bis zur ausdrücklichen Bestätigung startfähig.

1. **Bestand lesen (nur lesend, gefahrlos zuerst):**
   `bash scripts/hetzner/migrate-project-name.sh <ip> --role app --dry-run`
   Zeigt laufende Compose-Projekte, die App-/Caddy-Container mit Projekt-Label,
   die Alt-Volumes (`samplemonk_*`), den Zustand beider Verzeichnisse und die
   Kommandos, die im Ernstfall liefen. Kein `down`, kein `mv`, kein `up`.
2. **Bestätigen, welche Rollen der Knoten trägt** (`--role app|sfu|master|edge`);
   ohne `--role` bricht das Skript mit Klartext ab (es würde sonst raten, welche
   Dienste starten).
3. **Migration ausführen** (mit Rückfrage; `--yes` überspringt sie):
   `bash scripts/hetzner/migrate-project-name.sh <ip> --role sfu`
   Ablauf: Alt-Stack `down --remove-orphans` (**ohne** `-v`, die Volumes bleiben),
   Pfad `mv /opt/samplemonk /opt/audiomonastry` (nur wenn das Ziel fehlt),
   Volume-Kopien `samplemonk_<suffix>` → `audiomonastry_<suffix>` (bereits
   gefüllte Ziel-Volumes werden übersprungen = idempotent), Start im neuen Projekt.
4. **Verifizieren:** Das Skript gibt `compose ps` jedes Dienstes **mit**
   `projekt=…`-Label aus und probt Port 80 (app/sfu/edge) bzw. `/health`
   (master). Danach von außen gegenprüfen:
   `bash scripts/hetzner/fleet-status.sh` (zeigt je Knoten `[projekt=…]`; ein
   Alt-Projekt wird laut gemeldet) und
   `bash scripts/hetzner/fleet-preflight.sh check` (Commit-Parität des laufenden
   Knotens).
5. **Fachlich nachprüfen (Live, offen):** 4-User-E2E, SFU-RTP-Pfad und
   `POST /api/online` auf dem migrierten Knoten — das ist ein Live-Beweis und
   steht in `docs/OPS_RUNBOOK.md` („Live-Beweise"). Bis dahin gilt der Knoten als
   migriert, aber nicht als fachlich bestätigt.
6. **Rollback (jederzeit möglich, solange Schritt 7 nicht lief):**
   ```bash
   # neu stoppen (Container+Netz des neuen Projekts, Volumes bleiben):
   ssh root@<ip> 'cd /opt/audiomonastry && COMPOSE_PROJECT_NAME=audiomonastry \
     docker compose -f docker-compose.hetzner.yml [-f <overlay>] down'
   # Alt-Projekt wieder starten (die kopierten Alt-Volumes liegen unverändert):
   ssh root@<ip> 'cd /opt/audiomonastry && COMPOSE_PROJECT_NAME=samplemonk \
     docker compose -f docker-compose.hetzner.yml [-f <overlay>] up -d <dienste>'
   ```
   Läuft ein Rollback, ist der nächste `deploy.sh`-Lauf **bewusst** erneut zu
   migrieren (Schritt 3); die Skripte selbst schreiben nie zurück ins Alt-Projekt.
7. **Erst danach aufräumen** (löscht die kopierten Alt-Volumes endgültig):
   `bash scripts/hetzner/migrate-project-name.sh <ip> --role <rolle> --cleanup-legacy`
   Ohne dieses Flag bleiben die Alt-Volumes liegen — Rückweg inklusive.
8. **Reihenfolge über die Flotte:** pro Knoten einzeln migrieren, `app-1` zuletzt
   (dort hängt Caddy/Origin-TLS und die Domain); Knoten, die noch ein
   Rollen-Snapshot mit Alt-Namen bootet, erst migrieren, dann einen **frischen**
   Snapshot ziehen — sonst kommt der Alt-Zustand beim nächsten Wake zurück.

### Regressionsschutz (Tests)

* `tests/test_hetzner_scripts.py` → `NamespaceParitaetTest`: löst **beide**
  Schreibweisen über `fleet-names.sh` auf denselben Namen ab (Server, Container,
  Projekt, Pfad), prüft `name:` in der Compose-Datei gegen `fleet_compose_project`,
  die Trockenläufe der drei Rollenskripte, den Watchdog gegen ein **gefaktes `docker`**
  im PATH (echter Codepfad: Alt-Container gefunden, Reparatur im kanonischen Projekt,
  Migrationshinweis im Log), den Migrations-Trockenlauf (kein `down -v`, Löschen nur
  nach Bestätigung) und dass der Altname unter `scripts/`/`services/` **nur** in der
  Namensquelle, im Bestands-Leser des Portal-Workers und im dokumentierten
  Basis-Image-Pfad vorkommt.
* `tests/test_hetzner_scripts.py` → `FleetStartRemoteBuildDefaultTest` (PERF-P1-005,
  8 Tests): der Flottenstart setzt `DEPLOY_REMOTE_BUILD=1` als Default und zeigt
  den Weg im Trockenlauf; per Umgebung auf `0` stellbar (Gegenprobe zeigt den
  Transfer-Text); der Schalter steht im `deploy.sh`-Aufruf; ein **echter
  `deploy.sh`-Lauf** mit gefaktem `ssh`/`scp`/`rsync`/`docker` + lokalem
  `/api/health`-Stub beweist, dass im Remote-Build-Modus **kein** `docker save`/
  `docker load` läuft (mit Stempeln + Medien-Overlay im Kommando) und dass die
  Abschaltung wirklich den Transfer fährt; dazu der Beleg, dass
  `audiomonastry-master-player:hetzner` mit `build: ./services/master-player` im
  Default-Profil liegt (ohne Docker übersprungen, mit `docker compose config`
  geprüft).
* `tests/namingConventions.test.ts`: Ausnahmeliste aufgeräumt — die Einträge für
  `fleet-status.sh` und `fleet-deploy-live.sh` sind **entfernt** (beide Dateien
  enthalten den Altnamen nicht mehr), der Eintrag für `tests/test_hetzner_scripts.py`
  ist neu und begründet (Fixture eines Bestands-Knotens im Watchdog-Test).
* Bereits vorher grün und unverändert: `--print-config`-Verträge der Typen/Rollen
  (`ServertypRollenDriftTest`), Edge-Monitoring-Limits, Origin-TLS-Default und das
  Commit-Paritäts-Gate (`BuildParityTest`).

### Offen (bewusst NICHT behauptet)

* Der Live-Lauf der Migration auf `sfu-1`/`master-1` ist **nicht** ausgeführt —
  kein `ssh`, kein `hcloud apply`, kein Compose-`up` aus diesem Auftrag. Schritt 1
  (`--dry-run`) liefert die reale Bestandsaufnahme, erst danach wird migriert.
* Der Flottenstart zieht einen geänderten `services/master-player`-Stand auf einer
  **Bestandsflotte** nicht nach (`up -d master-player` ohne `--build`, siehe
  Abschnitt „Deploy-Wege“). Der Kaltstart-Fall ist gedeckt (auf einem frischen
  Knoten existiert kein Image, Compose baut es dort). Bewusst offen gelassen, weil
  ein `--build` bei jedem Flottenstart ~Minuten Build auf allen Knoten kostet.
* Der Default des Flottenstarts ist **ohne Flotte** belegt (Trockenlauf + gefakte
  Kommandozeile: kein `docker save` im Remote-Build-Modus, `docker compose
  config --services`). Ein echter Flottenstart-Lauf mit Remote-Build auf einem
  frisch provisionierten Knoten ist **nicht** Teil dieses Auftrags (kein Deploy
  gegen die laufende Flotte).
* Ob nach der Migration der volle Flottenfluss (4-User-E2E, SFU-RTP) grün ist,
  bleibt ein Live-Beweis (siehe Schritt 5).

---

## INFRA-HETZNER-014 · Firewall-Regel-Drift: die Knoten sprechen nicht mehr miteinander (2026-09-21)

**Befund (live gemessen 2026-09-21, SSOT-Item `INFRA-HETZNER-014`).** Nach dem
Neuaufbau der Flotte (neue IPs) trugen drei Hetzner-Firewalls noch die Quell-IPs
der **vorherigen** Flotte:

| Firewall | Regel | Quelle IST (vor dem Fix) | gemeint ist |
|---|---|---|---|
| `audiomonastry-app` | tcp/8080 | `167.233.192.196/32` | alte `edge-1` |
| `audiomonastry-ai` | tcp/8000 | `142.132.229.71/32` | alte `app-1` |
| `audiomonastry-ai` | tcp/11434 | `142.132.229.71/32` | alte `app-1` |
| `audiomonastry-master` | tcp/8000 | `142.132.229.71/32` | alte `app-1` |

Folge: **stumm blockierter Querverkehr** — edge-1 durfte die App-Metriken auf
8080 nicht scrapen (der Prometheus-Job `audiomonastry` blieb `health=down`),
app-1 durfte weder Stem-AI/Ollama (`ai:8000`, `ai:11434`) noch master-player
(`master:8000`) erreichen. Von außen war davon nichts zu sehen, weil aller
öffentliche Verkehr über den Cloudflare-Worker läuft: die Domain antwortete
normal, nur die Knoten erreichten sich gegenseitig nicht.

**Warum sich das bei jedem Neuaufbau wiederholt.** Die Regeln entstehen beim
Provisionieren bzw. beim Verdrahten aus festen Werten
(`scripts/hetzner/provision.py`, `services/portal-worker/src/index.js` →
`firewallRules`/`openFleetPorts`), und die Firewalls **überleben die Flotte**:
`delete-fleet.sh` löscht nur Server (nachgeprüft 2026-09-21), und
`ensure_firewall`/`ensureFirewall` finden die Firewall beim nächsten Aufbau über
ihren **Namen** wieder und schreiben nur einzelne Regeln nach. Jeder Neuaufbau
bringt also neue Knoten-IPs zu alten Firewall-Regeln. Der Abgleich ist deshalb
jetzt Teil des Flottenstarts statt ein Handgriff nach dem Start.

### Der Soll-Vertrag (abgeleitet aus der LAUFENDEN Flotte, keine festen IPs)

| Rolle | Firewall | Port/Protokoll | Quelle = IPv4 des Knotens |
|---|---|---|---|
| app-1 | `audiomonastry-app` | tcp/8080 (Monitoring-Scrape) | `edge-1` |
| app-1 | `audiomonastry-ai` | tcp/8000 (Stem-AI) | `app-1` |
| app-1 | `audiomonastry-ai` | tcp/11434 (Ollama) | `app-1` |
| app-1 | `audiomonastry-master` | tcp/8000 (master-player) | `app-1` |

Die Zuordnung wird **zur Laufzeit** aus `GET /servers` gebildet (Server-Namen
`audiomonastry-<rolle>-1` → primäre IPv4) — keine festen Adressen im Skript.
Rollen, die es in der laufenden Flotte nicht gibt, werden gemeldet statt geraten
(Exit ≠ 0, ohne Schreibversuch). Dieselben Zahlen/Quellen stehen in
`services/portal-worker/src/index.js`; `tests/test_hetzner_scripts.py` hält beide
Seiten deckungsgleich.

### Werkzeug

```bash
# Abgleichen + anwenden (Default) - idempotent: sind alle Quellen aktuell,
# faellt KEIN Schreibaufruf an ("unveraendert").
python3 scripts/hetzner/firewall-ensure.py

# Nur zeigen, was passieren wuerde (liest die API, schreibt nichts):
python3 scripts/hetzner/firewall-ensure.py --dry-run

# Netzfrei: Soll-Zuordnung + Pfad der Env-Datei (kein API-Aufruf, kein Token-Wert):
python3 scripts/hetzner/firewall-ensure.py --print-config
```

Das Werkzeug liest `GET /v1/firewalls` und `GET /v1/servers`, ersetzt **nur** die
veralteten Quell-IPv4-Einträge (Host oder `/32`) der vier Vertrags-Regeln durch
die IP des zuständigen Knotens, schickt die **vollständige** Regel-Liste per
`POST /v1/firewalls/<id>/actions/set_rules` und liest danach **frisch** zurück
(Gegenprobe). Es ist **non-destruktiv**:

* ICMP, SSH, andere Ports, Cloudflare-IP-Bereiche, IPv6-Quellen und
  Beschreibungen bleiben unverändert (und werden beim Rücklesen belegt);
* eine Regel, die bereits für `0.0.0.0/0` offen ist, wird **nicht** auf den
  Knoten verengt (das wäre eine Bedeutungsänderung, kein IP-Wechsel);
* fehlende Regeln werden **gemeldet**, aber nicht erfunden — ob ein Port offen
  sein soll, entscheidet der Verdrahtungs-Pfad (`/api/wire-fleet` bzw.
  `firewall-ensure-*.py`).

**Ausgabe** (IPs/Ports/Protokolle, nie Zugangsdaten — der Token erscheint nur als
Länge + Fingerabdruck): Vorher/Nachher je geänderter Regel, Zähler
`geaendert=<n> geprueft=<n>`, und die Firewall-IDs.
**Exit-Codes:** `0` abgeglichen oder schon aktuell · `1` Token fehlt bzw.
Soll-Zustand nicht ableitbar (Rolle fehlt) · `2` API-/Netzfehler · `3` Gegenprobe
weicht nach dem Schreiben ab.

### Im Flottenstart (Schritt 3/9)

```bash
bash scripts/hetzner/bring-up-fleet.sh --yes
#   Schritt 1/9 Flotte provisionieren
#   Schritt 2/9 IPs ermitteln
#   Schritt 3/9 Cross-Node-Firewall-Regeln auf die aktuellen Knoten-IPs abgleichen
```

Der Abgleich läuft **nach** dem Anlegen der Knoten (Schritt 1) und **vor** den
Rollen-Deploys — die Knoten sprechen also vom ersten Moment an miteinander.
Scheitert er, wird das **laut** gemeldet (kein stilles `|| true`); der Start
läuft weiter, weil die Smoke-/RTP-Tests am Ende den Fachzustand prüfen.

```bash
# Abschalten (die Firewall bleibt dann unveraendert, inkl. möglicher Blockade):
FLEET_FIREWALL_ENSURE=0 bash scripts/hetzner/bring-up-fleet.sh --yes
```

Der Trockenlauf `bring-up-fleet.sh --print-config` zeigt den Schalter **und**
druckt die Soll-Zuordnung des Abgleichs mit (netzfrei).

### Belege (read-only, ohne Schreibzugriff auf die laufende Flotte)

Trockenlauf gegen die laufende Flotte am 2026-09-21 (nur GET, kein `set_rules`):

```text
Token: gesetzt (Laenge 64, Fingerabdruck ca5212e5, Quelle: Umgebung)
Knoten der laufenden Flotte:
  audiomonastry-app-1        167.233.91.30
  audiomonastry-edge-1       178.104.175.83
Firewall audiomonastry-app (id 11645573): alle Quell-IPs aktuell
Firewall audiomonastry-ai (id 11645575): alle Quell-IPs aktuell
Firewall audiomonastry-master (id 11645576): alle Quell-IPs aktuell

Alle Quell-IPs sind aktuell - unveraendert (kein Schreibaufruf).
Zaehler: geaendert=0 geprueft=4
```

`tests/test_hetzner_scripts.py` → `CrossNodeFirewallAbgleichTest` und
`FirewallAbgleichImFlottenstartTest` fahren den echten Codepfad gegen einen
lokalen API-Stub: veraltete Quelle wird ersetzt und **jede** andere Regel bleibt
zeichengleich, „schon aktuell“ schreibt nichts, ohne Token entsteht kein
Request, `--print-config`/`--dry-run` schreiben nicht, und eine abweichende
Gegenprobe endet mit Exit ≠ 0.

### Offen (bewusst nicht behauptet)

* Der **schreibende** Lauf dieses Werkzeugs gegen die laufende Flotte ist hier
  nicht ausgeführt (Auftrag: keine Produktiv-Firewall anfassen) — belegt sind
  der netzfreie Trockenlauf und der lesende `--dry-run` gegen die laufende
  Flotte sowie die Vertragstests gegen den Stub. Der Fix der drei Firewalls
  wurde vorher mit dem Prototyp live gefahren (Zustand danach: „alle Quell-IPs
  aktuell“).
* Ob der Portal-Wake (`/api/wire-fleet` → `openFleetPorts`) und dieser Abgleich
  in **derselben** Sekunde laufen, ist nicht serialisiert: beide schreiben
  Regeln. Der Abgleich liest vorher und prüft nachher; ein dazwischenlaufender
  Schreiber würde als fehlgeschlagene Gegenprobe (Exit 3) sichtbar.
* Firewalls kosten bei Hetzner nichts, sie werden beim Flotten-Abbau auch nicht
  gelöscht — der Regelbestand bleibt damit zwischen Sitzungen erhalten. Alt-Regeln
  aus früheren Namensschemata (`samplemonk-*`) räumt weiterhin nur
  `scripts/hetzner/cleanup-legacy-firewalls.py` auf. Der Abbau-Entscheid ist
  unten belegt (**Firewall-Lebenszyklus beim Abbau**).

---

## Firewall-Lebenszyklus beim Abbau (Entscheid 2026-09-21)

**Frage:** soll `delete-fleet.sh` beim Flotten-Abbau auch die Firewalls bzw. deren
Regeln auf den Ausgangszustand zurücksetzen? **Antwort: nein.** Der Abbau löscht
weiterhin nur Server; die Firewalls werden **lesend aufgelistet**
(`GET /firewalls?per_page=50`) und bleiben unangetastet — kein `DELETE`, kein
`set_rules`.

Begründung, in dieser Reihenfolge:

1. **Die Cross-Node-Regeln sind nicht reproduzierbar.** Die vier Vertrags-Regeln
   (app:tcp/8080 ← edge-1, ai:tcp/8000 + tcp/11434 ← app-1, master:tcp/8000 ←
   app-1) legt **kein** Provisionierungspfad an: `provision.py` setzt nur
   22/80/443/ICMP (plus RTP/TURN für die Rolle `sfu`), und `firewall-ensure.py`
   passt ausschließlich **vorhandene** Quell-IPs an — fehlende Regeln werden
   **gemeldet**, nicht erzeugt (Exit bleibt 0). Ein Reset beim Abbau würde beim
   nächsten **CLI**-Aufbau (`bring-up-fleet.sh` ohne Portal-Wake) genau die Ports
   fehlen lassen, deren Blockade INFRA-HETZNER-014 ausgelöst hat: edge→app:8080
   (Metrik-Scrape), app→ai:8000/11434, app→master:8000. Der Block wäre **stumm**,
   weil `/api/health` und die Domain weiter funktionieren.
2. **Ein Löschen spart nichts und kostet Wiederaufbau.** Hetzner berechnet
   Firewalls nicht. `provision.py:ensure_firewall` und der Portal-Worker
   (`ensureFirewall`) finden sie über den **Namen** wieder — ein gelöschter
   Bestand wäre nur Mehrarbeit (und ein neues Risiko: Regeln, die beim Anlegen
   fehlen).
3. **Der Abgleich existiert schon.** Schritt 3/9 des Flottenstarts zieht die
   Quell-IPs der vier Regeln auf die **laufenden** Knoten
   (`python3 scripts/hetzner/firewall-ensure.py`, trocken: `--dry-run`). Der
   Aufbau startet damit in genau dem Zustand, der vor dem Abbau galt — ein Reset
   wäre eine zweite, konkurrierende Wahrheit über denselben Regelsatz.
4. **Gelöscht wird nur, was fachlich tot ist:** ungenutzte Firewalls des
   Alt-Präfixes — `python3 scripts/hetzner/cleanup-legacy-firewalls.py [--apply]`
   (löscht nur bei leerem `applied_to`).

**Beleg (ohne Netz).** `FleetFirewallLebenszyklusTest` in
`tests/test_hetzner_scripts.py` fährt den echten Pfad mit `--yes` gegen ein
gefaktes `curl` und prüft: es werden **nur** Server gelöscht (`DELETE
/v1/servers/<id>`), in der Spur steht **kein** `DELETE` gegen `/firewalls/...`
und **kein** `set_rules`; die Auflistung nennt Name + Regelzahl + Zuweisungen;
eine Rückfrage mit „n" erzeugt **gar keinen** API-Aufruf; ein zweiter Lauf (Server
schon weg) löscht nichts (idempotent). Der Entscheid selbst ist als Wächter im
Test (`docs`-Prüfung) festgehalten — er verschwindet nicht unbemerkt.

### Zusammenspiel Portal-Wake ↔ `firewall-ensure.py` (zwei Schreiber, vier Regeln)

Beide Seiten schreiben **dieselben vier Regeln**, aber mit unterschiedlichem
Verhalten:

| | Portal-Wake (`syncAppFirewall`, `openFleetPorts`) | `firewall-ensure.py` |
|---|---|---|
| Wann | bei **jedem** `/api/wake` und `/api/wire-fleet` | Schritt 3/9 im Flottenstart, sonst manuell |
| Schreibverhalten | setzt `set_rules` **immer** (kein Diff) | schreibt **nur bei Abweichung** (2. Lauf = kein Schreibaufruf) |
| Nachprüfung | keine | liest **frisch** zurück, Exit **3** bei Abweichung |
| Offene Regel (`0.0.0.0/0`) | wird auf die Knoten-IP **verengt** | bleibt **unverändert** (Bedeutungsänderung, kein IP-Wechsel) |
| Fehlende Regel | legt sie an (ai/master) bzw. baut sie mit auf (app:8080) | meldet sie nur („Regel fehlt", Exit 0) |

Ergebnis-Idempotenz: beide erzeugen denselben Zielzustand — ein Portal-Wake auf
einem frisch abgeglichenen Regelsatz erzeugt also **keine** inhaltliche Änderung
(nur Schreibverkehr), und `firewall-ensure` hat nach einem Wake **nichts zu tun**
(`geaendert=0`). Genau das hält `PortalWakeVertragTest`
(`tests/test_hetzner_scripts.py`, Python-Seite) und
`tests/portalWorkerFleetPorts.test.ts` (Portal-Seite, echter Codepfad gegen eine
Fake-Hetzner-API) fest.

**Nicht serialisiert** (bewusst offen, unverändert aus der Vorgängerrunde): laufen
Wake und Abgleich gleichzeitig, gilt „letzter Schreiber gewinnt" — der Abgleich
macht das über die Gegenprobe sichtbar (Exit 3), der Wake gar nicht.

**Befunde aus dieser Prüfung (bewusst NICHT eigenmächtig geändert):**

* `services/portal-worker/src/index.js` (`openFleetPorts`, Filter `baseRules` +
  Neuaufbau der Dienst-Ports, Zeilen 1511-1520): eine für `0.0.0.0/0` **offene**
  Vertrags-Regel wird auf die app-1-IP verengt und verliert dabei ihre
  `description`. `firewall-ensure.py` tut das Gegenteil (siehe Tabelle).
  Beide Verhalten sind gepinnt; eine Angleichung ist eine
  **Betreiberentscheidung** (Portal-Verhalten!).
* `services/portal-worker/src/index.js` Zeilen 325-328 + 338: der Kommentar an
  `cloudflareIpRanges()` sagt „Cache leer lassen -> App-Firewall bleibt zu
  (sicherer Ausfall)", tatsächlich fällt `firewallRules('app', [])` auf
  `0.0.0.0/0` + `::/0` für 80/443 zurück — **weit offen**. Ist die
  Cloudflare-IP-Liste nicht abrufbar, öffnet der nächste Wake den Origin für das
  ganze Internet. Gepinnt in `portalWorkerFleetPorts.test.ts`
  („BEFUND: faellt ohne Cloudflare-IP-Liste auf 0.0.0.0/0 …"). Nicht umgebaut,
  weil das das Sicherheitsverhalten des Portals ändern würde.

---

## sfu-1: `audiomonastry-caddy` bleibt „Created" — bewusst dokumentiert (2026-09-21)

**Befund.** Auf sfu-1 existiert ein Container `audiomonastry-caddy` im Zustand
`Created`, der nie startet. Grund: `docker-compose.hetzner.yml` mountet
`./Caddyfile` aus dem Repo-Verzeichnis des Knotens; auf sfu-1 **fehlt** diese
Datei. Der Repo-Sync schließt `Caddyfile` bewusst aus (`--exclude Caddyfile`,
damit die app-Knoten-Variante `Caddyfile.origin` nicht überschrieben wird), und
kein Rollen-Deploy installiert dort eine Site.

**Kein Ausfall.** Die App fährt `ENABLE_SFU=0` und nutzt sfu-1 ausschließlich als
**TURN-Server** (`turn:<sfu-ip>:3478?transport=udp|tcp`, gemintete
HMAC-Credentials); coturn läuft healthy und `udp/3478` (+ Relay-Bereich) ist in
der sfu-Firewall offen. `https://sfu.<domain>` antwortet mit **000** — auf 443
lauscht nichts. Das ist der dokumentierte Zustand, nicht ein Defekt.

**Warum die Definition bleibt (und nicht entfernt wird).** `caddy` steht im
sfu-Start absichtlich in der Service-Liste (`bring-up-fleet.sh` Schritt 6 und 7,
Portal-Worker): `wire-rtc.sh sfu` setzt `DOMAIN=<sfu-host>` und
`SFU_SIGNALING_URL=https://sfu.<domain>`, und ein HTTPS-Signalisierungspfad
braucht auf diesem Knoten einen Proxy mit Let's-Encrypt-Zertifikat (der
Origin-CA-Weg gilt nur für app-1). Die Definition zu entfernen würde diesen Weg
stumm abschalten — deshalb bleibt sie, und der **fehlende** Baustein (die
Caddyfile) wird benannt.

**Was getan wurde (ohne Zustandsänderung):**

* `wire-rtc.sh sfu` prüft am Ende der Verdrahtung, ob
  `$REPO_ROOT/Caddyfile` auf dem Knoten liegt (übersteuerbar per `CADDYFILE`),
  und meldet es **laut** — inklusive der Klarstellung, dass TURN davon
  unberührt ist und dass diese Verdrahtung vollständig durchgelaufen ist. Kein
  `exit`, keine Regel, kein Zustand: die Meldung macht den Zustand nur sichtbar.
* Der Watchdog (`auto-repair.sh`) greift bei `Created` **nicht** ein: seine
  Caddy-Probe läuft nur für **laufende** Container (`container_running` via
  `docker ps`) — es entsteht keine Restart-Schleife.

**Wenn HTTPS-Signalisierung gewünscht ist** (Betreiber-Schritt, nicht Teil des
Abbaus): ACME-Rollen-Site vom Betreiber-Rechner auf den Knoten bringen und Caddy
neu erzeugen —

```bash
rsync -az Caddyfile root@<sfu-1-ip>:/opt/audiomonastry/Caddyfile   # Repo-Root-Caddyfile ({$DOMAIN})
ssh root@<sfu-1-ip> 'cd /opt/audiomonastry && COMPOSE_PROJECT_NAME=audiomonastry docker compose \
  -f docker-compose.hetzner.yml -f docker-compose.sfu.yml -f docker-compose.turn.yml up -d caddy'
```

Voraussetzung: `DOMAIN=sfu.<domain>` steht in der Knoten-`.env` (setzt
`wire-rtc.sh sfu` aus `SFU_PUBLIC_URL=https://sfu.<domain>`) und der A-Record
`sfu.<domain>` ist **DNS-only** auf sfu-1 gerichtet
(`python3 scripts/hetzner/cf-dns-ensure.py --apply`).

**Beleg (ohne Netz):** `SfuCaddyRestzustandTest` in `tests/test_hetzner_scripts.py`
fährt die sfu-Rolle echt mit `CADDYFILE=<nicht vorhanden>` und belegt: Exit 0,
Warnung im Log, `ENABLE_SFU=1` + `turn:`-URLs in der `.env` und die fertige
coturn-Konfiguration (die Verdrahtung läuft also vollständig durch). Mit einer
**vorhandenen** Datei erscheint keine Warnung.
