# audioMONASTRY – Production-Readiness-Report

Stand: 2026-08-30 · V. 1|001|420 „AnunnakiDNA" · Sprint: Production-Readiness + Live-Flotte

## 0. Live-Flotte (2026-08-29, stündlich abgerechnet)

| Knoten | Typ | IP | Status |
|---|---|---|---|
| app-1 | CX33 | 159.69.102.29 (Floating) | ✅ HTTPS + App/API/Signaling + master-player |
| sfu-1 | CX33 | 49.13.0.226 | ✅ Mediasoup-SFU (RTP 40000–40099) |
| ai-1 | CX33 | 49.13.65.150 | ✅ bereit (Ollama/Stem-CPU bei Bedarf) |
| master-1 | CX23 | 167.233.22.157 | ✅ master-player healthy |
| edge-1 | CX23 | 167.233.214.220 | ✅ Prometheus/Grafana/cAdvisor/node-exporter |

Alle mit **Idle-Auto-Shutdown** (20 min ohne aktive User → `poweroff`).
**Stresstests:** app-1 HTTP 3000/3000 ok (310 req/s, 0 Fehler), Socket.io 50/50
(Relay p95 38 ms, Session-Full enforced) · sfu-1 40 Clients, createTransport
p95 38 ms, RTP-Caps ok.

### Browser-Engine-Stresstest (Playwright, live gegen app-1, 2026-08-30)

| Metrik | Wert |
|---|---|
| Boot (Start-Screen → Studio) | 2,6 s |
| Plugins aktiviert | 17/17 |
| Pattern-Loads (komplette 8-Kanal-Matrix) | 1000 → 8000 Kanal-Updates |
| Play/Stop-Zyklen mit BPM-Rapid (60–250) | 10 |
| Heap vor/nach | 65 MB → 65 MB (**0 MB Delta**) |
| UI-FPS unter Last | 27 fps (headless Chromium) |
| Page-Errors | **0** |
| Console-Errors | 0 (nur benigne MIDI-Permission im Headless) |

Dabei gefundene & gefixte Bugs: Master-Player-Play-Button ohne onClick,
Effect-Worklet-Crash (BaseAudioContext vor init), Sequencer-Crash bei
partiellen Patterns (undefined.map), WASM-Synth-404 als error statt warn.

## 1. Executive Summary

- **Live-Flotte aufgebaut, HTTPS + Let's-Encrypt aktiv, SFU/Redis aktiv, Replicate AKTIV** (Demucs-Stems + Bark-TTS/Sing, Token verifiziert).
- Qualität: `tsc` ✓ · 179 Unit-/Integrationstests ✓ · Boundary-Scan 0 ✓ · Production-Build ✓ · Coverage erzeugt ✓ · SonarCloud läuft automatisch per Push.

## 2. Umgesetzte Blocker

| DCT | Maßnahme | Status |
|---|---|---|
| DCT-101 | Stem-Queue: `STEM_MAX_JOBS`, 429 + `Retry-After`, Idempotency-Key (409), Timeout-Reset, kein Zombie-Job | ✅ |
| DCT-102 | AUTO_AI-Sync: kanonischer ModuleState + LWW über WebRTC `PLUGIN_STATE_UPDATE` (stale/duplicate-safe) | ✅ |
| DCT-103 | `PLUGIN_REGISTRY` komplett entfernt; `getPluginRegistry()` als einzige immutable Quelle | ✅ |
| DCT-104 | Playwright E2E: Boot, 17 Plugin-Buttons, Mixer+MOA, Session, Plugin-Toggle, **0 pageerrors** | ✅ |
| DCT-106 | IndexedDB-KV-Store (`largeGetJson`/`largeSetJson`) + MoaHistory migriert; Audio wartet nie | ✅ |
| DCT-107 | `firebase-schema.json` → `.historical.json`; backend-core im README als historisch markiert | ✅ |
| DCT-118 | ErrorBoundary mit Fehler/Stack/Komponenten-Stack + Reload; Boot-Diagnostics in `main.tsx` | ✅ |

## 3. Test-Matrix (Kurzfassung)

| Bereich | Unit | Integration | E2E | Failure |
|---|---|---|---|---|
| AudioGraph/Mixer/Sequencer | ✓ | ✓ | ✓ | – |
| AI/Stem | ✓ | ✓ (gemockt) | – | Stem-Queue 429 |
| WebRTC/Collab | ✓ | ✓ | – | teilweise (DCT-113 offen) |
| Plugin-System | ✓ | ✓ | ✓ | – |

Details: `docs/RELEASE_GATE.md`.

## 4. Architecture-Boundary-Audit

- `scripts/validate-interface-boundaries.mjs`: **0 Verstöße** (220 Dateien, 25 Adapter erlaubt).
- Keine Circular-Dependencies in neuen Pfaden (Registry → App, Context → WebRTCManager sind einseitig).
- UI→Audio, Audio→Network, Worklet→DOM sind nicht neu eingeführt worden.

## 5. Performance-Metriken (lokal gemessen)

- Build: Vite ~25 s, Worklets + Server-Bundle ~15 ms.
- Testlauf: Unit 5,9 s · E2E 12,9 s.
- Bundle: Client ~1,2 MB (min), Server-Bundle 134,6 KB. (Optimierungspotenzial: Lazy-Loading, DCT-119)

## 6. Bekannte Issues

| Prio | Issue | DCT |
|---|---|---|
| P1 | Kein E2E für WebRTC 2-Browser-Sync | DCT-113 |
| P1 | Stem-Routing-Hardcodes prüfen | DCT-115 |
| P2 | Kein `/api/metrics` | DCT-108 |
| P2 | Redis-Adapter für Multi-Instanz offen | DCT-105 |
| P2 | Dependency-Audit (`npm audit`) offen | Release-Gate |

## 7. Empfehlung

**GO für Live-Test unter Auflagen:** Blocker sind erledigt, Kernpfade stabil und getestet.
Vor dem Live-Test müssen noch manuell durchgeführt werden: Docker-Build + Container-Start,
2-Browser-WebRTC-Smoke, ein 4-User-Test und ein Upload/Stem-Echtlauf.
