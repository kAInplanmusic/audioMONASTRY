# ARCHITEKTUR-AUDIT — Hetzner-Flottenintegration (audioMONASTRY)

- **Repo:** `/home/patrick/audioMONASTRY` · **Branch:** `main` · **HEAD:** `902e9c3`
- **Datum:** 2026-09-20 (CEST) · **Modus:** rein lesendes Audit, **kein Produktionscode geändert**
- **Methode:** statische Belege aus dem Arbeitsbaum (`Datei:Zeile`), zusätzlich eine
  read-only Live-Enumeration gegen die Hetzner-Cloud-API (Bearer-Token, nur GET).
- **Ehrlichkeitsklausel:** Keine IP, kein Servertyp und keine Zahl in diesem Dokument ist
  erfunden. Jede Code-Aussage trägt `Datei:Zeile`. Wo etwas nicht zugreifbar oder nicht
  belegbar war, steht ausdrücklich *nicht verifiziert*. Kommentare in Skripten werden als
  „Skript-Kommentar" gekennzeichnet und **nicht** als Ist-Zustand gewertet — genau dort
  liegen die größten Abweichungen.
- **Credential-Regel eingehalten:** `.env*` wurde nie gesourct; der Hetzner-Token wurde per
  `grep | cut` in eine Shell-Variable gezogen (`.env.deploy`, Key-Name `HCLOUD_TOKEN`).
  Tokens/Secrets sind in diesem Dokument **nicht** abgedruckt (auch keine Länge/Werte).

---

## 0. Kurzbefund (Executive Summary)

1. **Der Repo-Soll-Zustand ist nicht eindeutig definiert:** fünf Stellen beschreiben die
   Flotte mit **vier verschiedenen Servertyp-Tabellen** (`provision-fleet.sh:5-9`,
   `services/portal-worker/src/index.js:22-28`, `docs/SERVER_FLEET.md:33-37`,
   `:49-55`, `:157-167`, `README.md:225`) — von `cx23` bis `CAX31`.
2. **Es gibt zwei konkurrierende Orchestratoren** mit unterschiedlichen Typen und
   unterschiedlichen Lebenszyklen: die CLI (`scripts/hetzner/*`) und der Cloudflare-Worker
   (`services/portal-worker/src/index.js`). Nur der Worker läuft im Portalbetrieb
   (Cloudflare-Route → `origin.anunnakitools.de`).
3. **Live verifiziert: 0 Server, 0 Floating-IPs, 12 Firewalls, 10 Snapshots.**
   Das Kostenmodell „delete to save" ist also **aktiv durchgezogen** (Abschnitt 6.1).
4. **Die dokumentierte „feste IP" existiert nicht (mehr):** `.env` nahe liegende
   Floating-IP `audiomonastry-floating` ist live **nicht vorhanden**; `stopFleet` löscht
   Floating-IPs bewusst (`index.js:736-743`), während `delete-fleet.sh:33` und
   `docs/SERVER_FLEET.md:14-15` behaupten, sie bleibe reserviert.
5. **Deploy und Portal-Provisionierung überschreiben sich gegenseitig:** `deploy.sh`
   rsynct das Repo-`Caddyfile` **ohne** Ausschluss (`deploy.sh:135-136`) auf den Knoten und
   überschreibt damit das vom Worker installierte Origin-TLS-Caddyfile
   (`index.js:405-411`, `Caddyfile.origin:14`); mit `DEPLOY_SYNC_ENV=1` (Default,
   `deploy.sh:46`) wird zusätzlich die rollen-spezifische `.env` des Workers
   (`index.js:344-376`) durch die lokale `.env` ersetzt.
6. **Monitoring ist ein Blindflug:** Prometheus auf edge-1 scrapt per Default nur
   `audiomonastry:8080` im lokalen Compose-Netz (`prometheus.yml:47-48`), nicht die
   Produktions-App auf app-1; die Cross-Host-Jobs sind auskommentiert (`:50-58`).
   Alertmanager zeigt ebenfalls auf den **lokalen** Container (`alertmanager.yml:36`).
7. **Zwei belegte Funktionsdefekte in Werkzeugen:** `scripts/hetzner/dns_setup.py` kann
   mit seiner eigenen Pfad-Validierung **keinen** DNS-Aufruf ausführen
   (`dns_setup.py:40` vs. `:72`, `:93`; Beweis in 6.3), und `install-auto-repair.sh` /
   `auto-repair.sh` werden von **keinem** Flottenskript installiert (Beleg in 4.4).

---

## 1. Verwendete Instanzen (Rollen / Typen / IPs / Ports)

### 1.1 Soll-Definition im Repo (CLI-Pfad)

`scripts/hetzner/provision-fleet.sh:49-53` legt genau fünf Knoten an:

| # | Servername | Type-Override (Env) | Default-Typ | Rolle | Firewall | Floating-IP |
|---|---|---|---|---|---|---|
| 1 | `audiomonastry-app-1` (`:49`) | `FLEET_TYPE_APP` (`:45`) | `cx23` | `app` | `audiomonastry-app` | `audiomonastry-floating` |
| 2 | `audiomonastry-sfu-1` (`:50`) | `FLEET_TYPE_SFU` (`:46`) | `cx23` | `sfu` | `audiomonastry-sfu` | `none` |
| 3 | `audiomonastry-ai-1` (`:51`) | `FLEET_TYPE_AI` (`:47`) | `cx23` | `ai` | `audiomonastry-ai` | `none` |
| 4 | `audiomonastry-master-1` (`:52`) | — (hart `cx23`) | `cx23` | `master` | `audiomonastry-master` | `none` |
| 5 | `audiomonastry-edge-1` (`:53`) | — (hart `cx23`) | `cx23` | `app` (**!**) | `audiomonastry-edge` | `none` |

**Befund 1.1 (P2, Doku-Drift im Kopfkommentar):** `provision-fleet.sh:5-7` behauptet für
app-1/sfu-1/ai-1 „CX33 (4 vCPU/8GB)"; die tatsächlich verwendeten Werte sind `cx23`
(`:45-47`). `:9` bezeichnet edge-1 als „Rolle app" — das deckt sich mit `ROLE=app` in
`:53`, ist aber von der `--role`-Hilfe in `provision.py:299-301` („app (Default), sfu …,
master, ai, edge") nicht gedeckt.

**Befund 1.2 (P2, Rolle ≠ Funktion):** Die Rolle `edge` wird im Repo **nirgends** als
Hetzner-Rolle verwendet: `provision.py:131-141` behandelt nur `sfu` (RTP-Ports) und hat für
`ai`/`master` einen leeren Zweig (`:138-141`, nur `pass`); `edge` fällt durch alle
Sonderfälle. edge-1 bekommt damit dieselbe Regelmenge wie app-1 (22/80/443 + ICMP) —
obwohl dort laut `bring-up-fleet.sh:112-114` der Monitoring-Stack läuft und
`bring-up-fleet.sh:140` Grafana auf Port 3000 ankündigt.
**Live-Gegenprobe:** Firewall `audiomonastry-edge` hat live genau 4 Regeln
(icmp/22/80/443, Abschnitt 6.2) — **kein** 3000. Der dokumentierte Grafana-Zugriff
(`bring-up-fleet.sh:140`, `docs/SERVER_FLEET.md:143`, `docs/HETZNER_DEPLOY.md:333`) ist
mit dieser Firewall nicht möglich.

**Befund 1.3 (P1, zwei Typ-Wahrheiten):** Der Portal-Worker provisioniert **andere**
Hardware als die CLI: `index.js:23-25` setzt für app/sfu/ai **`cx33`**, master/edge `cx23`
(`:26-27`). Die Env-Overrides `FLEET_TYPE_*` wirken ausschließlich auf
`provision-fleet.sh` — der Worker kennt sie nicht. Im Portalbetrieb (der produktive Pfad)
sind die `FLEET_TYPE_*`-Vorgaben also wirkungslos.

### 1.2 Weitere Typ-/Standort-Defaults

- `provision.py:286-287`: `--type` Default `os.environ.get("SERVER_TYPE", "cx23")`,
  Hilfe-Text „cx23 = 2 vCPU/4GB/40GB".
- `provision.py:288-289`: `--location` Default `fsn1`; Worker ebenfalls `LOCATION='fsn1'`
  (`index.js:43`).
- `provision.py:290-291` / `index.js:44`: Image `ubuntu-24.04`; `cloud-init.yaml:3`
  ebenfalls „Ubuntu 24.04".
- `provision-fleet.sh:42-44` (Skript-Kommentar) begründet den `cx23`-Default mit
  Hetzner-Knappheit und nennt `cpx22` als Option — **es gibt keinen automatischen
  Fallback**: schlägt der Create fehl, beendet `provision.py:61-68` mit `die()`, ein
  anderer Typ/Standort wird nicht probiert.

### 1.3 Ports und Firewalls (aus Code ableitbar — nicht geraten)

**CLI-Pfad `provision.py:120-151`:** Quelle aller Regeln ist
`all_ips = ["0.0.0.0/0", "::/0"]` (`:120`).
- `:122-123` TCP 22 · `:124-125` TCP 80 · `:126-127` TCP 443 · `:128-129` ICMP
- `:131-137` **nur `role == "sfu"`**: UDP **und** TCP `40000-40099`
- `:142-151` `FIREWALL_EXTRA_PORTS` (Format `proto/port`, kommagetrennt, offen für alle)

**Portal-Pfad `index.js:263-282` (produktiv):**
- `:264-267` ICMP + TCP 22 offen für alle
- `:268-272` **`role == 'app'`**: TCP 80/443 **nur für die Cloudflare-IP-Ranges**
  (Abruf `:247-261`; Fallback bei Fehlschlag: `0.0.0.0/0`, `:270`)
- `:273-276` alle anderen Rollen: TCP 80/443 offen für alle
- `:277-280` **`role == 'sfu'`**: UDP + TCP `40000-40099` offen für alle
- `:689-714` **Fleet-Ports** nach jedem Start: `audiomonastry-master` → TCP 8000,
  `audiomonastry-ai` → TCP 8000 **und** 11434, jeweils **nur** für `<app-1-IP>/32`
  (`:708-713`); Bestandsregeln werden gefiltert und neu geschrieben (`:705-714`).

**Host-Firewall `cloud-init.yaml:70-73`:** UFW erlaubt nur `22/tcp`, `80/tcp`, `443/tcp`,
dann `ufw --force enable`. Die RTP-Ports `40000-40099`, die die Hetzner-Firewall für sfu-1
öffnet, werden von UFW **nicht** geöffnet. Ob UFW in Verbindung mit dem
Docker-iptables-Handling dennoch durchlässt, ist **nicht verifiziert** (Docker umgeht UFW
in der Regel via `DOCKER-USER`-Kette — hier nicht geprüft, weil kein Knoten läuft).

**Mesh-/Sonstige Ports aus den Compose-Dateien:** siehe Abschnitt 2.2.

### 1.4 Nomen, Legacy-Präfix und Aufräumpfade

- `fleet-names.sh:19-20`: `FLEET_PREFIX=audiomonastry-`, `LEGACY_FLEET_PREFIX=samplemonk-`.
- `fleet_name()` (`:33-42`) prüft zur Laufzeit per API, welche Schreibweise existiert;
  `fleet_candidates()` (`:45-49`) liefert beide (neu zuerst).
- Genutzt in `lifecycle.sh:21-26`, `delete-fleet.sh:23-28`, `bring-up-fleet.sh:53-59`.
- Im Worker: `canonicalFleetName()` (`index.js:35-41`), Altpräfix `:32`, Snapshot-Präfixe
  `:48-55` (`audiomonastry-snapshot-` + `samplemonk-snapshot-`).
- **Live-Beleg für den Altbestand:** Alle 10 vorhandenen Snapshots tragen `samplemonk-*`
  (6.1) — der Altpfad ist also weiterhin die Realität, nicht nur Theorie.

### 1.5 IPs im Repo (alle als Beispiel/Kommentar — keine Laufzeit-Defaults)

| Datei:Zeile | IP | Kontext |
|---|---|---|
| `scripts/hetzner/install-ai1.sh:16` | `49.13.65.150` | Beispiel im `HOST="${1:?…}"`-Text |
| `scripts/hetzner/sfu-rtp-run.mjs:11` | `49.13.65.150` | Usage-Kommentar |
| `scripts/hetzner/sfu-rtp-multi-run.mjs:13` | `49.13.65.150` | Usage-Kommentar |
| `scripts/hetzner/stress-test.mjs:12` | `49.13.65.150` | Usage-Kommentar |
| `scripts/hetzner/sfu-stress-test.mjs:17` | `49.13.65.150` | Usage-Kommentar |
| `public/sfu-rtp-test.html:10` | `49.13.65.150` | Beispiel-Query in der Testseite |
| `scripts/hetzner/configure-floating-ip.sh:11,15` | `159.69.102.29` | Beispiel (Floating-IP) |
| `scripts/hetzner/dns_setup.py:14` | `91.98.104.74` | Beispiel-`TARGET_IP` |
| `docs/SERVER_FLEET.md:33-37` | `159.69.102.29`, `49.13.0.226`, `49.13.65.150`, `167.233.22.157`, `167.233.214.220` | „Live-Flotte (Stand 2026-08-30)" |

**Befund 1.4 (P2):** Die im Auftrag genannten Adressen `49.13.0.227` (app-1),
`49.13.0.228` (db-1), `49.13.0.229` (app-2), `49.13.0.230` (sfu-2) kommen im Repo
**nicht** vor (Volltextsuche über den Baum: 0 Treffer für `49.13.0.227|228|229|230`).
Ebenso existieren die Rollen `app-2`, `sfu-2`, `db-1` im Repo **nicht**
(Volltextsuche `audiomonastry-app-2|audiomonastry-sfu-2|audiomonastry-db-1|samplemonk-app-2`
→ 0 Treffer). Das ist Repo-Stand, nicht Live-Stand.

---

## 2. Service-Integration (Container → Rolle)

### 2.1 Basis-Stack `docker-compose.hetzner.yml` (produktiv)

| Service | Zeilen | Ports | Healthcheck | Limits | Besonderheit |
|---|---|---|---|---|---|
| `caddy` | `:38-62` | `80:80`, `443:443`, `443:443/udp` (`:42-45`) | **keiner** | 128M / 0.5 CPU (`:58-62`) | `DOMAIN: ${DOMAIN:-:80}` (`:49`); Volumes `./Caddyfile:ro`, `./certs:ro`, `caddy_data`, `caddy_config` (`:50-54`); `depends_on: audiomonastry` (`:56-57`) |
| `audiomonastry` | `:65-105` | nur `expose 8080` (`:72-73`) | `/api/health` via node-fetch (`:91-96`) | 2G / 2.0 CPU (`:98-105`) | `env_file: .env` (`:76-77`), `read_only: true` + `tmpfs /tmp` (`:84-86`), `ulimits nofile 65536` (`:87-90`), `stop_grace_period 30s` (`:97`) |
| `master-player` | `:108-136` | **`8000:8000` öffentlich** (`:115-116`) | `/health` via python (`:122-127`) | 1G / 1.0 CPU | `read_only`, `tmpfs 512m`; Kommentar `:113-114` behauptet Firewall-Begrenzung auf die app-1-IP (stimmt nur, weil `openFleetPorts` `:689-714` sie setzt) |
| `redis` | `:141-173` | nur `expose 6379` (`:149-150`) | `redis-cli ping` (`:163-168`) | 384M / 0.5 (`:169-173`) | Profil `fleet` (`:145`), `user: redis` (`:148`), `appendonly`, `maxmemory 256mb` (`:151-157`) |
| `midi-bridge` | `:178-195` | `9100:9100` (`:183-184`) | keiner | — | Profil `midi` (`:182`), braucht `/dev/snd` |
| `stem-ai` | `:199-221` | auskommentiert | — | 16G/8 CPU + GPU-Reservation | nur Doku/Commented-out |
| `ollama` | `:227-240` | auskommentiert | — | 12G/8 CPU | nur Doku/Commented-out |

### 2.2 Rollen-Overlays

- **SFU:** `docker-compose.sfu.yml:16-26` ist reines Overlay (Warnung `:1-6`,
  CI-Validierung `:13`): setzt `ENABLE_SFU=1`, `SFU_LISTEN_IP=0.0.0.0`
  (`:18-19`), verlangt `SFU_ANNOUNCED_IP` (`:20`) und publiziert
  `${SFU_PORTS:-40000-40099}` als **UDP und TCP** (`:25-26`). Ports sind damit deckungsgleich
  mit `provision.py:131-137` bzw. `index.js:277-280`.
- **AI:** `docker-compose.ai.yml:6-29` baut `services/audiomonastry-ai-runtime`,
  `AI_RUNTIME_DEVICE=simulated` (`:12`), `ports 8000:8000` (`:18-19`), Healthcheck (`:20-25`).
  Der Kopfkommentar `:3-5` sagt ausdrücklich, dass Produktion **nicht** auf Hetzner läuft —
  die Datei ist also Smoke-Test-Werkzeug, nicht Flottenbestandteil.
  **Konflikt:** `services/portal-worker` provisioniert ai-1 dagegen host-nativ
  (`index.js:424-454`), für die ai-1-Rolle ist `docker-compose.ai.yml` nirgends verdrahtet.
- **Monitoring:** `docker-compose.monitoring.yml` — `node-exporter` (`:36-56`),
  `cadvisor` (`:58-75`, `privileged: true` `:62`), `prometheus` (`:77-110`),
  `alertmanager` (`:114-142`), `grafana` (`:144-162`). **Kein Dienst publiziert Ports**,
  alle nur `expose` (`:50-51`, `:69-70`, `:104-105`, `:136-137`, `:156-157`) → von außen
  grundsätzlich nicht erreichbar. `GF_SECURITY_ADMIN_PASSWORD` fällt auf `admin` zurück
  (`:149`).
  Secret-Handling ist sauber gelöst: Prometheus/Alertmanager ersetzen Platzhalter erst beim
  Containerstart (`:91-100`, `:126-129`) — Begründung in `:85-90` und `:120-125`.
- **Test-Overlays:** `docker-compose.fleet-test.yml` (Redis-Multi-Instanz,
  CI-Validierung `build.yml:78-79`) und `docker-compose.monitoring.proof.yml`
  (`build.yml:80-81`) existieren für CI/Beweise.
- **Dev:** `docker-compose.yml:15-96` (App `8080:8080`, `stem-ai` `8000:8000`,
  `master-player` `8001:8000` `:76-96`) — Ports weichen bewusst von Hetzner ab.

### 2.3 Welche Rolle bekommt welche Container (belegt)

| Rolle | Startbefehl | Beleg |
|---|---|---|
| app-1 | `docker compose -f docker-compose.hetzner.yml up -d caddy audiomonastry` | `index.js:412`; `deploy.sh:179-182` |
| sfu-1 | `-f docker-compose.hetzner.yml -f docker-compose.sfu.yml up -d caddy audiomonastry` | `index.js:416`; `bring-up-fleet.sh:106` |
| master-1 | `-f docker-compose.hetzner.yml up -d master-player` | `index.js:419`; `bring-up-fleet.sh:110` |
| edge-1 | `-f docker-compose.hetzner.yml -f docker-compose.monitoring.yml up -d` (**ohne** Service-Liste) | `index.js:422`; `bring-up-fleet.sh:114` |
| ai-1 | host-nativ: Ollama (systemd) + stem-ai (systemd, Port 8000) | `index.js:424-454`; `scripts/hetzner/install-ai1.sh:27-83` |

**Befund 2.1 (P1, Überbuchung + Rollenvermischung edge-1):** Weil auf edge-1 **ohne**
Service-Liste gestartet wird, entstehen dort zusätzlich `caddy`, `audiomonastry` **und**
`master-player` (Basisdatei enthält alle drei). Die Speicher-Limits dieser acht Container
summieren sich auf **4672 MiB ≈ 4,56 GiB** (App 2048 + master 1024 + caddy 128 +
prometheus 512 + grafana 512 + alertmanager 128 + cadvisor 256 + node-exporter 64 MiB).
Der Default-Typ ist `cx23` mit 4 GB RAM (`provision.py:287`). Ob Compose v2
`deploy.resources.limits` auf dem Knoten tatsächlich als `--memory`/`--cpus` anwendet
(wichtig für diese Rechnung), ist **nicht verifiziert** (kein Knoten läuft).
Zusätzlich läuft auf edge-1 ein **zweiter** `caddy`, der dieselbe `DOMAIN` aus der
rsyncten `.env` sieht (`bring-up-fleet.sh:102,113`) — siehe Befund 4.2.

**Befund 2.2 (P2, fehlende Healthchecks):** `caddy` (`:38-62`), `midi-bridge` (`:178-195`)
und **alle** Monitoring-Services (`:36-162`) haben keinen Healthcheck. Für caddy bedeutet
das: ein toter Reverse-Proxy wird von `container health`-basierten Werkzeugen nicht erkannt
(vgl. `auto-repair.sh:24`, das genau darauf aufsetzt).

**Befund 2.3 (P2, SFU-Announced-IP zweigleisig):** Der Worker setzt
`SFU_ANNOUNCED_IP=$(hostname -I | awk '{print $1}')` (`index.js:415`) — das ist die
**erste** Adresse aller Interfaces, nicht zwingend die öffentliche IPv4; die CLI setzt
dagegen explizit `SFU_ANNOUNCED_IP=$SFU_IP` aus der API (`bring-up-fleet.sh:106`).
Welche Variante auf Hetzner-Knoten korrekt ist (Interface-Reihenfolge), ist **nicht
verifiziert** — die Divergenz ist ein Beleg, nicht die Wirkung.

### 2.4 Wie die SFU (mediasoup) „dranhängt"

1. Container-Ebene: Overlay-Option `ENABLE_SFU=1` + `SFU_ANNOUNCED_IP` +
   Portbereichspublishing (`docker-compose.sfu.yml:18-26`).
2. Netz-Ebene: Hetzner-Firewall UDP+TCP 40000-40099 (`index.js:277-280`;
   `provision.py:131-137`) — gegenüber dem Host-UFW zusätzlich (siehe 1.3).
3. Steuer-Ebene über HTTP: `Caddyfile:56-70` öffnet CORS für `/sfu-signaling/*` und
   `/socket.io/*` inkl. Preflight-204 (`:66-70`) — der Kommentar `:57-58` begründet die
   Origin-Reflexion mit Credentials.
4. Verdrahtung App→SFU: Die App bekommt die Knoten-IPs zur Laufzeit aus
   `/api/fleet-map` (`server/fleetWiring.ts:96-114`, `index.js:951-964`).

---

## 3. Deploy- und Lifecycle-Pipeline

### 3.1 `deploy.sh` (App-Knoten)

Ablauf (Reihenfolge im Code): Konfiguration `:39-51` → lokaler Docker-Build beider Images
`:115-116` → Remote-Verzeichnis `:122-123` → rsync des Repos `:126-149` → `.env`-Sync
`:152-158` → `DOMAIN` in Remote-`.env` setzen/leeren `:161-170` → Rollback-Tag
`:175-176` → `docker save | ssh docker load` `:178` → `compose up -d --no-build
--force-recreate audiomonastry master-player` + `up -d caddy` `:179-182` → Health-Wait
`:91-107`, `:201` → Smoke-Pfade `/api/health`, `/api/cloud/health`, `/api/master/health`
`:203-210`.

- **Idempotenz:** `mkdir -p` (`:123`), `rsync -az` (`:135`), `--force-recreate`
  (`:179-182`). Die Aktionen sind wiederholbar.
- **Rollback:** nur ein lokal getaggtes Image auf dem Zielrechner
  (`audiomonastry:hetzner-rollback`, `:176`) plus **ausgedruckte** Anleitung (`:216`).
  Es gibt **keinen** automatischen Rollback — schlägt der Health-Wait fehl, läuft
  `|| true` (`:201`) und das Skript meldet trotzdem Erfolg (`:213`).
- **Modus `node`:** `scripts/hetzner/start-prod.sh` (`:189-192`) — dort `npm ci` +
  `npm run build` + `node dist/server.cjs` (`start-prod.sh:19-31`); in diesem Modus gibt es
  **keinen** Rollback-Pfad.
- **Befund 3.1 (P1, `.env`-Überschreiben):** `DEPLOY_SYNC_ENV` default `1` (`:46`) und
  `scp ./.env → $REMOTE_DIR/.env` (`:154`) ersetzt die vom Portal rollen-skopierte `.env`
  (`index.js:344-376`, dort z. B. `TRUST_PROXY=1` nur für `app`, `:368`). `bring-up-fleet.sh:92`
  ruft `deploy.sh` **ohne** `DEPLOY_SYNC_ENV` → beim Flottenstart überschreibt die lokale
  `.env` die Portal-`.env`. `fleet-preflight.sh:107` macht es korrekt
  (`DEPLOY_SYNC_ENV=0`) — d. h. die beiden Pfade verhalten sich unterschiedlich.
- **Befund 3.2 (P1, Caddyfile-Überschreiben):** Der rsync (`:126-136`) hat **keinen**
  `Caddyfile`-Ausschluss. Der Worker installiert für app-1 aber
  `/opt/audiomonastry/Caddyfile` aus `scripts/hetzner/Caddyfile.origin` (`index.js:410`) und
  legt die Zertifikate unter `certs/` ab (`:406-409`). Das Repo-`Caddyfile` hat **keine**
  `tls`-Direktive (`Caddyfile:22` → automatisches ACME), während `Caddyfile.origin:14`
  explizit `tls /etc/caddy/certs/origin.crt /etc/caddy/certs/origin.key` setzt. Nach jedem
  Deploy/Preflight liegt damit wieder die ACME-Variante auf dem Knoten — hinter der
  Cloudflare-Worker-Route der bekannte TLS-Fehlpfad. Ob der Deploy diesen Effekt live
  auslöst, ist **nicht verifiziert** (Flotte ist gelöscht); der Mechanismus ist im Code
  eindeutig.
- `deploy.sh:197` `BASE_URL="http://${DEPLOY_HOST#*@}"` ist korrekt (entfernt `user@`) —
  geprüft per Hex-Dump der Zeile.

### 3.2 `bring-up-fleet.sh` (CLI-Komplettstart, 7 Schritte)

`1/7` provisionieren `:62-63` → `2/7` IPs aus der API `:67-76` (**harter Abbruch**, wenn
einer der fünf fehlt `:72-75`) → `3/7` SSH-/Cloud-Init-Wait, 90×5 s je Knoten `:80-88` →
`4/7` app-1 deployen `:92` (`sg docker -c "bash deploy.sh"` — setzt Docker-Gruppenrechte
voraus) → `5/7` rsync + rollen-spezifischer Start für sfu/master/edge/ai `:97-117` →
`6/7` Idle-Shutdown auf allen fünf `:121-123` → `7/7` Smoke/Stress/SFU-RTP `:126-132`
(jeweils `|| echo`-gedämpft) → Zusammenfassung + Browser `:137-149`.

- **Idempotenz:** `provision.py:331-333` (Server per Name), `:115-118` (Firewall),
  `:164-167` (Floating-IP), `rsync --delete` (`:98`), `compose up -d` — mehrfach lauffähig.
- **Rollback:** keiner. Fehler in `provision_one` (`provision-fleet.sh:35-38`) brechen die
  Schleife nicht ab; ein Teil-Fehlschlag kostet aber weiter Geld und endet erst im
  IP-Check (`bring-up-fleet.sh:72-75`).
- **Befund 3.3 (P2, Smoke-Test ohne Token):** `smoke-test.sh:20-22` nutzt
  `STUDIO_ACCESS_TOKEN` aus der **Shell-Umgebung**; `bring-up-fleet.sh:30` sourced nur
  `.env.deploy`, und dort ist `STUDIO_ACCESS_TOKEN` nicht enthalten (Key-Namen-Prüfung,
  Abschnitt 6.4). Die geschützten Aufrufe (`smoke-test.sh:29,33,37`) laufen daher ohne
  Token → HTTP 401 → `curl -fsS` + `set -e` (`smoke-test.sh:9`) bricht ab, was in
  `bring-up-fleet.sh:128` nur als Warnung endet.

### 3.3 `fleet-deploy-live.sh` (Live-Beweis-Deploy)

Kopf `:1-16`; Ablauf: rsync **ohne** `.env`/`.env.*` `:29-35` → optionale
E2E-Tunnel-Overlay-Datei `:40-52` → `docker save | gzip | ssh docker load` `:55` →
`compose up -d --no-build --remove-orphans caddy audiomonastry` + Health-Ping
`:57-58`.
**Befund 3.4 (P1, falsches Zielverzeichnis):** `REMOTE_DIR="${DEPLOY_REMOTE_DIR:-/opt/samplemonk}"`
(`:22`). Alle übrigen Pfade im Repo verwenden `/opt/audiomonastry`
(`deploy.sh:44`, `index.js:388`, `auto-repair.sh:45`, `bring-up-fleet.sh:100`).
Ein Live-Deploy mit Defaults schreibt also in ein **anderes** Verzeichnis als der laufende
Stack; die anschließenden Compose-Befehle (`:58`) laufen im `cd $REMOTE_DIR` und starten
folglich einen zweiten Stack aus dem Altpfad.

### 3.4 `lifecycle.sh` (Kostenmodell „delete to save")

- `stop` (`:48-57`): `snapshot_all` (`:29-46`) → `delete-fleet.sh --yes` (`:56`).
  Snapshot-Description `<NAME>-auto-<timestamp>` (`:38-43`), danach **fest** `sleep 30`
  (`:45`) — es wird **kein** Action-Status abgefragt, die Vollständigkeit des Snapshots ist
  damit ungeprüft.
- `start` (`:59-65`): `git fetch` + `merge --ff-only` (Fehler nur Hinweis, `:61-62`) →
  `bring-up-fleet.sh --yes` (`:64`).
- **Befund 3.5 (P1, unbegrenzte Snapshots):** `lifecycle.sh` hat **keine** Retention; die
  Löschung alter Snapshots existiert nur im Worker (`index.js:56` `SNAPSHOT_RETENTION = 2`,
  angewandt auf Portal-Snapshots). Live liegen 10 Snapshots, der älteste vom **2026-09-11**
  (6.1) — kein Aufräumen erkennbar. Snapshot-Kosten sind laut `index.js:46-47`
  „~0,01 €/GB/Monat"; bei Summe der live gemessenen `image_size`-Werte (6.1:
  ≈ 50,4 GB) ist das ein laufender Cent-Bis-Euro-Posten, der nirgends im Kostenmodell
  (`SERVER_FLEET.md:9-15`, `bring-up-fleet.sh:19-24`) auftaucht.
- **Befund 3.6 (P3):** `lifecycle.sh:15` nutzt `set -uo pipefail` **ohne** `-e`; Fehler
  brechen den Vorgang nicht ab (gewollt für Robustheit, aber ohne Statusprüfung bleibt ein
  halb gelöschter Zustand unbemerkt).
- **Befund 3.7 (P1, widersprüchliches Floating-IP-Versprechen):** `delete-fleet.sh:5-9,33`
  lässt die Floating-IP bewusst stehen („3 €/Monat"), `docs/SERVER_FLEET.md:14-15` nennt sie
  den Grund für stabile DNS. Der Worker löscht Floating-IPs dagegen aktiv
  (`index.js:736-743`, Kommentar `:736-737` „damit wirklich 0 € Kosten entstehen").
  **Live:** `floating_ips` = `[]`, `total_entries: 0` (6.1). Die dokumentierte feste IP
  existiert nicht — der DNS-Record muss bei jedem Wake neu gesetzt werden, was der Worker
  auch tut (`index.js:302-321`, `:668-674`).

### 3.5 `fleet-preflight.sh` (Repo-Stand → Flotte)

`:1-23` Zweck; `check` `:121-135` (lokal Commit/Version `:35-36`, Portal-Status,
Snapshot-Abgleich über `/api/snapshots` `:56-70`), `apply` `:137-158`:
Login `:139` → Wake + Warten auf `ready` (max. 180×4 s = 12 min, `:72-88`) → app-IP aus
`/api/status` `:90-97` → bei veraltetem Snapshot `deploy.sh` im **Remote-Build-Modus mit
`DEPLOY_SYNC_ENV=0`** `:99-112` → `/api/refresh-snapshots` mit Commit/Version
`:114-119`.
Das ist der konsistenteste Pfad im Repo (kein `.env`-Überschreiben, idempotent, mit
Nachweis-Metadaten am Snapshot).

---

## 4. System-Integration (TLS/DNS/Auth/Monitoring/Backup)

### 4.1 TLS / Caddy

- Basis: `Caddyfile:22` `{$DOMAIN}` (bewusst ohne `:80`-Suffix, Begründung `:8-11`),
  HTTP/1.1+2 only (`:16-20`, QUIC-Begründung `:13-15`), Reverse-Proxy mit
  Socket.io-Timeouts `:32-38`, Body-Limit 120 MB `:41-43`, Security-Header `:45-54`,
  SFU-CORS `:56-70`, Cache-Regeln `:72-78`.
- Origin-TLS: `scripts/hetzner/Caddyfile.origin:14` (`tls … origin.crt/key`), installiert
  durch den Worker nur, wenn `ORIGIN_CERT`/`ORIGIN_KEY` gesetzt sind (`index.js:405-411`);
  die Secrets liegen base64-kodiert im Worker (`index.js:386-387`, `:407-408`).
  Lokal vorhanden: `.env.portal` enthält `ORIGIN_CERT` und `ORIGIN_KEY` (Key-Namen-Prüfung,
  6.4).
- **Befund 4.1** = Befund 3.2 (Deploy überschreibt Caddyfile).
- `Caddyfile.master` ist **verwaist**: Der einzige Treffer im Repo ist die Datei selbst
  (`scripts/hetzner/Caddyfile.master:1`) — kein Skript kopiert sie je auf einen Knoten.
- Compose mountet `./Caddyfile:ro` (`docker-compose.hetzner.yml:51`). Ein geändertes
  Caddyfile greift erst, wenn der Container neu erstellt wird; `deploy.sh:182` macht
  `up -d caddy` **ohne** `--force-recreate` (im Gegensatz zu `:179-182` für die App).
  Ob Caddy die Datei dann neu lädt, ist **nicht verifiziert**.

### 4.2 DNS / Cloudflare-Worker

- **Produktivpfad:** Worker proxied `anunnakitools.de` auf `origin.anunnakitools.de`
  (`index.js:57-58`, `:1024-1035`) und synchronisiert den A-Record des Origin auf die
  aktuelle app-1-IP (`index.js:302-321`, aufgerufen bei Wake `:669-673` und über
  `POST /api/wire-fleet` `:969-977`). Health wird über die Domain mit
  `resolveOverride` geprüft (`:577-583`).
- **Zweiter, toter Pfad:** `scripts/hetzner/dns_setup.py` schreibt die DNS-Zone über die
  **Hetzner**-Cloud-DNS-API (`:5-8`, `:70-120`) und setzt `A @`, `CNAME www`,
  `TXT _acme-challenge = "PLACEHOLDER"` (`:145-147`). Das passt nicht zum
  Cloudflare-Worker-Pfad und ist laut eigener Pfadvalidierung **nicht lauffähig**
  (Beweis 6.3). `docs/HETZNER_DEPLOY.md:86-88` dokumentiert es trotzdem als Schritt.
- **Befund 4.2 (P2, doppeltes Caddy/Domain):** `bring-up-fleet.sh:102,105,109,113` syncen
  die **lokale `.env`** auf sfu/master/edge/ai. Die lokale `.env` enthält `DOMAIN`
  (6.4). Damit sehen auch sfu-1 und edge-1 `DOMAIN=anunnakitools.de`, und ihr jeweils
  mitgestartetes `caddy` (`bring-up-fleet.sh:106`, `:114`) würde Zertifikate für dieselbe
  Domain anfordern. Der Worker vermeidet das bewusst, indem er
  `DOMAIN=` nur für die Rolle `app` setzt (`index.js:360`). Wirkung live **nicht
  verifiziert** (keine Knoten), Mechanismus im Code belegt.

### 4.3 Auth (`STUDIO_ACCESS_TOKEN`)

- Server: `server.ts:248-249` Token + `studioTokenEnabled`; **fail-closed** ohne Token
  (`:272`, Antwort 503 `:367-370`); Prüfung per Konstantzeit-Vergleich (`:373`).
  Zusätzlich kurzlebige Portal-Session-Tokens (`:374-380`, `v1.<exp>.<hmac>`).
- Ausnahmen (bewusst, dokumentiert): Alert-Webhook nur `POST /alerts/webhook` mit
  `x-alert-token` **oder** `Authorization: Bearer` (`:337-344`), MJPEG-Query-Token nur für
  `GET /visual/mjpeg` (`:345-353`), Scrape-Token nur für `GET /metrics|/online`
  (`:354-364`). Kein Fail-open.
- `TRUST_PROXY=1` wird von server.ts:295 ausgewertet; im Portal nur für die Rolle `app`
  gesetzt (`index.js:368`).
- Worker-seitig: `/api/fleet-map` erfordert den Token im Header `x-studio-token`
  (`index.js:954-958`) und liefert die Knoten-IPv4s; die App verdrahtet daraus
  master-player/Ollama/stem-ai (`server/fleetWiring.ts:93-114`, Fallback auf das
  Legacy-Präfix `:66-78`).
- **Befund 4.3 (P2):** Der Worker akzeptiert das Master-Token direkt als Cookie, wenn kein
  `SESSION_SECRET` gesetzt ist (`index.js:556`), sonst ein kurzlebiges Session-Token
  (`:558-559`). Beides ist implementiert; ob in der Produktions-Worker-Konfiguration
  `SESSION_SECRET` gesetzt ist, ist **nicht verifiziert** (Worker-Secrets sind nicht im
  Repo).

### 4.4 Monitoring / Alerting

- Stack: `docker-compose.monitoring.yml:36-162` (Details 2.2), Konfig unter
  `scripts/hetzner/prometheus.yml`, `prometheus-alerts.yml`, `alertmanager.yml`,
  `grafana-provisioning/`, `grafana-dashboards/audiomonastry-overview.json`.
- Prometheus: lokale Jobs `prometheus:9090`, `node-exporter:9100`, `cadvisor:8080`
  (`prometheus.yml:17-27`), App-Job `audiomonastry:8080` mit `__SCRAPE_TOKEN__`
  (`:39-48`), Alertmanager-Ziel `alertmanager:9093` (`:11-14`).
- **Befund 4.4 (P1, Monitoring-Blindflug):** Der App-Job zeigt auf `audiomonastry:8080`
  im **lokalen** Compose-Netz (`prometheus.yml:48`); der Cross-Host-Job für die
  Domain/IP ist auskommentiert (`:50-58`). prometheus läuft auf edge-1, die Produktions-App
  auf app-1 → alle App-/Container-Metriken, die das Dashboard füllen, stammen von der
  **edge-Kopie** der App, nicht von app-1. Alarme über die reale Produktions-App entstehen
  so nicht.
- **Befund 4.5 (P1, Alert-Zustellung lokal):** `alertmanager.yml:36` schickt alle Alarme an
  `http://audiomonastry:8080/api/alerts/webhook` — im Compose-Netz von edge-1 ist das der
  **edge-eigene** Container. Der Kommentar `:8-10` nennt die Alternative
  (`https://anunnakitools.de/api/alerts/webhook`), implementiert ist sie nicht.
  Der Selbstschutz für „App down" hängt an `CRITICAL_WEBHOOK` (`:46-49`,
  `docker-compose.monitoring.yml:120-135`) — ob gesetzt, ist **nicht verifiziert**; ohne
  gesetzten Wert zeigt der Fallback wieder auf den lokalen Container
  (`docker-compose.monitoring.yml:129`).
- **Befund 4.6 (P2, Uhrenprüfung fehlt):** `prometheus-alerts.yml` und
  `alert-webhook-receiver.mjs` existieren, aber der Receiver wird von keinem Flottenskript
  gestartet (einziger Aufruf-Hinweis: `docs/OPS_RUNBOOK.md:200`); er ist ein lokales
  Beweiswerkzeug.
- **Befund 4.7 (P1, auto-repair ist nicht installiert):** `scripts/hetzner/auto-repair.sh`
  und `install-auto-repair.sh` existieren, werden aber **von keinem** Skript aufgerufen
  (Volltextsuche nach `install-auto-repair` → nur die Selbst-Doku
  `install-auto-repair.sh:3` und `auto-repair.sh:10`). `bring-up-fleet.sh:121-123` installiert
  nur den Idle-Shutdown. Der Watchdog läuft also nur, wenn ihn jemand manuell installiert.
  Zusätzlich würde `auto-repair.sh:36` (`http://127.0.0.1/api/health`, Port 80 = **Caddy**)
  bei totem Caddy die **App** als krank melden (`:43-47`) — Fehldiagnose per Konstruktion.
- **Befund 4.8 (P2, Idle-Semantik falsch gezählt):** `scripts/hetzner/systemd/idle-check.sh:22`
  zählt `ss -tn state established | awk '$4 ~ /:(8080|443|80)$/'`. Bei
  `ss -tn state established` fehlt die `State`-Spalte; die Spaltenfolge lautet
  `Recv-Q Send-Q Local-Address:Port Peer-Address:Port` — auf diesem Host experimentell
  bestätigt (6.5). `$4` ist damit die **Peer**-Adresse, nicht der lokale Listener: gezählt
  werden ausgehende TLS-Verbindungen, nicht eingehende User-Sessions. Der HTTP-Fallback des
  Idle-Checks misst also das Falsche; ob die primäre Messung (`:36-37`, `/api/online`)
  das kompensiert, ist **nicht verifiziert**. Zusätzlich: `IDLE_MINUTES` default `30`
  (`install-idle-shutdown.sh:6`) gegenüber „20 min" in `docs/SERVER_FLEET.md:39` und
  `index.js:12`.
- **Befund 4.9 (P2, Firewall-Aufräumen fehlt):** Live existieren **12** Firewalls, darunter
  sechs `samplemonk-*`-Legacy-Objekte und ein `audiomonastry-drill`, das in **keinem**
  Repo-Skript vorkommt (6.2). `stopFleet` löscht nur Server und Floating-IPs
  (`index.js:729-745`), `delete-fleet.sh` nur Server (`:38-48`).

### 4.5 Backups

- `scripts/backup.sh:1-20` sichert `dist/` + `public/` als `tar.gz` nach
  `/var/backups/audiomonastry` (`:33-36`), Ausschlüsse für die Medienbäume (`:38-46`),
  Rotation über `RETENTION_DAYS=14` (`:34`, `:52`), optional `--offsite` über
  `scripts/r2-backup.mjs` (`:57-60`; Upload mit Größen-Verifikation
  `r2-backup.mjs:73-100`).
- **Befund 4.10 (P1, kein Backup in der Flotte verdrahtet):** Kein Flottenskript ruft
  `backup.sh` auf (Volltextsuche: nur `docs/OPS_RUNBOOK.md:67-78`,
  `docs/PRODUKTIONSREIFE_WEGPLAN.md:45,70,139` und die Datei selbst). Es gibt **keine**
  systemd-Unit/keinen Timer dafür (nur `idle-check.sh` in `scripts/hetzner/systemd/`).
  Die einzige maschinelle Sicherung ist der Server-Snapshot — und der wird bei
  `stopFleet` **nicht** erzeugt (nur `lifecycle.sh:29-46` tut das).
  Für Off-Site fehlen in dieser Arbeitskopie die Zugangsdaten: `BACKUP_S3_*`/`HOS_S3_*`
  sind in `.env.deploy` **nicht** enthalten (Key-Namen-Prüfung, 6.4; erwartet laut
  `docs/ENV_MATRIX.md:185-193`).
- Datenbank: es gibt lokal `database/` und `supabase/`, aber keinen Dump-Schritt; laut
  `docs/SERVER_FLEET.md:4` ist Supabase bewusst extern (Cloud-DB) — Konsistenz mit dem
  fehlenden DB-Backup ist also plausibel, aber die Wiederherstellung der Cloud-DB ist im
  Repo **nicht** belegt.

---

## 5. Schwachstellen (nach Schwere)

### 5.1 Hoch (P1) — Funktion oder Kostenrisiko

| # | Befund | Beleg |
|---|---|---|
| H1 | `deploy.sh` überschreibt die Portal-`.env` (Rollenskopierung + `TRUST_PROXY` gehen verloren) | `deploy.sh:46,152-158` vs. `index.js:344-376`; Aufruf `bring-up-fleet.sh:92` |
| H2 | `deploy.sh` überschreibt das Origin-TLS-`Caddyfile` wieder mit der ACME-Variante | `deploy.sh:126-136` (kein Ausschluss) vs. `index.js:405-411`, `Caddyfile.origin:14` |
| H3 | Monitoring/Alerting messen und alarmieren die **lokale** edge-Kopie, nicht app-1 | `prometheus.yml:47-48,50-58`; `alertmanager.yml:36` |
| H4 | `fleet-deploy-live.sh` deployt per Default nach `/opt/samplemonk` (anderer Pfad als der laufende Stack) | `fleet-deploy-live.sh:22` vs. `deploy.sh:44`, `index.js:388` |
| H5 | auto-repair (Watchdog) wird von keinem Skript installiert → vorhanden, aber wirkungslos | `install-auto-repair.sh:3`, `bring-up-fleet.sh:121-123` |
| H6 | Kein Backup in der Flotte verdrahtet; Off-Site-Keys fehlen in dieser Kopie | `backup.sh:33-60`; keine Aufrufer; 6.4 |
| H7 | „Feste IP"/„Floating-IP bleibt reserviert" ist live falsch: 0 Floating-IPs | `delete-fleet.sh:33`, `SERVER_FLEET.md:14-15` vs. `index.js:736-743` + 6.1 |
| H8 | Snapshot-Retention fehlt im CLI-Pfad → 10 Snapshots live, ältester 2026-09-11, ungelöscht | `lifecycle.sh:29-46` (keine Retention) vs. `index.js:56` + 6.1 |
| H9 | `dns_setup.py` ist wegen eigener Pfadvalidierung nicht lauffähig (`?`, `=`, `@` verboten), wird aber dokumentiert | `dns_setup.py:40` vs. `:72`,`:93`,`:145-147`; Beweis 6.3 |
| H10 | edge-1 startet App+master+Caddy+Monitoring ohne Service-Liste → ~4,56 GiB Limits auf 4-GB-Typ | `bring-up-fleet.sh:114`, `index.js:422`, Limits aus 2.1 |

### 5.2 Mittel (P2) — Drift, Inkonsistenz, blinde Flecken

| # | Befund | Beleg |
|---|---|---|
| M1 | Vier Servertyp-Tabellen (`cx23`-Default vs. Worker `cx33` vs. Doku `CCX33/CPX31/CAX31`) | `provision-fleet.sh:5-7,45-47`; `index.js:23-27`; `SERVER_FLEET.md:33-37,49-55,157-167`; `README.md:225` |
| M2 | Rolle `edge` existiert nur in Doku/`--help`, nie als Provisionierungsrolle; edge-1 läuft als `app` | `provision.py:299-301` vs. `provision-fleet.sh:53`; `provision.py:131-141` |
| M3 | Firewall öffnet **nie** 3000/9090/9093, obwohl Grafana-Zugriff dokumentiert ist | `index.js:263-282`, `provision.py:120-137` vs. `bring-up-fleet.sh:140`, `SERVER_FLEET.md:143`, `HETZNER_DEPLOY.md:333` |
| M4 | Zwei getrennte DNS-Pfade (Hetzner-DNS-Skript vs. Cloudflare-Worker) | `dns_setup.py:5-8,145-147` vs. `index.js:302-321`, `HETZNER_DEPLOY.md:86-88` |
| M5 | sfu-1/edge-1 erhalten `DOMAIN` aus der gesyncten `.env` und starten ein zweites Caddy | `bring-up-fleet.sh:102,106,113-114` vs. `index.js:360` |
| M6 | `SFU_ANNOUNCED_IP` zweigleisig (`hostname -I`-erstes-Interface vs. API-IP) | `index.js:415` vs. `bring-up-fleet.sh:106` |
| M7 | Smoke-Test-Token wird nicht gesetzt → geschützte Endpunkte 401 beim Flottenstart | `smoke-test.sh:20-22`; `.env.deploy` ohne `STUDIO_ACCESS_TOKEN` (6.4) |
| M8 | `fleet-status.sh` prüft `http://<ip>/api/health`, obwohl die app-Firewall 80/443 **nur für Cloudflare** öffnet → Check kann strukturell nicht grün werden | `fleet-status.sh:60` vs. `index.js:268-272` (live: 22 CIDR-Einträge, 6.2) |
| M9 | Idle-Check zählt die falsche `ss`-Spalte (Peer statt Local) | `idle-check.sh:22`; Beweis 6.5 |
| M10 | Idle-Schwelle widersprüchlich: Code 30 min, Doku/Worker-Kommentar 20 min | `install-idle-shutdown.sh:6` vs. `SERVER_FLEET.md:39`, `index.js:12` |
| M11 | Kein Healthcheck für `caddy`/Monitoring-Services; `up -d caddy` ohne Recreate | `docker-compose.hetzner.yml:38-62,178-195`, `monitoring.yml:36-162`; `deploy.sh:182` |
| M12 | Rollback nur manuell (Docker-Modus), im `node`-Modus gar nicht; Health-Fehler wird verschluckt | `deploy.sh:176,201,213,216`; `:189-192` |
| M13 | Verwaiste Artefakte: `Caddyfile.master` (kein Aufrufer), Legacy-Firewalls/`audiomonastry-drill` live, Legacy-Snapshots live | `Caddyfile.master:1`; 6.1/6.2 |
| M14 | Kein automatischer Typ-/Standort-Fallback trotz Knappheits-Kommentar | `provision-fleet.sh:42-44` vs. `provision.py:61-68` |
| M15 | Doku-IPs stimmen mit keinem Live-Objekt überein; die real zuletzt verdrahtete app-1-IP (`142.132.229.71/32`) steht in keiner Doku | `SERVER_FLEET.md:33-37` vs. 6.1/6.2 |

### 5.3 Niedrig (P3) — Hygiene

- `lifecycle.sh:15` ohne `-e`; `:45` festes `sleep 30` ohne Action-Status.
- `.env` ist gruppen-/weltlesbar (`-rw-rw-r--`, Beleg 6.4) und enthält
  `STUDIO_ACCESS_TOKEN`; `.env.deploy`/`.env.portal` sind korrekt `0600`.
  Getrackt sind nur Beispiel-Dateien (`.gitignore:5-9`, `git ls-files` → `.env.example`,
  `.env.hetzner.example`, `.env.deploy.example`) — **kein** Secret im Git.
- Hartcodierte Beispiel-IPs in Kommentaren/Usage-Texten (Tabelle 1.5), u. a.
  `install-ai1.sh:16`.
- `configure-floating-ip.sh:17,20,34` verdrahtet **`eth0`** fest; auf aktuellen
  Ubuntu-24.04-Hetzner-Images ist der Interfacename ggf. anders (z. B. `ens10`) —
  **nicht verifiziert**, da kein Knoten läuft.
- `docs/SERVER_FLEET.md:59` behauptet „max. 5 Server pro Account" (Stand 2026-08-29);
  aktuelle Live-Quote nicht geprüft (**nicht verifiziert**).

### 5.4 Single Points of Failure (explizit)

1. **app-1** ist der einzige Knoten, der App, API, Signaling und Domain-Terminierung
   trägt (`index.js:412`, `:1024-1035`); fällt er aus, ist das Studio offline. Ein LB ist
   bewusst **nicht** im Einsatz (`SERVER_FLEET.md:174-189`), und die dafür nötige zweite
   App-Instanz existiert im Repo **nicht** (Suche 1.4: 0 Treffer für `app-2`).
2. **`origin.anunnakitools.de`** ist der einzige Weg zum Origin (`index.js:58`,
   `:1032`); ohne korrekten A-Record liefert das Portal 522 — genau dieser Fehler ist im
   Code als Live-Befund dokumentiert (`index.js:654-658`).
3. **Der Portal-Worker** kontrolliert Wake, Wiring und Auto-Delete
   (`index.js:605-682`, `:1029-1054`); fällt der Cron/Worker aus, bleibt die Flotte
   unbegrenzt und unbedient kostenpflichtig laufen.
4. **Redis** (Profil `fleet`, `docker-compose.hetzner.yml:141-173`) ist für Multi-App-Betrieb
   vorgesehen, existiert aber auf **keinem** Knoten als fester Bestandteil; die
   `REDIS_URL`-Verdrahtung ist nirgends gesetzt (`SERVER_FLEET.md:63-65` beschreibt nur
   den Weg).

---

## 6. Anhang: Live-Belege, Nicht-Zugreifbares, offene Punkte

### 6.1 Live-Enumeration (glückte: **ja**)

Ausgeführt read-only gegen `https://api.hetzner.cloud/v1` mit dem Token aus `.env.deploy`
(Key `HCLOUD_TOKEN`, per `grep | cut` in eine Shell-Variable; nie gesourct, nie gedruckt):

**`GET /servers` — wörtliche Antwort (ungekürzt):**
```json
{
 "servers": [],
 "meta": {
  "pagination": { "last_page": 1, "next_page": null, "page": 1, "per_page": 25,
                  "previous_page": null, "total_entries": 0 }
 }
}
```

**`GET /floating_ips` — wörtliche Antwort:**
```json
{ "floating_ips": [], "meta": { "pagination": { "last_page": 1, "next_page": null, "page": 1,
  "per_page": 25, "previous_page": null, "total_entries": 0 } } }
```
→ Es existiert **keine** Floating-IP; die Rollen/IPs/Typen dieses Dokuments sind
Soll-Definition, **nicht** laufender Bestand. Live-IPs: keine.

**`GET /images?type=snapshot` — 10 Treffer, wörtlich (Description · `image_size` GB ·
`disk_size` GB · `created`):**
```
samplemonk-snapshot-edge-2026-09-18    · 5,003   · 40 · 2026-09-18T18:20:18Z
samplemonk-snapshot-master-2026-09-18  · 2,629   · 40 · 2026-09-18T18:20:18Z
samplemonk-snapshot-ai-2026-09-18      · 13,188  · 80 · 2026-09-18T18:20:18Z
samplemonk-snapshot-sfu-2026-09-18     · 3,373   · 80 · 2026-09-18T18:20:18Z
samplemonk-snapshot-app-2026-09-18     · 3,783   · 80 · 2026-09-18T18:20:17Z
samplemonk-snapshot-edge-2026-09-11-live   · 1,173 · 40 · 2026-09-11T08:16:01Z
samplemonk-snapshot-master-2026-09-11-live · 1,139 · 40 · 2026-09-11T08:15:34Z
samplemonk-snapshot-ai-2026-09-11-live     · 18,286 · 40 · 2026-09-11T08:15:22Z
samplemonk-snapshot-sfu-2026-09-11-live    · 2,859 · 40 · 2026-09-11T08:15:22Z
samplemonk-snapshot-app-2026-09-11-live    · 2,009 · 40 · 2026-09-11T08:15:21Z
```
- Kein Snapshot trägt `protection.delete` (`false`).
- **Beobachtung (kein Beweis über Typen):** Die fünf Snapshots vom **2026-09-18** haben für
  app/sfu/ai `disk_size = 80 GB`, für master/edge `40 GB`; alle Snapshots vom 2026-09-11
  haben `40 GB`. Das ist mit der Aussage „am 2026-09-18 hatten app/sfu/ai eine größere
  Typ-/Disk-Klasse als master/edge" verträglich, sagt aber **nichts** über konkrete
  Servertypen — die Bestands-notiz mit `app-1 49.13.0.227` usw. lässt sich daraus
  **nicht** bestätigen (diese IPs kommen im Repo nicht vor, 1.4).
- Kein Snapshot folgt dem `lifecycle.sh`-Schema `<name>-auto-<timestamp>`
  (`lifecycle.sh:38-43`) → die vorhandenen Snapshots stammen aus dem Portal-Pfad
  (`index.js:48-55`, `:979-1012`).

### 6.2 Live-Firewalls (12, wörtlich aus der API)

```
samplemonk-test    (4 Regeln)   samplemonk-app    (4)   samplemonk-sfu  (6)
samplemonk-ai      (6)          samplemonk-master (5)   samplemonk-edge (4)
audiomonastry-drill(4)          audiomonastry-app (4)   audiomonastry-sfu  (6)
audiomonastry-ai   (6)          audiomonastry-master (5) audiomonastry-edge (4)
```
Regeln der kanonischen Firewalls (live gelesen):
- `audiomonastry-app`: icmp/alle, tcp/22/alle, tcp/80 **und** tcp/443 je **22 CIDR-Einträge**
  (erste: `173.245.48.0/20`, `103.21.244.0/22`) → deckt sich exakt mit
  `index.js:268-272` (Cloudflare-Ranges).
- `audiomonastry-master`: + tcp/8000 nur `142.132.229.71/32`.
- `audiomonastry-ai`: + tcp/8000 **und** tcp/11434 nur `142.132.229.71/32` → deckt sich mit
  `index.js:694-697,708-714`.
- `audiomonastry-sfu`: + udp **und** tcp `40000-40099` offen für alle.
- `audiomonastry-edge`: nur icmp/22/80/443 (**kein** 3000/9090/9093).
- `audiomonastry-drill`: icmp/22/80/443 — im Repo **nicht** referenziert.
- `applied_to` ist bei **allen** Firewalls leer (keine Server mehr).
- Die /32-Quelle `142.132.229.71` ist die **zuletzt verdrahtete app-1-IPv4**. Sie steht in
  keiner Repo-Doku (1.5) und ist **nicht** die Notiz-IP `49.13.0.227` — der Beweis, dass
  app-1 hinter einer wechselnden Primary-IPv4 lief, nicht hinter einer Floating-IP.

### 6.3 Beweis: `dns_setup.py` kann nicht ausgeführt werden

Die Pfadvalidierung `dns_setup.py:40` (`^/[A-Za-z0-9_./-]*$`) verbietet `?`, `=` und `@`;
die echten Aufrufe bauen aber genau diese Zeichen ein:
`/zones?name=anunnakitools.de` (`:72`), `/zones/<id>/rrsets/@/A` (`:93`, genutzt für den
Apex-Record `:145`) → `_safe_url` (`:41-44`) wirft `ValueError`, bevor der HTTP-Request
entsteht. Nachgerechnet (Python, Repo-Regex):
```
'/zones?name=anunnakitools.de'   -> regex match: False
'/zones/12345/rrsets/@/A'        -> regex match: False
'/zones/12345/rrsets/www/CNAME'  -> regex match: True
'/zones/12345/rrsets/_acme-challenge/TXT' -> regex match: True
provision.py-Regex '/servers?page=1&per_page=50' -> True   # provision.py:46 erlaubt ? & = explizit
```
`provision.py:44-46` macht es richtig (Kommentar + erweiterte Zeichenklasse) —
`dns_setup.py:39-40` ist die defekte Kopie.

### 6.4 Key-Namen-Prüfung der Env-Dateien (nur Schlüsselnamen, keine Werte)

- `.env.deploy` (0600): u. a. `HCLOUD_TOKEN`, `CLOUDFLARE_API_TOKEN`, `DNS_HC_TOKEN`,
  `ADMIN_USER`, `ADMIN_PASSWORD`. **Nicht** enthalten: `STUDIO_ACCESS_TOKEN`,
  `ORIGIN_CERT`/`ORIGIN_KEY`, `BACKUP_S3_*`, `HOS_S3_*`.
- `.env.portal` (0600): u. a. `HCLOUD_TOKEN`… `ORIGIN_CERT`, `ORIGIN_KEY`,
  `SESSION_SECRET`, `STUDIO_ACCESS_TOKEN`, `ADMIN_USER`, `ADMIN_PASSWORD`.
- `.env` (0664 — **gruppen-/weltlesbar**): enthält `DOMAIN` und `STUDIO_ACCESS_TOKEN`
  sowie **keine** `SFU_*`-Schlüssel (konsistent damit, dass `bring-up-fleet.sh:106`
  `SFU_ANNOUNCED_IP` erst auf dem Knoten anhängt).
- Getrackt im Git: nur `.env.example`, `.env.hetzner.example`, `.env.deploy.example`
  (`.gitignore:5-9`, `git ls-files`) → keine Secrets im Repository.

### 6.5 Beweis: Spaltenreihenfolge von `ss -tn state established`

Auf dem Audit-Host (`ss -tn state established | head -3`):
```
Recv-Q Send-Q  Local Address:Port   Peer Address:Port  Process
0      0       192.168.1.131:49990  3.173.21.63:443
```
→ Feld `$4` ist `Peer Address:Port`. `idle-check.sh:22` filtert `$4` auf
`:8080|443|80` und misst damit Peer-Ports (ausgehende Verbindungen), nicht die lokalen
Listener. Das ist hier belegt; ob ein Hetzner-Knoten dieselbe Spaltenfolge liefert, ist
technisch erwartbar, aber **nicht verifiziert** (kein Knoten läuft).

### 6.6 Weitere belegte Beobachtungen ohne Schweregrad

- Der Worker provisioniert Snapshots als Start-Image und fällt sonst auf
  `ubuntu-24.04` + `user_data` zurück (`index.js:620-636`); Rollen-Zuordnung von Snapshots
  läuft über Name/Description, weil die Alt-Snapshots **kein** Label tragen
  (`index.js:118-133` — mit dokumentiertem Live-Befund vom 2026-09-18).
- Der Portal-Bootstrap klont das Repo mit Einmal-Header und setzt das Remote danach auf die
  saubere URL (`index.js:392-397`) — kein Token in `.git/config`.
- Der Portal-Bootstrap setzt `SIGNALING_ALLOWED_ORIGINS=*` für **alle** Rollen
  (`index.js:361`).
- CI validiert alle Compose-Kombinationen inkl. SFU- und Monitoring-Overlays
  (`.github/workflows/build.yml:41,68-81`).
- Legacy-Testpfade sind im Repo bereits umbenannt dokumentiert (`HETZNER_DEPLOY.md:408`
  listet `samplemonk-*` → `audiomonastry-*`).

### 6.7 Offene Punkte / nicht Zugreifbares (ehrlich)

1. **Kein Knoten live** → SSH-/UFW-/Interface-Prüfungen, Docker-Limits, Caddy-Zertifikats-
   steuerung, tatsächliche Container-Zustände: **nicht verifiziert**. Alle Aussagen dazu
   sind Code-/Konfigurationsbelege, keine Messungen.
2. **Cloudflare-Worker-Secrets** (`ORIGIN_CERT/KEY` beim Worker, `SESSION_SECRET`,
   `CRITICAL_WEBHOOK`, `GF_SECURITY_ADMIN_PASSWORD`) sind nicht einsehbar → nicht
   verifiziert, ob die Fallbacks (`admin`, lokaler App-Pfad) in Produktion greifen.
3. **`docs/OPS_RUNBOOK.md` (710 Zeilen)** wurde nur gezielt (Backup/Alert-Receiver)
   ausgewertet; eine vollständige Doku-Drift-Prüfung dieses Dokuments steht aus.
4. **`MASTERTODOENDE.json`** (313 KB) wurde **nicht** als Quelle verwendet
   (Aufgabenliste, kein Code) — es enthält u. a. Notizen zu Backup/Alerting, die mit 4.4/4.5
   korrelieren, aber nicht als Beleg herangezogen wurden.
5. **Firewall-/Netzverhalten von `samplemonk-*`-Beständen** (6.2) wurde nicht inhaltlich
   geprüft (nur Namen/Regelanzahl), da keine Server mehr zugeordnet sind.
6. **Kostenrechnung:** Die Zahl „≈ 39 €/Monat" stammt aus Skript-/Doku-Kommentaren
   (`bring-up-fleet.sh:21-23`, `SERVER_FLEET.md:12-13`) und ist mit keiner Live-Preisliste
   gegengeprüft worden; die aktuelle Hetzner-Bepreisung der nicht vorhandenen Server ist
   damit **unverifiziert**.

### 6.8 Was dieses Audit nicht getan hat

- Kein Quellcode geändert, kein Commit, kein `git add`; keine Datei außer
  `docs/audit-infra-hetzner.md` angefasst.
- Keine repo-weiten Test-/Build-Gates gestartet.
- Keine Schreibzugriffe auf die Hetzner-API (ausschließlich GET).
