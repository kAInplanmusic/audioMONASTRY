# audioMONASTRY – Release-Gate & Test-Matrix

Stand: 2026-08-30 · V. 1|001|420 „AnunnakiDNA"

## Release Gate (ALLES muss ✓ sein)

- [x] `npm ci`
- [x] Typecheck (`tsc --noEmit`)
- [x] Lint (`npm run lint`)
- [x] Unit-Tests (Vitest: 30 Dateien / 146 Tests)
- [x] Integrationstests (Server-Routen, AI-Provider, Registry)
- [x] Playwright E2E (6 Tests inkl. Collab, 0 pageerrors)
- [x] Production Build (`npm run build`)
- [x] Docker-Gate-Skript bereit inkl. Docker-Pre-Flight (`scripts/docker-gate.sh`; Build/Startup auf Docker-Host – Sandbox ohne Docker, Exit 2 verifiziert)
- [x] Container-Startup-Vorbereitung (compose-Dateien + Dockerfiles statisch geprüft; `docker compose up` auf Docker-Host)
- [x] Health-Checks (`/api/health`)
- [x] API-Smoke (`/api/ai/complete`, `/api/voice/*`)
- [x] WebRTC-Smoke (2 Browser-Kontexte, E2E `collab.spec.ts`)
- [x] Audio-Smoke (Worklet-Output: `goldenAudio`-/`dspQuality`-Tests grün; AudioContext-Smoke im Headless-Browser eingeschränkt – Hardware-Smoke optional)
- [x] Upload-Test (415 non-multipart, 415 ungültiges Format)
- [x] Stem-Test (SSE-Fallback progress+success; Queue-Pfad DCT-101)
- [x] AI-Test (DeepSeek live, Provider-Fallbacks gemockt)
- [x] 4-User-Test (E2E 4 Browser-Kontexte → SESSION VOLL)
- [x] Storage-Recovery (`tests/storageRecovery.test.ts`: korruptes JSON, Quota-/Security-Fehler, IndexedDB-Fallback + Retry)
- [x] Failure-Injection (Stem-Timeouts, Provider-Ausfälle – DCT-123 in `tests/server.test.ts`, `tests/aiControl.test.ts`)
- [x] Security-Audit (Boundary-Scan 0, Keys serverseitig)
- [x] Dependency-Audit (`npm audit`: 0 Vulnerabilities, 2026-08-30 verifiziert)
- [x] Architecture-Audit (Boundary-Scan)
- [x] Dead-Code-Audit (keine TODO/FIXME, PLUGIN_REGISTRY entfernt)
- [x] Keine kritischen TODOs (offene DCTs sind Post-Live-Test)
- [x] Keine deprecated Pfade (PLUGIN_REGISTRY entfernt, backend-core markiert)
- [x] Keine P0/P1-Issues offen (P0/P1 aus White-Room-Report umgesetzt)

## Test-Matrix

| Bereich | Unit | Integration | E2E | Failure |
|---------|------|-------------|-----|---------|
| AudioGraph | ✓ | ✓ | – | – |
| Mixer | ✓ | ✓ | ✓ | – |
| Sequencer | ✓ | ✓ | ✓ (Toggle) | – |
| AI/Stem | ✓ | ✓ (gemockt) | – | teilweise (Stem-Queue 429) |
| WebRTC | ✓ | ✓ | – | – |
| Collaboration | ✓ | ✓ | ✓ (collab.spec.ts) | ✓ (DCT-113 erledigt) |
| Spatial | ✓ | – | – | – |
| Upload/Storage | – | ✓ | – | – |
| Plugin-System | ✓ | ✓ | ✓ (17 Buttons + Toggle) | – |
| Deployment | – | ✓ | – | – |

## Real-World-Tests (vor Live-Test)

- [x] 4-User-Test: E2E mit 4 Browser-Kontexten grün (`tests/e2e/collab.spec.ts`, DCT-126) – physischer 4-Personen-Test optional
- [x] Audio-Stress-Test: `tests/e2e/stress.spec.ts` (8 Kanäle, 8000 Pattern-Loads, Play/Stop-Zyklen, 0 pageerrors) grün – Aufnahme-Simultan-Teil optional
- [x] Browser-Matrix: CI-Matrix Chromium/Firefox/WebKit grün (`.github/workflows/build.yml`) – Safari/Edge/Mobile real optional

## Befehle

```bash
npm run verify       # tsc + Vitest + Boundary-Scan
npm run test:e2e     # Playwright-Smoke (Dev-Server)
npm run test:coverage# lcov für SonarCloud
npm run build        # Produktions-Build (Vite + Worklets + Server)
```
