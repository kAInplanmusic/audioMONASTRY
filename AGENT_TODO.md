# AGENT_TODO – Background-Coder Pipeline

Erzeugt: 2026-09-05T07:19:31.583Z

LEICHT: 12 · MITTEL: 9 · SCHWER: 2 · BLOCKED: 200

Festes Modell-Routing: Orchestrator=DeepSeek V4 Flash Visionary (max thinking) · #2 Kimi K2.7-Code · #3 GLM-5.3 · #4 Qwen3-Coder-Next · #5 GLM-5.3-Flash · #6 DeepSeek V4 Pro
## LEICHT (1-12)


TASK-001
CLASS: LEICHT
PRIORITY: P3
DOMAIN: BACKEND
DESCRIPTION: **A-5 Allokationen im `process()`-Pfad bei Kanal-/Quantum-Wechsel (Niedrig)** – im Konstruktor auf Maximalkanäle/-quantum vorallozieren.
IMPLEMENTATION_AGENT: #5
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
REVIEW_REQUIRED: NO
STATUS: READY


TASK-002
CLASS: LEICHT
PRIORITY: P3
DOMAIN: BACKEND
DESCRIPTION: **F-6 Non-null-Assertions ohne Guard (Niedrig)** – explizite Guards mit sprechender Meldung.
IMPLEMENTATION_AGENT: #5
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
REVIEW_REQUIRED: NO
STATUS: READY


TASK-003
CLASS: LEICHT
PRIORITY: P3
DOMAIN: BACKEND
DESCRIPTION: **F-7 Handler-Zuweisung statt Subscription (Niedrig)** – `onMainStream`/`onSessionUpdate` auf `addDataChannelListener`-Muster mit Unsubscribe.
IMPLEMENTATION_AGENT: #5
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
REVIEW_REQUIRED: NO
STATUS: READY


TASK-004
CLASS: LEICHT
PRIORITY: P3
DOMAIN: SECURITY
DESCRIPTION: **F-8 Accessibility (Niedrig)** – Slider-Rollen, `aria-pressed`, `aria-disabled`/`aria-label` für Lock-Zustand.
IMPLEMENTATION_AGENT: #5
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
REVIEW_REQUIRED: NO
STATUS: READY


TASK-005
CLASS: LEICHT
PRIORITY: P3
DOMAIN: CI/CD
DESCRIPTION: **Q-1 `check:memo` und `npm audit` fehlen als CI-Gates.**
IMPLEMENTATION_AGENT: #5
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
REVIEW_REQUIRED: NO
STATUS: READY


TASK-006
CLASS: LEICHT
PRIORITY: P3
DOMAIN: PERFORMANCE
DESCRIPTION: **Q-2 Bundle 1.56 MB > 1.50 MB Warnschwelle** – `tone`/`lucide-react` splitten/tree-shaken.
IMPLEMENTATION_AGENT: #5
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
REVIEW_REQUIRED: NO
STATUS: READY


TASK-007
CLASS: LEICHT
PRIORITY: P3
DOMAIN: SECURITY
DESCRIPTION: **Q-3 Coverage 32,6 %; untertestete Risiko-Dateien:** `audioEngine.ts` 26,7 %, `WebRTCManager.ts` 26,0 %, `rbac.ts` 0 %, `AuditLogger.ts` 0 %, `dropAudioBridge.ts` 0 %, `audioAnalyzer.ts` 0 %, `presetStore.ts`/`opfs.ts` 0 %.
IMPLEMENTATION_AGENT: #5
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
REVIEW_REQUIRED: NO
STATUS: READY


TASK-008
CLASS: LEICHT
PRIORITY: P3
DOMAIN: SECURITY
DESCRIPTION: **Q-4 `rbac.ts` (sicherheitsrelevant) mit Tests abdecken.**
IMPLEMENTATION_AGENT: #5
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
REVIEW_REQUIRED: NO
STATUS: READY


TASK-009
CLASS: LEICHT
PRIORITY: P3
DOMAIN: AUDIO
DESCRIPTION: **AD-N2 ESLint-Low-Hänger** – `scripts/**` teilgefixt (2026-09-05). Offen: `server.ts`, `ai/localDemucs.ts`, `audio-runtime/src/main.rs`.
IMPLEMENTATION_AGENT: #5
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
REVIEW_REQUIRED: NO
STATUS: READY


TASK-010
CLASS: LEICHT
PRIORITY: P3
DOMAIN: BACKEND
DESCRIPTION: **AD-N3 160× `any`/`as any` + 3× ts-ignore reduzieren** (deckungsgleich mit F-5/AUDIT.md).
IMPLEMENTATION_AGENT: #5
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
REVIEW_REQUIRED: NO
STATUS: READY


TASK-011
CLASS: LEICHT
PRIORITY: P3
DOMAIN: RUNBOOKS
DESCRIPTION: **P1-1 Statische V1-Verkabelung verifizieren:** Importe/Initialisierung, alle `connect()`-Aufrufe, Fehlerbehandlung – als Test-/Audit-Schritt dokumentieren.
IMPLEMENTATION_AGENT: #5
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
REVIEW_REQUIRED: NO
STATUS: READY


TASK-012
CLASS: LEICHT
PRIORITY: P3
DOMAIN: AUDIO
DESCRIPTION: **P1-3 Laufzeit-Prüfungen:** `audioContext.state`, `sampleRate`, `baseLatency`, `outputLatency` sichtbar machen (perfMONK nutzt `getAudioHealth()` bereits).
IMPLEMENTATION_AGENT: #5
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
REVIEW_REQUIRED: NO
STATUS: READY


## MITTEL (13-24)


TASK-013
CLASS: MITTEL
PRIORITY: P2
DOMAIN: AUDIO
DESCRIPTION: **A-2 `audioEngine.ts` 2814-Zeilen-Monolith (Mittel)** – in Graph-Aufbau/Worklet-Factory/Routing/Monitoring schneiden; Kernpfad-Coverage (26,7 %) erhöhen.
IMPLEMENTATION_AGENT: #2
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
REVIEW_REQUIRED: NO
STATUS: READY


TASK-014
CLASS: MITTEL
PRIORITY: P2
DOMAIN: AUDIO
DESCRIPTION: **A-3 Fehlgeschlagene Worklets nicht entsorgt (Mittel)** – `makeWorklet`-Fallbacks disconnecten und im Teardown führen.
IMPLEMENTATION_AGENT: #2
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
REVIEW_REQUIRED: NO
STATUS: READY


TASK-015
CLASS: MITTEL
PRIORITY: P2
DOMAIN: SECURITY
DESCRIPTION: **F-2 Vier parallele Lock-Modelle (Mittel)** – auf ein serverseitig autoritatives Modell konsolidieren.
IMPLEMENTATION_AGENT: #2
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
REVIEW_REQUIRED: NO
STATUS: READY


TASK-016
CLASS: MITTEL
PRIORITY: P2
DOMAIN: DATABASE
DESCRIPTION: **F-5 160× `any` (Mittel)** – Zod-Schemas für alle Peer-Payloads; Feature-Detection eng typisieren.
IMPLEMENTATION_AGENT: #2
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
REVIEW_REQUIRED: NO
STATUS: READY


TASK-017
CLASS: MITTEL
PRIORITY: P2
DOMAIN: BACKEND
DESCRIPTION: **AD-M3 Backend-Bugs:** `cloudAutomation.ts:100` Regex-Logik; `cloudAutomation.ts:132` Env-Zugriffe; `celery_app.py:104/120` Race Conditions `_load_demucs`/`_load_musicgen`; `hypersonic_moa.py:67` leerer Prompt; `app.py:124` + `handlers.py:105` Race Conditions Model-Loading; `handlers.py:130` Resampling-Fehlerbehandlung; `hf_manage_endpoint.py:122/130` Fehlerbehandlung/Trennung Konfiguration-Logik; `model_manager.py:130/190` Race/Load + VRAM-Fehlerfall; `registry.py:26` Revision-Pinning via `null`; `startup.sh:9/10` Symlink-Pfad + HF_HOME-Space-Check.
IMPLEMENTATION_AGENT: #2
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
REVIEW_REQUIRED: NO
STATUS: READY


TASK-018
CLASS: MITTEL
PRIORITY: P2
DOMAIN: SECURITY
DESCRIPTION: **AD-M5 React/State:** `usePluginState.ts:28` stale lockStatus; `useSessionSync.ts:35` `syncAdd` sendet unvalidierte Samples an Peers.
IMPLEMENTATION_AGENT: #2
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
REVIEW_REQUIRED: NO
STATUS: READY


TASK-019
CLASS: MITTEL
PRIORITY: P2
DOMAIN: DATABASE
DESCRIPTION: **P2-1 Core-Engine-Audit nach dem 4-Schritte-Schema** (Bestandsaufnahme → Abgleich → Bewertung umgesetzt/teilweise/nicht → Maßnahmen) einmalig für die Audio-Engine durchführen; Ergebnis als Abschnitt in MASTER_TODO/TASKDONE.
IMPLEMENTATION_AGENT: #2
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
REVIEW_REQUIRED: NO
STATUS: READY


TASK-020
CLASS: MITTEL
PRIORITY: P2
DOMAIN: BACKEND
DESCRIPTION: **P2-2 Methodik als wiederholbares Skript/Checkliste** in `scripts/` (z. B. `core-engine-abgleich.md`) ablegen, damit künftige Audits identisch ablaufen.
IMPLEMENTATION_AGENT: #2
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
REVIEW_REQUIRED: NO
STATUS: READY


TASK-021
CLASS: MITTEL
PRIORITY: P2
DOMAIN: SECURITY
DESCRIPTION: **P3-3 Clock & Synchronisation messen:** Jitter < ±1 Sample bei 48 kHz verifizieren; parallele Verteilung vs. Kaskade dokumentieren; Hot-Plug-Verhalten testen (deckt P2-1/P2-2 Rest).
IMPLEMENTATION_AGENT: #2
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
REVIEW_REQUIRED: NO
STATUS: READY


## SCHWER (25-36)


TASK-025
CLASS: SCHWER
PRIORITY: P0/P1
DOMAIN: SECURITY
DESCRIPTION: **AD-M4 AI-Runtime-Security/Architektur:** `backend-core/package.json:8` Uvicorn 0.0.0.0 ohne Auth; `startup.sh:18/21` AI-Runtime ungeschützt auf allen Interfaces; `pyproject.toml:7/11` fehlende Hash-Pins/Lockfile + veraltetes `torch==2.4.1`.
IMPLEMENTATION_AGENT: #2
REVIEW_AGENT: #6
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
REVIEW_REQUIRED: YES
STATUS: READY


TASK-026
CLASS: SCHWER
PRIORITY: P0/P1
DOMAIN: SECURITY
DESCRIPTION: **Prüfpunkt (Betreiber-Schritt):** HF-Endpoint-Secret rotieren (dokumentiert in `docs/AI_SECURITY_GUIDE.md`).
IMPLEMENTATION_AGENT: #2
REVIEW_AGENT: #6
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
REVIEW_REQUIRED: YES
STATUS: READY


## BACKLOG / BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: SECURITY
DESCRIPTION: **OPS-Load-Balancer Prüfpunkt (Live):** 2 App-Knoten hinter LB11, 4-User-E2E grün (State-Sync, Locking, Main-Stream stabil), Failover-Test. Architektur/Kosten dokumentiert in `docs/SERVER_FLEET.md`.
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: MITTEL
DOMAIN: PERFORMANCE
DESCRIPTION: **P2-1/P2-2 Rest (Live + Code):** Resampling-/Filter-Qualität, BPM sample-genau, Multi-User-PLL + Latenz-/Jitter-Prüfpunkte.
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: SCHWER
DOMAIN: SECURITY
DESCRIPTION: **Live-Prüfpunkte:** `docs/LIVE_CHECKLIST_2026-09-02.md` abarbeiten (Flotte, Browser, Audio/DSP, 4-User, KI/Eval, Security)
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: SCHWER
DOMAIN: SECURITY
DESCRIPTION: **S-7 Keine Content-Security-Policy (Mittel)** – Report-Only starten: `worker-src 'self' blob:`, `script-src 'self' 'wasm-unsafe-eval'`, `connect-src` auf Supabase/R2/SFU.
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: MITTEL
DOMAIN: SECURITY
DESCRIPTION: **AD-M1 ESLint-React-Hooks:** `DJ4ChMixer.tsx:182` useMemo; `set-state-in-effect` in `DropGeneratorPanel`, `DrumMachineTerminal`, `EQPluginTerminal`, `MasteringOverlay`, `MasterPlayerTerminal`, `SemanticSampleSearch`, `SettingsDialog`, `useControlHub`, `useHID`, `useMIDI`, `useMidiClockOut`, `useRoom`; `refs`-Warnungen in `MasterPlayerTerminal`, `MappingLearnPanel`, `AudioContext`, `useMidiClockOut`; `immutability` in `DropContext`, `useWebRTC`.
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: YES
STATUS: BLOCKED


BLOCKED
CLASS: MITTEL
DOMAIN: AUDIO
DESCRIPTION: **AD-M2 ESLint-Scripts:** scripts-Sammlung gefixt (2026-09-05: `build-worklets.mjs`, `check-react-memo.mjs`, `download-orchestral.mjs`, `sfu-rtp-multi-run.mjs`, `stress-test.mjs`, `wake-on-login/worker.js`, `services/mixer/index.js`, `services/portal-worker/src/index.js`). Offen: `no-require-imports` in `server.ts:1454`; `import/no-dynamic-require` in `LocalEmbeddingProvider.ts:41`.
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: MITTEL
DOMAIN: BACKEND
DESCRIPTION: **AD-M6 WebRTC:** `WebRTCManager.ts:150` SFU-Umschalt-Race; `WebRTCManager.ts:220` SFU-Producer-Fehlerbehandlung.
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **AD-N1 jscpd-Code-Duplikate** (u. a. `eqProcessor.ts`, `celery_app.py`, `drumSynth.ts`, `fmEngine.ts`, `VoiceMonkService.ts`, `RecorderTerminal.tsx`, `AiMonkDock.tsx`, `midiCodec.ts`, `presets.ts`, `DspEnginePlugin.tsx`, `sfu-rtp-*.js`) bereinigen.
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: YES
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **P1-2 Unit-Tests V1-Verkabelung:** Node-In/Out-Counts + Signalfluss-Spion analog `tests/audioEngine.test.ts` / `tests/monitorRouting.test.ts` ausbauen.
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: YES
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: RUNBOOKS
DESCRIPTION: **P1-4 Debug-/Analyser-Pfad:** `analyzerNode` → Visualisierung als fester Debug-Schritt dokumentieren/testen.
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **P1-5 Offline-Integrationstest:** `OfflineAudioContext`-Roundtrip (V1-Quelle → Kanalzug → Master → Bounce) automatisiert (goldenAudio/bounceGraph erweitern).
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **P1-6 PerformanceObserver:** Audio-Verarbeitungsdauer messen und in perfMONK anbinden.
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: PERFORMANCE
DESCRIPTION: **P1-7 100-%-Checkliste als Gate:** die 8 Punkte (Imports, Verkabelung, Fehlerbehandlung, Unit, Integration, Konsolenfehler, hörbar, Performance) in `npm run verify` oder CI aufnehmen.
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **P3-1 Routing-Dynamik prüfen:** V1 ist fest verdrahtet, `routing.json` wird nur teilweise angewendet. Machbarkeitsstudie: dynamisch rekonfigurierbarer Graph auf `AudioGraph` (V2) mit variablen Ports; Feedback-Schleifen nur nach Stabilitäts-/Phasentests.
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **P3-2 Einheitliche Port-API:** `IAudioPort`/`AudioPort` als verbindliche Schnittstelle für alle Module etablieren; variable Port-Anzahl erlauben.
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: ABRECHNUNG
DESCRIPTION: **P3-4 Latenzkompensation:** `getLatencyBudgetMs()` einführen und je Modul automatische Delay-Compensation vorbereiten (deckt A-4).
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **P3-5 Proprietäre Mathematik:** DSP-Modell-Versionierung einführen (z. B. `Compressor_v2.3`); LUT vs. Echtzeitberechnung je Algorithmus dokumentieren (Release-LUT ist schon da).
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: PERFORMANCE
DESCRIPTION: **P3-6 Schutz der Algorithmenkerne:** TEE/geschützter Speicher im Browser/Node als **nicht sinnvoll** markieren; stattdessen Build-/Bundle-Schutz und Objekt-Code-Review prüfen.
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: SECURITY
DESCRIPTION: **Prüfpunkt (Live):** 2 App-Knoten hinter LB, 4-User-E2E grün (State-Sync, Locking, Main-Stream stabil); Failover-Test (ein Knoten weg).
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: UI
DESCRIPTION: **Prüfpunkt (manuell/Live):** iPhone-Test vor Ort (UI nicht persistent, Panels schließbar, keine Zoom-/Overflow-Probleme; Safe-Area, Touch-Ziele ≥ 44 px).
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **Prüfpunkt (manuell/Live):** iOS/Android: Touch-Ziele ≥ 44 px, Safe-Areas, kein Hover-only.
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **Prüfpunkt (Live):** USB-Gerät angeschlossen → wird automatisch ausgewählt; Einstellungen nach Reload stabil; 2.1 sichtbar (Xonar U7).
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: YES
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **Prüfpunkt (Live):** USB-Default: Xonar bevorzugt, sonst erste USB-Karte.
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: YES
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **Prüfpunkt (Live):** Latenz-Messung vorher/nachher; `goldenAudio`-Tests ohne Artefakte; Dropout-Zähler bleibt 0 im Normalbetrieb.
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **Prüfpunkt (Live):** Lokale Roundtrip-Latenz < 15 ms (Ziel < 1 ms Audio-Thread p99.99); Netz-Latenz < 50 ms one-way; 0 Xruns/Dropouts im Normallauf.
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: PERFORMANCE
DESCRIPTION: **Prüfpunkt (Live):** 120 BPM, 10 min Lauf: Jitter < 1 ms; zwei Browser starten gleichzeitig und bleiben < 5 ms zueinander.
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **Prüfpunkt (Live):** Frequenzanalyse: Sub-Kanal enthält < 120 Hz, L/R enthält keine volle Bass-Einbuße; Testton 40 Hz auf Sub, 1 kHz auf L/R.
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **Prüfpunkt (Live):** 2.1-Layout: Sub < 80 Hz auf drittem Kanal oder Phantom-Fallback; Output-Layouts 2.0/2.1/2.2/3.x/4.x konfigurierbar. (12.x/18.x/24.x: siehe `SPECIAL_TODO.md`.)
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: DATABASE
DESCRIPTION: **Prüfpunkt (Live):** Echter MOA-LLM-Lauf (DeepSeek) je Plugin – 100 % der Kern-Kommandos werden korrekt geplant und ausgeführt; Scores in Supabase sichtbar.
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **Prüfpunkt (Live):** Fehlerfall zeigt verständliche Meldung (kein roher Traceback).
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **Prüfpunkt (Live):** A100/HF-Endpoint bevorzugt; DevSettings „AI Server Shutdown" aktiviert Fallbacks.
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: CI/CD
DESCRIPTION: **Prüfpunkt (Betreiber-Schritt):** CI-Lauf auf GitHub grün; Report enthält je Plugin Score, Dauer, Fehler.
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **Prüfpunkt (Live):** 4 Browser sehen identischen State.
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **Prüfpunkt (Live):** Gäste hören Main via Host-Stream; Cue separat.
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **Prüfpunkt (Live):** Rollenwechsel ohne Audio-Unterbrechung.
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: PERFORMANCE
DESCRIPTION: **Prüfpunkt (Live):** 0 Xruns/Dropouts im Normallauf.
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **AI-E2E-Szenario (Live):** Code-Teil erledigt – `tests/aiE2eScenario.test.ts` fährt Wake→Cold-Start→Load→Request→Switch→Scale-to-Zero gemockt durch → TASKDONE. Offen bleibt der Lauf gegen den echten HF-Endpoint (aus AITodo Phase 24–26).
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: RENDERING
DESCRIPTION: **AI-Failure-Suite (Live):** Code-Teil erledigt – `tests/aiFailureSuite.test.ts` deckt HF offline, GPU down, Duplicate und Crash ab (inkl. Fix des Concurrency-Slot-Lecks im `JobManager`) → TASKDONE. Offen bleibt die Wiederholung gegen die Live-Infrastruktur (aus AITodo Phase 24–26).
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: SECURITY
DESCRIPTION: **AI-GPU-Benchmarks (Live):** Cold/Warm/VRAM-Messwerte sobald Endpoint läuft (aus AITodo Phase 21/22/23, blockiert).
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: SECURITY
DESCRIPTION: **AI-Docker-Build/GPU-Test (CI/Betreiber):** Lokaler GPU-Test offen; CI baut/pusht Image automatisch (aus AITodo Phase 2, blockiert).
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **INT8-Kalibrierung (Live):** Je Modell vorab messen (aus AITodo OPTIONAL OPTIMIZATIONS).
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-001 · MEDIUM · @typescript-eslint/no-unused-vars** – `build-worklets.mjs:4` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: SECURITY
DESCRIPTION: **DA-2026-09-04-002 · MEDIUM · Verwundbarkeit: body-parser** – `package-lock.json` (npm-audit)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-003 · MEDIUM · @typescript-eslint/no-unused-vars** – `scripts/check-react-memo.mjs:6` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-004 · MEDIUM · @typescript-eslint/no-unused-vars** – `scripts/download-orchestral.mjs:17` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-005 · MEDIUM · prefer-const** – `scripts/dsp-benchmark.ts:67` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-006 · MEDIUM · @typescript-eslint/no-unused-vars** – `scripts/hetzner/sfu-rtp-multi-run.mjs:66` (eslint)
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-007 · MEDIUM · @typescript-eslint/no-unused-vars** – `scripts/hetzner/sfu-rtp-multi-run.mjs:84` (eslint)
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-008 · MEDIUM · @typescript-eslint/no-unused-vars** – `scripts/hetzner/sfu-rtp-multi-run.mjs:101` (eslint)
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: LASTTESTS
DESCRIPTION: **DA-2026-09-04-009 · MEDIUM · @typescript-eslint/no-unused-vars** – `scripts/hetzner/stress-test.mjs:76` (eslint)
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-010 · MEDIUM · @typescript-eslint/no-unused-vars** – `scripts/wake-on-login/worker.js:147` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-011 · MEDIUM · @typescript-eslint/no-unused-vars** – `scripts/wake-on-login/worker.js:167` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-019 · MEDIUM · Race Condition in Stem-Job-Management** – `server.ts:430` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-020 · MEDIUM · Potenzieller Zustandsverlust bei Stem-Jobs** – `server.ts:440` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-021 · MEDIUM · Unvollständige Fehlerbehandlung in parseMultipartStream** – `server.ts:470` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-022 · MEDIUM · @typescript-eslint/no-require-imports** – `server.ts:1422` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BARRIEREFREIHEIT
DESCRIPTION: **DA-2026-09-04-026 · MEDIUM · Unzureichende Validierung von Umgebungsvariablen** – `server/cloud.ts:159` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: DATABASE
DESCRIPTION: **DA-2026-09-04-028 · MEDIUM · Möglicher Fehler bei fehlenden Supabase-Konfiguration** – `server/cloudAutomation.ts:104` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-029 · MEDIUM · Potenzielle Race Condition bei Tag-Synchronisation** – `server/cloudAutomation.ts:119` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-033 · MEDIUM · @typescript-eslint/no-require-imports** – `services/backend-core/node/index.js:1` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-034 · MEDIUM · Race Condition bei Client-Verwaltung** – `services/backend-core/node/index.js:14` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-038 · MEDIUM · Unbegrenztes Wachstum der clients-Map durch wiederholte init mit verschiedenen userId** – `services/backend-core/node/index.js:45` (deepseek-pro)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: SECURITY
DESCRIPTION: **DA-2026-09-04-039 · MEDIUM · Unvollständige Lock-Cleanup-Logik** – `services/backend-core/node/index.js:47` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-046 · MEDIUM · Race Condition in Lazy Loading** – `services/backend-core/python/celery_app.py:123` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: SECURITY
DESCRIPTION: **DA-2026-09-04-052 · MEDIUM · Mögliche Injection in Service-URLs durch Umgebungsvariablen** – `services/backend-core/python/main.py:79` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-054 · MEDIUM · Unnötige JSON-Konvertierung bei Fehlerfällen** – `services/backend-core/python/main.py:100` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-065 · MEDIUM · @typescript-eslint/no-require-imports** – `services/midi-bridge/index.js:27` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: YES
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-066 · MEDIUM · @typescript-eslint/no-require-imports** – `services/midi-bridge/index.js:28` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: YES
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-067 · MEDIUM · @typescript-eslint/no-require-imports** – `services/midi-bridge/index.js:40` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: YES
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-068 · MEDIUM · @typescript-eslint/no-require-imports** – `services/midi-bridge/index.js:80` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: YES
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-069 · MEDIUM · @typescript-eslint/no-require-imports** – `services/midi-bridge/index.js:100` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: YES
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-070 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:7` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-071 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:8` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-072 · MEDIUM · @typescript-eslint/no-unused-vars** – `services/mixer/index.js:23` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-073 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:39` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-074 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:41` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-075 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:51` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-076 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:53` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-077 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:71` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-078 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:73` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-079 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:85` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-080 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:87` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-081 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:99` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-082 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:101` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-083 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:115` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-084 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:117` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-085 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:126` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-086 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:128` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-087 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:140` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-088 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:142` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-089 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:159` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-090 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:161` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-091 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:176` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-092 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:178` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-093 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:189` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-094 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:191` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-095 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:205` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-096 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:207` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-097 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:218` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-098 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:220` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-099 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:234` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-100 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:236` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-101 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:247` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-102 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:249` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-103 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:263` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-104 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:265` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-105 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:276` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-106 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:278` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-107 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:291` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-108 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:293` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-109 · MEDIUM · @typescript-eslint/no-unused-vars** – `services/portal-worker/src/index.js:33` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-111 · MEDIUM · Race Condition in Model Loading** – `services/samplemonk-ai-runtime/app.py:117` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-114 · MEDIUM · Potential Race Condition in Cache Eviction** – `services/samplemonk-ai-runtime/handlers.py:125` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-116 · MEDIUM · Potential Integer Overflow in Audio Resampling** – `services/samplemonk-ai-runtime/handlers.py:160` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-118 · MEDIUM · Fehlende Fehlerbehandlung bei Legacy-Endpoint-Löschung** – `services/samplemonk-ai-runtime/hf_manage_endpoint.py:109` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-119 · MEDIUM · Mögliche Race Condition bei Statusabfrage** – `services/samplemonk-ai-runtime/hf_manage_endpoint.py:124` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-121 · MEDIUM · Mögliche Race Condition bei Modell-Laden/Entladen** – `services/samplemonk-ai-runtime/mcp_runtime.py:69` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-124 · MEDIUM · Race Condition bei parallelen Load-Requests** – `services/samplemonk-ai-runtime/model_manager.py:139` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-130 · MEDIUM · @typescript-eslint/no-require-imports** – `services/signaling/index.js:1` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-131 · MEDIUM · @typescript-eslint/no-require-imports** – `services/signaling/index.js:2` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-132 · MEDIUM · @typescript-eslint/no-require-imports** – `services/signaling/index.js:3` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-133 · MEDIUM · prefer-const** – `src/audio/worklets/dspProcessor.ts:135` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: UI
DESCRIPTION: **DA-2026-09-04-134 · MEDIUM · react-hooks/use-memo** – `src/components/DJ4ChMixer.tsx:182` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: UI
DESCRIPTION: **DA-2026-09-04-135 · MEDIUM · react-hooks/set-state-in-effect** – `src/components/drop/DropGeneratorPanel.tsx:27` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: UI
DESCRIPTION: **DA-2026-09-04-136 · MEDIUM · react-hooks/set-state-in-effect** – `src/components/DrumMachineTerminal.tsx:86` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: UI
DESCRIPTION: **DA-2026-09-04-137 · MEDIUM · react-hooks/preserve-manual-memoization** – `src/components/DrumMachineTerminal.tsx:126` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: UI
DESCRIPTION: **DA-2026-09-04-138 · MEDIUM · react-hooks/preserve-manual-memoization** – `src/components/DrumMachineTerminal.tsx:140` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: UI
DESCRIPTION: **DA-2026-09-04-139 · MEDIUM · react-hooks/preserve-manual-memoization** – `src/components/DrumMachineTerminal.tsx:201` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: UI
DESCRIPTION: **DA-2026-09-04-140 · MEDIUM · react-hooks/preserve-manual-memoization** – `src/components/DrumMachineTerminal.tsx:210` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: UI
DESCRIPTION: **DA-2026-09-04-141 · MEDIUM · react-hooks/set-state-in-effect** – `src/components/DrumMachineTerminal.tsx:219` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-142 · MEDIUM · react-hooks/set-state-in-effect** – `src/components/EQPluginTerminal.tsx:254` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: UI
DESCRIPTION: **DA-2026-09-04-143 · MEDIUM · react-hooks/set-state-in-effect** – `src/components/MasteringOverlay.tsx:60` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: UI
DESCRIPTION: **DA-2026-09-04-144 · MEDIUM · react-hooks/refs** – `src/components/MasterPlayerTerminal.tsx:120` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: UI
DESCRIPTION: **DA-2026-09-04-145 · MEDIUM · react-hooks/refs** – `src/components/MasterPlayerTerminal.tsx:130` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: UI
DESCRIPTION: **DA-2026-09-04-146 · MEDIUM · react-hooks/set-state-in-effect** – `src/components/MasterPlayerTerminal.tsx:194` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: UI
DESCRIPTION: **DA-2026-09-04-147 · MEDIUM · react-hooks/set-state-in-effect** – `src/components/MasterPlayerTerminal.tsx:272` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: UI
DESCRIPTION: **DA-2026-09-04-148 · MEDIUM · react-hooks/refs** – `src/components/midi/MappingLearnPanel.tsx:28` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: YES
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: UI
DESCRIPTION: **DA-2026-09-04-149 · MEDIUM · react-hooks/set-state-in-effect** – `src/components/SemanticSampleSearch.tsx:71` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: UI
DESCRIPTION: **DA-2026-09-04-150 · MEDIUM · react-hooks/set-state-in-effect** – `src/components/SettingsDialog.tsx:90` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-151 · MEDIUM · react-hooks/refs** – `src/context/AudioContext.tsx:103` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-152 · MEDIUM · react-hooks/refs** – `src/context/AudioContext.tsx:104` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-153 · MEDIUM · react-hooks/refs** – `src/context/AudioContext.tsx:105` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-154 · MEDIUM · react-hooks/refs** – `src/context/AudioContext.tsx:343` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-155 · MEDIUM · react-hooks/immutability** – `src/context/DropContext.tsx:150` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-156 · MEDIUM · react-hooks/preserve-manual-memoization** – `src/context/DropContext.tsx:249` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: SECURITY
DESCRIPTION: **DA-2026-09-04-158 · MEDIUM · Fehlende Fehlerbehandlung bei RBAC-Prüfung** – `src/context/ModuleStateContext.tsx:59` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: ARCHITECTURE
DESCRIPTION: **DA-2026-09-04-159 · MEDIUM · Potenzielle Race Condition bei Zustandsaktualisierung** – `src/context/ModuleStateContext.tsx:67` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BARRIEREFREIHEIT
DESCRIPTION: **DA-2026-09-04-160 · MEDIUM · Zugriff auf ref-Variable außerhalb von Callbacks** – `src/context/PluginManagerContext.tsx:32` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: SECURITY
DESCRIPTION: **DA-2026-09-04-162 · MEDIUM · Möglicher Race Condition bei Lock-Abfrage** – `src/context/PluginManagerContext.tsx:58` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-163 · MEDIUM · prefer-const** – `src/core/drop/AiDropGenerator.ts:169` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-164 · MEDIUM · @typescript-eslint/no-unused-expressions** – `src/core/workers/WorkerPool.ts:83` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-165 · MEDIUM · prefer-const** – `src/data/musicLibrary.ts:20` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-166 · MEDIUM · react-hooks/set-state-in-effect** – `src/hooks/useControlHub.ts:23` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-167 · MEDIUM · react-hooks/set-state-in-effect** – `src/hooks/useHID.ts:72` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-168 · MEDIUM · react-hooks/set-state-in-effect** – `src/hooks/useMIDI.ts:175` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: YES
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: SECURITY
DESCRIPTION: **DA-2026-09-04-169 · MEDIUM · react-hooks/refs** – `src/hooks/useMidiClockOut.ts:43` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: YES
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: SECURITY
DESCRIPTION: **DA-2026-09-04-170 · MEDIUM · react-hooks/refs** – `src/hooks/useMidiClockOut.ts:46` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: YES
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: SECURITY
DESCRIPTION: **DA-2026-09-04-171 · MEDIUM · react-hooks/set-state-in-effect** – `src/hooks/useMidiClockOut.ts:62` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: YES
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: SECURITY
DESCRIPTION: **DA-2026-09-04-172 · MEDIUM · react-hooks/refs** – `src/hooks/useMidiClockOut.ts:86` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: YES
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-173 · MEDIUM · Möglicher Race Condition bei Zustandsabfrage** – `src/hooks/usePluginState.ts:20` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-175 · MEDIUM · react-hooks/set-state-in-effect** – `src/hooks/useRoom.ts:28` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-179 · MEDIUM · react-hooks/immutability** – `src/hooks/useWebRTC.ts:25` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-180 · MEDIUM · react-hooks/immutability** – `src/hooks/useWebRTC.ts:27` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-181 · MEDIUM · react-hooks/immutability** – `src/hooks/useWebRTC.ts:29` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-182 · MEDIUM · prefer-const** – `src/utils/audioEngine.ts:1946` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-183 · MEDIUM · @typescript-eslint/ban-ts-comment** – `src/utils/audioEngine.ts:1963` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-184 · MEDIUM · @typescript-eslint/ban-ts-comment** – `src/utils/audioEngine.ts:1965` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-185 · MEDIUM · import/no-dynamic-require** – `src/utils/LocalEmbeddingProvider.ts:41` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-186 · MEDIUM · prefer-const** – `src/utils/usageAnalytics.ts:16` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-188 · MEDIUM · Race Condition bei Peer-Verbindungen** – `src/utils/WebRTCManager.ts:170` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-190 · MEDIUM · @typescript-eslint/no-require-imports** – `server.ts:1454` (eslint)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-191 · MEDIUM · Fehlerhafte Regex-Logik bei Kategorisierung** – `server/cloudAutomation.ts:100` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BARRIEREFREIHEIT
DESCRIPTION: **DA-2026-09-04-193 · MEDIUM · Zugriff auf Umgebungsvariablen ohne Sicherheitsprüfungen** – `server/cloudAutomation.ts:132` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: SECURITY
DESCRIPTION: **DA-2026-09-04-194 · MEDIUM · Uvicorn bindet ohne sichtbare Authentifizierung an 0.0.0.0** – `services/backend-core/package.json:8` (deepseek-pro)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-195 · HIGH · Unvalidated File Path in `_validate_audio_file`** – `services/backend-core/python/celery_app.py:33` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-196 · MEDIUM · Race Condition in `_load_demucs`** – `services/backend-core/python/celery_app.py:104` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-197 · MEDIUM · Race Condition in `_load_musicgen`** – `services/backend-core/python/celery_app.py:120` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-198 · HIGH · Ungeprüfte Benutzereingabe in JSON-Validierung** – `services/backend-core/python/hypersonic_moa.py:57` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-199 · MEDIUM · Potential Race Condition in Model Loading** – `services/samplemonk-ai-runtime/app.py:124` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-200 · HIGH · Sensitive Data Exposure in Error Logging** – `services/samplemonk-ai-runtime/app.py:140` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-202 · HIGH · Unvalidated User Input in Model ID and Task** – `services/samplemonk-ai-runtime/handlers.py:105` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-203 · MEDIUM · Fehlende Fehlerbehandlung bei Audio-Resampling** – `services/samplemonk-ai-runtime/handlers.py:130` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: SECURITY
DESCRIPTION: **DA-2026-09-04-204 · HIGH · Potenzielle Exposition von Secrets in Logs** – `services/samplemonk-ai-runtime/hf_manage_endpoint.py:104` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-205 · MEDIUM · Unsichere Fehlerbehandlung bei `get_inference_endpoint`** – `services/samplemonk-ai-runtime/hf_manage_endpoint.py:122` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-206 · MEDIUM · Mangelnde Trennung von Konfiguration und Logik** – `services/samplemonk-ai-runtime/hf_manage_endpoint.py:130` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: AUDIO
DESCRIPTION: **DA-2026-09-04-207 · MEDIUM · Race Condition bei parallelen Load-Requests** – `services/samplemonk-ai-runtime/model_manager.py:130` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-208 · MEDIUM · Nicht expliziter Fehlerfall bei fehlender VRAM** – `services/samplemonk-ai-runtime/model_manager.py:190` (hf-qwen)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: SECURITY
DESCRIPTION: **DA-2026-09-04-209 · MEDIUM · Fehlende Hash-Pins und kein Lockfile für Supply-Chain-Sicherheit** – `services/samplemonk-ai-runtime/pyproject.toml:7` (deepseek-pro)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-210 · MEDIUM · Veraltete und exakt gepinnte PyTorch-Version (torch==2.4.1)** – `services/samplemonk-ai-runtime/pyproject.toml:11` (deepseek-pro)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-211 · MEDIUM · Revision-Pinning kann durch explizites `null` umgangen werden** – `services/samplemonk-ai-runtime/registry.py:26` (deepseek-flash)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-212 · MEDIUM · Working-directory change via dirname $0 breaks when invoked through symlink** – `services/samplemonk-ai-runtime/startup.sh:9` (deepseek-flash)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-213 · MEDIUM · No write/space verification for HF_HOME persistent cache** – `services/samplemonk-ai-runtime/startup.sh:10` (deepseek-flash)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-214 · HIGH · AI_RUNTIME_DEVICE defaults to cuda with no validation** – `services/samplemonk-ai-runtime/startup.sh:13` (deepseek-flash)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-215 · MEDIUM · AI-Runtime lauscht ungeschützt auf allen Interfaces** – `services/samplemonk-ai-runtime/startup.sh:18` (deepseek-pro)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: SECURITY
DESCRIPTION: **DA-2026-09-04-216 · MEDIUM · Server binds 0.0.0.0 with no authentication or proxy boundary check** – `services/samplemonk-ai-runtime/startup.sh:21` (deepseek-flash)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: SECURITY
DESCRIPTION: **DA-2026-09-04-217 · MEDIUM · updateState ist nicht stabil und kann stale lockStatus verwenden** – `src/hooks/usePluginState.ts:28` (deepseek-pro)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: SECURITY
DESCRIPTION: **DA-2026-09-04-218 · HIGH · Autorisierung nur clientseitig – Lock-Prüfung nicht im Backend erzwungen** – `src/hooks/usePluginState.ts:29` (deepseek-pro)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-219 · MEDIUM · syncAdd sends arbitrary unvalidated sample to remote peers** – `src/hooks/useSessionSync.ts:35` (deepseek-pro)
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-220 · MEDIUM · Race Condition bei SFU-Modus-Umschaltung** – `src/utils/WebRTCManager.ts:150` (hf-qwen)
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED


BLOCKED
CLASS: LEICHT
DOMAIN: BACKEND
DESCRIPTION: **DA-2026-09-04-221 · MEDIUM · Mögliche Fehlerbehandlung bei SFU-Produzenten** – `src/utils/WebRTCManager.ts:220` (hf-qwen)
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED

