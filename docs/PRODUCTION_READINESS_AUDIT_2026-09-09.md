> ⚠️ SUPERSEDED (2026-09-11): Einzige SSOT fuer offene Arbeiten ist jetzt **MASTERTODOENDE.json**.
> Dieses Dokument bleibt nur als historische Referenz und wird nicht mehr gepflegt.

# audioMONASTRY Production Readiness Audit

> Datum: 2026-09-09 · Umfang: ganzes Repository · Modus: Deep Audit (statisch) + Verify-Gates + Migration 16-MONK
> Bewertungsstufen: VERIFIED · PARTIALLY VERIFIED · STATIC ONLY · NOT VERIFIED · BLOCKED

## Executive Summary

Die Zielarchitektur (16 echte MONKs + System-Module masterplayerMONK/aiMONK/perforMONK,
MIDI/Controller als Settings-/System-Layer, V2 als alleiniger Production Audio Path) ist als
verbindliche Architektur in `TODO.md` festgeschrieben und auf Code-Ebene umgesetzt.

P0-Sicherheits- und Qualitätsgates sind geschlossen: Production Auth fail-closed, `npm audit` 0,
Zod-Runtime-Validierung der kritischen API-/Socket-Pfade, saubere Script-Trennung
(`typecheck`/`lint`/`security`/`verify`), ESLint 0 Warnings, TypeScript 0 Fehler, Build grün,
957/957 Tests grün. Die DSP-Parität wurde von RMS/Hash-Proxys auf sample-level Tests gehoben;
dabei wurde ein echter V2-Bug gefunden und behoben (EQ bei 0 dB war nicht transparent).

Offen bleiben ausschließlich Live-Gates, die in dieser Umgebung nicht ausführbar sind
(echter Audio-Browser/Live-Instanz, 4-User-E2E, Hardware, RunPod-Endpoint).

## Final Architecture (VERIFIED statisch)

- `src/plugins/registry.ts` + `public/plugin-manifest.json`: exakt 16 MONKs in Ziel-Reihenfolge
  `mixer, drop, song, effect, syntisampler, drumsampler, instru, biblio, voice, sound, stem, spatial, eq, dsp, master, record`.
- System-Module: masterplayerMONK (feste Sektion nach Head, inkl. `MasterPlayerTerminal`),
  aiMONK (Dock nach recordMONK), perforMONK (ganz unten, ex perfMONK).
- MIDI/Controller: kein Plugin-Slot mehr; `SettingsDialog → MIDI / Controllers` bettet
  `MIDIControllerTerminal` ein; `ControlHub`/`MappingEngine` bleiben System-Layer.
- Audio: MONK Audio API → V2 AudioGraph → Realtime Audio Runtime → AudioWorklet → Backend
  (V2LiveSink/v2SinkProcessor/V2SampleClock); Offline über denselben V2-Graph.

## 16-MONK-Architektur (VERIFIED)

| # | MONK | Komponente | Status |
|---|---|---|---|
| 1 | mixerMONK | DJ4ChMixer | bleibt |
| 2 | dropMONK | DropTerminal | bleibt |
| 3 | songMONK | SongMonkTerminal | bleibt |
| 4 | effectMONK | FXEngineTerminal | bleibt |
| 5 | syntisamplerMONK | SyntiSamplerTerminal (Synth/Sampler/MPC) | merge (neu) |
| 6 | drumsamplerMONK | DrumMachineTerminal | merge (neu) |
| 7 | instruMONK | InstrumentsTerminal | rename |
| 8 | biblioMONK | LibraryTerminal | bleibt |
| 9 | voiceMONK | VoiceGenTerminal (+Panel) | bleibt |
| 10 | soundMONK | SoundTerminal | bleibt |
| 11 | stemMONK | StemExtractorTerminal | bleibt |
| 12 | spatialMONK | SpatialScene | bleibt |
| 13 | eqMONK | EQPluginTerminal | bleibt |
| 14 | dspMONK | DSPTerminal | bleibt |
| 15 | masterMONK | MasteringOverlay | rename |
| 16 | recordMONK | RecorderTerminal | rename |

## System Modules (VERIFIED statisch)

| Modul | Position | Zustand |
|---|---|---|
| masterplayerMONK | nach Head, vor Plugin 1 | feste Sektion; `MasterPlayerTerminal` (Waveform/Info) jetzt verdrahtet |
| aiMONK | nach recordMONK | AiMonkDock (Feature-Flag), für alle User |
| perforMONK | ganz unten | PerformanceMonitorTerminal, umbenannt, Monitor-Wahl integriert |

## Old → New Migration Matrix (VERIFIED)

`instrument→instru`, `synthesizer+sampler+mcp→syntisampler`, `drum→drumsampler`,
`library→biblio`, `mastering→master`, `recording→record`, `perf→perfor`,
`controller→Settings/System-Layer`, `masterplayer/ai→System-Module`.
Alte IDs bleiben als dokumentierte Aliase in `pluginChannelMap`/Prompts/CommandRegistry
erhalten; kein Funktionsverlust bekannt. Registry/Router/EvalMatrix/PromptCatalog/
CommandRegistry/Theme-System sind synchron auf die 16er-Struktur umgestellt.

## Audio Engine V1/V2 Status (PARTIALLY VERIFIED)

- V2-Live-Pfad statisch vollständig: `V2LiveSink → v2SinkProcessor → V2SinkEngine
  (V2MonitorGraph/V2OutputGraph) → V2SampleClock (sample-genau, PDC-Kompensation)`.
- Live-E2E (`tests/e2e/v2-live.spec.ts`) ist BLOCKED in Headless-Umgebung; Live-Nachweis
  steht aus (echter Audio-Browser/Live-Instanz erforderlich).
- V1 (Tone.js) ist noch im Code (Feature-Flag `VITE_V2_AUDIO_MODE`, Default `v1`).
  Phase 9 (V1-Entfernung) erst nach Live-Paritätsnachweis.
- PDC: `v2Pdc.ts` (5 ms Mastering-Lookahead), Step-Kompensation sample-exakt getestet.

## DSP / Clock / PDC Status (VERIFIED für Offline-Parität)

- Neue Suite `tests/v2DspParityExtended.test.ts` (15 Tests): gain/pan/PDC/automation
  sample-exakt; silence/clipping/denormal/channel-count (stereo/2.1/N.x) geprüft.
- EQ-0dB-Fix in `computeBiquadCoefficients` (RBJ-Degeneration behoben, V2-EQ jetzt exakt
  transparent bei 0 dB). Toleranzen mathematisch dokumentiert in
  `docs/DSP_PARITY_TOLERANCES.md`.
- Clock: `V2SampleClock` (Phasenakkumulator, sample-genau, kein setInterval); Doku
  (`V2TODO.md`) korrigiert. Live-Jitter-/Latenzmessung steht aus (Live-Gate).

## Collaboration Status (STATIC ONLY / NOT VERIFIED live)

- Session/Lock/RBAC/SFU-Sync als V2-Module vorhanden (`v2SessionState`, `v2LockSync`,
  `v2SfuSync`); Socket.io-Server validiert `plugin-lock/unlock/state` jetzt per Zod.
- 4-User-Live-E2E nicht ausgeführt (BLOCKED: keine 4 Browser/Live-Instanz in dieser Umgebung).

## AI Status (STATIC ONLY)

- RunPod-Provider/Worker/Handler statisch vorhanden; Endpoint-Erstellung BLOCKED
  (RunPod-Guthaben). Replicate/HF bleiben bis Cutover (dokumentiert in TODO.md).
- AI-Runtime ist vom Audio-Core getrennt (async Orchestrator, kein Render-Thread-Zugriff
  im Boundary-Scan).

## MIDI Architecture (VERIFIED statisch)

- `SettingsDialog` → MIDI-Sektion + Controller-Dashboard; `MIDIControllerTerminal` ohne
  Plugin-Lock (lokaler State); ControlHub/MappingEngine/MappingStore unverändert.
- Kein `controller`-Plugin-Slot mehr.

## Security Status (PARTIALLY VERIFIED)

- Production Auth fail-closed (VERIFIED durch `tests/securityProductionAuth.test.ts`).
- `npm audit` = 0 (adm-zip entfernt). Zod-Validierung für kritische Routen + Socket
  (VERIFIED durch Tests). Rate-Limits, Key-Whitelist, SSRF-Guards vorhanden.
- Secret-History-Scan und Live-Pentest stehen aus (BLOCKED/offen).

## Persistence (STATIC ONLY)

- Supabase/R2/OPFS/IndexedDB-Code vorhanden; Produktions-Migrationsstatus nicht live
  geprüft (BLOCKED: Live-Zugang erforderlich).

## CI/CD (VERIFIED statisch)

- `ci.yml` nutzt jetzt `typecheck`/`lint --max-warnings=0`/`test`/`security`/`build`;
  Actions SHA-gepinnt. `verify` = echtes Release-Gate inkl. `audit:deep:static`.

## Testing (PARTIALLY VERIFIED)

- Unit/Integration: 957/957 grün (156 Dateien), inkl. neuer Zod-/Security-/Parity-Tests.
- E2E: Suite vorhanden (18 Specs inkl. `v2-live`, `collab`, `stress`); Headless nicht
  vollständig ausführbar (Audio/Live-Gates). 4-User-E2E BLOCKED.

## Deployment (PARTIALLY VERIFIED)

- `npm run build` grün (Vite + Worklets + esbuild server.cjs). Docker-Build nicht ausgeführt
  (BLOCKED in dieser Umgebung, kein Docker-Daemon-Lauf). Health-Check `/api/health` offen.

## Remaining TODOs (Priorität)

- P0 BLOCKED: ARCH-AUDIO-001 V2-Live-E2E (Live-Browser/Instanz).
- P1: 4-User-E2E, Live-Latenz/Jitter, Xonar/2.1-Hardware, RunPod-Endpoint, Replicate/HF-Entfernung.
- P2: server.ts-Dekomposition, jscpd-Duplikate (14), Telemetrie-Ausbau perforMONK, README auf 16-MONK-Architektur.

## Technical Debt

- `audioEngine.ts` (V1-Monolith, 3442 LOC) bleibt bis Phase 9; `server.ts` (2662 LOC) bis P2-Split.
- jscpd: 14 Duplikate; alte MONK-Komponenten bleiben als Sektionen/Aliase erhalten (bewusst,
  bis Parität nachgewiesen).

## Performance Metrics (Messwerte dieser Umgebung)

- `tsc --noEmit`: 0 Fehler · ESLint: 0 Warnings · `npm audit`: 0 · Boundary-Scan: 0 Verstöße
- Tests: 957 passed / 0 failed (Vitest, ~25 s) · Build: ok · Deep-Audit-static: 0 critical

## Production Readiness Score

| Bereich | Bewertung |
|---|---|
| Build/Typecheck/Lint/Security | VERIFIED |
| Plugin-Architektur (16 MONKs + System) | VERIFIED (statisch) |
| Audio V2 Code-Pfad | PARTIALLY VERIFIED (Live-Gate offen) |
| DSP/Clock/PDC | VERIFIED (offline), Live-Messung offen |
| Collaboration 4 User | NOT VERIFIED (live) |
| AI/RunPod | STATIC ONLY (Endpoint BLOCKED) |
| MIDI/Controller | VERIFIED (statisch) |
| Persistence/Deployment | STATIC ONLY / PARTIALLY VERIFIED |

**Gesamt: PARTIALLY VERIFIED** – code-seitig release-fähig; Live-Gates (Audio, 4-User, Hardware,
RunPod) müssen auf der Ziel-Infrastruktur nachgeholt werden.

## Release Recommendation

**Bedingte Freigabe für Staging/Live-Tests.** Kein Production-Rollout, bevor:
1. V2-Live-E2E auf audio-fähigem Browser/Instanz grün ist,
2. 4-User-Kollaborationstest grün ist,
3. RunPod-Endpoint validiert ist (bzw. Replicate/HF bewusst als Übergang bleibt),
4. `npm run verify` (inkl. Deep Audit) auf der Ziel-Hardware grün ist.
