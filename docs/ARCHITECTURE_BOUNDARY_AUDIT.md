# audioMONASTRY – Architecture-Boundary-Audit (DCT-125/129)

Stand: 2026-08-27

**Ergebnis: 0 Verstöße** (`scripts/validate-interface-boundaries.mjs`, 220 Dateien / 25 Adapter).

| Boundary | Regel | Status |
|---|---|---|
| UI → Audio | nur über `audioEngine`-API | ✅ |
| Audio → UI | nur via Callback/Port-Events, nie DOM | ✅ (Audit-Script) |
| Audio → Network | verboten in Worklets | ✅ (Audit-Script) |
| Worklet → DOM | verboten | ✅ (Audit-Script) |
| Core → Plattform-APIs | nur über Adapter (`utils/*Adapter`, `core/WebAudioBackend`, `core/adapters.ts`) | ✅ |
| Registry | `getPluginRegistry()` einzige Quelle, immutable | ✅ |
| Ownership | Frontend → API-Gateway (`server.ts`) → Sidecars (`stem-ai`, `master-player`); `backend-core` historisch | ✅ |

**Automatisierung:** `scripts/audit-audio-realtime.sh` + `scripts/dead-code-sweep.sh` + Boundary-Scan laufen in `npm run verify`.
