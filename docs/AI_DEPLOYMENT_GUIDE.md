# audioMONASTRY – AI Deployment Guide

> Stand 2026-08-31 · Gilt für die AI-Infrastruktur (`src/core/ai/orchestrator/`,
> `services/samplemonk-ai-runtime/`).

## Architektur (Ist-Zustand)

```
Browser → Hetzner App (server.ts) → AI Orchestrator
                                      ├── ProviderRouter → HF Endpoint / HF Serverless / Replicate / Local
                                      ├── JobManager (Dedup, Concurrency)
                                      ├── SessionManager (Lifecycle, Idle→Scale-to-Zero)
                                      ├── ModelManager (VRAM-Guard, Eviction)
                                      ├── McpRuntime (Permissions)
                                      ├── CostTracker
                                      └── aiPersistence → Supabase
```

## 1. HF-Endpoint anlegen (Betreiber-Schritt)

1. `services/samplemonk-ai-runtime/` als Custom Container im HF-Dashboard hochladen
   (Dockerfile, Port 8000, Health `/health`, Readiness `/ready`).
2. Konfiguration gemäß `hf_endpoint.example.json`:
   - Instanz: **A100 ×1 (80 GB, AWS)** – Betreiber-Freigabe 2026-08-31
   - `minReplicas: 0`, `maxReplicas: 1`, `scaleToZero: true`, Idle-Timeout 20 min
   - Secret `HF_TOKEN` als Endpoint-Secret setzen (nicht ins Image).
3. Endpoint-URL als `HF_ENDPOINT_URL` in `.env` der Hetzner-App eintragen.

## 2. Hetzner-App deployen

```bash
npm run verify          # tsc + 338 Tests + Boundary-Scan
npm run build           # Production-Build
bash scripts/deploy-ai.sh   # lokaler/Hetzner AI-Runtime-Smoke (docker-compose.ai.yml)
```

## 3. Health-Check

```bash
curl https://<app>/api/ai/orchestrator/status
curl https://<endpoint>/health   # Prozess
curl https://<endpoint>/ready    # Runtime + CORE-Modelle
```

## 4. Rollback

```bash
# App: vorherigen Commit deployen (deploy.sh)
# AI-Runtime: docker compose -f docker-compose.ai.yml down
# HF-Endpoint: im HF-Dashboard auf vorherige Container-Version zurücksetzen
```

## 5. Konfiguration

Siehe `.env.example` (Abschnitt „AI Orchestrator"): `HF_ENDPOINT_URL`, `HF_TOKEN`,
`AI_SESSION_IDLE_TIMEOUT`, `AI_MAX_VRAM`, `AI_MAX_CONCURRENCY_*`,
`AI_COST_*`.
