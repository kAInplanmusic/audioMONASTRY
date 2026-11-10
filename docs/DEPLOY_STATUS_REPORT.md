# RunPod Fleet Deployment - Final Status Report

> **Historischer Bericht — nicht die gültige RunPod-SSOT (2026-11-10).** Datierten Angaben zu GPU, Gewichtsspiegel, Rollen, Deploy, Preisen und damaliger Live-Prüfung nicht als aktuelle Fakten verwenden. **Aktive Referenz:** [RunPod Fleet SSOT](RUNPOD_FLEET_SSOT.md) mit `deploy/runpod/pod-fleet.json` und `services/audiomonastry-ai-runtime/model_manifest.json`: acht heterogene Pods (`brain`, `ears`, `voice`, `music`, `studio`, `audio-brain`, `song`, `vis`), RunPod-Gesamtbudget **8 €/h**. Historische Serverless-Bild-/Video-Rollen nicht deployen.


## 2026-11-07 19:30 UTC

### Zusammenfassung
Die audioMONASTRY Fleet-Konfiguration wurde erfolgreich aktualisiert und getestet. Die Hetzner-App ist gesund und funktionstüchtig. RunPod-Pods können nicht gestartet werden, da die Modell-Gewichte noch in R2 nicht verfügbar sind.

### Systemstatus

#### Hetzner-Server ✅
- **Status**: Läuft (healthy)
- **IP**: 78.47.218.180 (Floating IP)
- **App**: `/api/health` → `{"status":"ok","version":"1.210.001"}`
- **Container**: audiomonastry, caddy, redis, audiomonastry-master aktiv

#### RunPod Fleet ✅
- **Planung**: 4.32 €/h (unter 6.00 €/h Budget)
- **Verfügbare GPUs**:
  - 48GB: NVIDIA A40 ($0.35/h), RTX PRO 5000 ($0.82/h), RTX PRO 6000 MIG ($1.00/h)
  - 24GB: RTX 4090 ($0.34/h), RTX 5090 ($0.69/h), MIG 1g.24gb ($0.50/h)
- **Pods**: 5 konfiguriert (brain, ears, voice, stems, music)

#### Probleme ❌
1. **Gewichte nicht in R2** - `scripts/weights-mirror.py` muss ausgeführt werden
2. **Schema-Problem** - RunPod API blockiert POD-Erstellung ohne Gewichte-URLs

### Änderungen durchgeführt

#### deploy/runpod/pod-fleet.json
```diff
- "maxEurPerHour": 4
+ "maxEurPerHour": 6

48GB Pool:
+ NVIDIA A40 (0.35 $/h) - jetzt verfügbar
  NVIDIA RTX PRO 5000 Blackwell (0.82 $/h)
  NVIDIA RTX PRO 6000 MIG 2g.48gb (1.00 $/h)

24GB Pool:
  NVIDIA GeForce RTX 4090 (0.34 $/h)
  NVIDIA GeForce RTX 5090 (0.69 $/h)
+ NVIDIA RTX PRO 6000 MIG 1g.24gb (0.50 $/h)

stems-Pod: gpuPool "48gb" → "24gb-nvenc" (spart Kosten)
```

#### scripts/runpod-pods.py
```diff
ALLOWED_GPU_IDS += (
+ "NVIDIA RTX PRO 5000 Blackwell",
+ "NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 2g.48gb",
+ "NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 1g.24gb",
)
```

### Skripte für Deployment

#### Fleet Start/Stopp
```bash
cd /path/to/audioMONASTRY

# Alle Instanzen sichern und löschen
./fleet-stop.sh

# Neuestart mit Snapshot-Sicherung
./fleet-start.sh
```

#### RunPod Pods verwalten
```bash
# 1. Gewichte synchronisieren (VOR dem Start!)
python3 scripts/weights-mirror.py --yes

# 2. Pod-Plan prüfen
python3 scripts/runpod-pods.py plan

# 3. Pods starten
python3 scripts/runpod-pods.py up --yes

# 4. Status prüfen
python3 scripts/runpod-pods.py status

# 5. Pods stoppen (automatischer Snapshot)
python3 scripts/runpod-pods.py down --yes
```

#### App testen
```bash
# Health check
curl -sk --resolve anunnakitools.de:443:78.47.218.180 \
  https://anunnakitools.de/api/health

# AI Integration Test
python3 scripts/ai-integration-test.py
```

### Nächste Schritte

1. **[PRIORITÄT]** `scripts/weights-mirror.py` ausführen, um Gewichte nach R2 zu übertragen
2. **[MITTEL]** STUDIO_TOKEN in `.env.deploy` für API-Zugriff hinzufügen
3. **[HOCH]** RunPod-Pods starten nach Gewichts-Synchronisierung
4. **[KONTROLLIERT]** Monitoring für Kosten einrichten (max 6€/h)

### Alternative GPU-Anbieter (für Kapazitätsengpässe)

| Anbieter | RTX 4090 | A6000 | Preisvergleich |
|----------|----------|-------|----------------|
| RunPod | $0.34/h | - | ✅ Hauptanbieter |
| Vast.ai | $0.30-0.60/h | $0.40-0.70/h | ✅ Alternative |
| Lambda Labs | $0.50-0.70/h | $0.60-0.80/h | ✅ Backup |
| CoreWeave | $0.50-0.80/h | $0.70-1.00/h | ⚠️ Teurer |

### Commits
```
8048469: feat: Update RunPod fleet configuration with available GPUs
```

### Dokumentation
- `docs/RUNPOD_DEPLOY_COMPLETE.md` - Vollständige Anleitung
- `docs/RUNPOD_ISSUES.md` - Issues & Lösungen
- `docs/FLEET_RUNBOOK.md` - Betriebshandbuch
- `scripts/ai-integration-test.py` - Test-Suite
- `fleet-start.sh` / `fleet-stop.sh` - Absolute Entry Points