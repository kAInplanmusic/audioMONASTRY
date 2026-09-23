# `QUAL-P3-002`: verlorene Chunk-Einträge beim parallelen Upload

**Stand: 2026-09-23 · Status: behoben und bewiesen**

---

## 1. Wie es gefunden wurde

Nicht durch einen Test, sondern durch die **Frage nach dem Muster**. Nachdem `QUAL-P2-008`
als nicht-atomares Schreiben entlarvt war, habe ich gesucht, wo sonst mit `writeFile`
geschrieben und gleichzeitig gelesen wird. Ein Treffer:

```bash
rg -n "writeFile\(" src/ server/ --glob '!*.test.*' | rg -v "temp|tmp|rename"
```

`server/chunkedUpload.ts` schrieb die Upload-Metadaten mit einfachem `writeFile` — und baute
sie beim Chunk-Eintrag per *read-modify-write* neu auf:

```ts
// VORHER
const meta = await this.readMeta(uploadId);           // Stand lesen
await handle.write(data, 0, data.length, offset);      // Chunk-Daten
const chunks = { ...(meta.chunks ?? {}), [index]: data.length };
await writeFile(this.metaPath(uploadId), JSON.stringify({ ...meta, chunks, ... }));
```

Zwei gleichzeitige Chunks derselben Sitzung lesen also **denselben** Ausgangsstand, und der
zweite Schreibvorgang überschreibt den Eintrag des ersten.

---

## 2. Die Messung

`scripts/chunkupload-race-repro.ts` (`npm run proof:chunkupload-race`) sendet 8 Chunks
**gleichzeitig** an dieselbe Sitzung — die echte Klasse, temporäres Verzeichnis, kein HTTP.

| | Schreibvorgänge | Fehler | Einträge in den Metadaten |
|---|---|---|---|
| **vorher** | 8 | 0 | **1** (erwartet 8) |
| **nachher** | 8 | 0 | **8** |

Vorher: **7 von 8 Einträgen verloren**, obwohl alle 8 Aufrufe **ohne Fehler** zurückkamen.
Der Client sendet die fehlenden Chunks erneut — und ohne Sperre verlieren sie sich wieder.
**Der Upload kam so nie zum Abschluss.**

Das war kein Missbrauch: die Schnittstelle lässt parallele Chunks ausdrücklich zu, und ein
Client mit mehreren Verbindungen ist der Normalfall.

---

## 3. Der Fix

Drei Teile, alle in `server/chunkedUpload.ts`:

1. **Atomares Schreiben** (`writeMetaAtomic`): erst in eine temporäre Datei, dann `rename`.
   Ein Leser sieht entweder den alten oder den neuen vollständigen Stand — nie eine halb
   geschriebene Datei. Dasselbe Verfahren wie in `AgentRunStore`.
2. **Sperre je Sitzung** (`withMetaLock`): eine Promise-Kette pro `uploadId` serialisiert das
   Fortschreiben der Metadaten. Sie serialisiert **nur** die Metadaten, nicht die Chunk-Daten —
   die gehen an verschiedene Offsets und dürfen parallel laufen.
3. **Innerhalb der Sperre wird neu gelesen.** Das ist der eigentliche Kern: der vorher
   gelesene Stand darf nicht mehr verwendet werden, sonst bleibt der verlorene Eintrag.

Dazu, wie bei `QUAL-P2-008`: `readMeta()` unterscheidet jetzt **`ENOENT` („fehlt")** von
**„nicht lesbar"** (kurzer Retry). Vorher wurde jeder Fehler zu `UNKNOWN_UPLOAD` — ein
gleichzeitiges `status()` während eines Schreibvorgangs konnte deshalb „unbekannte
Upload-Sitzung" für eine existierende Sitzung melden.

---

## 4. Der Beweis

**4 neue Tests** in `tests/chunkedUpload.test.ts` (Datei jetzt 16/16):

* 8 gleichzeitige Chunks → alle 8 Einträge vorhanden, `status.complete === true`
  (mit Gegenprobe, dass kein Aufruf fehlgeschlagen ist — sonst wäre ein fehlender Eintrag
  die richtige Antwort);
* paralleles Lesen während des Schreibens → keine Ausnahme, 12 Lesungen gezählt;
* keine `.tmp`-Reste, genau eine Sitzung in `list()`;
* `assemble()` liefert die richtige Länge, den passenden SHA-256 und je Chunk den
  erwarteten Bytewert — so fällt auch ein falscher Offset auf.

**Gegenprobe** (der wichtigste Schritt): mit der Vor-Fix-Fassung aus HEAD
(`git show HEAD:server/chunkedUpload.ts`):

```
× verliert keinen Chunk-Eintrag, wenn alle Teile gleichzeitig eintreffen
× setzt die Datei korrekt zusammen (Inhalt je Chunk unterscheidbar)
Test Files  1 failed (1)     Tests  2 failed | 14 passed (16)
```

Mit dem Fix: **16/16**. Die Tests erkennen den Fehler also tatsächlich.

---

## 5. Ehrliche Einordnung

Ich hatte `QUAL-P3-002` in Iteration 9 als **P3** eingestuft mit der Begründung, der Client
sende sequenziell und das Protokoll heile Wiederholungen. **Die Messung hat diese Einstufung
widerlegt:** der Verlust ist nicht gelegentlich, sondern **systematisch** (7 von 8), und die
Wiederholung heilt ihn nicht — sie läuft in dieselbe Falle. Aus P3 wurde bei der Umsetzung
eine echte Datenintegritätslücke.

**Lehre:** die Einstufung „abgeschwächt, weil der aktuelle Client sich brav verhält" ist keine
Eigenschaft des Servers. Der Server muss damit zurechtkommen, was seine Schnittstelle zulässt —
nicht damit, was der heutige Client zufällig tut.
