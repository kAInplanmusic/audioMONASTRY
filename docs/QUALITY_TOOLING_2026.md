# Qualitäts-Werkzeuge: Totcode, Duplikate, stille Test-Skips (2026-09-11)

Bezug: `MASTERTODOENDE.json` → `QUAL-P2-001`, `QUAL-P2-002`, `CI-P1-001`.
Alle Zahlen sind gemessen und über die genannten Befehle reproduzierbar.

```bash
npm run check:deadcode   # knip (Konfiguration: knip.json)
npm run check:dupes      # jscpd (min-tokens 100)
npm run test:ci          # Vitest + Gate gegen übersprungene/todo-Tests
```

---

## 1. Totcode (knip) – Klassifikation vor Löschung

**Ausgangslage ohne Konfiguration:** 148 „unused files", 239 unused exports,
140 unused types, 22 unlisted imports, 3 duplicates – praktisch unbrauchbar, weil
knip **Betriebs-Einstiegspunkte** nicht kennt. `scripts/*` (Gates, Benchmarks,
Deploy), `services/*` (eigene Deployables) und `tests/e2e/*` werden nie
importiert und galten deshalb pauschal als tot.

**Konfiguration (`knip.json`)** deklariert genau diese als `entry` und ignoriert
Build-Artefakte (`dist/**`, `public/worklets/**`, `test-results/**`). Ergebnis:

| Kategorie | vorher | nachher |
|---|---|---|
| unused files | 148 | 49 |
| dependencies | 2 | **0** |
| devDependencies | 2 | **0** |
| unlisted | 22 | **0** |

**Tatsächlich entfernt (mit Gates verifiziert):**

- **11 Dateien ohne jede Referenz** (kein Import, kein String-/Doku-Treffer):
  `src/ai/aiRouter.ts`, `src/ai/costMonitor.ts`,
  `src/components/CustomSlotTerminal.tsx`, `src/components/StreamLayout.tsx`,
  `src/monitor/LiveMonitor.tsx`, `src/utils/LatencyMonitor.ts`,
  `src/utils/LiveStreamOut.ts`, `src/utils/ObjectPool.ts`,
  `src/utils/audioDiagnostics.ts`, `src/utils/dspOptimizations.ts`,
  `src/utils/spatialAutomation.ts` — Boundary-Scan 414 → 403 Dateien.
- **3 ungenutzte Pakete:** `motion`, `ytdl-core`, `autoprefixer` (kein Import,
  kein PostCSS-Config; Tailwind v4 bringt Prefixing selbst mit) → −11 Pakete im
  Lockfile.

**Bewusst NICHT gelöscht (klassifiziert):**

- **V1-Legacy** (`NativeBackend.ts`, `AudioBackend.ts`, `nativeAudioKit.ts`, …):
  wird erst nach nachgewiesener V2-Parität entfernt (siehe `AUDIO-P1-001` /
  `V1_REMOVAL_REPORT.md`). Löschen wäre ein Funktionsrisiko.
- **Do-Exporte** (knip „duplicates"): `workerPool`+`default`,
  `audioEngine`+`audioV2TerminalBridge`, `DJMixer`+`DJ4ChMixer` — identisches
  Objekt unter zwei Namen, **beide Namen werden benutzt** → kein Totcode.
- **Service-Abhängigkeiten** (`ws`/`midi`/`osc` in `services/midi-bridge`,
  `mixer-*`-Plattform-Binaries in `services/mixer`): stehen in den jeweiligen
  Service-`package.json` bzw. werden zur Laufzeit optional geladen.
- **222 unused exports / 137 unused types** in 100 Dateien: das ist ein
  **Kaskaden-Thema** (tote Dateien importieren tote Typen). Ein Massenschnitt
  berührt 100 Dateien gleichzeitig — dafür gibt es den eigenen Punkt
  `QUAL-P2-003` (iterativ: erst Dateien, dann Exporte, jeweils Gate-gestützt).

## 2. Duplikate (jscpd)

| Kennzahl | vorher | nachher |
|---|---|---|
| Klone | 15 | **12** |
| Duplikat-Anteil | 0,273 % | **0,204 %** |

**Entfernt:** derselbe 16-Bit-PCM-WAV-Encoder lag **fünfmal** im Code
(`localDemucs.ts`, `stemSplitter.ts`, `VoiceMonkService.ts`, zweimal inline in
`melody.ts`) — mit **unterschiedlichem Clamping**. Jetzt gibt es **eine**
Implementierung: `src/utils/wavEncode.ts` (+ 8 Tests in
`tests/wavEncode.test.ts`). Bewusste, dokumentierte Änderung: negatives Clamping
nutzt den vollen −32768 (asymmetrisch, korrekt) statt −32767; positives Verhalten
bleibt byte-identisch (Abschneiden wie zuvor durch `setInt16`).

**Verbleibende 12 Klone (klassifiziert, kein Handlungsbedarf):**

- `audio/worklets/dynamicsProcessor.ts` ↔ `core/audio/nodes/processingNodes.ts`:
  **beabsichtigt** — Worklets sind eigene Build-Ziele und müssen ohne Importe
  aus dem App-Graph auskommen.
- Gleiche-Datei-Wiederholungen (`DJ4ChMixer.tsx`, `melody.ts`, `fmEngine.ts`,
  `main.rs`): strukturell ähnliche, aber unterschiedlich parametrisierte Blöcke;
  ein Herausziehen würde die Lesbarkeit verschlechtern.
- `V2MonitorGraph.ts` ↔ `V2StudioGraph.ts`: Kandidat für einen gemeinsamen
  Graph-Builder — als Folgepunkt notiert, nicht in diesem Durchgang (Risiko am
  Audio-Pfad).

## 3. Stille Test-Skips (CI-P1-001)

`npm run test:ci` schreibt den Vitest-JSON-Report und lässt den Lauf rot werden,
wenn ein Test `skipped`/`todo` ist. Beide Richtungen bewiesen: künstlicher
`it.skip` → Exit 1; voller Lauf 1181 Tests → Exit 0.
