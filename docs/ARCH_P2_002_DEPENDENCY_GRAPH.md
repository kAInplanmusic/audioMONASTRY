# ARCH-P2-002 · Dependency-Graph der `server.ts`-Routen

**Zweck.** Subitem 1 des Tickets verlangt den Dependency-Graph *vor* dem Verschieben
(„Dependency-Graph zuerst, dann Router/Services“). Dieses Dokument hält das Ergebnis
fest, damit die Extraktionsreihenfolge begründet ist und nicht geraten wird.

**Reproduktion.**

```bash
python3 scripts/route-dependency-graph.py
```

Das Skript liest `server.ts`, ermittelt jede Top-Level-Route (`app.get|post|put|delete|patch|use`)
per Klammerbilanz, schneidet String-/Kommentar-Literale weg und schneidet die darin
verwendeten Bezeichner mit den Modul-Scope-Symbolen. Ausgegeben wird je Routen-Gruppe
(erste drei Pfadsegmente), welche **server.ts-lokalen** Symbole eine Route anfasst –
getrennt nach mutierbarem Zustand und Helfern/Konstanten. Importe werden nicht gelistet:
ein extrahiertes Modul importiert sie selbst.

**Grenzen des Verfahrens (ehrlich).** Die Zuordnung ist textuell und hat drei
bekannte Blindstellen, die bei der Umsetzung alle drei real zugeschlagen haben:

1. **Nur Routen-Statements, nicht transitiv.** Nutzt eine Route einen blockeigenen
   Helfer, der seinerseits ein Modul-Symbol anfasst, sieht der Graph das nicht. Im
   AI-Block fehlte dadurch `fleetTargets` (gelesen in `ollamaGenerate`) — gefunden hat
   es erst `tsc`, nicht das Werkzeug.
2. **Regex-Literale kennt der Scanner nicht.** Ein `/['"]/` o. Ä. bringt den
   String-Zustand durcheinander und lässt den Rest der Datei als „Literal" verschwinden.
   Dadurch galten `aiOrchestrator`/`aiPersistence` fälschlich als „nur im Block genutzt",
   und die Importe wären aus `server.ts` entfernt worden (tsc hat es verhindert).
   Deshalb wird die „wird außerhalb noch gebraucht?"-Frage **ohne** Literal-Stripping
   entschieden — konservativ, im Zweifel bleibt ein Import stehen.
3. **Ein Block ist keine Gruppe.** Die erste Blockgrenze war zu eng: der token-freie
   `GET /api/ai/vision/artifact/:name` steht *vor* dem Hauptblock. Gefunden hat das die
   Vollständigkeitsprüfung (Pfadmengen-Vergleich alt/neu), nicht das Werkzeug.

Für die hier gezogenen Schlüsse ist die `/api/ai`-Gruppe zusätzlich **von Hand** geprüft;
jede Extraktion wird per Assertion (Parität, Pfadmengen, Template-Zeilen) und über
`tsc`/`eslint`/`vitest` abgesichert, nicht per Augenschein.

## Ergebnis

Stand: `server.ts` 3.341 Zeilen · 52 Top-Level-Routen · 84 Modul-Scope-Symbole
(9 Zustand, 75 Helfer/Konstanten) · 61 Importe.

| Gruppe | Routen | lokaler Zustand | lokale Helfer |
|---|---:|---:|---:|
| /api/ai | 29 | **0** | 7 |
| /api/master | 5 | 0 | 2 |
| /api | 3 | 0 | 10 |
| /api/voice | 3 | 0 | 9 |
| Cross-Origin-Opener-Policy | 2 | 0 | 1 |
| (unbekannt, Middleware) | 2 | 0 | 1 |
| X-Request-Id | 1 | 0 | 2 |
| X-Content-Type-Options | 1 | 0 | 1 |
| /api/health | 1 | 0 | 1 |
| /api/webrtc-config | 1 | 0 | 1 |
| /api/metrics | 1 | 0 | 5 |
| /api/online | 1 | **1** | 1 |
| /api/audit | 1 | 0 | 2 |
| /api/telemetry | 1 | 0 | 2 |
| /api/alerts | 1 | 0 | 1 |
| /api/library | 1 | 0 | 1 |
| /api/separate-stems | 1 | **1** | 9 |
| /api/stem | 1 | 0 | 1 |
| /api/admin | 1 | **1** | 3 |
| /api/upload | 1 | 0 | 6 |
| /api/generate-voice | 1 | 0 | 1 |
| /api/sound | 1 | 0 | 8 |
| /api/song | 1 | 0 | 12 |

### Befund 1: Der Zustand blockiert die Zerlegung nicht

Es gibt nur **9 mutierbare Modul-Symbole** in `server.ts`:

| Zeile | Symbol | Heimat |
|---:|---|---|
| 90 | `stemActiveJobs` | Stem-Jobs |
| 91 | `stemJobSeq` | Stem-Jobs |
| 131 | `FLEET_MAP_URL` | Flotten-Anzeige |
| 214 | `activeSocketConnections` | Socket-Schicht |
| 238 | `authoritativeSession` | Kollaborations-Kern |
| 239 | `sessionPersistence` | Kollaborations-Kern |
| 240 | `sessionSaveTimer` | Kollaborations-Kern |
| 242 | `serverIo` | Socket-Schicht |
| 287 | `broadcastLockExpiry` | Lock-Schicht |

Keine davon liegt in `/api/ai`, `/api/voice`, `/api/sound`, `/api/song`, `/api/master`,
`/api/library`, `/api/upload`, `/api/telemetry`, `/api/alerts`. Der Zustand sitzt
konzentriert in der Socket-/Session-Schicht und in den drei Routen `/api/online`,
`/api/separate-stems`, `/api/admin`.

### Befund 2: Der eigentliche Blocker sind geteilte Helfer und die Reihenfolge

* `metrics` wird **53-mal** in `server.ts` verwendet (Middleware, `/api/ai`, `/api/metrics`,
  `/api/telemetry`, Audit). Ein extrahiertes Modul darf `server.ts` nicht importieren
  (Zirkularität), also muss `metrics` per Dependency-Objekt gereicht oder in ein eigenes
  Modul gezogen werden.
* Die `app.use(...)`-Ketten (Auth, Rate-Limit, Validierung) liegen vor den Routen und
  bestimmen die Reihenfolge; sie bleiben in `server.ts`. Verschieben einer Route ändert
  daran nichts, solange die Registrierung an der Originalposition bleibt.
* `voiceRuntime*`, `sendWavBuffer`, `cleanVoiceText`, `hfInference`, `hfModelFor`,
  `aceStep*`, `diffRhythm*` werden von `/api/voice`, `/api/sound`, `/api/song` **geteilt** –
  diese Gruppen müssen zusammen oder über ein gemeinsames Helfermodul wandern.

### Befund 3: `/api/ai` ist der sauberste große Block (handgeprüft)

| | |
|---|---|
| Zeilen | 764–1468 (GAP-4-Kommentar + Helfer + Routen) |
| Statements | 29 (28 Routen + die `app.use`-Sammelzeile aus Z. 496, s. Grenzen oben) |
| lokaler Zustand | **keiner** |
| blockeigene Helfer | `AI_TASK_IDS`, `isValidAiTask`, `isValidModelId`, `ollamaGenerate`, `sanitizeJsonBlock` |
| Nutzung dieser Helfer außerhalb 768–1468 | **keine** (per `grep` geprüft) |
| einzige geteilte Abhängigkeit | `metrics` |

Damit wandern die fünf Helfer mit dem Block, und `metrics` ist der einzige Wert, der
übergeben werden muss.

## Extraktionsreihenfolge (begründet)

1. **`/api/ai`** → `server/routes/aiRoutes.ts`. Größter Block, zustandsfrei, Helfer wandern mit.
   Einzige Dependency: `metrics`.
2. **`/api/master`** → reiner Proxy (5 Routen, 1 Helfer `proxyMasterPlayer`), sehr klein.
3. **`/api/voice` + `/api/sound` + `/api/song`** → gemeinsam, weil sie sich die
   Voice-/Song-Helfer teilen (sonst zirkuläre Deps zwischen zwei neuen Modulen).
4. **Einzelrouten ohne Zustand** (`/api/telemetry`, `/api/alerts`, `/api/library`,
   `/api/upload`, `/api/stem`, `/api/audit`, `/api/health`, `/api/metrics`, `/api/webrtc-config`).
5. **Routen mit eigenem Zustand** (`/api/online`, `/api/separate-stems`, `/api/admin`) –
   Zustand wandert mit oder wird über Getter gereicht (Muster aus der
   `sessionRoutes`-Verdrahtung: `get serverIo()` statt Wertkopie).
6. **Socket-/Session-Schicht zuletzt** – größter Umbau, betrifft `authoritativeSession`,
   `serverIo`, `broadcastLockExpiry` und die Kollaborationslogik.

Jeder Schritt folgt dem etablierten Muster aus dem ersten Paket
(`cloudRoutes`/`sessionRoutes`): Factory mit explizitem Dependency-Objekt,
Registrierung an der Originalposition, Paritätsprüfung per Assertion statt Augenschein,
`npm run verify` grün.

## Umsetzungsstand

### Paket 2: `/api/ai` extrahiert (2026-09-14)

| | |
|---|---|
| neu | `server/routes/aiRoutes.ts` (798 Zeilen, Factory `registerAiRoutes(app, deps)`) |
| verschoben | 2 Blöcke: Zeilen 517–534 (token-freier Artifact-Endpoint) und 764–1468 (Hauptblock) = 723 Zeilen |
| `server.ts` | 3.356 → **2.608 Zeilen** (−748); Routen 51 → **23** |
| Dependencies | `metrics` (aiRequests/aiFailures, geteilter Zähler) und `fleetTargets.ollama` (transitiv, s. Grenze 1) |
| Importe | 43 der 45 betroffenen Importe wandern mit; `llmRouter` und `uploadSampleToR2` bleiben in `server.ts` (dort weiterhin gebraucht) |
| Der Code | 1:1 verschoben, **nur** die Einrückung ist neu (Assertion: 662 Code-Zeilen in Reihenfolge, 12 Template-Zeilen byte-identisch) |

Nachweise: `npx tsc --noEmit` 0 · `npx eslint . --max-warnings=0` 0 ·
`npm run verify:boundary` 431/0 · `npx vitest run` 1432/1432 (209 Dateien) ·
`npm run build` ok (dist/server.cjs 317 kB) · collab-E2E 5 von 6 Läufen grün
(38,9–41,4 s).

Der eine rote Lauf scheiterte in Test 87 (`SESSION 2/4`), also an der
Socket-Mitgliederliste — ein Pfad, den diese Extraktion nicht berührt: die
Routen-Registrierung hat keinen Einfluss auf die Session-Zählung, und der einzige
Catch-all `app.get('*')` steht erst bei Zeile 1955, also nach der Registrierung.
Bleibt als offener Beobachtungspunkt notiert, nicht als erledigt.

### Nächste Pakete

Nach der Reihenfolge oben: `/api/master` (Proxy, 5 Routen), dann
`/api/voice` + `/api/sound` + `/api/song` gemeinsam (geteilte Voice-Helfer).
