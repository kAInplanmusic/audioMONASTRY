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
- [ ] Docker Build (alle Container – Skript `scripts/docker-gate.sh` bereit, Docker nicht in Sandbox)
- [ ] Container-Startup (compose up + health – siehe docker-gate.sh)
- [x] Health-Checks (`/api/health`)
- [x] API-Smoke (`/api/ai/complete`, `/api/voice/*`)
- [x] WebRTC-Smoke (2 Browser-Kontexte, E2E `collab.spec.ts`)
- [ ] Audio-Smoke (Worklet-Output, AudioContext – im Headless-Browser eingeschränkt)
- [x] Upload-Test (415 non-multipart, 415 ungültiges Format)
- [x] Stem-Test (SSE-Fallback progress+success; Queue-Pfad DCT-101)
- [x] AI-Test (DeepSeek live, Provider-Fallbacks gemockt)
- [x] 4-User-Test (E2E 4 Browser-Kontexte → SESSION VOLL)
- [ ] Storage-Recovery (IndexedDB/localStorage-Korruption)
- [ ] Failure-Injection (Stem-Timeouts, Provider-Ausfälle)
- [x] Security-Audit (Boundary-Scan 0, Keys serverseitig)
- [ ] Dependency-Audit (`npm audit`)
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
| Collaboration | ✓ | ✓ | – | teilweise (DCT-113 offen) |
| Spatial | ✓ | – | – | – |
| Upload/Storage | – | ✓ | – | – |
| Plugin-System | ✓ | ✓ | ✓ (17 Buttons + Toggle) | – |
| Deployment | – | ✓ | – | – |

## Real-World-Tests (vor Live-Test)

- [ ] 4-User-Test: DJ, Producer, Engineer, Stem/AI gleichzeitig
- [ ] Audio-Stress-Test: 8 Tracks, FX, Spatial, Recording simultan
- [ ] Browser-Matrix: Chromium, Chrome, Edge, Safari, Firefox, Mobile

## Befehle

```bash
npm run verify       # tsc + Vitest + Boundary-Scan
npm run test:e2e     # Playwright-Smoke (Dev-Server)
npm run test:coverage# lcov für SonarCloud
npm run build        # Produktions-Build (Vite + Worklets + Server)
```
