# Audit: Audio-Signalweg (audioMONASTRY)

**Datum:** 2026-09-20
**Audit-Basis:** Branch `main`, HEAD `abd73d7`, sauberer Arbeitsbaum
**Maßstab:** `AGENTS.md` §1.3 (Ultra-Low-Latency-Mandat, „sub-millisecond") und
§5 (Canonical Plugin Architecture: synchrones `process(audioBlock)`, kein
Netzwerk/Storage/React-State/blockierender Lock im `process()`, time-kritischer
DSP an der Worklet/WASM/Audio-Backend-Grenze, `OFF` = transparenter Bypass).
**Umfang:** 16 Worklet-Prozessoren in `src/audio/worklets/*.ts` (3181 Zeilen),
Rust/WASM-Kernel in `src/audio/wasm/*` und `src/audio/spatial/wasmHrtf.ts`,
Graph-/Live-Pfad in `src/core/audio/**`, Engine-Fassade
`src/utils/audioEngine.ts` (2481 Zeilen).

> **Ehrlichkeits-Klausel.** Alle Zeilenangaben beziehen sich auf den Stand
> `abd73d7`. In den Dateien, die dieser Audit **verändert** hat, verschieben die
> Fixes die Zeilennummern (die aktuellen Nummern stehen im `git diff`). Alle
> Zahlen im Dokument stammen entweder aus dem Quelltext (mit `Datei:Zeile`) oder
> aus einem tatsächlich ausgeführten Kommando; die Rohausgaben der Gates stehen
> wörtlich in §9. Geschätzte oder nicht gemessene Größen sind ausdrücklich als
> solche gekennzeichnet.
>
> **Nebenbefund zum Auftragsumfang:** Der Auftrag nennt „17 Prozessoren";
> `ls src/audio/worklets/*.ts` liefert genau **16** Dateien (dsp, eq, mastering,
> lufs, spatial, granular, fm6, itSynth, drumSynth, dynamics, effect, synth,
> analyzer, fallback, v2Sink, clock). Es fehlt keine Datei – die Zahl 17 zählt
> vermutlich einen Nicht-Worklet-DSP-Pfad mit.

---

## 1. Gliederung

1. Gliederung
2. Befund-Übersicht (nach Schwere)
3. Echtzeitpfad-Disziplin (Allokation, Logging, Locks im `process()`)
4. Latenz-Budget
5. Worklet-Qualität (k-/a-rate, Sample-Rate, Oversampling, Tail/Reset, Bypass)
6. Numerik (Denormals, NaN/Inf, Clipping, DC)
7. WASM-Rolle
8. Vergleich zum Stand der Technik (Empfehlungen ohne Umbau)
9. Umgesetzte Fixes + Abdeckung + Gate-Ausgaben (wörtlich)
10. Bewusst NICHT umgesetzt
11. Offene Punkte / nicht verifizierbar

---

## 2. Befund-Übersicht

| # | Schwere | Befund | Beleg | Status |
|---|---------|--------|-------|--------|
| F1 | **HOCH** | Allokationen im `process()`-Hot-Path (3 Stellen: SFZ-Block, Panning-Objekt pro Sample, FM6-Mixpuffer) | `v2SinkProcessor.ts:273`, `spatialProcessor.ts:417/445/467`, `fm6Processor.ts:48` | **gefixt** |
| F2 | **HOCH** | `itSynth`: Transposition potenziert sich pro Sample → Frequenz-Explosion bei Transpose ≠ 0 | `itSynthProcessor.ts:192-193` | **gefixt** (bitgenau neutral bei Transpose = 0) |
| F3 | **HOCH** | Fehlender `outputs[0]`-Guard in 3 Worklets → Throw aus dem Audio-Thread möglich | `dspProcessor.ts:111/113`, `eqProcessor.ts:175/176/178`, `effectProcessor.ts:142/144` | **gefixt** |
| F4 | MITTEL | Render-Quantum hart als 128 verdrahtet (Clock + Analyzer) | `clockProcessor.ts:58`, `analyzerProcessor.ts:25` | **gefixt** |
| F5 | MITTEL | Biquad-Zustand ohne NaN-/Denormal-Guard → ein NaN macht ein EQ-Band dauerhaft still | `eqProcessor.ts:146-150` | **gefixt** |
| F6 | MITTEL | Fehlende Klammern: `crushCounter = 0` läuft bei **jeder** Port-Nachricht | `effectProcessor.ts:62` | **gefixt** |
| F7 | MITTEL | `LeslieSim` mit hartcodiertem `48000` konstruiert (falsche Rotordrehzahl bei 44,1/96 kHz) | `synthProcessor.ts:116` | **gefixt** |
| F8 | MITTEL | WASM-Rolle: `WasmBackend` lädt/instanziiert den Kernel und **verwirft** die Instanz; gerendert wird in JS. Daneben tote WASM-Felder im Spatial-Prozessor | `WasmBackend.ts:23-35,46-59`, `spatialProcessor.ts:133-138` | Empfehlung (Instanz-Teil); tote Felder dokumentiert |
| F9 | MITTEL | Latenz-Budget: Lookahead wird an zwei Stellen unabhängig hergeleitet; §1.3 („sub-ms") ist für den Mastering-Pfad strukturell unerreichbar | `masteringProcessor.ts:80`, `v2Pdc.ts:10-15`, `v2SinkProcessor.ts:84` | Empfehlung |
| F10 | NIEDRIG | Werkzeug-/Konsistenzbefunde (Doku-Drift EQ, Pipeline nur von Tests instanziiert + `console.warn` im Blockpfad, LUFS ohne K-Weighting/Gating, ungeprüftes `freq`/ungenutzte Velocity, Integer-Delay im Chorus, Destructuring im Sample-Loop) | §3.6 / §8 | teils gefixt, teils Empfehlung |

**Summe: 3 HOCH, 6 MITTEL, 1 NIEDRIG-Sammelbefund** (in dem 7 Einzelpunkte mit
eigenem Beleg stecken).

**Umgesetzt und durch die Gates gedeckt:** F1, F2, F3, F4, F5, F6, F7 und der
Doku-Teil von F10.
**Bewusst nur empfohlen:** F8, F9 sowie alle klangrelevanten Punkte aus §8.

---

## 3. Echtzeitpfad-Disziplin (Allokation, Logging, Locks im `process()`)

**Positiv belegt (Volltextprüfung aller 16 Prozessoren):** In keinem `process()`
steht ein `console.*`, ein `fetch`/`localStorage`/`indexedDB`-Zugriff, ein
React-/Store-Zugriff (`setState`, `useStore`, `zustand`) oder ein `await`. Auch
kein `Atomics.wait` – `lufsProcessor.ts:26` nutzt nur `Atomics.store` (nicht
blockierend). Die Zustandsgrenzen Worklet ↔ Main-Thread laufen ausschließlich
über `port.onmessage`/`port.postMessage`.

**Bypass-Transparenz (§5 „OFF = transparenter Bypass"):**
- `dynamicsProcessor.ts:295-301`: `if (!this.enabled) { output[ch].set(input[ch] ?? input[0]); }`
  – **bitgenauer** Bypass, keine Latenz, keine Färbung. Vorbildlich.
- `fallbackProcessor.ts:7-25`: 1:1-Passthrough mit NaN-Sanitisierung.
- `PluginAudioPipeline.ts:33-34`: `if (!adapter || adapter.state === 'OFF') continue;`
  – OFF wird korrekt übersprungen (siehe aber F10.2: die Klasse ist nicht
  produktiv verdrahtet).
- `v2SinkProcessor`, `granularProcessor`, `synthProcessor`, `fm6Processor`,
  `drumSynthProcessor`, `itSynthProcessor`, `clockProcessor` **erzeugen** Signal
  bzw. Takt und besitzen kein OFF-Konzept – hier ist „Bypass" nicht anwendbar.

### F1 (HOCH) – Allokationen im `process()`

**F1.1 `v2SinkProcessor` (SFZ-Quellen):**
```
v2SinkProcessor.ts:271-276
  for (const [channel, bank] of this.sfzBanks) {
    if (!bank.hasActiveVoices()) continue;
    const mono = new Float32Array(length);   // Heap-Allokation pro Block+Kanal
    bank.renderBlock(mono, length);
    this.engine.setExternalSource(channel, [mono]);   // zusätzlich ein Array-Literal
  }
```
Bei 48 kHz läuft `process()` 375×/s; pro aktivem SFZ-Kanal entstehen damit ein
neuer `Float32Array` **und** ein neues einelementiges Array im Audio-Thread.

**F1.2 `spatialProcessor` (Objekte pro Sample):**
```
spatialProcessor.ts:56-62   azToStereoGains() liefert `return { left, right };`
spatialProcessor.ts:417     Aufruf im WASM-Pfad
spatialProcessor.ts:445     Aufruf im Low-Pfad
spatialProcessor.ts:467     Aufruf im Medium/High-FIR-Pfad
```
Alle drei Aufrufe stehen im innersten Per-Sample-Loop: 8 Quellen × 128 Frames =
**1024 Objekte pro Block = 384 000 Objekte/s**. Der Dateikopf behauptet
ausdrücklich „process() allokiert nichts" (`spatialProcessor.ts:18-19`) – der
Code hielt das an dieser Stelle nicht ein.

**F1.3 `fm6Processor` (Mixpuffer):**
```
fm6Processor.ts:48   const mix = new Float32Array(blockLen);
```
Pro Render-Quantum ein neuer Puffer (375/s), obwohl `blockLen` konstant 128 ist.

**Fix:** Scratch-Puffer bzw. nicht-allokierende Panning-Variante; Details und
Gate-Belege in §9. Bei `spatialProcessor` wurde dafür eine neue, nur intern
genutzte Funktion `azToStereoGainsInto()` ergänzt; die **exportierte**
`azToStereoGains()` liefert weiterhin ein frisches Objekt (keine
Aliasing-Überraschung für Aufrufer/Tests).

**Weiterhin offen (bewusst, F1.4):** `v2SinkProcessor.ts:268`
(`const events: V2StepRenderEvent[] = []` pro Block) und
`v2SinkProcessor.ts:315-320` (Objekt-Literal als `render()`-Argument pro Block)
sowie `V2SinkEngine.ts:387-389` (`[...events, ...pendingSynthTriggers]`). Ob
diese verhaltensneutral in wiederverwendete Strukturen wandern können, hängt
davon ab, ob `render()` die Argumente nur liest oder Referenzen behält – das
wurde **nicht** vollständig geprüft und deshalb **nicht** angefasst (§11).

### F10.2 (NIEDRIG) – Fehler-Logging im Blockpfad
```
PluginAudioPipeline.ts:37-44
  try { block = adapter.process(block); }
  catch (err) { … console.warn(`[plugin-pipeline] ${pluginId} process failed`, err); }
```
Der Kommentar sagt „kein Log-Spam im Audio-Thread", der Code loggt aber
ungeratelimitet – bei einem dauerhaft werfenden Adapter wären das bis zu 375
Zeilen/s. Der Fail-Safe selbst (Block unverändert weiterreichen) ist richtig.
**Zusatzbefund:** `PluginAudioPipeline` wird **ausschließlich** von
`tests/pluginAudioPipeline.test.ts` instanziiert (Volltextsuche über `src/` und
`tests/`); der Live-Pfad läuft über die Worklets. Die Klasse, die die
§5-Regeln durchsetzen soll, ist damit derzeit toter Produktionscode.

---

## 4. Latenz-Budget

### 4.1 Belegte Bestandteile

| Baustein | Wert | Herkunft |
|---|---|---|
| Mastering-Lookahead (Delay-Line) | `max(16, round(0.005·SR))` Samples → **240 @48k / 221 @44,1k / 480 @96k** | Code: `masteringProcessor.ts:80`; gespiegelt in `v2Pdc.ts:10-15`; Test: `tests/v2PdcImpulse.test.ts:71-76` |
| Render-Quantum | 128 Frames = **2,667 ms @48 kHz** (per Spec) | Code: `v2SinkProcessor.ts:84,412-413` |
| PDC-Kompensation des Step-Frames | `frame − lookaheadSamples` | Code: `v2Pdc.ts:23-25`; Test: `tests/v2PdcImpulse.test.ts:71-95` |
| `baseLatency` der Gate-Umgebung | **0,0106667 s = 10,67 ms** (sampleRate 48000, state=running) | **Messung** `npm run perf:worklet`, Rohausgabe in §9.5 |
| Worklet-Last v2-Sink | 2500 Blöcke, Ø **0,3916 ms**/Block, **14,69 %** des 2,667-ms-Budgets, **0** verpasste Quanten | **Messung** `npm run perf:worklet`, §9.5 |
| Dynamik-Kette | **ohne Lookahead** (bewusste, dokumentierte Entscheidung zur Latenzvermeidung) | Code: `dynamicsProcessor.ts:9-11` |

**Summe der Latenzquellen (kein Messwert, sondern Summe aus gemessener
`baseLatency` und code-belegten Werten):** 10,67 ms (`baseLatency`, gemessen)
+ 2,667 ms (Render-Quantum, Code) + 5 ms (Mastering-Lookahead, Code) ≈
**18,3 ms**, bevor `outputLatency` (Hardware/Audio-Stack) hinzukommt. Diese
Summe ist ausdrücklich **nicht** als eine Messung zu lesen; `outputLatency`
wurde in diesem Audit nicht gemessen (die Engine stellt sie bereit:
`audioEngine.ts:1698-1705`).

### F9 (MITTEL) – Latenz-Herleitung und §1.3-Anspruch

**(a) Zwei unabhängige Herleitungen desselben Werts.** Der Lookahead existiert
als Klassenfeld im Prozessor (`masteringProcessor.ts:80`, aus dem Worklet-Global
`sampleRate`) **und** als Konstante plus Funktion in `v2Pdc.ts:10-15`
(`V2_MASTERING_LOOKAHEAD_SEC = 0.005`, Default-Parameter 48000). Beide Formeln
sind heute identisch; nichts erzwingt das. Der Prozessor **exportiert** bereits
`getLookaheadSamples()` (`masteringProcessor.ts:83`), `v2Pdc.ts` konsultiert ihn
aber nicht, und `GraphPlaybackEngine.ts:29,45-47` spiegelt den Wert ein drittes
Mal über `v2MasteringLookaheadSamples()`. Eine einseitige Änderung erzeugt einen
stillen Phasenversatz statt eines Fehlers.
**Empfehlung:** eine Quelle der Wahrheit (Konstante importieren und im Prozessor
daraus rechnen) + ein Test, der `getLookaheadSamples()` gegen
`v2MasteringLookaheadSamples(sr)` für 44,1/48/96 kHz prüft.

**(b) §1.3 ist für den Mastering-Pfad strukturell nicht erreichbar.** Allein
Lookahead (5 ms) + Render-Quantum (2,667 ms) sind ~7,7 ms, dazu kommen die
gemessenen 10,67 ms `baseLatency`. „sub-millisecond" (AGENTS.md §1.3) kann nur
für die *Rechenzeit pro Block* gelten – und die ist mit Ø 0,3916 ms gemessen
tatsächlich sub-millisecond. Das ist ein **Dokumentationsbefund**: §1.3
vermischt Rechenbudget und Signallatenz. Empfehlung: §1.3 präzisieren (z. B.
„Prozess-Latenz pro Block < 1 ms; Gesamt-Latenz der Mastering-Kette
dokumentiert und budgetiert").

**(c) Keine weitere unnötige Latenzquelle gefunden.** In keinem Prozessor
existiert ein zusätzlicher Lookahead oder ein überdimensionierter Puffer:
- `networkLatency`-Puffer, `setTimeout`-Scheduler im Audio-Pfad: keine
  (`V2SampleClock.ts:6-8` ersetzt den früheren `setInterval`-Pfad,
  `GraphPlaybackEngine.ts:50-52,65-68` startet bewusst keinen Timer mehr).
- `dynamicsProcessor` verzichtet explizit auf Lookahead (`:9-11`).
- Direkte Faltung mit 8–64 Taps im Spatial-Pfad (`spatialProcessor.ts:459-465`)
  fügt **keine** Latenz hinzu (FIR beginnt bei Tap 0).

---

## 5. Worklet-Qualität

### F4 (MITTEL) – Hartcodierter Render-Quantum
```
clockProcessor.ts:58    const blockLen = perSample ? bpmArr!.length : 128;
analyzerProcessor.ts:25 const quantum = 128 / sampleRate;
```
`eqProcessor.ts:31-32,176` hat genau dieses Problem unter „A-6: Quantum aus der
tatsächlichen Blocklänge ableiten" bereits behoben
(`this.blockSize = input[0].length`) – Clock und Analyzer waren nicht
nachgezogen. Bei einem Render-Quantum ≠ 128 driftet der Phasen-Akkumulator des
Clocks systematisch (nicht jitternd), und die Dropout-Erkennung des Analyzers
vergleicht gegen die falsche Quantengröße. Beide Fixes sind bei 128 Frames
wertgleich.

### k-rate vs. a-rate
Genau **ein** Prozessor deklariert `parameterDescriptors`: `clockProcessor.ts:30-37`
(`bpm` a-rate für sample-genaue Tempoautomation, `swing`/`gate` k-rate). Alle
übrigen 15 Prozessoren sind rein port-message-getrieben und realisieren
Klickfreiheit über **eigene** Rampen:
- sample-genau: `dspProcessor.ts:67-92`, `effectProcessor.ts:72-92`,
  `dynamicsProcessor.ts:221-233`, `masteringProcessor.ts:128-148`,
  `itSynthProcessor.ts:342-362` (Rampen-Objekte, wiederverwendeter Snapshot),
  `spatialProcessor.ts:357-366`.
- block-genau: `eqProcessor.ts:59,153-170` (Band-Gain → Biquad-Koeffizienten).
Kein Befund – aber siehe §8.6 (native AudioParam-Automation wäre der moderne
Weg).

### F5 (MITTEL) – Zustands-Guard in `eqProcessor`
```
eqProcessor.ts:145-151 (vor dem Fix)
  private biquad(f, x) {
    const [b0, b1, b2, a1, a2] = f.co;
    const y   = b0 * x + f.z[0];
    f.z[0]    = b1 * x - a1 * y + f.z[1];   // kein Guard
    f.z[1]    = b2 * x - a2 * y;            // kein Guard
    return y;
  }
```
Die **Ausgabe** wird maskiert (`eqProcessor.ts:184`
`outCh[i] = Number.isFinite(s) ? s : 0`), der **Zustand** nicht: ein einziges
nicht-finites Sample schreibt NaN in `z[0]`, und `b1·x − a1·y + NaN` bleibt NaN.
Das Band liefert danach dauerhaft 0 – ein lautloser Funktionsverlust, der wie
„kein Signal" aussieht. `dspProcessor.ts:143-145` macht es vor (NaN→0 **und**
Denormal-Clamp), `dynamicsProcessor.ts:400-403` deckt wenigstens NaN ab.

### F6 (MITTEL) – Fehlende Klammern im `effectProcessor`
```
effectProcessor.ts:62 (vor dem Fix)
  if (typeof m.sampleReduction === 'number') this.crushReduction = Math.max(1, Math.min(64, m.sampleReduction)); this.crushCounter = 0;
```
Die zweite Anweisung stand außerhalb des `if`: **jede** Nachricht – `{ wet }`,
`{ rate }`, sogar ein `automate`-Frame – setzte den Sample-Hold-Zähler des
Bitcrushers zurück und erzeugte damit kurze, ungewollte
Sample-Rate-Reduktions-Artefakte (bis 64 Samples). Zähler-Kommentar
(`effectProcessor.ts:33`) und Nachbarschaft der Anweisungen belegen die Absicht.
*Interpretationshinweis:* Die alternative Lesart „Reset bei jeder Nachricht ist
gewollt" ist nach Aktenlage unplausibel, aber nicht formal ausschließbar; der
Fix wirkt **nur** im Fall „andere Nachricht als `sampleReduction`".

### F7 (MITTEL) – Sample-Rate in der Leslie-Simulation
```
synthProcessor.ts:116 (vor dem Fix)
  private leslie = new LeslieSim(48000, { slowHz: 0.8, fastHz: 6.2, … });
```
`LeslieSim` benutzt die übergebene Rate für die Rotor-Rampe
(`tonewheel.ts:69`: `1 / (rampSec * this.sampleRate)`) und die Phasenlage ihres
Doppler-/AM-LFO. Bei 44,1 kHz ist die Zeitbasis um 48000/44100 ≈ **8,8 %**
falsch, bei 96 kHz um Faktor 2. Der Prozessor kannte das Worklet-Global
`sampleRate` bereits (`synthProcessor.ts:148`).

### Tail-/Reset-Semantik
- `reset`-Nachrichten leeren konsequent Zustand und Delay-Lines:
  `dspProcessor.ts:39`, `effectProcessor.ts:39`, `eqProcessor.ts:53-55`,
  `dynamicsProcessor.ts:143-151`, `masteringProcessor.ts:99`,
  `spatialProcessor.ts:293-300`, `clockProcessor.ts:47`.
- **Tail-Befund (klein, nicht gefixt):** `masteringProcessor.ts:99` setzt beim
  Reset `this.delayLine = []` und `this.scratch = null`; die Neuanlage passiert
  dadurch im **nächsten `process()`** (`:168-173`) – also eine Allokation im
  Hot-Path unmittelbar nach jedem Reset. Verhaltensneutral wäre, die Puffer nur
  zu leeren (`fill(0)`) und die Länge zu behalten. Nicht umgesetzt (siehe §10).
- `itSynthProcessor.ts:469` (`this.voices = this.voices.filter(...)`) und
  `drumSynthProcessor.ts:55` (`filter`) allokieren ein neues Array – aber nur in
  Quanten, in denen tatsächlich eine Stimme endet (im `itSynth` explizit
  begründet). Vertretbar, kein Befund.

---

## 6. Numerik (Denormals, NaN/Inf, Clipping, DC)

**Vorbildlich belegt:**
- `dspProcessor.ts:143-145`: NaN→0 **und** Denormal-Clamp (`|z| < 1e-20 → 0`) je
  Zustandsvariable, plus `Number.isFinite` auf der Ausgabe.
- `effectProcessor.ts:94-118`: Denormal-Clamp nach jedem Delay-Line-Write („A-7",
  Begründung CPU-Spitzen im Kommentar korrekt).
- `masteringProcessor.ts:205,213-216`: Release-Hüllkurve wird auf
  `limiterCeiling` (≥ 0,1) begrenzt → strukturell denormal-frei; vor jeder
  Division steht `Math.max(x, 1e-8)`.
- `dynamicsProcessor.ts:327,359,384-386`: Detektor-, Kompressor- und
  Ausgangswerte NaN-geprüft, Ausgang auf ±4 geclippt.
- `granularProcessor.ts:121`, `fallbackProcessor.ts:20`,
  `itSynthProcessor.ts:279-281`: Ausgabe-NaN-Guards.
- `lufsProcessor.ts:22-23`: Floor verhindert `log10(0) → -Infinity` im
  SharedArrayBuffer (A-1).
- `spatialProcessor.ts:72-82`: `distanceGain`/`distanceLowpassCoef` sanitisieren
  `dist` (NaN → 1), bevor es in Koeffizienten fließt.
- `synthProcessor.ts:174`, `drumSynthProcessor.ts:52-53`: Ausgangs-NaN-Guard bzw.
  Clipping auf ±1.

**Befunde:**
- **F5** (NaN-Zustand in `eqProcessor`) und **F2** (Phasen-Compounding in
  `itSynthProcessor`) – beide in §5/§3 beschrieben und gefixt.
- **`dynamicsProcessor.ts:400-403`**: NaN ja, Denormal nein – der Dateikopf
  behauptet aber „Denormals werden geklemmt" (`:15-16`). Reine
  Doku-/Code-Diskrepanz ohne hörbare Folge (nicht gefixt, siehe §10).
- **`synthProcessor.ts:124`**: `this.freq = m.freq` ohne NaN-/Range-Prüfung;
  `freq` fließt in `this.dt` und damit in `this.phase` (`:149,155`). Ein NaN
  vergiftet den Phasen-Akkumulator dauerhaft (Ausgabe wird maskiert, siehe F5 –
  gleiches Muster). `MoogLadder` (`synthProcessor.ts:80-93`) hat ebenfalls keinen
  NaN-Guard auf `_y1.._y4`.
- **Kein DC-Offset-Problem gefunden:** Die Biquads sind RBJ-konform
  (`eqProcessor.ts:111-142`), der Lookahead-Delay ist DC-neutral
  (`masteringProcessor.ts:182-202`), der SSB-Allpass in `dspProcessor.ts:134-135`
  ist ein reiner Phasen-Allpass ohne Gleichanteil.
- **Clipping:** `dynamicsProcessor.ts:384-386` (±4), `drumSynthProcessor.ts:53`
  (±1), `masteringProcessor.ts:215-216` (Gain ≤ 1 relativ zu `ceiling`) – bewusst
  gesetzt, kein unkontrolliertes Clipping gefunden.

---

## 7. WASM-Rolle

**Vorhanden und korrekt angebunden:**
- `src/audio/spatial/wasmHrtf.ts` (partitioned-FFT-HRTF, Block 128, IR ≤ 1024,
  `hrtf_init/set_ir/process/reset`) + eingebettete Kopie im `spatialProcessor`
  (`:315-368`). Import und Einrichtung laufen im **Message-Handler** und in
  `initWasm()`, nicht im `process()` – die Grenze Worklet↔WASM ist korrekt
  gezogen.
- `public/wasm/dspKernel.wasm` (gebaut aus `src/audio/wasm/dspKernel.c`, 16 Zeilen:
  reiner 2-Kanal-Gain mit `isfinite`-Sanitisierung) und das Rust-Äquivalent
  `src/audio/wasm/dspKernel_rs/src/lib.rs` (64 Zeilen, gleiche Exporte
  `dsp_process`/`alloc`/`free_ptr`, gleiches NaN-Verhalten).

### F8 (MITTEL) – Der WASM-Kernel wird geladen und **nicht benutzt**
```
WasmBackend.ts:23-35   initialize(): fetch('/wasm/dspKernel.wasm'),
                       WebAssembly.compile + instantiate …
                       this.ready = typeof exports.dsp_process === 'function';
                       // die Instanz wird NICHT gespeichert – kein Feld dafür existiert
WasmBackend.ts:46-59   render(): graph.process(ctx) und danach eine
                       JS-Kopieschleife `for (i…) dst[i] = src[i]`
```
Damit ist der Kernel toter Ballast: `available` ist nach dem Laden `true`, aber
`dsp_process` wird nirgends aufgerufen; die Arbeit macht der JS-Pfad. **Empfehlung
(nicht umgesetzt, weil verhaltensändernd):** entweder `dsp_process` tatsächlich
für den Mix/Gain-Pfad verwenden (Instanz in einem Feld halten, Puffer per
`alloc` beziehen) oder den Kernel samt Build-Skript als nicht verwendet
kennzeichnen. Ein „Laden ohne Nutzung" verbraucht Startzeit und erzeugt den
Eindruck einer WASM-beschleunigten Kette, die es nicht gibt.
*Hinweis:* `src/audio/wasm/dspKernel_rs/target/**` (Rust-Build-Artefakte
inkl. `dsp_kernel.wasm`) liegt im Arbeitsbaum, ist aber **nicht** git-getrackt
(`git ls-files` listet nur `Cargo.lock`, `Cargo.toml`, `src/lib.rs`) – also kein
Repo-Ballast.

### F8.1 (NIEDRIG) – Tote Vorallokation im `spatialProcessor`
```
spatialProcessor.ts:133-138   Felder wasmInL/wasmInR/wasmOutL/wasmOutR
spatialProcessor.ts:322-336   Zuweisung der Views in initWasm()
spatialProcessor.ts:408-411   im Hot-Path aber NEU erzeugt, Felder nie gelesen
```
**Wichtiger Befund aus dem Audit-Versuch:** Ich habe zunächst genau diese
Ersetzung (vorallokierte Views nutzen) implementiert – **und der Testlauf hat sie
widerlegt**:
```
FAIL tests/wasmHrtf.test.ts > spatialProcessor Worklet + WASM-Integration (Node)
     > instanziiert WASM über loadHRTFWasm und rendert High-Quality-Block
TypeError: Cannot perform %TypedArray%.prototype.set on a detached ArrayBuffer
 ❯ SpatialProcessor.process src/audio/worklets/spatialProcessor.ts:431:14
```
Das WASM-Modul kann den Linear-Speicher während `hrtf_set_ir`/`hrtf_process`
wachsen lassen; die Ansicht wird dabei **detached**. Die 4 Views pro Block sind
also **notwendige** Defensive, keine Schlamperei. Der Fix wurde zurückgerollt
und die Begründung als Kommentar an der Stelle hinterlassen. Die Felder
`wasmInL/wasmInR/wasmOutL/wasmOutR` bleiben tot – Empfehlung: entfernen oder
dokumentieren, aber **nicht** in den Hot-Path ziehen.

### Wo WASM (k)einen Sinn hat
- **Sinnvoll in WASM:** mehrstufige Faltung (HRTF) – Aufwand skaliert mit
  IR-Länge. Korrekt dort.
- **Bewusst JS/Worklet, kein WASM nötig:** Biquad-Kaskaden, Hüllkurven,
  PolyBLEP-Oszillatoren, Delay-Netze – pro Sample O(1); die Zustandsübergabe pro
  Block über die JS↔WASM-Grenze wäre teurer als die Rechnung.
- **Kandidat für eine Verschiebung nach WASM (Empfehlung, nicht umgesetzt):** die
  direkte Medium/High-FIR-Faltung mit bis zu 64 Taps × Sample × Quelle in
  `spatialProcessor.ts:459-465` (bei 8 Quellen ~1024 MAC/Sample = ~49 M MAC/s
  @48 kHz, grobe Abschätzung aus dem Code, **nicht gemessen**). Die vorhandene
  partitioned-FFT-Infrastruktur könnte das übernehmen; das ändert aber das
  Ergebnis (Rundungsverlauf, Kernel-Länge) → kein „sicherer" Fix.

---

## 8. Vergleich zum Stand der Technik (Empfehlungen, kein Umbau)

1. **True-Peak-Erkennung** ist in `masteringProcessor.ts:194-200` eine *lineare*
   2×-Übersampling-Schätzung. BS.1770-/EBU-R128-konform wäre 4×-Polyphase-
   Übersampling mit dem Standard-FIR-Interpolator. Die aktuelle Schätzung
   unterschätzt echte Zwischenwerte. → **klangrelevant, nicht umgesetzt**
   (Vorsicht zusätzlich: der `audio:gate` prüft TPK per ffmpeg `ebur128`, siehe
   §9.4 – die Gate-Grenze −1 dBTP ist damit strenger als die interne Schätzung).
2. **Echte PDC für die Mastering-Kette.** Kompensiert wird heute nur der
   Step-Frame des Schedulers (`v2Pdc.ts:23-25`, getestet in
   `tests/v2PdcImpulse.test.ts:97-119`). Für parallele Pfade (Cue/Monitor,
   Recorder, Analyzer) wäre eine explizite Verzögerung pro Bus der Standard
   (DAW-PDC). Grundlage dafür ist erst F9(a) – eine gemeinsame
   Latenz-Konstante. → **klangrelevant (Phasenlage), nicht umgesetzt.**
3. **Fractional-Delay im Chorus:** `effectProcessor.ts:125` rundet die
   Leseposition (`Math.round(delaySamples)`) → bei Modulation
   Quantisierungsstufen (Zipper). Stand der Technik ist lineare Interpolation
   zwischen zwei Taps (oder Allpass). → **klangrelevant, nicht umgesetzt.**
4. **Oversampling nichtlinearer Stufen:** `synthProcessor` betreibt das
   Moog-Leiter-Filter ohne Oversampling (`synthProcessor.ts:80-93`), ebenso
   `itSynthProcessor.ts:87-105`; bei hoher Resonanz nahe Nyquist ist das der
   klassische Aliasing-Punkt. Der Soft-Clipper in `dspProcessor.ts:148-150`
   (zweimal `Math.tanh` pro Sample) ist 1×-betrieben – `tanh` ist aber
   analytisch und erzeugt kein Knie-Aliasing. → **klangrelevant, nicht
   umgesetzt.**
5. **dB/linear-Konventionen sind korrekt und konsistent:** dBFS-Spitzenwert über
   `20·log10` (`dynamicsProcessor.ts:33-37`, `masteringProcessor.ts:205`),
   Amplituden-Koeffizienten über `10^(dB/20)`, Shelf-/Peaking-`A`-Terme über
   `10^(dB/40)` nach RBJ (`eqProcessor.ts:122,136`). **Kein Befund.**
6. **Parameter-Automation:** Nur `bpm` ist ein echter `AudioParam` (a-rate).
   Alles andere läuft über `postMessage` + eigene Rampe. Das ist funktional
   gleichwertig sample-genau, aber es erlaubt keine native
   `setValueCurveAtTime`-Automation und keine host-seitige
   Parametervalidierung (`minValue/maxValue/automationRate`). Empfehlung für die
   nächsten Worklets: Clamps in `parameterDescriptors` deklarieren.
7. **Nicht gerampter Sprung:** `synthProcessor.ts:125-126` übernimmt `cutoff`
   und `resonance` sofort (kein Ramp), im Unterschied zu allen anderen
   Prozessoren. → hörbar, Empfehlung.

---

## 9. Umgesetzte Fixes, Abdeckung und Gate-Ausgaben

### 9.1 Liste der Änderungen (11 Dateien, kein Commit – siehe §9.6)

| Datei | Änderung | Befund |
|---|---|---|
| `src/audio/worklets/v2SinkProcessor.ts` | Scratch-Puffer + Block-Array je SFZ-Kanal (`sfzScratch`, `sfzScratchFor()`); keine `new Float32Array`/`[mono]` mehr im `process()` | F1.1 |
| `src/audio/worklets/spatialProcessor.ts` | neue Hot-Path-Variante `azToStereoGainsInto()` (wiederverwendetes Ergebnisobjekt), 3 Aufrufstellen umgestellt; exportierte `azToStereoGains()` unverändert (frisches Objekt) | F1.2 |
| `src/audio/worklets/fm6Processor.ts` | `mixBuf` wiederverwendet (mit `fill(0)` vor jedem Render → semantisch wie ein frisches Array) | F1.3 |
| `src/audio/worklets/itSynthProcessor.ts` | `this.baseFreq = f;` entfernt (Compounding-Bug) | F2 |
| `src/audio/worklets/dspProcessor.ts` | `!output \|\| !output[0]` im Guard | F3 |
| `src/audio/worklets/eqProcessor.ts` | `!output \|\| !output[0]` im Guard; `biquad()` mit Index-Zugriff + NaN-/Denormal-Guard auf `z[0]/z[1]` | F3, F5 |
| `src/audio/worklets/effectProcessor.ts` | `!output \|\| !output[0]` im Guard; fehlende Klammern um `crushCounter = 0` | F3, F6 |
| `src/audio/worklets/clockProcessor.ts` | Blocklänge aus `outputs[0][0].length` statt hart 128 | F4 |
| `src/audio/worklets/analyzerProcessor.ts` | Quantengröße aus der tatsächlichen Blocklänge | F4 |
| `src/audio/worklets/synthProcessor.ts` | `LeslieSim(currentSampleRate(), …)` statt `48000` | F7 |
| `docs/audit-audioweg.md` | diese Auditdatei (neu) | – |

Zusätzlich: `reports/worklet-cpu.json` wurde durch `npm run perf:worklet`
**regeneriert** (getrackte Datei, Inhalt = Messwerte aus §9.5).

### 9.2 Verhaltensneutralität – was genau gleich bleibt
- **F1.1/F1.3:** identische Pufferinhalte, identische Reihenfolge; nur die
  Allokation entfällt. `V2SinkEngine.setExternalSource` reicht die Referenz nur
  bis `render()`-Ende durch (`V2SinkEngine.ts:372-375,395-399`), Wiederverwendung
  ist daher unkritisch. Bei FM6 wird vor dem Render genullt, was exakt der
  Semantik eines frisch allokierten `Float32Array` entspricht.
- **F1.2:** dieselbe Mathematik (`Math.cos`/`Math.sin` derselben Argumente), nur
  ohne Objekt-Neuanlage.
- **F2:** für `transposeSemi = 0` ist `Math.pow(2, 0) === 1` und
  `baseFreq * 1 === baseFreq` bitgenau – das Verhalten ist unverändert. Für
  Transpose ≠ 0 behebt der Fix das Compounding. Messung (Node, ausgeführt):
  ```
  alt, +12 Halbtoene nach 100 Samples: 2.7888313205021047e+32 Hz (2 ms @48k)
  neu/transpose=0 nach 100 Samples: 220 Hz -> identisch: true
  neu, +12 Halbtoene (konstant): 440 Hz
  ```
  Es gibt **keine** Stelle im Repo, die Transpose ≠ 0 an das IT-Synth-Worklet
  sendet (Volltextsuche `transpose` über `src/` und `tests/`: nur
  `dx7Presets`/`fmEngine`/`InstrumentBackend` und dort auf MIDI-Noten bezogen) –
  der Bug war also latent.
- **F3:** nur der Pfad `outputs[0]` fehlt ändert sich (vorher `TypeError`, jetzt
  stiller Rückzug); wenn `output[0]` existiert, ist der Codepfad identisch.
- **F4:** bei 128 Frames wertgleich (der Test-Harness ohne Ausgangspuffer fällt
  auf 128 zurück).
- **F5:** die NaN-Hälfte ist für finite Audio bitgleich. Der **Denormal-Clamp**
  (`|z| < 1e-20 → 0`, ca. −400 dBFS) ändert Bits in subnormalen Zuständen –
  bewusst in Kauf genommen, weil `dspProcessor` denselben Guard seit „AM-E1-7"
  benutzt und Subnormals pro Sample hunderte CPU-Zyklen kosten können. Der
  gesamte Testbestand bleibt grün (§9.3).
- **F6:** wirkt nur, wenn eine Nachricht **ohne** `sampleReduction` eintrifft.
- **F7:** `LeslieSim` benutzt die Rate ausschließlich für seine interne
  Zeitbasis/Phase; die Klangfarbe der Parameter (`slowHz`, `fastHz`, `amDepth`,
  `fmDepth`, `rampSec`) ist unverändert.

### 9.3 Abdeckung durch Tests (ehrlich)
- `tests/clockProcessorWorklet.test.ts` und `tests/v2SinkProcessorWorklet.test.ts`
  führen die **echten** Prozessoren mit gestubbten Worklet-Globals aus und
  testen u. a. a-rate-BPM-Wechsel bzw. sample-genaue Steps – sie decken F1.1 und
  F4 (Clock) ab.
- `tests/spatialProcessor.test.ts` importiert den Prozessor direkt und deckt
  F1.2 ab.
- `tests/wasmHrtf.test.ts` hat den ersten (falschen) F8.1-Versuch aufgedeckt –
  sie ist die wirksame Absicherung dieses Pfads.
- **Nicht direkt abgedeckt:** `eqProcessor` (F3/F5), `dspProcessor` (F3),
  `effectProcessor` (F3/F6), `synthProcessor` (F7), `fm6Processor` (F1.3),
  `itSynthProcessor` (F2), `analyzerProcessor` (F4). Für diese Dateien importiert
  **kein** Test die Prozessorklasse (Volltextsuche nach
  `from '…/worklets/<name>'` in `tests/`: nur `spatialProcessor`). Sie sind
  abgesichert durch `tsc` + `eslint` + grünen Gesamtbestand, **nicht** durch
  einen eigenen Golden-WAV.
- Der `audio:gate` prüft nur `tests/fixtures/audio/golden-1s.wav` gegen
  Loudness-/Peak-Fenster – er rendert **keine** Worklet-Kette und deckt damit
  keinen der Fixes inhaltlich ab (siehe §9.4).

### 9.4 Gate-Ausgaben (wörtlich)

```
$ npm run typecheck
> audioMONASTRY@1.210.001 typecheck
> tsc --noEmit
```
(keine weitere Ausgabe, Exit-Code 0)

```
$ npm run lint
> audioMONASTRY@1.210.001 lint
> eslint . --max-warnings=0
```
(keine weitere Ausgabe, Exit-Code 0)

```
$ npm test
> audioMONASTRY@1.210.001 test
> vitest run

 Test Files  242 passed (242)
      Tests  1694 passed (1694)
   Start at  04:20:04
   Duration  34.62s (transform 17.89s, setup 3.65s, import 33.03s, tests 78.53s, environment 32.12s)
```
(= Baseline des Auftrags: 1694 Tests in 242 Dateien, vollständig grün, **nach**
allen Fixes)

```
$ npm run audio:gate
> audioMONASTRY@1.210.001 audio:gate
> bash scripts/audio-gate.sh

PASS tests/fixtures/audio/golden-1s.wav: I=-12.0 LUFS, TPK=-8.4 dBTP, Peak=-8.4 dBFS
AUDIO-GATE: OK (1 Datei(en))
```

```
$ npm run perf:worklet
  AudioContext state=running sampleRate=48000 baseLatency=0.010666666666666666
  worklet: channels=2 Messung=gestartet
  aktiv: erster Bericht nach 2500 Block(en), Budget 2.6667 ms @ 48000 Hz
  Nachrichten vom Worklet: {"cpu-stats":11,"step":56}
  Ausgangs-Pegel (Beweis, dass gerendert wurde): 0.2971
--- Worklet-CPU (v2-sink-processor, Messung opt-in) ---
  Bloecke gemessen : 2500
  Ø pro Block      : 0.3916 ms
  Max pro Block    : 18 ms  (nur informativ: 1-ms-Raster)
  Budget pro Block : 2.6667 ms (128 Frames @ 48000 Hz)
  Last             : 14.69 %  (Ziel <=25 %, Fehlschlag >50 %)
  Zeitquelle       : date (grob, 1 ms – nur fuer den Mittelwert)
--- Deadline-Treue (currentFrame, PERF-P3-002) ---
  Verpasste Quanten : 0  (Ziel 0, 1 Quantum = 128 Frames = 2.6667 ms)
  Groesste Luecke   : 1 Quantum(e)
  Stall-Ereignisse  : 0
--- Audio-Uhr-Abgleich (getOutputTimestamp, PERF-P3-002) ---
  Audio-Zeit        : 5985.3 ms
  Wall-Clock        : 5998 ms
  Rueckstand       : 12.7 ms (0.21 %, Toleranz <= 10 %)
--- Zusagen ---
  OK    Messmodus aktiv (erster Bericht)
  OK    Messwerte vorhanden
  OK    Ø-Last im Budget
  OK    keine verpassten Render-Quanten (currentFrame, PERF-P3-002)
  OK    Audio-Uhr im Takt (getOutputTimestamp, PERF-P3-002)
  OK    Context-Last im Rahmen (falls messbar)
  OK    Ausgang hat Signal (Graph rendert wirklich)
  OK    keine pageErrors
  OK    renderCapacity-API vorhanden (PERF-P3-002)
  OFFEN  AudioContext.renderCapacity fehlt in diesem Browser (keine Context-Last/Underrun-Messung)
  Bericht: reports/worklet-cpu.json
```
**Wichtige Einschränkung zu dieser Messung:** Sie gilt für den **V2-Sink-Pfad
in der Gate-Umgebung** (headless Chromium, 48 kHz, 1 Kanalpaar, ohne SFZ-Voices,
ohne Spatial-Quellen). Sie ist **kein** Nachweis eines Vorher/Nachher-Effekts
der Fixes: der `perf:worklet`-Gate kennt keine Baseline für `abd73d7`, und F1.1
sowie F1.3 greifen nur mit aktiven Stimmen. Eine Allokations- oder
CPU-Verbesserung durch die Fixes ist damit **nicht gemessen** – belegt ist nur,
dass die Fixes das Budget nicht reißen.

### 9.5 Vorher/Nachher-Sicherung
Der einzige „harte" Vorher/Nachher-Beleg in diesem Audit ist der **widerlegte**
Optimierungsversuch F8.1 (Test rot → Fix zurückgerollt → Test grün). Für die
übrigen Fixes gibt es keinen regenerierten Golden-WAV und keine CPU-Baseline;
die Absicherung ist „Verhalten nachweislich unverändert plus vollständig grüner
Bestand".

### 9.6 Commit-Status
Es wurde **nicht** committet. `git status --short` nach den Änderungen:
```
 M reports/worklet-cpu.json
 M src/audio/worklets/analyzerProcessor.ts
 M src/audio/worklets/clockProcessor.ts
 M src/audio/worklets/dspProcessor.ts
 M src/audio/worklets/effectProcessor.ts
 M src/audio/worklets/eqProcessor.ts
 M src/audio/worklets/fm6Processor.ts
 M src/audio/worklets/itSynthProcessor.ts
 M src/audio/worklets/spatialProcessor.ts
 M src/audio/worklets/synthProcessor.ts
 M src/audio/worklets/v2SinkProcessor.ts
?? docs/audit-audioweg.md
```

---

## 10. Bewusst NICHT umgesetzt

| Punkt | Grund |
|---|---|
| F8 `WasmBackend` an `dsp_process` verdrahten | Ändert den Render-Pfad (Pufferverwaltung per `alloc`, Mix-Semantik) – nicht verhaltensneutral, benötigt einen eigenen Golden-Test. |
| F8.1 vorallokierte WASM-Views in `spatialProcessor` nutzen | **Versucht und widerlegt** (detached ArrayBuffer, s. §7) – der Test beweist, dass die 4 Views pro Block notwendig sind. |
| F9 PDC/Latenz-Konstante zusammenführen | Verhaltensneutral wäre es möglich, aber es berührt `v2Pdc.ts`, `GraphPlaybackEngine.ts` und den Prozessor gleichzeitig (drei Module, zwei Testdateien) – außerhalb des „kleinen, sicheren" Rahmens; als klar umrissene Empfehlung dokumentiert. |
| True-Peak 4×-Polyphase, Chorus-Fractional-Delay, Oversampling Ladder-Filter, `synthProcessor`-Rampen für cutoff/resonance, K-Weighting/Gating im LUFS-Prozessor | Ändern das hörbare Ergebnis bzw. die exportierte Kennzahl – laut Auftrag nur Empfehlung. |
| `masteringProcessor` Reset ohne Re-Allokation (Reserve-Puffer) | Verhaltensneutral, aber der Reset-Pfad ist Teil der verifizierten Limiter-Semantik (`delayPos=0`, Delay-Line leer) und wird von Impluls-Tests aus `tests/v2PdcImpulse.test.ts` mitgenutzt – Risiko/Nutzen für einen Einmalvorgang ungünstig. |
| `dynamicsProcessor` Denormal-Clamp ergänzen | Die Doku behauptet ihn (`:15-16`), der Code hat nur NaN. Ein echter Clamp ändert Bits in subnormalen Zuständen; ohne klanglichen Nutzen und ohne Test, der das absichert, nur als Doku-Diskrepanz gemeldet. |
| `v2SinkProcessor` `events`-Array und `render()`-Argumentobjekt wiederverwenden | Erfordert die Prüfung, ob `V2SinkEngine.render()` Referenzen über den Aufruf hinaus behält (`V2SinkEngine.ts:383-399` liest sie heute nur, die vollständige Pfadanalyse inkl. `studio.setSourceBuffer`/`applyMonitorRouting` stand nicht im Zeitrahmen) – offen statt geraten. |
| `PluginAudioPipeline` `console.warn` ratelimiten | Die Klasse ist produktiv nicht verdrahtet (§3, F10.2) – Änderung dort wäre Arbeit an totem Code. |
| Wiederverwendung von `azToStereoGains` (exportierte Funktion) selbst | Sie ist öffentliche API (Tests: `tests/spatialProcessor.test.ts:3,12-22`) – die Hot-Path-Variante wurde deshalb als **zusätzliche** Funktion ergänzt, nicht als Verhaltensänderung der bestehenden. |

---

## 11. Offene Punkte / nicht verifizierbar

1. **Volle Latenz-Summe inklusive `outputLatency` und Cue-/Monitor-PDC nicht
   gemessen.** `audioEngine.getAudioHealth()` (`audioEngine.ts:1698-1705`)
   liefert `baseLatency`/`outputLatency`; ein Browser-Lauf zum Auslesen der
   konkreten Werte dieser Maschine wurde nicht durchgeführt. Die in §4 genannte
   Größenordnung ≈18,3 ms ist eine **Summe aus gemessener `baseLatency` und
   Code-Werten**, kein Messergebnis.
2. **Keine CPU-Baseline für `abd73d7`.** Ob F1/F1.3 die Renderzeit senken, ist
   nicht gemessen (kein Vorher-Lauf vorhanden, der Gate-Pfad hat keine aktiven
   SFZ-Voices in der Messung).
3. **`V2SinkEngine.render()`-Argumentlebensdauer nicht vollständig analysiert**
   → F1.4 bleibt offen (siehe §10).
4. **Keine Worklet-Einzeltests für 7 der 16 Prozessoren** (§9.3). Ein
   Golden-WAV pro Prozessor (Impulsantwort bzw. 1-s-Sweep) wäre die belastbare
   Absicherung für künftige DSP-Änderungen – als Empfehlung, nicht als Fix.
5. **`npx`-Aufrufe wurden bewusst vermieden** (Umgebungs-Policy); es wurden
   ausschließlich die npm-Skripte (`typecheck`, `lint`, `test`, `audio:gate`,
   `perf:worklet`) ausgeführt.
6. **Kein Browser-/Hörtest.** Alle Aussagen zu hörbaren Effekten (§8) folgen aus
   dem Code, nicht aus einer Abhörsitzung.
7. **`src/utils/audioEngine.ts` (2481 Zeilen, God-Class) wurde nicht
   tiefen-auditiert** – der Auftrag zielte auf den Signalweg. Die Datei stellt
   die Health-/Latenzmetriken bereit (`:1698-1705`) und leitet `latencyHint`
   (`:330-335`); eine eigene God-Class-Zerlegungsanalyse bleibt offen.
