# audioMONASTRY · SampleMONK

> Browser-based collaborative audio workstation for up to 4 users.
> Version: **1.10.1** (`V. 1|010|001`) · Codename "HyperAudioWorkstation" · Date 2026-09-03.
> Main branch: `main` · Release gate: `npm run verify` must be green.
> Project purpose: **private / research** (no commercial purpose).

---

## 1. Project Overview

**Purpose:** A fully browser-based, real-time collaborative audio workstation (DAW) with AI support – without proprietary plugins and without dependence on a single cloud provider.

**Target Audience:** Music producers, DJs, sound designers, and researchers who want to work together on the same session up to four at a time.

**Core Functionality:**
- 21 plugin modules ("MONKs") in a top bar – mixer, instruments, synth, drum, sampler, MCP, voice, sound, controller, FX, drop, library, EQ, DSP, mastering, stem extractor, spatial, recorder, performance monitor, aiMONK, master player (complete list in section 5)
- Real-time collaboration up to 4 users with identical state (WebRTC DataChannels + Socket.io), B2B locking per plugin
- Audio Engine V1 (Tone.js) + V2 (AudioGraph/Worklets), SAB/RingBuffer, deterministic noise, PDC-capable mastering, dynamics worklet insert (compressor/gate/dynamic EQ), MIDI clock/note out for external hardware
- AI: MOA/MCP planning (DeepSeek), voice/TTS (HF), stems (Replicate), audio analysis (HF Endpoint custom container), local fallbacks (Ollama, WebSpeech, deterministic)
- Persistence: Supabase (metadata) + Cloudflare R2 (audio blobs) + OPFS/IndexedDB (local)

### 1.1 Quick Start

```bash
npm ci                      # Dependencies (package-lock.json is authoritative)
cp .env.example .env        # Add secrets – .env is NEVER committed
node build-worklets.mjs     # Build AudioWorklets (public/worklets is gitignored)
npm run dev                 # tsx server.ts: Express + Vite middleware on :8080
```

Without cloud keys, the app runs completely offline (built-in presets, local fallbacks). Production:

```bash
npm run build               # Vite client + AudioWorklets + esbuild server bundle
npm start                   # node dist/server.cjs
```

**Important npm scripts** (complete in `package.json`):

| Script | Purpose |
|---|---|
| `npm run dev` | Dev server (API + frontend, port 8080) |
| `npm run worker` | File queue worker (`services/taskWorker.ts`) |
| `npm run build` / `npm start` | Production build / start |
| `npm run lint` | `tsc --noEmit` (type checking, no ESLint step) |
| `npm test`, `npm run test:coverage` | Vitest (unit/integration, currently 107 files) |
| `npm run test:e2e`, `test:e2e:responsive`, `test:stress` | Playwright (13 specs, including smoke/collab/hardware/keyboard/visual/responsive/stress/live2browser) |
| `npm run verify` | **Release gate:** tsc + Vitest + interface boundary scan |
| `npm run verify:boundary` | only `scripts/validate-interface-boundaries.mjs` |
| `npm run check:bundle` | Bundle size (< 2.0 MiB fail gate, warning < 1.5 MiB) |
| `npm run check:memo` | React memo heuristic for terminal components |
| `npm run generate:golden` | Golden WAV references for DSP tests |
| `npm run eval:ai`, `iterate:prompts` | AI evaluation / prompt iteration (21 plugins) |
| `npm run stress:hetzner`, `stress:sfu*` | Load/SFU tests against the fleet |
| `npm run build:wasm-hrtf` | Rust → WASM HRTF convolution (`src/audio/wasm/hrtf_conv`) |

## 2. System Architecture

```
┌──────────────┐   HTTPS/WSS    ┌─────────────────────────────┐
│  Browser (4×)│ ─────────────► │ Hetzner app-1 (server.ts)    │
│  React/Vite  │ ◄───────────── │ Express + Socket.io + Redis  │
└──────────────┘   SSE/WebRTC   └──────┬───────────┬──────────┘
                                       │           │
                     ┌─────────────────┘           └──────────────────┐
                     ▼                                                ▼
          ┌───────────────────┐                              ┌─────────────────┐
          │ AI Orchestrator   │                              │ SFU (mediasoup) │
          │ (src/core/ai/     │                              │ sfu-1, UDP/RTP  │
          │  orchestrator/)   │                              └─────────────────┘
          └──┬────┬─────┬─────┘
             │    │     │
      ┌──────┘    │     └────────┐
      ▼           ▼              ▼
┌──────────┐ ┌──────────┐ ┌───────────────────────────┐
│ Replicate│ │ HF       │ │ HF Endpoint (Custom)      │
│ (Stems)  │ │ Serverless│ │ samplemonk-ai-runtime    │
└──────────┘ │ (LLM/TTS)│ │ A100, Scale-to-Zero       │
             └──────────┘ └───────────────────────────┘
      ▼           ▼              ▼
┌─────────────────────────────────────────────────────┐
│ Supabase (Metadata, RLS) + Cloudflare R2 (Blobs)   │
│ Ollama/ai-1 (Local CPU Fallback)                    │
└─────────────────────────────────────────────────────┘
```

**Data Flow (AI Request):**
Browser → `/api/ai/orchestrate` → JobManager (dedup/concurrency) →
ProviderRouter (HF Endpoint/Serverless/Replicate/local) → result →
CostTracker → Supabase persistence → response.

**Dependencies:**
- Runtime: Node 22, TypeScript, Express, Socket.io, Vite/React 19
- Audio: Web Audio API, AudioWorklets, Tone.js, SAB/Atomics
- Cloud: Supabase JS, AWS S3 SDK (R2), Redis adapter (optional)
- AI: huggingface_hub (endpoint management), FastAPI/PyTorch (custom container)

## 3. Services & Microservices

| Service | Location | Port/Protocol | Responsibility |
|---|---|---|---|
| **App/API** | `server.ts` | 8080 HTTP + WebSocket | REST, Socket.io signaling, AI proxy, metrics |
| **AI Orchestrator** | `src/core/ai/orchestrator/` | in-process | Jobs, sessions, provider routing, MCP, costs |
| **AI Runtime (Custom Container)** | `services/samplemonk-ai-runtime/` | 8000 HTTP | HF Endpoint: `/health`, `/ready`, `/status`, `/infer`, `/mcp/tools`, `/metrics` |
| **stem-ai** (optional) | `services/stem-ai/` | 8000 HTTP (internal) | Local Demucs CPU fallback |
| **master-player** | `services/master-player/` | internal | FFmpeg mastering/render |
| **midi-bridge** | `services/midi-bridge/` | internal | MIDI ↔ WebSocket bridge |
| **audio-runtime** (Rust) | `services/audio-runtime/` | native | Native audio enumeration (Xonar U7, etc.) |
| **mixer** (Rust NAPI) | `services/mixer/` | native | Native mixer backend |
| **taskWorker** | `services/taskWorker.ts` | file queue | Legacy backend core processing |
| **backend-core** | `services/backend-core/` | 8000 (legacy) | Historical Python/Node backend core (partially replaced) |
| **library-ai** | `services/library-ai/` | internal | Sample tagging (historical) |
| **portal-worker** | `services/portal-worker/` | Cloudflare | Wake/proxy/auto-delete (€0 portal) |
| **turn** | `services/turn/` | 3478/5349 | TURN (WebRTC relay) |
| **SFU** | `docker-compose.sfu.yml` | 40000–40099 UDP/TCP | Mediasoup selective forwarding |

### 3.1 HTTP API (excerpt from `server.ts`)

| Area | Endpoints |
|---|---|
| Health/Status | `GET /api/health`, `/api/online`, `/api/cloud/health`, `/api/master/health`, `/api/master/selftest` |
| AI Orchestrator | `POST /api/ai/orchestrate`, `/api/ai/complete`, `/api/ai/compose`, `/api/ai/describe`, `/api/ai/generate`, `/api/ai/generate-drop`; `GET /api/ai/jobs`, `/api/ai/jobs/:jobId`, `/api/ai/models`, `/api/ai/orchestrator/status` |
| AI Session | `GET /api/ai/session`, `POST /api/ai/session/heartbeat`, `POST /api/ai/session/shutdown` |
| MCP | `GET /api/ai/mcp/tools`, `POST /api/ai/mcp/tools/:name` |
| Voice | `POST /api/voice/tts`, `/api/voice/sing`, `/api/voice/song`, `/api/generate-voice` |
| Stems | `POST /api/separate-stems` (SSE progress), `GET /api/stem/status` |
| Mastering | `POST /api/master/mix`, `/api/master/master`, `/api/master/analyze` |
| Cloud/Assets | `POST /api/cloud/sync`, `/api/cloud/upload`, `/api/cloud/samples`, `/api/cloud/music`, `/api/upload/sample` |
| Operations | `GET /api/metrics`, `/api/audit`, `/api/admin/debug`, `POST /api/telemetry`, `POST /api/alerts/webhook` |

Additionally, `server.ts` serves Socket.io signaling (session join, state sync, plugin leases) and in production delivers the SPA bundle (`GET *`).

## 4. Configuration Management

**Configuration Files:**
- `.env` / `.env.example` – Environment variables (secrets NEVER committed)
- `docker-compose.yml`, `docker-compose.hetzner.yml`, `docker-compose.ai.yml`, `docker-compose.monitoring.yml`, `docker-compose.sfu.yml`, `docker-compose.fleet-test.yml`
- `Caddyfile` – TLS/reverse proxy
- `services/samplemonk-ai-runtime/runtime_config.yaml` – AI runtime (device, VRAM budget, idle timeout)
- `services/samplemonk-ai-runtime/model_manifest.json` – model registry (revision pinning)
- `services/samplemonk-ai-runtime/hf_endpoint.example.json` – HF endpoint config
- `database/schema.sql` + `database/ai_migration_001.sql` + `database/ai_migration_002.sql` – Supabase schema & prompt/eval tables
- `deploy/helm/audioMONASTRY/values.yaml` – Helm (optional)

**Secrets Strategy:**
- All keys/tokens server-side; `VITE_*` only for publishable values.
- GitHub Actions retrieves secrets from repository secrets (`HF_TOKEN`, `GHCR_USERNAME`, `GHCR_PASSWORD`, `SONAR_TOKEN`).
- Logs redact secrets (`AiLogger.redactSecrets`).
- Boundary scan (`scripts/validate-interface-boundaries.mjs`) enforces encapsulation of platform APIs.

## 5. Plugin Ecosystem

**Registry:** `src/plugins/registry.ts` – 21 modules (`EXPECTED_PLUGIN_COUNT = 21`), states `OFF` | `AUTO_AI` | `PRO`, B2B locking via `src/core/session/locking.ts`. The registry is loaded at runtime from `public/plugin-manifest.json` (`discoverPlugins()`); if the count doesn't match, the built-in fallback registry applies. All terminals are code-split via `React.lazy`.

| # | ID | Name | Terminal Component | Interface / Core |
|---|---|---|---|---|
| 0 | `masterplayer` | masterplayerMONK (MPR) | `MasterPlayerTerminal` | Master transport, fixed header, sticky player |
| 1 | `instrument` | instrumentMONK (INS) | `InstrumentsTerminal` | `IInstrumentBackend`, instrument pool, pad/key view |
| 2 | `synthesizer` | synthesizerMONK (SYN) | `SynthesizerTerminal` | Worklet synthesis, 16-step note sequencer |
| 3 | `drum` | drumMONK (DRM) | `DrumMachineTerminal` | Pattern engine (TR-808/M8), 32 steps, A/B/chain, MIDI clock/note out |
| 4 | `sampler` | samplerMONK (SAM) | `SamplerTerminal` | Sample playback/slicing, 16-step sequencer per pad |
| 5 | `mcp` | mcpMONK (MCP) | `McpTerminal` | MPC pads (4×4, bank A–D) + 16/32-step sequencer |
| 6 | `voice` | voiceMONK (VOX) | `VoiceGenTerminal` | `/api/voice/*` (HF/Replicate/WebSpeech/Ollama) |
| 7 | `sound` | soundMONK (SND) | `SoundTerminal` | AI/rule-based beat, bass, atmosphere, one-shot generation |
| 8 | `mixer` | mixerMONK (MIX) | `MischpultTerminal` | 5 channels (A/B), deck skins, MIDI mapping, DJ crossfade |
| 9 | `controller` | controllerMONK (CTRL) | `MIDIControllerTerminal` | `IHardwareAdapter`, control message, MIDI out for motor faders/LEDs |
| 10 | `effect` | effectMONK (FX) | `FXEngineTerminal` | Multi-FX routing |
| 11 | `drop` | dropMONK (DRP) | `DropTerminal` | AI auto-drop: BPM/key analysis + beat-grid one-shots, quantized bridges |
| 12 | `library` | biblioMONK (LIB) | `LibraryTerminal` | Supabase/R2, favorites, folder tree, auto-save |
| 13 | `eq` | eqMONK (EQ) | `EQPluginTerminal` | AudioWorklet parameters |
| 14 | `dsp` | dspMONK (DSP) | `DSPTerminal` | Cutoff/resonance/modindex/gain/LFO + dynamics insert (comp/gate/dyn EQ) |
| 15 | `mastering` | masteringMONK (MST) | `MasteringOverlay` | PDC, LUFS, release LUT |
| 16 | `stem` | stemMONK (RMX) | `StemExtractorTerminal` | `/api/separate-stems` (Replicate/local/ONNX) |
| 17 | `spatial` | spatialMONK (3D) | `SpatialScene` | 2D panning array, HRTF (JSON/WASM), ILD/ITD/metrics |
| 18 | `recording` | recordingMONK (REC) | `RecorderTerminal` | Bit-perfect export |
| 19 | `performance` | perfMONK (PRF) | `PerformanceMonitorTerminal` | FPS/jitter/latency budgets (LOCAL/NET/DROPOUTS), signal display |
| 20 | `ai` | aiMONK (AI) | `AiMonkTerminal` + `AiMonkDock` | Orchestrator UI, auto-AI control, bottom dock |

> Note: The former `visMONK` (visualizer) was removed; its signal display is integrated into `perfMONK`.

**Metamodules:** `METAMODULE_GROUPS` groups modules into a single terminal – `process` (dsp+eq+effect → `effect`), `sound` (synthesizer+instrument → `instrument`), `source` (recording+voice → `recording`). `resolveComponent(id)` renders only the primary module.

**Activation Logic:** Top-bar icons → `ModuleStateContext`; `AUTO_AI` = periodic MOA suggestions; `PRO` = full terminal; locking per lease.

**Start State (P0-1):** When entering the studio, **all** plugins start in `OFF` mode. `audioEngine.init()` activates the silence gate (`setIdleSilence`), so the main output remains silent at idle.

## 6. AI Model Integration

| Model | Task | Version/Revision | Provider | Fine-Tuning |
|---|---|---|---|---|
| DeepSeek V4 Flash | LLM/MOA planner | `deepseek-v4-flash` | DeepSeek API | no |
| DeepSeek V4 Pro | LLM (complex) | `deepseek-v4-pro` | DeepSeek API | no |
| Qwen2.5-72B-Instruct | LLM fallback | HF router | HF serverless | no |
| Mistral Small | LLM (EU) | `mistral-small-latest` | Mistral API | no |
| Qwen2.5:7b | LLM local | `qwen2.5:7b` | Ollama (ai-1) | no |
| MMS-TTS-deu | TTS | `5cbe5218…` (pin) | HF serverless/endpoint | no |
| Bark | TTS/singing | `70a8a7d3…` (pin) | HF serverless/endpoint | no |
| MusicGen small/medium | Music | `4c8334b0…` / `d3bd7b00…` | HF endpoint | no |
| Whisper large-v3 | STT | `06f233fe…` (pin) | HF endpoint (pilot running) | no |
| AST (Audioset) | Audio classification | `f826b80d…` (pin) | HF endpoint (custom) | no |
| CLAP (larger_clap_music) | Audio embeddings | `a0b4534a…` (pin) | HF endpoint | no |
| MERT-v1-95M | Music understanding | `12af15fe…` (pin) | HF endpoint (license private/research OK) | no |
| PyAnnote Diarization | Speaker diarization | `84fd2591…` (pin) | HF endpoint | no |
| Qwen2.5-Omni-7B | Multimodal | `ae9e1690…` (pin) | HF endpoint (RARE) | no |
| Demucs (cjwbw/demucs) | Stem separation | latest_version resolved | Replicate | no |
| htdemucs-ONNX | Stem separation local | `smank/htdemucs-onnx` | local/ONNX | no |
| LocalEmbeddingProvider | Embeddings local | transformers.js (~80 MB) | browser/Node | no |

**Model Registry:** `services/samplemonk-ai-runtime/model_manifest.json` + TS mirror `src/core/ai/orchestrator/modelRegistry.ts`. Load classes CORE/FREQUENT/ON_DEMAND/RARE, revision pinning (no `latest`).
**Evaluation:** `docs/HF_MODEL_CAPABILITY_MATRIX.md` (scores U·Q·P·V·I·R).

## 7. Server Infrastructure

**Deployment Targets:**
- Hetzner fleet: `app-1` (CPX31), `sfu-1` (CPX31), `master-1` (CX23), `edge-1` (CX23), `ai-1` (CCX33, Ollama/stem-ai CPU)
- Hugging Face Dedicated Endpoints: `samplemonk-ai` (custom container, A100 ×1, us-east-1, scale-to-zero 20 min), `samplemonk-ai-pilot` (Whisper, running)
- Cloudflare Worker (`portal-worker`), Supabase, Cloudflare R2

**Containerization:** `Dockerfile` (app), `Dockerfile.hetzner`, `Dockerfile.multistage`, `services/samplemonk-ai-runtime/Dockerfile` (pytorch/pytorch base, no weights in image, `HF_HOME=/data/hf-cache`), `services/stem-ai/Dockerfile`, `services/master-player/Dockerfile`, `services/midi-bridge/Dockerfile`.

**Orchestration:** Docker Compose (dev/hetzner/ai/monitoring/sfu/fleet-test), optional Helm (`deploy/helm/`), Hetzner scripts (`scripts/hetzner/`: bring-up/delete-fleet, idle-shutdown, auto-repair, prometheus/alertmanager).

## 8. Data Formats & Serialization

| Format | Usage | Rationale |
|---|---|---|
| JSON | State sync (LWW-CRDT), AudioGraph serialization, AI requests/responses, logs, manifest | readable, schemaless, JS-native, sufficient for 4 users |
| WAV/PCM | Audio export, TTS/stem output | lossless, universal |
| MP3/FLAC | Sample library | compact/lossless |
| Float32Array + SAB/Atomics | Audio thread (worklets, ring buffer) | zero-copy, deterministic, sub-ms |
| SSE | Stem progress | simple server-push semantics |
| Socket.io / WebRTC DataChannels | Real-time sync | bidirectional, NAT-friendly |
| Prometheus text format | `/api/metrics`, container `/metrics` | standard, Grafana-compatible |
| Protobuf/Parquet | **intentionally not used** | YAGNI until >10 users or big-data analysis (documented) |

## 9. Security Concept

**Authentication:** Studio token (`x-studio-token`) for API + Socket.io, portal password (constant-time checked) + cookie, `ADMIN_TOKEN` for debug.
**Authorization:** RBAC (`src/utils/rbac.ts`), plugin locking (lease per user), MCP permissions `READ < WRITE < EXECUTION < DESTRUCTIVE`, Supabase RLS (anon = read, service_role = write).
**Data Encryption:** TLS (Caddy), R2 objects via signed URLs, secrets exclusively server-side, secret redaction in logs.
**Hardening:** express-rate-limit per route, upload limits (busboy streaming, file limit), stem queue limits (429 + retry-after, idempotency → 409), audio cap 25 MB in AI container, no shell execution via AI, input validation (task/model lengths, model regex).
Details: `docs/SECURITY_AUDIT.md`, `docs/AI_SECURITY_GUIDE.md`.

## 10. Monitoring & Observability

**Logging:** Structured JSON (`AiLogger`, Python runtime `log_event`) with timestamp, level, service, sessionId, jobId, model, provider, durationMs, error; levels DEBUG/INFO/WARN/ERROR/FATAL; tracing via `X-Request-Id`.
**Metrics:** `/api/metrics` (Prometheus: http/ai/stem/telemetry counters), container `/metrics` (uptime, models_loaded, vram_used, inference_count).
**Dashboards:** Grafana (`scripts/hetzner/grafana-dashboards/`, `grafana-provisioning/`), Prometheus + Alertmanager (webhook `POST /api/alerts/webhook`).
**Tracing:** `X-Request-Id` per request, `AuditLogger`, `errorTracker`.
**Costs:** `CostTracker` (cost/session, cost/hour, cost/month, pricing sources documented in `docs/AI_COST_GUIDE.md`).

## 11. Project Structure

```
server.ts                 Express + Socket.io + AI proxy (single-entry backend)
src/
  App.tsx, main.tsx       React 19 entry point, stream screen layout
  components/             Terminal UIs per plugin (lazy loaded)
  context/                Session, module, audio, project, access context
  core/                   Engine core: audio, clock, routing, session (locking,
                          state replication), ai/orchestrator, hardware, spatial,
                          instrument, voice, gpu, workers, interfaces.ts
  plugins/                registry.ts + plugin-specific modules (mischpult,
                          instrumente, dsp-engine)
  audio/, workers/        Worklets, WASM HRTF, web workers
  utils/, hooks/, types/  RBAC, prompts, themes, shared types
services/                 Micro-services (see section 3)
scripts/                  Build, deploy, benchmark, and Hetzner automation
tests/                    Vitest suites (101 files) + tests/e2e (Playwright)
public/                   Static assets, plugin-manifest.json, routing.json
docs/                     Architecture, AI, security, hardware, and ops docs
database/                 Supabase schema & migrations
deploy/                   Helm charts (optional)
```

## 12. Tests, Quality & CI

**Local Gates:**
- `npm run lint` – TypeScript type checking (`tsc --noEmit`)
- `npm test` – Vitest (unit/integration, currently 107 files, including `architecture.test.ts`, `lockFuzz.test.ts`, `goldenAudio.test.ts`, `aiOrchestrator.test.ts`, `pluginAudioRouter.test.ts`, `midiClockOut.test.ts`, `dynamicsProcessor.test.ts`, `spatialProcessor.test.ts`, `wasmHrtf.test.ts`)
- `npm run verify:boundary` – Interface boundary scan: platform APIs may only be used in their designated adapters
- `npm run verify` – Mandatory before every PR (tsc + Vitest + boundary scan)
- `npm run check:bundle` – Bundle budget gate (< 2.0 MiB)
- `npm run check:memo` – React memo heuristic for terminal components
- `npm run test:e2e` – Playwright (`smoke`, `collab`, `hardware`, `keyboard`, `visual`, `responsive`, `stress`, `live2browser`, `startState`, `pluginCloseSync`, `monitorCue`, `masterPlayerFixed`)
- `npx tsx scripts/spatial-regression.ts` – spatialMONK audio regression (ILD/ITD asserts + WAV artifacts)

**GitHub Actions** (`.github/workflows/`): `build.yml` (build, bundle, memo audit, Google-free check), `verify.yml` (tsc, Vitest, boundary scan, spatial regression), `e2e.yml` (Chromium/Firefox/WebKit, without visual baselines), `nightly.yml` (verify + build + AI eval + prompt iteration + auto-issue on error), `ai.yml`, `hf-endpoint.yml` (endpoint management), `live-stress.yml`, `sonarcloud.yml` (config in `sonar-project.properties`).

---

## Further Documentation

- `AGENTS.md` / `.cursorrules` – binding architecture and workflow rules
- `docs/` – AI architecture, HF setup, deployment, registry, MCP, security, operations, troubleshooting, cost, hardware matrices, release gate
- `MASTER_TODO.md` – product/release history and open tasks
- `TASKDONE.md` – completed work packages (change log)
- `docs/HANDOVER.md` – handover/status document
- `docs/LIVE_CHECKLIST_2026-09-02.md` – remaining live/listen-through check points
