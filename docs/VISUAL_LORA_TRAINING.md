# Stil-LoRA-Training auf einem RunPod-Pod (VISUAL-P1-007)

> Ticket: **VISUAL-P1-007** „Stil-LoRA-Training auf RunPod-Pod (Selbstlern-Loop,
> GPU-Kosten)". Dieser Text beschreibt die **vorbereitete** Pipeline: Kuration →
> Dataset → Pod-Lauf. Der Trainingslauf selbst ist ein **GPU-Job und läuft beim
> Betreiber** – dieses Repo legt keinen Pod an und gibt kein Geld aus.
>
> Stand: 2026-09-22 · Status: **Pipeline + Abschnittsbetrieb gebaut und offline
> geprüft; ein echter Trainingslauf ist NOCH NICHT gelungen.** Der erste Lauf
> (Betreiber, A40 secure 0,49 USD/h) lief 90,4 min in die harte Laufzeitgrenze
> und wurde abgebrochen: 0,74 USD bezahlt, **kein LoRA**. Ursache war eine
> Planrechnung, die nie ins Fenster passte (3700 Schritte × 2,0 s/Schritt =
> 123 min gegen 90 min) und die das Skript damals nicht geprüft hat. Beides ist
> jetzt anders: **VORAB-RECHNUNG** (§3a) und **Abschnittsbetrieb** (§3b).
> Der Ticket-Status in `MASTERTODOENDE.json` ist der SSOT und wird dort gepflegt –
> nicht aus diesem Dokument heraus.

---

## 1. Was heute wirklich da ist (gemessen, nicht behauptet)

Der Selbstlern-Loop hat zwei Hälften: die **Bewertung** (läuft) und das
**Training** (dieses Ticket).

| Baustein | Zustand | Beleg |
|---|---|---|
| Generierungen + Bewertungen entstehen in der App | **vorhanden** | `server/routes/aiRoutes.ts`: `POST /api/ai/vision` legt die Generierung an, `POST /api/ai/vision/feedback` die Bewertung (1..5, `keep`, `tags`, `comment`) |
| Speicherort der Bewertungen | **nur Supabase**, kein lokaler Spiegel | `database/ai_migration_008_visual.sql`: Tabellen `visual_generations`, `visual_feedback` (RLS, nur `service_role`) |
| Bilder | **nicht im Repo** | `visual_generations.r2_url` / `r2_key` (Cloudflare R2) oder lokale Server-Ablage `VISION_ARTIFACT_DIR` (`server/visionArtifacts.ts`, Default `$TMPDIR/audiomonastry-vision`) |
| RAG auf Bewertungen | vorhanden | `visual_style_ranking` (Migration 008) → `GET /api/ai/vision/styles` |
| **Trainings-Pipeline** | **dieses Dokument** | `scripts/visual-lora-curate.py`, `scripts/visual-lora-dataset.py`, `scripts/runpod-lora-train.py`, `scripts/lora/bootstrap.sh`, `scripts/lora/lora-progress.py` (Fortschrittsmarker), `scripts/lora/vorstaging.sh` (Volume vorstagen) |

### Befund zum Datenpfad (2026-09-20, read-only gegen die Live-DB geprüft)

```
python3 scripts/visual-lora-curate.py --diagnose
→ {"source":{"kind":"supabase","detail":"SB_URL, SB_SERVICE_ROLE"},
   "feedback_rows":0, "generation_rows":0,
   "verdict":"visual_feedback ist LEER – es gibt heute keine Bild-Bewertungen"}
```

**Beide Tabellen sind leer.** Es gibt heute also **0 verwertbare Prompt/Bild-Paare**,
und genau das ist das korrekte Ergebnis dieser Vorbereitung: Der Kurationspfad
endet mit **Exit 3 und Begründung** und schreibt eine 0-Paare-Datei als Beleg –
kein stiller Erfolg, keine Ersatzdaten.

**Betreiber-Schritt (der fehlende Datenpfad):** Bewertungen müssen erst
entstehen. Sie kommen aus der Session-Ende-Umfrage der App (VisualMONK-Overlay →
`POST /api/ai/vision/feedback`, Ticket VISUAL-P1-004). Erst wenn echte Nutzer
Bilder bewertet haben, ist ein Stil-LoRA überhaupt sinnvoll – ein LoRA braucht
typischerweise einige Dutzend bewertete Bilder desselben Stils. Bis dahin ist
jeder Trainingslauf ein Lauf auf einer leeren Datenbasis.

---

## 2. Die Pipeline in drei Schritten

```
 (1) Kuration          (2) Dataset                (3) Pod-Lauf
 curate.py     →   dataset.py   →  dataset.tar.gz  →  runpod-lora-train.py
 ─────────────────────────────   ────────────────────   ──────────────────
 Supabase/Export      Bilder+Captions+Metadaten      Kosten → Gate → Pod → terminieren
 Exit 3 = leer        Exit 3 = kein Bild             Exit 3 = keine Freigabe
```

Alle drei Skripte sind **stdlib-only**, reden nur lesend nach außen (Supabase-GET,
HTTP-GET für Bilder) und brechen bei leerer Datenlage ehrlich ab.

### Schritt 1 – Kuration

```bash
# Datenlage prüfen (read-only)
python3 scripts/visual-lora-curate.py --diagnose

# Standardlauf: liest Supabase (SB_URL + SB_SERVICE_ROLE aus .env)
python3 scripts/visual-lora-curate.py --min-rating 4 --min-votes 1 --limit 200

# ohne Supabase: Export-Datei (Formen: {"feedback":[…],"generations":[…]} oder {"pairs":[…]})
python3 scripts/visual-lora-curate.py --from-json daten/visual-export.json
```

Filter: `--min-rating` (Default 4), `--min-votes`, `--keep-only` /
`--include-unkept`, `--style NAME` (auch Komma-Liste), `--limit`.
Paare ohne Bild-Referenz (`r2_url`/`r2_key`) werden standardmäßig verworfen
(`--allow-missing-image` nur zur Diagnose).

Ausgabe: `logs/lora/<datum>/curated-pairs.json` (Schema `visual-lora-pairs/1`).
**Die Datei wird auch bei 0 Paaren geschrieben** – als Beleg, dass der Lauf
stattgefunden hat. Exit-Codes: `0` = Paare, `2` = Aufruf-/Konfigfehler,
`3` = 0 verwertbare Paare.

### Schritt 2 – Dataset bauen

Bilder müssen vorliegen: aus R2 kopieren (`--fetch`, HTTP-GET auf `r2_url`), aus
der lokalen Artefakt-Ablage (`--images-dir`, Dateiname = Generierungs-ID) oder
explizit (`--image-map`).

```bash
python3 scripts/visual-lora-dataset.py \
    --images-dir /pfad/zu/bildern \
    --name noir-v1 --trigger monkstyle --repeats 10 --tar
# oder: --fetch        (lädt fehlende Bilder per URL)
```

Ausgabe: `logs/lora-dataset-<name>-<zeitstempel>/`

| Datei | Inhalt |
|---|---|
| `images/<nr>_<id8>.<ext>` | Bild, **1:1 kopiert** (kein Re-Encoding, keine Skalierung) |
| `images/<nr>_<id8>.txt` | Caption: `monkstyle, <Prompt>, <Tags>` (deterministisch, kein LLM) |
| `metadata.jsonl` | eine Zeile je Bild: `file_name`, `text` + Herkunft (Rating, Stil, Seed, `generation_id`) |
| `dataset_config.toml` | Vorlage im kohya-ss/sd-scripts-Format (`--dataset_config`); `image_dir` ist der Pfad **im Pod** |
| `dataset.json` | Manifest: Zählungen, Filter, **sha256 je Datei**, Verwurfsgründe |
| `README.md` | Formaterklärung für den Trainer-Lauf |
| `dataset.tar.gz` | nur mit `--tar`; deterministisch (mtime/uid/gid normalisiert) |

Exit-Codes: `0` = Bilder geschrieben, `2` = Aufruf-/Konfigfehler,
`3` = **0 Bilder** (Gründe: `ohne_bilddatei`, `leere_bilddatei`,
`download_fehlgeschlagen`).

### Schritt 3 – Pod-Lauf (in Abschnitten, s. §3b/§3c)

```bash
# 0) einmalig: Konfiguration + Volume-Kosten ansehen (kein API-Aufruf)
python3 scripts/runpod-lora-train.py --print-config --steps 2000 --segment-steps 1000 \
    --price-per-hour <satz> --volume-id <vol-id> --volume-size-gb 100

# 1) rechnen (kein API-Aufruf, keine Kosten) – die VORAB-RECHNUNG bricht laut ab,
#    wenn der Abschnitt nicht ins Laufzeitfenster passt
python3 scripts/runpod-lora-train.py --plan --steps 2000 --segment-steps 1000 --price-per-hour <satz>

# 2) Abschnitt starten – NUR mit Freigabe (sonst Exit 3, kein einziger HTTP-Request)
LORA_APPROVE_SPEND=1 KOSTENBESTAETIGUNG=<obergrenze je Abschnitt> \
python3 scripts/runpod-lora-train.py --train --steps 2000 --segment-steps 1000 --segment 1 \
    --price-per-hour <satz> \
    --template-id runpod-torch-v280 \
    --docker-args 'bash -c "bash /workspace/lora/bootstrap.sh"' \
    --train-command 'python3 /workspace/ai-toolkit/run.py …' \
    --volume-id <vol-id> --volume-size-gb 100 --dataset-url <https-url-des-tar.gz> \
    --checkpoint-dir /workspace/lora/ckpt --checkpoint-upload-url <presigned-put> \
    --progress-read-url <presigned-get> --progress-upload-url <presigned-put> \
    --result-url <presigned-put-url>

# 3) nächster Abschnitt: dieselben Argumente + --segment auto (setzt aus dem Checkpoint fort)

# 4) Not-Aus / Aufräumen (jederzeit, ohne Freigabe – beendet Kosten)
python3 scripts/runpod-lora-train.py --terminate <pod-id>
```

---

## 3. Kostenrechnung

**Formel (keine erfundenen Zahlen; der Stundensatz ist eine Betreiber-Eingabe):**

```
Kosten          = Stundensatz × Zeit[h]
Zeit_Plan       = Kaltstart + Training + Aufräumen
Zeit_Obergrenze = Kaltstart + LORA_MAX_RUNTIME_MINUTES + Aufräumen
Schritte        = ceil(Bilder × num_repeats × Epochen / batch_size)   (oder --steps, Default 2000)
Trainingszeit   = Schritte × Sekunden_je_Schritt
Abschnitt       = ceil(Gesamtschritte / --segment-steps) Teil-Läufe zu je --segment-steps Schritten
Kosten_Abschnitt= Stundensatz × (Kaltstart + Abschnittszeit + Aufräumen)
Kosten_Volume   = Größe_GB × 0,05 USD/GB/Monat   (läuft monatlich, auch ohne Pod)
```

| Größe | Wert | Herkunft |
|---|---|---|
| Stundensatz | **Pflicht: `--price-per-hour` / `LORA_GPU_PRICE_PER_H`** | Ablesen per `runpodctl gpu list` (`securePricePerHr` / `communityPricePerHr`) oder RunPod-Preisseite. Das Skript erfindet **keinen** Preis und liest ihn auch nicht selbst (ein Preis-Lookup wäre schon ein API-Aufruf vor dem Gate) |
| Kaltstart | 20 min (Default `LORA_STARTUP_MINUTES`) | gemessen 2026-09-11: Kaltstart/Bild-Pull eines Bild-Workers 15–25 min, `docs/VISUALMONK_SPEC.md` §4. **Ohne Network Volume kommen ~24 GB Gewichte-Download dazu** (Betreiber-Messung 2026-09-22: ~30 min je Abschnitt) |
| Sekunden/Schritt | 2,0 s (**Annahme**, Default `LORA_SECONDS_PER_STEP`) | **kein Messwert** – streut stark nach Modell/Auflösung/Karte. Nach dem ersten Lauf durch den gemessenen Wert ersetzen |
| Aufräumen/Upload | 5 min (Default `LORA_TEARDOWN_MINUTES`) | Planungsannahme |
| Harte Laufzeitgrenze | 90 min (Default `LORA_MAX_RUNTIME_MINUTES`) | Betriebsentscheidung: danach wird der Pod zwangsweise terminiert |
| Schritte je Abschnitt | 1000 (`--segment-steps`) | Betriebsentscheidung 2026-09-22 („1000, dann wieder 1000, dann wieder 1000 …") |
| Gesamtschritte | 2000 (`--steps`, Default) | Betriebsentscheidung 2026-09-22; `--images` rechnet sie wie bisher aus |
| Volume | 0,05 USD/GB/Monat (`--volume-price-per-gb-month`) | Betreiber-Angabe 2026-09-22 (RunPod Network Volume); Größe per `--volume-size-gb` |
| USD→EUR | 0,92 (`LORA_USD_EUR`) | der Satz des Repos aus `docs/AI_COST_GUIDE.md` ($2.50/h ≈ 2,30 €/h). Nur Anzeige; gerechnet wird in der Planwährung (Default USD) |

**Rechenbeispiel** (60 Bilder × repeats 10 × Epochen 10 = 6000 Schritte; Kaltstart
20 min, Training 6000 × 2 s = 200 min → aber die Laufzeitgrenze greift):

| Posten | mit 0,69 $/h | mit 1,10 $/h |
|---|---|---|
| Plan (20 + 200 + 5 min = 3,75 h) | 2,59 $ (2,38 €) | 4,13 $ (3,79 €) |
| **Harte Obergrenze** (20 + 90 + 5 min = 1,92 h) | **1,32 $ (1,22 €)** | **2,11 $ (1,94 €)** |

Beide Sätze sind **Rechenbeispiele** (der zweite für eine teurere Karte), keine
Preisaussage des Repos: Pod-Preise sind tagesaktuell, cloud-abhängig
(`SECURE`/`COMMUNITY`) und werden **vom Betreiber** aus `runpodctl gpu list`
eingetragen. Die Tabelle zeigt nur, wie sich der Satz linear durchrechnet.
Zwei Konsequenzen aus dem Beispiel:

1. **Ein Plan über 200 min Training passt nicht in eine 90-min-Laufzeitgrenze.**
   Entweder `--max-runtime-minutes` bewusst erhöhen (dann steigt die Obergrenze
   linear) oder die Schrittzahl senken (weniger Bilder/Epochen, größerer
   `--batch-size`).
2. Die **harte Obergrenze ist der Betrag, der bestätigt werden muss** – sie ist
   der Maximalwert, weil der Pod spätestens dann terminiert wird. Der
   „Plan"-Wert ist nur eine Erwartung.

**Kostenschutz im Skript:**

- **VORAB-RECHNUNG** vor dem Gate (§3a): passt die geplante Arbeit des Abschnitts
  nicht ins Laufzeitfenster, endet der Lauf mit Exit 2 – ohne Pod, ohne
  HTTP-Request, ohne SDK-Import. Genau dieser Fall hat 0,74 USD verbrannt.
- **Abschnittsbetrieb mit Checkpoints** (§3b): 1000er-Abschnitte, Resume aus dem
  Checkpoint, Fortschrittsmarker nach R2. Ein abgebrochener Abschnitt ist nur
  bezahlte Wartezeit **bis zum letzten Checkpoint**, nicht der ganze Lauf.
- **„NICHTS ZU TUN" ohne Kosten:** meldet der Fortschrittsmarker den Zielschritt,
  beendet der Starter mit Exit 0 – ohne Freigabe und ohne Pod.
- Gate **vor** jedem API-Aufruf: ohne `LORA_APPROVE_SPEND=1` **und**
  `KOSTENBESTAETIGUNG >= Obergrenze` → Exit 3, und das `runpod`-SDK wird nicht
  einmal importiert (Test: `tests/test_visual_lora_pipeline.py::GateTest`).
- **Kein Bearer-Token in der Ausgabe:** presigned URLs (Fortschritt, Checkpoint,
  Ergebnis) und Zugangsdaten erscheinen in `--plan`/`--print-config` nur als
  „gesetzt/nicht gesetzt".
- Harte Laufzeitgrenze (`--max-runtime-minutes`): danach Terminierung, Exit 4.
- `finally`-Terminierung: auch bei Abbruch/Fehler wird der Pod terminiert und die
  Terminierung nachgeprüft; die Pod-ID steht sofort nach dem Anlegen im Report
  (`logs/lora-runs/<zeit>-<name>.json`, per `--report-dir` / `LORA_REPORT_DIR`
  umlenkbar).
- Doppelname-Schutz: existiert schon ein Pod mit demselben Namen, bricht das
  Skript **vor** dem Anlegen ab (Exit 2) – verhindert bezahlte Waisen.
- `--terminate <pod-id>`: Not-Aus, bewusst **ohne** Kostenfreigabe.
- Auf dem Volume statt in der Container-Disk arbeiten (`--volume-id`): die
  Container-Disk ist nach dem Terminieren weg, das Volume behält das Ergebnis.

**Wichtig:** Ein Pod rechnet **pro Sekunde**, solange er läuft – auch wenn das
Training längst fertig ist. Deshalb ist die Terminierung kein „Aufräumen", sondern
der eigentliche Kostenstopp. Notfalls `runpodctl pod list` und
`runpodctl pod remove <id>`.

---

## 3a. VORAB-RECHNUNG (Abbruch VOR dem Gate)

Der erste Lauf hat 0,74 USD gekostet und **kein LoRA** geliefert, weil die
Planrechnung nie ins Laufzeitfenster passte und das Skript das nicht geprüft hat.
Diese Rechnung ist jetzt Pflicht und steht **vor** dem Gate:

```
Kaltstart + Abschnittsschritte × s/Schritt  >  Laufzeitgrenze      → ABBRUCH (Exit 2)
```

```
$ python3 scripts/runpod-lora-train.py --plan --steps 3700 --segment-steps 3700 \
      --seconds-per-step 2.0 --startup-minutes 20 --max-runtime-minutes 90 --price-per-hour 0.49
[lora] VORAB-RECHNUNG: PASST NICHT ins Laufzeitfenster
[lora]   Kaltstart 20.00 min + Training 3700 Schritte x 2.00 s/Schritt (ANNAHME, kein Messwert) = 123.33 min = 143.33 min
[lora]   Laufzeitgrenze (--max-runtime-minutes): 90.00 min
[lora]   UEBERSCHREITUNG: 53.33 min (0.89 h) …
ABBRUCH (VORAB-RECHNUNG) – es wurde KEIN POD angelegt und KEINE Kosten freigegeben:
…
  Der Abschnitt braucht 143.33 min, das Fenster ist 90.00 min. In dieses Fenster passen
  bei 2.00 s/Schritt (ANNAHME) hoechstens ~2100 Schritte je Abschnitt (--segment-steps 2100);
  die Gesamtschritte bleiben unveraendert.
→ Exit 2, kein HTTP-Request, das runpod-SDK wird nicht importiert
```

Drei Auswege nennt die Meldung selbst: Abschnitt verkleinern, Laufzeitgrenze
bewusst erhöhen (die Obergrenze steigt mit) oder einen **Messwert** statt der
2,0-s-Annahme einsetzen. `--allow-overrun` übergeht die Prüfung bewusst – nur für
Tests/absichtliche Hängerläufe, nie für einen echten Trainingslauf; das Gate gilt
trotzdem weiter.

---

## 3b. Abschnittsbetrieb: 1000 Schritte, Checkpoint, Resume, Fortschritt

**Entscheidung des Betreibers (2026-09-22):** nicht ein langer Lauf, sondern
Abschnitte – „1000, dann wieder 1000, dann wieder 1000 …". Ein Abschnitt ist ein
eigener Pod-Lauf, der gesichert wird, bevor er endet.

```
  --steps 2000 --segment-steps 1000            → 2 Abschnitte
  Abschnitt 1: Schritte 0–1000     Abschnitt 2: Schritte 1000–2000
   └─ Pod ─▶ Checkpoint → R2 ─▶ Fortschrittsmarker → R2 ─▶ Pod terminieren (Kostenstopp)
                                        │
                          nächster Lauf: --segment auto liest den Marker und
                          setzt aus dem Checkpoint fort (Schritt 1000)
```

**Starten und fortsetzen** (`--segment auto` ist der Normalfall; `--segment N`
erzwingt eine Nummer, `--segment 1` ist der Erstlauf):

```bash
# Abschnitt 1 (Erstlauf)
LORA_APPROVE_SPEND=1 KOSTENBESTAETIGUNG=0.9392 \
python3 scripts/runpod-lora-train.py --train --steps 2000 --segment-steps 1000 \
    --segment 1 --price-per-hour 0.49 \
    --checkpoint-dir /workspace/lora/ckpt --checkpoint-upload-url "$CKPT_PUT" \
    --progress-read-url "$PROGRESS_GET" --progress-upload-url "$PROGRESS_PUT" \
    --volume-id <vol-id> --volume-size-gb 100 …

# Abschnitt 2 (dieselben Argumente, nur --segment auto): setzt aus dem Checkpoint fort
LORA_APPROVE_SPEND=1 KOSTENBESTAETIGUNG=0.9392 \
python3 scripts/runpod-lora-train.py --train --steps 2000 --segment-steps 1000 --segment auto …
```

Wichtige Eigenschaften:

* **Vor jedem Lauf liest der Starter den Fortschrittsmarker** (`--progress-read-url`,
  eine presigned GET-URL). Er bestimmt daraus, ab welchem Schritt dieser Abschnitt
  arbeitet – nach einem Abbruch bei Schritt 250 geht es ab 250 weiter, nicht bei 0.
  Ist der Lauf komplett (Marker = Zielschritt), endet er mit **„NICHTS ZU TUN"**,
  Exit 0 – ohne Freigabe, ohne Pod, ohne Kosten.
* **Checkpoints alle `--checkpoint-every` Schritte** (Default 250) in
  `--checkpoint-dir` – das Verzeichnis muss **außerhalb** von `--output-dir-in-pod`
  liegen, sonst hielte die Ergebnisprüfung einen Zwischenstand für das LoRA (das
  Skript weist das als Konfigurationsfehler ab).
* **Fortschrittsmarker** (Schema `visual-lora-progress/1`, JSONL, der Starter liest
  die letzte Zeile): `step`, `loss`, `ts`, `state`, `checkpoint_url`. Der Pod
  schreibt sie über `scripts/lora/lora-progress.py`; der Trainer kann sie nach jedem
  Checkpoint selbst aufrufen (`. $LORA_PROGRESS_FILE`/`LORA_PROGRESS_URL` stehen ihm
  als Env zur Verfügung). Der Starter zeigt sie im Sekundentakt an – **statt nur den
  Pod-Zustand zu pollen**:

  ```
  [lora] Fortschritt: Schritt 750/2000 (37.5%) | Abschnitt 1/2: Schritte 0-1000 | Loss 0.0812
         | Zustand RUNNING | Marker 2026-09-22T10:12:03Z (vor 0.42 min)
  [lora]   WARNUNG: seit 21.50 min kein neuer Marker (Grenze 15 min) – Trainer haengt,
           meldet nichts oder schreibt nicht nach R2. …
  ```
* **Der Pod beendet sich erst, wenn der Checkpoint gesichert ist.** `bootstrap.sh`
  lädt zuerst den Checkpoint nach R2 und schreibt **dann** `state=SEGMENT_DONE`;
  erst dieser Zustand lässt den Starter terminieren (Kostenstopp). Sonst würde ein
  Pod-Abbruch den Abschnitt vernichten.
* **Zwischenabschnitte liefern Checkpoints, kein LoRA.** Im letzten Abschnitt gilt
  wieder die LoRA-Ergebnisprüfung (`--result-url`); in Zwischenabschnitten wäre ein
  Upload des unfertigen LoRA schädlich, deshalb wird er dort nicht verlangt.
* **Ohne `--progress-read-url`** verhält sich alles wie vorher (Pod-Zustand-Polling,
  Laufzeitgrenze als Rückfall). Der Abschnittsbetrieb ist dann blind – nicht zu
  empfehlen.

### Kosten des Abschnittsbetriebs

Bezahlt wird **je Abschnitt** (jeder Lauf braucht eine eigene Freigabe); der Plan
zeigt die Summe der Obergrenzen ausdrücklich mit an:

```
[lora]   Gesamtlauf          : 2000 Schritte x 2.00 s/Schritt = 66.67 min -> 2 Abschnitte zu je max. 90 min
[lora]   -> Obergrenze ALLER 2 Abschnitte zusammen: 1.88 USD (Kaltstart und Aufräumen fallen je Abschnitt an)
```

Der Kaltstart fällt **pro Abschnitt** an – genau deshalb das Network Volume (§3c).

---

## 3c. VORSTAGING auf einem Network Volume (einmal füllen, dann sparen)

**Warum:** Die Zeit geht nicht für die Fotos drauf (Dataset 54 MB aus R2 ≈
Sekunden), sondern für Container-Image-Pull (15–25 min, gemessen) und den Download
der Basisgewichte (~24 GB). Im Abschnittsbetrieb würde das bei **jedem** Start
erneut bezahlt. Ein Network Volume (0,05 USD/GB/Monat, an **ein** Rechenzentrum
gebunden) hält Gewichte, Datensatz und Trainer-Checkout dauerhaft: der Start eines
Abschnitts sinkt von ~30 min auf wenige Minuten (Betreiber-Messung 2026-09-22).

**Schritt 1 – Volumen anlegen (Betreiber, DC = DC des Pods):**

```bash
runpodctl network-volume create --name audiomonastry-lora --size 100 --data-center-id <DC>
```

**Schritt 2 – einmalig füllen, auf einem CPU-Pod** (NICHT auf einer GPU – das
Herunterladen braucht keine GPU, GPU-Zeit dafür wäre Geldverbrennung). Der Pod
startet der **Betreiber**; dieses Repo legt keinen Pod an. Im Container:

```bash
# Gewichte per hf_transfer (~24 GB), Datensatz, Trainer-Checkout – idempotent
HF_TOKEN=<token> bash /workspace/lora/vorstaging.sh \
    --volume /workspace \
    --model black-forest-labs/FLUX.1-dev \
    --dataset-url "$LORA_DATASET_URL" --dataset-key lora/dataset.tar.gz \
    --ai-toolkit-repo https://github.com/ostris/ai-toolkit
```

* **Nachweis der Übersprünge:** jeder Schritt prüft zuerst, ob sein Ergebnis schon
  (vollständig) auf dem Volumen liegt, und schreibt das als Zeile:
  `[vorstaging] uebersprungen: Gewichte (24.1 GB im Volume, Marker von …)`. Marker
  und Bericht liegen unter `<volume>/vorstaging/*.json` (`report.json`), `--json`
  gibt den Bericht maschinenlesbar aus, `--dry-run` sagt ohne Netz, was getan würde.
* **Vollständigkeit statt Hoffnung:** die Gewichte gelten nur dann als vorhanden,
  wenn Marker **und** Verzeichnis existieren und die Größe ≥ 90 % des beim Download
  gemessenen Werts ist. Ein abgebrochener Download wird also erneut geladen.
* **Der Datensatz wird über `--dataset-key` wiedererkannt**, nicht über die URL: die
  Dataset-URL ist eine presigned URL (Bearer-Token) und wird bewusst **nicht** in
  Marker oder Report geschrieben. Gleiches gilt für Tokens.
* **Aufräumen:** `--min-free-gb` (Default 40) bricht vorher ab, wenn das Volumen zu
  klein ist. Nach dem Training: `runpodctl network-volume delete <id>` – sonst
  laufen die Monatskosten weiter (siehe §3d).

**Schritt 3 – im Abschnittsbetrieb nutzen:** `--volume-id <vol-id> --volume-mount
/workspace --volume-size-gb 100 --base-model black-forest-labs/FLUX.1-dev`.
`bootstrap.sh` meldet dann im STATUS, ob die Gewichte vorgestaged waren:

```
{"step":"WEIGHTS","message":"uebersprungen: Gewichte (black-forest-labs/FLUX.1-dev liegt schon in /workspace/hf-cache – kein ~24-GB-Download im GPU-Pod)"}
{"step":"DATASET","message":"uebersprungen: Datensatz (2 Bilder liegen schon in /workspace/lora-dataset, Volume) – kein Download von …"}
```

Fehlen sie, steht dort eine `WARNUNG` – der GPU-Pod lädt dann selbst (bezahlte
Wartezeit), das Vorstaging wurde übersprungen.

---

## 3d. Konfiguration und Volumenkosten anzeigen (`--print-config`)

```bash
python3 scripts/runpod-lora-train.py --print-config --steps 2000 --price-per-hour 0.49 \
    --volume-id <vol-id> --volume-size-gb 100
```

```
[lora] Volume              : 100 GB x 0.05 USD/GB/Monat = 5.00 USD/Monat (~4.60 EUR/Monat)
                             – laeuft monatlich weiter, solange das Volume existiert (auch ohne Pod!)
[lora]   Vorgestagte Daten : Gewichte (HF_HOME=/workspace/hf-cache), Datensatz (/workspace/lora-dataset), …
[lora]   Loeschen NACH dem Training (sonst laufen die Monatskosten weiter): runpodctl network-volume delete <vol-id>
```

Ohne Volumen beziffert derselbe Block die Mehrkosten des Abschnittsbetriebs
(`N Abschnitte x ~0.50 h Kaltstart = … USD NUR Kaltstart`) und nennt den
Vorstaging-Befehl. **Keine Geheimnisse:** RunPod-Key, `HF_TOKEN`, presigned URLs
(Fortschritt, Checkpoint, Ergebnis) und Dataset-URL erscheinen nur als
„gesetzt/nicht gesetzt" – eine presigned URL ist ein Bearer-Token und gehört
nicht in Logs (dieselbe Regel wie in `scripts/hetzner/lib/r2-sigv4.sh`).

---

## 4. Betreiber-Schritte (exakt, in dieser Reihenfolge)

**A. Einmalig vorbereiten**

1. **Datenlage prüfen:** `python3 scripts/visual-lora-curate.py --diagnose`.
   Erwartung heute: `verdict: visual_feedback ist LEER`. Ohne Bewertungen ist
   Schritt C sinnlos – dann zuerst Schritt B.
2. **Trainer-Entscheidung treffen** (diese zwei Angaben sind Pflicht, es gibt
   bewusst keinen Default, weil das Skript keine Images/Kommandos erfindet):
   - **Image/Template:** `--template-id <id>` (z. B. das offizielle
     PyTorch-Template `runpod-torch-v280`, im Runpod-Skill live verifiziert) oder
     `--image <image>`. Gewähltes Image muss CUDA + PyTorch mitbringen und – für
     gated Gewichte wie `black-forest-labs/FLUX.1-dev` – `HF_TOKEN` im Env haben.
   - **Trainer-Kommando:** `--train-command '<befehl>'`, der im Pod läuft, z. B.
     kohya-ss/sd-scripts (`flux_train_network.py --dataset_config …`) oder
     ai-toolkit. **Syntax gegen die im Image installierte Trainer-Version
     prüfen** – dieses Repo hat sie nicht laufen lassen und behauptet es nicht.
3. **Stundensatz ablesen:** `runpodctl gpu list` → `securePricePerHr` bzw.
   `communityPricePerHr` (der Satz muss zur `--cloud-type`-Wahl passen) und
   **denselben Betrag** als `--price-per-hour` einsetzen.
4. **Netz-Volume anlegen** (im Abschnittsbetrieb **Pflicht**, s. §3c):
   `runpodctl network-volume create --name audiomonastry-lora --size <GB>
   --data-center-id <DC>`. Volume und Pod müssen im **selben Data Center** liegen,
   sonst scheitert das Scheduling. Größe gleich als `--volume-size-gb` notieren
   (für den Monatskosten-Hinweis).
5. **Volume einmalig vorstagen** (§3c) – auf einem **CPU-Pod**, nicht auf der GPU:
   `bash scripts/lora/vorstaging.sh --volume /workspace --model
   black-forest-labs/FLUX.1-dev --dataset-url <url> --dataset-key <stabile Kennung>`.
   Danach `--dry-run` gegenlaufen lassen: dreimal `uebersprungen` = fertig.
6. **Datensatz + Runner ins Volume:** `dataset.tar.gz` aus Schritt 2 der Pipeline
   bereitstellen (`--dataset-url`; der Pod lädt selbst, wenn sie noch nicht im
   Volume liegt) und `scripts/lora/bootstrap.sh`, `scripts/lora/lora-progress.py`
   ins Volume kopieren (erwartete Pfade: `/workspace/lora/bootstrap.sh`,
   `/workspace/lora/lora-progress.py`). Der Trainer-Checkout liegt aus dem
   Vorstaging unter `/workspace/ai-toolkit`.

**B. Daten entstehen lassen (der eigentliche Blocker)**

7. App starten, Visuals generieren, Session beenden und bewerten (Umfrage).
   Danach `--diagnose` erneut: `feedback_rows > 0` mit Bewertungen ≥ 4.
8. Kuration + Dataset bauen (Schritte 1 und 2 oben). Bei `Exit 3` **nicht
   weitermachen** – erst die Datenlage klären.

**C. Trainingslauf in Abschnitten (der einzige bezahlte Teil)**

9. **Konfiguration ansehen:** `python3 scripts/runpod-lora-train.py --print-config
   --steps 2000 --segment-steps 1000 --price-per-hour <satz> --volume-id <vol-id>
   --volume-size-gb <GB>` → zeigt Abschnitt, Volume-Monatskosten und Löschbefehl.
10. **Rechnen:** `--plan` mit denselben Argumenten. Der Plan nennt die **harte
   Obergrenze je Abschnitt**, die VORAB-RECHNUNG bricht laut ab, wenn der
   Abschnitt nicht ins Fenster passt, und der Block „Gesamtlauf" nennt die Summe
   aller Abschnitte.
11. **Freigeben und Abschnitt 1 starten** (Wert aus dem Plan, 4 Dezimalstellen):
    ```
    LORA_APPROVE_SPEND=1 KOSTENBESTAETIGUNG=0.9392 \
    python3 scripts/runpod-lora-train.py --train --steps 2000 --segment-steps 1000 \
        --segment 1 --price-per-hour <satz> \
        --template-id runpod-torch-v280 --train-command '<trainer-befehl>' \
        --docker-args 'bash -c "bash /workspace/lora/bootstrap.sh"' \
        --volume-id <vol-id> --dataset-url <url> \
        --checkpoint-dir /workspace/lora/ckpt \
        --checkpoint-upload-url <presigned-put-checkpoint> \
        --progress-read-url <presigned-get-marker> --progress-upload-url <presigned-put-marker> \
        --result-url <presigned-put-lora>
    ```
    Erwartete Ausgaben: `[lora] Freigabe erteilt …` → `Abschnitt 1/N: Schritte 0-1000`
    → `Pod angelegt: <id>` → Fortschrittszeilen (`Fortschritt: Schritt … | Loss …`)
    → `ABSCHNITT FERTIG` / `Abschnittsziel erreicht` → `Aufraeumen ok: terminiert`.
12. **Nächsten Abschnitt starten:** dieselben Argumente, nur `--segment auto`
    (statt `--segment 1`) und neue presigned URLs für Checkpoint/Marker. `--segment
    auto` liest den Fortschrittsmarker und setzt ab dem letzten Checkpoint fort.
    Meldet der Starter `NICHTS ZU TUN`, sind alle Schritte erreicht.
13. **Nach jedem Abschnitt prüfen:** Report unter `logs/lora-runs/<zeit>-<name>.json`
    (`segment`, `resume`, `progress.last_marker` mit Schritt/Loss, `pod.terminated:
    true`), im Volume die `STATUS`-JSONL, `progress.jsonl` und `train.log`.
14. **Nach dem letzten Abschnitt aufräumen:** `runpodctl pod list` (kein Pod mehr);
    `runpodctl user`; das **Volume löschen**, wenn keine weiteren Abschnitte
    geplant sind → `runpodctl network-volume delete <id>` (sonst laufen die
    Monatskosten weiter, s. §3d).

**Abbruchkriterien** (dann sofort `--terminate`):

- Der Pod bleibt auf `RUNNING`, der Fortschrittsmarker steht aber still
  (Warnung „seit X min kein neuer Marker") → erst Log im Pod prüfen, dann
  terminieren.
- Der Trainingsverlust/Log zeigt einen Abbruch vor `DONE` in `STATUS`.
- Zweifel am Datenpfad: **erst** Datenlage klären, dann bezahlen.

---

## 5. Ehrliche Grenzen (was hier NICHT belegt ist)

- **Der echte Trainingslauf ist weiterhin nicht belegt.** Der erste Lauf brach an
  der Laufzeitgrenze ab (90,4 min, 0,74 USD, kein LoRA). Abschnittsbetrieb,
  Vorab-Rechnung, Checkpoints, Resume, Fortschrittsmarker und Vorstaging sind
  **offline** geprüft (Fake-SDK, Stub-Trainer, Stub-Downloader, Loopback-HTTP) –
  aber **nie mit einem echten GPU-Pod und nie mit einem echten Diffusion-Trainer**.
  Es gibt weiterhin keinen Messwert für Trainingsdauer, Loss-Verlauf,
  LoRA-Qualität oder VRAM-Eignung des gewählten Images.
- **Die 2,0 s/Schritt sind eine Annahme.** Sie stehen deshalb als „ANNAHME" im
  Kostenblock und in der Abbruchmeldung. Nach dem ersten gemessenen Abschnitt
  ersetzen (`--seconds-per-step`) – erst dann rechnet der Plan mit der Wahrheit.
- **Der Trainer-Befehl im Pod ist ungeprüft.** `scripts/lora/bootstrap.sh` ist
  offline mit Stub-Trainern getestet (Resume-Pflicht, Checkpoint-Prüfung,
  Fortschrittsmarker, Exit-Codes), aber nie mit einem echten Diffusion-Trainer.
  `bootstrap.sh` **erfindet keine Trainer-Syntax**: es übergibt die Angaben des
  Abschnitts als Env (`LORA_RESUME_FROM`, `LORA_MAX_STEPS`,
  `LORA_SAVE_EVERY_STEPS`, `LORA_CHECKPOINT_DIR`, `LORA_SEGMENT_*`,
  `LORA_PROGRESS_FILE`, `LORA_PROGRESS_URL`) und der Betreiber entscheidet, wie
  der Trainer sie in seine Syntax übersetzt.
- **Der HF-Download im Vorstaging ist ungeprüft.** `vorstaging.sh` ist offline mit
  Stub-Downloader, lokalem Git-Repo und lokalem Archiv getestet; der echte
  `huggingface-cli download` mit `hf_transfer` und gated Gewichten
  (`HF_TOKEN`) wurde nicht ausgeführt. Marker/Größenprüfung sind eine
  Vollständigkeits-Heuristik (≥ 90 % der gemessenen Größe), kein Bit-Beweis.
- **Der Datenpfad ist leer** (live geprüft, s. o.). Ohne echte Bewertungen ist
  jeder Lauf ein Lauf ohne Daten – die Pipeline bricht dann mit Exit 3 ab.
- **Rechte/Lizenz:** Stil-LoRAs aus Nutzerbildern und ggf. gated Basisgewichte
  (`FLUX.1-dev`, `FLUX.2 [dev]`) sind ein eigenes Thema; das Skript prüft keine
  Lizenzen (`docs/VISUALMONK_SPEC.md` §9 nennt es als offenen Punkt).
- **Volume-Löschung ist bewusst manuell.** Das Skript löscht keine Volumes (dort
  liegen Gewichte, Datensatz, Checkpoints und das Ergebnis) – es nennt nur den
  Befehl und beziffert die Monatskosten.

---

## 6. Tests und Belege

```bash
python3 tests/test_visual_lora_pipeline.py        # 28 Tests: Pipeline + Gate (kein Netz/GPU/Kosten)
python3 tests/test_lora_segments.py               # 53 Tests: Abschnitte, Resume, Marker, Vorab-Abbruch, Volume
python3 tests/test_lora_segments.py -v            # mit Testnamen
```

`tests/test_lora_segments.py` deckt den Abschnittsbetrieb ab – ohne Netz, GPU,
Pod und Kosten:

* **Abschnittsplanung:** 1000er-Raster, angebrochener letzter Abschnitt,
  `finished` (nichts zu tun), Fortsetzen aus dem Marker (250 → 1000), Rangfolge
  `--segment N` vor Marker vor „auto".
* **VORAB-RECHNUNG:** der verbrannte Fall (3700 × 2,0 s + 20 min Kaltstart gegen
  90 min) → Exit 2, `ABBRUCH (VORAB-RECHNUNG)`, **das Fake-SDK wird nicht einmal
  importiert**; die Aufteilung in 4 Abschnitte läuft stattdessen durch;
  `--allow-overrun` überspringt nur die Rechnung, nicht das Gate.
* **Fortschrittsmarker:** Roundtrip, letzte gültige Zeile, Alter/Warnung,
  `SEGMENT_DONE`-Erkennung (Schritt ≥ Ziel allein genügt **nicht**), Anzeige im
  Starter (`Fortschritt: Schritt 1000/1000 … | Loss …`), Pod-Terminierung durch
  den Marker (create → terminate), „NICHTS ZU TUN" ohne SDK-Kontakt.
* **Volume:** Monatskosten-Rechnung, `--print-config` zeigt Größe, USD/Monat und
  `runpodctl network-volume delete`; **kein Bearer-Token** (presigned URL) im
  Output.
* **Vorstaging:** Trockenlauf ohne Netz, echter Offline-Lauf (Stub-Downloader,
  lokales Git-Repo, lokales Archiv), zweiter Lauf überspringt alles
  („uebersprungen: …"), unvollständige Gewichte werden erneut geladen, anderer
  `--dataset-key` wird nicht übersprungen, URL landet nicht im Marker.
* **In-Pod-Runner:** Datensatz-Skip mit Nachweis (die URL zeigt auf einen
  geschlossenen Port – ein Download würde scheitern), Resume-Pflicht (Folgeabschnitt
  ohne Checkpoint → Exit 2 ohne Training), Checkpoint fehlt → Exit 5,
  Zwischenabschnitt ohne LoRA ist kein Fehler, und über einen **Loopback-HTTP-Server**
  ist die Reihenfolge „Checkpoint-Upload → `SEGMENT_DONE`-Marker" belegt.

Die Tests benutzen ein **gefälschtes `runpod`-SDK**, das jeden Kontakt in eine
Logdatei schreibt. Genau dieses Log ist der Beleg für „kein API-Aufruf vor der
Freigabe" (und für „kein API-Aufruf bei fehlgeschlagener VORAB-RECHNUNG"): nach
einem abgelehnten Lauf ist es leer.
