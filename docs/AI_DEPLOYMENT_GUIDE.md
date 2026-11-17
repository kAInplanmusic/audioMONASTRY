# audioMONASTRY – AI Deployment Guide

## Gültige Architektur (17.11.2026)

Browser → Hetzner App/Orchestrator → Vast.ai GPU-Flotte mit acht Rollen.
Cloudflare R2 stellt gepinnte Modellgewichte bereit; Hugging Face Hub ist **nur** Gewichtquelle, kein Hostingdienst.
Supabase speichert App- und Jobdaten.

Die verbindlichen Dateien sind `deploy/gpu-provider.json`, `deploy/gpu/pod-fleet.json`, `services/audiomonastry-ai-runtime/model_manifest.json` und `docs/AI_FLEET_STARTPLAN.md`.

## Prüfung ohne GPU-Miete

```bash
python3 scripts/gpu-pods.py status
python3 scripts/frontier-r2-mirror.py # Nur Dry-Run, kein Upload
npm run verify
```

## Deployment (nur nach ausdrücklicher Betreiberfreigabe)

```bash
python3 scripts/gpu-pods.py plan
python3 scripts/gpu-pods.py preflight
# Erst nach Kosten-/Readinessprüfung und Freigabe:
# python3 scripts/gpu-pods.py up
```

## Health und Rücknahme

Prüfe den App-Status unter `/api/ai/orchestrator/status`, den Runtime-Gesundheitsstatus und die Rollen-Readiness. Beende fehlerhafte GPU-Mieten über den Vast.ai-Dispatcher; produktive Stable-/Golden-Master-Daten nicht löschen.

## Kosten und Secrets

GPU-Hardcap: 8 €/h gemäß `deploy/gpu-provider.json`; Hetzner und Supabase separat. `HF_TOKEN` dient ausschließlich dem Zugang zu HF Hub-Modellgewichten. Cloudflare R2 verwendet `CFS3_*`/ `CFR2_*` Secrets, niemals eingecheckte Werte.

**Kein Hugging-Face-A100-Inference-Endpoint, keine automatische HF-Endpoint-Provisionierung.**
