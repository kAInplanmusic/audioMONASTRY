# Block 2 — die fünf Angriffe, mit Messwerten (2026-09-23)

Bezug: `MASTERTODOENDE.json` → `SEC-P2-004`. Dieses Dokument beantwortet die drei
Angriffe, die nach Iteration 4 noch offen waren (1, 2, 5). Die Angriffe 3 und 4
sind in Iteration 4 gehärtet und belegt worden (siehe Audit-Report §9.2).

**Grundregel dieses Dokuments:** jede Aussage trägt einen Beleg — Datei und Zeile
oder einen Befehl mit Ausgabe. Wo ein Beleg fehlt, steht `ANNAHME:` oder
`TODO(verify):` — es steht nicht "erledigt".

**Grenze der Belege:** die Flotte ist aus (0 Server). Ein echter Lastversuch
gegen laufende Endpunkte war nicht möglich. Alle Zahlen unten stammen aus
Code, Konfiguration und den bereits gemessenen Werten im Repo — nicht aus einem
neuen Angriffslauf. Das ist der Grund, weshalb `SEC-P2-004` **PARTIAL** bleibt
und nicht DONE.

---

## Angriff 1 — Kostenerschöpfung

**Frage:** Was kann jemand mit gültigem Studio-Token an Geld auslösen?

### Was bremst (belegt)

| Bremse | Wert | Beleg |
|---|---|---|
| Anfragen an die teuren Pfade | **10 / Minute** je Schlüssel | `server.ts:598-607` (`expensiveLimiter` mit `AI_RATE.expensiveMax`), angehängt an `/api/ai`, `/api/voice`, `/api/sound`, `/api/song`, `/api/separate-stems`, `/api/cloud/upload`, `/api/cloud/sync`, `/api/upload/sample` (`server.ts:624`) |
| Flotten-Stundenbudget | **10 EUR/h** hart, Zielband 5–7,5 | `src/config/aiInfrastructure.ts:97` (`AI_MAX_FLEET_EUR_PER_HOUR`), geprüft in `src/core/ai/orchestrator/fleetWake.ts:341` (`assertFleetHourlyBudget`) **vor** dem ersten Netzwerkaufruf; Überschreitung → Wecken startet nicht, Antwort 409 |
| Zugang | gültiger Studio-Token nötig | `server.ts:430-465`: `/api/*` außer Health/Metrics/CSP-Report verlangt den Token, sonst 401 `STUDIO_TOKEN_REQUIRED` |
| Harte Obergrenze | **RunPod-Guthaben** | `402 → INSUFFICIENT_CREDIT`, nicht wiederholbar (`docs/audit-infra-runpod.md:286`) |
| Sofortstopp | Kill-Switch | `server/killSwitch.ts`, in Iteration 2 gebaut und in beide Richtungen gemessen |

Damit ist die **Geldsumme strukturell gedeckelt**: mehr als 10 EUR/h lässt der
Wächter nicht zu, und wenn das Guthaben leer ist, endet es am Anbieter.

### Was NICHT bremst (belegt — und das ist der Befund)

```
$ rg -n "concurrencyMax" --glob '!node_modules' --glob '!dist' .
src/config/aiRateLimits.ts:14:  concurrencyMax: number;      ← Feld
src/config/aiRateLimits.ts:22:  concurrencyMax: 4,           ← Default
src/config/aiRateLimits.ts:37:  …env('AI_RATE_CONCURRENCY_MAX', …)  ← aus Env lesbar
tests/aiRateLimits.test.ts:17: expect(cfg).toEqual({ …, concurrencyMax: 2 });  ← getestet
```

**Es gibt keinen Abnehmer.** `concurrencyMax` ist deklariert,
umgebungs­konfigurierbar und unit-getestet — und wird von **keiner**
Produktionsdatei gelesen. Dasselbe gilt für `AI_RATE.max` (30/min) und
`AI_RATE.windowMs`: nur `expensiveWindowMs` und `expensiveMax` sind verdrahtet.

Das ist die unangenehmste Sorte Befund: in den Tests sieht die Kostenbremse
vollständig aus, im Betrieb sind zwei ihrer fünf Felder wirkungslos.

**Was das praktisch bedeutet:** gleichzeitige Aufträge werden nicht begrenzt. Die
Anzahl paralleler GPUs bestimmt allein die Autoskalierung des Anbieters (in der
Endpunktliste steht `n: 1` als *Minimum*, ein `workersMax` ist **nicht** gesetzt —
`docs/audit-infra-runpod.md` Abschnitt 4). Der EUR/h-Wächter begrenzt die Summe,
die Parallelität begrenzt er nicht.

### Verdrängungsbefund (Dokumentationsdrift)

`docs/audit-infra-runpod.md:300` führt als „Befund V3-4 (MITTEL)":

> `wakeFleet()` weckt immer die komplette Flotte, ohne Kosten-Gate … keine Prüfung
> gegen `AI_MAX_FLEET_EUR_PER_HOUR` vor dem Wecken.

Dieser Zustand ist **behoben** (`fleetWake.ts:341`, SSOT-Eintrag DONE 2026-09-20).
Das Dokument ist eine Momentaufnahme von vorher und sagt das nicht. Wer nur die
Infra-Audit-Datei liest, hält ein geschlossenes Loch für offen. In Iteration 5 ist
dort ein Korrekturhinweis ergänzt worden.

`ANNAHME:` Weil die Flotte aus ist, ist der 402-Pfad (`INSUFFICIENT_CREDIT`) nach
wie vor **nicht live provoziert** — das ist der eigene offene Punkt O-8 aus
`docs/audit-infra-runpod.md:496`. Ein echter Angriff würde heute am leeren Konto
enden, nicht am Wächter; das ist kein Nachweis, sondern ein Nebeneffekt.

---

## Angriff 2 — Speichererschöpfung

### Per-Request-Grenzen (belegt)

| Pfad | Grenze | Beleg |
|---|---|---|
| Upload-Chunk | 32 MB roh | `server/routes/uploadRoutes.ts:269` (`express.raw({ limit: '32mb' })`) |
| JSON-Rümpfe | 50 MB | `server.ts:242` (`express.json({ limit: '50mb' })`) |
| Probe-Upload | 100 MB (`UPLOAD_MAX_MB`) | `server/routes/uploadRoutes.ts:49,82` |
| Chunk-Anfragen | 240/min | `server.ts:534` (`UPLOAD_CHUNK_RATE_LIMIT_MAX`) |

Der Server **puffert vollständig**: `Buffer.concat(chunks)` (`server.ts:887`) und
`parseMultipartStream(..., maxFileBytes)` — die Datei liegt als ganzes `Buffer` im
Heap (`uploadRoutes.ts:46,65`).

### Der Deckel ist der Container (belegt)

`docker-compose*.yml` setzen Speichergrenzen je Dienst (gemessen: 128M, 256M,
384M, 512M, 1G, 2G, 4G). Ein Überlauf tötet also **den Dienst**, nicht den Host —
Containment ist vorhanden, Verfügbarkeit ist es nicht.

### Was fehlt (belegt)

```
$ rg -n "semaphore|p-limit|maxConcurrent|inFlight|activeUploads" server/ server.ts
(keine Treffer)
```

**Es gibt keine Parallelitätsbremse für Uploads.** Der Speicherbedarf skaliert mit
der Anzahl gleichzeitiger Anfragen bis zur Container-Grenze: N × 32 MB Chunk bzw.
N × 100 MB Sample. Die verfügbaren Grenzen sind pro Anfrage, nicht pro Dienst.

### Was das bestehende Gate wirklich prüft

```
$ npm run check:memory
[memory-gate] Heap vorher 3.96 MB · nachher 3.99 MB · Delta 0.03 MB (Gate 512.00 MB)
✅ Memory-Pressure-Gate bestanden (< 512 MB Heap-Delta).
```

Das ist ein **Frontend**-Gate: `scripts/memory-pressure-gate.mjs` fährt
Worklet-artige Blockverarbeitung, Snapshot-Serialisierung und den
Telemetrie-Ringpuffer. Es misst **nicht** den Server unter Upload-Last. Der
Kommentar im Skript sagt das selbst ("Die volle 2-GB-OOM-Simulation bleibt
bewusst offen"). Es ist also kein Beleg für Angriff 2 — nur für schleichende
Leaks im Client.

`TODO(verify):` Ein Lastversuch mit vielen parallelen Uploads (N × 32 MB) gegen
einen laufenden Dienst mit `--max-old-space-size`-Grenze und protokolliertem
Heap-Verlauf. Ergebnis wäre: bei welchem N kippt es, und greift der Watchdog.

---

## Angriff 5 — Polyglot-Auslieferung

**Frage:** Kann eine Datei mit harmlosem Namen und fremdem Inhalt so ausgeliefert
werden, dass der Browser sie ausführt?

### Was schützt (belegt)

| Schutz | Beleg |
|---|---|
| `X-Content-Type-Options: nosniff` auf **allen** Antworten | `server.ts:275-283`; die Middleware steht in der Kette **vor** den statischen Handlern (`server.ts:989,1005,1017`), nicht dahinter |
| `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, CSP | dieselbe Middleware |
| Audio-Whitelist beim Upload | `server/routes/uploadRoutes.ts:73`: ohne Audio-Endung **und** ohne `audio/`-Content-Type → **415**, kein Speichern |
| Namensbereinigung | `safeName` + `objectKey` unter `uploads/<kind>s/…` (kein Pfadausbruch, geprüft in Iteration 1) |

`nosniff` ist hier der entscheidende Teil: ohne diesen Kopf würde ein Browser bei
einem Inhalt, der nach HTML aussieht, den erklärten Typ ignorieren. Mit `nosniff`
gilt ausschließlich der gesendete Typ — und der kommt bei Uploads aus der
Whitelist-Prüfung.

### Restrisiko (klein, aber nicht null)

Hochgeladene Dateien werden nach R2 geschrieben, mit
`ContentType: contentType` (`server/cloud.ts:369`). Der Wert stammt aus der
Anfrage; die Whitelist lässt nur `audio/*` durch. Wird eine solche Datei später
**direkt aus R2/Supabase** abgerufen, setzt unser `nosniff`-Kopf **nicht** — er
kommt nur, wenn die Antwort durch den Server läuft.

`ANNAHME:` Ein Browser führt `audio/mpeg` nicht als HTML aus, deshalb ist das
Risiko gering. Belegt ist diese Annahme nicht: es fehlt ein Test, der eine Datei
mit Audio-Endung und HTML-Inhalt einspeist und den Kopf beim Abruf prüft.

`TODO(verify):` Abruf einer hochgeladenen Datei über den R2-Weg (nicht über den
Server) und Prüfung, ob ein `nosniff`/`Content-Disposition` gesetzt wird. Falls
nicht, ist die Entscheidung zu treffen: fester Content-Type oder
`Content-Disposition: attachment` erzwingen.

---

## Ergebnis

| Angriff | Stand | Kernaussage |
|---|---|---|
| 1 Kosten | **belegt**, ein Befund | Geldsumme durch 10-EUR/h-Wächter (geprüft, 409) + Guthaben gedeckelt; **`concurrencyMax` und `AI_RATE.max` sind tote Konfiguration**, Parallelität ist nicht begrenzt; `workersMax` nirgends gesetzt |
| 2 Speicher | **belegt**, ein Befund | Grenzen pro Anfrage (32/50/100 MB) und Container-Grenze vorhanden; **keine Parallelitätsbremse** für Uploads; das bestehende Memory-Gate prüft den Client, nicht den Server |
| 5 Polyglot | **belegt**, kleines Restrisiko | globale `nosniff`-Kopfzeile + Audio-Whitelist (415) verhindern die Ausführung im Browser; ungeprüft bleibt die Auslieferung direkt aus R2 |
| 3 Bombe | **gehärtet** (Iteration 4) | Metadaten-Probe vor dem Dekodieren, `-t`/`-fs`, fail-closed; 10/10 Tests |
| 4 ffmpeg | **gehärtet** (Iteration 4) | `-protocol_whitelist` in beiden Aufrufstellen, 6/6 Prüfungen inkl. Gegenprobe |

**`SEC-P2-004` bleibt PARTIAL**, weil zwei Prüfungen offen sind, die beide eine
laufende Umgebung brauchen: der Lastversuch zu Angriff 2 und der R2-Abruf zu
Angriff 5. Ohne Flotte ist beides nicht zu liefern — und eine Annahme in eine
Erledigung umzuschreiben wäre genau der Fehler, den dieses Dokument vermeiden soll.
