# Visual-Import · MONASTRY/Visuals → VisualMONK-Clip-Bank

Die Visuals-Sammlung auf der 2-TB-Platte
(`/mnt/wd-elements/Projekte/MONASTRY/Visuals/`) ist nach 20 Themen sortiert und
enthält lizenzsauberes Material (CC0 / Public Domain / CC-BY / CC-BY-SA /
Eigenmaterial). Dieses Dokument beschreibt, wie daraus Clips in der
audioMONASTRY-Bank werden — ohne KI-Generierung, ohne LoRA.

## Was entsteht

| | |
|---|---|
| Quelle | `MONASTRY/Visuals/01…20_<Thema>/{Bilder,Videos}` + `.meta.json` je Datei |
| Ziel | R2 `audiomonastrysamples` → `visuals/bank/{m,w,p}NNx*.mp4` (+ `_start.jpg`) |
| Clips | 283 (Stufe 1: 100 aus MONASTRY/Visuals · Stufe 2: 43 Kurzclips + 26 Fotos · Stufe 3: 114 Bilder aus /VISUALS) |
| Clips je Kategorie | bis zu 7 aus `MONASTRY/Visuals` (2 Videos + bis zu 5 Bilder); Deckel über **alle** Quellen je Thema = 30 |
| Dateien je Clip | Basis + 8 Varianten + Startbild = 10 (nur Altbestand `b*`: 4–10) |
| Format | 1280×720, 30 fps, H.264 (`yuv420p`, `+faststart`), 6 s |
| Varianten | `_loop` (Ping-Pong, 12 s), `_quadrat` (720×720), `_wide` (1920×1080), `_slow` (0.75×), `_fast` (1.5×), `_mirror`, `_hue15`, `_grau` |
| Index | `visuals/bank/bank-index.json` + `varianten-index.json` (auf R2 ergänzt) |
| Code | generiert: `src/visuals/importedBank.generated.ts` |

Bilder werden zu Ken-Burns-Clips (langsamer Zoom), damit aus stehendem Material
Bewegung wird — dasselbe Prinzip wie bei den acht Wan-2.2-Vorlagen, nur
kostenlos und in Serie.

## Pipeline

```bash
npm run visuals:import:scan     # Auswahl + plan.json (ohne Rendern)
npm run visuals:import:render   # ffmpeg: Basis + Varianten + Startbild
npm run visuals:import:upload   # R2 + Indizes
npm run visuals:import -- ts    # src/visuals/importedBank.generated.ts schreiben
```

Einzelschritte sind wiederholbar: bereits gerenderte/hochgeladene Clips werden
übersprungen, der Plan liegt in `.visual-import/plan.json` (nicht im Git,
ebenso das 900-MB-Render-Verzeichnis).

## Zweite Quelle: eigenes Material (Stufe 2)

`scripts/visual-import/import_brain_local.py` ergänzt Clips von der BRAIN-Platte
(`/Videos`, `/Medien/Videos`, `/Bilder/<Jahr>`). Die Auswahl wurde über
Kontaktabzüge **gesichtet**: nur Aufnahmen **ohne Personen** und mit passendem
Motiv (Landschaft/Wasser/Stadt/Gebäude/Technik) kommen rein; Personenfotos,
Selfies und Rauschaufnahmen sind ausgeschlossen. Ids: `wNNN` (Video), `pNNN` (Foto).
Themen-Deckel: Natur bleibt bei 30 Clips, sonst kippt die Show in eine Diashow.

## Dritte Quelle: `/VISUALS` auf der Platte (Stufe 3)

`scripts/visual-import/import_visuals_folder.py` importiert die eigene
Bildsammlung `/mnt/wd-elements/VISUALS` (148 Dateien, UUID-Namen). Die Zuordnung
zum Thema kommt aus einer Sichtung über fünf Kontaktabzüge, nicht aus dem
Dateinamen: 114 Motive sind drin, 34 bewusst draußen (echte Personen/Porträts,
Hände, Tarot-Karten mit Text, Markenlogos). Ids: `vNNN`.

## Vierte Quelle: themen-sortierte Ordner (Stufe 4)

`scripts/visual-import/import_visuals_themes.py` liest die 14 Themenordner unter
`/mnt/wd-elements/VISUALS` (`01-wwi-duester/` … `14-zitate/`) und die 23 fertigen
Kurzvideos im Wurzelordner (`01-wwi-duester-1.mp4`, `fantasy.mp4`, …). Das Thema
kommt aus dem Ordnernamen bzw. dem Dateinamen-Präfix, nicht aus einer Sichtung.

Ids: `n` + 6 Zeichen SHA-1 des relativen Pfads — dadurch bleibt die Zuordnung
stabil, wenn Dateien umsortiert werden (die älteren `vNNN` aus Stufe 3 hängen
noch an der Listenposition). Fast leere Bilder (Graustufen-Standardabweichung
< 10) werden automatisch verworfen.

## Auswahlregeln (warum dieser Clip, warum nicht)

1. **Lizenz zuerst.** Fehlt die Lizenz in der `.meta.json` oder ist sie nicht
   CC0/PD/BY/BY-SA/Eigenmaterial, fällt die Datei raus.
2. **Themenbezug.** Bewertet wird der Text aus Titel, Dateiname und Tags gegen
   die Suchbegriffe aus `MONASTRY/Visuals/tools/categories.py`
   (Ordnername ×4, Katalogbegriffe ×2, Suchbegriffe ×1). Ganze Wörter
   (`\b`-Grenzen), sonst trifft „rave" auch „gravel".
3. **Videos nur mit Titel-Treffer.** Die Tags der Stock-Anbieter sind zu breit
   gestreut (ein Sonnenuntergang trägt dort „rave"). Videos müssen im Titel
   passen, sonst lieber Ken-Burns aus einem Bild.
4. **Sperrliste.** Nationalsozialistische Motive (§86a StGB), „porno" und
   Rohaufnahme-Müll (`temp`, `home movie`, `vlog`, `IMG_`, `MVI_`, …) fliegen
   raus — unabhängig vom Thema.
5. **Doppelte Dateien** werden über den Dateinamen einmalig verwendet.

## Lizenz-Nachweis

Jeder Eintrag in `bank-index.json` und in `importedBank.generated.ts` führt
`license`, `attribution` und `source_url` mit. Die Dateien werden **same-origin**
über `/api/ai/vision/bank/<id>` ausgeliefert — nicht wegen CORS (der Bucket
sendet `Access-Control-Allow-Origin: *`), sondern weil er privat ist und die
Route den Lesezugriff serverseitig per SigV4 signiert. Beim Weiterverwenden
außerhalb der App ist die Attribution aus dem Index mitzugeben.

## Ausdehnen

* **Mehr Clips je Kategorie:** `imgs[:5]` / `vids[:2]` in `scan()` erhöhen.
* **Mehr Themen:** `CATEGORY_STYLE` in `import_monastry.py` um den Ordnernamen
  ergänzen — die Kategorie muss in `categories.py` existieren (Suchbegriffe).
* **Andere Varianten:** `VARIANTS` ergänzen; jede Variante ist automatisch ein
  eigener Pool-Eintrag (`IMPORTED_POOL` in `poolManifest.ts`).
* **Neues Themenmaterial:** Dateien samt `.meta.json` in den Kategorie-Ordner
  legen, dann `scan → render → upload → ts`.

## Verdrahtung im Code

* `src/visuals/visualBank.ts` — `IMPORTED_SCENES`, `ALL_BANK_SCENES` (was der
  Visualizer lädt) und `BANK_R2_SOURCES` (Whitelist der Server-Route, inkl.
  Varianten-IDs).
* `src/visuals/poolManifest.ts` — `IMPORTED_POOL`, `ALL_POOL`; `poolByMood`,
  `poolByEnergy` und `poolSample` arbeiten auf dem ganzen Topf.
* `src/components/visual/VisualMonkOverlay.tsx` — lädt `ALL_BANK_SCENES`.
* `server/routes/aiRoutes.ts` — unverändert; bedient jede ID aus der Whitelist.

## Betrieb (Stufe 3 · Produktionsreife)

* **Rate-Limit:** `/api/ai/vision/bank/*` hat ein eigenes Budget
  (`VISUAL_BANK_RATE_LIMIT_MAX`, Default 600/min) und ist aus `apiLimiter` und
  `expensiveLimiter` ausgenommen — vorher (10/min) war die Show nach ~1 Minute
  schwarz.
* **Auslieferung:** gestreamt (`Readable.fromWeb`), `Range`/`206`,
  `Accept-Ranges`, `ETag`/`Last-Modified` durchgereicht, 20-s-Timeout,
  `R2 429 → 503 + Retry-After`.
* **Cache:** `public, max-age=31536000, immutable`; Caddy darf das nicht
  überschreiben — die spezifische Regel steht in `Caddyfile` **nach**
  `header /api/* no-store`.
* **Lizenz-Schnitt:** Clips mit Lizenzen ohne Weiterverbreitungsrecht
  (Coverr/Unsplash/Mixkit) sind entfernt (`reconcile_bank.py
  --drop-license-blocked`); der Test `importedBank.test.ts` hält das fest.
* **Index-Reparatur:** `scripts/visual-import/reconcile_bank.py` leitet
  `bank-index.json`/`varianten-index.json` aus dem Plan ab (der Plan ist die
  Wahrheit) und räumt Waisen auf.
* **Deployment:** `.visual-import/` ist aus `.dockerignore` und den
  rsync-Ausschlüssen von `deploy.sh` ausgenommen (2,4 GB Renderdaten).

## Prüfung

```bash
npx vitest run tests/importedBank.test.ts   # Szene/Pool/Whitelist je Clip
npx tsc --noEmit
```
