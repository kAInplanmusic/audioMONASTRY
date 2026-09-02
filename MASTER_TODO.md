# MASTERTODO – Offene Punkte (zusammengeführt)

> Stand: 2026-09-02
> Quellen: `audioMONASTRY/MASTER_TODO.md` + `samplemonk/MASTER_TODO.md`
> Legende: `[ ]` offen · `[x]` erledigt → wird nach `TASKDONE.md` verschoben und hier gelöscht.
> Prioritäten: 🔴 Kritisch · 🟠 Hoch · 🟡 Mittel · 🔵 Strategisch

---

## 🎯 Nächste TODOs (in dieser Reihenfolge)

- [ ] **OPS-Snapshot Prüfpunkt**: Flotten-Start (wake→ready) vorher/nachher messen und dokumentieren; Ziel < 90 s bis ready (Live-Messung beim nächsten Flotten-Start)
- [ ] **OPS-Load-Balancer**: Hetzner LB11 erst ab ≥2 App-Knoten (stündlich 0,012 €/h netto, 7,49 €/Monat netto) – aktuell bewusst NICHT
- [ ] **P1-2 Skins (Komponenten)**: Hardware-Look-Komponenten je Plugin (mittlere Priorität nach D8) + `visual.spec.ts`-Screenshot-Tests
- [ ] **P1-4 Scratchpad Prüfpunkt**: Reload/DnD/Clipboard-Roundtrip im Browser verifizieren (Code + Helper-Tests grün)
- [ ] **P2-1/P2-2 Rest**: Resampling-/Filter-Qualität, BPM sample-genau, Multi-User-PLL + Latenz-/Jitter-Prüfpunkte
- [ ] **P2-4 Prüfpunkt**: Performance-Messung zeigt < 70 % CPU (Graph-Validierung + effectNode-Insert sind umgesetzt)
- [ ] **P3-2/P3-3 Rest**: Iterations-Loop + `aiEvaluation.test.ts` je Plugin + Nightly-Eval-Lauf verifizieren

---

## 🟠 OPS – Flotten-Start per Snapshot beschleunigen (2026-09-02)

> Ausgangslage: Der Flotten-Wake baut aktuell pro Knoten das Docker-Image aus
> dem Repo (Dauer: mehrere Minuten). Hetzner-Snapshots kosten ca. 0,01 €/GB/
> Monat (Cent-Beträge) und machen den Start deutlich schneller.
>
> Umsetzung 2026-09-02: Portal-Worker nutzt Rollen-Snapshots, Refresh-Endpoint
> + Auto-Retention sind umgesetzt → TASKDONE. Offen ist nur die Live-Messung.

- [ ] **Prüfpunkt:** Flotten-Start (wake→ready) vorher/nachher messen und dokumentieren; Ziel < 90 s bis ready.

---

## 🟠 OPS – Hetzner Load Balancer (LB11) erst bei Skalierung (2026-09-02)

> Check: Hetzner LB11 ist **stundenbasiert** abgerechnet (Europa netto
> **0,012 €/h**, Deckel **7,49 €/Monat**, 20 TB Traffic inkl., Stand 04/2026).
> Für den aktuellen Betrieb (1× app-1 hinter Cloudflare, max. 4 User/Session)
> macht ein Load Balancer **keinen** Sinn – Cloudflare übernimmt Edge/TLS und
> die Session läuft auf genau einem Knoten. Sinnvoll wird er erst bei
> horizontaler Skalierung auf **≥ 2 App-Knoten**.

- [ ] **Trigger definieren:** LB11 erst installieren, wenn ≥ 2 App-Knoten laufen (Multi-Session, > 4 User/Session oder HA/Zero-Downtime-Deploys).
- [ ] **Architektur:** Cloudflare → Hetzner LB11 (sticky WebSocket-Sessions) → app-1/app-2; Socket.io-Räume über Redis-Adapter teilen (`REDIS_URL`), Mediasoup/SFU nur auf dediziertem Knoten.
- [ ] **Kosten dokumentieren:** 0,012 €/h netto bzw. 7,49 €/Monat netto (LB11, Europa, Stand 04/2026); stündlich → nur zahlen, solange er existiert.
- [ ] **Prüfpunkt:** 2 App-Knoten hinter LB, 4-User-E2E grün (State-Sync, Locking, Main-Stream stabil); Failover-Test (ein Knoten weg).

---

## 🟠 P1 – HOCH: MONK-Ausbau (2026-09-01)

### NEW-MONK-1 drumMONK – Sequencer vervollständigen (TR-8S)

- [x] 32 Steps, A/B-Pattern + Chain, Flam/Roll, Swing (MasterClock) → TASKDONE.
- [ ] MIDI-Out/Clock-Ausgabe (Hardware).

### NEW-MONK-2 samplerMONK – Sequencer ergänzen

- [x] 16-Step-Sequencer je Pad + Quantize → TASKDONE.
- [x] 32 Steps, Bänke, Pitch/Slice pro Step.

### NEW-MONK-3 mcpMONK – MPC + Sequencer voll ausbauen

- [x] Sample je Pad (Library-DnD), 16-Level-Velocity, Note Repeat, Bank A–D, 16/32-Step-Sequencer mit Swing, Audio-Routing auf MAIN via mixerMONK.

### NEW-MONK-4 synthMONK – Synth + Sequencer + Pads

- [x] 16-Step-Notensequencer → TASKDONE.
- [ ] Pads-Synth-UI im Minilogue-Stil, Beatstep-Pro-MIDI-Profil.

### NEW-MONK-5 instrumentMONK – Spiel-UI

- [x] Pad-/Klavier-Eingabe als Standard-Spielansicht → TASKDONE.
- [ ] Echtbild-UI mit Touch (spielbares Instrumentenbild, GarageBand-artig) je Instrument.

### NEW-MONK-6 biblioMONK – Semantik & Auto-Save

- [ ] Server-seitige semantische Suche (Embeddings/Supabase); neu erzeugtes Audio/Stems/Presets automatisch in die Library speichern.

### NEW-MONK-7 spatialMONK

- [x] komplett erledigt inkl. WASM-FFT-HRTF → siehe TASKDONE.md

### NEW-MONK-8 MONASTRYmasterclock (unsichtbares Systemmodul)

- [x] Singuläre Timing-Quelle (clockProcessor-Worklet), BPM/Start/Stop/Swing systemweit; Latenz-Management (Lookahead 8–15 ms, adaptive Puffergröße bei Xruns); Dropout-/Soundfehler-Prävention (NaN/Inf-Guards, Silence-Gate, Watchdog mit Auto-Recovery); Multi-User-Sync (Host-Clock + PLL); Diagnose nur in perfMONK.

---

## 🔴 P0 – KRITISCH: Stabilität, Signalfluss, Start-Zustand

### P0-1 Start-Zustand „Kein Plugin offen" + Mixer-Sonderfall entfernen

- [x] **Prüfpunkt:** E2E „Studio betreten" → 0 ModuleContainer sichtbar, alle Grid-Icons gedimmt, Main-RMS < -60 dBFS, kein aiMONK/Mixer-Terminal.

### P0-3 Plugin-Terminals: Close-Button + State-Synchronisation

- [x] **Prüfpunkt:** Plugin im Terminal auf OFF stellen → Grid-Icon dunkel, Audio weg, Lock frei; Reload → Zustand bleibt wie gespeichert (bzw. Start-OFF-Regel P0-1).

### P0-4 Rauschen auf Main beseitigen

- [ ] NaN/Inf-Guards an Master-Kette prüfen (bereits vorhanden, aber erneut durch `goldenAudio`-Test mit allen Worklets).
- [ ] **Prüfpunkt:** 60 s Dauerlauf ohne aktives Plugin → RMS ≤ -60 dBFS; mit aktivem Sequencer → nur erwartete Steps hörbar.

### P0-6 Main-/Monitor-Routing & Mehrbenutzer-Fix

- [ ] **Prüfpunkt:** 4-User-E2E: User2 aktiviert Drum → auf MAIN hörbar; User3 wählt PLUGIN-Cue → hört nur sein Plugin, MAIN bleibt unverändert; zurück auf MAIN → sofort Gesamtmix.

### P0-7 Master-Player fest oben mit Transport

- [x] **Prüfpunkt:** Scroll-Position egal → Play/Stop erreichbar; E2E Keyboard-Space + Button funktionieren.

---

## 🟠 P1 – HOCH: UX/UI/GUI, Cross-Platform, Bibliothek, Zwischenspeicher

### P1-1 Responsive Shell für iOS/Android/Windows/Linux/macOS

- [x] Touch: Zielgrößen ≥ 44 px, `touch-action`, Safe-Area-Insets (`env(safe-area-inset-*)`), kein Hover-only, verhindere Zoom bei Doppeltipp, Pointer-Events für Knobs/Fader auf Touch testen.
- [x] Plattform-Matrix: Chromium (Win/Linux/macOS/Android), Safari (iOS), Firefox (Desktop) – dokumentiert in `docs/HARDWARE_TEST_MATRIX_2026.md` (2026-09-02).
- [x] **Prüfpunkt (automatisiert):** Playwright-Responsive-Tests (iPhone SE/14, Pixel 7, Desktop 1920) grün – 9 Tests, Chromium + Firefox (2026-09-02).
- [ ] **Prüfpunkt (manuell):** iPhone-Test vor Ort (UI nicht persistent, Panels schließbar).

### P1-2 High-End-Klassiker-Skins pro Plugin

- [ ] `mixerMONK` (MischpultTerminal) im Stil Pioneer DJM-A9 / Allen & Heath XONE; farbliche Kanal-Accents, Fader/Knobs wie Hardware.
- [ ] `synthesizerMONK` im Stil klassischer Analog-Synths (MiniMoog/Prophet/ Juno), `drumMONK` TR-808/Dirtywave M8, `eqMONK` API/SSL, `masteringMONK` TC/Massey, `spatialMONK` 3D-Panner wie High-End-Controller.
- [x] Design-Tokens zentral in `index.css` (`--monk-*`) erweitern; keine plugin-lokalen Hex-Werte-Duplikate → `src/utils/pluginTheme.ts` + `.monk-theme-*`-Klassen (21), angewandt in `ModuleContainer`/`RackRow`/`PluginButton`, Tests `tests/pluginTheme.test.ts`.
- [ ] **Prüfpunkt:** Screenshot-Tests (`visual.spec.ts`) für alle 21 Plugins; Vergleich mit Referenz-Hardware-Look.

### P1-3 Einstellungen & Geräte-Defaults

- [x] `bufferHint`/`sampleRate` tatsächlich anwenden (AudioContext-Optionen, siehe P2-1).
- [ ] **Prüfpunkt:** USB-Gerät angeschlossen → wird automatisch ausgewählt; Einstellungen nach Reload stabil; 2.1 sichtbar.

### P1-4 Session-Zwischenspeicher (Scratchpad) + Drag & Drop + Clipboard

- [x] `SessionScratchpad` in IndexedDB: Button im Header „ZWISCHENSPEICHER" mit eigener Farbe (z. B. amber/orange) zum Ein-/Ausschalten; speichert Session-Snapshot (Patterns, BPM, Mixer, Plugin-States, Routing).
- [x] Drag & Drop: Einträge/Plugins/Tracks in den Scratchpad-Bereich ziehen; aus dem Scratchpad per Drop auf ein Plugin/Modul laden → `SessionScratchpadPanel` (Overlay-Sidebar, D9), Drag-Handle in `RackRow` (`MONK_DRAG_MIME`), Drop aufs Modul (`MONK_SCRATCH_MIME`), IndexedDB-Einträge.
- [x] Jedes Plugin (ModuleContainer) bekommt „⧉ In Zwischenablage senden": kopiert Plugin-State/Preset/Config als JSON in die Zwischenablage → `RackRow`-Copy (voller Snapshot via `buildSessionSnapshot`) + `ModuleContainer`-Prop `onCopyToClipboard`.
- [ ] **Prüfpunkt:** Speichern/Laden überlebt Reload; DnD funktioniert; Clipboard-Roundtrip (Copy → Paste) liefert gültiges JSON → Helper-Tests grün (`tests/sessionScratchpad.test.ts`); Browser-Verifikation offen.

### P1-5 Lieder-Datenbank automatisch sortieren

- [x] Sortier-/Gruppierungs-Test (`tests/musicLibrarySorted.test.ts`) → TASKDONE.

### P1-6 Key-/MIDI-Handling optimieren

- [ ] MIDI: F8-Clock, Start/Stop/Continue, Song Position, SysEx-Empfang, RPN-Parser, `send()` für LEDs/Motorfader (bereits teils vorhanden, verdrahten).
- [ ] **Prüfpunkt:** Keyboard-E2E + MIDI-Codec-Tests grün; kein Hotkey bricht Eingabefelder.

---

## 🟡 P2 – MITTEL: Latenz, Qualität, Clock, Signalfluss

### P2-1 Latenz & Audio-Qualität

- [x] `AudioSettings`-Optionen wirklich anwenden: `latencyHint`, Sample-Rate, Puffergröße beim Context-Aufbau (`audioContextFactory`) → `resolveAudioContextOptions`/`createConfiguredAudioContext` + `applyLatencyProfile` (TASKDONE).
- [x] Lookahead von 25 ms auf adaptiven Wert (8–15 ms) senken; Scheduling zunehmend über `clockProcessor`/Worklet statt `setTimeout`.
- [x] End-to-End-Latenz persistieren und im `PerformanceMonitorTerminal` anzeigen (bestehende Telemetrie nutzen); Ziel lokal < 15 ms, Netz < 50 ms → Anzeige LOCAL/NET(RTT)/DROPOUTS im Terminal; Persistenz via 30s-Telemetrie in `App.tsx`.
- [ ] Qualität: Resampling-Strategie prüfen, hochwertige Filter für EQ/Master, keine hörbaren Zipper (generische Worklet-Rampen).
- [ ] **Prüfpunkt:** Latenz-Messung vorher/nachher; `goldenAudio`-Tests ohne Artefakte; Dropout-Zähler bleibt 0 im Normalbetrieb.

### P2-2 Clock prüfen & synchronisieren

- [x] `clockProcessor`, `ClockSync`, `PhaseLockedLoop` auditen; eine einzige Timing-Quelle festlegen (Worklet-Clock) → `masterClock.attach(audioEngine)` in `audioEngine.init()`, `getClockDiagnostics()`, Audit-Modul `src/core/clock/clockAudit.ts` + Tests `tests/clockAudit.test.ts`.
- [ ] BPM-Wechsel sample-genau; 16/32-Step-Wechsel ohne Timing-Sprung.
- [ ] Multi-User-Clock-Sync: Host-Clock wird an Gäste verteilt, Drift- Kompensation (PLL).
- [ ] **Prüfpunkt:** 120 BPM, 10 min Lauf: Jitter < 1 ms; zwei Browser starten gleichzeitig und bleiben < 5 ms zueinander.

### P2-3 2.1-Ausgabe für Main

- [ ] `stereoMode='2.1'`: Master → Crossover (Sub < 80–120 Hz, L/R High-Pass); Sub auf dritten Kanal, falls Gerät 2.1 unterstützt; sonst Sub phantom in L/R mischen (Fallback).
- [ ] Routing in `audioEngine`/`OutputConfig` erweitern; UI-Anzeige im Settings.
- [ ] **Neu (D10):** Ausgabe-Layouts **2.0 / 2.1 / 2.2 / 12.0 / 12.1 / 12.2 / 18.0 / 18.1 / 18.2 / 24.0 / 24.1 / 24.2** unterstützen; aktuell Xonar U7 (7.1) angeschlossen → **reale 2.1 als Standard** hinterlegen.
- [ ] **Prüfpunkt:** Frequenzanalyse: Sub-Kanal enthält < 120 Hz, L/R enthält keine volle Bass-Einbuße; Testton 40 Hz auf Sub, 1 kHz auf L/R.

### P2-4 Signalfluss-/Pipeline-Audit

- [x] `routing.json` gegen echten Audio-Graph validieren (Test: `audioEngine.exportGraphState()` vs. `routing.json`).
- [x] Falschverkabelungen korrigieren (z. B. `bassFilter`/`channel7`-Pfad, `effectNode`-Insert, Monitor-PDC) → `effectNode` wird jetzt in `init()` erzeugt und als fester Insert zwischen `toneShiftTilt` und `eqNode` verdrahtet (`isEffectInsertReady()`); `bassFilter`→`channel7` (Bass-Kette) und Monitor-PDC (paralleler Cue mit Delay) als korrekt verifiziert.
- [x] Bottlenecks: Main-Thread-Scheduler, Tone.js-Node-Anzahl, Worklet-CPU; wo sinnvoll V2-Graph/Worklet-Pfad verwenden → V2-Hybrid (`V2StudioGraph`, NEW-D4-1) vorhanden; Graph-Validierungs-Tests erweitert (`tests/routingValidator.test.ts`: fehlende Nodes/Verbindungen, doppelte Pfade).
- [ ] **Prüfpunkt:** Graph-Validierung grün; kein ungenutzter/doppelter Verbindungs-Pfad; Performance-Messung zeigt < 70 % CPU.

### P2-5 Performance & Rendering

- [ ] `React.memo`/stabile Handler für alle Terminals prüfen (UI-Audit nachziehen); Bundle-Diät (lucide tree-shaken, Tone-Chunks).
- [ ] Worklet-CPU-Budgets im PerformanceMonitor; unter 4-User-Last keine Dropouts.
- [ ] **Prüfpunkt:** Playwright-Stress-Test grün; Bundle < 1,5 MB JS.

---

## 🔵 P3 – STRATEGISCH: KI/MOA/MCP, Prompt-DB, Evaluierung

### P3-1 Datenbank-Migration 002: Systemprompts & Evaluierung

- [ ] **Prüfpunkt:** Daten in Supabase sichtbar (Server-Schritt; Migration idempotent + CRUD-Tests grün → TASKDONE)

### P3-2 MOA/MCP pro Plugin anlernen, prompten, iterieren

- [x] Prompt-Bibliothek je Plugin (21 Plugins): Systemprompt (Rolle, Kontext, Parameter, Routing-Ziel, erlaubte Aktionen), Few-Shot-Beispiele (deutsche Kommandos), Fehlerbehandlung.
- [x] `pluginCommandRegistry` auf alle 21 IDs erweitert und mit `PluginAudioRouter` verbunden (Aktivierung, Routing, Parameter) → generische `activate`/`deactivate`/`route`-Kommandos je ID, neue Kern-Kommandos für masterplayer/sound/drop/ai, `mixer.channel`; Tests `tests/pluginCommandRegistry.test.ts`.
- [x] MCP-Tools serverseitig je Plugin ergänzt (mixer.set_channel, synth.play_note, sequencer.load_pattern, …) in `mcpRuntime.ts`; Permissions READ/WRITE/EXECUTION/DESTRUCTIVE beibehalten → Katalog-Tools je Plugin (`<plugin>.<action>`, WRITE), Aliase + `plugin.command`; Tests `tests/mcpPluginTools.test.ts`.
- [ ] Iterations-Loop: pro Plugin → Prompt-Version anlegen → Eval-Suite laufen lassen → Score → Prompt optimieren → neue Version.
- [ ] **Prüfpunkt:** `aiEvaluation.test.ts` je Plugin; 100 % der Kern-Kommandos werden von MOA korrekt geplant und ausgeführt; Scores in DB.

### P3-3 Evaluierungs-Framework & Regression

- [x] Bestehendes `evaluation.ts` an DB anbinden; `npm run eval:ai` schreibt Ergebnisse nach `ai_evaluations` → `aiPersistence.saveEvaluation`/`saveEvalRun` (Supabase, sonst No-Op) + DB-ready JSON (`test-results/ai-evaluations.json`, `ai-eval-runs.json`); 21 Plugin-Cases.
- [x] Nightly-CI: Eval-Run je Plugin, Report in `ai_eval_runs`, Gate bei Score-Abfall → `nightly.yml` um `npm run eval:ai` + Artifact-Upload erweitert; FAIL → Exit 1.
- [ ] **Prüfpunkt:** CI grün; Report enthält je Plugin Score, Dauer, Fehler.

---

## 🔴 AUD-P – Maßnahmen aus dem Audit-Run (2026-08-31)

### Priorisierte Maßnahmen (aus dem Audit-Lauf abgeleitet)

- [ ] **AUD-P0-1** `audioEngine`-Plugin-Lifecycle: OFF = Signalkette trennen, Synths/Worklets lazy erzeugen (verknüpft: P0-2, AUD-2/6)
- [ ] **AUD-P0-4** `SynthesizerTerminal` an `audioEngine`/`InstrumentBackend` verdrahten (verknüpft: P0-5, AUD-4)
- [ ] **AUD-P1-3** `database/ai_migration_002.sql`: Prompt-/Eval-Tabellen (verknüpft: P3-1, AUD-8)
- [ ] **AUD-P2-1** Testrun-2-Checkliste mit den AUD-Befunden abgleichen (P5-1)

---

## GAP – Vollständigkeits-Analyse & Vervollständigung (2026-08-31)

### GAP-3 Atomarer Plugin-Audit – alle 21 Plugins einzeln

- [x] **Prüfpunkt:** Jedes Plugin hat mindestens einen Test (Unit oder E2E), der Aktivierung → Routing → Deaktivierung abdeckt → `tests/pluginAudit.test.ts`, TASKDONE.

### GAP-4 Sicherheitslücken-Audit vervollständigen

- [ ] Server-seitiges RBAC durchsetzen (Host/Admin/DJ/Producer/Engineer/Guest)
- [ ] Locking an User-ID statt Socket-ID server-seitig absichern
- [ ] HF-Token-Rotation dokumentiert ✅ – **Endpoint-Secret rotieren** (Betreiber-Schritt, offen)
- [ ] Pen-Test `/api/ai/*` (Auth, Rate-Limit, Input-Validierung, SSRF)
- [ ] Supabase RLS prüfen (Prompts/Evals: anon read, service_role write)
- [ ] **Prüfpunkt:** Security-Checkliste aus `docs/SECURITY_AUDIT.md` ist vollständig abgehakt oder hat einen offenen Task

### GAP-5 Prompt-/Trainings-Matrix je Plugin

- [ ] Je Plugin Prompt-Version in `system_prompts` (DB) anlegen
- [ ] Je Plugin Eval-Suite (`ai_evaluations`) mit Mindest-Score definieren
- [ ] Iterations-Loop: Prompt → Eval → Score → Optimierung → neue Version
- [ ] **Prüfpunkt:** Jedes Plugin hat ≥ 1 Eval-Datensatz und ≥ 1 Score in der DB; Score-Abfall blockiert Release (G13)

### GAP-8 Zentrales Fehler-Register

- [x] `src/utils/ErrorRegister.ts` + `tests/errorRegister.test.ts` → TASKDONE.

---

## FA-P – Maßnahmen aus dem Fremdaudit

### Priorisierte Maßnahmen aus dem Fremdaudit

- [x] **FA-P0-2** `model_manager.py`: Instanz-Cache + injizierbarer Loader + VRAM-Tracking → TASKDONE.
- [x] **FA-P2-2** Regressionstests für FA-1/FA-4 (repository + revision aus Manifest) → `tests/modelRegistry.test.ts`, TASKDONE.

---

## AM-E – AUDIOMORPH-Atomar-Analyse (Ebene 1–6)

### Ebene 1 – Atomare Code-Analyse (Hot-Paths)

- [x] **AM-E1-3** `masteringProcessor`: dB→Gain-Lookup statt `Math.pow(10, -grDb/20)` pro Sample → TASKDONE.
- [x] **AM-E1-7** Float-Präzisions-Audit DSP: Denormal-/NaN-Guards in `dspProcessor.filterZ` ergänzt → TASKDONE.

### Ebene 2 – Multi-Plugin-Orchestrierung

- [x] **AM-E2-1** `src/core/pluginAudioRouter.ts` (geplant in P0-2): zusätzlich Isolation-Level definieren – pro Plugin Audio-Quelle, Insert/Send-Bus, Crash-Containment (SafeModuleBoundary ≠ Audio-Isolation), Staggered Recovery (< 50 ms).
- [x] **AM-E2-2** Inter-Plugin-Kommunikation: aktuelle `window.dispatchEvent(new CustomEvent('monk:*'))`-Steuerung (z. B. `pluginCommandRegistry.ts`) messen (Latenz, Event-Flooding) und durch typisierten Control-Bus/Event-Bus ersetzen; kein JSON über `CustomEvent` im Audio-Pfad.
- [ ] **AM-E2-3** Parameter-Automation-Smoothing: vorhandene Rampen (AM-E1-2) auf z-transform-Stabilität prüfen; für alle Worklets einheitliches `automate`-Muster ohne Allokationen.

### Ebene 3 – Multiuser-Echtzeit-Architektur

- [ ] **AM-E3-2** RBAC-Latenz: Auth-Check vom Audio-Thread entkoppeln (kein `fetch`/Token-Refresh im Audio-Pfad); Berechtigungs-Cache mit Lease.
- [x] **AM-E3-3** Konkurrierende Edit-Resolution: LWW-CRDT-Fuzz-Test (4 User × 1000 Edits) + CrdtClockMerger-Init-Fix → `tests/clock.test.ts`, TASKDONE.
- [ ] **AM-E3-4** Netzwerk-Jitter-Kompensation: SFU/WebRTC-Pfad um adaptiven Jitter-Buffer erweitern (aktuell nur Opus + Standard-JitterBuffer); QoS-Tagging für Audio-Pakete dokumentieren.
- [x] **AM-E3-5** Prioritäts-Inversion: `WebRTCManager`-DataChannel-State-Sync (~60 Hz) darf den Audio-Thread nicht blockieren; Messung `audioEngine.getAudioHealth()` während State-Bursts.

### Ebene 4 – High-Quality DSP-Kernel

- [ ] **AM-E4-1** Sample-Raten-Konvertierung: Browser macht SRC unsichtbar; für native Runtime Polyphase/Farrow-Struktur spezifizieren (`services/audio-runtime`), 44.1↔48 kHz Roundtrip-Test.
- [ ] **AM-E4-2** FFT/iFFT: aktuell keine eigene FFT im Audio-Pfad; wenn Spektral-Features kommen, cache-oblivious Mixed-Radix evaluieren (kein Naive-DFT).
- [ ] **AM-E4-3** Biquad-Stabilität: `dspProcessor.setLowpass()` (TF2/DF1-Mischung) auf Koeffizienten-Sprung bei `freq=0`/`freq=sampleRate/2` prüfen; Denormal- Guards für `filterZ`; einheitliche DF1-Implementierung.
- [ ] **AM-E4-4** Dynamik-Prozessoren: `masteringProcessor` Lookahead 5 ms + True- Peak-Approximation validieren (Golden-Audio-Referenz); Release-Kurve als segmentierte Lookup-Tabelle statt `Math.exp`-Koeffizient je Block.
- [ ] **AM-E4-6** Oversampling: aktuell nur 2×-True-Peak-Schätzung linear; für Sättigung (Soft-Clipper) Half-Band-Oversampling evaluieren (Qualität vs. CPU).
- [ ] **AM-E4-7** SIMD/NEON/AVX: im Browser nicht direkt verfügbar; native Runtime (Rust) mit `std::simd`/`wide`-Crates vorbereiten; JS-Worklets auf Block-Verarbeitung (128 Samples) optimieren, damit V8 auto-vektorisieren kann.

### Ebene 5 – Sandbox-Simulation & Stress-Testing

- [ ] **AM-E5-1** `tests/e2e/stress.spec.ts` erweitern: 256 simulierte Plugin-Instanzen (UI-State + Worklet-Budget) unter 95 % CPU-Last messen (Ziel: < 80 % CPU, 0 Xruns).
- [ ] **AM-E5-2** Memory-Pressure-Test: OOM-Prophylaxe (IndexedDB/largeStore, Sample-Cache) mit 2-GB-Limit simulieren; Memory-Leak-Detection über `performance.memory`/Heap-Snapshots.
- [ ] **AM-E5-3** Race-Condition-Fuzzing: `PluginManagerContext`, `LockManager`, `stateReplication` mit Thread-Interleaving-Explosion testen (Property-Based / Vitest-Injection).
- [ ] **AM-E5-4** Real-Time-Deadline-Test: Xrun-/Dropout-Zähler (`analyzerProcessor`) als Gate: 0 Dropouts/24 h bei 4-User-Last; CI-Langtest (Nightly) anstoßen.
- [ ] **AM-E5-6** Cross-Platform-Divergenz: Worklet-Verhalten in Chromium/ Firefox/WebKit + iOS/Android testen (Sample-Rate, Buffer, `setSinkId`).

### Ebene 6 – Lebendige Selbstevolution

- [ ] **AM-E6-1** Kontinuierliches Profiling: `PerformanceMonitorTerminal` + `/api/telemetry` um Worklet-CPU-Budgets, Per-Sample-Allokationen, Xrun-Histogramm erweitern; perf/VTune nur für native Runtime dokumentieren.
- [ ] **AM-E6-2** Adaptive Puffergrößen: `bufferHint`/`latencyHint` nicht nur speichern, sondern tatsächlich beim Context-Aufbau anwenden und bei Xruns automatisch erhöhen (Latenz vs. Durchsatz).
- [ ] **AM-E6-4** Selbstlernende Parameter-Vorhersage: MOA/MCP-Historie (`MoaHistory`, `ai_evaluations`) als Datensatz für Automation-Vorschläge nutzen (ML optional; zunächst heuristisch).
- [ ] **AM-E6-5** Energie-Optimierung: Audio-Context nur bei Bedarf aktiv, Worklet-Idle-Detection, Display-Sleep-Verhalten auf iOS/Android testen.
- [ ] **AM-E6-6** A/B-Validierung: für kritische DSP-Änderungen Golden-Audio (`tests/goldenAudio.test.ts`) als Regressions-Gate; jede Optimierung mit vorher/nachher-Messung in MASTER_TODO dokumentieren.

---

## NEW-D – Tasks aus Entscheidungen (D1–D23)

### Neue Tasks aus den Entscheidungen

- [x] **NEW-D4-1** V2-AudioGraph: `V2StudioGraph` (Source→Gain→Pan→MasterSum, 8 Kanäle, NaN/Soft-Clip), `MasterSumNode`, Hybrid-Anbindung an `audioEngine` (`renderV2Block`, `syncV2FromV1`), Tests `tests/v2AudioGraph.test.ts` → TASKDONE.

---

## AI-Infrastruktur – aus AITodo.md übernommen (GAP-2)

> Offene Punkte aus der archivierten `AITodo.md` (2026-09-01 übernommen).

- [x] **AI-Rate-Limits:** `src/config/aiRateLimits.ts` + Server-Verdrahtung + `tests/aiRateLimits.test.ts` → TASKDONE.
- [x] **AI-Supabase-Persistenz-Tests:** Gemockte Tests für `ai_sessions`/`ai_jobs`/`ai_errors` → `tests/aiPersistence.test.ts`, TASKDONE.
- [ ] **AI-E2E-Szenario:** Wake→Cold-Start→Load→Request→Switch→Scale-to-Zero als automatisierter Test (aus AITodo Phase 24–26)
- [ ] **AI-Failure-Suite:** HF offline, GPU down, Duplicate, Crash automatisieren (aus AITodo Phase 24–26)
- [ ] **AI-GPU-Benchmarks:** Cold/Warm/VRAM-Messwerte sobald Endpoint läuft (aus AITodo Phase 21/22/23, blockiert)
- [ ] **AI-Docker-Build/GPU-Test:** Lokaler GPU-Test offen; CI baut/pusht Image automatisch (aus AITodo Phase 2, blockiert)
- [ ] **Warm-Keep-Option:** Selten genutzte Fenster ohne Kaltstart (aus AITodo LOW PRIORITY)
- [ ] **INT8-Kalibrierung:** Je Modell vorab messen (aus AITodo OPTIONAL OPTIMIZATIONS)
- [ ] **Modell-Splitting:** Bei dauerhafter Überlast, erst mit Freigabe (aus AITodo OPTIONAL OPTIMIZATIONS)

---

## Hinweis für die Zukunft

Erledigte Aufgaben werden **nicht** hier abgehakt, sondern nach
`TASKDONE.md` verschoben und aus dieser Datei gelöscht.

