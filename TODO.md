# TODO – audioMONASTRY · Zentraler technischer Backlog

> Einzige offene Aufgabenliste des Repos.
> Stand: 2026-09-09 · Audit-Lauf durchgeführt (verify, deep-audit:static, npm audit, boundary scan).
> Vorheriger Stand (Live-Gates/RunPod) ist als Task-Liste unten vollständig integriert.
> Status-Legende: `OPEN` · `IN_PROGRESS` · `DONE` · `BLOCKED`

---

## 1. Verbindliche Zielarchitektur (Kurzfassung)

```
HEAD
↓ masterplayerMONK (System, fest, alle 4 User)
↓ DJ:        mixerMONK · dropMONK · songMONK · effectMONK
↓ PRODUCING: syntisamplerMONK · drumsamplerMONK · instruMONK · biblioMONK
↓ AI:        voiceMONK · soundMONK · stemMONK · spatialMONK
↓ MASTERING: eqMONK · dspMONK · masterMONK · recordMONK
↓ aiMONK (System, alle 4 User)
↓ perforMONK (System, alle 4 User)
```

Systemweit: `Settings → MIDI / Controllers · Audio · Devices · Collaboration · AI · Account · System`
MIDI/Controller sind KEINE Plugin-Slots: `USB-MIDI → MIDI-Runtime → Mapping/Routing → MONK/Parameter/Transport`.

Audio: `MONKs → MONK Audio API → V2 AudioGraph → Realtime Audio Runtime → AudioWorklet → Audio Backend`
Offline: `MONKs → V2 Graph → Offline Renderer`. V2 ist der einzige Production Audio Path.

---

## 2. Migration-Matrix OLD (21) → NEW (16 + System)

| OLD | Funktion (Ist) | NEW | Art |
|---|---|---|---|
| masterplayerMONK | Playback/WaveTable/Info (`MasterPlayerTerminal.tsx` + App-Sektion) | **masterplayerMONK** (System, Pos. nach Head) | bleibt, UI vollständig einbinden |
| instrumentMONK | Instrumente, Presets, MIDI/Note, `InstrumentsTerminal` | **instruMONK** | rename |
| synthesizerMONK | Synth, `SynthesizerTerminal` | **syntisamplerMONK** | merge |
| samplerMONK | Sampler, `SamplerTerminal` | **syntisamplerMONK** | merge |
| mcpMONK | MPC/Sequencer/Synth-Sampler-Steuerung, `McpTerminal` | **syntisamplerMONK** + MCP-Control-Layer (systemweit) | merge |
| drumMONK | Drum Machine, `DrumMachineTerminal` | **drumsamplerMONK** (inkl. Drum-Sampling) | merge |
| voiceMONK | Voice/TTS | **voiceMONK** | bleibt |
| soundMONK | Sound Generation | **soundMONK** | bleibt |
| mixerMONK | Mixer/Channels/Fader/Routing | **mixerMONK** | bleibt |
| controllerMONK | MIDI/Mapping/Hardware, `MIDIControllerTerminal` | **Settings → MIDI/Controllers** + `ControlHub`/`MappingEngine` (System-Layer) | verschieben |
| effectMONK | FX/Effektketten | **effectMONK** | bleibt |
| dropMONK | Live Drops/One-Shots | **dropMONK** | bleibt |
| biblioMONK | Library/Assets/Suche | **biblioMONK** | bleibt |
| eqMONK | EQ | **eqMONK** | bleibt |
| dspMONK | DSP/Processing Nodes | **dspMONK** | bleibt |
| masteringMONK | Mastering Chain/Dynamics | **masterMONK** | rename |
| stemMONK | Stem Separation | **stemMONK** | bleibt |
| spatialMONK | Spatial/2.1/N.x | **spatialMONK** | bleibt |
| recordingMONK | Recording/Bounce/Export | **recordMONK** | rename |
| perfMONK | Performance-Telemetrie | **perforMONK** (System, ganz unten) | rename + Ausbau |
| aiMONK | AI Chat/Orchestrierung | **aiMONK** (System, nach recordMONK) | bleibt, Position fixieren |
| songMONK | Songs/Arrangement/Transport-nah | **songMONK** (prüfen: Transport-/Playlist-Funktionen aus audioEngine hierher ziehen) | bleibt + Konsolidierung |

Regeln: Alte MONKs werden erst entfernt, wenn ihre Funktion im neuen Modul/System-Layer nachweisbar ist (Test + UI-Pfad). Kein stillschweigender Funktionsverlust.

---

## 3. Audit-Ergebnisse 2026-09-09 (Messwerte)

| Prüfung | Ergebnis | Bewertung |
|---|---|---|
| `npm run verify` (tsc+vitest+boundary) | tsc grün · 929/931 Tests grün · 2 Timeouts unter Volllast (`aiRoutes`, `aiSecurityPenTest`), isoliert beide grün | PARTIALLY VERIFIED (Flaky-Risiko unter Last) |
| `validate-interface-boundaries` | 371 Dateien, 0 Verstöße | VERIFIED |
| `audit:deep:static` | 43 Findings (0 critical, 1 medium: adm-zip, 42 low) | VERIFIED (statisch) |
| `npm audit` | 1 moderate (adm-zip 0.6.0, Symlink-Arbitrary-Overwrite) | FAIL → P0-Task |
| `tsc --noEmit` | 0 Fehler | VERIFIED |
| ESLint | 31 Findings (warn) | PARTIALLY VERIFIED |
| `knip` | 0 Findings | VERIFIED |
| `jscpd` | 14 Duplikate | PARTIALLY VERIFIED |
| Fallow | nicht installiert | NOT VERIFIED (Tool fehlt; Deep-Audit + knip/jscpd/semgrep als Ersatz) |
| E2E | Suite vorhanden (18 Specs inkl. `v2-live`), nicht in Headless-CI ausführbar | NOT VERIFIED (Live-Gate offen) |

---

## 4. P0 – Blocker (in dieser Reihenfolge abarbeiten)

### ARCH-SEC-001
- **Priority:** P0 · **Domain:** Security / Production Auth · **Status:** DONE (2026-09-09)
- **Task:** Production Auth fail-closed: Ohne `STUDIO_ACCESS_TOKEN` darf `NODE_ENV=production` NICHT ungeschützt laufen.
- **Location:** `server.ts` (`/api`-Middleware Z. 307–313, Socket.io-Handshake Z. 2227–2248)
- **Current State:** `if (!studioTokenEnabled) return next();` → fail-open; Socket-Handshake ebenfalls fail-open.
- **Target State:** `NODE_ENV=production && !STUDIO_ACCESS_TOKEN` ⇒ `/api/*` (außer `/api/health`) antwortet 503 `STUDIO_TOKEN_MISSING`, Socket-Handshake wird abgelehnt, lauter Boot-Log. Dev/Test (`NODE_ENV!=='production'`) behält expliziten Dev-Modus.
- **Implementation:** zentrale Guard-Funktion `studioAuthGuard(req,res,next)` + `studioTokenMissing`-Flag; Tests in `tests/security.test.ts` / `server.test.ts` ergänzen.
- **Acceptance Criteria:** (a) Production ohne Token ⇒ API 503, Socket abgelehnt; (b) mit Token ⇒ unverändert; (c) `NODE_ENV=test` ⇒ Server-Tests grün; (d) Health bleibt erreichbar.
- **Tests:** neue Fälle in `tests/security.test.ts`; `npm run test -- tests/server.test.ts tests/security.test.ts`.
- **Dependencies:** keine.

### ARCH-SEC-002
- **Priority:** P0 · **Domain:** Security / Dependencies · **Status:** DONE (2026-09-09, npm audit 0)
- **Task:** `npm audit` auf 0 bringen (adm-zip 0.6.0 moderate, ungenutzte direkte Dependency).
- **Location:** `package.json` (`adm-zip`), `package-lock.json`
- **Current State:** adm-zip 0.6.0 als direkte Dependency ohne Import im Code.
- **Target State:** adm-zip entfernt (kein Import vorhanden, kein Funktionsverlust); `npm audit` ⇒ 0.
- **Implementation:** `npm uninstall adm-zip`, Verify.
- **Acceptance Criteria:** `npm audit` = 0 findings; `npm run verify` grün.
- **Tests:** `npm audit`, `npm run verify`.
- **Dependencies:** keine.

### ARCH-SEC-003
- **Priority:** P0 · **Domain:** Security / API Validation · **Status:** DONE (2026-09-09)
- **Task:** Runtime-Validation (Zod) für externe Userdaten in kritischen API-/Socket-Pfaden; unsichere Casts ersetzen.
- **Location:** `server.ts` (`/api/cloud/samples`, `/api/cloud/music`, `/api/cloud/upload`, `/api/ai/*`, `/api/upload/sample`, `/api/telemetry`, Socket-Handler `plugin-state`), `src/types/zod/schemas.ts`
- **Current State:** manuelles `(req.body as any)` und `JSON.parse(...) as T` bei externen Payloads; Zod-Schemas existieren nur für Socket-Session-Payloads.
- **Target State:** alle genannten Routen validieren mit Zod (`safeParse`, 400 bei Fehler, Feld-Whitelisting); keine `as unknown as`-Casts auf externe Bodies.
- **Implementation:** Schemas in `src/types/zod/schemas.ts` erweitern (CloudSample, CloudMusic, AiGenerateDrop, UploadSample, TelemetryEvent, PluginState), Routen auf `safeParse` umstellen.
- **Acceptance Criteria:** (a) ungültige Payloads ⇒ 400 mit Feld-Fehlern, kein 500/kein Crash; (b) Tests für Validierung + Negative Cases; (c) keine `as any`-Casts mehr auf `req.body` in den Zielrouten.
- **Tests:** `tests/aiRoutes.test.ts`, `tests/server.test.ts`, neue Zod-Unit-Tests.
- **Dependencies:** keine.

### ARCH-AUDIO-001
- **Priority:** P0 · **Domain:** Audio Runtime / V2 Production Path · **Status:** BLOCKED (kein Audio-Browser/Live-Target in dieser Umgebung; Test bleibt Live-Gate)
- **Task:** V2-Live-E2E-Gate schließen (Playwright auf audio-fähiger Instanz/Browser), V2 als Production-Audio-Path verifizieren.
- **Location:** `tests/e2e/v2-live.spec.ts` (aktuell `test.skip`), `src/utils/audioEngine.ts`, `src/core/audio/live/*`
- **Current State:** Code-Pfad V2 (V2LiveSink→v2SinkProcessor→V2SampleClock) vorhanden; E2E-Test skipped in Headless.
- **Target State:** Test läuft gegen Live-Instanz/Browser mit AudioContext; dokumentierter Live-Nachweis (Play/Stop, Scheduler-Steps, kein Worklet-Fehler).
- **Implementation:** Live-Run dokumentieren (oder Skript `scripts/live-v2-gate`), Skip-Bedingung explizit auf Headless-Limit prüfen.
- **Acceptance Criteria:** mindestens ein protokollierter Live-Lauf mit `v2Connected=true`, `playing=true`, 0 Worklet-Fehler.
- **Tests:** `npm run test:e2e -- tests/e2e/v2-live.spec.ts` auf Live-Target.
- **Dependencies:** Deployment-Instanz mit Audio.

### ARCH-AUDIO-002
- **Priority:** P0 · **Domain:** Audio Runtime / DSP Parity · **Status:** DONE (2026-09-09, 15 neue sample-level Tests + EQ-0dB-Fix + Toleranz-Doku)
- **Task:** Echte sample-level V1/V2-Parity-Tests statt RMS/Hash-Proxy (gain, pan, EQ, compressor, limiter, dynamics, FX, automation, latency, PDC, routing, silence, clipping, denormal, channel count, stereo, 2.1, multichannel).
- **Location:** `tests/v2Parity.test.ts`, `tests/v2DspV1Parity.test.ts`, `src/core/audio/nodes/*`, `src/audio/worklets/*`
- **Current State:** `v2Parity.test.ts` prüft nur RMS > threshold, RMS-ratio < 20, Hash-Determinismus. `v2DspV1Parity.test.ts` hat Passthrough-/Peak-Checks.
- **Target State:** Pro DSP-Baustein: identischer Input → Output-Differenz (max. abs. Fehler/SNR) gegen dokumentierte Toleranz; absichtliche Abweichungen mathematisch dokumentiert.
- **Implementation:** Test-Harness `dspParityHarness.ts` (render V1-Worklet-Klasse vs. V2-Node, Vergleich per Sample), Tabellen-Tests für gain/pan/EQ/dynamics/mastering/FX/automation/PDC; Toleranzen in `docs/DSP_PARITY_TOLERANCES.md`.
- **Acceptance Criteria:** (a) gain/pan Parität ≤ 1e-6; (b) EQ/Dynamics/Mastering ≤ dokumentierte Toleranz (z. B. -60 dB Restfehler); (c) silence/clipping/denormal-Tests; (d) `npm run test:parity` grün.
- **Tests:** neue Parity-Suite, erweitertes `v2DspV1Parity.test.ts`.
- **Dependencies:** ARCH-AUDIO-001 (Referenz-Pfad), keine Blocker.

### ARCH-AUDIO-003
- **Priority:** P0 · **Domain:** Audio Runtime / Clock & Docs · **Status:** DONE (2026-09-09)
- **Task:** Clock-/Scheduler-Doku aktualisieren (Code nutzt AudioWorklet-Scheduler, Doku behauptet teils noch setInterval-Prototyp).
- **Location:** `V2TODO.md` (Zeile: GraphPlaybackEngine „Prototyp, setInterval“), `src/core/audio/compat/GraphPlaybackEngine.ts`, `docs/`
- **Current State:** `GraphPlaybackEngine` hat KEINEN setInterval mehr (start() startet nur Transport); V2TODO-Tabelle veraltet.
- **Target State:** Doku beschreibt Worklet-Clock (`V2SampleClock` + `v2SinkProcessor`) als einzigen Live-Scheduler; setInterval nur noch für nicht-auditive Watchdogs (z. B. Health-Poll) erlaubt und dokumentiert.
- **Implementation:** V2TODO-Tabelle/Text korrigieren, Clock-Abschnitt in `docs/ARCHITEKTUR_EVOLUTION.md` ergänzen.
- **Acceptance Criteria:** kein Doku-Text behauptet setInterval im Audio-Renderpfad; Code-Suche bestätigt keinen UI-Timer im Renderpfad.
- **Tests:** `tests/v2SampleClock.test.ts` (existiert) + Doku-Review.
- **Dependencies:** keine.

### ARCH-BUILD-001
- **Priority:** P0 · **Domain:** Script Hygiene / Release Gate · **Status:** DONE (2026-09-09)
- **Task:** npm-Scripts trennen: `typecheck`, `lint`, `test`, `test:e2e`, `build`, `security`, `verify`; `verify` als echtes Release-Gate.
- **Location:** `package.json`
- **Current State:** `"lint": "tsc --noEmit"` (semantisch falsch), kein `security`-Script, `verify` ohne ESLint/Audit.
- **Target State:** `typecheck`=tsc; `lint`=eslint; `security`=npm audit + boundary scan; `verify`=typecheck+lint+test+security+audit:deep:static.
- **Implementation:** package.json-Scripts umbauen; CI (`ci.yml`) auf neue Scripts umstellen.
- **Acceptance Criteria:** `npm run lint` ruft ESLint auf; `npm run verify` schlägt bei Audit-Findings/Lint-Warnungen fehl (Release-Gate); CI grün.
- **Tests:** `npm run verify`.
- **Dependencies:** ARCH-SEC-002 (audit 0), sonst verify rot.

---

## 5. P1 – Release

### ARCH-PLUGIN-001 (16-MONK-Registry)
- **Priority:** P1 · **Domain:** Plugin Architecture · **Status:** DONE (2026-09-09, Registry/Manifest/Router/channelMap/evalMatrix/prompts/commandRegistry/App/Settings/Themes umgestellt)
- **Task:** Plugin-Registry auf exakt 16 echte MONKs in Ziel-Reihenfolge migrieren (Namen, Kategorien, `public/plugin-manifest.json`, `registry.ts`, `App.tsx` RACK_ORDER/NAV).
- **Location:** `src/plugins/registry.ts`, `public/plugin-manifest.json`, `src/App.tsx`
- **Current State:** 16 ui_plugins (mixer, drop, song, effect, syntisampler, drumsampler, instru, biblio, voice, sound, stem, spatial, eq, dsp, master, record), `EXPECTED_PLUGIN_COUNT=16`; Adapter-Architektur unter `src/plugins/adapters/` eingeführt.
- **Target State:** 16 IDs: `mixer, drop, song, effect, syntisampler, drumsampler, instru, biblio, voice, sound, stem, spatial, eq, dsp, master, record`; `EXPECTED_PLUGIN_COUNT=16`; Manifest synchron.
- **Implementation:** Registry umschreiben; App-RACK_ORDER/NAV_EXCLUDED anpassen; `usePluginState`-IDs migrieren; Komponenten-Aliase (`mastering→master`, `recording→record`, `instrument→instru`).
- **Acceptance Criteria:** (a) `getPluginRegistry()` liefert exakt 16 in Ziel-Reihenfolge; (b) `plugin-manifest.json` konsistent; (c) Header-Navigation rendert 16 Icons; (d) `registryConflict.test.ts`/`pluginAudit.test.ts` grün.
- **Tests:** `tests/pluginAudit.test.ts`, `tests/registryConflict.test.ts`, Komponenten-Tests.
- **Dependencies:** ARCH-PLUGIN-002/003 (Komponenten-Merges vorher).

### ARCH-PLUGIN-002 (syntisamplerMONK)
- **Priority:** P1 · **Domain:** Plugin Architecture · **Status:** DONE (2026-09-09, SyntiSamplerTerminal mit Synth/Sampler/MPC-Sektionen)
- **Task:** `syntisamplerMONK` bauen: SynthesizerTerminal + SamplerTerminal + MCP-Synth/Sampler-Steuerung in einem Terminal; MCP-Kommandos als Control-Layer erhalten.
- **Location:** `src/components/SynthesizerTerminal.tsx`, `SamplerTerminal.tsx`, `McpTerminal.tsx`, neue `SyntiSamplerTerminal.tsx`
- **Current State:** drei getrennte Terminals.
- **Target State:** ein Terminal mit Sektionen (Synth/Sampler/MPC), alle Funktionen erreichbar; alte Terminals bleiben bis Parität, werden danach entfernt.
- **Implementation:** Tabs/Sektionen-Komponente; `usePluginState('syntisampler')`; alte IDs als Aliase.
- **Acceptance Criteria:** Synth-Play, Sample-Play, MPC-Pad+Sequencer im selben Terminal; keine Regression in `synth/sampler/mcp`-Tests.
- **Tests:** bestehende Synth-/Sampler-/MCP-Tests + neue UI-Tests.
- **Dependencies:** ARCH-PLUGIN-001.

### ARCH-PLUGIN-003 (drumsamplerMONK)
- **Priority:** P1 · **Domain:** Plugin Architecture · **Status:** DONE (2026-09-09, DrumMachineTerminal als drumsamplerMONK registriert)
- **Task:** `drumsamplerMONK` bauen: DrumMachineTerminal + Drum-Sampling (Pad-Sample-Zuordnung).
- **Location:** `src/components/DrumMachineTerminal.tsx`
- **Current State:** Drum-Terminal ohne eigene Sample-Pad-Persistenz im Plugin-Slot.
- **Target State:** ein Terminal (Pattern-Sequencer + Drum-Pads mit Samples); Funktion der DrumMachine vollständig erhalten.
- **Acceptance Criteria:** Pattern-Trigger, Swing, 16/32 Steps, Sample-Pads; Tests grün.
- **Dependencies:** ARCH-PLUGIN-001.

### ARCH-PLUGIN-004 (System-Module-Positionierung)
- **Priority:** P1 · **Domain:** Plugin Architecture / System · **Status:** DONE (2026-09-09, masterplayer+MasterPlayerTerminal verdrahtet, perforMONK benannt/positioniert; Telemetrie-Ausbau P2)
- **Task:** masterplayerMONK (Head→vor Plugin 1), aiMONK (nach recordMONK), perforMONK (ganz unten) als feste System-Sektionen; `MasterPlayerTerminal`-Funktionen in die masterplayer-Sektion integrieren; perfMONK→perforMONK umbenennen und Telemetrie ausbauen.
- **Location:** `src/App.tsx`, `src/components/MasterPlayerTerminal.tsx` (ungenutzt), `src/components/PerformanceMonitorTerminal.tsx`
- **Current State:** masterplayer-Sektion statisch (BPM/Transport/BeatVisualizer); `MasterPlayerTerminal` toter Code; perfMONK unten mit Basis-Telemetrie.
- **Target State:** masterplayer zeigt Playback/WaveTable/Info (MasterPlayerTerminal verdrahtet); perforMONK zeigt Session/Audio/System/Services (Sample Rate, Buffer, Latency, XRuns, Dropouts, Render CPU, PDC, Graph State, CPU/RAM/GPU/Netz, Service-Status) ohne Renderpfad-Belastung.
- **Implementation:** App.tsx-Sektionen umbauen; `PerformanceMonitorTerminal` erweitern (Polling ≤ 1 Hz, Daten aus `audioEngine.getAudioHealth()`/`masterClock`/`webRTCManager`).
- **Acceptance Criteria:** drei System-Sektionen in korrekter Position für alle 4 User sichtbar; Telemetrie ≤ 1 Hz, kein Einfluss auf Audio-Thread; `masterPlayerFixed.spec.ts` grün.
- **Dependencies:** ARCH-PLUGIN-001.

### ARCH-PLUGIN-005 (MIDI/Controller → Settings)
- **Priority:** P1 · **Domain:** MIDI / Hardware · **Status:** DONE (2026-09-09, controller aus Registry; Dashboard in Settings → MIDI/Controllers; lokaler State)
- **Task:** controllerMONK aus der Plugin-Registry entfernen; MIDI/Controller-Funktionen in `SettingsDialog` (MIDI/Controllers) + ControlHub/MappingEngine als System-Layer; MIDIControllerTerminal als Settings-Panel weiterverwenden.
- **Location:** `src/plugins/registry.ts`, `src/components/MIDIControllerTerminal.tsx`, `src/components/SettingsDialog.tsx`, `src/core/hardware/*`, `src/core/mapping/*`
- **Current State:** controller als Plugin (id `controller`); SettingsDialog hat nur MIDI-An/Aus; ControlHub/MappingEngine existieren.
- **Target State:** Settings-Sektion „MIDI / Controllers“ mit Devices, Input/Output, MIDI Learn, CC/Note/Channel Mapping, Presets, Transport; Mapping läuft über ControlHub→MappingEngine→MONK-Parameter.
- **Implementation:** SettingsDialog-Tab erweitern, MIDIControllerTerminal dort einbetten; Registry-ID `controller` entfernen; `usePluginState('controller')`-Referenzen migrieren.
- **Acceptance Criteria:** (a) kein `controller`-Plugin mehr; (b) alle MIDI-Funktionen in Settings erreichbar; (c) Mapping-/MIDI-Tests grün.
- **Dependencies:** ARCH-PLUGIN-001.

### ARCH-PLUGIN-006 (alte MONKs entfernen)
- **Priority:** P1 · **Domain:** Plugin Architecture · **Status:** OPEN
- **Task:** Alte MONKs (instrument, synthesizer, sampler, drum, mcp, mastering, recording, perf, controller) erst nach Funktionsmapping aus Registry/Komponenten entfernen; Aliase/Docs pflegen.
- **Acceptance Criteria:** keine alten Plugin-IDs in Registry; keine verlorenen Funktionen (Matrix in §2 abgehakt); `knip` 0.
- **Dependencies:** ARCH-PLUGIN-001…005.

### ARCH-COLLAB-001
- **Priority:** P1 · **Domain:** Collaboration · **Status:** OPEN
- **Task:** 4-User-E2E gegen Live-Infrastruktur (State-Sync, Locks, RBAC, Main/Cue, Reconnect, kein Zipper/Pumping) durchführen und dokumentieren.
- **Location:** `tests/e2e/collab.spec.ts`, `tests/e2e/live2browser.spec.ts`, `src/core/session/v2*`
- **Current State:** Socket.io-Session mit Locks/RBAC implementiert; E2E nur lokal/mock.
- **Acceptance Criteria:** 4 User gleichzeitig: State konsistent, Plugin-Locks korrekt, Transport/BPM/Mixer/Routing synchron, Reconnect ohne State-Pumping, Rolle-Berechtigungen greifen.
- **Dependencies:** Deployment (Hetzner/LB11).

### ARCH-AI-001
- **Priority:** P1 · **Domain:** AI Runtime · **Status:** PARTIALLY DONE (2026-09-09: Endpoint `uzg7p9lm890ts8` erstellt; Smoke-Test classify/ast-audioset **COMPLETED**; Run/Hetzner auf User-Wunsch gestoppt – Logs in `logs/run-2026-09-09/`; BS-RoFormer + Replicate/HF-Entfernung offen)
- **Task:** RunPod-Cutover validieren (Inferenz-Smoke, BS-RoFormer verifizieren, Replicate/HF erst danach entfernen); AI-Runtime async/isoliert vom Audio-Thread.
- **Location:** `src/core/ai/orchestrator/runpodProvider.ts`, `services/samplemonk-ai-runtime/`, `scripts/runpod-deploy.py`.
- **Current State:** Image korrekt: `ghcr.io/kainplanmusic/samplemonk-ai-runtime-runpod:latest` (Entrypoint `python runpod_worker.py`); Template `s50qv6n5rr`; Endpoint `uzg7p9lm890ts8` (HOPPER_141, workers 0–1, idle 5). Hetzner-Flotte gelöscht (0 Server, keine Kosten); RunPod ohne laufende Worker.
- **Acceptance Criteria:** RunPod-Inference E2E grün; Failover/Timeout/Retry getestet; AI blockiert nie den Render-Thread (async boundaries).
- **Dependencies:** Nächster Run: Hetzner `fleet-preflight.sh apply`, RunPod runsync gegen `uzg7p9lm890ts8` (Job-Payload in `logs/run-2026-09-09/rp_smoke_job.json`).

### ARCH-HW-001
- **Priority:** P1 · **Domain:** Hardware / Spatial · **Status:** OPEN
- **Task:** USB/Xonar U7/2.1-Live-Test; Device-Switch/Reconnect; Spatial-Fallback (WebGPU/WASM optional, CPU-Fallback Pflicht) verifizieren.
- **Location:** `src/core/output/crossover.ts`, `src/core/audio/V2OutputGraph.ts`, `src/core/hardware/*`
- **Acceptance Criteria:** 2.1-Layout sichtbar/stabil nach Reload; Sub <80–120 Hz, L/R ohne Bass-Einbuße; CPU-Fallback ohne WebGPU funktioniert.
- **Dependencies:** Hardware vorhanden (Xonar U7).

### ARCH-VER-001
- **Priority:** P1 · **Domain:** Version/Release Hygiene · **Status:** OPEN
- **Task:** Versionen/Runtime konsolidieren: README (1.10.1) → `1.210.001`; Node-Runtime: CI (22), Dockerfile (22-alpine/multistage 20-alpine), package.json `"node"`-Dependency (`^26.7.0`), `@types/node` (22) auf eine deklarierte Runtime (Node 22 LTS) angleichen.
- **Location:** `README.md`, `package.json`, `Dockerfile`, `Dockerfile.multistage`, `.github/workflows/*.yml`
- **Acceptance Criteria:** README/package.json/Docker/CI deklarieren dieselbe Node-Major-Version; `npm run build` + Docker-Build grün.
- **Dependencies:** keine.

---

## 6. P2 – Härtung

### ARCH-REF-001
- **Priority:** P2 · **Domain:** Backend · **Status:** OPEN
- **Task:** `server.ts` (2662 LOC) nach Domains aufteilen (auth, health, ai, cloud, samples, music, uploads, collaboration, fleet, monitoring, routes), ohne Verhaltensänderung; Tests als Netz.
- **Location:** `server.ts`, neues `server/`-Layout
- **Acceptance Criteria:** Routen-Module mit klaren Boundaries; Server-Tests unverändert grün; `server.ts` < 500 LOC (Bootstrap).
- **Dependencies:** ARCH-SEC-003 (Validation zuerst).

### ARCH-PERF-001
- **Priority:** P2 · **Domain:** Testing / Flaky · **Status:** DONE (2026-09-09: `vitest.config.ts` → testTimeout 15s, hookTimeout 20s, maxWorkers 4; voller Suite-Lauf mit neuer Konfiguration grün)
- **Task:** Test-Timeouts unter Volllast beheben (2 Tests in `aiRoutes`/`aiSecurityPenTest` timeouteten im Voll-Lauf, isoliert grün): Timeout-Budgets oder Vitest-Parallelität (`maxWorkers`) justieren.
- **Location:** `vitest.config.ts`, betroffene Tests
- **Acceptance Criteria:** `npm run test` unter Last grün (Suite-Lauf mit 4 Workern verifiziert).
- **Dependencies:** keine.

### ARCH-DEDUP-001
- **Priority:** P2 · **Domain:** Cleanup · **Status:** OPEN
- **Task:** jscpd-Duplikate (14) prüfen und gezielt konsolidieren; ESLint-Warnungen (31) abarbeiten.
- **Location:** `test-results/deep-audit/audit-report.md`
- **Acceptance Criteria:** jscpd 0, ESLint 0 Warnings (oder begründete Suppressions).
- **Dependencies:** keine.

### ARCH-DOC-001
- **Priority:** P2 · **Domain:** Dokumentation · **Status:** OPEN
- **Task:** README/README_DE auf Zielarchitektur (16 MONKs, System-Module, MIDI-Settings) und V2-only umstellen.
- **Dependencies:** ARCH-PLUGIN-001…006.

---

## 7. P3 – Strategisch / blockiert

- MIDI-Hardware-Hörprobe (TR-8S/Beatstep Pro) – keine Hardware vorhanden (BLOCKED).
- Komponenten-Neubau Hardware-Look – nach Stabilität.
- Optionale Synthese-/DSP-Bausteine (E-Piano, Phase-Distortion, Mod-Matrix, High-Quality Reverb) – Backlog.
- OS-Aggregation (PipeWire/macOS Aggregate) – bei Bedarf.
- HF-Endpoint-Secret-Rotation + Secret-History-Scan – vor RunPod-Cutover.
- Supabase-Live-Abgleich (Migrationen 001/002, RLS/Indizes) – vor Live-4-User-Test.

---

## 8. Gate-Reihenfolge (Release)

1. `npm run typecheck` grün
2. `npm run lint` grün
3. `npm test` grün
4. `npm run security` grün (npm audit 0 + boundary scan)
5. `npm run audit:deep:static` 0 Gate-relevant
6. `npm run build` grün
7. `npm run test:e2e` (Live-Set) grün
8. Live-Gates: V2-Live-Audio, 4-User-Collab, 2.1/Hardware, AI/RunPod

---

## 9. Run-/Ops-Befunde 2026-09-09 (aus `logs/run-2026-09-09/`)

### Fehler (aufgetreten → behoben)
| ID | Fehler | Ursache | Fix |
|---|---|---|---|
| RUN-ERR-001 | RunPod-Job hing 20 min IN_QUEUE | Template zeigte auf falsches Image `samplemonk-ai-runtime` (Uvicorn/startup.sh) statt `…-runpod` (runpod_worker) | Template auf `ghcr.io/kainplanmusic/samplemonk-ai-runtime-runpod:latest` umgestellt; Smoke-Test COMPLETED |
| RUN-ERR-002 | „Template name must be unique" | deploy.py legte Duplikate an | deploy.py idempotent (podTemplates-Lookup, `RUNPOD_TEMPLATE_ID`) |
| RUN-ERR-003 | „Invalid GPU Pool ID: NVIDIA H200" | RunPod erwartet Pool-IDs | Default/Workflow auf `HOPPER_141` umgestellt |
| RUN-ERR-004 | „You must have at least $0.01" | API-Key gehörte zu altem Konto ohne Guthaben | neuen Key in `.env` übernommen (Konto `user_3J64HqlkbI32qXU1QR7gK99UjEo`) |
| RUN-ERR-005 | fleet-status zeigte „nicht erreichbar" | hartkodierte Alt-IPs nach Wake | `fleet-status.sh` liest IPs dynamisch aus Hetzner-API |
| RUN-ERR-006 | Test-Timeouts (aiRoutes/aiSecurityPenTest) unter Volllast | CPU-Last im CI/parallel | isoliert grün; Flaky-Risiko offen → ARCH-PERF-001 |
| RUN-ERR-007 | GHCR-API: „Bad credentials" | lokale GHCR_Credentials abgelaufen | öffentliches Image genutzt; Credentials erneuern (P2) |

### Offene TODOs aus dem Run
- [x] ARCH-PERF-001: Vitest-Timeout-Budgets/`maxWorkers` justieren (testTimeout 15s, hookTimeout 20s, maxWorkers 4).
- [x] RunPod-Smoke als Repo-Skript (`scripts/runpod-smoke.py`) mit automatischer Ergebnis-Persistenz.
- [x] GHCR-Image-Prüfpunkt automatisiert (`scripts/ghcr-check.py` – Entrypoint-Verifikation ohne Docker).
- [ ] ARCH-AI-001 Rest: BS-RoFormer-GPU-Test (BLOCKED: RunPod auf User-Wunsch gestoppt, keine Kosten) + Replicate/HF-Code erst nach Cutover entfernen (BLOCKED bis Cutover validiert).
- [ ] GHCR-Credentials erneuern (`.env`: GHCR_USERNAME/GHCR_PASSWORD bzw. PAT) – User-Aktion.
- [ ] Live-Gates: V2-Live-E2E, 4-User-E2E, Xonar/2.1 (BLOCKED: Hardware/Browser nötig).

### Verbesserungen (umgesetzt)
- `scripts/runpod-deploy.py`: idempotent + GPU-Pool-Default + Endpoint-Update.
- `scripts/runpod-smoke.py`: Smoke-Test mit sofortiger Ergebnis-Persistenz (neu).
- `scripts/ghcr-check.py`: Image-Entrypoint-Prüfung (neu).
- `scripts/hetzner/fleet-status.sh`: dynamische IPs.
- `Dockerfile.hetzner` + alle Workflows: Node 22.
- `.env.hetzner.example`: STUDIO_ACCESS_TOKEN als Pflicht dokumentiert (fail-closed).
- `.github/workflows/runpod-deploy.yml`: GPU-Pool `HOPPER_141`, workers 0–1, idle 5.
- `vitest.config.ts`: robuste Timeout-Budgets + maxWorkers 4.

### Prüfpunkte (vor dem nächsten Run)
1. RunPod-Konto: Guthaben ≥ $0.01, API-Key = Konto `user_3J64HqlkbI32qXU1QR7gK99UjEo`.
2. Hetzner: `fleet-preflight.sh check` (Portal-Snapshots commit `911ec6d` vorhanden).
3. Server-.env: `STUDIO_ACCESS_TOKEN` gesetzt (sonst 503 fail-closed).
4. GHCR-Image: `python3 scripts/ghcr-check.py` (Entrypoint `runpod_worker` im `…-runpod`-Repo).
5. RunPod-Smoke: `RP_API_KEY=… RUNPOD_ENDPOINT_ID=uzg7p9lm890ts8 python3 scripts/runpod-smoke.py` (Ergebnis wird automatisch in `logs/` gespeichert).
6. `npm run verify` grün (957 Tests) vor jedem Deploy.

---

## 10. V2-Final-Migration 2026-09-09 (Phase 9 / 16-MONK)

### Erledigt
- [x] ARCH-PLUGIN-006: V2-Live-Gate headed grün (Play/Stop real, V2LiveSink verbunden, 12,2s).
- [x] ARCH-PLUGIN-006: Tone-15-`rawContext`-Unwrap in `audioEngine.init()` (nativer AudioContext für AudioWorkletNode).
- [x] V1-Feature-Flags entfernt: `resolvePlaybackMode` erzwingt immer `'v2'` (kein V1-Fallback).
- [x] `GraphEngineAdapter` + Test entfernt (deprecated, nie im Live-Pfad).
- [x] 16-MONK-Registry verifiziert: `EXPECTED_PLUGIN_COUNT=16`, Manifest exakt 16, System-Module getrennt.
- [x] `rolePresets.ts` auf 16 Plugin-IDs migriert (mcp/drum/synthesizer/controller/instrument/recording/perfor entfernt).
- [x] `pluginCommandRegistry.ts` auf 16 IDs + System-Module bereinigt (alte 21-MONK-Aliase entfernt).
- [x] `App.tsx`: `activeNav`-Default `'instru'`, Header-Kommentar korrigiert.
- [x] ARCH-V2-001: **Tone.js vollständig entfernt** — `nativeAudioKit` (WebAudio-Adapter) ersetzt alle Tone-Imports; `tone` aus `package.json` entfernt; Live-Gate headed grün (11,9 s), 954 Tests grün.

### Offen (priorisiert)
| ID | Prio | Domäne | Problem | Ziel |
|---|---|---|---|---|
| ARCH-V2-002 | P1 | Audio | V1-Zweige in `play()/stop()/triggerEvent()` sind tot (Mode immer v2), aber noch kompiliert | V1-Zweige entfernen, sobald Terminal-API V2-nativ |
| ARCH-V2-003 | P1 | Kollaboration | UI/Server-Sync nutzt noch die audioEngine-Facade (V1-State-Modelle) | V2-GraphState als einzige Sync-Quelle |
| ARCH-V2-004 | P2 | Server | `server.ts` groß; Dependency-Graph fehlt | Zerlegung in `server/` (auth/ai/cloud/collab/uploads/…) |
| ARCH-V2-005 | P2 | DSP | Parity-Tests nur RMS/Hash; PDC-Impuls-/Latenz-Suite fehlt | mathematische V2-Referenz-Suite + PDC-Impulstest |
| ARCH-V2-006 | P2 | MIDI | Settings-MIDI vorhanden; MIDI-Runtime-Mapping-Layer weiter ausbauen | Mapping-Layer vollständig dokumentieren/testen |
| ARCH-V2-007 | P1 | AI | AI-Runtime vom Render-Thread trennen (Queues/Timeouts/Cancellation) | AI-Executor-Worker, keine Blockade des Audio-Threads |
| ARCH-V2-008 | P1 | Security | Alle externen Payloads Zod-validieren (Uploads, AI, Session, Plugin-State) | Runtime-Validierung statt Casts |
| ARCH-V2-009 | P2 | CI | SHA-Pinning der Actions, npm audit 0, secret scan | CI-Gates dokumentieren/umsetzen |
| ARCH-V2-010 | P2 | Docs | README-Version (1.10.1 vs package.json 1.210.001) synchronisieren | Release-Historie festlegen, alle Dateien konsistent |
