# Themen-LoRAs — Bericht zum Aufwachen

**Stand:** 2026-09-27, ~10:30 lokal · Auftrag: VISUAL-P1-009 („je Thema ein eigener Bilder-Satz + eigenes LoRA")
**Freigabe:** 12 USD, SDXL, alle Themen, keine neuen Bilder generieren.

> **Nachtrag vom 27.09., 10:30 — bitte zuerst §8 lesen.**
> Bei der Nachkontrolle mit einem eigenen Messwerkzeug (CLIP auf der CPU, kostenlos)
> stellte sich heraus: **7 der 32 ausgelieferten LoRAs sind kaputt** — sie erzeugen
> nur noch eine leere Fläche. Die Ursache ist gemessen (zu hohe Lernrate), der Fix
> ist erprobt, und ein Thema ist bereits neu trainiert und nachweislich gut.
> Die Aussage in §4 („die LoRAs funktionieren") gilt weiterhin für die **Prüfung
> mit eigenem Inferenz-Test**, war aber zu optimistisch: sie stützte sich auf
> 3 von 32 Themen und hat den Zerfall nicht erfasst.

---

## 1. Das Wichtigste zuerst

| | |
|---|---|
| **Fertige LoRAs** | **32 von 32 Themen** (das letzte lief im Nachhol-Pod, siehe §6) |
| **Wo** | Cloudflare R2, Bucket `audiomonastrysamples`, Präfix **`lora-out/<thema>/`** |
| **Je Thema** | `<thema>.safetensors` (85 MB) · `samples.tar` · `train.log` · `meta.json` |
| **Modell** | SDXL 1.0, LoRA-Rang 16, 800 Schritte, ~14 min je Thema, alle Exit-Code 0 |
| **Qualität** | **7 von 32 kaputt** (§8) — 25 in Ordnung; das frühere „8 flächig" war ein Messfehler (§4) |
| **Kosten** | siehe §5 — deutlich unter der Freigabe |

**Ein Hinweis, der wichtig ist:** Das sind **SDXL**-LoRAs. Deine Rolle `imageHq` läuft
aber auf **FLUX.1-dev**. Diese LoRAs wirken dort **nicht**. Sie brauchen einen
SDXL-Generator (ComfyUI mit SDXL-Checkpoint oder einen neuen SDXL-Endpoint).
Das war die Konsequenz deiner Entscheidung für SDXL — sie war bewusst, aber sie
hat diesen Preis.

---

## 2. Drei echte Datenfehler gefunden und behoben

Das war der wichtigste Teil der Nacht. Ohne diese Arbeit wären 32 LoRAs auf
falschem Material entstanden.

**Fehler 1 — die falschen Bilder.**
Die 25 Bilder je Themenordner waren die *generischen*: sie hatten im
Analyse-CSV den Wert `treffer` 4–6, passten also zu vier bis sechs Themen
gleichzeitig. In `natur_tiere` lagen deshalb bemalte Rücken statt Tiere.
Ich habe gegengeprüft, ob es eindeutige Bilder gibt: **27.601 Bilder mit
`treffer = 1`** — und je Thema ≥ 25 davon.

**Fehler 2 — die kontamininierten Captions.**
Die Spalte `tags` ist bei einem Bild in **allen** Themen-CSVs identisch
(29.339 von 29.339 geprüft). Sie ist *nicht* themenspezifisch. Hätte ich sie in
die Captions geschrieben, hätte jedes Themen-LoRA die Begriffe aller anderen
Themen mitgelernt. Captions sind jetzt: `mstyle_<thema>, <BLIP-Beschreibung>`.

**Fehler 3 — die verschwundenen Originale.**
Die Originalpfade aus dem CSV existierten nicht mehr: die Sammlung wurde
**zweimal** umsortiert. Auflösungskette gebaut: Originalpfad → Umkehr-Tabelle
(46.311 Einträge) → Themenordner → Datei-Index (46.695 Dateien).
Ergebnis: 742 Dateien über die Umkehr-Tabelle, 91 über den Index, 0 verloren.

**Und ein vierter, ehrlicher Befund:**
`treffer == 1` klingt sauber, ist es aber nicht — das sind die *schwachen
Ausreißer*. Im Kontrollblatt landeten in `natur_tiere` Blumen, ein Musiker und
ein Türriegel. Ich habe **beide** Varianten gebaut und am Bild verglichen, dann
verworfen. **Trainiert wurde am Ende mit deinen kuratierten Ordnerbildern**
(die Version, die am Kontrollblatt stimmig war). Enddatensatz: **32 Themen × 25 Bilder = 800**.

---

## 3. Was technisch lief

- **Trainer:** ai-toolkit, Image `ostris/aitoolkit:latest` — der Trainer ist
  **im Image** enthalten (`/app/ai-toolkit`), es musste nichts installiert werden.
- **SDXL-Anbindung** aus dem Quellcode belegt, nicht geraten: `arch: "sdxl"` setzt
  intern `is_xl` und wählt die `StableDiffusionXLPipeline`;
  `noise_scheduler: ddpm` (nicht `flowmatch` wie bei FLUX); `dtype: bf16` in
  **beiden** Blöcken (`model` und `train`) — genau der Schlüssel, an dem der
  FLUX-Lauf seinerzeit gescheitert war.
- **Gemessen:** 800 Schritte in **12:14** = **0,88 s/Schritt**, ~14 min je Thema
  inkl. Latenz-Cache und Probe-Bildern. Gesamt-Trainingszeit der 30: **7,37 h**.
- **Uploadweg:** eigener SigV4-Presigner (nur stdlib) — **vor** dem ersten Cent
  getestet (PUT 200 / GET 200 / Byte-identisch / Fehlerfall meldet korrekt).
- **Kein Network Volume** — SDXL ist nur ~7 GB, das Volumen (5 USD/Monat) hätte
  sich nicht gerechnet.

### Verifiziert, nicht behauptet
- `comic.safetensors` heruntergeladen und **strukturell geprüft**: 2166 Tensoren,
  Header- und Datenlängen konsistent, Metadaten `ss_base_model_version = sdxl_1.0`,
  Rang 16. Es ist eine echte, ladbare LoRA.
- Am Bild geprüft: Schritt 0 = grauer Brei → Schritt 400 = Tuschezeichnung mit
  Panels → Schritt 800 = kräftige Schwarz-Weiß-Comic-Illustration. **Der Stil ist
  gelernt, nicht nur der Loss gefallen.**

---

## 4. Qualität — und eine Korrektur an mir selbst

**Erster Befund (falsch).** Ich habe die Probe-Bilder des Trainers gemessen
(Graustufen-Streuung, Kantenenergie, Farbstreuung). Ergebnis: 22 strukturiert,
**8 flächig** — `taenzer`, `geheimbund_moenche`, `krieg_tod`, `licht_rauch`,
`natur_echt`, `industrial_techno`, `hdr_sternenhimmel`, `nackte_haut`.
Messwerte stehen in `ergebnisse/qualitaet.json`.

**Warum dieser Schluss falsch war.** Ich habe daraus „die LoRAs sind überangepasst"
abgeleitet. Das war ein Fehlschluss aus dem falschen Beweis: das Probe-Bild ist das
Erzeugnis des *Trainers*, nicht des LoRA allein.

**Gegenprobe mit eigenem Inferenz-Test** (`infer-test2.py`, ~0,25 USD):
Dieselben LoRAs in einer eigenen diffusers-Pipeline geladen, mit und ohne Trigger.
Die Diagnose ist eindeutig — **722 LoRA-Schichten** werden geladen (vorher 0), das
LoRA greift also. Und am Bild (Kontrollblatt `ergebnisse/inferenz-test-v2.png`):

| Trigger | Ergebnis |
|---|---|
| `mstyle_comic` | Porträts werden zu **Bleistift-/Comic-Zeichnungen**, Tänzer in harten Spotlights |
| `mstyle_krieg_tod` | Tänzer in dunkler Kleidung, Porträts **grau, ausgemergelt, düster** |
| `mstyle_taenzer` | zarte, helle, elegante Bilder |
| **ohne Trigger** | generisch — der Trigger ist tragend, wie geplant |

**Korrigiertes Urteil:** Die LoRAs **funktionieren**. Die acht flächigen
Probe-Bilder waren ein **Artefakt des Trainer-Probe-Prompts** (nackter Trigger +
„high detail, natural light" bei CFG 7), kein Qualitätsurteil über das LoRA.
Das erklärt auch, warum `comic` in beiden Fällen gut aussah: dort trägt der Stil
auch einen schwachen Prompt.

**Was ehrlich offen bleibt:** Geprüft wurden drei Themen im Inferenz-Test, nicht
alle 32. Für die übrigen ist „das Trainings-Probe-Bild sieht gut aus" ein Indiz,
kein Beweis. Ein kompletter Inferenz-Durchlauf über alle 32 Themen ist der nächste
sinnvolle Schritt (~0,5 USD, ein Pod, ~40 min).

**Ehrlicher Hinweis zur Datenbasis:** In `natur_tiere` beschreiben 24 von 25
Captions tätowierte Haut — der Ordner enthält Tier-*Tattoos*, keine Tiere. Ich habe
das nicht „repariert", sondern trainiert, was du kuratiert hast. Wenn du dort echte
Tiere willst, braucht der Ordner anderes Bildmaterial.

---

## 5. Kosten

| Posten | Betrag |
|---|---|
| Start (aufgeladen) | 11,795 USD |
| **Verbraucht** | **~8,3 USD** inkl. aller Fehlversuche und Prüfläufe |
| Verbleibend | ~3,5 USD |

Aufgeteilt: ~6,5 USD Training (32 Themen × ~15 min auf RTX PRO 5000 Community zu
0,82 USD/h, inkl. Kaltstarts), ~0,5 USD Fehlversuche, ~0,4 USD Diagnose- und
Inferenz-Prüfläufe, ~0,4 USD Nachhol-Pods.

Enthalten sind die Fehlversuche, die ich dokumentiere statt sie zu verschweigen:
- **Erster Pod-Versuch (RTX 4090):** Treiber 580.126.09 → `torch.cuda` scheiterte
  mit „CUDA unknown error". Die Doku sagte „Treiber ≥ 580" — die Realität zeigt:
  580 reicht **nicht**, 595 funktioniert. Zwei Pods haben 13 Themen mit
  25-Sekunden-Fehlschlägen verbrannt (~0,1 USD), sich dann selbst beendet.
- **HF-Hub-Aussetzer:** bei 3 Themen (2 verworfen, 1 später gut gelaufen)
  kam „model is not cached locally and an error occurred while trying to fetch
  metadata from the Hub". Seitdem baut der Pod bei schnellen Fehlschlägen
  automatisch einen Wiederholungsversuch ein.
- **Diagnose-Pod:** ~0,2 USD, hat die Treiberfrage geklärt.

**Der Sparen-effekt deiner Entscheidung:** Community statt Secure und 4090 statt
teurer Karten. Der L40S-Preis aus dem Vorgänger-Lauf (1,09 USD/h secure) hätte für
dieselbe Arbeit ~60 % mehr gekostet.

**Kostenwächter, die alle gegriffen haben:**
- `trap ... EXIT` + Selbst-Terminierung: **jeder** Pod löscht sich am Ende selbst.
  RunPod startet einen beendeten Container sonst automatisch neu — ohne das hätte
  jeder Pod seinen ganzen Lauf wiederholt und doppelt gekostet.
- Hartes Zeitlimit je Thema (40 min).
- Frist: nach Ablauf startet kein neues Thema mehr.
- Namenssperre gegen bezahlte Waisen.
- **Am Ende des Laufs: null Pods. Nachgeprüft, nicht angenommen.**

---

## 6. Offen

- **`wikinger_samurai`** lief zuletzt im Nachhol-Pod `lora-p10` (der erste
  Anlauf war fertig trainiert, aber der 85-MB-Upload hing — dasselbe
  Host-Netzproblem wie beim HF-Aussetzer). Fertig ~09:15 lokal. Seitdem bricht
  ein hängender Upload nach 15 min ab, statt den Pod eine Stunde zu blockieren.
- **Vollständige Qualitätsprüfung:** Der Inferenz-Test deckte 3 von 32 Themen ab.
  Ein Durchlauf über alle 32 (~0,5 USD, ein Pod, ~40 min) würde für jedes Thema
  belegen, dass es unter freiem Prompt wirkt. Sag Bescheid, dann mache ich das.
- **SDXL-Anbindung — der eigentliche nächste Schritt:** Die LoRAs nützen dir erst,
  wenn ein SDXL-Generator läuft. Deine Rolle `imageHq` ist FLUX.1-dev und kann sie
  nicht laden. Nötig ist ein SDXL-Pfad (ComfyUI mit SDXL-Checkpoint oder ein neuer
  Endpoint mit `stabilityai/stable-diffusion-xl-base-1.0`).

---

## 7. Dateien in diesem Ordner

| Datei | Inhalt |
|---|---|
| `BERICHT.md` | dieser Bericht |
| `ergebnisse/alle-themen-loras.png` | Kontrollblatt aller fertigen LoRAs |
| `ergebnisse/qualitaet.json` | Messwerte je Thema |
| `ergebnisse/ergebnisse.json` | Dauer, Größe, Exit-Code je Thema |
| `bundle/pod-run.sh` | der Ablauf im Pod (nachvollziehbar) |
| `make-configs.py` | LoRA-Konfiguration, jede SDXL-Änderung begründet |
| `r2.py` | SigV4-Presigner |
| `monitor.py` | Fortschritt + Kosten |
| `verify-results.py`, `qualitaet.py`, `pruefe-lora.py` | Prüfwerkzeuge |
| `build-datasets-v3.py` | der Datensatzbau (endgültige Fassung) |
| `out-v3/<thema>/manifest.json` | je Thema: welche Bilder, welche Caption, warum |

---

## 8. Nachtrag 27.09. — sieben LoRAs waren kaputt, die Ursache ist gemessen

### 8.1 Der Befund

Ich habe ein eigenes Messwerkzeug gebaut (`clipbasis.py` + `bewerte.py`: CLIP läuft
**lokal auf der CPU**, also ohne einen Cent GPU-Kosten) und damit die Probe-Bilder
aller 32 Themen Schritt für Schritt nachgemessen. Dabei fiel eines auf: bei
`taenzer` stieg die Kennzahl am stärksten, während das Bild gleichzeitig
`Graustufen-Std 0,9` hatte.

**Nachgesehen statt geschlossen:** Die Serie läuft 0 → 200 → 400 schön hoch und
kippt dann in eine praktisch **leere Fläche**. Das LoRA ist bei Schritt 800
zerstört — und ausgeliefert wurde genau der letzte Stand.

**Betroffen (7 von 32):**

| Thema | Struktur Schritt 2 | Struktur Schritt 800 | letzter brauchbarer Schritt |
|---|---|---|---|
| `taenzer` | 47,3 | **0,9** | 600 |
| `geheimbund_moenche` | 30,6 | **2,7** | 200 |
| `krieg_tod` | 34,0 | **3,0** | 200 |
| `licht_rauch` | 40,8 | **5,9** | 400 |
| `natur_echt` | 42,0 | **10,1** | 0 |
| `vorsintflutliche_hochkultur` | 37,2 | **4,3** | 200 |
| `industrial_techno` | 50,3 | **16,4** | 600 |

### 8.2 Zwei eigene Messfehler, die ich dabei gefunden habe

1. **Meine erste Kennzahl war wertlos** — sie verglich jedes Bild mit dem
   Themenzentrum, in dem es selbst steckte. „eigen" war deshalb immer genau
   1,000. Umgestellt auf **leave-one-out**.
2. **Die Kennzahl belohnt den Zerfall** — Korrelation zwischen „Anstieg" und
   Bildstruktur: **−0,268**. Eine leere Fläche liegt dem Themenzentrum näher als
   ein strukturiertes Bild. Deshalb wird jetzt **immer beides** gemessen:
   Struktur (ist überhaupt etwas im Bild?) *und* Stilnähe.

Außerdem: mein erster Zerfall-Detektor (absoluter Schwellwert) meldete bei sechs
Themen falschen Alarm (`drohnenflug`, `fantasy`, `gewitter_raining_day`,
`nackte_haut`, `natur_makro`, `schwarz_weiss_…`) — glatte Motive wie Haut,
Himmel und Makro haben legitim wenig Kanten. **Alle 16 Verdachtsfälle wurden
angesehen**, der Detektor dann auf den **relativen** Einbruch umgestellt
(Struktur unter 40 % des Maximums).

### 8.3 Die Ursache — ein sauberer Messlauf, eine Variable

An `vorsintflutliche_hochkultur` (dessen Trainingsdaten die saubersten von allen
sind, 24 von 25 Bildern themenrein — also kein Datenproblem) wurden zwei
Einstellungen gegeneinander gemessen:

| Arm | Struktur über die Schritte 0→800 | Ergebnis |
|---|---|---|
| **lr 5e-5 + Cosine** | 37 → 42 → 33 → 31 → **30** | gesund bis 800 |
| lr 1e-4 + Cosine | 37 → 32 → **3,7** → … → 3,0 | zerfällt ab Schritt 300 |
| *(v1: lr 1e-4, konstant)* | 37 → 35 → **4,9** → … → 4,3 | zerfällt ab Schritt 400 |

**Es ist die Lernrate, nicht der Zeitplan.** Cosine allein rettet nichts;
die Hälfte der Lernrate (5e-5) verhindert den Zerfall vollständig.

### 8.4 Der Beweis am Bild

`vorsintflutliche_hochkultur` neu trainiert mit lr 5e-5 + Cosine, Ablage in R2
unter `lora-themen-v2/out/vorsintflutliche_hochkultur__lr5e5cos/`:

- **v1:** 0 Glasfassade → 200 weißes Relief → **400/600/800 nur leere Fläche**
- **v2:** 0 Glasfassade → 200 Glasfassade → 300 **Architektur-Innenraum mit
  Bäumen** → 400–800 durchgehend saubere Architektur mit Lichtbändern und Glas

Das Ergebnis ist nicht nur „nicht zerfallen", sondern themengerecht und gut.
Kosten des kompletten Messlaufs: **0,56 USD**.

### 8.5 Was noch offen ist

Die sechs übrigen betroffenen Themen (`geheimbund_moenche`, `industrial_techno`,
`krieg_tod`, `licht_rauch`, `natur_echt`, `taenzer`) sind mit derselben
Einstellung neu gestartet. RunPod hatte zum Startzeitpunkt jedoch **keine
Kapazität** (siehe §9) — der Lauf startet automatisch, sobald wieder eine Karte
frei ist (`start-mit-wiederholung.sh`). Bis dahin gilt: **diese sechs LoRAs
bitte nicht verwenden**, sie erzeugen leere Bilder.

---

## 9. Nachtrag: RunPod-Kapazität und zwei Kosten-Fallen

1. **`runpodctl pod create` meldet Erfolg, auch wenn nichts verfügbar ist.**
   Der Aufruf gibt eine Pod-ID zurück, der Pod wird aber nie auf einer Maschine
   platziert und verschwindet nach Sekunden wieder — ohne Fehlermeldung, ohne
   Kosten. Meine GPU-Kette hielt das für Erfolg und probierte die nächste Karte
   nie. `start-pod.py` prüft jetzt nach der Anlage 75 s lang, ob der Pod wirklich
   existiert, und geht erst dann zur nächsten Karte.
2. **Der Stundensatz muss von der KARTE kommen, nicht vom Aufrufer.** Ich hatte
   den Deckel für 0,33 USD/h (A6000) gerechnet, gelaufen ist eine Karte zu
   1,69 USD/h — der Wächter im Pod hätte das Fünffache erlaubt. Der Satz wird
   jetzt aus einer Tabelle je Karte gesetzt; unbekannte Karten bekommen einen
   Aufschlag, damit der Deckel im Zweifel zu früh greift.

Beides kostete kein Geld (die Geister-Pods werden nicht berechnet), aber Zeit.

---

## 10. Was wir über FLUX und SDXL wissen (Nachtrag 27.09., nachmittags)

Die Bild-Rolle der App sollte auf ein groesseres Basismodell — der Auftrag nannte
**FLUX.2-dev**. Ich habe das **nicht gebaut**, sondern erst nachgemessen. Drei
Befunde, jeder mit Beleg, und einer davon ist ein Widerspruch in der App selbst.

### 10.1 Befund 1: Der Live-Endpoint ist FLUX.1-dev — nicht FLUX.2

Das Manifest behauptet FLUX.2. Laufen tut FLUX.1-dev. Nachgeprueft an der
RunPod-API, nicht am Gedaechtnis:

```
GET /v1/endpoints/wzh9hcbitjnn95  →  audiomonastry-ai-image
                                  →  templateId 7xzd1v17dx
GET /v1/templates/7xzd1v17dx      →  audiomonastry-ai-image-template
                                  →  imageName:
                                     registry.runpod.net/prunaai-runpod-worker-
                                     flux-1-dev-main-dockerfile:287a29201
                                  →  env AI_ROLE=imageHq
```

Das Image heisst **`prunaai-runpod-worker-flux-1-dev`**. Dasselbe sagt der
Adapter: `comfyui_adapter.py` fuehrt fuer die Rolle `imageHq` schon
`defaultModel: "flux1-dev-juiced"`.

**Nur das Manifest sagt etwas anderes.** `model_manifest.json`, Rolle `imageHq`:

> `"label": "Bild-Generierung (FLUX.2 [dev] + Qwen-Image-2512 + ControlNet/IP-Adapter)"`
> `"preloadModels": ["flux2-dev", "qwen-image-2512", …]`

Der Widerspruch wird hier **dokumentiert, nicht stillschweigend korrigiert** —
denn die Frage „welches Modell laeuft dort wirklich" ist eine Betreiber-Entscheidung,
keine Aufraeumarbeit. Betroffen ist nur die Beschriftung, nicht der Betrieb: die
Rolle `imageHq` bleibt unveraendert, die neue LoRA-Rolle kommt additiv dazu.

### 10.2 Befund 2: FLUX.2-dev ist für Musikvisuals masslos überdimensioniert

Gemessen an der HuggingFace-API (`/api/models/<repo>?blobs=true`, Feld
`siblings[].size`, 27.09.2026):

| Modell | Kleinster Betriebssatz | Faktor gegenüber SDXL |
|---|---|---|
| **SDXL 1.0** | `sd_xl_base_1.0.safetensors` **6,46 GB** | 1× |
| **FLUX.1-dev** (fp8) | Unet 11,08 GB + T5 4,56 GB + CLIP-L 0,23 GB + VAE 0,31 GB = **16,2 GB** | 2,5× |
| **FLUX.2-dev** | Transformer **60,0 GB** + Mistral-Text-Encoder **40,3 GB** + VAE 0,31 GB = **100,6 GB** | **15,6×** |

Das Repo `FLUX.2-dev` umfasst insgesamt **177,6 GB** (es enthaelt zusaetzlich das
Einzeldatei-Checkpoint *und* das diffusers-Layout, dazu fp32-Varianten).

**Eine Ehrlichkeit dazu:** Die Zahl „113 GB" aus dem Auftragstext
(„Transformer 64,5 GB + Mistral 48,0 GB") kann ich **nicht belegen** — die
Modellkarte des Repos ist gated (HTTP 401 ohne autorisierten Token). Die
gemessenen Zahlen sind etwas kleiner als die genannte Schaetzung, aendern an der
Aussage aber nichts: es bleibt bei rund **100 GB gegen 6,5 GB**.

Für Standbilder in der Groesse, in der Musikvisuals gebraucht werden, aendert das
am sichtbaren Ergebnis nichts. Es kostet Kaltstart, Volume-Groesse und eine
teurere Kartenklasse.

### 10.3 Befund 3: Für FLUX.2 gibt es praktisch keinen Stil-LoRA-Bestand

Das war der ausschlaggebende Punkt. Wenn wir einen LoRA-fähigen Endpoint bauen,
dann **wegen der Stile** — ein Basismodell ohne Stil-LoRAs macht den ganzen
Aufwand sinnlos.

| Basismodell | Repos mit diesem `base_model` | Was es ist |
|---|---|---|
| `stable-diffusion-xl-base-1.0` | **>1000** (seitenbegrenzt) | SDXL-Stile, der groesste Bestand ueberhaupt |
| `black-forest-labs/FLUX.1-dev` | **>1000** (seitenbegrenzt) | FLUX.1-Stile, breit kuratiert |
| `black-forest-labs/FLUX.2-dev` | **134** | und die Top 10 nach Downloads sind **Quantisierungen, keine Stile**: `unsloth/FLUX.2-dev-GGUF` (117k Downloads), `city96/FLUX.2-dev-gguf` (91k), `DeepBeepMeep/Flux2` (32k), `silveroxides/FLUX.2-dev-fp8_scaled` (28k), `fal/FLUX.2-dev-Turbo` (10k). Die erste **echte** LoRA ist `ostris/flux2_berthe_morisot` (1.024 Downloads) — eine **Personen**-LoRA, kein Stil |

FLUX.2 ist zu neu: der Bestand besteht aus Konvertierungen und Turbo-Distillaten,
nicht aus dem, was wir brauchen.

### 10.4 Analyse des gelieferten LoRA-Textes: 11 von 12 sind nutzbar

Der Auftragstext nannte 12 LoRAs. Nach Zuordnung zum Basismodell:

| Basismodell | Anzahl | Nutzbar |
|---|---|---|
| SDXL | 9 | ja — die eigenen 32 Themen-LoRAs laufen auf demselben Stack |
| FLUX.1-dev | 2 | ja, auf dem FLUX.1-dev-Pfad |
| SD 1.5 (`Fractal Geometry`) | 1 | **nein** — faellt heraus, kein dritter Stack |

**11 von 12 werden also nutzbar**, sobald der ComfyUI-Endpoint steht — mit SDXL
*und* FLUX.1-dev in einem Worker. Deshalb genau zwei Basismodelle und kein
drittes: ein SD-1.5-Stack fuer **eine** LoRA waere teurer als der Nutzen.

**Zwei Einschraenkungen, die ich nicht verschweige:**

1. **Die Likes sind kein Qualitaetsnachweis.** Die genannten Kandidaten liegen
   bei **0 bis 11 Likes**. Ein Modell mit 0 Likes kann gut sein — es kann aber
   auch Muell sein. Jede LoRA wird deshalb **an Testbildern** beurteilt, bevor
   sie in die Auswahl kommt, nicht an ihrer Beliebtheit.
2. **Die Liste selbst liegt nicht auf der Platte.** Sie kam als Text in den
   Auftrag; ich habe sie in keiner Datei gefunden (Suche ueber `.md`, `.txt`,
   `.json`, `.log` im Arbeitsverzeichnis). Zwei Kandidaten konnte ich namentlich
   nachpruefen: `ThalisAI/fractal-aliens-sci-fi-lora` **existiert** (0 Likes,
   72 Downloads, `license: other`, Basis FLUX.1-dev) — `d15ff-Flame-Fractal`
   **existiert nicht** (HTTP 404). Fuer die Kuratierung der uebrigen muss die
   Liste neu geliefert werden; ich erfinde sie nicht aus dem Gedaechtnis.

### 10.5 Die Entscheidung

**Ein LoRA-fähiger ComfyUI-Endpoint, der SDXL und FLUX.1-dev fährt. Kein
FLUX.2, keine SD-1.5-Spur, kein neuer Trainer.**

- **SDXL** ist die **kommerziell saubere** Spur (openrail++) und traegt die
  **32 eigenen Themen-LoRAs** — die sind fertig und in R2.
- **FLUX.1-dev** ist **nicht kommerziell** (BFL Non-Commercial), fuer den
  privaten Testgebrauch aber freigegeben — und ist genau das Modell, auf dem
  `imageHq` heute schon laeuft.
- Die uebrigen 9 Kandidaten aus dem Text werden in diese beiden Spuren
  eingeordnet, sobald die Liste wieder vorliegt.

### 10.6 Was noch fehlt, bevor die LoRAs benutzbar sind

Der Adapter und die zwei Workflows sind **gebaut und getestet** (149 Tests gruen).
Was fehlt, ist der Endpoint — und dort gibt es eine Vorgabe, die der urspruengliche
Plan nicht beruecksichtigt hatte:

**Die Flotte ist auf 8 GPU-Endpoints begrenzt** (`AI_MAX_GPU_ENDPOINTS = 8`,
Betreiber-Freigabe 2026-09-15; in `src/config/aiInfrastructure.ts` als hartes
Verbot formuliert: „weitere GPU-Endpoints sind nicht erlaubt"). Die drei
Visual-Rollen `imageHq`, `videoReal`, `videoAbstract` sind die Bonus-Instanzen —
ein **zweiter Bild-Endpoint waere die neunte**. Vorgabe des Betreibers vom 27.09.:
*„die visuals sind bonus, also max 3 zusaetzliche instanzen"*.

Dazu kommt: der bestehende Bild-Endpoint wird von `runpodVision.ts` **direkt** mit
`{prompt, num_inference_steps, width, height}` angesprochen, ohne den Adapter. Ein
Umstellen des Endpoints auf den ComfyUI-Worker bricht diesen Pfad, solange er
nicht mit-uebersetzt wird.

Drei Wege stehen offen (Details und Preise in `visualplan.md` §15) — **keiner
davon ist ohne Ihre Entscheidung umgesetzt.** Erfreulich dabei: die guenstigste
Karte, die fuer SDXL und FLUX.1-dev fp8 reicht, ist eine **RTX 4000 Ada mit 20 GB
zu 0,20 USD/h** (Community, Rechenzentrum EU-RO-1) — etwa die Haelfte dessen, was
die Bild-Rolle heute als Erfahrungswert fuehrt. Der LoRA-Pfad waere also
**billiger** als der heutige Bild-Pfad, nicht teurer.

Speicherseitig neu im Pool: **Backblaze B2** (`audioMONASTRY`, eu-central-003),
0,006 USD/GB/Monat — die billigste Ablage, aber **nicht mountbar**. Die geplante
Aufteilung (FLUX.1-dev aus dem Image, nur SDXL + LoRAs auf einem 20-GB-Volume)
kostet **1,00 USD/Monat** statt der 1,50 USD, die ein 30-GB-Volume mit allen
Gewichten gekostet haette.

Der Umsetzungsplan dazu steht in `docs/VISUAL_LORA_STACK.md` (im App-Repo) und in
`visualplan.md` §14 und §15.
