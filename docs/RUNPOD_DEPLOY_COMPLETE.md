# RunPod Fleet Deployment Guide

## Aktueller Stand (2026-11-07)

### Hetzner-Server
- **Status**: Läuft
- **IP**: 78.47.218.180 (Floating IP) / 49.13.138.200 (Privat)
- **App**: Healthy, commit 402dfc8, Version 1.210.001
- **Containers**: audiomonastry, audiomonastry-master, audiomonastry-caddy, audiomonastry-redis

### RunPod Kapazität
- **Status**: Eingeschränkt verfügbar
- **48GB GPUs**: RTX PRO 5000 Blackwell ($0.82/h), RTX PRO 6000 MIG 2g.48gb ($1.00/h)
- **24GB GPUs**: RTX 4090 ($0.34/h), RTX 5090 ($0.69/h), RTX PRO 6000 MIG 1g.24gb ($0.50/h, Medium stock)
- **Balance**: ~$9.84 USD verfügbar

### Konfigurierte Pods
| Rolle | GPU Pool | VRAM | Max €/h | Modelle |
|-------|----------|------|---------|---------|
| brain | 48GB | 29G | 0.92 | qwen3-30b-a3b-awq, qwen3-4b |
| ears | 48GB | 26G | 0.92 | whisper-large-v3, clap-music, mert-v1-330m, qwen2-audio-7b, pyannote-diarization, ast-audioset, essentia |
| voice | 48GB | 39G | 0.92 | qwen3-tts-17b, qwen3-tts-voicedesign, qwen3-tts-06b-base, moss-soundeffect-v.0, acestep-v15-xl-base, acestep-v15-shared |
| stems | 24GB | 14G | 0.64 | bs-roformer-sw-6stem, htdemucs-6s |
| music | 48GB | 31G | 0.92 | acestep-v15-xl-sft, acestep-v15-xl-turbo, acestep-5hz-lm-4b, acestep-v15-shared |

**Gesamtbudget**: max. 6.00 €/h (aktuell ~4.32 €/h)

## Skripte

### Fleet Start/Stopt
```bash
# Absolute Entry Points
./fleet-start.sh      # Startet Hetzner-Server + RunPod-Pods
./fleet-stop.sh       # Stoppt alles + erstellt Snapshots

# Python Manager (direkte API-Calls)
python3 scripts/fleet_manager.py start    # Start
python3 scripts/fleet_manager.py stop     # Stop + Snapshot
python3 scripts/fleet_manager.py status   # Status anzeigen
```

### RunPod Pod Management
```bash
# Planen anzeigen
python3 scripts/runpod-pods.py plan

# Pods starten (mit --yes bestätigen)
python3 scripts/runpod-pods.py up

# Pods stoppen
python3 scripts/runpod-pods.py down

# Status prüfen
python3 scripts/runpod-pods.py status
```

## Snapshots (Sicherheitsnetz)
- 9 Snapshots vorhanden (letzte vom 2026-11-07)
- Image ID 453326244: audiomonastry-snapshot-media-1-2026-11-07
- Automatischer Snapshot vor jeder Löschung in stop-Fleet.sh

## Alternative GPUs (unter $1/h)

### 48GB
- NVIDIA RTX PRO 5000 Blackwell: $0.82/h, Stock: Low
- NVIDIA RTX PRO 6000 Blackwell MIG 2g.48gb: $1.00/h, Stock: Low

### 24GB
- NVIDIA GeForce RTX 4090: $0.34/h, Stock: Low
- NVIDIA RTX PRO 6000 Blackwell MIG 1g.24gb: $0.50/h, Stock: Medium ✅
- NVIDIA GeForce RTX 5090: $0.69/h, Stock: Low

### Konkurrenz-Alternativen (falls RunPod ausgebucht)

#### Vast.ai
- RTX 4090: ~$0.30-0.60/h
- RTX 4090 Ti: ~$0.40-0.50/h
- A6000: ~$0.40-0.70/h
- Vorteil: sehr große Community, oft verfügbare GPUs

#### Lambda Labs
- RTX 4090: ~$0.50-0.70/h
- A6000: ~$0.60-0.80/h
- H100: ~$1.50-2.50/h

#### CoreWeave
- RTX 4090: ~$0.50-0.80/h
- A6000: ~$0.70-1.00/h

## Deployment-Workflow

### Von Grund auf neu
```bash
# 1. Alle Instanzen sichern und löschen
./fleet-stop.sh

# 2. Neue Server/Pods erstellen
./fleet-start.sh

# 3. App deployen
./deploy.sh

# 4. Health check
curl -sk https://78.47.218.180/api/health
```

### Nur RunPod-Pods
```bash
# Pods planen
python3 scripts/runpod-pods.py plan

# Pods starten
python3 scripts/runpod-pods.py up

# Prüfen
python3 scripts/runpod-pods.py status
```

## Probleme & Lösungen

| Problem | Lösung |
|---------|--------|
| RP_POD_IMAGE fehlt | Setze RP_POD_IMAGE in .env.deploy |
| GPU-Kapazität nicht verfügbar | Nutze Alternative-GPUs oder andere Anbieter |
| GHCR Pull Error | Setze GHCR_USERNAME/GHCR_PASSWORD oder nutze vorhandene Image-Region |
| Budget überschritten | Nutze günstigere GPUs oder reduziere Anzahl Pods |