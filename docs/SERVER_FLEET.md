# audioMONASTRY – 5-Instanzen-Architektur (final)

> Stand: 2026-08-30 · Ziel: 5 Server, klare Rollen, GPU nur für lokale KI/Stem.
> Cloud bleibt extern: Supabase (DB), Cloudflare R2 (Audio-Blobs),
> DeepSeek/HF/Mistral/Replicate (Cloud-KI). Lokale KI/Stem laufen auf ai-1.

## 💶 Kostenmodell (wichtig, Stand 2026-08-30)

- **Hetzner berechnet Server ab ERSTELLUNG – auch im ausgeschalteten Zustand.**
  Der 20-min-Idle-Auto-Shutdown spart daher **kein Geld**, nur Ressourcen.
- Kosten stoppen geht **nur durch Löschen** der Server.
- Aktuelle Flotte (netto): 3× CX33 (à 8,49 €) + 2× CX23 (à 5,49 €)
  + Floating-IPv4 (3,00 €) = **≈ 39,45 €/Monat**, solange die Server existieren.
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

## Live-Flotte (Stand 2026-08-30: gelöscht, Floating-IP reserviert)

| # | Name | Typ | IP | Rolle |
|---|---|---|---|---|
| 1 | samplemonk-app-1 | CX33 | 159.69.102.29 (Floating) | Caddy + App/API/Signaling + master-player |
| 2 | samplemonk-sfu-1 | CX33 | 49.13.0.226 | Caddy + Mediasoup-SFU (UDP/TCP 40000–40099) |
| 3 | samplemonk-ai-1 | CX33 | 49.13.65.150 | Ollama/Stem-CPU-Fallback (installiert + aktiv, systemd) |
| 4 | samplemonk-master-1 | CX23 | 167.233.22.157 | master-player (FFmpeg-Mixing/Mastering) |
| 5 | samplemonk-edge-1 | CX23 | 167.233.214.220 | Staging, Prometheus/Grafana/cAdvisor/node-exporter, Smoke |

Alle 5 Einheiten haben Idle-Auto-Shutdown (20 min ohne aktive User/Session
fährt die Instanz herunter – stündliche Abrechnung). **Replicate ist aktiv**
(`REPLICATE_API_TOKEN` gesetzt, `STEM_AI_PROVIDER=replicate`,
`VOICE_PROVIDER=replicate`): Demucs-Stems und Bark-TTS/Sing laufen über die
GPU-Cloud. Verifiziert per `/api/admin/debug` (`replicateActive: true`).

Provisionierung: `bash scripts/hetzner/provision-fleet.sh`

## Flotte (5 Instanzen)

| # | Name | Hetzner-Typ | Rolle |
|---|---|---|---|
| 1 | **ai-1** | CCX33 (CPU) | Ollama (MOA/LLM/TTS/Song-Fallback) + Stem-CPU-Fallback (Demucs) |
| 2 | **app-1** | CPX31 | Caddy + sample-monk (App, API, Signaling) – ENABLE_SFU=0 |
| 3 | **sfu-1** | CPX31 | Caddy + sample-monk mit `docker-compose.sfu.yml` (Mediasoup, UDP 40000–40099) |
| 4 | **master-1** | CX23 | master-player (FFmpeg-Mixing/Mastering) |
| 5 | **edge-1** | CX23 | Staging, Smoke-Tests, Monitoring, Backup-Target |

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
   Test: `tail -n +2 scripts/hetzner/fleet-redis-test.mjs | docker exec -i -w /app samplemonk node --input-type=module -`

## ai-1 (CPU, CCX33): lokale KI + Stem

> Status 2026-08-30: **installiert + aktiv** (Ollama 0.33.2 mit `qwen2.5:7b`,
> stem-ai systemd-Dienst auf Port 8000, `AI_DEVICE=cpu`). Replicate bleibt
> Primärpfad für Stems/Voice; ai-1 ist der lokale Fallback.

```bash
# Ollama (MOA/LLM/TTS/Song-Fallback) – installiert via:
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen2.5:7b
systemctl enable --now ollama          # API: http://127.0.0.1:11434

# Stem-AI (Demucs) als systemd-Dienst:
cd /opt/samplemonk/services/stem-ai
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
docker compose -f docker-compose.hetzner.yml up -d caddy sample-monk
```

## sfu-1 (Mediasoup)

```bash
# .env: SFU_ANNOUNCED_IP=<public-ip>, SIGNALING_ALLOWED_ORIGINS=*
docker compose -f docker-compose.hetzner.yml -f docker-compose.sfu.yml up -d caddy sample-monk
```

Firewall: UDP/TCP **40000–40099** zusätzlich öffnen.

## master-1 (Mastering)

```bash
docker compose -f docker-compose.hetzner.yml up -d master-player
# Health: curl http://localhost:8000/health  (Port 8000 intern, via Firewall nur bei Bedarf)
```

## edge-1 (Staging/Smoke/Monitoring)

```bash
DEPLOY_HOST=<edge-1> DEPLOY_DOMAIN= bash deploy.sh
bash scripts/hetzner/smoke-test.sh http://<edge-1>

# Observability-Stack (Prometheus/Grafana/cAdvisor/node-exporter):
docker compose -f docker-compose.hetzner.yml -f docker-compose.monitoring.yml up -d
# Grafana: http://<edge-1>:3000 (Port 3000 in der Hetzner-Firewall freigeben)
```

## AI-Routing (LlmRouter)

1. DeepSeek V4 Flash (MOA/MCP) → 2. Hugging Face → 3. Mistral → 4. Groq Free
→ 5. **Ollama (ai-1, lokal)** → 6. DeepSeek V4 Pro → Notfall Gemini/OpenAI.

## Qualitäts-Eckpunkte

- Master-Player rendert mit FFmpeg/NumPy bei 48 kHz, True-Peak-Limiter im Worklet.
- Deterministische Bounces: `OfflineBounceEngine` + Golden-Master-Tests.
- PDC: Monitor-/Cue-Pfad um Mastering-Lookahead kompensiert.

## Kosten (netto/Monat, Stand 15.06.2026 – Hetzner-Preiserhöhungen eingepreist)

| Komponente | Typ | Preis |
|---|---|---|
| ai-1 (Stem/Ollama CPU) | **CAX31** (ARM, 8 vCPU/16 GB) | 20,99 € ≈ 0,0336 €/h |
| app-1 | **CAX21** (ARM, 4 vCPU/8 GB) | 10,49 € ≈ 0,0168 €/h |
| sfu-1 (Mediasoup, x86-Prebuilds) | **CX33** (x86, 4 vCPU/8 GB) | 8,49 € ≈ 0,0136 €/h |
| master-1 | **CAX21** (ARM) | 10,49 € ≈ 0,0168 €/h |
| edge-1 | **CAX21** (ARM) | 10,49 € ≈ 0,0168 €/h |
| Floating-IP | – | 3 € |

> Hinweis: CCX33 ist 2026 auf 138,49 €/Monat gestiegen (+122 %) und lohnt nur
> noch bei garantiert dedizierter CPU. Die CAX-Serie ist die neue
> Preis-Leistungs-Empfehlung für alles außer dem SFU-Knoten (mediasoup-worker
> hat offizielle x86_64-Prebuilds; ARM erfordert Source-Build).
| **Summe (alle 5, stündlich)** | **≈ 0,096 €/h** |

