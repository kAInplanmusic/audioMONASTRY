# AI Fleet Integration Status

## 2026-11-08 Aktualisierung

### ✅ Abgeschlossene Verbesserungen

**1. MERT-v2 Label korrigiert**
- model_manifest.json: `mert-v1-330m` → `mert-v2-330m`
- pod-fleet.json: MERT-Referenz aktualisiert

**2. Qwen-Omni Integration**
- requirements-ears-ai.lock: `qwen-omni-utils` integriert
- Modell im Manifest noch auszuholen (status: neu)

**3. pyannote 4.x torch 2.8**
- Dockerfile.runpod bereits für torch 2.8 vorbereitet
- Build-Arg `AI_INSTALL_PYANNOTE4=1` bereits implementiert

**4. NVIDIA MusicFlamingo**
- pod-fleet.json: `musicFlamingoErsatz` konfiguriert
- Dynamische Lade-Unterstützung

**5. 8. Pod DJ-AI**
- Deploy/runpod/pod-8-nvidia-audio.json erstellt
- Modelle: MusicFlamingo, MusicGen, DJ-AI Features
- GPU: NVIDIA RTX 4090 (24GB NVENC)

**6. Gewichte-Spiegelung bereit**
- scripts/weights-mirror.py konfiguriert
- R2 Bucket `audiomonastrysamples` bereit

### 🔄 Noch auszuführen

```bash
# R2 Umgebungsvariablen setzen
export CFS3_BUCKET=audiomonastrysamples
export CFS3_ACCESS_KEY=<key>
export CFS3_SECRET_KEY=<secret>
export CFR2_ACCOUNT_ID=<account_id>

# Gewichte spiegeln
python3 scripts/weights-mirror.py --yes

# Pods starten
python3 scripts/runpod-pods.py up --yes --wait 900
```

### 📊 Kostenplan

Aktueller Stand: ~2,44 €/h (5 Pods + visPod)
Mit 8. Pod: ~2,78 €/h (unter 4 €/h Deckel)

### 🐛 Offene Issues

Siehe docs/RUNPOD_ISSUES.md (DEPLOY-001, DEPLOY-002)