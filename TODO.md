# TODO – audioMONASTRY

> Einzige offene Aufgabenliste des Repos.
> Stand: 2026-09-07 · Konsolidiert aus `MASTER_TODO.md`, `OFFENE_PUNKTE_*.md`, `AGENT_TODO.*`,
> `TASKDONE.md`, `docs/*AUDIT*.md`, `logs/background-coder/audit-plans.md` und Commit-Logs.
> Erledigte Punkte, Doku-Historie und alte Tracking-Dateien wurden entfernt.
> Backup der entfernten Dateien: `/tmp/audiomonastry-cleanup-2026-09-07/tracking-and-agent-backup.tgz`

---

## 1. Code / Audio / Architektur

- [ ] **audioEngine-Split weiterführen** – Phase 2: Worklets entkoppeln; Phase 3: Routing; Phase 4: Graph-Kompatibilität. Basis ist `docs/audioEngine-split-plan.md` + `src/core/audio/backends/AudioBackend.ts`.
- [ ] **Pre-existing WebGPU-/TS-Typfehler bereinigen** – `@webgpu/types` sauber auflösen oder als bekannte Runtime-only-Dateien dokumentieren/ausschließen.
- [ ] **V2-AudioGraph / experimentelle Pfade final entscheiden** – `src/core/gpu/`, Rust-Runtime (`services/audio-runtime`), Rust-Mixer (`services/mixer`), WASM-DSP/HRTF, `localDemucs` entweder produktiv verdrahten, klar als Referenz markieren oder aus `main` entfernen.
- [ ] **Worklet-CPU-/Underrun-Budgets im UI ausbauen** – PerformanceMONK zeigt CPU-Budget; Underrun-/Dropout-Zähler und adaptive Puffer-/Energie-Optimierung (Audio-Context-Idle) ergänzen.
- [ ] **Automation-Backpressure prüfen** – Engine-seitiges Throttling/Coalescing für hohe Automation-/Pattern-Raten (nicht nur Netz-Coalescing in WebRTCManager).
- [ ] **Optionale Synthese-/DSP-Bausteine (Backlog)** – E-Piano, Phase-Distortion, spektrale Additiv-Steuerung, Mod-Matrix, Reverb-High-Quality/Convolution – erst nach Bedarf, nicht im Produktivpfad erzwingen.

## 2. Hardware / MIDI / Control / Audio-Geräte

> Der Hardware-Ausbau (Mapping-Engine, MIDI-1.0-Vollabdeckung, HID-Report-Parser, OSC-Codec,
> Device-Profile, Hotplug, ControlHub, WebMIDI/HID-Rückkanal) ist laut `docs/HARDWARE_IMPLEMENTATION_2026.md`
> bereits implementiert. Offen sind v. a. echte Gerätetests und die native Integration.

- [ ] **Native Runtime (Rust/cpal) in die Web-App integrieren** – `NativeRuntimeAudioBackend`/IPC existieren als Prototyp, sind aber nicht in den Produktivpfad eingebunden (NOT TESTED). Alternativ klar als Referenz kennzeichnen.
- [ ] **HID-Output-/Feature-Report-Rückkanal generisch implementieren** – aktuell nur Best-Effort-No-op (WebHID-`sendReport`-Pfad ausbauen oder dokumentiert lassen).
- [ ] **Multi-Device-Clocking/Drift mehrerer Audio-Interfaces** – nicht implementiert; nur falls ein echtes Mehrgeräte-Setup geplant ist.
- [ ] **OS-Aggregation real testen** – PipeWire Combine-Sink / macOS Aggregate für Mehrgeräte-Audio dokumentieren und mit echter Hardware verifizieren.

## 3. Live-/Betreiber-/Verifikations-Todos

- [ ] **OPS-Load-Balancer LB11** – 2 App-Knoten, 4-User-E2E (State-Sync, Locking, Main-Stream), Failover-Test.
- [ ] **`docs/LIVE_CHECKLIST_2026-09-02.md` abarbeiten** – Flotte, Browser, Audio/DSP, 4-User, KI/Eval, Security.
- [ ] **Supabase-Live-Abgleich** – Migrationen (inkl. 002) gegen Live-Instanz prüfen, RLS/Indizes bestätigen, Daten sichtbar.
- [ ] **H-1 Socket.io-Stresstest-Session-Pfad** – gültige Session-Tokens/Test-Fixture verwenden, Mehr-User-Pfad gegen Flotte testen.
- [ ] **4-User-Livelauf** – identischer State, Gäste hören Main, Cue separat, Rollenwechsel ohne Audio-Unterbrechung; Pump-/Zipper-Freiheit prüfen.
- [ ] **iPhone/iOS/Android-Test** – Touch-Ziele ≥ 44 px, Safe-Areas, kein Hover-only, Audio-Thread unter WebKit (Sample-Rate/Buffer) prüfen.
- [ ] **USB/Xonar U7** – automatische Geräteauswahl, 2.1-Layout sichtbar, Einstellungen nach Reload stabil.
- [ ] **Latenz-/Jitter-Messungen** – lokal < 15 ms, Netz one-way < 50 ms, 120 BPM/10 min Jitter < 1 ms bzw. < 5 ms zwischen Browsern; 0 Xruns/Dropouts.
- [ ] **2.1-Frequenzanalyse** – Sub < 80–120 Hz, L/R ohne Bass-Einbuße; Testtöne 40 Hz/1 kHz.
- [ ] **Hörproben mit echter Hardware** – MIDI-Out/Clock (TR-8S/Beatstep Pro), DropMONK am laufenden Mix, 4-User-Hörprobe.
- [ ] **Komponenten-Neubau Hardware-Look (Backlog)** – DJM-A9/XONE, MiniMoog/Prophet, TR-808, API/SSL … inkl. Screenshot-Baselines.

## 4. KI / Infrastruktur / Security-Betrieb

- [ ] **Echter LLM-/MOA-Lauf je Plugin** – 100 % Kern-Kommandos, Scores/Dauer/Fehler in Supabase sichtbar; Nightly-CI-Lauf auf GitHub bestätigen.
- [ ] **AI-E2E- und AI-Failure-Suite gegen echte Infrastruktur** – inkl. HF-Endpoint/GPU-Benchmarks (Cold/Warm/VRAM) und INT8-Kalibrierung je Modell.
- [ ] **HF-Endpoint-Secret rotieren** – eigentliche Rotation in HF-/Hetzner-Konsole durchführen.
- [ ] **AI-Docker-Build/GPU-Test lokal ausführen** – als Betreiber-Schritt dokumentiert.
- [ ] **Gate-Verifikation** – keine Secrets im Repo/History (nach OG-1-Fix erneut prüfen), `npm audit` 0, ESLint ohne Errors, CI-Hardening (Actions-SHA) dauerhaft grün halten.

## 5. Doku-/Compliance-Checklisten (bei Änderungen beachten)

- [ ] `docs/LICENSE_EXTERNAL_RESOURCES.md`: kein fremdes Audiomaterial im Repo/Image/Snapshot; keine Presets mit eingebetteten fremden Samples; Attribution für CC-BY-Quellen dokumentieren; neue Fremdressourcen zuerst eintragen.
- [ ] `docs/PGVECTOR_LINT0014.md`: keine `CREATE EXTENSION vector` im `public`-Schema; keine unqualifizierten `public.vector`-Typen; kein angepasstes `search_path`; Datenbank-Backup vorhanden.
