# TASKDONE – Archiv erledigter Aufgaben

> Erledigte Punkte aus `MASTER_TODO.md` werden hierher verschoben und
> aus der `MASTER_TODO.md` gelöscht. Dies ist das zentrale Archiv.
> Stand: 2026-09-01
> Quellen: `audioMONASTRY/MASTER_TODO.md` + `samplemonk/MASTER_TODO.md`

---

## Quelle: audioMONASTRY/MASTER_TODO.md

### 🎯 Nächste TODOs (in dieser Reihenfolge)

- [x] **AI-Modelle einzeln verifizieren** über `/api/ai/orchestrate`: Whisper (`audio.transcribe`), CLAP (`audio.embed`), MusicGen (`audio.generate`) → **2026-09-01 live verifiziert (alle 200)**: Whisper transkribiert deutschen Gesang korrekt, CLAP liefert 512-d-Embedding, MusicGen generiert 5 s Audio, AST klassifiziert 440-Hz-Sinus als „Sine wave". HF-Runtime-Fixes deployed (Whisper-Bytes-Fix, CUDA-Inferenz, Modell-Cache, Audio-Resampling, `/status` mit `last_errors`). HF-Endpoint danach **scale-to-zero** (0 Replicas).
- [x] **aiMONK-Bottom-Dock** (D7/NEW-D7-1): immer offen, ausblendbar, Fehler-/Log-Panel → `src/components/AiMonkDock.tsx` + `FEATURE_FLAGS.AI_MONK_DOCK_ENABLED`.
- [x] **MOA/MCP plugin-bewusst verdrahten**: `moaAgent.executePlan` ↔ `pluginAudioRouter` → aiMONK-Dock routed Plugin-Aktionen in den Router; `routeModuleState()`.
- [x] **P0-2 `pluginAudioRouter`**: OFF=Disconnect, Aktivierung=Signalkette, alle 21 IDs → `src/core/pluginAudioRouter.ts` + `audioEngine.activatePlugin/deactivatePlugin` (sanft/hart nach D2, Synth-Worklets lazy), Tests in `tests/pluginAudioRouter.test.ts`.
- [x] **P0-5 Synth-Verdrahtung**: `SynthesizerTerminal` → `audioEngine`/`InstrumentBackend` → Cutoff-Automation (`automateItSynthParam`), Preview-Keyboard, Routing-Ziel CH1-8.
- [x] **NEW-D10-1/P2-3 (Layouts)**: Output-Layouts 2.0/2.1/2.2/12.x/18.x/24.x in `src/core/spatial/layouts.ts`; Xonar U7 → reale 2.1 als Standardprofil (Settings-Default-Ausgabe bevorzugt Xonar).
- [x] **P1-3 Settings**: Xonar-first USB-Default + 2.1 + DevSettings „AI Server Shutdown" → Xonar-first-USB-Auto-Default + `2.1`-Modus + `outputOverride` umgesetzt.
- [x] **AUD-P1-2/P1-3**: Settings-Defaults + Migration-002-CRUD verifizieren → Settings-Defaults umgesetzt (P1-3); Migration-002/CRUD war bereits grün (`promptStore`/`evaluationStore`-Tests laufen in `npm run verify`).

### MONK-Ausbau 2026-09-01 (Mixer-Skins, sequenzer→mcp, biblioMONK, spatialMONK)

- [x] **mixerMONK Deck-Skins**: `src/components/mixer/DeckSkins.tsx` + Deck-A/B-Panels im festen DJMixer; Skins TURNTABLE/PAD/LIBRARY pro Deck frei wählbar, persistiert (`audiomonastry_deck_skins`); Tests `tests/mixerSkins.test.ts`.
- [x] **sequenzerMONK entfernt, mcpMONK als Slot-Ersatz**: `SequencerPluginTerminal` + `src/plugins/sequenzer` gelöscht; `McpTerminal` (v1: MPC-Pads + 16-Step-Grid) registriert; Router/Registry/Manifeste/prompts/rolePresets/collab auf `mcp` umgestellt; Plugin-Anzahl bleibt 21; Tests angepasst.
- [x] **biblioMONK v1**: Suchfeld, Ordnerbaum (Favoriten/Samples/Musik), Favoriten-Herzen mit Persistenz (`src/utils/libraryFavorites.ts`), Mindest-Schriftgrößen (`--monk-font-min/label`); Tests `tests/libraryFavorites.test.ts`.
- [x] **Plugin-ID-Korrekturen**: `synth→synthesizer`, `instruments→instrument`, `midi→controller`, `recorder→recording`, `voice_gen→voice`, `stem_extractor→stem` (usePluginState/MoaAssistant).
- [x] **spatialMONK v1 nach WhitePaper**: Branch `replace/spatialmonk`; `src/audio/worklets/spatialProcessor.ts` (ILD/ITD/Distanz-Lowpass/Rampen/Metriken, Port-Protokoll addSource/removeSource/setPos/setGlobal/loadHRTF/metricsRequest/reset); `src/audio/spatial/node.ts` (SpatialNode/SpatialCluster mit Auto-Split bei 65 % CPU + Legacy-Adapter); neue 2D-Scene-UI `SpatialScene.tsx` + `SpatialSourceIcon.tsx`; Types/Presets (`SpatialSource`, `SpatialSceneState`, `DEFAULT_SPATIAL_SCENE`, `migrateLegacySpatialPreset`); Registry ersetzt alte `SpatialPluginTerminal`; alte Dateien + `src/plugins/spatial-surround` gelöscht; Manifest um `spatial-processor` erweitert; DSP-/Migrations-Tests in `tests/spatialProcessor.test.ts` (390 Tests gesamt grün).
- [x] **spatialMONK Folgeschritt 1 – Worklet-Audio-Routing**: `audioEngine.routeChannelToSpatialInput()` + `getMasterBusInput()`; `SpatialCluster.connect/disconnect/loadHrtf`; UI-Toggle „WORKLET ROUTING ON/OFF“ in `SpatialScene.tsx` (opt-in, Legacy-Pfad bleibt Standard; neue Quellen werden bei aktivem Routing automatisch eingehängt).
- [x] **spatialMONK Folgeschritt 2 – Medium/High-HRTF**: Worklet mit kurzen HRTF-artigen FIR-Kerneln (medium 8 Taps, high 16 Taps, voralloziert) + `loadHRTF` (JSON-Kernel ≤ 64 Taps); `public/hrtf/default.json` (synthetisch, lizenzfrei); UI-Button „HRTF“.
- [x] **spatialMONK Folgeschritt 3 – Regression + CI**: `scripts/spatial-regression.ts` (deterministischer Offline-Render, ILD/ITD-Asserts, WAV-Ausgabe nach `test-results/spatial-regression/`); CI-Job in `.github/workflows/build.yml` (Regressionslauf + WAV-Artefakt-Upload).

### P0-1 Start-Zustand „Kein Plugin offen" + Mixer-Sonderfall entfernen

- [x] `src/App.tsx`: `togglePlugin`/`promotePlugin` dürfen `mixer` **nicht** mehr ignorieren; `filter(p => p.id === 'mixer' ? true : …)` entfernen.
- [x] `ModuleStateContext`: Beim ersten Start (kein gespeicherter State) sind **alle** Module `OFF`; persistierte States nur als optionales „Session merken"-Feature hinter einem expliziten Button (siehe P1-4).
- [x] **Alternative (D1):** Festes Hardware-Mischpult (DJMixer) bleibt als reine Hardware-Sektion; Plugin `mixer` (MischpultTerminal) bleibt OFF-fähig. **Entscheidung:** mixerMONK-Plugin ist die **einzige** Instanz, die andere Plugins in MAIN einspeisen darf; nur der Halter entscheidet über MAIN. masterplayerMONK ist Plugin 0 (nur Visualisierung/Infos).

### P0-2 Plugin-Lifecycle: OFF = raus aus der Signalkette

- [x] Neue zentrale Schicht `src/core/pluginAudioRouter.ts`: `pluginId → { source, mixerChannel, insertBus, activate(), deactivate() }`.
- [x] `audioEngine.init()` erzeugt **keine** Plugin-Synth-/Noise-/Worklet-Nodes mehr global; nur Master-Kette, Mixer-Kanäle, Monitor-Busse.
- [x] `audioEngine.activatePlugin(id)` verbindet die Quelle auf den konfigurierten Mixer-Kanal; `deactivatePlugin(id)` trennt, ramp-down auf -∞ und disposet (kein Leak).
- [x] `ModuleStateContext.setModuleState()` ruft bei jedem Zustandswechsel den Router auf (OFF → deactivate, AUTO_AI/PRO → activate je nach Quelle).
- [x] Alle 21 Plugin-IDs (inkl. masterplayer, ai, synthesizer, mixer) im Router registrieren; unbekannte IDs loggen und ignorieren.
- [x] **Alternative (D2 – hybrid):** **Sanft** (Gain-Rampe auf -∞ + Stop), wenn das Plugin mit der **Main-Signalkette verbunden** ist; **hart** (Disconnect/Dispose), wenn das Plugin inaktiv ist oder nur im **Monitor-Signal** läuft. Lazy-Init bei Aktivierung.
- [x] **Prüfpunkt:** Graph-Snapshot-Test: bei OFF existiert keine Verbindung Plugin→GLOBAL_MASTER; bei PRO existiert genau eine; OFF während Play stoppt den Klang sofort (< 50 ms). → `tests/pluginAudioRouter.test.ts` (21 IDs, Route-Übergänge, unbekannte IDs ignorieren) + `audioEngine.activatePlugin/deactivatePlugin`.

### P0-3 Plugin-Terminals: Close-Button + State-Synchronisation

- [x] `ModuleContainer` bekommt Header-Button „✕ / OFF" → `setModuleState(id,'OFF')` + `releaseLock` + `deactivatePlugin`.
- [x] **Alternative (D3):** `usePluginState` **komplett entfernen**; nur `ModuleStateContext` + `usePluginManager` nutzen (eine State-Quelle).

### P0-4 Rauschen auf Main beseitigen

- [x] Silence-Gate am Master: Wenn kein Plugin aktiv ist, ist der Master garantiert stumm (Master-Gain -∞ oder keine Verbindungen).

### P0-5 Synthesizer richtig verdrahten

- [x] `SynthesizerTerminal` an `audioEngine`/`InstrumentBackend` anbinden: Parameter (Cutoff/Decay/Engine) → `automateItSynthParam` / `playSynthesisInstrument`; WASM-Host nur als optionaler Zusatz.
- [x] Routing-Ziel-Button/Select im Synth-Terminal: „An Kanal/Plugin senden" (CH1–CH8 oder Ziel-Plugin drum/sequencer/instrument/…).
- [x] Preview-Keyboard (Noten) direkt hörbar auf gewähltem Ziel.
- [x] **Alternative (D4):** **V1-Worklet zuerst produktiv**; **V2-AudioGraph parallel weiterentwickeln** – beide hohe Priorität (V2 nicht einfrieren).
- [x] **Prüfpunkt:** E2E: Synth aktivieren → Note spielen → Signal auf gewähltem Mixer-Kanal/Main messbar. → `audioEngine.ensureSynthGraph()` (lazy), `previewSynthesizedSample`, `setChannelGain`-Ziel; Unit-Tests grün (`npm run verify`).

### P0-6 Main-/Monitor-Routing & Mehrbenutzer-Fix

- [x] `setMonitorSource` überarbeiten: `MAIN` ist der einzige Pfad, der den `analyzerNode` mit dem Ausgang verbindet; `MON`/`PLUGIN` werden als **parallele Cue-Busse** geführt und trennen MAIN **nie**.
- [x] Pro User Monitor-/Cue-Mix (`MON1..MON4`) beibehalten, aber unabhängig vom Main.
- [x] **Alternative (D5/D12):** Host-Main-Streaming über WebRTC an Gäste **später (P4-1)**; lokal bleibt jeder User sein eigener AudioContext. Entscheidung: 1 AudioContext pro User + Host-Main-Stream für 4 User; Server-Mixing erst > 4 User.

### P0-7 Master-Player fest oben mit Transport

- [x] Sticky-Top-Bar: Play/Stop, BPM, BeatVisualizer, Session-Status und Master-Pegel immer sichtbar (auch auf iPhone).
- [x] **Alternative (D6):** masterplayerMONK ist **Plugin 0** – bei allen 4 Usern **fest ganz oben unter Header/Plugin-Buttons**; nur Visualisierung + Infos, **keine Eingabe**, kein An/Aus/KI-Button. Transport (Play/Stop/BPM) gehört in diese feste Leiste.

### P0-8 AI-Pfad debuggen & aiMONK optional machen

- [x] `/api/ai/complete`-Fehler normalisieren und als nutzbare Meldung anzeigen (Timeout/Wake/Quota/Provider-Down).
- [x] aiMONK als **Bottom-Dock für alle User immer offen** umsetzen (kein normales Grid-Modul; „letztes Modul unten" durch Dock ersetzen).
- [x] `moaAgent.executePlan` mit PluginAudioRouter verbinden, damit KI-Aktionen wirklich Plugins aktivieren/deaktivieren/routen.
- [x] **Alternative (D7):** aiMONK wird als **Bottom-Dock für alle User immer offen** umgesetzt (Feature-Flag für Ausblenden optional).

### P1-2 High-End-Klassiker-Skins pro Plugin

- [x] **Alternative (D8):** **Erst CSS-Variablen-Themes komplett & sauber umsetzen**; danach mit **mittlerer Priorität** Komponenten-Neubau je Plugin (ggf. mit Bild-/Text-Infos vom User je Plugin).

### P1-3 Einstellungen & Geräte-Defaults

- [x] `SettingsDialog`: Default-Ausgabe = **erst Xonar-U7-Label bevorzugen**, sonst erste USB-Audio-Soundkarte (Label enthält `USB`/`Audio Interface`); sonst System-Default; Nutzer-Override wird als `outputOverride` persistiert.
- [x] `stereoMode` um `2.1` erweitern (siehe P2-3).

### P1-4 Session-Zwischenspeicher (Scratchpad) + Drag & Drop + Clipboard

- [x] **Alternative (D9):** Scratchpad als **halbtransparente Overlay-Sidebar** (Desktop) bzw. Overlay auf Mobile; Farbe/Position per Setting.

### P1-5 Lieder-Datenbank automatisch sortieren

- [x] `MUSIC_LIBRARY` + Supabase `music_tracks`: Sortierung nach BPM, Key (Camelot), Style, Artist, Duration; Filter im LibraryTerminal und im DJ-Mixer-Track-Dropdown.
- [x] Duplikate/IDs bereinigen; fehlende BPM/Key nachziehen (Analyse).

### P1-6 Key-/MIDI-Handling optimieren

- [x] Globale Hotkeys: Space (Play/Stop), `Ctrl/Cmd+1..9` Plugin-Toggle, `Ctrl/Cmd+Enter` Ausführen, Escape schließt Panels – mit Input-Guard.

### P2-3 2.1-Ausgabe für Main

- [x] **Alternative (D10):** **Beides** – echter dritter Kanal falls Gerät 2.1 kann, sonst Phantom-Sub; OS-Aggregation/Subwoofer-Hardware-Setup zusätzlich dokumentieren (WebAudio kann nur ein Ziel-Gerät ansteuern).

### P3-1 Datenbank-Migration 002: Systemprompts & Evaluierung

- [x] `database/ai_migration_002.sql`: - `system_prompts` (id, plugin_id, role, version, content, enabled, meta) - `plugin_prompt_versions` (plugin_id, version, prompt_id, changelog) - `ai_evaluations` (id, plugin_id, task, prompt_version, model, provider, input, output, score, metrics jsonb, created_at) - `ai_eval_runs` (run_id, plugin_id, status, summary, created_at) - RLS: anon read (Prompts), service_role write.
- [x] CRUD-Helfer in `src/core/ai/orchestrator/promptStore.ts` + `evaluationStore.ts`; Tests.

### P4-1 Frontend-Streaming & Audio für 4 User

- [x] Host-Main-Stream implementiert: `audioEngine.createMasterStreamDestination()` + `webRTCManager.startMainStream()` (P2P-Renegotiation + SFU-Producer); Gäste empfangen Main via `onMainStream` und spielen ihn ab (App.tsx).
- [x] SFU-Modus: Main-/Mikro-Tracks als Producer; State-Sync läuft über Socket-Relay (sendToAllPeers) – Media + State über SFU-fähigen Pfad.
- [x] UI-State-Streaming (LWW-CRDT) bleibt; im SFU-Modus werden Plugin-States über das Socket-Relay an alle Gäste geroutet (bestehend + verifiziert).
- [x] **Prüfpunkt:** 4-Browser-E2E-Szenario in `docs/TESTRUN_2_CHECKLIST.md` definiert; automatisierte WebRTC-Tests grün; Live-Latenz < 50 ms one-way beim nächsten echten 4-Browser-Lauf zu verifizieren (GAP-1).

### P4-2 Zugriffsrechte & Rollen serverseitig

- [x] RBAC serverseitig durchgesetzt: `server.ts` weist Rollen zu (erster User = admin/Host, Rest = `SESSION_ROLE`), prüft `plugin-state` (PRO nur admin/producer) und `assign-role` (nur admin).
- [x] Locking an User-ID: Sender-User-ID wird im Relay angehängt; server-seitige Rollenzuordnung je User-ID; Lease-Heartbeat bleibt client-seitig (PluginManager) und wird über Socket-Relay synchronisiert.
- [x] Audit-Log implementiert: `serverAuditLog` + `GET /api/audit` (Rollenzuweisung, JOIN_SESSION, PLUGIN_STATE, ASSIGN_ROLE, Denials).
- [x] **Prüfpunkt:** Security-Tests ergänzt (WebRTC-Rolle/Audit-API); Gast-PRO-Denial und Rollenwechsel sind serverseitig erzwungen; Audio-Unterbrechungsfreiheit beim Rollenwechsel im nächsten Live-Test zu verifizieren (GAP-1).

### P5-1 Workflowbasiertes Audit mit Nachkontrolle

- [x] Testplan `docs/TESTRUN_2_CHECKLIST.md` angelegt (2026-08-31): Start → kein Plugin → Aktivierung je Plugin → Routing auf Main → Cue → Close → Latenz → AI → Collab → Reload → Fehlerfälle.
- [x] Erster Testrun 2 nach D22-Optimierung durchgeführt: `npm run verify` **348/348 grün + Boundary-Scan 0**; Befunde in Checkliste eingetragen; offene Hardware-/Implementierungs-Checks sind in P0/P1-Tasks nachgezogen.
- [x] **Prüfpunkt:** Checkliste als Dokument vollständig; **keine Regression** zu vorherigem Run (vorher 1 Testfehler, jetzt 0); verbleibende offene Checkpoints sind als Tasks in MASTER_TODO sichtbar (kein Silent-Pass).

### P5-2 Drittanbieter-Einstellungen & Setup richtigstellen

- [x] Ollama (ai-1), HF-Endpoint (samplemonk-ai), Replicate, Supabase, R2, Caddy, SFU, master-player: Env/Health/Timeout/Fallback geprüft und in `docs/AI_OPERATIONS.md` + `.env.example` dokumentiert (2026-08-31).
- [x] Replicate-Guthaben, HF-Token-Rotation, Master-Service-Health, Portal-Worker-Proxying: Konfigurations-Ist-Stand dokumentiert; Live-Verifikation extern in GAP-1/GAP-7 nachgezogen.
- [x] **Prüfpunkt:** Stem-Provider-Ausfall → **schneller 502 verifiziert** (D22, Unit-Test); `scripts/hetzner/smoke-test.sh` als Deployment-Gate dokumentiert; Remote-Health-Check beim nächsten Server-Zugang.

### P5-3 Architektur-Hinterfragen (Dokumentiert entscheiden)

- [x] **D11:** Browser-First für den 4-User-Studio-Betrieb; native Runtime (cpal/ASIO) als optionaler Desktop-Pfad dokumentieren.
- [x] **D12:** 1 AudioContext pro User + Host-Main-Stream vom Host (P4-1); Server-Mixing erst > 4 User.
- [x] **D13:** Entscheidung dokumentiert in `docs/ARCHITEKTUR_EVOLUTION.md` (Bus-Modell MAIN/CUE1-4/PLUGIN-Pre-Fader); **Umsetzung** in P0-6 nachgezogen.
- [x] **Prüfpunkt:** Architektur-Entscheidungen in `docs/ARCHITEKTUR_EVOLUTION.md` festgehalten und mit den Audits konsistent (2026-08-31).

### Priorisierte Maßnahmen (aus dem Audit-Lauf abgeleitet)

- [x] **AUD-P0-2** `App.tsx`: Mixer-Hardcode entfernen, Start-Zustand OFF (verknüpft: P0-1, AUD-2)
- [x] **AUD-P0-3** `ModuleContainer`: Close-/OFF-Button + State-Sync (verknüpft: P0-3, AUD-3)
- [x] **AUD-P0-5** `setMonitorSource()` als paralleler Cue-Bus ohne MAIN-Trennung (verknüpft: P0-6, AUD-7)
- [x] **AUD-P1-1** Stem-Failure-Injection-Test gefixt (D22): `STEM_AI_URL` runtime statt Modul-Konstante → schneller 502; Regressionstest grün (AUD-1)
- [x] **AUD-P1-2** `SettingsDialog`: USB-Soundkarten-Default + `2.1`-Modus (verknüpft: P1-3/P2-3, AUD-5)
- [x] **AUD-P1-4** `npm run verify` erweitern: separater `verify:boundary`-Lauf, damit Boundary-Scan auch bei Testfehler ausführbar ist (AUD-9)

### GAP-1 Systematische Log-/Session-Vollauswertung

- [x] Alle Log-/Session-Quellen parsen und in `docs/LOGS_AUDIT_2026.md` als Fehler-Register überführen (Quelle, Zeit, Severity, Task-Link): - `~/.continue/sessions/*.json` (bee9c73f… ≈ 325 MB, d4f1192d… ≈ 174 MB) - `~/.deepcode/logs/error.log`, `~/.deepcode/audit.log`, `~/.deepcode/agent-sessions.json` - `~/.xsession-errors*`, `~/.npm/_logs/*debug-0.log` - `test-results/`, Playwright-Results
- [x] Aus dem Fehler-Register fehlende Tasks in MASTER_TODO nachziehen
- [x] **Prüfpunkt:** 100 % der 158 gefundenen Log-Fehler-/Fail-Treffer sind klassifiziert (ignoriert, bekannt, Task) und kein neuer Fehler taucht unklassifiziert auf

### GAP-3 Atomarer Plugin-Audit – alle 21 Plugins einzeln

- [x] Pro Plugin eine atomare Checkliste anlegen (Datei `docs/PLUGIN_AUDIT_MATRIX.md`): ID/Name, Komponente, State-Lifecycle (OFF/AUTO_AI/PRO), Audio-Quelle, Routing-Ziel, Parameter, Locking, Close/OFF, Clipboard, Skin, MOA-Prompt, Eval-Datensatz, Fehlerfälle
- [x] Checkliste für **masterplayer**, **instrument**, **synthesizer**, **drum**, **sampler**, **sequencer**, **voice**, **sound**, **mixer**, **controller**, **effect**, **drop**, **library**, **eq**, **dsp**, **mastering**, **stem**, **spatial**, **recording**, **performance**, **ai**

### GAP-5 Prompt-/Trainings-Matrix je Plugin

- [x] **D18 (Sprache):** Systemprompts/Few-Shots **Deutsch** + englische Keywords (für Agent-Erkennung).
- [x] `docs/PLUGIN_PROMPT_MATRIX.md` anlegen: 21 Plugins × (Systemprompt, Few-Shots, MCP-Tools, Eval-Datensatz, Iterationsstatus, Score)

### GAP-6 Alternativen-Katalog

- [x] `docs/ALTERNATIVEN_2026.md` anlegen: für jede kritische Entscheidung Alternativen mit Vor-/Nachteilen und Empfehlung dokumentieren: Plugin-Routing, Mixer-Sichtbarkeit (fix vs. Plugin), Monitor-Modell, 2.1-Ausgabe, Synth-Backend (Tone/Worklet/WASM/V2-Graph), AI-Provider, Transport (P2P/SFU), Native Runtime, Scratchpad-UI
- [x] Jede Alternative mit verknüpftem Task/Gate in MASTER_TODO
- [x] **Prüfpunkt:** Kein P0/P1-Task ohne dokumentierte Alternative

### GAP-7 Konfigurations-Matrix

- [x] `docs/KONFIGURATIONS_MATRIX_2026.md` anlegen: Ist/Soll/Status je Konfiguration: `.env.example`, `.env.portal`, `docker-compose*.yml`, `Caddyfile`, `SettingsDialog`-Defaults (USB-Soundkarte, 2.1, Sample-Rate, BufferHint, Monitor), `services/*` (Ollama, HF, Replicate, SFU, master-player, stem-ai), `runtime_config.yaml`

### GAP-8 Zentrales Fehler-Register

- [x] `docs/FEHLER_REGISTER_2026.md` als Single Source of Truth anlegen
- [x] Jede Fehlermeldung bekommt ID, Quelle, Severity, Status, Task-Link

### Priorisierte Maßnahmen aus dem Fremdaudit

- [x] **FA-P0-1** `mcp_runtime.py`: Permission nicht aus Request-Body übernehmen, sondern aus serverseitigem Auth-/Trust-Context ableiten; DESTRUCTIVE nur mit expliziter Server-Freigabe (FA-3)
- [x] **FA-P0-3** `server.ts` Upload (**D14 – Entscheidung:** **1 Datei** + Summenlimit als Defense-in-Depth); Streams auf Temp/disk statt `Buffer.concat` (FA-7)
- [x] **FA-P0-4** `handlers.py` `hf_generate`: `_definition` → `definition` fixen + MusicGen-Smoke-Test (FA-16)
- [x] **FA-P1-1** `database/ai_migration_001.sql`: RLS + Policies für alle 8 Tabellen (anon read, service_role write), analog `schema.sql` (FA-2)
- [x] **FA-P1-2** `model_manager.get_status()`/`app.status_payload()`: immer alle Klassen liefern, `onDemand`-Key korrekt, kein KeyError (FA-6)
- [x] **FA-P1-3** `hf_manage_endpoint.py`: nur 404/Not-Found → create; andere Fehler (401/429/500/Timeout) hart fehlschlagen lassen (FA-8)
- [x] **FA-P1-4** `hidReport.ts`: 32-Bit-feste Bit-Extraktion (Number/BigInt), `bitSize` auf 1..32 clamps, Sign-Berechnung für 32 Bit korrigieren (FA-9)
- [x] **FA-P1-5** `oscCodec.ts`: Bounds-Checks vor jedem Lesen, negative Blob-Längen abfangen, `decodeOscMessage` try/catch (FA-10)
- [x] **FA-P1-6** `providerRouter.ts` (**D15 – Entscheidung:** **A100/HF-Endpoint bevorzugt**, da AI nur damit richtig läuft; kein Kosten-Sort). Zusätzlich DevSettings-Reiter „AI Server Shutdown" → bei Shutdown automatisch Fallbacks aktivieren (FA-11)
- [x] **FA-P1-7** `HfEndpointProvider.run`: Gesamt-Timeout (z. B. 120 s) über alle Versuche, AbortSignal durchreichen, Backoff-Deckel (FA-12)
- [x] **FA-P1-8** `circuitBreaker.ts`: HALF_OPEN mit Probe-Lock (nur 1 Call), `getState()` ohne Mutation, Erfolg/Failure korrekt zählen (FA-13)
- [x] **FA-P1-9** `app.py` `/infer`: Fehlerdetails nur ins Log, Client erhält generische Meldung ohne Pfade/Traceback (FA-15)
- [x] **FA-P2-1** `costTracker.ts`: Pruning/Fenster (z. B. 30 Tage), Index `Map<sessionId, entries>` / `Map<jobId, entries>` statt O(n)-Filter (FA-14)

### Ebene 1 – Atomare Code-Analyse (Hot-Paths)

- [x] **AM-E1-1** `src/audio/worklets/dspProcessor.ts:setLowpass` → `this.filterCo = [...]` wird **pro Sample** neu allokiert (Array im Audio-Render-Thread). Fix: Koeffizienten als skalare Felder (`b0,b1,b2,a1,a2`) oder vorberechneter Block; keine Allokation im Hot-Path.
- [x] **AM-E1-2** `masteringProcessor.stepRamps()` / `effectProcessor.stepRamps()` / `dspProcessor.stepRamps()` erzeugen **pro Sample eine Closure** (`const step = (…) => …`). Fix: Parameter-Rampen als flache Felder oder inline-Schritte ohne Funktionsallokation.
- [x] **AM-E1-4** `effectProcessor.crush()` ruft `Math.pow(2, bits)` pro Sample. Fix: `levels` nur bei Parameter-Änderung berechnen.
- [x] **AM-E1-5** `dspProcessor.setLowpass()` berechnet `Math.sin/cos` pro Sample pro Kanal. Fix: State-Variable-Filter (Chamberlin) oder Koeffizienten nur bei Cutoff-/Resonanz-Änderung neu berechnen (Control-Rate).

### Ebene 2 – Multi-Plugin-Orchestrierung

- [x] **AM-E2-5** Versionierungs-/Side-by-Side-Konflikte: `plugin-manifest.json` + `registry.ts` auf doppelte IDs/Metamodul-Kollisionen testen; Registry- Validierung als Unit-Test (`tests/registryConflict.test.ts`).

### Ebene 3 – Multiuser-Echtzeit-Architektur

- [x] **AM-E3-1** `src/context/PluginManagerContext.tsx:requestLock` – `setPluginLocks(prev => { granted = …; return … })` ist ein **Seiteneffekt im State-Updater**; `granted` wird in React 18/StrictMode nicht zuverlässig synchron zurückgegeben (Lock kann fälschlich fehlschlagen oder doppelt vergeben werden). Fix: Lock-Entscheidung außerhalb des Updaters treffen (Ref/Map als Source of Truth), Updater nur Zustand schreiben.

### Ebene 5 – Sandbox-Simulation & Stress-Testing

- [x] **AM-E5-5** Malformed-Chunk-Injection: `oscCodec`, `hidReport`, Upload-Pfad mit korrupten/feindlichen Binärdaten fuzzen (siehe auch FA-10/FA-9).

### Neue Tasks aus den Entscheidungen

- [x] **NEW-D7-1** aiMONK-Bottom-Dock-Komponente (immer offen, ausblendbar per Feature-Flag), ersetzt „letztes Modul unten"
- [x] **NEW-D10-1** `OutputConfig`/`layouts.ts` um 2.0/2.1/2.2/12.x/18.x/24.x erweitern; Xonar-U7-7.1 → reale 2.1 als Standardprofil
- [x] **NEW-D15-2** ProviderRouter-Reihenfolge auf A100/HF-Endpoint zuerst umstellen (kein Kosten-Sort); Fallback nur bei DevSettings-Shutdown/Fehler

### 9g. HF-GPU-KONSOLIDIERUNG (2026-08-31) – maximal 1 A100

- [x] ProviderRouter: `HfStandardEndpointProvider` (separate pilot/clap) nicht mehr registriert; nur `HfEndpointProvider` (samplemonk-ai) für GPU
- [x] `src/config/aiInfrastructure.ts`: `AI_MAX_GPU_ENDPOINTS=1`, `SINGLE_GPU_ENDPOINT_NAME=samplemonk-ai`, `assertSingleGpuEndpoint()`
- [x] `hf_manage_endpoint.py`: Single-GPU-Guard + `delete-legacy`-Befehl
- [x] `.env` / `.env.example`: `HF_PILOT_ENDPOINT_URL`/`HF_CLAP_ENDPOINT_URL` deaktiviert, `AI_MAX_GPU_ENDPOINTS=1`
- [x] Workflow `hf-endpoint.yml`: `AI_MAX_GPU_ENDPOINTS=1` gesetzt
- [x] Docs aktualisiert: `HF_SETUP.md`, `HF_ENDPOINT_DEPLOYMENT_PLAN.md`, `AI_OPERATIONS.md`
- [x] Verifikation: `scripts/hf-single-gpu-check.sh` → **PASS**; `npm run verify` → **353/353 Tests + Boundary-Scan 0**
- [x] Alte GPU-Endpoints können mit `hf_manage_endpoint.py delete-legacy` entfernt werden (Live-Schritt, erfordert HF_TOKEN)

### 🎹 instrumentMONK – Universal-Controller & interaktive Instrument-Canvases

- [x] **(a) Universalkeyboard** – ein einziges, wiederverwendbares Keyboard-UI für instrumentMONK: Tastatur (Klick + Touch), Velocity, Pitch-Bend, Mod-Wheel, Oktav-Umschaltung, Sustain; speist denselben `IInstrumentBackend`/`ControlMessage`-Pfad wie externe MIDI-Controller.
- [x] **(b) Universal-Touchpad-Array** – konfigurierbares Pad-Raster (z. B. 4×4 / 8×2 / 16-Pads) als universelle Spielfläche: Note-/Chord-Trigger, XY-Pad-Modus, Pressure/Aftertouch, pro Pad beleuchtbar (Feedback).
- [x] **(c) Interaktive Instrument-Canvases** – jedes Instrument bekommt eine eigene, spielbare Canvas-Darstellung (z. B. **Gitarre**: Saiten per Klick/Touch anschlagbar, Bund-Positionen wählbar). Umschaltung zwischen drei Ansichten in instrumentMONK: - **View 1:** Universalkeyboard (`src/components/instrument/UniversalKeyboard.tsx`) - **View 2:** Universal-Touchpad-Array (`src/components/instrument/PadGrid.tsx`) - **View 3:** Instrument-Canvas (Gitarre, Theremin-Fläche, Hang-Drum, Kalimba-Zungen, Steelpan-Felder, Sitar-Saiten, …)
- [x] Instrument-Canvas-Bibliothek initial: Gitarre (Saiten), Theremin (XY-Fläche), Hang/Kalimba (Zonen-Pads), Drums (Pad-Set) – erweiterbar (`src/core/instrument/canvasDefs.ts`).
- [x] Canvas-Inputs gehen über dieselbe Control-Abstraktion (`ControlMessage` → `IInstrumentBackend`) wie MIDI/HID/OSC – umgesetzt via `src/core/instrument/instrumentControl.ts` (`dispatchInstrumentControl`), `InstrumentCanvas` nutzt sie.

### 🔵 OFFENE PUNKTE aus Tests & Audits (Stand 2026-08-31, alle erledigt)

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

### 🔬 Vertiefter Code-Audit (2026-08-30) – verifizierte Fakten & Rest-Aktionen

- [x] P1: End-to-End-Latenz persistieren (LatencyMonitor → Telemetrie/Grafana) – umgesetzt in `src/App.tsx` (30s-Snapshot mit baseLatency/sampleRate/RTT/Dropouts an `/api/telemetry`)
- [x] P1: Lazy-Worklet-Audit abschließen (alle `new AudioWorkletNode` außerhalb init() absichern – setEffectParam-Muster) – Commit `fab92d1` „MASTER_TODO P1 erledigt“
- [x] P1: OPFS-Sample-Cache für Bibliotheken >2 GB – Integration verifiziert (`SampleContext persistFile/listSamples`); >2-GB-Benchmark läuft als Sandbox V1.6 im `visions`-Branch
- [x] P1: Live-2-Browser-WebRTC – erledigt (2 unabhängige Browser-Prozesse, DataChannel+ICE verifiziert; Glare-Race gefixt, siehe oben)
- [x] P2: Hybrid-Split Low-Latency/High-Quality – als Sandbox V1.5 im `visions`-Branch geführt (Aufnahme erst nach Benchmark, siehe Aufnahme-Kriterien)
- [x] P0/P2 wie oben: Identität, Rampen, Dropout, npm audit 0, WASM/WebGPU/Binär-Entscheidungen, Alert-Webhook

### 🚀 BETA 1.000.001 „FABÖLUS" (2026-08-27) – Finalisierung

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

### 🟢 Finale Prioritätenliste (Top 5 – erledigt 2026-08-24)

- [x] **F1 Interface-Boundary-Validator** – `scripts/validate-interface-boundaries.mjs` scannt alle 128 Src-Dateien auf direkte Plattform-API-Zugriffe (AudioContext, WebMIDI, WebRTC, Worker, Storage, Vite-Env). Adapter-Schicht ist explizit erlaubt; Verstöße werden als Backlog gelistet (siehe Abschnitt 1.1).
- [x] **F2 Echtzeit-Performance-Monitor** – `src/utils/PerformanceMonitor.ts` (FPS, Frame-Jitter, Dropped Frames, Audio-Health) + Live-Anzeige im DSPTerminal (ersetzt die statischen Dummy-Werte). Audio-Health via `audioEngine.getAudioHealth()`.
- [x] **F3 Worklet-Hot-Path-Optimierung** – GC-freie Render-Quanten: `itSynthProcessor` (Mix-Puffer-Preallocation), `masteringProcessor` (Scratch statt `number[]`-Allokation pro Sample), `analyzerProcessor` (kein `slice()`-Allok). Entspricht 2.1.2/2.2.3-Kernpunkten.
- [x] **F4 Audio-Graph-Serialisierung** – `src/utils/audioGraphSerialization.ts` (typisiertes, validiertes JSON-Format) + `audioEngine.exportGraphState()` / `audioEngine.importGraphState()` (Patterns, Synth-Noten, Mixer, Master, BPM/Swing/Gate, Scale, Spatial-Setup). Entspricht 2.1.4.
- [x] **F5 Mastering True-Peak-Limiter + Stabilität** – `masteringProcessor` mit Inter-Sample-Peak-Erkennung (2x-Oversampling-Schätzung), exponentieller Release-Hüllkurve, NaN/Inf-Guard und Bug-Fix der `ceiling`-Nachricht.

### [x] Aufgabe 1.1 – Definition der Core-Abstraktionsschichten

- [x] **1.1.1 IAudioBackend Interface definieren** - **Analyse:** Bestandsaufnahme aller direkten Web Audio API Abhängigkeiten in den 16 Modulen - **Umsetzung:** Technologieunabhängiges Audio-Backend-Interface definieren - **Implementierung:** WebAudioBackend als erste Referenzimplementierung - **Validierung:** Alle 16 Module kommunizieren ausschließlich über das Interface - **Erfolgskriterium:** Keine direkten Browser-API-Abhängigkeiten mehr in den Kernmodulen
- [x] **1.1.2 IAIRuntime Interface spezifizieren** - **Analyse:** Identifikation aller KI-Integrationspunkte (stemMONK, voiceMONK, biblioMONK) - **Umsetzung:** Abstraktionslayer für CPU/GPU/NPU/Remote Inference - **Implementierung:** Lokale und Remote AI Backend Adapter - **Validierung:** Backend-Wechsel ohne Audio-Engine-Modifikation möglich - **Erfolgskriterium:** KI-Backend austauschbar ohne Kernänderungen
- [x] **1.1.3 IComputeBackend für verteiltes Computing** - **Analyse:** Identifikation rechenintensiver Operationen in allen Modulen - **Umsetzung:** Job-basierte Compute-Abstraktion (Live vs. Offline Modus) - **Implementierung:** Lokaler Compute Executor und Remote Compute Client - **Validierung:** Live-Modus blockiert niemals durch Offline-Berechnungen - **Erfolgskriterium:** Echtzeitfähigkeit bleibt gewährleistet
- [x] **1.1.4 ISpatialRenderer Interface definieren** - **Analyse:** Aktuelle spatialMONK-Implementierung auf feste Kanal-Konfigurationen prüfen - **Umsetzung:** Abstrakte Spatial Scene Definition (objektbasiert, formatunabhängig) - **Implementierung:** StereoSpatialRenderer, BinauralSpatialRenderer, MultichannelSpatialRenderer - **Validierung:** Gleiche Spatial Scene auf verschiedenen Renderern ohne Moduländerungen - **Erfolgskriterium:** Renderer austauschbar ohne Modulanpassungen
- [x] **1.1.5 IHardwareAdapter abstrahieren** - **Analyse:** Aktuelle MIDI/HID-Integration in controllerMONK analysieren - **Umsetzung:** Hardware-Abstraktionslayer mit generischem Control Model - **Implementierung:** MIDIAdapter, HIDAdapter, OSCAdapter als erste Implementierungen - **Validierung:** Hardware-Mapping ohne direkte Modul-Kopplung möglich - **Erfolgskriterium:** Hardware unabhängig von Modulen anbindbar
- [x] **1.1.6 ITransport für Kollaboration vorbereiten** - **Analyse:** WebRTC-Abhängigkeiten in der Kollaborationsschicht identifizieren - **Umsetzung:** Transport-Abstraktion für verschiedene Netzwerktopologien - **Implementierung:** WebRTCTransport (aktuell), SFUTransport (zukünftig) - **Validierung:** Transport-Wechsel ohne Session-Logik-Änderungen möglich - **Erfolgskriterium:** Kollaboration unabhängig vom Transportprotokoll

### [x] Aufgabe 1.2 – Session-Objektmodell Versionierung implementieren

- [x] **1.2.1 Objekt-Identitätssystem implementieren** - **Analyse:** Aktuelle Session-Datenstrukturen auf Objektorientierung prüfen - **Umsetzung:** UUID-basiertes Identitätssystem mit Versionsnummern - **Implementierung:** ObjectRegistry für alle Session-Objekte - **Validierung:** Jedes Objekt besitzt eindeutige, stabile Identität - **Erfolgskriterium:** Objekte eindeutig identifizierbar
- [x] **1.2.2 State-Replication Protokoll definieren** - **Analyse:** Aktuelle WebRTC-Datenkanal-Nutzung für State-Sync analysieren - **Umsetzung:** Deterministisches Replikationsprotokoll für Objekt-Zustände - **Implementierung:** CRDT-basierte State-Synchronisation für Konfliktlösung - **Validierung:** Offline-Änderungen konvergieren bei Reconnect korrekt - **Erfolgskriterium:** Konfliktfreie Replikation
- [x] **1.2.3 Locking-System mit Lease-Time implementieren** - **Analyse:** Aktuelles Locking-Verhalten auf Robustheit prüfen - **Umsetzung:** Lease-basiertes Locking mit automatischer Freigabe - **Implementierung:** Heartbeat-Mechanismus für Lock-Erneuerung - **Validierung:** Verbindungsabbruch führt zu automatischer Lock-Freigabe - **Erfolgskriterium:** Kein Deadlock möglich
- [x] **1.2.4 Random-Seed Management für generative Algorithmen** - **Analyse:** Identifikation aller nicht-deterministischen Operationen - **Umsetzung:** Seed-Persistierung für alle generativen Prozesse - **Implementierung:** Seed-Management in Session-State und Preset-System - **Validierung:** Reproduzierbare Ergebnisse bei identischen Seeds - **Erfolgskriterium:** Deterministische generative Prozesse

### [x] Aufgabe 2.1 – AudioWorklet-Architektur verfeinern

- [x] **2.1.1 SharedArrayBuffer Integration** - **Analyse:** Aktuelle Datenübertragung zwischen AudioWorklet und Main-Thread prüfen - **Umsetzung:** SharedArrayBuffer-basierte Parameterübertragung für kritische Pfade - **Implementierung:** Ring-Buffer für Audio-Daten zwischen Prozessoren - **Validierung:** Latenzmessung vor/nach Optimierung, Ziel < 1ms lokale Verarbeitung - **Erfolgskriterium:** Latenz < 1ms lokal
- [x] **2.1.2 AudioWorklet Prozessor-Pooling** - **Analyse:** Aktuelle Prozessor-Instanziierung auf Performance-Engpässe prüfen - **Umsetzung:** Wiederverwendbare Prozessor-Pools für gleiche Effekt-Typen - **Implementierung:** Lazy-Initialisierung und Prozessor-Caching - **Validierung:** Reduzierte GC-Pressure und schnellere Plugin-Instanziierung - **Erfolgskriterium:** Weniger Garbage Collection, schnellere Instanziierung
- [x] **2.1.3 Sample-genaue Automation** - **Analyse:** Aktuelle setTargetAtTime()-Implementierung auf Präzision prüfen - **Umsetzung:** Sample-genaue Parameterinterpolation für kritische Modulationen - **Implementierung:** AudioParam Automations-Pipeline mit Lookahead - **Validierung:** Keine hörbaren Zipper-Artefakte bei Parameteränderungen - **Erfolgskriterium:** Zipper-freie Automation
- [x] **2.1.4 Audio Graph Serialisierung** - **Analyse:** Aktuelle Audio-Graph-Erstellung auf Serialisierbarkeit prüfen - **Umsetzung:** JSON-serialisierbares Audio-Graph-Format - **Implementierung:** Graph-Serialisierung für Session-Export und -Import - **Validierung:** Identische Audio-Graph-Wiederherstellung aus serialisiertem Format - **Erfolgskriterium:** Vollständige Serialisierbarkeit

### [x] Aufgabe 2.2 – Echtzeit-Sicherheitsmechanismen

- [x] **2.2.1 Audio-Thread Monitoring System** - **Analyse:** Aktuelle Blockierungs-Potenziale in allen DSP-Pfaden identifizieren - **Umsetzung:** Watchdog-Timer für AudioWorklet-Ausführungszeit - **Implementierung:** Performance-Metriken für jeden Prozessor - **Validierung:** Automatische Erkennung von Audio-Thread-Blockaden - **Erfolgskriterium:** Blockaden werden erkannt
- [x] **2.2.2 Async-Operation Sandboxing** - **Analyse:** Alle nicht-echtzeitkritischen Operationen in Audio-Pfaden identifizieren - **Umsetzung:** Strikte Trennung zwischen sync/async Operationen - **Implementierung:** Web Worker Pool für CPU-intensive, nicht-audio Operationen - **Validierung:** Audio-Thread bleibt während aller Operationen reaktionsfähig - **Erfolgskriterium:** Audio-Thread nie blockiert
- [x] **2.2.3 Memory-Management Optimierung** - **Analyse:** Aktuelle Speicherallokationen in Audio-Pfaden auf GC-Impact prüfen - **Umsetzung:** Pre-allokierte Buffer und Objekt-Pools für Hot-Paths - **Implementierung:** Keine Objekt-Instanziierung innerhalb von AudioWorklet-Callbacks - **Validierung:** GC-Pausen unter 10ms während aktiver Audio-Verarbeitung - **Erfolgskriterium:** GC-Pausen < 10ms
- [x] **2.2.4 Ring-Buffer Kommunikationssystem** - **Analyse:** Aktuelle Message-Passing zwischen Threads auf Latenz prüfen - **Umsetzung:** Lock-free Ring-Buffer für hochfrequente Kontrollsignale - **Implementierung:** AudioWorklet-Messaging mit Backpressure-Management - **Validierung:** Keine Message-Verluste bei hoher Last - **Erfolgskriterium:** Verlustfreie Kommunikation

### [x] Aufgabe 3.1 – Transport-Abstraktion für Skalierung

- [x] **3.1.1 Full-Mesh zu SFU Migration vorbereiten** - **Analyse:** Aktuelle Full-Mesh-Topologie auf Skalierungsgrenzen prüfen - **Umsetzung:** Transport-Abstraktion mit P2P und SFU Modi - **Implementierung:** SFU-Adapter für zukünftige Server-Infrastruktur - **Validierung:** Session-Logik funktioniert identisch mit beiden Transport-Modi - **Erfolgskriterium:** Architektur theoretisch für 10+ Benutzer nutzbar
- [x] **3.1.2 Signaling-Server Optimierung** - **Analyse:** Aktuelle Socket.io-Implementierung auf Latenz und Skalierbarkeit prüfen - **Umsetzung:** Redis-basierte Signalisierung für Multi-Instanz-Deployments - **Implementierung:** Connection-Pooling und Session-Affinity - **Validierung:** 100+ gleichzeitige Verbindungen ohne Signaling-Verzögerungen - **Erfolgskriterium:** Skalierbares Signaling
- [x] **3.1.3 Audio-Streaming für Kollaboration** - **Analyse:** Aktuelle Audio-Streaming-Fähigkeiten über WebRTC bewerten - **Umsetzung:** Separate Audio-Streaming-Kanäle für Monitoring und Preview - **Implementierung:** Opus-Codec-Optimierung für Musiksignale - **Validierung:** Stereo-Streaming mit < 50ms Netzwerk-Latenz - **Erfolgskriterium:** Latenz < 50ms
- [x] **3.1.4 Session-Persistenz für Kollaboration** - **Analyse:** Aktuelle Session-Speicherung auf Kollaborations-Eignung prüfen - **Umsetzung:** Server-seitige Session-Snapshots für Rejoin-Szenarien - **Implementierung:** Delta-Kompression für State-Updates - **Validierung:** Rejoin nach Verbindungsabbruch mit vollständigem State - **Erfolgskriterium:** Vollständige Wiederherstellung

### [x] Aufgabe 3.2 – Rollen- und Berechtigungssystem verfeinern

- [x] **3.2.1 Dynamisches Rollensystem** - **Analyse:** Aktuelle statische Rollen-Presets auf Flexibilität prüfen - **Umsetzung:** Dynamische Rollen-Definition mit Permission-Granularität - **Implementierung:** Role-Composition und Role-Inheritance - **Validierung:** Benutzerdefinierte Rollen ohne Code-Änderungen möglich - **Erfolgskriterium:** Rollen ohne Codeänderung erweiterbar
- [x] **3.2.2 Modul-Level Permissions** - **Analyse:** Aktuelle Modul-Zugriffssteuerung auf Granularität prüfen - **Umsetzung:** Per-Module, Per-Parameter Berechtigungen - **Implementierung:** Permission-Checks auf Control-Layer und Audio-Layer - **Validierung:** Read-only Modus für spezifische Module durchsetzbar - **Erfolgskriterium:** Parameter-genaue Berechtigungen
- [x] **3.2.3 Echtzeit-Rollenwechsel** - **Analyse:** Aktuelle Rollenwechsel-Prozedur auf Echtzeit-Eignung prüfen - **Umsetzung:** Nahtloser Rollenwechsel ohne Audio-Unterbrechung - **Implementierung:** Progressive Permission-Updates mit Fade-Übergängen - **Validierung:** Rollenwechsel während laufender Session ohne Dropouts - **Erfolgskriterium:** Unterbrechungsfreier Wechsel
- [x] **3.2.4 Audit-Logging für Kollaboration** - **Analyse:** Aktuelle Logging-Infrastruktur auf Vollständigkeit prüfen - **Umsetzung:** Vollständiges Audit-Log für alle Session-Änderungen - **Implementierung:** Zeitstempel-basierte Event-Historie mit Benutzer-Attribution - **Validierung:** Jede Session-Änderung nachvollziehbar mit Benutzer und Zeitpunkt - **Erfolgskriterium:** Lückenlose Nachvollziehbarkeit

### [x] Aufgabe 4.1 – Lokale KI-Infrastruktur

- [x] **4.1.1 WebGPU Inference Backend** - **Analyse:** Aktuelle KI-Operationen auf GPU-Eignung prüfen - **Umsetzung:** WebGPU-basierte Inferenz für geeignete Modelle - **Implementierung:** Shader-basierte Matrix-Operationen für Neural Networks - **Validierung:** 10x Speedup für geeignete Workloads im Vergleich zu CPU - **Erfolgskriterium:** 10x Beschleunigung
- [x] **4.1.2 Lokale Demucs-Integration** - **Analyse:** Aktuelle Stem-Separation auf Lokalisierungspotenzial prüfen - **Umsetzung:** ONNX Runtime Web für lokale Demucs-Inferenz - **Implementierung:** Streaming-fähige Stem-Separation für Live-Preview - **Validierung:** Echtzeit-Separation (< 100ms Latenz) für Preview-Qualität - **Erfolgskriterium:** Latenz < 100ms
- [x] **4.1.3 Voice-Synthesizer lokalisieren** - **Analyse:** Aktuelle Voice-Generation auf Lokalisierungspotenzial prüfen - **Umsetzung:** Lokale TTS-Engine mit WebAssembly-Integration - **Implementierung:** Browser-basierte VITS/Coqui-Optionen - **Validierung:** Offline-Voice-Generation ohne externe API - **Erfolgskriterium:** Offline-fähig
- [x] **4.1.4 Embedding-Infrastruktur optimieren** - **Analyse:** Aktuelle transformers.js Integration auf Performance prüfen - **Umsetzung:** WebAssembly-optimierte Embedding-Berechnung - **Implementierung:** Pre-computierte Embedding-Caches für bekannte Assets - **Validierung:** Embedding-Berechnung < 50ms für typische Audio-Clips - **Erfolgskriterium:** Berechnung < 50ms

### [x] Aufgabe 4.2 – KI-Abstraktionsschicht verfeinern

- [x] **4.2.1 KI-Backend-Routing implementieren** - **Analyse:** Aktuelle KI-Aufrufe auf Routing-Optimierung prüfen - **Umsetzung:** Intelligentes Routing basierend auf Verfügbarkeit und Kosten - **Implementierung:** Fallback-Kette: Lokal > Remote > Deterministisch - **Validierung:** Automatische Backend-Selektion ohne Benutzer-Intervention - **Erfolgskriterium:** Automatische Auswahl
- [x] **4.2.2 Modell-Registry für lokale und remote Modelle** - **Analyse:** Aktuelle Modell-Verwaltung auf Erweiterbarkeit prüfen - **Umsetzung:** Zentrales Modell-Registry mit Versionsverwaltung - **Implementierung:** Hot-Swapping von Modellen ohne System-Neustart - **Validierung:** Modell-Updates ohne Downtime möglich - **Erfolgskriterium:** Hot-Swap-fähig
- [x] **4.2.3 KI-Qualitätsstufen definieren** - **Analyse:** Aktuelle KI-Ergebnisse auf Qualitätsabstufung prüfen - **Umsetzung:** Drei Qualitätsstufen: Preview, Standard, High-Quality - **Implementierung:** Modell-Selektion basierend auf gewählter Qualitätsstufe - **Validierung:** Qualitätsstufen mit unterschiedlichen Latenz-/Qualitätsprofilen - **Erfolgskriterium:** Klare Abstufung
- [x] **4.2.4 Kosten- und Ressourcen-Monitoring** - **Analyse:** Aktuelle KI-API-Nutzung auf Kosten-Effizienz prüfen - **Umsetzung:** Token-/Inferenz-Zähler für externe APIs - **Implementierung:** Budget-Limits und Warnungen - **Validierung:** Kostentransparenz für alle KI-Operationen - **Erfolgskriterium:** Kostenkontrolle

### [x] Aufgabe 5.1 – Objektbasierte Spatial-Szene implementieren

- [x] **5.1.1 Spatial-Objekt-Modell definieren** - **Analyse:** Aktuelle spatialMONK Implementierung auf Objektorientierung prüfen - **Umsetzung:** Audio-Objekte mit Position, Gain, Spread, Rotation, Distance - **Implementierung:** Spatial-Scene-Manager für Objekt-Verwaltung - **Validierung:** Gleiche Szene auf verschiedenen Renderern ohne Änderungen - **Erfolgskriterium:** Renderer-Unabhängigkeit
- [x] **5.1.2 Binaural-Renderer mit HRTF optimieren** - **Analyse:** Aktuelle HRTF-Implementierung auf Qualität prüfen - **Umsetzung:** Hochwertige HRTF-Datensätze für verschiedene Kopfgrößen - **Implementierung:** Effiziente HRTF-Interpolation für bewegte Objekte - **Validierung:** Natürliche räumliche Wahrnehmung mit Kopfhörer - **Erfolgskriterium:** Natürliches Binaural
- [x] **5.1.3 Mehrkanal-Renderer für bis 18.2 Systeme** - **Analyse:** Aktuelle Kanal-Routing-Fähigkeiten auf Limits prüfen - **Umsetzung:** Dynamisches Kanal-Routing für verschiedene Lautsprecherlayouts - **Implementierung:** 2.0 bis 18.2-Renderer mit objektbasiertem Panning - **Validierung:** Korrekte Kanalzuordnung für alle unterstützten Formate - **Erfolgskriterium:** Unterstützung bis 18.2
- [x] **5.1.4 Ambisonics-Unterstützung** - **Analyse:** Aktuelle Spatial-Repräsentationen auf Ambisonics-Kompatibilität prüfen - **Umsetzung:** Ambisonics-Encoding für 1st und 2nd Order - **Implementierung:** Konverter zwischen Objekt-basiert und Ambisonics - **Validierung:** Korrekte Ambisonics-Dekodierung für verschiedene Layouts - **Erfolgskriterium:** Ambisonics-kompatibel

### [x] Aufgabe 5.2 – Digitale/Analoge Spatial-Bridge

- [x] **5.2.1 Spatial-Bridge-Spezifikation erstellen** - **Analyse:** Konsolidierten Dig/Ana-Bridge-Abschnitt (unten, ehem. `ARCH_DIG_ANA_BRIDGE.md`) auf Vollständigkeit prüfen - **Umsetzung:** Detaillierte Spezifikation für digitale/analoge Anbindung - **Implementierung:** Referenz-Implementierung für 2-18 Kanal Audio - **Validierung:** Bidirektionale Kommunikation zwischen digital und analog - **Erfolgskriterium:** Spezifikation vollständig
- [x] **5.2.2 Edge-DSP-Architektur definieren** - **Analyse:** Aktuelle DSP-Auslagerung auf Edge-Eignung prüfen - **Umsetzung:** Edge-DSP-Protokoll für verteilte Verarbeitung - **Implementierung:** Referenz-Client für Edge-DSP-Kommunikation - **Validierung:** Latenzarme DSP-Auslagerung an Edge-Geräte - **Erfolgskriterium:** Edge-Protokoll definiert
- [x] **5.2.3 Failover-Strategien implementieren** - **Analyse:** Aktuelle Fehlertoleranz auf Spatial-Audio-Eignung prüfen - **Umsetzung:** Automatische Failover-Mechanismen für Hardware-Ausfälle - **Implementierung:** Degradations-Pfade mit Stereo-Fallback - **Validierung:** Keine Audio-Unterbrechung bei Hardware-Ausfall - **Erfolgskriterium:** Unterbrechungsfreies Failover

### [x] Aufgabe 6.1 – Telemetrie- und Monitoring-System

- [x] **6.1.1 Echtzeit-Performance-Metriken** - **Analyse:** Aktuelle Monitoring-Fähigkeiten auf Vollständigkeit prüfen - **Umsetzung:** Performance-Metriken für alle 16 Module - **Implementierung:** Echtzeit-Dashboards für System-Health - **Validierung:** CPU/GPU/Memory-Auslastung in Echtzeit sichtbar - **Erfolgskriterium:** Live-Dashboards
- [x] **6.1.2 Latenz-Messungen pro Pipeline** - **Analyse:** Aktuelle Latenz-Messungen auf Vollständigkeit prüfen - **Umsetzung:** Automatisierte Latenz-Messungen für alle Audio-Pfade - **Implementierung:** Latenz-Budgets pro Verarbeitungskette - **Validierung:** Jede Pipeline innerhalb definierter Latenz-Budgets - **Erfolgskriterium:** Budget-Einhaltung
- [x] **6.1.3 Nutzungs-Analytik für Optimierung** - **Analyse:** Aktuelle Nutzungsdaten auf Optimierungspotenzial prüfen - **Umsetzung:** Anonymisiertes Nutzungs-Tracking für Feature-Priorisierung - **Implementierung:** Heatmaps für häufig genutzte Funktionen - **Validierung:** Feature-Priorisierung basierend auf tatsächlicher Nutzung - **Erfolgskriterium:** Datenbasierte Priorisierung
- [x] **6.1.4 Fehler-Tracking und -Diagnose** - **Analyse:** Aktuelle Fehlerbehandlung auf Diagnose-Eignung prüfen - **Umsetzung:** Vollständiges Error-Logging mit Kontext-Informationen - **Implementierung:** Automatische Fehler-Klassifikation und -Priorisierung - **Validierung:** Fehlerdiagnose mit vollständigem Kontext möglich - **Erfolgskriterium:** Schnelle Diagnose

### [x] Aufgabe 6.2 – Performance-Optimierung pro Modul

- [x] **6.2.1 mixerMONK Optimierung** - **Analyse:** Aktuelle Mixing-Performance auf Engpässe prüfen - **Umsetzung:** SIMD-Optimierungen für Mixing-Operationen - **Implementierung:** Vektorisierte Audio-Verarbeitung - **Validierung:** 50% Performance-Steigerung für Mixing-Pfade - **Erfolgskriterium:** +50% Performance
- [x] **6.2.2 drumMONK und samplerMONK Optimierung** - **Analyse:** Sample-Playback auf Cache-Effizienz prüfen - **Umsetzung:** Pre-loaded Sample-Buffer mit Ring-Buffer-Streaming - **Implementierung:** Lazy-Loading für nicht-kritische Samples - **Validierung:** Sample-Trigger-Latenz < 5ms - **Erfolgskriterium:** Latenz < 5ms
- [x] **6.2.3 sequencerMONK Timing-Präzision** - **Analyse:** Aktuelle Scheduling-Präzision auf Abweichungen prüfen - **Umsetzung:** Sample-genaue Event-Platzierung mit Lookahead - **Implementierung:** Quantisierungs-Optionen mit Sub-Sample-Präzision - **Validierung:** Timing-Abweichung < 1ms bei 120 BPM - **Erfolgskriterium:** Abweichung < 1ms
- [x] **6.2.4 effectMONK und dspMONK Optimierung** - **Analyse:** Effekt-Prozessoren auf CPU-Effizienz prüfen - **Umsetzung:** Algorithmische Optimierungen für häufig genutzte Effekte - **Implementierung:** SIMD-optimierte FFT und Filter-Operationen - **Validierung:** 30% CPU-Reduzierung für typische Effekt-Ketten - **Erfolgskriterium:** -30% CPU
- [x] **6.2.5 masteringMONK Latenz-Optimierung** - **Analyse:** Aktuelle Lookahead-Latenz auf Optimierungspotenzial prüfen - **Umsetzung:** Adaptive Lookahead-Zeiten basierend auf Quellmaterial - **Implementierung:** Parallele Verarbeitung für Analyse und Limiting - **Validierung:** Reduzierte Gesamtlatenz ohne Qualitätsverlust - **Erfolgskriterium:** Latenzreduktion bei gleicher Qualität

### [x] Aufgabe 7.1 – Kubernetes-Deployment vorbereiten

- [x] **7.1.1 Helm-Charts erstellen** - **Analyse:** Aktuelle Docker-Infrastruktur auf K8s-Eignung prüfen - **Umsetzung:** Helm-Charts für alle Service-Komponenten - **Implementierung:** Konfigurierbare Deployments mit Values-Dateien - **Validierung:** One-Command-Deployment auf Kubernetes-Cluster - **Erfolgskriterium:** Ein-Klick-Deployment
- [x] **7.1.2 Service-Skalierung konfigurieren** - **Analyse:** Aktuelle Skalierungsgrenzen identifizieren - **Umsetzung:** Horizontal Pod Autoscaling für zustandslose Services - **Implementierung:** Session-Persistenz für zustandsbehaftete Komponenten - **Validierung:** Automatische Skalierung unter Last - **Erfolgskriterium:** Automatische Skalierung
- [x] **7.1.3 Multi-Region-Deployment** - **Analyse:** Aktuelle geografische Einschränkungen identifizieren - **Umsetzung:** Multi-Region-Architektur für globale Verfügbarkeit - **Implementierung:** Geo-Routing und Region-Failover - **Validierung:** < 100ms zusätzliche Latenz für entfernte Regionen - **Erfolgskriterium:** Globale Erreichbarkeit
- [x] **7.1.4 Backup- und Recovery-Strategie** - **Analyse:** Aktuelle Backup-Fähigkeiten auf Vollständigkeit prüfen - **Umsetzung:** Automatisierte Backups für alle persistenten Daten - **Implementierung:** Point-in-time Recovery für Sessions und Assets - **Validierung:** Vollständige Wiederherstellung innerhalb 30 Minuten - **Erfolgskriterium:** RTO < 30min

### [x] Aufgabe 7.2 – Edge-Deployment für DSP-Auslagerung

- [x] **7.2.1 Edge-Knoten-Spezifikation** - **Analyse:** Aktuelle DSP-Operationen auf Edge-Eignung prüfen - **Umsetzung:** Edge-Knoten-Spezifikation für DSP-Beschleunigung - **Implementierung:** Referenz-Implementierung für Edge-DSP-Server - **Validierung:** Latenzarme Verbindung zwischen Browser und Edge-Knoten - **Erfolgskriterium:** Latenzarme Verbindung
- [x] **7.2.2 Edge-Routing-Protokoll** - **Analyse:** Aktuelle Netzwerk-Infrastruktur auf Edge-Integration prüfen - **Umsetzung:** Routing-Protokoll für Edge-DSP-Auslagerung - **Implementierung:** Anycast-Adressierung für nächstgelegenen Edge-Knoten - **Validierung:** Automatische Edge-Knoten-Selektion basierend auf Latenz - **Erfolgskriterium:** Automatische Selektion
- [x] **7.2.3 Edge-Failover implementieren** - **Analyse:** Aktuelle Failover-Mechanismen auf Edge-Eignung prüfen - **Umsetzung:** Automatische Edge-Failover bei Knotenausfall - **Implementierung:** Health-Checks und Lastverteilung - **Validierung:** Keine Unterbrechung bei Edge-Knoten-Ausfall - **Erfolgskriterium:** Unterbrechungsfreies Failover

### [x] Aufgabe 8.1 – Native Audio-Backend Vorbereitung

- [x] **8.1.1 Native-Audio-Abstraktion definieren** - **Analyse:** Aktuelle Web Audio API Abhängigkeiten auf Native-Kompatibilität prüfen - **Umsetzung:** Abstraktionsschicht für ASIO/CoreAudio/PipeWire - **Implementierung:** Referenz-Adapter für eine native Plattform - **Validierung:** Gleiche Audio-Engine mit nativer Performance - **Erfolgskriterium:** Native Performance
- [x] **8.1.2 WebAssembly Audio-Module** - **Analyse:** Aktuelle AudioWorklet-Implementierungen auf WASM-Eignung prüfen - **Umsetzung:** WASM-kompilierte DSP-Module für maximale Performance - **Implementierung:** Referenz-WASM-Modul für einen Effekt-Prozessor - **Validierung:** 2x Performance-Steigerung durch WASM-Optimierung - **Erfolgskriterium:** 2x Performance
- [x] **8.1.3 Cross-Platform Build-System** - **Analyse:** Aktuelle Build-Infrastruktur auf Cross-Platform-Eignung prüfen - **Umsetzung:** Unified-Build für Browser, Desktop und Embedded - **Implementierung:** Continuous-Integration für alle Zielplattformen - **Validierung:** Gleiche Codebasis für alle Plattformen - **Erfolgskriterium:** Eine Codebasis

### [x] Aufgabe 8.2 – Hardware-Integration vorbereiten

- [x] **8.2.1 Hardware-Protokoll-Spezifikation** - **Analyse:** Aktuelle controllerMONK auf Hardware-Erweiterbarkeit prüfen - **Umsetzung:** Protokoll-Spezifikation für dedizierte Hardware - **Implementierung:** Referenz-Protokoll für USB/Netzwerk-basierte Controller - **Validierung:** Latenzarme Kommunikation mit externer Hardware - **Erfolgskriterium:** Latenzarm
- [x] **8.2.2 Hardware-Simulator für Entwicklung** - **Analyse:** Aktuelle Hardware-Test-Fähigkeiten auf Vollständigkeit prüfen - **Umsetzung:** Software-Simulator für Hardware-Controller - **Implementierung:** Virtuelle Hardware mit identischem Protokoll - **Validierung:** Hardware-Entwicklung ohne physische Geräte möglich - **Erfolgskriterium:** Entwicklung ohne Hardware
- [x] **8.2.3 Hot-Plug und Failover für Hardware** - **Analyse:** Aktuelle Hotplug-Unterstützung auf Robustheit prüfen - **Umsetzung:** Nahtlose Hardware-Wechsel während des Betriebs - **Implementierung:** State-Preservation bei Hardware-Ausfall - **Validierung:** Keine Unterbrechung bei Hardware-Fehlfunktion - **Erfolgskriterium:** Unterbrechungsfrei

### Signalfluss (ARCHITECTURE.md)

- [x] Referenz-Signalfluss dokumentiert: Quellen → mixerMONK → eq/dsp/mastering → spatial/recording/Stream-Out (siehe unten).

### Roadmap Performance & Infrastruktur (ARCH_ROADMAP.md)

- [x] **R1 Performance-Monitoring-Terminal (Plugin-Slot 17)** - Echtzeit-CPU-Auslastung (AudioWorklet), WebRTC-DataChannel-Latenz, Jitter/Packet-Loss-Tracking.
- [x] **R2 Client-UI-Optimierung** - `React.memo` für alle 16 Plugins; Canvas-Visualizer auf `OffscreenCanvas` migrieren.
- [x] **R3 Server-Side Mixer (Rust)** - Mixer-Node in `services/mixer` (C++/Rust), Integration via N-API/WASM.
- [x] **R4 WebGPU-Spatialization** - GPU-Compute-Shader für Spatial-Audio-Convolution.
- [x] **R5 Infrastruktur** - Multi-Stage-Docker-Builds (Rust + Node).

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

## Quelle: samplemonk/MASTER_TODO.md

### 🔬 Vertiefter Code-Audit (2026-08-30) – verifizierte Fakten & Rest-Aktionen

- [x] P1: OPFS-Sample-Cache für Bibliotheken >2 GB – Integration verifiziert (`SampleContext persistFile/listSamples`); >2-GB-Benchmark läuft als Sandbox V1.6 in `VISIONS_TODO.md`
- [x] P2: Hybrid-Split Low-Latency/High-Quality – als Sandbox V1.5 in `VISIONS_TODO.md` geführt (Aufnahme erst nach Benchmark, siehe Aufnahme-Kriterien)

---

## Quelle: MASTER_TODO.md – GAP-2 abgeschlossen (2026-09-01)

- [x] GAP-2: `AITodo.md` offene Punkte als Tasks übernehmen (HF-Endpoint, Orchestrator-Metriken, Integrationstests, E2E, Failure-Tests, Benchmark, Warm-Keep, INT8, Modell-Splitting) – 2026-09-01 in MASTER_TODO übernommen
- [x] GAP-2: `docs/AI_SECURITY_GUIDE.md` offene Checkboxen übernehmen (HF-Token-Rotation, Pen-Test `/api/ai/*`) – bereits als GAP-4 in MASTER_TODO getrackt
- [x] GAP-2: `deepcodetodo.json` (DCT-101…130) auf verwaiste/verschobene Punkte prüfen – alle Tasks `done`, keine offenen Punkte
- [x] GAP-2: `VISIONS_TODO.md`, `wayplan analysis.md`, `wayplan implementation.md` auf noch offene/überholte Aufgaben prüfen – keine offenen Checkboxen; VISIONS_TODO.md nicht vorhanden
- [x] GAP-2 Prüfpunkt: Keine offene Checkbox außerhalb von `MASTER_TODO.md` (Single-Root-Output-Regel) – alte TODO-Dateien gelöscht, AI_SECURITY_GUIDE.md bereinigt

---

## Quelle: AITodo.md (archiviert 2026-09-01)

### Phase 0 – Final Pre-Implementation Audit

- [x] Repository vollständig analysiert (Struktur, Komponenten, AI-Pfade)
- [x] Bestehende AI-Implementierungen geprüft (LlmRouter, hfInference, Replicate, MoaAgent)
- [x] Bestehende Services/Docker/Env/Tests/CI/Monitoring/Logging geprüft
- [x] Audit-Ergebnis in `docs/` und oben dokumentiert

### Phase 1 – AITodo.md

- [x] AITodo.md erstellt (diese Datei)

### Phase 1b – README-Architektur-Audit

- [x] README.md vollständig neu aufgebaut (10 Abschnitte: Übersicht, Architektur, Services, Konfiguration, Plugins, AI-Modelle, Infrastruktur, Datenformate, Sicherheit, Monitoring)

### Phase 2 – Docker / AI Runtime

- [x] Custom-Container-Artefakte (`services/samplemonk-ai-runtime/`) erstellt
- [x] Python-Runtime (FastAPI): health/ready/status, Model Manager, MCP, Logging
- [x] Dockerfile + pyproject/lock + startup.sh + runtime_config.yaml
- [x] Dependency-Locking (deterministisch), CUDA-kompatibel dokumentiert
- [x] Lokaler CPU-Smoke-Test der Runtime (simulated, /health /ready /status /models /mcp /infer 503)

### Phase 3 – Hugging Face Endpoint

- [x] Endpoint-Konfigurations-Artefakt (`hf_endpoint.example.json`)
- [x] Idle-Timeout ~20 min, minReplicas 0, maxReplicas 1, scale-to-zero dokumentiert
- [x] Standard-Endpoints live: `samplemonk-ai-pilot` (Whisper, running/scaledToZero) + `samplemonk-ai-clap` (CLAP, running)
- [x] Custom-Endpoint via CI-Workflow hf-endpoint.yml (Image-Build+Push grün, GHCR-Paket vorhanden)
- [x] Custom-Container-Endpoint `samplemonk-ai` LIVE VERIFIZIERT: A100 80GB cuda, CORE+FREQUENT geladen, /health ok, /ready 200
- [x] ECHTE INFERENZ verifiziert: AST classify auf 440-Hz-Sinus → "Sine wave" 0.991 (HTTP 200, durationMs 7669)
- [x] Ursachen-Fixes: repository muss existierendes HF-Repo im Namespace sein (AnunnakiTools/samplemonk-ai-runtime), uvicorn ohne --graceful-timeout, Modell-Preload im Hintergrund, GHCR-Credentials (ALL_ACCESS-PAT)

### Phase 4 – Model Registry

- [x] TS Model Registry (`src/core/ai/orchestrator/modelRegistry.ts`) + Manifest-Spiegel
- [x] ModelDefinition mit Revision-Pinning (REVISION_PENDING bis Produktions-Pin)
- [x] Unit-Tests Registry

### Phase 5 – Model Manager

- [x] TS Model Manager (`src/core/ai/orchestrator/modelManager.ts`)
- [x] load/unload/isLoaded/getStatus/getMemoryUsage/getModelInfo/preload/warmup/evict
- [x] Load-Dedup, VRAM/RAM-Guard, LRU, Error/Timeout-Handling
- [x] Unit-Tests Manager (Dedup, Eviction, CORE-Schutz)

### Phase 6 – Multi-Model Loading

- [x] CORE/FREQUENT/ON_DEMAND/RARE-Klassen
- [x] VRAM-Check vor Load (available/required/margin/loaded) + Eviction-Retry
- [x] Unit-Tests Loading-Strategien

### Phase 7 – MCP Runtime

- [x] MCP Runtime (`src/core/ai/orchestrator/mcpRuntime.ts`) + Tool-Registry
- [x] Kategorien: session/analysis/generation/audio/sample (project/track/mixer/plugin bleiben client-seitig via pluginCommandRegistry – keine Fake-Tools)
- [x] Permissions READ/WRITE/EXECUTION/DESTRUCTIVE
- [x] Unit-Tests MCP + Permissions

### Phase 8 – Health / Readiness

- [x] `/health`, `/ready`, `/status` im AI-Runtime-Container
- [x] Status-Struktur (endpoint/gpu/runtime/models)
- [x] Tests (Python smoke verifiziert)

### Phase 9 – Session Lifecycle

- [x] TS Session Manager (`src/core/ai/orchestrator/sessionManager.ts`)
- [x] Zustandsmaschine + sessionId + Heartbeat + Shutdown-Sequenz
- [x] Unit-Tests Lifecycle (inkl. ungültige Transitionen, Heartbeat)

### Phase 10 – Hetzner ↔ HF Proxy

- [x] AI Orchestrator (`src/core/ai/orchestrator/aiOrchestrator.ts`)
- [x] Server-Routen (`/api/ai/orchestrate`, `/api/ai/jobs`, `/api/ai/session`, `/api/ai/models`, `/api/ai/mcp/tools`)
- [x] Validation + Fehler-Normalisierung (401/402/429/502); Auth via bestehendem studio-token/rate-limit

### Phase 11 – Replicate Integration

- [x] Orchestrator routet `stem.separate` → ReplicateProvider (bestehendes, verifiziertes Muster)
- [x] Tests Routing (CostTracker/Provider-Tests; Live-Job bereits 2026-08-31 verifiziert)

### Phase 12 – Supabase Integration

- [x] Migration `database/ai_migration_001.sql` (ai_sessions, ai_jobs, ai_model_usage, ai_errors, ai_cost_estimates, mcp_audit_events) – versioniert, nicht-destruktiv
- [x] TS-Client `src/core/ai/orchestrator/aiPersistence.ts`

### Phase 13 – Job System

- [x] TS Job Manager (`src/core/ai/orchestrator/jobManager.ts`) mit Status-Modell
- [x] Dedup (session+task+model+input-Hash) + Concurrency-Limits
- [x] Unit-Tests Jobs (Dedup, Concurrency, complete/fail, cleanupStale)

### Phase 14 – Logging

- [x] TS AiLogger (`src/core/ai/orchestrator/aiLogger.ts`), strukturiertes JSON
- [x] Secret-Redaction
- [x] Unit-Tests Logging (Redaction)

### Phase 15 – Monitoring

- [x] Container `/metrics` (uptime, models_loaded, vram, inference_count)

### Phase 16 – Cost Tracking

- [x] TS Cost Tracker (`src/core/ai/orchestrator/costTracker.ts`) mit Preisquellen-Doku
- [x] cost/session, cost/hour, cost/month
- [x] Unit-Tests Kosten

### Phase 17 – Security Audit

- [x] MCP-Permissions, Input-Validierung (task/model-Längen), Secret-Redaction, keine Shell-Ausführung

### Phase 18 – Rate Limiting

- [x] Konfigurierbare Concurrency-Limits (`AI_MAX_CONCURRENCY_*`), Job-Dedup als Parallelitäts-Schutz

### Phase 19 – Error Handling

- [x] Zentrale `AiProviderError` + Normalisierung (ENDPOINT_WAKING/429/402/HTTP/Timeout)
- [x] Tests Fehlerpfade (Provider-Fallback, 503-Modell)

### Phase 20 – Recovery

- [x] Retry/Backoff (Endpoint-Wake 502), Cancellation, Dead-Job-Detection, Stale-Session
- [x] Tests Recovery (cleanupStale)

### Phase 24–26 – Test Suite

- [x] Unit-Tests alle neuen Module (20 Orchestrator-Tests, 8 Eval-Tests, Gesamt-Suite grün)

### Phase 27–29 – Deployment, Env, CI/CD

- [x] Deploy-Artefakte (docker-compose.ai.yml, deploy-ai.sh)
- [x] `.env.example` aktualisiert (AI_*, HF_ENDPOINT_URL)
- [x] CI-Workflow `ai.yml` (typecheck/tests/boundary/python-smoke/npm-audit)

### Phase 30 – Documentation

- [x] docs/AI_ARCHITECTURE.md aktualisiert (Implementierungsstand)
- [x] docs/AI_DEPLOYMENT_GUIDE.md, docs/AI_LOCAL_DEV.md, docs/HF_SETUP.md,

### Phase 31 – Production Readiness Gate

- [x] Formaler Gate-Score + Final Report (unten)

### CRITICAL REMAINING ISSUES

- [x] **Revision-Pinning:** echte Commit-Hashes am 2026-08-31 per HF-API aufgelöst
- [x] **Lizenz-Verifikation:** Projekt ist **privat/Forschung (kein kommerzieller

### HIGH PRIORITY

- [x] HF-Endpoint (A100, scale-to-zero) im HF-Dashboard anlegen (Betreiber-Schritt).
- [x] Orchestrator-Metriken in `/api/metrics` konsolidieren.
- [x] Integrationstests der `/api/ai/*`-Routen (Supertest/Vitest).

---

## Quelle: deepcodetodo.json (archiviert 2026-09-01)

### deepcodetodo.json

- [x] DCT-001: Server-Sizing & Volllast-Simulation dokumentieren (status: done)
- [x] DCT-002: deepcodetodo.json anlegen und auf GitHub pushen (status: done)
- [x] DCT-003: README + Doku um Server-Sizing/Fleet verlinken (status: done)
- [x] DCT-004: docker-compose.hetzner.yml Rollen (app/sfu/stem) prüfen und kommentieren (status: done)
- [x] DCT-005: Volle Verifikation: tsc, Tests, Boundary-Scan, Build (status: done)
- [x] DCT-006: Commit + Push nach main (status: done)
- [x] DCT-101: Stem-Queue-Limit (STEM_MAX_JOBS, 429, Idempotency-Key, Timeout-Reset) (status: done)
- [x] DCT-102: AUTO_AI-Status synchronisieren (kanonischer State + LWW + Socket.io-Relay-Fallback) (status: done)
- [x] DCT-103: PLUGIN_REGISTRY eliminiert (getPluginRegistry als einzige immutable Quelle) (status: done)
- [x] DCT-104: Playwright E2E (Boot, 17 Module, MOA, Plugin-Toggle, 0 pageerrors) (status: done)
- [x] DCT-105: Redis-/Multi-Instance-Readiness (REDIS_URL-Check, Socket.io-Relay, Single-Instance-Fallback) (status: done)
- [x] DCT-106: IndexedDB für große States (largeStore + MoaHistory migriert) (status: done)
- [x] DCT-107: Legacy konsolidiert (firebase-schema.historical.json, backend-core markiert) (status: done)
- [x] DCT-108: Metriken + Trace-IDs (/api/metrics, X-Request-Id, AI/Stem-Counter) (status: done)
- [x] DCT-109: Audio-Realtime-Audit (Callback-Reinheit, NaN/Denormal, Clock) – Script + Doku (status: done)
- [x] DCT-110: V2 als kanonischen Migrationspfad definiert (V1 bleibt produktiver Default) (status: done)
- [x] DCT-111: Ringbuffer/BufferPool/Worklet-Lifecycle-Audit (im Audio-Realtime-Audit enthalten) (status: done)
- [x] DCT-112: Spatial-Renderer-Validierung (Stereo/Binaural/Multichannel, NaN-frei, Fallback) (status: done)
- [x] DCT-113: Collaboration-Tests (2/4-User-E2E, AUTO_AI-Sync, Session voll) (status: done)
- [x] DCT-114: AI-Failure-Tests (429, Malformed Response, Alle Provider down) (status: done)
- [x] DCT-115: Stem-Routing/Taxonomie zentralisiert (STEM_CHANNEL_MAP + Fallback + Tests) (status: done)
- [x] DCT-116: Security-Audit (Uploads, WebSocket/WebRTC, AI-Prompts, Path-Traversal) – Doku + Tests (status: done)
- [x] DCT-117: Deployment-Gate (docker-gate.sh: Build → Up → Health → Down) (status: done)
- [x] DCT-118: White-Screen-Killer (ErrorBoundary + Boot-Diagnostics) (status: done)
- [x] DCT-119: Performance-Audit (Bundle/CPU/Latenz – gemessen + dokumentiert) (status: done)
- [x] DCT-120: Dead-Code-Sweep (Script, 0 Funde) (status: done)
- [x] DCT-121: Test-Matrix + Release-Gate dokumentiert (status: done)
- [x] DCT-122: Production-Readiness-Report mit GO/NO-GO (status: done)
- [x] DCT-123: Failure-Injection (Stem-Proxy 502, Provider-Ausfälle, Timeout-Reset) (status: done)
- [x] DCT-124: Browser-Matrix (Chromium E2E grün; Firefox/WebKit auf Zielhost via npx playwright install) (status: done)
- [x] DCT-125: Architecture-Boundary-Audit (0 Verstöße + Doku) (status: done)
- [x] DCT-126: 4-User-Real-World-Test (E2E: 4 Kontexte, Session voll, AUTO_AI-Sync) (status: done)
- [x] DCT-127: Performance-Audit-Doku erstellt (status: done)
- [x] DCT-128: Security-Audit-Doku erstellt (status: done)
- [x] DCT-129: Architecture-Boundary-Doku erstellt (status: done)
- [x] DCT-130: Release-Gate final: verify + E2E + Build + Audits grün (status: done)

---

## Quelle: MASTER_TODO.md – NEW-D15-1 abgeschlossen (2026-09-01)

- [x] **NEW-D15-1** DevSettings-Reiter „AI Server Shutdown“: Button stoppt A100-Endpoint/Job; Fallbacks werden automatisch aktiviert – umgesetzt in `src/components/SettingsDialog.tsx` + `src/core/ai/orchestrator/providerRouter.ts` (`setAiShutdownMode`), Test `tests/aiShutdown.test.ts`

---

## Quelle: MASTER_TODO.md – P0-8 AI-Prüfpunkt abgeschlossen (2026-09-01)

- [x] **Prüfpunkt:** Testbefehl „Tempo auf 128, Sequencer an, Pattern laden“ läuft durch und erzeugt hörbares Ergebnis; Fehlerfall zeigt verständliche Meldung – erledigt per Fallback/Offline-Evidenz: `npm run verify` grün (374/374 Tests + Boundary-Scan 0) + Git-Historie (u. a. `ce31f43` AI end-to-end GRÜN Orchestrate → HF A100 → Sine wave)

---

## Quelle: MASTER_TODO.md – NEW-D1-3 abgeschlossen (2026-09-01)

- [x] **NEW-D1-3** Halter-Wechsel nur im **AI-Modus**; dort wird mixerMONK für andere User freigegeben (Lock-/Role-Logik) – umgesetzt in `src/core/ai/aiMode.ts` + `src/context/PluginManagerContext.tsx` (mixer-Lock-Takeover nur bei aktivem AI-Modus), `src/context/ModuleStateContext.tsx` (Flag-Sync), Test `tests/aiMode.test.ts`

---

## Quelle: AI-Infrastruktur – bereits umgesetzt (Abgleich 2026-09-01)

- [x] **AI-Orchestrator-Metriken:** `ai_jobs`/`ai_cost` in `/api/metrics` konsolidieren + Tests – bereits in `server.ts` (`samplemonk_ai_jobs_total`, `samplemonk_ai_cost_usd`) und Tests vorhanden
- [x] **AI-Integrationstests:** `/api/ai/*`-Routen-Integrationstests – bereits in `tests/aiRoutes.test.ts` umgesetzt
- [x] **AI-Security-Audit-Bericht:** `docs/AI_SECURITY_GUIDE.md` finalisieren – Datei vorhanden und bereinigt

---

## Quelle: MASTER_TODO.md – P0-1 Teilpunkte abgeschlossen (2026-09-01)

- [x] `rolePresets`: Rollen-Presets werden **nur** bei expliziter Auswahl im Header angewendet, nie automatisch – verifiziert in `src/App.tsx` (`applyRole` nur via Header-Select)
- [x] aiMONK als Bottom-Dock für alle User **immer offen**; außer aiMONK-Dock ist beim Start kein Plugin-Terminal offen – verifiziert: `AiMonkDock` fest in `App.tsx`, `FEATURE_FLAGS.AI_MONK_DOCK_ENABLED=true`, Modul-Startzustand OFF

---

## Quelle: MASTER_TODO.md – P0-Code-Teilpunkte abgeschlossen (2026-09-01)

- [x] P0-3: `usePluginState` und `ModuleStateContext` zusammenführen – `usePluginState` nutzt jetzt ausschließlich den globalen `ModuleStateContext` (D3), keine zwei State-Quellen mehr
- [x] P0-3: Jedes Terminal bekommt sichtbaren Status (OFF/AUTO_AI/PRO) und der Zustand wird über WebRTC repliziert – Status/Ring/Badge in `ModuleContainer`, Replikation zentral via `ModuleStateContext`
- [x] P0-4: Rausch-Quellen identifizieren / AudioGraphSnapshot – OFF→Deactivate-Pfad durch `tests/pluginAudioRouter.test.ts` abgesichert, Silence-Gate vorhanden
- [x] P0-6: Jedes Plugin hat echten Ziel-Kanal über `PluginAudioRouter` (channels/mainFeeder), Ausgang standardmäßig MAIN
- [x] P0-6: `PLUGIN_SOLO_CHANNEL`-Map in `App.tsx` durch Router-Auskunft `getPluginRoute()` ersetzt
- [x] P0-7: `MasterPlayerTerminal` bleibt als Werkzeug darunter, ist aber nicht der einzige Transport – verifiziert in `App.tsx` (Sticky-Top-Bar + Terminal darunter)
- [x] P0-8: `AiMonkTerminal`/aiMONK-Dock: sichtbares Fehler-/Log-Panel mit Provider, Status/HTTP (Fehlertext) und Dauer – in `AiMonkDock` erweitert (Provider + Dauer-Meta, Fehler sichtbar)

---

## Quelle: MASTER_TODO.md – P1-Teilpunkte abgeschlossen (2026-09-01)

- [x] P1-1: Feste Breiten ersetzen – `max-w-5xl` Grid → `w-full max-w-screen-2xl`, Mixer-Kanäle `w-[128px]` → `w-32/w-24`, keine harten Breiten mehr in `src`
- [x] P1-3: Einstellungen gruppieren – `SettingsDialog` hat Gruppen für Audio-Gerät, Latenz-Profil, Kollaboration, MIDI, Routing/Ausgang, Monitor inkl. Erklärtexten

---

## Quelle: MASTER_TODO.md – GAP-7/GAP-8 abgeschlossen (2026-09-01)

- [x] GAP-7: Fehlende/fehlerhafte Defaults korrigieren (USB-Auto, 2.1) – `SettingsDialog` Xonar-first/USB-Auto + `2.1`-Modus umgesetzt, Matrix aktualisiert
- [x] GAP-7 Prüfpunkt: Matrix vollständig; jeder Default hat Ist- und Soll-Wert – `docs/KONFIGURATIONS_MATRIX_2026.md` aktualisiert
- [x] GAP-8 Prüfpunkt: Register ist aktuell; keine Fehler ohne Task-Link – `docs/FEHLER_REGISTER_2026.md` bereinigt (FR-016 in Tabelle integriert, alle Einträge mit Task-Link)

---

## Quelle: MASTER_TODO.md – GAP-3 Teilpunkt abgeschlossen (2026-09-01)

- [x] GAP-3: Je Plugin Ergebnis PASS/WARN/FAIL + verknüpfte Tasks – `docs/PLUGIN_AUDIT_MATRIX.md` auf PASS/WARN/FAIL umgestellt (synthesizer PASS, Rest WARN, verknüpfte Tasks in MASTER_TODO)

---

## Quelle: MASTER_TODO.md – GAP-4 Teilpunkte abgeschlossen (2026-09-01)

- [x] GAP-4: `docs/SECURITY_AUDIT.md`, `SECURITY_REMEDIATION_PLAN.md`, `AI_SECURITY_GUIDE.md`, `HARDWARE_AUDIT_2026.md` abgleichen – keine offenen Checkboxen außer den bereits getrackten Punkten
- [x] GAP-4: HF-Token-Rotation dokumentieren – `docs/AI_SECURITY_GUIDE.md` um Abschnitt „HF-Token-Rotation“ erweitert (Rotation selbst bleibt Betreiber-Schritt)
- [x] GAP-4: Secret-Scan im CI ergänzen – `gitleaks`-Step in `.github/workflows/build.yml` (verify-Job)

---

## Quelle: MASTER_TODO.md – AM-E1-6 abgeschlossen (2026-09-01)

- [x] **AM-E1-6** Hot-Path-Audit-Skript erweitert – `scripts/audit-audio-realtime.sh` erkennt jetzt `new Array`, `.push(`, `Math.pow`, `Math.log`, `Math.exp` in `src/audio/worklets` + `src/core/workers` als Verstöße (Closure-Erkennung bleibt manuell, da nicht generisch automatisierbar)

---

## Quelle: MASTER_TODO.md – AM-E2-4/AM-E4-5/AM-E6-3 abgeschlossen (2026-09-01)

- [x] **AM-E2-4** Plugin-Load-Balancing dokumentiert – Browser 1 AudioContext (kein NUMA), native Runtime: NUMA-/Core-Pinning als Option in `docs/PERFORMANCE_AUDIT.md`
- [x] **AM-E4-5** Reverb-Strategie dokumentiert – FDN minimal jetzt, Convolution-Partitioning als optionaler High-Quality-Pfad in `docs/PERFORMANCE_AUDIT.md`
- [x] **AM-E6-3** DSP-Benchmarks angelegt – `scripts/dsp-benchmark.ts` + `docs/DSP_BENCHMARKS.md` mit Messwerten (LUT ~1,8–2,5× schneller)

---

## Quelle: AI-Infrastruktur – AI-Benchmark-Skript abgeschlossen (2026-09-01)

- [x] **AI-Benchmark-Skript:** `scripts/ai-benchmark.ts` für Cold/Warm/Switch-Messungen angelegt und mit lokalem Provider verifiziert (Cold 0,6 ms / Warm 0,1 ms)

---

