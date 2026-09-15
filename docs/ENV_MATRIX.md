# audioMONASTRY – ENV-Konfigurationsmatrix (SSOT)

> Stand: 2026-09-13 · Erzeugt aus Code- und Template-Analyse (Phase 1/7).
> Regel: **Alias-Namen werden nur mit Warnung gelesen, nie still umbenannt.**
> Kanonisches Schema (Commit 359ce7e): `RP_*` (RunPod), `SB_*` (Supabase),
> `CFR2_*` (Cloudflare R2 nativ), `CFS3_*` (Cloudflare R2 S3-kompatibel).

## 1. Laufzeit-Kern (server.ts + src)

| Erwarteter ENV-Name | Tatsächlich verwendet | Quelle | Pflicht | Default | Validierung | Komponenten | Secret |
|---|---|---|---|---|---|---|---|
| `PORT` | `PORT` | Prozess | nein | `8080` | Nummer | server.ts, alle Services | nein |
| `NODE_ENV` | `NODE_ENV` | Prozess | nein | – | – | server.ts (Production-Warnungen) | nein |
| `STUDIO_ACCESS_TOKEN` | `STUDIO_ACCESS_TOKEN` | .env | **ja (prod)** | – | 32+ Zeichen empfohlen | server.ts (fail-closed Auth) | **ja** |
| `MAIN_OUT_USER_ID` | `MAIN_OUT_USER_ID` | .env | nein | erster Admin | non-empty String | server.ts P0-1 (MixerMONK-Pin) | nein |
| `SESSION_HOST_USER` | `SESSION_HOST_USER` | .env | empfohlen | erster Join | non-empty String | server.ts `roleForSessionUser` | nein |
| `SESSION_ROLE` | `SESSION_ROLE` | .env | nein | `guest` | admin/producer/engineer/guest | server.ts `roleForSessionUser` | nein |
| `REDIS_URL` | `REDIS_URL` | .env | nein | – | URL | server.ts (Socket-Adapter + Session-Persistenz) | **ja** |
| `SIGNALING_ALLOWED_ORIGINS` | `SIGNALING_ALLOWED_ORIGINS` | .env | nein | alle | CSV-URLs | server.ts (Origin-Check) | nein |
| `SIGNALING_IDLE_TIMEOUT_MS` | `SIGNALING_IDLE_TIMEOUT_MS` | .env | nein | 300000 | Nummer | server.ts | nein |
| `SIGNALING_MAX_CLIENTS` | `SIGNALING_MAX_CLIENTS` | .env | nein | – | Nummer | server.ts | nein |
| `UPLOAD_MAX_MB` | `UPLOAD_MAX_MB` | .env | nein | 100 | Nummer | server.ts `/api/upload` | nein |
| `STEM_MAX_UPLOAD_MB` | `STEM_MAX_UPLOAD_MB` | .env | nein | 100 | Nummer | server.ts `/api/separate-stems` | nein |
| `STEM_MAX_JOBS` | `STEM_MAX_JOBS` | .env | nein | 2 | Nummer | server.ts (Backpressure) | nein |
| `STEM_JOB_TIMEOUT_MS` | `STEM_JOB_TIMEOUT_MS` | .env | nein | 300000 | Nummer | server.ts | nein |
| `TURN_STATIC_AUTH_SECRET` | `TURN_STATIC_AUTH_SECRET` | .env | nein | – | non-empty | server/webrtcConfig.ts | **ja** |
| `TURN_URLS` | `TURN_URLS` | .env | nein | – | URL | server/webrtcConfig.ts | nein |
| `VISION_ARTIFACT_DIR` | `VISION_ARTIFACT_DIR` | .env | nein | system temp | Pfad | server/visionArtifacts.ts | nein |
| `VITE_ENABLE_LOCAL_EMBEDDINGS` | `VITE_ENABLE_LOCAL_EMBEDDINGS` | Vite | nein | – | boolean | src/lib/cloudConfig.ts | nein |

## 2. Supabase (kanonisch `SB_*`)

| Erwartet | Verwendet | Alias (Warnung) | Pflicht | Komponenten | Secret |
|---|---|---|---|---|---|
| `SB_URL` | `SB_URL` | `SUPABASE_URL` | nein (offline-fähig) | src/config/supabaseKeys.ts, server.ts | nein |
| `SB_SERVICE_ROLE` | `SB_SERVICE_ROLE` | `SUPABASE_SERVICE_ROLE` | nein | server.ts (Server-Schreibzugriff) | **ja** |
| `SB_ANON_PUB` | `SB_ANON_PUB` | `SUPABASE_ANON_PUB` | nein | src/lib/supabaseClient.ts | nein (publishable) |
| `SB_PUBLISHABLE` | `SB_PUBLISHABLE` | – | nein | src/lib/supabaseClient.ts | nein (publishable) |
| `SB_SECRET` | `SB_SECRET` | `SUPABASE_SECRET` | nein | server.ts | **ja** |
| `SB_PAT` | `SB_PAT` | `SUPABASE_PAT` | nein | scripts (Migrationen) | **ja** |
| `VITE_SB_URL` / `VITE_SUPABASE_URL` | beide akzeptiert | – | nein | Browser-Bundle | nein |
| `VITE_SB_ANON_PUB` / `VITE_SUPABASE_ANON_PUB` | beide akzeptiert | – | nein | Browser-Bundle | nein (publishable) |

## 3. Cloudflare R2 (kanonisch `CFR2_*`/`CFS3_*`)

| Erwartet | Verwendet | Alias (Warnung) | Komponenten | Secret |
|---|---|---|---|---|
| `CFR2_ACCOUNT_ID` | `CFR2_ACCOUNT_ID` | `CLOUDFLARE_ACCOUNT_ID`, `CF_ACCOUNT_ID` | server/cloud.ts, src/lib/cloudConfig.ts | nein |
| `CFR2_ACCESS_KEY_ID` | `CFR2_ACCESS_KEY_ID` | `CLOUDFLARE_ACCESS_KEY_ID` | R2-Schreibpfad | **ja** |
| `CFR2_SECRET_ACCESS_KEY` | `CFR2_SECRET_ACCESS_KEY` | `CLOUDFLARE_SECRET_ACCESS_KEY` | R2-Schreibpfad | **ja** |
| `CFR2_BUCKET` | `CFR2_BUCKET` | – | server/cloud.ts | nein |
| `CFR2_PUBLIC_URL` | `CFR2_PUBLIC_URL` | – | Public-Read-URLs | nein |
| `CFS3_ACCESS_KEY` | `CFS3_ACCESS_KEY` | – | S3-kompatibler Pfad | **ja** |
| `CFS3_SECRET_KEY` | `CFS3_SECRET_KEY` | – | S3-kompatibler Pfad | **ja** |
| `CFS3_ENDPOINT` | `CFS3_ENDPOINT` | – | S3-kompatibler Pfad | nein |
| `CFS3_BUCKET` | `CFS3_BUCKET` | – | S3-kompatibler Pfad | nein |
| `CFS3_PUBLIC_KEY` | `CFS3_PUBLIC_KEY` | – | S3-kompatibler Pfad | nein |

## 4. RunPod-GPU-Flotte (kanonisch `RP_*`)

| Erwartet | Verwendet | Alias (Warnung) | Komponenten | Secret |
|---|---|---|---|---|
| `RP_API_KEY` | `RP_API_KEY` | `RUNPOD_API_KEY` | runpodProvider.ts, fleetWake.ts | **ja** |
| `RP_AGENT_KEY` | `RP_AGENT_KEY` | – | runpodProvider.ts (Vorrang) | **ja** |
| `RP_ENDPOINT_ID_BRAIN/EARS/VOICE/MUSIC/IMAGE/VIDEO_REAL/VIDEO_ABSTRACT/ORCHESTRATOR` | `RP_ENDPOINT_ID_*` | `RUNPOD_ENDPOINT_ID_*` | endpointRegistry.ts (8-Instanzen-Flotte) | nein |
| `RP_ENDPOINT_ID` | `RP_ENDPOINT_ID` | `RUNPOD_ENDPOINT_ID` | endpointRegistry.ts (Legacy-Fallback, gilt für ALLE 8 Rollen) | nein |
| `RP_BRAIN_OPENAI_URL` | `RP_BRAIN_OPENAI_URL` | – | LlmRouter (vLLM-Override) | nein |
| `RUNPOD_API_BASE` | `RUNPOD_API_BASE` | – | runpodProvider.ts (Tests) | nein |
| `RP_S3_ACCESS_KEY` / `RP_S3_SECRET_KEY` | `RP_S3_*` | – | RunPod-Payload-Transfer | **ja** |

## 5. AI-Orchestrator / LLM

| Erwartet | Verwendet | Default | Komponenten | Secret |
|---|---|---|---|---|
| `DEEPSEEK_API_KEY` | `DEEPSEEK_API_KEY` | – | src/core/ai/clientLlm.ts, LlmRouter | **ja** |
| `OLLAMA_URL` | `OLLAMA_URL` | http://127.0.0.1:11434 | LlmRouter (lokaler Fallback) | nein |
| `OLLAMA_MODEL` | `OLLAMA_MODEL` | qwen2.5:7b | LlmRouter | nein |
| `AI_JOB_TIMEOUT_MS` | `AI_JOB_TIMEOUT_MS` | 120000 | aiOrchestrator.ts | nein |
| `AI_SESSION_IDLE_TIMEOUT` | `AI_SESSION_IDLE_TIMEOUT` | – | SessionManager (Scale-to-Zero) | nein |
| `AI_LOG_LEVEL` | `AI_LOG_LEVEL` | INFO | aiLogger.ts | nein |
| `AI_COST_*` | `AI_COST_*_USD_PER_HOUR` u. a. | rollenabhängig | costTracker.ts | nein |
| `AI_CB_FAILURE_THRESHOLD` / `AI_CB_RESET_MS` | `AI_CB_*` | 5 / 30000 | circuitBreaker.ts | nein |
| `AI_MAX_VRAM` | `AI_MAX_VRAM` | 80 | modelManager.ts | nein |

## 6. Python-AI-Runtime (services/audiomonastry-ai-runtime)

| Name | Pflicht | Default | Secret |
|---|---|---|---|
| `AI_ROLE` | nein (Legacy-All) | – | nein |
| `AI_DEVICE` / `AI_RUNTIME_DEVICE` | nein | simulated | nein |
| `AI_MODEL_MANIFEST` | nein | model_manifest.json | nein |
| `HF_TOKEN` | nein | – | **ja** |
| `HF_HOME` | nein | /data/hf-cache | nein |
| `AI_MCP_PERMISSION` | nein | READ | nein |
| `AI_MCP_API_TOKEN` | nein | – | **ja** |
| `AI_UPLOAD_ROOT` / `AI_MAX_UPLOAD_MB` | nein | temp / 50 | nein |
| `AI_SEPARATION_TIMEOUT_SEC` | nein | 900 | nein |
| `AI_TASK_TIME_LIMIT_SEC` / `AI_TASK_SOFT_TIME_LIMIT_SEC` | nein | – | nein |
| `AI_RESULT_EXPIRES_SEC` | nein | – | nein |

## 7. Migrationsstrategie für Alias-Namen

1. Alias bleibt lesbar, wird aber beim Lesen mit `console.warn`/`aiLogger.warn` protokolliert.
2. `.env.TEMPLATE`/`.env.example`/`.env.hetzner.example` dokumentieren nur kanonische Namen.
3. Umstellung je Betreiber: alten Namen durch kanonischen ersetzen, App neu starten,
   Warnung verschwindet. Kein Code entfernt Alias-Namen unangekündigt.

## 8. Bekannte Altlasten (nicht still umbenannt)

- `CFR2_API_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CF_API_KEY`, `CF_ACCOUNT_TOKEN` in lokaler `.env`/alter `.env.TEMPLATE`: werden von **keinem** Laufzeitcode gelesen (nur Deploy-Skripte historisch). Rotieren, da lokal vorhanden.
- `COMET_API_KEY` in `.env`: wird im Repo nicht verwendet (nur externe Deep-Code-Integration).

## 3b. Hetzner Object Storage als Backup-Ziel (PROD-P0-002, 2026-09-14)

Kanonisch: `HOS_S3_*` (Hetzner Object Storage, S3-kompatibel). Der Uploader
`scripts/r2-backup.mjs` liest in dieser Reihenfolge: `BACKUP_S3_*` → `HOS_S3_*`
→ `CFS3_*`/`CFR2_*`. Damit ist das Backup-Ziel unabhaengig vom R2-Sample-Upload.

| Erwarteter ENV-Name | Verwendet von | Pflicht | Beispiel | Secret |
|---|---|---|---|---|
| `HOS_S3_ACCESS_KEY` | scripts/r2-backup.mjs, scripts/backup.sh --offsite | fuer Off-Site | 20 Zeichen (Hetzner-Format) | **ja** |
| `HOS_S3_SECRET_KEY` | dito | fuer Off-Site | 40 Zeichen (Hetzner-Format) | **ja** |
| `HOS_S3_ENDPOINT` | dito | fuer Off-Site | `https://nbg1.your-objectstorage.com` | nein |
| `HOS_S3_BUCKET` | dito | fuer Off-Site | `audiomonastry-backups` | nein |
| `HOS_S3_REGION` | dito (optional) | nein | `nbg1`/`fsn1`/`hel1` – wird sonst aus dem Endpoint abgeleitet | nein |

Wichtig: Hetzner Object Storage verlangt **`region` = Location** (nbg1/fsn1/hel1),
Cloudflare R2 dagegen `auto`. Der Uploader leitet das automatisch ab.
R2-Keys sind hex 32/64 Zeichen, Hetzner-Keys 20/40 Zeichen – daran sind sie zu
unterscheiden (server/cloud.ts validiert R2 streng auf hex32/hex64).
