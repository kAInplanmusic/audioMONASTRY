# `QUAL-P2-008`: atomares Schreiben im `AgentRunStore`

**Stand: 2026-09-23 · Status: behoben und bewiesen · Anlass: ein „flaky Test", der keiner war**

---

## 1. Was passiert ist

Zwei vollständige Läufe von `npm run verify` auf **demselben** Stand ergaben
**exit 1** und **exit 0**. Der rote Lauf scheiterte in `tests/agentRuns.test.ts:175`
mit `unbekannter Lauf: r2`, geworfen aus `ResumableAgentRunner.cancel()`.

Mein erster Reflex war: ein zeitabhängiger Test. Der Test lässt je Schritt 20 ms vergehen
und pollt mit 50 × 5 ms — das riecht nach Wettlauf, und ich habe ihn in Iteration 8
**bewusst nicht angefasst**, weil ein blinder Fix (länger warten, retry, überspringen)
einen echten Fehler hätte verdecken können.

**Das war die richtige Entscheidung.** Der Test war der Überbringer, nicht die Ursache.

---

## 2. Der Fehler

`src/core/ai/agentRuns.ts`, `AgentRunStore`:

```ts
// VORHER
async save(record) {
  await writeFile(this.file(record.runId), JSON.stringify(record), 'utf8');
}

async load(runId) {
  try {
    return JSON.parse(await readFile(this.file(runId), 'utf8'));
  } catch {
    return null;                    // ← JEDER Fehler bedeutet "nicht gefunden"
  }
}
```

Zwei Dinge zusammen:

1. **`writeFile` ist nicht atomar.** Es ist *truncate + write*: zwischen den beiden
   Schritten liegt die Datei **leer oder halb geschrieben** auf der Platte.
2. **`load` verschluckt jeden Fehler.** Ein `JSON.parse`-Fehler auf einer halb
   geschriebenen Datei wurde nicht als „unlesbar", sondern als **„existiert nicht"**
   gemeldet.

Und der Auslöser ist kein Randfall: `ResumableAgentRunner.execute()` ruft `onStep` auf
und **speichert bei jedem Schritt** (`await this.store.save(current)`). Gleichzeitig kann
ein zweiter Aufruf lesen — ein Abbruch (`cancel()`), eine Statusabfrage
(`GET /api/ai/agent/runs/:runId`).

---

## 3. Die Messung

`scripts/agentrun-race-repro.ts` (`npm run proof:agentrun-race`) schreibt und liest
gleichzeitig auf denselben Datensatz — die echte Store-Klasse, ein temporäres Verzeichnis,
keine Datenbank.

| | Lesevorgänge | davon fälschlich `null` |
|---|---|---|
| **vorher** | 740 | **399 (53,9 %)** |
| **nachher** | 1 003 | **0 (0,00 %)** |

Mehr als die Hälfte aller Leser bekam für einen **vorhandenen** Datensatz „nicht gefunden".

**Das war kein Testproblem.** Es bedeutete konkret:

* `GET /api/ai/agent/runs/:runId` konnte **404** für einen laufenden Auftrag liefern;
* ein **Abbruch** konnte mit „unbekannter Lauf" fehlschlagen, obwohl der Lauf lief;
* die Oberfläche konnte einen aktiven Auftrag als verschwunden anzeigen.

Der Grund, warum das bisher nie auffiel: der Wettlauf braucht Last. Auf einer Maschine mit
285 parallel laufenden Testdateien passiert er zuverlässig, im ruhigen Einzellauf praktisch nie.

---

## 4. Der Fix

**Atomar schreiben** — in eine temporäre Datei schreiben, dann umbenennen:

```ts
const ziel = this.file(record.runId);
const temp = `${ziel}.${(this.tempZaehler += 1)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
try {
  await writeFile(temp, JSON.stringify(record), 'utf8');
  await rename(temp, ziel);          // atomar auf POSIX
} catch (error) {
  await rm(temp, { force: true }).catch(() => {});
  throw error;
}
```

`rename` ist auf POSIX atomar: ein Leser sieht **entweder die alte oder die neue,
vollständige** Datei — nie etwas dazwischen. Der temporäre Name endet auf `.tmp` und wird
von `list()` (filtert auf `.json`) nicht erfasst.

**`load` unterscheidet jetzt „fehlt" von „unlesbar":** `ENOENT` bedeutet weiterhin
`null` (echt nicht da); jeder andere Fehler wird kurz erneut versucht, statt sofort
aufzugeben. Der Rückgabevertrag bleibt unverändert.

**Zwei Fallstricke, die den Fix sonst gebrochen hätten:**

* **Kein `process.pid`** im temporären Namen. Diese Datei kann über einen Client-Import ins
  Browser-Bundle geraten, wo es `process` nicht gibt — dafür gibt es
  `tests/browserSafeModules.test.ts`. Stattdessen Zähler + Zufall.
* **Der alte Fehler musste vollständig weg**, nicht nur halb: eine atomare Schreibweise
  mit dem alten stillen `null` in `load` hätte den Fall nur seltener gemacht.

---

## 5. Der Beweis, dass es weg ist

**Regressionstest** in `tests/agentRuns.test.ts` (2 Fälle): gleichzeitiges Lesen/Schreiben
liefert nie `null`, und es bleiben keine temporären Dateien liegen. Der Test prüft
zusätzlich, dass überhaupt gemessen wurde (`expect(gelesen).toBeGreaterThan(20)`) — sonst
wäre ein „0 von 0" ein grünes Nichts.

**Gegenprobe — der wichtigste Schritt.** Ein Test, der immer besteht, ist wertlos. Also habe
ich den alten Code kurz wieder eingebaut (nicht-atomares `writeFile` **und** das stille
`null`) und den neuen Test laufen lassen:

```
× liefert beim gleichzeitigen Lesen NIE null fuer einen vorhandenen Lauf
  Tests  1 failed | 14 passed (15)
```

Danach den Fix wiederhergestellt: **15/15 grün**, dreimal in Folge.
Der Test erkennt den Fehler also tatsächlich.

---

## 6. Nachbarschaft: dasselbe Muster noch woanders?

Nach dem Fund habe ich gesucht, wo sonst mit `writeFile` geschrieben und gleichzeitig
gelesen wird. Ein Treffer, inzwischen **behoben** (`QUAL-P3-002`, Iteration 10 —
Details in `docs/QUAL_P3_002_CHUNK_UPLOAD.md`):

**`server/chunkedUpload.ts`** schrieb Upload-Metadaten mit einfachem `writeFile` und
baute sie per *read-modify-write* um (`{ ...meta, chunks: { ...meta.chunks, [index]: len } }`).
`readMeta` meldete jeden Lesefehler als `UNKNOWN_UPLOAD` — dieselbe Verwechslung von
„unlesbar" und „existiert nicht".

**Meine Einstufung als P3 war falsch** — das hat die Messung in Iteration 10 gezeigt. Ich hatte
argumentiert: der Client sendet Chunks sequenziell (`for (const index of chunksToSend(status))`
mit `await`), und das Protokoll ist auf Wiederholung ausgelegt, also sei der Schaden begrenzt.
Die Messung sagt etwas anderes: bei 8 gleichzeitigen Chunks derselben Sitzung blieb **1 von 8
Einträgen** übrig, und die Wiederholung läuft in dieselbe Falle. Der Upload kam so nie zum
Abschluss.

**Lehre:** „abgeschwächt, weil der heutige Client sich brav verhält" ist keine Eigenschaft des
Servers. Der Server muss damit zurechtkommen, was **seine Schnittstelle zulässt** — nicht damit,
was der aktuelle Client zufällig tut. Eine Einstufung, die auf dem Verhalten des Aufrufers
beruht, ist keine Einstufung des Fehlers.

---

## 7. Was ich daraus mitnehme

**Ein Test, der unter Last rot wird, ist ein Hinweis, kein Ärgernis.** Die erste Fassung
dieses Befunds (`QUAL-P2-008`, Iteration 8) lautete: „flaky Test — Ursache offen, bewusst
nicht angefasst". Genau richtig: wer ihn damals „repariert" hätte, hätte einen 404-Fehler in
der API zugedeckt.

**„Nicht gefunden" und „nicht lesbar" sind verschiedene Dinge.** Beide Stellen im Code
machten daraus dasselbe. Das ist ein Muster, auf das man achten sollte, nicht ein Einzelfall.
