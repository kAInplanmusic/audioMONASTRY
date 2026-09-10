# audioMONASTRY MASTER TODO

Last audited: 2026-09-10
Repository: kAInplanmusic/audioMONASTRY
Branch: main @ 9f8e2ef (working tree clean zum Audit-Zeitpunkt)

> Dieses Dokument ist ab sofort die KANONISCHE Ausführungsliste.
> Es wurde aus einem vollständigen Code-gegen-Doku-Audit generiert (CODE = Source of Truth).
> Ersetzt: `MASTERTODO.md` (alt, superseded), Abschnitte aus `TODO.md`/`V2TODO.md`/`VISIONS_TODO.md` (siehe Reconciliation unten).
> Status-Legende: `OPEN` · `IN_PROGRESS` · `DONE` · `BLOCKED` · `PARTIAL` · `STALE` · `NEEDS_VERIFICATION`

---

## CURRENT SYSTEM STATUS

| Ebene | Befund (Code-verifiziert) |
|---|---|
| Build/Type/Lint/Test | `tsc --noEmit` 0 Fehler · `eslint --max-warnings=0` 0 · Vitest **159 Dateien / 996 Tests grün** · `npm audit` 0 · Boundary-Scan 393 Dateien 0 Verstöße · `npm run build` grün (Vite + 32 Worklets + esbuild-Server) |
| Live-Audio-Gate | `npx playwright test tests/e2e/v2-live.spec.ts --headed` **1 passed (19,7 s)** – V2LiveSink im echten AudioWorklet verbunden, Play/Stop real (nach AUDIO-P0-001…004) |
| Audio-Engine | Live-Pfad: `audioEngine.play()` → `V2LiveSink` → `v2-sink-processor` (AudioWorklet) → `V2SinkEngine` (`V2MonitorGraph` + **Master-Kette EQ→DSP→FX→Dynamics→Mastering** + `V2OutputGraph` + `V2SampleClock`). **Phase 9 umgesetzt:** kein V1-Transport, keine No-Op-Synth-/Mastering-Kette, kein Legacy-Doppelpfad zur Destination mehr. `nativeAudioKit` dient nur noch als Zustandsträger der Terminal-Facade |
| MONK-Architektur | 16er-Registry + 3 System-Module **im Code verifiziert** (`registry.ts`, `plugin-manifest.json`, `App.tsx`, `rolePresets.ts`, `legacyAliases.ts`) |
| MIDI | Kein MIDI-/Controller-Plugin; Settings → MIDI/Controllers (`SettingsDialog` + `MIDIControllerTerminal`) |
| Security | Fail-closed Auth implementiert (`server.ts` 298–382, 2302–2313), Zod-Validierung der Haupt-Routen, CI-Actions SHA-gepinnt |
| Collaboration | Socket.io-Relay + Plugin-Locks (in-memory), optionaler Redis-Adapter; **kein** serverautoritativer State (Revision/Sequence/Snapshot) |
| AI | ProviderRouter (HF/Serverless, Replicate, RunPod, local, deterministic, cerebras); RunPod-Endpoint `uzg7p9lm890ts8`; Live-Inferenz nicht in dieser Session ausgeführt |

**Kernbefund (Phase 1D, nach AUDIO-P0-001…004):** Der V2-Live-Pfad enthält jetzt **Gain/Pan/Master/Monitor/2.1 + Master-Processing-Kette (EQ→DSP→FX→Dynamics→Mastering) + rollenbasierte Drum-Stimmen (kick/hat/clap/bass) + Mute + hörbare Trigger/Preview/Instrument-Pfade + Master-Stream-Tap am V2-Ausgang**. Offen bleiben: Seek, echte 4-User-/Hardware-/RunPod-Live-Verifikation und der Abbau der toten V1-Zweige. Phase 9 („V1-Code vollständig löschen") bleibt **BLOCKED**, bis AUDIO-P1-001…003 und COLLAB-P0 erledigt sind (Details: `V1_REMOVAL_REPORT.md`).

---

## P0 — RELEASE BLOCKERS

### AUDIO-P0-001 — V2-Drum-Synthese (kick/hat/clap/bass) in den Live-Sink portieren
- **Status:** DONE (2026-09-10, implementiert + Tests + Live-Gate) · **Priority:** P0 · **Area:** Audio Runtime
- **Problem:** Im V2-Live-Pfad spielen Pattern-Steps ohne Sample auf allen Kanälen einen 440-Hz-Sinus-Burst (`v2SinkProcessor` → `getSynthSource`-Default). Die V1-Stimmen (MembraneSynth/MetalSynth/NoiseSynth/MonoSynth) sind über `nativeAudioKit` No-Ops. Der hörbare „Drum-Loop" ist in V2 faktisch ein Sinus-Piepser.
- **Current state:** `setSynthSource()` wird produktiv nie aufgerufen; `V2SinkEngine.renderStepBurst()` erzeugt nur Sinus + Exp-Decay; `drumSynthProcessor` existiert, ist aber nicht angebunden.
- **Required change:** Pro Kanal eine synthetische Stimme (kick/hat/clap/bass) im Worklet rendern oder `drumSynthProcessor` als V2-Quelle verdrahten; `synthSources`/Rollen-Mapping in `syncV2PatternsToLiveSink()` bzw. `v2SinkProcessor` speisen.
- **Files/components:** `src/core/audio/live/V2SinkEngine.ts`, `src/audio/worklets/v2SinkProcessor.ts`, `src/utils/audioEngine.ts`, `src/audio/worklets/drumSynthProcessor.ts`
- **Dependencies:** keine
- **Acceptance criteria:** (a) kick/hat/clap/bass sind als unterscheidbare Stimmen hörbar (Worklet-Level-Test: Spektral-/RMS-Signatur je Rolle); (b) kein Kanal fällt auf 440-Hz-Default zurück; (c) bestehende 990 Tests grün.
- **Verification:** neue Tests in `tests/v2SinkEngine.test.ts` + headed Live-Gate mit Pattern-Play und Audio-Capture.
- **Risk:** hoch (hörbare Änderung) · **Rollback:** Feature-Flag `V2_DRUM_SYNTH` oder Commit-Revert.

### AUDIO-P0-002 — Master-Stream-Tap auf den V2-Pfad legen (WebRTC/SFU hörbar machen)
- **Status:** DONE (2026-09-10, V2-Tap implementiert; 4-User-Live-Beweis offen) · **Priority:** P0 · **Area:** Audio Output / Collaboration
- **Problem:** `createMasterStreamDestination()` greift `masterStreamTap` ab – das Ende der Legacy-Worklet-Kette aus `init()`, deren Eingang über No-Op-`nativeAudioKit`-Knoten läuft. Im V2-Modus ist der Master-Stream daher **stumm**; andere User/SFU erhalten kein Master-Audio.
- **Current state:** `v2LiveSink.connect()` verbindet das Sink-Worklet direkt mit `ctx.destination`, nicht mit `masterStreamTap`/`MediaStreamDestination`.
- **Required change:** V2-Ausgang (Worklet-Output oder ein Tap dahinter) in `masterStreamTap`/`createMasterStreamDestination` einspeisen; genau EINE hörbare Quelle für Main-Out und Master-Stream.
- **Files/components:** `src/utils/audioEngine.ts` (`init`, `connectV2LiveOutput`, `createMasterStreamDestination`), `src/core/audio/backends/V2LiveSink.ts`
- **Dependencies:** AUDIO-P0-004 (Legacy-Kette)
- **Acceptance criteria:** (a) `MediaStreamAudioDestinationNode` trägt nach `play()` Nicht-Stille (E2E/Headed-Check via Analyser); (b) `useMasterStream` → SFU-Track enthält V2-Audio; (c) kein Doppel-Pfad auf `ctx.destination`.
- **Verification:** headed E2E `masterStream.spec.ts` (neu) + Unit-Test mit gemocktem `AudioContext`.
- **Risk:** hoch (Kollaborations-Kern) · **Rollback:** Commit-Revert.

### AUDIO-P0-003 — Trigger, Preview und Instrument müssen im V2-Modus hörbar sein
- **Status:** DONE (2026-09-10, Trigger/Preview/Instrument auf V2-Sink verdrahtet) · **Priority:** P0 · **Area:** Audio Runtime / Terminals
- **Problem:** (a) `triggerEvent()` im V2-Modus rendert nur einen Offline-Block (`graphPlayback.trigger`), der nirgends ausgegeben wird; (b) `previewSample(url)` erzeugt `new Tone.Player(url).toDestination()` – ein No-Op; (c) `playSynthesisInstrument`/`itSynthNode` endet auf No-Op-`Tone.Gain`/Kanalzug und ist im V2-Modus stumm.
- **Current state:** Pad-Trigger, Sample-Vorhorchen und Instrument-Play sind UI-seitig vorhanden, aber auditiv wirkungslos.
- **Required change:** Alle drei Pfade auf `v2LiveSink`-Messages umstellen (`sample-trigger`, `synth-source`, `sfz-load/note-on` oder dedizierte Worklet-Voices).
- **Files/components:** `src/utils/audioEngine.ts`, `src/core/audio/backends/V2LiveSink.ts`, `src/audio/worklets/v2SinkProcessor.ts`, betroffene Terminals (`McpTerminal`, `InstrumentsTerminal`, `LibraryTerminal`)
- **Dependencies:** AUDIO-P0-001
- **Acceptance criteria:** (a) Pad-Trigger erzeugt hörbaren V2-Sample-/Synth-Sound; (b) Library-Preview hörbar; (c) Instrument-Note-On hörbar; (d) jeweils mit Worklet-Level- oder headed-Test belegt.
- **Verification:** neue Unit-Tests (`v2SinkEngine`) + headed E2E.
- **Risk:** hoch · **Rollback:** Commit-Revert.

### AUDIO-P0-004 — Legacy-Worklet-Kette in `init()` abbauen bzw. an V2 verdrahten
- **Status:** DONE (2026-09-10, Master-Kette EQ→DSP→FX→Dynamics→Mastering im V2-Live-Graph; vollständiger Legacy-Ketten-Abbau → AUDIO-P1-001) · **Priority:** P0 · **Area:** Audio Runtime / Architektur
- **Problem:** `init()` baut bei jedem Start eine komplette parallele Kette (toneShift→effect→dynamics→eq→mastering→dsp→lufs→analyzer→destination) auf, deren Eingang No-Op ist. Sie verbraucht CPU (Worklets laufen leer), täuscht Verdrahtung vor und trägt den stummen `masterStreamTap`. EQ/DSP/FX/Mastering-UI-Aktionen wirken nur auf diese tote Kette – nicht auf den hörbaren V2-Pfad.
- **Current state:** Kette existiert in `src/utils/audioEngine.ts` (Z. 471–621); `nativeAudioKit`-Knoten (Volume/Filter/Compressor/Limiter) sind reine Zustandsobjekte ohne Audio.
- **Required change:** Entweder (bevorzugt) EQ/DSP/FX/Dynamics/Mastering als V2-Nodes in `V2SinkEngine`/`V2MonitorGraph` aufnehmen und die Legacy-Kette löschen, oder (interim) die Legacy-Kette real verdrahten. Analyzer/LUFS-Telemetrie auf den V2-Pfad umhängen.
- **Files/components:** `src/utils/audioEngine.ts`, `src/core/audio/live/V2SinkEngine.ts`, `src/core/audio/V2MonitorGraph.ts`, `src/core/audio/nodes/processingNodes.ts`, `src/core/audio/worklets/*`
- **Dependencies:** AUDIO-P0-001/002/003
- **Acceptance criteria:** (a) EQ/DSP/FX/Mastering-Parameter ändern das V2-Live-Audio messbar; (b) `init()` erzeugt keine tote Parallelkette mehr; (c) CPU-Last im Idle sinkt (Profilmessung); (d) 990 Tests grün.
- **Verification:** Worklet-Level-Parity-Tests + headed Live-Gate + CPU-Messung.
- **Risk:** hoch (Kernpfad) · **Rollback:** Commit-Revert.

### COLLAB-P0-001 — Serverautoritativer Session-State (Revision/Sequence/Snapshot)
- **Status:** OPEN · **Priority:** P0 · **Area:** Collaboration
- **Problem:** `server.ts` relaisiert `plugin-state` nur; es gibt keine Revision/Sequence, keinen Voll-Snapshot für Reconnects, kein deterministisches Verwerfen veralteter Events, keine atomaren Locks über Instanzen hinweg (Locks liegen in lokaler Map).
- **Current state:** `pluginLocks` = `Map` mit TTL (server.ts Z. 184); Redis-Adapter nur für Socket-Fanout; `join-session` sendet nur Lock-Snapshot.
- **Required change:** Session-State mit Revision/Sequence/Sender/Timestamp/Event-ID, Snapshot bei Join/Reconnect, Lock-Vergabe/-Verlängerung/-Freigabe atomar, Redis-Backup für State+Locks, Host-/Admin-Determinismus.
- **Files/components:** `server.ts`, `src/core/session/*`, `src/utils/collab.ts`
- **Dependencies:** keine
- **Acceptance criteria:** (a) 4 parallele User: State konsistent, Locks korrekt, Reconnect ohne Pumping; (b) Server-Neustart/2 Instanzen mit Redis: kein State-Verlust; (c) verspätete/doppelte Events werden deterministisch verworfen.
- **Verification:** `tests/collab*.test.ts` erweitern + `tests/e2e/collab.spec.ts` Live.
- **Risk:** hoch · **Rollback:** Commit-Revert.

### COLLAB-P0-002 — 4-User-Live-E2E gegen echte Instanz
- **Status:** BLOCKED (kein 4-User-Live-Target in dieser Session) · **Priority:** P0 · **Area:** Collaboration
- **Problem:** Nur lokale/Mock-Collab-Tests; 4-User-Szenario nie live verifiziert.
- **Required change:** Live-Run (Hetzner oder lokal 4 Browser) dokumentieren; State-Sync, Lock-Denial, Reconnect, RBAC, Main/Cue prüfen.
- **Acceptance criteria:** protokollierter Lauf mit 4 Clients, 0 Desync, Locks/RBAC greifen.
- **Verification:** `tests/e2e/collab.spec.ts`, `live2browser.spec.ts`.
- **Risk:** mittel · **Rollback:** n/a (Test).

### COLLAB-P0-003 — WebRTC/SFU/TURN-Härtung
- **Status:** OPEN · **Priority:** P0 · **Area:** Networking
- **Problem:** ICE-Server hartkodiert (nur STUN, `AudioContext.tsx` Z. 139–143), keine kurzlebigen TURN-Credentials, `iceConnectionState`/`connectionState` nicht vollständig behandelt, Reconnect kann doppelte PeerConnections erzeugen.
- **Required change:** ICE/TURN aus Server-Config (`/api/webrtc-config`), TURN-Credentials serverseitig kurzlebig, Zustandsmaschine für ICE/Connection/Signaling, Backoff-Reconnect, Fallback P2P→SFU→Fehler.
- **Files/components:** `src/context/AudioContext.tsx`, `src/utils/WebRTCManager.ts`, `server.ts`, `src/core/transport/MediasoupTransport.ts`
- **Acceptance criteria:** Tests für ICE-Fehler, Reconnect, TURN-Konfig, Main-Stream-Wiederherstellung.
- **Verification:** Unit + E2E.
- **Risk:** hoch · **Rollback:** Commit-Revert.

---

## P1 — MUST VERIFY / MUST FIX

### AUDIO-P1-001 — Tote V1-Transport-/Scheduler-Zweige aus `audioEngine` entfernen
- **Status:** DONE (2026-09-10, Phase 9: V1-Transport/Scheduler, No-Op-Synths, Fake-Mastering-Kette und Legacy-Doppelpfad entfernt) · **Area:** Audio Cleanup
- **Problem:** `play()/stop()/triggerEvent()/tick()/processEvent()` enthalten nicht erreichbare V1-Zweige (Mode ist immer `v2`), inkl. `Tone.Transport`-Scheduler, `kickSynth`-Fallbacks etc.
- **Required change:** V1-Zweige und tote No-Op-Synth-Felder löschen; `AudioPlaybackMode`-Zweige konsolidieren.
- **Acceptance criteria:** keine `playbackMode === 'v2'`-else-Zweige mehr; Typecheck/Test grün.
- **Verification:** `npm run verify`.
- **Risk:** mittel · **Rollback:** Commit-Revert.

### AUDIO-P1-002 — `audioEngine`-Facade (3444 LOC) in Module zerlegen
- **Status:** OPEN · **Area:** Audio Architektur
- **Problem:** 35+ Dateien importieren `utils/audioEngine`; Monolith vermischt Zustand, Verdrahtung, Worklet-Setup und V2-Sync.
- **Required change:** Split nach Zustand/Session, V2-Sync, Worklet-Verwaltung, Master-Stream; API stabil lassen.
- **Acceptance criteria:** `audioEngine.ts` < 1500 LOC; Importeure unverändert; Tests grün.
- **Verification:** `npm run verify`, `knip`.
- **Risk:** mittel · **Rollback:** Commit-Revert.

### AUDIO-P1-003 — `nativeAudioKit` nur noch dort erlauben, wo es real gebraucht wird
- **Status:** PARTIAL (2026-09-10, Phase 9: keine No-Op-Nodes mehr im Live-Signalweg; verbleibende Klassen sind reine Zustandsträger der Terminal-Facade) · **Area:** Audio Cleanup
- **Problem:** Die Tone-kompatible No-Op-Facade verschleiert stumme Pfade; nach P0-001…004 dürfen keine No-Op-Nodes mehr im Produktions-Signalweg liegen.
- **Required change:** No-Op-Klassen aus dem Live-Pfad entfernen; verbleibende Nutzung nur für Zustands-Serialisierung/Tests dokumentieren.
- **Acceptance criteria:** kein `new Tone.Volume/Gain/Player/Compressor/…` im Live-Audio-Pfad; Boundary-Test.
- **Verification:** grep-basierter Test + `npm run verify`.
- **Risk:** mittel · **Rollback:** Commit-Revert.

### AI-P1-001 — RunPod-Cutover validieren, erst dann Replicate/HF entfernen
- **Status:** PARTIAL (Endpoint existiert, Smoke-Test früher grün; BS-RoFormer + Failover offen) · **Area:** AI
- **Problem:** Replicate-/HF-Code darf nicht entfernt werden, bevor RunPod (inkl. BS-RoFormer-GPU, Timeout/Retry/Cost-Limits) nachweislich ersetzt.
- **Required change:** RunPod-E2E-Smoke, Failover-/Timeout-Tests, Kosten-Limits, Job-Status-Persistenz; danach Provider-Entfernungs-Entscheidung.
- **Acceptance criteria:** RunPod-Inferenz E2E grün; Replicate/HF-Entfernung als eigener, revertierbarer Schritt.
- **Verification:** `scripts/runpod-smoke.py` (neu: `RUNPOD_SMOKE_ROLE=<role>`), `tests/ai*.test.ts`.
- **Risk:** mittel · **Rollback:** Provider-Code bis Cutover behalten.
- **Update 2026-09-10:** Flotte auf 3 Rollen umgebaut (`docs/RUNPOD_AI_V1_SPEC.md`):
  brain/ears/voiceGen, `AI_MAX_GPU_ENDPOINTS=3`, rollenfähiger Provider, Session-Wake.
  Endpoints müssen noch deployt werden; der Alt-H200-Endpoint `uzg7p9lm890ts8` läuft
  weiter als Legacy-Fallback (`RUNPOD_ENDPOINT_ID`).

### AI-P1-003 — Flotten-Restpakete nach dem 3-Rollen-Umbau
- **Status:** PARTIAL (Flotte deployt + getestet 2026-09-10; Restpakete offen) · **Area:** AI / GPU-Flotte
- **Erreicht (2026-09-10):** Image `ghcr.io/kainplanmusic/samplemonk-ai-runtime-runpod@1391e4d2` gebaut;
  Endpoints `samplemonk-ai-brain` (`ppxo7wrn599p0q`), `-ears` (`xeax6xrgd0csag`),
  `-voice` (`gajmangfldpzrk`) mit `AMPERE_48`, `workers 0..1`, `idle 15 min` angelegt;
  Rollen-Smoke je Rolle grün (jede Rolle lädt **nur** ihre Preload-Modelle); alles wieder
  abgeschaltet ($0/h). Details: `logs/run-2026-09-10/RUN_PROTOKOLL.md`.
- **Problem:** Der Umbau ist implementiert und läuft, aber mehrere Punkte sind bewusst
  offen gelassen (siehe `docs/RUNPOD_AI_V1_SPEC.md` §6).
- **Required change:**
  0. **CI-Deploy reparieren:** Der Actions-`deploy`-Job ist rot (Läufe #6/#7/#8), weil
     vermutlich das Repo-Secret `RP_API_KEY` fehlt. Preflight-Check ist im Workflow
     eingebaut; Secret im Repo setzen. Lokales Deploy funktioniert. Zusätzlich:
     `GHCR_PASSWORD` in `.env` ist ein fine-grained PAT und für GHCR-Push unbrauchbar.
  0b. **vLLM ins Brain-Image** (`AI_INSTALL_VLLM=1`) und `RUNPOD_BRAIN_OPENAI_URL` setzen —
     ohne vLLM kann der Brain-Worker keinen OpenAI-kompatiblen LLM-Endpunkt bedienen,
     d. h. `runpod-local` in `src/core/ai/LlmRouter.ts` bleibt funktionslos.
  1. **Revisions-Pins** für `qwen3-32b`, `qwen3-30b-a3b`, `glm-4.5-air`, `mert-v1-95m`, `fish-speech`, `rvc` eintragen (derzeit `status: "planned"` → werden nicht geladen).
  2. **Benchmark-Gate Voice DE/EN + Gesang** (AuditEval/AuditScore + MOS) → Voice-Modell fixieren.
  3. **Benchmark-Gate Brain**: 50–200 echte MCP-Aufgaben DE/EN; bei Durchfall GLM-4.5-Air-Upgrade (2×A6000, `gpuCount=2`).
  4. **Batch-Indexer** für `public.sample_audio_embeddings` (Migration 007) — ohne ihn bleibt die
     Ähnlichkeitssuche im dropMONK leer (`sample_audio_embedding_stats()` macht den Grad sichtbar).
  5. **aiMONK-Agent-Loop**: mehrstufig planen → ausführen → prüfen → korrigieren, Kontext-Assembly
     (16 Plugin-IDs, `routing.json`, Session-/Projektzustand, Locks/RBAC), Bestätigungspflicht ab `WRITE`.
  6. `PATCH {RUNPOD_REST_BASE}/endpoints/{id}` (Session-Wake) gegen die echte RunPod-API-Shape verifizieren
     — fällt bei Fehlschlag auf den Warmup-Job allein zurück (dann kein Warmhalte-Schutz).
- **Acceptance criteria:** Pins echt (kein `TBD-`), beide Benchmark-Gates dokumentiert, Indexer füllt
  `sample_audio_embeddings`, Agent-Loop führt eine 3-Schritt-Aufgabe fehlerfrei aus.
- **Verification:** `tests/manifestRoles.test.ts`, `scripts/runpod-smoke.py --role`, `npm run verify`.
- **Risk:** mittel · **Rollback:** Rollen bleiben einzeln abschaltbar (`AI_FLEET_WAKE=0`, Legacy-Endpoint).

### AI-P1-002 — AI-Runtime async/isoliert vom Audio-Thread
- **Status:** OPEN · **Area:** AI Runtime
- **Problem:** AI-Aufrufe können UI-/Audio-Flow blockieren (kein Executor-Worker).
- **Required change:** Queues/Timeouts/Cancellation/Worker für AI-Jobs; Audio-Thread bleibt unberührt.
- **Acceptance criteria:** AI-Job blockiert nie den Render-Thread (Test mit Last).
- **Verification:** `tests/ai*.test.ts` + Profiling.
- **Risk:** mittel · **Rollback:** Commit-Revert.

### SEC-P1-001 — Zod-Validierung auf ALLE externen Payloads ausweiten
- **Status:** PARTIAL (Haupt-Routen validiert; Upload-/Session-/Sonstige-Pfade prüfen) · **Area:** Security
- **Required change:** restliche `req.body`-Pfade (Upload, Sonstige) auf `safeParse`; keine `as any`-Casts auf externe Bodies.
- **Acceptance criteria:** Negativ-Tests 400 statt 500; grep-Nachweis.
- **Verification:** `tests/security*.test.ts`, `tests/zodSchemas.test.ts`.
- **Risk:** niedrig · **Rollback:** Commit-Revert.

### HW-P1-001 — Xonar U7 / 2.1 / Hotplug Live-Test
- **Status:** BLOCKED (Hardware nicht in dieser Session) · **Area:** Hardware
- **Acceptance criteria:** 2.1-Layout stabil nach Reload; Sub <80–120 Hz; Device-Switch/Reconnect; CPU-Fallback ohne WebGPU.
- **Verification:** `tests/e2e/hardware.spec.ts` + manueller Lauf.

### UI-P1-001 — Mobile-/Browser-Matrix verifizieren
- **Status:** OPEN · **Area:** UI
- **Required change:** Touch-Ziele, Safe-Area, Keyboard/Focus/Screenreader, `prefers-reduced-motion`, Safari/WebKit/iOS/Android-Prüfung.
- **Verification:** `playwright.responsive.config.ts`, manuelle Geräte-Tests.

### DB-P1-001 — Supabase-Live-Abgleich + RLS-Verifikation
- **Status:** OPEN · **Area:** Database
- **Required change:** Migrationen 001/002 auf Live anwenden, RLS/Indizes prüfen, Session-/User-Ownership testen.
- **Verification:** `tests/supabaseRls.test.ts`, `scripts/verify-supabase.ts`.

### CI-P1-001 — E2E in CI + Secret-Scan
- **Status:** PARTIAL (Actions SHA-gepinnt; E2E nicht in CI; Secret-Scan fehlt) · **Area:** CI/CD
- **Required change:** E2E-Smoke in CI (nicht überspringbar), Secret-Scan, Dependency-Review.
- **Verification:** `.github/workflows/*.yml`.

---

## P2 — QUALITY / HARDENING

- **QUAL-P2-001:** Dead-Code-Bereinigung: `knip`-Liste (144 Einträge) klassifizieren; echte Dead Files (z. B. `B2BModal.tsx`, `MasterTrackTerminal.tsx`, `SampleMonkLogo.tsx`, `ModuleContainer.tsx`, `RoomPlannerPanel.tsx`) nach Import-Check entfernen; Worklet-/WAM-Assets als bewusste Runtime-Assets markieren.
- **QUAL-P2-002:** jscpd-Duplikate (15) reduzieren.
- **DOC-P2-001:** Dokumentations-Zahlen synchronisieren (README/PRODUCTION_READINESS/TODO: 990 Tests, Live-Gate 24,7 s, knip-Realität); „Tone.js vollständig entfernt" präzisieren (npm-Paket entfernt, No-Op-Facade `nativeAudioKit` bleibt bis P0-004).
- **MIDI-P2-001:** MIDI-Mapping-Layer vollständig dokumentieren/testen; Hardware-Hörprobe (TR-8S/Beatstep) bei Verfügbarkeit.
- **OPS-P2-001:** GHCR-Credentials erneuern (User-Aktion); HF-Secret-Rotation vor RunPod-Cutover.
- **SEC-P2-001:** Cookie-Sicherheit serverseitig dokumentieren; SHA-Pinning für alle Workflows bestätigen.

---

## P3 — OPTIMIZATION

- Worklet-CPU-Budgets nach P0-004 (Legacy-Kette weg) neu messen.
- Vitest-Laufzeit (40 s) und Bundle-Größe weiter optimieren.
- Optionale Synthese-/DSP-Bausteine (E-Piano, Phase-Distortion, Mod-Matrix, HQ-Reverb) – Backlog.

---

## P4 — FUTURE / BACKLOG

- VISIONS V1.1–V1.10 (WASM-SIMD-DSP, WebCodecs, WebTransport, WebGPU-Spektral, Hybride Engine, OPFS-Cache, MPE, DAWproject-Export, Tauri, CRDT) – nur nach Benchmark + Aufnahmekriterien.
- VISIONS V2 (ONNX/WASM-Runtime, KI-Co-Producer, Spatial 24.2, Session-Cloud, Broadcast-Modus).
- VISIONS B1–B8 (Patch-Bay-Router, Hardware-Clock, Steckmodul-Hub, Auto-Codegen, Edge-AI-NPUs, analog/digital, Routing-Vorschläge, Paritätstest).

---

## DONE / VERIFIED

- 🟢 Build/Typecheck/Lint/Test/Audit/Boundary-Scan grün (990 Tests).
- 🟢 V2-Live-Gate headed grün (Play/Stop real, V2LiveSink verbunden).
- 🟢 `tone` aus `package.json`/`node_modules` entfernt; `GraphEngineAdapter` + Test entfernt; V1-Feature-Flags erzwingen `v2`.
- 🟢 16-MONK-Registry + System-Module (masterplayer/ai/perfor) + MIDI-in-Settings code-verifiziert.
- 🟢 Fail-closed Production-Auth (503 `STUDIO_TOKEN_MISSING`), Origin-Allowlist, Socket-Handshake-Auth.
- 🟢 Zod-Validierung der Haupt-API-/Socket-Pfade.
- 🟢 npm audit 0; CI-Actions SHA-gepinnt.
- 🟢 Vitest-Timeout-Budgets (`testTimeout` 15 s, `maxWorkers` 4).

## STALE TODO REMOVED

- ⚫ „knip 0 Findings" → falsch; Standard-`knip` meldet 144 ungenutzte Dateien (teils Worklet-/WAM-Runtime-Assets, teils echter Dead Code). Durch QUAL-P2-001 ersetzt.
- ⚫ „954 Tests grün" → Stand veraltet; aktuell 990 Tests.
- ⚫ „Tone.js vollständig entfernt" → nur bedingt korrekt: npm-Paket entfernt, aber `nativeAudioKit`-No-Op-Facade bleibt im Produktionscode (AUDIO-P1-003).
- ⚫ TODO.md §9 „Prüfpunkte vor dem nächsten Run" Punkt 6 (957 Tests) → Zahl veraltet.
- ⚫ `docs/audioEngine-split-plan.md` (23 offene Checkboxen) → durch V2-Module überholt; historisch aufbewahren, nicht mehr ausführen.
- ⚫ `MASTERTODO.md` (alt) → durch dieses Dokument ersetzt.

## DEPRECATED / DELETE

- 🗑️ `src/components/B2BModal.tsx`, `MasterTrackTerminal.tsx`, `SampleMonkLogo.tsx`, `ModuleContainer.tsx`, `RoomPlannerPanel.tsx` u. a. – Kandidaten aus `knip`; **erst nach Import-/Referenz-Check löschen** (QUAL-P2-001).
- 🗑️ No-Op-Klassen in `nativeAudioKit` (Synths/Player/Compressor/Limiter), sobald P0-001…004 deren Nutzung im Live-Pfad beseitigt haben.
- 🗑️ Replicate-/HF-Provider-Code – NUR nach validiertem RunPod-Cutover (AI-P1-001).

## UNKNOWN / HUMAN VERIFICATION

- ❓ Echtes 4-User-Live-Szenario (Audio-Stream, Locks, RBAC, Reconnect) – kein Live-Target in dieser Session.
- ❓ Physische Hardware (Xonar U7, 2.1, MIDI-Controller) – nicht vorhanden.
- ❓ RunPod-Live-Inferenz (Kosten) – Endpoint konfiguriert, nicht ausgeführt.
- ❓ Cookie-Sicherheit im Portal-Worker (HttpOnly/Secure/SameSite) – serverseitig zu verifizieren.
- ❓ Reale Hörqualität der V2-Drum-/Synth-Stimmen nach AUDIO-P0-001 – Mensch/Hörtest.

## ARCHITECTURE DECISIONS

1. **V2 ist der einzige Produktiv-Audiopfad.** V1 = entfernt (npm/Tone), ABER die No-Op-Facade und die tote Legacy-Kette müssen erst durch P0-001…004 ersetzt werden. Bis dahin gilt: „V2-only" ≠ „V2-vollständig".
2. **MIDI ist kein MONK.** Pfad: Settings → MIDI-Runtime → Mapping → Routing → MONK/Transport/Parameter.
3. **16 + 3:** 16 Plugin-IDs + System-Module `masterplayer`/`ai`/`perfor`; Registry ist einzige Quelle.
4. **Master-Stream-Tap gehört an den V2-Ausgang** (nicht an die Legacy-Kette) – AUDIO-P0-002.
5. **Kein Feature wird als „DONE" geführt, solange es nur im Zustand, nicht im hörbaren V2-Pfad wirkt.**

## RELEASE GATE

1. `npm run typecheck` grün
2. `npm run lint` grün (0 Warnings)
3. `npm test` grün (990)
4. `npm run security` grün (audit 0 + Boundary-Scan 0)
5. `npm run build` grün
6. `npx playwright test tests/e2e/v2-live.spec.ts --headed` grün
7. **NEU:** Audio-P0-001…004 abgenommen (hörbare Drums, EQ/DSP/Mastering im V2-Pfad, Master-Stream trägt Audio, keine tote Legacy-Kette)
8. Live-Gates: 4-User-Collab, 2.1/Hardware, AI/RunPod
