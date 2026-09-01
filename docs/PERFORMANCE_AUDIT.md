# audioMONASTRY – Performance-Audit (DCT-119/127)

Stand: 2026-08-27 · lokal gemessen in der Sandbox.

| Metrik | Wert | Bewertung |
|---|---|---|
| Client-Bundle (min) | ~1,2 MB (gzip ~341 KB) | ⚠️ Lazy-Loading für seltene Module als Post-V1-Optimierung |
| Server-Bundle (`dist/server.cjs`) | ~134 KB | ✅ schlank |
| Unit-/Integrationstests | 158 Tests in ~6 s | ✅ schnell |
| Playwright E2E | 6 Tests in ~39 s | ✅ |
| Production Build | Vite ~25 s · Worklets/Server ~15 ms | ✅ |
| Worklet-CPU | GC-freie Hot-Paths, ObjectPool, SAB | ✅ (Audit-Script sauber) |
| Latenz-Pfade | DSP im Browser, Server nur Proxy | ✅ |

**Audits (automatisiert):**
- `scripts/audit-audio-realtime.sh` – verbotene Aufrufe in Worklets/Workern → **sauber**
- `scripts/dead-code-sweep.sh` – TODO/FIXME/@deprecated → **sauber**

**Bekannte Optimierungen (Post-V1):**
1. Route-basiertes Code-Splitting (selten genutzte Terminals lazy laden).
2. `onnxruntime-web` + Demucs-Modell weiter aus dem Haupt-Bundle herauslösen (bereits dynamisch).
3. Worklet-CPU-Budgets in `PerformanceMonitorTerminal` um Underrun-Zähler ergänzen.

## AM-E2-4 Plugin-Load-Balancing / NUMA (dokumentiert 2026-09-01)

- **Browser:** 1 `AudioContext` pro User → kein NUMA, keine Core-Pinning-Thematik.
  Worklets laufen im Browser-Audio-Thread; Lastverteilung macht der Browser.
- **Native Runtime (`services/audio-runtime`, Rust/cpal):** NUMA-/Core-Pinning als
  Option vorbereiten – geplant: `core_affinity`/`thread-priority` als experimentelle
  Runtime-Config (`runtime_config.yaml`), Standard bleibt „OS-scheduled“.

## AM-E4-5 Reverb-Strategie (dokumentiert 2026-09-01)

- **Aktuell:** `effectProcessor` nutzt ein minimales FDN-artiges Netz
  (2 Comb + 2 Allpass) – CPU-schonend, gut für Live-Betrieb.
- **High-Quality-Pfad (optional):** Convolution-Partitioning (partitionierte
  Faltung) für realistische Räume; erst sinnvoll, wenn Spektral-Features/IR-Loader
  kommen. Nicht im Produktivpfad, solange CPU-Budget < 70 % nicht gefährdet ist.
