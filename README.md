# audioMONASTRY – Pro Audio Workstation

**Version: V. 1|001|420 · CODENAME „AnunnakiDNA"** · Stand: 2026-08-30

Kollaborative, objektbasierte Audio-Workstation (OBA) mit **17 Plugins**, hochmodularer Architektur,
Echtzeit-Signalverarbeitung (AudioWorklets), KI-Assistenz, Spatial-Audio bis **24.2**, WebRTC-/SFU-Kollaboration
und vollständiger Offline-/Selfhost-Fähigkeit (Google-/Firebase-frei).

- Bis zu **4 User** gleichzeitig an einem Workflow (identisches State-Mirroring, B2B-Plugin-Locking)
- Reaktionszeiten/Delays im **unteren Millisekunden-Bereich**
- Datenbank: **Supabase** (Metadaten) + **Cloudflare R2** (Audio-Blobs) – optional, Offline-Fallback inklusive
- App-weite Audio-Ausgabe inkl. **ASUS Xonar U7** (1× jetzt, 3–4× für 24-Kanal später)

---

## 🛠 Plugin-Katalog (17 Slots)

| Slot | Plugin-ID | Terminal | Funktion |
|---|---|---|---|
| 1 | `mixer` | mixerMONK | 4-Kanal-Mischpult, zentrales Routing, Stereo-Summe, Gain-Staging |
| 2 | `controller` | controllerMONK | MIDI/HID/OSC-Integration, Hardware-Mappings, Auto-Erkennung + Hotplug |
| 3 | `sequencer` | sequencerMONK | Touch-Step-Sequenzer (16 Steps × 8 Spuren), Swing/Gate |
| 4 | `spatial` | spatialMONK | Spatial-Audio 2.0–24.2, 2D-Vektor-Panning, Raumplaner |
| 5 | `instrument` | instrumentMONK | 91 Instrumente (50 akustisch + 41 Synthese), WAM2-Host |
| 6 | `drum` | drumMONK | Drum-Sampler-Engine & Kit-Management |
| 7 | `effect` | effectMONK | FX-Rack: FDN-Reverb, Chorus/Flanger, Bitcrusher |
| 8 | `synth` | synthesizerMONK | Subtraktiv/FM/Wavetable-Synthese |
| 9 | `voice` | voiceMONK | KI-Vocal-Synthese, TTS, Gesang, Song (Suno-artig), Pitch-Detection, MOA-Assistent |
| 10 | `visualizer` | visMONK | OffscreenCanvas-Waveform-Visualizer (Web Worker) |
| 11 | `sampler` | samplerMONK | 16-Pad-Sampler, Granular-Synthese |
| 12 | `stem` | stemMONK | 5-Stem-Trennung (lokal/deterministisch oder stem-ai) |
| 13 | `recording` | recordingMONK | Finaler Capture & Mastering-Export |
| 14 | `library` | biblioMONK | Sample-/Musik-Bibliothek, Cloud-Sync (Supabase/R2), PUSH/SYNC |
| 15 | `eq` | eqMONK | 4-Band parametrischer EQ |
| 16 | `mastering` | masteringMONK | True-Peak-Limiter, Soft-Knee, LUFS-Metering |
| 17 | `performance` | perfMONK | Echtzeit-Performance-Monitoring (FPS/Jitter/Latenz-Budgets) |

**Metamodul-Gruppen** (Konsolidierung): `process` (dsp+eq+effect→effect), `sound` (synth+instrument→instrument), `source` (recording+voice→recording).

**MOA/MCP-Assistent:** Jedes Terminal hat eine MOA-Eingabezeile. Der `MoaAgent` plant Aufgaben mit
DeepSeek V4 Flash (Server-Proxy `/api/ai/complete`), führt sie plugin-bewusst über das
`VoiceControlService`-Kommando-Registry aus und zeigt das Ergebnis inline (`AUTO_AI`-Feedback).
Im `AUTO_AI`-Modus generiert der Assistent periodisch plugin-spezifische Vorschläge
(`PLUGIN_MOA_TASKS` in `src/utils/prompts.ts`).

---

## 🎛 Audio-Worklets (10)

| Worklet | Datei | Funktion |
|---|---|---|
| `it-synth-processor` | `itSynthProcessor.ts` | Sample-genaue Instrumenten-Synthese (additiv/subtraktiv/FM/Drum/FX), Automation-Rampen, deterministisches Noise |
| `synth-processor` | `synthProcessor.ts` | PolyBLEP-Oszillator + Moog-Ladder + ADSR |
| `eq-processor` | `eqProcessor.ts` | 4-Band RBJ-EQ (HP/Lowshelf/Peaking/Highshelf) |
| `dsp-processor` | `dspProcessor.ts` | Phasen-Tilt, Envelope-Filter, Soft-Clipper |
| `mastering-processor` | `masteringProcessor.ts` | Lookahead True-Peak-Limiter + Soft-Knee + Exp-Release |
| `effect-processor` | `effectProcessor.ts` | FDN-Reverb, Chorus/Flanger, Bitcrusher |
| `clock-processor` | `clockProcessor.ts` | Audio-Thread-Clock (Swing/Gate, jitterfrei) |
| `lufs-processor` | `lufsProcessor.ts` | LUFS-Metering via SharedArrayBuffer |
| `analyzer-processor` | `analyzerProcessor.ts` | Waveform-Daten in SAB |
| `fallback-processor` | `fallbackProcessor.ts` | Neutraler Gain-Fallback |

Build: `npm run build` kompiliert alle Worklets nach `dist/worklets/` + `public/worklets/` (`build-worklets.mjs`).

**V2-Transport (kanonischer Migrationspfad):** Der produktive Echtzeit-Transport bleibt V1
(Tone.js + AudioWorklets). Der V2-Pfad (`audioEngine.setPlaybackMode('v2')`, `playV2/stopV2/
triggerEventV2`, `ingestAudioSources`) ist vollständig verdrahtet und getestet; er wird nach dem
Live-Test schrittweise zum Standard (DCT-110).

---

## ☁️ RunDienste (Services)

### Hauptprozess
| Dienst | Pfad | Beschreibung |
|---|---|---|
| **Server (All-in-One)** | `server.ts` | Express + Vite (Dev) bzw. statisch (Prod) + REST-API + Socket.io-Signaling + optional SFU (Mediasoup) + Stems-Proxy + Voice-Stub + Cloud-Endpunkte |

Start: `npm run dev` (Dev, Port 8080) · `npm run build && npm start` (Prod, `dist/server.cjs`).

### Einzel-RunDienste (`services/`)
| Dienst | Pfad | Sprache | Beschreibung |
|---|---|---|---|
| backend-core | `services/backend-core/` | Node + Python | **HISTORISCH (DCT-107):** API-Kern/MOA-Pipeline der Vorversion. Ownership liegt jetzt bei `server.ts` (API-Gateway) → `src/core/ai` (MOA/LLM) → optionale Sidecars (`stem-ai`, `master-player`). Nicht mehr deployen. |
| library-ai | `services/library-ai/tagger.py` | Python | KI-Tagging für die Bibliothek |
| master-player | `services/master-player/server.py` | Python | Master-Player-Service |
| mixer | `services/mixer/` | Rust (N-API) | Server-Side-Mixer (Rust, vorkompiliertes `.node`) |
| signaling | `services/signaling/index.js` | Node | Eigenständiger Signaling-Server |
| stem-ai | `services/stem-ai/main.py` | Python | Demucs-Stem-Separation (via `ENABLE_STEMS=1` + `STEM_AI_URL`) |
| Task-Worker | `services/taskWorker.ts` | TypeScript | Hintergrund-Task-Queue (`npm run worker`) |

Daten-/Protokoll-Dokumente: `services/backend-core/ASSET_DB_SCHEMA.md`, `SESSION_DB_SCHEMA.md`, `SIGNALING_PROTOCOL.md`.

---

## 🔊 ASUS Xonar U7 – App-weite Audio-Ausgabe

Der **AudioDeviceManager** (`src/utils/audioDeviceManager.ts`) verwaltet die Ausgabe für die **gesamte App**
(nicht nur Spatial): Enumeration, Xonar-U7-Erkennung, `setSinkId()` auf dem Master-AudioContext und
Mehrgeräte-Kanalpläne.

| Konfiguration | Kanäle | Geräte |
|---|---|---|
| 1× Xonar U7 (7.1) | 8 | 1 |
| 12.x Spatial | 12–14 | 2× U7 |
| 18.x Spatial | 18–20 | 3× U7 |
| 24.x Spatial | 24–26 | 3–4× U7 (24.1/24.2 → 4×) |

- **Xonar-U7-Kanalbelegung je Gerät:** FL · FR · C · LFE · RL · RR · SL · SR
- **App-weit setzen:** Settings-Dialog → Ausgabe → Gerät wählen (setSinkId)
- **Mehrgeräte:** Browser steuern nativ nur EIN Gerät an → OS-Aggregation nötig:
  - Windows: ASIO4ALL / Voicemeeter / „Lautsprecher gruppieren"
  - Linux: PipeWire Combine-Sink
  - macOS: Aggregate Device
- **Kanalplan:** `audioDeviceManager.xonarChannelMap(setupId, raum)` liefert für jedes Setup die
  vollständige Zuordnung Kanal → Gerät → Gerätekanal (Referenz für Aggregation & native Backends).

---

## 📐 Spatial-Audio & Raumplaner

Unterstützte Formate: `2.0 · 4.0 · 6.0 · 8.0 · 10.0 · 12.0/12.1/12.2 · 14.0 · 16.0 · 18.0/18.1/18.2 · 24.0/24.1/24.2`.

- `.1` = 1 LFE-Kanal, `.2` = 2 LFE-Kanäle
- **Raumplaner** (`src/core/spatial/roomPlanner.ts` + `RoomPlannerPanel.tsx`): aus Raumlänge/-breite werden
  für alle drei Familien (12.x/18.x/24.x) **Kanalnummer, Aufstellwinkel, Position (x/y) und Abstand** berechnet
  und per Knopfdruck ins Audiosystem übernommen (`audioEngine.setSpatialSetup()`).
- Renderer: Stereo / Binaural / Multichannel (`src/core/spatial/spatialRenderers.ts`), Ambisonics 1st/2nd Order,
  HRTF-Interpolation, Spatial-Scene.
- Edge-/Dig-Ana-Bridge: `docs/SPATIAL_BRIDGE_SPEC.md`, `src/core/edge/`.

---

## 🌐 Cross-Origin-Isolation (COOP/COEP) & WebGPU-/WASM-Multithreading

Der Server setzt automatisch:
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: credentialless` (erlaubt weiterhin Supabase-/R2-Audio-URLs)
- `Cross-Origin-Resource-Policy: cross-origin`

Damit ist `crossOriginIsolated` aktiv → **SharedArrayBuffer** und **WASM-Multithreading**
(`onnxruntime-web` nutzt dann bis zu 4 Threads + SIMD, `src/ai/localDemucs.ts` konfiguriert das automatisch).

## 🔊 OS-Aggregation für mehrere Xonar U7

| OS | Weg | Skript |
|---|---|---|
| Windows | ASIO4ALL / Voicemeeter Potato / Stereomix | `scripts/windows-aggregate.ps1` |
| Linux | PipeWire/PulseAudio Combine-Sink (`xonar_aggregate`) | `scripts/pipewire-combine-sink.sh` |
| macOS | Audio-MIDI-Setup → Aggregat-Gerät | `scripts/macos-aggregate.sh` |

Status + Anleitung live in der App: **Settings → Ausgabe → „OS-Aggregation"**.
Kanalplan je U7: `1 FL · 2 FR · 3 C · 4 LFE · 5 RL · 6 RR · 7 SL · 8 SR`.

## 🎼 Stem-Separation (100% echtes ONNX-Modell)

- **Modell:** HTDemucs v4 (`htdemucs.onnx`, ~291 MB) in `public/models/`
- **Download:** `bash scripts/download-models.sh` (Hugging Face `smank/htdemucs-onnx`)
- **Inferenz:** `src/ai/localDemucs.ts` – ONNX Runtime Web (WebGPU → WASM), decode → 44,1 kHz → Segmentierung (343.980 Samples, 25 % Overlap) → Overlap-Add → WAV
- **Stems:** drums · bass · other · vocals (echte Modell-Ausgabe)
- Notfall nur bei fehlendem Modell: DSP-Split (`src/utils/stemSplitter.ts`)

## 🧠 KI-Infrastruktur (`src/ai/` + `src/core/ai/`)

| Modul | Aufgabe |
|---|---|
| `aiRouter.ts` | Fallback-Kette **lokal → remote → deterministisch**, Qualitätsstufen preview/standard/high |
| `modelRegistry.ts` | Modell-Registry mit Hot-Swap |
| `costMonitor.ts` | Token-/Budget-Monitoring mit Warnungen |
| `localDemucs.ts` | Lokale Stem-Separation (ONNX-Scaffold + deterministischer Fallback) |
| `localVoice.ts` | Lokale TTS (VITS-CLI → WebSpeech → deterministisch) |
| `embeddingCache.ts` | Embedding-Cache (Memory + Storage, max. 500) |
| `core/ai/LlmRouter.ts` | Kosten-Routing: **DeepSeek Flash (MOA/MCP) → HF → Mistral → Ollama (lokal) → DeepSeek Pro**; Gemini/OpenAI nur Notfall (`AI_EMERGENCY_PROVIDERS=true`) |
| `core/ai/MoaAgent.ts` | MOA/MCP-Planer: Aufgaben → Plugin-Schritte → `VoiceControlService`-Ausführung |
| `core/ai/MoaHistory.ts` | Zentrale, persistente MOA-Historie (Session/UI) |
| `core/ai/clientLlm.ts` | Browser-Client für `/api/ai/complete` (Keys bleiben serverseitig) |
| `core/voice/hfApi.ts` | Browser-Proxy für `/api/voice/tts|sing|song` |
| `core/voice/pluginCommandRegistry.ts` | Kommando-Registry: alle 17 Plugin-IDs für Sprach-/KI-Steuerung |
| `core/voice/SongGenerator.ts` | Song-Generator (Suno-artig): HF MusicGen → lokaler Formant-Synth |
| `core/voice/VoiceMonkService.ts` | TTS (HF MMS + deterministisch), Gesang (Bark + Formant), Song-Erzeugung |

Weitere: `utils/LocalEmbeddingProvider.ts` (transformers.js MiniLM), `core/gpu/WebGPUKernel.ts` (GEMM/Activation), `core/gpu/SpatialConvKernel.ts`.

**Voice-Fallback-Kette (Server):** HF MMS/Bark/MusicGen → lokaler Synth (Groq entfernt, HF ist Primär-Fallback).
Vollständige Übersicht aller APIs: **[docs/API_INTEGRATIONS.md](docs/API_INTEGRATIONS.md)**.

---

## 🗄 Datenbank & Cloud (Supabase + Cloudflare R2)

**Supabase** (Projekt `pwtwtqbcynsjtkxlkrwh`):
- Tabellen: `samples`, `sample_tags`, `music_tracks`, `library_links` (Schema: `database/schema.sql`, idempotent)
- Lese-Zugriff: anon-Key (RLS) · Schreib-Zugriff: service_role (nur Server)
- **Cloudflare R2**: Bucket `audiomonastrysamples` für Audio-Blobs

**Server-Endpunkte:**
| Endpunkt | Funktion |
|---|---|
| `GET /api/health` | Health-Check |
| `GET /api/cloud/health` | Supabase-/R2-Status |
| `POST /api/cloud/sync` | Preset-Daten seeden (Samples/Musik) |
| `POST /api/cloud/samples` | Einzelnes Sample upserten |
| `POST /api/cloud/music` | Einzelnen Track upserten |
| `POST /api/cloud/upload` | Audio-Blob (base64) → R2 |
| `POST /api/ai/compose` | Deterministischer Preset-Generator |
| `POST /api/ai/generate` | Ollama-KI-Komposition (Fallback lokal) |
| `POST /api/ai/describe` | Ollama-Beschreibung/Mix-Tipp |
| `POST /api/ai/complete` | LLM-Router (DeepSeek/HF/Mistral/Ollama) – Keys serverseitig |
| `GET /api/metrics` | Metriken: JSON (Default) oder `?format=prometheus` (Prometheus/Grafana) |
| `POST /api/separate-stems` | Stems (SSE-Fallback / stem-ai-Proxy) |
| `POST /api/generate-voice` | Voice (lokale Engine / WebSpeech) |
| `POST /api/voice/tts` | Text → Stimme (HF MMS, Fallback lokaler Synth) |
| `POST /api/voice/sing` | Text → Gesang (HF Bark, Fallback lokaler Synth) |
| `POST /api/voice/song` | Text → Song (HF MusicGen medium→small) |

**WebRTC:** Socket.io `/webrtc-signaling` (offer/answer/ice) · optional Mediasoup `/sfu-signaling` (`ENABLE_SFU=1`).

---

## 🧩 Core-Abstraktionen (`src/core/`)

| Bereich | Module |
|---|---|
| Interfaces | `interfaces.ts` – `IAudioBackend`, `IAIRuntime`, `IComputeBackend`, `ISpatialRenderer`, `IHardwareAdapter`, `ITransport` |
| Adapter | `adapters.ts` – WebAudioBackend, AIRuntime, ComputeBackend, SpatialRenderer, WebMIDI/HID/OSC-Adapter |
| Worker | `workers/` – WorkerPool, RingBuffer (SAB), WorkletPool, AsyncSandbox |
| Transport | `transport/` – WebRTCTransport, MediasoupTransport, TransportRegistry (sfu→p2p→local), LocalTransport |
| Spatial | `spatial/` – spatialRenderers, SpatialScene, ambisonics, hrtfInterpolator, roomPlanner |
| Session | `session/` – ObjectRegistry (UUID+Version), stateReplication (CRDT/LWW), locking (Lease), seedManagement, SessionSnapshot |
| Edge | `edge/` – EdgeDspClient, EdgeRouter, FailoverController |
| Hardware | `hardware/` – HardwareSimulator, HotplugManager |
| Native | `native/NativeAudioBackend.ts` – ASIO/CoreAudio/PipeWire-Abstraktion |
| GPU | `gpu/` – WebGPUKernel, SpatialConvKernel |
| Instrument | `instrument/` – Typen, Katalog, IInstrumentBackend, InstrumentBackend, midiProgramMap |

Dokumentation: `src/core/README.md`.

---

## 🔧 Utility-Module (`src/utils/`)

`audioEngine` (zentrale Engine), `spatialMath` (Panning/HRTF/Setups), `audioDeviceManager` (Xonar U7),
`PerformanceMonitor`, `telemetry`, `usageAnalytics`, `errorTracker`, `dspOptimizations`, `ObjectPool`,
`storage`/`indexedDB`/`mediaDevices`/`workerFactory`/`audioContextFactory` (Plattform-Adapter),
`audioAnalyzer`, `audioDiagnostics`, `PitchDetector`, `LatencyMonitor`, `ClockSync`, `PhaseLockedLoop`,
`rbac` (Rollen+Permissions+Transition), `collab`, `db`, `presetStore`, `opfs`, `LocalEmbeddingProvider`,
`aiRhythmGenerator`, `prompts`, `presetValidator`, `routingValidator`, `validation`, `spatialAutomation`,
`StemRouter`, `WebRTCManager`, `LiveStreamOut`, `AuditLogger`, `audioGraphSerialization`.

---

## ⚙️ Umgebungsvariablen (`.env`)

**Server:** `PORT`, `NODE_ENV`, `OLLAMA_URL`, `OLLAMA_MODEL`, `BACKEND_CORE_URL`, `STEM_AI_URL`, `ENABLE_STEMS`,
`VOICE_ENGINE`, `VOICE_CLI`, `ENABLE_SFU`, `SFU_LISTEN_IP`, `SFU_ANNOUNCED_IP`,
`SFU_RTC_MIN_PORT`/`SFU_RTC_MAX_PORT` (Mediasoup-RTP-Bereich, Default 40000–40099),
`API_RATE_LIMIT_MAX`/`API_RATE_LIMIT_WINDOW_MS` (Default 60/Min/IP),
`SIGNALING_IDLE_TIMEOUT_MS`, `SIGNALING_ALLOWED_ORIGINS` (Komma-Liste oder `*`).

**Cloud:** `SUPABASE_URL`, `SUPABASE_ANON_PUB`, `SUPABASE_PUBLISHABLE`, `SUPABASE_SERVICE_ROLE`, `SUPABASE_SERVICE_ROLE_JWT`, `SUPABASE_PAT`,
`CLOUDFLARE_API`, `CFR2_ACCOUNT_ID`, `CFR2_ACCESS_KEY_ID`, `CFR2_SECRET_ACCESS_KEY`, `CFR2_API_TOKEN`, `CFR2_BUCKET`.

**Client (VITE_):** `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_PUB`, `VITE_CFR2_ACCOUNT_ID`, `VITE_CFR2_BUCKET`,
`VITE_API_BASE_URL`, `VITE_SOCKET_IO_SIGNALING_URL`, `VITE_SIGNALING_WS_URL/HTTP_URL/TRANSPORT_URL`, `VITE_ENABLE_LOCAL_EMBEDDINGS`, `VITE_VOICE_ENGINE`, `VITE_VOICE_CLI`.

**KI-Keys (optional, alle serverseitig):** `HF_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY` (Modell per `MISTRAL_MODEL`), `OLLAMA_URL`/`OLLAMA_MODEL` (lokaler MOA-/Sprach-/TTS-Fallback auf der GPU-Instanz),
`GEMINI_API_KEY`, `OPENAI_API_KEY`, `AI_EMERGENCY_PROVIDERS` (`true` registriert Gemini/OpenAI als Notfall).

**Voice-Modelle (Server):** `HF_TTS_MODEL` (Default `facebook/mms-tts-deu`), `HF_BARK_MODEL` (Default `suno/bark`),
`HF_MUSIC_MODEL` (Default `facebook/musicgen-medium`), `HF_MUSIC_FALLBACK_MODEL` (Default `facebook/musicgen-small`),


Vorlagen: `.env.example` (Dev) · `.env.hetzner.example` (Deployment).

---

## 🚀 Entwicklung, Build & Deployment

```bash
npm run dev      # Dev-Server (tsx server.ts, Port 8080)
npm run build    # Vite-Build + Worklets + Server-Bundle (dist/server.cjs)
npm start        # Produktion (node dist/server.cjs)
npm run worker   # Task-Worker
npm run lint     # tsc --noEmit
```

**Tests & Qualitätssicherung:**
```bash
npm run test           # Vitest-Suite (32 Dateien, 158 Tests)
npm run test:coverage  # Coverage-Report (coverage/lcov.info für SonarCloud)
node scripts/validate-interface-boundaries.mjs   # Interface-/Plattform-API-Scan (muss 0 sein)
```

**Stresstests (Hetzner):**
```bash
npm run build:sfu-test            # SFU-RTP-Testbundle erzeugen (public/sfu-rtp-test.js)
BASE_URL=http://IP npm run stress:hetzner      # HTTP + Socket.io-Lasttest
BASE_URL=http://IP npm run stress:sfu          # Mediasoup-Transport-/Router-Last
BASE_URL=http://IP npm run stress:sfu-rtp      # Echter SFU-RTP-Pfad (Browser/Fake-Mic)
BASE_URL=http://IP npm run stress:sfu-rtp-multi # 2 Producer + 2 Consumer über Kreuz + Echo
```
Für die RTP-Tests muss die Instanz `ENABLE_SFU=1`, `SFU_ANNOUNCED_IP` und
`SIGNALING_ALLOWED_ORIGINS` gesetzt haben; die Testseite läuft lokal auf
`localhost` (secure context) und signalisiert per `?server=` an die Instanz.

**SonarCloud:** Analyse läuft automatisch bei Push/PR (`.github/workflows/sonarcloud.yml`).
Quality Gate: **OK** – 0 Bugs, 0 Vulnerabilities, Security/Reliability/Maintainability = A,
New Coverage = **87,4 %** (Stand 2026-08-27). Konfiguration: `sonar-project.properties`.

**Container:**
- `Dockerfile` / `Dockerfile.multistage` / `Dockerfile.hetzner` (tini, non-root, Healthcheck, OCI-Labels)
- `docker-compose.yml` (Dev) / `docker-compose.hetzner.yml` (Hetzner: Caddy + App + master-player, gehärtet mit `cap_drop`/`read_only`, Profile `fleet`=Redis, `ai`=Ollama)
- `docker-compose.sfu.yml` (Mediasoup-RTP-Ports) / `docker-compose.monitoring.yml` (Prometheus + Grafana + cAdvisor + node-exporter) / `docker-compose.fleet-test.yml` (2. App-Instanz für Redis-Fleet-Test)
- `deploy.sh` (Image-Transfer via `docker save | ssh docker load`, Rollback-Image, Health-Wait + Smoke-Test)
- `scripts/hetzner/` (provision.py mit `ROLE=sfu`, cloud-init mit BBR/UDP-Tuning, Idle-Auto-Shutdown, `fleet-redis-test.mjs`, Grafana-Provisioning)

**Kubernetes (Helm):** `deploy/helm/audiomonastry/` – Chart, HPA, Readiness-/Liveness-Probes, Multi-Region-Values, Backup-CronJob.

**Wake-on-Login (0 € Standby):** `scripts/wake-on-login/` – kostenloser Cloudflare-Worker.
Alle Hetzner-Server sind aus (0 €/h), bis man sich auf der Login-Seite einloggt.
Der Worker startet dann die Flotte, pollt `/api/health` und leitet in die App.
Deploy: `bash scripts/wake-on-login/deploy.sh` (Passwort wird generiert/persistiert,
Hetzner-Token wird nur beim Deploy injiziert – Repo enthält keine Secrets).

**Server-Sizing & Volllast:** Instanz-Flotte, Lastprofile aller Module und Volllast-Simulation: **[docs/SERVER_SIZING.md](docs/SERVER_SIZING.md)**.

**Skripte (`scripts/`):** `backup.sh`, `build-cross-platform.sh`, `build-wasm-audio.sh`, `vm-startup.sh`, `hetzner/` (provision.py, start-prod, idle-shutdown, smoke-test), `validate-interface-boundaries.mjs`.

**WASM-DSP:** `src/audio/wasm/dspKernel.c` → `scripts/build-wasm-audio.sh` (Emscripten) → `dist/wasm/`.

---

## 🔒 Sicherheit & Betrieb

- `.env` ist in `.gitignore` (Keys niemals committen; bei Klartext-Leak rotieren)
- `deepcode/` (lokale Agent-Keys) ist ignoriert
- Boundary-Regel: Kernmodule ohne direkte Plattform-APIs (Validator erzwingt das)
- Supabase-RLS: anon = Lesen, service_role = Schreiben (nur Server-seitig)
- Rate-Limiting: `/api` 60 req/min/IP

---

## ⚖️ Copyright & Branding

**audioMONASTRY** by **monkMONASTRY** · inspiriert vom PRAIN Cluster · alle Rechte AnunnakiTools 2026 by Patrick Hilf.
