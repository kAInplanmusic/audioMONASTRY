# Gesamt-Audit 2026-10-07 · Code, Tests, Architektur, UI/UX, Performance

> **Herkunft:** Erster Audit-Bericht dieser Sitzung (Chat), hier dauerhaft abgelegt, damit er nicht verloren geht.
> **Ausgangs-Commit:** `653fa02` · **Detailanalyse der Top 10:** [`AUDIT_2026-10-07_ECHTZEIT.md`](AUDIT_2026-10-07_ECHTZEIT.md) · **AI-Korrektur:** [`AUDIT_2026-10-07_AI_LOKAL.md`](AUDIT_2026-10-07_AI_LOKAL.md) · **Aufgaben:** `MASTERTODOENDE.json` → `RT-AUDIT-*`, `rtAudit2026_10_07`
> **Hinweis:** Der Abschnitt „AI-Integration“ dieses Berichts ist durch die AI-Korrektur teilweise überholt (Cloud-Provider sind nur Entwicklungswerkzeuge, Produkt = lokal auf Runpod).

## Kurzfazit

Infrastruktur sauber (tsc, ESLint, Boundary-Scan, alle 2511 Vitest-Tests grün, AI vom Audio-Thread getrennt). Der hörbare Live-Pfad (`v2SinkProcessor` → `V2SinkEngine`) hat aber Fehler, die man sofort hört: Drum-Steps und Noten brechen nach 2,67 ms ab, Swing verwirft 7 von 16 Steps, die Mastering-Kette verzerrt mit 17 % THD, die Dropout-Erkennung kann Dropouts grundsätzlich nicht sehen. Die Tests finden das nicht, weil keiner über mehrere Blöcke prüft.

## Phase 1 — Was im Repo steckt

| Schicht | Was es wirklich ist |
|---|---|
| Audio-Engine | Läuft im Browser: ein AudioWorklet (`v2SinkProcessor`) mit TS-Graph (`V2SinkEngine`/`V2MonitorGraph`), feste 8 Kanäle, Blockgröße 128. Legacy-Worklets (mastering, effect, analyzer, lufs, itSynth) werden erzeugt, hängen aber nicht am Ausgang. |
| UI | React 19; Kommunikation mit der Engine per `MessagePort.postMessage`, keine SharedArrayBuffer-Ringpuffer. |
| AI | `LlmRouter` (lokal-zuerst, Cloud-Wege per Schalter), Runpod Serverless; „MCP“ = In-Process-Werkzeugliste auf dem Server, kein MCP-Protokoll; Demucs als ONNX im Browser. |
| Plugin-Host | Kein VST3/CLAP/AU. „Plugins“ = 16 TS-Adapter, deren `process()` nur im Offline-Bounce läuft (`pluginChainBounce.ts`). |
| Server | Node/Express/socket.io (Sync, Locks), mediasoup (SFU), Python-Dienste. Rust-`audio-runtime` (cpal) nirgends angebunden. |
| Build | Vite, esbuild, tsx, Node 22; zwei Lockfiles (npm + bun). |

## Phase 3 — Messungen

Eigene Skripte auf denselben Klassen wie im Worklet (Node/V8, 4 Kerne), dazu echtes Chromium 1194 (headless, Fake-Audiogerät). Reproduzierbar: `npm run audit:rt`.

| Messung | Ergebnis |
|---|---|
| Kick-Step auf channel1 | 1 Block hörbar = 2,67 ms, danach Stille (erwartet ~300 ms) |
| Swing 0,2 / 0,5 | 8 Steps gespielt, 7 verworfen pro Takt |
| 60 s Render, Transport an | Ø 232 µs, p99,9 4,85 ms, max 11,4 ms bei 2,67 ms Budget; 85 Blöcke über Budget |
| Allokationen | 46 `acquire`/Block, 1.035.000 neue Arrays, 0 Freigaben; 2,6 GC/s, längste Pause 9,6 ms |
| THD Default-Masterkette, 1 kHz | −30 dBFS 0,008 % · −18: 0,13 % · −12: 5,5 % · −6: 17,4 % (−6 dBFS kommt mit −10,3 dBFS heraus) |
| Sample-Player 44,1 → 48 kHz | SINAD 13,6 dB bei 5 kHz (Nearest-Neighbor) |
| EffectNode, Impuls nur links | Rechts Energie 0,43 (soll 0) |
| Skalierung, alle Master-Inserts an | 1 Engine 14 % Budget (6/3750 über Budget) · 4×8 Kanäle 55 % (144) · 8×8 Kanäle 121 % → Dauer-XRuns |
| Chromium-Überlast (4 bzw. 8 ms CPU/Block) | Audio-Uhr 72 % bzw. 35 % Echtzeit, `currentFrame` zeigt 0 Lücken |
| Chromium-Latenz (Fake-Gerät, 44,1 kHz) | interactive 10 + 32 ms · playback 23 + 72 ms |
| Theoretische Latenz 48 kHz | 128 Frames 2,67 ms · 256: 5,33 · 512: 10,67 · 1024: 21,3 ms; wegen GC-Pausen ≥ 512 Frames nötig |
| LLM (Entwicklungs-Provider, nicht Produkt) | DeepSeek v4-flash TTFT 0,9–1,3 s; OpenRouter Llama-3.3-70B TTFT 0,5–0,8 s; Cerebras gesamt 0,36–0,52 s |

## Phase 5 — Findings (Stand des ersten Berichts)

| Bereich | Finding | Schwere | Fix | To-Do-ID |
|---|---|---|---|---|
| Audio-Engine | Stimmen enden nach einem Block | 95 % | Voice-Pool | RT-AUDIT-P0-001 |
| Audio-Engine | BufferPool gibt nie frei, 46 Allokationen/Block | 90 % | feste Port-Puffer | RT-AUDIT-P0-002 |
| Audio-Engine | Swing verwirft ungerade Steps | 85 % | Event-Queue | RT-AUDIT-P0-003 |
| Mastering | Momentanwert-Regelung + `tanh` immer an, 17 % THD | 85 % | Detektor mit Attack/Release, Lookahead | RT-AUDIT-P0-004 |
| Monitoring | XRun-Erkennung über `currentFrame` blind | 75 % | Wanduhr-Drift | RT-AUDIT-P0-005 |
| Instrumente | itSynth unhörbar (`GLOBAL_MASTER` unverbunden) | 75 % | im Sink rendern | RT-AUDIT-P0-006 |
| Robustheit | kein `try/catch`, kein `onprocessorerror` | 70 % | Fehlerpfad + Neuaufbau | RT-AUDIT-P0-007 |
| Persistenz | Session-State nur im RAM ohne `REDIS_URL` | 70 % | Redis AOF / Datei | RT-AUDIT-P1-008 |
| Sampler | Nearest-Neighbor-Resampling | 70 % | Resampling beim Laden | RT-AUDIT-P1-009 |
| IPC | Klonen großer Daten im Audio-Thread, SFZ-Parsing im `onmessage` | 65 % (später 75 %) | Transfer, Sample-Pool, SAB-Ring | RT-AUDIT-P1-010 |
| Architektur | Plugin-Vertrag nur im Offline-Bounce | 60 % | Live-Graph = Plugin-Runtime | PLUGIN-V2-C1 |
| FX | EffectNode teilt Delay-Lines für L/R | 60 % | Zustand pro Kanal | RT-AUDIT-P1-011 |
| Latenz-UI | `latencyHint`/Sample-Rate nie angewendet | 55 % | Context mit Settings | RT-AUDIT-P1-012 |
| Streaming | `produce()` ohne `codecOptions` | 55 % | opusStereo, 256 kbit/s | RT-AUDIT-P1-013 |
| Metering | LUFS unverbunden, Peak-Meter verliert Samples | 50 % | Meter im Sink + SAB | RT-AUDIT-P0-005 |
| Stem-AI | Demucs-OLA blendet Anfang/Ende aus | 50 % | Gewichte korrigieren | RT-AUDIT-P2-018 |
| AI | (überholt, siehe AI-Korrektur) | – | – | RT-AUDIT-P1-014/015 |
| Tests | keine Mehrblock-/THD-/Stereo-Tests | 50 % | audit:rt als Gate | RT-AUDIT-P2-022 |
| DSP | DspFilterNode-Koeffizienten pro Sample | 45 % | gedrosselt, allokationsfrei | RT-AUDIT-P2-017 |
| Portabilität | torch 2.5.1 vs. ≥ 2.6 | 45 % | ein Image | RT-AUDIT-P2-019 |
| Mixer | Parameter-Zipper | 40 % | Glättung | RT-AUDIT-P2-016 |
| Mixer | 8 Kanäle fest | 40 % | konfigurierbar | RT-AUDIT-P2-021 |
| Latenz-UI | 5 ms Phantom-Lookahead in der Anzeige | 30 % | echte Graph-Latenz | RT-AUDIT-P1-012 |
| Spatial | 4 Float32Array-Views pro Block im WASM-Pfad | 25 % | Views einmal anlegen | (Teil von RT-AUDIT-P0-002) |
| Altlasten | Rust-Runtime, WasmBackend, Legacy-Worklets unverbunden | 20 % | löschen/kennzeichnen | RT-AUDIT-P2-020 |

## Phase 4 — Technologie-Bewertung

| Thema | Bewertung |
|---|---|
| VST3/CLAP/AU | Nicht vorhanden; im Browser nicht hostbar. Realistischer Standard: WAM 2.0. |
| IPC UI ↔ Engine | `postMessage` klont/alloziert im Audio-Thread → SAB-SPSC-Ring (COOP/COEP gesetzt). ZeroMQ/gRPC ohne Nutzen. |
| Engine ↔ Server | socket.io für Steuerdaten ok (entprellt, Größen-Limit, Locks serverseitig); Audio über WebRTC, 50 ms Jitter-Puffer. |
| MCP | In-Process-Registry, kein Protokoll-Overhead, getrennt vom Audio-Thread – in Ordnung. |
| Hetzner vs. Runpod | DSP läuft im Browser des Mixer-Halters → Server-Hardware egal für Audio-Latenz (Widerspruch zu AGENTS §1.1). Portabilität scheitert nur an torch-Version und Redis-Konfiguration. |

## Nicht verifiziert / nicht ausführbar

- Runpod-GPU-Inferenz (kein `RUNPOD_API_KEY` im Container).
- Demucs-Laufzeit (`public/models/htdemucs.onnx` fehlt).
- `npm run verify` vollständig: `test:rls`/`audit:deep` brauchen Live-Supabase; `test:python` 13 Fehler nur in Fleet-/Deploy-Skripttests wegen Container-Umgebung (`zstd`, `aria2c` fehlen, flacher Git-Clone).
- Echte Hardware-Latenz (nur Fake-Audiogerät).
- Opus mono nur aus dem Code abgeleitet.
