# Stil-LoRA-Training auf einem RunPod-Pod (VISUAL-P1-007)

> Ticket: **VISUAL-P1-007** „Stil-LoRA-Training auf RunPod-Pod (Selbstlern-Loop,
> GPU-Kosten)". Dieser Text beschreibt die **vorbereitete** Pipeline: Kuration →
> Dataset → Pod-Lauf. Der Trainingslauf selbst ist ein **GPU-Job und läuft beim
> Betreiber** – dieses Repo legt keinen Pod an und gibt kein Geld aus.
>
> Stand: 2026-09-20 · Status: **vorbereitet, nicht gelaufen** (kein Pod, keine
> GPU-Kosten, kein Training). Der Ticket-Status in `MASTERTODOENDE.json` ist der
> SSOT und wird dort gepflegt – nicht aus diesem Dokument heraus.

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
| **Trainings-Pipeline** | **dieses Dokument** | `scripts/visual-lora-curate.py`, `scripts/visual-lora-dataset.py`, `scripts/runpod-lora-train.py`, `scripts/lora/bootstrap.sh` |

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

### Schritt 3 – Pod-Lauf

```bash
# 1) rechnen (kein API-Aufruf, keine Kosten)
python3 scripts/runpod-lora-train.py --plan --images 60 --price-per-hour <satz>

# 2) starten – NUR mit Freigabe (sonst Exit 3, kein einziger HTTP-Request)
LORA_APPROVE_SPEND=1 KOSTENBESTAETIGUNG=<obergrenze> \
python3 scripts/runpod-lora-train.py --train --images 60 --price-per-hour <satz> \
    --template-id runpod-torch-v280 \
    --docker-args 'bash -c "bash /workspace/lora/bootstrap.sh"' \
    --train-command 'python3 /workspace/lora/train_style_lora.py --dataset_config /workspace/lora-dataset/dataset_config.toml' \
    --volume-id <vol-id> --dataset-url <https-url-des-tar.gz> --result-url <presigned-put-url>

# 3) Not-Aus / Aufräumen (jederzeit, ohne Freigabe – beendet Kosten)
python3 scripts/runpod-lora-train.py --terminate <pod-id>
```

---

## 3. Kostenrechnung

**Formel (keine erfundenen Zahlen; der Stundensatz ist eine Betreiber-Eingabe):**

```
Kosten          = Stundensatz × Zeit[h]
Zeit_Plan       = Kaltstart + Training + Aufräumen
Zeit_Obergrenze = Kaltstart + LORA_MAX_RUNTIME_MINUTES + Aufräumen
Schritte        = ceil(Bilder × num_repeats × Epochen / batch_size)
Trainingszeit   = Schritte × Sekunden_je_Schritt
```

| Größe | Wert | Herkunft |
|---|---|---|
| Stundensatz | **Pflicht: `--price-per-hour` / `LORA_GPU_PRICE_PER_H`** | Ablesen per `runpodctl gpu list` (`securePricePerHr` / `communityPricePerHr`) oder RunPod-Preisseite. Das Skript erfindet **keinen** Preis und liest ihn auch nicht selbst (ein Preis-Lookup wäre schon ein API-Aufruf vor dem Gate) |
| Kaltstart | 20 min (Default `LORA_STARTUP_MINUTES`) | gemessen 2026-09-11: Kaltstart/Bild-Pull eines Bild-Workers 15–25 min, `docs/VISUALMONK_SPEC.md` §4 |
| Sekunden/Schritt | 2,0 s (**Annahme**, Default `LORA_SECONDS_PER_STEP`) | **kein Messwert** – streut stark nach Modell/Auflösung/Karte. Nach dem ersten Lauf durch den gemessenen Wert ersetzen |
| Aufräumen/Upload | 5 min (Default `LORA_TEARDOWN_MINUTES`) | Planungsannahme |
| Harte Laufzeitgrenze | 90 min (Default `LORA_MAX_RUNTIME_MINUTES`) | Betriebsentscheidung: danach wird der Pod zwangsweise terminiert |
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

- Gate **vor** jedem API-Aufruf: ohne `LORA_APPROVE_SPEND=1` **und**
  `KOSTENBESTAETIGUNG >= Obergrenze` → Exit 3, und das `runpod`-SDK wird nicht
  einmal importiert (Test: `tests/test_visual_lora_pipeline.py::GateTest`).
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
Training längst fertig ist. Deshalb ist die Terminierung kein „Aufräumen",
sondern der eigentliche Kostenstopp. Notfalls `runpodctl pod list` und
`runpodctl pod remove <id>`.

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
4. **Netz-Volume anlegen** (empfohlen): `runpodctl network-volume create --name
   audiomonastry-lora --size <GB> --data-center-id <DC>`. Volume und Pod müssen
   im **selben Data Center** liegen, sonst scheitert das Scheduling.
5. **Datensatz hochladen:** `dataset.tar.gz` aus Schritt 2 der Pipeline auf das
   Volume legen **oder** über eine URL bereitstellen (`--dataset-url`; der Pod
   lädt selbst). Zusätzlich `scripts/lora/bootstrap.sh` ins Volume kopieren
   (erwarteter Pfad: `/workspace/lora/bootstrap.sh`).

**B. Daten entstehen lassen (der eigentliche Blocker)**

6. App starten, Visuals generieren, Session beenden und bewerten (Umfrage).
   Danach `--diagnose` erneut: `feedback_rows > 0` mit Bewertungen ≥ 4.
7. Kuration + Dataset bauen (Schritte 1 und 2 oben). Bei `Exit 3` **nicht
   weitermachen** – erst die Datenlage klären.

**C. Trainingslauf (der einzige bezahlte Teil)**

8. **Rechnen:** `python3 scripts/runpod-lora-train.py --plan --images <n>
   --price-per-hour <satz> …`. Der Plan nennt die **harte Obergrenze** und listet
   auf, was noch fehlt.
9. **Freigeben und starten** (Kopieren des Werts aus dem Plan, 4 Dezimalstellen):
   ```
   LORA_APPROVE_SPEND=1 KOSTENBESTAETIGUNG=1.3225 \
   python3 scripts/runpod-lora-train.py --train --images <n> --price-per-hour <satz> \
       --template-id runpod-torch-v280 --train-command '<trainer-befehl>' \
       --docker-args 'bash -c "bash /workspace/lora/bootstrap.sh"' \
       --volume-id <vol-id> --dataset-url <url> --result-url <presigned-put>
   ```
   Erwartete Ausgaben: `[lora] Freigabe erteilt …` → `Pod angelegt: <id>` →
   Zustandszeilen → `Aufraeumen ok: terminiert`.
10. **Nach dem Lauf prüfen:** Report unter `logs/lora-runs/<zeit>-<name>.json`
    (`pod.terminated: true`, `artifact`, `failure`), im Pod/Volume die
    `STATUS`-JSONL und `train.log`. Ohne `--result-url` wird der Erfolg **nicht**
    am Artefakt gemessen – dann die LoRA-Datei selbst kontrollieren.
11. **Aufräumen bestätigen:** `runpodctl pod list` (kein Pod mehr da);
    `runpodctl user` (laufende Kosten). Ein nicht mehr gebrauchtes Volume kostet
    weiter Speicher → `runpodctl network-volume delete <id>`.

**Abbruchkriterien** (dann sofort `--terminate`):

- Der Pod bleibt auf `RUNNING`, es kommt aber kein Ergebnis → Laufzeitgrenze
  abwarten oder sofort terminieren.
- Der Trainingsverlust/Log zeigt einen Abbruch vor `DONE` in `STATUS`.
- Zweifel am Datenpfad: **erst** Datenlage klären, dann bezahlen.

---

## 5. Ehrliche Grenzen (was hier NICHT belegt ist)

- **Kein Lauf, kein Pod, kein Training.** Es gibt keinen Messwert für die
  Trainingsdauer, für die Bildqualität des LoRA oder für die VRAM-Eignung des
  gewählten Images.
- **Die 2,0 s/Schritt sind eine Annahme.** Sie stehen deshalb als „ANNAHME" im
  Kostenblock. Nach dem ersten echten Lauf ersetzen (`--seconds-per-step`).
- **Der Trainer-Befehl im Pod ist ungeprüft.** `scripts/lora/bootstrap.sh` ist
  offline mit Stub-Trainern getestet (Ergebnisdatei-Prüfung, Statusdatei,
  Exit-Codes), aber nie mit einem echten Diffusion-Trainer.
- **Der Datenpfad ist leer** (live geprüft, s. o.). Ohne echte Bewertungen ist
  jeder Lauf ein Lauf ohne Daten – die Pipeline bricht dann mit Exit 3 ab.
- **Rechte/Lizenz:** Stil-LoRAs aus Nutzerbildern und ggf. gated Basisgewichte
  (`FLUX.1-dev`, `FLUX.2 [dev]`) sind ein eigenes Thema; das Skript prüft keine
  Lizenzen (`docs/VISUALMONK_SPEC.md` §9 nennt es als offenen Punkt).
- **Volume-Löschung ist bewusst manuell.** Das Skript löscht keine Volumes
  (dort liegt der Datensatz + das Ergebnis).

---

## 6. Tests und Belege

```bash
python3 tests/test_visual_lora_pipeline.py        # 28 Tests, ohne Netz/GPU/Kosten
python3 tests/test_visual_lora_pipeline.py -v     # mit Testnamen
```

Abgedeckt: Filter/Sortierung/Limit der Kuration, ehrliche 0-Paare-Ausgabe
(Exit 3 + Datei), Diagnose, Dataset-Bau (Bild + Caption + `metadata.jsonl` +
Prüfsummen + deterministisches `tar.gz`), „kein Bild → Exit 3", **das
Freigabe-Gate** (ohne Freigabe/bei zu niedrigem Betrag: Exit 3 und das
Fake-SDK wird **nicht einmal importiert**), Pod-Anlegen + Terminierung mit
Fake-SDK, Doppelname-Schutz, Laufzeitgrenze, Not-Aus-Modus und der In-Pod-Runner
mit Stub-Trainer.

Die Tests benutzen ein **gefälschtes `runpod`-SDK**, das jeden Kontakt in eine
Logdatei schreibt. Genau dieses Log ist der Beleg für „kein API-Aufruf vor der
Freigabe": nach einem abgelehnten Lauf ist es leer.
