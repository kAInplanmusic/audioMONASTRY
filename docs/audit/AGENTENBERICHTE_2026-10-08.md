# Agenten-Abschlussberichte 2026-10-08 (wörtlich archiviert)

Abschlussberichte der Hintergrund-Agenten für RT-AUDIT-P0-004 und RT-AUDIT-P1-010, unverändert übernommen, damit Einschränkungen und Folgepunkte nicht verloren gehen. Integration in main: siehe MASTERTODOENDE.json (note der Punkte) und die Folgepunkte RT-AUDIT-P0-004-F1/-F2/-F3, RT-AUDIT-P1-010-F1.

Hinweis zur Integration: Nach dem gemeinsamen Merge musste `tests/v2SamplePool.test.ts` (aus P1-010) an die echte Mastering-Latenz aus P0-004 angepasst werden – nach `stopSample` werden erst 2 Blöcke (Limiter-Lookahead, 240 Samples) verworfen, dann exakt Stille geprüft. Grenze unverändert (= 0).

Pfade im Bericht beziehen sich auf die damaligen Worktrees; die Worktrees sind entfernt, die Commits liegen in main.

---

## A4 · Bericht RT-AUDIT-P0-004 – Masterkette ohne Verzerrung

Die Masterkette verzerrt nicht mehr: Die THD liegt bei −18 dBFS unter 1e-5 % und bei −6 dBFS bei 0,00034 % (vorher 0,132 % bzw. 17,4 %). Damit sind beide audit:rt-Zeilen des Punkts OK, und alle Pflichtprüfungen sind grün. Für Grün mussten 27 bestehende Tests in 6 Dateien angepasst werden, weil die Masterkette jetzt wirklich 240 Samples verzögert. Diese Anpassungen bitte ansehen (Abschnitt unten). Den Status in MASTERTODOENDE.json habe ich wie vorgegeben nicht geändert, gepusht ist nichts.

**Branch:** `rt-audit/p0-004-mastering` im Worktree `/home/user/audioMONASTRY/.claude/worktrees/agent-a8ed5ddb08eec37f6`
**Commit:** `c62e071` („RT-AUDIT-P0-004: …“, audit:rt vorher/nachher im Commit-Text, Co-Authored-By und Claude-Session am Ende). Ein Commit, nur dieser Punkt.

### Umsetzung
- **Gemeinsamer Rechenkern** `src/core/dsp/masteringDynamics.ts`: Der MasteringNode und der Legacy-Worklet `masteringProcessor` rechnen mit diesem einen Kern.
- **Kompressor:**
  - Pegel in dB, Maximum über die Kanäle, Kennlinie `compressorCurveDb` mit Soft-Knee.
  - Glättung nach Giannoulis/Massberg/Reiss (JAES 2012, smooth decoupled peak detector).
  - Neue automatisierbare Parameter `compAttack` (Default 10 ms) und `compRelease` (Default 100 ms). Die Defaults stehen dokumentiert in `MASTERING_DEFAULTS`.
  - `release` ist weiterhin das Limiter-Release (50 ms).
- **Limiter:**
  - Delay-Line je Kanal mit `lookaheadSamples` = `v2MasteringLookaheadSamples(sr)` (240 bei 48 kHz). Sie wird nur bei Wechsel von Sample-Rate oder Kanalzahl neu angelegt.
  - Der Detektor liest das Eingangssignal des Limiters, Ziel-Gain = min(1, ceiling/|x|).
  - Gleitendes Minimum über eine vorallokierte monotone Deque, exponentielles Release, Attack-Rampe als gleitender Mittelwert über das Lookahead.
  - Ausgang = verzögertes Signal · Gain, danach harte Sicherung ±ceiling mit Zähler `safetyClipCount`. Der Zähler blieb in allen Tests bei 0.
- **True-Peak ist umgesetzt, kein Folgepunkt:**
  - 4×-Oversampling mit dem polyphasigen 48-Tap-FIR aus ITU-R BS.1770-4. Die Laufzeit des FIR ist über die Fensterlängen ausgeglichen, die Gesamtlatenz bleibt 240 Samples.
  - Messung mit 12-kHz-Sinus (Sample-Peaks nur 0,707 des echten Peaks), ceiling 0,5: der rekonstruierte Peak liegt mit True-Peak bei 0,497, ohne bei 0,707.
  - Der FIR wird übersprungen, wenn kein Inter-Sample-Peak das Ceiling erreichen kann; das ist eine exakte Grenze, kein Genauigkeitsverlust.
  - Kosten des Kerns: ca. 28 µs pro 128er-Block in Stereo (ca. 1 % des Budgets), ohne True-Peak ca. 22 µs.
- **Fehler unterwegs gefunden und behoben:** Bei voller Deque konnte ein neuer Eintrag den Kopf überschreiben. Jetzt werden verfallene Einträge zuerst entfernt. Ein Test vergleicht den Limiter bitgleich mit einem Brute-Force-Referenzmodell; mit dem alten Ablauf schlägt er nachweislich fehl (Abweichung ab Sample 241).
- **MasterSumNode:** `tanh` entfernt, die Summe ist linear, der NaN/Inf-Schutz bleibt. In StereoSumNode, PdcDelayNode, Monitor- und Cue-Bussen gibt es keine versteckte Sättigung.
- **Cue-Weg:** `V2MonitorGraph` verzögert den Cue-Weg zum Monitor jetzt um denselben Lookahead (`cuePdc`). Sonst lägen Cue und MAIN im MIX-Modus 5 ms auseinander.
- **Latenzanzeige:** `getLatencyBudgetMs` meldet jetzt `lookaheadSamples/sampleRate`, also die echte Latenz (5,0 ms bei 48 kHz). `cuePdcMs` meldet denselben Wert. In `audioEngine.ts` sind nur diese Methode und eine Import-Zeile geändert.
- **Legacy `masteringProcessor`:** auf den gemeinsamen Kern umgestellt statt gelöscht. Er hängt nicht im hörbaren Pfad, wird aber von audioEngine (Erzeugung, dort durfte ich nichts ändern), workletParamBridge, C0-Bindung und Plugin-Manifest angesprochen und von 6 Testdateien geprüft; Löschen hätte Tests gekostet, was verboten ist. Nachrichten-API, Rampen und die Release-Tabelle bleiben erhalten.
- **Doku:** `docs/DSP_PARITY_TOLERANCES.md` Abschnitt 2.3 aktualisiert.

### Pflichtprüfungen
| Prüfung | Ergebnis |
|---|---|
| `npx tsc --noEmit` | 0 Fehler |
| `npx eslint . --max-warnings=0` | 0 Findings |
| `npm test` | 317 Dateien, 2628 Tests grün (vorher 2614; 14 neu, keiner gelöscht oder übersprungen) |
| `npm run check:deadfiles` | exit 0 |
| `npm run verify:boundary` | 0 Verstöße (465 Dateien) |
| `node build-worklets.mjs` | erfolgreich |

**`npm run audit:rt`:**
| Zeile | Vorher | Nachher |
|---|---|---|
| RT-AUDIT-P0-004/-18 (THD) | 0,132 % FAIL | 0 % OK |
| RT-AUDIT-P0-004/-6 (THD) | 17,406 % FAIL | 0 % OK |
| P0-002/alloc | 0 OK | 0 OK |
| P0-002/gcmax | 3,19 ms FAIL | 0,988 ms OK |
| P0-002/p999 | 0,793 ms OK | 1,099 ms OK |
| P0-002/over | 4 FAIL | 1 FAIL |
| Gesamt | 6/12 | 9/12 |

- `over` = 1 ist VM-Jitter; nebenher lief der parallele Agent (Load-Average ca. 3).
- P1-011 und P1-009 sind unverändert FAIL; das sind andere Punkte.

### Neue Tests (`tests/masteringTruePeak.test.ts`)
- THD wie rt-bench bei −18 und −6 dBFS; MasterSumNode ist linear.
- Sinus-Burst +6 dBFS (100 Hz bis 11 kHz, ceiling 0,98 und 0,5): Ausgang nie über ceiling + 1e-6, Sicherung 0-mal ausgelöst.
- True-Peak-Fall und Brute-Force-Referenzmodell (siehe oben).
- Impuls bei 44,1, 48 und 96 kHz: genau ein Ausgangswert ungleich 0, exakt bei `lookaheadSamples`.
- Latenzbudget und Cue-PDC.
- Allokationsfreiheit: Ausgangsreferenzen über 1000 Blöcke identisch, keine neuen Port-Puffer.
- Attack/Release:
  - Attack 10 ms: 63 % der Gain-Reduction nach 10,13 ms (5 ms: 5,15 ms; 30 ms: 30,13 ms).
  - Release 100 ms: Rückgang auf 37 % nach 110,5 ms (50 ms: 61,1 ms; 300 ms: 310,1 ms). Toleranz jeweils ±30 %.
- Worklet und MasteringNode weichen weniger als 1e-4 voneinander ab.

### Angepasste Tests – bitte prüfen
Keiner dieser Tests schreibt die Verzerrung fest. Alle prüften im ersten 128er-Block, obwohl die PDC 5 ms Lookahead ausweist; das ist der Teil des Bugs „Latenz, die es nicht gibt“. Die Anpassung verschiebt nur das Messfenster um den echten Lookahead von 240 Samples, Grenzwerte bleiben gleich. Die v2Parity/v2Dsp-Paritätstests sind unberührt und grün.

- **`v2SinkEngine.test.ts` (9 Tests):**
  - „Step-Event sample-genau“: vorher Ton ab Sample 64, jetzt Stille exakt bis 64+240 und Ton ab 64+240.
  - „Testton gestoppt → Stille“: erst 240 Samples Latenz abwarten, dann dieselbe Grenze < 1e-6.
  - Sample-Player One-Shot, Loop, External Source, Kick/Hat, Mute, triggerSynth, Master-EQ: Fenster [240, 368) statt Block 0, gleiche Schwellen.
- **`v2Phase4.test.ts` (6):** Messung nach 2 Blöcken Einschwingen (auch nach jedem Routing-Wechsel). Beim 2.1-Test wird LFE über alle Blöcke bis zum verzögerten One-Shot geprüft.
- **`c0StudioChain.test.ts` (7):** Messung nach dem Einschwingen. Der SYNC-Test misst relativ zum Lookahead; die Erwartungen 0/16/0 sind unverändert.
- **`optionalDspWiring.test.ts` (2):** Fenster [240, 368).
- **`v2SinkFaults.test.ts` (2):** Referenz- und Folgeblock erst nach dem Einschwingen; Fehlerzählung und 1-s-Logik unverändert.
- **`v2SinkProcessorWorklet.test.ts` (1):** Der Burst wird jetzt exakt bei Frame 6000+240 erwartet (Block 48, Offset 96). Zusätzlich wird geprüft, dass alle Blöcke davor still sind.

`v2PdcImpulse.test.ts` bleibt unverändert grün.

### Einschränkungen und vorgeschlagene Folgepunkte
- **Step-Clock-PDC wirkt im Live-Pfad nicht.** Die Rechnung in `v2Pdc` und `V2SampleClock` stimmt mit dem echten Wert überein (240 Samples). Der Clock in `v2SinkProcessor` wird aber ohne `pdcCompensationSamples` gebaut. Bloßes Einschalten wäre falsch: Die vorgezogenen Frames lägen in schon gerenderten Blöcken. Der Clock müsste um L Samples vorauslaufen. Hörbare Steps kommen deshalb 5 ms nach den Step-Meldungen an den Main-Thread. `v2SinkProcessor` habe ich wegen RT-AUDIT-P1-010 nicht angefasst. Vorschlag: eigener Punkt.
- **Mögliche Konflikte mit dem P1-010-Agenten:** Ich habe die Tests `v2SinkFaults` und `v2SinkProcessorWorklet` angepasst, nicht aber `v2SinkProcessor` selbst. Falls der parallele Agent dieselben Testdateien ändert, kann es Merge-Konflikte geben.
- **Offline-Bounce:** Bounces sind jetzt um 5 ms verschoben, weil keine Latenzkompensation beim Trimmen erfolgt. Bei `tailSeconds: 0` fehlen die letzten 5 ms. Vorschlag: Folgepunkt.
- **Weitere Sättigung außerhalb des Live-Pfads:** Die Referenz-Spec `masteringSpec` in `src/core/audio/workletSpecs.ts` wendet weiter `tanh` an. Sie wird nur vom GraphPlaybackEngine bzw. Offline-Referenzpfad genutzt; `phase1Migration.test.ts` prüft diesen Wert. Außerhalb meines Auftrags, nicht geändert.
- **Kommentarleiche:** In `audioEngine.ts` sind `PDC_MASTERING_LOOKAHEAD_SEC` und der zugehörige Kommentar jetzt ungenutzt bzw. veraltet (nicht angefasst, da außerhalb von `getLatencyBudgetMs`).
- **Worktree:** Im Worktree liegt ein Symlink `node_modules` auf das Hauptrepo. Er ist per `.gitignore` ausgeschlossen und nicht committet.

### Dateien
Alle Pfade relativ zum Worktree `/home/user/audioMONASTRY/.claude/worktrees/agent-a8ed5ddb08eec37f6`.
- **Neu:**
  - `src/core/dsp/masteringDynamics.ts`
  - `tests/masteringTruePeak.test.ts`
- **Geändert (Code):**
  - `src/core/audio/nodes/processingNodes.ts` (nur MasteringNode und Import; EffectNode unberührt)
  - `src/core/audio/nodes/basicNodes.ts`
  - `src/audio/worklets/masteringProcessor.ts`
  - `src/core/audio/V2MonitorGraph.ts`
  - `src/core/audio/live/v2Pdc.ts` (nur Doku)
  - `src/core/audio/C0StudioChain.ts` (nur Kommentar)
  - `src/core/audio/V2StudioGraph.ts` (nur Kommentar)
  - `src/utils/audioEngine.ts` (nur `getLatencyBudgetMs` und Import)
  - `docs/DSP_PARITY_TOLERANCES.md`
- **Geändert (Tests):** die 6 oben genannten Testdateien unter `tests/`.
---

## A5 · RT-AUDIT-P1-010 – Abschlussbericht

Beide Schritte sind umgesetzt und alle Pflichtprüfungen grün. Pro Schritt gibt es einen eigenen Commit, nichts ist gepusht, `MASTERTODOENDE.json` ist unverändert.

**Branch:** `rt-audit/p1-010` (Worktree `/home/user/audioMONASTRY/.claude/worktrees/agent-ae386858d743108c7`, Basis `cd40e8a`)
- `d23bdf1` RT-AUDIT-P1-010: Sample-Pool mit IDs + Transfer, SFZ im Main-Thread parsen (Schritt 1)
- `fbfcc79` RT-AUDIT-P1-010: lock-freier SPSC-Steuer-Ring im SharedArrayBuffer (Schritt 2)

### Schritt 1 (Pflicht)
- **Transfer statt Klonen:** `V2LiveSink.loadSample(id, left, right, rate)` sendet `sample-load` mit Transfer-Liste.
  - Ist ein Array nur eine Ansicht auf einen größeren Puffer, wird es vorher kopiert.
  - `copyAudioBufferChannels()` kopiert über `copyFromChannel`. `getChannelData`-Ansichten werden nie übertragen.
  - Wer welchen Puffer danach noch besitzt, ist im Code dokumentiert.
- **Zuordnung:** `assignSample(channel, id)` schickt `sample-assign`. Bleibt die Zuordnung gleich, geht keine Nachricht raus.
- **Pool-Buchführung:** Sie gilt je Prozessor; ein neuer Knoten nach Neuaufbau oder Layout-Wechsel startet mit leerem Pool. Nicht zugeordnete Samples werden ab 128 MB verdrängt (LRU, `sample-unload`).
- **`sample-set` entfernt:** `setSampleBuffer` bleibt als Kompatibilitätsweg (Kopie → `loadSample` + `assignSample`).
- **Prozessor:** hält eine Map id → Sample, die nur im Message-Handler verändert wird, nie in `renderBlock`.
- **SFZ:**
  - `SfzRegion` und `matchRegion` liegen jetzt parserfrei in `sfzRegion.ts`; `sfzParser.ts` exportiert sie weiter.
  - Die Bank ohne Parser liegt in `sfzVoiceBankCore.ts` (`loadParsed`). `SfzVoiceBank` erweitert sie um `load(text)` für den Main-Thread.
  - Der Prozessor verarbeitet `sfz-regions` mit `loadParsed`.
  - `SfzBridge` parst einmal im Main-Thread und sendet die Regionen plus übertragene Kopien der Quellen.
  - Der gebaute Worklet-Bundle enthält keinen Parser mehr (0 Treffer für „Opcode“).
- **audioEngine:** `V2SampleUploader` (neu) ordnet über eine WeakMap jedem AudioBuffer bzw. Array eine ID zu.
  - `triggerEvent`, `syncV2SamplesToLiveSink`, `bridgeAudioBufferToV2` und `bridgeDecodedSamplesToV2` senden ein unverändertes Sample nicht erneut.
  - Nach einer Hörprobe auf demselben Kanal geht nur ein kleines `sample-assign` raus.
  - Für RT-AUDIT-P1-009 (Resampling) ist ein `prepare`-Hook vorbereitet, der vor `loadSample` läuft.

### Schritt 2 (Ringpuffer)
- **Ring:** `src/core/audio/live/controlRing.ts` nach dem Muster von ringbuf.js: Indizes als Int32 mit Atomics, feste Datensätze (Int32 op/channel/portSeq, Float32 a/b/c). Lesen geht ohne Allokation, Überläufe werden gezählt.
- **Was über den Ring läuft:** gain-db, pan, mute, master-gain, synth-trigger und sample-trigger.
  - Ist der Ring voll, wird der Überlauf gezählt und die Nachricht per postMessage zugestellt.
  - Aktiv nur mit SharedArrayBuffer und `crossOriginIsolated`, sonst bleibt alles bei postMessage.
- **Prozessor:** `renderBlock` liest den Ring am Blockanfang.
- **Reihenfolge Port ↔ Ring:** bleibt über eine Port-Sequenznummer vollständig erhalten.
  - Ein Trigger wartet auf sein vorher gesendetes `sample-assign`.
  - Jeder Port-Handler wendet ältere Ring-Datensätze zuerst an.

### Neue bzw. geänderte Dateien
- **Neu:** `src/audio/v2SampleUploader.ts`, `src/core/audio/live/controlRing.ts`, `src/core/instrument/sfzRegion.ts`, `src/core/instrument/sfzVoiceBankCore.ts`, `tests/v2SamplePool.test.ts` (17 Tests), `tests/v2ControlRing.test.ts` (12 Tests)
- **Geändert:** `src/core/audio/backends/V2LiveSink.ts`, `src/audio/worklets/v2SinkProcessor.ts`, `src/core/audio/live/V2SinkEngine.ts` (nur der Nachrichtentyp), `src/core/instrument/sfzParser.ts`, `src/core/instrument/sfzVoice.ts`, `src/audio/sfzBridge.ts`, `src/utils/audioEngine.ts`, `tests/sfzBridge.test.ts`
- Die Stellen des parallelen Agenten (P0-004) sind nicht angefasst.

### Was die Tests belegen
- **Kein Versand pro Schlag:** 100 × `triggerEvent` ergeben 0 × `sample-load`/`sample-set`, 0 × `sample-assign` und 100 × `sample-trigger` (Spy auf `post`). `syncV2SamplesToLiveSink` sendet bei unverändertem Sample ebenfalls nichts.
- **Transfer:** Nach dem Senden hat das übertragene Array `byteLength === 0`. Der Fake-Port bildet dafür `structuredClone(msg, {transfer})` nach. Der AudioBuffer bleibt intakt.
- **Kein Parser im Audio-Thread:** Der Laufzeit-Importgraph des Prozessors enthält weder `sfzParser.ts` noch `sfzVoice.ts`.
- **Klang:** Ein echter Prozessor spielt Pool-Samples und SFZ-Regionen hörbar ab. Die bestehenden Sample-, SFZ- und VoicePool-Tests sind grün.
- **Ring:** 10.000 Nachrichten gehen ohne Verlust und in Reihenfolge durch, Überläufe werden gezählt. Beim Lesen von 10.000 Datensätzen wächst der Heap um weniger als 8 KB; eine allozierende Variante misst etwa 480 KB.

### Prüfergebnisse (Stand nach Schritt 2)
- `npx tsc --noEmit`: 0 Fehler
- `npx eslint . --max-warnings=0`: 0 Findings
- `npm test`: 318 Dateien / 2643 Tests grün (nach Schritt 1: 317 / 2631). Kein Test gelöscht oder übersprungen.
- `npm run check:deadfiles`: exit 0
- `npm run verify:boundary`: 0 Verstöße (468 Dateien)
- `node build-worklets.mjs`: ok
- `npm run audit:rt`:

| Messung | vorher (`cd40e8a`) | nach Schritt 1 | nach Schritt 2 |
|---|---|---|---|
| Grenzen eingehalten | 5/12 | 6/12 | 6/12 |
| alloc (Arrays/Block) | 0 | 0 | 0 |
| gcmax | 1,106 ms | 1,207 ms | 1,053 ms |
| GC pro Sekunde | 0,083 | 0,067 | 0,083 |
| p99,9 | 1,576 ms | 1,311 ms | 0,754 ms |
| Blöcke über Budget (`over`) | 10 | 3 | 3 |

- `rt-bench` importiert keinen geänderten Laufzeitcode, die Schwankungen sind VM-Jitter.
- Zwei Läufe unter Last vom parallelen Agenten habe ich verworfen und die Last dokumentiert: Last 12 ergab gcmax 40,8 ms, Last 6,4 ergab 3,65 ms.

### Playwright-Probe
Chromium 1194, lokaler Server, 5-MB-Stereo-Sample, 100 Pad-Trigger im 40-ms-Abstand, je Variante 5 Läufe (2 ohne, 3 mit COOP/COEP).
- **Main-Thread:** Die 100 Trigger brauchen vorher 5,30–5,59 s, nachher 4,34–4,41 s (Ideal etwa 4,3 s). Pro Schlag entfallen damit etwa 10–13 ms Klon-Arbeit.
- **Audio-Uhr gegen Wanduhr:** Kein belastbarer Unterschied, das VM-Rauschen dominiert.
  - Spitzen von 135 und 150 ms gab es nur in der alten Variante mit Triggern.
  - Die neue Variante hatte aber auch im Leerlauf einmal 62 ms.
  - Einen Dropout-Rückgang im Audio-Thread kann ich deshalb nicht belegen.
- Der AudioBuffer war in allen Läufen intakt, der Ring war mit COOP/COEP aktiv.
- Die Probe-Skripte liegen nur im Scratchpad, nicht im Repo.

### Einschränkungen und Folgepunkte
- **Größter Folgepunkt (Proxy in `audioEngine`):** Der Proxy um `audioEngine` ruft vor jedem Methodenaufruf `syncV2FromV1()` auf. Dadurch erzeugt jeder `triggerEvent` zusätzlich rund 26 kleine Nachrichten.
  - Mit Ring laufen gain/pan/mute/master darüber.
  - `monitor-plan` (ein Objekt) geht aber weiterhin pro Schlag per postMessage.
  - Am Proxy habe ich nichts geändert; das gehört in einen eigenen Punkt.
- **SFZ nach Neuaufbau:** SFZ-Bänke werden nach einem Neuaufbau des Prozessors nicht erneut gesendet. Das war schon vorher so; Samples dagegen werden jetzt nach jedem Neuaufbau einmal neu geladen.
- **Doppelter SFZ-Speicher:** `SfzBridge` behält ihre Main-Thread-Bank mit den Original-Quellen und überträgt Kopien. Der Speicher ist damit doppelt belegt, wie vorher beim Klonen.
- **Regionen-Tabelle:** Sie wird weiterhin geklont, ist aber klein.
- **Float32 im Ring:** Werte im Ring sind Float32, gain/pan/velocity weichen also minimal (Float32-Rundung) vom Double-Wert ab.
- **Geänderter Test:** `tests/sfzBridge.test.ts` habe ich an die neue Schnittstelle angepasst. Begründung: Der alte Test schrieb fest, dass SFZ-Text an den Sink geht – genau der Befund. Jetzt prüft er Regionen plus kopierte Quellen. Das muss in die note.
- **Stilles Ignorieren:** Ein `sample-assign` mit unbekannter ID wird im Prozessor ohne Meldung ignoriert.
- **Umbau in `SfzVoiceBankCore`:** Index-Schleifen statt `for…of`/`some` (allokationsfrei), das Verhalten ist identisch.