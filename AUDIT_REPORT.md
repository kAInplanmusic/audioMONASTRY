# AUDIT REPORT — audioMONASTRY Full Code-vs-Documentation Audit

Datum: 2026-09-10
Repository: kAInplanmusic/audioMONASTRY · Branch: main @ 9f8e2ef
Modus: Audio-Engine-Code-Audit (audioaudit Modus D) + Release-Readiness
Regel: CODE = Source of Truth. Kein Feature gilt als fertig, nur weil Doku/Tests es behaupten.

---

## 1. Executive Summary

- Das Repository ist **build- und testgesund**: Typecheck 0, Lint 0 (max-warnings=0), Vitest **990/990 grün (159 Dateien)**, npm audit 0, Boundary-Scan 393 Dateien 0 Verstöße, Production-Build grün, **V2-Live-Gate headed grün (24,7 s)**.
- Die **16-MONK-Architektur + 3 System-Module** ist im Code korrekt umgesetzt; MIDI ist kein Plugin.
- **Aber:** Der V2-Live-Audiopfad ist funktional **unvollständig**. Er trägt nur Gain/Pan/Master/Monitor/2.1. EQ, DSP, FX, Dynamics, Mastering, Drum-Synthese, Mute/Solo, Trigger/Preview/Instrument-Audio und der Master-Stream-Tap sind im Live-Pfad **stumm oder unwirksam**. Die „V1-Entfernung" wurde über eine No-Op-Facade (`nativeAudioKit`) erreicht — nicht über echte V2-Parität.
- **V1-Removal-Entscheidung: NOT READY. Es wurde nichts Destruktives gelöscht.**
- Erstellt wurden: `MASTER_TODO.md` (kanonisch), `V1_REMOVAL_REPORT.md`, dieses `AUDIT_REPORT.md`.

## 2. Actual Architecture (Code-verifiziert)

```
UI (App.tsx: masterplayer-Leiste → 16 Plugin-Rack → perforMONK → aiMONK-Dock)
  ↓
Terminals/Adapter (src/plugins/adapters, src/components/*)
  ↓
audioEngine-Facade (src/utils/audioEngine.ts, 3444 LOC, Proxy mit auto-syncV2FromV1)
  ↓                      ↓
Zustand (patterns, gains,  V2-Live-Pfad (V2LiveSink → v2-sink-processor → V2SinkEngine)
mutedStems, monitorPlan)    V2SinkEngine = V2MonitorGraph (Gain/Pan/Sum) + V2OutputGraph (2.1) + V2SampleClock
  ↓                      ↓
Legacy-Worklet-Kette      ctx.destination
(init(): effect/dynamics/eq/mastering/dsp/lufs/analyzer → masterStreamTap → destination)
```

```
Frontend → Session State (Socket.io plugin-state relay + pluginLocks Map in server.ts)
         → WebRTC/SFU (AudioContext.tsx P2P + MediasoupTransport; ICE nur STUN hartkodiert)
         → andere User (Master-Stream via masterStreamTap — im V2-Modus STUMM)
```

```
Frontend → AI ProviderRouter (HF/Serverless, Replicate, RunPod, local, deterministic, cerebras)
         → RunPod Endpoint uzg7p9lm890ts8 (HOPPER_141) / Replicate / HF
```

**Grenzen:** Server `server.ts` (124 KB, Express+Socket.io+Mediasoup) vs. Client `src/`; Audio-Grenze = AudioWorklet (`v2-sink-processor`); State-Grenze = Socket.io; AI-Grenze = ProviderRouter; Persistenz = Supabase/R2.

## 3. Audio Engine Status

| Pfad | Status | Beweis |
|---|---|---|
| V2-Live-Transport | 🟢 VERIFIED | `v2-live.spec.ts` headed grün; `V2SampleClock` + `v2SinkProcessor` |
| V2-Sample-Playback (Pattern) | 🟢 IMPLEMENTED | `sample-set`/`triggerSample` im Worklet; `syncV2SamplesToLiveSink` |
| V2-Drum-Synthese (kick/hat/clap/bass) | 🔴 TODO | nur 440-Hz-Sinus-Burst; `setSynthSource` produktiv nie gesetzt |
| EQ/DSP/FX/Dynamics/Mastering im Live-Pfad | 🔴 TODO | Nodes existieren, aber nicht in `V2SinkEngine`; Legacy-Kette stumm |
| Mute/Solo im Live-Pfad | 🔴 TODO | `mutedStems` wird nicht in den V2-Sink übertragen |
| Trigger (`triggerEvent`) | 🔴 TODO | Offline-Render ohne Ausgang |
| Sample-Preview (`previewSample(url)`) | 🔴 TODO | `new Tone.Player(url).toDestination()` = No-Op |
| Instrument (`playSynthesisInstrument`/it-synth) | 🟡 PARTIAL | Worklet existiert, Ausgang hängt an No-Op-Gain |
| Master-Stream-Tap (WebRTC/SFU) | 🔴 TODO | Tap hängt am stummen Legacy-Ende |
| Analyzer/LUFS-Telemetrie | 🟡 PARTIAL | hängt an Legacy-Kette (läuft leer, liefert aber Daten des stummen Pfads) |
| Offline-Bounce | 🟢 VERIFIED | `OfflineBounceEngine` + Tests |
| `tone`-npm-Paket | 🗑️ entfernt | 0 Importe, nicht in `node_modules` |
| `nativeAudioKit` (Tone-kompatible No-Op-Facade) | ⚫ STALE im Live-Pfad | alle `Tone.*`-Referenzen laufen hierüber; Node-Klassen ohne Audio-Wirkung |

## 4. V1/V2 Dependency Graph (vereinfacht)

```
V1 (Ruhestand, aber Code-Reste):
  tone (npm)                     → entfernt ✅
  GraphEngineAdapter             → entfernt ✅
  V1-Feature-Flags               → entfernt (API defensiv) ✅
  V1-Transport-Zweige            → tot, kompiliert (AUDIO-P1-001)
  Tone-Synth-Fallbacks           → No-Op via nativeAudioKit (stumm)
  Legacy-Worklet-Kette (init)    → läuft leer, speist masterStreamTap (stumm)
  audioEngine-Monolith           → Facade, 35+ Importeure (KEEP bis Split)

V2 (Produktiv):
  V2LiveSink → v2-sink-processor → V2SinkEngine → V2MonitorGraph + V2OutputGraph + V2SampleClock
  WorkletGraphRuntime/OfflineBounce (Offline/Test)
  processingNodes.ts (EQ/DSP/Dynamics/Mastering als V2-Nodes — noch NICHT im Live-Graph)
  V2SessionState/v2LockSync/v2SfuSync (Kollaborations-Module — noch nicht serverautoritativ)
```

## 5. V2 Parity Matrix (ehrlich)

| Feature | V1 | V2 (Live-Pfad) | PARITY | GETESTET? | REAL BROWSER? | RISK |
|---|---|---|---|---|---|---|
| Playback | ✅ | ✅ | OK | ja | ja (Live-Gate) | niedrig |
| Pause | ✅ | ✅ (clock.playing=false, Position bleibt) | OK | teilweise | nein | mittel |
| Stop | ✅ | ✅ | OK | ja | ja | niedrig |
| Seek | ✅ | ❌ (nur reset) | FEHLT | nein | nein | mittel |
| Looping | ✅ | ✅ (Pattern-Loop; Sample-loop Flag) | OK | teilweise | nein | niedrig |
| Sample-accurate Scheduling | ✅ (Worklet-Clock) | ✅ | OK | ja | ja | niedrig |
| Channel-Routing (10ch) | ✅ | ✅ | OK | ja | teilweise | niedrig |
| Volume/Pan | ✅ | ✅ (syncV2FromV1 → Gain/Pan) | OK | ja | nein | niedrig |
| Mute/Solo | ✅ | ❌ | FEHLT | nein | nein | hoch |
| Drum-Synthese | ✅ (Membrane/Metal/Noise/Mono) | ❌ (440-Hz-Sinus) | FEHLT | nein | nein | hoch |
| EQ | ✅ (Worklet) | ❌ (nicht im Live-Graph) | FEHLT | offline | nein | hoch |
| DSP | ✅ | ❌ (nicht im Live-Graph) | FEHLT | offline | nein | hoch |
| FX/Effects | ✅ | ❌ | FEHLT | offline | nein | hoch |
| Dynamics/Compressor/Gate | ✅ | ❌ | FEHLT | offline | nein | hoch |
| Mastering/Limiter | ✅ | ❌ (nur Soft-Clip im MasterSum) | FEHLT | offline | nein | hoch |
| Cue/Main/Monitor | ✅ | ✅ (MonitorPlan im Sink) | OK | ja | nein | mittel |
| 2.1/Spatial | ✅ | ✅ (V2OutputGraph Crossover) | OK | ja | nein | mittel |
| Automation | ✅ | 🟡 Coalescer vorhanden, Live-Wirkung an fehlende Nodes gebunden | PARTIAL | teilweise | nein | mittel |
| MIDI | ✅ | ✅ (Settings-Layer) | OK (Code) | ja | nein (Hardware) | mittel |
| Recording/Export | ✅ | ✅ (OfflineBounce/Recorder) | OK (offline) | ja | nein | mittel |
| Waveform/Analyse | ✅ | 🟡 Analyzer an Legacy-Kette | PARTIAL | ja | nein | mittel |
| Offline-Rendering | ✅ | ✅ | OK | ja | – | niedrig |
| Session-State | ✅ | 🟡 v2SessionState vorhanden, Server nur Relay | PARTIAL | ja (Unit) | nein | hoch |
| Collaboration Sync | ✅ | 🟡 Socket-Relay + Locks; kein Revision/Snapshot | PARTIAL | dünn | nein | hoch |
| Master-Stream (WebRTC/SFU) | ✅ | ❌ stumm | FEHLT | nein | nein | kritisch |

## 6. MONK Architecture (Code-verifiziert)

- `src/plugins/registry.ts`: `COMPONENT_MAP` exakt 16 IDs, `EXPECTED_PLUGIN_COUNT=16`, `SYSTEM_MODULES={masterplayer,ai,perfor}` — **korrekt**.
- `public/plugin-manifest.json`: 16 `ui_plugins` — **konsistent**.
- `App.tsx`: masterplayer-Leiste oben, 16er-Rack, perforMONK unten, aiMONK-Dock — **korrekt**.
- `legacyAliases.ts`: instrument→instru, sampler/synthesizer/mcp→syntisampler, drum→drumsampler, library→biblio, mastering→master, recording→record — **korrekt**.
- Keine Duplikate, keine toten Registrierungen in der Registry. Alte Terminals (Synthesizer/Sampler/Mcp) sind als Sektionen in `SyntiSamplerTerminal` eingebunden (keine Orphans).
- `SYSTEM_MODULES.masterplayer.component = null` — System-Modul ohne eigenes Terminal, in `App.tsx` als Leiste realisiert (ok, aber dokumentieren).

## 7. Collaboration

- Server: Socket.io-Relay (`join-session`, `plugin-lock`, `plugin-state`, RBAC-denied), Locks in-memory mit TTL, Redis-Adapter optional (nur Fanout) — **serverautoritativer State fehlt** (kein Revision/Sequence/Snapshot, kein atomarer Lock über Instanzen).
- Client: `AudioContext.tsx` P2P-RTC (ICE nur STUN hartkodiert) + `MediasoupTransport` SFU; `v2SessionState/v2LockSync/v2SfuSync` vorhanden, aber nicht vollständig serververdratet.
- Tests: `collab.test.ts` deckt nur `localUser` ab — **kein 4-User-Nachweis**.
- **P0-Blocker:** COLLAB-P0-001/002/003 (MASTER_TODO.md).

## 8. MIDI/HID

- MIDI ist kein MONK: Settings → MIDI/Controllers (`SettingsDialog` + `MIDIControllerTerminal`). Mapping-Layer (`src/core/mapping`, `midiCodec`, `mappingEngine`) getestet.
- **CODE VERIFIED:** Enumeration/Hotplug/Mapping/Clock-Out als Code + Unit-Tests vorhanden.
- **REAL HARDWARE VERIFIED:** ❌ (keine Hardware in dieser Session; TR-8S/Beatstep offen).

## 9. AI Infrastructure

- ProviderRouter: HF (Serverless/Endpoint), Replicate, RunPod, local, deterministic, cerebras.
- RunPod: Endpoint `uzg7p9lm890ts8` (HOPPER_141), Provider-Code + Smoke-Skript vorhanden; **Live-Inferenz in dieser Session nicht ausgeführt** (Kosten).
- Replicate/HF-Code noch vorhanden — korrekt, solange RunPod-Cutover nicht validiert ist (AI-P1-001).
- AI-Executor-Isolation vom Audio-Thread: offen (AI-P1-002).

## 10. Security

- Fail-closed Production-Auth (503 `STUDIO_TOKEN_MISSING`), Dev-Mode explizit, Origin-Allowlist, Socket-Handshake-Auth — **implementiert**.
- Zod-Validierung der Haupt-Routen (Telemetry/Cloud/AI/Socket) — **implementiert**; Rest-Pfade offen (SEC-P1-001).
- `npm audit` 0; Boundary-Scan 0; CI-Actions SHA-gepinnt; Secrets nicht in Client-Bundles (Boundary-Scan).
- Cookie-Sicherheit Portal-Worker: ❓ Human Verification.

## 11. Database

- `database/` (schema, ai_migration_001–006, reset) + `supabase/migrations` (002–006 inkl. RLS/Policies/pgvector) vorhanden.
- Tests: `migrations.test.ts`, `supabaseRls.test.ts` grün.
- Live-Abgleich (Migrationen auf Live, RLS-Verifikation): offen (DB-P1-001).

## 12. UI/Mobile

- Desktop-Layout + 16er-Rack + System-Leisten vorhanden; `playwright.responsive.config.ts` existiert.
- Mobile-/Touch-/Accessibility-Matrix: **nicht real verifiziert** (UI-P1-001).

## 13. Tests

| Suite | Ergebnis |
|---|---|
| `npm run typecheck` | ✅ 0 Fehler |
| `npm run lint` | ✅ 0 Errors/Warnings |
| `npm test` (Vitest) | ✅ 159 Dateien, 990 Tests |
| `npm audit` | ✅ 0 |
| `node scripts/validate-interface-boundaries.mjs` | ✅ 393 Dateien, 0 |
| `npm run build` | ✅ Vite + 32 Worklets + esbuild-Server |
| `npx playwright test tests/e2e/v2-live.spec.ts --headed` | ✅ 1 passed (24,7 s) |
| `npx knip` (Standard) | ⚠️ 144 ungenutzte Dateien (davon Worklet-/WAM-Assets; echter Dead Code vorhanden) |
| 4-User-E2E / Hardware / RunPod-Live | ❌ nicht ausgeführt |

**Mängel:** Live-Gate prüft nur `playing/v2Connected`, keinen Audio-Inhalt; Parity-Tests sind Offline-/Proxy-Level; Mute/Drum/Processing-Lücken sind ungetestet.

## 14. Performance

- Legacy-Worklet-Kette läuft bei jedem `init()` leer mit (CPU-Verschwendung) → AUDIO-P0-004.
- Vitest 40 s; Build ~4,5 min; Bundle-Budget via `check:bundle` vorhanden.
- Reale Audio-Performance (Xruns/Latenz unter Last) nur über Telemetrie-Konzept, nicht live gemessen.

## 15. TODO Reconciliation

| Dokument | Bewertung |
|---|---|
| `TODO.md` | Teils korrekt, teils stale (Testzahlen, knip-Behauptung, „Tone.js vollständig entfernt"). P0/P1 weitgehend zutreffend; wird durch MASTER_TODO.md ergänzt. |
| `V2TODO.md` | Phase 1–8 nachweislich umgesetzt; **Phase 9 ist faktisch NICHT abgeschlossen** (nur Tone-Paket/Flags/Adapter entfernt). |
| `VISIONS_TODO.md` | Korrekt als Sandbox geführt; keine P0/P1-Kontamination. |
| `MASTERTODO.md` | Durch `MASTER_TODO.md` ersetzt (superseded). |
| `PRODUCTION_READINESS.md` | **Stale Zahlen:** 954 Tests → 990; „knip 0" → falsch; „Tone.js vollständig entfernt" → missverständlich (No-Op-Facade bleibt). |
| `MONK_ARCHITECTURE.md` | ✅ Code-konsistent. |
| `V1_DEPENDENCY_MAP.md` | Weitgehend korrekt, aber unterschätzt die stummen Pfade (Preview/Trigger/Instrument/Master-Stream). |
| `AGENTS.md` | ✅ Grundsätze konsistent; „Tone.js" nicht mehr als Engine erwähnen. |

## 16. V1 Removal Decision

**NOT READY.** Siehe `V1_REMOVAL_REPORT.md`. Keine destruktiven Änderungen durchgeführt.

## 17. Changes Actually Made

- ✅ `MASTER_TODO.md` erstellt (kanonische Ausführungsliste).
- ✅ `V1_REMOVAL_REPORT.md` erstellt.
- ✅ `AUDIT_REPORT.md` erstellt.
- ❌ Keine Code-Änderungen, keine Löschungen, keine Doku-Überschreibungen (historische Dateien bleiben erhalten).

## 18. Remaining Blockers

1. AUDIO-P0-001…004 (V2-Live-Pfad funktional vervollständigen).
2. COLLAB-P0-001…003 (serverautoritativer State + Live-E2E + WebRTC/TURN).
3. Hardware-/RunPod-/4-User-Live-Verifikation (Umgebung/Kosten).
4. AI-P1-001 (RunPod-Cutover) vor Provider-Entfernung.

## 19. Recommended Next 10 Tasks

1. AUDIO-P0-004: Processing-Nodes (EQ/DSP/FX/Dynamics/Mastering + Mute/Solo) in `V2SinkEngine`/`V2MonitorGraph` verdrahten.
2. AUDIO-P0-001: Drum-Synthese (kick/hat/clap/bass) in den V2-Sink portieren.
3. AUDIO-P0-002: Master-Stream-Tap an den V2-Ausgang legen.
4. AUDIO-P0-003: `triggerEvent`/`previewSample`/Instrument-Audio hörbar machen.
5. Audio-Capture-Tests ins Live-Gate aufnehmen (Nicht-Stille + Rollen-Spektrum).
6. COLLAB-P0-001: Revision/Sequence/Snapshot + atomare Locks (Redis).
7. COLLAB-P0-003: ICE/TURN aus Server-Config + Reconnect-Zustandsmaschine.
8. AI-P1-001: RunPod-Smoke/Failover validieren; danach Provider-Entfernungsentscheidung.
9. QUAL-P2-001: Dead-Code-Bereinigung auf Basis der knip-Klassifikation.
10. DOC-P2-001: Zahlen/Doku synchronisieren (990 Tests, Live-Gate, knip-Realität).

## 20. Release Readiness

**FINAL RELEASE SCORE**

| Kategorie | Score | Begründung |
|---|---:|---|
| Architecture | 7/10 | 16+3 sauber, aber Legacy-/V2-Doppelstruktur |
| Audio | 4/10 | Live-Pfad trägt nur Mixer/2.1; Processing + Stimmen fehlen |
| V2 migration | 4/10 | Tone-Paket weg, aber Parität via No-Op statt echter Portierung |
| Collaboration | 3/10 | Relay + Locks vorhanden, kein serverautoritativer State, kein Live-Beweis |
| AI | 5/10 | Provider-Vielfalt, aber Cutover/Live-Test offen |
| Security | 8/10 | fail-closed, Zod, audit 0; Rest-Pfade + Cookie-Doku offen |
| Database | 6/10 | Schema/RLS vorhanden, Live-Abgleich offen |
| MIDI/HID | 6/10 | Code+Tests grün, keine Hardware-Verifikation |
| UI | 6/10 | Desktop solide, Mobile/Accessibility unverifiziert |
| Testing | 7/10 | 990 grün, aber Audio-Inhalt/Live-Kollab ungetestet |
| Performance | 5/10 | Leere Legacy-Worklets; keine Live-Messung |
| **Overall** | **5.2/10** | Build-gesund und architektonisch klar, aber **nicht release-fähig**, bis der V2-Live-Pfad hörbar vollständig ist |
