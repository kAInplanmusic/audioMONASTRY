# audioMONASTRY · SampleMONK

> Browser-basierte kollaborative Audio-Workstation für bis zu 4 Nutzer.
> Version: **V. 1|010|001** · Codename „HyperAudioWorkstation" · Stand 2026-08-31.
> Projektzweck: **privat / Forschung** (kein kommerzieller Zweck).

---

## 1. Projektübersicht

**Zweck:** Eine vollständig im Browser laufende, echzeit-kollaborative
Audio-Workstation (DAW) mit KI-Unterstützung – ohne proprietäre Plugins und
ohne Abhängigkeit von einem einzelnen Cloud-Anbieter.

**Zielgruppe:** Musikproduzenten, DJs, Sound-Designer und Forscher, die zu
viert gleichzeitig an derselben Session arbeiten wollen.

**Kernfunktionalität:**
- 17 Plugins (Mixer, Sequencer, Library, Drum/Synth, Instrumente, Spatial, EQ,
  Mastering, MIDI-Profile, FX, Stem-Extractor, Voice, Extension-Slot, Recorder,
  DSP-Engine, Visualizer, Performance-Monitor)
- Echtzeit-Kollaboration bis 4 Nutzer mit identischem State (WebRTC DataChannels
  + Socket.io), B2B-Locking pro Plugin
- Audio-Engine V1 (Tone.js) + V2 (AudioGraph/Worklets), SAB/RingBuffer,
  deterministisches Noise, PDC-fähiges Mastering
- KI: MOA/MCP-Planung (DeepSeek), Voice/TTS (HF), Stems (Replicate),
  Audio-Analyse (HF-Endpoint-Custom-Container), lokale Fallbacks (Ollama,
  WebSpeech, deterministisch)
- Persistenz: Supabase (Metadaten) + Cloudflare R2 (Audio-Blobs) + OPFS/IndexedDB
  (lokal)

## 2. Systemarchitektur

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
│ Supabase (Metadaten, RLS) + Cloudflare R2 (Blobs)  │
│ Ollama/ai-1 (lokaler CPU-Fallback)                  │
└─────────────────────────────────────────────────────┘
```

**Datenfluss (AI-Request):**
Browser → `/api/ai/orchestrate` → JobManager (Dedup/Concurrency) →
ProviderRouter (HF-Endpoint/Serverless/Replicate/Local) → Ergebnis →
CostTracker → Supabase-Persistenz → Response.

**Abhängigkeiten:**
- Runtime: Node 22, TypeScript, Express, Socket.io, Vite/React 19
- Audio: Web Audio API, AudioWorklets, Tone.js, SAB/Atomics
- Cloud: Supabase JS, AWS S3 SDK (R2), Redis-Adapter (optional)
- AI: huggingface_hub (Endpoint-Verwaltung), FastAPI/PyTorch (Custom Container)

## 3. Services & Microservices

| Dienst | Ort | Port/Protokoll | Zuständigkeit |
|---|---|---|---|
| **App/API** | `server.ts` | 8080 HTTP + WebSocket | REST, Socket.io-Signaling, AI-Proxy, Metriken |
| **AI Orchestrator** | `src/core/ai/orchestrator/` | in-process | Jobs, Sessions, Provider-Routing, MCP, Kosten |
| **AI Runtime (Custom Container)** | `services/samplemonk-ai-runtime/` | 8000 HTTP | HF-Endpoint: `/health`, `/ready`, `/status`, `/infer`, `/mcp/tools`, `/metrics` |
| **stem-ai** (optional) | `services/stem-ai/` | 8000 HTTP (intern) | Lokaler Demucs-CPU-Fallback |
| **master-player** | `services/master-player/` | intern | FFmpeg-Mastering/Render |
| **midi-bridge** | `services/midi-bridge/` | intern | MIDI ↔ WebSocket-Bridge |
| **audio-runtime** (Rust) | `services/audio-runtime/` | nativ | Native Audio-Enumeration (Xonar U7 u. a.) |
| **mixer** (Rust NAPI) | `services/mixer/` | nativ | Native Mixer-Backend |
| **taskWorker** | `services/taskWorker.ts` | Datei-Queue | Legacy-Backend-Core-Abarbeitung |
| **backend-core** | `services/backend-core/` | 8000 (legacy) | Historischer Python/Node-Backend-Kern (teilweise ersetzt) |
| **library-ai** | `services/library-ai/` | intern | Sample-Tagging (historisch) |
| **portal-worker** | `services/portal-worker/` | Cloudflare | Wake/Proxy/Auto-Delete (0-€-Portal) |
| **turn** | `services/turn/` | 3478/5349 | TURN (WebRTC-Relay) |
| **SFU** | `docker-compose.sfu.yml` | 40000–40099 UDP/TCP | Mediasoup Selective Forwarding |

## 4. Konfigurationsmanagement

**Konfigurationsdateien:**
- `.env` / `.env.example` – Umgebungsvariablen (Secrets NIE committen)
- `docker-compose.yml`, `docker-compose.hetzner.yml`, `docker-compose.ai.yml`,
  `docker-compose.monitoring.yml`, `docker-compose.sfu.yml`,
  `docker-compose.fleet-test.yml`
- `Caddyfile` – TLS/Reverse-Proxy
- `services/samplemonk-ai-runtime/runtime_config.yaml` – AI-Runtime (Device,
  VRAM-Budget, Idle-Timeout)
- `services/samplemonk-ai-runtime/model_manifest.json` – Model Registry
  (Revision-Pinning)
- `services/samplemonk-ai-runtime/hf_endpoint.example.json` – HF-Endpoint-Konfig
- `database/schema.sql` + `database/ai_migration_001.sql` – Supabase-Schema
- `deploy/helm/audioMONASTRY/values.yaml` – Helm (optional)

**Secrets-Strategie:**
- Alle Keys/Tokens serverseitig; `VITE_*` nur für publishable Werte.
- GitHub Actions bezieht Secrets aus Repository-Secrets (`HF_TOKEN`,
  `GHCR_USERNAME`, `GHCR_PASSWORD`, `SONAR_TOKEN`).
- Logs redactieren Secrets (`AiLogger.redactSecrets`).
- Boundary-Scan (`scripts/validate-interface-boundaries.mjs`) erzwingt die
  Kapselung von Plattform-APIs.

## 5. Plugin-Ökosystem

**Registry:** `src/plugins/registry.ts` – 17 Plugin-IDs, Zustände `OFF` |
`AUTO_AI` | `PRO`, B2B-Locking via `src/core/session/locking.ts`.

| # | Plugin | Verzeichnis | Schnittstelle |
|---|---|---|---|
| 0 | Master Player | `src/plugins/…` | `usePluginState`, Master-Transport |
| 1 | Mischpult | `mischpult/` | 5 Kanäle (A/B), MIDI-Mapping |
| 2 | Sequenzer | `sequenzer/` | 16 Steps × 8 Spuren |
| 3 | Library | LibraryTerminal | Supabase/R2, Auto-Save |
| 4 | Junket (Drum/Synth) | DrumMachine/SoundTerminal | Pattern-Engine |
| 5 | Instrumente | `instrumente/` | `IInstrumentBackend`, 100 Instrumente |
| 6 | Spatial Surround | `spatial-surround/` | 2D-Panning-Array |
| 7 | EQ | DSP-Plugin | AudioWorklet-Parameter |
| 8 | Mastering | Mastering-Kette | PDC, LUFS |
| 9 | MIDI-Profile | `MIDIControllerTerminal` | `IHardwareAdapter`, ControlMessage |
| 10 | FX | DSP-Engine | Worklet-Automation |
| 11 | Stem-Extractor | `StemExtractorTerminal` | `/api/separate-stems` (Replicate/lokal) |
| 12 | Voice | VoiceMONK | `/api/voice/*` (HF/Replicate/WebSpeech) |
| 13 | Extension-Slot | Registry | offen |
| 14 | Recorder | MasterStream | Bit-perfect Export |
| 15 | DSP-Engine | Worklets | Cutoff/Reso/LFO |
| 16 | Visualizer | OffscreenCanvas | Waveform im Worker |
| 17 | Performance-Monitor | `PerformanceMonitorTerminal` | FPS/Jitter/Latenz-Budgets |

**Aktivierungslogik:** Top-Bar-Icons → `ModuleStateContext`; `AUTO_AI` =
periodische MOA-Vorschläge; `PRO` = volles Terminal; Locking pro Lease.

## 6. AI-Modell-Integration

| Modell | Task | Version/Revision | Provider | Fine-Tuning |
|---|---|---|---|---|
| DeepSeek V4 Flash | LLM/MOA-Planer | `deepseek-v4-flash` | DeepSeek API | nein |
| DeepSeek V4 Pro | LLM (komplex) | `deepseek-v4-pro` | DeepSeek API | nein |
| Qwen2.5-72B-Instruct | LLM-Fallback | HF Router | HF Serverless | nein |
| Mistral Small | LLM (EU) | `mistral-small-latest` | Mistral API | nein |
| Qwen2.5:7b | LLM lokal | `qwen2.5:7b` | Ollama (ai-1) | nein |
| MMS-TTS-deu | TTS | `5cbe5218…` (pin) | HF Serverless/Endpoint | nein |
| Bark | TTS/Gesang | `70a8a7d3…` (pin) | HF Serverless/Endpoint | nein |
| MusicGen small/medium | Musik | `4c8334b0…` / `d3bd7b00…` | HF Endpoint | nein |
| Whisper large-v3 | STT | `06f233fe…` (pin) | HF Endpoint (Pilot läuft) | nein |
| AST (Audioset) | Audio-Klassifikation | `f826b80d…` (pin) | HF Endpoint (Custom) | nein |
| CLAP (larger_clap_music) | Audio-Embeddings | `a0b4534a…` (pin) | HF Endpoint | nein |
| MERT-v1-95M | Music Understanding | `12af15fe…` (pin) | HF Endpoint (Lizenz privat/Forschung ok) | nein |
| PyAnnote Diarization | Sprecher-Trennung | `84fd2591…` (pin) | HF Endpoint | nein |
| Qwen2.5-Omni-7B | Multimodal | `ae9e1690…` (pin) | HF Endpoint (RARE) | nein |
| Demucs (cjwbw/demucs) | Stem-Separation | latest_version aufgelöst | Replicate | nein |
| htdemucs-ONNX | Stem-Separation lokal | `smank/htdemucs-onnx` | lokal/ONNX | nein |
| LocalEmbeddingProvider | Embeddings lokal | transformers.js (~80 MB) | Browser/Node | nein |

**Model Registry:** `services/samplemonk-ai-runtime/model_manifest.json` +
TS-Spiegel `src/core/ai/orchestrator/modelRegistry.ts`. Ladeklassen CORE/
FREQUENT/ON_DEMAND/RARE, Revision-Pinning (kein `latest`).
**Bewertung:** `docs/HF_MODEL_CAPABILITY_MATRIX.md` (Scores U·Q·P·V·I·R).

## 7. Server-Infrastruktur

**Deployment-Targets:**
- Hetzner-Flotte: `app-1` (CPX31), `sfu-1` (CPX31), `master-1` (CX23),
  `edge-1` (CX23), `ai-1` (CCX33, Ollama/stem-ai-CPU)
- Hugging Face Dedicated Endpoints: `samplemonk-ai` (Custom Container, A100 ×1,
  us-east-1, Scale-to-Zero 20 min), `samplemonk-ai-pilot` (Whisper, läuft)
- Cloudflare Worker (`portal-worker`), Supabase, Cloudflare R2

**Containerisierung:** `Dockerfile` (App), `Dockerfile.hetzner`,
`Dockerfile.multistage`, `services/samplemonk-ai-runtime/Dockerfile`
(pytorch/pytorch-Basis, keine Gewichte im Image, `HF_HOME=/data/hf-cache`),
`services/stem-ai/Dockerfile`, `services/master-player/Dockerfile`,
`services/midi-bridge/Dockerfile`.

**Orchestrierung:** Docker Compose (dev/hetzner/ai/monitoring/sfu/fleet-test),
optional Helm (`deploy/helm/`), Hetzner-Skripte (`scripts/hetzner/`:
bring-up/delete-fleet, idle-shutdown, auto-repair, prometheus/alertmanager).

## 8. Datenformate & Serialisierung

| Format | Einsatz | Begründung |
|---|---|---|
| JSON | State-Sync (LWW-CRDT), AudioGraph-Serialisierung, AI-Requests/Responses, Logs, Manifest | lesbar, schemalos, JS-nativ, ausreichend für 4 User |
| WAV/PCM | Audio-Export, TTS/Stem-Output | verlustfrei, universell |
| MP3/FLAC | Sample-Bibliothek | platzsparend/verlustfrei |
| Float32Array + SAB/Atomics | Audio-Thread (Worklets, RingBuffer) | Zero-Copy, deterministisch, sub-ms |
| SSE | Stem-Progress | einfache Server-Push-Semantik |
| Socket.io / WebRTC DataChannels | Echtzeit-Sync | bidirektional, NAT-freundlich |
| Prometheus Text-Format | `/api/metrics`, Container-`/metrics` | Standard, Grafana-kompatibel |
| Protobuf/Parquet | **bewusst nicht** | YAGNI bis >10 User bzw. Big-Data-Analyse (dokumentiert) |

## 9. Sicherheitskonzept

**Authentifizierung:** Studio-Token (`x-studio-token`) für API+Socket.io,
Portal-Passwort (konstantzeitgeprüft) + Cookie, `ADMIN_TOKEN` für Debug.
**Autorisierung:** RBAC (`src/utils/rbac.ts`), Plugin-Locking (Lease pro User),
MCP-Permissions `READ<WRITE<EXECUTION<DESTRUCTIVE`, Supabase RLS
(anon=Lesen, service_role=Schreiben).
**Datenverschlüsselung:** TLS (Caddy), R2-Objekte über signierte URLs,
Secrets ausschließlich serverseitig, Secret-Redaction in Logs.
**Härtung:** express-rate-limit je Route, Upload-Limits (busboy-Streaming,
Datei-Limit), Stem-Queue-Limits (429+Retry-After, Idempotency→409),
Audio-Deckel 25 MB im AI-Container, keine Shell-Ausführung durch AI,
Input-Validierung (task/model-Längen, Modell-Regex).
Details: `docs/SECURITY_AUDIT.md`, `docs/AI_SECURITY_GUIDE.md`.

## 10. Monitoring & Observability

**Logging:** strukturiertes JSON (`AiLogger`, Python-Runtime `log_event`) mit
timestamp, level, service, sessionId, jobId, model, provider, durationMs,
error; Level DEBUG/INFO/WARN/ERROR/FATAL; Trace via `X-Request-Id`.
**Metriken:** `/api/metrics` (Prometheus: http/ai/stem/telemetry-Counter),
Container `/metrics` (uptime, models_loaded, vram_used, inference_count).
**Dashboards:** Grafana (`scripts/hetzner/grafana-dashboards/`,
`grafana-provisioning/`), Prometheus + Alertmanager (Webhook `POST /api/alerts/webhook`).
**Tracing:** `X-Request-Id` je Request, `AuditLogger`, `errorTracker`.
**Kosten:** `CostTracker` (cost/session, cost/hour, cost/month, Preisquellen
dokumentiert in `docs/AI_COST_GUIDE.md`).

---

## Weiterführende Dokumente

- `AITodo.md` – zentrales Implementierungs-Live-Dokument (Status je Phase)
- `docs/` – AI-Architektur, HF-Setup, Deployment, Registry, MCP, Security,
  Operations, Troubleshooting, Cost, Hardware-Matrizen
- `MASTER_TODO.md` – Produkt-/Release-Historie
