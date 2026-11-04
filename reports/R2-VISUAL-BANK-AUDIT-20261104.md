# Audit R2-Bestand + Lizenz-Kette Visual-Bank (`audiomonastrysamples`)
Datum: 2026-11-04 · Nur gelesen (LIST/GET/HEAD), keine Schreiboperation. Zahlen aus dem Live-Bucket.

## Kurzfassung

| Kennzahl | Wert |
|---|---|
| Objekte im Bucket | **5.080** · **597,89 GB** |
| davon `weights/` | 1.568 Obj · **574,2 GB** (96 %) |
| davon `visuals/bank/` | 1.432 Obj (1.430 Medien + 2 Indizes) · **1,395 GB** |
| Bank-IDs auf R2 | **153** (106 `m*`, 35 `b*`, 12 `w*`) — nicht 175 |
| `bank-index.json` | 122 Einträge (106 `m`, 16 `b`) → **31 IDs fehlen** |
| `varianten-index.json` | 141 Einträge (106 `m`, 35 `b`) → 12 `w` fehlen, **438 tote Varianten-URLs** |
| Dateien ohne Index-Referenz | **163** (11,4 %): 100 `w*` + 63 `b*` |
| Phantome (Index-URL, kein Objekt) | **438** (alle `b*`) |
| Lizenz-Klassen der 106 `m*` | CC BY(+SA) **70**, PD 17, CC0 13, Sonderlizenz **6** |
| Monatskosten R2 (Storage) | **~8,82 USD** gesamt · Bank-Anteil **0,00 USD** (Free Tier 10 GB) |
| Öffentlicher Dev-URL | **aktiv** (`pub-663ece9f…r2.dev`, HTTP 200 für alle geprüften Keys, `Access-Control-Allow-Origin: *`) |

**Urteil: nicht produktionsreif.** Drei Blocker (Bucket-weite Public-Access, zwei lizenzwidrige Quellen, CC-BY-Attribution wird nicht mitgeliefert) und drei hohe Befunde (Lizenzlücke bei 47 Clips, Index/Objekt-Drift, personenbezogenes Material + interne Pfade öffentlich).

---

## BLOCKER

### B1 — Gesamter Bucket ist öffentlich lesbar (nicht nur die Visual-Bank)
`pub-…r2.dev` liefert **jeden** Key mit HTTP 200, geprüft u. a. für:
`visuals/bank/*`, `01 live @ Nature One 11 part 1.mp3`, `autosaves/rev-1-1790706959341.json`, `uploads/health-check.txt`, `gpu/bootstrap.sh`, `debug/ears2-…log`, `probe/*`, `selftest/*`.
Kein Listing (`?list-type=2` → 404), aber Keys sind erratbar (Zeitstempel-Namen bei `autosaves/`).
Betroffen: 606 Objekte/8,0 GB Musik-Master im Bucket-Root (482 WAV, 123 MP3), 75 Autosaves, 31 Uploads, 574 GB Gewichte.
**Fix:** `r2.dev` deaktivieren; Public-Access nur über Custom Domain + Cloudflare Access/WAF-Token für `/visuals/*`, alles andere privat. Getrennte Buckets: `assets-public`, `user-private`, `weights`. Vor dem Umschalten Keys prüfen, die in `autosaves/`/`debug/` liegen (Projekt-Snapshots sind fremdzugänglich).

### B2 — Sechs Clips mit Lizenzen, die eine öffentliche Bank ausschließen
| IDs | Lizenz | Problem |
|---|---|---|
| `m11a`, `m20a`, `m20b` | „Coverr License (frei nutzbar, **keine Weiterverbreitung**)" | Öffentliche Auslieferung = Weiterverbreitung; `source_url` ist nur eine Suchseite (`coverr.co/s?q=…`), Asset nicht belegbar |
| `m12a`, `m12b`, `m12e` | Unsplash License | Lizenz verbietet das Zusammenstellen zu einem konkurrierenden/kompilierenden Angebot; genau das ist eine Clip-Bank |
**Fix:** 6 Clips aus der Bank nehmen (R2 + Index + TS) oder durch CC0/PD-Motive ersetzen. Coverr/Unsplash nicht mehr als Quelle in `ALLOWED_LICENSE_HINTS` (`import_monastry.py:85`).

### B3 — CC-BY/BY-SA-Namensnennung wird bei der Auslieferung nicht erfüllt
70 Clips stehen unter CC BY bzw. BY-SA. Im Index stehen **nur Autorennamen** (67 von 70 ohne Lizenzname/Lizenzlink, ohne Titel, ohne Änderungshinweis); die App zeigt an keiner Stelle einen Bildnachweis (kein Treffer für `attribution`/`Namensnennung` in `src/`-Komponenten).
Zusätzlich: die Varianten (`_hue15`, `_mirror`, `_grau`, `_quadrat`, `_slow`, …) sind **Bearbeitungen**. CC BY verlangt einen Änderungshinweis, CC BY-SA verlangt ShareAlike für die Bearbeitung — beides fehlt; die 24 BY-SA-Clips werden ohne Lizenzangabe weiterverbreitet.
**Fix:** Pflichtfelder je Clip: `license_id` (SPDX), `license_url`, `creator`, `title`, `source_url`, `changes` („gekürzt auf 6 s, farbverschoben/gespiegelt/entsättigt, 720p"). Nachweis in der App sichtbar machen (Show-Overlay „Credits" + `/credits`-Seite) und BY-SA-Bearbeitungen unter BY-SA kennzeichnen.

---

## HOCH

### H1 — 47 Clips ohne jede Lizenzangabe im öffentlichen Index
35 `b*` und 12 `w*` haben **kein** `license`/`attribution`/`source_url`:
* `b000`–`b015`: im `bank-index.json` nur `name/datei/bytes/url/quelle` — keine Lizenzfelder.
* `b016`–`b034`: gar kein Index-Eintrag.
* `w000`–`w032` (12 Stück): weder in `bank-index.json` noch in `varianten-index.json` noch in `importedBank.generated.ts`.
`b*` stammen laut `quelle` aus `/home/patrick/lora-themen-2026-09-27/bilder-vorrat/` — **Verzeichnis existiert nicht mehr**, Herkunft nicht mehr prüfbar.
**Fix:** `b*`/`w*` offline nehmen, bis Lizenz + Attribution je Clip belegt sind; bei `b*` gilt ohne Quelle: nicht wieder öffentlich bereitstellen. Index-Schema um Pflichtfelder erweitern und Upload ohne diese Felder abbrechen (Validierung in `upload()`).

### H2 — Index und Bestand driften auseinander (153 Clips vs. 175 geplant)
| Prüfung | Ergebnis |
|---|---|
| IDs im Plan (`.visual-import/plan.json`) | 175 (106 `m`, 43 `w`, 26 `p`) |
| IDs auf R2 | 153 (106 `m`, 35 `b`, 12 `w`, **0 `p`**) |
| in `bank-index.json` fehlend | 31 (19 `b`, 12 `w`) |
| in `varianten-index.json` fehlend | 12 (`w`) |
| tote Varianten-URLs im `varianten-index.json` | **438** (`hoch45`, `slow050/075`, `fast150/200`, `hue_m15`, `hue_p30`, `kontrast`, `weich`, `rueckwaerts`, `zoompan`, `grau` je 35×, `wide`/`mirror` je 9×) — Stichprobe `b000_fast150.mp4` und `b000_grau.mp4` = **404** |
| Dateien ohne Index-Referenz | 163 (100 `w`, 63 `b` — u. a. alle 35 `*_start.jpg` der `b*`) |
| `bytes` in `bank-index.json` vs. Objektgröße | 122/122 korrekt |
| `m*`: Dateien je Clip | 106 × 10 = 1.060 → exakt wie dokumentiert, kein Fehlstand |

Ursache: Der Upload-Lauf für Eigenmaterial wurde am 04.11. um **16:00:12** nach 12 Clips abgebrochen (`upload2.log` ist 0 Byte, Indizes werden erst am Ende geschrieben → deshalb fehlen die `w*` überall). `plan.json` führt für alle 69 Eigenclips weiterhin `uploaded: {}`.
**Fix:** Upload wiederholbar machen (Index je Clip nachziehen, nicht erst am Ende; Resume-Marker in `plan.json`), dann `upload` + `ts` erneut laufen lassen. `varianten-index.json` aus dem tatsächlichen Bucket-Inhalt generieren (LIST statt Render-Annahmen) — die 12 Zusatz-Variantennamen stammen aus einem älteren Vorlagen-Schema und existieren für `b*` nie.

### H3 — Personenbezogenes Material und interne Pfade im öffentlich lesbaren Bucket
* 12 eigene Drohnenclips (`w*`, 100 Dateien) sind öffentlich. Stichproben der Startbilder (`w000`, `w005`, `w032`): keine Personen, aber **Straßenzug mit parkenden Autos** (Kennzeichen im 4K-Original potenziell lesbar) und identifizierbare Wohngebiete/Orte in Colorado.
* 26 eigene Fotos (Garten/Kirche/Blumengarten) sind gerendert, aber **nicht** hochgeladen — unkritisch, solange das so bleibt (Regel: keine Alben mit Personen als Quelle).
* `bank-index.json` ist öffentlich und enthält **absolute lokale Pfade**: `/mnt/wd-elements/Projekte/MONASTRY/Visuals/...`, `/home/patrick/lora-themen-2026-09-27/...` → Benutzername, Verzeichnisstruktur, private Dateinamen.
* Lavc-encoded, keine EXIF/GPS in den MP4/JPEG geprüft (`ffprobe` ohne `format_tags`) — positiv.
**Fix:** Eigene Aufnahmen nur in einen privaten Prefix/Bucket mit signierten URLs; `quelle`-Feld vor Veröffentlichung auf relative Quellen umstellen (oder Index privat halten). Vor jedem Upload Gesicht/Kennzeichen-Check am Kontaktabzug dokumentieren (das Skript behauptet „ohne Personen", belegt es aber nicht maschinell).

---

## MITTEL

### M1 — `b*`-Familie bricht das Formatschema
`b000`, `b010`, `b020`, `b030` sind **3,03 s** lang (nicht 6 s), 35 Clips, 271 Dateien mit 4–10 Dateien je Clip; `w*`/`m*` sind 6,0 s. Zwei Längen in einer Bank ⇒ `IMPORTED_SECONDS = 6` ist für `b*` falsch.
Zusätzlich sind `sekunden`/`laenge` im Index für `b*` unbrauchbar: `b000` = „263,1 s" / `laenge: 49`, real 3,03 s; `m*` = `laenge: 1` (immer).
**Fix:** `sekunden`/`laenge` aus `ffprobe` beim Upload schreiben; `b*` neu rendern (6 s) oder als eigene 3-s-Klasse deklarieren.

### M2 — Doku-Aussage „Bucket sendet keinen CORS-Header" ist falsch
`HEAD visuals/bank/m01a.mp4` liefert `Access-Control-Allow-Origin: *`, `Vary: Origin`, `Access-Control-Expose-Headers: Content-Length,Content-Range,ETag`.
Folge: Der Same-Origin-Proxy `/api/ai/vision/bank/:id` (`server/routes/aiRoutes.ts:169`) ist für CORS **nicht** nötig, puffert aber den kompletten Clip in den RAM (`Buffer.from(await upstream.arrayBuffer())`, bis 14,3 MB je Request) und setzt hart `Content-Type: video/mp4`.
**Fix:** Kommentare in `visualBank.ts`/`aiRoutes.ts` korrigieren; Route streamen (`Readable.fromWeb`) oder direkt auf die (Custom-Domain-)URL zeigen und die Whitelist als reine ID-Prüfung behalten.

### M3 — Lizenzstrings nicht maschinenlesbar (36 Clips)
17 verschiedene Schreibweisen für 6 Lizenzfamilien, u. a. `BY-2.0` (23×), `BY-SA-2.0` (8×), `BY-4.0` (1×), `CC0-1.0` (4×) neben `CC BY 2.0`, `CC0`, `Public domain`, `Public Domain (Internet Archive)`.
**Fix:** Normalisieren auf SPDX (`CC-BY-2.0`, `CC-BY-SA-2.0`, `CC0-1.0`, `PDM-1.0`) + `license_url`; Mapping-Tabelle beim Scan, Alt-Werte migrieren.

### M4 — Ein BY-Clip ohne Attribution
`m06e` (Cleveland Museum of Art, CC0) hat `attribution: ""`. Bei CC0 rechtlich unkritisch, aber inkonsistent zur Pflichtfeld-Logik.
**Fix:** Quelle als Attribution eintragen („Cleveland Museum of Art, 1990.144") oder Feld als optional für CC0/PD markieren.

---

## NIEDRIG

* **N1 — 8 tote Varianten:** `*_grau.mp4` und `*_hue15.mp4` sind byte-identisch (gleicher ETag) bei `m01b, m02a–m02e, m08a, m16a` — Quelle ist schon schwarzweiß, `hue=h=15` wirkt nicht. 16 Dateien, ~10 MB. Fix: `hue15` bei Graustufenquellen überspringen.
* **N2 — Themenbalance:** Kategorie 09 (Natur) hat 35 von 175 Clips (Cap 30 + 5 Sammel-Clips), Kategorie 08 28 — die eigenen Aufnahmen kippen die Show in Richtung Landschaft. Fix: Cap je Kategorie auch für `m*` anwenden.
* **N3 — Doku-Drift:** `docs/VISUAL_IMPORT.md` verspricht „5 Bilder + bis zu 2 Videos je Kategorie" (real bis 7, z. B. `m20g`) und „10 Dateien je Clip" (real 4–10 bei `b*`). Kategorie 09 fehlt in der Zählung.
* **N4 — Dev-URL hart im Code:** `pub-663ece9f…r2.dev` steht in `src/visuals/visualBank.ts:36` und `scripts/visual-import/import_monastry.py:public_url()` (nur dort mit `CFR2_PUBLIC_URL`-Fallback). Ein Domainwechsel erfordert heute Code-Änderung + Rebuild.
* **N5 — Startbilder der `b*` sind nicht indexiert:** 35 `*_start.jpg` liegen im Bucket, aber kein Index-Feld zeigt darauf (`m*` haben `start`, `b*` nicht).

---

## Budget (4)

R2 Standard: 0,015 USD/GB-Monat, 10 GB frei, Class B 0,36 USD/Mio (10 Mio frei), Egress 0.

| Posten | GB | USD/Monat |
|---|---|---|
| `weights/` | 574,2 | 8,61 |
| `samples/` | 9,5 | 0,14 (nach Free Tier) |
| Root-Musik (606 Obj) | 8,0 | im Free-Tier-Anteil |
| `lora-out/`, `music/`, Rest | ~4,8 | 0,07 |
| **`visuals/` (Bank + 27 Vorlagen)** | **1,407** | **0,00** (Free Tier) |
| **Summe Bucket** | **597,89** | **~8,82** |

Bank allein: 1.277 MP4 (Ø 1,08 MB, max 14,26 MB) + 153 JPEG (Ø 139 KB). Hochrechnung volle 175 Clips à 10 Dateien ≈ 1,6 GB → weiterhin 0 USD.
Reads: 10.000 Shows × 10 Dateien = 100.000 Class B ⇒ 0,036 USD. **Kosten sind kein Risiko; 96 % des Budgets sind Modellgewichte.** Ein Infrequent-Access-Tier für `weights/` (0,01 USD/GB) würde ~2,9 USD/Monat sparen, kostet aber Retrieval.

## Öffentlicher Dev-URL (6)

Aktiv und der einzige konfigurierte Zugang (`CFR2_PUBLIC_URL` in `.env.deploy` = `https://pub-663ece9f…r2.dev`). Laut Cloudflare-Doku ist der `r2.dev`-Endpunkt **„intended for non-production traffic"**; Caching, WAF, Rate-Limits und Access-Regeln sind dort nicht verfügbar.
**Für Produktion zwingend:** Custom Domain am Bucket, `r2.dev` abschalten, `CFR2_PUBLIC_URL` + `visualBank.ts` auf die Domain umstellen, Cache-Regeln (`immutable, max-age=31536000` für gehashte Varianten) und Bot-/Hotlink-Schutz aktivieren.

---

## Fix-Reihenfolge

1. **B1:** `r2.dev` aus, Custom Domain + Access; private Prefixes (`autosaves/`, `uploads/`, `music`-Root) in eigenen Bucket. *(Sperrt zugleich H3.)*
2. **B2/B3:** 6 Sonderlizenz-Clips entfernen; Attribution-Pflichtfelder + Credits-Anzeige; BY-SA-Kennzeichnung.
3. **H1/H2:** 47 Clips ohne Lizenz offline; Upload wiederholbar machen, `upload` + `ts` fertig laufen lassen, `varianten-index.json` aus LIST erzeugen (438 Phantome verschwinden, 163 Waisen werden indexiert).
4. **M1–M4:** `sekunden` aus ffprobe, SPDX-Mapping, CORS-Kommentar/Streaming, `m06e`.
5. **N1–N5:** Kosmetik/Doku.

## Belege (Auszug)

```
LIST visuals/bank/            → 1.432 Obj (1.277 mp4, 153 jpg, 2 json) = 1.395 MB
IDs                           → 106 m*, 35 b*, 12 w*, 0 p*
HEAD visuals/bank/m01a.mp4    → 200, ACAO *, CL 871.661
HEAD visuals/bank/b000_grau.mp4 / b000_fast150.mp4 → 404 (im varianten-index referenziert)
HEAD autosaves/rev-1-…json     → 200 (öffentlich)
ffprobe b000/b010/b020/b030   → 3,031 s | m01a/w032 → 6,0 s | 1280×720@30
plan.json: uploaded-Flags    → 106/175 true; upload2.log = 0 Byte
```
