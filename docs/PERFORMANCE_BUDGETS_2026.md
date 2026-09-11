# Performance-Budgets 2026 (gemessen, nicht geschätzt)

Datum: 2026-09-11 · Bezug: `MASTERTODOENDE.json` → `PERF-P3-001` · Skill: `audioaudit` (Modus D)

Alle Zahlen unten sind **gemessen** und mit dem Befehl reproduzierbar. Wo eine
Messung nicht belastbar ist, steht das ausdrücklich dabei.

---

## 1. Worklet-CPU des V2-Live-Pfads

**Befehl:** `npm run perf:worklet` (baut nichts, braucht `node build-worklets.mjs` davor)

**Verfahren:** Der `v2-sink-processor` misst seine eigene `process()`-Zeit, aber
nur mit `processorOptions.measure: true` (im Betrieb **aus** → keine zusätzlichen
Kosten außer zwei Zeitstempeln pro Block). Ein Render-Quantum sind 128 Frames;
bei 48 kHz ist das Echtzeit-Budget **2,667 ms pro Block**. Gemessen wird beim
gleichzeitigen Triggern von **vier Kanälen** plus Testton im Master (Näherung an
den 4-User-Betrieb), Messfenster 6 s.

| Kennzahl | Wert (Chromium headless, 48 kHz) | Bewertung |
|---|---|---|
| Ø Render-Zeit pro Block | **0,41–0,48 ms** (3 Läufe) | **15–18 %** des Budgets → >80 % Luft |
| Blöcke im Messfenster | 2 500 | ~6,6 s Audio |
| Max pro Block | 8 ms | **nicht belastbar** (s. u.) |
| Ausgangs-Pegel | 0,297 | Beweis, dass wirklich gerendert wurde |
| Zusagen im Gate | 7/7 OK (Exit 0) | inkl. „kein Signal ⇒ Fehlschlag" |

**Streuung:** zwischen Läufen schwankt der Mittelwert um ~±15 % (0,41 / 0,42 /
0,48 ms) — headless auf einer geteilten Maschine. Die Aussage „deutlich unter
25 %" ist davon nicht betroffen; einzelne Läufe deshalb nicht überinterpretieren.

**Budgets, die das Gate durchsetzt:** WARN > 25 % · FAIL > 50 % · kein Block über
Budget (nur bei feiner Zeitquelle) · Ausgang muss Signal haben · keine Page-Errors.

**Warum der Max-Wert nicht belastbar ist:** In diesem Chromium-Scope ist
`performance` **undefiniert** (siehe §4), die Messung fällt auf `Date.now()`
(1 ms Auflösung) zurück und weist das im Bericht als `timer: "date"` aus. Ein
„Max 8 ms" ist damit Quantisierung/Scheduler und kein DSP-Ausreißer. Für
**Mittelwerte** ist die Quantisierung unkritisch (Fehler mittelt sich über 2 500
Blöcke). Auf einer Maschine mit `performance` im Worklet-Scope ist auch der Max
belastbar.

**Nicht messbar in dieser Umgebung:** `AudioContext.renderCapacity` existiert im
verwendeten Chromium-Build nicht. Das Gate meldet das ausdrücklich („kein stiller
Erfolg") — die Gesamtlast des Graphen ist hier also offen.

## 2. Startlast des Bundles (eager vs. lazy)

**Befehl:** `npm run build && npm run check:bundle`

Die Messung wurde in diesem Durchgang **korrigiert**: vorher summierte das Gate
alle JS-Chunks und warnte über „1,65 MB Startup", obwohl lazy Chunks enthalten
waren — darunter der 403-KB-`onnx-*.js`-Chunk, der erst beim optionalen lokalen
ONNX-/Demucs-Pfad per `import('onnxruntime-web')` geladen wird.

| Kategorie | Dateien | Größe | Bewertung |
|---|---|---|---|
| **Startlast (eager)** = Entry + `modulepreload` aus `index.html` | 9 | **0,93 MB** | ✅ im Budget (Warn 1,50 / Fail 2,00 MB) |
| Lazy (erst bei Nutzung) | 28 | 0,72 MB | informativ, kein Fail |

Größte Startlast-Chunks: `index` 236 KB · `react` 189 KB · `mediasoup` 188 KB.
Größte Lazy-Chunks: `onnx` 403 KB · `DropTerminal` 49 KB · `DJ4ChMixer` 32 KB.

**Konsequenz:** Kein Optimierungsdruck bei der Startlast (0,57 MB Luft bis zur
Warnschwelle). Die lazy Chunks sind bereits korrekt gesplittet.

## 3. Test-Laufzeit

**Befehl:** `npm run test:ci`

| Kennzahl | Wert |
|---|---|
| Dateien / Tests | 174 / **1165** (0 übersprungen — das Gate erzwingt das) |
| Dauer | **~27 s** (Vitest 4, 8 Kerne, inkl. Transform + Import) |

Kein Handlungsbedarf: die Suite wächst mit dem Projekt, liegt aber deutlich unter
den 25 min des CI-Jobs. Größter Hebel wäre `--pool=threads`-Feintuning; die
Flaky-Historie (ARCH-PERF-001) spricht dafür, die Timeouts lieber großzügig zu
lassen als zu parallelisieren.

## 4. Zwei Befunde, die Arbeit gekostet haben (und Zeit sparen, wenn sie bekannt sind)

1. **`performance` fehlt im AudioWorkletGlobalScope.** Live gemessen:
   `typeof performance === 'undefined'`. Ein `performance.now()` im Worklet warf
   dort in **jedem** Block eine `ReferenceError`; der Prozessor starb und lieferte
   **Stille** — ohne Page-Error. Sichtbar wurde das nur, weil ein
   `processorOptions`-Test das vorher grüne `audio-gate.cjs` rot machte.
   → **Regel:** im Worklet Zeitquelle per Feature-Test wählen und die Messung in
   `try/catch` kapseln, damit sie den Audio-Pfad nie gefährden kann (umgesetzt:
   `timer: 'performance' | 'date'` + Auto-Abschaltung bei Fehler).
2. **`this.port.postMessage()` im Konstruktor** eines `AudioWorkletProcessor`
   brachte den Prozessor ebenfalls zum Scheitern. Erste Messung deshalb ohne
   jeden Wert. → **Regel:** im Konstruktor nichts posten; die erste Meldung im
   ersten `process()`-Block senden.
3. **Headless-Chromium-Eigenheit:** der Audio-Thread läuft nur, solange der
   Main-Thread beschäftigt ist — währenddessen werden Port-Nachrichten aber nicht
   zugestellt. Deshalb: erst kurz warten (Zustellung), dann beschäftigen (Audio
   rendert, Meldungen werden eingereiht), dann wieder freigeben (Meldungen
   ankommen). Zusätzlich `--disable-background-timer-throttling`,
   `--disable-renderer-backgrounding`, `--disable-backgrounding-occluded-windows`.
4. **Pegel-Beweis einbauen:** Solange nur `ctx.currentTime` geprüft wird, sieht
   alles gesund aus, obwohl **nichts** rendert (`currentTime` läuft auch ohne
   Prozessorarbeit). Erst `getFloatTimeDomainData()` am Ausgang beweist Audio.
   Genau diese Prüfung hat den stillen Ausfall oben aufgedeckt.

## 5. Wiederholung / Gates

```bash
node build-worklets.mjs            # Worklets mit Messcode bauen
npm run perf:worklet               # CPU-Budget-Gate (Exit 1 bei Verletzung)
npm run test:audio-gate            # Regression: Messung AUS -> Audio unverändert
npm run build && npm run check:bundle
npm run test:ci                    # inkl. Skip-Gate
```

Berichte: `reports/worklet-cpu.json` (CPU + Browser-Version + Zusagen),
`reports/audio-gate.json` (Pegel-Rohdaten).

## 6. Offene Punkte (bewusst nicht in diesem Durchgang)

- `renderCapacity`-Messung auf einem Chromium mit dieser API nachholen
  (Gesamtlast inkl. Underruns) — auf dem CI-Runner oder im Desktop-Chrome.
- Max-Wert der Blockzeit auf einer Maschine mit `performance` im Worklet-Scope
  erheben (hier nur als 1-ms-Quantisierung sichtbar).
- `AUDIO-P1-002` (audioEngine-Facade, 3444 LOC): Die Startlast von 0,93 MB und
  15 % Audio-Thread-Last geben **kein** Dringlichkeitssignal — eine Aufteilung
  wäre Struktur-Verbesserung, nicht Performance-Rettung. Diese Zahlen sind die
  Entscheidungsgrundlage dafür.
