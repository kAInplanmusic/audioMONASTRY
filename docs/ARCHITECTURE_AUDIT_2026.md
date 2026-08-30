# audioMONASTRY – State-of-the-Art Architecture, Standards & Engineering Audit

Stand: 2026-08-30 · Auditor-Perspektive: Senior Principal Architect / Real-Time-/Audio-/Browser-Plattform-Engineer
Umfang: komplettes Repo (`server.ts`, `src/`, `services/`, `scripts/`, `deploy/`)

> Ziel dieses Audits ist nicht Neuheit um der Neuheit willen, sondern:
> correctness → reliability → deterministic behavior → audio integrity → latency →
> performance → maintainability → interoperability → scalability → extensibility.

---

## 1. Architektur-Modell (aus dem Code verifiziert)

| Ebene | Implementierung |
|---|---|
| Frontend | React 19 + Vite, 17 Plugin-Terminals lazy (Code-Splitting), Tailwind, ModuleContainer/SafeModuleBoundary, PluginManager/ModuleState Contexts |
| Backend | `server.ts` (Express + Socket.io + optionale Mediasoup-SFU + REST/Proxys), Redis-Adapter optional, Rate-Limit, Trace-IDs, Metriken |
| Audio | Tone.js als V1-Produktivpfad + 10 AudioWorklets (`itSynth/synth/eq/dsp/mastering/effect/clock/lufs/analyzer/fallback`), V2-Graph-Pfad (`AudioGraph`, `GraphEngineAdapter`, `setPlaybackMode('v2')`) |
| DSP | AudioWorklets mit Preallocation, SAB/Atomics (LUFS/Analyzer), SPSC-RingBuffer, sample-genaue Rampen in `itSynthProcessor`, PDC für Mastering-Lookahead |
| Netz | Socket.io-Signaling (`/webrtc-signaling`), WebRTC Full-Mesh DataChannels + Mediasoup-SFU (optional), WebSocket-Fallback über Socket.io |
| Kollaboration | `ObjectRegistry` (UUID+Version), LWW-CRDT + Lamport-Clock, Lease-Locking (Heartbeat), `WebRTCManager` mit State-Coalescing (~60 Hz), 4-User-Session-Enforcement |
| Plugins | Registry (17 Slots) + Metamodul-Gruppen, Plugin-Kommando-Registry (KI/Voice), SafeModuleBoundary, Lazy-Import |
| Persistenz | IndexedDB (MoaHistory/Large-State), lokaler Storage, Supabase (Metadaten) + Cloudflare R2 (Audio-Blobs), Offline-Fallback |
| KI | `LlmRouter` (DeepSeek→HF→Mistral→Ollama→DeepSeek Pro→Notfall), `MoaAgent` (Plan/Execute), Replicate (Demucs/Bark), lokale ONNX-Demucs- und Embedding-Scaffolds, WebGPU-Kernel (GEMM/Activation) |
| Auth | `AccessContext` (ADMIN/EDITOR/VIEWER, rein client-lokal) + infrastruktureller Wake-on-Login (Cloudflare Worker) |
| Deployment | Docker-Compose (Caddy/App/master-player/Redis/Monitoring), Hetzner-Flotte (5 Knoten, stündlich, Idle-Auto-Shutdown, Auto-Repair), Helm-Chart, Wake-on-Login |
| Tests | Vitest (179 Tests), Playwright E2E (smoke/collab/responsive/visual/stress), Boundary-Scan, Coverage, SonarCloud-CI, Nightly-CI, Live-Stress on-demand |

---

## 2. Browser-Plattform-Baseline (pro API entschieden)

| API | Benötigt? | Implementiert? | Bewertung |
|---|---|---|---|
| Web Audio API | Ja (Kern) | Ja | Korrekt genutzt; Kontext über `audioContextFactory` (Boundary-Regel) |
| AudioWorklet | Ja (Kern) | Ja, 10 Prozessoren | Korrekt; Hot-Pfade überwiegend allokationsfrei (verifiziert: `lufsProcessor` nur `Int32Array`+`Atomics.store`) |
| SAB + Atomics | Ja (LUFS/Analyzer/Ring) | Ja | Korrekt; COOP/COEP gesetzt; Fallback ohne SAB vorhanden |
| WebAssembly | Bedingt (optionaler DSP-Kernel) | Teilweise | **Befund:** `WasmBackend` lädt den Kernel, rendert aber in JS (Scaffold). Siehe §5 |
| WASM SIMD/Threads | Optional (ONNX) | Indirekt | `onnxruntime-web` nutzt SIMD/Threads, wenn crossOriginIsolated – ok als Optional |
| Web Workers | Ja | Ja | `WorkerPool`, `workerFactory`, Visualizer-Worker – korrekt |
| OffscreenCanvas | Ja (Visualizer) | Ja | Worker-Rendering vorhanden |
| WebGPU | Optional (KI/Visual) | Scaffold | GEMM/Activation + SpatialConv-Kernel; **defer** (§6) |
| WebCodecs | Nein (aktuell) | Nein | WAV/Opus laufen über WebRTC/FFmpeg – korrekt nicht eingeführt |
| WebTransport | Nein (aktuell) | Nein | **Reject für jetzt** (§9) |
| WebRTC | Ja | Ja | Full-Mesh (DataChannel) + SFU-Modus; ICE/STUN ok |
| WebSocket/Socket.io | Ja (Control) | Ja | Socket.io + Redis-Adapter; Relay p95 38 ms gemessen |
| IndexedDB/OPFS | Ja (große States) | IndexedDB ja, OPFS nur Utility | OPFS derzeit ungenutzt – für Sample-Cache später relevant |

---

## 3. Audio-Engine: Real-Time-Sicherheit

**Erfüllt:**
- Worklet-Hot-Pfade: Preallocation (Mix-Puffer, Scratch), keine `slice()`/`map()` im Prozess-Callback (statischer Audit + `scripts/audit-audio-realtime.sh`)
- Kein Locking im Audio-Thread; SPSC-Ring nur für Kontrollsignale
- Deterministisches Noise (`xorshift32`) statt `Math.random()` im Worklet
- NaN/Inf-Guards an den Worklet-Ausgängen, Parameter-Clamping
- PDC: Monitor-/Cue-Pfad um Mastering-Lookahead (5 ms) kompensiert

**Abweichungen/Befunde:**
- `setEffectParam` konstruierte das Effect-Worklet lazy mit potenziell `null`-Context (BaseAudioContext-Crash) → **gefixt** (Raw-Context-Fallback + try/catch). Muster prüfen: weitere Lazy-Worklet-Konstruktionen hart absichern.
- Generische AudioParam-Automations-Pipeline für **alle** Worklets (eq/dsp/effect/mastering) ist offen – nur `itSynthProcessor` hat sample-genaue Rampen. Parameter-Sprünge auf diesen Worklets können Zipper erzeugen. **Priorität: hoch.**
- `loadPatterns`/`applyPatterns` allokieren im Control-Plane (erlaubt), aber ohne Backpressure bei 1000 Events/s → Coalescing im WebRTCManager deckt Netz, nicht die Engine selbst. Engine-seitiges Throttling für Automation erwägen.

---

## 4. Audio-Thread-Architektur

Trennung existiert sauber: UI → Parameter/State (React/Context) → Scheduling (Tone.Transport/Clock-Worklet) → AudioWorklet → DSP → Output.
- Klick-/Zipper-Schutz: Rampen in `itSynthProcessor`, `setTargetAtTime` für Fader
- Event-Scheduling: Clock-Worklet (jitterarm), Lookahead-Scheduler
- Buffer/Sample-Rate: 48 kHz intern dokumentiert; Sample-Raten-Wechsel im Browser geräte-fixiert → nativer Pfad (`AudioDeviceManager`, Xonar U7) ist die richtige Stelle
- Underrun-Handling: kein explizites Underrun-Counter-Feedback im UI (nur Audio-Health) → **Messpunkt ergänzen**

---

## 5. WASM/DSP

- `src/audio/wasm/dspKernel.c` existiert und wird per `build-wasm-audio.sh` gebaut – aber der **produktive Render-Pfad nutzt ihn nicht** (`WasmBackend.render` verarbeitet den Graphen in JS und kopiert Sample für Sample).
- Bewertung: Für kleine per-Sample-DSP-Kernel bringt WASM im Browser kaum messbaren Nutzen (AudioWorklet ist dafür die richtige Plattform). **Entscheidung:** Kernel nicht erzwingen; entweder (a) als optionalen Offline-Render-Backend fertig verdrahten (deterministisches Bounce-Rendering) oder (b) klar als Referenz markieren und nicht als „WASM-Backend" bewerben. Zero-Copy-Claims vermeiden – aktuell wird real kopiert.

---

## 6. WebGPU

- Sinnvoll nur für: große FFT/Spektralanalyse, Convolution, GEMM/Inference, Visualizer.
- Ungeeignet für: per-Sample-DSP, kleine Buffer, häufige CPU/GPU-Sync.
- **Entscheidung:** als optionales Backend **behalten, aber defer** – erst verdrahten, wenn ein echter Workload existiert (z. B. lokale ONNX-Inferenz oder Spektral-Effekte). Kein Prestige-Einsatz.

---

## 7. Audio-Buffering

- `RingBuffer`: SPSC, SAB + Atomics (SeqCst), korrektes Layout `[Daten][head][tail]`, Fallback ohne SAB sauber deklariert. **Korrekt.**
- LUFS/Analyzer: SAB + `Atomics.store` → echte Zero-Copy-Messung. **Korrekt.**
- WASM-Grenze: per-Sample-Kopie (kein Zero-Copy) – ehrlich dokumentieren.
- Netzgrenze: JSON über DataChannel/Socket; Opus über WebRTC/SFU. Für 4 User ausreichend; Binärprotokoll (Protobuf/CBOR) erst bei >10 Usern oder sehr hohen State-Raten sinnvoll (YAGNI).

---

## 8. Latenz (realistische, getrennte Ziele)

| Kategorie | Realistisches Ziel | Aktueller Stand |
|---|---|---|
| Lokal (Device-Buffer + Browser + Worklet + DSP) | 8–15 ms (je Interface) | Worklet-Quanten + Xonar; **kein persistenter End-to-End-Messwert** → Instrumentierung ergänzen |
| Netz (WebRTC Opus / SFU) | < 50 ms one-way | SFU-Signaling p95 38 ms gemessen; RTP-Echtpfad noch offen |
| Kollaboration (State) | < 100 ms bis UI-Feedback | Relay p95 38–47 ms gemessen ✅ |

Marketing-Ziel „<3 ms end-to-end" ist für diese Architektur **nicht seriös** – nicht verwenden.

---

## 9. Transport-Entscheidung

- **WebRTC bleibt richtig** für Medien (NAT, Jitter, Opus, P2P+SFU).
- **Socket.io bleibt richtig** für die Control-Plane (Fallback, Redis-Adapter, einfache Rooms).
- **WebTransport: jetzt ablehnen.** QUIC-Vorteile sind bei 4 Usern marginal; Komplexität und Browser-Matrix-Kosten überwiegen. Erneut prüfen erst bei >10 Usern oder datenintensiven Features (z. B. Stem-Upload-Streams).

---

## 10. AuthN/AuthZ – größter Architektur-Gap

- `AccessContext` ist rein client-lokal: Rolle per State schaltbar, keine Identität, kein Token, keine Server-Durchsetzung.
- Plugin-Locking bindet an `socket.id`, nicht an eine User-Identität.
- Wake-on-Login ist ein **Infrastruktur-Gate**, keine App-Authentifizierung.
- **Bewertung:** Für den privaten 4-User-Studio-Betrieb vertretbar; für jeden öffentlichen/kommerziellen Betrieb **nicht**. Empfehlung: minimale Session-Identität (Server vergibt signiertes Session-Token beim Join, Rollen serverseitig durchgesetzt, Locking an User-ID statt Socket-ID). Komplexität: mittel; Nutzen: hoch.

---

## 11. Custom vs. Standard

| Custom-Baustein | Urteil |
|---|---|
| LWW-CRDT + Lamport-Clock + ObjectRegistry | **Gerechtfertigt** (deterministisch, leichtgewichtig für 4 User). Yjs/Automerge wären erst bei >10 Usern oder Rich-Text/Undo-Historie sinnvoll (YAGNI) |
| SPSC-RingBuffer | **Gerechtfertigt** (einfach, korrekt, keine Dependency nötig) |
| LLM-Router (Kosten-Fallback) | **Gerechtfertigt** (Provider-Unabhängigkeit ist Produktanforderung) |
| Telemetrie/Error-Tracker | **Gerechtfertigt**; OpenTelemetry wäre für diese Größe überdimensioniert |
| AudioGraph-Serialisierung (JSON) | **Gerechtfertigt**; Standardformat (z. B. DAWproject) erst bei Interop-Anforderung |
| Eigene Build-/Deploy-Skripte | **Gerechtfertigt** (Hetzner-spezifisch); Helm existiert für K8s-Pfad |

**Ersetzen durch Standard:** nichts Dringendes.

---

## 12. Zukunftsbeschränkungen

1. 4-User-Cap ist Produktentscheidung (Session-Full) – Architektur (SFU/Redis) kann >4, aber UI/Locking müssten angepasst werden.
2. Sample-Raten-Wechsel: Browser-fixiert → nativer Backend-Pfad (`NativeAudioBackend`, Xonar U7) ist der richtige Ort; dort testen.
3. Identität (siehe §10) begrenzt serverseitige Rechte, Auditierbarkeit und sicheres Locking.
4. Stem-ONNX lokal (~291 MB Modell) ist Laptop-lastig; Replicate übernimmt aktuell – hybride Strategie beibehalten.

---

## 13. Priorisierte Verbesserungen (Nutzen vs. Aufwand)

**P0 – vor Live-Test**
- [ ] Session-Identität minimal: Server-Token beim Join + Locking an User-ID (nicht Socket-ID)
- [ ] Generische AudioParam-Rampen für eq/dsp/effect/mastering-Worklets (Zipper-Schutz vervollständigen)
- [ ] Underrun-/Dropout-Zähler im Audio-Thread → `/api/telemetry` + UI

**P1 – kurz danach**
- [ ] End-to-End-Latenz-Messung persistieren (LatencyMonitor → Telemetrie/Grafana)
- [ ] Lazy-Worklet-Konstruktionen auditen (Muster aus `setEffectParam`-Fix überall anwenden)
- [ ] OPFS-Sample-Cache für große Bibliotheken aktivieren
- [ ] Live-2-Browser-WebRTC- und SFU-RTP-Echtpfad-Tests (bereits in MASTER_TODO)

**P2 – strategisch**
- [ ] WASM-Kernel entweder als Offline-Render-Backend fertig verdrahten oder klar als Referenz markieren
- [ ] WebGPU erst mit echtem Workload (ONNX-Inferenz/Spektral) aktivieren
- [ ] Binärprotokoll (CBOR/Protobuf) erst bei >10 Usern
- [ ] Alerting-Webhook (Discord/Slack/Telegram)

**Bewusst NICHT tun (Premature/Oversized):** WebTransport, OpenTelemetry, Yjs/CRDT-Framework, WebCodecs, „<3 ms"-Marketing, WebGPU für per-Sample-DSP.

---

## 14. Fazit

Die Architektur ist für eine browserbasierte 4-User-Audio-Workstation **technisch solide und überwiegend standardkonform**. Die Audio-Thread-Disziplin ist überdurchschnittlich (Worklets, SAB, RingBuffer, PDC, deterministisches Noise). Die größten Lücken sind **Identität/AuthZ**, **vollständige Zipper-freie Parameter-Automation über alle Worklets** und **fehlende End-to-End-Latenz-/Dropout-Telemetrie**. WASM/WebGPU/WebTransport sind korrekt als optional/deferred eingeordnet und dürfen nicht erzwungen werden.
