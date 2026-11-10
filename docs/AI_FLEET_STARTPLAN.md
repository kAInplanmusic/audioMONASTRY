# RunPod-Startplan (aktuell)

**Autoritaet:** [RUNPOD_FLEET_SSOT.md](RUNPOD_FLEET_SSOT.md), [pod-fleet.json](../deploy/runpod/pod-fleet.json), [model_manifest.json](../services/audiomonastry-ai-runtime/model_manifest.json). Keine historischen Starttabellen aktiv. Acht physische GPU-Rollen. **8,00 EUR/h Gesamtgrenze, keine 1-USD-Grenze je Pod**.

Offline: `python3 scripts/runpod-pods.py plan`. Vor kostenpflichtigem `up --yes`: Gewichte, Image-Build, GPU-Typ, Preise und Secrets verifizieren. Der bisherige Adapter-/GPU-Status ist nicht als erfolgreich nachgewiesen.
