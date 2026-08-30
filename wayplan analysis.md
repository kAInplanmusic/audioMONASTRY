# Interne Entwicklungsdokumentation – Strang A (Spezifikation/Analyse)

## Rolle dieses Strangs (Spezifikation / Analyse)

Dieser Strang dokumentiert ausschließlich abstrahierte Anforderungen und
Konzepte. Er enthält keinen Quellcode und keine Implementierungsdetails.
Alle Einträge werden mit Zeitstempel geführt, damit die Trennung der beiden
Entwicklungsstränge lückenlos nachvollziehbar bleibt.


## Spezifikation (abstrahiert, ohne Codeübernahme)

**Technologie & Implementierung:**
- Backend (Echtzeit-Audio): Rust und WebAssembly (WASM) für Performance und Speichersicherheit.
- Frontend/UI: TypeScript, GPU-beschleunigtes Rendering für Waveforms und MIDI-Clips.
- Datenmodell: Rationale Zeit für Timing-Genauigkeit, Tree-basierte Struktur für verschachtelte Sequenzen.

**Plugins & Erweiterungen:**
- WAM-Standard: Web Audio Modules, Organisation als Pedalboard-Kette, Shared Array Buffers/Ringbuffer für UI-Audio-Thread-Kommunikation.
- Modulare Nodes: Gerichteter azyklischer Graph (DAG) aus Audio-Nodes mit definierten Ein-/Ausgängen.
- Kategorien: Generatoren (Oszillator, Noise, Sampler, Granular), Effekte (Filter, Delay, Reverb, Distortion, Chorus, Phaser), Dynamik (Kompressor, Expander, Gate, De-Esser, Multiband), Utilities (Mixer, Splitter, Gain, Autopan).

**Datenformate & Session-Management:**
- JSON-Snapshot für Projektzustand, Befehle: NEW_SESSION, LOAD_SESSION, SAVE_SESSION, EXPORT.

**Kern-Prozesse:**
- Zentrales Session-Objekt für Tracks, Tempo, Wiedergabestatus; undo/redo-fähige Events.
- Automation: READ, WRITE, TOUCH, LATCH Modi mit Interpolation.
- Signal-System: Typsicheres Event-System für lose Kopplung.

**Web-Infrastruktur:**
- Web Audio API, AudioWorklets, Web MIDI API, WebSocket (ws://127.0.0.1:3030/ws) für Kollaboration.

**Spezifikation:**
1. Client-Server-Webapplikation: Client = Echtzeit-Audio/UI, Server = Projektverwaltung/Kollaboration.
2. Audio-Engine: Rust → WASM, läuft im AudioWorker-Thread.
3. UI: TypeScript + GPU-beschleunigtes Rendering.
4. Datenmodell: Rationale Zeit, Tree<Event>, JSON-Persistenz.
5. Plugin-System: WAM-Standard, Shared Memory/Ringbuffer.
6. Kern-Features: Simultane Aufnahme, non-destruktives Editing, vollautomatisierbares Mischpult, Undo/Redo.
7. Future-Proofing: MIDI 2.0, KI-Hooks für Stem-Separation/Text-to-Audio.


## Rekonstruierte Historie

| Zeitstempel | Tätigkeit |
|---|---|
| 2026-08-27 02:03:55 +0200 | Rust-Mastering-Kette (3-Band-EQ/Drive/Ceiling) + NativeBackend echten V2-DSP-Pfad |
| 2026-08-27 01:53:20 +0200 | Echte DSP/Streaming/TTS: Rust PCM-DSP + 440Hz-Stream, NativeBackend DSP, V1→V2 GraphEngineAdapter |
| 2026-08-27 01:43:01 +0200 | SonarCloud: letzte 8 Issues aus neuer Architektur bereinigen (Regex, random, NOSONAR) |
| 2026-08-27 01:36:35 +0200 | VoiceMONK-Verfeinerung (Presets, Melodie-Synth, Live-Preview) + Phase 5 Render-Queue |
| 2026-08-27 01:25:48 +0200 | Phase 4: WebSpeech Live-TTS, VoiceMonkPanel UI, preview + Voice-Presets |
| 2026-08-27 01:19:08 +0200 | MASTERTODO: Phase 3 Pipeline abhaken |
| 2026-08-27 01:18:38 +0200 | Phase 3: Source→Extraction→AudioObject Pipeline + SpatialScene-Integration |
| 2026-08-27 01:07:10 +0200 | Phase 2: cpal in Rust-Runtime – echte Device-Liste + Silent-Stream via device.open |
| 2026-08-27 00:55:28 +0200 | Phase 2: Rust Device-Liste (/proc/asound), listDevices IPC, NativeBackend.listDevices |
| 2026-08-27 00:48:16 +0200 | Phase 2: Rust-Runtime gebaut, StdioTransport + NativeRuntimeSpawner + NativeBackend-Integration |
| 2026-08-27 00:43:22 +0200 | MASTERTODO: Phase 2 abhaken (Runtime + Rust-Scaffold) |
| 2026-08-27 00:42:41 +0200 | Phase 2: RuntimeProcessManager, NativeRuntimeClient, Rust audio-runtime Scaffold |
| 2026-08-27 00:34:04 +0200 | Live-Worklet-Verdrahtung: WebAudioWorkletBridge + audioEngine.connectLiveWorkletChain |
| 2026-08-27 00:18:08 +0200 | WebAudioBackend: Graph-Output auf Destination verdrahten (getLastOutput, render/playOutput) |
| 2026-08-27 00:12:13 +0200 | V2-Transport aktiv über AudioGraph: playV2/stopV2/triggerEventV2 nutzen Worklet-Kette |
| 2026-08-26 23:57:03 +0200 | Worklet-Referenz-Specs (itSynth/EQ/Mastering) im AudioGraph registriert |
| 2026-08-26 23:51:00 +0200 | Cloud-Automation: R2↔Supabase Sync, Analyse+Tagging, Upload-Ingest, V2-Transport-Wrapper |
| 2026-08-26 23:39:11 +0200 | Phase-1 Worklet-Einhängung: WorkletGraphRuntime + audioEngine-Integration |
| 2026-08-26 23:12:50 +0200 | Phase-1-Migration: GraphStateBridge, Mixer-Nodes, Worklet-Adapter, BufferPool + Optimierung |
| 2026-08-26 23:03:16 +0200 | AI Control Layer: LlmRouter (Free->Flash->Pro->Paid), VoiceControlService, VoiceMonkService, SessionMediaStore |
| 2026-08-26 22:00:46 +0200 | Architektur-Evolution: Audio-Runtime-Abstraktion, SpatialScene, VoiceMONK, OfflineRenderer, IPC, DeviceManager |
| 2026-08-26 08:33:10 +0200 | SonarCloud: neue Hetzner-Script-Issues beheben (S1313, S3457) |
| 2026-08-26 08:30:19 +0200 | Docs: Floating IP + DNS-Setup + Domain anunnakitools.de vorbereitet |
| 2026-08-26 08:25:00 +0200 | Hetzner DNS: neue Cloud-API (rrsets) verwenden, TXT-Quoting, @-Pfad-Fix |
| 2026-08-26 07:57:11 +0200 | Hetzner: Floating-IP-Support in Provisioning + DNS-Setup-Skript |
| 2026-08-26 02:43:06 +0200 | SonarCloud: Regex-Zeichenklasse unter (?i) deduplizieren (S5869) |
| 2026-08-26 02:24:15 +0200 | SonarCloud: neue Python-Issues beheben (Annotated, async/sync, NOSONAR-Syntax, Regex) |
| 2026-08-26 02:06:41 +0200 | SonarCloud: SCM-Blame deaktivieren (Sparse-Checkout-Kompatibilität) |
| 2026-08-26 01:51:04 +0200 | Sparse-Checkout: server.ts inkludieren (Server-Test-Import) |
| 2026-08-26 01:49:37 +0200 | Hash-Locks für alle Python-Services (uv pip compile), require-hashes in Dockerfiles |
| 2026-08-26 01:15:29 +0200 | Node-Coverage jsdom-Tests + Sparse-Checkout + master-player Hash-Lock |
| 2026-08-26 00:18:17 +0200 | SonarCloud Node-Coverage: Vitest + LCOV, Tests fuer Server/Cloud/Utils/Scripts, CI-Scan mit Coverage |
| 2026-08-25 22:57:52 +0200 | SonarCloud: Docker-Python-Abhaengigkeiten in requirements.lock auslagern (S8544) |
| 2026-08-25 22:28:16 +0200 | SonarCloud: letzte 4 Issues beheben (Requirements pinnen, pipe-Konstanten) |
| 2026-08-25 22:07:23 +0200 | SonarCloud: restliche 10 offene Issues beheben (Konstanten, ignore-scripts, S8475, S4036) |
| 2026-08-25 21:49:24 +0200 | SonarCloud: Automatic Analysis deaktiviert, CI-Scan aktiviert (sonarqube-scan-action) |
| 2026-08-25 21:42:55 +0200 | SonarCloud: auf Automatic Analysis umstellen (CI-Workflow entfernt, .sonarcloud.properties) |
| 2026-08-25 21:41:02 +0200 | SonarCloud CI-Scan via GitHub Actions einrichten (sonarqube-scan-action) |
| 2026-08-25 21:24:08 +0200 | SonarCloud: 260 Issues ausgewertet und behoben/abgesichert (TS, Python, Docker, Shell, C) |
| 2026-08-25 19:54:20 +0200 | Hetzner-Deploy vorbereitet: CX23-Testinstanz, DOMAIN-Caddy, Provisioning, Smoke-Test |
| 2026-08-25 20:35:13 +0200 | Add GitHub Actions workflow to export SonarQube issues |
| 2026-08-25 18:40:24 +0200 | Sample-Upload mit Scan + R2/Supabase-Ablage, DB-Metadaten, Hetzner-Deploy |
| 2026-08-25 18:23:16 +0200 | Backend-Services optimiert: Robustheit, Limits, Queue-Fix |
| 2026-08-25 18:14:13 +0200 | Bugfix master-player: acompressor makeup als linearen Faktor korrigiert |
| 2026-08-25 18:07:32 +0200 | Gesamtes UX/UI querformat-optimiert (alle Plugins, PC + mobil) |
| 2026-08-25 16:52:19 +0200 | Responsive-Pass Mixer + Sequencer (Querformat/Touch optimiert) |
| 2026-08-25 16:31:14 +0200 | Mobile-/Touch-Perfektionierung fuer Linux-Laptops + iPhone/iPad |
| 2026-08-25 16:22:13 +0200 | Drummachine zum echten 16-Step-Sequencer aufgewertet |
| 2026-08-25 16:09:17 +0200 | EQ-Modul aufgewertet: echter Frequenzgang, präzise Fader, Presets |
| 2026-08-25 15:56:00 +0200 | Spatial-Modul massiv verbessert: interaktive 360°-Bühne + UX |
| 2026-08-25 15:08:37 +0200 | Single-Session-Signaling: eine feste Session statt Raumverwaltung |
| 2026-08-25 14:59:41 +0200 | UX-Optimierung: Master-Player + globaler App-Pass |
| 2026-08-25 14:06:31 +0200 | Frontend: MasterPlayerTerminal an /api/master/* angebunden |
| 2026-08-25 13:58:33 +0200 | master-player v2: nativer Mixing/Mastering-Dienst (FFmpeg+NumPy) |
| 2026-08-25 12:48:49 +0200 | Mixer DJM-A9 (4/8-Kanal), 12-Band-EQ, WebMIDI/HID-Controller, TR-8S-Drummachine, Plugin-Verbesserungen |
| 2026-08-25 12:48:43 +0200 | Security-Audit (Semgrep): Docker non-root + SHA-256 statt MD5 |
| 2026-08-25 07:53:58 +0200 | Server: B2B-Raumverwaltung (max. 4 User, Full-Mesh-Signaling) |
| 2026-08-25 07:35:23 +0200 | COOP/COEP-Header + WASM-Threading + OS-Aggregation fertig |
| 2026-08-25 07:27:13 +0200 | Finaler Cleanup: Dead-Code entfernt, Gesamtvalidierung bestanden |
| 2026-08-25 01:10:24 +0200 | Echtes HTDemucs-ONNX-Modell: 100% Stem-Separation |
| 2026-08-25 00:48:59 +0200 | Recherche-gestuetzte Qualitaetsoffensive: Stems, Drums, FX, Touch-UX |
| 2026-08-25 00:39:22 +0200 | Xonar U7 app-weit + README als vollstaendige Referenz |
| 2026-08-25 00:34:40 +0200 | Spatial 12.x/18.x/24.x + Raumplaner + Xonar U7 Support |
| 2026-08-25 00:21:37 +0200 | Tiefen-Audit + Optimierungsrunden (115%-Pass) |
| 2026-08-25 00:14:06 +0200 | MASTER_TODO komplett: Abschluss-Sprint ueber alle offenen Phasen |
| 2026-08-24 23:54:02 +0200 | Aufgabe 1.2 komplett: 1.2.3 Lease-Locking + 1.2.4 Seed-Management |
| 2026-08-24 23:48:16 +0200 | MASTER_TODO 1.1.4-1.1.6 + 1.2.1-1.2.2 produktionsreif umgesetzt |
| 2026-08-24 23:30:48 +0200 | Boundary-Migration: 50 Verstöße behoben + TODO 1.1.1-1.1.3 abgeschlossen |
| 2026-08-24 23:19:44 +0200 | Finale Top-5-Liste: Boundary-Validator, Performance-Monitor, Worklet-Hot-Path, Graph-Serialisierung, True-Peak-Mastering |
| 2026-08-24 21:30:59 +0200 | Konsolidiere Planung + Databank-Integration + instrumentMONK Tasks 1/3/2 |
| 2026-08-24 16:48:42 +0200 | env. change to lightweight terminal |
| 2026-08-23 16:31:34 +0200 | main |
| 2026-08-23 10:56:20 +0200 | MASTER_TODO: Priorität-0-Abschnitt mit instrumentMONK-Tasks (Reihenfolge 1,3,2) |
| 2026-08-23 10:08:34 +0200 | instrumentMONK: sample-genaue Synthese im AudioWorklet (Aufgabe 1) |
| 2026-08-21 17:08:15 +0200 | instrumentMONK: 100-Instrumenten-Engine (Plugin #5) + Hybrid-Synthese |
| 2026-08-20 15:29:41 +0200 | Phase 1: Core-Abstraktionen + WebGPU/WorkerPool/SFU-Bausteine |
| 2026-08-19 18:51:00 +0200 | Cleanup: veraltete Plan-/TODO-Dateien entfernt, MASTER_TODO.md behalten |
| 2026-08-19 18:40:24 +0200 | Automatische lokal-Offline Audio-Analyse (BPM/Key/Energy) |
| 2026-08-19 15:19:16 +0200 | Musik-Bibliothek (public/music) in Apps integriert |
| 2026-08-19 13:55:26 +0200 | commit |
