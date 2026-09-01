# MASTERTODO – Offene Punkte (zusammengeführt)

> Stand: 2026-09-01
> Quellen: `audioMONASTRY/MASTER_TODO.md` + `samplemonk/MASTER_TODO.md`
> Legende: `[ ]` offen · `[x]` erledigt → wird nach `TASKDONE.md` verschoben und hier gelöscht.
> Prioritäten: 🔴 Kritisch · 🟠 Hoch · 🟡 Mittel · 🔵 Strategisch

---

## 🎯 Nächste TODOs (in dieser Reihenfolge)

- [ ] **NEW-D1-1/D1-2**: masterplayerMONK Plugin 0 fest oben; mixerMONK einzige MAIN-Einspeisung; Halter OFF stoppt Main+Clock
- [ ] **P1-1 Responsive**: feste Breiten raus, Touch ≥44px, Safe-Areas, Plattform-Matrix
- [ ] **P1-2 Skins**: CSS-Variablen-Themes je Plugin (D8)
- [ ] **P1-4 Scratchpad**: Overlay-Sidebar, DnD, „In Zwischenablage senden"
- [ ] **P2-1/P2-2**: Latenz-Budget anwenden, Clock auditen, Lookahead 8–15 ms
- [ ] **P2-4**: `routing.json` vs. `exportGraphState()` Validierung + Bottleneck-Fix
- [ ] **P3-2/P3-3**: 21 Plugin-Prompts + Eval-Suiten + `npm run eval:ai`
- [ ] **GAP-3**: Plugin-Audit-Matrix mit PASS/WARN/FAIL je Plugin füllen

---

## 🔴 P0 – KRITISCH: Stabilität, Signalfluss, Start-Zustand

### P0-1 Start-Zustand „Kein Plugin offen" + Mixer-Sonderfall entfernen

- [ ] **Prüfpunkt:** E2E „Studio betreten" → 0 ModuleContainer sichtbar, alle Grid-Icons gedimmt, Main-RMS < -60 dBFS, kein aiMONK/Mixer-Terminal.

### P0-3 Plugin-Terminals: Close-Button + State-Synchronisation

- [ ] **Prüfpunkt:** Plugin im Terminal auf OFF stellen → Grid-Icon dunkel, Audio weg, Lock frei; Reload → Zustand bleibt wie gespeichert (bzw. Start-OFF-Regel P0-1).

### P0-4 Rauschen auf Main beseitigen

- [ ] NaN/Inf-Guards an Master-Kette prüfen (bereits vorhanden, aber erneut durch `goldenAudio`-Test mit allen Worklets).
- [ ] **Prüfpunkt:** 60 s Dauerlauf ohne aktives Plugin → RMS ≤ -60 dBFS; mit aktivem Sequencer → nur erwartete Steps hörbar.

### P0-6 Main-/Monitor-Routing & Mehrbenutzer-Fix

- [ ] **Prüfpunkt:** 4-User-E2E: User2 aktiviert Drum → auf MAIN hörbar; User3 wählt PLUGIN-Cue → hört nur sein Plugin, MAIN bleibt unverändert; zurück auf MAIN → sofort Gesamtmix.

### P0-7 Master-Player fest oben mit Transport

- [ ] **Prüfpunkt:** Scroll-Position egal → Play/Stop erreichbar; E2E Keyboard-Space + Button funktionieren.

---

## 🟠 P1 – HOCH: UX/UI/GUI, Cross-Platform, Bibliothek, Zwischenspeicher

### P1-1 Responsive Shell für iOS/Android/Windows/Linux/macOS

- [ ] Touch: Zielgrößen ≥ 44 px, `touch-action`, Safe-Area-Insets (`env(safe-area-inset-*)`), kein Hover-only, verhindere Zoom bei Doppeltipp, Pointer-Events für Knobs/Fader auf Touch testen.
- [ ] Plattform-Matrix: Chromium (Win/Linux/macOS/Android), Safari (iOS), Firefox (Desktop) – dokumentiert in `docs/HARDWARE_TEST_MATRIX_2026.md`.
- [ ] **Prüfpunkt:** Playwright-Responsive-Tests (iPhone SE/14, Pixel 7, Desktop 1920) grün; manueller iPhone-Test (UI nicht persistent, Panels schließbar).

### P1-2 High-End-Klassiker-Skins pro Plugin

- [ ] `mixerMONK` (MischpultTerminal) im Stil Pioneer DJM-A9 / Allen & Heath XONE; farbliche Kanal-Accents, Fader/Knobs wie Hardware.
- [ ] `synthesizerMONK` im Stil klassischer Analog-Synths (MiniMoog/Prophet/ Juno), `drumMONK` TR-808/Dirtywave M8, `eqMONK` API/SSL, `masteringMONK` TC/Massey, `spatialMONK` 3D-Panner wie High-End-Controller.
- [ ] Design-Tokens zentral in `index.css` (`--monk-*`) erweitern; keine plugin-lokalen Hex-Werte-Duplikate.
- [ ] **Prüfpunkt:** Screenshot-Tests (`visual.spec.ts`) für alle 21 Plugins; Vergleich mit Referenz-Hardware-Look.

### P1-3 Einstellungen & Geräte-Defaults

- [ ] `bufferHint`/`sampleRate` tatsächlich anwenden (AudioContext-Optionen, siehe P2-1).
- [ ] **Prüfpunkt:** USB-Gerät angeschlossen → wird automatisch ausgewählt; Einstellungen nach Reload stabil; 2.1 sichtbar.

### P1-4 Session-Zwischenspeicher (Scratchpad) + Drag & Drop + Clipboard

- [ ] `SessionScratchpad` in IndexedDB: Button im Header „ZWISCHENSPEICHER" mit eigener Farbe (z. B. amber/orange) zum Ein-/Ausschalten; speichert Session-Snapshot (Patterns, BPM, Mixer, Plugin-States, Routing).
- [ ] Drag & Drop: Einträge/Plugins/Tracks in den Scratchpad-Bereich ziehen; aus dem Scratchpad per Drop auf ein Plugin/Modul laden.
- [ ] Jedes Plugin (ModuleContainer) bekommt „⧉ In Zwischenablage senden": kopiert Plugin-State/Preset/Config als JSON in die Zwischenablage.
- [ ] **Prüfpunkt:** Speichern/Laden überlebt Reload; DnD funktioniert; Clipboard-Roundtrip (Copy → Paste) liefert gültiges JSON.

### P1-5 Lieder-Datenbank automatisch sortieren

- [ ] **Prüfpunkt:** Dropdown zeigt sortierte, gruppierte Liste; Sortierung überlebt Reload.

### P1-6 Key-/MIDI-Handling optimieren

- [ ] MIDI: F8-Clock, Start/Stop/Continue, Song Position, SysEx-Empfang, RPN-Parser, `send()` für LEDs/Motorfader (bereits teils vorhanden, verdrahten).
- [ ] **Prüfpunkt:** Keyboard-E2E + MIDI-Codec-Tests grün; kein Hotkey bricht Eingabefelder.

---

## 🟡 P2 – MITTEL: Latenz, Qualität, Clock, Signalfluss

### P2-1 Latenz & Audio-Qualität

- [ ] `AudioSettings`-Optionen wirklich anwenden: `latencyHint`, Sample-Rate, Puffergröße beim Context-Aufbau (`audioContextFactory`).
- [ ] Lookahead von 25 ms auf adaptiven Wert (8–15 ms) senken; Scheduling zunehmend über `clockProcessor`/Worklet statt `setTimeout`.
- [ ] End-to-End-Latenz persistieren und im `PerformanceMonitorTerminal` anzeigen (bestehende Telemetrie nutzen); Ziel lokal < 15 ms, Netz < 50 ms.
- [ ] Qualität: Resampling-Strategie prüfen, hochwertige Filter für EQ/Master, keine hörbaren Zipper (generische Worklet-Rampen).
- [ ] **Prüfpunkt:** Latenz-Messung vorher/nachher; `goldenAudio`-Tests ohne Artefakte; Dropout-Zähler bleibt 0 im Normalbetrieb.

### P2-2 Clock prüfen & synchronisieren

- [ ] `clockProcessor`, `ClockSync`, `PhaseLockedLoop` auditen; eine einzige Timing-Quelle festlegen (Worklet-Clock).
- [ ] BPM-Wechsel sample-genau; 16/32-Step-Wechsel ohne Timing-Sprung.
- [ ] Multi-User-Clock-Sync: Host-Clock wird an Gäste verteilt, Drift- Kompensation (PLL).
- [ ] **Prüfpunkt:** 120 BPM, 10 min Lauf: Jitter < 1 ms; zwei Browser starten gleichzeitig und bleiben < 5 ms zueinander.

### P2-3 2.1-Ausgabe für Main

- [ ] `stereoMode='2.1'`: Master → Crossover (Sub < 80–120 Hz, L/R High-Pass); Sub auf dritten Kanal, falls Gerät 2.1 unterstützt; sonst Sub phantom in L/R mischen (Fallback).
- [ ] Routing in `audioEngine`/`OutputConfig` erweitern; UI-Anzeige im Settings.
- [ ] **Neu (D10):** Ausgabe-Layouts **2.0 / 2.1 / 2.2 / 12.0 / 12.1 / 12.2 / 18.0 / 18.1 / 18.2 / 24.0 / 24.1 / 24.2** unterstützen; aktuell Xonar U7 (7.1) angeschlossen → **reale 2.1 als Standard** hinterlegen.
- [ ] **Prüfpunkt:** Frequenzanalyse: Sub-Kanal enthält < 120 Hz, L/R enthält keine volle Bass-Einbuße; Testton 40 Hz auf Sub, 1 kHz auf L/R.

### P2-4 Signalfluss-/Pipeline-Audit

- [ ] `routing.json` gegen echten Audio-Graph validieren (Test: `audioEngine.exportGraphState()` vs. `routing.json`).
- [ ] Falschverkabelungen korrigieren (z. B. `bassFilter`/`channel7`-Pfad, `effectNode`-Insert, Monitor-PDC).
- [ ] Bottlenecks: Main-Thread-Scheduler, Tone.js-Node-Anzahl, Worklet-CPU; wo sinnvoll V2-Graph/Worklet-Pfad verwenden.
- [ ] **Prüfpunkt:** Graph-Validierung grün; kein ungenutzter/doppelter Verbindungs-Pfad; Performance-Messung zeigt < 70 % CPU.

### P2-5 Performance & Rendering

- [ ] `React.memo`/stabile Handler für alle Terminals prüfen (UI-Audit nachziehen); Bundle-Diät (lucide tree-shaken, Tone-Chunks).
- [ ] Worklet-CPU-Budgets im PerformanceMonitor; unter 4-User-Last keine Dropouts.
- [ ] **Prüfpunkt:** Playwright-Stress-Test grün; Bundle < 1,5 MB JS.

---

## 🔵 P3 – STRATEGISCH: KI/MOA/MCP, Prompt-DB, Evaluierung

### P3-1 Datenbank-Migration 002: Systemprompts & Evaluierung

- [ ] **Prüfpunkt:** Migration idempotent; CRUD-Tests grün; Daten in Supabase sichtbar.

### P3-2 MOA/MCP pro Plugin anlernen, prompten, iterieren

- [ ] Prompt-Bibliothek je Plugin (21 Plugins): Systemprompt (Rolle, Kontext, Parameter, Routing-Ziel, erlaubte Aktionen), Few-Shot-Beispiele (deutsche Kommandos), Fehlerbehandlung.
- [ ] `pluginCommandRegistry` auf alle 21 IDs erweitern und mit `PluginAudioRouter` verbinden (Aktivierung, Routing, Parameter).
- [ ] MCP-Tools serverseitig je Plugin ergänzen (mixer.set_channel, synth.play_note, sequencer.load_pattern, …) in `mcpRuntime.ts`; Permissions READ/WRITE/EXECUTION/DESTRUCTIVE beibehalten.
- [ ] Iterations-Loop: pro Plugin → Prompt-Version anlegen → Eval-Suite laufen lassen → Score → Prompt optimieren → neue Version.
- [ ] **Prüfpunkt:** `aiEvaluation.test.ts` je Plugin; 100 % der Kern-Kommandos werden von MOA korrekt geplant und ausgeführt; Scores in DB.

### P3-3 Evaluierungs-Framework & Regression

- [ ] Bestehendes `evaluation.ts` an DB anbinden; `npm run eval:ai` schreibt Ergebnisse nach `ai_evaluations`.
- [ ] Nightly-CI: Eval-Run je Plugin, Report in `ai_eval_runs`, Gate bei Score-Abfall.
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

- [ ] Je Plugin Ergebnis: PASS/WARN/FAIL + verknüpfte Tasks in MASTER_TODO
- [ ] **Prüfpunkt:** Jedes Plugin hat mindestens einen Test (Unit oder E2E), der Aktivierung → Routing → Deaktivierung abdeckt

### GAP-4 Sicherheitslücken-Audit vervollständigen

- [ ] `docs/SECURITY_AUDIT.md`, `docs/SECURITY_REMEDIATION_PLAN.md`, `docs/AI_SECURITY_GUIDE.md`, `docs/HARDWARE_AUDIT_2026.md` abgleichen; alle offenen/ungelösten Punkte als Tasks übernehmen
- [ ] Server-seitiges RBAC durchsetzen (Host/Admin/DJ/Producer/Engineer/Guest)
- [ ] Locking an User-ID statt Socket-ID server-seitig absichern
- [ ] HF-Token-Rotation dokumentieren + Endpoint-Secret rotieren
- [ ] Pen-Test `/api/ai/*` (Auth, Rate-Limit, Input-Validierung, SSRF)
- [ ] Supabase RLS prüfen (Prompts/Evals: anon read, service_role write)
- [ ] Secret-Scan im CI (z. B. gitleaks) ergänzen
- [ ] **Prüfpunkt:** Security-Checkliste aus `docs/SECURITY_AUDIT.md` ist vollständig abgehakt oder hat einen offenen Task

### GAP-5 Prompt-/Trainings-Matrix je Plugin

- [ ] Je Plugin Prompt-Version in `system_prompts` (DB) anlegen
- [ ] Je Plugin Eval-Suite (`ai_evaluations`) mit Mindest-Score definieren
- [ ] Iterations-Loop: Prompt → Eval → Score → Optimierung → neue Version
- [ ] **Prüfpunkt:** Jedes Plugin hat ≥ 1 Eval-Datensatz und ≥ 1 Score in der DB; Score-Abfall blockiert Release (G13)

### GAP-7 Konfigurations-Matrix

- [ ] Fehlende/fehlerhafte Defaults korrigieren (USB-Auto, 2.1)
- [ ] **Prüfpunkt:** Matrix vollständig; jeder Default hat Ist- und Soll-Wert

### GAP-8 Zentrales Fehler-Register

- [ ] CI/Logs speisen das Register automatisch (Script oder manuell je Audit)
- [ ] **Prüfpunkt:** Register ist aktuell; keine Fehler ohne Task-Link

---

## FA-P – Maßnahmen aus dem Fremdaudit

### Priorisierte Maßnahmen aus dem Fremdaudit

- [ ] **FA-P0-2** `model_manager.py`: echte Modell-Instanzen laden/cachen, Handler nutzen geladene Instanz statt `from_pretrained` je Request; VRAM real tracken (FA-5)
- [ ] **FA-P2-2** Regressionstests für FA-1/FA-4: sicherstellen, dass `repository` + `revision` aus Manifest verwendet werden (FA-1, FA-4)

---

## AM-E – AUDIOMORPH-Atomar-Analyse (Ebene 1–6)

### Ebene 1 – Atomare Code-Analyse (Hot-Paths)

- [ ] **AM-E1-3** `masteringProcessor.process()` ruft pro Sample `Math.log10`, `Math.pow`, `Math.exp`-Koeffizient (releaseCoeff ist ok, aber `gr = Math.pow(10, -grDb/20)` pro Sample). Fix: Block-Envelope oder Lookup/Approximation; messen mit `goldenAudio`.
- [ ] **AM-E1-6** Hot-Path-Audit-Skript erweitern: `scripts/audit-audio-realtime.sh` soll zusätzlich `new Array`, `.push`, Closure-Konstruktion, `Math.pow/log` pro Sample in `src/audio/worklets/*.ts` erkennen und als Fehler melden.
- [ ] **AM-E1-7** Float-Präzisions-Audit DSP: alle Biquad/Allpass-Pfade auf Denormal-/NaN-Risiken prüfen (FTZ/DAZ nicht verfügbar; Noise-Gating bzw. Flush-to-Zero-Guards ergänzen), insbesondere `dspProcessor.filterZ` und `effectProcessor`-Delay-Lines.

### Ebene 2 – Multi-Plugin-Orchestrierung

- [ ] **AM-E2-1** `src/core/pluginAudioRouter.ts` (geplant in P0-2): zusätzlich Isolation-Level definieren – pro Plugin Audio-Quelle, Insert/Send-Bus, Crash-Containment (SafeModuleBoundary ≠ Audio-Isolation), Staggered Recovery (< 50 ms).
- [ ] **AM-E2-2** Inter-Plugin-Kommunikation: aktuelle `window.dispatchEvent(new CustomEvent('monk:*'))`-Steuerung (z. B. `pluginCommandRegistry.ts`) messen (Latenz, Event-Flooding) und durch typisierten Control-Bus/Event-Bus ersetzen; kein JSON über `CustomEvent` im Audio-Pfad.
- [ ] **AM-E2-3** Parameter-Automation-Smoothing: vorhandene Rampen (AM-E1-2) auf z-transform-Stabilität prüfen; für alle Worklets einheitliches `automate`-Muster ohne Allokationen.
- [ ] **AM-E2-4** Plugin-Load-Balancing: Web-Browser = 1 AudioContext → kein NUMA; dokumentieren. Für native Runtime (Rust/cpal) NUMA-/Core-Pinning als Option vorbereiten (`services/audio-runtime`).

### Ebene 3 – Multiuser-Echtzeit-Architektur

- [ ] **AM-E3-2** RBAC-Latenz: Auth-Check vom Audio-Thread entkoppeln (kein `fetch`/Token-Refresh im Audio-Pfad); Berechtigungs-Cache mit Lease.
- [ ] **AM-E3-3** Konkurrierende Edit-Resolution: LWW-CRDT (`src/core/session/stateReplication.ts`) auf atomare Objektfelder prüfen; Fuzz-Test mit 4 Usern × 1000 Edits (Interleaving-Explosion).
- [ ] **AM-E3-4** Netzwerk-Jitter-Kompensation: SFU/WebRTC-Pfad um adaptiven Jitter-Buffer erweitern (aktuell nur Opus + Standard-JitterBuffer); QoS-Tagging für Audio-Pakete dokumentieren.
- [ ] **AM-E3-5** Prioritäts-Inversion: `WebRTCManager`-DataChannel-State-Sync (~60 Hz) darf den Audio-Thread nicht blockieren; Messung `audioEngine.getAudioHealth()` während State-Bursts.

### Ebene 4 – High-Quality DSP-Kernel

- [ ] **AM-E4-1** Sample-Raten-Konvertierung: Browser macht SRC unsichtbar; für native Runtime Polyphase/Farrow-Struktur spezifizieren (`services/audio-runtime`), 44.1↔48 kHz Roundtrip-Test.
- [ ] **AM-E4-2** FFT/iFFT: aktuell keine eigene FFT im Audio-Pfad; wenn Spektral-Features kommen, cache-oblivious Mixed-Radix evaluieren (kein Naive-DFT).
- [ ] **AM-E4-3** Biquad-Stabilität: `dspProcessor.setLowpass()` (TF2/DF1-Mischung) auf Koeffizienten-Sprung bei `freq=0`/`freq=sampleRate/2` prüfen; Denormal- Guards für `filterZ`; einheitliche DF1-Implementierung.
- [ ] **AM-E4-4** Dynamik-Prozessoren: `masteringProcessor` Lookahead 5 ms + True- Peak-Approximation validieren (Golden-Audio-Referenz); Release-Kurve als segmentierte Lookup-Tabelle statt `Math.exp`-Koeffizient je Block.
- [ ] **AM-E4-5** Reverb: `effectProcessor` FDN-artiges Netz (2 Comb + 2 Allpass) ist minimal; als High-Quality-Reverb Convolution-Partitioning oder größeres FDN dokumentieren/optional implementieren.
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
- [ ] **AM-E6-3** Algorithmen-Substitution: FFT-/Filter-Benchmarks als `scripts/dsp-benchmark.ts` anlegen; Ergebnisse in `docs/DSP_BENCHMARKS.md` versionieren.
- [ ] **AM-E6-4** Selbstlernende Parameter-Vorhersage: MOA/MCP-Historie (`MoaHistory`, `ai_evaluations`) als Datensatz für Automation-Vorschläge nutzen (ML optional; zunächst heuristisch).
- [ ] **AM-E6-5** Energie-Optimierung: Audio-Context nur bei Bedarf aktiv, Worklet-Idle-Detection, Display-Sleep-Verhalten auf iOS/Android testen.
- [ ] **AM-E6-6** A/B-Validierung: für kritische DSP-Änderungen Golden-Audio (`tests/goldenAudio.test.ts`) als Regressions-Gate; jede Optimierung mit vorher/nachher-Messung in MASTER_TODO dokumentieren.

---

## NEW-D – Tasks aus Entscheidungen (D1–D23)

### Neue Tasks aus den Entscheidungen

- [ ] **NEW-D1-1** masterplayerMONK als Plugin 0: bei allen 4 Usern fest ganz oben unter Header/Plugin-Buttons; nur Visualisierung + Infos, keine Eingabe, kein An/Aus/KI-Button
- [ ] **NEW-D1-2** mixerMONK als einzige MAIN-Einspeiseinstanz: andere Plugins können nur über mixerMONK auf MAIN; wenn Halter mixerMONK OFF schaltet → **Main-Ausgabe + MainClock/Tick stoppen**
- [ ] **NEW-D4-1** V2-AudioGraph als eigenes Arbeitspaket mit hoher Priorität weiterführen (nicht einfrieren); Meilenstein „V2-Minimum hörbar“ – Priorität bestätigt 2026-09-01: V2 parallel mit hoher Priorität; falls später nur V2 → absoluter Fokus, falls hybrid → beide mit hoher Priorität

---

## AI-Infrastruktur – aus AITodo.md übernommen (GAP-2)

> Offene Punkte aus der archivierten `AITodo.md` (2026-09-01 übernommen).

- [ ] **AI-Rate-Limits:** Explizite `AI_RATE_*`-Request-Limits + Tests umsetzen (aus AITodo Phase 18)
- [ ] **AI-Supabase-Persistenz-Tests:** Gemockte Tests für `ai_sessions`/`ai_jobs`/`ai_errors` ergänzen (aus AITodo Phase 12)
- [ ] **AI-E2E-Szenario:** Wake→Cold-Start→Load→Request→Switch→Scale-to-Zero als automatisierter Test (aus AITodo Phase 24–26)
- [ ] **AI-Failure-Suite:** HF offline, GPU down, Duplicate, Crash automatisieren (aus AITodo Phase 24–26)
- [ ] **AI-Benchmark-Skript:** `scripts/ai-benchmark.ts` für Cold/Warm/Switch-Messungen anlegen (aus AITodo Phase 21/22/23)
- [ ] **AI-GPU-Benchmarks:** Cold/Warm/VRAM-Messwerte sobald Endpoint läuft (aus AITodo Phase 21/22/23, blockiert)
- [ ] **AI-Docker-Build/GPU-Test:** Lokaler GPU-Test offen; CI baut/pusht Image automatisch (aus AITodo Phase 2, blockiert)
- [ ] **Warm-Keep-Option:** Selten genutzte Fenster ohne Kaltstart (aus AITodo LOW PRIORITY)
- [ ] **INT8-Kalibrierung:** Je Modell vorab messen (aus AITodo OPTIONAL OPTIMIZATIONS)
- [ ] **Modell-Splitting:** Bei dauerhafter Überlast, erst mit Freigabe (aus AITodo OPTIONAL OPTIMIZATIONS)

---

## Hinweis für die Zukunft

Erledigte Aufgaben werden **nicht** hier abgehakt, sondern nach
`TASKDONE.md` verschoben und aus dieser Datei gelöscht.

