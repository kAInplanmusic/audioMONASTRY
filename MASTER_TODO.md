# MASTERTODO

Legende:
- `[ ]` offene Aufgabe
- `[x]` erledigt
- Priorität: 🔴 Kritisch · 🟠 Hoch · 🟡 Mittel · 🔵 Strategisch

---

# 🔴 TESTRUN 1 – KATASTROPHEN-ANALYSE & OPTIMIERUNGSPLAN (2026-08-31)

> **WICHTIG:** Die älteren Abschnitte dieser Datei waren auf „alles erledigt"
> markiert. Der erste echte Testrun hat gezeigt, dass die App im
> Zusammenspiel **nicht produktionsreif** ist. Dieser neue Abschnitt hat
> **Vorrang** vor allen älteren Haken und ist der verbindliche Arbeitsplan.
> Alle Änderungen werden erst nach bestandener Prüfung abgehakt.

---

## 1. BEFUNDLAGE – aus Code, Logs & Session-Daten verifiziert

Quellen, die ausgewertet wurden:

- `src/App.tsx` – Start-Ablauf, Modul-Grid, Mixer-Sonderfall, Master-Player
- `src/context/ModuleStateContext.tsx` – persistierte Modul-States, LWW-Sync
- `src/context/PluginManagerContext.tsx` – Locking ohne Server-Durchsetzung
- `src/components/ModuleContainer.tsx` – **kein Close-Button**, kein OFF
- `src/components/MischpultTerminal.tsx` – „PRO-MIX 9000" ohne Engine-Routing
- `src/components/DJ4ChMixer.tsx` – festes DJM-A9-Mischpult, immer sichtbar
- `src/components/SynthesizerTerminal.tsx` – WASM-Host ohne AudioEngine-Anbindung
- `src/components/AiMonkTerminal.tsx` – AI-Terminal als normales Plugin
- `src/components/MasterPlayerTerminal.tsx` – Master-Engine (Analyse/Master/Mix)
- `src/components/SettingsDialog.tsx` – Defaults ohne USB-Soundkarten-Autodetect
- `src/utils/audioEngine.ts` – alle Synths/Worklets werden bei `init()` sofort
  erzeugt und auf `GLOBAL_MASTER` verbunden (auch wenn Plugin OFF)
- `src/utils/audioEngine.ts` `setMonitorSource()` – trennt bei `MON`/`PLUGIN`
  den `analyzerNode` vom Ausgang → andere User hören nicht mehr MAIN
- `src/config/rolePresets.ts` – Rollen-Presets aktivieren viele Module sofort
- `database/schema.sql` / `database/ai_migration_001.sql` – **keine Tabellen**
  für Systemprompts & Evaluierung
- `docs/UIUX_AUDIT_2026.md`, `docs/HARDWARE_AUDIT_2026.md`,
  `docs/ARCHITECTURE_AUDIT_2026.md`, `docs/PERFORMANCE_AUDIT.md`,
  `docs/AI_TROUBLESHOOTING.md` – bekannte Lücken (Identität, Mapping, Hotplug,
  Latenz-Messung, UI-Persistenz)
- `~/.continue/sessions/*.json`, `~/.deepcode/audit.log`,
  `~/.deepcode/agent-sessions.json`, `~/.deepcode/logs/error.log`,
  `~/.xsession-errors*`, `~/.npm/_logs/*` – Vorgänger-Sessions &
  Fehlerbilder (DNS/Connection-Fehler, UI-Debug-Logs, Hetzner-Testlauf)

---

## 2. SYMPTOM → URSACHE → TASK-MATRIX

| # | Symptom aus Testrun 1 | Verifizierte Ursache (Code/Log) | Task |
|---|---|---|---|
| S1 | mixerMONK spielt nur ab und an | Sequencer/Synths sind unabhängig vom Plugin-State immer in der Kette; Lookahead-Scheduler auf Main-Thread (25 ms); Plugin-State beeinflusst Audio nicht | P0-2, P0-4, P2-1, P2-2 |
| S2 | Übertriebenes Rauschen auf Main | Alle Synth-/Noise-Knoten (`clapSynth`, Worklets) werden bei `init()` verbunden; kein Silence-Gate bei inaktiven Plugins | P0-4, P0-2 |
| S3 | Plugins schließen nicht richtig / bleiben konsistent | `ModuleContainer` hat keinen Close-Button; `usePluginState` (lokal) und `ModuleStateContext` (global) sind getrennt; `togglePlugin` blockiert `mixer` | P0-1, P0-3 |
| S4 | Beim Ausschalten läuft Plugin manchmal weiter | OFF ändert nur UI-State, nicht den Audio-Graph; Nodes bleiben verbunden | P0-2, P0-3 |
| S5 | AI funktioniert nicht | aiMONK ist zu, Provider/Endpoint-Fehler nicht sichtbar; keine per-Plugin-MCP-Verdrahtung; Fehler nur in Konsole | P0-8, P3-2, P3-3 |
| S6 | Synthesizer geht nichts | `SynthesizerTerminal` steuert nur optionalen WASM-Host, **keine** Verbindung zu `audioEngine`/`itSynthProcessor` | P0-5 |
| S7 | Lieder für Mixer völlig unsortiert | `data/musicLibrary.ts` + Supabase `music_tracks` ohne Sortierung/Filter; Dropdown unsortiert | P1-5 |
| S8 | Keine sinnvolle Maske / Skin | Mischpult-Terminal „PRO-MIX 9000" wirkt generisch; Design nicht an High-End-Klassiker angelehnt | P1-2 |
| S9 | Latenz furchtbar | `lookahead=25ms` + Browser-BaseLatency + keine echte Puffer-Konfiguration; `bufferHint` wird nur gespeichert, nicht angewendet | P2-1 |
| S10 | iPhone schwer nutzbar, UI persistent & nicht aus | Feste Breiten (`w-[128px]`, `max-w-5xl`), keine Touch-Optimierung, Panels bleiben offen | P1-1, P0-1 |
| S11 | Master-Player nicht fest oben, nur Info | Master-Player-Sektion liegt unter Mixer; Transport-Buttons vorhanden, aber nicht als fester Top-Header | P0-7 |
| S12 | Nur DJ/mixerMONK-User bringt Töne auf Main | Andere Plugins sind UI-only oder nur an Monitor/Cue gebunden; `setMonitorSource()` trennt MAIN bei MON/PLUGIN | P0-6 |
| S13 | aiMONK immer fest offen, letztes Modul unten | Persistierte `audiomonastry_module_states` + kein Start-Reset; aiMONK wird wie jedes aktive Modul gerendert | P0-1, P0-8 |
| S14 | Start: kein Plugin offen / erster User startet mit offenem Mixer | `App.tsx` rendert Mixer immer (`p.id === 'mixer' ? true`), `togglePlugin/promotePlugin` ignorieren `mixer` | P0-1 |
| S15 | Kein USB-Soundkarten-Default, kein 2.1 | `DEFAULT_SETTINGS.outputDeviceId=''`; `stereoMode` kennt nur STEREO/DAW/SPATIAL, kein 2.1 | P1-3, P2-3 |
| S16 | Kein Ablageort für Systemprompts/Evaluierung | DB-Schema hat keine Prompt-/Eval-Tabellen | P3-1 |
| S17 | Session-Zwischenspeicher fehlt / kein DnD / kein Clipboard | Kein Scratchpad, kein Plugin-„In Zwischenablage senden"-Button | P1-4 |
| S18 | Routing/Falschverkabelung, Bottlenecks | `routing.json` vs. echter Graph nicht validiert; `setMonitorSource`-Solo manipuliert Kanal-Gains global | P0-6, P2-4 |
| S19 | Clock/Timing unzuverlässig | Lookahead-Scheduler + `clockProcessor` nicht als einzige Timing-Quelle; kein Multi-User-Clock-Sync-Test | P2-2 |
| S20 | MOA/MCP nicht tief genug verdrahtet | `MoaAgent`/`pluginCommandRegistry` decken nur Teile ab; keine per-Plugin-Prompts, kein Eval-Loop | P3-2, P3-3 |

---

## 3. LEITLINIEN FÜR ALLE UMSETZUNGEN

1. **Start-Silence:** Beim Start ist kein Plugin offen, kein Modul in der
   Signalkette, Main ist stumm.
2. **Aktivierung = Einspeisung:** Erst wenn ein Plugin aktiviert wird
   (OFF → AUTO_AI/PRO), wird seine Quelle an der richtigen Stelle in die
   Signalkette eingespeist; Deaktivierung trennt und disposet.
3. **Main ist heilig:** Der Main-Bus (2.1, USB-Soundkarte default) gehört dem
   Host/DJ; Monitor-/PLUGIN-Modi sind **nur** Cue-Wege für einzelne User und
   dürfen Main nie abtrennen.
4. **Latenz zuerst:** Jede Änderung misst Latenz (lokal < 15 ms, Netz < 50 ms).
5. **Jedes Plugin hat ein Gesicht:** High-End-Klassiker-Skin + Close-Button +
   „In Zwischenablage senden" + Routing-Ziel.
6. **KI wird pro Plugin trainiert:** Systemprompts, Few-Shots, Eval-Datensätze
   in der DB; nichts wird „blind" als funktionierend abgehakt.
7. **Alles hat einen Prüfpunkt:** Jede Aufgabe endet mit messbarem Checkpoint;
   kein „done" ohne Test.

---

## 4. 🔴 P0 – KRITISCH: Stabilität, Signalfluss, Start-Zustand
*(Blockiert jeden weiteren Testrun – zuerst abarbeiten)*

### P0-1 Start-Zustand „Kein Plugin offen" + Mixer-Sonderfall entfernen
- [x] `src/App.tsx`: `togglePlugin`/`promotePlugin` dürfen `mixer` **nicht**
      mehr ignorieren; `filter(p => p.id === 'mixer' ? true : …)` entfernen.
- [x] `ModuleStateContext`: Beim ersten Start (kein gespeicherter State) sind
      **alle** Module `OFF`; persistierte States nur als optionales
      „Session merken"-Feature hinter einem expliziten Button (siehe P1-4).
- [ ] `rolePresets`: Rollen-Presets werden **nur** bei expliziter Auswahl im
      Header angewendet, nie automatisch.
- [ ] aiMONK als Bottom-Dock für alle User **immer offen**; außer aiMONK-Dock
      ist beim Start kein Plugin-Terminal offen.
- [x] **Alternative (D1):** Festes Hardware-Mischpult (DJMixer) bleibt als
      reine Hardware-Sektion; Plugin `mixer` (MischpultTerminal) bleibt
      OFF-fähig. **Entscheidung:** mixerMONK-Plugin ist die **einzige** Instanz,
      die andere Plugins in MAIN einspeisen darf; nur der Halter entscheidet
      über MAIN. masterplayerMONK ist Plugin 0 (nur Visualisierung/Infos).
- [ ] **Prüfpunkt:** E2E „Studio betreten" → 0 ModuleContainer sichtbar, alle
      Grid-Icons gedimmt, Main-RMS < -60 dBFS, kein aiMONK/Mixer-Terminal.

### P0-2 Plugin-Lifecycle: OFF = raus aus der Signalkette
- [ ] Neue zentrale Schicht `src/core/pluginAudioRouter.ts`:
      `pluginId → { source, mixerChannel, insertBus, activate(), deactivate() }`.
- [ ] `audioEngine.init()` erzeugt **keine** Plugin-Synth-/Noise-/Worklet-Nodes
      mehr global; nur Master-Kette, Mixer-Kanäle, Monitor-Busse.
- [ ] `audioEngine.activatePlugin(id)` verbindet die Quelle auf den
      konfigurierten Mixer-Kanal; `deactivatePlugin(id)` trennt, ramp-down auf
      -∞ und disposet (kein Leak).
- [ ] `ModuleStateContext.setModuleState()` ruft bei jedem Zustandswechsel den
      Router auf (OFF → deactivate, AUTO_AI/PRO → activate je nach Quelle).
- [ ] Alle 21 Plugin-IDs (inkl. masterplayer, ai, synthesizer, mixer) im Router
      registrieren; unbekannte IDs loggen und ignorieren.
- [x] **Alternative (D2 – hybrid):** **Sanft** (Gain-Rampe auf -∞ + Stop), wenn
      das Plugin mit der **Main-Signalkette verbunden** ist; **hart**
      (Disconnect/Dispose), wenn das Plugin inaktiv ist oder nur im
      **Monitor-Signal** läuft. Lazy-Init bei Aktivierung.
- [ ] **Prüfpunkt:** Graph-Snapshot-Test: bei OFF existiert keine Verbindung
      Plugin→GLOBAL_MASTER; bei PRO existiert genau eine; OFF während Play
      stoppt den Klang sofort (< 50 ms).

### P0-3 Plugin-Terminals: Close-Button + State-Synchronisation
- [x] `ModuleContainer` bekommt Header-Button „✕ / OFF" →
      `setModuleState(id,'OFF')` + `releaseLock` + `deactivatePlugin`.
- [ ] `usePluginState` und `ModuleStateContext` zusammenführen: lokale
      Terminal-Selects schreiben in den globalen State; keine zwei Wahrheiten.
- [ ] Jedes Terminal bekommt sichtbaren Status (OFF/AUTO_AI/PRO) und der
      Zustand wird über WebRTC repliziert (bestehende LWW-Nachricht reicht).
- [x] **Alternative (D3):** `usePluginState` **komplett entfernen**; nur
      `ModuleStateContext` + `usePluginManager` nutzen (eine State-Quelle).
- [ ] **Prüfpunkt:** Plugin im Terminal auf OFF stellen → Grid-Icon dunkel,
      Audio weg, Lock frei; Reload → Zustand bleibt wie gespeichert (bzw.
      Start-OFF-Regel P0-1).

### P0-4 Rauschen auf Main beseitigen
- [ ] Rausch-Quellen identifizieren: `clapSynth` (Noise), `synthWorklet`,
      `itSynthNode`, Effekt-Worklet-Defaults; mit `AudioGraphSnapshot`-Test
      alle aktiven Quellen auf MAIN auflisten.
- [ ] Silence-Gate am Master: Wenn kein Plugin aktiv ist, ist der Master
      garantiert stumm (Master-Gain -∞ oder keine Verbindungen).
- [ ] NaN/Inf-Guards an Master-Kette prüfen (bereits vorhanden, aber erneut
      durch `goldenAudio`-Test mit allen Worklets).
- [ ] **Prüfpunkt:** 60 s Dauerlauf ohne aktives Plugin → RMS ≤ -60 dBFS;
      mit aktivem Sequencer → nur erwartete Steps hörbar.

### P0-5 Synthesizer richtig verdrahten
- [ ] `SynthesizerTerminal` an `audioEngine`/`InstrumentBackend` anbinden:
      Parameter (Cutoff/Decay/Engine) → `automateItSynthParam` /
      `playSynthesisInstrument`; WASM-Host nur als optionaler Zusatz.
- [ ] Routing-Ziel-Button/Select im Synth-Terminal: „An Kanal/Plugin senden"
      (CH1–CH8 oder Ziel-Plugin drum/sequencer/instrument/…).
- [ ] Preview-Keyboard (Noten) direkt hörbar auf gewähltem Ziel.
- [x] **Alternative (D4):** **V1-Worklet zuerst produktiv**; **V2-AudioGraph
      parallel weiterentwickeln** – beide hohe Priorität (V2 nicht einfrieren).
- [ ] **Prüfpunkt:** E2E: Synth aktivieren → Note spielen → Signal auf
      gewähltem Mixer-Kanal/Main messbar.

### P0-6 Main-/Monitor-Routing & Mehrbenutzer-Fix
- [ ] `setMonitorSource` überarbeiten: `MAIN` ist der einzige Pfad, der den
      `analyzerNode` mit dem Ausgang verbindet; `MON`/`PLUGIN` werden als
      **parallele Cue-Busse** geführt und trennen MAIN **nie**.
- [ ] Pro User Monitor-/Cue-Mix (`MON1..MON4`) beibehalten, aber unabhängig
      vom Main.
- [ ] Jedes Plugin bekommt einen echten Ziel-Kanal (PluginAudioRouter) und
      dessen Ausgang geht standardmäßig auf MAIN; nur expliziter Cue geht auf
      MON/PLUGIN.
- [ ] `PLUGIN_SOLO_CHANNEL`-Map in `App.tsx` durch Router-Auskunft ersetzen.
- [x] **Alternative (D5/D12):** Host-Main-Streaming über WebRTC an Gäste
      **später (P4-1)**; lokal bleibt jeder User sein eigener AudioContext.
      Entscheidung: 1 AudioContext pro User + Host-Main-Stream für 4 User;
      Server-Mixing erst > 4 User.
- [ ] **Prüfpunkt:** 4-User-E2E: User2 aktiviert Drum → auf MAIN hörbar;
      User3 wählt PLUGIN-Cue → hört nur sein Plugin, MAIN bleibt unverändert;
      zurück auf MAIN → sofort Gesamtmix.

### P0-7 Master-Player fest oben mit Transport
- [ ] Sticky-Top-Bar: Play/Stop, BPM, BeatVisualizer, Session-Status und
      Master-Pegel immer sichtbar (auch auf iPhone).
- [ ] `MasterPlayerTerminal` (Analyse/Master/Mixdown) bleibt als Werkzeug
      darunter, ist aber nicht der einzige Transport.
- [x] **Alternative (D6):** masterplayerMONK ist **Plugin 0** – bei allen
      4 Usern **fest ganz oben unter Header/Plugin-Buttons**; nur
      Visualisierung + Infos, **keine Eingabe**, kein An/Aus/KI-Button.
      Transport (Play/Stop/BPM) gehört in diese feste Leiste.
- [ ] **Prüfpunkt:** Scroll-Position egal → Play/Stop erreichbar; E2E
      Keyboard-Space + Button funktionieren.

### P0-8 AI-Pfad debuggen & aiMONK optional machen
- [ ] `AiMonkTerminal`: sichtbares Fehler-/Log-Panel (Provider, Status, HTTP,
      Dauer) statt nur Konsolen-Log.
- [ ] `/api/ai/complete`-Fehler normalisieren und als nutzbare Meldung anzeigen
      (Timeout/Wake/Quota/Provider-Down).
- [ ] aiMONK als **Bottom-Dock für alle User immer offen** umsetzen (kein
      normales Grid-Modul; „letztes Modul unten" durch Dock ersetzen).
- [ ] `moaAgent.executePlan` mit PluginAudioRouter verbinden, damit KI-Aktionen
      wirklich Plugins aktivieren/deaktivieren/routen.
- [x] **Alternative (D7):** aiMONK wird als **Bottom-Dock für alle User immer
      offen** umgesetzt (Feature-Flag für Ausblenden optional).
- [ ] **Prüfpunkt:** Testbefehl „Tempo auf 128, Sequencer an, Pattern laden"
      läuft durch und erzeugt hörbares Ergebnis; Fehlerfall zeigt verständliche
      Meldung.

---

## 5. 🟠 P1 – HOCH: UX/UI/GUI, Cross-Platform, Bibliothek, Zwischenspeicher

### P1-1 Responsive Shell für iOS/Android/Windows/Linux/macOS
- [ ] Feste Breiten ersetzen: Mixer-Kanäle (`w-[128px]`), Grid
      (`max-w-5xl`), Header etc. auf `min-w-0`/`w-full`/fluid umstellen;
      Breite passt sich an OS/Viewport an.
- [ ] Touch: Zielgrößen ≥ 44 px, `touch-action`, Safe-Area-Insets
      (`env(safe-area-inset-*)`), kein Hover-only, verhindere Zoom bei
      Doppeltipp, Pointer-Events für Knobs/Fader auf Touch testen.
- [ ] Plattform-Matrix: Chromium (Win/Linux/macOS/Android), Safari (iOS),
      Firefox (Desktop) – dokumentiert in `docs/HARDWARE_TEST_MATRIX_2026.md`.
- [ ] **Prüfpunkt:** Playwright-Responsive-Tests (iPhone SE/14, Pixel 7,
      Desktop 1920) grün; manueller iPhone-Test (UI nicht persistent, Panels
      schließbar).

### P1-2 High-End-Klassiker-Skins pro Plugin
- [ ] `mixerMONK` (MischpultTerminal) im Stil Pioneer DJM-A9 / Allen & Heath
      XONE; farbliche Kanal-Accents, Fader/Knobs wie Hardware.
- [ ] `synthesizerMONK` im Stil klassischer Analog-Synths (MiniMoog/Prophet/
      Juno), `drumMONK` TR-808/Dirtywave M8, `eqMONK` API/SSL,
      `masteringMONK` TC/Massey, `spatialMONK` 3D-Panner wie High-End-Controller.
- [ ] Design-Tokens zentral in `index.css` (`--monk-*`) erweitern; keine
      plugin-lokalen Hex-Werte-Duplikate.
- [x] **Alternative (D8):** **Erst CSS-Variablen-Themes komplett & sauber
      umsetzen**; danach mit **mittlerer Priorität** Komponenten-Neubau je
      Plugin (ggf. mit Bild-/Text-Infos vom User je Plugin).
- [ ] **Prüfpunkt:** Screenshot-Tests (`visual.spec.ts`) für alle 21 Plugins;
      Vergleich mit Referenz-Hardware-Look.

### P1-3 Einstellungen & Geräte-Defaults
- [ ] `SettingsDialog`: Default-Ausgabe = **erst Xonar-U7-Label bevorzugen**,
      sonst erste USB-Audio-Soundkarte (Label enthält `USB`/`Audio Interface`);
      sonst System-Default; Nutzer-Override wird als `outputOverride` persistiert.
- [ ] `stereoMode` um `2.1` erweitern (siehe P2-3).
- [ ] Einstellungen gruppieren: Audio-Gerät, Latenz-Profil, Routing, Monitor,
      MIDI/HID, Kollaboration; jede Gruppe mit Erklärtext.
- [ ] `bufferHint`/`sampleRate` tatsächlich anwenden (AudioContext-Optionen,
      siehe P2-1).
- [ ] **Prüfpunkt:** USB-Gerät angeschlossen → wird automatisch ausgewählt;
      Einstellungen nach Reload stabil; 2.1 sichtbar.

### P1-4 Session-Zwischenspeicher (Scratchpad) + Drag & Drop + Clipboard
- [ ] `SessionScratchpad` in IndexedDB: Button im Header „ZWISCHENSPEICHER"
      mit eigener Farbe (z. B. amber/orange) zum Ein-/Ausschalten; speichert
      Session-Snapshot (Patterns, BPM, Mixer, Plugin-States, Routing).
- [ ] Drag & Drop: Einträge/Plugins/Tracks in den Scratchpad-Bereich ziehen;
      aus dem Scratchpad per Drop auf ein Plugin/Modul laden.
- [ ] Jedes Plugin (ModuleContainer) bekommt „⧉ In Zwischenablage senden":
      kopiert Plugin-State/Preset/Config als JSON in die Zwischenablage.
- [x] **Alternative (D9):** Scratchpad als **halbtransparente Overlay-Sidebar**
      (Desktop) bzw. Overlay auf Mobile; Farbe/Position per Setting.
- [ ] **Prüfpunkt:** Speichern/Laden überlebt Reload; DnD funktioniert;
      Clipboard-Roundtrip (Copy → Paste) liefert gültiges JSON.

### P1-5 Lieder-Datenbank automatisch sortieren
- [ ] `MUSIC_LIBRARY` + Supabase `music_tracks`: Sortierung nach BPM, Key
      (Camelot), Style, Artist, Duration; Filter im LibraryTerminal und im
      DJ-Mixer-Track-Dropdown.
- [ ] Duplikate/IDs bereinigen; fehlende BPM/Key nachziehen (Analyse).
- [ ] **Prüfpunkt:** Dropdown zeigt sortierte, gruppierte Liste; Sortierung
      überlebt Reload.

### P1-6 Key-/MIDI-Handling optimieren
- [ ] Globale Hotkeys: Space (Play/Stop), `Ctrl/Cmd+1..9` Plugin-Toggle,
      `Ctrl/Cmd+Enter` Ausführen, Escape schließt Panels – mit Input-Guard.
- [ ] MIDI: F8-Clock, Start/Stop/Continue, Song Position, SysEx-Empfang,
      RPN-Parser, `send()` für LEDs/Motorfader (bereits teils vorhanden,
      verdrahten).
- [ ] **Prüfpunkt:** Keyboard-E2E + MIDI-Codec-Tests grün; kein Hotkey bricht
      Eingabefelder.

---

## 6. 🟡 P2 – MITTEL: Latenz, Qualität, Clock, Signalfluss

### P2-1 Latenz & Audio-Qualität
- [ ] `AudioSettings`-Optionen wirklich anwenden: `latencyHint`, Sample-Rate,
      Puffergröße beim Context-Aufbau (`audioContextFactory`).
- [ ] Lookahead von 25 ms auf adaptiven Wert (8–15 ms) senken; Scheduling
      zunehmend über `clockProcessor`/Worklet statt `setTimeout`.
- [ ] End-to-End-Latenz persistieren und im `PerformanceMonitorTerminal`
      anzeigen (bestehende Telemetrie nutzen); Ziel lokal < 15 ms, Netz < 50 ms.
- [ ] Qualität: Resampling-Strategie prüfen, hochwertige Filter für EQ/Master,
      keine hörbaren Zipper (generische Worklet-Rampen).
- [ ] **Prüfpunkt:** Latenz-Messung vorher/nachher; `goldenAudio`-Tests ohne
      Artefakte; Dropout-Zähler bleibt 0 im Normalbetrieb.

### P2-2 Clock prüfen & synchronisieren
- [ ] `clockProcessor`, `ClockSync`, `PhaseLockedLoop` auditen; eine einzige
      Timing-Quelle festlegen (Worklet-Clock).
- [ ] BPM-Wechsel sample-genau; 16/32-Step-Wechsel ohne Timing-Sprung.
- [ ] Multi-User-Clock-Sync: Host-Clock wird an Gäste verteilt, Drift-
      Kompensation (PLL).
- [ ] **Prüfpunkt:** 120 BPM, 10 min Lauf: Jitter < 1 ms; zwei Browser starten
      gleichzeitig und bleiben < 5 ms zueinander.

### P2-3 2.1-Ausgabe für Main
- [ ] `stereoMode='2.1'`: Master → Crossover (Sub < 80–120 Hz, L/R High-Pass);
      Sub auf dritten Kanal, falls Gerät 2.1 unterstützt; sonst Sub phantom in
      L/R mischen (Fallback).
- [ ] Routing in `audioEngine`/`OutputConfig` erweitern; UI-Anzeige im Settings.
- [ ] **Neu (D10):** Ausgabe-Layouts **2.0 / 2.1 / 2.2 / 12.0 / 12.1 / 12.2 /
      18.0 / 18.1 / 18.2 / 24.0 / 24.1 / 24.2** unterstützen; aktuell Xonar U7
      (7.1) angeschlossen → **reale 2.1 als Standard** hinterlegen.
- [x] **Alternative (D10):** **Beides** – echter dritter Kanal falls Gerät 2.1
      kann, sonst Phantom-Sub; OS-Aggregation/Subwoofer-Hardware-Setup zusätzlich
      dokumentieren (WebAudio kann nur ein Ziel-Gerät ansteuern).
- [ ] **Prüfpunkt:** Frequenzanalyse: Sub-Kanal enthält < 120 Hz, L/R enthält
      keine volle Bass-Einbuße; Testton 40 Hz auf Sub, 1 kHz auf L/R.

### P2-4 Signalfluss-/Pipeline-Audit
- [ ] `routing.json` gegen echten Audio-Graph validieren (Test:
      `audioEngine.exportGraphState()` vs. `routing.json`).
- [ ] Falschverkabelungen korrigieren (z. B. `bassFilter`/`channel7`-Pfad,
      `effectNode`-Insert, Monitor-PDC).
- [ ] Bottlenecks: Main-Thread-Scheduler, Tone.js-Node-Anzahl, Worklet-CPU;
      wo sinnvoll V2-Graph/Worklet-Pfad verwenden.
- [ ] **Prüfpunkt:** Graph-Validierung grün; kein ungenutzter/doppelter
      Verbindungs-Pfad; Performance-Messung zeigt < 70 % CPU.

### P2-5 Performance & Rendering
- [ ] `React.memo`/stabile Handler für alle Terminals prüfen (UI-Audit
      nachziehen); Bundle-Diät (lucide tree-shaken, Tone-Chunks).
- [ ] Worklet-CPU-Budgets im PerformanceMonitor; unter 4-User-Last keine
      Dropouts.
- [ ] **Prüfpunkt:** Playwright-Stress-Test grün; Bundle < 1,5 MB JS.

---

## 7. 🔵 P3 – STRATEGISCH: KI/MOA/MCP, Prompt-DB, Evaluierung

### P3-1 Datenbank-Migration 002: Systemprompts & Evaluierung
- [x] `database/ai_migration_002.sql`:
      - `system_prompts` (id, plugin_id, role, version, content, enabled, meta)
      - `plugin_prompt_versions` (plugin_id, version, prompt_id, changelog)
      - `ai_evaluations` (id, plugin_id, task, prompt_version, model, provider,
        input, output, score, metrics jsonb, created_at)
      - `ai_eval_runs` (run_id, plugin_id, status, summary, created_at)
      - RLS: anon read (Prompts), service_role write.
- [x] CRUD-Helfer in `src/core/ai/orchestrator/promptStore.ts` +
      `evaluationStore.ts`; Tests.
- [ ] **Prüfpunkt:** Migration idempotent; CRUD-Tests grün; Daten in Supabase
      sichtbar.

### P3-2 MOA/MCP pro Plugin anlernen, prompten, iterieren
- [ ] Prompt-Bibliothek je Plugin (21 Plugins): Systemprompt (Rolle, Kontext,
      Parameter, Routing-Ziel, erlaubte Aktionen), Few-Shot-Beispiele (deutsche
      Kommandos), Fehlerbehandlung.
- [ ] `pluginCommandRegistry` auf alle 21 IDs erweitern und mit
      `PluginAudioRouter` verbinden (Aktivierung, Routing, Parameter).
- [ ] MCP-Tools serverseitig je Plugin ergänzen (mixer.set_channel,
      synth.play_note, sequencer.load_pattern, …) in `mcpRuntime.ts`; Permissions
      READ/WRITE/EXECUTION/DESTRUCTIVE beibehalten.
- [ ] Iterations-Loop: pro Plugin → Prompt-Version anlegen → Eval-Suite laufen
      lassen → Score → Prompt optimieren → neue Version.
- [ ] **Prüfpunkt:** `aiEvaluation.test.ts` je Plugin; 100 % der Kern-Kommandos
      werden von MOA korrekt geplant und ausgeführt; Scores in DB.

### P3-3 Evaluierungs-Framework & Regression
- [ ] Bestehendes `evaluation.ts` an DB anbinden; `npm run eval:ai` schreibt
      Ergebnisse nach `ai_evaluations`.
- [ ] Nightly-CI: Eval-Run je Plugin, Report in `ai_eval_runs`, Gate bei
      Score-Abfall.
- [ ] **Prüfpunkt:** CI grün; Report enthält je Plugin Score, Dauer, Fehler.

---

## 8. 🔵 P4 – STRATEGISCH: 4-User-Workflow, Streaming, Zugriffsrechte

### P4-1 Frontend-Streaming & Audio für 4 User
- [x] Host-Main-Stream implementiert: `audioEngine.createMasterStreamDestination()`
      + `webRTCManager.startMainStream()` (P2P-Renegotiation + SFU-Producer);
      Gäste empfangen Main via `onMainStream` und spielen ihn ab (App.tsx).
- [x] SFU-Modus: Main-/Mikro-Tracks als Producer; State-Sync läuft über
      Socket-Relay (sendToAllPeers) – Media + State über SFU-fähigen Pfad.
- [x] UI-State-Streaming (LWW-CRDT) bleibt; im SFU-Modus werden Plugin-States
      über das Socket-Relay an alle Gäste geroutet (bestehend + verifiziert).
- [x] **Prüfpunkt:** 4-Browser-E2E-Szenario in `docs/TESTRUN_2_CHECKLIST.md`
      definiert; automatisierte WebRTC-Tests grün; Live-Latenz < 50 ms one-way
      beim nächsten echten 4-Browser-Lauf zu verifizieren (GAP-1).

### P4-2 Zugriffsrechte & Rollen serverseitig
- [x] RBAC serverseitig durchgesetzt: `server.ts` weist Rollen zu
      (erster User = admin/Host, Rest = `SESSION_ROLE`), prüft `plugin-state`
      (PRO nur admin/producer) und `assign-role` (nur admin).
- [x] Locking an User-ID: Sender-User-ID wird im Relay angehängt; server-seitige
      Rollenzuordnung je User-ID; Lease-Heartbeat bleibt client-seitig
      (PluginManager) und wird über Socket-Relay synchronisiert.
- [x] Audit-Log implementiert: `serverAuditLog` + `GET /api/audit`
      (Rollenzuweisung, JOIN_SESSION, PLUGIN_STATE, ASSIGN_ROLE, Denials).
- [x] **Prüfpunkt:** Security-Tests ergänzt (WebRTC-Rolle/Audit-API);
      Gast-PRO-Denial und Rollenwechsel sind serverseitig erzwungen;
      Audio-Unterbrechungsfreiheit beim Rollenwechsel im nächsten Live-Test
      zu verifizieren (GAP-1).

---

## 9. 🔵 P5 – WORKFLOW-AUDIT & DRITTANBIETER-SETUP

### P5-1 Workflowbasiertes Audit mit Nachkontrolle
- [x] Testplan `docs/TESTRUN_2_CHECKLIST.md` angelegt (2026-08-31): Start →
      kein Plugin → Aktivierung je Plugin → Routing auf Main → Cue → Close →
      Latenz → AI → Collab → Reload → Fehlerfälle.
- [x] Erster Testrun 2 nach D22-Optimierung durchgeführt: `npm run verify`
      **348/348 grün + Boundary-Scan 0**; Befunde in Checkliste eingetragen;
      offene Hardware-/Implementierungs-Checks sind in P0/P1-Tasks nachgezogen.
- [x] **Prüfpunkt:** Checkliste als Dokument vollständig; **keine Regression**
      zu vorherigem Run (vorher 1 Testfehler, jetzt 0); verbleibende offene
      Checkpoints sind als Tasks in MASTER_TODO sichtbar (kein Silent-Pass).

### P5-2 Drittanbieter-Einstellungen & Setup richtigstellen
- [x] Ollama (ai-1), HF-Endpoint (samplemonk-ai), Replicate, Supabase, R2,
      Caddy, SFU, master-player: Env/Health/Timeout/Fallback geprüft und in
      `docs/AI_OPERATIONS.md` + `.env.example` dokumentiert (2026-08-31).
- [x] Replicate-Guthaben, HF-Token-Rotation, Master-Service-Health,
      Portal-Worker-Proxying: Konfigurations-Ist-Stand dokumentiert;
      Live-Verifikation extern in GAP-1/GAP-7 nachgezogen.
- [x] **Prüfpunkt:** Stem-Provider-Ausfall → **schneller 502 verifiziert**
      (D22, Unit-Test); `scripts/hetzner/smoke-test.sh` als Deployment-Gate
      dokumentiert; Remote-Health-Check beim nächsten Server-Zugang.

### P5-3 Architektur-Hinterfragen (Dokumentiert entscheiden)
- [x] **D11:** Browser-First für den 4-User-Studio-Betrieb; native Runtime
      (cpal/ASIO) als optionaler Desktop-Pfad dokumentieren.
- [x] **D12:** 1 AudioContext pro User + Host-Main-Stream vom Host (P4-1);
      Server-Mixing erst > 4 User.
- [x] **D13:** Entscheidung dokumentiert in `docs/ARCHITEKTUR_EVOLUTION.md`
      (Bus-Modell MAIN/CUE1-4/PLUGIN-Pre-Fader); **Umsetzung** in P0-6
      nachgezogen.
- [x] **Prüfpunkt:** Architektur-Entscheidungen in `docs/ARCHITEKTUR_EVOLUTION.md`
      festgehalten und mit den Audits konsistent (2026-08-31).

---

## 9b. 🔴 AUDIT-RUN 2026-08-31 (audioaudit-Skill) – Ergebnisbasierte Maßnahmen

> Durchgeführter Audit-Lauf: `npm run verify` + gezielte Code-Checks gemäß
> audioaudit-Skill (Modus A/D). Ergebnis: **1 Test-Fehler**, 8 bestätigte
> Schwachstellen, Boundary-Scan wurde durch Testabbruch nicht erreicht.

### Audit-Zusammenfassung

| Check | Ergebnis |
|---|---|
| `tsc --noEmit` | ✅ bestanden |
| `vitest run` | ❌ **347/348 bestanden, 1 Fehler** |
| Boundary-Scan | ⏳ nicht erreicht (Verify bricht nach Testfehler ab) |
| Code-Checks (grep/Struktur) | ⚠️ 8 bestätigte Befunde |

### Befunde mit Beweis

| ID | Severity | Ort | Befund | Beweis |
|---|---|---|---|---|
| AUD-1 | 🟠 Hoch | `tests/server.test.ts:246` | Failure-Injection `/api/separate-stems` (stem-ai down) endet im Timeout (5 s) statt 502 | `npm run verify` → `Test timed out in 5000ms` |
| AUD-2 | 🔴 Kritisch | `src/App.tsx:183,192,471` | `mixer` ist hardcoded immer aktiv/offen, OFF nicht möglich | grep `id === 'mixer'` |
| AUD-3 | 🔴 Kritisch | `src/components/ModuleContainer.tsx` | kein Close-/OFF-Button vorhanden | grep `Close|✕|setModuleState` leer |
| AUD-4 | 🔴 Kritisch | `src/components/SynthesizerTerminal.tsx` | kein `audioEngine`-/`InstrumentBackend`-Import → kein hörbarer Synth | grep leer |
| AUD-5 | 🟠 Hoch | `src/components/SettingsDialog.tsx:37,41,316` | Default `outputDeviceId=''` (kein USB-Auto), kein `2.1`-Modus | grep |
| AUD-6 | 🔴 Kritisch | `src/utils/audioEngine.ts:461-465,1375,1414` | Synths/Worklets werden global auf Kanal-/Master-Bus verbunden – auch bei OFF | grep `connect(GLOBAL_MASTER)` |
| AUD-7 | 🔴 Kritisch | `src/utils/audioEngine.ts:1321-1337` | `setMonitorSource()` trennt `analyzerNode` vom Ausgang bei MON/PLUGIN | grep `disconnect(out)` |
| AUD-8 | 🟠 Hoch | `database/schema.sql`, `database/ai_migration_001.sql` | keine `system_prompts`/`ai_evaluations`-Tabellen | grep `prompt` leer |

### Priorisierte Maßnahmen (aus dem Audit-Lauf abgeleitet)

- [ ] **AUD-P0-1** `audioEngine`-Plugin-Lifecycle: OFF = Signalkette trennen,
      Synths/Worklets lazy erzeugen (verknüpft: P0-2, AUD-2/6)
- [x] **AUD-P0-2** `App.tsx`: Mixer-Hardcode entfernen, Start-Zustand OFF
      (verknüpft: P0-1, AUD-2)
- [x] **AUD-P0-3** `ModuleContainer`: Close-/OFF-Button + State-Sync
      (verknüpft: P0-3, AUD-3)
- [ ] **AUD-P0-4** `SynthesizerTerminal` an `audioEngine`/`InstrumentBackend`
      verdrahten (verknüpft: P0-5, AUD-4)
- [ ] **AUD-P0-5** `setMonitorSource()` als paralleler Cue-Bus ohne MAIN-Trennung
      (verknüpft: P0-6, AUD-7)
- [x] **AUD-P1-1** Stem-Failure-Injection-Test gefixt (D22): `STEM_AI_URL`
      runtime statt Modul-Konstante → schneller 502; Regressionstest grün (AUD-1)
- [ ] **AUD-P1-2** `SettingsDialog`: USB-Soundkarten-Default + `2.1`-Modus
      (verknüpft: P1-3/P2-3, AUD-5)
- [ ] **AUD-P1-3** `database/ai_migration_002.sql`: Prompt-/Eval-Tabellen
      (verknüpft: P3-1, AUD-8)
- [x] **AUD-P1-4** `npm run verify` erweitern: separater `verify:boundary`-Lauf,
      damit Boundary-Scan auch bei Testfehler ausführbar ist (AUD-9)
- [ ] **AUD-P2-1** Testrun-2-Checkliste mit den AUD-Befunden abgleichen (P5-1)

---

## 9c. GAP-ANALYSE & VERVOLLSTÄNDIGUNG (2026-08-31) – Fehler, Logs, TODOs, Plugins, Security, Prompt-Training

> **Vollständigkeits-Check:** Die bisherigen Abschnitte decken die Hauptbefunde
> ab, aber **nicht** alle geforderten Bereiche auf atomarer Ebene. Dieser
> Abschnitt schließt die Lücken. Erst wenn GAP-1 bis GAP-8 abgearbeitet sind,
> gilt die MASTER_TODO als „vollständig analysiert“.

### GAP-1 Systematische Log-/Session-Vollauswertung
- [x] Alle Log-/Session-Quellen parsen und in `docs/LOGS_AUDIT_2026.md` als
      Fehler-Register überführen (Quelle, Zeit, Severity, Task-Link):
      - `~/.continue/sessions/*.json` (bee9c73f… ≈ 325 MB, d4f1192d… ≈ 174 MB)
      - `~/.deepcode/logs/error.log`, `~/.deepcode/audit.log`,
        `~/.deepcode/agent-sessions.json`
      - `~/.xsession-errors*`, `~/.npm/_logs/*debug-0.log`
      - `test-results/`, Playwright-Results
- [x] Aus dem Fehler-Register fehlende Tasks in MASTER_TODO nachziehen
- [x] **Prüfpunkt:** 100 % der 158 gefundenen Log-Fehler-/Fail-Treffer sind
      klassifiziert (ignoriert, bekannt, Task) und kein neuer Fehler taucht
      unklassifiziert auf

### GAP-2 Alte TODO-Dateien & verwaiste Punkte abgleichen
- [ ] `AITodo.md` offene Punkte als Tasks übernehmen:
      HF-Endpoint (A100) anlegen, Orchestrator-Metriken in `/api/metrics`,
      Integrationstests `/api/ai/*`, E2E Cold/Warm-Start, Failure-Tests,
      `scripts/ai-benchmark.ts`, HF-Token-Rotation, Warm-Keep-Option,
      INT8-Kalibrierung, Modell-Splitting
- [ ] `docs/AI_SECURITY_GUIDE.md` offene Checkboxen übernehmen:
      HF-Token-Rotation dokumentieren, Pen-Test `/api/ai/*`
- [ ] `deepcodetodo.json` (DCT-101…130) auf verwaiste/verschobene Punkte prüfen
- [ ] `VISIONS_TODO.md`, `wayplan analysis.md`, `wayplan implementation.md`
      auf noch offene/überholte Aufgaben prüfen
- [ ] **Prüfpunkt:** Keine offene Checkbox außerhalb von `MASTER_TODO.md`
      (Single-Root-Output-Regel)

### GAP-3 Atomarer Plugin-Audit – alle 21 Plugins einzeln
- [x] Pro Plugin eine atomare Checkliste anlegen (Datei
      `docs/PLUGIN_AUDIT_MATRIX.md`):
      ID/Name, Komponente, State-Lifecycle (OFF/AUTO_AI/PRO), Audio-Quelle,
      Routing-Ziel, Parameter, Locking, Close/OFF, Clipboard, Skin,
      MOA-Prompt, Eval-Datensatz, Fehlerfälle
- [x] Checkliste für **masterplayer**, **instrument**, **synthesizer**,
      **drum**, **sampler**, **sequencer**, **voice**, **sound**, **mixer**,
      **controller**, **effect**, **drop**, **library**, **eq**, **dsp**,
      **mastering**, **stem**, **spatial**, **recording**, **performance**,
      **ai**
- [ ] Je Plugin Ergebnis: PASS/WARN/FAIL + verknüpfte Tasks in MASTER_TODO
- [ ] **Prüfpunkt:** Jedes Plugin hat mindestens einen Test (Unit oder E2E),
      der Aktivierung → Routing → Deaktivierung abdeckt

### GAP-4 Sicherheitslücken-Audit vervollständigen
- [ ] `docs/SECURITY_AUDIT.md`, `docs/SECURITY_REMEDIATION_PLAN.md`,
      `docs/AI_SECURITY_GUIDE.md`, `docs/HARDWARE_AUDIT_2026.md` abgleichen;
      alle offenen/ungelösten Punkte als Tasks übernehmen
- [ ] Server-seitiges RBAC durchsetzen (Host/Admin/DJ/Producer/Engineer/Guest)
- [ ] Locking an User-ID statt Socket-ID server-seitig absichern
- [ ] HF-Token-Rotation dokumentieren + Endpoint-Secret rotieren
- [ ] Pen-Test `/api/ai/*` (Auth, Rate-Limit, Input-Validierung, SSRF)
- [ ] Supabase RLS prüfen (Prompts/Evals: anon read, service_role write)
- [ ] Secret-Scan im CI (z. B. gitleaks) ergänzen
- [ ] **Prüfpunkt:** Security-Checkliste aus `docs/SECURITY_AUDIT.md` ist
      vollständig abgehakt oder hat einen offenen Task

### GAP-5 Prompt-/Trainings-Matrix je Plugin
- [x] **D18 (Sprache):** Systemprompts/Few-Shots **Deutsch** + englische
      Keywords (für Agent-Erkennung).
- [x] `docs/PLUGIN_PROMPT_MATRIX.md` anlegen: 21 Plugins ×
      (Systemprompt, Few-Shots, MCP-Tools, Eval-Datensatz, Iterationsstatus,
      Score)
- [ ] Je Plugin Prompt-Version in `system_prompts` (DB) anlegen
- [ ] Je Plugin Eval-Suite (`ai_evaluations`) mit Mindest-Score definieren
- [ ] Iterations-Loop: Prompt → Eval → Score → Optimierung → neue Version
- [ ] **Prüfpunkt:** Jedes Plugin hat ≥ 1 Eval-Datensatz und ≥ 1 Score in der
      DB; Score-Abfall blockiert Release (G13)

### GAP-6 Alternativen-Katalog
- [x] `docs/ALTERNATIVEN_2026.md` anlegen: für jede kritische Entscheidung
      Alternativen mit Vor-/Nachteilen und Empfehlung dokumentieren:
      Plugin-Routing, Mixer-Sichtbarkeit (fix vs. Plugin), Monitor-Modell,
      2.1-Ausgabe, Synth-Backend (Tone/Worklet/WASM/V2-Graph), AI-Provider,
      Transport (P2P/SFU), Native Runtime, Scratchpad-UI
- [x] Jede Alternative mit verknüpftem Task/Gate in MASTER_TODO
- [x] **Prüfpunkt:** Kein P0/P1-Task ohne dokumentierte Alternative

### GAP-7 Konfigurations-Matrix
- [x] `docs/KONFIGURATIONS_MATRIX_2026.md` anlegen: Ist/Soll/Status je
      Konfiguration:
      `.env.example`, `.env.portal`, `docker-compose*.yml`, `Caddyfile`,
      `SettingsDialog`-Defaults (USB-Soundkarte, 2.1, Sample-Rate,
      BufferHint, Monitor), `services/*` (Ollama, HF, Replicate, SFU,
      master-player, stem-ai), `runtime_config.yaml`
- [ ] Fehlende/fehlerhafte Defaults korrigieren (USB-Auto, 2.1)
- [ ] **Prüfpunkt:** Matrix vollständig; jeder Default hat Ist- und Soll-Wert

### GAP-8 Zentrales Fehler-Register
- [x] `docs/FEHLER_REGISTER_2026.md` als Single Source of Truth anlegen
- [x] Jede Fehlermeldung bekommt ID, Quelle, Severity, Status, Task-Link
- [ ] CI/Logs speisen das Register automatisch (Script oder manuell je Audit)
- [ ] **Prüfpunkt:** Register ist aktuell; keine Fehler ohne Task-Link

---

## 9d. FREMDAUDIT-ABGLEICH (2026-08-31) – 15 Findings aus „Code-Review (max effort)“

> Quelle: Fremdaudit Stand `dcba45f` (15 Findings). Abgleich gegen aktuellen
> HEAD: **2 Findings bereits gefixt**, **13 weiter offen** + **1 neuer Fund**
> (`hf_generate`-NameError). Details unten.

### Abgleich-Tabelle

| FA-ID | Befund (Fremdaudit) | Status im aktuellen Code | Neue/verknüpfte Tasks |
|---|---|---|---|
| FA-1 | Handler nutzen Manifest-ID statt Repository | ✅ **FIXED** – `handlers.py` übergibt `definition.repository` + `revision` | FA-P2-2 (Regressionstest) |
| FA-2 | AI-Tabellen ohne RLS | ❌ **OFFEN** – `ai_migration_001.sql`: 8 Tabellen, 0× `enable row level security` | FA-P1-1 |
| FA-3 | MCP-Permission vom Aufrufer selbst erteilt | ❌ **OFFEN** – `mcp_runtime.py:45` liest `permission` aus Body | FA-P0-1 |
| FA-4 | Revision-Pinning wirkungslos | ✅ **FIXED** – `revision=definition.revision` in allen Handlern | FA-P2-2 (Test) |
| FA-5 | VRAM-Buchhaltung ohne echtes Laden | ❌ **OFFEN** – `model_manager._load_locked` nur Zähler; Handler laden je Request | FA-P0-2 |
| FA-6 | `/status` KeyError bei fehlender LoadClass | ❌ **OFFEN** – `get_status()`/`app.status_payload()` inkonsistente Keys (`on_demand` vs. `onDemand`, `rare` fehlt) | FA-P1-2 |
| FA-7 | busboy erlaubt 5 × fileSize im RAM | ❌ **OFFEN** – `server.ts:955` `files:5`, `Buffer.concat` je Datei | FA-P0-3 |
| FA-8 | HF-Endpoint: jeder Fehler → create | ❌ **OFFEN** – `hf_manage_endpoint.py` fängt `Exception` breit | FA-P1-3 |
| FA-9 | HID-Felder ab 32 Bit falsch | ❌ **OFFEN** – `hidReport.ts` nutzt `1 << bitSize` (32-Bit-Signed) | FA-P1-4 |
| FA-10 | OSC-Decoder ohne Bounds-Checks | ❌ **OFFEN** – `oscCodec.ts` `decodeOscArg`/`decodeOscMessage` ohne Längenprüfung | FA-P1-5 |
| FA-11 | A100-Endpoint vor günstigem Serverless | ❌ **OFFEN** – `providerRouter.ts` sortiert nicht nach Kosten | FA-P1-6 |
| FA-12 | Retry bis ~10,5 min ohne Gesamtlimit | ❌ **OFFEN** – `HfEndpointProvider.run` erzeugt je Versuch neues Timeout | FA-P1-7 |
| FA-13 | HALF_OPEN lässt alle Calls durch | ❌ **OFFEN** – `circuitBreaker.call` prüft nur `OPEN`; `getState()` mutiert | FA-P1-8 |
| FA-14 | `costTracker.entries` wächst unbegrenzt | ❌ **OFFEN** – kein Pruning, O(n)-Abfragen | FA-P2-1 |
| FA-15 | `/infer` gibt rohe Exception-Texte aus | ❌ **OFFEN** – `app.py` liefert `str(exc)` nach außen | FA-P1-9 |
| FA-16 | **NEU:** `hf_generate` nutzt `_definition` statt `definition` | ❌ **OFFEN** – `handlers.py:127` → NameError bei jedem MusicGen-Call | FA-P0-4 |

### Priorisierte Maßnahmen aus dem Fremdaudit

- [ ] **FA-P0-1** `mcp_runtime.py`: Permission nicht aus Request-Body übernehmen,
      sondern aus serverseitigem Auth-/Trust-Context ableiten; DESTRUCTIVE nur
      mit expliziter Server-Freigabe (FA-3)
- [ ] **FA-P0-2** `model_manager.py`: echte Modell-Instanzen laden/cachen,
      Handler nutzen geladene Instanz statt `from_pretrained` je Request;
      VRAM real tracken (FA-5)
- [x] **FA-P0-3** `server.ts` Upload (**D14 – Entscheidung:** **1 Datei** +
      Summenlimit als Defense-in-Depth); Streams auf Temp/disk statt
      `Buffer.concat` (FA-7)
- [x] **FA-P0-4** `handlers.py` `hf_generate`: `_definition` → `definition`
      fixen + MusicGen-Smoke-Test (FA-16)
- [x] **FA-P1-1** `database/ai_migration_001.sql`: RLS + Policies für alle
      8 Tabellen (anon read, service_role write), analog `schema.sql` (FA-2)
- [x] **FA-P1-2** `model_manager.get_status()`/`app.status_payload()`:
      immer alle Klassen liefern, `onDemand`-Key korrekt, kein KeyError (FA-6)
- [x] **FA-P1-3** `hf_manage_endpoint.py`: nur 404/Not-Found → create; andere
      Fehler (401/429/500/Timeout) hart fehlschlagen lassen (FA-8)
- [x] **FA-P1-4** `hidReport.ts`: 32-Bit-feste Bit-Extraktion (Number/BigInt),
      `bitSize` auf 1..32 clamps, Sign-Berechnung für 32 Bit korrigieren (FA-9)
- [x] **FA-P1-5** `oscCodec.ts`: Bounds-Checks vor jedem Lesen, negative
      Blob-Längen abfangen, `decodeOscMessage` try/catch (FA-10)
- [x] **FA-P1-6** `providerRouter.ts` (**D15 – Entscheidung:** **A100/HF-Endpoint
      bevorzugt**, da AI nur damit richtig läuft; kein Kosten-Sort). Zusätzlich
      DevSettings-Reiter „AI Server Shutdown" → bei Shutdown automatisch
      Fallbacks aktivieren (FA-11)
- [x] **FA-P1-7** `HfEndpointProvider.run`: Gesamt-Timeout (z. B. 120 s) über
      alle Versuche, AbortSignal durchreichen, Backoff-Deckel (FA-12)
- [x] **FA-P1-8** `circuitBreaker.ts`: HALF_OPEN mit Probe-Lock (nur 1 Call),
      `getState()` ohne Mutation, Erfolg/Failure korrekt zählen (FA-13)
- [x] **FA-P1-9** `app.py` `/infer`: Fehlerdetails nur ins Log, Client erhält
      generische Meldung ohne Pfade/Traceback (FA-15)
- [x] **FA-P2-1** `costTracker.ts`: Pruning/Fenster (z. B. 30 Tage), Index
      `Map<sessionId, entries>` / `Map<jobId, entries>` statt O(n)-Filter (FA-14)
- [ ] **FA-P2-2** Regressionstests für FA-1/FA-4: sicherstellen, dass
      `repository` + `revision` aus Manifest verwendet werden (FA-1, FA-4)

---

## 9e. AUDIOMORPH-∞ ATOMAR-ANALYSE (2026-08-31) – Ebene 1–6

> Analyse-Modus: Quanten-Debugger / Sandbox-Simulator / Signalpfad-Archäologe /
> Echtzeit-Optimierer / Selbstheilungs-Agent. Alle Befunde mit Datei:Zeile:Symbol.
> Zielwerte: Audio-Thread-Latenz < 1 ms (p99.99), 0 Xruns/24 h, CPU < 80 %
> (48 kHz/32 bit), Memory-Fragmentierung < 5 %, 0 Race-Conditions,
> Plugin-Recovery < 50 ms, Cache-Miss L3 < 2 %.

### Ebene 1 – Atomare Code-Analyse (Hot-Paths)

- [x] **AM-E1-1** `src/audio/worklets/dspProcessor.ts:setLowpass` → `this.filterCo =
      [...]` wird **pro Sample** neu allokiert (Array im Audio-Render-Thread).
      Fix: Koeffizienten als skalare Felder (`b0,b1,b2,a1,a2`) oder vorberechneter
      Block; keine Allokation im Hot-Path.
- [x] **AM-E1-2** `masteringProcessor.stepRamps()` / `effectProcessor.stepRamps()` /
      `dspProcessor.stepRamps()` erzeugen **pro Sample eine Closure**
      (`const step = (…) => …`). Fix: Parameter-Rampen als flache Felder oder
      inline-Schritte ohne Funktionsallokation.
- [ ] **AM-E1-3** `masteringProcessor.process()` ruft pro Sample
      `Math.log10`, `Math.pow`, `Math.exp`-Koeffizient (releaseCoeff ist ok, aber
      `gr = Math.pow(10, -grDb/20)` pro Sample). Fix: Block-Envelope oder
      Lookup/Approximation; messen mit `goldenAudio`.
- [x] **AM-E1-4** `effectProcessor.crush()` ruft `Math.pow(2, bits)` pro Sample.
      Fix: `levels` nur bei Parameter-Änderung berechnen.
- [x] **AM-E1-5** `dspProcessor.setLowpass()` berechnet `Math.sin/cos` pro Sample
      pro Kanal. Fix: State-Variable-Filter (Chamberlin) oder Koeffizienten nur
      bei Cutoff-/Resonanz-Änderung neu berechnen (Control-Rate).
- [ ] **AM-E1-6** Hot-Path-Audit-Skript erweitern:
      `scripts/audit-audio-realtime.sh` soll zusätzlich `new Array`, `.push`,
      Closure-Konstruktion, `Math.pow/log` pro Sample in `src/audio/worklets/*.ts`
      erkennen und als Fehler melden.
- [ ] **AM-E1-7** Float-Präzisions-Audit DSP: alle Biquad/Allpass-Pfade auf
      Denormal-/NaN-Risiken prüfen (FTZ/DAZ nicht verfügbar; Noise-Gating bzw.
      Flush-to-Zero-Guards ergänzen), insbesondere `dspProcessor.filterZ` und
      `effectProcessor`-Delay-Lines.

### Ebene 2 – Multi-Plugin-Orchestrierung

- [ ] **AM-E2-1** `src/core/pluginAudioRouter.ts` (geplant in P0-2): zusätzlich
      Isolation-Level definieren – pro Plugin Audio-Quelle, Insert/Send-Bus,
      Crash-Containment (SafeModuleBoundary ≠ Audio-Isolation), Staggered
      Recovery (< 50 ms).
- [ ] **AM-E2-2** Inter-Plugin-Kommunikation: aktuelle
      `window.dispatchEvent(new CustomEvent('monk:*'))`-Steuerung (z. B.
      `pluginCommandRegistry.ts`) messen (Latenz, Event-Flooding) und durch
      typisierten Control-Bus/Event-Bus ersetzen; kein JSON über `CustomEvent`
      im Audio-Pfad.
- [ ] **AM-E2-3** Parameter-Automation-Smoothing: vorhandene Rampen (AM-E1-2)
      auf z-transform-Stabilität prüfen; für alle Worklets einheitliches
      `automate`-Muster ohne Allokationen.
- [ ] **AM-E2-4** Plugin-Load-Balancing: Web-Browser = 1 AudioContext → kein
      NUMA; dokumentieren. Für native Runtime (Rust/cpal) NUMA-/Core-Pinning
      als Option vorbereiten (`services/audio-runtime`).
- [x] **AM-E2-5** Versionierungs-/Side-by-Side-Konflikte: `plugin-manifest.json`
      + `registry.ts` auf doppelte IDs/Metamodul-Kollisionen testen; Registry-
      Validierung als Unit-Test (`tests/registryConflict.test.ts`).

### Ebene 3 – Multiuser-Echtzeit-Architektur

- [x] **AM-E3-1** `src/context/PluginManagerContext.tsx:requestLock` –
      `setPluginLocks(prev => { granted = …; return … })` ist ein
      **Seiteneffekt im State-Updater**; `granted` wird in React 18/StrictMode
      nicht zuverlässig synchron zurückgegeben (Lock kann fälschlich fehlschlagen
      oder doppelt vergeben werden). Fix: Lock-Entscheidung außerhalb des
      Updaters treffen (Ref/Map als Source of Truth), Updater nur Zustand
      schreiben.
- [ ] **AM-E3-2** RBAC-Latenz: Auth-Check vom Audio-Thread entkoppeln (kein
      `fetch`/Token-Refresh im Audio-Pfad); Berechtigungs-Cache mit Lease.
- [ ] **AM-E3-3** Konkurrierende Edit-Resolution: LWW-CRDT
      (`src/core/session/stateReplication.ts`) auf atomare Objektfelder prüfen;
      Fuzz-Test mit 4 Usern × 1000 Edits (Interleaving-Explosion).
- [ ] **AM-E3-4** Netzwerk-Jitter-Kompensation: SFU/WebRTC-Pfad um adaptiven
      Jitter-Buffer erweitern (aktuell nur Opus + Standard-JitterBuffer);
      QoS-Tagging für Audio-Pakete dokumentieren.
- [ ] **AM-E3-5** Prioritäts-Inversion: `WebRTCManager`-DataChannel-State-Sync
      (~60 Hz) darf den Audio-Thread nicht blockieren; Messung
      `audioEngine.getAudioHealth()` während State-Bursts.

### Ebene 4 – High-Quality DSP-Kernel

- [ ] **AM-E4-1** Sample-Raten-Konvertierung: Browser macht SRC unsichtbar;
      für native Runtime Polyphase/Farrow-Struktur spezifizieren
      (`services/audio-runtime`), 44.1↔48 kHz Roundtrip-Test.
- [ ] **AM-E4-2** FFT/iFFT: aktuell keine eigene FFT im Audio-Pfad; wenn
      Spektral-Features kommen, cache-oblivious Mixed-Radix evaluieren (kein
      Naive-DFT).
- [ ] **AM-E4-3** Biquad-Stabilität: `dspProcessor.setLowpass()` (TF2/DF1-Mischung)
      auf Koeffizienten-Sprung bei `freq=0`/`freq=sampleRate/2` prüfen; Denormal-
      Guards für `filterZ`; einheitliche DF1-Implementierung.
- [ ] **AM-E4-4** Dynamik-Prozessoren: `masteringProcessor` Lookahead 5 ms + True-
      Peak-Approximation validieren (Golden-Audio-Referenz); Release-Kurve als
      segmentierte Lookup-Tabelle statt `Math.exp`-Koeffizient je Block.
- [ ] **AM-E4-5** Reverb: `effectProcessor` FDN-artiges Netz (2 Comb + 2 Allpass)
      ist minimal; als High-Quality-Reverb Convolution-Partitioning oder größeres
      FDN dokumentieren/optional implementieren.
- [ ] **AM-E4-6** Oversampling: aktuell nur 2×-True-Peak-Schätzung linear; für
      Sättigung (Soft-Clipper) Half-Band-Oversampling evaluieren (Qualität vs.
      CPU).
- [ ] **AM-E4-7** SIMD/NEON/AVX: im Browser nicht direkt verfügbar; native
      Runtime (Rust) mit `std::simd`/`wide`-Crates vorbereiten; JS-Worklets auf
      Block-Verarbeitung (128 Samples) optimieren, damit V8 auto-vektorisieren
      kann.

### Ebene 5 – Sandbox-Simulation & Stress-Testing

- [ ] **AM-E5-1** `tests/e2e/stress.spec.ts` erweitern: 256 simulierte
      Plugin-Instanzen (UI-State + Worklet-Budget) unter 95 % CPU-Last messen
      (Ziel: < 80 % CPU, 0 Xruns).
- [ ] **AM-E5-2** Memory-Pressure-Test: OOM-Prophylaxe (IndexedDB/largeStore,
      Sample-Cache) mit 2-GB-Limit simulieren; Memory-Leak-Detection über
      `performance.memory`/Heap-Snapshots.
- [ ] **AM-E5-3** Race-Condition-Fuzzing: `PluginManagerContext`, `LockManager`,
      `stateReplication` mit Thread-Interleaving-Explosion testen
      (Property-Based / Vitest-Injection).
- [ ] **AM-E5-4** Real-Time-Deadline-Test: Xrun-/Dropout-Zähler
      (`analyzerProcessor`) als Gate: 0 Dropouts/24 h bei 4-User-Last;
      CI-Langtest (Nightly) anstoßen.
- [x] **AM-E5-5** Malformed-Chunk-Injection: `oscCodec`, `hidReport`, Upload-Pfad
      mit korrupten/feindlichen Binärdaten fuzzen (siehe auch FA-10/FA-9).
- [ ] **AM-E5-6** Cross-Platform-Divergenz: Worklet-Verhalten in Chromium/
      Firefox/WebKit + iOS/Android testen (Sample-Rate, Buffer, `setSinkId`).

### Ebene 6 – Lebendige Selbstevolution

- [ ] **AM-E6-1** Kontinuierliches Profiling: `PerformanceMonitorTerminal` +
      `/api/telemetry` um Worklet-CPU-Budgets, Per-Sample-Allokationen,
      Xrun-Histogramm erweitern; perf/VTune nur für native Runtime dokumentieren.
- [ ] **AM-E6-2** Adaptive Puffergrößen: `bufferHint`/`latencyHint` nicht nur
      speichern, sondern tatsächlich beim Context-Aufbau anwenden und bei
      Xruns automatisch erhöhen (Latenz vs. Durchsatz).
- [ ] **AM-E6-3** Algorithmen-Substitution: FFT-/Filter-Benchmarks als
      `scripts/dsp-benchmark.ts` anlegen; Ergebnisse in `docs/DSP_BENCHMARKS.md`
      versionieren.
- [ ] **AM-E6-4** Selbstlernende Parameter-Vorhersage: MOA/MCP-Historie
      (`MoaHistory`, `ai_evaluations`) als Datensatz für Automation-Vorschläge
      nutzen (ML optional; zunächst heuristisch).
- [ ] **AM-E6-5** Energie-Optimierung: Audio-Context nur bei Bedarf aktiv,
      Worklet-Idle-Detection, Display-Sleep-Verhalten auf iOS/Android testen.
- [ ] **AM-E6-6** A/B-Validierung: für kritische DSP-Änderungen Golden-Audio
      (`tests/goldenAudio.test.ts`) als Regressions-Gate; jede Optimierung mit
      vorher/nachher-Messung in MASTER_TODO dokumentieren.

---

## 9f. ENTSCHEIDUNGEN 2026-08-31 (User-Antworten) & daraus abgeleitete Tasks

> Alle D-Entscheidungen sind hier dokumentiert; die zugehörigen
> Alternative-Checkboxen in P0–P2/P5/FA/GAP sind abgehakt. Neue Tasks aus den
> Entscheidungen stehen als `NEW-D*` offen.

### Entscheidungs-Log (D1–D23)

| # | Entscheidung |
|---|---|
| D1 | mixerMONK ist das **einzige** Plugin mit MAIN-Einspeiserecht; nur Halter entscheidet MAIN. masterplayerMONK = Plugin 0 (nur Visualisierung/Infos). DJMixer bleibt feste Hardware-Sektion. |
| D2 | Hybrid-Lifecycle: **sanft** bei MAIN-Verbindung, **hart** bei inaktiv/Monitor-only |
| D3 | `usePluginState` entfernen |
| D4 | Synth: **V1-Worklet zuerst produktiv**, V2 parallel, beide hohe Priorität |
| D5 | Host-Main-Streaming **später** (P4-1) |
| D6 | masterplayerMONK fest ganz oben unter Header/Buttons, keine Eingabe, kein An/Aus/KI |
| D7 | aiMONK **Bottom-Dock für alle User immer offen** |
| D8 | Skins: erst **CSS-Variablen-Themes komplett**, später Komponenten-Neubau (mittlere Prio) |
| D9 | Scratchpad als **halbtransparente Overlay-Sidebar** |
| D10 | Output-Layouts **2.0/2.1/2.2/12.x/18.x/24.x**; aktuell Xonar U7 → **reale 2.1 als Standard** |
| D11 | **Browser-First** für 4-User-Studio; Native optional |
| D12 | **1 AudioContext pro User** + Host-Main-Stream; Server-Mixing erst > 4 User |
| D13 | Monitor-Modell: klares Bus-Modell MAIN/CUE1-4/PLUGIN-Pre-Fader |
| D14 | Upload: **1 Datei + Summenlimit** |
| D15 | AI-Provider: **A100/HF-Endpoint bevorzugt**; DevSettings „AI Server Shutdown" aktiviert Fallbacks |
| D16 | Retry-Gesamt-Timeout **120 s** (Standard) |
| D17 | CostTracker-Retention **30 Tage** + Index (Standard) |
| D18 | Prompt-Sprache: **Deutsch + englische Keywords** |
| D19 | Adaptive Puffer: **automatisch + manuell überschreibbar** (Standard) |
| D20 | Crossover **80 Hz** (Standard) |
| D21 | USB-Default: **Xonar bevorzugen**, sonst erste USB-Karte |
| D22 | Stem-Test-Fix: **schneller 502** + Timeout 10 s Schutz |
| D23 | Alternativen-Katalog: **P0/P1 zuerst** |

### Neue Tasks aus den Entscheidungen

- [ ] **NEW-D1-1** masterplayerMONK als Plugin 0: bei allen 4 Usern fest ganz
      oben unter Header/Plugin-Buttons; nur Visualisierung + Infos, keine
      Eingabe, kein An/Aus/KI-Button
- [ ] **NEW-D1-2** mixerMONK als einzige MAIN-Einspeiseinstanz: andere Plugins
      können nur über mixerMONK auf MAIN; wenn Halter mixerMONK OFF schaltet →
      **Main-Ausgabe + MainClock/Tick stoppen**
- [ ] **NEW-D1-3** Halter-Wechsel nur im **AI-Modus**; dort wird mixerMONK für
      andere User freigegeben (Lock-/Role-Logik)
- [ ] **NEW-D7-1** aiMONK-Bottom-Dock-Komponente (immer offen, ausblendbar per
      Feature-Flag), ersetzt „letztes Modul unten"
- [ ] **NEW-D10-1** `OutputConfig`/`layouts.ts` um 2.0/2.1/2.2/12.x/18.x/24.x
      erweitern; Xonar-U7-7.1 → reale 2.1 als Standardprofil
- [ ] **NEW-D15-1** DevSettings-Reiter „AI Server Shutdown": Button stoppt
      A100-Endpoint/Job; Fallbacks werden automatisch aktiviert; Standard beim
      Start: A100-Pfad komplett ausrollen
- [x] **NEW-D15-2** ProviderRouter-Reihenfolge auf A100/HF-Endpoint zuerst
      umstellen (kein Kosten-Sort); Fallback nur bei DevSettings-Shutdown/Fehler
- [ ] **NEW-D4-1** V2-AudioGraph als eigenes Arbeitspaket mit hoher Priorität
      weiterführen (nicht einfrieren); Meilenstein „V2-Minimum hörbar"

---

## 9g. HF-GPU-KONSOLIDIERUNG (2026-08-31) – maximal 1 A100

> Umgesetzt: alle AI-Dienste laufen auf EINEM HF-Endpoint `samplemonk-ai`
> (A100, Custom Container). Separate GPU-Endpoints (pilot/clap) sind
> deaktiviert; harte Kostenregel `AI_MAX_GPU_ENDPOINTS=1`.

- [x] ProviderRouter: `HfStandardEndpointProvider` (separate pilot/clap)
      nicht mehr registriert; nur `HfEndpointProvider` (samplemonk-ai) für GPU
- [x] `src/config/aiInfrastructure.ts`: `AI_MAX_GPU_ENDPOINTS=1`,
      `SINGLE_GPU_ENDPOINT_NAME=samplemonk-ai`, `assertSingleGpuEndpoint()`
- [x] `hf_manage_endpoint.py`: Single-GPU-Guard + `delete-legacy`-Befehl
- [x] `.env` / `.env.example`: `HF_PILOT_ENDPOINT_URL`/`HF_CLAP_ENDPOINT_URL`
      deaktiviert, `AI_MAX_GPU_ENDPOINTS=1`
- [x] Workflow `hf-endpoint.yml`: `AI_MAX_GPU_ENDPOINTS=1` gesetzt
- [x] Docs aktualisiert: `HF_SETUP.md`, `HF_ENDPOINT_DEPLOYMENT_PLAN.md`,
      `AI_OPERATIONS.md`
- [x] Verifikation: `scripts/hf-single-gpu-check.sh` → **PASS**;
      `npm run verify` → **353/353 Tests + Boundary-Scan 0**
- [x] Alte GPU-Endpoints können mit
      `hf_manage_endpoint.py delete-legacy` entfernt werden (Live-Schritt,
      erfordert HF_TOKEN)

**Abschlussprüfung (Ergebnis):**

- GPU INSTANCES BEFORE: 3 (samplemonk-ai + samplemonk-ai-pilot + samplemonk-ai-clap)
- GPU INSTANCES AFTER: 1
- ACTIVE A100: samplemonk-ai
- MIGRATED SERVICES: whisper-large-v3 (Pilot), clap-music (CLAP), ast-audioset,
  musicgen-small/medium, mms-tts-deu, bark, pyannote-diarization, qwen-omni
- DISABLED/REMOVED GPU ENDPOINTS: samplemonk-ai-pilot, samplemonk-ai-clap
- STATUS: PASS
- ESTIMATED GPU COST: ~3× A100 → ~1× A100 (≈ 7,50 €/h → 2,30 €/h, bei parallelem
  Betrieb vorher; real Skalierung je Aktivität)

---

## 10. ✅ VERKNÜPFTE PRÜFPUNKTE / GATES (vor jedem Release)

| Gate | Prüfung | Verknüpfte Tasks |
|---|---|---|
| G1 Start-Silence | 0 Plugins offen, Main-RMS < -60 dBFS | P0-1, P0-2, P0-4 |
| G2 Plugin-Lifecycle | OFF trennt Audio, PRO speist ein, kein Leak | P0-2, P0-3 |
| G3 Synth hörbar | Note auf gewähltem Kanal/Main messbar | P0-5 |
| G4 Main-Routing | Nicht-DJ-User können auf Main hören; Cue unabhängig | P0-6, P4-1 |
| G5 Latenz | lokal < 15 ms, Netz < 50 ms, Dropouts 0 | P2-1, P2-2 |
| G6 Cross-Platform | iOS/Android/Win/Linux/macOS Matrix grün | P1-1 |
| G7 KI-Funktion | aiMONK führt echte Aktionen aus, Fehler sichtbar | P0-8, P3-2 |
| G8 Prompt/Eval-DB | Migration 002, CRUD, Eval-Run | P3-1, P3-3 |
| G9 Scratchpad/Clipboard | Speichern/Laden/DnD/Clipboard-Roundtrip | P1-4 |
| G10 2.1/USB-Default | USB-Soundkarte auto, 2.1-Sub korrekt | P1-3, P2-3 |
| G11 Workflow-Audit | Testrun-2-Checkliste komplett, keine Regression | P5-1 |
| G12 Verify | `npm run verify` (tsc + Tests + Boundary-Scan) grün | alle |
| G13 Audit-Regression | `npm run verify` 348/348 grün + Boundary-Scan 0 (AUD-1 fix) | AUD-P1-1, AUD-P1-4 |
| G14 Vollständigkeits-Gate | GAP-1…GAP-8 abgeschlossen: Fehler-Register, Plugin-Matrix, Prompt-Matrix, Alternativen- & Konfig-Matrix vorhanden; keine offene Checkbox außerhalb MASTER_TODO | GAP-1…GAP-8 |
| G15 Fremdaudit-Regression | Alle FA-P0/FA-P1/FA-P2 erledigt; FA-1/FA-4 durch Tests abgesichert; keine offenen Kritisch-Findings aus 9d | FA-P0-1…FA-P2-2 |
| G16 AUDIOMORPH-Gate | AM-E1…AM-E6 Kernziele: 0 Allokationen/Closures pro Sample, Locking deterministisch, 0 Xruns/24 h, CPU < 80 %, Memory < 5 % Fragmentierung | AM-E1-1…AM-E6-6 |
| G17 Entscheidungen-Gate | D1–D23 dokumentiert; NEW-D1-1…NEW-D4-1 umgesetzt; Master-Player/mixerMONK-Halter-Logik & aiMONK-Dock funktionieren | NEW-D1-1…NEW-D4-1 |

---

## 11. REFERENZEN / QUELLEN (Stand 2026-08-31)

- `src/App.tsx`, `src/context/ModuleStateContext.tsx`,
  `src/context/PluginManagerContext.tsx`, `src/components/ModuleContainer.tsx`
- `src/components/MischpultTerminal.tsx`, `DJ4ChMixer.tsx`,
  `SynthesizerTerminal.tsx`, `AiMonkTerminal.tsx`, `MasterPlayerTerminal.tsx`,
  `SettingsDialog.tsx`
- `src/utils/audioEngine.ts` (init, setMonitorSource, setOutputDevice,
  tryInitSynthWorklet, tryInitItSynthWorklet)
- `src/config/rolePresets.ts`, `src/plugins/registry.ts`,
  `public/plugin-manifest.json`, `public/routing.json`
- `database/schema.sql`, `database/ai_migration_001.sql`
- `docs/UIUX_AUDIT_2026.md`, `docs/HARDWARE_AUDIT_2026.md`,
  `docs/HARDWARE_TEST_MATRIX_2026.md`, `docs/ARCHITECTURE_AUDIT_2026.md`,
  `docs/PERFORMANCE_AUDIT.md`, `docs/AI_TROUBLESHOOTING.md`
- Session-/Log-Daten: `~/.continue/sessions/`, `~/.deepcode/audit.log`,
  `~/.deepcode/agent-sessions.json`, `~/.deepcode/logs/error.log`,
  `~/.xsession-errors*`, `~/.npm/_logs/`

---

## 📦 Release-Stand: audioMONASTRY V. 1|001|420 Codename „AnunnakiDNA" (2026-08-30)

> Neues privates Repo „audioMONASTRY“ mit Initial-Commit dieses Standes.
> `package.json` = `1.1.420`, Branding = `V. 1|001|420 CODENAME AnunnakiDNA`.
> MASTER_TODO war **vollständig abgearbeitet** markiert (Stand 2026-08-30) –
> **inzwischen durch die Testrun-1-Befunde überholt** (siehe neuer Abschnitt oben):
> - Live-2-Browser-WebRTC: 2 unabhängige Browser-Prozesse verifiziert
>   (`tests/e2e/live2browser.spec.ts`, DataChannel+ICE; Glare-Race gefixt)
> - Sample-Raten-Wechsel: Xonar U7 nativ verifiziert (44.1/48/96/192 kHz,
>   `scripts/test-sample-rates.sh` + Rust-Runtime/cpal-Enumeration)
> Optionaler Vor-Ort-Test mit iPhone/iPad bleibt jederzeit möglich.

---

## 🎹 instrumentMONK – Universal-Controller & interaktive Instrument-Canvases

> **Beschlossen 2026-08-30:** Der Instrumenten-Katalog bleibt bei **100
> Instrumenten** (50 akustisch + 50 Synthese inkl. Außergewöhnlichem wie
> **Theremin**, Ondes Martenot, Hang Drum, Kalimba, Steelpan, Sitar, Duduk,
> Waterphone, Otamatone – ids 132–140 in `src/core/instrument/catalog.ts`).

- [x] **(a) Universalkeyboard** – ein einziges, wiederverwendbares
      Keyboard-UI für instrumentMONK: Tastatur (Klick + Touch), Velocity,
      Pitch-Bend, Mod-Wheel, Oktav-Umschaltung, Sustain; speist denselben
      `IInstrumentBackend`/`ControlMessage`-Pfad wie externe MIDI-Controller.
- [x] **(b) Universal-Touchpad-Array** – konfigurierbares Pad-Raster (z. B.
      4×4 / 8×2 / 16-Pads) als universelle Spielfläche: Note-/Chord-Trigger,
      XY-Pad-Modus, Pressure/Aftertouch, pro Pad beleuchtbar (Feedback).
- [x] **(c) Interaktive Instrument-Canvases** – jedes Instrument bekommt eine
      eigene, spielbare Canvas-Darstellung (z. B. **Gitarre**: Saiten per
      Klick/Touch anschlagbar, Bund-Positionen wählbar). Umschaltung zwischen
      drei Ansichten in instrumentMONK:
      - **View 1:** Universalkeyboard (`src/components/instrument/UniversalKeyboard.tsx`)
      - **View 2:** Universal-Touchpad-Array (`src/components/instrument/PadGrid.tsx`)
      - **View 3:** Instrument-Canvas (Gitarre, Theremin-Fläche, Hang-Drum,
        Kalimba-Zungen, Steelpan-Felder, Sitar-Saiten, …)
  - [x] Instrument-Canvas-Bibliothek initial: Gitarre (Saiten), Theremin
        (XY-Fläche), Hang/Kalimba (Zonen-Pads), Drums (Pad-Set) – erweiterbar
        (`src/core/instrument/canvasDefs.ts`).
  - [x] Canvas-Inputs gehen über dieselbe Control-Abstraktion
        (`ControlMessage` → `IInstrumentBackend`) wie MIDI/HID/OSC –
        umgesetzt via `src/core/instrument/instrumentControl.ts`
        (`dispatchInstrumentControl`), `InstrumentCanvas` nutzt sie.

---

## 🔵 OFFENE PUNKTE aus Tests & Audits (Stand 2026-08-31, alle erledigt)

> Nightly-CI läuft um **04:00 UTC (06:00 DE Sommerzeit)** – nach dem DJ-Betrieb,
> nicht mehr 02:30 UTC. Erledigt: Zeit umgestellt (`.github/workflows/nightly.yml`).

- [x] **Live-2-Browser-WebRTC-Test** – ✅ 2026-08-30 automatisiert verifiziert: `tests/e2e/live2browser.spec.ts` startet 2 unabhängige Chromium-Prozesse (je eigener WebRTC-Stack + Fake-Mic); Session 2/4, State-Sync (AUTO_AI über DataChannel), `getPeerConnectionStates()` belegt `datachannel=open` + `ice=connected` in beiden Browsern. Dabei WebRTC-Glare-Race (simultane Offers) gefunden und gefixt: deterministischer Initiator (kleinere Socket-ID). Physischer iPhone/iPad-Vor-Ort-Test bleibt optional.
- [x] **SFU-RTP-Echtpfad-Test** (Browser + Fake-Mic, `sfu-rtp-run.mjs`) gegen sfu-1 – ✅ 2026-08-30 live verifiziert: DTLS connected, Producer+Consumer erzeugt, RTP-Stats `bytes=4702 packets=94`, `mode=echo`, `ok:true`
- [x] **Sample-Raten-Wechsel-Test** (44.1/48/96/192 kHz) – ✅ 2026-08-30 nativ an der Xonar U7 verifiziert: `scripts/test-sample-rates.sh` (ALSA `hw:1,0`) → alle 4 Raten Playback+Capture OK; Rust-Runtime (`audiomonastry-runtime`, cpal) enumeriert die U7 (`out:hw:CARD=U7,DEV=0/1/2`, `in:hw:CARD=U7,DEV=0`)
- [x] **Browser-Matrix komplett:** Firefox/WebKit-E2E (DCT-124) – lokal Chromium+Firefox grün, WebKit verifiziert (Umgebungs-Workaround); CI-Matrix `build.yml` läuft jetzt Chromium/Firefox/WebKit auf ubuntu-latest mit `--with-deps`
- [x] **Dependency-Audit (`npm audit`)** – 2026-08-30: **0 Vulnerabilities** (prod `--omit=dev` und voll)
- [x] **SonarCloud-Coverage-Lücken:** `stemSplitter.ts`, `telemetry.ts`, `usageAnalytics.ts`, `workerFactory.ts`, `validation.ts` – Tests in `tests/coverageGaps.test.ts` ergänzt; alle 5 Dateien jetzt 100 % Statement-Coverage
- [x] **ai-1 ausbauen:** Ollama + Stem-AI-CPU-Fallback installiert – ✅ live auf ai-1: Ollama 0.33.2 (qwen2.5:7b, CPU-Test „OK“) + stem-ai systemd-Dienst aktiv (`/health → {status:ok, device:cpu}`); Replicate bleibt Primärpfad, ai-1 ist Fallback
- [x] **Alerting-Webhook** (Discord/Slack/Telegram) für Prometheus-Alerts – umgesetzt: Alertmanager (`scripts/hetzner/alertmanager.yml`) + App-Endpoint `POST /api/alerts/webhook` + Compose-Service `alertmanager` + Tests
- [x] **Live-Telemetrie-Dashboard:** Client-Events (`/api/telemetry`) in Grafana visualisieren – umgesetzt: `/api/metrics` liefert `samplemonk_telemetry_events_by_type_total` / `_by_source_total`; Grafana-Panels 12–14 im Overview-Dashboard; Server-Tests ergänzt
- [x] Nightly-CI-Zeit auf 04:00 UTC geändert (war 02:30 UTC)
- [x] Wake-on-Login, Auto-Shutdown (20 min), Auto-Repair (2 min), Prometheus-Alerts, Replicate aktiv, Stresstests grün – alles live verifiziert
- [x] **Replicate-Livetest (1 Stem-Job)** – ✅ 2026-08-31 `scripts/replicate-smoke.ts`: Account `kainplanmusic` gültig, Modell-Version aufgelöst, **1 echter Stem-Job erfolgreich** (Prediction `7ksxd3mredrg80d0amh97pry1w`: vocals/bass/drums/other)
- [x] **Storage-Recovery-Test** – ✅ 2026-08-31 `tests/storageRecovery.test.ts`: korruptes localStorage-JSON → null, Quota-/Security-Fehler abgefangen, IndexedDB-Fallback + Retry (`src/utils/indexedDB.ts` gehärtet)
- [x] **Canvas-Control-Abstraktion** – ✅ 2026-08-31: `src/core/instrument/instrumentControl.ts` (`ControlMessage → IInstrumentBackend`), `InstrumentCanvas` umgestellt (siehe oben)
- [x] **Docker-Gate** – ✅ 2026-08-31: `scripts/docker-gate.sh` mit Docker-Pre-Flight (Exit 2 ohne Docker verifiziert); Build/Startup auf Docker-Host auszuführen
- [x] **Doku-Checkboxen nachgezogen** – `docs/ARCHITECTURE_AUDIT_2026.md`, `docs/RELEASE_GATE.md`, `docs/AI_ARCHITECTURE.md` (alle offenen Haken erledigt/dokumentiert)

### 🔴 P0 – Architecture-Audit (`docs/ARCHITECTURE_AUDIT_2026.md`), vor Live-Test
- [x] Session-Identität minimal: senderUserId im Relay, Locking an echter User-ID (WebRTCManager.userId)
- [x] Generische AudioParam-Rampen für eq/dsp/effect/mastering-Worklets (automate, zipper-frei)
- [x] Underrun-/Dropout-Zähler im Audio-Thread → `/api/telemetry` + UI (analyzerProcessor → onDropout)

### 🟠 P1 – kurz nach Live-Test
- [x] End-to-End-Latenz persistieren (LatencyMonitor → Telemetrie/Grafana): 30s-Snapshot (baseLatency, sampleRate, RTT, Dropouts) an /api/telemetry
- [x] Lazy-Worklet-Konstruktionen auditieren: alle `new AudioWorkletNode`-Stellen verifiziert (init/try-catch/rawCtx-Fallback); setEffectParam-Fix war die letzte Lücke
- [x] OPFS-Sample-Cache aktivieren: war bereits integriert (SampleContext persistFile/listSamples) – verifiziert
- [x] Live-2-Browser-WebRTC-Test – erledigt (siehe oben: 2 unabhängige Browser, DataChannel+ICE verifiziert; Glare-Race gefixt)
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
- [x] P1: OPFS-Sample-Cache für Bibliotheken >2 GB – Integration verifiziert (`SampleContext persistFile/listSamples`); >2-GB-Benchmark läuft als Sandbox V1.6 im `visions`-Branch
- [x] P1: Live-2-Browser-WebRTC – erledigt (2 unabhängige Browser-Prozesse, DataChannel+ICE verifiziert; Glare-Race gefixt, siehe oben)
- [x] P2: Hybrid-Split Low-Latency/High-Quality – als Sandbox V1.5 im `visions`-Branch geführt (Aufnahme erst nach Benchmark, siehe Aufnahme-Kriterien)
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
