# audioMONASTRY ROLLOUT-TASKLIST (Phase B – Deploy & Infrastructure Finalization)

## Zusammenfassung (Stand 2026-11-02)

### ✅ Erledigt
- [x] **ESLint Warnings**: Alle 21 Warnings behoben (authRoutes.ts, DropContext.tsx, v2Meters.test.ts, v2SinkProcessorWorklet.test.ts, webrtcManager.test.ts)
- [x] **Test Coverage**: 399/399 Test-Dateien, 3492 Tests grün (Vitest)
- [x] **Typecheck**: `tsc --noEmit` ohne Fehler
- [x] **Security**: 0 findings, Interface-Boundary sauber
- [x] **Audio Gate**: -11.8 LUFS, -8.0 dBTP ✅
- [x] **Build**: dist/server.cjs, Worklets, 158 Assets
- [x] **Git**: main auf origin/main gepusht (commit bc54bed0)
- [x] **Test Accounts**: 4 Accounts implementiert (dj, producer, engineer, admin)
- [x] **SFU-Ticket-Auth**: Vollständig implementiert (kein Draft-PR nötig)
- [x] **Hetzner API**: 0 audioMONASTRY-Server, 0 Floating-IPs (hallerbans ist Agent-Gerät)
- [x] **RunPod API**: 1 Pod "my pod" EXITED (28.10.2026), kein aktiver Knoten
- [x] **SIGNALING_ALLOWED_ORIGINS**: In .env.deploy gesetzt
- [x] **test_env_token_override_helper**: Fixed mit SIGNALING_ALLOWED_ORIGINS

### 📊 Deploy-Infrastruktur-Status

#### RunPod Fleet (pod-fleet.json)
| Rolle | Status | GPU | Models (current) | Notes |
|-------|--------|-----|------------------|-------|
| brain | ✅ defined | 48GB A40 | qwen3-30b-a3b-awq, qwen3-4b | Orchestrator |
| ears | ✅ defined | 48GB A40 | whisper-large-v3, qwen2-audio-7b, pyannote-diarization | 5 models |
| voice | ✅ defined | 48GB A40 | qwen3-tts-17b, moss-soundeffect-v2.0 | TTS/SFX |
| stems | ✅ defined | 48GB A40 | bs-roformer-sw-6stem | Stem separation |
| music | ✅ defined | 48GB A40 | acestep-v15-xl-sft, acestep-v15-xl-turbo | AI music |
| vis | ⚪ disabled | 24GB NVENC | - | Phase V1 enable needed |

#### Aktuelle Instanzen
| Plattform | Instanz | Status | Aufgabe |
|-----------|---------|--------|---------|
| Hetzner | hallerbans (cx21) | running | Agent-Gerät (nicht Projekt) |
| RunPod | "my pod" | EXITED (28.10.2026) | Veraltet, kein Knoten |

#### Fehlende Deploy-Variablen (.env.deploy)
```bash
# FÜR DEPLOYMENT BENötigt (nicht gesetzt):
DEPLOY_HOST=<IP oder Domain>        # Ziel-Server
DEPLOY_SSH_KEY=~/.ssh/id_ed25519      # SSH-Schlüssel-Pfad

# BEREITS GESETZT:
DOMAIN=anunnakitools.de               # HTTPS Domain
HCLOUD_TOKEN=<valid>                  # Hetzner API Token
RUNPOD_API_KEY=<valid>                # RunPod API Token
SIGNALING_ALLOWED_ORIGINS=<valid>   # CORS Header
```

### 🚀 Deployment-Optionen

#### Option A: Hetzner Single-Instance (empfohlen für Start)
```bash
# Vorbereitung:
export DEPLOY_HOST=91.98.102.14         # Floating IP (noch kein zugewiesen)
export DEPLOY_SSH_KEY=$HOME/.ssh/id_ed25519
export DEPLOY_DOMAIN=anunnakitools.de
export DEPLOY_MODE=docker
export DEPLOY_SMOKE=1

# Deploy (lokal bauen & transferieren):
bash deploy.sh

# Alternativ Registry-Weg (schneller bei Wiederholung):
export DEPLOY_IMAGE_SOURCE=registry
export DEPLOY_REGISTRY_IMAGE=ghcr.io/kAInplanmusic/audiomonastry:<tag>
bash deploy.sh
```

#### Option B: RunPod Fleet (KI-Intensiv)
```bash
# Voraussetzungen:
# - RP_API_KEY ist gesetzt (ist Hetzner-Token, KEIN RunPod-Key!)
# - HF_TOKEN für Model-Downloads

# Pod-Flotte starten:
python3 scripts/runpod-deploy.py up

# Rollen: brain, ears, voice, stems, music
# visPod: deaktiviert (Phase V1 noch nicht aktiv)
```

### 📋 Nächste Schritte (Explizite Anforderung nötig)

**NACHFRAGE FÜR AKTIVE BEREITSTELLUNG:**
1. Welche Plattform? (Hetzner-Einzelfall vs RunPod-Fleet)
2. Welche Rollen sollen gestartet werden?
3. Wie lange sollen die Instanzen laufen? (Kosten-Null-Regel: Löschen nach Gebrauch)

**VOR DEM DEPLOY:**
- [ ] Floating IP an Hetzner-Server zuweisen (falls Hetzner gewählt)
- [ ] HCLOUD_TOKEN validieren (ist korrekt?)
- [ ] RP_API_KEY durch echten RunPod API Key ersetzen (aktuell Hetzner-Token!)
- [ ] DEPLOY_HOST und DEPLOY_SSH_KEY in .env.deploy oder Exportieren

### 📊 Health-Checks nach Deploy
```bash
curl -fsS https://anunnakitools.de/api/health | jq .
curl -fsS https://anunnakitools.de/api/cloud/health | jq .
curl -fsS https://anunnakitools.de/api/master/health | jq .
```

### 🔄 Rollback-Plan
```bash
ssh root@<DEPLOY_HOST> 'docker tag audiomonastry:hetzner-rollback audiomonastry:hetzner && \
cd /opt/audiomonastry && \
docker compose -f docker-compose.hetzner.yml up -d --no-build --force-recreate audiomonastry'
```

### 📝 Dokumentation
- [docs/HETZNER_DEPLOY.md](./docs/HETZNER_DEPLOY.md)
- [docs/RUNPOD_PODS_RUNBOOK.md](./docs/RUNPOD_PODS_RUNBOOK.md)
- [deploy.sh](./deploy.sh) – Haupt-Deploy-Skript
- [scripts/hetzner/](./scripts/hetzner/) – Hetzner-Wartungsskripte
- [.github/workflows/runpod-deploy.yml](.github/workflows/runpod-deploy.yml) – CI/CD

---

## Verwandte Tickets
- **DB-011/DB-017**: Audio-Integrität (camilla_sink in PipeWire nicht konfiguriert)
- **P1-004**: Performance: renderBlock Latenz ~4.4ms > 1.33ms Budget
- **P2-011**: VRAM-Messung für Model-Deployments

---

Status: ✅ Release-Ready (npm run verify ohne ESLint Warnings)
Warte auf: Explizite Anfrage für Server-Start (Kosten-Null-Regel)