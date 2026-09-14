# ARCH-P2-002 · Dependency-Graph der `server.ts`-Routen

**Zweck.** Subitem 1 des Tickets verlangt den Dependency-Graph *vor* dem Verschieben
(„Dependency-Graph zuerst, dann Router/Services“). Dieses Dokument hält das Ergebnis
fest, damit die Extraktionsreihenfolge begründet ist und nicht geraten wird.

**Reproduktion.**

```bash
python3 scripts/route-dependency-graph.py                  # Bericht (Markdown)
python3 scripts/route-dependency-graph.py --json           # maschinenlesbar
python3 scripts/route-dependency-graph.py --plan /api/ai   # Extraktionsplan
```

Das Skript liest `server.ts`, ermittelt jedes Top-Level-Statement
(`app.get|post|put|delete|patch|use` und Deklarationen) per Bilanz über `(){}[]`,
schneidet String-/Template-/**Regex**-/Kommentar-Literale weg und verfolgt die darin
verwendeten Bezeichner **transitiv** durch blockeigene Helfer. Ausgegeben wird je
Routen-Gruppe (erste drei Pfadsegmente), welche **server.ts-lokalen** Symbole sie
anfasst – getrennt nach mutierbarem Zustand und Helfern/Konstanten, plus die Importe
und **alle** Zeilenbereiche der Gruppe. `--plan <prefix>` ist die Arbeitsanweisung für
eine Extraktion: genau diese Bereiche verschieben, genau diese Dependencies übergeben.

Abgesichert durch `tests/routeDependencyGraph.test.ts` (6 Tests) mit Fixtures unter
`tests/fixtures/routeDepGraph/` — je einer pro Blindstelle (siehe unten).

**Die drei Blindstellen sind gefixt (2026-09-14).** Jede hatte beim ersten Umsetzen
real zugeschlagen; jede hat jetzt Fixture + Test, damit sie nicht zurückkommt:

| Blindstelle | Vorher | Jetzt |
|---|---|---|
| 1. **nicht transitiv** | Nur direkte Referenzen: `fleetTargets` (gelesen in `ollamaGenerate`) fehlte — gefunden hat es erst `tsc`. | Closure über die Referenzen der Top-Level-Deklarationen. `--plan /api/ai` listet `fleetTargets` (im Vorher-Stand geprüft). |
| 2. **Regex-Literale** | Ein `/['"]/` desynchronisierte den String-Zustand und ließ den Rest der Datei als „Literal“ verschwinden; dadurch galten `aiOrchestrator`/`aiPersistence` fälschlich als blocklokal, die Importe wären aus `server.ts` entfernt worden (tsc verhinderte es). | Eigene Regex-Erkennung (Vorgängerzeichen/-Schlüsselwort, Zeichenklassen, Escapes, Flags). Die „wird außerhalb noch gebraucht?“-Frage bleibt zusätzlich konservativ (ohne Literal-Stripping). |
| 3. **ein Block ≠ eine Gruppe** | Die Blockgrenze war zu eng: der token-freie `GET /api/ai/vision/artifact/:name` steht *vor* dem Hauptblock; gefunden hat das die Vollständigkeitsprüfung. | Eine Gruppe ist die Menge **aller** Statements ihres Präfix. `--plan` gibt die vollständige Bereichsliste aus (Vorher-Stand: 29 Bereiche statt 1 Block). |

**Verbleibende Grenzen (ehrlich).** Die Regex-Erkennung ist eine Heuristik: nach `)`,
`]` und `}` wird bewusst Division angenommen, weil Block vs. Objektliteral ohne Parser
nicht entscheidbar ist — ein verpasstes Regex ist der harmlose Fall (es wird dann nur
etwas zu viel maskiert). Die Zuordnung bleibt textuell, kein Parser: gleichnamige
lokale Variablen können eine Über-Approximation erzeugen. Für die gezogenen Schlüsse
ist die `/api/ai`-Gruppe zusätzlich **von Hand** geprüft; jede Extraktion wird per
Assertion (Parität, Pfadmengen, Template-Zeilen) und über `tsc`/`eslint`/`vitest`
abgesichert, nicht per Augenschein.

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

### Pakete 3–8: die restlichen 23 Routen extrahiert (2026-09-14)

Alle noch offenen Route-Handler sind draußen und registriert. `server.ts`:
**3.476 → 1.383 Zeilen**, davon **0 Top-Level-Route-Handler** — es bleiben
Middleware-Registrierungen (CORS, Rate-Limit, Security-Header) und die
Socket-/Session-Schicht.

| Paket | Routen | neues Modul | Gereicht (Gründe) |
|---|---|---|---|
| 3 | `/api/master` (5) | `masterRoutes.ts` | `getMasterPlayerUrl` — auch `/api/upload/sample` braucht sie |
| 4 | `/api/voice` + `/api/sound` + `/api/song` (5) | `voiceRoutes.ts` | nichts außer `app` — 19 Helfer und 4 Schemas wandern mit |
| 5 | `/api/generate-voice`, `/api/library`, `/api/stem`, `/api/webrtc-config` (4) | `mediaRoutes.ts` | nichts außer `app` |
| 6 | `/api/health`, `/api/metrics`, `/api/online`, `/api/audit`, `/api/telemetry`, `/api/alerts` (6) | `opsRoutes.ts` | `metrics`, `STEM_MAX_JOBS`, `serverAuditLog` (Referenz) + **Getter** `getStemActiveJobs`, `getActiveSocketConnections` |
| 7 | `/api/upload/sample` (1) | `uploadRoutes.ts` | `parseMultipartStream` (auch Stems), `getMasterPlayerUrl` |
| 8 | `/api/separate-stems`, `/api/admin/debug` (2) | `stemRoutes.ts`, `adminRoutes.ts` | `STEM_MAX_JOBS`, `metrics`, `fleetTargets`, `parseMultipartStream`, `safeTokenEqual`; der Stem-Zähler **wandert mit** und wird als `getStemActiveJobs()` exportiert |

Zwei Muster, die sich dabei bewährt haben bzw. erzwungen waren:

- **Getter statt Wertkopie** für veränderliche Skalare. `stemActiveJobs` und
  `activeSocketConnections` werden von anderer Stelle fortgeschrieben; als Wert
  übergeben würde die Anzeige einfrieren. Der Stem-Zähler liegt jetzt in
  `stemRoutes.ts` (dort schreibt ihn die Route) und wird von Ops/Admin über den
  exportierten Getter gelesen.
- **Helfer in die Factory, Zustand auf Modulebene.** Verschobene Funktionen
  brauchen die gereichten Dependencies im Scope, exportierte Getter brauchen den
  Zustand auf Modulebene. Zuerst lagen beide auf Modulebene — tsc fand
  `fleetTargets` nicht.

Nachweise: `npm run verify` **exit 0** (tsc 0, eslint 0, vitest **1.445/1.445** in
210 Dateien, security 0, Deep Audit 0 gate-relevante Findings, **knip 0**) ·
`npm run build` ok · `npm run verify:boundary` 431/0.

jscpd meldet 19 Findings; drei davon sind Selbst-Klone in `voiceRoutes.ts`. Sie
sind **mitgezogen, nicht erzeugt**: im Vorher-Stand stehen dieselben Paare an
denselben Stellen (`server.ts` [1558–1570] ↔ [1480–1492], [1675–1692] ↔
[1788–1803], [1710–1720] ↔ [1851–1861]) — die drei Voice-Handler waren schon dort
strukturell gleich; sie sauber zu deduplizieren wäre eine eigene, verhaltensändernde
Aufgabe.

### Was bewusst offen bleibt

Die **Socket-/Session-Schicht** in `server.ts` (7 Modul-Symbole Zustand:
`authoritativeSession`, `sessionPersistence`, `sessionSaveTimer`, `serverIo`,
`broadcastLockExpiry`, `activeSocketConnections`, `FLEET_MAP_URL`) und der
eingerückte **SPA-Catch-all** `app.get('*')` in der Production-Verzweigung. Der
Catch-all muss zwingend zuletzt registriert werden und gehört damit nicht in eine
Factory; die Socket-Schicht ist kein Route-Handler und war oben schon als letzter
Schritt geführt.

### Nächste Pakete

Socket-/Session-Schicht (Reihenfolge siehe oben, zuletzt), danach die
verhaltensneutrale Deduplizierung der drei Voice-Handler-Selbstklone.
