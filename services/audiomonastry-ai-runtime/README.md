# AudioMONASTRY AI Runtime (HF Custom Container)

FastAPI-Runtime für den dedizierten Hugging-Face-Inference-Endpoint.

- `/health` Prozess-Check · `/ready` Runtime bereit · `/status` GPU/Modelle
- `/infer` Inference · `/mcp/tools` MCP-Tools (Permission-geschützt) · `/metrics` Prometheus
- Modelle werden aus `model_manifest.json` (Revision-Pinning) geladen,
  Gewichte liegen im persistenten `HF_HOME`-Cache.
- **Konfiguration hat genau eine Quelle pro Wert (INFRA-RUNPOD-006):** das
  VRAM-Budget steht AUSSCHLIESSLICH in `model_manifest.json`
  (`runtime.vramBudgetGb`, je Rolle `roles.<rolle>.vramBudgetGb`); alles andere
  kommt aus der Umgebung. Eine eigene Laufzeit-YAML gibt es nicht mehr – die
  frühere `runtime_config.yaml` (141 GB/8 GB aus der H200-Pod-Ära) wurde am
  2026-09-20 entfernt, weil sie von keinem Skript gelesen wurde.

Deployment: GitHub Actions Workflow `.github/workflows/hf-endpoint.yml`
(baut Image → GHCR → legt/aktualisiert HF-Endpoint `audiomonastry-ai`).
