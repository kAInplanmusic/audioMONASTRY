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

## AM-E6-6 A/B-Validierung für kritische DSP-Änderungen (dokumentiert 2026-09-03)

**Gate:** `tests/goldenAudio.test.ts` ist das Regressions-Gate für DSP-Änderungen.
Es rendert eine definierte Quelle (440 Hz + 554,37 Hz, 1 s) durch alle
Referenz-Worklets und vergleicht **bit-genau** mit dem committeten WAV-Fixture
(`tests/fixtures/audio/golden-1s.wav`). Zusätzlich prüft es Determinismus
(zwei Render identisch) und P0-4 (60 s Stille ≤ -60 dBFS).

**Verfahren (A/B):**
1. Vor der DSP-Änderung: `npm run generate:golden`-Quelle dokumentieren und
   `npx vitest run tests/goldenAudio.test.ts` als Baseline grün notieren.
2. Änderung umsetzen.
3. `npx vitest run tests/goldenAudio.test.ts` muss **weiterhin grün** sein
   (Bit-Genauigkeit). Bei beabsichtigter Klangänderung: Fixture bewusst neu
   generieren, Diff dokumentieren (vorher/nachher-Hash + Messwerte).
4. Messwerte (RMS/True-Peak/CPU) vorher/nachher in `MASTER_TODO.md` bzw.
   `TASKDONE.md` dokumentieren – so bleibt jede Optimierung nachvollziehbar.

**CI:** `nightly.yml` führt `npm run verify` aus; darin enthalten sind
Typecheck, alle Vitest-Suiten inkl. `goldenAudio.test.ts` und der
Interface-Boundary-Scan. Ein DSP-Regress bricht den Nightly-Lauf (Exit 1).

## AM-E4-1 Sample-Raten-Konvertierung (spezifiziert 2026-09-03)

- **Browser:** SRC ist unsichtbar – der AudioContext resampelt selbst. Kein
  Eingriff nötig; `sampleRate` wird beim Context-Aufbau gesetzt (P1-3/P2-1).
- **Native Runtime (`services/audio-runtime`, Rust/cpal):** Polyphase/Farrow-
  Struktur spezifizieren:
  - 44.1 ↔ 48 kHz: Polyphase-FIR (z. B. 64 Phasen, 32 Taps, Kaiser-Fenster)
  - Beliebiges Ratio: Farrow-Struktur (kubisch) als Fallback
  - **Roundtrip-Test** (44.1→48→44.1) als Regression: Null-Spektrum außerhalb
    des Nutzbands < -100 dB, Latenz < 1 ms.
- Status: Spezifikation; Implementierung erst mit nativem Runtime-Build.

## AM-E4-7 SIMD/NEON/AVX (vorbereitet 2026-09-03)

- **Browser:** kein direktes SIMD; JS-Worklets laufen bereits in 128er-Blöcken
  (V8 kann auto-vektorisieren). Keine `new Array`/`Math.pow`/`.push` im
  Hot-Path (statisches Audit `tests/workletRampAudit.test.ts`).
- **Native Runtime (Rust):** `std::simd`/`wide`-Crates für f32x4/f32x8-Pfade
  in Biquad/Oversampling-Cores vorbereiten; Feature-Gates je CPU
  (SSE2/AVX2/NEON), skalare Referenz bleibt für Tests.
- Status: Vorbereitung/Doku; Implementierung mit nativem Runtime-Build.
