# MASTERTODO – Offene Punkte (zusammengeführt)

> Stand: 2026-09-02
> Quellen: `audioMONASTRY/MASTER_TODO.md` + `samplemonk/MASTER_TODO.md`
> Legende: `[ ]` offen · `[x]` erledigt → wird nach `TASKDONE.md` verschoben und hier gelöscht.
> Prioritäten: 🔴 Kritisch · 🟠 Hoch · 🟡 Mittel · 🔵 Strategisch
> **Hardware-Spezialfälle** (>5 User-Geräte, >4.2-Layouts, MIDI-Controller/Interfaces/USB-Mischpulte) liegen in **`SPECIAL_TODO.md`**.

---

## 🎯 Nächste TODOs (in dieser Reihenfolge)

- [x] **NEW-MONK-1 MIDI-Out/Clock**: drumMONK sendet 24-PPQN-Clock, Transport und Noten an externe Hardware → TASKDONE.
- [x] **[DSP][EFFECTS] Echtzeit-Dynamik**: Kompressor + Gate + Dynamic EQ als Worklet-Insert → TASKDONE.
- [x] **OPS-Snapshot Prüfpunkt**: Flotten-Start (wake→ready) gemessen: ohne Snapshot ≈ 8,2 min, mit Snapshot **72,4 s (< 90 s ✅)** → TASKDONE.
- [ ] **OPS-Load-Balancer Prüfpunkt (Live):** 2 App-Knoten hinter LB11, 4-User-E2E grün (State-Sync, Locking, Main-Stream stabil), Failover-Test. Architektur/Kosten dokumentiert in `docs/SERVER_FLEET.md`.
- [ ] **P1-2 Skins (Komponenten)**: Hardware-Look-Komponenten je Plugin (mittlere Priorität nach D8). Screenshot-Baselines (`visual.spec.ts`) für alle 21 Plugins vorhanden.
- [ ] **P1-4 Scratchpad Prüfpunkt (Browser-Live):** Speichern/Laden überlebt Reload; DnD funktioniert; Clipboard-Roundtrip (Copy → Paste) liefert gültiges JSON. Code + Helper-Tests grün (`tests/sessionScratchpad.test.ts`).
- [ ] **P2-1/P2-2 Rest (Live + Code):** Resampling-/Filter-Qualität, BPM sample-genau, Multi-User-PLL + Latenz-/Jitter-Prüfpunkte.
- [ ] **P2-4 Prüfpunkt (Live):** Performance-Messung zeigt < 70 % CPU (Graph-Validierung + effectNode-Insert sind umgesetzt).
- [x] **P3-3 Prüfpunkt**: Eval-Lauf grün, Report je Plugin mit Score, Dauer und Fehler (`npm run eval:ai` → `test-results/ai-eval-report.json/.md`, Gate aus `src/core/ai/orchestrator/evalMatrix.ts`, Nightly-Artefakt + Job-Summary) → TASKDONE. Offen bleibt nur die Bestätigung des nächtlichen CI-Laufs auf GitHub (Betreiber-Schritt).
- [ ] **Live-Prüfpunkte:** `docs/LIVE_CHECKLIST_2026-09-02.md` abarbeiten (Flotte, Browser, Audio/DSP, 4-User, KI/Eval, Security)

---

## 🟠 OPS – Flotten-Start per Snapshot beschleunigen (2026-09-02)

> Ausgangslage: Der Flotten-Wake baut aktuell pro Knoten das Docker-Image aus
> dem Repo (Dauer: mehrere Minuten). Hetzner-Snapshots kosten ca. 0,01 €/GB/
> Monat (Cent-Beträge) und machen den Start deutlich schneller.
>
> Umsetzung 2026-09-02: Portal-Worker nutzt Rollen-Snapshots, Refresh-Endpoint
> + Auto-Retention sind umgesetzt → TASKDONE. Offen ist nur die Live-Messung.

- [x] **Prüfpunkt:** Flotten-Start (wake→ready) vorher/nachher messen und dokumentieren; Ziel < 90 s bis ready → gemessen 2026-09-02: ohne Snapshot ≈ 8,2 min, mit Snapshot **72,4 s** → TASKDONE.

---

## 🟠 OPS – Hetzner Load Balancer (LB11) erst bei Skalierung (2026-09-02)

> Check: Hetzner LB11 ist **stundenbasiert** abgerechnet (Europa netto
> **0,012 €/h**, Deckel **7,49 €/Monat**, 20 TB Traffic inkl., Stand 04/2026).
> Für den aktuellen Betrieb (1× app-1 hinter Cloudflare, max. 4 User/Session)
> macht ein Load Balancer **keinen** Sinn – Cloudflare übernimmt Edge/TLS und
> die Session läuft auf genau einem Knoten. Sinnvoll wird er erst bei
> horizontaler Skalierung auf **≥ 2 App-Knoten**.

- [x] **Trigger, Architektur & Kosten dokumentiert:** `docs/SERVER_FLEET.md` → Abschnitt „Load Balancer (LB11) – bewusst noch nicht im Einsatz" (Trigger ≥ 2 App-Knoten, Cloudflare → LB11 sticky → app-1/app-2 + Redis-Adapter, SFU/UDP nicht über LB, 0,012 €/h bzw. 7,49 €/Monat netto, stündliche Abrechnung) → TASKDONE.
- [ ] **Prüfpunkt (Live):** 2 App-Knoten hinter LB, 4-User-E2E grün (State-Sync, Locking, Main-Stream stabil); Failover-Test (ein Knoten weg).

---

## 🟠 P1 – HOCH: MONK-Ausbau (2026-09-01)

### NEW-MONK-1 drumMONK – Sequencer vervollständigen (TR-8S)

- [x] 32 Steps, A/B-Pattern + Chain, Flam/Roll, Swing (MasterClock) → TASKDONE.
- [x] MIDI-Out/Clock-Ausgabe (Hardware): `src/core/hardware/midiClockOut.ts` (24 PPQN, Start/Stop/Continue, Song Position, GM-Note-Out, All-Notes-Off), Hook `src/hooks/useMidiClockOut.ts`, Schalter „MIDI OUT" + Portwahl im drumMONK; Tests `tests/midiClockOut.test.ts` → TASKDONE.

### NEW-MONK-2 samplerMONK – Sequencer ergänzen

- [x] 16-Step-Sequencer je Pad + Quantize → TASKDONE.
- [x] 32 Steps, Bänke, Pitch/Slice pro Step.

### NEW-MONK-3 mcpMONK – MPC + Sequencer voll ausbauen

- [x] Sample je Pad (Library-DnD), 16-Level-Velocity, Note Repeat, Bank A–D, 16/32-Step-Sequencer mit Swing, Audio-Routing auf MAIN via mixerMONK.

### NEW-MONK-4 synthMONK – Synth + Sequencer + Pads

- [x] 16-Step-Notensequencer → TASKDONE.
- _Umgezogen nach `SPECIAL_TODO.md`:_ Pads-Synth-UI im Minilogue-Stil + Beatstep-Pro-MIDI-Profil (braucht MIDI-Controller-Hardware).

### NEW-MONK-5 instrumentMONK – Spiel-UI

- [x] Pad-/Klavier-Eingabe als Standard-Spielansicht → TASKDONE.
- [ ] Echtbild-UI mit Touch (spielbares Instrumentenbild, GarageBand-artig) je Instrument.

### NEW-MONK-6 biblioMONK – Semantik & Auto-Save

- [ ] Server-seitige semantische Suche (Embeddings/Supabase); neu erzeugtes Audio/Stems/Presets automatisch in die Library speichern.
- _Umgezogen nach `SPECIAL_TODO.md`:_ Hörprobe mit echter Hardware (TR-8S/Beatstep Pro) – Clock-Lock und Notenzuordnung am Gerät (siehe `docs/HARDWARE_AUDIT_2026.md`).

### NEW-MONK-7 spatialMONK

- [x] komplett erledigt inkl. WASM-FFT-HRTF → siehe TASKDONE.md

### NEW-MONK-8 MONASTRYmasterclock (unsichtbares Systemmodul)

- [x] Singuläre Timing-Quelle (clockProcessor-Worklet), BPM/Start/Stop/Swing systemweit; Latenz-Management (Lookahead 8–15 ms, adaptive Puffergröße bei Xruns); Dropout-/Soundfehler-Prävention (NaN/Inf-Guards, Silence-Gate, Watchdog mit Auto-Recovery); Multi-User-Sync (Host-Clock + PLL); Diagnose nur in perfMONK.

---

## 🔴 P0 – KRITISCH: Stabilität, Signalfluss, Start-Zustand

### P0-1 Start-Zustand „Kein Plugin offen" + Mixer-Sonderfall entfernen

- [x] **Prüfpunkt:** E2E „Studio betreten" → 0 ModuleContainer sichtbar, alle Grid-Icons gedimmt, Main-RMS < -60 dBFS, kein aiMONK/Mixer-Terminal. → Mixer-Sonderfall (Host-Seed `seedHostMixer`) aus `src/App.tsx` entfernt, `audioEngine.init()` startet im Silence-Gate; Prüfpunkt automatisiert in `tests/e2e/startState.spec.ts` (2026-09-03) → TASKDONE.

### P0-3 Plugin-Terminals: Close-Button + State-Synchronisation

- [x] **Prüfpunkt:** Plugin im Terminal auf OFF stellen → Grid-Icon dunkel, Audio weg, Lock frei; Reload → Zustand bleibt wie gespeichert (bzw. Start-OFF-Regel P0-1). → automatisiert in `tests/e2e/pluginCloseSync.spec.ts` (Terminal-OFF, Rack-Power, Reload) (2026-09-03) → TASKDONE.

### P0-4 Rauschen auf Main beseitigen

- [x] NaN/Inf-Guards an Master-Kette prüfen (bereits vorhanden, aber erneut durch `goldenAudio`-Test mit allen Worklets) → Guards vorhanden (AM-E1-7), `goldenAudio`-Suite grün. `fallbackProcessor` zusätzlich mit Sample-Sanitizing (NaN/Inf → 0, Stille bei fehlendem Eingangskanal) gehärtet (2026-09-03) → TASKDONE.
- [x] **Prüfpunkt:** 60 s Dauerlauf ohne aktives Plugin → RMS ≤ -60 dBFS → automatisierter Golden-Test (`tests/goldenAudio.test.ts`, 60 s Stille durch alle Referenz-Worklets) grün; „mit aktivem Sequencer → nur erwartete Steps hörbar" bleibt Live-Hörprobe.

### P0-6 Main-/Monitor-Routing & Mehrbenutzer-Fix

- [x] **Prüfpunkt:** 4-User-E2E: User2 aktiviert Drum → auf MAIN hörbar; User3 wählt PLUGIN-Cue → hört nur sein Plugin, MAIN bleibt unverändert; zurück auf MAIN → sofort Gesamtmix. → Cue-Weg real verdrahtet (`src/core/audio/monitorRouting.ts` + `audioEngine`: per-Kanal-Cue-Abgriff pre-Master, lokaler MAIN-/CUE-Umschalter mit 10-ms-Rampe, MAIN-Bus/Master-Stream unangetastet); automatisiert durch `tests/monitorRouting.test.ts` (4-User-Matrix + „MAIN unverändert"-Beweis über `exportGraphState`) und `tests/e2e/monitorCue.spec.ts` (Chromium, Cue-Gains auf Web-Audio-Ebene) → TASKDONE. Reine Hörprobe im 4-Browser-Livelauf bleibt in `docs/LIVE_CHECKLIST_2026-09-02.md`.

### P0-7 Master-Player fest oben mit Transport

- [x] **Prüfpunkt:** Scroll-Position egal → Play/Stop erreichbar; E2E Keyboard-Space + Button funktionieren. → defekten Smoke-Prüfpunkt repariert (Heading `masterplayerMONK`, BPM-Assertion) + neuer Sticky-/Scroll-Test `tests/e2e/masterPlayerFixed.spec.ts` (2026-09-03) → TASKDONE.

---

## 🟠 P1 – HOCH: UX/UI/GUI, Cross-Platform, Bibliothek, Zwischenspeicher

### P1-1 Responsive Shell für iOS/Android/Windows/Linux/macOS

- [x] Touch: Zielgrößen ≥ 44 px, `touch-action`, Safe-Area-Insets (`env(safe-area-inset-*)`), kein Hover-only, verhindere Zoom bei Doppeltipp, Pointer-Events für Knobs/Fader auf Touch testen.
- [x] Plattform-Matrix: Chromium (Win/Linux/macOS/Android), Safari (iOS), Firefox (Desktop) – dokumentiert in `docs/HARDWARE_TEST_MATRIX_2026.md` (2026-09-02).
- [x] **Prüfpunkt (automatisiert):** Playwright-Responsive-Tests (iPhone SE/14, Pixel 7, Desktop 1920) grün – 9 Tests, Chromium + Firefox (2026-09-02).
- [ ] **Prüfpunkt (manuell/Live):** iPhone-Test vor Ort (UI nicht persistent, Panels schließbar, keine Zoom-/Overflow-Probleme; Safe-Area, Touch-Ziele ≥ 44 px).
- [ ] **Prüfpunkt (manuell/Live):** iOS/Android: Touch-Ziele ≥ 44 px, Safe-Areas, kein Hover-only.

### P1-2 High-End-Klassiker-Skins pro Plugin

- [ ] `mixerMONK` (MischpultTerminal) im Stil Pioneer DJM-A9 / Allen & Heath XONE; farbliche Kanal-Accents, Fader/Knobs wie Hardware.
- [ ] `synthesizerMONK` im Stil klassischer Analog-Synths (MiniMoog/Prophet/ Juno), `drumMONK` TR-808/Dirtywave M8, `eqMONK` API/SSL, `masteringMONK` TC/Massey, `spatialMONK` 3D-Panner wie High-End-Controller.
- [x] Design-Tokens zentral in `index.css` (`--monk-*`) erweitern; keine plugin-lokalen Hex-Werte-Duplikate → `src/utils/pluginTheme.ts` + `.monk-theme-*`-Klassen (21), angewandt in `ModuleContainer`/`RackRow`/`PluginButton`, Tests `tests/pluginTheme.test.ts`.
- [x] **Prüfpunkt:** Screenshot-Tests (`visual.spec.ts`) für alle 21 Plugins; Vergleich mit Referenz-Hardware-Look → `visual.spec.ts` deckt jetzt alle 21 Plugins ab (19 Rack-Terminals + masterplayer + aiMONK-Dock) mit committeten Baselines; animierte Bereiche werden maskiert (Canvas/Scroll-Listen/Logs), Toleranz 6 % für animierte Terminals. Hardware-Look-Vergleich bleibt Teil des Komponenten-Neubaus (mittlere Priorität).

### P1-3 Einstellungen & Geräte-Defaults

- [x] `bufferHint`/`sampleRate` tatsächlich anwenden (AudioContext-Optionen, siehe P2-1).
- [ ] **Prüfpunkt (Live):** USB-Gerät angeschlossen → wird automatisch ausgewählt; Einstellungen nach Reload stabil; 2.1 sichtbar (Xonar U7).
- [ ] **Prüfpunkt (Live):** USB-Default: Xonar bevorzugt, sonst erste USB-Karte.

### P1-4 Session-Zwischenspeicher (Scratchpad) + Drag & Drop + Clipboard

- [x] `SessionScratchpad` in IndexedDB: Button im Header „ZWISCHENSPEICHER" mit eigener Farbe (z. B. amber/orange) zum Ein-/Ausschalten; speichert Session-Snapshot (Patterns, BPM, Mixer, Plugin-States, Routing).
- [x] Drag & Drop: Einträge/Plugins/Tracks in den Scratchpad-Bereich ziehen; aus dem Scratchpad per Drop auf ein Plugin/Modul laden → `SessionScratchpadPanel` (Overlay-Sidebar, D9), Drag-Handle in `RackRow` (`MONK_DRAG_MIME`), Drop aufs Modul (`MONK_SCRATCH_MIME`), IndexedDB-Einträge.
- [x] Jedes Plugin (ModuleContainer) bekommt „⧉ In Zwischenablage senden": kopiert Plugin-State/Preset/Config als JSON in die Zwischenablage → `RackRow`-Copy (voller Snapshot via `buildSessionSnapshot`) + `ModuleContainer`-Prop `onCopyToClipboard`.
- [ ] **Prüfpunkt (Browser-Live):** Speichern/Laden überlebt Reload; DnD funktioniert; Clipboard-Roundtrip (Copy → Paste) liefert gültiges JSON → Helper-Tests grün (`tests/sessionScratchpad.test.ts`); Browser-Verifikation offen.

### P1-5 Lieder-Datenbank automatisch sortieren

- [x] Sortier-/Gruppierungs-Test (`tests/musicLibrarySorted.test.ts`) → TASKDONE.

### P1-6 Key-/MIDI-Handling optimieren

- [x] MIDI: F8-Clock, Start/Stop/Continue, Song Position, SysEx-Empfang, RPN-Parser, `send()` für LEDs/Motorfader → Codec (`src/core/hardware/midiCodec.ts`) inkl. Tests deckt alles ab; `midiOut.ts` sendet Pitch-Bend/CC für Motorfader/LEDs; Hardware-Verdrahtung bleibt Live-Check.
- [x] **Prüfpunkt (automatisiert):** Keyboard-E2E + MIDI-Codec-Tests grün; kein Hotkey bricht Eingabefelder → Keyboard-E2E live 2/2, `tests/midiCodec.test.ts` grün; Hotkey-Input-Guard in `App.tsx`.
- [ ] **Prüfpunkt (Live):** Keyboard-E2E (Space, Ctrl/Cmd+1..9, Escape) – kein Hotkey bricht Eingabefelder; MIDI-Codec-Tests grün (Unit-Suite läuft lokal).

---

## 🟡 P2 – MITTEL: Latenz, Qualität, Clock, Signalfluss

### P2-1 Latenz & Audio-Qualität

- [x] `AudioSettings`-Optionen wirklich anwenden: `latencyHint`, Sample-Rate, Puffergröße beim Context-Aufbau (`audioContextFactory`) → `resolveAudioContextOptions`/`createConfiguredAudioContext` + `applyLatencyProfile` (TASKDONE).
- [x] Lookahead von 25 ms auf adaptiven Wert (8–15 ms) senken; Scheduling zunehmend über `clockProcessor`/Worklet statt `setTimeout`.
- [x] End-to-End-Latenz persistieren und im `PerformanceMonitorTerminal` anzeigen (bestehende Telemetrie nutzen); Ziel lokal < 15 ms, Netz < 50 ms → Anzeige LOCAL/NET(RTT)/DROPOUTS im Terminal; Persistenz via 30s-Telemetrie in `App.tsx`.
- [ ] Qualität: Resampling-Strategie prüfen, hochwertige Filter für EQ/Master, keine hörbaren Zipper (generische Worklet-Rampen).
- [ ] **Prüfpunkt (Live):** Latenz-Messung vorher/nachher; `goldenAudio`-Tests ohne Artefakte; Dropout-Zähler bleibt 0 im Normalbetrieb.
- [ ] **Prüfpunkt (Live):** Lokale Roundtrip-Latenz < 15 ms (Ziel < 1 ms Audio-Thread p99.99); Netz-Latenz < 50 ms one-way; 0 Xruns/Dropouts im Normallauf.

### P2-2 Clock prüfen & synchronisieren

- [x] `clockProcessor`, `ClockSync`, `PhaseLockedLoop` auditen; eine einzige Timing-Quelle festlegen (Worklet-Clock) → `masterClock.attach(audioEngine)` in `audioEngine.init()`, `getClockDiagnostics()`, Audit-Modul `src/core/clock/clockAudit.ts` + Tests `tests/clockAudit.test.ts`.
- [ ] BPM-Wechsel sample-genau; 16/32-Step-Wechsel ohne Timing-Sprung.
- [ ] Multi-User-Clock-Sync: Host-Clock wird an Gäste verteilt, Drift- Kompensation (PLL).
- [ ] **Prüfpunkt (Live):** 120 BPM, 10 min Lauf: Jitter < 1 ms; zwei Browser starten gleichzeitig und bleiben < 5 ms zueinander.

### P2-3 2.1-Ausgabe für Main

- [ ] `stereoMode='2.1'`: Master → Crossover (Sub < 80–120 Hz, L/R High-Pass); Sub auf dritten Kanal, falls Gerät 2.1 unterstützt; sonst Sub phantom in L/R mischen (Fallback).
- [ ] Routing in `audioEngine`/`OutputConfig` erweitern; UI-Anzeige im Settings.
- [ ] **Neu (D10):** Ausgabe-Layouts **2.0 / 2.1 / 2.2 / 3.0 / 3.1 / 3.2 / 4.0 / 4.1 / 4.2** unterstützen; Xonar U7 (8 Kanäle, Verstärker max. 6) → **reale 2.1 als Standard** hinterlegen. (Layouts > 4.2: siehe `SPECIAL_TODO.md`.)
- [ ] **Prüfpunkt (Live):** Frequenzanalyse: Sub-Kanal enthält < 120 Hz, L/R enthält keine volle Bass-Einbuße; Testton 40 Hz auf Sub, 1 kHz auf L/R.
- [ ] **Prüfpunkt (Live):** 2.1-Layout: Sub < 80 Hz auf drittem Kanal oder Phantom-Fallback; Output-Layouts 2.0/2.1/2.2/3.x/4.x konfigurierbar. (12.x/18.x/24.x: siehe `SPECIAL_TODO.md`.)

### P2-4 Signalfluss-/Pipeline-Audit

- [x] `routing.json` gegen echten Audio-Graph validieren (Test: `audioEngine.exportGraphState()` vs. `routing.json`).
- [x] Falschverkabelungen korrigieren (z. B. `bassFilter`/`channel7`-Pfad, `effectNode`-Insert, Monitor-PDC) → `effectNode` wird jetzt in `init()` erzeugt und als fester Insert zwischen `toneShiftTilt` und `eqNode` verdrahtet (`isEffectInsertReady()`); `bassFilter`→`channel7` (Bass-Kette) und Monitor-PDC (paralleler Cue mit Delay) als korrekt verifiziert.
- [x] Bottlenecks: Main-Thread-Scheduler, Tone.js-Node-Anzahl, Worklet-CPU; wo sinnvoll V2-Graph/Worklet-Pfad verwenden → V2-Hybrid (`V2StudioGraph`, NEW-D4-1) vorhanden; Graph-Validierungs-Tests erweitert (`tests/routingValidator.test.ts`: fehlende Nodes/Verbindungen, doppelte Pfade).
- [x] **Prüfpunkt (automatisiert):** Graph-Validierung grün; kein ungenutzter/doppelter Verbindungs-Pfad → `validateRoutingAgainstGraph` + neues `findUnusedGraphPaths` (ungenutzte Nodes, unbekannte Endpunkte, doppelte Kanten) in `src/core/routing/validateRouting.ts`, Tests `tests/routingValidator.test.ts` → TASKDONE.
- [ ] **Prüfpunkt (Live):** Performance-Messung zeigt < 70 % CPU.

### P2-5 Performance & Rendering

- [x] `React.memo`/stabile Handler für alle Terminals prüfen (UI-Audit nachziehen); Bundle-Diät (lucide tree-shaken, Tone-Chunks) → letzte Lücke `DropTerminal.tsx` geschlossen, `npm run check:memo` grün und als CI-Gate in `.github/workflows/build.yml` verdrahtet → TASKDONE.
- [ ] Worklet-CPU-Budgets im PerformanceMonitor; unter 4-User-Last keine Dropouts.
- [x] **Prüfpunkt (automatisiert):** Playwright-Stress-Test grün; Bundle < 1,5 MB JS → Stress-Test grün (`npm run test:stress`); Bundle-Diät umgesetzt (zod + axios aus dem Client entfernt, Prompts kompaktiert) → **< 1,5 MB erreicht ✅** (`check:bundle` grün).
- [ ] **Prüfpunkt (Live):** Playwright-Stress-Test grün; Bundle < 1,5 MB JS (aktuell nur Warn-Schwelle; 2.0-MiB-Gate ist grün).

---

## 🔵 P3 – STRATEGISCH: KI/MOA/MCP, Prompt-DB, Evaluierung

### P3-1 Datenbank-Migration 002: Systemprompts & Evaluierung

- [x] Migration 002 idempotent + CRUD-Tests grün (`tests/migrations.test.ts`, `tests/supabaseRls.test.ts`) → TASKDONE.
- [ ] **Prüfpunkt (Betreiber-Schritt):** Daten in Supabase sichtbar (Migration 002: `system_prompts`, `plugin_prompt_versions`, `ai_evaluations`, `ai_eval_runs`).
- [ ] **Prüfpunkt (Betreiber-Schritt):** Supabase RLS prüfen (Prompts/Evals: anon read, service_role write).

### P3-2 MOA/MCP pro Plugin anlernen, prompten, iterieren

- [x] Prompt-Bibliothek je Plugin (21 Plugins): Systemprompt (Rolle, Kontext, Parameter, Routing-Ziel, erlaubte Aktionen), Few-Shot-Beispiele (deutsche Kommandos), Fehlerbehandlung.
- [x] `pluginCommandRegistry` auf alle 21 IDs erweitert und mit `PluginAudioRouter` verbunden (Aktivierung, Routing, Parameter) → generische `activate`/`deactivate`/`route`-Kommandos je ID, neue Kern-Kommandos für masterplayer/sound/drop/ai, `mixer.channel`; Tests `tests/pluginCommandRegistry.test.ts`.
- [x] MCP-Tools serverseitig je Plugin ergänzt (mixer.set_channel, synth.play_note, sequencer.load_pattern, …) in `mcpRuntime.ts`; Permissions READ/WRITE/EXECUTION/DESTRUCTIVE beibehalten → Katalog-Tools je Plugin (`<plugin>.<action>`, WRITE), Aliase + `plugin.command`; Tests `tests/mcpPluginTools.test.ts`.
- [x] Iterations-Loop: pro Plugin → Prompt-Version anlegen → Eval-Suite laufen lassen → Score → Prompt optimieren → neue Version → `src/core/ai/orchestrator/promptIteration.ts` (`runPromptIteration`, `evaluatePromptCoverage`, `optimizePromptContent`), CLI `npm run iterate:prompts` (21 Plugins, 41 Iterationen, 0 nicht konvergiert), Tests `tests/promptIteration.test.ts`, Nightly-Gate.
- [x] **Prüfpunkt (automatisiert):** `aiEvaluation.test.ts` je Plugin; 100 % der Kern-Kommandos werden von MOA korrekt geplant und ausgeführt; Scores in DB → `tests/aiEvaluation.test.ts` plant + führt für alle 21 Plugins das jeweilige Kern-Kommando aus (deterministischer Mock-LLM) und legt Scores im `evaluationStore` ab; Supabase-Pfad via `aiPersistence.saveEvaluation` getestet.
- [ ] **Prüfpunkt (Live):** Echter MOA-LLM-Lauf (DeepSeek) je Plugin – 100 % der Kern-Kommandos werden korrekt geplant und ausgeführt; Scores in Supabase sichtbar.
- [ ] **Prüfpunkt (Live):** Fehlerfall zeigt verständliche Meldung (kein roher Traceback).
- [ ] **Prüfpunkt (Live):** A100/HF-Endpoint bevorzugt; DevSettings „AI Server Shutdown" aktiviert Fallbacks.

### P3-3 Evaluierungs-Framework & Regression

- [x] Bestehendes `evaluation.ts` an DB anbinden; `npm run eval:ai` schreibt Ergebnisse nach `ai_evaluations` → `aiPersistence.saveEvaluation`/`saveEvalRun` (Supabase, sonst No-Op) + DB-ready JSON (`test-results/ai-evaluations.json`, `ai-eval-runs.json`); 21 Plugin-Cases.
- [x] Nightly-CI: Eval-Run je Plugin, Report in `ai_eval_runs`, Gate bei Score-Abfall → `nightly.yml` um `npm run eval:ai` + Artifact-Upload erweitert; FAIL → Exit 1.
- [ ] **Prüfpunkt (Betreiber-Schritt):** CI-Lauf auf GitHub grün; Report enthält je Plugin Score, Dauer, Fehler.

---

## 🔴 AUD-P – Maßnahmen aus dem Audit-Run (2026-08-31)

### Priorisierte Maßnahmen (aus dem Audit-Lauf abgeleitet)

- [x] **AUD-P0-1** `audioEngine`-Plugin-Lifecycle: OFF = Signalkette trennen, Synths/Worklets lazy erzeugen → erledigt durch P0-2 (`pluginAudioRouter`, `activatePlugin`/`deactivatePlugin`, Synth-Worklets lazy).
- [x] **AUD-P0-4** `SynthesizerTerminal` an `audioEngine`/`InstrumentBackend` verdrahten → erledigt durch P0-5 (`ensureSynthGraph`, `previewSynthesizedSample`, Routing-Ziel CH1-8).
- [x] **AUD-P1-3** `database/ai_migration_002.sql`: Prompt-/Eval-Tabellen → Datei vorhanden (idempotent, RLS), Tests grün; Live-Anwendung in Supabase bleibt Betreiber-Schritt (P3-1).
- [x] **AUD-P2-1** Testrun-2-Checkliste mit den AUD-Befunden abgeglichen → `docs/TESTRUN_2_CHECKLIST.md` Abschnitt 11 (AUD-P0-1/P0-4/P1-1/P1-3, GAP-4, GAP-5 je mit Test-Nachweis); automatisiert abgedeckte Punkte sind abgehakt, offen bleiben nur Live-/Hörprobe-Schritte → TASKDONE.

---

## GAP – Vollständigkeits-Analyse & Vervollständigung (2026-08-31)

### GAP-3 Atomarer Plugin-Audit – alle 21 Plugins einzeln

- [x] **Prüfpunkt:** Jedes Plugin hat mindestens einen Test (Unit oder E2E), der Aktivierung → Routing → Deaktivierung abdeckt → `tests/pluginAudit.test.ts`, TASKDONE.

### GAP-4 Sicherheitslücken-Audit vervollständigen

- [x] Server-seitiges RBAC durchsetzen (Host/Admin/DJ/Producer/Engineer/Guest) → erledigt in P4-2 (`server.ts` Rollenzuweisung, PRO nur admin/producer, `assign-role` nur admin).
- [x] Locking an User-ID statt Socket-ID server-seitig absichern → erledigt in P4-2 (Sender-User-ID im Relay, Rollenzuordnung je User-ID, Audit-Log).
- [ ] **Prüfpunkt (Betreiber-Schritt):** HF-Endpoint-Secret rotieren (dokumentiert in `docs/AI_SECURITY_GUIDE.md`).
- [x] Pen-Test `/api/ai/*` (Auth, Rate-Limit, Input-Validierung, SSRF) → `tests/aiSecurityPenTest.test.ts` (11 Fälle, Sentinel-Server ohne Treffer), Ergebnisse in `docs/SECURITY_AUDIT.md` → TASKDONE.
- [x] Supabase RLS geprüft (Prompts/Evals + Samples/Music: anon read, service_role write) → statisches Audit-Gate `tests/supabaseRls.test.ts` über alle `database/*.sql` → TASKDONE.
- [x] **Prüfpunkt (automatisiert):** Security-Checkliste aus `docs/SECURITY_AUDIT.md` vollständig – alle Zeilen ✅, Pen-Test in `npm run verify` → TASKDONE.

### GAP-5 Prompt-/Trainings-Matrix je Plugin

- [x] Je Plugin Prompt-Version in `system_prompts` anlegen → `npm run iterate:prompts` schreibt DB-ready Zeilen (`test-results/system-prompts.json`) und persistiert über `aiPersistence.saveSystemPrompt`/`savePromptVersion`; Gate schlägt an, wenn ein Plugin ohne Prompt-Version bleibt.
- [x] Je Plugin Eval-Suite (`ai_evaluations`) mit Mindest-Score → `src/core/ai/orchestrator/evalMatrix.ts` (21 Plugins, 4.0 bzw. 4.5 für MAIN-kritische Plugins, Laufzeit-Budget), Tests `tests/evalMatrix.test.ts`.
- [x] Iterations-Loop: Prompt → Eval → Score → Optimierung → neue Version → `runPromptIteration` + `npm run iterate:prompts` (21 Plugins, 41 Versionen, 0 nicht konvergiert).
- [x] **Prüfpunkt:** Jedes Plugin hat ≥ 1 Eval-Datensatz und ≥ 1 Score; Score-Abfall blockiert den Nightly-Lauf (Exit 1) → `docs/PLUGIN_PROMPT_MATRIX.md` aus den Reports erzeugt. Das Schreiben in die Live-DB bleibt an P3-1 (Betreiber) gekoppelt → TASKDONE.

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
- [x] **AM-E2-3** Parameter-Automation-Smoothing: vorhandene Rampen (AM-E1-2) auf z-transform-Stabilität prüfen; für alle Worklets einheitliches `automate`-Muster ohne Allokationen → `tests/workletRampAudit.test.ts` (statischer Audit: automate-Handler vorhanden, keine `new Array`/`Math.pow`/unerwartete `.push(` im process-Hot-Path der Automations-Worklets); Rampen-Muster in dsp/eq/effect/mastering vorhanden.

### Ebene 3 – Multiuser-Echtzeit-Architektur

- [x] **AM-E3-2** RBAC-Latenz: Auth-Check vom Audio-Thread entkoppeln (kein `fetch`/Token-Refresh im Audio-Pfad); Berechtigungs-Cache mit Lease → `src/utils/RbacCache.ts` (Lease/Sliding-Window) + Tests (TASKDONE).
- [x] **AM-E3-3** Konkurrierende Edit-Resolution: LWW-CRDT-Fuzz-Test (4 User × 1000 Edits) + CrdtClockMerger-Init-Fix → `tests/clock.test.ts`, TASKDONE.
- [ ] **AM-E3-4** Netzwerk-Jitter-Kompensation: SFU/WebRTC-Pfad um adaptiven Jitter-Buffer erweitern (aktuell nur Opus + Standard-JitterBuffer); QoS-Tagging für Audio-Pakete dokumentieren.
- [x] **AM-E3-5** Prioritäts-Inversion: `WebRTCManager`-DataChannel-State-Sync (~60 Hz) darf den Audio-Thread nicht blockieren; Messung `audioEngine.getAudioHealth()` während State-Bursts.
- [ ] **Prüfpunkt (Live):** 4 Browser sehen identischen State.
- [ ] **Prüfpunkt (Live):** Gäste hören Main via Host-Stream; Cue separat.
- [ ] **Prüfpunkt (Live):** Rollenwechsel ohne Audio-Unterbrechung.

### Ebene 4 – High-Quality DSP-Kernel

- [ ] **AM-E4-1** Sample-Raten-Konvertierung: Browser macht SRC unsichtbar; für native Runtime Polyphase/Farrow-Struktur spezifizieren (`services/audio-runtime`), 44.1↔48 kHz Roundtrip-Test.
- [ ] **AM-E4-2** FFT/iFFT: aktuell keine eigene FFT im Audio-Pfad; wenn Spektral-Features kommen, cache-oblivious Mixed-Radix evaluieren (kein Naive-DFT).
- [x] **AM-E4-3** Biquad-Stabilität: `dspProcessor.setLowpass()` (TF2/DF1-Mischung) auf Koeffizienten-Sprung bei `freq=0`/`freq=sampleRate/2` prüfen; Denormal- Guards für `filterZ`; einheitliche DF1-Implementierung → `src/audio/dsp/biquad.ts` (stabile Lowpass-Koeffizienten an den Rändern) + Tests (TASKDONE).
- [ ] **AM-E4-6** Oversampling: aktuell nur 2×-True-Peak-Schätzung linear; für Sättigung (Soft-Clipper) Half-Band-Oversampling evaluieren (Qualität vs. CPU).
- [ ] **AM-E4-7** SIMD/NEON/AVX: im Browser nicht direkt verfügbar; native Runtime (Rust) mit `std::simd`/`wide`-Crates vorbereiten; JS-Worklets auf Block-Verarbeitung (128 Samples) optimieren, damit V8 auto-vektorisieren kann.

### Ebene 5 – Sandbox-Simulation & Stress-Testing

- [x] **AM-E5-1** `tests/e2e/stress.spec.ts` erweitern: 256 simulierte Plugin-Instanzen (UI-State + Worklet-Budget) unter 95 % CPU-Last messen (Ziel: < 80 % CPU, 0 Xruns) → Stress-Test (21 Plugins, 8000 Pattern-Loads, Play/Stop-Zyklen, FPS/Heap-Messung) läuft grün (`npm run test:stress`); CPU-/Xrun-Messung bleibt Live.
- [ ] **AM-E5-2** Memory-Pressure-Test: OOM-Prophylaxe (IndexedDB/largeStore, Sample-Cache) mit 2-GB-Limit simulieren; Memory-Leak-Detection über `performance.memory`/Heap-Snapshots → Heap-Wachstums-Gate im Stress-Test ergänzt (< 512 MB Delta); volle 2-GB-Simulation bleibt offen.
- [x] **AM-E5-3** Race-Condition-Fuzzing: `PluginManagerContext`, `LockManager`, `stateReplication` mit Thread-Interleaving-Explosion testen (Property-Based / Vitest-Injection) → `tests/lockFuzz.test.ts` (LockManager 4 User × 1000 Ops, Invariante genau ein aktiver Besitzer).
- [ ] **AM-E5-4** Real-Time-Deadline-Test: Xrun-/Dropout-Zähler (`analyzerProcessor`) als Gate: 0 Dropouts/24 h bei 4-User-Last; CI-Langtest (Nightly) anstoßen.
- [ ] **AM-E5-6** Cross-Platform-Divergenz: Worklet-Verhalten in Chromium/ Firefox/WebKit + iOS/Android testen (Sample-Rate, Buffer, `setSinkId`).
- [ ] **Prüfpunkt (Live):** 0 Xruns/Dropouts im Normallauf.

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
- [ ] **AI-E2E-Szenario (Live):** Code-Teil erledigt – `tests/aiE2eScenario.test.ts` fährt Wake→Cold-Start→Load→Request→Switch→Scale-to-Zero gemockt durch → TASKDONE. Offen bleibt der Lauf gegen den echten HF-Endpoint (aus AITodo Phase 24–26).
- [ ] **AI-Failure-Suite (Live):** Code-Teil erledigt – `tests/aiFailureSuite.test.ts` deckt HF offline, GPU down, Duplicate und Crash ab (inkl. Fix des Concurrency-Slot-Lecks im `JobManager`) → TASKDONE. Offen bleibt die Wiederholung gegen die Live-Infrastruktur (aus AITodo Phase 24–26).
- [ ] **AI-GPU-Benchmarks (Live):** Cold/Warm/VRAM-Messwerte sobald Endpoint läuft (aus AITodo Phase 21/22/23, blockiert).
- [ ] **AI-Docker-Build/GPU-Test (CI/Betreiber):** Lokaler GPU-Test offen; CI baut/pusht Image automatisch (aus AITodo Phase 2, blockiert).
- [ ] **Warm-Keep-Option:** Selten genutzte Fenster ohne Kaltstart (aus AITodo LOW PRIORITY).
- [ ] **INT8-Kalibrierung (Live):** Je Modell vorab messen (aus AITodo OPTIONAL OPTIMIZATIONS).
- [ ] **Modell-Splitting:** Bei dauerhafter Überlast, erst mit Freigabe (aus AITodo OPTIONAL OPTIMIZATIONS).

---

## 🎛️ Open-Source Audio Technology Audit (2026-09-03)

> Architektur-Audit des bestehenden MONK-Systems gegen den Katalog
> quelloffener/freier Audio-Instrumente & Tools. **Nur Roadmap, keine Umsetzung.**
> Klassifikation: A = hoher Wert / umsetzen · B = gute Zukunftserweiterung ·
> C = Architektur-Referenz · D = optionale externe Ressource · E = Duplikat ·
> F = inkompatibel · G = Lizenzproblem · H = Reject.

### Klassifikationsübersicht (34 bewertete Projekte)

| Klasse | Projekte |
|---|---|
| A – hoher Wert | Actuate (Granular), LinuxSampler/SFZ-Format, LSP Plugins + ZL Equalizer 2 (Dynamik), Dexed (6-Op-FM/DX7) |
| B – Zukunft | Surge XT (Wavetable), setBfree/Open B3 (Tonewheel/Leslie), RdPiano (EP-Modeling), Hydrogen (Song/Humanize), Geonkick (Drum-Synth), VSCO 2 CE (Orchester CC0), Nakst (Phase Distortion), AudioKit ROMPlayer (EXS/SF2/WAV-Formate) |
| C – Referenz | ZynAddSubFX, Six Sines, LeSynth, JS80P, Helm, amsynth, Grace, HISE, Dragonfly Reverb, Tiagolr Effects, Cardinal, Retromulator, EP-Mk1, MDA Piano, Aeolus, SamplerBox, Just a Sample, Drumlabooh |
| D – extern | BBC SO Discover, Spitfire LABS, Virtual Playing Orchestra, Sonatina Symphonic Orchestra, Berlin Free Orchestra |
| E – Duplikat | Carla (Plugin-Host = MONK-Registry/Rack), FreeEQ8 (12-Band-EQ existiert), Helm/amsynth (subtraktiv existiert), SamplerBox (Player) |
| F – inkompatibel | Cardinal als direkter Modular-Host (widerspricht MONK-Pluginvertrag, GPL, CV/Gate-Ökosystem) |
| G – Lizenz | The Alpine Project (CC-BY-ND), Pacific Percussion (unklar), direkte GPL-Code-Einbettung (Surge XT/Dexed/…) |

### A – Hoher Wert (P1)

- [ ] **[AUDIO][SYNTH] Granular-Engine als neuer Synthese-Modus** (Referenz: Actuate; MONK hat bislang nur „Glitch Granulator" als LFO-Chop, keinen echten Grain-Scheduler).
  - Target: `public/worklets/itSynthProcessor.js` (neuer `kind: 'granular'` bzw. eigener `granularProcessor`), `src/core/instrument/catalog.ts` (`InstrumentDefinition`/`FxDef`), `SynthesizerTerminal`-UI.
  - Integration: Port/Adaption des Algorithmus (Grain-Scheduler, Hüllkurven-Fenster, Position/Density/Pitch/Reverse), KEIN Fremdcode (Actuate-Lizenz prüfen).
  - Wiring: `NoteOn/MIDI → GranularVoice (Worklet) → bestehender Filter → Output-Bus → Kanalzug → MAIN`; Grain-Quelle aus `SampleContext`/OPFS (`src/utils/opfs.ts`) oder `audioEngine.loadTrackSample`.
  - Parameter: grainSize, density, position, positionJitter, pitch, pitchJitter, direction, window, spray, freeze.
  - State/Presets: `InstrumentDefinition`-Schema erweitern; Automation über bestehende `automate`-Rampen des Worklets.
  - Worklet/WASM: AudioWorklet (real-time); Pre-Allocation aller Grain-Puffer, keine Allocs im `process`.
  - Performance: 8–16 aktive Grains/Voice, 16 Voices Polyphonie-Deckel wie bestehend; CPU-Budget < 20 % eines Kerns.
  - License: Actuate-Lizenz prüfen → `LICENSE_REVIEW_REQUIRED`; Algorithmus nativ nachbauen.
  - Dependencies: keine neuen Runtime-Dependencies.
  - Acceptance criteria: Golden-Test mit 1 kHz-Grain reproduzierbar; NaN/Inf-frei; Touch-UI spielbar.

- [ ] **[SAMPLER] SFZ-Parsing + Streaming für samplerMONK/mcpMONK/dropMONK** (Referenz: LinuxSampler, Grace, HISE; SFZ ist ein offenes Format, LinuxSampler-Code ist GPL → nur Format/Algorithmus-Referenz).
  - Target: `src/context/SampleContext.tsx`, `src/utils/opfs.ts`, `audioEngine.loadTrackSample`, `SamplerTerminal`/`McpTerminal`.
  - Integration: Port (SFZ-Parser nativ; OPFS-chunked `decodeAudioData`; Voice-Management nach LinuxSampler-Vorbild: Velocity-Layer, Round-Robin, Key-Ranges).
  - Wiring: `Sample/SFZ → OPFS-File → chunk-decode → AudioBufferSourceNode-Queue → Kanal-Gain → MAIN`; Metadaten in `AudioSample.parameters`.
  - Parameter: rootKey, keyRange, velocityLayer, roundRobin, loopMode, offset, release.
  - State: `AudioSample`-Typ um SFZ-Metadaten erweitern; Presets als JSON.
  - Worklet/WASM: Decode im Worker (`WorkerPool`/`AsyncSandbox`), Playback über bestehende BufferSource-Kette; Disk-Streaming nur für große Dateien.
  - Performance: Speicherbudget (z. B. 64 MB Sample-Cache), LRU-Eviction über OPFS; keine Main-Thread-Decodes.
  - License: SFZ-Format offen; LinuxSampler GPL → kein Code-Embedding.
  - Dependencies: keine neuen; optional `sfz-parser`-Eigenbau.
  - Acceptance criteria: SFZ mit Velocity-Layer/Round-Robin lädt und spielt; Reload-Persistenz; Cache-Eviction-Test.

- [x] **[DSP][EFFECTS] Echtzeit-Dynamik: Kompressor + Gate + Dynamic EQ als Worklet** – umgesetzt in `src/audio/worklets/dynamicsProcessor.ts` (Insert `effectNode`↔`eqNode`, Default = Bypass, kein Lookahead → keine Zusatzlatenz), UI im `DSPTerminal`, Tests `tests/dynamicsProcessor.test.ts` → TASKDONE. Ursprüngliche Spezifikation:
  - **[DSP][EFFECTS] Echtzeit-Dynamik: Kompressor + Gate + Dynamic EQ als Worklet** (Referenz: LSP Plugins, ZL Equalizer 2; MONK hat bislang nur Backend-Mastering/FFmpeg und tanh-Softclip, keinen Echtzeit-Kompressor/Gate).
  - Target: `public/worklets/dspProcessor.js` bzw. neues `dynamicsProcessor.js`; Insert-Punkt `effectNode`↔`eqNode` (`isEffectInsertReady()` in `src/utils/audioEngine.ts`); UI in `FXEngineTerminal`/`DSPTerminal`.
  - Integration: Port der Algorithmen (Detektor mit Smoothing, Knee, Program-Dependency; Gate mit Hysterese; DynEQ = peaking-Filter mit level-abhängigem Gain auf Basis des bestehenden 12-Band-Biquads).
  - Wiring: `Insert → DynamicsProcessor → EQ → … → MASTER`; Sidechain optional aus `pluginAudioRouter`-Kanal.
  - Parameter: threshold, ratio, attack, release, knee, makeup, range, hold (Gate); dynEQ: freq, gain, Q, threshold je Band.
  - State: `ModuleState`-Kontext + Worklet-Messages wie `eqProcessor` (`automate`-Rampen).
  - Worklet/WASM: AudioWorklet; One-Pole-Smoothing, Lookahead nur wenn nötig; keine Allocs.
  - Performance: < 5 % CPU pro Instanz; parameter-ramped, zipper-frei.
  - License: LSP (LGPL/GPL gemischt) → nur Algorithmus-Referenz, eigener Code.
  - Dependencies: keine.
  - Acceptance criteria: Golden-Test (Kompression −20 dBFS Sinus); Gate schließt unterhalb Threshold; DynEQ senkt Resonanz nur bei Pegelüberschreitung.

- [ ] **[SYNTH][MIDI] 6-Operator-FM + DX7-SysEx-Import** (Referenz: Dexed; MONK-FM ist aktuell 2-Op mit `modIndex`).
  - Target: `public/worklets/itSynthProcessor.js` (`kind: 'fm'` auf 6 Op + 32 Algorithmen erweitern), `src/core/instrument/catalog.ts` (`FmDef`), `src/core/instrument/midiProgramMap.ts`, `MIDIControllerTerminal`.
  - Integration: Port/Algo-Referenz (Operator-Architektur, DX7-Envelope-Raten, Feedback, Algorithmen); DX7-SysEx ist ein offenes Format, kein Dexed-Code.
  - Wiring: `MIDI (inkl. SysEx) → 6-Op-Matrix → Filter → Output → MAIN`; Patch-Import über `biblioMONK`/Drop.
  - Parameter: op{1..6}(ratio, level, envR1..R4), algorithm, feedback, lfo.
  - State/Presets: `FmDef`-Schema erweitern; DX7-Patches als JSON-Presets.
  - Worklet/WASM: AudioWorklet; 6 Oszillatoren/Voice pre-allocated.
  - Performance: 16 Voices × 6 Op; < 25 % CPU; DX7-SysEx-Parse im Main-Thread (klein).
  - License: Dexed GPLv3 → kein Code-Embedding; `LICENSE_REVIEW_REQUIRED` nur bei Code-Übernahme.
  - Dependencies: keine.
  - Acceptance criteria: 10 Referenz-DX7-Patches klingen konsistent; SysEx-Import-Roundtrip; Golden-Test.

### B – Gute Zukunftserweiterungen (P2)

- [ ] **[SYNTH] Wavetable-Oszillatoren + Mod-Matrix** (Referenz: Surge XT). Target: `synthProcessor.js`/`itSynthProcessor.js` (neuer `kind: 'wavetable'`), `SynthesizerTerminal`. Integration: Port der Konzepte (Wavetable-Morphing, Mip-Map-Interpolation gegen Aliasing), KEIN GPL-Code. Performance: pre-computed Tables, 2×-Oversampling optional. License: GPL → nur Referenz.

- [ ] **[SYNTH] Tonewheel-Orgel + Leslie-Simulation** (Referenz: setBfree, Open B3). Target: `instrumentMONK`-Katalog (`catalog.ts`, neuer `kind: 'tonewheel'`), `itSynthProcessor.js`. Integration: 9 Drawbars + Keyclick + Percussion + Leslie (Doppler-AM/FM, Rotor-Beschleunigung) nativ. License: GPL → nur Referenz.

- [ ] **[SYNTH] Physical-Modeling E-Piano (Rhodes/Wurlitzer)** (Referenz: RdPiano, EP-Mk1, Retromulator). Target: `instrumentMONK` (`catalog.ts`). Integration: Tine/Fork-Modell bzw. Reed-Modell als nativ berechnete Voice im Worklet. License: Referenz.

- [ ] **[DRUMS] Drum-Synthese mit Transient-Shaping + Song-Mode/Humanize** (Referenz: Geonkick, Hydrogen). Target: `drumMONK` (`DrumMachineTerminal`, `drumKits.ts`), `itSynthProcessor.js` (`kind: 'drum'` erweitern). Integration: Kick mit Pitch-/Amp-Hüllkurven-Segmenten, Noise-Transient-Layer, Click; Pattern-Song-Kette + Velocity-Humanize in `drumKits`/Sequencer. License: Referenz.

- [ ] **[SAMPLER][LIBRARY] Orchestrale CC0-Library bündeln** (Referenz: VSCO 2 Community Edition, CC0). Target: `public/data/`, `SampleContext`/`PRESET_SAMPLE_DATABASE`. Integration: kleine Subset-Auswahl (Strings/Brass/Woodwinds) als OPFS-Presets; Metadaten in `AudioSample`. License: VSCO 2 CE = CC0 (unproblematisch); VPO/Sonatina/Berlin = `LICENSE_REVIEW_REQUIRED`, nicht ungeprüft bündeln.

- [ ] **[SYNTH] Phase-Distortion-Oszillator** (Referenz: Nakst Regency). Target: `synthProcessor.js` (`osc: 'pd'`). Integration: Casio-CZ-artige Phasenverzerrung als Oszillator-Modus. License: Referenz.

- [ ] **[SAMPLER] EXS24/SF2/WAV-ROM-Import-Konzept** (Referenz: AudioKit ROMPlayer). Target: `SampleContext`, `dropMONK`/`biblioMONK`-Import. Integration: Format-Parser als Worker-Task; nur Metadaten-/Mapping-Konzepte. License: Formate offen; ROMPlayer-Code nicht einbetten.

### C – Architektur-Referenzen (P2/P3, keine Integration)

- [ ] **[DSP][SPATIAL] Reverb-Verbesserung: Early-Reflections + Modulationsparameter** (Referenz: Dragonfly Reverb, LSP Reverb). Target: `public/worklets/effectProcessor.js` (Comb-Reverb existiert). Integration: Freeverb-artige Erweiterung um Early-Reflections/Pre-Delay/Damping nativ; kein Fremdcode.

- [ ] **[SYNTH] Spektrale Additiv-Steuerung** (Referenz: ZynAddSubFX, LeSynth, Six Sines). Target: `instrumentMONK` (`catalog.ts`, `itSynthProcessor.js`). Integration: Partial-Morphing, spektrale Hüllkurven pro Partial als Konzept-Erweiterung der bestehenden 50 Additiv-Patches.

- [ ] **[ARCHITECTURE] Mod-Matrix-/CV-Gate-Konzepte prüfen** (Referenz: Cardinal/VCV Rack). Target: `synthesizerMONK`-Modulation, `ModuleState`-Routing. Integration: NUR als UI-/Datenmodell-Referenz für eine interne Mod-Matrix; KEIN Modul-Host (würde MONK-Pluginvertrag widersprechen, GPL).

- [ ] **[SYNTH] Analoge Filter-/Oszillator-Referenzen** (Referenz: Helm, amsynth, JS80P). Target: `synthProcessor.js`-Filter (`src/core/instrument`). Integration: Filterkoeffizienten-/Drift-Konzepte nativ; kein Code (GPL).

### Lizenz-Hinweise (G)

- [x] **[LICENSE] Externe Library-Ressourcen dokumentiert**: `docs/LICENSE_EXTERNAL_RESOURCES.md` (BBC SO Discover, Spitfire LABS, Virtual Playing Orchestra, Sonatina, Berlin Free Orchestra, The Alpine Project (CC-BY-ND), Pacific Percussion, VSCO 2 CE = CC0) – keine Redistribution, keine Derivate aus ND-Material, Abgrenzung zu GPL-Code-Referenzen, Release-Checkliste → TASKDONE.

---

## Zusammenfassung offener Punkte (nach Kategorie)

> Extrahiert aus `COPILOTTODO.md`, `docs/TESTRUN_2_CHECKLIST.md`, `docs/LIVE_CHECKLIST_2026-09-02.md`, `TASKDONE.md`, `docs/HARDWARE_AUDIT_2026.md` und den Audit-Dokumenten.

### Nur Code/Tests (automatisiert umsetzbar)

- Worklet-CPU-Budgets im PerformanceMonitor
- Kontinuierliches Profiling (Worklet-CPU, Per-Sample-Allokationen, Xrun-Histogramm)
- Adaptive Puffergrößen bei Xruns
- Energie-Optimierung (Audio-Context Idle, Display-Sleep)
- Granular-Engine, SFZ-Parsing, 6-Op-FM, Wavetable, Tonewheel, E-Piano, Drum-Synthese, Orchester-Library, Phase-Distortion, EXS24/SF2/WAV-Import-Konzept, Reverb-Verbesserung, Spektrale Additiv-Steuerung, Mod-Matrix-Konzept, Analoge Filter-Referenzen

### Live-/Hardware-/Browser-Prüfpunkte (vor Ort)

- Main-RMS < -60 dBFS (60 s Dauerlauf ohne aktives Plugin)
- iPhone/iOS-Test (Responsive, Panels, Safe-Area, Touch-Ziele)
- USB-Gerät automatisch auswählen; 2.1-Layout sichtbar
- Scratchpad Reload/DnD/Clipboard-Roundtrip
- Latenz-Messung vorher/nachher; 120 BPM / 10 min Jitter < 1 ms; 2-Browser-Offset < 5 ms
- 4-User-Livelauf (Cue/Main, Rollenwechsel, Latenz < 50 ms one-way)
- MIDI-Out/Clock mit echter Hardware (TR-8S/Beatstep Pro) → umgezogen nach `SPECIAL_TODO.md`
- Drop-Hörprobe am laufenden Mix
- 2 App-Knoten hinter LB11 + Failover

### Betreiber-Schritte (externe Konsole/Cloud)

- Migration 002 in Live-Supabase anwenden + RLS-Abgleich
- HF-Endpoint-Secret rotieren
- Nightly-CI-Lauf auf GitHub bestätigen
- Echter DeepSeek/MOA-LLM-Lauf je Plugin + Scores in Supabase
- AI-GPU-Benchmarks + AI-Docker-Build/GPU-Test

---

---

## Hinweis für die Zukunft

Erledigte Aufgaben werden **nicht** hier abgehakt, sondern nach
`TASKDONE.md` verschoben und aus dieser Datei gelöscht.

