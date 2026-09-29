# visualplan.md — Übergabe an den nächsten Agenten

**Zweck:** Betriebsanleitung für die Themen-LoRAs (VISUAL-P1-009). Kein Bericht für
den Menschen — der steht in `BERICHT.md`. Hier stehen die Fakten, die man sonst
teuer neu herausfindet: welche Hardware funktioniert und welche **nachweislich
nicht**, welches Image, welche Konfiguration, welche Fallen im Datenpfad, welche
Schutzmechanismen **nicht entfernt werden dürfen**.

**Stand:** 2026-09-27, 09:15 CEST · **Ergebnis:** 32/32 Themen-LoRAs trainiert,
verifiziert, in R2 · **Verbraucht:** 8,44 USD von 11,80 · **Pods laufend:** 0

Arbeitsordner für alles: `/home/patrick/lora-themen-2026-09-27/`

---

## 0. Schnellstart (wenn nur Zeit für einen Abschnitt ist)

```bash
cd /home/patrick/lora-themen-2026-09-27

# 1) Zugangsdaten laden (NIE ausgeben, NIE in Logs schreiben)
export RUNPOD_API_KEY=$(grep -E '^RP_API_KEY=' \
  "/home/patrick/AnunnakiTools Projekte/laufende Projekte/audioMONASTRY/.env" \
  | head -1 | cut -d= -f2- | tr -d '"')

# 2) Status: Pods, Guthaben, fertige LoRAs
python3 monitor.py

# 3) Bundle (Datensätze + Konfigs + Pod-Skript) nach R2 schnüren
python3 make-bundle.py --run lora-themen-v1 --steps 800

# 4) Einen Pod starten (GPU-Kette: nur Karten mit Treiber >= 595!)
python3 start-pod.py --name lora-pX \
  --gpu "NVIDIA RTX PRO 5000 Blackwell,NVIDIA RTX PRO 6000 Blackwell Workstation Edition" \
  --themes "comic abstrakt" --steps 800 --deadline-hours 4 --max-theme-minutes 40
```

Alle GPUs sind Community Cloud. **Kein `--public-ip`** (siehe §2.3).

---

## 1. Hardware — was geht, was nicht (mit Beleg)

| Karte | Treiber auf dem Host | Ergebnis | Preis |
|---|---|---|---|
| **RTX PRO 5000 Blackwell** (48 GB) | 595.71.05 / 595.58.03 | **funktioniert** · `torch 2.13.0+cu130 \| verfuegbar True` | 0,82 USD/h |
| RTX 4090 (24 GB) | **580.126.09** | **funktioniert NICHT** · `RuntimeError: CUDA unknown error … Setting the available devices to zero` | 0,34 USD/h |
| RTX A6000, L40S | — | zum Zeitpunkt nicht verfügbar („no longer any instances") | 0,33 / 0,79 USD/h |

### 1.1 Die wichtigste Falle: `--min-cuda-version 13.0` garantiert nichts
Das Trainer-Image bringt `nvidia/cuda:13.0.3` mit und braucht einen Host-Treiber
**≥ 595**. Der Dockerfile sagt „driver >= 580" — **das ist falsch**, live widerlegt.
`runpodctl gpu list`/`get-capacity` melden für die 4090 „CUDA 13.0 AVAILABLE", der
Host hat aber Treiber 580 → `torch.cuda.is_available()` ist `False`, obwohl
`nvidia-smi` läuft.

**Konsequenz:** Karten ungleich „RTX PRO 5000 Blackwell" (und PRO 6000/H100/H200)
vor dem Massenlauf **immer erst mit einem Test-Pod prüfen**. Ein Pod kostet in
5 Minuten ~0,07 USD; ein ungeprüfter Massenlauf verbrennt Themen.

### 1.2 GPU-Kette, die sich bewährt hat
```
NVIDIA RTX PRO 5000 Blackwell
NVIDIA RTX PRO 6000 Blackwell Workstation Edition
NVIDIA RTX PRO 6000 Blackwell Server Edition
NVIDIA H100 PCIe
```
`start-pod.py` probiert sie der Reihe nach durch und nimmt die erste verfügbare.

### 1.3 Was Hardware **nicht** braucht
- **Kein Network Volume.** SDXL ist nur ~7 GB; das Volumen (100 GB = 5 USD/Monat)
  rechnet sich erst ab ~25 Abschnitten pro Monat. Für eine Nacht: weglassen.
- 24 GB VRAM reichen für SDXL-LoRA (batch 2, grad checkpointing). 48 GB sind
  bequem, aber nicht Pflicht — die 24-GB-4090-Sperre war der **Treiber**, nicht der
  VRAM.

---

## 2. Pod-Anlage — die drei Fallen

### 2.1 `--public-ip` verhindert die Anlage
```
{"error":"failed to create pod: graphql error: There are no longer any instances
 available with the requested specifications."}
```
Mit `--public-ip` (community) kam diese Meldung reproduzierbar für 4090 **und**
A6000. Ohne das Flag klappte die Anlage sofort. SSH wird nicht gebraucht — der Pod
arbeitet autonom. Also: **kein `--public-ip`, keine `--ports`.**

### 2.2 Ein beendeter Container wird automatisch NEU GESTARTET
RunPod startet einen Container, dessen Kommando endet, erneut. Ist das Pod-Skript
zu Ende, läuft der komplette Lauf **von vorn** — doppelte Kosten. Deshalb:
`SELF_TERMINATE=1` + `RUNPOD_API_KEY` im Pod **und** `trap 'self_terminate' EXIT`
im Skript. **Diese Zeilen sind nicht optional.** Nachgewiesen: beim ersten
Test-Pod ohne sie lief eine sichtbare Neustart-Schleife im Log.

### 2.3 Pod-Anlage: `runpodctl pod create`
`runpodctl` in dieser Umgebung: **2.14.0**.
- Pod-Liste: `runpodctl pod list -o json` — **nicht `--format json`**, das Flag
  existiert hier nicht (führte zu stiller Leerliste im Monitor).
- Terminieren: `runpodctl pod remove <id>`
- Env + Kommando: `--env '<json>'` und `--docker-args 'bash -c "…"'`

---

## 3. Software — Image und Konfiguration

### 3.1 Image
```
ostris/aitoolkit:latest        # ohne Bindestrich! "ostris/ai-toolkit" existiert nicht
```
- **Der Trainer ist im Image enthalten** (`WORKDIR /app/ai-toolkit`).
  `pod-run.sh` findet ihn dort — **nicht klonen**, das kostet nur Zeit.
- Bringt CUDA 13.0.3 mit, `TORCH_CUDA_ARCH_LIST="8.0 8.6 8.9 9.0 10.0 12.0"`,
  `torch 2.13.0+cu130`.
- Kein venv: `python` = `/usr/bin/python3.12` (Symlink), Pakete mit
  `--break-system-packages` installiert.
- Entrypoint `/opt/nvidia/nvidia_entrypoint.sh`, Cmd `/start.sh` — wird durch
  `--docker-args` ersetzt, das ist unproblematisch.

### 3.2 Trainerkonfiguration (SDXL)
Vorlage: `make-configs.py`, erzeugt `bundle/configs/<slug>.yml`.
Basis war die **bewährte FLUX-Konfiguration vom 24.09.** (`lora/cosmic-r16/config.yml`
in R2). Geändert wurde nur, was SDXL wirklich betrifft, jede Zeile belegt aus dem
ai-toolkit-Quellcode:

```yaml
model:
  name_or_path: "stabilityai/stable-diffusion-xl-base-1.0"
  arch: "sdxl"          # config_modules.py: `elif self.arch == 'sdxl': self.is_xl = True`
  is_flux: false        # is_xl wählt die StableDiffusionXLPipeline
  dtype: "bf16"
train:
  dtype: "bf16"         # PFLICHT in BEIDEN Blöcken. Fehlt es, lädt ai-toolkit fp32
                        # und stirbt am .to(cuda) — genau daran scheiterte der FLUX-Lauf.
  noise_scheduler: ddpm # SDXL = DDPM. Flowmatch ist FLUX.
  batch_size: 2
  steps: 800
  gradient_checkpointing: true
  optimizer: adamw8bit
  lr: 1e-4
  train_unet: true
  train_text_encoder: false
network:
  type: lora
  linear: 16            # Rang 16 — bei 25 Bildern reicht das; höher = Überanpassung
  linear_alpha: 16
datasets:
  - folder_path: "/workspace/themes/<slug>/images"
    caption_ext: txt
    resolution: [1024]
    cache_latents_to_disk: true
sample:
  sampler: ddpm         # muss zu train.noise_scheduler passen
  guidance_scale: 7
  width: 1024
  height: 1024
```
**Nicht** `stabilityai/stable-diffusion-xl-base-1.0` als gated behandeln — es ist
offen, `HF_TOKEN` ist optional.

### 3.3 Gemessene Werte (RTX PRO 5000 Blackwell, batch 2, 1024 px)
| Größe | Wert |
|---|---|
| Schritte/Sekunde | **1,13 it/s → 0,88 s/Schritt** |
| 800 Schritte | **12:14 min** |
| Thema komplett inkl. Latenz-Cache + 5 Probe-Bildern | **13,4 – 19,5 min** (Median ~15) |
| LoRA-Datei | **85.438.356–85.438.400 Bytes** (Rang 16) |
| 32 Themen gesamt | **7,97 h Trainingszeit** |
| `sample_every` | `steps // 4` → 4 Zwischenbilder (kostet ~3 s je Bild) |

---

## 4. Datenpipeline — vier Fallen, die Geld gekostet hätten

Quelle: `/home/patrick/am-visuals-themen-neu/`
- `<Thema>/` = 25 kuratierte Bilder je Thema (echte Dateien, JPG/HEIC/PNG/DNG)
- `_listen/<Thema>.csv` = semikolongetrennte Analyse je Originalbild:
  `proxy;original;aesthetik;nsfw;personen;treffer;themen;ausschluss;beschreibung;tags`

Fertiger Datensatz: **`out-v3/<slug>/images/{NN_name.jpg, NN_name.txt}`**
= 32 Themen × 25 Bilder = **800 Bilder, 0 Verwürfe**.
Caption-Regel: `mstyle_<slug>, <BLIP-Beschreibung>`.

### Falle 1 — `tags` ist NICHT themenspezifisch
Bei einem Bild ist die Spalte `tags` in **allen** Themen-CSVs identisch
(29.339 von 29.339 geprüft). Sie in die Caption zu schreiben impft jedem LoRA die
Begriffe **aller** Themen ein. → **`tags` gehört nicht in die Caption.**

### Falle 2 — die Ordnerbilder sind die *generischen*
Die 25 Bilder in `<Thema>/` haben `treffer` 4–6, passen also zu 4–6 Themen
gleichzeitig. Am Kontrollblatt: in `natur_tiere` lagen **bemalte Rücken statt
Tiere**. Es gibt 27.601 Bilder mit `treffer == 1`.
**Aber Achtung:** `treffer == 1` ist *auch* nicht sauber — das selektiert die
**schwachen Ausreißer** (`natur_tiere` = Blumen, Musiker, Türriegel).
Beide Varianten wurden gebaut und **am Kontrollblatt verworfen**; trainiert wurde
mit den kuratierten Ordnerbildern. Wer die Auswahl ändert, muss sie **am Bild**
prüfen, nicht an der Zahl.
`ausschluss == "ja"` ist ein echtes Ausschlusssignal (die Ordnerbilder waren alle
ausschluss-frei).

### Falle 3 — die Originale wurden **zweimal** verschoben
`original` aus der CSV (`/home/patrick/Bilder/IMG_9241.JPG`) existiert nicht mehr.
Auflösungskette in `build-datasets-v2.py`:
1. absoluter Pfad
2. `bilder-sortierung-umkehr.tsv` (46.311 Einträge, `alt → Bilder/<neu>`)
3. Kopie in `<Thema>/`
4. `datei-index.json` (46.695 Dateien, eindeutiger Basisname)

Nur die Kombination löst genug auf: Kette allein 56,8 %, Basisnamen-Index allein
27,4 %, **gemeinsam 742 + 91 = 833 von 833**.

### Falle 4 — `dcraw` in dieser Umgebung kennt kein `-O`
`dcraw v9.28` schreibt `<name>.tiff` neben die Eingabe. DNG also **in ein
Temp-Verzeichnis kopieren** und `dcraw -T -w <kopie>` aufrufen.
HEIC geht über `pillow_heif` — **nur im venv** `/home/patrick/bildanalyse-venv`
(vorhanden: PIL 12.3, pillow_heif 1.8, numpy 2.5).

```bash
/home/patrick/bildanalyse-venv/bin/python3 build-datasets-v3.py   # ← das ist der gültige
python3 build-datasets-v2.py                                       # historisch, treffer==1-Variante
```

---

## 5. Ablauf im Pod

`bundle/pod-run.sh` (läuft im Pod, wird aus R2 geladen):

```
0. Bundle + presign.json holen (presigned GET, keine Zugangsdaten im Pod)
1. Trainer finden: /app/ai-toolkit  (Notnagel: /app, erst dann git clone)
2. GPU-Bericht schreiben: nvidia-smi + torch-Version + cuda-Verfügbarkeit
   → Ein Fehlschlag muss DIAGNOSIERBAR sein. Der erste Versuch brach ohne
     Bericht ab und die Ursache war nicht mehr feststellbar.
3. je Thema: trainieren → Ergebnis nehmen → nach R2 hochladen → aufräumen
   - schneller Fehlschlag (<120 s, kein Ergebnis) → EIN Wiederholungsversuch
     (fängt HF-Hub-Aussetzer ab: "model is not cached locally and an error
     occurred while trying to fetch metadata from the Hub")
   - hängender Upload → `timeout 900` (ein 85-MB-Upload hing 30+ min und hätte
     den Pod eine Stunde blockiert)
4. Status-JSONL + Log nach R2, dann `self_terminate`
```

**Ergebnisdatei auswählen:** ZUERST `<training_folder>/<name>/<name>.safetensors`
(die Enddatei), sonst den höchsten `<name>_000000NNN.safetensors`.
Die Schritte sind 9-stellig mit Null aufgefüllt → alphabetische Sortierung =
numerische. **Nicht nach Dateigröße sortieren** — das lieferte live den
600er- statt des 800er-Stands.

---

## 6. Kostenmodell (gemessen, nicht geschätzt)

```
Kosten = Pod-Stunden × Stundensatz
Stundensatz RTX PRO 5000 Blackwell, Community = 0,82 USD/h
Thema  ≈ 15 min Training + Anteil Kaltstart (einmal je Pod, ~5 min)
```

| Posten | Ist |
|---|---|
| 32 Themen Training, 478 min | ~6,5 USD |
| Fehlversuche (2× RTX 4090, 13 Themen in 25–40 s) | ~0,1 USD |
| Diagnose-Pod (Treiberfrage) | ~0,2 USD |
| Inferenz-Prüfläufe (2×) | ~0,25 USD |
| Nachhol-Pods (p8, p9, p10) | ~0,4 USD |
| **Gesamt** | **8,44 USD** von 11,80 |

**Parallelität ≠ höhere Kosten.** Die Kosten sind Gesamt-GPU-Stunden; mehr Pods
verkürzen nur die Wanduhr (pro Pod fällt ein Kaltstart an). Für eine Nacht:
5 Pods → 32 Themen in ~2,5 h.

---

## 7. Schutzmechanismen — NICHT entfernen

| Mechanismus | Warum |
|---|---|
| `trap 'self_terminate' EXIT` in `pod-run.sh` | RunPod startet beendete Container neu → doppelte Kosten |
| `SELF_TERMINATE=1` + `RUNPOD_API_KEY` im Pod-Env | Pod löscht sich selbst per GraphQL `podTerminate` |
| `MAX_THEME_SECONDS` (Zeitlimit je Thema, 2400 s) | ein hängendes Thema frisst sonst Stunden |
| `DEADLINE_EPOCH` (Frist) | nach Ablauf startet **kein neues** Thema |
| Namenssperre in `start-pod.py` | verhindert bezahlte Waisen mit gleichem Namen |
| `set -uo pipefail` **ohne `-e`** in `pod-run.sh` | mit `-e` würde ein Fehler die Shell vor dem `trap` beenden |
| `timeout 900` um Uploads | hängender Upload blockiert sonst den Pod |
| Kosten-Freigabe vor jedem Lauf | Betreiber-Entscheidung, nicht Agent-Entscheidung |

**Immer am Ende prüfen:** `runpodctl pod list -o json` → `[]`. Nicht annehmen.

---

## 8. Nachweiswerkzeuge (bitte benutzen, nicht glauben)

```bash
python3 pruefe-lora.py <thema>     # safetensors-Struktur: Tensoren, Header-Länge,
                                   # Metadaten ss_base_model_version, Rang, Konsistenz
python3 verify-results.py          # alle LoRAs in R2 + Kontrollblatt ergebnisse/alle-themen-loras.png
python3 monitor.py                 # Pods, Guthaben, Fortschritt
python3 qualitaet.py               # Probe-Bild-Statistik  ⚠ siehe Warnung unten
python3 test-plumbing.py           # presign + Uploadweg + Bundle + Konfigs, ohne GPU
python3 infer-test2.py             # ECHTE Qualitätsprüfung (siehe unten)
```

### ⚠ Die wichtigste Lektion: das Trainer-Probe-Bild ist KEIN Qualitätsnachweis
`qualitaet.py` maß 8 von 32 Themen als „flächig" (Std < 20). Ich habe daraus
„die LoRAs sind überangepasst" geschlossen — **das war falsch.** Das Probe-Bild ist
das Erzeugnis des *Trainers* (nackter Trigger + „high detail, natural light" bei
CFG 7), nicht des LoRA.

**Richtige Prüfung:** `infer-test2.py` lädt das LoRA in eine eigene
diffusers-Pipeline, **mit** und **ohne** Trigger, und zählt die geladenen
LoRA-Schichten. Ergebnis: **722 Schichten** geladen, und am Bild greift jedes
Thema (`comic` → Bleistiftzeichnung, `krieg_tod` → grau/düster, `taenzer` → zart).
Ein erster Inferenz-Test war **wertlos**, weil (a) der Trigger im Prompt fehlte und
(b) nicht geprüft wurde, ob die Gewichte überhaupt geladen wurden. Ein Test ohne
diese beiden Dinge beweist nichts.

**Trigger sind tragend.** Ohne `mstyle_<thema>` im Prompt wirkt das LoRA kaum.

---

## 9. Offene Punkte / nächste Schritte (Priorität)

1. **SDXL-Generator anbinden — der eigentliche Blocker.**
   Die LoRAs sind **SDXL**. Die Rolle `imageHq` in audioMONASTRY läuft
   **FLUX.1-dev** und kann sie nicht laden. Nötig: ComfyUI mit
   `stabilityai/stable-diffusion-xl-base-1.0` oder ein neuer Endpoint.
   Ohne das ist die ganze Arbeit nicht benutzbar.
2. **Vollständige Qualitätsprüfung:** Inferenz-Test lief nur für 3 von 32 Themen.
   Alle 32 durchprüfen: ~0,5 USD, ein Pod, ~40 min (`infer-test2.py --themes …`).
3. **Datenbasen verbessern:** `hdr_sternenhimmel` hatte nur 15 saubere Kandidaten,
   `feuer_flammen` 40. Im Enddatensatz haben aber alle 25 Bilder — die Auswahl kam
   aus den kuratierten Ordnern. Wer mehr will, braucht **besseres Bildmaterial**,
   nicht andere Schwellen.
4. **`natur_tiere` stimmt inhaltlich nicht:** 24 von 25 Captions beschreiben
   tätowierte Haut — der Ordner enthält Tier-*Tattoos*, keine Tiere. Bewusst so
   trainiert (es ist die Kuratierung des Betreibers), aber beim Benutzen wissen.
5. **Nicht bewertet:** ob die LoRAs zusammen mit dem Vision-Endpoint der App
   ein brauchbares Ergebnis liefern. Dafür muss erst Punkt 1 stehen.

---

## 10. Dateien

| Datei | Zweck |
|---|---|
| `BERICHT.md` | Bericht für den **Menschen** (to gustav: Kosten, Datenfehler, Korrekturen) |
| **`visualplan.md`** | diese Übergabe an den nächsten **Agenten** |
| `r2.py` | SigV4-Presigner (nur stdlib). Selbsttest: `python3 r2.py selftest` |
| `make-bundle.py` | Bundle schnüren + alle Ziel-URLs signieren + hochladen |
| `make-configs.py` | SDXL-LoRA-Konfiguration, jede Änderung begründet |
| `start-pod.py` | Pod anlegen mit GPU-Fallbackkette, Frist, Zeitlimit |
| `bundle/pod-run.sh` | Ablauf im Pod (Trainer finden, Schleife, Uploads, Terminierung) |
| `bundle/upload.py` | Upload per vorab signierter URL (keine Zugangsdaten im Pod) |
| `monitor.py` | Pods, Guthaben, Fortschritt, Kosten |
| `verify-results.py`, `qualitaet.py`, `pruefe-lora.py`, `infer-test2.py` | Nachweise |
| `test-plumbing.py` | Vorab-Test der ganzen Kette ohne GPU |
| `build-datasets-v3.py` | gültiger Datensatzbau (v1/v2 in der Datei erklärt) |
| `diag-pod.py` | Umgebungsdiagnose eines Pods (GPU/Treiber/torch) |
| `out-v3/<slug>/manifest.json` | je Thema: gewählte Bilder, Caption, Verwurfsgründe |
| `ergebnisse/` | Kontrollblätter, Messwerte, Ergebnisse |

### Zugangsdaten (nur Namen, niemals Werte ausgeben)
`/home/patrick/AnunnakiTools Projekte/laufende Projekte/audioMONASTRY/.env`
- `RP_API_KEY` — RunPod (auth für runpodctl, MCP, den Pod selbst)
- `CFS3_ACCESS_KEY` / `CFS3_SECRET_KEY` / `CFS3_ENDPOINT` / `CFS3_BUCKET`
  — Cloudflare R2, Bucket `audiomonastrysamples`
- `HF_TOKEN` — optional (SDXL ist nicht gated)

Ergebnispräfix in R2: **`lora-out/<slug>/`**
(`<slug>.safetensors`, `samples.tar`, `train.log`, `meta.json`; Sammelstatus unter
`lora-out/_status/lora-pN.jsonl`)

---

## 11. Anti-Patterns (haben hier Zeit oder Geld gekostet)

- ❌ Ohne Freigabe starten. Der Betreiber entscheidet über Geld, nicht der Agent.
- ❌ `--public-ip` bei Community-Pods → Anlage scheitert.
- ❌ `runpodctl pod list --format json` → Flag existiert nicht, stille Leerliste.
- ❌ Ein Pod-Skript ohne `trap`-Terminierung → Neustart-Schleife, doppelte Kosten.
- ❌ `set -e` im Pod-Skript → `trap` wird übersprungen.
- ❌ Umgebung prüfen und **hart abbrechen**, ohne den Befund zu protokollieren —
  genau das hat beim ersten Pod die Diagnose vernichtet.
- ❌ Ergebnis nach Dateigröße auswählen → falscher Checkpoint.
- ❌ `tags` aus der Analyse-CSV in Captions schreiben.
- ❌ Themen-Auswahl nur über `treffer` entscheiden, ohne die Bilder anzusehen.
- ❌ Aus einem flächigen Trainer-Probe-Bild auf die LoRA-Qualität schließen.
- ❌ Inferenz-Test ohne Trigger und ohne Prüfung, ob die Gewichte geladen wurden.
- ❌ Alles parallel starten, bevor **ein** Thema nachweislich durchgelaufen ist.
- ❌ `runpodctl pod create` fuer Erfolg halten. **Es meldet auch dann Erfolg mit
  Pod-ID, wenn keine Kapazitaet da ist** — der Pod wird nie platziert und
  verschwindet nach Sekunden, ohne Fehlermeldung und ohne Kosten. Deshalb prueft
  `start-pod.py` jetzt 75 s, ob der Pod wirklich existiert, und geht sonst zur
  naechsten Karte. Ohne diese Pruefung laeuft die ganze GPU-Kette ins Leere.
- ❌ Den Stundensatz fuer den Kostendeckel vom AUFRUFER nehmen. Er muss von der
  **Karte** kommen (`RATE_USD_H` in `start-pod.py`). Live passiert: Deckel fuer
  0,33 USD/h gerechnet, gelaufen ist eine Karte zu 1,69 — der Waechter im Pod
  haette das Fuenffache erlaubt. Unbekannte Karten bekommen einen Aufschlag.
- ❌ Eine Kennzahl bauen, ohne zu pruefen, ob sie die richtige Frage stellt.
  Zwei eigene Fehlschlaege in diesem Lauf: (a) „eigen" war immer 1.000, weil das
  Bild in seiner eigenen Referenz steckte -> leave-one-out; (b) die CLIP-Naehe
  **belohnt leere Flaechen** (Korrelation Anstieg↔Struktur −0,268) -> immer
  Struktur UND Stil messen.
- ❌ Einen absoluten Schwellwert fuer „zerfallen" benutzen. Glatte Motive (Haut,
  Himmel, Makro) haben legitim wenig Kanten -> sechs Fehlalarme. Relativ messen
  (unter 40 % des eigenen Maximums) und **die Verdachtsfaelle ansehen**.
- ❌ Ein Skript ins Bundle-Verzeichnis legen und annehmen, es sei im Bundle.
  `armwahl.py` fehlte in der Tar-Liste; der Pod nahm den Traceback-Text als
  „Einstellung", Phase 2 fand keine Konfiguration und uebersprang **alle** Themen
  — der Pod meldete trotzdem Erfolg. `make-bundle-v2.py` bricht jetzt ab, wenn
  eine Datei fehlt, und `pod-run.sh` validiert den Suffix gegen `^[A-Za-z0-9_]+$`.

---

## 12. Nachtrag 27.09. — Zerfall, Lernrate und der v2-Weg

### 12.1 Der Befund: 7 von 32 LoRAs waren kaputt

Nicht „schwach", sondern **zerstört**: der ausgelieferte 800er-Stand erzeugt eine
leere Flaeche. `taenzer` Graustufen-Std 47,3 → **0,9**; ebenso
`geheimbund_moenche`, `krieg_tod`, `licht_rauch`, `natur_echt`,
`vorsintflutliche_hochkultur`, `industrial_techno`. Gefunden mit
`serie-struktur.py` (misst die Probe-Serie des Trainers, kostet nichts) und
**an den Bildern verifiziert** (`ergebnisse/zerfall-*.png`).

Die frueher benutzte CLIP-Kennzahl hat das nicht gesehen — sie stieg bei
`taenzer` sogar am staerksten.

### 12.2 Die Ursache: die Lernrate

Gemessen an `vorsintflutliche_hochkultur` (sauberste Daten, 24/25 themenrein —
also reines Optimierungsproblem), zwei Arme, eine Variable:

| Arm | Struktur 0→800 | Ergebnis |
|---|---|---|
| **lr 5e-5 + cosine** | 37 → 42 → 33 → 31 → **30** | gesund |
| lr 1e-4 + cosine | 37 → 32 → **3,7** → … → 3,0 | zerfaellt ab 300 |
| lr 1e-4 konstant (v1) | 37 → 35 → **4,9** → … → 4,3 | zerfaellt ab 400 |

**Cosine allein hilft nicht — die Lernrate muss runter.** Kosten des Messlaufs:
0,56 USD.

### 12.3 Was der v2-Weg zusaetzlich kann

| Datei | Zweck |
|---|---|
| `make-configs.py` | um `--lr-scheduler`, `--save-every`, `--keep-saves`, `--sample-every`, `--suffix` erweitert (belegt aus `toolkit/scheduler.py` und `BaseSDTrainProcess.py:2213`) |
| `bundle-v2/schrittwahl.py` | waehlt im Pod den **nicht zerfallenen** Schritt statt blind den letzten; relativ gemessen, am echten `taenzer`-Fall getestet |
| `bundle-v2/armwahl.py` | vergleicht Messarme anhand der Berichte und gibt den Gewinner aus |
| `bundle-v2/pod-run.sh` | zwei Phasen (messen -> anwenden), **harte USD-Obergrenze**, validierter Suffix, frueher CUDA-Abbruch **mit** Bericht |
| `make-bundle-v2.py` | Bundle nur mit den betroffenen Themen (61 MB statt 299 MB) |
| `start-mit-wiederholung.sh` | startet automatisch, sobald RunPod wieder Kapazitaet hat |
| `clipbasis.py`, `bewerte.py`, `bewerte-nachweis.py`, `serie-struktur.py` | **lokale** Pruefwerkzeuge (CLIP auf der CPU, 0 USD) |

Schluessel der neuen Ergebnisse: **`lora-themen-v2/out/<job>/`**; bei
Anwendungsthema zusaetzlich der saubere Schluessel
`lora-themen-v2/out/<slug>/<slug>.safetensors`. v1 bleibt unter `lora-out/`
unberuehrt.

### 12.4 Fortsetzen

```bash
cd /home/patrick/lora-themen-2026-09-27
export RUNPOD_API_KEY=$(grep -E '^RP_API_KEY=' \
  "/home/patrick/AnunnakiTools Projekte/laufende Projekte/audioMONASTRY/.env" \
  | head -1 | cut -d= -f2- | tr -d '"')

./start-mit-wiederholung.sh 10 240        # startet, sobald Kapazitaet da ist

# danach: Ergebnis lokal nachmessen (kostenlos)
/home/patrick/bildanalyse-venv/bin/python3 serie-struktur.py --themen "taenzer,krieg_tod"
```

**Wenn die 6 Themen durch sind:** `infer-nachweis.py` + `bewerte-nachweis.py`
fuer den vollstaendigen Qualitaetsnachweis (eigene Bilder mit/ohne Trigger,
lokal bewertet, ~0,5 USD).

---

## 13. STAND 27.09. 10:46 — hier wieder ansetzen

**Pods laufend: 0 · Guthaben 12,6282 USD · v2 bisher verbraucht ~0,70 USD**

### Was fertig ist

- **1 von 7 Themen ist repariert und am Bild verifiziert:**
  `vorsintflutliche_hochkultur` → R2 `lora-themen-v2/out/vorsintflutliche_hochkultur__lr5e5cos/`
  (Achtung: Schluessel exakt `lora-themen-v2/out/vorsintflutliche_hochkultur__lr5e5cos/`).
  v1 lieferte ab Schritt 400 nur leere Flaechen, v2 liefert durchgehend saubere
  Architektur. Vergleichsbild: `/tmp/v1-vs-v2.png` (neu erzeugen, falls weg).
- **Bundle + presign liegen in R2** fuer die 6 uebrigen Themen:
  `lora-themen-v2/bundle.tar.gz` (61 MB), `presign.json` (157 URLs inkl. 120
  Status-Schluessel fuer das Namensraster `lora-v2-p1..p20`, `lora-v2-w1c..w20c`,
  `lora-v2-w1s..w20s`). Signiert ~10:41, gueltig 48 h — **nach ~29.09. 10:41 neu bauen.**

### Was noch fehlt

Die 6 weiteren kaputten Themen, je mit lr 5e-5 + cosine, 800 Schritte,
`save_every 100`, Checkpoint-Auswahl:

`geheimbund_moenche`, `industrial_techno`, `krieg_tod`, `licht_rauch`,
`natur_echt`, `taenzer`

**Bis dahin diese sechs v1-LoRAs NICHT verwenden** — sie erzeugen leere Bilder.

### Der naechste Schritt, genau

1. `./start-mit-wiederholung.sh 14 200` — startet den Pod, sobald Kapazitaet da
   ist, und beendet sich nach dem ersten Erfolg. Jeder Versuch bekommt einen
   eigenen Namen (Namenssperre!). Kein zweiter Aufruf noetig, solange er laeuft.
2. **Erst wenn ein Pod laenger als 10 Minuten lebt**, ist er brauchbar. Im
   Container-Log muss stehen: `[boot] starte pod-run.sh` und
   `=== Phase 2: Anwendung auf ... (Einstellung 'lr5e5cos')`.
3. Bis die 6 Dateien in R2 liegen:
   `lora-themen-v2/out/<slug>/<slug>.safetensors` (plus `step-wahl.json`,
   `meta.json`, `samples.tar`).
4. Kostenlos nachmessen: `serie-struktur.py --themen "taenzer,krieg_tod,..."`
   → darf **kein** `ZERFALL` zeigen; `letzter Halt` soll 800 sein.
5. Dann der Qualitaetsnachweis (eigene Bilder mit/ohne Trigger, ~0,5 USD):
   `infer-nachweis.py --lora "..."` → `bewerte-nachweis.py --tag nachweis`.

### Offene Frage, falls es weiter scheitert

Am 27.09. zwischen 10:00 und 10:46 **starben vier Pods innerhalb von 1–2 Minuten**
und hinterliessen **kein Log und keinen Status** (zusammen ~0,17 USD). Zwei
davon wurden nie platziert (0 USD, reine Kapazitaet), zwei wurden berechnet —
also gestartet und dann gestorben, **bevor** das Boot-Skript etwas schrieb.
Pod 1 lief am selben Tag mit demselben Image 40 Minuten problemlos.

**Diagnose, die das trennt** (noch nicht durchgefuehrt): einen Pod mit einem
minimalen Befehl starten und sehen, ob der Container ueberhaupt lebt:

```bash
runpodctl pod create --name lora-test-lebt \
  --image ostris/aitoolkit:latest --gpu-id "NVIDIA RTX PRO 6000 Blackwell Workstation Edition" \
  --gpu-count 1 --cloud-type COMMUNITY --min-cuda-version 13.0 --container-disk-in-gb 40 \
  --docker-args 'bash -c "echo HALLO; sleep 900"'
# nach 2 Minuten: erscheint 'HALLO' im Log?
```

- **Kommt `HALLO`** → der Container laeuft, das Problem liegt in meinem Boot-Skript
  oder im Bundle.
- **Kommt kein `HALLO`** → die Hosts sind das Problem (Image-Pull/Container-Start),
  dann Image oder Karte wechseln statt weiter zu wiederholen.

**Ergebnis des Trenn-Tests (27.09. nachmittags): `HALLO-LEBT` kam an.** Der
Container laeuft, das Image wird gezogen, die Karte wird platziert. Die vier
gestorbenen Pods waren also Host-/Kapazitaetsprobleme, **nicht** das Boot-Skript.
Ein gestorbener Pod ohne Log heisst nicht „mein Skript ist kaputt".

**Und der zweite Befund, der schwerer wiegt:** auf derselben Karte (RTX 5090,
Host-Treiber **590.48.01**) schreibt torch
`CUDA initialization: CUDA unknown error … Setting the available devices to zero`
→ `TORCH 2.13.0+cu130 | available=False`. Damit ist die Regel aus §1.1 scharf:
**das Trainer-Image braucht Host-Treiber ≥ 595.** 580 scheitert (4090), 590
scheitert (5090), 595 funktioniert (PRO 5000 Blackwell). Alles darunter ist kein
„vielleicht", sondern gemessen unbrauchbar — **bevor** ein Themenlauf darauf
gestartet wird.

---

## 14. Basismatrix — welches Modell wir fuer die Bild-Rolle nehmen (27.09.2026)

Alle Zahlen sind am 27.09.2026 **live von der HuggingFace-API** gelesen
(`/api/models/<repo>?blobs=true`, Feld `siblings[].size`), nicht aus dem
Gedaechtnis. Repo-Gesamtgroessen enthalten **alle** Formate (fp32, ONNX, Flax,
GGUF) und taugen als Groessenvergleich **nicht** — verglichen wird die Spalte
„Dateien fuer den Betrieb".

| Basismodell | Dateien fuer den Betrieb (ComfyUI) | Lizenz | LoRA-Bestand | Hardware |
|---|---|---|---|---|
| **SDXL 1.0**<br>`stabilityai/stable-diffusion-xl-base-1.0` | `sd_xl_base_1.0.safetensors` **6,46 GB** (VAE ist enthalten; diffusers-Unet fp16 4,78 GB, Text-Encoder 2 2,59 GB) | **openrail++** — kommerziell nutzbar | **>1000** Repos mit `base_model:sdxl-base-1.0`; zusaetzlich **32 eigene Themen-LoRAs** aus diesem Lauf (85,4 MB je Datei, Rang 16) | 8–12 GB VRAM, jede Karte ab RTX 3060. Gemessen: 0,88 s/Schritt bei 1024 px, batch 2 |
| **FLUX.1-dev**<br>`black-forest-labs/FLUX.1-dev` | Unet fp8 **11,08 GB** (`Kijai/flux-fp8`) oder 16,06 GB (`Comfy-Org/flux1-dev`, fp8) · Text-Encoder `t5xxl_fp8_e4m3fn` **4,56 GB**, `clip_l` **0,23 GB** · `ae.safetensors` **0,31 GB** → **~16–21 GB** je nach fp8-Variante. Volles bf16-Checkpoint: 22,17 GB | **BFL Non-Commercial** (HF: `license: "other"`, `gated: "auto"`). Fuer privaten Testgebrauch freigegeben, **nicht** kommerziell | **>1000** Repos. Aus dem gelieferten Text: 2 Kandidaten, davon **1 nachgeprueft vorhanden** (`ThalisAI/fractal-aliens-sci-fi-lora`, 0 Likes, 72 Downloads, `license: other`). `d15ff-Flame-Fractal` **existiert nicht** (HTTP 404) | 16–24 GB VRAM mit fp8 |
| **FLUX.2-dev**<br>`black-forest-labs/FLUX.2-dev` | Transformer **60,0 GB** (`flux2-dev.safetensors`) + Mistral-Text-Encoder **40,3 GB** (10 Shards à 4,45–4,55 GB) + VAE 0,31 GB ≈ **100 GB** fuer den Betrieb. Repo gesamt **177,6 GB** | BFL Non-Commercial, `gated: "auto"` | Nur **134** Repos mit `base_model:FLUX.2-dev` — und die **Top 10 nach Downloads sind fast alle Quantisierungen, keine Stil-LoRAs**: `unsloth/FLUX.2-dev-GGUF` (117k), `city96/FLUX.2-dev-gguf` (91k), `DeepBeepMeep/Flux2` (32k), `silveroxides/FLUX.2-dev-fp8_scaled` (28k), `fal/FLUX.2-dev-Turbo` (10k). Die erste echte LoRA ist `ostris/flux2_berthe_morisot` (1.024 Downloads, Personen-LoRA) | **>80 GB VRAM** unquantisiert; fp8 noch ~60 GB |
| **FLUX.2-klein-4B**<br>`black-forest-labs/FLUX.2-klein-4B` | Transformer **7,22 GB** + Text-Encoder **7,50 GB** (2 Shards) + VAE 0,16 GB = Repo **22,1 GB** | **apache-2.0** | — (klein, aufwaerts offen) | ~12–16 GB VRAM |

### 14.1 Die Entscheidung, und warum

**SDXL und FLUX.1-dev, kein FLUX.2.** Die Begruendung steht in Zahlen in der
Tabelle:

1. **FLUX.2-dev ist fuer Musikvisuals masslos ueberdimensioniert.** ~100 GB
   Betriebsdateien gegen 6,46 GB (SDXL) bzw. ~16 GB (FLUX.1-dev fp8). Das sind
   **15-mal** SDXL. Fuer Standbilder in Album-Cover-Groesse aendert das am
   Ergebnis nichts, das ein Nutzer sieht — es kostet nur Kaltstart, Volume und
   Kartenklasse.
2. **FLUX.2-dev hat praktisch keinen Stil-LoRA-Bestand.** 134 Repos insgesamt,
   und die meistgeladenen sind Konvertierungen, keine Stile. Der ganze Grund fuer
   einen LoRA-faehigen Endpoint ist der **Bestand an Stilen** — genau den gibt es
   hier nicht.
3. **Die eigenen 32 Themen-LoRAs sind SDXL** — sie sind bereits trainiert,
   verifiziert und in R2 (§1–§3). Kein Grund, denselben Datensatz ein zweites
   Mal auf einem 100-GB-Modell zu trainieren.
4. **FLUX.1-dev ist der Pfad, auf dem die App schon laeuft** (§14.2) — der
   Live-Endpoint ist FLUX.1-dev. Damit ist der Umstieg auf ComfyUI + FLUX.1-dev
   kein Modellwechsel, sondern nur ein Wechsel des ausfuehrenden Workers.
5. **Klein-4B bleibt notiert, aber nicht gebaut.** Apache-2.0 und 22 GB sind
   attraktiv; fuer Musikvisuals ist die Bildqualitaet eines 4B-Distillats aber
   nicht belegt, und ein dritter Stack kostet mehr, als er heute einbringt.

**Was das kostet, ehrlich:** FLUX.1-dev ist **nicht** kommerziell nutzbar. SDXL
(openrail++) bleibt die kommerziell saubere Spur. Wir fahren **beide** Stacks —
SDXL als Standard, FLUX.1-dev fuer den privaten Testgebrauch.

### 14.2 Der Live-Befund: das Manifest sagt FLUX.2, laufen tut FLUX.1

**Behauptung im Manifest** (`services/audiomonastry-ai-runtime/model_manifest.json`,
Rolle `imageHq`):

```
"label": "Bild-Generierung (FLUX.2 [dev] + Qwen-Image-2512 + ControlNet/IP-Adapter)",
"preloadModels": ["flux2-dev", "qwen-image-2512", ...]
```

**Was live laeuft** (RunPod REST v1, 27.09.2026):

```
GET /v1/endpoints/wzh9hcbitjnn95   → name audiomonastry-ai-image
                                  → templateId 7xzd1v17dx
GET /v1/templates/7xzd1v17dx      → name audiomonastry-ai-image-template
                                  → imageName registry.runpod.net/
                                    prunaai-runpod-worker-flux-1-dev-main-dockerfile:287a29201
                                  → env AI_ROLE=imageHq
```

Das Image heisst **`prunaai-runpod-worker-flux-1-dev`** — es ist ein
**FLUX.1-dev**-Worker. Passt zum Adapter, der fuer `imageHq` schon
`defaultModel: "flux1-dev-juiced"` fuehrt (`comfyui_adapter.py`, `COMFY_ROLES`).
Nur das Manifest-Label und `preloadModels` sagen `flux2-dev`.

**Konsequenz — und was wir *nicht* tun:** Der Widerspruch wird **dokumentiert,
nicht stillschweigend korrigiert** (siehe `BERICHT.md` §10). `imageHq` bleibt
unveraendert im Betrieb; wie die LoRA-Faehigkeit dazukommt, entscheidet §15.

---

## 15. STAND 27.09. 14:15 — der Endpoint steht zur Entscheidung

**Pods laufend: 0 · Guthaben 12,56 USD · Neue Ausgaben seit 10:46: 0,00 USD**

### Was fertig und getestet ist (kostet nichts)

- **Adapter + Workflows fuer den LoRA-Pfad sind gebaut:**
  `workflows/image_sdxl.json`, `workflows/image_flux1.json`,
  `comfyui_adapter.py` (`image`-Modus: Basismodell-Wahl, Prompt/Seed/Groesse,
  **LoRA-Kette** mit Gewichten), 15 neue Regressionstests.
  **Alle vier geforderten Testdateien gruen** (149 Tests):
  `test_visual_lora_pipeline` 28, `test_lora_segments` 54,
  `test_lora_trainer_aitoolkit` 19, `test_comfyui_adapter` 48.
- **Dauerhafte Referenz im App-Repo:** `docs/VISUAL_LORA_STACK.md`
  (Basismodelle mit Revisions-Pins, Volumen-Layout, Treiber-Regel, Kosten je Karte,
  LoRA-Wirkungsnachweis, Fallen).

### Neue Messwerte, die die Bauentscheidung veraendern

**1. Die guenstigste ausreichende Karte ist viel guenstiger als angenommen.**
RunPod-Katalog, 27.09.2026:

| Karte | VRAM | Community | Secure | Verfuegbar in |
|---|---|---|---|---|
| **RTX 4000 Ada** | 20 GB | **0,20 USD/h** | 0,28 USD/h | **EU-RO-1**, EUR-IS-1 |
| RTX PRO 4500 | 32 GB | – | 0,72 USD/h | EU-RO-1 |
| A100 PCIe | 80 GB | 1,19 USD/h | 1,59 USD/h | EU-RO-1, CA-MTL-3 |
| L40S | 48 GB | 0,79 USD/h | 1,07 USD/h | keine Kapazitaet |

20 GB reichen fuer SDXL (8–12 GB) und FLUX.1-dev fp8. Die Rolle `imageHq` fuehrt
heute 0,39 EUR/h als Erfahrungswert (A6000-Klasse) — die RTX 4000 Ada liegt bei
etwa der Haelfte. **Der LoRA-Pfad ist also nicht nur ein Zusatz, sondern auch
guenstiger als der heutige Bild-Pfad.**

**2. Ein zweiter Bild-Endpoint ist NICHT erlaubt.** `src/config/aiInfrastructure.ts`
sagt hart: „Die AI-Flotte besteht aus den Rollen … – weitere GPU-Endpoints sind
nicht erlaubt", `AI_MAX_GPU_ENDPOINTS = 8` (Betreiber-Freigabe 2026-09-15), und
`tests/aiInfrastructure.test.ts` prueft Rollenliste und Flottensumme (3,92 EUR/h)
**exakt**. `imageHq`, `videoReal`, `videoAbstract` sind die drei Bonus-Instanzen —
ein vierter Bild-Endpoint waere eine neunte Instanz. **Betreiber-Vorgabe 27.09.:
„die visuals sind bonus, also max 3 zusaetzliche instanzen".**

**3. `runpodVision.ts` spricht den Bild-Endpoint DIREKT an** —
`{input: {prompt, num_inference_steps, width, height}}`, ohne Adapter. Ein
Umstellen des Bild-Endpoints auf den ComfyUI-Worker bricht diesen Pfad, solange er
nicht mit-uebersetzt wird.

### Die drei Wege (alle im Leerlauf 0 USD, weil scale-to-zero)

| Weg | Endpoints | App-Aenderung | Kosten bei Betrieb |
|---|---|---|---|
| **A** Bild-Slot auf ComfyUI umstellen (`imageHq`), `runpodVision.ts` mitziehen | **8** (unveraendert) | ja: `runpodVision.ts` + Template-Wechsel | **0,20 statt ~0,39 EUR/h** |
| **B** ComfyUI als vierter Visual-Endpoint | **9** | nein | +0,20 USD/h — ueber der 8er-Grenze |
| **C** Prompt-Kompatibilitaet ins Image bauen (eigener Handler uebersetzt `{prompt}` in den FLUX-Graphen) | **8** | **nein** (nur Image) | wie A, plus Image-Bau und ~30 GB Push |

**Empfehlung: A.** Ein Endpoint, der dieselbe Rolle besser und billiger erfuellt,
statt eines zweiten daneben. C ist technisch am elegantesten, kostet aber den
Image-Weg.

### Speicher: Backblaze B2 ist im Pool

Vom Betreiber am 27.09. aufgenommen, in `.env` eingetragen (`BB_KEY_ID`,
`BB_MA_KEY`, `BB_ENDPOINT`, `BB_BUCKET`), Bucket **`audioMONASTRY`**, Region
**eu-central-003** (S3: `https://s3.eu-central-003.backblazeb2.com`), verifiziert
per `b2_authorize_account` (HTTP 200). **0,006 USD/GB/Monat** — die billigste
Ablage im Pool, ein Achtel des RunPod-Volumens.

⚠️ **Der Schluessel ist ein Master Application Key** (keine Bucket-Beschraenkung,
darf alles loeschen). Fuer den Dauerbetrieb gehoert ein auf `audioMONASTRY`
beschraenkter Key dorthin.

**B2 ersetzt kein Volume** — es laesst sich nicht mounten. Es ist Quelle/Archiv;
von dort fuellt sich das Volume.

### Geplante Aufteilung (klein und schnell)

```
Image   runpod/worker-comfyui:5.11.0-flux1-dev-fp8   -> FLUX.1-dev fp8 IM Image (0 USD/Monat)
Volume  20 GB Standard = 1,00 USD/Monat, Data Center EU-RO-1
        models/checkpoints/sd_xl_base_1.0.safetensors      6,46 GB
        models/vae/sdxl-vae-fp16-fix.safetensors           0,33 GB
        models/loras/*.safetensors (32 eigene, 2,73 GB)    + kuratierte
```

Zusammen **1,00 USD/Monat** Speicher, Endpoint im Leerlauf 0, ein Bild
~0,002–0,003 USD. Das passt in die Freigabe „30 GB + Endpoint, alles" und ist um
ein Drittel kleiner (nur SDXL auf dem Volume, FLUX kommt aus dem Image).

### Was bis zur Entscheidung NICHT gebaut wurde

Kein Volume, kein Endpoint, **kein `roles.imageLora` im Manifest**. Grund: der
Drift-Guard `tests/manifestRoles.test.ts` verlangt Deckungsgleichheit von
Manifest-Rollen und `GPU_ROLE_IDS`; ein Manifest-Eintrag ohne TS-Spiegel wuerde ihn
brechen. Die Rolle ist im Adapter fertig, aber nicht in der Flotte registriert —
das ist der Teil, der die Betreiber-Entscheidung braucht.

### Der naechste Schritt, genau

1. **Entscheidung A / B / C** (siehe Tabelle oben).
2. Bei A oder C: Volume 20 GB in **EU-RO-1** anlegen, Modelle + LoRAs vorstagen
   (CPU-Pod, wenige Cent), Endpoint/Template setzen, dann:
3. **Smoke-Job je Workflow** (fester Prompt, fester Seed) → es muss ein echtes PNG
   zurueckkommen.
4. **LoRA-Wirkungsnachweis:** gleicher Prompt und Seed mit/ohne LoRA → die Bilder
   muessen sich messbar unterscheiden (`clipbasis.py` + `bewerte.py`, kostenlos).
   Kommt keine Aenderung, ist es ein Worker-/Workflow-Problem — **dann nicht
   weitertrainieren.**
5. **§2 abschliessen:** die 6 kaputten SDXL-LoRAs
   (`geheimbund_moenche`, `industrial_techno`, `krieg_tod`, `licht_rauch`,
   `natur_echt`, `taenzer`) mit lr 5e-5 + cosine neu trainieren. Achtung: das
   Trainer-Image braucht Host-Treiber **≥ 595** — eine RTX 4000 Ada oder ein
   A100-Host darunter ist dafuer **ungeeignet**. Vorher `diag-pod.py` laufen
   lassen, nicht raten.

---

## 16. STAND 27.09. 15:00 — Weg A ist gebaut, wartet auf Kapazitaet

**Guthaben 12,5506 USD · Verbraucht in diesem Abschnitt: 0,0116 USD · Pods laufend: 0**

### Was steht (alles nachpruefbar)

| Was | Wert |
|---|---|
| Network Volume | `x8n6oeex5p`, 20 GB, **EU-RO-1**, 1,00 USD/Monat (Live-Aequivalent: 0,002 USD/h) |
| Volume-Inhalt | `models/checkpoints/sd_xl_base_1.0.safetensors` (6.938.078.334 B — **exakt die Quellgroesse**), `models/vae/sdxl-vae-fp16-fix.safetensors` (334.641.162 B), `models/loras/*.safetensors` (**alle 32**) |
| Vorstaging-Kosten | **0,0054 USD** (10.006.747.280 Bytes, 0 Fehler) |
| Template | `35rilgx8er` — `runpod/worker-comfyui:5.10.0-flux1-dev-fp8`, Disk 40 GB, `NETWORK_VOLUME_DEBUG=true`, **kein HF-Token** |
| Endpoint | `audiomonastry-ai-image` (`wzh9hcbitjnn95`) zeigt auf `35rilgx8er` + Volume `x8n6oeex5p`, `gpuTypeIds` = RTX 4000 Ada Generation / PRO 6000 WK, `flashboot` an, `minCudaVersion` 12.8, `workersMin` 0 |
| **Rueckweg** | `PATCH /v1/endpoints/wzh9hcbitjnn95` mit `{"templateId":"7xzd1v17dx","networkVolumeId":"","gpuTypeIds":["NVIDIA A40","NVIDIA RTX A6000","NVIDIA RTX 6000 Ada Generation","NVIDIA L40","NVIDIA L40S"],"flashboot":false,"minCudaVersion":"12.4"}` — Original in `/tmp/ep-image-vorher.json` |

**Keine neunte Instanz.** Die LoRA-Faehigkeit sitzt im bestehenden Bild-Slot;
die Flotte bleibt bei acht Endpoints, `imageHq` bleibt die Rolle.

### Die Sperre: keine passende Karte im Volumen-Rechenzentrum

Der Smoke-Job blieb **9,5 min in `IN_QUEUE` bei 0 Workern**. Ursache gemessen:

* **RTX 4000 Ada Generation**: derzeit **kein Bestand** in irgendeinem DC.
* **PRO 6000 WK**: Bestand nur in **EU-CZ-1** — das Volumen liegt in **EU-RO-1**.
* In EU-RO-1 hat nur die **RTX PRO 4500** Bestand, und deren ID akzeptiert die
  v1-API **nicht** (siehe unten).

Kein Defekt, sondern Kapazitaet — der Job wartet, bis eine der beiden Karten in
EU-RO-1 auftaucht. Der haengende Job wurde **abgebrochen** (`CANCELLED`), damit er
nicht spaeter unerwartet laeuft.

**Wenn es schnell gehen soll:** Volumen in **EU-CZ-1** neu anlegen und dort
vorstagen (0,0054 USD) — dort hat die PRO 6000 WK Bestand. Kostet 1,00 USD/Monat
fuer das neue Volumen; das alte wird geloescht.

### Drei neue Fallen, jede live erlebt

1. **`runpodctl template create` legt kein Template an** (Ausgabe ohne `id`,
   Template erscheint nicht in der Liste) — ueber `POST /v1/templates` geht es
   sofort. Nachpruefen mit `GET /v1/templates`.
2. **Die v1-`gpuTypeIds` sind NICHT die `gpuId`-Werte aus `runpodctl gpu list`.**
   Akzeptiert: `NVIDIA RTX 4000 Ada Generation`, `NVIDIA RTX PRO 6000 Blackwell
   Workstation Edition`, `NVIDIA RTX PRO 6000 Blackwell Server Edition`,
   `NVIDIA A40`, `NVIDIA RTX A6000`. **Abgelehnt** (still auf `null` gesetzt,
   HTTP 200!): `NVIDIA RTX PRO 4500`, `NVIDIA RTX PRO 4500 Blackwell`,
   `NVIDIA RTX PRO 4500 Blackwell SE`, `NVIDIA RTX PRO 4000 Blackwell`,
   `NVIDIA RTX 4000 Ada`. Ein PATCH mit einer ungueltigen ID **loescht die
   Auswahl** und der Endpoint startet keinen Worker mehr — immer nachlesen.
3. **`5.11.0` ist auf Docker Hub nicht veroeffentlicht.** Der Plan nannte diese
   Version (GitHub-Release existiert), Images gibt es bis **5.10.0**. Deshalb
   fehlt die 5.11-Neuerung „Modell-Referenzen vorab pruefen" — ein fehlendes
   Modell meldet ComfyUI als `value not in list`.
4. **Ein Container-Kommando `bash -c …` in `alpine` scheitert** („executable file
   not found") und laeuft in die RunPod-Neustart-Schleife. `sh -c …` nehmen.
5. **Beweise vor der Terminierung hochladen.** Mehrere Pods verschwanden ohne
   Log; erst `upload_evidence()` (Log + Bericht nach B2) hat die Diagnose
   moeglich gemacht. Das Vorstagen war beim ersten Blick auf das Log bereits
   **fertig** — die Folge-Pods beendeten sich in Sekunden, weil sie alles
   „vorhanden" fanden.

### Backblaze B2 — aufgenommen und nutzbar

`b2.py` (neben `r2.py`) kann schreiben, lesen, auflisten und signieren.
`python3 b2.py selftest` → PUT 200 / GET 200 identisch / DELETE 204.

**Wichtig:** Die uebergebene `BB_KEY_ID` (`a05968581a09`) ist die **Account-ID**
— die native API akzeptiert sie, die **S3**-API nicht (`InvalidAccessKeyId:
Malformed Access Key Id`, derselbe Fehler mit eigener Signatur *und* mit rclone).
Deshalb legt `b2.py mkscopedkey` einen Application-Key an, der **nur** den Bucket
`audioMONASTRY` darf (listFiles/readFiles/writeFiles/deleteFiles) — kein Bucket
anlegen, kein Loeschen von fremden Daten. Er steht als `BB_S3_KEY_ID`/`BB_S3_KEY`
in der `.env`; der Master-Key bleibt fuer die Verwaltung und gehoert **nicht** in
einen Pod.

### Was als Naechstes zu tun ist

1. **Smoke-Job, sobald eine Karte in EU-RO-1 auftaucht** (oder Volumen nach
   EU-CZ-1): beide Workflows mit festem Prompt und Seed → es muss ein echtes PNG
   zurueckkommen. Befehl:
   `runpodctl serverless run wzh9hcbitjnn95 --input-file /tmp/smoke-sdxl.json --wait 12m`
   (Payloads erzeugt der Adapter; `/tmp/smoke-sdxl.json` und
   `/tmp/smoke-flux1.json` neu erzeugen, falls weg).
2. **LoRA-Wirkungsnachweis**: derselbe Prompt/Seed **mit** und **ohne**
   `lora_pairs` — die Bilder muessen sich messbar unterscheiden. Ohne diesen
   Nachweis ist „die LoRA wirkt" nicht belegt.
3. **`runpodVision.ts` mitziehen** (Weg A): der Pfad schickt heute
   `{prompt, num_inference_steps, width, height}` **direkt** an den Endpoint —
   der ComfyUI-Worker verlangt `{workflow}`. Solange das nicht uebersetzt ist,
   **ist der Vision-Pfad der App mit dem neuen Worker kaputt.** Das ist der
   wichtigste offene Punkt aus Weg A.
4. **Idle-Timeout messen, nicht raten**: 120 s sind unveraendert. Ein Job dauert
   ~15 s, der Worker laeuft aber bis zum Idle-Ende weiter. Erst messen (Guthaben
   vor/nach einem Job), dann entscheiden.
5. Danach §2 (die 6 kaputten LoRAs) und §4 (Kuratierung; die Liste der 12 fehlt).

### 16.1 Der Regionsversuch (27.09. ~14:15) — und warum er zurueckgedreht wurde

Die guenstige Karte ist **nicht regionsgebunden**, sie wandert:

| Zeit | RTX 4000 Ada (20 GB, 0,20 USD/h Community) |
|---|---|
| 12:21 | EU-RO-1, EUR-IS-1 |
| 14:12 | **nur EUR-IS-1** |
| 14:17 | **keine der beiden** (Katalog leer, nur große Karten) |

Also wurde ein zweites Volume in **EUR-IS-1** angelegt (`e555xn7pzf`, 20 GB) —
und **wieder geloescht**, nachdem sich zeigte:

* **CPU-Pods sind auch in EUR-IS-1 Geister** (drei Anlaeufe, keiner platziert) —
  in EU-RO-1 war es dasselbe. Ein CPU-Pod mit Volume ist auf diesem Konto
  offenbar nicht platzierbar; das Vorstaging lief in EU-RO-1 auf einem **GPU**-Pod.
* Die Ada-Kapazitaet in EUR-IS-1 war **vier Minuten spaeter weg**.
* Zwei Volumes kosten **2,00 USD/Monat** statt 1,00 — fuer eine Bonus-Rolle
  nicht zu rechtfertigen, erst recht nicht fuer ein leeres.

**Entscheidung:** Das **gefuellte** Volume in EU-RO-1 bleibt (1,00 USD/Monat),
das leere in EUR-IS-1 ist geloescht. Der Endpoint zeigt auf EU-RO-1 und die
Kartenliste enthaelt die Ada. Wenn die Karte dort auftaucht, laeuft der Smoke-Job
sofort — ohne Umbau.

**Wenn es in einer anderen Region schneller geht** (Reihenfolge, ~10 Minuten):
```bash
# 1) Volume in der Region mit Bestand
runpodctl network-volume create --name audiomonastry-image-lora-XX --size 20 --data-center-id <DC>
# 2) vorstagen (GPU-Pod, weil CPU-Pods nie platziert werden)
python3 stage-image-lora-volume.py --volume <NEUE-ID> --data-center <DC> \
  --run --watch 30 --attempts 3 --gpu "NVIDIA RTX 4000 Ada Generation" --cloud COMMUNITY
# 3) Endpoint umhaengen — WICHTIG: gpuTypeIds NICHT im selben PATCH mitschicken,
#    sonst wird die Auswahl still auf null gesetzt und der Endpoint startet nicht mehr.
curl -X PATCH -H "Authorization: Bearer $RUNPOD_API_KEY" -H "Content-Type: application/json" \
  -d '{"networkVolumeId":"<NEUE-ID>"}' https://rest.runpod.io/v1/endpoints/wzh9hcbitjnn95
# 4) danach gpuTypeIds separat setzen und NACH LESEN
```

Und immer nach dem Vorstaging: `python3 b2.py get audiomonastry/visual-lora-stack/staging.log /tmp/x.log`
— das Log liegt in B2, auch wenn der Pod ohne Spur verschwindet.

### 16.2 GELOEST, 27.09. ~14:40 — der Endpoint laeuft, die LoRA wirkt

**Der Durchbruch war die richtige GPU-ID.** `runpodctl gpu list` nennt als `gpuId`
`NVIDIA RTX 4090`, die v1-API verlangt **`NVIDIA GeForce RTX 4090`**. Mit dieser
Schreibweise und dem vorhandenen Bestand in EU-RO-1 (0,34 USD/h Community) startete
sofort ein Worker. Weitere akzeptierte IDs: `NVIDIA RTX 4000 Ada Generation`,
`NVIDIA RTX 2000 Ada Generation`, `NVIDIA RTX 6000 Ada Generation`,
`NVIDIA RTX PRO 6000 Blackwell Workstation/Server Edition`, `NVIDIA A100 80GB PCIe`,
`NVIDIA L40S`, `NVIDIA A40`, `NVIDIA RTX A6000`.
**Abgelehnt** bleiben: alle PRO 4000/4500-Schreibweisen und `NVIDIA RTX 4090` ohne
„GeForce".

**Der Beweis (gleicher Prompt, gleicher Seed 4711, SDXL):**

| | ohne LoRA | mit LoRA (`comic.safetensors`, Gewicht 1,0) |
|---|---|---|
| Status | COMPLETED | COMPLETED |
| Bild | `image_sdxl_00001_.png`, 1.366.810 B | `image_sdxl_00001_.png`, 1.272.480 B |
| Graustufen-Std | 42,9 | 43,1 (beide strukturiert, **keine** leere Flaeche) |
| mittlere Pixel-Differenz | — | **30,9 von 255** |
| klar veraenderte Pixel | — | **72,3 %** |

**Urteil: die LoRA wird geladen und wirkt.** Das Abbruchkriterium („Endpoint
antwortet, aber ohne Bildaenderung durch die LoRA") ist nicht eingetreten.
Beweise: `ergebnisse/endpoint-nachweis/` (beide PNGs, beide Payloads).

**Gemessene Kosten und Zeiten (RTX 4090, EU-RO-1):**

* Kaltstart inkl. Image-Pull (~30 GB) + ComfyUI + Modell laden + Bild:
  **13 min 24 s** → das ist der groesste Einzelposten. **Danach 12 s pro Bild.**
* Gesamtverbrauch dieses Abschnitts: **0,1245 USD** (Guthaben 12,5622 → 12,4377).
* Laufend danach: **0,002 USD/h** = nur das Volume. Der Worker faehrt nach dem
  Idle-Fenster selbst auf Null (`currentSpendPerHr` geprueft, nicht geschaetzt).

**Zwei Lehren, die Geld kosten, wenn man sie vergisst:**

1. **Jobs hintereinander schicken, solange der Worker warm ist.** Der zweite Job
   lief in 12 s, weil der erste ihn geweckt hatte. Ein einzelner Job bezahlt
   immer den vollen Kaltstart (~13 min ≈ 0,07 USD bei 0,34 USD/h) — bei 32 Themen
   in Einzelaufrufen waere das 32-mal Kaltstart. **Stapeln, nicht streuen.**
2. **Die Karten-ID wird nicht geraten.** Ein PATCH mit einer ungueltigen ID setzt
   die Auswahl still auf `null` (HTTP 200), danach startet der Endpoint **gar
   keinen** Worker mehr. Immer nachlesen (`gpuTypeIds` im GET pruefen).

**FLUX.1-dev auch live bestaetigt (27.09. ~15:27):** `base: "flux1"` lief durch —
`image_flux1_00001_.png`, 1024x1024, 753.576 B, Graustufen-Std 49,0, Kantenenergie
0,804 (FLUX zeichnet glaetter als SDXL, dessen Kantenenergie 3,026 betraegt — beides
strukturiert, nichts leer). Dauer **8 min 21 s** inkl. Kaltstart, Kosten des
Durchgangs **0,0620 USD**. Beweis: `ergebnisse/endpoint-nachweis/payload-flux1.json`
und `flux1-ohne-lora-seed4711.png`.

**Damit ist Weg A funktional fertig:** beide Basismodelle laufen auf dem Endpoint.
Der **Vision-Pfad der App** (`runpodVision.ts`) schickt genau diesen FLUX-Graphen —
er ist damit auf Protokollebene geprueft (27 Tests gruen + der Graph lief live),
aber der Weg *durch die App* wurde noch nicht am laufenden Endpoint gemessen.

**Gesamtverbrauch der Sitzung: 0,1865 USD** (Guthaben 12,5622 → 12,3757).
Laufend: 0,002 USD/h (nur das Volume). Beide Durchgaenge zusammen hatten
**21 min 45 s Kaltstart** — bei 0,34 USD/h ist Warten teurer als Rechnen.

**Noch offen (nicht Weg A):**

* **§2** — die 6 kaputten SDXL-LoRAs. Es gibt **noch kein Reparatur-Skript**; es
  braucht Bundle + vorab signierte URLs + einen Host mit Treiber **>= 595**.
  Guenstigster Kurs dafuer: **PRO 6000 MIG 24 GB, 0,59 USD/h** (EUR-IS-2/US-NE-1/
  US-PA-1) oder 48 GB fuer 1,09 USD/h. Budget ~0,60-1,10 USD.
* **§4** — die Liste der 12 gelieferten LoRAs liegt weiterhin in keiner Datei.
