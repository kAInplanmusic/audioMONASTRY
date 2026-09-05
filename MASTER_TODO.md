# MASTERTODO – Offene Punkte (zusammengeführt)

> Stand: 2026-09-02
> Quellen: `audioMONASTRY/MASTER_TODO.md` + `samplemonk/MASTER_TODO.md`
> Legende: `[ ]` offen · `[x]` erledigt → wird nach `TASKDONE.md` verschoben und hier gelöscht.
> Prioritäten: 🔴 Kritisch · 🟠 Hoch · 🟡 Mittel · 🔵 Strategisch
> **Hardware-Spezialfälle** (>5 User-Geräte, >4.2-Layouts, MIDI-Controller/Interfaces/USB-Mischpulte) liegen in **`SPECIAL_TODO.md`**.

---

## 🎯 Nächste TODOs (in dieser Reihenfolge)


---

## 🔴 Übernahme aus `AUDIT.md` (Tiefen-Audit 2026-09-03, Commit 7b22c18)

> Die Datei AUDIT.md wurde am 2026-09-05 vollständig in diese Liste überführt und anschließend gelöscht.

### K – Kritisch: Multi-User/B2B-Locking


### S – Backend & Security


### A – Audio-Engine & DSP


### F – Frontend, React & Architektur


### Q – Build, CI & Qualität

### Empfohlene Reihenfolge (AUDIT.md)

1. Sofort P0: K-1 → K-4 → K-3 → K-2 → K-5 + Regressionstests.
2. Kurzfristig P1: S-1, S-2, S-3, S-4; A-1; F-3 + CI; `npm audit fix`; F-1.
3. Mittelfristig P2: F-4/F-5 Zod; A-2 Modularisierung + Coverage; Bundle; S-7/S-5/S-6/S-9; A-3…A-7; F-6…F-8.

---

## 🔴 Übernahme aus `AUDIT_DEEP.md` (Deep Audit 300)

> Die Datei AUDIT_DEEP.md wurde am 2026-09-05 vollständig in diese Liste überführt und anschließend gelöscht.

### Kritisch (3)


### Hoch (11)


### Mittel (72) – verdichtet


### Niedrig (813) – aggregiert


### Info (2)


---

## 🔵 Prüfung eingereichter Punkte (2026-09-05)

> Bewertet auf Machbarkeit und Sinn im **Bestand**. Umsetzbare Bestands-Punkte stehen hier in MASTER_TODO; Zukunftsvisionen in `VISIONS_TODO.md` auf dem Branch `visions`.

### P-1 · V1 & V2 Audiograph-Verifikation

**Bewertung:** Sinnvoll und machbar als Audit-/Test-Checkliste. V1 (`audioEngine`, Tone/WebAudio) ist der Live-Pfad; V2 (`AudioGraph`/`V2StudioGraph`/Backends) ist als Prototyp markiert und nur in Tests verdrahtet.


**Nicht sinnvoll im Bestand:** `AudioGraph`-Fremdbibliothek/„audiograph“-Import – Eigenbau liegt vor. V2-Live-Parität → `VISIONS_TODO.md`.

### P-2 · Core-Engine-Abgleich (Agenten-Prompt)

**Bewertung:** Sinnvoll als wiederkehrende Audit-Methodik (Ist/Soll-Abgleich + Maßnahmen), kein Code-Feature. Die enthaltenen Schritte passen auf das bestehende System.

### P-3 · PluginSystem-Briefing

**Bewertung:** Prüffragen zum Ist-Zustand sind machbar und sinnvoll; Hardware-/Zukunftsteile sind Visionen → `VISIONS_TODO.md`.


**Vision (in `VISIONS_TODO.md` überführt):** Universal-Steckmodul-Hub, parallele LVDS-Clock-Verteilung + Feedback-Clock, Auto-Codegenerierung (Matlab/Simulink), Edge-AI-NPUs, software-definierte Analogsignale, selbstlernende Routing-Vorschläge.

---

## 🟠 OPS – Flotten-Start per Snapshot beschleunigen (2026-09-02)

> Ausgangslage: Der Flotten-Wake baut aktuell pro Knoten das Docker-Image aus
> dem Repo (Dauer: mehrere Minuten). Hetzner-Snapshots kosten ca. 0,01 €/GB/
> Monat (Cent-Beträge) und machen den Start deutlich schneller.
>
> Umsetzung 2026-09-02: Portal-Worker nutzt Rollen-Snapshots, Refresh-Endpoint
> + Auto-Retention sind umgesetzt → TASKDONE. Offen ist nur die Live-Messung.


---

## 🟠 OPS – Hetzner Load Balancer (LB11) erst bei Skalierung (2026-09-02)

> Check: Hetzner LB11 ist **stundenbasiert** abgerechnet (Europa netto
> **0,012 €/h**, Deckel **7,49 €/Monat**, 20 TB Traffic inkl., Stand 04/2026).
> Für den aktuellen Betrieb (1× app-1 hinter Cloudflare, max. 4 User/Session)
> macht ein Load Balancer **keinen** Sinn – Cloudflare übernimmt Edge/TLS und
> die Session läuft auf genau einem Knoten. Sinnvoll wird er erst bei
> horizontaler Skalierung auf **≥ 2 App-Knoten**.


---

## 🟠 P1 – HOCH: MONK-Ausbau (2026-09-01)

### NEW-MONK-1 drumMONK – Sequencer vervollständigen (TR-8S)


### NEW-MONK-2 samplerMONK – Sequencer ergänzen


### NEW-MONK-3 mcpMONK – MPC + Sequencer voll ausbauen


### NEW-MONK-4 synthMONK – Synth + Sequencer + Pads

- _Umgezogen nach `SPECIAL_TODO.md`:_ Pads-Synth-UI im Minilogue-Stil + Beatstep-Pro-MIDI-Profil (braucht MIDI-Controller-Hardware).

### NEW-MONK-5 instrumentMONK – Spiel-UI


### NEW-MONK-6 biblioMONK – Semantik & Auto-Save

- _Umgezogen nach `SPECIAL_TODO.md`:_ Hörprobe mit echter Hardware (TR-8S/Beatstep Pro) – Clock-Lock und Notenzuordnung am Gerät (siehe `docs/HARDWARE_AUDIT_2026.md`).

### NEW-MONK-7 spatialMONK


### NEW-MONK-8 MONASTRYmasterclock (unsichtbares Systemmodul)


---

## 🔴 P0 – KRITISCH: Stabilität, Signalfluss, Start-Zustand

### P0-1 Start-Zustand „Kein Plugin offen" + Mixer-Sonderfall entfernen


### P0-3 Plugin-Terminals: Close-Button + State-Synchronisation


### P0-4 Rauschen auf Main beseitigen


### P0-6 Main-/Monitor-Routing & Mehrbenutzer-Fix


### P0-7 Master-Player fest oben mit Transport


---

## 🟠 P1 – HOCH: UX/UI/GUI, Cross-Platform, Bibliothek, Zwischenspeicher

### P1-1 Responsive Shell für iOS/Android/Windows/Linux/macOS


### P1-2 High-End-Klassiker-Skins pro Plugin


### P1-3 Einstellungen & Geräte-Defaults


### P1-4 Session-Zwischenspeicher (Scratchpad) + Drag & Drop + Clipboard


### P1-5 Lieder-Datenbank automatisch sortieren


### P1-6 Key-/MIDI-Handling optimieren


---

## 🟡 P2 – MITTEL: Latenz, Qualität, Clock, Signalfluss

### P2-1 Latenz & Audio-Qualität


### P2-2 Clock prüfen & synchronisieren


### P2-3 2.1-Ausgabe für Main


### P2-4 Signalfluss-/Pipeline-Audit


### P2-5 Performance & Rendering


---

## 🔵 P3 – STRATEGISCH: KI/MOA/MCP, Prompt-DB, Evaluierung

### P3-1 Datenbank-Migration 002: Systemprompts & Evaluierung


### P3-2 MOA/MCP pro Plugin anlernen, prompten, iterieren


### P3-3 Evaluierungs-Framework & Regression


---

## 🔴 AUD-P – Maßnahmen aus dem Audit-Run (2026-08-31)

### Priorisierte Maßnahmen (aus dem Audit-Lauf abgeleitet)


---

## GAP – Vollständigkeits-Analyse & Vervollständigung (2026-08-31)

### GAP-3 Atomarer Plugin-Audit – alle 21 Plugins einzeln


### GAP-4 Sicherheitslücken-Audit vervollständigen


### GAP-5 Prompt-/Trainings-Matrix je Plugin


### GAP-8 Zentrales Fehler-Register


---

## FA-P – Maßnahmen aus dem Fremdaudit

### Priorisierte Maßnahmen aus dem Fremdaudit


---

## AM-E – AUDIOMORPH-Atomar-Analyse (Ebene 1–6)

### Ebene 1 – Atomare Code-Analyse (Hot-Paths)


### Ebene 2 – Multi-Plugin-Orchestrierung


### Ebene 3 – Multiuser-Echtzeit-Architektur


### Ebene 4 – High-Quality DSP-Kernel


### Ebene 5 – Sandbox-Simulation & Stress-Testing


### Ebene 6 – Lebendige Selbstevolution


---

## NEW-D – Tasks aus Entscheidungen (D1–D23)

### Neue Tasks aus den Entscheidungen


---

## AI-Infrastruktur – aus AITodo.md übernommen (GAP-2)

> Offene Punkte aus der archivierten `AITodo.md` (2026-09-01 übernommen).


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





### B – Gute Zukunftserweiterungen (P2)








### C – Architektur-Referenzen (P2/P3, keine Integration)





### Lizenz-Hinweise (G)


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

---

## 🔷 SSOT – Konsolidierte offene Punkte (2026-09-04)

> `MASTER_TODO.md` ist die **einzige Quelle offener Arbeit** in `main`.
> `COPILOTTODO.md` und `SPECIAL_TODO.md` wurden aufgelöst und gelöscht;
> `TASKDONE.md` bleibt reines Erledigt-Archiv (offene Punkte stehen hier).
> `VISIONS_TODO.md` lebt nur im Branch `visions` (Zukunft/Experimente).

### Aus TASKDONE.md übernommen (waren dort noch offen)
- Betreiber: Nightly-CI-Lauf auf GitHub bestätigen · HF-Endpoint-Secret rotieren · echter DeepSeek/MOA-Lauf je Plugin (Scores in Supabase) · Live-Supabase-Abgleich
- Live-Hörproben: Drop-Sweep/Crossfade am laufenden Mix · TR-8S/Beatstep-Pro (Clock-Lock, Notenzuordnung) · 4-User-Livelauf (Pump-/Zipper-Freiheit) · Scratchpad Reload/DnD/Clipboard im Browser
- Live-Messungen: Flotten-Wake < 90 s (erneut messen) · CPU < 70 % · Jitter < 1 ms / < 5 ms zwischen Browsern · Resampling-/Filter-Qualität
- LB11: 2 App-Knoten + Failover (erst bei Skalierung)
- Komponenten-Neubau Hardware-Look (DJM-A9/XONE, MiniMoog/Prophet, TR-808, API/SSL) – mittlere Priorität

### Aus SPECIAL_TODO.md übernommen (Hardware-Sonderfälle)
- Beatstep-Pro-MIDI-Profil + Pads-Synth-UI (Minilogue-Stil) – braucht Beatstep Pro
- MIDI-Out/Clock-Hörprobe mit echter Hardware (TR-8S/Beatstep Pro)
- Audio-Layouts 12.x/18.x/24.x konfigurierbar + hörbar – braucht > 4.2-Lautsprecher-Setup

### Aus docs/LIVE_CHECKLIST_2026-09-02.md (zusammengefasst)
- iPhone/iOS/Android manuell: Safe-Areas, Touch-Ziele ≥ 44 px, kein Hover-only, kein Zoom/Overflow
- Xonar-U7-Default + 2.1 sichtbar, Einstellungen nach Reload stabil
- Keyboard-E2E live (Space, Ctrl/Cmd+1..9, Escape – kein Hotkey bricht Eingabefelder)
- 60-s-Stille → Main-RMS ≤ −60 dBFS (Hörprobe) · 4-User-Cue/Main-Hörprobe · Rollenwechsel ohne Unterbrechung · 0 Xruns/Dropouts
- Supabase-Daten sichtbar (P3-1) · Nightly-Report je Plugin · Security-Checkliste vollständig

### Aus AUDIT.md (Commit `7b22c18`, 2026-09-03 – ggf. durch spätere Fixes veraltet, verifizieren!)
- 🔴 Locking netzwerkweit verifizieren: Locks werden laut Audit nicht repliziert; Lock-Owner-Vergleich `'localUser'` vs. `webRTCManager.userId` in ~20 Komponenten prüfen (spätere P4-2-Fixes gegenzuprüfen)
- 🟡 Server-Error-Leaks: `(e as Error).message` 1:1 an Clients prüfen/bereinigen
- 🟡 Toter Code: `useWebRTC.ts`/parallel Lock-Implementierungen aufräumen · 160× `any` reduzieren
- 🟡 `qs`-CVEs / Dependency-Audit erneut ausführen
- 🟡 Test-Abdeckung (32,6 % Statements) gezielt für Kernpfade erhöhen

### Experimentelles in `main` (optional, laut VISIONS-Regel dokumentiert)
- WebGPU-Kernel (`src/core/gpu/`), Rust-Runtime (`services/audio-runtime`), Rust-Mixer (`services/mixer`), V2-AudioGraph, WASM-DSP/HRTF-Kernel, `localDemucs` → Benchmarks/Entscheid offen, Details in `VISIONS_TODO.md` (Branch `visions`)

---

## Deep-Audit 2026-09-04 – Befunde


---

## Deep-Audit 2026-09-04 – Befunde


---

## 🔬 Softwareaudit 2026-09-05 (offline deterministisch, 19 Niedrig)

> Quelle: `npm run audit:deep:static` (Commit `5ad2a91`). AUDIT_DEEP.md danach wieder gelöscht (Single-Root-Output).


## 🔭 Tiefen-Audit Plan-Modus 2026-09-05 (Agent-Pläne in logs/background-coder/audit-plans.md)

---

## 🔬 OpenGrep + reviewdog Audit 2026-09-05

> Quelle: OpenGrep v1.29.0 (`auto` + `p/security-audit` + `p/secrets`, 545 Regeln, 744 Dateien → 59 Findings) + reviewdog v0.21.0 (ESLint 10.9.1 → 72 Probleme, tsc 5.8.3 → 0, npm audit → 0).
> Report: `docs/AUDIT_REPORT_OPENGREP_REVIEWDOG_2026-09-05.md`


---

## 🧠 Cerebras-Tiefenaufträge 2026-09-05 (Routing: SCHWER → #7 Cerebras GPT-OSS-120B)

> Quelle: User-Anweisung „große tiefe zurückgestellte Sachen → Cerebras“. Diese Punkte sind bewusst HOCH/SCHWER markiert, damit der Orchestrator sie an Agent #7 (Cerebras) routet.



---

## 🤖 Delegationsaufträge 2026-09-05 (Background-Coder/Cerebras)

> Quelle: User-Anweisung „Aufgaben klug an Background-Coder, Cerebras und dich übergeben“. Routing: HOCH→SCHWER→#7, MITTEL→#2/#4.

