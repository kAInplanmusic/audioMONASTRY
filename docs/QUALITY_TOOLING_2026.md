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

## 4. Totcode-Kaskade (QUAL-P2-003) – was in dieser Runde passiert ist

**Vorgehen in der richtigen Reihenfolge** (die erste Fassung scheiterte, weil sie
Exporte reduzierte, bevor die toten Dateien weg waren – dadurch brachen die
bewusst behaltenen Barrel-Dateien):

1. **Erreichbarkeit statt Namenssuche.** 263 Wurzeln (index.html→main.tsx,
   server.ts, Configs, scripts/**, tests/**, Worklet-Verzeichnis – letzteres wird
   von `build-worklets.mjs` per `readdir` gebaut) → BFS über aufgelöste Importe.
   Ergebnis: 628 erreichbare Dateien, 44 der 49 knip-Kandidaten unerreichbar.
2. **Klassifikation vor Löschung.** Nur was in **keinem** Dokument/Plan vorkommt
   und zusätzlich überholt ist, wurde gelöscht. Entfernt: `src/plugins/PluginBase.tsx`,
   `PluginLockable.ts`, `dsp-engine/DspEnginePlugin.tsx`, `instrumente/InstrumentePlugin.tsx`
   (eigener Kommentar: „Basisklasse für Legacy-Plugins“), `src/hubConnector.ts`,
   `src/hooks/useDevice.ts` → Boundary 404 → 398 Dateien.
   **Bewusst behalten** (im `knip.json`-`ignore` mit Begründung gruppiert):
   V1-Barrel (`src/core/index.ts`, `src/lib/db.ts`, `src/core/audio/backends/*`)
   und implementierte, aber nicht angebundene Infrastruktur (Session-Replikation,
   RingBuffer/WorkletPool/AsyncSandbox, Ambisonics/HRTF/SceneRenderers,
   EdgeDspClient/Failover, HardwareSimulator, Native-Runtime, webgpu_adapter).
   Grund: Projektregel „kein V1-Abbau vor V2-Parität“ + „kein stiller
   Funktionsverlust“. Rückholbar per `git checkout <sha> -- <pfad>`.
3. **Exporte/Typen reduzieren – mit zwei Schutzregeln** (beide aus Fehlschlägen
   gelernt): (a) kein Name, der irgendwo importiert **oder re-exportiert** wird;
   (b) nur zurückstufen, wenn die Deklaration in ihrer Datei selbst benutzt wird
   (sonst schlägt `--max-warnings=0` wegen einer ungenutzten lokalen
   Deklaration an). Ergebnis: **171 Exporte/Typen** über 89 Dateien auf
   „nur intern“ zurückgestuft, ohne eine Zeile Verhalten zu ändern.

| Kennzahl | vorher | nachher |
|---|---|---|
| ungenutzte Exporte | 221 | **136** |
| ungenutzte Typen | 137 | **51** |
| ungenutzte Dateien | 148 | **5** (dokumentierte Behalten-Liste) |

**Rest (eigene Runde, `QUAL-P2-004`):** 68 Deklarationen sind sogar **innerhalb
ihrer Datei** ungenutzt (Kandidaten für echte Löschung) und ~187 Exporte/Typen
sind nur deshalb noch offen, weil sie von bewusst behaltenen, nicht angebundenen
Dateien importiert werden. Beides braucht die Datei-für-Datei-Entscheidung
„anbinden oder löschen“, kein Skript.

## 5. Entscheidungs-Register „nicht angebundene Dateien“ (QUAL-P2-004)

**Vorgehen statt Bauchgefühl:** Die knip-Ausgabe wird als JSON gelesen und jede
gemeldete Deklaration per TypeScript-AST klassifiziert:

| Klasse | Bedingung | Aktion |
|---|---|---|
| **DELETE** | nirgends extern referenziert (Code/Doku/Tests) **und** im eigenen Modul nicht verwendet | Deklaration entfernt |
| **UNEXPORT** | nirgends extern referenziert, aber im eigenen Modul verwendet | `export` entfernt (Verhalten unverändert) |
| **KEEP** | extern referenziert (Barrel, Doku, API) oder kein Top-Level-Decl | bleibt, mit Begründung |

Die externe Referenz wird per `grep -rIl` über `src`, `server`, `services`,
`scripts`, `tests`, `docs`, `database` und alle `*.md` geprüft (nicht nur
Imports) — so fällt auch ein Name auf, der nur in einem Plan steht.

| Kennzahl | vor QUAL-P2-004 | nachher |
|---|---|---|
| ungenutzte Exporte | 136 | **106** |
| ungenutzte Typen | 53 | **40** |
| ungenutzte Dateien | 5 | 5 (Worklet-Runtime-Assets, s. §1) |

**Gelöscht (43 Deklarationen in 37 Dateien, per AST-Sweep, Gates danach grün):**
`cloudAutomationHealth`, `r2Blocked` (server);
`useAccess`; `errorStats`; `totalEstimatedVram`, `resolveRoleForTask`,
`EvalPluginId`, `PromptVersionEntry`; `defaultOutputLayout`; `supports24_2`;
`trackLabel`; `checkAudioSystem`; `RENDER_FACTORS`; `isNoteOn`; `OSC_IMMEDIATE`;
`midiClockTick`, `midiClockContinue`; `trackOf`, `isDrumRole`, `AudioElement`,
`MotionSequence`, `ALL_ROLES`; `TRACK_ROLE_ORDER`; `isV2SessionState`;
`getDropProfile`, `getDropProfilesForPlugins`; `isAudioContextLike`;
`noteToFreq`; `useAIStatus`; `MIDI_TYPE_LABEL`; `cosineSimilarity`;
`GPUTensor`; `AudioEvent`, `AIAudioResult`; `UploadMeta`; `V2StudioState`;
`V2OutputLayoutId`; `PluginLockPayload`; `offlineBounceEngine`;
`songOutputBridge` + die nur dafür existierende lokale Klasse; `getCachedAnalysis`;
`HRTFProcessingResultSchema` + `HRTFProcessingResult`.

**Zurückgestuft (`export` entfernt):** `RenderFactor` (`OfflineRenderer.ts`),
`ModPolarity` (`modMatrix.ts`).

**Bewusst behalten — mit Grund (jede Datei entschieden, nicht „irgendwie“):**

- **Barrels/Re-Exports** (`src/core/drop/index.ts`, `src/utils/midi.ts`,
  `src/core/spatial/spatialRenderers.ts`, `src/plugins/registry.ts` u. a.):
  bewusst behaltene öffentliche Fläche; Löschen wäre V1-Abbau (Projektregel).
- **Payload-Sicherheit (SEC-P1-001):** `validateSessionMembers`,
  `validateRoleChanged`, `validatePeerJoined`, `validatePeerLeft`,
  `validatePluginState`, `validateSessionFull` und `validateGeminiPreset`
  bleiben als Runtime-Validierung verfügbar.
- **Konfiguration/Deploy:** `SIGNALING_WS_URL`, `r2PublicBaseUrl`.
- **Cloud/Storage-API:** `uploadSampleBlobToCloud`, `removeSample`.
- **Worklet-/Engine-Init:** `createClockWorkletNode`, `createSynthWorkletNode`.
- **V1-Kompatibilität:** `translateLegacySpatialMessage`.
- **Session-/Infra-Paare:** `clearSessionScratchpad`, `createSfuTransportState`,
  `StudioSessionClaims`, `useCollabSession`.
- **Test-/UI-API:** `enterStudio` (E2E-Helfer), `toggleAudioPreview`.
- **Produktinhalt:** `HYPERSONIC_MOA_SYSTEM_PROMPTS`.
- **Bewusst nicht angebundene Infrastruktur** (in `knip.json` mit Begründung
  gruppiert, z. B. V1-Backends, Native-Runtime, Edge/Failover, Spatial/HRTF,
  Worker/Sandbox, State-Replikation, WebGPU-Adapter, firebase/db): Entscheidung
  **behalten bis nachgewiesener V2-Parität** (`AUDIO-P1-001`) — kein stiller
  Funktionsverlust, Rückholbar per `git checkout <sha> -- <pfad>`.

**Belege (Gates nach dem Sweep):** `npx tsc --noEmit` 0 Fehler ·
`npx eslint . --max-warnings=0` 0 Findings · Interface-Boundary-Scan 404 Dateien,
0 Verstöße · `npm run test:ci` 1222/1222 Tests grün, 0 übersprungen ·
`npm run check:deadcode` 106/40 statt 136/53.

