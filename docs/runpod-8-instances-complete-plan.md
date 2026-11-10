# RunPod 8-Pod-Standard — SSOT 2026-11-10

**Verbindliche Dateien:** [RUNPOD_FLEET_SSOT.md](RUNPOD_FLEET_SSOT.md), [pod-fleet.json](../deploy/runpod/pod-fleet.json) und [model_manifest.json](../services/audiomonastry-ai-runtime/model_manifest.json).

Die aktuelle Flotte besteht aus genau acht heterogenen Pods: `brain`, `ears`, `voice`, `music`, `studio`, `audio-brain`, `song` und `vis`. GPU-Klassen: 32/48/96 GB gemäß Rolle und Priorität im JSON. **8×A40 ist nicht gültig.** `vis` ist für **Audio-Restaurierung**, nicht Bild-/Videogenerierung.

Das **harte RunPod-Gesamtbudget beträgt 8,00 €/h** einschließlich konfigurierter Steuer- und Pufferannahme. Kein Einzel-Preisdeckel je Pod. Modell-Revisionen sind ausschließlich im Manifest autoritativ. Live-Preise, GPU-VRAM, Checkpoint-Integrität, Loader/CUDA, Audioqualität und GPU-Readiness sind ohne Live-Nachweise **nicht verifiziert**.

Das historische Serverless-Deployment `scripts/runpod-deploy.py` und `.github/workflows/runpod-deploy.yml` ist gesperrt. Vor jeglichem kostenpflichtigen Start: `scripts/runpod-ssot-preflight.py`, `scripts/runpod-pods.py plan`, `scripts/runpod-pods.py weights` und echte Provider-GPU-Preisprüfung.
