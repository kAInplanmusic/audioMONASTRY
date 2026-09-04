# sampleMONK auf Hetzner deployen – empfohlene Konfiguration

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
Caddy (HTTPS), sample-monk (App + API + Signaling), master-player und optional
Redis. Mehr Instanzen brauchst du erst, wenn du Last hast – dann skaliert man
horizontal (Load Balancer, Redis-Signaling, getrennte Services) oder vertikal
(CX23 → CX33/CAX21).

---

## 2. Instanz automatisch anlegen (empfohlen)

Voraussetzungen: Hetzner-Konto + API-Token (Console → Security → API Tokens),
lokaler SSH-Key (`~/.ssh/id_ed25519.pub`), Python 3.

```bash
# Im Repo samplemonk/:
HCLOUD_TOKEN=dein-token python3 scripts/hetzner/provision.py

# SFU-Knoten (öffnet zusätzlich RTP-Ports 40000-40099):
HCLOUD_TOKEN=dein-token ROLE=sfu SERVER_NAME=samplemonk-sfu python3 scripts/hetzner/provision.py

# Ohne Floating IP (z. B. ai-/master-/edge-Knoten):
HCLOUD_TOKEN=dein-token FLOATING_IP_NAME=none SERVER_NAME=samplemonk-ai python3 scripts/hetzner/provision.py
```

Das Skript erstellt idempotent:

1. SSH-Key in Hetzner Cloud
2. Firewall (nur 22/80/443 + ICMP; bei `ROLE=sfu` zusätzlich UDP/TCP 40000–40099)
3. **Floating IP** (`samplemonk-floating`, fsn1) – feste IP, überlebt Instanz-Wechsel
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
# Im Repo samplemonk/ (Floating IP + Domain sind vorbereitet):
DEPLOY_HOST=91.98.104.74 \
DEPLOY_DOMAIN=anunnakitools.de \
DEPLOY_SYNC_ENV=1 \
bash deploy.sh
```

Was `deploy.sh` macht (Default `DEPLOY_MODE=docker`):

1. **Lokaler Image-Build** – `Dockerfile.hetzner` (App) + `services/master-player`
   (kein `npm ci` mehr auf dem Laptop oder VPS)
2. Remote-Rollback-Image sichern (`samplemonk:hetzner-rollback`)
3. Images per **`docker save | ssh docker load`** übertragen (kein Remote-Build,
   deutlich schneller für stündlich abgerechnete Instanzen)
4. Config (`Caddyfile`, `docker-compose.hetzner.yml`, `.env`, Services) per rsync
5. `.env` wird hochgeladen (wenn `DEPLOY_SYNC_ENV=1`), `DOMAIN=...` gesetzt
6. `docker compose up -d --no-build` (App + master-player) + Caddy
7. **Health-Wait** auf `/api/health` + Smoke-Test

Wichtige Variablen:

| Variable | Default | Zweck |
|---|---|---|
| `DEPLOY_MODE` | `docker` | `docker` (Image-Transfer) oder `node` (start-prod.sh) |
| `DEPLOY_REMOTE_BUILD` | `0` | `1` = Remote-Build statt Image-Transfer (Fallback ohne lokales Docker) |
| `DEPLOY_PLATFORM` | leer | z. B. `linux/amd64` für Cross-Build (Apple Silicon → Hetzner x86) via buildx |
| `DEPLOY_SMOKE` | `1` | Smoke-Test nach Deploy |
| `DEPLOY_SYNC_ENV` | `1` | lokale `.env` hochladen |

Rollback:

```bash
ssh root@IP 'docker tag samplemonk:hetzner-rollback samplemonk:hetzner && \
  cd /opt/samplemonk && docker compose -f docker-compose.hetzner.yml up -d --no-build --force-recreate sample-monk'
```

> Ohne `DEPLOY_DOMAIN` wird nur HTTP auf der IP getestet – das geht im Desktop-Browser,
> aber **nicht** mit iPhone/iPad-Mikrofon (HTTPS-Pflicht).

### Pflicht-Werte in `.env`

Kopie von `.env.hetzner.example` (oder deine lokale `.env`):

```env
PORT=8080
NODE_ENV=production
DOMAIN=samplemonk.example          # Pflicht für HTTPS/iOS

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

---

## 5. Start & Betrieb

```bash
# Status / Logs:
ssh root@IP 'docker compose -f /opt/samplemonk/docker-compose.hetzner.yml ps'
ssh root@IP 'docker compose -f /opt/samplemonk/docker-compose.hetzner.yml logs -f sample-monk'

# Updates:
git pull
DEPLOY_HOST=1.2.3.4 DEPLOY_DOMAIN=samplemonk.example bash deploy.sh
```

### Smoke-Test

```bash
bash scripts/hetzner/smoke-test.sh https://samplemonk.example
# oder manuell:
curl -s https://samplemonk.example/api/health
curl -s https://samplemonk.example/api/cloud/health
curl -s https://samplemonk.example/api/master/health
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
(Offer/Answer-Relay zwischen zwei `sample-monk`-Instanzen) läuft; Test:
`tail -n +2 scripts/hetzner/fleet-redis-test.mjs | docker exec -i -w /app samplemonk node --input-type=module -`
(Zweite Instanz: `docker-compose.fleet-test.yml` mit `--profile fleet`).

### Monitoring (Prometheus + Grafana + cAdvisor + node-exporter)

```bash
# Auf edge-1 (oder eigenem Knoten):
docker compose -f docker-compose.hetzner.yml -f docker-compose.monitoring.yml up -d

# App-Metriken: /api/metrics (JSON) bzw. /api/metrics?format=prometheus
# (Prometheus scrapt automatisch das Prometheus-Format)
# Grafana: http://<knoten>:3000 (Port 3000 gezielt in der Firewall öffnen)
```

Das Grafana-Provisioning (`scripts/hetzner/grafana-provisioning/` + `grafana-dashboards/`)
richtet Datasource und das Dashboard **sampleMONK Overview** automatisch ein.

### Lokale KI (Ollama) + Stem-AI

Auf dem ai-1-Knoten (siehe `docs/SERVER_FLEET.md`) die kommentierten
`ollama`-/`stem-ai`-Blöcke in `docker-compose.hetzner.yml` aktivieren.

### Auto-Shutdown (stündliche Abrechnung sparen)

```bash
ssh root@IP 'sudo bash /opt/samplemonk/scripts/hetzner/install-idle-shutdown.sh'
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
