# Performance-Budgets 2026 (gemessen, nicht geschätzt)

Datum: 2026-09-11, nachgezogen 2026-09-13 · Bezug: `MASTERTODOENDE.json` → `PERF-P3-001` + `PERF-P3-002` · Skill: `audioaudit` (Modus D)

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
| Ø Render-Zeit pro Block | **0,33–0,39 ms** (Läufe 2026-09-13) | **12,5–17 %** des Budgets → >80 % Luft |
| Blöcke im Messfenster | 2 250–2 500 | ~6 s Audio |
| **Verpasste Render-Quanten** | **0** (größte Lücke 1 Quantum, 0 Stall-Ereignisse) | **belastbar** – keine Deadline verpasst |
| Max pro Block (`Date.now()`) | 8–10 ms | **nicht belastbar** (1-ms-Raster, s. u.) |
| Audio-Uhr-Rückstand | **−0,5 … +0,2 %** (3 Läufe) | Audio-Thread hält Takt (Budget ≤ 10 %) |
| Ausgangs-Pegel | 0,27–0,30 | Beweis, dass wirklich gerendert wurde |
| Zusagen im Gate | 8/9 OK, 1 bewusst OFFEN (Exit 0) | offen: `renderCapacity` (s. u.) |

**Streuung:** zwischen Läufen schwankt der Mittelwert um ~±15 % (0,33 / 0,39 ms) —
headless auf einer geteilten Maschine. Die Aussage „deutlich unter 25 %" ist davon
nicht betroffen; einzelne Läufe deshalb nicht überinterpretieren.

**Budgets, die das Gate durchsetzt:** WARN > 25 % · FAIL > 50 % · **0 verpasste
Render-Quanten** · |Audio-Uhr-Rückstand| ≤ 10 % · Ausgang muss Signal haben · keine
Page-Errors · `renderCapacity` nur mit `REQUIRE_PERF_APIS=1` Pflicht.

**Die belastbare Max-Aussage ist `missedQuanta`, nicht `maxMs` (Stand 2026-09-13):**
`performance` ist im `AudioWorkletGlobalScope` **per Spec nicht exponiert** – live
geprüft: im Prozessor-Scope ist `typeof performance === "undefined"`, während
`Date`, `currentTime`, `currentFrame` und `sampleRate` vorhanden sind. Ein „Max 8 ms"
aus `Date.now()` ist deshalb Quantisierung/Scheduler und kein DSP-Ausreißer. Das
frühere Gate hat diese Prüfung bei grober Zeitquelle sogar übersprungen („kein Block
über Budget (nur bei feiner Zeitquelle)") und war damit grün, **ohne etwas zu
belegen** – während im selben Bericht `maxBlockOverBudget: true` stand.

Stattdessen zählt der Prozessor jetzt Lücken im `currentFrame`-Zähler: springt er um
mehr als einen Render-Quantum, hat der Audio-Thread einen Block nicht rechtzeitig
geliefert. Das ist auflösungsunabhängig, kostet im Betrieb nichts (weiterhin opt-in
über `processorOptions.measure`) und ist als Zusage belastbar — gemessen **0
verpasste Quanten** in allen Läufen. Zusätzlich verknüpft das Gate
`AudioContext.getOutputTimestamp()` (Main-Thread, dort gibt es `performance`)
Audio-Zeit und Wall-Clock: ≤ 0,2 % Rückstand ⇒ der Audio-Thread hält exakt Takt.

**Nicht messbar in dieser Umgebung:** `AudioContext.renderCapacity` existiert weder
im Playwright-Chromium (151.0.7922.34) noch im System-Chrome (153.0.8010.36) —
geprüft mit und ohne `--enable-blink-features=AudioRenderCapacity` /
`--enable-features=AudioRenderCapacity`, in sicherem Kontext
(`isSecureContext: true`) und laufendem Context. Das Gate meldet das ausdrücklich
(„kein stiller Erfolg") — die Gesamtlast des Graphen ist hier also offen.

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
   **Nachtrag 2026-09-13:** `performance` ist im Worklet-Scope **per Spec** nicht
   exponiert (`WorkletGlobalScope` ist kein `WorkerGlobalScope`) — das ist kein
   Build-Zufall und wird durch kein Browser-Update kommen. Der `date`-Rückfall
   taugt deshalb nur für den **Mittelwert**; die Deadline-Aussage kommt aus
   `currentFrame` (s. §1).
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
5. **Eine Prüfung, die an einer fehlenden API hängt, ist grün ohne Beweis.** Das
   Gate fragte „kein Block über Budget (nur bei feiner Zeitquelle)" — bei
   `timer: 'date'` wurde sie stillschweigend übersprungen und meldete **OK**,
   obwohl im selben Bericht `maxBlockOverBudget: true` und `maxMs: 10` bei
   `budgetMs: 2,667` standen. → **Regel:** eine Aussage nie an die Verfügbarkeit
   ihres Messwegs koppeln. Fehlt der Weg, muss die Aussage auf **OFFEN** stehen
   oder durch eine belastbare Quelle ersetzt werden (hier: Lücken im
   `currentFrame`-Zähler, s. §1).

## 5. Wiederholung / Gates

```bash
node build-worklets.mjs            # Worklets mit Messcode bauen
npm run perf:worklet               # CPU-Budget-Gate (Exit 1 bei Verletzung)
REQUIRE_PERF_APIS=1 npm run perf:worklet   # renderCapacity wird zur Pflicht
CHROME_PATH=/usr/bin/google-chrome npm run perf:worklet   # System-Chrome statt Playwright-Chromium
npm run test:audio-gate            # Regression: Messung AUS -> Audio unverändert
npm run build && npm run check:bundle
npm run test:ci                    # inkl. Skip-Gate + Deadline-Treue-Tests
```

Die Deadline-Treue (`missedQuanta`) ist zusätzlich als Unit-Test abgesichert
(`tests/v2SinkProcessorWorklet.test.ts`) — nötig, weil das Gate ein manuelles
Skript ist und **nicht** im CI läuft.

Berichte: `reports/worklet-cpu.json` (CPU + Deadline-Treue + Audio-Uhr-Abgleich +
Browser-Version + Zusagen), `reports/audio-gate.json` (Pegel-Rohdaten).

## 6. Offene Punkte (bewusst nicht in diesem Durchgang)

- `renderCapacity`-Messung auf einer Maschine nachholen, die diese API ausliefert
  (Gesamtlast inkl. Underruns). Auf diesem Laptop nicht erreichbar: weder
  Playwright-Chromium 151 noch System-Chrome 153 haben sie, mit und ohne
  `--enable-blink-features=AudioRenderCapacity` (s. §1) — die Angabe „seit
  Chrome 116 standardmäßig enthalten" trifft auf diese Builds nicht zu.
- ~~Max-Wert der Blockzeit über `performance` im Worklet-Scope erheben~~ →
  **geschlossen, nicht offen:** `performance` ist dort per Spec nicht exponiert und
  wird es in keinem Chromium sein. Ersetzt durch `missedQuanta` aus `currentFrame`
  (s. §1); der `date`-Maximalwert bleibt nur als Hinweis im Bericht.
- `AUDIO-P1-002` (audioEngine-Facade, 3444 LOC): Die Startlast von 0,93 MB und
  15 % Audio-Thread-Last geben **kein** Dringlichkeitssignal — eine Aufteilung
  wäre Struktur-Verbesserung, nicht Performance-Rettung. Diese Zahlen sind die
  Entscheidungsgrundlage dafür.
