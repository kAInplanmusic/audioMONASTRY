# RunPod-Flotte – gültiger Standard

**Verbindliche Architekturdokumentation:** [RUNPOD_FLEET_SSOT.md](RUNPOD_FLEET_SSOT.md).

Die einzige ausführbare Pod-Konfiguration mit acht NVIDIA A40 (48 GB) und eindeutiger Modell-/Gewichtsverteilung liegt in [`deploy/runpod/pod-fleet.json`](../deploy/runpod/pod-fleet.json). Revisions-Pins in [`model_manifest.json`](../services/audiomonastry-ai-runtime/model_manifest.json).

Dieses Dokument enthält bewusst keine eigenständigen GPU-, Modell- oder Kostenvarianten. Vor Live-Betrieb reale A40-VRAM- und Lizenz-Gates aus der SSOT abarbeiten.
