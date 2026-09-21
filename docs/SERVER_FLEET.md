# audioMONASTRY – Server-Flotte: 5 Hetzner-Knoten + 8 RunPod-Rollen

> Verbindliche Zahlen: siehe docs/INFRA_KONSTITUTION.md.

> Stand: 2026-08-30 · Ziel: **5 Hetzner-Server** (Rollen app/sfu/ai/master/edge),
> klare Rollen; GPU-Inferenz extern.
> Cloud bleibt extern: Supabase (DB), Cloudflare R2 (Audio-Blobs),
> DeepSeek/HF/Mistral/Replicate (Cloud-KI).
>
> **Stand 2026-09-20:** Die GPU-Inferenz läuft auf **max. 8 RunPod-Endpoints**
> (Rollen `brain`/`ears`/`voiceGen`/`music`/`imageHq`/`videoReal`/`videoAbstract`/
> `orchestrator`); ai-1 ist nur noch **CPU-Fallback/Stem**. Die frühere Aussage
> „GPU nur für lokale KI/Stem auf ai-1" ist damit überholt; Titel und
> Rollenbild der früheren Fassung („5-Instanzen-Architektur", KI lokal auf ai-1)
> sind überholt (`docs/INFRA_KONSTITUTION.md` §1.1/§1.2).

## Rollen + Servertypen – die eine Tabelle (Stand 2026-09-20)

> **Verbindlich für Code und Doku.** Beide Provisionierungspfade lesen dieselben
> Override-Variablen `FLEET_TYPE_<ROLLE>` (Großschreibung); gesetzt werden sie dort,
> wo der Pfad startet – CLI aus `.env.deploy`/Umgebung, Portal-Worker als
> Worker-Variablen. Ohne Override gilt der jeweilige Fallback. Die Typen sind eine
> **Betreiber-Entscheidung** (Preis/Placement), keine Empfehlung.

| Rolle | Knotenname | Typ-Override (Env) | Fallback CLI | Fallback Portal-Worker | Zweck |
|---|---|---|---|---|---|
| `app` | `audiomonastry-app-1` | `FLEET_TYPE_APP` | `cx23` | `cx33` | Caddy + App/REST/Signaling (+ Floating-IP für DNS) |
| `sfu` | `audiomonastry-sfu-1` | `FLEET_TYPE_SFU` | `cx23` | `cx33` | mediasoup-SFU (RTP 40000–40099) |
| `ai` | `audiomonastry-ai-1` | `FLEET_TYPE_AI` | `cx23` | `cx33` | Ollama + Stem-CPU-Fallback (host-nativ, systemd) |
| `master` | `audiomonastry-master-1` | `FLEET_TYPE_MASTER` | `cx23` | `cx23` | master-player (FFmpeg/NumPy) |
| `edge` | `audiomonastry-edge-1` | `FLEET_TYPE_EDGE` | `cx23` | `cx23` | Monitoring-Stack (nur der Stack), Staging/Smoke |

- **CLI-Quelle:** `scripts/hetzner/provision-fleet.sh` (`TYPE_*`); Trockenlauf ohne
  API-Zugriff: `bash scripts/hetzner/provision-fleet.sh --print-config`.
- **Portal-Quelle:** `services/portal-worker/src/index.js` (`FLEET`, `fleetServerType`);
  das Wake-Ergebnis nennt die effektiven Typen unter `types`.
- **Rolle `edge` ist provisioniert** (eigener Knoten, eigene Firewall
  `audiomonastry-edge`, Regelmenge wie `app`: 22/80/443 + ICMP; `ROLE=edge` in
  `provision.py`). **Keine Monitoring-Ports in der Firewall:** Grafana ist im
  Overlay nur auf `127.0.0.1` veröffentlicht (Zugriff per SSH-Tunnel:
  `ssh -L 3000:127.0.0.1:3000 root@<edge-1-ip>` → `http://127.0.0.1:3000`),
  Prometheus (9090) und Alertmanager (9093) bleiben rein intern.
- **Gegen Drift:** `tests/test_hetzner_scripts.py` vergleicht diese Tabelle mit
  beiden Code-Pfaden und mit `README.md`/`docs/AI_ARCHITECTURE.md`.

## 💶 Kostenmodell (wichtig, Stand 2026-08-30)

- **Hetzner berechnet Server ab ERSTELLUNG – auch im ausgeschalteten Zustand.**
  Der 20-min-Idle-Auto-Shutdown spart daher **kein Geld**, nur Ressourcen.
- Kosten stoppen geht **nur durch Löschen** der Server.
- Kosten hängen direkt an der Typ-Tabelle (oben): mit dem Portal-Fallback
  (3× CX33 + 2× CX23) **≈ 39,45 €/Monat**, mit dem CLI-Default (5× CX23)
  **≈ 30,45 €/Monat** – jeweils inkl. Floating-IPv4 (3,00 €/Monat), solange die
  Server existieren. Preise/Herleitung: §Kosten.
- **Nach dem Löschen:** 0 € Serverkosten; nur die Floating-IP bleibt
  reserviert (3,00 €/Monat), damit `anunnakitools.de` stabil bleibt.

```bash
# Komplett hochfahren (provisionieren → deployen → installieren → Tests → Browser):
bash scripts/hetzner/bring-up-fleet.sh

# Nach der Session: Server löschen (Kosten stoppen), Floating-IP bleibt:
bash scripts/hetzner/delete-fleet.sh
```

> GitHub reicht als Ablage: Alle Provisionierungs-, Deploy-, Install- und
> Test-Skripte liegen im Repo unter `scripts/hetzner/`. Ein Docker-Image ist
> für die Steuerung nicht nötig (die App selbst läuft auf den VMs in Docker).

## Historische Live-Aufnahme (2026-08-30, Flotte gelöscht) – keine Soll-Konfiguration

> Diese Tabelle ist ein **Messprotokoll** der damaligen Flotte (Typen/IPs zum
> Aufnahmezeitpunkt), nicht der Soll-Zustand. Die Soll-Typen stehen in der Tabelle
> oben; die Rolle `edge` trug damals Staging, heute ausschließlich den
> Monitoring-Stack (INFRA-HETZNER-006).

| # | Name | Typ (damals) | IP | Rolle |
|---|---|---|---|---|
| 1 | audiomonastry-app-1 | CX33 | 159.69.102.29 (Floating) | Caddy + App/API/Signaling + master-player |
| 2 | audiomonastry-sfu-1 | CX33 | 49.13.0.226 | Caddy + Mediasoup-SFU (UDP/TCP 40000–40099) |
| 3 | audiomonastry-ai-1 | CX33 | 49.13.65.150 | Ollama/Stem-CPU-Fallback (installiert + aktiv, systemd) |
| 4 | audiomonastry-master-1 | CX23 | 167.233.22.157 | master-player (FFmpeg-Mixing/Mastering) |
| 5 | audiomonastry-edge-1 | CX23 | 167.233.214.220 | Staging, Prometheus/Grafana/cAdvisor/node-exporter, Smoke |

Alle 5 Einheiten haben Idle-Auto-Shutdown (20 min ohne aktive User/Session
fährt die Instanz herunter – stündliche Abrechnung). **Replicate ist aktiv**
(`REPLICATE_API_TOKEN` gesetzt, `STEM_AI_PROVIDER=replicate`,
`VOICE_PROVIDER=replicate`): Demucs-Stems und Bark-TTS/Sing laufen über die
GPU-Cloud. Verifiziert per `/api/admin/debug` (`replicateActive: true`).

Provisionierung: `bash scripts/hetzner/provision-fleet.sh`
(Trockenlauf: `--print-config`)

## Knoten im Detail (Default-Typen der CLI, je Rolle überschreibbar)

| # | Name | Hetzner-Typ (Default) | Override | Zweck |
|---|---|---|---|---|
| 1 | **app-1** | cx23 | `FLEET_TYPE_APP` | Caddy + audiomonastry (App, API, Signaling) – ENABLE_SFU=0 |
| 2 | **sfu-1** | cx23 | `FLEET_TYPE_SFU` | Caddy + audiomonastry mit `docker-compose.sfu.yml` (Mediasoup, UDP 40000–40099) |
| 3 | **ai-1** | cx23 | `FLEET_TYPE_AI` | Ollama (host-nativ, systemd) + Stem-CPU-Fallback (Demucs) |
| 4 | **master-1** | cx23 | `FLEET_TYPE_MASTER` | master-player (FFmpeg-Mixing/Mastering) |
| 5 | **edge-1** | cx23 | `FLEET_TYPE_EDGE` | **Nur** Monitoring-Stack (Prometheus/Grafana/cAdvisor/node-exporter), Smoke-Tests |

> Der Portal-Worker provisioniert dieselben Rollen mit seinen eigenen Fallbacks
> (app/sfu/ai `cx33`, master/edge `cx23`) – siehe Tabelle oben. Ein Override muss
> immer in dem Pfad gesetzt werden, der den Server anlegt.

## Wichtige Erkenntnisse aus dem Fleet-Test (2026-08-29)

1. **Hetzner-Limit:** Aktuell max. 5 Server pro Account – genau unsere 5er-Flotte.
   Für mehr Knoten beim Hetzner-Support ein Limit-Upgrade anfragen.
2. **SFU-Knoten braucht Caddy:** Ohne HTTP-Proxy ist `/sfu-signaling` nicht
   erreichbar → auf sfu-1 immer `caddy` mitstarten.
3. **Redis-Adapter:** Mit `REDIS_URL` teilen mehrere App-Knoten die
   Socket.io-Räume (Session-/Plugin-State über Prozessgrenzen).
   Redis läuft als Compose-Profil: `--profile fleet up -d redis`.
4. **Stem:** Ohne `STEM_AI_URL` nutzt `/api/separate-stems` den lokalen
   Fallback. GPU-Stem nur auf ai-1 aktivieren.
5. **Provisioning nach Rolle:** `ROLE=sfu` öffnet die RTP-Ports in der
   Hetzner-Firewall, `FLOATING_IP_NAME=none` überspringt die Floating IP
   (nur app-1 braucht die feste IP für DNS).
6. **Fleet-Test verifiziert (2026-08-29):** Redis-Adapter läuft auf beiden
   App-Instanzen (`docker-compose.fleet-test.yml` + `--profile fleet`);
   Cross-Instanz-Signaling (Offer A→B, Answer B→A über Redis) erfolgreich.
   Test: `tail -n +2 scripts/hetzner/fleet-redis-test.mjs | docker exec -i -w /app audiomonastry node --input-type=module -`

## ai-1 (CPU, cx23): lokale KI + Stem

> Status 2026-08-30: **installiert + aktiv** (Ollama 0.33.2 mit `qwen2.5:7b`,
> stem-ai systemd-Dienst auf Port 8000, `AI_DEVICE=cpu`). Replicate bleibt
> Primärpfad für Stems/Voice; ai-1 ist der lokale Fallback.

```bash
# Ollama (MOA/LLM/TTS/Song-Fallback) – installiert via:
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen2.5:7b
systemctl enable --now ollama          # API: http://127.0.0.1:11434

# Stem-AI (Demucs) als systemd-Dienst:
cd /opt/audiomonastry/services/stem-ai
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
# Unit: /etc/systemd/system/stem-ai.service (ExecStart uvicorn main:app --port 8000)
systemctl enable --now stem-ai          # Health: http://127.0.0.1:8000/health
```

```bash
# app-1/.env
OLLAMA_URL=http://<ai-1>:11434
OLLAMA_MODEL=qwen2.5:7b
STEM_AI_URL=http://<ai-1>:8000
ENABLE_STEMS=1
```

## app-1 (App/API/Signaling)

```bash
# .env
DOMAIN=anunnakitools.de
ENABLE_SFU=0
REDIS_URL=redis://<redis-host>:6379   # erst ab 2 App-Knoten nötig
MASTER_PLAYER_URL=http://<master-1>:8000
# STEM_AI_URL/OLLAMA_URL zeigen auf ai-1
```

```bash
docker compose -f docker-compose.hetzner.yml up -d caddy audiomonastry
```

## sfu-1 (Mediasoup)

```bash
# .env: SFU_ANNOUNCED_IP=<public-ip>, SIGNALING_ALLOWED_ORIGINS=*
docker compose -f docker-compose.hetzner.yml -f docker-compose.sfu.yml up -d caddy audiomonastry
```

Firewall: UDP/TCP **40000–40099** zusätzlich öffnen.

## master-1 (Mastering)

```bash
docker compose -f docker-compose.hetzner.yml up -d master-player
# Health: curl http://localhost:8000/health  (Port 8000 intern, via Firewall nur bei Bedarf)
```

## edge-1 (Monitoring-Knoten; Rolle `edge`)

```bash
# NUR der Monitoring-Stack (INFRA-HETZNER-006). Die explizite Service-Liste ist
# Pflicht: ohne sie startet die Basisdatei zusätzlich caddy + audiomonastry +
# master-player (4672 MiB deklarierte Limits auf einem 4-GB-cx23).
ssh root@<edge-1-ip> 'cd /opt/audiomonastry && docker compose -f docker-compose.hetzner.yml -f docker-compose.monitoring.yml up -d node-exporter cadvisor prometheus alertmanager grafana'
# (bring-up-fleet.sh macht dasselbe über $MONITORING_SERVICES)

# Grafana ist nur auf 127.0.0.1 des Knotens veröffentlicht -> SSH-Tunnel:
ssh -L 3000:127.0.0.1:3000 root@<edge-1-ip>     # dann http://127.0.0.1:3000
# Prometheus (9090) / Alertmanager (9093): rein intern (kein Port, keine Firewall-Regel).

# Smoke-Test prüft die App (app-1) – nicht den Monitoring-Knoten:
bash scripts/hetzner/smoke-test.sh https://anunnakitools.de
```

Kein App-Deploy auf edge-1: der Knoten trägt **keinen** App-Traffic. Ein
`DEPLOY_HOST=<edge-1> bash deploy.sh` würde Caddy + App auf den Monitoring-Knoten
bringen und dort einen zweiten Caddy für dieselbe Domain starten.

> **Bereits benutzte edge-Knoten (Ehrlichkeitsgrenze):** Wird edge-1 aus einem
> **alten Rollen-Snapshot** gebootet, zieht Docker dort per
> `restart: unless-stopped` die damals gestarteten Container
> (`caddy`/`audiomonastry`/`master-player`) wieder hoch — der Portal-Wake führt bei
> Snapshot-Starts **kein** Compose aus. Der CLI-Pfad stoppt sie beim Flottenstart
> automatisch (`bring-up-fleet.sh`, Schritt 6); für den Portal-Pfad gilt einmalig
> auf dem Knoten: `docker compose -f docker-compose.hetzner.yml -f docker-compose.monitoring.yml stop caddy audiomonastry master-player` — danach ein frisches
> edge-Snapshot ziehen.

## AI-Routing (LlmRouter)

1. DeepSeek V4 Flash (MOA/MCP) → 2. Hugging Face → 3. Mistral → 4. Groq Free
→ 5. **Ollama (ai-1, lokal)** → 6. DeepSeek V4 Pro → Notfall Gemini/OpenAI.

> **Stand 2026-09-20:** Groq ist entfernt; das lokale LLM der Flotte läuft über
> die RunPod-Rolle `brain` (`runpod-local` im `LlmRouter`), Ollama auf ai-1
> bleibt Fallback. Betriebsmodi („AI an"/„AI aus", immer-Rollen vs.
> Visual-Rollen nur bei Abruf): `docs/INFRA_KONSTITUTION.md` §2.

## Qualitäts-Eckpunkte

- Master-Player rendert mit FFmpeg/NumPy bei 48 kHz, True-Peak-Limiter im Worklet.
- Deterministische Bounces: `OfflineBounceEngine` + Golden-Master-Tests.
- PDC: Monitor-/Cue-Pfad um Mastering-Lookahead kompensiert.

## Kosten (netto, Preisstand 15.06.2026 – Preiserhöhungen eingepreist)

Typen je Rolle: siehe Tabelle oben. Preise je Typ und Klasse:
`docs/HETZNER_DEPLOY.md` §1 (CX23 = 5,49 €, CX33 = 8,49 €, Floating-IPv4 = 3,00 €).

| Konfiguration | Rechnung | Summe |
|---|---|---|
| **Portal-Fallback** (3× cx33 + 2× cx23) | 3 × 8,49 € + 2 × 5,49 € + 3,00 € | **39,45 €/Monat ≈ 0,054 €/h** |
| **CLI-Default** (`provision-fleet.sh`: 5× cx23) | 5 × 5,49 € + 3,00 € | **30,45 €/Monat ≈ 0,042 €/h** |

> Die Zahl **39,45 €/Monat ≈ 0,054 €/h** ist die in `docs/INFRA_KONSTITUTION.md`
> §2 genannte Größe („nur Hetzner"); sie gilt für die Typen des Portal-Pfads.
> Der CLI-Default ist eine Klasse kleiner (cx23 überall), weil jeder Knoten nur
> seine Rolle trägt. Beides sind Summen der oben genannten Listenpreise, keine
> Live-Preisliste. Kanonischer Rahmen: 5 Hetzner-Server,
> 8 RunPod-Rollen-Endpoints, laufende Flottenkosten (Hetzner + RunPod)
> **max. 10 €/h**, Zielband **5–7,5 €/h**; bei „AI aus" bleiben nur die
> Hetzner-Kosten.

> Empfehlung (nicht konfiguriert): CCX33 ist 2026 auf 138,49 €/Monat gestiegen
> (+122 %) und lohnt nur noch bei garantiert dedizierter CPU. Die CAX-Serie
> (CAX21/CAX31, ARM) bleibt die Preis-Leistungs-Empfehlung für alles außer dem
> SFU-Knoten (mediasoup-worker hat offizielle x86_64-Prebuilds; ARM erfordert
> Source-Build) – ein solcher Mix wird per `FLEET_TYPE_<ROLLE>` gewählt, ist aber
> **nicht** der Default.

## Load Balancer (LB11) – bewusst noch nicht im Einsatz

> Entscheidung (2026-09-02): Der aktuelle Betrieb läuft mit **einem** App-Knoten
> hinter Cloudflare; eine Session lebt auf genau diesem Knoten. Ein Load
> Balancer bringt dort keinen Nutzen und kostet nur zusätzlich.

| Punkt | Festlegung |
|---|---|
| Kosten | **0,012 €/h netto**, Deckel **7,49 €/Monat netto** (LB11, Standort Europa, Stand 04/2026), 20 TB Traffic inklusive |
| Abrechnung | **stündlich** – es wird nur gezahlt, solange der LB existiert (wie bei den Servern: löschen = 0 €) |
| Trigger | Erst installieren, wenn **≥ 2 App-Knoten** laufen, d. h. bei Multi-Session-Betrieb, > 4 Usern pro Session oder HA-/Zero-Downtime-Deploys |
| Architektur | Cloudflare → Hetzner LB11 (**sticky Sessions** für WebSocket) → `app-1`/`app-2`; Socket.io-Räume über den Redis-Adapter teilen (`REDIS_URL`); Mediasoup/SFU bleibt auf dem dedizierten Knoten (UDP/RTP darf **nicht** über den LB laufen) |
| Prüfpunkt (offen) | 2 App-Knoten hinter dem LB, 4-User-E2E grün (State-Sync, Locking, Main-Stream stabil) + Failover-Test (ein Knoten entfernen) |

Solange nur `app-1` läuft, bleibt die Kette **Cloudflare → Floating-IP → app-1**
unverändert; es ist keine Konfigurationsänderung nötig.

