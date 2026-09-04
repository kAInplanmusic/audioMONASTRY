# SampleMONK AI Runtime (HF Custom Container)

FastAPI-Runtime für den dedizierten Hugging-Face-Inference-Endpoint.

- `/health` Prozess-Check · `/ready` Runtime bereit · `/status` GPU/Modelle
- `/infer` Inference · `/mcp/tools` MCP-Tools (Permission-geschützt) · `/metrics` Prometheus
- Modelle werden aus `model_manifest.json` (Revision-Pinning) geladen,
  Gewichte liegen im persistenten `HF_HOME`-Cache.

Deployment: GitHub Actions Workflow `.github/workflows/hf-endpoint.yml`
(baut Image → GHCR → legt/aktualisiert HF-Endpoint `samplemonk-ai`).
