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
- [x] **P1-2 Skins (Komponenten)**: Hardware-Look-Komponenten je Plugin → umgesetzt 2026-09-03: `getHardwareSkinClass()` + `.hw-skin-*`-Klassen (mixer/synthesizer/drum/eq/mastering/spatial/mcp/sampler: Panel-Texturen, Knob-/Fader-Accents über `--monk-accent`) in `src/index.css`, angewandt in `ModuleContainer`; Farben bleiben zentral in `.monk-theme-*`. Screenshot-Baselines vorhanden → TASKDONE.
- [x] **P1-4 Scratchpad Prüfpunkt (Browser-Live):** Speichern/Laden überlebt Reload; DnD funktioniert; Clipboard-Roundtrip (Copy → Paste) liefert gültiges JSON. Code + Helper-Tests grün (`tests/sessionScratchpad.test.ts`). → Browser-Verifikation automatisiert 2026-09-04: `tests/e2e/scratchpad.spec.ts` (Reload-Persistenz, DnD beide Richtungen, Clipboard-Read/Paste → gültiges JSON) grün → TASKDONE.
- [ ] **P2-1/P2-2 Rest (Live + Code):** Resampling-/Filter-Qualität, BPM sample-genau, Multi-User-PLL + Latenz-/Jitter-Prüfpunkte.
- [x] **P2-4 Prüfpunkt (Live):** Performance-Messung zeigt < 70 % CPU (Graph-Validierung + effectNode-Insert sind umgesetzt). → automatisiert 2026-09-04: `tests/e2e/performance.spec.ts` misst via CDP `Performance.getMetrics` (TaskDuration/Wanduhr) unter Studio-Last **20,6 % CPU** → TASKDONE.
- [x] **P3-3 Prüfpunkt**: Eval-Lauf grün, Report je Plugin mit Score, Dauer und Fehler (`npm run eval:ai` → `test-results/ai-eval-report.json/.md`, Gate aus `src/core/ai/orchestrator/evalMatrix.ts`, Nightly-Artefakt + Job-Summary) → TASKDONE. Offen bleibt nur die Bestätigung des nächtlichen CI-Laufs auf GitHub (Betreiber-Schritt).
- [ ] **Live-Prüfpunkte:** `docs/LIVE_CHECKLIST_2026-09-02.md` abarbeiten (Flotte, Browser, Audio/DSP, 4-User, KI/Eval, Security)
- [x] **Audiokanalfluss-Audit (2026-09-05):** F1 Plugin-/Worklet-Quellen laufen jetzt über den Kanalzug (Pre-Fader→Fader→EQ→Pan→GLOBAL_MASTER); F2 Master-Stream wird post-Mastering abgegriffen (`masterStreamTap`); F3 2.1-Routing ohne mainMonitorGain-Bypass; F4/F5 Cue/PFL pre-fader + tote MON/USER-Busse entfernt + PDC-Delay im Cue-Pfad; F6 `setMixChannelParam('gain'/'pan')`-No-op beseitigt, neuer `setMasterVolumeDb()`; F7 `routing.json` wendet Pattern/Bus-Effekte an; tote Mischpult-Altlasten gelöscht; V2/Native-Backends als `@deprecated` markiert. Neu: `src/core/audio/pluginChannelMap.ts` + `tests/channelFlow.test.ts`; `npm run verify` grün (793 Tests, Boundary-Scan 344 Dateien). → TASKDONE.

---

## 🔴 Übernahme aus `AUDIT.md` (Tiefen-Audit 2026-09-03, Commit 7b22c18)

> Die Datei AUDIT.md wurde am 2026-09-05 vollständig in diese Liste überführt und anschließend gelöscht.

### K – Kritisch: Multi-User/B2B-Locking

- [x] **K-1 Lock-Owner-Vergleich gegen falsches Literal** – 14 Komponenten ersetzen `'localUser'` durch `webRTCManager.userId` (2026-09-05); `usePluginState` auditiert mit echter User-ID.
- [x] **K-2 Plugin-Locks werden nicht netzwerkweit repliziert** – Server `plugin-lock`/`plugin-unlock`/`plugin-locks-sync` + Client-Replikation in `PluginManagerContext`/`WebRTCManager` (2026-09-05).
- [x] **K-3 `releaseLock()` prüft den Halter nicht** – Owner-Check im Client + Server akzeptiert nur Owner (`plugin-unlock`) (2026-09-05).
- [x] **K-4 Lock-Halter kann eigenen State nicht ändern** – `usePluginState.updateState()` prüft Owner korrekt (2026-09-05).
- [x] **K-5 Keine Lock-Freigabe bei Disconnect** – Server-TTL 60 s + Release im `disconnect`-Handler (2026-09-05).

### S – Backend & Security

- [x] **S-1 Rohe Exception-Messages an Client (Hoch)** – SFU-Callbacks generisch (`'internal'`) + `cloudAutomation` nutzt Codes (2026-09-05).
- [x] **S-2 Socket.io-Relay ohne Ziel-Validierung (Hoch)** – `relayToSessionPeer` prüft Ziel-Socket + Session-Room (2026-09-05).
- [x] **S-3 `assign-role` ohne Session-Zugehörigkeitsprüfung (Hoch)** – Ziel-User gegen Room-Mitglieder + self validiert (2026-09-05).
- [x] **S-4 Admin-Token-Vergleich nicht konstantzeitig (Mittel)** – `safeTokenEqual()` für `x-admin-token` (2026-09-05).
- [x] **S-5 SFU-`sessionId` ungeprüft (Mittel)** – Whitelist `/^[a-zA-Z0-9_-]{1,64}$/`, sonst disconnect (2026-09-05).
- [x] **S-6 `VOICE_CLI` ungeprüft (Mittel)** – Pfad-Allowlist + `crypto.randomBytes` im Dateinamen (2026-09-05).
- [ ] **S-7 Keine Content-Security-Policy (Mittel)** – Report-Only starten: `worker-src 'self' blob:`, `script-src 'self' 'wasm-unsafe-eval'`, `connect-src` auf Supabase/R2/SFU.
- [x] **S-8 `qs`-Kette verwundbar (Niedrig)** – `npm audit fix` durchgeführt (2026-09-05, 0 Vulnerabilities).
- [x] **S-9 Redis-/Fleet-Map-URL ungeprüft (Niedrig)** – `new URL()` https-only + redis/rediss-Schema-Whitelist (2026-09-05).

### A – Audio-Engine & DSP

- [x] **A-1 LUFS `log10(0)` → -Infinity (Hoch)** – `lufsProcessor.ts:21-25` gefixt (2026-09-05): `Math.max(rms, 1e-8)` + Clamp −70 dB.
- [ ] **A-2 `audioEngine.ts` 2814-Zeilen-Monolith (Mittel)** – in Graph-Aufbau/Worklet-Factory/Routing/Monitoring schneiden; Kernpfad-Coverage (26,7 %) erhöhen.
- [ ] **A-3 Fehlgeschlagene Worklets nicht entsorgt (Mittel)** – `makeWorklet`-Fallbacks disconnecten und im Teardown führen.
- [ ] **A-4 Mastering-Lookahead nicht per API abfragbar (Mittel)** – `audioEngine.getLatencyBudgetMs()` mit Stufen-Aufschlüsselung; in perfMONK anzeigen.
- [ ] **A-5 Allokationen im `process()`-Pfad bei Kanal-/Quantum-Wechsel (Niedrig)** – im Konstruktor auf Maximalkanäle/-quantum vorallozieren.
- [x] **A-6 Quantum-Annahme 128 im EQ-Ramping (Niedrig)** – gefixt (2026-09-05): `blockSize` aus `input[0].length`.
- [x] **A-7 Keine Denormal-Clamps im Reverb-Feedback (Niedrig)** – gefixt (2026-09-05) in `effectProcessor.ts:94-121`.

### F – Frontend, React & Architektur

- [x] **F-1 `src/hooks/useWebRTC.ts` toter Code (Mittel)** – gelöscht (2026-09-05).
- [ ] **F-2 Vier parallele Lock-Modelle (Mittel)** – auf ein serverseitig autoritatives Modell konsolidieren.
- [x] **F-3 Memo-Gate rot (Mittel)** – `DropTerminal.tsx` nutzt bereits `React.memo`; `check:memo` grün (2026-09-05). Offen: CI-Pflicht-Step.
- [x] **F-4 LWW-Merge ohne Payload-Validierung (Mittel)** – `VALID_PLUGIN_IDS.has(pluginId)` verifiziert (2026-09-05).
- [ ] **F-5 160× `any` (Mittel)** – Zod-Schemas für alle Peer-Payloads; Feature-Detection eng typisieren.
- [ ] **F-6 Non-null-Assertions ohne Guard (Niedrig)** – explizite Guards mit sprechender Meldung.
- [ ] **F-7 Handler-Zuweisung statt Subscription (Niedrig)** – `onMainStream`/`onSessionUpdate` auf `addDataChannelListener`-Muster mit Unsubscribe.
- [ ] **F-8 Accessibility (Niedrig)** – Slider-Rollen, `aria-pressed`, `aria-disabled`/`aria-label` für Lock-Zustand.

### Q – Build, CI & Qualität

- [ ] **Q-1 `check:memo` und `npm audit` fehlen als CI-Gates.**
- [ ] **Q-2 Bundle 1.56 MB > 1.50 MB Warnschwelle** – `tone`/`lucide-react` splitten/tree-shaken.
- [ ] **Q-3 Coverage 32,6 %; untertestete Risiko-Dateien:** `audioEngine.ts` 26,7 %, `WebRTCManager.ts` 26,0 %, `rbac.ts` 0 %, `AuditLogger.ts` 0 %, `dropAudioBridge.ts` 0 %, `audioAnalyzer.ts` 0 %, `presetStore.ts`/`opfs.ts` 0 %.
- [ ] **Q-4 `rbac.ts` (sicherheitsrelevant) mit Tests abdecken.**

### Empfohlene Reihenfolge (AUDIT.md)

1. Sofort P0: K-1 → K-4 → K-3 → K-2 → K-5 + Regressionstests.
2. Kurzfristig P1: S-1, S-2, S-3, S-4; A-1; F-3 + CI; `npm audit fix`; F-1.
3. Mittelfristig P2: F-4/F-5 Zod; A-2 Modularisierung + Coverage; Bundle; S-7/S-5/S-6/S-9; A-3…A-7; F-6…F-8.

---

## 🔴 Übernahme aus `AUDIT_DEEP.md` (Deep Audit 300)

> Die Datei AUDIT_DEEP.md wurde am 2026-09-05 vollständig in diese Liste überführt und anschließend gelöscht.

### Kritisch (3)

- [x] **AD-K1 `server/cloudAutomation.ts:122`** – verifiziert (2026-09-05): `ingestAudioObject` nutzt generische Codes, keine `error.message`.
- [x] **AD-K2 `services/samplemonk-ai-runtime/app.py:150`** – MCP-Tools ohne `AI_MCP_API_TOKEN` deaktiviert (503); sonst `hmac.compare_digest` (2026-09-05).
- [x] **AD-K3 `services/samplemonk-ai-runtime/model_manager.py:170`** – `empty_cache()` nur noch bei `AI_CUDA_EMPTY_CACHE_ON_UNLOAD/EVICT=1` (2026-09-05).

### Hoch (11)

- [x] **AD-H1 `server/cloudAutomation.ts:76`** – `isSafeR2Key` härter: Colon-Block, Segmentlängen 1..255 (2026-09-05).
- [x] **AD-H2 `services/backend-core/python/celery_app.py:33`** – verifiziert: `realpath`-Root-Check vorhanden (2026-09-05).
- [x] **AD-H3 `services/backend-core/python/hypersonic_moa.py:57`** – verifiziert: Datei nutzt keine `json.loads(raw)`-Strecke mehr (2026-09-05).
- [x] **AD-H4 `services/samplemonk-ai-runtime/app.py:107`** – `/infer` prüft Modell gegen Manifest-Whitelist `KNOWN_MODEL_IDS` (2026-09-05).
- [x] **AD-H5 `services/samplemonk-ai-runtime/app.py:140`** – Error-Logging nutzt nur noch `type(exc).__name__` (2026-09-05).
- [x] **AD-H6 `services/samplemonk-ai-runtime/handlers.py:105`** – verifiziert: `run_inference` validiert task und nutzt `HANDLERS`-Whitelist (2026-09-05).
- [x] **AD-H7 `services/samplemonk-ai-runtime/hf_manage_endpoint.py:104`** – verifiziert: kein `HF_TOKEN`-Logging; Token nur im `secrets`-Feld (2026-09-05).
- [x] **AD-H8 `services/samplemonk-ai-runtime/model_manager.py:107`** – verifiziert: `_SAFE_REPOSITORY_RE`/`_SAFE_REVISION_RE` vorhanden (2026-09-05).
- [x] **AD-H9 `services/samplemonk-ai-runtime/startup.sh:13`** – `AI_RUNTIME_DEVICE` Allowlist (`cpu|cuda|mps|auto`), Default auto (2026-09-05).
- [x] **AD-H10 `src/hooks/usePluginState.ts:29`** – Lock-Prüfung jetzt auch serverseitig erzwungen (`plugin-lock`/`plugin-state`-RBAC) (2026-09-05).
- [x] **AD-H11 `src/utils/WebRTCManager.ts:109`** – `senderId` wird durch `peer.userId` ersetzt (bestehende Validierung bestätigt) (2026-09-05).

### Mittel (72) – verdichtet

- [ ] **AD-M1 ESLint-React-Hooks:** `DJ4ChMixer.tsx:182` useMemo; `set-state-in-effect` in `DropGeneratorPanel`, `DrumMachineTerminal`, `EQPluginTerminal`, `MasteringOverlay`, `MasterPlayerTerminal`, `SemanticSampleSearch`, `SettingsDialog`, `useControlHub`, `useHID`, `useMIDI`, `useMidiClockOut`, `useRoom`; `refs`-Warnungen in `MasterPlayerTerminal`, `MappingLearnPanel`, `AudioContext`, `useMidiClockOut`; `immutability` in `DropContext`, `useWebRTC`.
- [ ] **AD-M2 ESLint-Scripts:** scripts-Sammlung gefixt (2026-09-05: `build-worklets.mjs`, `check-react-memo.mjs`, `download-orchestral.mjs`, `sfu-rtp-multi-run.mjs`, `stress-test.mjs`, `wake-on-login/worker.js`, `services/mixer/index.js`, `services/portal-worker/src/index.js`). Offen: `no-require-imports` in `server.ts:1454`; `import/no-dynamic-require` in `LocalEmbeddingProvider.ts:41`.
- [ ] **AD-M3 Backend-Bugs:** `cloudAutomation.ts:100` Regex-Logik; `cloudAutomation.ts:132` Env-Zugriffe; `celery_app.py:104/120` Race Conditions `_load_demucs`/`_load_musicgen`; `hypersonic_moa.py:67` leerer Prompt; `app.py:124` + `handlers.py:105` Race Conditions Model-Loading; `handlers.py:130` Resampling-Fehlerbehandlung; `hf_manage_endpoint.py:122/130` Fehlerbehandlung/Trennung Konfiguration-Logik; `model_manager.py:130/190` Race/Load + VRAM-Fehlerfall; `registry.py:26` Revision-Pinning via `null`; `startup.sh:9/10` Symlink-Pfad + HF_HOME-Space-Check.
- [ ] **AD-M4 AI-Runtime-Security/Architektur:** `backend-core/package.json:8` Uvicorn 0.0.0.0 ohne Auth; `startup.sh:18/21` AI-Runtime ungeschützt auf allen Interfaces; `pyproject.toml:7/11` fehlende Hash-Pins/Lockfile + veraltetes `torch==2.4.1`.
- [ ] **AD-M5 React/State:** `usePluginState.ts:28` stale lockStatus; `useSessionSync.ts:35` `syncAdd` sendet unvalidierte Samples an Peers.
- [ ] **AD-M6 WebRTC:** `WebRTCManager.ts:150` SFU-Umschalt-Race; `WebRTCManager.ts:220` SFU-Producer-Fehlerbehandlung.

### Niedrig (813) – aggregiert

- [ ] **AD-N1 jscpd-Code-Duplikate** (u. a. `eqProcessor.ts`, `celery_app.py`, `drumSynth.ts`, `fmEngine.ts`, `VoiceMonkService.ts`, `RecorderTerminal.tsx`, `AiMonkDock.tsx`, `midiCodec.ts`, `presets.ts`, `DspEnginePlugin.tsx`, `sfu-rtp-*.js`) bereinigen.
- [ ] **AD-N2 ESLint-Low-Hänger** – `scripts/**` teilgefixt (2026-09-05). Offen: `server.ts`, `ai/localDemucs.ts`, `audio-runtime/src/main.rs`.
- [ ] **AD-N3 160× `any`/`as any` + 3× ts-ignore reduzieren** (deckungsgleich mit F-5/AUDIT.md).

### Info (2)

- [x] **AD-I1 `services/samplemonk-ai-runtime/startup.sh:17`** – `AI_MODEL_MANIFEST`-Default jetzt `$SCRIPT_DIR/model_manifest.json` (2026-09-05).
- [x] **AD-I2 `src/hooks/useSessionSync.ts:37`** – `SCRATCHPAD_UPDATE` mit `seq`/`ts` je Sender (2026-09-05).

---

## 🔵 Prüfung eingereichter Punkte (2026-09-05)

> Bewertet auf Machbarkeit und Sinn im **Bestand**. Umsetzbare Bestands-Punkte stehen hier in MASTER_TODO; Zukunftsvisionen in `VISIONS_TODO.md` auf dem Branch `visions`.

### P-1 · V1 & V2 Audiograph-Verifikation

**Bewertung:** Sinnvoll und machbar als Audit-/Test-Checkliste. V1 (`audioEngine`, Tone/WebAudio) ist der Live-Pfad; V2 (`AudioGraph`/`V2StudioGraph`/Backends) ist als Prototyp markiert und nur in Tests verdrahtet.

- [ ] **P1-1 Statische V1-Verkabelung verifizieren:** Importe/Initialisierung, alle `connect()`-Aufrufe, Fehlerbehandlung – als Test-/Audit-Schritt dokumentieren.
- [ ] **P1-2 Unit-Tests V1-Verkabelung:** Node-In/Out-Counts + Signalfluss-Spion analog `tests/audioEngine.test.ts` / `tests/monitorRouting.test.ts` ausbauen.
- [ ] **P1-3 Laufzeit-Prüfungen:** `audioContext.state`, `sampleRate`, `baseLatency`, `outputLatency` sichtbar machen (perfMONK nutzt `getAudioHealth()` bereits).
- [ ] **P1-4 Debug-/Analyser-Pfad:** `analyzerNode` → Visualisierung als fester Debug-Schritt dokumentieren/testen.
- [ ] **P1-5 Offline-Integrationstest:** `OfflineAudioContext`-Roundtrip (V1-Quelle → Kanalzug → Master → Bounce) automatisiert (goldenAudio/bounceGraph erweitern).
- [ ] **P1-6 PerformanceObserver:** Audio-Verarbeitungsdauer messen und in perfMONK anbinden.
- [ ] **P1-7 100-%-Checkliste als Gate:** die 8 Punkte (Imports, Verkabelung, Fehlerbehandlung, Unit, Integration, Konsolenfehler, hörbar, Performance) in `npm run verify` oder CI aufnehmen.

**Nicht sinnvoll im Bestand:** `AudioGraph`-Fremdbibliothek/„audiograph“-Import – Eigenbau liegt vor. V2-Live-Parität → `VISIONS_TODO.md`.

### P-2 · Core-Engine-Abgleich (Agenten-Prompt)

**Bewertung:** Sinnvoll als wiederkehrende Audit-Methodik (Ist/Soll-Abgleich + Maßnahmen), kein Code-Feature. Die enthaltenen Schritte passen auf das bestehende System.

- [ ] **P2-1 Core-Engine-Audit nach dem 4-Schritte-Schema** (Bestandsaufnahme → Abgleich → Bewertung umgesetzt/teilweise/nicht → Maßnahmen) einmalig für die Audio-Engine durchführen; Ergebnis als Abschnitt in MASTER_TODO/TASKDONE.
- [ ] **P2-2 Methodik als wiederholbares Skript/Checkliste** in `scripts/` (z. B. `core-engine-abgleich.md`) ablegen, damit künftige Audits identisch ablaufen.

### P-3 · PluginSystem-Briefing

**Bewertung:** Prüffragen zum Ist-Zustand sind machbar und sinnvoll; Hardware-/Zukunftsteile sind Visionen → `VISIONS_TODO.md`.

- [ ] **P3-1 Routing-Dynamik prüfen:** V1 ist fest verdrahtet, `routing.json` wird nur teilweise angewendet. Machbarkeitsstudie: dynamisch rekonfigurierbarer Graph auf `AudioGraph` (V2) mit variablen Ports; Feedback-Schleifen nur nach Stabilitäts-/Phasentests.
- [ ] **P3-2 Einheitliche Port-API:** `IAudioPort`/`AudioPort` als verbindliche Schnittstelle für alle Module etablieren; variable Port-Anzahl erlauben.
- [ ] **P3-3 Clock & Synchronisation messen:** Jitter < ±1 Sample bei 48 kHz verifizieren; parallele Verteilung vs. Kaskade dokumentieren; Hot-Plug-Verhalten testen (deckt P2-1/P2-2 Rest).
- [ ] **P3-4 Latenzkompensation:** `getLatencyBudgetMs()` einführen und je Modul automatische Delay-Compensation vorbereiten (deckt A-4).
- [ ] **P3-5 Proprietäre Mathematik:** DSP-Modell-Versionierung einführen (z. B. `Compressor_v2.3`); LUT vs. Echtzeitberechnung je Algorithmus dokumentieren (Release-LUT ist schon da).
- [ ] **P3-6 Schutz der Algorithmenkerne:** TEE/geschützter Speicher im Browser/Node als **nicht sinnvoll** markieren; stattdessen Build-/Bundle-Schutz und Objekt-Code-Review prüfen.

**Vision (in `VISIONS_TODO.md` überführt):** Universal-Steckmodul-Hub, parallele LVDS-Clock-Verteilung + Feedback-Clock, Auto-Codegenerierung (Matlab/Simulink), Edge-AI-NPUs, software-definierte Analogsignale, selbstlernende Routing-Vorschläge.

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
- [x] Echtbild-UI mit Touch (spielbares Instrumentenbild, GarageBand-artig) je Instrument → umgesetzt 2026-09-03: `src/components/instrument/GarageBandInstrumentView.tsx` (10 Instrumenten-Kacheln mit `public/`-Bildern: Schlagzeug, Gitarre, Bass, Klavier, Cello, Streicher, Pads, Glocken, Drum-Machine, Pad-Sequenzer; Spielfläche mit Tasten-/Saiten-/Drum-Zonen, Pointer-Touch, Pressed-States, Audio-Preview), integriert als Spielansicht „ECHTBILD“ im InstrumentsTerminal; `tests/garageBandView.test.tsx` (3) grün → TASKDONE.

### NEW-MONK-6 biblioMONK – Semantik & Auto-Save

- [x] Server-seitige semantische Suche (Embeddings/Supabase) → umgesetzt 2026-09-03: `POST /api/library/search` mit **Supabase-Embedding-Pfad** (`embedText()` 256-dim + `aiPersistence.rpcMatchSamples()` → `match_samples`-RPC, Migration 005 `sample_embeddings` + pgvector-HNSW) und Keyword-Fallback; Tests `textEmbedding.test.ts` (4) + `aiPersistence.test.ts` (RPC) + `aiRoutes.test.ts` grün → TASKDONE. **Auto-Save neu erzeugter Audio/Stems/Presets in die Library → 2026-09-04 verifiziert:** Recorder-Takes und Stem-Extractor-Ergebnisse speichern bereits automatisch über `SampleContext.addSample` in die Library; Presets bleiben Session-/Scratchpad-Objekte → TASKDONE.
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

- [x] `mixerMONK` (MischpultTerminal) im Stil Pioneer DJM-A9 / Allen & Heath XONE; farbliche Kanal-Accents, Fader/Knobs wie Hardware → Skin-System `hw-skin-mixer` (Panel-Textur + Accent-Fader/Knobs via `--monk-accent`) umgesetzt 2026-09-03 → TASKDONE.
- [x] `synthesizerMONK` (MiniMoog/Prophet/Juno), `drumMONK` (TR-808/Dirtywave M8), `eqMONK` (API/SSL), `masteringMONK` (TC/Massey), `spatialMONK` (3D-Panner) → Skin-Klassen `hw-skin-synthesizer/drum/eq/mastering/spatial` umgesetzt 2026-09-03 → TASKDONE.
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
- [x] **Prüfpunkt (Browser-Live):** Speichern/Laden überlebt Reload; DnD funktioniert; Clipboard-Roundtrip (Copy → Paste) liefert gültiges JSON → Helper-Tests grün (`tests/sessionScratchpad.test.ts`); Browser-Verifikation 2026-09-04 automatisiert: `tests/e2e/scratchpad.spec.ts` grün (Reload, DnD beide Richtungen, Clipboard-Read/Paste → gültiges JSON) → TASKDONE.

### P1-5 Lieder-Datenbank automatisch sortieren

- [x] Sortier-/Gruppierungs-Test (`tests/musicLibrarySorted.test.ts`) → TASKDONE.

### P1-6 Key-/MIDI-Handling optimieren

- [x] MIDI: F8-Clock, Start/Stop/Continue, Song Position, SysEx-Empfang, RPN-Parser, `send()` für LEDs/Motorfader → Codec (`src/core/hardware/midiCodec.ts`) inkl. Tests deckt alles ab; `midiOut.ts` sendet Pitch-Bend/CC für Motorfader/LEDs; Hardware-Verdrahtung bleibt Live-Check.
- [x] **Prüfpunkt (automatisiert):** Keyboard-E2E + MIDI-Codec-Tests grün; kein Hotkey bricht Eingabefelder → Keyboard-E2E live 2/2, `tests/midiCodec.test.ts` grün; Hotkey-Input-Guard in `App.tsx`.
- [x] **Prüfpunkt (Live):** Keyboard-E2E (Space, Ctrl/Cmd+1..9, Escape) – kein Hotkey bricht Eingabefelder; MIDI-Codec-Tests grün (Unit-Suite läuft lokal). → automatisiert 2026-09-04: `tests/e2e/keyboard.spec.ts` erweitert (Space togglet Transport, Ctrl+1 togglet Plugin, Space im Input tippt Leerzeichen statt Play, Escape-Fokus-Falle) – Suite 5/5 grün → TASKDONE.

---

## 🟡 P2 – MITTEL: Latenz, Qualität, Clock, Signalfluss

### P2-1 Latenz & Audio-Qualität

- [x] `AudioSettings`-Optionen wirklich anwenden: `latencyHint`, Sample-Rate, Puffergröße beim Context-Aufbau (`audioContextFactory`) → `resolveAudioContextOptions`/`createConfiguredAudioContext` + `applyLatencyProfile` (TASKDONE).
- [x] Lookahead von 25 ms auf adaptiven Wert (8–15 ms) senken; Scheduling zunehmend über `clockProcessor`/Worklet statt `setTimeout`.
- [x] End-to-End-Latenz persistieren und im `PerformanceMonitorTerminal` anzeigen (bestehende Telemetrie nutzen); Ziel lokal < 15 ms, Netz < 50 ms → Anzeige LOCAL/NET(RTT)/DROPOUTS im Terminal; Persistenz via 30s-Telemetrie in `App.tsx`.
- [x] Qualität: Resampling-Strategie geprüft + dokumentiert in `docs/DSP_BENCHMARKS.md` (Browser-SRC unsichtbar, RBJ-Biquads + Denormal-Guards, Worklet-Rampen statisch auditiert, 2×-Oversampling nur nach Messung) → TASKDONE (2026-09-03).
- [ ] **Prüfpunkt (Live):** Latenz-Messung vorher/nachher; `goldenAudio`-Tests ohne Artefakte; Dropout-Zähler bleibt 0 im Normalbetrieb.
- [ ] **Prüfpunkt (Live):** Lokale Roundtrip-Latenz < 15 ms (Ziel < 1 ms Audio-Thread p99.99); Netz-Latenz < 50 ms one-way; 0 Xruns/Dropouts im Normallauf.

### P2-2 Clock prüfen & synchronisieren

- [x] `clockProcessor`, `ClockSync`, `PhaseLockedLoop` auditen; eine einzige Timing-Quelle festlegen (Worklet-Clock) → `masterClock.attach(audioEngine)` in `audioEngine.init()`, `getClockDiagnostics()`, Audit-Modul `src/core/clock/clockAudit.ts` + Tests `tests/clockAudit.test.ts`.
- [x] BPM-Wechsel sample-genau; 16/32-Step-Wechsel ohne Timing-Sprung → umgesetzt: `clockProcessor` Phasen-Akkumulator + a-rate-`bpm`, `audioEngine.setBpm` per `setValueAtTime`, `tests/clockProcessorWorklet.test.ts` → TASKDONE (2026-09-03).
- [x] Multi-User-Clock-Sync: Host-Clock wird an Gäste verteilt, Drift- Kompensation (PLL) → umgesetzt: `App.tsx` CLOCK_SYNC + CRDT-Merger, `PhaseLockedLoop`/`MonastryMasterClock.handleClockPong`, Tests in `tests/clock.test.ts` → TASKDONE (2026-09-03). Live-2-Browser-Jitter bleibt separater Prüfpunkt.
- [ ] **Prüfpunkt (Live):** 120 BPM, 10 min Lauf: Jitter < 1 ms; zwei Browser starten gleichzeitig und bleiben < 5 ms zueinander.

### P2-3 2.1-Ausgabe für Main

- [x] `stereoMode='2.1'`: Master → Crossover (Sub < 80–120 Hz, L/R High-Pass); Sub auf dritten Kanal, falls Gerät 2.1 unterstützt; sonst Sub phantom in L/R mischen (Fallback) → umgesetzt: `src/core/output/crossover.ts` (`Stereo21Crossover`), `audioEngine.setStereoMode` + Live-Routing, `tests/crossover.test.ts` → TASKDONE (2026-09-03).
- [x] Routing in `audioEngine`/`OutputConfig` erweitern; UI-Anzeige im Settings → umgesetzt: `OutputConfig.designLinkwitzRileyCrossover`/`hasDedicatedSub`, `audioEngine.setStereoMode`, Settings-Select „2.1-Crossover“ → TASKDONE (2026-09-03).
- [x] **Neu (D10):** Ausgabe-Layouts **2.0 / 2.1 / 2.2 / 3.0 / 3.1 / 3.2 / 4.0 / 4.1 / 4.2** unterstützen; Xonar U7 (8 Kanäle, Verstärker max. 6) → **reale 2.1 als Standard** hinterlegen → Layouts in `OutputConfig`/`OUTPUT_LAYOUTS`, 2.1 als wählbarer Standard im Settings → TASKDONE (2026-09-03). (>4.2: `SPECIAL_TODO.md`.)
- [ ] **Prüfpunkt (Live):** Frequenzanalyse: Sub-Kanal enthält < 120 Hz, L/R enthält keine volle Bass-Einbuße; Testton 40 Hz auf Sub, 1 kHz auf L/R.
- [ ] **Prüfpunkt (Live):** 2.1-Layout: Sub < 80 Hz auf drittem Kanal oder Phantom-Fallback; Output-Layouts 2.0/2.1/2.2/3.x/4.x konfigurierbar. (12.x/18.x/24.x: siehe `SPECIAL_TODO.md`.)

### P2-4 Signalfluss-/Pipeline-Audit

- [x] `routing.json` gegen echten Audio-Graph validieren (Test: `audioEngine.exportGraphState()` vs. `routing.json`).
- [x] Falschverkabelungen korrigieren (z. B. `bassFilter`/`channel7`-Pfad, `effectNode`-Insert, Monitor-PDC) → `effectNode` wird jetzt in `init()` erzeugt und als fester Insert zwischen `toneShiftTilt` und `eqNode` verdrahtet (`isEffectInsertReady()`); `bassFilter`→`channel7` (Bass-Kette) und Monitor-PDC (paralleler Cue mit Delay) als korrekt verifiziert.
- [x] Bottlenecks: Main-Thread-Scheduler, Tone.js-Node-Anzahl, Worklet-CPU; wo sinnvoll V2-Graph/Worklet-Pfad verwenden → V2-Hybrid (`V2StudioGraph`, NEW-D4-1) vorhanden; Graph-Validierungs-Tests erweitert (`tests/routingValidator.test.ts`: fehlende Nodes/Verbindungen, doppelte Pfade).
- [x] **Prüfpunkt (automatisiert):** Graph-Validierung grün; kein ungenutzter/doppelter Verbindungs-Pfad → `validateRoutingAgainstGraph` + neues `findUnusedGraphPaths` (ungenutzte Nodes, unbekannte Endpunkte, doppelte Kanten) in `src/core/routing/validateRouting.ts`, Tests `tests/routingValidator.test.ts` → TASKDONE.
- [x] **Prüfpunkt (Live):** Performance-Messung zeigt < 70 % CPU. → automatisiert 2026-09-04: `tests/e2e/performance.spec.ts` (CDP-TaskDuration unter Studio-Last: **20,6 % CPU**) → TASKDONE.

### P2-5 Performance & Rendering

- [x] `React.memo`/stabile Handler für alle Terminals prüfen (UI-Audit nachziehen); Bundle-Diät (lucide tree-shaken, Tone-Chunks) → letzte Lücke `DropTerminal.tsx` geschlossen, `npm run check:memo` grün und als CI-Gate in `.github/workflows/build.yml` verdrahtet → TASKDONE.
- [x] Worklet-CPU-Budgets im PerformanceMonitor → umgesetzt: `Telemetry.recordWorkletCpu` + perfMONK-Anzeige „WORKLET CPU BUDGETS“ (2026-09-03). „Unter 4-User-Last keine Dropouts“ bleibt Live-Check.
- [x] **Prüfpunkt (automatisiert):** Playwright-Stress-Test grün; Bundle < 1,5 MB JS → Stress-Test grün (`npm run test:stress`); Bundle-Diät umgesetzt (zod + axios aus dem Client entfernt, Prompts kompaktiert) → **< 1,5 MB erreicht ✅** (`check:bundle` grün).
- [x] **Prüfpunkt (Live):** Playwright-Stress-Test grün; Bundle < 1,5 MB JS → 2026-09-04 lokal verifiziert: `test:stress` grün, Bundle **1,38 MB** (`check:bundle` ✅, keine Warnung mehr) → TASKDONE.

---

## 🔵 P3 – STRATEGISCH: KI/MOA/MCP, Prompt-DB, Evaluierung

### P3-1 Datenbank-Migration 002: Systemprompts & Evaluierung

- [x] Migration 002 idempotent + CRUD-Tests grün (`tests/migrations.test.ts`, `tests/supabaseRls.test.ts`) → TASKDONE.
- [x] **Prüfpunkt (Betreiber-Schritt):** Daten in Supabase sichtbar (Migrationen 001–004 in `database/` + `supabase/migrations/`; `aiPersistence` schreibt `system_prompts`/`plugin_prompt_versions`/`ai_evaluations`/`ai_eval_runs`, Seeds via `iterate:prompts`/`eval:ai`) → laut Nutzer erledigt 2026-09-03, Tests grün → TASKDONE.
- [x] **Prüfpunkt (Betreiber-Schritt):** Supabase RLS geprüft → `supabase/migrations/003_ai_policies.sql`: `system_prompts`/`plugin_prompt_versions` = anon read + service_role write; `ai_evaluations`/`ai_eval_runs`/`ai_migrations` = **bewusst strenger: nur service_role** (input/output sensibel, dokumentiert im Sicherheitshinweis); `tests/supabaseRls.test.ts` grün → TASKDONE (2026-09-03).

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
- [x] **AM-E3-4** Netzwerk-Jitter-Kompensation: SFU/WebRTC-Pfad um adaptiven Jitter-Buffer erweitern (aktuell nur Opus + Standard-JitterBuffer); QoS-Tagging für Audio-Pakete dokumentieren → umgesetzt 2026-09-03: `WebRTCManager.setJitterBufferTarget` (Default 50 ms, geclampt 10–200 ms, auf allen Receivern) + QoS-/Jitter-Doku in `docs/PERFORMANCE_AUDIT.md` → TASKDONE.
- [x] **AM-E3-5** Prioritäts-Inversion: `WebRTCManager`-DataChannel-State-Sync (~60 Hz) darf den Audio-Thread nicht blockieren; Messung `audioEngine.getAudioHealth()` während State-Bursts.
- [ ] **Prüfpunkt (Live):** 4 Browser sehen identischen State.
- [ ] **Prüfpunkt (Live):** Gäste hören Main via Host-Stream; Cue separat.
- [ ] **Prüfpunkt (Live):** Rollenwechsel ohne Audio-Unterbrechung.

### Ebene 4 – High-Quality DSP-Kernel

- [x] **AM-E4-1** Sample-Raten-Konvertierung → spezifiziert in `docs/PERFORMANCE_AUDIT.md` (Polyphase-FIR 64/32 für 44.1↔48 kHz, Farrow-Fallback, Roundtrip-Regression < −100 dB/< 1 ms) → TASKDONE (2026-09-03). Implementierung mit nativem Runtime-Build.
- [x] **AM-E4-2** FFT/iFFT → evaluiert + dokumentiert in `docs/DSP_BENCHMARKS.md` (Radix-2/4 + Twiddle-Tables, Mixed-Radix, Bluestein als letzter Ausweg) → TASKDONE (2026-09-03).
- [x] **AM-E4-3** Biquad-Stabilität: `dspProcessor.setLowpass()` (TF2/DF1-Mischung) auf Koeffizienten-Sprung bei `freq=0`/`freq=sampleRate/2` prüfen; Denormal- Guards für `filterZ`; einheitliche DF1-Implementierung → `src/audio/dsp/biquad.ts` (stabile Lowpass-Koeffizienten an den Rändern) + Tests (TASKDONE).
- [x] **AM-E4-6** Oversampling → evaluiert + dokumentiert in `docs/DSP_BENCHMARKS.md` (Half-Band-FIR 2×, Entscheidung nach Benchmark) → TASKDONE (2026-09-03).
- [x] **AM-E4-7** SIMD/NEON/AVX → vorbereitet + dokumentiert in `docs/PERFORMANCE_AUDIT.md` (Rust `std::simd`/`wide`, Feature-Gates SSE2/AVX2/NEON; JS-Worklets 128er-Blöcke) → TASKDONE (2026-09-03).

### Ebene 5 – Sandbox-Simulation & Stress-Testing

- [x] **AM-E5-1** `tests/e2e/stress.spec.ts` erweitern: 256 simulierte Plugin-Instanzen (UI-State + Worklet-Budget) unter 95 % CPU-Last messen (Ziel: < 80 % CPU, 0 Xruns) → Stress-Test (21 Plugins, 8000 Pattern-Loads, Play/Stop-Zyklen, FPS/Heap-Messung) läuft grün (`npm run test:stress`); CPU-/Xrun-Messung bleibt Live.
- [x] **AM-E5-2** Memory-Pressure-Test → Heap-Wachstums-Gate umgesetzt: `scripts/memory-pressure-gate.mjs` (< 512 MB Delta, gemessen ~0,05 MB), `npm run check:memory` + Nightly-CI → TASKDONE (2026-09-03). Volle 2-GB-OOM-Simulation bleibt offen.
- [x] **AM-E5-3** Race-Condition-Fuzzing: `PluginManagerContext`, `LockManager`, `stateReplication` mit Thread-Interleaving-Explosion testen (Property-Based / Vitest-Injection) → `tests/lockFuzz.test.ts` (LockManager 4 User × 1000 Ops, Invariante genau ein aktiver Besitzer).
- [x] **AM-E5-4** Real-Time-Deadline-Test: CI-Langtest (Nightly) angestoßen → neuer Job `stress-longtest` in `.github/workflows/nightly.yml` (Playwright Chromium + `npm run test:stress`). Der 24-h-/4-User-Dropout-Lauf (0 Xruns) bleibt Live-Check → TASKDONE (2026-09-03).
- [x] **AM-E5-6** Cross-Platform-Divergenz: dokumentiert in `docs/PERFORMANCE_AUDIT.md` (Chromium/Firefox via Playwright-Suiten, iOS/Android via Responsive-Emulation; echte WebKit/iOS-Audio-Thread-Unterschiede bleiben Live-Check) → TASKDONE (2026-09-03).
- [ ] **Prüfpunkt (Live):** 0 Xruns/Dropouts im Normallauf.

### Ebene 6 – Lebendige Selbstevolution

- [x] **AM-E6-1** Kontinuierliches Profiling → umgesetzt: `Telemetry.recordXrun/recordWorkletCpu/recordWorkletAllocation`, perfMONK-UI (XRUNS + WORKLET CPU BUDGETS/ALLOCATIONEN), `/api/metrics` (JSON+Prometheus), `tests/telemetryXrun.test.ts` → TASKDONE (2026-09-03).
- [x] **AM-E6-2** Adaptive Puffergrößen → umgesetzt: `src/utils/adaptiveLatency.ts` (Eskalation alle 3 Xruns, Lookahead 8–15 ms, stabile Fenster), verdrahtet in `audioEngine` + MasterClock-Watchdog, `tests/adaptiveLatency.test.ts` → TASKDONE (2026-09-03).
- [x] **AM-E6-4** Selbstlernende Parameter-Vorhersage → umgesetzt: `src/core/ai/parameterPrediction.ts` (Rezenz-gewichtetes Ranking, Konfidenz), `moaHistory.suggest()`, `tests/parameterPrediction.test.ts` → TASKDONE (2026-09-03).
- [x] **AM-E6-5** Energie-Optimierung → umgesetzt: `src/utils/idleDetection.ts` + AudioEngine-Wiring (Idle → `ctx.suspend()`, Aktivität → `ctx.resume()`), `tests/idleDetection.test.ts` → TASKDONE (2026-09-03). Display-Sleep iOS/Android bleibt Live-Check.
- [x] **AM-E6-6** A/B-Validierung → Verfahren in `docs/PERFORMANCE_AUDIT.md` dokumentiert, Nightly-Golden-Gate-Kommentar in `nightly.yml`, `goldenAudio.test.ts` grün → TASKDONE (2026-09-03).

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
- [x] **Warm-Keep-Option:** dokumentiert in `docs/AI_OPERATIONS.md` (`AI_WARM_KEEP=true`, Standard aus wegen Scale-to-Zero-Kosten; Umsetzung im `SessionManager`-Heartbeat) → TASKDONE (2026-09-03).
- [ ] **INT8-Kalibrierung (Live):** Je Modell vorab messen (aus AITodo OPTIONAL OPTIMIZATIONS).
- [x] **Modell-Splitting:** dokumentiert in `docs/AI_OPERATIONS.md` (erst bei dauerhaft >90 % A100-Last + Freigabe; Kostenregel max. 1 GPU-Endpoint bewusst erweitern) → TASKDONE (2026-09-03).

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

- [x] **[AUDIO][SYNTH] Granular-Engine als neuer Synthese-Modus** (Referenz: Actuate; MONK hat bislang nur „Glitch Granulator" als LFO-Chop, keinen echten Grain-Scheduler) → **produktionsreif umgesetzt 2026-09-03:** deterministischer Grain-Scheduler + Render (`src/core/instrument/granularEngine.ts`, Hann-Fenster, Position/Pitch/Jitter/Direction/Freeze), Echtzeit-Worklet `src/audio/worklets/granularProcessor.ts` (64-Slot-Pool, Fenster-LUT, keine Allocs im Hot-Path, SAB-Source) + Manifest-Eintrag; Tests `tests/granularEngine.test.ts` (5) + `tests/granularProcessorWorklet.test.ts` (2) grün → TASKDONE. UI + Engine-Wiring umgesetzt 2026-09-03: `audioEngine.loadGranularSource/setGranularParams/isGranularReady` (Worklet auf GLOBAL_MASTER) + SynthesizerTerminal-UI (Grain/Density/Pitch/Freeze, Source-Load) → TASKDONE.
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

- [x] **[SAMPLER] SFZ-Parsing + Streaming für samplerMONK/mcpMONK/dropMONK** → umgesetzt 2026-09-03: Parser (`sfzParser.ts`), **Voice-Management** (`sfzVoice.ts`: 16 Voices, LRU-Stealing, Loop-Playback, AD-Hüllkurve, Note-Off) + `audioEngine.loadSfzInstrument/sfzNoteOn/sfzNoteOff`; Tests `sfzParser.test.ts` (4) + `sfzVoice.test.ts` (3) grün → TASKDONE. **OPFS-chunked Decode/Streaming → 2026-09-04 umgesetzt:** `src/core/sampler/sfzStreaming.ts` (`planChunkRanges` + `SfzSampleCache` 64-MB-LRU), an `audioEngine` verdrahtet (`cacheSfzSample`/`getCachedSfzSample`/`planSfzChunks`), Tests `sfzStreaming.test.ts` (4) → TASKDONE.
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

- [x] **[SYNTH][MIDI] 6-Operator-FM + DX7-SysEx-Import** (Referenz: Dexed; MONK-FM ist aktuell 2-Op mit `modIndex`) → **produktionsreif umgesetzt 2026-09-03:** 6-Op-FM-Engine mit 32 Algorithmen (`src/core/instrument/fmEngine.ts` + `dx7Algorithms.ts`, DX7-Hüllkurven R1–R4/L1–L4, Feedback, Detune, Velocity-/Key-Scaling, LFO), DX7-SysEx-Import/Export (`src/core/instrument/dx7Sysex.ts`, 156-Byte-unpacked, Roundtrip) und 10 Referenz-Patches (`dx7Presets.ts`); Tests `tests/fmEngine.test.ts` (6) + `tests/dx7Sysex.test.ts` (4) grün → TASKDONE. Worklet + Engine + UI umgesetzt 2026-09-03: `fm6Processor` (16 Voices, `Fm6Synth`-Block-Engine) + Manifest, `audioEngine.setFm6Patch/loadFm6Sysex/fm6NoteOn/fm6NoteOff/setFm6Gain` (Worklet auf GLOBAL_MASTER), SynthesizerTerminal-UI (Patch-Auswahl + Note-Preview) → TASKDONE. MIDIControllerTerminal-SysEx-Drop bleibt optionaler Folgeschritt.
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

- [x] **[SYNTH] Wavetable-Oszillatoren + Mod-Matrix** (Referenz: Surge XT) → umgesetzt 2026-09-03: `src/core/instrument/wavetable.ts` (bandlimitierte additive Tabellen, Mip-Maps, Morphing `sampleWavetable`) + `synthProcessor`-Waveform `osc:'wavetable'` (Mip-Wahl nach Tonhöhe); `tests/instrumentCores.test.ts` → TASKDONE. Mod-Matrix-Konzept separat dokumentiert.

- [x] **[SYNTH] Tonewheel-Orgel + Leslie-Simulation** (Referenz: setBfree, Open B3) → umgesetzt 2026-09-03: `src/core/instrument/tonewheel.ts` (9-Drawbar-Additiv-Tabelle + `LeslieSim` mit Slow/Fast-Rampe, AM+Doppler-FM) + `synthProcessor`-Waveform `osc:'tonewheel'`; `tests/instrumentCores.test.ts` → TASKDONE.

- [x] **[SYNTH] Physical-Modeling E-Piano (Rhodes/Wurlitzer)** → umgesetzt 2026-09-03: `src/core/instrument/epiano.ts` (inharmonische Partialschwingungen + Hammer-Noise-Transient, deterministisch) + Tests → TASKDONE.

- [x] **[DRUMS] Drum-Synthese mit Transient-Shaping + Song-Mode/Humanize** → umgesetzt 2026-09-03: `src/core/instrument/drumSynth.ts` (Kick/Snare/Hat mit Pitch-/Amp-Hüllkurven, Noise-Layer, Click, Soft-Clipper + deterministischer `humanize()`-Jitter) + Tests → TASKDONE.

- [x] **[SAMPLER][LIBRARY] Orchestrale CC0-Library – Metadaten-Katalog** umgesetzt 2026-09-03: `src/data/orchestralLibrary.ts` (12 VSCO-2-CE-Einträge Strings/Brass/Woodwinds mit CC0-Tags + `orchestralSamples()`-Konverter) + `tests/orchestralLibrary.test.ts` grün → TASKDONE. **Audio-Download → 2026-09-04 umgesetzt:** `npm run download:orchestral` (streaming, >2-GiB-fähig) lädt VSCO 2 CE (CC0) und entpackt **3249 Dateien** nach `public/data/orchestral/` (gitignored) → TASKDONE.

- [x] **[SYNTH] Phase-Distortion-Oszillator** (Referenz: Nakst Regency) → umgesetzt 2026-09-03: `src/core/instrument/phaseDistortion.ts` (piecewise-lineares Casio-CZ-Reshaping, amount-geclampt) + `synthProcessor`-Waveform `osc: 'pd'`; `tests/phaseDistortion.test.ts` (3) grün → TASKDONE.

- [x] **[SAMPLER] EXS24/SF2/WAV-ROM-Import-Konzept** → dokumentiert 2026-09-03 in `docs/DSP_BENCHMARKS.md` (Parser als Worker-Task nach SFZ-Muster, kein ROMPlayer-Code) → TASKDONE.

### C – Architektur-Referenzen (P2/P3, keine Integration)

- [x] **[DSP][SPATIAL] Reverb-Verbesserung: Early-Reflections + Modulationsparameter** → umgesetzt 2026-09-03: `src/core/instrument/earlyReflections.ts` (4-Tap-Early-Reflections mit Damping + Feedback, deterministische Impulsantwort) + Tests → TASKDONE. Worklet-Integration in `effectProcessor` bleibt optionaler Folgeschritt.

- [x] **[SYNTH] Spektrale Additiv-Steuerung** → umgesetzt 2026-09-03: `src/core/instrument/earlyReflections.ts` (`renderAdditiveMorph`: Partial-Morphing zwischen Harmonik-Sets mit spektraler Hüllkurve) + Tests → TASKDONE.

- [x] **[ARCHITECTURE] Mod-Matrix-/CV-Gate-Konzepte geprüft** → dokumentiert 2026-09-03 in `docs/DSP_BENCHMARKS.md` (interne Mod-Matrix als `ModuleState`-Routing, KEIN Modul-Host/GPL) → TASKDONE.

- [x] **[SYNTH] Analoge Filter-/Oszillator-Referenzen** → dokumentiert 2026-09-03 in `docs/DSP_BENCHMARKS.md` (Drift/Sättigung als native Koeffizienten-Variation, Biquad-Stabilität via `src/audio/dsp/biquad.ts`) → TASKDONE.

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

- [ ] **DA-2026-09-04-001 · MEDIUM · @typescript-eslint/no-unused-vars** – `build-worklets.mjs:4` (eslint)
  - 'copyFile' is defined but never used.
- [ ] **DA-2026-09-04-002 · MEDIUM · Verwundbarkeit: body-parser** – `package-lock.json` (npm-audit)
  - qs
  - Vorschlag: npm audit fix ausführen
- [ ] **DA-2026-09-04-003 · MEDIUM · @typescript-eslint/no-unused-vars** – `scripts/check-react-memo.mjs:6` (eslint)
  - 'existsSync' is defined but never used.
- [ ] **DA-2026-09-04-004 · MEDIUM · @typescript-eslint/no-unused-vars** – `scripts/download-orchestral.mjs:17` (eslint)
  - 'createReadStream' is defined but never used.
- [ ] **DA-2026-09-04-005 · MEDIUM · prefer-const** – `scripts/dsp-benchmark.ts:67` (eslint)
  - 'b0' is never reassigned. Use 'const' instead.
- [ ] **DA-2026-09-04-006 · MEDIUM · @typescript-eslint/no-unused-vars** – `scripts/hetzner/sfu-rtp-multi-run.mjs:66` (eslint)
  - 'context' is assigned a value but never used.
- [ ] **DA-2026-09-04-007 · MEDIUM · @typescript-eslint/no-unused-vars** – `scripts/hetzner/sfu-rtp-multi-run.mjs:84` (eslint)
  - 'page' is assigned a value but never used.
- [ ] **DA-2026-09-04-008 · MEDIUM · @typescript-eslint/no-unused-vars** – `scripts/hetzner/sfu-rtp-multi-run.mjs:101` (eslint)
  - 'page' is assigned a value but never used.
- [ ] **DA-2026-09-04-009 · MEDIUM · @typescript-eslint/no-unused-vars** – `scripts/hetzner/stress-test.mjs:76` (eslint)
  - 'id' is defined but never used.
- [ ] **DA-2026-09-04-010 · MEDIUM · @typescript-eslint/no-unused-vars** – `scripts/wake-on-login/worker.js:147` (eslint)
  - 'e' is defined but never used.
- [ ] **DA-2026-09-04-011 · MEDIUM · @typescript-eslint/no-unused-vars** – `scripts/wake-on-login/worker.js:167` (eslint)
  - 'e' is defined but never used.
- [x] **DA-2026-09-04-012 · HIGH · Ungeprüfte Socket.io-Verbindungsziele** → gefixt 2026-09-04 – `server.ts:104` (hf-qwen)
  - Die fleetTargets werden dynamisch aus einer externen API geladen, ohne Validierung oder Sanitization. Dies könnte zu SSRF oder unerwünschten Zieladressen führen.
  - Vorschlag: Validiere und sanitze die IPs aus der Fleet-Map vor dem Zuweisen an fleetTargets. Verwende z.B. dns.lookup() oder IP-Regex-Validierung.
- [x] **DA-2026-09-04-013 · MEDIUM · Potenzielle Fehlerlecks an Client** → gefixt 2026-09-04 – `server.ts:170` (hf-qwen)
  - Bei Fehlern in /api/cloud/sync wird die volle Fehlermeldung an den Client geleakt, was potenziell sensible Informationen enthält.
  - Vorschlag: Verwende eine allgemeine Fehlermeldung für den Client und logge die vollständige Fehlermeldung nur serverseitig.
- [x] **DA-2026-09-04-014 · MEDIUM · Potenzielle Fehlerlecks an Client** → gefixt 2026-09-04 – `server.ts:200` (hf-qwen)
  - Bei Fehlern in /api/cloud/samples wird die volle Fehlermeldung an den Client geleakt.
  - Vorschlag: Verwende eine allgemeine Fehlermeldung für den Client und logge die vollständige Fehlermeldung nur serverseitig.
- [x] **DA-2026-09-04-015 · MEDIUM · Potenzielle Fehlerlecks an Client** → gefixt 2026-09-04 – `server.ts:217` (hf-qwen)
  - Bei Fehlern in /api/cloud/music wird die volle Fehlermeldung an den Client geleakt.
  - Vorschlag: Verwende eine allgemeine Fehlermeldung für den Client und logge die vollständige Fehlermeldung nur serverseitig.
- [x] **DA-2026-09-04-016 · MEDIUM · Potenzielle Fehlerlecks an Client** → gefixt 2026-09-04 – `server.ts:240` (hf-qwen)
  - Bei Fehlern in /api/cloud/upload wird die volle Fehlermeldung an den Client geleakt.
  - Vorschlag: Verwende eine allgemeine Fehlermeldung für den Client und logge die vollständige Fehlermeldung nur serverseitig.
- [x] **DA-2026-09-04-017 · HIGH · Unvalidierte Socket.io-Verbindungsziele** → gefixt 2026-09-04 – `server.ts:400` (hf-qwen)
  - Die getMasterPlayerUrl Funktion verwendet dynamisch geladene Fleet-Ziele ohne Validierung, was zu SSRF führen könnte.
  - Vorschlag: Validiere die URL aus fleetTargets vor dem Verwenden. Verwende z.B. URL-Konstruktor mit Validierung.
- [x] **DA-2026-09-04-018 · HIGH · Unvalidierte Socket.io-Verbindungsziele** → gefixt 2026-09-04 – `server.ts:408` (hf-qwen)
  - Die getStemAiUrl Funktion verwendet dynamisch geladene Fleet-Ziele ohne Validierung, was zu SSRF führen könnte.
  - Vorschlag: Validiere die URL aus fleetTargets vor dem Verwenden. Verwende z.B. URL-Konstruktor mit Validierung.
- [ ] **DA-2026-09-04-019 · MEDIUM · Race Condition in Stem-Job-Management** – `server.ts:430` (hf-qwen)
  - Die stemActiveJobs Variable wird inkrementiert und dekrementiert, aber es gibt keine Mutex- oder Lock-Mechanismus, was zu Race Conditions führen kann.
  - Vorschlag: Verwende eine atomare Operation oder einen Mutex für den Zugriff auf stemActiveJobs, um Race Conditions zu verhindern.
- [ ] **DA-2026-09-04-020 · MEDIUM · Potenzieller Zustandsverlust bei Stem-Jobs** – `server.ts:440` (hf-qwen)
  - Die stemJobStatus Map wird nicht synchronisiert, was zu Zustandsverlusten führen kann, wenn Jobs parallel verarbeitet werden.
  - Vorschlag: Verwende eine synchronisierte Datenstruktur oder einen Lock-Mechanismus für den Zugriff auf stemJobStatus.
- [ ] **DA-2026-09-04-021 · MEDIUM · Unvollständige Fehlerbehandlung in parseMultipartStream** – `server.ts:470` (hf-qwen)
  - Die parseMultipartStream Funktion kann nicht sicherstellen, dass alle Streams korrekt geschlossen werden, was zu Speicherlecks führen kann.
  - Vorschlag: Stelle sicher, dass alle Streams korrekt geschlossen werden und Speicher freigegeben wird, auch bei Fehlern.
- [ ] **DA-2026-09-04-022 · MEDIUM · @typescript-eslint/no-require-imports** – `server.ts:1422` (eslint)
  - A `require()` style import is forbidden.
- [x] **DA-2026-09-04-023 · HIGH · Potenzielle Fehlerlecks an Client** → gefixt 2026-09-04 – `server/cloud.ts:105` (hf-qwen)
  - Die Funktion `pushSampleToCloud` gibt direkte Supabase-Fehlermeldungen an den Client weiter, was zu potenziellen Informationsschutzverletzungen führen kann.
  - Vorschlag: Entferne sensible technische Details aus Fehlern, die an den Client gesendet werden. Verwende stattdessen generische Fehlermeldungen und logge die detaillierten Fehler serverseitig.
- [x] **DA-2026-09-04-024 · HIGH · Potenzielle Fehlerlecks an Client** → gefixt 2026-09-04 – `server/cloud.ts:126` (hf-qwen)
  - Die Funktion `pushMusicTrackToCloud` gibt direkte Supabase-Fehlermeldungen an den Client weiter, was zu potenziellen Informationsschutzverletzungen führen kann.
  - Vorschlag: Entferne sensible technische Details aus Fehlern, die an den Client gesendet werden. Verwende stattdessen generische Fehlermeldungen und logge die detaillierten Fehler serverseitig.
- [x] **DA-2026-09-04-025 · MEDIUM · Mögliche Path Traversal durch unvalidierte Eingaben** → gefixt 2026-09-04 – `server/cloud.ts:155` (hf-qwen)
  - Die Funktion `uploadSampleToR2` verwendet den Parameter `objectKey` direkt ohne Validierung, was zu Path Traversal-Angriffen führen könnte.
  - Vorschlag: Validiere den `objectKey` vor dem Speichern, um sicherzustellen, dass er keine relativen Pfade oder Sonderzeichen enthält, die zu Path Traversal führen könnten.
- [ ] **DA-2026-09-04-026 · MEDIUM · Unzureichende Validierung von Umgebungsvariablen** – `server/cloud.ts:159` (hf-qwen)
  - Die Funktion `r2Client()` akzeptiert Umgebungsvariablen ohne ausreichende Prüfung auf Gültigkeit und Sicherheit.
  - Vorschlag: Füge zusätzliche Validierungen hinzu, um sicherzustellen, dass die Umgebungsvariablen korrekt formatiert sind und keine gefährlichen Werte enthalten.
- [x] **DA-2026-09-04-027 · HIGH · Ungeprüfte Benutzereingaben in R2-Keys** → gefixt 2026-09-04 – `server/cloudAutomation.ts:76` (hf-qwen)
  - Die Funktion `analyzeAudioKey` verwendet den Roh-Dateinamen (key) direkt für Kategorisierung, Stil- und Artist-Erkennung ohne vorherige Validierung oder Sanitization. Dies könnte zu unerwartetem Verhalten oder Sicherheitsrisiken führen, wenn Dateinamen manipuliert werden.
  - Vorschlag: Validiere und sanitze den Dateinamen vor der Verwendung in regulären Ausdrücken und Textverarbeitungsschritten. Prüfe z.B. auf gefährliche Sonderzeichen oder Längenbeschränkungen.
- [ ] **DA-2026-09-04-028 · MEDIUM · Möglicher Fehler bei fehlenden Supabase-Konfiguration** – `server/cloudAutomation.ts:104` (hf-qwen)
  - In `ingestAudioObject` wird geprüft, ob `db` existiert, aber es gibt keine explizite Fehlerbehandlung, falls die Supabase-Instanz nicht korrekt initialisiert wurde. Dies kann zu unerwarteten Fehlern führen, wenn die Umgebungsvariablen fehlen.
  - Vorschlag: Füge Logging hinzu, um das Fehlen der Supabase-Konfiguration zu protokollieren, und prüfe, ob die Umgebungsvariablen wirklich leer sind oder nur nicht gesetzt wurden.
- [ ] **DA-2026-09-04-029 · MEDIUM · Potenzielle Race Condition bei Tag-Synchronisation** – `server/cloudAutomation.ts:119` (hf-qwen)
  - In `ingestAudioObject` wird zunächst `sample_tags` gelöscht und dann neu eingefügt. Falls zwischen diesen beiden Operationen ein anderer Prozess auf dieselben Daten zugreift, kann dies zu inkonsistenten Zuständen führen.
  - Vorschlag: Nutze Transaktionen oder eine atomare Operation, um sicherzustellen, dass die Tags-Synchronisation konsistent bleibt.
- [x] **DA-2026-09-04-030 · MEDIUM · routeAudio is an incomplete/no-op skeleton** → gefixt 2026-09-04 – `services/backend-core/node/audio-routing.js:5` (deepseek-pro)
  - The exported function routeAudio only logs a message; the actual native addon call is commented out. Any caller expecting audio routing will silently fail, violating the backend's role as the audio orchestrator if this function is used in a real path.
  - Vorschlag: Implement the native addon integration and call audioCore.process(input, output) after validating inputs, or throw an explicit error when the function is not yet available to avoid silent no-op behavior.
- [x] **DA-2026-09-04-031 · MEDIUM · console.log im vorgesehenen Audio-Routing-Pfad verursacht synchrone I/O** → gefixt 2026-09-04 – `services/backend-core/node/audio-routing.js:6` (deepseek-flash)
  - Die Funktion routeAudio ist als zentrales Audio-Routing konzipiert. Ein console.log bei jedem Aufruf erzeugt synchrone, blockierende I/O, die in einem Echtzeit- oder Ultra-Low-Latency-Pfad zu Verzögerungen und Dropouts führen kann. Zudem wird die Routing-Topologie bei jedem Aufruf in das Log geschrieben.
  - Vorschlag: Logging aus der Routing-Funktion entfernen oder hinter ein asynchrones, gepuffertes Logger-Modul legen, das nur im Debug-Modus aktiv ist. Keine direkten console-Aufrufe in latenzkritischen Funktionen.
- [x] **DA-2026-09-04-032 · HIGH · routeAudio ist eine No-op-Funktion ohne tatsächliches Audio-Routing** → gefixt 2026-09-04 – `services/backend-core/node/audio-routing.js:7` (deepseek-flash)
  - Die Funktion routeAudio protokolliert lediglich die übergebenen Parameter. Die eigentlich native Verarbeitung über audioCore.process ist auskommentiert. Wenn dieser Export im Audio-Routing-Pfad verwendet wird, wird kein Signal geroutet, was zu vollständigem Audioausfall führt. Der Code ist ein offensichtlicher Stub, aber als vollwertige Funktion exportiert.
  - Vorschlag: Entweder die native Audio-Routing-Implementierung aktivieren und korrekt einbinden oder die Funktion als unfertig kennzeichnen und Aufrufer darauf vorbereiten, dass sie noch keine Funktion hat. Im Produktivbetrieb darf kein Aufruf an diesen Stub erfolgen.
- [ ] **DA-2026-09-04-033 · MEDIUM · @typescript-eslint/no-require-imports** – `services/backend-core/node/index.js:1` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-034 · MEDIUM · Race Condition bei Client-Verwaltung** – `services/backend-core/node/index.js:14` (hf-qwen)
  - Es besteht eine Race Condition zwischen dem Setzen des 'userId' und dem Empfang weiterer Nachrichten. Ein Client kann Nachrichten senden, bevor er initialisiert wurde, was zu Fehlern oder inkonsistentem Zustand führen kann.
  - Vorschlag: Verzögere die Verarbeitung von Nicht-'init'-Nachrichten, bis der 'userId' gesetzt wurde, oder implementiere eine Warteschlange für uninitialisierte Clients.
- [x] **DA-2026-09-04-035 · HIGH · Ungeprüfte Benutzereingabe bei WebRTC-Signaling** → gefixt 2026-09-04 – `services/backend-core/node/index.js:27` (hf-qwen)
  - Der Code sendet eingehende WebRTC-Signaling-Nachrichten direkt an einen Empfänger ohne Validierung der 'recipient'-ID. Dies könnte zu einer Nachrichtenweiterleitung an nicht autorisierte Empfänger führen.
  - Vorschlag: Validiere, ob der 'sender' berechtigt ist, eine Nachricht an den 'recipient' zu senden, z.B. durch Prüfung, ob beide User im selben Session-Context sind.
- [x] **DA-2026-09-04-036 · CRITICAL · Fehlende Authentifizierung für 'lock_request'** – `services/backend-core/node/index.js:39` (hf-qwen) → gefixt 2026-09-04
  - Die 'lock_request'-Nachricht wird ohne jegliche Authentifizierung oder Berechtigungsprüfung verarbeitet. Ein beliebiger Client kann Module sperren, was zu Zustandsinkonsistenzen und Sicherheitsproblemen führt.
  - Vorschlag: Füge eine Authentifizierungsprüfung hinzu, z.B. durch Überprüfung, ob der 'userId' berechtigt ist, das Modul zu sperren (z.B. durch Rollen oder Ownership).
- [x] **DA-2026-09-04-037 · CRITICAL · Fehlende Authentifizierung erlaubt Übernahme beliebiger User-IDs** – `services/backend-core/node/index.js:44` (deepseek-pro) → gefixt 2026-09-04
  - Ein Client kann in der init-Nachricht einen beliebigen `data.sender` angeben. `userId` wird blind übernommen und in die `clients`-Map geschrieben. Dadurch kann ein Angreifer die Signalisierung eines anderen Benutzers umleiten, Locks in dessen Namen anfordern oder bestehende Verbindungen kapern. Es erfolgt keine Authentifizierung oder Autorisierung.
  - Vorschlag: Vor dem Setzen von `userId` die Identität per Token/Session authentifizieren und `data.sender` gegen den authentifizierten Benutzer prüfen. Zusätzlich verhindern, dass eine bereits aktive `userId` überschrieben wird.
- [ ] **DA-2026-09-04-038 · MEDIUM · Unbegrenztes Wachstum der clients-Map durch wiederholte init mit verschiedenen userId** – `services/backend-core/node/index.js:45` (deepseek-pro)
  - Ein Client kann mehrfach `init` mit unterschiedlichen `data.sender` senden. Jeder Aufruf fügt einen neuen Schlüssel in die `clients`-Map ein, ohne den vorherigen Eintrag zu entfernen. Da beim Schließen nur der aktuell gespeicherte `userId` gelöscht wird, bleiben alle zuvor registrierten Schlüssel bestehen. Dies führt zu einem Speicherleck und potenziellem Fehlrouting.
  - Vorschlag: Beim erneuten `init` den vorherigen `userId` aus der Map entfernen oder pro Verbindung alle registrierten IDs speichern und beim Schließen bereinigen. Alternativ `init` nur einmal pro Verbindung erlauben.
- [ ] **DA-2026-09-04-039 · MEDIUM · Unvollständige Lock-Cleanup-Logik** – `services/backend-core/node/index.js:47` (hf-qwen)
  - Beim Schließen der Verbindung werden nur Locks entfernt, wenn der Nutzer der Besitzer war. Es gibt keine Prüfung, ob der Nutzer tatsächlich noch verbunden ist, was zu verwaisten Locks führen kann.
  - Vorschlag: Überprüfe zusätzlich, ob der Besitzer noch verbunden ist, bevor du den Lock freigibst, um verwaiste Locks zu verhindern.
- [x] **DA-2026-09-04-040 · HIGH · Signaling-Nachrichten werden mit ungeprüftem Absender weitergeleitet** → gefixt 2026-09-04 – `services/backend-core/node/index.js:51` (deepseek-pro)
  - Die WebRTC-Signalisierungsnachrichten (sdp_offer, sdp_answer, ice_candidate) werden roh an den Empfänger gesendet. Der Absender (`data.sender`) wird nicht verifiziert, sodass ein Angreifer Nachrichten mit gefälschtem Absender an beliebige Empfänger senden kann. Das ermöglicht Session Hijacking oder Man-in-the-Middle-Szenarien.
  - Vorschlag: Die Nachricht serverseitig mit dem authentifizierten `userId` des Senders neu serialisieren und `data.sender` überschreiben oder ignorieren. Vor dem Weiterleiten prüfen, dass `recipient` existiert und der Sender berechtigt ist.
- [x] **DA-2026-09-04-041 · CRITICAL · Unvalidiertes data.payload führt zu TypeError und Server-Absturz (DoS)** – `services/backend-core/node/index.js:59` (deepseek-pro) → gefixt 2026-09-04
  - In Zeile 59 wird `const { moduleId } = data.payload;` ohne vorherige Prüfung von `data.payload` ausgeführt. Ein Client kann eine JSON-Nachricht wie `{"type":"lock_request"}` senden; der JavaScript-Fehler wird nicht vom try/catch um `JSON.parse` abgefangen, da er erst beim Destructuring auftritt. Dies crasht den gesamten Node-Prozess (unbehandelter Fehler im Event-Handler).
  - Vorschlag: Vor dem Destructuring `data.payload` und `moduleId` validieren, z. B. `if (!data.payload || typeof data.payload.moduleId !== 'string') return;` oder den gesamten Handler in try/catch einbetten und Fehler an den Client melden.
- [x] **DA-2026-09-04-042 · HIGH · lock_request vor init setzt null als Owner und blockiert Modul dauerhaft** → gefixt 2026-09-04 – `services/backend-core/node/index.js:61` (deepseek-pro)
  - Ein Client kann eine `lock_request`-Nachricht senden, bevor er eine `init`-Nachricht gesendet hat. `userId` ist dann `null`. Der Code setzt `lockState.set(moduleId, null)`. Da beim späteren Schließen des Clients nur Locks mit `ownerId === userId` bereinigt werden (und `userId` nun ein anderer Wert ist), bleibt dieser Lock dauerhaft bestehen. Das Modul kann danach nie wieder entsperrt werden.
  - Vorschlag: Vor Bearbeitung von `lock_request` prüfen, dass `userId` gesetzt ist (z. B. `if (!userId) return;`). Zusätzlich beim `init` einen Null-Owner-Lock nicht erlauben.
- [x] **DA-2026-09-04-043 · HIGH · Race Condition: Doppelte userId überschreibt Map und close löscht neuen Client** → gefixt 2026-09-04 – `services/backend-core/node/index.js:75` (deepseek-pro)
  - Wenn derselbe Benutzer (oder ein Angreifer) `init` erneut mit derselben `userId` sendet, wird `clients.set(userId, ws)` den vorhandenen Eintrag überschreiben. Schließt die alte Verbindung, wird `clients.delete(userId)` ausgeführt und entfernt damit den Eintrag der neuen Verbindung. Dadurch ist der neue Client nicht mehr erreichbar und State-Desync tritt auf.
  - Vorschlag: Vor dem Überschreiben prüfen, ob `userId` bereits verbunden ist, und ggf. die alte Verbindung schließen oder die neue ablehnen. Beim `close` nur löschen, wenn `clients.get(userId) === ws` ist.
- [x] **DA-2026-09-04-044 · MEDIUM · Production-Startskript verwendet Uvicorn mit --reload** → gefixt 2026-09-04 – `services/backend-core/package.json:7` (deepseek-pro)
  - Das Skript start:python startet den Python-Dienst mit dem Entwicklungs-Flag --reload. In einer Echtzeit-Audio-Architektur mit Ultra-Low-Latency-Mandat verursacht der File-Watcher zusätzliche CPU-/I/O-Last und kann bei Dateiänderungen unerwartete Neustarts und Latenzspitzen auslösen. Zudem wird das Skript über npm start gemeinsam mit dem Node-Prozess gestartet, sodass dieses Verhalten im Standard-S
  - Vorschlag: --reload aus dem Standard-Startskript entfernen und nur in einem expliziten Dev-Skript verwenden, z. B. "start:python:dev". Für Produktionsstarts einen ASGI-Server ohne Reload (z. B. uvicorn main:app --no-reload) oder einen Process-Manager (systemd, PM2, Docker) einsetzen.
- [x] **DA-2026-09-04-045 · HIGH · Unvalidated File Path in Audio Processing** → gefixt 2026-09-04 – `services/backend-core/python/celery_app.py:105` (hf-qwen)
  - The `separate_stems_task` function uses `file_path` directly without validation, which could lead to path traversal vulnerabilities if the input is not properly sanitized.
  - Vorschlag: Validate and sanitize `file_path` to ensure it's within expected directories using `os.path.abspath()` and `os.path.commonpath()` checks.
- [ ] **DA-2026-09-04-046 · MEDIUM · Race Condition in Lazy Loading** – `services/backend-core/python/celery_app.py:123` (hf-qwen)
  - There's a potential race condition in `_load_demucs()` and `_load_musicgen()` where two threads might attempt to load the same module simultaneously, leading to redundant loading or inconsistent state.
  - Vorschlag: Use double-checked locking pattern correctly by checking again inside the lock to avoid redundant initialization.
- [x] **DA-2026-09-04-047 · MEDIUM · Potential Insecure Randomness in Output Filename** → gefixt 2026-09-04 – `services/backend-core/python/celery_app.py:135` (hf-qwen)
  - The `generate_sample_task` function generates output filenames using regex substitution on user-provided prompts, which may lead to predictable or malicious filenames if not handled carefully.
  - Vorschlag: Use a cryptographically secure random string instead of truncating and sanitizing the prompt for generating unique filenames.
- [x] **DA-2026-09-04-048 · HIGH · Ungeprüfte Benutzereingabe in JSON-Validierung** → gefixt 2026-09-04 – `services/backend-core/python/hypersonic_moa.py:50` (hf-qwen)
  - Die Ausgabe von `raw.strip()` wird direkt an `json.loads()` übergeben, ohne vorherige Prüfung auf gefährliche Inhalte oder unerwartete Strukturen. Dies könnte zu einer Deserialisierungsangriffsszene führen, wenn externe Eingaben manipuliert werden.
  - Vorschlag: Fügen Sie zusätzliche Validierungslogik hinzu, um sicherzustellen, dass die geparste JSON-Struktur den erwarteten Schema-Formaten entspricht, z.B. durch Prüfung von Schlüsseln und Typen vor dem Rückgabewert.
- [x] **DA-2026-09-04-049 · MEDIUM · Möglicher Fehler bei leerem Prompt** → gefixt 2026-09-04 – `services/backend-core/python/hypersonic_moa.py:67` (hf-qwen)
  - Wenn `report_text` leer ist, kann dies zu einem ungültigen Prompt führen, der möglicherweise zu unvorhersehbaren Ergebnissen oder Fehlern beim Ollama-Modell führt.
  - Vorschlag: Fügen Sie eine Überprüfung hinzu, ob `report_text` leer ist, und geben Sie einen Default-Wert oder eine Fehlermeldung zurück.
- [x] **DA-2026-09-04-050 · HIGH · Potenzielle Fehlerlecks durch unkontrollierte Exception-Handling** → gefixt 2026-09-04 – `services/backend-core/python/main.py:57` (hf-qwen)
  - Die Funktion `get_render_status` fängt alle Exceptions beim Zugriff auf `res.result` ab, ohne diese zu loggen oder weiterzuwerfen. Dies kann zu versteckten Fehlern führen, die schwer zu debuggen sind.
  - Vorschlag: Logge die Exception, um Debugging zu erleichtern, z.B. `logger.exception("Fehler beim Abrufen des Task-Ergebnisses")`.
- [x] **DA-2026-09-04-051 · HIGH · Keine Authentifizierung/RBAC am API-Gateway** → gefixt 2026-09-04 – `services/backend-core/python/main.py:59` (deepseek-pro)
  - Die FastAPI-App definiert keine Authentifizierung, API-Key-Prüfung oder Session-/JWT-Middleware. Sämtliche Routen (`/api/render-status`, `/api/separate-stems`, `/api/generate-voice`, `/api/apply-fx`, `/api/render`) sind ohne Credentials aufrufbar und erlauben anonymen Zugriff auf teure KI-/DSP-Verarbeitung und Task-Ergebnisse.
  - Vorschlag: Authentifizierung und RBAC als FastAPI-Dependency/Middleware einführen; vor jedem Proxying/Rendering die Berechtigung und ggf. Limits prüfen.
- [ ] **DA-2026-09-04-052 · MEDIUM · Mögliche Injection in Service-URLs durch Umgebungsvariablen** – `services/backend-core/python/main.py:79` (hf-qwen)
  - Die Service-URLs werden direkt aus Umgebungsvariablen gelesen (`os.environ.get(...)`), ohne Validierung oder Sanitization. Falls diese von externen Quellen stammen, könnten sie schädliche URLs enthalten.
  - Vorschlag: Validiere die URLs mit `urllib.parse.urlparse()` und prüfe auf erlaubte Schemes und Hostnamen.
- [x] **DA-2026-09-04-053 · HIGH · Race Condition bei Client-Instanzierung** → gefixt 2026-09-04 – `services/backend-core/python/main.py:89` (hf-qwen)
  - Der globale `_client` wird nicht thread-sicher initialisiert. Bei gleichzeitigen Requests kann es zu einer Race Condition kommen, wenn mehrere Threads gleichzeitig `get_client()` aufrufen.
  - Vorschlag: Nutze threading.Lock() oder eine thread-safe Initialisierungsmethode wie `functools.lru_cache` mit `maxsize=1`.
- [ ] **DA-2026-09-04-054 · MEDIUM · Unnötige JSON-Konvertierung bei Fehlerfällen** – `services/backend-core/python/main.py:100` (hf-qwen)
  - Bei Fehlern wird versucht, den Response-Body als JSON zu parsen, obwohl der Service möglicherweise keinen gültigen JSON-Body zurückgibt. Dies kann zu unnötigen Fehlern führen.
  - Vorschlag: Prüfe vorher, ob der Content-Type des Responses 'application/json' ist, bevor du `.json()` aufrufst.
- [x] **DA-2026-09-04-055 · MEDIUM · Blockierender Celery-Result-Aufruf im Async-Endpoint** → gefixt 2026-09-04 – `services/backend-core/python/main.py` (deepseek-pro)
  - `res.result` ist ein synchroner, blockierender Celery-Backend-Aufruf (z. B. Redis) innerhalb eines async-Endpoints. Das blockiert den Event-Loop und beeinträchtigt parallele Requests erheblich.
  - Vorschlag: Blockierenden Aufruf in Threadpool auslagern (`await asyncio.to_thread(res.result)`) oder den Endpoint als sync-`def` definieren, damit FastAPI ihn im Threadpool ausführt.
- [x] **DA-2026-09-04-056 · CRITICAL · Lokale Session-Verwaltung widerspricht Multi-User-Synchronisation** – `services/backend-core/SESSION_DB_SCHEMA.md:4` (deepseek-pro) → gefixt 2026-09-04
  - Die Datei beschreibt, dass Sessions 'rein LOKAL im Browser' laufen, obwohl die Architekturregeln bis zu 4 gleichzeitige Benutzer mit identischem State-Mirroring und 'zero state desync' verlangen. Mit lediglich in-memory und localStorage werden Änderungen eines Nutzers nicht an andere übertragen, was zwangsläufig zu divergierenden Zuständen führt.
  - Vorschlag: Eine zentrale Session-Verwaltung (z. B. über den Backend-Core mit WebSockets/WebRTC) einführen, die alle Nutzer als autoritative Quelle synchronisiert, inklusive Konfliktlösung und Versionierung.
- [x] **DA-2026-09-04-057 · MEDIUM · B2B-Räume nur in-memory und pro Tab** → gefixt 2026-09-04 – `services/backend-core/SESSION_DB_SCHEMA.md:9` (deepseek-pro)
  - Die B2B-Räume werden als 'in-memory, pro Tab' beschrieben. Damit existieren keine zentrale Raumverwaltung und keine Persistenz; ein Reload oder ein zweiter Tab führt zu separat laufenden Räumen ohne Synchronisation.
  - Vorschlag: Räume über einen zentralen Service verwalten und Broadcast-Kanäle oder Backend-Nachrichten nutzen, um tab- und nutzerübergreifend konsistent zu bleiben.
- [x] **DA-2026-09-04-058 · MEDIUM · Audit-Log nur lokal und ungeschützt** → gefixt 2026-09-04 – `services/backend-core/SESSION_DB_SCHEMA.md:10` (deepseek-pro)
  - Das Audit-Log wird laut Beschreibung ausschließlich in Konsole und localStorage geschrieben. Diese Daten sind client-seitig manipulierbar und gehen bei Browserdaten-Löschung verloren. Für ein B2B-Kollaborationswerkzeug ist eine vertrauenswürdige, zentrale Protokollierung erforderlich.
  - Vorschlag: Audit-Ereignisse an einen zentralen, schreibgeschützten Logging-Dienst senden, der vor Manipulation geschützt ist.
- [x] **DA-2026-09-04-059 · HIGH · Client-seitige Locks sind manipulierbar** → gefixt 2026-09-04 – `services/backend-core/SESSION_DB_SCHEMA.md:15` (deepseek-pro)
  - Die Lock-Verwaltung wird als lokale Map<String, userId> im Browser beschrieben. Ein Nutzer kann diese Daten im DevTools oder über die Anwendung manipulieren und sich so fremde Locks aneignen oder aufheben. Das untergräbt das B2B/Busy-Mode-Prinzip und kann zu State-Desync führen.
  - Vorschlag: Lock-Operationen ausschließlich über den Backend-Core validieren und durchsetzen, z. B. mit serverseitiger Lock-Tabelle und atomaren Acquire/Release-Operationen.
- [x] **DA-2026-09-04-060 · MEDIUM · Benutzeridentitäten und aktive Nutzer client-seitig speicherbar** → gefixt 2026-09-04 – `services/backend-core/SESSION_DB_SCHEMA.md:19` (deepseek-pro)
  - Die aktive Benutzerliste inklusive Name und Farbe wird als lokale Map beschrieben. Identitäten lassen sich dadurch fälschen oder doppelt einnehmen, was Kollaborations- und Locking-Funktionen kompromittiert.
  - Vorschlag: Identitäten durch serverseitig signierte Tokens verifizieren und die activeUsers-Liste vom Backend als verlässliche Quelle führen.
- [x] **DA-2026-09-04-061 · HIGH · Fehlende Authentifizierung/Autorisierung erlaubt Spoofing von sender/recipient** → gefixt 2026-09-04 – `services/backend-core/SIGNALING_PROTOCOL.md:19` (deepseek-pro)
  - Das Protokoll definiert in der Nachrichtenstruktur frei wählbare Felder 'sender' und 'recipient' und verlangt bei 'init' lediglich die Registrierung einer UserID ohne Authentifizierungsnachweis. Jeder Client kann sich damit als beliebiger User ausgeben, SDP-/ICE-Nachrichten an unautorisierte Ziele umleiten oder Lock-Requests im Namen anderer User senden. Dies verletzt die Anforderung, dass nur ber
  - Vorschlag: Jede Verbindung muss serverseitig authentifiziert werden (z. B. signiertes Token oder Session-Handshake). Der Server muss 'sender' aus der authentifizierten Session setzen und darf 'recipient' nur an Mitglieder derselben Session weiterleiten. Zusätzlich sind Zugriffsrechte/RBAC für Locking und Signa
- [x] **DA-2026-09-04-062 · MEDIUM · Race Condition bei konkurrierenden lock_requests ohne Sequenz/Idempotenz-Token** → gefixt 2026-09-04 – `services/backend-core/SIGNALING_PROTOCOL.md:25` (deepseek-pro)
  - 'lock_request' enthält nur 'moduleId'. Wenn zwei User gleichzeitig dasselbe Modul sperren, gibt es keine Versions- oder Idempotenz-Information, um Konflikte zu erkennen. Der Server könnte den letzten Request gewinnen lassen und der unterlegene Client erhält möglicherweise keinen eindeutigen Ablehnungsstatus, was zu zwei Clients führen kann, die beide annehmen, den Lock zu halten (State-Desync).
  - Vorschlag: Ergänze ein requestId/Nonce und/oder eine lockVersion im lock_request. Der Server muss pro moduleId serialisieren und bei bereits aktivem Lock eine eindeutige Ablehnung mit aktuellem Owner zurücksenden. Alternativ CAS (Compare-and-Swap) auf Basis der letzten lock_status-Version.
- [x] **DA-2026-09-04-063 · HIGH · Kein Lease/Heartbeat für Locks – Stale Locks bei Verbindungsabbruch** → gefixt 2026-09-04 – `services/backend-core/SIGNALING_PROTOCOL.md:27` (deepseek-pro)
  - Das Protokoll definiert 'lock_request' und 'lock_status', aber keinen Mechanismus, um Locks bei Verbindungsabbruch freizugeben. Wenn ein User die Verbindung verliert, ohne ein explizites Unlock zu senden, bleibt das Modul dauerhaft gesperrt, da der Server keinen Disconnect-Erkennungs- oder Lease-Ablauf spezifiziert. Dies führt zu State-Desync und blockiert die Kollaboration (B2B/Busy-Mode).
  - Vorschlag: Lease-TTL oder Heartbeat für Locks einführen. Der Server muss Locks bei Disconnect, Timeout oder fehlendem Heartbeat automatisch freigeben und den neuen Status broadcasten.
- [x] **DA-2026-09-04-064 · MEDIUM · Fehlende Sequenz-/Versionsnummer in lock_status führt zu State-Desync bei Out-of-order Delivery** → gefixt 2026-09-04 – `services/backend-core/SIGNALING_PROTOCOL.md:28` (deepseek-pro)
  - 'lock_status' überträgt nur moduleId, userId und status, aber keine monoton steigende Version oder Sequenznummer. Bei Transporten, die keine strikte Reihenfolge garantieren (z. B. DataChannel/WebSocket unter Last), können Clients veraltete Lock-Updates nach einem neueren Update verarbeiten und so einen falschen Sperrzustand anzeigen.
  - Vorschlag: Füge eine sequenzielle Versionsnummer oder Lamport-/Server-Timestamp in lock_status ein. Clients verwerfen Updates mit niedrigerer Version als dem zuletzt akzeptierten Zustand.
- [ ] **DA-2026-09-04-065 · MEDIUM · @typescript-eslint/no-require-imports** – `services/midi-bridge/index.js:27` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-066 · MEDIUM · @typescript-eslint/no-require-imports** – `services/midi-bridge/index.js:28` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-067 · MEDIUM · @typescript-eslint/no-require-imports** – `services/midi-bridge/index.js:40` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-068 · MEDIUM · @typescript-eslint/no-require-imports** – `services/midi-bridge/index.js:80` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-069 · MEDIUM · @typescript-eslint/no-require-imports** – `services/midi-bridge/index.js:100` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-070 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:7` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-071 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:8` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-072 · MEDIUM · @typescript-eslint/no-unused-vars** – `services/mixer/index.js:23` (eslint)
  - 'e' is defined but never used.
- [ ] **DA-2026-09-04-073 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:39` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-074 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:41` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-075 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:51` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-076 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:53` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-077 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:71` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-078 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:73` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-079 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:85` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-080 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:87` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-081 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:99` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-082 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:101` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-083 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:115` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-084 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:117` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-085 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:126` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-086 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:128` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-087 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:140` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-088 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:142` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-089 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:159` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-090 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:161` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-091 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:176` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-092 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:178` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-093 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:189` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-094 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:191` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-095 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:205` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-096 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:207` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-097 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:218` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-098 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:220` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-099 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:234` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-100 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:236` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-101 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:247` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-102 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:249` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-103 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:263` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-104 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:265` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-105 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:276` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-106 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:278` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-107 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:291` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-108 · MEDIUM · @typescript-eslint/no-require-imports** – `services/mixer/index.js:293` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-109 · MEDIUM · @typescript-eslint/no-unused-vars** – `services/portal-worker/src/index.js:33` (eslint)
  - 'REPO_URL' is assigned a value but never used.
- [x] **DA-2026-09-04-110 · HIGH · Potential Command Injection via Model Name** → gefixt 2026-09-04 – `services/samplemonk-ai-runtime/app.py:107` (hf-qwen)
  - The model parameter in the /infer endpoint is directly used in logging and error messages without sanitization. If an attacker can control the model name, they could inject malicious content into logs or error messages.
  - Vorschlag: Sanitize the model name before including it in log messages. Consider using a whitelist approach or regex validation to prevent injection attacks.
- [ ] **DA-2026-09-04-111 · MEDIUM · Race Condition in Model Loading** – `services/samplemonk-ai-runtime/app.py:117` (hf-qwen)
  - There's a potential race condition between model loading in the background thread and inference requests. The STATE.models_ready flag is set after preloading but there's no synchronization mechanism to ensure all models are actually available before allowing inference.
  - Vorschlag: Add proper synchronization mechanisms such as locks or atomic flags to ensure model availability before allowing inference requests.
- [x] **DA-2026-09-04-112 · MEDIUM · Missing Input Validation for Task Parameter** → gefixt 2026-09-04 – `services/samplemonk-ai-runtime/app.py:130` (hf-qwen)
  - The task parameter in /infer endpoint is not validated against a predefined list of allowed tasks. This could lead to unexpected behavior or security issues if invalid tasks are passed.
  - Vorschlag: Validate the task parameter against a predefined list of allowed tasks to prevent unauthorized operations.
- [x] **DA-2026-09-04-113 · HIGH · Unvalidated User Input in Model ID and Task Handling** → gefixt 2026-09-04 – `services/samplemonk-ai-runtime/handlers.py:107` (hf-qwen)
  - The `model_id` parameter is directly used in cache keys without sanitization, which could allow for cache poisoning or injection attacks if malicious values are passed. Additionally, the `_normalize_task` function does not sanitize input, potentially allowing arbitrary task execution.
  - Vorschlag: Sanitize `model_id` and `task` inputs before using them in cache keys or handler lookups. Consider validating against a whitelist of allowed characters or patterns.
- [ ] **DA-2026-09-04-114 · MEDIUM · Potential Race Condition in Cache Eviction** – `services/samplemonk-ai-runtime/handlers.py:125` (hf-qwen)
  - The cache eviction logic in `_cache_get` uses `popitem(last=False)` which may lead to race conditions if multiple threads access the cache simultaneously during eviction. This could cause inconsistent behavior or loss of cached models.
  - Vorschlag: Use thread-safe operations or locks around cache access during eviction to prevent race conditions. Alternatively, consider using a dedicated thread-safe cache implementation like `collections.OrderedDict` with proper locking mechanisms.
- [x] **DA-2026-09-04-115 · HIGH · Insecure Direct Object Reference (IDOR) Risk in Audio Payload Handling** → gefixt 2026-09-04 – `services/samplemonk-ai-runtime/handlers.py:140` (hf-qwen)
  - The `_audio_bytes` function accepts both base64 strings and raw bytes but doesn't validate or sanitize the source of the audio data. If an attacker can control the payload, they might inject malicious content that bypasses size checks or gets processed incorrectly.
  - Vorschlag: Add stricter validation on the format and content of incoming audio data. Ensure that all inputs are validated against known good formats and sizes before processing.
- [ ] **DA-2026-09-04-116 · MEDIUM · Potential Integer Overflow in Audio Resampling** – `services/samplemonk-ai-runtime/handlers.py:160` (hf-qwen)
  - In `_read_audio`, when calculating `new_len` for resampling, there's no explicit check for integer overflow or underflow. If `duration` or `target_sr` are extremely large or small, it could lead to incorrect resampled lengths or errors.
  - Vorschlag: Validate that `duration * target_sr` results in a reasonable integer value before casting to int. Add bounds checking to prevent potential overflows.
- [x] **DA-2026-09-04-117 · HIGH · Ungeprüfte Benutzereingaben in Umgebungsvariablen** → gefixt 2026-09-04 – `services/samplemonk-ai-runtime/hf_manage_endpoint.py:95` (hf-qwen)
  - Die Funktion `_common_kwargs()` verwendet ungeprüfte Umgebungsvariablen wie `HF_TOKEN`, `HF_REGISTRY_USERNAME` und `HF_REGISTRY_PASSWORD`, um Secrets zu setzen. Diese Werte könnten gefährliche Inhalte enthalten, ohne Validierung.
  - Vorschlag: Validiere und sanitisiere alle Umgebungsvariablen vor dem Einsatz. Insbesondere `HF_TOKEN`, `HF_REGISTRY_USERNAME` und `HF_REGISTRY_PASSWORD`. Verwende z. B. regex-basierte Prüfungen oder eine Whitelist.
- [ ] **DA-2026-09-04-118 · MEDIUM · Fehlende Fehlerbehandlung bei Legacy-Endpoint-Löschung** – `services/samplemonk-ai-runtime/hf_manage_endpoint.py:109` (hf-qwen)
  - In der `delete-legacy`-Logik wird bei Fehlern beim Löschen eines alten Endpoints lediglich eine Warnung ausgegeben, aber das Skript setzt nicht explizit auf einen Fehlercode, was zu unerwartetem Verhalten führen kann.
  - Vorschlag: Setze nach jedem Fehler beim Löschen eines Legacy-Endpoints einen Fehlercode zurück, um sicherzustellen, dass das Skript korrekt abbricht, falls ein Fehler auftritt.
- [ ] **DA-2026-09-04-119 · MEDIUM · Mögliche Race Condition bei Statusabfrage** – `services/samplemonk-ai-runtime/hf_manage_endpoint.py:124` (hf-qwen)
  - Die Statusabfrage (`get_inference_endpoint`) kann unter bestimmten Bedingungen zu einer Race Condition führen, wenn der Endpoint kurzzeitig nicht verfügbar ist. Die Abfrage erfolgt ohne Retry-Mechanismus.
  - Vorschlag: Implementiere einen Retry-Mechanismus mit Exponential Backoff für die Statusabfrage, um temporäre Netzwerkprobleme oder API-Latenz zu berücksichtigen.
- [x] **DA-2026-09-04-120 · HIGH · Ungeprüfte Benutzereingabe in Model-ID** → gefixt 2026-09-04 – `services/samplemonk-ai-runtime/mcp_runtime.py:57` (hf-qwen)
  - Die `model_id` wird direkt aus dem Payload extrahiert und ohne Validierung oder Sanitization verwendet. Dies könnte zu Sicherheitsproblemen führen, wenn externe Eingaben nicht korrekt validiert werden.
  - Vorschlag: Füge eine Validierung hinzu, um sicherzustellen, dass `model_id` nur gültige Werte enthält (z.B. durch Regex oder Whitelist).
- [ ] **DA-2026-09-04-121 · MEDIUM · Mögliche Race Condition bei Modell-Laden/Entladen** – `services/samplemonk-ai-runtime/mcp_runtime.py:69` (hf-qwen)
  - Die Methoden `_tool_model_load` und `_tool_model_unload` rufen direkt Methoden des Managers auf, ohne Synchronisation. Bei parallelen Anfragen kann dies zu inkonsistentem Zustand führen.
  - Vorschlag: Implementiere eine Mutex/Sperre um sicherzustellen, dass Modelloperationen atomar ablaufen.
- [x] **DA-2026-09-04-122 · CRITICAL · Fehlende Input-Validierung für Tool-Aufrufe** – `services/samplemonk-ai-runtime/mcp_runtime.py:77` (hf-qwen) → gefixt 2026-09-04
  - Der Aufruf von `handler(payload)` erfolgt ohne jegliche Validierung des Payloads. Ein böswilliger Client könnte schädliche Daten senden, die das System beeinträchtigen könnten.
  - Vorschlag: Validiere alle Eingabeparameter vor dem Aufruf des Handlers, insbesondere bei dynamischen Funktionen wie `_infer`.
- [x] **DA-2026-09-04-123 · HIGH · Potenzielle unsichere Deserialisierung von ModelDefinition** → gefixt 2026-09-04 – `services/samplemonk-ai-runtime/model_manager.py:107` (hf-qwen)
  - Die Methode `ModelDefinition.from_dict()` akzeptiert unvalidierte Benutzereingaben aus dem Manifest und erstellt Instanzen ohne zusätzliche Validierung. Dies könnte zu Sicherheitsproblemen führen, wenn externe Quellen das Manifest steuern.
  - Vorschlag: Implementiere eine strenge Validierung der Eingabedaten vor dem Erstellen der ModelDefinition-Instanz. Prüfe z.B. auf erlaubte Werte für `loadClass`, `framework`, `quantization` und andere kritische Attribute.
- [ ] **DA-2026-09-04-124 · MEDIUM · Race Condition bei parallelen Load-Requests** – `services/samplemonk-ai-runtime/model_manager.py:139` (hf-qwen)
  - Obwohl ein `_loading`-Set zur Deduplikation verwendet wird, gibt es einen potenziellen Race Condition, wenn zwei Threads gleichzeitig prüfen, ob ein Modell geladen ist und beide gleichzeitig versuchen es zu laden.
  - Vorschlag: Stelle sicher, dass die Prüfung auf `_loaded` und `_loading` atomar erfolgt. Alternativ: Verwende eine Lock-Strategie, die alle Zugriffe auf `model_id` synchronisiert, um Race Conditions vollständig zu vermeiden.
- [x] **DA-2026-09-04-125 · MEDIUM · Unvollständige Fehlerbehandlung bei Modell-Unload** → gefixt 2026-09-04 – `services/samplemonk-ai-runtime/model_manager.py:170` (hf-qwen)
  - Wenn `torch.cuda.empty_cache()` fehlschlägt, wird der Fehler stillschweigend ignoriert. Dies kann zu Speicherlecks führen, insbesondere bei GPU-Abstürzen.
  - Vorschlag: Füge Logging hinzu, um Fehler bei `torch.cuda.empty_cache()` zu protokollieren, und prüfe, ob dies zu einer unvollständigen Speicherbereinigung führt.
- [x] **DA-2026-09-04-126 · MEDIUM · setuptools packages = [] deaktiviert Installation aller lokalen Python-Module** → gefixt 2026-09-04 – `services/samplemonk-ai-runtime/pyproject.toml:19` (deepseek-pro)
  - Die Konfiguration packages = [] führt dazu, dass bei einer Installation (pip install .) keinerlei eigene Python-Pakete des AI-Runtime-Services installiert werden. Falls der Service lokale Module enthält (z. B. app, routers, models), sind diese nach der Installation nicht als importierbare Pakete verfügbar, was zu ModuleNotFoundError beim Start führen kann. In einem Hugging Face Custom Container wi
  - Vorschlag: Setze packages = find: oder liste die tatsächlichen Pakete explizit auf (z. B. packages = ["samplemonk_ai_runtime"]). Falls flache Module vorliegen, verwende py_modules.
- [x] **DA-2026-09-04-127 · MEDIUM · Unbehandeltes Manifest-Schema: `models` kann `None` oder keine Liste sein** → gefixt 2026-09-04 – `services/samplemonk-ai-runtime/registry.py:18` (deepseek-pro)
  - Wenn das JSON-Manifest ein Feld `models` mit dem Wert `null` oder einem Objekt statt einer Liste enthält, liefert `data.get('models', [])` den Wert `None` bzw. das Objekt zurück und die anschließende Iteration wirft einen TypeError bzw. AttributeError. Der Default `[]` greift nur bei fehlendem Schlüssel, nicht bei `null` oder falschem Typ. Dadurch stürzt der Loader bei fehlerhaftem Manifest ohne k
  - Vorschlag: Vor der Iteration explizit prüfen: `models = data.get('models') or []`; `if not isinstance(models, list): raise ValueError('models must be a list')`. Alternativ das Manifest per JSON-Schema validieren.
- [x] **DA-2026-09-04-128 · MEDIUM · VRAM-Budget und Safety Margin überschreiten übliche 80-GB-GPU** → gefixt 2026-09-04 – `services/samplemonk-ai-runtime/runtime_config.yaml:7` (deepseek-flash)
  - Die Kombination aus vram_budget_gb=80 und vram_safety_margin_gb=6 ergibt einen Reservierungsbedarf von 86 GB. Wenn die Runtime die Safety Margin zusätzlich zum Budget als freien Speicher freihalten soll, ist das auf einer typischen 80-GB-GPU (A100/H100) nicht möglich und führt zu CUDA-OOM oder Fehlallokation. Die Werte müssen zur tatsächlich verfügbaren GPU passen; entweder ist das Budget zu hoch 
  - Vorschlag: VRAM-Budget so setzen, dass Budget + Safety Margin ≤ verfügbarer VRAM ist (z.B. vram_budget_gb: 72 bei 6 GB Marge auf einer 80-GB-Karte) oder die Safety Margin als Teil des Budgets definieren und die Konfiguration entsprechend dokumentieren/validieren.
- [x] **DA-2026-09-04-129 · CRITICAL · Trailing backslash causes shell syntax error** – `services/samplemonk-ai-runtime/startup.sh:21` (deepseek-pro) → gefixt 2026-09-04
  - The exec uvicorn command ends with a line continuation backslash on line 21 but no following line. Bash will report a syntax error/unexpected EOF, so the script always fails and the service cannot start.
  - Vorschlag: Remove the trailing backslash or move a final option onto the same line. Example: `--timeout-keep-alive 30` without backslash.
- [ ] **DA-2026-09-04-130 · MEDIUM · @typescript-eslint/no-require-imports** – `services/signaling/index.js:1` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-131 · MEDIUM · @typescript-eslint/no-require-imports** – `services/signaling/index.js:2` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-132 · MEDIUM · @typescript-eslint/no-require-imports** – `services/signaling/index.js:3` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-133 · MEDIUM · prefer-const** – `src/audio/worklets/dspProcessor.ts:135` (eslint)
  - 'y1' is never reassigned. Use 'const' instead.
- [ ] **DA-2026-09-04-134 · MEDIUM · react-hooks/use-memo** – `src/components/DJ4ChMixer.tsx:182` (eslint)
  - Error: Expected the first argument to be an inline function expression  Expected the first argument to be an inline function expression.  /home/patrick/audioMONASTRY/src/components/DJ4ChMixer.tsx:182:26   180 |   181 | export const DJMixer = React.memo(function DJMixer() { > 182 |   const strips = useMemo(buildStrips, []);       |                          ^^^^^^^^^^^ Expected the first argument to
- [ ] **DA-2026-09-04-135 · MEDIUM · react-hooks/set-state-in-effect** – `src/components/drop/DropGeneratorPanel.tsx:27` (eslint)
  - Error: Calling setState synchronously within an effect can trigger cascading renders  Effects are intended to synchronize state between React and external systems such as manually updating the DOM, state management libraries, or other platform APIs. In general, the body of an effect should do one or both of the following: * Update external systems with the latest state from React. * Subscribe for 
- [ ] **DA-2026-09-04-136 · MEDIUM · react-hooks/set-state-in-effect** – `src/components/DrumMachineTerminal.tsx:86` (eslint)
  - Error: Calling setState synchronously within an effect can trigger cascading renders  Effects are intended to synchronize state between React and external systems such as manually updating the DOM, state management libraries, or other platform APIs. In general, the body of an effect should do one or both of the following: * Update external systems with the latest state from React. * Subscribe for 
- [ ] **DA-2026-09-04-137 · MEDIUM · react-hooks/preserve-manual-memoization** – `src/components/DrumMachineTerminal.tsx:126` (eslint)
  - Compilation Skipped: Existing memoization could not be preserved  React Compiler has skipped optimizing this component because the existing manual memoization could not be preserved. This value was memoized in source but not in compilation output.  /home/patrick/audioMONASTRY/src/components/DrumMachineTerminal.tsx:126:38   124 |   }, []);   125 | > 126 |   const playStepSample = useCallback((sampl
- [ ] **DA-2026-09-04-138 · MEDIUM · react-hooks/preserve-manual-memoization** – `src/components/DrumMachineTerminal.tsx:140` (eslint)
  - Compilation Skipped: Existing memoization could not be preserved  React Compiler has skipped optimizing this component because the existing manual memoization could not be preserved. This dependency may be mutated later, which could cause the value to change unexpectedly.  /home/patrick/audioMONASTRY/src/components/DrumMachineTerminal.tsx:140:7   138 |     const match = activeDrumKit.sounds.find((
- [ ] **DA-2026-09-04-139 · MEDIUM · react-hooks/preserve-manual-memoization** – `src/components/DrumMachineTerminal.tsx:201` (eslint)
  - Compilation Skipped: Existing memoization could not be preserved  React Compiler has skipped optimizing this component because the existing manual memoization could not be preserved. This value was memoized in source but not in compilation output.  /home/patrick/audioMONASTRY/src/components/DrumMachineTerminal.tsx:201:40   199 |   };   200 | > 201 |   const handleSampleDrop = useCallback((sample: 
- [ ] **DA-2026-09-04-140 · MEDIUM · react-hooks/preserve-manual-memoization** – `src/components/DrumMachineTerminal.tsx:210` (eslint)
  - Compilation Skipped: Existing memoization could not be preserved  React Compiler has skipped optimizing this component because the existing manual memoization could not be preserved. This dependency may be mutated later, which could cause the value to change unexpectedly.  /home/patrick/audioMONASTRY/src/components/DrumMachineTerminal.tsx:210:34   208 |       return { ...prev, [key]: arr };   209 
- [ ] **DA-2026-09-04-141 · MEDIUM · react-hooks/set-state-in-effect** – `src/components/DrumMachineTerminal.tsx:219` (eslint)
  - Error: Calling setState synchronously within an effect can trigger cascading renders  Effects are intended to synchronize state between React and external systems such as manually updating the DOM, state management libraries, or other platform APIs. In general, the body of an effect should do one or both of the following: * Update external systems with the latest state from React. * Subscribe for 
- [ ] **DA-2026-09-04-142 · MEDIUM · react-hooks/set-state-in-effect** – `src/components/EQPluginTerminal.tsx:254` (eslint)
  - Error: Calling setState synchronously within an effect can trigger cascading renders  Effects are intended to synchronize state between React and external systems such as manually updating the DOM, state management libraries, or other platform APIs. In general, the body of an effect should do one or both of the following: * Update external systems with the latest state from React. * Subscribe for 
- [ ] **DA-2026-09-04-143 · MEDIUM · react-hooks/set-state-in-effect** – `src/components/MasteringOverlay.tsx:60` (eslint)
  - Error: Calling setState synchronously within an effect can trigger cascading renders  Effects are intended to synchronize state between React and external systems such as manually updating the DOM, state management libraries, or other platform APIs. In general, the body of an effect should do one or both of the following: * Update external systems with the latest state from React. * Subscribe for 
- [ ] **DA-2026-09-04-144 · MEDIUM · react-hooks/refs** – `src/components/MasterPlayerTerminal.tsx:120` (eslint)
  - Error: Cannot access refs during render  React refs are values that are not needed for rendering. Refs should only be accessed outside of render, such as in event handlers or effects. Accessing a ref value (the `current` property) during render can cause your component not to update as expected (https://react.dev/reference/react/useRef).  /home/patrick/audioMONASTRY/src/components/MasterPlayerTerm
- [ ] **DA-2026-09-04-145 · MEDIUM · react-hooks/refs** – `src/components/MasterPlayerTerminal.tsx:130` (eslint)
  - Error: Cannot access refs during render  React refs are values that are not needed for rendering. Refs should only be accessed outside of render, such as in event handlers or effects. Accessing a ref value (the `current` property) during render can cause your component not to update as expected (https://react.dev/reference/react/useRef).  /home/patrick/audioMONASTRY/src/components/MasterPlayerTerm
- [ ] **DA-2026-09-04-146 · MEDIUM · react-hooks/set-state-in-effect** – `src/components/MasterPlayerTerminal.tsx:194` (eslint)
  - Error: Calling setState synchronously within an effect can trigger cascading renders  Effects are intended to synchronize state between React and external systems such as manually updating the DOM, state management libraries, or other platform APIs. In general, the body of an effect should do one or both of the following: * Update external systems with the latest state from React. * Subscribe for 
- [ ] **DA-2026-09-04-147 · MEDIUM · react-hooks/set-state-in-effect** – `src/components/MasterPlayerTerminal.tsx:272` (eslint)
  - Error: Calling setState synchronously within an effect can trigger cascading renders  Effects are intended to synchronize state between React and external systems such as manually updating the DOM, state management libraries, or other platform APIs. In general, the body of an effect should do one or both of the following: * Update external systems with the latest state from React. * Subscribe for 
- [ ] **DA-2026-09-04-148 · MEDIUM · react-hooks/refs** – `src/components/midi/MappingLearnPanel.tsx:28` (eslint)
  - Error: Cannot access refs during render  React refs are values that are not needed for rendering. Refs should only be accessed outside of render, such as in event handlers or effects. Accessing a ref value (the `current` property) during render can cause your component not to update as expected (https://react.dev/reference/react/useRef).  /home/patrick/audioMONASTRY/src/components/midi/MappingLear
- [ ] **DA-2026-09-04-149 · MEDIUM · react-hooks/set-state-in-effect** – `src/components/SemanticSampleSearch.tsx:71` (eslint)
  - Error: Calling setState synchronously within an effect can trigger cascading renders  Effects are intended to synchronize state between React and external systems such as manually updating the DOM, state management libraries, or other platform APIs. In general, the body of an effect should do one or both of the following: * Update external systems with the latest state from React. * Subscribe for 
- [ ] **DA-2026-09-04-150 · MEDIUM · react-hooks/set-state-in-effect** – `src/components/SettingsDialog.tsx:90` (eslint)
  - Error: Calling setState synchronously within an effect can trigger cascading renders  Effects are intended to synchronize state between React and external systems such as manually updating the DOM, state management libraries, or other platform APIs. In general, the body of an effect should do one or both of the following: * Update external systems with the latest state from React. * Subscribe for 
- [ ] **DA-2026-09-04-151 · MEDIUM · react-hooks/refs** – `src/context/AudioContext.tsx:103` (eslint)
  - Error: Cannot access refs during render  React refs are values that are not needed for rendering. Refs should only be accessed outside of render, such as in event handlers or effects. Accessing a ref value (the `current` property) during render can cause your component not to update as expected (https://react.dev/reference/react/useRef).  /home/patrick/audioMONASTRY/src/context/AudioContext.tsx:10
- [ ] **DA-2026-09-04-152 · MEDIUM · react-hooks/refs** – `src/context/AudioContext.tsx:104` (eslint)
  - Error: Cannot access refs during render  React refs are values that are not needed for rendering. Refs should only be accessed outside of render, such as in event handlers or effects. Accessing a ref value (the `current` property) during render can cause your component not to update as expected (https://react.dev/reference/react/useRef).  /home/patrick/audioMONASTRY/src/context/AudioContext.tsx:10
- [ ] **DA-2026-09-04-153 · MEDIUM · react-hooks/refs** – `src/context/AudioContext.tsx:105` (eslint)
  - Error: Cannot access refs during render  React refs are values that are not needed for rendering. Refs should only be accessed outside of render, such as in event handlers or effects. Accessing a ref value (the `current` property) during render can cause your component not to update as expected (https://react.dev/reference/react/useRef).  /home/patrick/audioMONASTRY/src/context/AudioContext.tsx:10
- [ ] **DA-2026-09-04-154 · MEDIUM · react-hooks/refs** – `src/context/AudioContext.tsx:343` (eslint)
  - Error: Cannot access refs during render  React refs are values that are not needed for rendering. Refs should only be accessed outside of render, such as in event handlers or effects. Accessing a ref value (the `current` property) during render can cause your component not to update as expected (https://react.dev/reference/react/useRef).  /home/patrick/audioMONASTRY/src/context/AudioContext.tsx:34
- [ ] **DA-2026-09-04-155 · MEDIUM · react-hooks/immutability** – `src/context/DropContext.tsx:150` (eslint)
  - Error: Cannot access variable before it is declared  `addChatMessage` is accessed before it is declared, which prevents the earlier access from updating when this value changes over time.  /home/patrick/audioMONASTRY/src/context/DropContext.tsx:150:7   148 |   149 |       setAiSuggestions((prev) => [...prev.slice(-2), generated]); > 150 |       addChatMessage(       |       ^^^^^^^^^^^^^^ `addChat
- [ ] **DA-2026-09-04-156 · MEDIUM · react-hooks/preserve-manual-memoization** – `src/context/DropContext.tsx:249` (eslint)
  - Compilation Skipped: Existing memoization could not be preserved  React Compiler has skipped optimizing this component because the existing manual memoization could not be preserved. This value was memoized in source but not in compilation output.  /home/patrick/audioMONASTRY/src/context/DropContext.tsx:249:5   247 |   248 |   const addChatMessage = useCallback( > 249 |     (text: string, sender: 
- [x] **DA-2026-09-04-157 · HIGH · Ungeprüfte Benutzereingaben in WebRTC-Nachrichten** → gefixt 2026-09-04 – `src/context/ModuleStateContext.tsx:57` (hf-qwen)
  - Die Funktion `addDataChannelListener` akzeptiert beliebige Nachrichten vom WebRTC-Kanal ohne strenge Validierung der `pluginId`, `state`, `senderId` und `timestamp`. Dies könnte zu unerwarteten Zustandsänderungen führen, wenn ein Angreifer manipulierte Nachrichten sendet.
  - Vorschlag: Validiere alle Felder der eingehenden WebRTC-Nachricht strikt gegen einen bekannten Schema (z.B. mit Zod oder Joi), um sicherzustellen, dass sie nicht manipuliert wurden.
- [ ] **DA-2026-09-04-158 · MEDIUM · Fehlende Fehlerbehandlung bei RBAC-Prüfung** – `src/context/ModuleStateContext.tsx:59` (hf-qwen)
  - Wenn `roleForUser` oder `readSessionConfig` fehlschlagen, wird die RBAC-Prüfung nicht durchgeführt, was zu einer möglichen Sicherheitslücke führen kann.
  - Vorschlag: Implementiere eine sichere Default-Rolle oder eine explizite Fehlerbehandlung, falls `roleForUser` oder `readSessionConfig` keine gültigen Werte zurückgeben.
- [ ] **DA-2026-09-04-159 · MEDIUM · Potenzielle Race Condition bei Zustandsaktualisierung** – `src/context/ModuleStateContext.tsx:67` (hf-qwen)
  - Die Aktualisierung von `lastSeen.current` und `setModuleStates` erfolgt getrennt. Bei parallelen Updates kann dies zu inkonsistenten Zuständen führen.
  - Vorschlag: Verwende atomare Zustandsoperationen oder eine Mutex-Struktur, um sicherzustellen, dass `lastSeen` und `moduleStates` immer synchron aktualisiert werden.
- [ ] **DA-2026-09-04-160 · MEDIUM · Zugriff auf ref-Variable außerhalb von Callbacks** – `src/context/PluginManagerContext.tsx:32` (hf-qwen)
  - Die `commit`-Funktion greift direkt auf `locksRef.current` zu, was potenziell zu Fehlern führen kann, wenn andere Teile des Codes den Ref-Wert ändern, ohne dass `setPluginLocks` aufgerufen wird.
  - Vorschlag: Stelle sicher, dass alle Zustandsänderungen über `commit` erfolgen und dass `locksRef.current` nur innerhalb von Callbacks oder synchronen Kontexten gelesen wird.
- [x] **DA-2026-09-04-161 · HIGH · Ungeprüfte Benutzeridentität bei Lock-Übernahme** → gefixt 2026-09-04 – `src/context/PluginManagerContext.tsx:49` (hf-qwen)
  - Die Funktion `requestLock` erlaubt es einem Benutzer, einen Lock zu übernehmen, wenn der Mixer im AI-Modus ist und bereits von einem anderen Benutzer besessen wird. Es erfolgt keine Validierung, ob der übernehmende Benutzer tatsächlich berechtigt ist, den Lock zu übernehmen.
  - Vorschlag: Füge eine zusätzliche Berechtigungsprüfung hinzu, z.B. durch Überprüfung einer Rollenliste oder eines Token-Claims, bevor ein Lock übernommen wird.
- [ ] **DA-2026-09-04-162 · MEDIUM · Möglicher Race Condition bei Lock-Abfrage** – `src/context/PluginManagerContext.tsx:58` (hf-qwen)
  - In der `requestLock`-Funktion wird `locksRef.current` verwendet, um den aktuellen Zustand abzurufen, aber es gibt keinen Mechanismus, um sicherzustellen, dass der Zustand während der Verarbeitung nicht verändert wurde. Dies kann zu inkonsistenten Lock-Statusen führen.
  - Vorschlag: Verwende atomare Zustandsoperationen oder eine Mutex-ähnliche Struktur, um sicherzustellen, dass die Lock-Logik konsistent bleibt.
- [ ] **DA-2026-09-04-163 · MEDIUM · prefer-const** – `src/core/drop/AiDropGenerator.ts:169` (eslint)
  - 'baseProfile' is never reassigned. Use 'const' instead.
- [ ] **DA-2026-09-04-164 · MEDIUM · @typescript-eslint/no-unused-expressions** – `src/core/workers/WorkerPool.ts:83` (eslint)
  - Expected an assignment or function call and instead saw an expression.
- [ ] **DA-2026-09-04-165 · MEDIUM · prefer-const** – `src/data/musicLibrary.ts:20` (eslint)
  - 'title' is never reassigned. Use 'const' instead.
- [ ] **DA-2026-09-04-166 · MEDIUM · react-hooks/set-state-in-effect** – `src/hooks/useControlHub.ts:23` (eslint)
  - Error: Calling setState synchronously within an effect can trigger cascading renders  Effects are intended to synchronize state between React and external systems such as manually updating the DOM, state management libraries, or other platform APIs. In general, the body of an effect should do one or both of the following: * Update external systems with the latest state from React. * Subscribe for 
- [ ] **DA-2026-09-04-167 · MEDIUM · react-hooks/set-state-in-effect** – `src/hooks/useHID.ts:72` (eslint)
  - Error: Calling setState synchronously within an effect can trigger cascading renders  Effects are intended to synchronize state between React and external systems such as manually updating the DOM, state management libraries, or other platform APIs. In general, the body of an effect should do one or both of the following: * Update external systems with the latest state from React. * Subscribe for 
- [ ] **DA-2026-09-04-168 · MEDIUM · react-hooks/set-state-in-effect** – `src/hooks/useMIDI.ts:175` (eslint)
  - Error: Calling setState synchronously within an effect can trigger cascading renders  Effects are intended to synchronize state between React and external systems such as manually updating the DOM, state management libraries, or other platform APIs. In general, the body of an effect should do one or both of the following: * Update external systems with the latest state from React. * Subscribe for 
- [ ] **DA-2026-09-04-169 · MEDIUM · react-hooks/refs** – `src/hooks/useMidiClockOut.ts:43` (eslint)
  - Error: Cannot access refs during render  React refs are values that are not needed for rendering. Refs should only be accessed outside of render, such as in event handlers or effects. Accessing a ref value (the `current` property) during render can cause your component not to update as expected (https://react.dev/reference/react/useRef).  /home/patrick/audioMONASTRY/src/hooks/useMidiClockOut.ts:43
- [ ] **DA-2026-09-04-170 · MEDIUM · react-hooks/refs** – `src/hooks/useMidiClockOut.ts:46` (eslint)
  - Error: Cannot access refs during render  React refs are values that are not needed for rendering. Refs should only be accessed outside of render, such as in event handlers or effects. Accessing a ref value (the `current` property) during render can cause your component not to update as expected (https://react.dev/reference/react/useRef).  /home/patrick/audioMONASTRY/src/hooks/useMidiClockOut.ts:46
- [ ] **DA-2026-09-04-171 · MEDIUM · react-hooks/set-state-in-effect** – `src/hooks/useMidiClockOut.ts:62` (eslint)
  - Error: Calling setState synchronously within an effect can trigger cascading renders  Effects are intended to synchronize state between React and external systems such as manually updating the DOM, state management libraries, or other platform APIs. In general, the body of an effect should do one or both of the following: * Update external systems with the latest state from React. * Subscribe for 
- [ ] **DA-2026-09-04-172 · MEDIUM · react-hooks/refs** – `src/hooks/useMidiClockOut.ts:86` (eslint)
  - Error: Cannot access refs during render  React refs are values that are not needed for rendering. Refs should only be accessed outside of render, such as in event handlers or effects. Accessing a ref value (the `current` property) during render can cause your component not to update as expected (https://react.dev/reference/react/useRef).  /home/patrick/audioMONASTRY/src/hooks/useMidiClockOut.ts:86
- [ ] **DA-2026-09-04-173 · MEDIUM · Möglicher Race Condition bei Zustandsabfrage** – `src/hooks/usePluginState.ts:20` (hf-qwen)
  - Der Zugriff auf `moduleStates[pluginId]` kann zwischen dem Lesen des Zustands und dem Aufruf von `setModuleState` durch einen anderen Thread oder Event veraltet sein. Dies kann zu inkonsistenten Zuständen führen.
  - Vorschlag: Verwende eine atomare Zustandsaktualisierungsmethode, z.B. eine Reducer-Funktion, um sicherzustellen, dass alle Zustandsänderungen konsistent sind.
- [x] **DA-2026-09-04-174 · HIGH · Ungeprüfte Zustandsaktualisierung bei Plugin-Sperre** → gefixt 2026-09-04 – `src/hooks/usePluginState.ts:27` (hf-qwen)
  - Die Funktion `updateState` erlaubt es Benutzern, den Plugin-Zustand zu ändern, auch wenn das Plugin gesperrt ist. Dies könnte zu Zustandsinkonsistenzen führen, da andere Benutzer nicht wissen, ob der Zustand tatsächlich geändert wurde.
  - Vorschlag: Füge eine zusätzliche Prüfung hinzu, um sicherzustellen, dass nur der Benutzer, der das Plugin gesperrt hat, den Zustand ändern darf. Alternativ: Verhindere das Setzen eines neuen Zustands, wenn das Plugin gesperrt ist.
- [ ] **DA-2026-09-04-175 · MEDIUM · react-hooks/set-state-in-effect** – `src/hooks/useRoom.ts:28` (eslint)
  - Error: Calling setState synchronously within an effect can trigger cascading renders  Effects are intended to synchronize state between React and external systems such as manually updating the DOM, state management libraries, or other platform APIs. In general, the body of an effect should do one or both of the following: * Update external systems with the latest state from React. * Subscribe for 
- [x] **DA-2026-09-04-176 · HIGH · Ungeprüfte Benutzereingaben in WebRTC-Nachrichten** → gefixt 2026-09-04 – `src/hooks/useSessionSync.ts:22` (hf-qwen)
  - Die `sample`-Eigenschaft wird direkt aus der WebRTC-Nachricht entpackt und ohne weitere Validierung an `addToScratchpad` weitergereicht. Dies könnte zu Sicherheitsproblemen führen, wenn bösartige Nutzer schadhaftes Payload senden.
  - Vorschlag: Führe zusätzliche Validierung durch, z.B. Prüfung auf erwartete Eigenschaften (z.B. `id`, `name`) und Typüberprüfung mit z.B. Zod oder Joi vor dem Aufruf von `addToScratchpad`.
- [x] **DA-2026-09-04-177 · MEDIUM · Möglicher Zustandsinkonsistenz bei REMOTE_REMOVE** → gefixt 2026-09-04 – `src/hooks/useSessionSync.ts:27` (hf-qwen)
  - Wenn ein entferntes Element lokal nicht existiert, kann es zu einer inkonsistenten Zustandsverwaltung kommen. Es wird keine Prüfung durchgeführt, ob das Element tatsächlich im Scratchpad vorhanden war.
  - Vorschlag: Füge eine Überprüfung hinzu, ob das Element existiert, bevor es entfernt wird, z.B. durch einen Vorhandenseinscheck vor dem Aufruf von `removeFromScratchpad`.
- [x] **DA-2026-09-04-178 · MEDIUM · Unsichere Typisierung in syncAdd Funktion** → gefixt 2026-09-04 – `src/hooks/useSessionSync.ts:33` (hf-qwen)
  - Die Funktion `syncAdd` akzeptiert einen Parameter vom Typ `any`. Dies kann zu Laufzeitfehlern führen, da keine Typüberprüfung stattfindet.
  - Vorschlag: Definiere einen expliziten Typ für `sample`, z.B. `interface ScratchpadSample { id: string; name: string; url?: string; ... }` und verwende diesen Typ anstelle von `any`.
- [ ] **DA-2026-09-04-179 · MEDIUM · react-hooks/immutability** – `src/hooks/useWebRTC.ts:25` (eslint)
  - Error: Cannot access variable before it is declared  `handleOffer` is accessed before it is declared, which prevents the earlier access from updating when this value changes over time.  /home/patrick/audioMONASTRY/src/hooks/useWebRTC.ts:25:9   23 |   24 |       if (type === 'sdp_offer') { > 25 |         handleOffer(sender, payload);      |         ^^^^^^^^^^^ `handleOffer` accessed before it is de
- [ ] **DA-2026-09-04-180 · MEDIUM · react-hooks/immutability** – `src/hooks/useWebRTC.ts:27` (eslint)
  - Error: Cannot access variable before it is declared  `handleAnswer` is accessed before it is declared, which prevents the earlier access from updating when this value changes over time.  /home/patrick/audioMONASTRY/src/hooks/useWebRTC.ts:27:9   25 |         handleOffer(sender, payload);   26 |       } else if (type === 'sdp_answer') { > 27 |         handleAnswer(sender, payload);      |         ^^
- [ ] **DA-2026-09-04-181 · MEDIUM · react-hooks/immutability** – `src/hooks/useWebRTC.ts:29` (eslint)
  - Error: Cannot access variable before it is declared  `handleCandidate` is accessed before it is declared, which prevents the earlier access from updating when this value changes over time.  /home/patrick/audioMONASTRY/src/hooks/useWebRTC.ts:29:9   27 |         handleAnswer(sender, payload);   28 |       } else if (type === 'ice_candidate') { > 29 |         handleCandidate(sender, payload);      | 
- [ ] **DA-2026-09-04-182 · MEDIUM · prefer-const** – `src/utils/audioEngine.ts:1946` (eslint)
  - 'semitone' is never reassigned. Use 'const' instead.
- [ ] **DA-2026-09-04-183 · MEDIUM · @typescript-eslint/ban-ts-comment** – `src/utils/audioEngine.ts:1963` (eslint)
  - Use "@ts-expect-error" instead of "@ts-ignore", as "@ts-ignore" will do nothing if the following line is error-free.
- [ ] **DA-2026-09-04-184 · MEDIUM · @typescript-eslint/ban-ts-comment** – `src/utils/audioEngine.ts:1965` (eslint)
  - Use "@ts-expect-error" instead of "@ts-ignore", as "@ts-ignore" will do nothing if the following line is error-free.
- [ ] **DA-2026-09-04-185 · MEDIUM · import/no-dynamic-require** – `src/utils/LocalEmbeddingProvider.ts:41` (eslint)
  - Definition for rule 'import/no-dynamic-require' was not found.
- [ ] **DA-2026-09-04-186 · MEDIUM · prefer-const** – `src/utils/usageAnalytics.ts:16` (eslint)
  - 'state' is never reassigned. Use 'const' instead.
- [x] **DA-2026-09-04-187 · HIGH · Ungeprüfte Socket-ID in Datenkanal-Nachrichten** → gefixt 2026-09-04 – `src/utils/WebRTCManager.ts:109` (hf-qwen)
  - Die Funktion `dispatchDataMessage` akzeptiert Daten aus einem DataChannel ohne vorherige Validierung der Socket-ID des Senders. Dies könnte zu einer Sicherheitslücke führen, da bösartige Nutzer möglicherweise gefälschte Nachrichten senden könnten.
  - Vorschlag: Validiere die Socket-ID des Senders vor dem Verarbeiten der Daten. Überprüfe, ob der Sender in der Liste der bekannten Peers enthalten ist, bevor du die Daten an die Listener weiterleitest.
- [ ] **DA-2026-09-04-188 · MEDIUM · Race Condition bei Peer-Verbindungen** – `src/utils/WebRTCManager.ts:170` (hf-qwen)
  - In der Methode `setupSignaling` wird bei Empfang eines 'offer'-Events geprüft, ob der Signaling-Zustand des PeerConnections 'stable' ist. Es besteht jedoch ein potenzieller Race-Zustand, da zwischen dem Prüfen des Zustands und dem Setzen der Remote-Description weitere Ereignisse auftreten könnten.
  - Vorschlag: Verwende eine Mutex- oder Queue-Mechanismus, um sicherzustellen, dass nur ein Thread gleichzeitig mit der Verarbeitung von Offers beschäftigt ist. Alternativ: Speichere das Offer in einer Warteschlange und verarbeite es später, sobald der Zustand stabil ist.
- [x] **DA-2026-09-04-189 · MEDIUM · Unsichere JSON-Parsing-Operation** → gefixt 2026-09-04 – `src/utils/WebRTCManager.ts:200` (hf-qwen)
  - Die Methode `ondatachannel` verwendet `JSON.parse(msg.data)` ohne strenge Validierung des Ergebnisses. Dies könnte zu Fehlern führen, wenn ungültige JSON-Daten empfangen werden.
  - Vorschlag: Implementiere eine zusätzliche Validierung des geparsten JSON-Objekts, um sicherzustellen, dass es die erwartete Struktur hat. Verwende z.B. Joi oder Zod zur Schema-Validierung.

---

## Deep-Audit 2026-09-04 – Befunde

- [ ] **DA-2026-09-04-190 · MEDIUM · @typescript-eslint/no-require-imports** – `server.ts:1454` (eslint)
  - A `require()` style import is forbidden.
- [ ] **DA-2026-09-04-191 · MEDIUM · Fehlerhafte Regex-Logik bei Kategorisierung** – `server/cloudAutomation.ts:100` (hf-qwen)
  - In `detectCategoryType` wird der Typ basierend auf dem Dateinamen bestimmt, aber es gibt keine explizite Prüfung, ob der Typ korrekt zugeordnet wird. Dies könnte zu inkonsistenten Kategorisierungen führen.
  - Vorschlag: Implementiere eine Priorisierung der Regex-Muster, um sicherzustellen, dass spezifische Begriffe wie 'kick' vor allgemeinen Mustern wie 'loop' geprüft werden. Alternativ: Füge Tests hinzu, um die Zuordnung zu validieren.
- [x] **DA-2026-09-04-192 · CRITICAL · Mögliche Fehlermeldung mit internen Details an Client** → gefixt 2026-09-04 – `server/cloudAutomation.ts:122` (hf-qwen)
  - Die Funktion `ingestAudioObject` gibt direkt Fehlermeldungen von Supabase zurück, was potenziell sensible Informationen preisgeben kann.
  - Vorschlag: Verwende eine Logging-Strategie, die interne Fehlerdetails nicht an den Client weitergibt. Stattdessen logge sie serverseitig und sende eine generische Fehlermeldung an den Client.
- [ ] **DA-2026-09-04-193 · MEDIUM · Zugriff auf Umgebungsvariablen ohne Sicherheitsprüfungen** – `server/cloudAutomation.ts:132` (hf-qwen)
  - Die Funktion `r2Client()` und `supabaseAdmin()` greifen direkt auf Umgebungsvariablen zu, ohne diese auf Gültigkeit zu prüfen. Dies kann zu Laufzeitfehlern führen, wenn Variablen fehlen oder leer sind.
  - Vorschlag: Füge explizite Prüfungen hinzu, ob alle erforderlichen Umgebungsvariablen gesetzt sind, bevor ein Client erstellt wird. Gibt eine klare Fehlermeldung zurück, falls nicht.
- [ ] **DA-2026-09-04-194 · MEDIUM · Uvicorn bindet ohne sichtbare Authentifizierung an 0.0.0.0** – `services/backend-core/package.json:8` (deepseek-pro)
  - Das Startskript für den Python-Teil des Backend-Cores bindet den Uvicorn-Server an alle Netzwerk-Interfaces (0.0.0.0) und exponiert damit die API, die für Audio-Routing, Signaling und AI-Processing zuständig ist, potenziell ungeschützt im gesamten Netzwerk. Ohne eine im Code belegbare Authentifizierungs-/TLS-Schicht oder Netzwerksegmentierung können unbefugte Clients auf Steuerungs- und Verarbeitu
  - Vorschlag: Uvicorn nur an das interne/private Interface binden (z. B. --host 127.0.0.1 oder eine interne Container-Netzwerkadresse), sofern der Dienst nicht explizit öffentlich erreichbar sein muss. Falls externe Erreichbarkeit erforderlich ist, Authentifizierung, Autorisierung und TLS auf Anwendungsebene bzw.
- [ ] **DA-2026-09-04-195 · HIGH · Unvalidated File Path in `_validate_audio_file`** – `services/backend-core/python/celery_app.py:33` (hf-qwen)
  - Die Funktion `_validate_audio_file` akzeptiert einen Dateipfad ohne ausreichende Validierung gegen Path Traversal Angriffe. Obwohl `os.path.abspath` verwendet wird, fehlt eine strenge Prüfung, ob der Pfad innerhalb eines erlaubten Root-Verzeichnisses liegt.
  - Vorschlag: Füge zusätzliche Sicherheitsprüfungen hinzu, um sicherzustellen, dass der Dateipfad nicht durch symbolische Links oder andere Mechanismen manipuliert werden kann. Überprüfe auch, ob `upload_root` selbst gültig ist und keine relativen Pfade enthält.
- [ ] **DA-2026-09-04-196 · MEDIUM · Race Condition in `_load_demucs`** – `services/backend-core/python/celery_app.py:104` (hf-qwen)
  - In `_load_demucs` gibt es eine Race Condition zwischen dem Check auf `_demucs_cache is not None` und dem eigentlichen Laden des Modells. Zwei Threads könnten gleichzeitig in den kritischen Abschnitt eintreten und denselben Cache laden.
  - Vorschlag: Verwende eine einzige atomare Prüfung mit Lock, z.B. `with _demucs_lock: if _demucs_cache is None: ...` um sicherzustellen, dass nur ein Thread das Modell lädt.
- [ ] **DA-2026-09-04-197 · MEDIUM · Race Condition in `_load_musicgen`** – `services/backend-core/python/celery_app.py:120` (hf-qwen)
  - Ähnlich wie bei `_load_demucs`, gibt es eine Race Condition in `_load_musicgen`. Der Cache-Check vor dem Lock kann zu parallelen Ladevorgängen führen.
  - Vorschlag: Wende dieselbe Strategie wie bei `_load_demucs` an: Prüfe den Cache innerhalb des Locks, um Race Conditions zu vermeiden.
- [ ] **DA-2026-09-04-198 · HIGH · Ungeprüfte Benutzereingabe in JSON-Validierung** – `services/backend-core/python/hypersonic_moa.py:57` (hf-qwen)
  - Die Ausgabe von `raw.strip()` wird direkt an `json.loads()` übergeben, ohne vorherige Prüfung auf gefährliche Inhalte oder unerwartete Strukturen. Dies könnte zu einer Deserialisierungsangriffsszene führen, wenn externe Daten manipuliert werden können.
  - Vorschlag: Fügen Sie zusätzliche Validierungen hinzu, z.B. Prüfung auf erlaubte Schlüsselnamen, Typen und Größenbeschränkungen vor dem Parsen des JSON-Strings.
- [ ] **DA-2026-09-04-199 · MEDIUM · Potential Race Condition in Model Loading** – `services/samplemonk-ai-runtime/app.py:124` (hf-qwen)
  - The background thread `_preload_models_background()` may attempt to access the ModelManager instance while it's still being configured in the main thread during startup, leading to race conditions.
  - Vorschlag: Add synchronization mechanisms such as locks or ensure that the ModelManager is fully initialized and configured before starting the background loading thread.
- [ ] **DA-2026-09-04-200 · HIGH · Sensitive Data Exposure in Error Logging** – `services/samplemonk-ai-runtime/app.py:140` (hf-qwen)
  - The error logging function logs exception details directly into the 'error' field which could expose internal implementation details or paths to clients through structured logs.
  - Vorschlag: Avoid logging raw exceptions or stack traces in production environments. Instead, log only sanitized error messages and use structured logging to capture metadata without exposing sensitive information.
- [x] **DA-2026-09-04-201 · CRITICAL · Lack of Authentication for MCP Tools** → gefixt 2026-09-04 – `services/samplemonk-ai-runtime/app.py:150` (hf-qwen)
  - The /mcp/tools/{tool_name} endpoint allows direct invocation of MCP tools without any authentication or authorization checks, potentially enabling privilege escalation or unauthorized tool usage.
  - Vorschlag: Implement proper authentication and role-based access control (RBAC) checks before allowing invocation of MCP tools. Ensure that only authorized users can execute specific tools based on permissions defined in the system.
- [ ] **DA-2026-09-04-202 · HIGH · Unvalidated User Input in Model ID and Task** – `services/samplemonk-ai-runtime/handlers.py:105` (hf-qwen)
  - Die Funktion `run_inference` akzeptiert `model_id` und `task` direkt aus dem Payload ohne ausreichende Validierung. Dies könnte zu einer unerwarteten Ausführung von Handler-Funktionen führen, wenn `task` manipuliert wird.
  - Vorschlag: Validiere `task` gegen eine whitelist von erlaubten Tasks, um sicherzustellen, dass nur bekannte Handler aufgerufen werden können.
- [ ] **DA-2026-09-04-203 · MEDIUM · Fehlende Fehlerbehandlung bei Audio-Resampling** – `services/samplemonk-ai-runtime/handlers.py:130` (hf-qwen)
  - In `_read_audio` wird bei fehlendem `torchaudio` als Fallback auf lineare Interpolation zurückgegriffen, aber es wird keine explizite Fehlermeldung ausgegeben, falls diese auch fehlschlägt.
  - Vorschlag: Füge eine zusätzliche Fehlerbehandlung hinzu, um sicherzustellen, dass auch der Fallback fehlerhaft abgefangen wird.
- [ ] **DA-2026-09-04-204 · HIGH · Potenzielle Exposition von Secrets in Logs** – `services/samplemonk-ai-runtime/hf_manage_endpoint.py:104` (hf-qwen)
  - Die Funktion `_validate_config()` validiert Umgebungsvariablen, aber keine Secrets wie `HF_TOKEN` werden explizit aus dem Log entfernt. Obwohl das Skript selbst keine Secrets direkt loggt, könnte bei Fehlern oder Debugging-Output durch andere Teile des Systems (z. B. Exceptions) ein Token in Logs landen.
  - Vorschlag: Stelle sicher, dass alle Secrets (insbesondere `HF_TOKEN`) bei Logging oder Fehlerausgaben nicht ausgegeben werden. Verwende z. B. Logging-Filter oder Wrapper, die sensible Daten maskieren.
- [ ] **DA-2026-09-04-205 · MEDIUM · Unsichere Fehlerbehandlung bei `get_inference_endpoint`** – `services/samplemonk-ai-runtime/hf_manage_endpoint.py:122` (hf-qwen)
  - Die Fehlerbehandlung in `main()` prüft nur auf spezifische Textmuster ('404', 'not found') zur Unterscheidung zwischen Nichtvorhandensein und anderen Fehlern. Dies ist anfällig für Änderungen in der API-Antwort und kann zu unerwartetem Verhalten führen.
  - Vorschlag: Nutze stattdessen spezifische Exceptions (z. B. `HfHubHTTPError` mit Statuscode 404) statt String-Prüfung, um sicherzustellen, dass nur wirklich nicht vorhandene Endpunkte als solche behandelt werden.
- [ ] **DA-2026-09-04-206 · MEDIUM · Mangelnde Trennung von Konfiguration und Logik** – `services/samplemonk-ai-runtime/hf_manage_endpoint.py:130` (hf-qwen)
  - Die Konfiguration des Endpoints (`_common_kwargs`, `_create_kwargs`) wird direkt in der Hauptlogik definiert. Dies erschwert Wartung, Testbarkeit und mögliche Wiederverwendung.
  - Vorschlag: Trenne Konfiguration und Logik durch eine Klasse oder Modul, das die Endpoint-Konfiguration kapselt. Dies verbessert die Testbarkeit und Wartbarkeit.
- [ ] **DA-2026-09-04-207 · MEDIUM · Race Condition bei parallelen Load-Requests** – `services/samplemonk-ai-runtime/model_manager.py:130` (hf-qwen)
  - Obwohl es einen `loading`-Set gibt, um parallele Requests zu deduplizieren, besteht ein potenzieller Race Condition, wenn zwei Threads gleichzeitig `load()` aufrufen und beide den gleichen `model_id` haben. Der erste Thread setzt `_loading.add(model_id)` und der zweite prüft darauf, aber beide können den gleichen Status haben.
  - Vorschlag: Verwende eine Lock-basierte Warteschlange oder eine Semaphore, um sicherzustellen, dass nur ein Thread pro Modell gleichzeitig lädt. Alternativ: Füge eine Warteschlange hinzu, die auf den Abschluss des Ladevorgangs wartet.
- [ ] **DA-2026-09-04-208 · MEDIUM · Nicht expliziter Fehlerfall bei fehlender VRAM** – `services/samplemonk-ai-runtime/model_manager.py:190` (hf-qwen)
  - Wenn `required > self._available_vram_gb()` und keine Eviction möglich ist, wird ein `ModelUnavailableError` geworfen. Es fehlt eine explizite Strategie zur Behandlung dieses Falls, was zu unerwarteten Ausfällen führen kann.
  - Vorschlag: Implementiere eine Logging-Strategie oder eine Callback-Funktion, die auf VRAM-Überlastung reagiert, um z.B. eine Notfallstrategie wie 'Fallback auf CPU' oder 'Benachrichtigung an Admin' zu aktivieren.
- [ ] **DA-2026-09-04-209 · MEDIUM · Fehlende Hash-Pins und kein Lockfile für Supply-Chain-Sicherheit** – `services/samplemonk-ai-runtime/pyproject.toml:7` (deepseek-pro)
  - Die Dependencies sind ohne Hash-Verifikation deklariert und es existiert kein sichtbares Lockfile (z. B. poetry.lock oder pip-tools requirements.txt). Dadurch können bei Installation kompromittierte oder bösartige Paketversionen innerhalb der erlaubten Bereiche (z. B. >=4.44,<5) eingespielt werden, ohne dass der Integritätscheck dies verhindert.
  - Vorschlag: Ergänze ein Lockfile mit Hash-Pins (z. B. poetry.lock oder pip-tools mit --generate-hashes) und binde es in den Build/Deployment-Prozess ein. Prüfe außerdem regelmäßig auf bekannte Schwachstellen (z. B. via Dependabot oder pip-audit).
- [ ] **DA-2026-09-04-210 · MEDIUM · Veraltete und exakt gepinnte PyTorch-Version (torch==2.4.1)** – `services/samplemonk-ai-runtime/pyproject.toml:11` (deepseek-pro)
  - Die exakte Pin auf torch==2.4.1 (veröffentlicht Juli 2024) führt dazu, dass bekannte Sicherheitslücken und Stabilitätsprobleme, die in neueren PyTorch-Versionen behoben wurden, dauerhaft im Projekt verbleiben. Da keine automatische Update-Strategie erkennbar ist, bleibt das Risiko bestehen, bis die Version manuell aktualisiert wird.
  - Vorschlag: Aktualisiere auf die neueste stabile PyTorch-Version (z. B. 2.7.x) und prüfe anschließend die Kompatibilität mit den anderen Abhängigkeiten. Erwäge, einen Bereich mit Obergrenze (z. B. >=2.5,<3) zu verwenden, oder behalte die exakte Pin, aber plane regelmäßige Updates und Security-Audits.
- [ ] **DA-2026-09-04-211 · MEDIUM · Revision-Pinning kann durch explizites `null` umgangen werden** – `services/samplemonk-ai-runtime/registry.py:26` (deepseek-flash)
  - Die Validierung fordert eine feste Revision, konvertiert aber `null`/None mit `str()` zu "None". Dadurch wird ein Manifest-Eintrag mit `"revision": null` als gültig akzeptiert, obwohl keine Revision gepinnt wurde. Damit kann die Produktionsregel "feste Revisionen (kein `latest`)" umgangen werden und es können ungewollte oder nicht reproduzierbare Modellversionen geladen werden.
  - Vorschlag: Prüfe den Rohwert vor der String-Konvertierung, z.B.: `revision = model.get("revision")`; lehne ab, wenn `revision is None`, kein String, leer, oder `revision.strip().lower() == "latest"` ist.
- [ ] **DA-2026-09-04-212 · MEDIUM · Working-directory change via dirname $0 breaks when invoked through symlink** – `services/samplemonk-ai-runtime/startup.sh:9` (deepseek-flash)
  - The script cd's to "$(dirname "$0")". If startup.sh is invoked via a symlink (e.g., from /usr/local/bin or a container entrypoint), the working directory becomes the symlink's location, making the subsequent relative default for AI_MODEL_MANIFEST incorrect.
  - Vorschlag: Resolve the script location robustly: SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; cd "$SCRIPT_DIR"
- [ ] **DA-2026-09-04-213 · MEDIUM · No write/space verification for HF_HOME persistent cache** – `services/samplemonk-ai-runtime/startup.sh:10` (deepseek-flash)
  - HF_HOME defaults to /data/hf-cache but the script never creates or checks writability/free space. If the volume is read-only or not mounted, the app starts successfully and model loading fails later at request time, obscuring the configuration error.
  - Vorschlag: After export, add a guard: mkdir -p "$HF_HOME" && [ -w "$HF_HOME" ] || { log structured startup error; exit 1; }
- [ ] **DA-2026-09-04-214 · HIGH · AI_RUNTIME_DEVICE defaults to cuda with no validation** – `services/samplemonk-ai-runtime/startup.sh:13` (deepseek-flash)
  - The script defaults AI_RUNTIME_DEVICE to 'cuda'. In a CPU-only environment or one without the CUDA runtime properly configured, this will either crash at startup or fall back unpredictably. There is also no allowlist validation, so a malformed or attacker-influenced AI_RUNTIME_DEVICE (if variables come from a config-injection surface) could cause unexpected device initialization.
  - Vorschlag: Default to 'cpu' or auto-detect available device; validate against an allowlist (cpu, cuda, mps) before exporting.
- [ ] **DA-2026-09-04-215 · MEDIUM · AI-Runtime lauscht ungeschützt auf allen Interfaces** – `services/samplemonk-ai-runtime/startup.sh:18` (deepseek-pro)
  - Uvicorn wird mit --host 0.0.0.0 gestartet und akzeptiert Verbindungen auf allen Netzwerkinterfaces. Das Skript selbst konfiguriert weder TLS noch Authentifizierung. Jeder mit Netzwerkzugriff kann die AI-Runtime unautorisiert nutzen (Inferenz, Ressourcenverbrauch, möglicherweise Datenabfluss). Wenn der Dienst nur vom Orchestrator-Backend konsumiert wird, ist dies eine unnötige Exposition.
  - Vorschlag: Begrenze den Host auf das interne Netzwerk, z.B. --host 127.0.0.1 bei gleicher Pod-/Container-Netzwerknutzung, oder erzwinge Applikations-Auth/mTLS und sichere Firewall-Regeln.
- [ ] **DA-2026-09-04-216 · MEDIUM · Server binds 0.0.0.0 with no authentication or proxy boundary check** – `services/samplemonk-ai-runtime/startup.sh:21` (deepseek-flash)
  - Uvicorn is started with --host 0.0.0.0. If the service is reachable outside an internal Docker network without an auth gateway, the AI runtime can be called directly. The script does not verify it is behind an authenticated orchestrator/proxy.
  - Vorschlag: Bind to 127.0.0.1 when the service is only meant to be reached through the orchestrator, or document/require a secure internal network with an auth boundary.
- [ ] **DA-2026-09-04-217 · MEDIUM · updateState ist nicht stabil und kann stale lockStatus verwenden** – `src/hooks/usePluginState.ts:28` (deepseek-pro)
  - updateState wird bei jedem Render neu erstellt und schließt den aktuellen lockStatus ein. Wenn der Rückgabewert in memoized Children oder Effects mit leeren Dependencies verwendet wird, kann eine veraltete Lock-Entscheidung getroffen werden. Zudem ist webRTCManager.userId eine externe nicht-reaktive Quelle, deren Änderung keinen Re-Render auslöst.
  - Vorschlag: updateState mit useCallback stabilisieren (Dependencies: [lockStatus.active, lockStatus.lockedBy, pluginId, setModuleState, userId]); userId über React-Context bereitstellen.
- [ ] **DA-2026-09-04-218 · HIGH · Autorisierung nur clientseitig – Lock-Prüfung nicht im Backend erzwungen** – `src/hooks/usePluginState.ts:29` (deepseek-pro)
  - Die Berechtigungsprüfung (nur Owner darf State ändern) findet ausschließlich im Frontend-Hook statt. Dieser Hook ruft setModuleState auf, nachdem er lokal geprüft hat. In einer Multi-User-Architektur mit WebRTC-Replikation kann ein manipulierter Client den Check umgehen und unautorisiert Plugin-State setzen. Es muss serverseitig validiert werden.
  - Vorschlag: Serverseitige Validierung der Lock-Eigentümerschaft im Orchestrator oder im zentralen State-Service erzwingen; der Client-Check dient nur als UX-Sperre.
- [ ] **DA-2026-09-04-219 · MEDIUM · syncAdd sends arbitrary unvalidated sample to remote peers** – `src/hooks/useSessionSync.ts:35` (deepseek-pro)
  - syncAdd accepts `sample: any` and sends it directly via webRTCManager without applying the same id/name/url validation that is enforced for incoming messages. A compromised or buggy local caller can broadcast malformed or untrusted payloads (e.g., non-string URL, oversized object, injection attempts) to all other session users.
  - Vorschlag: Define a strict Sample type and reuse the same validation guard (id string, name string, url undefined or isTrustedMediaUrl) before calling addToScratchpad and sendData. Avoid `any`.
- [ ] **DA-2026-09-04-220 · MEDIUM · Race Condition bei SFU-Modus-Umschaltung** – `src/utils/WebRTCManager.ts:150` (hf-qwen)
  - In `setSfuMode`, wenn der SFU-Modus aktiviert wird, werden bestehende P2P-Verbindungen geschlossen, aber es gibt keine Garantie dafür, dass alle Verbindungen vor dem Umschaltvorgang ordnungsgemäß abgeschlossen wurden. Dies kann zu Zustandsinkonsistenzen führen, insbesondere wenn noch Daten über alte Verbindungen gesendet werden.
  - Vorschlag: Füge eine Wartezeit oder ein Promise-basiertes Schließen hinzu, bevor der SFU-Modus aktiviert wird, um sicherzustellen, dass alle Ressourcen freigegeben wurden.
- [ ] **DA-2026-09-04-221 · MEDIUM · Mögliche Fehlerbehandlung bei SFU-Produzenten** – `src/utils/WebRTCManager.ts:220` (hf-qwen)
  - In `syncSfuSubscriptions` wird bei einem Fehler beim Erstellen eines Tracks nur eine Warnung ausgegeben. Es gibt keine Mechanismen zur Wiederholung oder Fehlerbehandlung, was zu fehlenden Streams führen kann.
  - Vorschlag: Implementiere eine Retry-Logik oder eine Wiederherstellungsmethode, um sicherzustellen, dass fehlgeschlagene Subscriptions später wieder versucht werden.
