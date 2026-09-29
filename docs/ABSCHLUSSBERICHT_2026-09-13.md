# audioMONASTRY – Abschlussbericht (2026-09-13)

> Erstellt nach Phase-10-Reihenfolge. Basis: Repository-Analyse (Phase 1),
> Umsetzung P0-1/P0-2/P1-1/P1-2 + COLLAB-P1-004. Alle Gates grün
> (`npm run verify`).

## 1. Executive Summary

audioMONASTRY ist ein React/TypeScript-Monorepo (1.313 Dateien) mit
Express/Socket.IO-Server, WebAudio/AudioWorklet-Engine (V2), 5 RunPod-GPU-Rollen,
Supabase/pgvector und Cloudflare R2. Die kritischste Lücke – **serverseitige
Durchsetzung des MixerMONK-Main-Out-Schutzes** – wurde geschlossen. Zusätzlich:
MNOA-MCP-Smoke-Test (live verifiziert), automatische Snapshots mit
Checksumme/Retention/Dry-Run, ENV-SSOT-Matrix, 4-User-Nav-Spiegelung.

**Verifizierter Stand:** typecheck 0 · eslint 0 · 208 Testdateien / **1.439
Tests grün** · Boundary-Scan 430 Dateien 0 · npm audit 0 · Deep-Audit 0
Gate-relevante Findings · Audio-Gate PASS · Worklet-CPU-Gate PASS.

## 2. Architekturübersicht

```
4× Browser (React 19) ── Socket.IO/WebRTC ── server.ts (Express, fail-closed)
  │  AudioWorklets (128 Frames, 48 kHz)         │  /api/ai/*, /api/health
  ▼                                             ▼
V2StudioGraph (10 Kanäle: Gain→Pan→MasterSum)  AI Orchestrator (Jobs/Sessions/
  │                                            MCP/Cost/SnapshotStore)
Mastering-Worklet (5 ms PDC)                   ProviderRouter → RunPod 5 Rollen
  │                                            (brain/ears/voiceGen/vision/video)
MasterStreamTap → Main-Out (MixerMONK-geschützt)
  │
Supabase (pgvector) + R2 (Audio-Objekte)
```

Komponenten: `src/core/audio` (V2-Graph, Worklets, Routing), `src/core/session`
(AuthoritativeSession, mainOutGuard, SnapshotStore), `src/core/ai/orchestrator`
(JobManager, AiJobRuntime, McpRuntime, ProviderRouter), `src/plugins` (16
kanonische Adapter), `services/` (audiomonastry-ai-runtime Python, stem-ai,
master-player, mixer/Rust, …).

## 3. Audio-Routing-Dokumentation

| Signalpfad | Quelle | Format | SR | Block | Kanäle | Transport | Bearbeitung | Ziel | Latenz |
|---|---|---|---|---|---|---|---|---|---|
| Input→Track→Main | Worklet-Source | Float32 | 48 kHz | 128 | 1–2 | WebAudio | Gain→Pan→MasterSum→Mastering (5 ms Lookahead) | Main-Out | ~5 ms + Gerätepuffer |
| Monitor ohne Aufnahme | MonitorRoutingFacade (MAIN/MON/PLUGIN) | Float32 | 48 kHz | 128 | 1–2 | WebAudio | Cue-Matrix, DJ-PFL | Cue/Monitor | ~5 ms |
| Aufnahme→Clip/Persistenz | Recorder-Terminal | WAV 16-bit PCM | 48 kHz | – | 1–2 | IndexedDB/OPFS + R2 | encodeWavFromChannels | Library | offline |
| Send/Return-Effekt | FX-Insert | Float32 | 48 kHz | 128 | 1–2 | WebAudio | effectProcessor (Reverb/Delay/Mod) | Return→MasterSum | ~5 ms |
| Solo/Mute | Kanal-Strip | – | – | – | – | deterministisch | Mute=0, Solo-Isolation im Cue | – | – |
| Main-Out-Schutz | mixer/master | – | – | – | – | Server + Client | nur MixerMONK (P0-1) | – | – |

Regeln: `OFF` = transparenter Bypass; kein Netz/Storage/React in `process()`;
Routing-Schleifen werden durch den topologischen Plan des AudioGraph verhindert;
Fehler eines Adapters werden gefangen und geloggt.

## 4. Userflow (1–4 Nutzer)

1. **Login/Session:** Socket-Handshake mit `studio`-Cookie / `x-studio-token`;
   ohne `STUDIO_ACCESS_TOKEN` ist die API fail-closed (nur `/api/health` offen).
2. **Join:** `join-session {userId}` → erste User-ID wird admin (MixerMONK),
   weitere erhalten `SESSION_ROLE` (Default guest). `SESSION_HOST_USER` pinnt den
   Host deterministisch. Max. 4 Mitglieder; `mainOutUserId` wird an alle geliefert.
3. **Rollen:** admin > producer > engineer > guest. Server erzwingt `assign-role`
   (admin-only), `plugin-state` (Lock + PRO-Promotion + Main-Out-Schutz).
4. **Spuren/Takes/Clips:** Track-Claims über ProjectContext (LWW), Spatial-Claims,
   Recorder speichert WAV-Clips, Autosave debounced + Snapshot-Interval.
5. **Dateiübergabe:** Upload `UPLOAD_MAX_MB` (Default 100 MB) → R2/Supabase;
   Stem-Upload separat mit Backpressure (`STEM_MAX_JOBS`).
6. **Mixer-Steuerung:** nur Main-Out-Owner (admin oder `MAIN_OUT_USER_ID`)
   schaltet `mixer`/`master`; alle anderen arbeiten auf ihren Spuren/Bussen.
7. **AI:** MOA-Planung (brain), Audio-Analyse (ears), TTS/Song/Stems (voiceGen),
   Vision (vision), Video (video); MCP-Tools READ/WRITE/EXECUTION/DESTRUCTIVE.
8. **Snapshot/Export/Restore:** automatische Snapshots (Intervall/Änderung),
   Retention, Checksummen-validierter Restore, WAV-Export 16-bit PCM.

## 5. Fünf AI-Instanzen

| Instanz | Rolle | Modelle (Preload) | Status |
|---|---|---|---|
| brain | LLM/NLU, MOA-Planung | Qwen3-14B-AWQ (vLLM), Qwen3-4B | ✅ live (0,67–0,74 s warm, historisch) |
| ears | classify/transcribe/embed/analyze | AST, Whisper-v3, CLAP | ✅ live |
| voiceGen | TTS/Sing/Song/SFX/Stems | mms-tts-deu, demucs | ✅ live; qwen3-tts-06b MODEL_UNAVAILABLE |
| vision | Bild (FLUX) | FLUX-Worker | ⚠️ Endpoint konfiguriert, Live-Beweis offen |
| video | Video (Wan2.2) | Wan2.2-Worker | ⚠️ Wake/Sleep verdrahtet, Live-Beweis offen |

Systemprompts/Tools/Verbote: `src/utils/prompts.ts` (Plugin-Katalog),
`docs/PLUGIN_PROMPT_MATRIX.md`, `docs/AI_PROMPTS.md`. AI darf Main-Out nicht
verändern (P0-1-Gate), keine Secrets, keine DB-Migrationen, keine
DESTRUCTIVE-Tools ohne explizite Permission.

## 6. MCP-Dokumentation

- **Pfad:** `GET /api/ai/mcp/tools`, `POST /api/ai/mcp/tools/:name`
- **Tools:** 68 (session, runtime, models, audio.*, stem.separate, sample.search,
  plugin.*-Planung, Aliasse)
- **Permissions:** READ < WRITE < EXECUTION < DESTRUCTIVE; DESTRUCTIVE explizit
- **Smoke:** `npm run mcp:smoke` (mit `BASE_URL`, `STUDIO_ACCESS_TOKEN`)
- **Live-Beweis 2026-09-13:** 68 Tools, SMOKE OK; ohne Token fail-closed OK;
  Kaltstart-Wiederholung OK.

## 7. ENV-/Modell-/Codec-/Plugin-Matrix

- ENV: `docs/ENV_MATRIX.md` (kanonisch `RP_*`, `SB_*`, `CFR2_*`/`CFS3_*`,
  Alias-Warnung, Secret-Kennzeichnung). Template: `.env.TEMPLATE` bereinigt.
- Modelle: `services/audiomonastry-ai-runtime/model_manifest.json` (Revision-Pinning,
  5 `planned` ohne Revision werden nicht geladen).
- Codecs: WAV-Encode (16-bit PCM, 1–2 Kanäle) ✅; Browser-Decode für
  MP3/FLAC/OGG/AAC via `decodeAudioData`; **keine** MP3/FLAC/AAC/OGG-Encoder.
- Plugins: 16 kanonische Adapter + `public/wam/`; eigene Schnittstelle
  (`plugin_interface.ts`), kein VST3/AU/LV2-Host.

## 8. Kaltstartanleitung

```bash
# 1. Abhängigkeiten
npm ci
# 2. Konfiguration
cp .env.TEMPLATE .env   # STUDIO_ACCESS_TOKEN (openssl rand -hex 32),
                        # SESSION_HOST_USER, MAIN_OUT_USER_ID optional
# 3. Start (Dev)
npm run dev             # http://localhost:8080
# 4. Health
curl http://localhost:8080/api/health   # {"status":"ok"}
# 5. MCP-Smoke
BASE_URL=http://localhost:8080 STUDIO_ACCESS_TOKEN=... npm run mcp:smoke
# Produktion (Hetzner):
npm run build && PORT=8080 NODE_ENV=production node dist/server.cjs
```

Reihenfolge: Server startet erst, wenn `STUDIO_ACCESS_TOKEN` gesetzt ist
(fail-closed); AI-Flotte wird bei Session-Eintritt über `POST /api/ai/fleet/wake`
geweckt (`AI_FLEET_WAKE=0` deaktiviert das).

## 9. Snapshot-/Restore-Anleitung

Siehe `docs/SNAPSHOT_RESTORE.md`. Kurz: SnapshotStore mit SHA-256-Checksumme,
`SNAPSHOT_INTERVAL_MS` (60 s), `SNAPSHOT_MAX_SNAPSHOTS` (20),
`SNAPSHOT_MAX_AGE_MS` (7 d), Restore `'latest'` prüft Checksumme, Prune ist
dry-run-fähig und löscht nie den neuesten gültigen Snapshot.

## 10. Testbericht mit Messergebnissen

| Gate | Ergebnis |
|---|---|
| `npm run typecheck` | 0 Fehler |
| `npm run lint` | 0 Findings |
| `npm run test` | **208 Dateien, 1.439 Tests grün** |
| `npm run verify:boundary` | 430 Dateien, 0 Verstöße |
| `npm run security` | 0 Vulnerabilities |
| `npm run verify` | grün (Deep-Audit: 0 Gate-relevante Findings; jscpd 16 WARN) |
| `npm run test:audio-gate` | GATE PASS (12 Prüfungen) |
| `npm run perf:worklet` | PASS (Ø-Last im Budget, keine verpassten Quanten) |
| `npm run mcp:smoke` (live) | SMOKE OK (68 Tools) + fail-closed + Kaltstart |

## 11. Latenz- & Performancebericht

- Audio-Quantum: **128 Frames @ 48 kHz = 2,67 ms** pro Render-Quantum.
- Mastering-PDC: **5 ms Lookahead** (dokumentiert, kompensiert).
- AI: brain warm 0,67–0,74 s (historisch), Stems ~5 s (demucs, historisch).
- Netzwerk: adaptiver Jitterbuffer 50 ms Ziel, RTT-basierte Clock-Sync (PLL).
- Offen: `renderCapacity` nur auf Browsern mit der API messbar (Chrome); Worklet-
  Gate misst ersatzweise verpasste Render-Quanten über `currentFrame`.

## 12. Geänderte Dateien (diese Session)

Neu: `src/core/session/mainOutGuard.ts`, `src/core/persistence/snapshotStore.ts`,
`scripts/mcp-smoke.mjs`, `tests/mainOutGuard.test.ts`,
`tests/snapshotStore.test.ts`, `tests/mcpSmokeScript.test.ts`,
`docs/ENV_MATRIX.md`, `docs/SNAPSHOT_RESTORE.md`.
Geändert: `server.ts`, `src/utils/rbac.ts`, `src/utils/WebRTCManager.ts`,
`src/context/ModuleStateContext.tsx`, `src/App.tsx`, `package.json`,
`tests/rbac.test.ts`, `tests/webrtcManager.test.ts`, `.env.TEMPLATE`,
`reports/audio-gate.json`, `reports/worklet-cpu.json`,
`.deepcode/settings.json` (vorherige CometAPI-Konfiguration).

## 13. Offene Risiken

1. **WebRTC-Peer-Parameterpfad** ist nicht server-inspizierbar; Main-Out-Parameter
   müssen künftig über das neue `main-out-update`-Event laufen (Mixer-/Master-
   Terminals noch nicht umgestellt).
2. **SnapshotStore ist In-Memory** – Redis-Anbindung für den KV-Store fehlt.
3. **Lokale `.env` enthält historische, ungelesene Cloudflare-Tokens**
   (`CFR2_API_TOKEN`, `CF_API_KEY`, `CF_ACCOUNT_TOKEN`) und `COMET_API_KEY`
   → Rotation empfohlen.
4. **qwen3-tts-06b MODEL_UNAVAILABLE** (Voice-Preload ohne TTS-Modell).
5. **vision/video** ohne Live-Beweis; VISUAL-P1-001 offen.
6. Ungültiges JSON im MCP-Pfad loggt einen Stack-Trace (Response korrekt).

## 14. Nicht gelöste Punkte

- Upload-Resume/Chunking + Abbruch-Wiederaufnahme.
- Codec-Export MP3/FLAC/AAC/OGG (nur WAV-Encoder vorhanden).
- aiMONK-Agent-Loop (mehrstufig planen→ausführen→prüfen).
- Batch-Indexer für `sample_audio_embeddings`.
- Reconnect-Gerätewechsel und 4-User-Live-E2E gegen echte Instanz (COLLAB-P0-002
  bleibt PARTIAL).
- Server-Refactor `server.ts` zerlegen (ARCH-P2-002).
- Redis-Anbindung des SnapshotStores.

## 15. Exakte Befehle

```bash
cd "/home/patrick/AnunnakiTools Projekte/laufende Projekte/audioMONASTRY"

# Lokaler Start (Dev)
npm install
cp .env.TEMPLATE .env        # Werte eintragen (STUDIO_ACCESS_TOKEN Pflicht)
npm run dev                  # http://localhost:8080

# Tests
npm run typecheck
npm run lint
npm run test                 # 1439 Tests
npm run verify               # Komplett-Gate
npm run test:audio-gate      # Audio-Smoke
npm run perf:worklet         # Worklet-CPU-Gate
BASE_URL=http://localhost:8080 STUDIO_ACCESS_TOKEN=... npm run mcp:smoke

# Produktion
npm run build
PORT=8080 NODE_ENV=production node dist/server.cjs
# oder Hetzner-Flotte: bash scripts/hetzner/lifecycle.sh start
```
