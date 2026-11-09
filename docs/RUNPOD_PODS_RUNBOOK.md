# RunPod Betrieb · 8×A40

**SSOT:** [RUNPOD_FLEET_SSOT.md](RUNPOD_FLEET_SSOT.md). Genau sieben KI-Pods und ein aktivierter `vis`-Pod, alle mit **NVIDIA A40 48 GB**. Pro GPU stehen maximal 42 GB für die **geschätzte** residente Nutzung zur Verfügung.

```bash
python3 scripts/runpod-pods.py plan
python3 scripts/runpod-pods.py weights
python3 scripts/runpod-pods.py up --yes --wait 900
python3 scripts/runpod-pods.py status
python3 scripts/runpod-pods.py down --yes
```

`RP_POD_IMAGE` setzt das Image der sieben KI-Pods, `RP_VIS_IMAGE` das des Visual-Pods; `AI_POD_TOKEN` (mindestens 32 Zeichen) schützt alle Pod-Requests. Model-IDs stehen nur in `deploy/runpod/pod-fleet.json`, Gewichtsrevisionen nur in `services/audiomonastry-ai-runtime/model_manifest.json`.

Ohne `--yes` keine Provisionierung. Bei fehlenden Gewichten, zu hohen Preisen, fehlender A40-Verfügbarkeit oder nicht erfülltem GPU-/Lizenz-Gate **abbrechen**, nicht auf einen anderen GPU-Typ oder Modellstack ausweichen. Historischer Preisansatz 0,35 USD/h je A40; Ist-Preise müssen bei jedem Start überprüft werden.
