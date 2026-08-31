# Konfigurations-Matrix 2026 (GAP-7)

> Ist/Soll/Status je Konfiguration. Stand: 2026-08-31.

| Konfiguration | Ist | Soll | Status |
|---|---|---|---|
| `.env.example` | HF_ENDPOINT_URL, HF_TOKEN, AI_MAX_GPU_ENDPOINTS=1 | dokumentiert | ✅ |
| `.env` (lokal) | HF_PILOT/CLAP auskommentiert, AI_MAX_GPU_ENDPOINTS=1 | 1 GPU | ✅ |
| `docker-compose.ai.yml` | AI-Runtime simulated/CPU | lokaler Smoke | ✅ |
| `docker-compose.hetzner.yml` | App/Caddy/Redis/master-player | unverändert | ✅ |
| `Caddyfile` | TLS/Reverse-Proxy | unverändert | ✅ |
| `SettingsDialog` Defaults | `outputDeviceId=''` | Xonar-first, sonst USB | ⬜ P1-3 |
| `stereoMode` | STEREO/DAW/SPATIAL | + 2.1 | ⬜ P2-3 |
| Sample-Rate | 48 kHz Default | U7: 44,1/48/96/192 | ✅ U7 verifiziert |
| BufferHint | interactive | interactive + Auto-Anpassung | ⬜ AM-E6-2 |
| `runtime_config.yaml` | cuda/simulated, VRAM 80 GB | unverändert | ✅ |
| `model_manifest.json` | 9 Modelle, Revision-Pins | unverändert (1 A100) | ✅ |
| `hf-endpoint.yml` | nur samplemonk-ai, AI_MAX_GPU_ENDPOINTS=1 | 1 GPU | ✅ |
| `stem-ai` | `STEM_AI_URL` runtime | schneller 502 | ✅ D22 |
| Ollama/ai-1 | optional | Fallback | ⬜ Live-Check |
| Replicate | Token vorhanden | Guthaben prüfen | ⬜ Live-Check |
