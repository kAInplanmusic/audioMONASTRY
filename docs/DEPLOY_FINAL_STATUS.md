# RunPod Fleet Deployment - Aktueller Stand

## 2026-11-07 19:45 UTC

### ✅ Was funktioniert

> Historischer Abschnitt archiviert: `EVIDENCE_REGISTRY.json` →
> `R2-A2-HISTORY-DOMAIN-04`, Originalzeilen 7–11.
> Der unveränderte Wortlaut ist dort nachlesbar; keine aktuelle Dienstzusage.

**RunPod Konfiguration**
- alle 5 Pods konfiguriert (brain, ears, voice, stems, music)
- Budget: 6.00 €/h (aktueller Plan: 4.32 €/h)
- verfügbare GPUs: A40 (0.35$/h), RTX PRO 5000 (0.82$/h), RTX PRO 6000 (1.00$/h)

### ❌ Was nicht funktioniert

**R2 Bucket: LEER**
- Bucket: `audiomonastrysamples`
- Pfad: `weights/`
- Status: Keine Gewichte vorhanden

**Folge**: RunPod-Pods können nicht gestartet werden

```
✖ brain: Gewichte fehlen im Speicher → scripts/weights-mirror.py
```

### Sofortige Lösung

Führen Sie das Gewichts-Synchronisations-Skript aus:

```bash
source .env.deploy
python3 scripts/weights-mirror.py --yes
# Oder nur bestimmte Rollen:
python3 scripts/weights-mirror.py --yes --only brain,ears
```

### R2 Verbindung getestet
```
endpoint: https://2a195733f62228991f55e60bbb397efa.r2.cloudflarestorage.com
bucket: audiomonastrysamples
HEAD weights/: Empty/Not found
```

### Git Commits
```
8048469: feat: Update RunPod fleet configuration with available GPUs
10bacd3: docs: Add final deployment status report
```
