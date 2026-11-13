# A5 – getrennte Netzwerk-/Prozess-Telemetrie

## Umfang und Grenzen

`npm run audit:rt:telemetry` ist ein expliziter Zusatzlauf. Ohne diesen Aufruf
läuft keine neue Messung; `scripts/audit/rt-bench.ts` und dessen DSP-Gates bleiben
unverändert. Der Collector liest Prozess-CPU über Linux `/proc/<PID>/stat`
und sendet UDP-Echo-Proben. Es werden keine Container oder Cloud-Ressourcen
gestartet, gestoppt oder verändert.

Der gespeicherte Dauerlauf verwendet **einen lokalen Testprozess**, keinen
angemeldeten Browser-Mixer-Holder. `rt-holder-harness.ts:6-20` rendert den echten
`V2SinkEngine` mit Testton und Master-DSP in 128er-Blöcken bei 48 kHz. Die
Renderanzahl folgt der verstrichenen monotonen Wanduhr; 600 Sekunden werden
nicht durch das schnelle Rendern von 600 Sekunden Audio ersetzt. Der Collector
und der Renderer sind getrennte Prozesse (`rt-telemetry.mjs:42`). Die gemessene
Renderer-CPU enthält auch seinen lokalen UDP-Echo-Dienst
(`rt-holder-harness.ts:22-26`).

**Live-Verifikation offen:** Dieser Lauf belegt weder die CPU eines tatsächlichen
Browser-Holders noch WAN-/LAN-/WebRTC-RTP-Jitter. Dafür fehlen eine bestätigte
Holder-PID und ein bestehender erreichbarer Messendpunkt. A5 bleibt hierfür ⚠️.

## Definitionen und Rohdaten

- Netzwerk-Jitter: absoluter Unterschied aufeinanderfolgender UDP-Roundtripzeiten,
  `abs(RTT[n] - RTT[n-1])`, nur für unmittelbar aufeinanderfolgende Sequenznummern
  in Empfangsreihenfolge (`rt-telemetry.mjs:82-93`). Gemessen wird die kombinierte
  Laufzeitvariation von Hin-/Rückweg samt Echo-/OS-Scheduling. Keine Aussage über
  synchronisierte Einweglaufzeit oder RTP-Jitter. Der Dauerlauf verwendet Loopback.
- Verteilung: nearest-rank p50/p95/p99/max, ohne Ausreißerentfernung
  (`rtTelemetry.mjs:2-7`). Leere Verteilungen enthalten `null`, nicht erfundene Nullen.
- CPU: Änderung der Prozess-User-/Systemticks pro monotonem Messintervall,
  `CLK_TCK` aus `getconf`; 100 % entspricht einem logischen Kern. Kindprozesse
  sind ausgeschlossen. Abtastung jede Sekunde plus finales Restintervall.
  PID-Wiederverwendung wird über Prozessstartticks erkannt
  (`rtTelemetry.mjs:10-20`, `rt-telemetry.mjs:62-64,102-111`). Bei 100 Hz ist die
  Tickauflösung 10 ms; kleine Intervallunterschiede sind deshalb quantisiert.
- `packets.csv`: Sequenznummer, Empfangszeit seit Start, Sendezeit seit Start,
  RTT und Jitter in ms; der erste oder nicht sequenzielle Jitterwert ist leer.
  Fehlende Sequenznummern im Bereich `[0, summary.sent)` entsprechen Verlusten.
- `cpu.csv`: Zeitpunkt, tatsächliches Intervall, CPU-Prozent, kumulative Ticks.
- `summary.json`: Host, Node, gemessener Commit/Dirty-Status, ISO-Zeiten,
  Messdauer, Modus, Endpunkt, Paketverlust, Verteilungen, zeitgewichtete CPU,
  Renderer-Blockanzahl und Fehlerstatus.

## Reproduktion

Abhängigkeiten: Linux mit lesbarem `/proc`, `getconf`, Node 22 und `npm ci`.
Hier wurde `npm ci --ignore-scripts --no-audit --no-fund` verwendet; es wurden
607 Pakete installiert. Der Cloud-Standard war Node v24.22.1 / npm 11.9.0;
das Repo verlangt laut `package.json` Node >=22 <23. Messung und Prüfungen
verwenden deshalb Node v22.23.5 über den folgenden Aufruf:

```sh
npm exec --yes --package=node@22 -- node scripts/audit/rt-telemetry.mjs --local-harness --duration 600 --out docs/audit/A5_RT_TELEMETRY_2026-11-13
```

Der lokale Fixture-Prozess wird vom Collector gestartet und danach beendet.
Das betrifft ausschließlich diesen Testprozess. Der bestehende DSP-Benchmark
ist weiterhin `npm run audit:rt` bzw. `npm run audit:rt:gate`.

Für einen **bereits laufenden** Holder und einen **bereits vorhandenen**
UDP-Echo-Endpunkt auf demselben Messhost (keine Bereitstellung durch das Skript):

```sh
npm run audit:rt:telemetry -- --holder-pid <PID> --echo-host <HOST> --echo-port <PORT> --duration 600 --out work/rt-live
```

Die PID muss tatsächlich zum zu prüfenden Holder gehören. Diese Zuordnung
überprüft der Collector nicht. Der bestehende Echo-Endpunkt muss die empfangenen
12 Bytes unverändert zurücksenden. Keine Zugangsdaten als CLI-Argumente verwenden.

## Durchgeführte Prüfungen

```sh
npm exec --yes --package=node@22 -- node --test scripts/audit/rtTelemetry.test.mjs
```

Originalzusammenfassung (Exit 0):

```text
# tests 3
# suites 0
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

Die Tests prüfen Percentile einschließlich maximalem Ausreißer, den Linux-Stat-
Parser mit Sonderzeichen im Prozessnamen und CPU-Berechnung/PID-Wiederverwendung.

```sh
npm exec --yes --package=node@22 -- node node_modules/eslint/bin/eslint.js scripts/audit/rtTelemetry.mjs scripts/audit/rtTelemetry.test.mjs scripts/audit/rt-telemetry.mjs scripts/audit/rt-holder-harness.ts --max-warnings=0
```

Originalausgabe: leer, Exit 0.

Ein Smoke-Lauf mit `--duration 3 --out /workspace/work/a5-smoke` endete mit
Exit 0: gemessen 3.000674679 Sekunden, 148 gesendet / 148 empfangen / 0 verloren,
147 Jitter-Differenzen. Er lief vor dem Implementierungscommit, daher dirty=true;
er ist kein Ersatz für den gespeicherten 600-s-Lauf.

```sh
npm exec --yes --package=node@22 -- npm run verify
```

Originalausgabe nach Start der verify-Kette (Exit 2):

```text
> audioMONASTRY@1.210.001 typecheck
> tsc --noEmit

src/core/ai/orchestrator/brainBench.ts(29,64): error TS1109: Expression expected.
```

`git diff --exit-code 5193d9e -- src/core/ai/orchestrator/brainBench.ts`
lieferte keine Ausgabe (Exit 0): `brainBench.ts` ist in A5 unverändert.
Die weiteren verify-Gates wurden wegen
dieses ersten Fehlers nicht erreicht. Eine grüne Gesamtverifikation liegt nicht vor.

Separat ausgeführt:

```sh
npm exec --yes --package=node@22 -- node --import tsx scripts/audit/rt-bench.ts --gate
```

Exit 1; Originalausschnitt:

```text
FAIL  RT-AUDIT-P0-002/over       Blöcke über Budget (2,67 ms)                                2 Blöcke       SOLL = 0
19/20 Grenzen eingehalten.
```

Diese Messung ist ein offener Gatebefund. Die Ursache wurde nicht bestimmt.
`git diff 5193d9e -- scripts/audit/rt-bench.ts` lieferte keine Ausgabe (Exit 0).
Die bestehende DSP-Messung wurde nicht geändert oder abgeschwächt.

## Dauerlauf

Ergebnisse und Original-Rohdaten liegen nach Abschluss unter
`docs/audit/A5_RT_TELEMETRY_2026-11-13/`. Der gemessene Implementierungscommit
ist `a55a4a5d57ff680023bd7f1c3f38fb7dfa32a5e6`.

Setup: geteilte Cloud-CPU, lokaler V2-Renderer plus UDP-Echo/Collector.
Während des 600-s-Laufs wurden `npm run verify`, der separate DSP-Gate-Lauf
und gezielte Lint-/Helpertests ausgeführt; parallel arbeiteten die übrigen
Aufgabenagenten. Es lag **keine isolierte Leerlaufumgebung** vor. Die gemessene
PID-CPU bleibt prozessspezifisch; Scheduler-/Paketzeiten können durch diese
Parallelaktivität beeinflusst sein. Die Rohwerte werden nicht bereinigt.

Rohdatenprüfung (aus dem Repo-Wurzelverzeichnis):

```sh
python3 - <<'PY'
import csv, json, math
from pathlib import Path
p = Path('docs/audit/A5_RT_TELEMETRY_2026-11-13')
s = json.loads((p / 'summary.json').read_text())
packets = list(csv.DictReader((p / 'packets.csv').open()))
cpu = list(csv.DictReader((p / 'cpu.csv').open()))
assert s['measuredSeconds'] >= 600 and s['error'] is None
assert s['dirty'] is False
assert len(packets) == s['received'] and len(cpu) == s['cpuPercent']['count']
assert float(cpu[-1]['elapsedMs']) >= 600000
assert s['sent'] - s['received'] == s['lost']
for key, values in [
    ('jitterMs', [float(r['jitterMs']) for r in packets if r['jitterMs']]),
    ('rttMs', [float(r['rttMs']) for r in packets]),
    ('cpuPercent', [float(r['cpuPercent']) for r in cpu]),
]:
    values.sort()
    assert len(values) == s[key]['count']
    for name, q in [('p50', .5), ('p95', .95), ('p99', .99), ('max', 1)]:
        assert values[max(0, math.ceil(q * len(values)) - 1)] == s[key][name]
print(f"PASS: {s['measuredSeconds']:.6f}s; {len(packets)} UDP rows; {len(cpu)} CPU rows; all distributions reproduce")
PY
```

Originalausgabe der Rohdatenprüfung (Exit 0):

```text
PASS: 600.002025s; 29788 UDP rows; 600 CPU rows; all distributions reproduce
```

Gemessen auf Host `3e5f32b30d89`, Node `v22.23.5`, Commit
`a55a4a5d57ff680023bd7f1c3f38fb7dfa32a5e6`, `dirty=false`.
Start `2026-11-13T07:21:11.371Z` / Ende `2026-11-13T07:31:11.589Z`
(08:21–08:31 Europe/Berlin). Monotone Messdauer: **600.002025103 s**.
Der Renderer meldete 225078 Blöcke / 600.208 s Audio. Sein Audiozähler läuft
bereits vor der ersten CPU-Probe und bis nach dem expliziten 200-ms-Echo-Drain
nach der CPU-Messphase (`rt-holder-harness.ts:12-26`, `rt-telemetry.mjs:77-79,112-118`).
Für die Zehn-Minuten-Aussage zählt die monotone CPU-Messdauer.

| Größe | p50 | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: |
| UDP-RTT-Differenz, ms | 0.032378 | 0.347214 | 2.167786 | 21.043035 |
| UDP-RTT, ms | 0.162160 | 0.380233 | 1.595159 | 21.368045 |
| Renderer-Prozess-CPU, % eines Kerns | 6.001602 | 8.995100 | 10.002300 | 17.983310 |

29788 Pakete gesendet und empfangen, 0 verloren, 0 Duplikate;
29787 Jitter-Differenzen, 600 CPU-Samples. Zeitgewichtete mittlere
Prozess-CPU: 6.526645 %. Vollständige Präzision und Fehlerstatus `null`
stehen in `A5_RT_TELEMETRY_2026-11-13/summary.json`.

**DoD:** Rohdaten und reproduzierbare Auswertung für zehn echte Minuten sind
vorhanden. Die Prozess-/Netzwerk-Messung ist im lokalen V2-Testaufbau belegt.
Die Anforderung einer Messung des echten Browser-Mixer-Holders und seines
Produktionsnetzwerks ist weiterhin offen; deshalb Gesamtstatus **⚠️**.
Die fehlgeschlagene Gesamtverifikation und der separate DSP-Gatefehler bleiben
ebenfalls offen. Es wurde nichts auf `main` gepusht und nichts gemergt.
