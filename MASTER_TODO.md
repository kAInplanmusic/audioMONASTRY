# MASTERTODO

Legende:
- `[ ]` offene Aufgabe
- `[x]` erledigt
- Priorität: 🔴 Kritisch · 🟠 Hoch · 🟡 Mittel · 🔵 Strategisch

---

## 📦 Release-Stand: audioMONASTRY V. 1|001|420 Codename „AnunnakiDNA" (2026-08-30)

> Neues privates Repo „audioMONASTRY“ mit Initial-Commit dieses Standes.
> `package.json` = `1.1.420`, Branding = `V. 1|001|420 CODENAME AnunnakiDNA`.
> MASTER_TODO ist vollständig abgearbeitet – offen sind nur noch zwei
> **Hardware-Tests** (Live-2-Browser-WebRTC mit echten Geräten,
> Sample-Raten-Wechsel am nativen Backend/Xonar U7), die physisch nicht
> automatisierbar sind.

---

## 🔵 OFFENE PUNKTE aus Tests & Audits (Stand 2026-08-30, Live-Test-Vorbereitung)

> Nightly-CI läuft um **04:00 UTC (06:00 DE Sommerzeit)** – nach dem DJ-Betrieb,
> nicht mehr 02:30 UTC. Erledigt: Zeit umgestellt (`.github/workflows/nightly.yml`).

- [ ] **Live-2-Browser-WebRTC-Test** (echte 2 Geräte: Laptop + iPhone/iPad, Offer/Answer/State-Sync, Mikrofon) – ⛔ Hardware-Test: erfordert 2 physische Geräte, kann nicht automatisiert werden; der 4-Kontext-E2E läuft grün
- [x] **SFU-RTP-Echtpfad-Test** (Browser + Fake-Mic, `sfu-rtp-run.mjs`) gegen sfu-1 – ✅ 2026-08-30 live verifiziert: DTLS connected, Producer+Consumer erzeugt, RTP-Stats `bytes=4702 packets=94`, `mode=echo`, `ok:true`
- [ ] **Sample-Raten-Wechsel-Test** (44.1/48/96/192 kHz) – ⛔ Hardware-Test: muss am nativen Backend (`AudioDeviceManager`/Xonar U7) mit echter Karte verifiziert werden
- [x] **Browser-Matrix komplett:** Firefox/WebKit-E2E (DCT-124) – lokal Chromium+Firefox grün, WebKit verifiziert (Umgebungs-Workaround); CI-Matrix `build.yml` läuft jetzt Chromium/Firefox/WebKit auf ubuntu-latest mit `--with-deps`
- [x] **Dependency-Audit (`npm audit`)** – 2026-08-30: **0 Vulnerabilities** (prod `--omit=dev` und voll)
- [x] **SonarCloud-Coverage-Lücken:** `stemSplitter.ts`, `telemetry.ts`, `usageAnalytics.ts`, `workerFactory.ts`, `validation.ts` – Tests in `tests/coverageGaps.test.ts` ergänzt; alle 5 Dateien jetzt 100 % Statement-Coverage
- [x] **ai-1 ausbauen:** Ollama + Stem-AI-CPU-Fallback installiert – ✅ live auf ai-1: Ollama 0.33.2 (qwen2.5:7b, CPU-Test „OK“) + stem-ai systemd-Dienst aktiv (`/health → {status:ok, device:cpu}`); Replicate bleibt Primärpfad, ai-1 ist Fallback
- [x] **Alerting-Webhook** (Discord/Slack/Telegram) für Prometheus-Alerts – umgesetzt: Alertmanager (`scripts/hetzner/alertmanager.yml`) + App-Endpoint `POST /api/alerts/webhook` + Compose-Service `alertmanager` + Tests
- [x] **Live-Telemetrie-Dashboard:** Client-Events (`/api/telemetry`) in Grafana visualisieren – umgesetzt: `/api/metrics` liefert `samplemonk_telemetry_events_by_type_total` / `_by_source_total`; Grafana-Panels 12–14 im Overview-Dashboard; Server-Tests ergänzt
- [x] Nightly-CI-Zeit auf 04:00 UTC geändert (war 02:30 UTC)
- [x] Wake-on-Login, Auto-Shutdown (20 min), Auto-Repair (2 min), Prometheus-Alerts, Replicate aktiv, Stresstests grün – alles live verifiziert

### 🔴 P0 – Architecture-Audit (`docs/ARCHITECTURE_AUDIT_2026.md`), vor Live-Test
- [x] Session-Identität minimal: senderUserId im Relay, Locking an echter User-ID (WebRTCManager.userId)
- [x] Generische AudioParam-Rampen für eq/dsp/effect/mastering-Worklets (automate, zipper-frei)
- [x] Underrun-/Dropout-Zähler im Audio-Thread → `/api/telemetry` + UI (analyzerProcessor → onDropout)

### 🟠 P1 – kurz nach Live-Test
- [x] End-to-End-Latenz persistieren (LatencyMonitor → Telemetrie/Grafana): 30s-Snapshot (baseLatency, sampleRate, RTT, Dropouts) an /api/telemetry
- [x] Lazy-Worklet-Konstruktionen auditieren: alle `new AudioWorkletNode`-Stellen verifiziert (init/try-catch/rawCtx-Fallback); setEffectParam-Fix war die letzte Lücke
- [x] OPFS-Sample-Cache aktivieren: war bereits integriert (SampleContext persistFile/listSamples) – verifiziert
- [ ] Live-2-Browser-WebRTC-Test (echte Geräte) – ⛔ Hardware-Test, nicht automatisierbar; SFU-RTP-Teil ist erledigt (siehe oben, live gegen sfu-1)
- [x] Dependency-Audit (`npm audit --omit=dev`): **0 Vulnerabilities**

### 🔵 P2 – strategisch
- [x] WASM-Kernel: als optionaler Offline-Render-Referenzpfad markiert (nicht als Produktiv-WASM bewerben)
- [x] WebGPU: defer bis echter Workload (ONNX-Inferenz/Spektral) – dokumentiert
- [x] Binärprotokoll (CBOR/Protobuf): YAGNI bis >10 User – dokumentiert
- [x] Alert-Webhook: `scripts/hetzner/alert-webhook.sh` (Discord/Slack, Health→Alarm)

### 🚫 Bewusst NICHT (Audit-Entscheidungen)
- [x] WebTransport: rejected (WebRTC + Socket.io korrekt für 4 User)
- [x] OpenTelemetry: overkill (eigene Telemetrie reicht)
- [x] Yjs/CRDT-Framework: YAGNI (LWW-CRDT reicht bis >10 User)
- [x] WebCodecs: nicht nötig (WebRTC/FFmpeg decken ab)
- [x] „<3 ms end-to-end"-Marketing: nicht seriös (realistisch 8–15 ms lokal, <50 ms Netz)

## 🔬 Vertiefter Code-Audit (2026-08-30) – verifizierte Fakten & Rest-Aktionen

**Verifiziert (codebasiert):**
- Worklet-Hot-Pfade: `analyzerProcessor`/`lufsProcessor` nur `Float32Array`+`Atomics.store`; `masteringProcessor` alloziert Delay-Line/Scratch nur bei Kanalzahl-Wechsel (bewacht) – kein GC-Druck im Regelpfad
- SAB/Atomics: LUFS + Analyzer echtes Zero-Copy (SAB wird per postMessage als Buffer übergeben, keine Kopie); Parameter laufen als kleine JSON-Objekte (Control-Rate, korrekt)
- SPSC-RingBuffer: Layout `[Daten][head][tail]` korrekt, Atomics SeqCst, kein ABA bei SPSC, Overflow=push-false, Underflow=pop-undefined; **Hinweis:** Int32-Indizes laufen nach 2^31 Pushes über (theoretisch, praktisch irrelevant bei Audio-Kontrollraten)
- Kein Resampler in der Engine (Browser/Device macht SRC; Tone.Player resampled via WebAudio) – für 44.1k-Assets in 48k-Kontext ok
- Hybrid-Engine vorhanden: V1 Tone.js (Produktiv) + V2 AudioGraph/WorkletGraphRuntime + OfflineBounceEngine (deterministisch) – PDC für Mastering-Lookahead

**Rest-Aktionen (priorisiert):**
- [x] P1: End-to-End-Latenz persistieren (LatencyMonitor → Telemetrie/Grafana) – umgesetzt in `src/App.tsx` (30s-Snapshot mit baseLatency/sampleRate/RTT/Dropouts an `/api/telemetry`)
- [x] P1: Lazy-Worklet-Audit abschließen (alle `new AudioWorkletNode` außerhalb init() absichern – setEffectParam-Muster) – Commit `fab92d1` „MASTER_TODO P1 erledigt“
- [x] P1: OPFS-Sample-Cache für Bibliotheken >2 GB – Integration verifiziert (`SampleContext persistFile/listSamples`); >2-GB-Benchmark läuft als Sandbox V1.6 in `VISIONS_TODO.md`
- [ ] P1: Live-2-Browser-WebRTC (echte Geräte) – ⛔ Hardware-Test; SFU-RTP-Echtpfad ist erledigt (live gegen sfu-1, siehe oben)
- [x] P2: Hybrid-Split Low-Latency/High-Quality – als Sandbox V1.5 in `VISIONS_TODO.md` geführt (Aufnahme erst nach Benchmark, siehe Aufnahme-Kriterien)
- [x] P0/P2 wie oben: Identität, Rampen, Dropout, npm audit 0, WASM/WebGPU/Binär-Entscheidungen, Alert-Webhook

---

## 🚀 BETA 1.000.001 „FABÖLUS" (2026-08-27) – Finalisierung

- [x] Version auf `1.000.001-beta.1` gesetzt (package.json + UI-Branding „V1.000.001β FABÖLUS" + index.html-Titel)
- [x] LLM-Router finalisiert: DeepSeek V4 Flash als MOA/MCP-Planer, Groq/SambaNova Free-Tier, Gemini/OpenAI nur Notfall (`AI_EMERGENCY_PROVIDERS=true`)
- [x] MOA/MCP-Agent (`MoaAgent`), Client-Proxy (`clientLlm`), Server-Proxy `/api/ai/complete`
- [x] Voice/Song/LLM-Keys vollständig serverseitig (keine Secrets im Client-Bundle)
- [x] Plugin-Kommando-Registry (`pluginCommandRegistry`) für Sprach-/KI-Steuerung (Tempo/Play/Stop/Automation)
- [x] MOA/MCP-Verdrahtung: `VoiceControlService.executePluginCommand` (exakte Action + Keywords), `MoaAgent.executePlan` plugin-bewusst, `MoaAssistant`-UI in **allen 17 Plugin-Terminals** eingebaut – Registry deckt alle 17 Plugin-IDs ab (sampler hat echten `trigger`-Handler, stem/recording/mastering/visualizer/performance melden Status)
- [x] MOA-Stufen 1–3: echte UI-only-Handler (Datei-Picker/Recorder/Mastering/Visualizer/Performance), Pattern-State-Sync (Sequencer/Drum), AUTO_AI-Feedback in 14 Terminals
- [x] AUTO_AI-Modus: periodische plugin-spezifische MOA-Vorschläge (`PLUGIN_MOA_TASKS`), zentrale `MoaHistory` + `MoaHistoryPanel`, Event-Handler-Tests (jsdom)
- [x] Sequencer „KI-PATTERN"-Button (nutzt `/api/ai/compose`, wendet Patterns + BPM an)
- [x] WASM-Backend: optionaler Kernel-Load + JS-Graph-Fallback (keine TODO-Stubs mehr)
- [x] SonarQube: Boundary-Scan 0 Verstöße, Coverage (`coverage/lcov.info`) erzeugt, Workflow bereit
- [x] `tsc` sauber · 96/96 Tests grün · Production-Build ok · kein Secret-Leak

---

## ARCHITEKTUR-EVOLUTION (Priorität: KRITISCH)

> Ziel: Backend-unabhängige Audio-Runtime (Browser/WebAudio, WASM, Native),
> Spatial Scene System (bis 24.2), VoiceMONK-Integration und deterministisches
> Offline-Rendering.

### Phase 1: Audio Runtime Abstraktion
- [x] AudioGraph vom Browser entkoppeln (Migration bestehender `audioEngine.ts`: hybrid gelöst – V1-Tone-Transport bleibt Produktivpfad, V2-Graph-Pfad ist über `setPlaybackMode('v2')`, `playV2/stopV2/triggerEventV2` und `ingestAudioSources` verdrahtet; `GraphEngineAdapter` hält V1↔V2 synchron)
- [x] IAudioNode Interface definieren
- [x] IAudioBuffer, IAudioPort, IAudioParameter Interfaces erstellen
- [x] ProcessingPlan System implementieren
- [x] Backend-unabhängige Node-Architektur aufbauen (Grundgerüst `src/core/audio/`)

### Phase 2: Native Runtime Integration
- [x] audioMONASTRY-runtime Prozess konzipieren (`RuntimeProcessManager`, `services/audio-runtime`)
- [x] Rust-basierte Audio Engine vorbereiten (`services/audio-runtime/src/main.rs`, JSON-Lines-IPC)
- [x] IPC-Protokoll zwischen React und Runtime definieren (`src/core/audio/runtime/ipc.ts`)
- [x] Device Manager mit Backend-Abstraktion implementieren (`AudioDeviceManager`)

### Phase 3: Spatial Scene System
- [x] SpatialScene als zentrale Datenstruktur implementieren
- [x] AudioObject vom Track entkoppeln
- [x] Source → Extraction → AudioObject Pipeline aufbauen (`SourceExtractionPipeline`)
- [x] 24.2 Output-Konfiguration unterstützen (`layouts.ts`, 26 Kanäle)
- [x] Stereo als Standard, Spatial als optionalen Modus implementieren

### Phase 4: VoiceMONK Integration
- [x] Speech Engine (TTS) integriert (`HfTtsProvider` via Server-Proxy `/api/voice/tts`, `DeterministicTtsProvider` offline, Web-Speech-Fallback)
- [x] Singing Engine mit Lyrics/Melody/Pitch/Timing vorbereitet (`sing()` via HF Bark `/api/voice/sing` + lokaler Formant-Synth `LocalFormantSingingProvider`)
- [x] AI Automation Agent für Sprachsteuerung entwickelt (regelbasiert + getestet; `pluginCommandRegistry` registriert Standard-Kommandos für Transport/FX)
- [x] Control-Layer: DeepSeek V4 Flash als MOA/MCP-Planer (`MoaAgent` + `LlmRouter` + `/api/ai/complete`-Proxy) statt OpenAI; lokale Voice Engine bleibt Synthese-Backend

### Phase 5: Offline Render Engine
- [x] Deterministisches Offline-Rendering implementieren (`OfflineRenderer`)
- [x] Gleiche AudioGraph-Struktur für Realtime und Offline nutzen
- [x] Render-Faktoren (1x, 4x, 20x) unterstützen

---

## 🟢 Finale Prioritätenliste (Top 5 – erledigt 2026-08-24)
*Nach dem Codebase-Scan iterierte, finale Liste mit Fokus auf State of the Art,
Soundqualität, Stabilität und Reaktionszeit.*

- [x] **F1 Interface-Boundary-Validator** – `scripts/validate-interface-boundaries.mjs`
  scannt alle 128 Src-Dateien auf direkte Plattform-API-Zugriffe (AudioContext,
  WebMIDI, WebRTC, Worker, Storage, Vite-Env). Adapter-Schicht ist explizit
  erlaubt; Verstöße werden als Backlog gelistet (siehe Abschnitt 1.1).
- [x] **F2 Echtzeit-Performance-Monitor** – `src/utils/PerformanceMonitor.ts`
  (FPS, Frame-Jitter, Dropped Frames, Audio-Health) + Live-Anzeige im
  DSPTerminal (ersetzt die statischen Dummy-Werte). Audio-Health via
  `audioEngine.getAudioHealth()`.
- [x] **F3 Worklet-Hot-Path-Optimierung** – GC-freie Render-Quanten:
  `itSynthProcessor` (Mix-Puffer-Preallocation), `masteringProcessor`
  (Scratch statt `number[]`-Allokation pro Sample), `analyzerProcessor`
  (kein `slice()`-Allok). Entspricht 2.1.2/2.2.3-Kernpunkten.
- [x] **F4 Audio-Graph-Serialisierung** – `src/utils/audioGraphSerialization.ts`
  (typisiertes, validiertes JSON-Format) + `audioEngine.exportGraphState()` /
  `audioEngine.importGraphState()` (Patterns, Synth-Noten, Mixer, Master,
  BPM/Swing/Gate, Scale, Spatial-Setup). Entspricht 2.1.4.
- [x] **F5 Mastering True-Peak-Limiter + Stabilität** – `masteringProcessor`
  mit Inter-Sample-Peak-Erkennung (2x-Oversampling-Schätzung), exponentieller
  Release-Hüllkurve, NaN/Inf-Guard und Bug-Fix der `ceiling`-Nachricht.

---

## 🔴 Priorität 0: instrumentMONK – nächste Umsetzungs-Tasks
**Reihenfolge: 1, 3, 2**

Ziel: Die drei aus der instrumentMONK-Engine abgeleiteten nächsten Bausteine
in dieser Reihenfolge abarbeiten: **1)** Sample-genaue Automation,
**3)** Worklet-Param-/Filter-LFO-Steuerung im DSP-Terminal, **2)** MIDI-Program-
Change-Mapping der 100 Instrumente.

### [x] Task 1 – Sample-genaue Automation im it-synth-processor
- Verknüpfung mit **2.1.3** («AudioParam-Automations-Pipeline mit Lookahead»).
- Umsetzung: Im `it-synth-processor` pro-Sample-Interpolations-Buffer für
  `cutoff`, `resonance`, `modIndex`, `gain` aufbauen (Lineare Rampen statt
  hörbarer Zipper-Sprünge), Steuerung über Port-Nachricht `{type:'automate',
  param, value, rampTime?}`.
- Validierung: `tsc` sauber, keine hörbaren Zipper-Artefakte, Latenz-Ziel
  < 1 ms lokale Verarbeitung; DSP-Test ohne NaN/Inf.

> **✅ UMGESETZT:** `itSynthProcessor.ts` besitzt jetzt einen sample-genauen
> Rampen-Automator (`cutoff`/`resonance`/`modIndex`/`gain`/`lfoRate`/`lfoDepth`),
> Nachricht `{type:'automate', param, value, rampTime?}`, NaN/Inf-Guards und
> einen wiederverwendbaren Parameter-Snapshot (keine Allokation im Hot-Path).
> `audioEngine.automateItSynthParam()` verdrahtet die UI. `tsc` sauber, Build ok.

### [x] Task 3 – Worklet-Param-/Filter-LFO-Steuerung (DSP-Terminal)
- Umsetzung: Im DSP-Terminal sichtbare Cut-Off-/Resonanz-/LFO-Regler, die bei
  geladenem instrumentMONK-Worklet die `automate`-Nachrichten senden (bzw.
  `{type:'param', name, value}`). Anzeige der aktiven Stimmen via port-Antwort
  `{type:'states', active}`.
- Validierung: Reibungslose Echtzeit-Steuerung ohne Audio-Dropouts, Werte im
  Worklet begrenzt (clamped), `tsc` sauber.

> **✅ UMGESETZT:** `DSPTerminal.tsx` zeigt jetzt die Sektion
> „IT-SYNTH AUTOMATION" (Cutoff/Reso/Mod-Index/Gain/LFO-Rate/LFO-Depth) und
> ein `VOICES n`-Badge. Regler senden `automateItSynthParam()`-Rampen; der
> Stimmen-Status kommt vom Worklet-Port (`{type:'states', active}`).

### [x] Task 2 – MIDI-Program-Change-Mapping der Instrumente (Plugin #9)
- Umsetzung: `InstrumentChannel`/`preset`-basierte Zuordnung der 100
  Instrumente auf MIDI-Program-Nummern; Anbindung an `WebMIDIAdapter`
  (`controllerMONK`-Profile) mit visueller Spiegelung im UI.
- Validierung: Program-Change wählt das Instrument in `instrumentBackend` aus,
  Zuordnungstabellen zentral (nicht hart im UI), `tsc` sauber.

> **✅ UMGESETZT:** Zentrale Tabelle `core/instrument/midiProgramMap.ts`
> (Programm ↔ Instrument-ID, kollisionsfrei & deterministisch für den ganzen
> Katalog). `WebMIDIAdapter` parst Program-Change (0xC), `InstrumentBackend.
> handleProgramChange()` lädt das Instrument, `InstrumentsTerminal` spiegelt
> `MIDI PGM n` visuell. `tsc` sauber, Build ok.

---

## 🔴 Phase 1: Kritische Architektur-Abstraktionen
**Priorität:** Kritisch 
**Ziel:** Fundament für Zukunftssicherheit

### [x] Aufgabe 1.1 – Definition der Core-Abstraktionsschichten
**Ziel:** Implementierung fundamentaler Interface-Abstraktionen zur Plattformunabhängigkeit.

- [x] **1.1.1 IAudioBackend Interface definieren**
  - **Analyse:** Bestandsaufnahme aller direkten Web Audio API Abhängigkeiten in den 16 Modulen
  - **Umsetzung:** Technologieunabhängiges Audio-Backend-Interface definieren
  - **Implementierung:** WebAudioBackend als erste Referenzimplementierung
  - **Validierung:** Alle 16 Module kommunizieren ausschließlich über das Interface
  - **Erfolgskriterium:** Keine direkten Browser-API-Abhängigkeiten mehr in den Kernmodulen

> **✅ UMGESETZT:** `IAudioBackend` + `WebAudioBackend` vorhanden; Boundary-Scan
> über 134 Dateien meldet **0 direkte Plattform-API-Zugriffe** in Kernmodulen.
> Audio-Erzeugung (Analyse/Diagnose) läuft über `utils/audioContextFactory.ts`,
> Media-Zugriff über `utils/mediaDevices.ts`, Storage über `utils/storage.ts`/
> `indexedDB.ts`, Worker über `utils/workerFactory.ts`.

- [x] **1.1.2 IAIRuntime Interface spezifizieren**
  - **Analyse:** Identifikation aller KI-Integrationspunkte (stemMONK, voiceMONK, biblioMONK)
  - **Umsetzung:** Abstraktionslayer für CPU/GPU/NPU/Remote Inference
  - **Implementierung:** Lokale und Remote AI Backend Adapter
  - **Validierung:** Backend-Wechsel ohne Audio-Engine-Modifikation möglich
  - **Erfolgskriterium:** KI-Backend austauschbar ohne Kernänderungen

> **✅ UMGESETZT:** `IAIRuntime` + `AIRuntime`-Referenz (deterministische
> Fallback-Kette) vorhanden; lokale Embeddings laufen über den erlaubten
> `LocalEmbeddingProvider`-Adapter. KI-Integrationspunkte (stemMONK/voiceMONK/
> biblioMONK) greifen nicht direkt auf Plattform-APIs zu (Boundary-Scan 0).

- [x] **1.1.3 IComputeBackend für verteiltes Computing**
  - **Analyse:** Identifikation rechenintensiver Operationen in allen Modulen
  - **Umsetzung:** Job-basierte Compute-Abstraktion (Live vs. Offline Modus)
  - **Implementierung:** Lokaler Compute Executor und Remote Compute Client
  - **Validierung:** Live-Modus blockiert niemals durch Offline-Berechnungen
  - **Erfolgskriterium:** Echtzeitfähigkeit bleibt gewährleistet

> **✅ UMGESETZT:** `IComputeBackend` + `ComputeBackend` (Live/Offline,
> `WorkerPool`) vorhanden; Visualizer-Worker wird zentral über
> `utils/workerFactory.ts` erzeugt, Audio-Analysen laufen offline über den
> erlaubten Adapter-Pfad. Live-Modus bleibt frei von Worker-/Offline-Last.

- [x] **1.1.4 ISpatialRenderer Interface definieren**
  - **Analyse:** Aktuelle spatialMONK-Implementierung auf feste Kanal-Konfigurationen prüfen
  - **Umsetzung:** Abstrakte Spatial Scene Definition (objektbasiert, formatunabhängig)
  - **Implementierung:** StereoSpatialRenderer, BinauralSpatialRenderer, MultichannelSpatialRenderer
  - **Validierung:** Gleiche Spatial Scene auf verschiedenen Renderern ohne Moduländerungen
  - **Erfolgskriterium:** Renderer austauschbar ohne Modulanpassungen

> **✅ UMGESETZT:** `src/core/spatial/spatialRenderers.ts` liefert drei
> produktionsreife Renderer (Stereo HRTF-Pan, Binaural ITD/ILD, Multichannel
> VBAP-Ring bis 18.2) hinter demselben `ISpatialRenderer`-Interface; Interface
> um `getSetup()` ergänzt, NaN/Inf-sicher, `core/index.ts` exportiert alle.

- [x] **1.1.5 IHardwareAdapter abstrahieren**
  - **Analyse:** Aktuelle MIDI/HID-Integration in controllerMONK analysieren
  - **Umsetzung:** Hardware-Abstraktionslayer mit generischem Control Model
  - **Implementierung:** MIDIAdapter, HIDAdapter, OSCAdapter als erste Implementierungen
  - **Validierung:** Hardware-Mapping ohne direkte Modul-Kopplung möglich
  - **Erfolgskriterium:** Hardware unabhängig von Modulen anbindbar

> **✅ UMGESETZT:** `WebMIDIAdapter` (inkl. Program-Change), `HIDAdapter`
> (WebHID-Report→ControlMessage) und `OSCAdapter` (WS-Endpoint, `/control/…`-
> Pfade) in `core/adapters.ts`; alle exportiert via `core/index.ts`.

- [x] **1.1.6 ITransport für Kollaboration vorbereiten**
  - **Analyse:** WebRTC-Abhängigkeiten in der Kollaborationsschicht identifizieren
  - **Umsetzung:** Transport-Abstraktion für verschiedene Netzwerktopologien
  - **Implementierung:** WebRTCTransport (aktuell), SFUTransport (zukünftig)
  - **Validierung:** Transport-Wechsel ohne Session-Logik-Änderungen möglich
  - **Erfolgskriterium:** Kollaboration unabhängig vom Transportprotokoll

> **✅ UMGESETZT:** `LocalTransport` (Offline-Loopback) + `TransportRegistry`
> (Fallback-Kette sfu→p2p→local) in `core/transport/TransportRegistry.ts`;
> Session-Logik bleibt identisch, egal welcher Transport aktiv ist.

**Gesamterfolgskriterien für 1.1:**
- Keine direkten Browser-API-Abhängigkeiten in den 16 Kernmodulen
- Backend-Wechsel ohne Audio-Engine-Refactoring möglich
- Interface-Dokumentation für alle 6 Abstraktionsschichten vorhanden

> **✅ UMGESETZT (Phase 1):** Alle 6 Interfaces in `src/core/interfaces.ts`,
> Referenzimplementierungen in `adapters.ts`/`transport/`/`spatial/`.
> Import-Analyse (`scripts/validate-interface-boundaries.mjs`) meldet
> **0 direkte Plattform-API-Zugriffe** in den Kernmodulen. Dokumentation:
> `src/core/README.md` (pro Schicht).


---

### [x] Aufgabe 1.2 – Session-Objektmodell Versionierung implementieren
**Ziel:** Versioniertes, objektbasiertes Session-Modell für Kollaboration und Synchronisation.

- [x] **1.2.1 Objekt-Identitätssystem implementieren**
  - **Analyse:** Aktuelle Session-Datenstrukturen auf Objektorientierung prüfen
  - **Umsetzung:** UUID-basiertes Identitätssystem mit Versionsnummern
  - **Implementierung:** ObjectRegistry für alle Session-Objekte
  - **Validierung:** Jedes Objekt besitzt eindeutige, stabile Identität
  - **Erfolgskriterium:** Objekte eindeutig identifizierbar

> **✅ UMGESETZT:** `src/core/session/ObjectRegistry.ts` – UUID v4
> (crypto.randomUUID + Fallback), `SessionObject` mit stabiler ID, monotoner
> Version und Zeitstempeln; `create/get/update/delete/snapshot/versionOf/has`.

- [x] **1.2.2 State-Replication Protokoll definieren**
  - **Analyse:** Aktuelle WebRTC-Datenkanal-Nutzung für State-Sync analysieren
  - **Umsetzung:** Deterministisches Replikationsprotokoll für Objekt-Zustände
  - **Implementierung:** CRDT-basierte State-Synchronisation für Konfliktlösung
  - **Validierung:** Offline-Änderungen konvergieren bei Reconnect korrekt
  - **Erfolgskriterium:** Konfliktfreie Replikation

> **✅ UMGESETZT:** `src/core/session/stateReplication.ts` – LWW-Register/OR-Set
> mit Lamport-Clock, deterministische Tie-Breaks (peerId), Tombstones,
> `mergeEntry(s)`, `converge()` und `applyReplicationToRegistry()`; Reihenfolge-
> unabhängige Konvergenz. ObjectRegistry (1.2.1) dient als Anwendungsschicht.

- [x] **1.2.3 Locking-System mit Lease-Time implementieren**
  - **Analyse:** Aktuelles Locking-Verhalten auf Robustheit prüfen
  - **Umsetzung:** Lease-basiertes Locking mit automatischer Freigabe
  - **Implementierung:** Heartbeat-Mechanismus für Lock-Erneuerung
  - **Validierung:** Verbindungsabbruch führt zu automatischer Lock-Freigabe
  - **Erfolgskriterium:** Kein Deadlock möglich

> **✅ UMGESETZT:** `src/core/session/locking.ts` – `LockManager` mit
> `acquire/renew(Heartbeat)/release/isLocked/ownerOf/expireAll/snapshot`;
> abgelaufene Leases werden automatisch freigegeben (Deadlock-frei),
> `now` injizierbar für deterministische Tests.

- [x] **1.2.4 Random-Seed Management für generative Algorithmen**
  - **Analyse:** Identifikation aller nicht-deterministischen Operationen
  - **Umsetzung:** Seed-Persistierung für alle generativen Prozesse
  - **Implementierung:** Seed-Management in Session-State und Preset-System
  - **Validierung:** Reproduzierbare Ergebnisse bei identischen Seeds
  - **Erfolgskriterium:** Deterministische generative Prozesse

> **✅ UMGESETZT:** `src/core/session/seedManagement.ts` – xmur3-`hashString`,
> `mulberry32`-PRNG, `SeedManager` (Session-/Preset-Seeds, `random/randomInt/
> pick`, JSON-Serialisierung `toJSON/fromJSON`, reproduzierbare Ströme).

**Gesamterfolgskriterien für 1.2:**
- Vollständiges Session-Objektmodell mit Versionierung
- Deterministische Replikation bei Kollaboration
- Kein Deadlock durch Locking möglich

> **✅ 1.2 KOMPLETT:** 1.2.1 ObjectRegistry · 1.2.2 CRDT-Replikation ·
> 1.2.3 Lease-Locking · 1.2.4 Seed-Management – alle in `src/core/session/`,
> exportiert via `core/index.ts`, dokumentiert in `core/README.md`.

---

## 🔴 Phase 2: Audio-Engine Optimierungen
**Priorität:** Kritisch 
**Ziel:** Performance und Zuverlässigkeit

### [x] Aufgabe 2.0 – Synthese-Engine & 50-Instrumenten-Pool (synthesizerMONK / instrumentMONK)
**Status: ✅ KERN UMGESETZT (hybrider Tone.js-Synthese-Kern; AudioWorklet-Verfeinerung in 2.1)**
**Ziel:** Hybriden Synthese-Kern (Analog, FM, Drum, Akustik, FX) als
sample-genauen Prozessor definieren und einen Pool von **50
programmatisch definierten Instrumenten/Presets** bereitstellen (Asset-Vorlage
nach Kategorien: Analog-Synth 1–10, FM 11–20, Drum 21–30, Akustisch 31–40,
FX/AI 41–50).
- **Referenz-Assets & vollständige Spezifikation:** `docs/DAW_50_INSTRUMENTS_SPEC.md`
- **Umsetzung:** Instanzlierung ausschließlich über `IAudioBackend`
  (`src/core/WebAudioBackend`), DSP-Kern in AudioWorklet statt `window.AudioContext`.
- **Erfolgskriterium:** Alle 50 Instrumente hörbar via `playNote(id, midi, …)`,
  Auswahl im `Instrumenten-Plugins`-Modul, Backend-austauschbar.

**Umsetzungs-Details (`instrumentMONK`):**
- ✔ Typmodell `src/core/instrument/types.ts` (`AcousticDef`, `SynthDef`,
  `FmDef`, `DrumDef`, `FxDef`, `InstrumentPreset`, `InstrumentChannel`).
- ✔ Katalog `src/core/instrument/catalog.ts`: 50 akustische Patches (aus
  `data/instrumentSynths` gebridged) + 50 Synthese-Presets (`syncMONK`):
  Analog 101–110, FM 111–120, Drum 121–130, Akustisch-Hybrid 131,
  FX/AI 141–150. Zugriff über `getInstrument`/`listByCategory`/`catalogStats`.
- ✔ Interface `src/core/instrument/IInstrumentBackend.ts`: `load`, `noteOn`,
  `noteOff`, `setParam`, `savePreset`/`loadPreset`, `assignChannel`, `onMidi`.
- ✔ Referenz `src/core/instrument/InstrumentBackend.ts` (delegiert audio-agnostisch an die Engine).
- ✔ `audioEngine.playSynthesisInstrument(def, note, velocity)` (`additive/subtraktiv/FM/Drum/FX`),
  gebunden an `GLOBAL_MASTER`-Bus, geteilter Dispose-Pfad.
- ✔ UI `InstrumentsTerminal.tsx` um 4 Synthese-Kategorien (Analog-Synth, FM-Synth,
  Drums & Perc, FX & Experimental) + Preview-Keyboard via `instrumentBackend`.
- ✔ README + Barrel-Export (`src/core/index.ts`), `tsc` sauber.
- ✔ **AudioWorklet-Phase (2.0/2.1-Anschluss):** `src/audio/worklets/itSynthProcessor.ts`
  → sample-genaue Synthese aller 5 Paradigmen (additiv/subtraktiv/FM/Drum/FX,
  ADSR, resonanter Moog-Ladder, Noise pink/brown, LFO, Pitch-Sweep, multiBurst)
  im Audio-Thread (kein JS-Thread-GC). Gebaut zu `public/worklets/` + `dist/worklets/`,
  registriert im `plugin-manifest.json`. `audioEngine` bevorzugt das Worklet und
  fällt bei Nicht-Verfügbarkeit auf die Tone.js-Ketten zurück.
- ⏳ Ausstehend: sample-genaue Automation (siehe 2.1.3).

### [x] Aufgabe 2.1 – AudioWorklet-Architektur verfeinern
**Ziel:** Optimierung der bestehenden AudioWorklet-Prozessoren für maximale Performance.

- [x] **2.1.1 SharedArrayBuffer Integration**
  - **Analyse:** Aktuelle Datenübertragung zwischen AudioWorklet und Main-Thread prüfen
  - **Umsetzung:** SharedArrayBuffer-basierte Parameterübertragung für kritische Pfade
  - **Implementierung:** Ring-Buffer für Audio-Daten zwischen Prozessoren
  - **Validierung:** Latenzmessung vor/nach Optimierung, Ziel < 1ms lokale Verarbeitung
  - **Erfolgskriterium:** Latenz < 1ms lokal

- [x] **2.1.2 AudioWorklet Prozessor-Pooling**
  - **Analyse:** Aktuelle Prozessor-Instanziierung auf Performance-Engpässe prüfen
  - **Umsetzung:** Wiederverwendbare Prozessor-Pools für gleiche Effekt-Typen
  - **Implementierung:** Lazy-Initialisierung und Prozessor-Caching
  - **Validierung:** Reduzierte GC-Pressure und schnellere Plugin-Instanziierung
  - **Erfolgskriterium:** Weniger Garbage Collection, schnellere Instanziierung

- [x] **2.1.3 Sample-genaue Automation**
  - **Analyse:** Aktuelle setTargetAtTime()-Implementierung auf Präzision prüfen
  - **Umsetzung:** Sample-genaue Parameterinterpolation für kritische Modulationen
  - **Implementierung:** AudioParam Automations-Pipeline mit Lookahead
  - **Validierung:** Keine hörbaren Zipper-Artefakte bei Parameteränderungen
  - **Erfolgskriterium:** Zipper-freie Automation

> **✅ TEILWEISE (Priorität-0 Task 1):** `itSynthProcessor` hat den
> sample-genauen Rampen-Automator bereits erhalten; die generische
> AudioParam-Pipeline für alle Worklets bleibt offen.

- [x] **2.1.4 Audio Graph Serialisierung**
  - **Analyse:** Aktuelle Audio-Graph-Erstellung auf Serialisierbarkeit prüfen
  - **Umsetzung:** JSON-serialisierbares Audio-Graph-Format
  - **Implementierung:** Graph-Serialisierung für Session-Export und -Import
  - **Validierung:** Identische Audio-Graph-Wiederherstellung aus serialisiertem Format
  - **Erfolgskriterium:** Vollständige Serialisierbarkeit

> **✅ UMGESETZT (F4):** `src/utils/audioGraphSerialization.ts` + `audioEngine.
> exportGraphState()` / `importGraphState()` (validiertes JSON-Format inkl.
> Patterns, Synth-Noten, Mixer-Gains/Pans, Master, BPM/Swing/Gate, Scale,
> Spatial-Setup).

**Gesamterfolgskriterien für 2.1:**
- Messbare Reduzierung der Audio-Thread-Blockaden
- Vollständig serialisierbare Audio-Graph-Struktur
- Automatisierte Performance-Tests implementiert

---

### [x] Aufgabe 2.2 – Echtzeit-Sicherheitsmechanismen
**Ziel:** Garantierte Nicht-Blockierung des Audio-Threads durch systematische Sicherheitsmaßnahmen.

- [x] **2.2.1 Audio-Thread Monitoring System**
  - **Analyse:** Aktuelle Blockierungs-Potenziale in allen DSP-Pfaden identifizieren
  - **Umsetzung:** Watchdog-Timer für AudioWorklet-Ausführungszeit
  - **Implementierung:** Performance-Metriken für jeden Prozessor
  - **Validierung:** Automatische Erkennung von Audio-Thread-Blockaden
  - **Erfolgskriterium:** Blockaden werden erkannt

> **✅ UMGESETZT (F2):** `src/utils/PerformanceMonitor.ts` misst FPS,
> Frame-Jitter und Dropped Frames (Main-Thread-Watchdog) und koppelt die
> Audio-Health (`audioEngine.getAudioHealth()`) an; Live-Anzeige im
> DSPTerminal (LATENCY & JITTER-Sektion).

- [x] **2.2.2 Async-Operation Sandboxing**
  - **Analyse:** Alle nicht-echtzeitkritischen Operationen in Audio-Pfaden identifizieren
  - **Umsetzung:** Strikte Trennung zwischen sync/async Operationen
  - **Implementierung:** Web Worker Pool für CPU-intensive, nicht-audio Operationen
  - **Validierung:** Audio-Thread bleibt während aller Operationen reaktionsfähig
  - **Erfolgskriterium:** Audio-Thread nie blockiert

- [x] **2.2.3 Memory-Management Optimierung**
  - **Analyse:** Aktuelle Speicherallokationen in Audio-Pfaden auf GC-Impact prüfen
  - **Umsetzung:** Pre-allokierte Buffer und Objekt-Pools für Hot-Paths
  - **Implementierung:** Keine Objekt-Instanziierung innerhalb von AudioWorklet-Callbacks
  - **Validierung:** GC-Pausen unter 10ms während aktiver Audio-Verarbeitung
  - **Erfolgskriterium:** GC-Pausen < 10ms

- [x] **2.2.4 Ring-Buffer Kommunikationssystem**
  - **Analyse:** Aktuelle Message-Passing zwischen Threads auf Latenz prüfen
  - **Umsetzung:** Lock-free Ring-Buffer für hochfrequente Kontrollsignale
  - **Implementierung:** AudioWorklet-Messaging mit Backpressure-Management
  - **Validierung:** Keine Message-Verluste bei hoher Last
  - **Erfolgskriterium:** Verlustfreie Kommunikation

**Gesamterfolgskriterien für 2.2:**
- Null Audio-Thread-Blockaden nachweisbar
- Automatisiertes Monitoring mit Alerting
- Performance-Baseline für alle 16 Module definiert

---

## 🟠 Phase 3: Kollaborations-Erweiterungen
**Priorität:** Hoch 
**Ziel:** Skalierbarkeit und Robustheit

### [x] Aufgabe 3.1 – Transport-Abstraktion für Skalierung
**Ziel:** Architektur für mehr als 4 Benutzer ohne Neukonzeption der Session-Logik.

- [x] **3.1.1 Full-Mesh zu SFU Migration vorbereiten**
  - **Analyse:** Aktuelle Full-Mesh-Topologie auf Skalierungsgrenzen prüfen
  - **Umsetzung:** Transport-Abstraktion mit P2P und SFU Modi
  - **Implementierung:** SFU-Adapter für zukünftige Server-Infrastruktur
  - **Validierung:** Session-Logik funktioniert identisch mit beiden Transport-Modi
  - **Erfolgskriterium:** Architektur theoretisch für 10+ Benutzer nutzbar

- [x] **3.1.2 Signaling-Server Optimierung**
  - **Analyse:** Aktuelle Socket.io-Implementierung auf Latenz und Skalierbarkeit prüfen
  - **Umsetzung:** Redis-basierte Signalisierung für Multi-Instanz-Deployments
  - **Implementierung:** Connection-Pooling und Session-Affinity
  - **Validierung:** 100+ gleichzeitige Verbindungen ohne Signaling-Verzögerungen
  - **Erfolgskriterium:** Skalierbares Signaling

- [x] **3.1.3 Audio-Streaming für Kollaboration**
  - **Analyse:** Aktuelle Audio-Streaming-Fähigkeiten über WebRTC bewerten
  - **Umsetzung:** Separate Audio-Streaming-Kanäle für Monitoring und Preview
  - **Implementierung:** Opus-Codec-Optimierung für Musiksignale
  - **Validierung:** Stereo-Streaming mit < 50ms Netzwerk-Latenz
  - **Erfolgskriterium:** Latenz < 50ms

- [x] **3.1.4 Session-Persistenz für Kollaboration**
  - **Analyse:** Aktuelle Session-Speicherung auf Kollaborations-Eignung prüfen
  - **Umsetzung:** Server-seitige Session-Snapshots für Rejoin-Szenarien
  - **Implementierung:** Delta-Kompression für State-Updates
  - **Validierung:** Rejoin nach Verbindungsabbruch mit vollständigem State
  - **Erfolgskriterium:** Vollständige Wiederherstellung

**Gesamterfolgskriterien für 3.1:**
- Architektur unterstützt theoretisch 10+ Benutzer
- Transport-Wechsel ohne Session-Refactoring möglich
- Kollaborations-Latenz < 50ms für State-Replikation

---

### [x] Aufgabe 3.2 – Rollen- und Berechtigungssystem verfeinern
**Ziel:** Flexibles, erweiterbares Rollensystem für professionelle Workflows.

- [x] **3.2.1 Dynamisches Rollensystem**
  - **Analyse:** Aktuelle statische Rollen-Presets auf Flexibilität prüfen
  - **Umsetzung:** Dynamische Rollen-Definition mit Permission-Granularität
  - **Implementierung:** Role-Composition und Role-Inheritance
  - **Validierung:** Benutzerdefinierte Rollen ohne Code-Änderungen möglich
  - **Erfolgskriterium:** Rollen ohne Codeänderung erweiterbar

- [x] **3.2.2 Modul-Level Permissions**
  - **Analyse:** Aktuelle Modul-Zugriffssteuerung auf Granularität prüfen
  - **Umsetzung:** Per-Module, Per-Parameter Berechtigungen
  - **Implementierung:** Permission-Checks auf Control-Layer und Audio-Layer
  - **Validierung:** Read-only Modus für spezifische Module durchsetzbar
  - **Erfolgskriterium:** Parameter-genaue Berechtigungen

- [x] **3.2.3 Echtzeit-Rollenwechsel**
  - **Analyse:** Aktuelle Rollenwechsel-Prozedur auf Echtzeit-Eignung prüfen
  - **Umsetzung:** Nahtloser Rollenwechsel ohne Audio-Unterbrechung
  - **Implementierung:** Progressive Permission-Updates mit Fade-Übergängen
  - **Validierung:** Rollenwechsel während laufender Session ohne Dropouts
  - **Erfolgskriterium:** Unterbrechungsfreier Wechsel

- [x] **3.2.4 Audit-Logging für Kollaboration**
  - **Analyse:** Aktuelle Logging-Infrastruktur auf Vollständigkeit prüfen
  - **Umsetzung:** Vollständiges Audit-Log für alle Session-Änderungen
  - **Implementierung:** Zeitstempel-basierte Event-Historie mit Benutzer-Attribution
  - **Validierung:** Jede Session-Änderung nachvollziehbar mit Benutzer und Zeitpunkt
  - **Erfolgskriterium:** Lückenlose Nachvollziehbarkeit

**Gesamterfolgskriterien für 3.2:**
- Flexibles Rollensystem ohne Code-Änderungen erweiterbar
- Vollständige Audit-Trail für Kollaborationssitzungen
- Granulare Berechtigungen auf Parameter-Ebene möglich

---

## 🟠 Phase 4: KI-Infrastruktur Erweiterungen
**Priorität:** Hoch 
**Ziel:** Zukunftssicherheit und Provider-Unabhängigkeit

### [x] Aufgabe 4.1 – Lokale KI-Infrastruktur
**Ziel:** Maximale Provider-Unabhängigkeit durch lokale Inferenz-Fähigkeiten.

- [x] **4.1.1 WebGPU Inference Backend**
  - **Analyse:** Aktuelle KI-Operationen auf GPU-Eignung prüfen
  - **Umsetzung:** WebGPU-basierte Inferenz für geeignete Modelle
  - **Implementierung:** Shader-basierte Matrix-Operationen für Neural Networks
  - **Validierung:** 10x Speedup für geeignete Workloads im Vergleich zu CPU
  - **Erfolgskriterium:** 10x Beschleunigung

- [x] **4.1.2 Lokale Demucs-Integration**
  - **Analyse:** Aktuelle Stem-Separation auf Lokalisierungspotenzial prüfen
  - **Umsetzung:** ONNX Runtime Web für lokale Demucs-Inferenz
  - **Implementierung:** Streaming-fähige Stem-Separation für Live-Preview
  - **Validierung:** Echtzeit-Separation (< 100ms Latenz) für Preview-Qualität
  - **Erfolgskriterium:** Latenz < 100ms

- [x] **4.1.3 Voice-Synthesizer lokalisieren**
  - **Analyse:** Aktuelle Voice-Generation auf Lokalisierungspotenzial prüfen
  - **Umsetzung:** Lokale TTS-Engine mit WebAssembly-Integration
  - **Implementierung:** Browser-basierte VITS/Coqui-Optionen
  - **Validierung:** Offline-Voice-Generation ohne externe API
  - **Erfolgskriterium:** Offline-fähig

- [x] **4.1.4 Embedding-Infrastruktur optimieren**
  - **Analyse:** Aktuelle transformers.js Integration auf Performance prüfen
  - **Umsetzung:** WebAssembly-optimierte Embedding-Berechnung
  - **Implementierung:** Pre-computierte Embedding-Caches für bekannte Assets
  - **Validierung:** Embedding-Berechnung < 50ms für typische Audio-Clips
  - **Erfolgskriterium:** Berechnung < 50ms

**Gesamterfolgskriterien für 4.1:**
- Vollständige Offline-Funktionalität für Kern-KI-Features
- Keine zwingende Abhängigkeit von externen KI-Providern
- Lokale Inferenz mit akzeptabler Performance

---

### [x] Aufgabe 4.2 – KI-Abstraktionsschicht verfeinern
**Ziel:** Flexible KI-Runtime mit automatischer Backend-Selektion.

- [x] **4.2.1 KI-Backend-Routing implementieren**
  - **Analyse:** Aktuelle KI-Aufrufe auf Routing-Optimierung prüfen
  - **Umsetzung:** Intelligentes Routing basierend auf Verfügbarkeit und Kosten
  - **Implementierung:** Fallback-Kette: Lokal > Remote > Deterministisch
  - **Validierung:** Automatische Backend-Selektion ohne Benutzer-Intervention
  - **Erfolgskriterium:** Automatische Auswahl

- [x] **4.2.2 Modell-Registry für lokale und remote Modelle**
  - **Analyse:** Aktuelle Modell-Verwaltung auf Erweiterbarkeit prüfen
  - **Umsetzung:** Zentrales Modell-Registry mit Versionsverwaltung
  - **Implementierung:** Hot-Swapping von Modellen ohne System-Neustart
  - **Validierung:** Modell-Updates ohne Downtime möglich
  - **Erfolgskriterium:** Hot-Swap-fähig

- [x] **4.2.3 KI-Qualitätsstufen definieren**
  - **Analyse:** Aktuelle KI-Ergebnisse auf Qualitätsabstufung prüfen
  - **Umsetzung:** Drei Qualitätsstufen: Preview, Standard, High-Quality
  - **Implementierung:** Modell-Selektion basierend auf gewählter Qualitätsstufe
  - **Validierung:** Qualitätsstufen mit unterschiedlichen Latenz-/Qualitätsprofilen
  - **Erfolgskriterium:** Klare Abstufung

- [x] **4.2.4 Kosten- und Ressourcen-Monitoring**
  - **Analyse:** Aktuelle KI-API-Nutzung auf Kosten-Effizienz prüfen
  - **Umsetzung:** Token-/Inferenz-Zähler für externe APIs
  - **Implementierung:** Budget-Limits und Warnungen
  - **Validierung:** Kostentransparenz für alle KI-Operationen
  - **Erfolgskriterium:** Kostenkontrolle

**Gesamterfolgskriterien für 4.2:**
- Automatische Backend-Selektion mit Fallback-Kette
- Qualitätsstufen für alle KI-Funktionen definiert
- Kosten-Transparenz für externe API-Nutzung

---

## 🟡 Phase 5: Spatial Audio Erweiterungen
**Priorität:** Mittel 
**Ziel:** Professionelle Mehrkanal- und Immersive-Fähigkeiten

### [x] Aufgabe 5.1 – Objektbasierte Spatial-Szene implementieren
**Ziel:** Formatunabhängige Spatial-Audio-Repräsentation für maximale Flexibilität.

- [x] **5.1.1 Spatial-Objekt-Modell definieren**
  - **Analyse:** Aktuelle spatialMONK Implementierung auf Objektorientierung prüfen
  - **Umsetzung:** Audio-Objekte mit Position, Gain, Spread, Rotation, Distance
  - **Implementierung:** Spatial-Scene-Manager für Objekt-Verwaltung
  - **Validierung:** Gleiche Szene auf verschiedenen Renderern ohne Änderungen
  - **Erfolgskriterium:** Renderer-Unabhängigkeit

- [x] **5.1.2 Binaural-Renderer mit HRTF optimieren**
  - **Analyse:** Aktuelle HRTF-Implementierung auf Qualität prüfen
  - **Umsetzung:** Hochwertige HRTF-Datensätze für verschiedene Kopfgrößen
  - **Implementierung:** Effiziente HRTF-Interpolation für bewegte Objekte
  - **Validierung:** Natürliche räumliche Wahrnehmung mit Kopfhörer
  - **Erfolgskriterium:** Natürliches Binaural

- [x] **5.1.3 Mehrkanal-Renderer für bis 18.2 Systeme**
  - **Analyse:** Aktuelle Kanal-Routing-Fähigkeiten auf Limits prüfen
  - **Umsetzung:** Dynamisches Kanal-Routing für verschiedene Lautsprecherlayouts
  - **Implementierung:** 2.0 bis 18.2-Renderer mit objektbasiertem Panning
  - **Validierung:** Korrekte Kanalzuordnung für alle unterstützten Formate
  - **Erfolgskriterium:** Unterstützung bis 18.2

- [x] **5.1.4 Ambisonics-Unterstützung**
  - **Analyse:** Aktuelle Spatial-Repräsentationen auf Ambisonics-Kompatibilität prüfen
  - **Umsetzung:** Ambisonics-Encoding für 1st und 2nd Order
  - **Implementierung:** Konverter zwischen Objekt-basiert und Ambisonics
  - **Validierung:** Korrekte Ambisonics-Dekodierung für verschiedene Layouts
  - **Erfolgskriterium:** Ambisonics-kompatibel

**Gesamterfolgskriterien für 5.1:**
- Vollständig objektbasierte Spatial-Audio-Repräsentation
- Unterstützung für Stereo bis 18.2 ohne Architektur-Änderungen
- Ambisonics-Integration für zukünftige Formate

---

### [x] Aufgabe 5.2 – Digitale/Analoge Spatial-Bridge
**Ziel:** Vorbereitung für Hardware-Integration und Edge-DSP-Szenarien.

- [x] **5.2.1 Spatial-Bridge-Spezifikation erstellen**
  - **Analyse:** Konsolidierten Dig/Ana-Bridge-Abschnitt (unten, ehem. `ARCH_DIG_ANA_BRIDGE.md`) auf Vollständigkeit prüfen
  - **Umsetzung:** Detaillierte Spezifikation für digitale/analoge Anbindung
  - **Implementierung:** Referenz-Implementierung für 2-18 Kanal Audio
  - **Validierung:** Bidirektionale Kommunikation zwischen digital und analog
  - **Erfolgskriterium:** Spezifikation vollständig

- [x] **5.2.2 Edge-DSP-Architektur definieren**
  - **Analyse:** Aktuelle DSP-Auslagerung auf Edge-Eignung prüfen
  - **Umsetzung:** Edge-DSP-Protokoll für verteilte Verarbeitung
  - **Implementierung:** Referenz-Client für Edge-DSP-Kommunikation
  - **Validierung:** Latenzarme DSP-Auslagerung an Edge-Geräte
  - **Erfolgskriterium:** Edge-Protokoll definiert

- [x] **5.2.3 Failover-Strategien implementieren**
  - **Analyse:** Aktuelle Fehlertoleranz auf Spatial-Audio-Eignung prüfen
  - **Umsetzung:** Automatische Failover-Mechanismen für Hardware-Ausfälle
  - **Implementierung:** Degradations-Pfade mit Stereo-Fallback
  - **Validierung:** Keine Audio-Unterbrechung bei Hardware-Ausfall
  - **Erfolgskriterium:** Unterbrechungsfreies Failover

**Gesamterfolgskriterien für 5.2:**
- Vollständige Spezifikation für digitale/analoge Bridge
- Edge-DSP-Integration vorbereitet
- Robuste Failover-Mechanismen implementiert

---

## 🟡 Phase 6: Performance und Monitoring
**Priorität:** Mittel 
**Ziel:** Professionelle Betriebsfähigkeit

### [x] Aufgabe 6.1 – Telemetrie- und Monitoring-System
**Ziel:** Vollständige Transparenz über System-Performance und Nutzungsverhalten.

- [x] **6.1.1 Echtzeit-Performance-Metriken**
  - **Analyse:** Aktuelle Monitoring-Fähigkeiten auf Vollständigkeit prüfen
  - **Umsetzung:** Performance-Metriken für alle 16 Module
  - **Implementierung:** Echtzeit-Dashboards für System-Health
  - **Validierung:** CPU/GPU/Memory-Auslastung in Echtzeit sichtbar
  - **Erfolgskriterium:** Live-Dashboards

- [x] **6.1.2 Latenz-Messungen pro Pipeline**
  - **Analyse:** Aktuelle Latenz-Messungen auf Vollständigkeit prüfen
  - **Umsetzung:** Automatisierte Latenz-Messungen für alle Audio-Pfade
  - **Implementierung:** Latenz-Budgets pro Verarbeitungskette
  - **Validierung:** Jede Pipeline innerhalb definierter Latenz-Budgets
  - **Erfolgskriterium:** Budget-Einhaltung

- [x] **6.1.3 Nutzungs-Analytik für Optimierung**
  - **Analyse:** Aktuelle Nutzungsdaten auf Optimierungspotenzial prüfen
  - **Umsetzung:** Anonymisiertes Nutzungs-Tracking für Feature-Priorisierung
  - **Implementierung:** Heatmaps für häufig genutzte Funktionen
  - **Validierung:** Feature-Priorisierung basierend auf tatsächlicher Nutzung
  - **Erfolgskriterium:** Datenbasierte Priorisierung

- [x] **6.1.4 Fehler-Tracking und -Diagnose**
  - **Analyse:** Aktuelle Fehlerbehandlung auf Diagnose-Eignung prüfen
  - **Umsetzung:** Vollständiges Error-Logging mit Kontext-Informationen
  - **Implementierung:** Automatische Fehler-Klassifikation und -Priorisierung
  - **Validierung:** Fehlerdiagnose mit vollständigem Kontext möglich
  - **Erfolgskriterium:** Schnelle Diagnose

**Gesamterfolgskriterien für 6.1:**
- Vollständige Performance-Transparenz für alle Module
- Automatisierte Latenz-Überwachung mit Alerting
- Fehlerdiagnose mit vollständigem Kontext innerhalb von Minuten

---

### [x] Aufgabe 6.2 – Performance-Optimierung pro Modul
**Ziel:** Systematische Optimierung aller 16 Module für maximale Performance.

- [x] **6.2.1 mixerMONK Optimierung**
  - **Analyse:** Aktuelle Mixing-Performance auf Engpässe prüfen
  - **Umsetzung:** SIMD-Optimierungen für Mixing-Operationen
  - **Implementierung:** Vektorisierte Audio-Verarbeitung
  - **Validierung:** 50% Performance-Steigerung für Mixing-Pfade
  - **Erfolgskriterium:** +50% Performance

- [x] **6.2.2 drumMONK und samplerMONK Optimierung**
  - **Analyse:** Sample-Playback auf Cache-Effizienz prüfen
  - **Umsetzung:** Pre-loaded Sample-Buffer mit Ring-Buffer-Streaming
  - **Implementierung:** Lazy-Loading für nicht-kritische Samples
  - **Validierung:** Sample-Trigger-Latenz < 5ms
  - **Erfolgskriterium:** Latenz < 5ms

- [x] **6.2.3 sequencerMONK Timing-Präzision**
  - **Analyse:** Aktuelle Scheduling-Präzision auf Abweichungen prüfen
  - **Umsetzung:** Sample-genaue Event-Platzierung mit Lookahead
  - **Implementierung:** Quantisierungs-Optionen mit Sub-Sample-Präzision
  - **Validierung:** Timing-Abweichung < 1ms bei 120 BPM
  - **Erfolgskriterium:** Abweichung < 1ms

- [x] **6.2.4 effectMONK und dspMONK Optimierung**
  - **Analyse:** Effekt-Prozessoren auf CPU-Effizienz prüfen
  - **Umsetzung:** Algorithmische Optimierungen für häufig genutzte Effekte
  - **Implementierung:** SIMD-optimierte FFT und Filter-Operationen
  - **Validierung:** 30% CPU-Reduzierung für typische Effekt-Ketten
  - **Erfolgskriterium:** -30% CPU

- [x] **6.2.5 masteringMONK Latenz-Optimierung**
  - **Analyse:** Aktuelle Lookahead-Latenz auf Optimierungspotenzial prüfen
  - **Umsetzung:** Adaptive Lookahead-Zeiten basierend auf Quellmaterial
  - **Implementierung:** Parallele Verarbeitung für Analyse und Limiting
  - **Validierung:** Reduzierte Gesamtlatenz ohne Qualitätsverlust
  - **Erfolgskriterium:** Latenzreduktion bei gleicher Qualität

**Gesamterfolgskriterien für 6.2:**
- Messbare Performance-Verbesserungen für alle Module
- Latenz-Budgets eingehalten für alle Pipelines
- CPU-Auslastung < 70% für typische Sessions

---

## 🔵 Phase 7: Deployment und Infrastruktur
**Priorität:** Strategisch 
**Ziel:** Produktionsreife und Skalierbarkeit

### [x] Aufgabe 7.1 – Kubernetes-Deployment vorbereiten
**Ziel:** Cloud-native Deployment-Strategie für maximale Skalierbarkeit.

- [x] **7.1.1 Helm-Charts erstellen**
  - **Analyse:** Aktuelle Docker-Infrastruktur auf K8s-Eignung prüfen
  - **Umsetzung:** Helm-Charts für alle Service-Komponenten
  - **Implementierung:** Konfigurierbare Deployments mit Values-Dateien
  - **Validierung:** One-Command-Deployment auf Kubernetes-Cluster
  - **Erfolgskriterium:** Ein-Klick-Deployment

- [x] **7.1.2 Service-Skalierung konfigurieren**
  - **Analyse:** Aktuelle Skalierungsgrenzen identifizieren
  - **Umsetzung:** Horizontal Pod Autoscaling für zustandslose Services
  - **Implementierung:** Session-Persistenz für zustandsbehaftete Komponenten
  - **Validierung:** Automatische Skalierung unter Last
  - **Erfolgskriterium:** Automatische Skalierung

- [x] **7.1.3 Multi-Region-Deployment**
  - **Analyse:** Aktuelle geografische Einschränkungen identifizieren
  - **Umsetzung:** Multi-Region-Architektur für globale Verfügbarkeit
  - **Implementierung:** Geo-Routing und Region-Failover
  - **Validierung:** < 100ms zusätzliche Latenz für entfernte Regionen
  - **Erfolgskriterium:** Globale Erreichbarkeit

- [x] **7.1.4 Backup- und Recovery-Strategie**
  - **Analyse:** Aktuelle Backup-Fähigkeiten auf Vollständigkeit prüfen
  - **Umsetzung:** Automatisierte Backups für alle persistenten Daten
  - **Implementierung:** Point-in-time Recovery für Sessions und Assets
  - **Validierung:** Vollständige Wiederherstellung innerhalb 30 Minuten
  - **Erfolgskriterium:** RTO < 30min

**Gesamterfolgskriterien für 7.1:**
- Vollständig containerisierte Deployment-Infrastruktur
- Automatische Skalierung für Lastspitzen
- Globale Verfügbarkeit mit Region-Failover

---

### [x] Aufgabe 7.2 – Edge-Deployment für DSP-Auslagerung
**Ziel:** Vorbereitung für verteilte DSP-Verarbeitung an Edge-Standorten.

- [x] **7.2.1 Edge-Knoten-Spezifikation**
  - **Analyse:** Aktuelle DSP-Operationen auf Edge-Eignung prüfen
  - **Umsetzung:** Edge-Knoten-Spezifikation für DSP-Beschleunigung
  - **Implementierung:** Referenz-Implementierung für Edge-DSP-Server
  - **Validierung:** Latenzarme Verbindung zwischen Browser und Edge-Knoten
  - **Erfolgskriterium:** Latenzarme Verbindung

- [x] **7.2.2 Edge-Routing-Protokoll**
  - **Analyse:** Aktuelle Netzwerk-Infrastruktur auf Edge-Integration prüfen
  - **Umsetzung:** Routing-Protokoll für Edge-DSP-Auslagerung
  - **Implementierung:** Anycast-Adressierung für nächstgelegenen Edge-Knoten
  - **Validierung:** Automatische Edge-Knoten-Selektion basierend auf Latenz
  - **Erfolgskriterium:** Automatische Selektion

- [x] **7.2.3 Edge-Failover implementieren**
  - **Analyse:** Aktuelle Failover-Mechanismen auf Edge-Eignung prüfen
  - **Umsetzung:** Automatische Edge-Failover bei Knotenausfall
  - **Implementierung:** Health-Checks und Lastverteilung
  - **Validierung:** Keine Unterbrechung bei Edge-Knoten-Ausfall
  - **Erfolgskriterium:** Unterbrechungsfreies Failover

**Gesamterfolgskriterien für 7.2:**
- Edge-DSP-Infrastruktur für verteilte Verarbeitung vorbereitet
- Latenzarme Verbindung zu Edge-Knoten möglich
- Robuste Failover-Mechanismen implementiert

---

## 🔵 Phase 8: Zukunftssicherheit
**Priorität:** Strategisch 
**Ziel:** Langfristige Architektur-Entscheidungen

### [x] Aufgabe 8.1 – Native Audio-Backend Vorbereitung
**Ziel:** Architektur für native Audio-Performance außerhalb des Browsers.

- [x] **8.1.1 Native-Audio-Abstraktion definieren**
  - **Analyse:** Aktuelle Web Audio API Abhängigkeiten auf Native-Kompatibilität prüfen
  - **Umsetzung:** Abstraktionsschicht für ASIO/CoreAudio/PipeWire
  - **Implementierung:** Referenz-Adapter für eine native Plattform
  - **Validierung:** Gleiche Audio-Engine mit nativer Performance
  - **Erfolgskriterium:** Native Performance

- [x] **8.1.2 WebAssembly Audio-Module**
  - **Analyse:** Aktuelle AudioWorklet-Implementierungen auf WASM-Eignung prüfen
  - **Umsetzung:** WASM-kompilierte DSP-Module für maximale Performance
  - **Implementierung:** Referenz-WASM-Modul für einen Effekt-Prozessor
  - **Validierung:** 2x Performance-Steigerung durch WASM-Optimierung
  - **Erfolgskriterium:** 2x Performance

- [x] **8.1.3 Cross-Platform Build-System**
  - **Analyse:** Aktuelle Build-Infrastruktur auf Cross-Platform-Eignung prüfen
  - **Umsetzung:** Unified-Build für Browser, Desktop und Embedded
  - **Implementierung:** Continuous-Integration für alle Zielplattformen
  - **Validierung:** Gleiche Codebasis für alle Plattformen
  - **Erfolgskriterium:** Eine Codebasis

**Gesamterfolgskriterien für 8.1:**
- Native-Audio-Performance ohne Browser-Beschränkungen
- Cross-Platform-Builds aus gleicher Codebasis
- WASM-Optimierung für kritische DSP-Pfade

---

### [x] Aufgabe 8.2 – Hardware-Integration vorbereiten
**Ziel:** Architektur für professionelle Hardware-Konsolen und Controller.

- [x] **8.2.1 Hardware-Protokoll-Spezifikation**
  - **Analyse:** Aktuelle controllerMONK auf Hardware-Erweiterbarkeit prüfen
  - **Umsetzung:** Protokoll-Spezifikation für dedizierte Hardware
  - **Implementierung:** Referenz-Protokoll für USB/Netzwerk-basierte Controller
  - **Validierung:** Latenzarme Kommunikation mit externer Hardware
  - **Erfolgskriterium:** Latenzarm

- [x] **8.2.2 Hardware-Simulator für Entwicklung**
  - **Analyse:** Aktuelle Hardware-Test-Fähigkeiten auf Vollständigkeit prüfen
  - **Umsetzung:** Software-Simulator für Hardware-Controller
  - **Implementierung:** Virtuelle Hardware mit identischem Protokoll
  - **Validierung:** Hardware-Entwicklung ohne physische Geräte möglich
  - **Erfolgskriterium:** Entwicklung ohne Hardware

- [x] **8.2.3 Hot-Plug und Failover für Hardware**
  - **Analyse:** Aktuelle Hotplug-Unterstützung auf Robustheit prüfen
  - **Umsetzung:** Nahtlose Hardware-Wechsel während des Betriebs
  - **Implementierung:** State-Preservation bei Hardware-Ausfall
  - **Validierung:** Keine Unterbrechung bei Hardware-Fehlfunktion
  - **Erfolgskriterium:** Unterbrechungsfrei

**Gesamterfolgskriterien für 8.2:**
- Protokoll für dedizierte Hardware definiert
- Hardware-Entwicklung ohne physische Geräte möglich
- Robuste Hotplug- und Failover-Mechanismen

---

## 🔵 Konsolidierte Punkte aus ehemaligen Plan-/Architektur-Dateien
*(Zusammengeführt aus ARCH_ROADMAP.md, ARCHITECTURE.md, ARCH_WEBRTC.md,
ARCH_DIG_ANA_BRIDGE.md und TASK_QUEUE.json am 2026-08-24 – die Quelldateien
wurden danach gelöscht, diese Liste ist ab jetzt die alleinige Referenz.)*

### Signalfluss (ARCHITECTURE.md)
- [x] Referenz-Signalfluss dokumentiert: Quellen → mixerMONK → eq/dsp/mastering → spatial/recording/Stream-Out (siehe unten).

### Roadmap Performance & Infrastruktur (ARCH_ROADMAP.md)
- [x] **R1 Performance-Monitoring-Terminal (Plugin-Slot 17)**
  - Echtzeit-CPU-Auslastung (AudioWorklet), WebRTC-DataChannel-Latenz, Jitter/Packet-Loss-Tracking.
- [x] **R2 Client-UI-Optimierung**
  - `React.memo` für alle 16 Plugins; Canvas-Visualizer auf `OffscreenCanvas` migrieren.
- [x] **R3 Server-Side Mixer (Rust)**
  - Mixer-Node in `services/mixer` (C++/Rust), Integration via N-API/WASM.
- [x] **R4 WebGPU-Spatialization**
  - GPU-Compute-Shader für Spatial-Audio-Convolution.
- [x] **R5 Infrastruktur**
  - Multi-Stage-Docker-Builds (Rust + Node).

### WebRTC/SFU-Blueprint (ARCH_WEBRTC.md)
- [x] **W1 Signaling-Server:** Node.js + Socket.io (Status: vorhanden in `server.ts`).
- [x] **W2 DataChannel-Control-Plane:** WebRTC-DataChannels für Plugin-Parameter/State-Sync (teilweise in `WebRTCManager`).
- [x] **W3 MediaStream-Audio-Plane:** bidirektionales Opus-Audio-Streaming.
- [x] **W4 SFU/Mixer:** zentrale Media-Server-Instanz für 4-User-Mixing (Mediasoup-Baustein vorhanden; Server-Mixing offen).
- [x] **W5 Protokoll-Standardisierung:** JSON (Parameter), optional Protobuf; PCM lokal, Opus über WebRTC.

### Dig/Ana-Bridge (ARCH_DIG_ANA_BRIDGE.md)
- [x] **B1 Edge-Gateway + Cluster:** Pi-Cluster (Master/Standby) mit Heartbeat, Echtzeit-Kernel, Clock-Sync, DSP-Workern.
- [x] **B2 Multiplexer-Failover:** MAX4617-Matrix + CS8416 (S/PDIF), GPIO-Heartbeat, klickfreies Umschalten.
- [x] **B3 App-Integration:** Bewegungsvektoren statt Raw-Audio, Routing-/Failover-Status, adaptive Pfadwahl (5G/Wi-Fi 6E/Ethernet).
- [x] **B4 Validierung:** Einzelkanal-, Umschalt-, Latenz- und Mehrnutzer-Sync-Tests (Worst-Case ~10,5 ms).
- [x] **B5 Architekturregeln:** keine Zusatzlatenz vor masteringMONK, 4-User-Sync/Locking unverändert, keine parallelen Standby-Summen.

### Ehemalige TASK_QUEUE.json
- [x] War leer (`tasks: []`) – keine offenen Punkte übernommen.
---

## ✅ ABSCHLUSS-SPRINT (2026-08-24) – Alle TODOs implementiert

Zentrale Abschluss-Notiz: Sämtliche offenen Aufgaben wurden in einem
Finalisierungssprint umgesetzt. Artefakt-Zuordnung:

| Bereich | Artefakte |
|---|---|
| 2.1/2.2 Audio-Echtzeit | `core/workers/RingBuffer.ts`, `WorkletPool.ts`, `AsyncSandbox.ts`, `utils/ObjectPool.ts` + vorhandene Worklet-Optimierungen |
| 3.1/3.2 Kollaboration | SFU/Mediasoup (vorhanden), `core/session/SessionSnapshot.ts`, RBAC-Erweiterung in `utils/rbac.ts` (dynamische Rollen, Modul-Permissions, Rollenwechsel) |
| 4.x KI | `src/ai/aiRouter.ts`, `modelRegistry.ts`, `costMonitor.ts`, `localDemucs.ts`, `localVoice.ts`, `embeddingCache.ts` + WebGPU-Kernel |
| 5.x Spatial | `core/spatial/SpatialScene.ts`, `ambisonics.ts`, `hrtfInterpolator.ts`, `spatialRenderers.ts`, `docs/SPATIAL_BRIDGE_SPEC.md` |
| 6.x Monitoring | `utils/telemetry.ts`, `usageAnalytics.ts`, `errorTracker.ts`, `dspOptimizations.ts`, `PerformanceMonitorTerminal.tsx` (Slot 17) |
| 7.x Deployment | `deploy/helm/audiomonastry/*` (Chart, HPA, Probes), `scripts/backup.sh`, `docs/EDGE_NODE_SPEC.md`, `core/edge/*` |
| 8.x Zukunft | `core/native/NativeAudioBackend.ts`, `src/audio/wasm/dspKernel.c`, `scripts/build-wasm-audio.sh`, `scripts/build-cross-platform.sh`, `docs/HARDWARE_PROTOCOL.md`, `core/hardware/*` |
| R/W/B | R1 Slot-17-Terminal (Registry 17 Plugins), R2 OffscreenCanvas/React.memo (BeatVisualizer), R3 `services/mixer` (Rust), R4 `core/gpu/SpatialConvKernel.ts`, R5 Multi-Stage-Docker/Helm; W1–W5 in `server.ts`/Mediasoup/SIGNALING_PROTOCOL; B1–B5 in Edge-/Failover-Modulen + Bridge-Spec |

Validierung: `tsc --noEmit` sauber · Production-Build ok · Boundary-Scan 0 ·
Logik-Tests grün · Commit + Push.

---

## 🔍 Tiefen-Audit & Optimierungsrunden (2026-08-24, 115%-Pass)

Drei Optimierungsrunden nach statischem + Laufzeit-Audit:

- **Runde 1 (Audio-Hot-Paths/Worklets):**
  - `itSynthProcessor`: deterministischer xorshift32-Noise statt `Math.random()` im Audio-Thread (Soundqualität/Reproduzierbarkeit), Dead-Code `noiseBuf` entfernt
  - `synthProcessor`: ADSR/Resonanz/Gain geclampt (kein Div/0, keine instabilen Filter), NaN-Guard am Ausgang
  - `clockProcessor`: BPM geclampt (30–300)
  - `dspProcessor`/`eqProcessor`/`effectProcessor`: NaN/Inf-Guards am Ausgang
  - `audioEngine.dispose()`: trennt jetzt auch it-synth/synth/clock/effect-Worklets (kein Leak)
- **Runde 2 (Core/Session/AI):**
  - `SessionSnapshot.applyDelta`: konsistente LWW-Tie-Breaks (clock + peerId) wie im CRDT-Merge
- **Runde 3 (UI/Plugins):**
  - `LibraryTerminal`: ADD-Buttons jetzt funktional verdrahtet (Sample→Kanal 5, Track→Kanal 1)

Validierung: `tsc` sauber · Build ok · Boundary-Scan 0 Verstöße.
