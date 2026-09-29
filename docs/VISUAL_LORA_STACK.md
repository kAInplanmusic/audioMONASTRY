# VISUAL_LORA_STACK — LoRA-fähige Bild-Generierung (SDXL + FLUX.1-dev)

**Stand:** 2026-09-27 · **Status:** Adapter + Workflows fertig, Endpoint-Entscheidung offen
**Gehört zu:** VISUAL-P1-009 (je Thema ein eigener Bilder-Satz + eigenes LoRA)
**Bericht/Betriebsanleitung:** `/home/patrick/lora-themen-2026-09-27/visualplan.md` §14,
`BERICHT.md` §10

Dieses Dokument ist die dauerhafte Referenz: warum welche Basismodelle, wo die
Gewichte liegen, wie ein LoRA in den Graphen kommt, und was ein Endpoint kostet.
Alle Größen- und Preisangaben sind **gemessen**, nicht geschätzt — die Quelle steht
jeweils dabei.

---

## 1. Die Entscheidung in drei Sätzen

Die Bild-Rolle fährt **SDXL 1.0** und **FLUX.1-dev** aus *einem* ComfyUI-Worker,
damit **ein** Endpoint den LoRA-Bestand beider Familien bedienen kann. SDXL ist die
kommerziell saubere Spur (openrail++) und trägt die **32 eigenen Themen-LoRAs**;
FLUX.1-dev ist das Modell, auf dem die Rolle heute schon läuft, und trägt die
FLUX-LoRAs (nicht kommerziell, privater Testgebrauch). **FLUX.2-dev wird nicht
gebaut** — Begründung mit Zahlen in `visualplan.md` §14.

---

## 2. Die Basismodelle — gemessene Größen

Quelle: HuggingFace-API `/api/models/<repo>?blobs=true`, Feld `siblings[].size`,
gelesen am 27.09.2026. Repo-Gesamtgrößen enthalten alle Formate (fp32, ONNX, Flax)
und taugen **nicht** als Vergleich — verglichen wird der Betriebssatz.

| Modell | Betriebssatz (ComfyUI) | Dateiname im Worker | Lizenz | Revisions-Pin |
|---|---|---|---|---|
| **SDXL 1.0** | **6,46 GB** (`sd_xl_base_1.0.safetensors`) | `models/checkpoints/sd_xl_base_1.0.safetensors` | openrail++ | `462165984030d82259a11f4367a4eed129e94a7b` |
| SDXL-VAE (fp16-fix) | 0,33 GB | `models/vae/sdxl-vae-fp16-fix.safetensors` | MIT | `207b116dae70ace3637169f1ddd2434b91b3a8cd` |
| **FLUX.1-dev fp8** (All-in-One) | **16,06 GB** — Unet + T5 + CLIP-L + VAE in *einer* Datei | `models/checkpoints/flux1-dev-fp8.safetensors` | BFL Non-Commercial | `83c446ef27a6ac1e9e36ecf13257283aa12cf22a` |
| *Alternative* FLUX.1-dev getrennt (fp8) | 11,08 GB Unet + 4,56 GB T5 + 0,23 GB CLIP-L + 0,31 GB VAE | `models/unet/`, `models/clip/`, `models/vae/` | dito | `3de623fc3c33e44ffbe2bad470d0f45bccf2eb21` |

**Warum FLUX.1-dev fp8 als All-in-One-Checkpoint:** 16 GB in *einer* Datei statt
vier Einzeldateien mit vier Pfaden — ein Knoten (`CheckpointLoaderSimple`), ein
Dateiname, ein Pfad, der schiefgehen kann. fp8 ist das Format, in dem FLUX.1-dev
in ComfyUI produktiv läuft; bf16 (22,17 GB) braucht mehr als 24 GB VRAM für Komfort.

**Warum SDXL 1.0 und nicht ein Refiner-/Turbo-Derivat:** Die 32 eigenen LoRAs sind
auf `stabilityai/stable-diffusion-xl-base-1.0` trainiert (`ss_base_model_version =
sdxl_1.0`, in `visualplan.md` §3 verifiziert). Ein anderes SDXL-Derivat würde die
LoRAs nur noch teilweise laden. Das Basismodell ist damit **nicht frei wählbar**.

---

## 3. Wo die Gewichte liegen — und was das kostet

Zwei Orte, und die Wahl ist eine **Kosten**frage:

| Ort | Kosten | Kaltstart | Wann richtig |
|---|---|---|---|
| **Im Image** (gebacken) | **0 USD/Monat** | erster Pull langsam, danach Host-Cache | Gewichte, die sich nie ändern; spart monatliche Volumenkosten |
| **Network Volume** | **0,05 USD/GB/Monat** | schnell (liegt im Rechenzentrum) | was sich ändern soll, ohne das Image neu zu bauen (LoRAs) |
| **Backblaze B2** | **0,006 USD/GB/Monat** | — (kein Mount) | Quelle/Archiv für Artefakte; **nicht** mountbar, muss kopiert werden |

### 3.1 Die gewählte Aufteilung (klein und schnell)

```
Image  runpod/worker-comfyui:5.11.0-flux1-dev-fp8
       └─ FLUX.1-dev fp8 (16 GB) ist IM Image enthalten → 0 USD/Monat, kein Download

Volume 20 GB Standard = 1,00 USD/Monat   (gemountet als /runpod-volume)
       └─ models/checkpoints/sd_xl_base_1.0.safetensors         6,46 GB
       └─ models/vae/sdxl-vae-fp16-fix.safetensors              0,33 GB
       └─ models/loras/*.safetensors   (32 eigene Themen-LoRAs)  2,73 GB
       └─ models/loras/*.safetensors   (kuratierte Fremd-LoRAs)  ~1–2 GB
```

**Warum nicht alles auf das Volume:** FLUX.1-dev fp8 liegt fertig im Image. Auf
das Volume kopiert kostete dieselbe Datei 0,80 USD/Monat und müsste erst 16 GB
übertragen werden — ohne Gegenwert, weil sich ein Basismodell nicht ändert.

**Warum nicht alles ins Image:** dann kostet es 0 USD/Monat, aber jede neue LoRA
erzwingt einen Image-Neubau *und* einen Upload des Images vom Aufnahmeort. Für
einen Bestand, der sich ändert, ist das Volume billiger als der Arbeitsaufwand.

### 3.2 Das Pfad-Layout ist nicht frei wählbar

`worker-comfyui` bindet ein Network Volume über `src/extra_model_paths.yaml` ein
(gelesen am 27.09.2026):

```yaml
runpod_worker_comfy:
  base_path: /runpod-volume
  checkpoints: models/checkpoints/
  clip:        models/clip/
  clip_vision: models/clip_vision/
  configs:     models/configs/
  controlnet:  models/controlnet/
  embeddings:  models/embeddings/
  loras:       models/loras/
  upscale_models: models/upscale_models/
  vae:         models/vae/
  unet:        models/unet/
```

Daraus folgen **drei Fallen**, die alle still fehlschlagen (ComfyUI meldet dann nur
`value not in list`):

1. **Der Pfad muss `models/…` enthalten.** `/runpod-volume/checkpoints/…` ist
   falsch, `/runpod-volume/models/checkpoints/…` ist richtig.
2. **FLUX-Text-Encoder gehören nach `models/clip/`, nicht nach
   `models/text_encoders/`.** Ebenso der Unet nach `models/unet/`, nicht nach
   `models/diffusion_models/`. ComfyUI führt beide Namen auf dieselbe Liste, das
   Worker-Manifest (`handler.py`, `MODEL_TYPE_VOLUME_DIRS`) übersetzt entsprechend —
   aber die Datei auf dem Volume muss im YAML-Pfad liegen.
3. **Nur bekannte Endungen.** `.safetensors`, `.ckpt`, `.pt`, `.pth`, `.bin`,
   `.msgpack` — alles andere wird ignoriert.

Debug: `NETWORK_VOLUME_DEBUG=true` in die Endpoint-Umgebung setzen; der Worker
schreibt dann je Job einen Volumen-Bericht (Mount, Verzeichnisse, gefundene
Dateien) ins Log.

---

## 4. So bauen wir Modelle und LoRAs

### 4.1 Gewichte holen

```bash
# öffentlich, kein Token nötig (SDXL ist NICHT gated):
#   https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors
#   https://huggingface.co/madebyollin/sdxl-vae-fp16-fix/resolve/main/sdxl_vae.safetensors
# FLUX.1-dev ist gated (HF: gated "auto") → HF_TOKEN mit erteiltem Zugriff nötig:
#   https://huggingface.co/Comfy-Org/flux1-dev/resolve/main/flux1-dev-fp8.safetensors
```

Der Pod/die Maschine schreibt **immer** nach `models/<typ>/<datei>` — nie direkt in
den Volumen-Wurzelpfad.

### 4.2 Das Volume füllen

Zwei Wege, und der Unterschied ist nur die Bandbreite:

* **CPU-Pod mit gemountetem Volume** (empfohlen): laden und schreiben im
  Rechenzentrum. Ein reiner CPU-Pod kostet wenige Cent pro Stunde; 10 GB sind in
  Minuten drüben. Das ist der Weg, den `scripts/lora/vorstaging.sh` im App-Repo
  schon geht (idempotent, mit Monatskostenrechnung).
* **S3-API des Volumens von außen**: `s3://<NETWORK_VOLUME_ID>/models/loras/…`.
  Kein Pod nötig, aber die Daten laufen über die eigene Leitung.

Das Vorstaging ist **idempotent**: ein zweiter Lauf überspringt, was schon da ist.

### 4.3 Eigene LoRAs trainieren

Unverändert gültig aus `visualplan.md` §3 und §12: ai-toolkit im Image
`ostris/aitoolkit:latest`, `arch: sdxl`, `noise_scheduler: ddpm`, `dtype: bf16` in
**beiden** Blöcken, Rang 16, **lr 5e-5 + cosine** (nicht 1e-4 — das war die
Zerfallsursache), 800 Schritte, `save_every 100`. Ergebnis: 85,4 MB je LoRA.

**Achtung Host-Treiber:** das Trainer-Image bringt CUDA 13.0.3 und braucht
Host-Treiber ≥ 595. Mit 580 und 590 ist `torch.cuda.is_available()` `False`
(gemessen, `visualplan.md` §1.1). Der ComfyUI-Worker braucht das **nicht** — er
basiert auf CUDA 12.8.1.

Ein eigenes Thema auf FLUX.1-dev zu trainieren ist **möglich, aber nicht nötig**:
der SDXL-LoRA existiert bereits, und ai-toolkit kann `arch: flux` mit 24 GB.

### 4.4 Trigger

Die eigenen LoRAs tragen den Trigger `mstyle_<thema>` in der Caption. **Ohne
Trigger im Prompt wirkt das LoRA kaum** (`visualplan.md` §8). Deshalb setzt der
Aufrufer ihn in `prompt`; der Adapter hängt ihn nicht selbst an — sonst könnte der
Aufrufer den Stil nicht bewusst abschalten.

---

## 5. Die Anbindung (fertig gebaut)

### 5.1 Aufruf

```jsonc
{ "prompt": "mstyle_comic, a lone figure on a neon-lit stage",
  "seed": 4711,
  "base": "sdxl",                 // "sdxl" | "flux1", Default: sdxl
  "lora_pairs": [                 // optional, gewichtet, in Reihenfolge gekettet
    { "name": "mstyle_comic.safetensors", "weight": 0.8 },
    { "name": "dark_ornament.safetensors", "weight": 0.5 }
  ],
  "steps": 30, "cfg": 7.0, "negative_prompt": "blurry",
  "width": 1024, "height": 1024
}
```

Antwort (normiert, wie bei `imageHq`): `{kind: "image", items: [{filename, data:
"data:image/png;base64,…"}], count}`. Unterschied zu `imageHq`: worker-comfyui
liefert **kein** `seed` zurück — der Aufrufer behält seinen eigenen.

### 5.2 Wie die LoRA wirklich in den Graphen kommt

`comfyui_adapter.apply_loras_to_workflow()` baut eine `LoraLoader`-Kette
zwischen Basis-Loader und Verbraucher:

```
CheckpointLoaderSimple ──model(0)──> LoraLoader 1 ──> LoraLoader 2 ──> KSampler
                        ──clip(1)───>      │              │        └──> CLIPTextEncode
                        ──vae(2)────────────────────────────────────> VAEDecode  (unverändert)
```

Die Verbraucher werden **umgehängt**, nicht neu verdrahtet: jede Verbindung, die
vorher auf Slot 0/1 des Loaders zeigte, zeigt danach auf das Kettenende. Der
VAE-Slot 2 bleibt unangetastet — LoRAs ändern den VAE nicht.

**Warum das geprüft werden muss:** eine LoRA, die im Request steht und nicht im
Graphen landet, erzeugt Bilder, die sich von „ohne LoRA" nicht unterscheiden. Das
sieht man dem Ergebnis nicht an. Der LoRA-Wirkungsnachweis (gleicher Prompt und
Seed mit/ohne LoRA) ist deshalb Pflicht, nicht Kür.

### 5.3 Dateien

| Datei | Rolle |
|---|---|
| `workflows/image_sdxl.json` | SDXL-Graph (30 Schritte, CFG 7, dpmpp_2m/karras) |
| `workflows/image_flux1.json` | FLUX.1-dev-Graph (20 Schritte, CFG 1, euler/simple) |
| `comfyui_adapter.py` | `imageLora`/`image`-Modus, LoRA-Kette, Prompt/Seed/Größe |
| `tests/test_comfyui_adapter.py` | 15 Regressionstests für die Rolle (ohne GPU) |

Der Adapter lehnt einen LoRA-Namen mit `/`, `\` oder `..` **ab**, statt ihn still
zu ignorieren: eine weggelassene LoRA ist von einer wirkungslosen nicht zu
unterscheiden, und genau das soll der Nachweis trennen können.

---

## 6. Der Endpoint

### 6.1 Was ein Worker kostet (gemessen, RunPod-Katalog 27.09.2026)

Der Dienst ist **scale-to-zero**: im Leerlauf kostet er nichts, bezahlt wird je
laufende Sekunde.

| Karte | VRAM | Community | Secure | Verfügbar in | reicht für |
|---|---|---|---|---|---|
| **RTX 4000 Ada** | 20 GB | **0,20 USD/h** | 0,28 USD/h | **EU-RO-1**, EUR-IS-1 | SDXL (min. 8 GB) und FLUX fp8 |
| RTX PRO 4500 | 32 GB | – | 0,72 USD/h | EU-RO-1 | beides mit Reserve |
| A100 PCIe | 80 GB | 1,19 USD/h | 1,59 USD/h | EU-RO-1, CA-MTL-3 | beides sehr bequem |
| L40S | 48 GB | 0,79 USD/h | 1,07 USD/h | – (keine Kapazität am 27.09.) | beides |

**Die günstigste Karte, die reicht, ist die RTX 4000 Ada mit 20 GB zu 0,20 USD/h**
— ein Fünftel dessen, was die Rolle `imageHq` heute als Erfahrungswert führt
(0,39 €/h, A6000-Klasse). Das ist der Grund, den Bild-Slot auf den
ComfyUI-Worker umzustellen statt einen zweiten daneben zu betreiben.

Ein Video-/Bild-Endpoint mit Volume muss im **Datenzentrum des Volumens** laufen.
Die Karte und das Volumen gehören also zusammen gewählt: Volumen in **EU-RO-1**
(dort liegen RTX 4000 Ada und A100 PCIe) — Europa, kurze Wege zum Betreiber.

### 6.2 Der Konflikt, der eine Betreiber-Entscheidung braucht

`src/config/aiInfrastructure.ts` ist hart: *„Die AI-Flotte besteht aus den Rollen
… – weitere GPU-Endpoints sind nicht erlaubt"*, `AI_MAX_GPU_ENDPOINTS = 8`
(Betreiber-Freigabe 2026-09-15), und `tests/aiInfrastructure.test.ts` prüft die
Rollenliste und die Flottensumme (3,92 €/h) **exakt**. Die Visual-Rollen
`imageHq`, `videoReal`, `videoAbstract` sind die drei Bonus-Instanzen.

**Ein zweiter Bild-Endpoint wäre der vierte** und damit außerhalb der Freigabe.
Dagegen steht: `src/core/ai/vision/runpodVision.ts` spricht den Bild-Endpoint
**direkt** mit `{input: {prompt, num_inference_steps, width, height}}` an — ohne
den Adapter. Ein Umstellen des Bild-Endpoints auf den ComfyUI-Worker bricht diesen
Pfad, solange er nicht mit-übersetzt wird.

Drei Wege, und alle kosten dasselbe (0 USD im Leerlauf):

| Weg | Endpoints | App-Änderung | Preis |
|---|---|---|---|
| **A** Bild-Slot auf ComfyUI umstellen (`imageHq`), `runpodVision.ts` auf den Workflow-Protokollpfad mitziehen | 8 (unverändert) | ja: `runpodVision.ts` + Template-Wechsel am Endpoint | **günstiger** als heute (0,20 statt ~0,39 €/h) |
| **B** ComfyUI-Worker als vierten Visual-Endpoint | **9** | nein | +0,20 USD/h bei Betrieb, 0 im Leerlauf — aber über der 8er-Grenze |
| **C** Prompt-Kompatibilität ins Image bauen (eigener Handler, der `{prompt}` in den FLUX-Graphen übersetzt) | 8 | **nein** (nur Image) | wie A, plus ein Image-Bau und -Push |

**Empfehlung: A.** Ein Endpoint, der dieselbe Rolle besser und billiger erfüllt,
statt eines zweiten daneben. C ist technisch am elegantesten (kein App-Eingriff),
kostet aber einen Image-Bau und einen Push von ~30 GB.

**Bis zur Entscheidung ist nichts davon gebaut** — der Adapter und die Workflows
sind fertig und getestet, aber es gibt **keinen** LoRA-Endpoint und **kein**
`roles.imageLora` im Manifest: der Drift-Guard `tests/manifestRoles.test.ts`
verlangt Deckungsgleichheit von Manifest-Rollen und `GPU_ROLE_IDS`, ein Eintrag
ohne TS-Spiegel würde ihn brechen.

---

## 7. Der Speicher im Pool: Backblaze B2

**Bucket** `audioMONASTRY`, Region **eu-central-003**, S3-Endpunkt
`https://s3.eu-central-003.backblazeb2.com`. Preis **0,006 USD/GB/Monat** —
gegenüber R2 und dem RunPod-Volume die billigste Ablage.

**Wofür B2 taugt und wofür nicht:**

* ✅ **Archiv und Quelle** für Artefakte: LoRA-Bundle, Datensätze, erzeugte
  Bilder. Von hier füllt sich das Volume in Minuten.
* ❌ **Nicht mountbar.** Ein Container kann B2 nicht als Verzeichnis sehen; die
  Daten müssen kopiert werden. „Gewichte direkt aus B2 laden" ist kein
  Volume-Ersatz, sondern nur ein anderer Download-Ort.

⚠️ **Der übergebene Schlüssel ist ein Master Application Key** (`BB_MA_KEY`, vom
Betreiber am 27.09.2026 in den Pool aufgenommen). Er ist **nicht** auf den Bucket
beschränkt — er darf alle Buckets anlegen und löschen und alle Daten entfernen.
Für den Dauerbetrieb gehört ein auf `audioMONASTRY` beschränkter Key dorthin;
bis dahin liegt er wie die übrigen Zugangsdaten in
`.env` (Dateirechte `600`) und wird nie ausgegeben oder in Logs geschrieben.

---

## 8. Kostenüberblick

| Posten | Betrag | Rhythmus |
|---|---|---|
| Network Volume 20 GB Standard | 1,00 USD | Monat |
| Serverless-Endpoint im Leerlauf | 0,00 USD | — (scale-to-zero) |
| Ein Bild (SDXL, 30 Schritte, 1024 px, RTX 4000 Ada) | ~0,002 USD | je Bild |
| Ein Bild (FLUX.1-dev fp8, 20 Schritte, 1024 px) | ~0,003 USD | je Bild |
| Smoke-Test beider Workflows + LoRA-Nachweis | ~0,10–0,30 USD | einmalig |
| B2-Artefakte (10 GB) | 0,06 USD | Monat |

Die Trainingsseite ist abgeschlossen (8,44 USD für 32 LoRAs, `BERICHT.md` §5).

---

## 9. Fallen (aus diesem Lauf, jede hat Geld oder Zeit gekostet)

* **Host-Treiber ≥ 595** für das ai-toolkit-Trainer-Image (CUDA 13.0.3). 580 und
  590 liefern `torch.cuda.is_available() == False`, obwohl `nvidia-smi` läuft.
* **Der Boot-Vorgang ist nicht schuld, wenn ein Pod ohne Log stirbt.** Der
  Trenn-Test (Pod mit `echo HALLO; sleep 900`) hat gezeigt: der Container läuft.
  Erst danach war die Treiberfrage die richtige Frage.
* **Ein Volumen ohne `models/`-Präfix** und **FLUX-Encoder in
  `text_encoders/` statt `clip/`** — beides findet ComfyUI still nicht.
* **Ein Worker-Feldname ist kein Vertrag.** worker-comfyui liefert Bilder als
  *rohes* base64 in `images[].data` (`imageHq` liefert `data:image/png;base64,…`).
  Der Adapter gleicht das an, sonst ist das Ergebnis-JSON nicht von einem Textfeld
  zu unterscheiden.
* **`runpodctl pod create` meldet Erfolg ohne Kapazität** (`visualplan.md` §11).
* **Ein LoRA-Name ohne Prüfung** ist ein Pfad-Traversal auf einem geteilten
  Volume — deshalb `LORA_NAME_PATTERN` und Ablehnung statt Ignorieren.

---

## 10. Abkürzungen

| Kürzel | Bedeutung |
|---|---|
| P1-009 | Projektposten „je Thema ein eigener Bilder-Satz + eigenes LoRA" |
| `mstyle_<thema>` | Trigger-Wort der eigenen Themen-LoRAs |
| scale-to-zero | Endpoint mit `workersMin = 0`: im Leerlauf keine Kosten |
| LoRA | Low-Rank Adaptation — kleine Zusatzgewichte, die einen Stil auf ein Basismodell aufprägen |
