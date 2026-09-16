# ComfyUI-Workflows je Rolle

`comfyui_adapter.py` laedt den Workflow einer Rolle in dieser Reihenfolge:

1. `workflow` direkt im Job-Args (Inline-Override, hoechste Prioritaet)
2. `COMFY_WORKFLOW_<ROLLE>` (Pfad, z. B. `/data/workflows/music.json`)
3. `workflows/<rolle>.json` in diesem Verzeichnis

Rolle mit Workflow-Protokoll: **music**.
Rollen mit Prompt-Protokoll (kein Workflow noetig): **imageHq**, **videoReal**,
**videoAbstract**.

## Stand je Rolle (2026-09-16)

| Rolle | Protokoll | Status |
|---|---|---|
| **music** | Workflow | **live verifiziert**: `music.json` (ACE-Step 1.5 XL Turbo), Job COMPLETED, echte MP3 (`ACESTEP_00001.mp3`, 10,032 s, 48 kHz stereo, 293.716 Bytes), Prompt nachweislich im Graphen (ID3-Metadaten) |
| **videoAbstract** | Prompt | **live verifiziert** (nach Image-Wechsel, siehe unten): Job COMPLETED, echtes Video (H.264, 480×720, 161 Frames, 5,03 s, 1,1 MB) |

Belege: `logs/probes/*.json` (gitignored, base64-Nutzlasten), auswertbare Fassung
ohne Nutzlast in `contracts-20260916.json`.

### Prompt-Rollen (kein Workflow noetig)

| Rolle | Kontrakt (live gemessen) |
|---|---|
| imageHq | `{prompt}` → `{image_url: "data:image/png;base64,…", images: [<derselbe URI>], seed}` – Nutzlast kommt doppelt |
| videoReal | `{prompt}` → `{video: "<rohes base64 MP4>"}` – **kein** `data:`-Praefix |

## music.json: Herkunft und Umbau

Der Graph ist **nicht** von Hand geschrieben, sondern reproduzierbar erzeugt:

```bash
python3 scripts/build-music-workflow.py            # schreibt workflows/music.json
python3 scripts/build-music-workflow.py --dry-run  # nur zeigen
```

* Struktur aus dem offiziellen ComfyUI-Template
  `templates/audio_ace_step1_5_xl_turbo.json`
  (<https://github.com/Comfy-Org/workflow_templates>, ACE-Step 1.5 XL Turbo).
* Eingangs-/Ausgangsnamen aus den Quellen der im Image eingesetzten ComfyUI-Version
  (`v0.32.0` laut Dockerfile des ACE-Step-Templates): `comfy_extras/nodes_ace.py`
  und `comfy_extras/nodes_audio.py` – nicht geraten.
* Umwandlung UI-Format → API-Format mit `scripts/comfyui-ui-to-api.py`. Das Skript
  bricht ab, wenn eine Knotenklasse unbekannt ist oder die Widget-Anzahl nicht
  passt, statt etwas Falsches zu erzeugen. Knoten mit DynamicCombo (z. B.
  `SaveAudioAdvanced`) werden mit Begruendung abgelehnt.
* **Eine bewusste Abweichung** vom Template: `SaveAudioAdvanced` → `SaveAudioMP3`.
  Live belegt: mit `SaveAudioAdvanced` kam der Job als „Required input is missing:
  quality" zurueck (die DynamicCombo braucht `format.quality` verschachtelt).
  `SaveAudioMP3` ist genau der Knoten des offiziellen Schwester-Templates
  `audio_ace_step_1_5_split_4b.json` (als „DEPRECATED" markiert, aber funktional).
* Lizenz-Hinweis: die Templates stammen aus dem ComfyUI-Umfeld (GPL-3.0). Im Repo
  liegt nur der **umgewandelte Graph** (`music.json`), nicht das Template selbst;
  die Herkunft steht im Kopf von `scripts/build-music-workflow.py`.

**Modelle, die der Graph erwartet** (das Image muss sie bereitstellen):

| Datei | Ablage | Herkunft |
|---|---|---|
| `acestep_v1.5_xl_turbo_bf16.safetensors` | `diffusion_models/` | Comfy-Org/ace_step_1.5_ComfyUI_files |
| `qwen_0.6b_ace15.safetensors` + `qwen_4b_ace15.safetensors` | `text_encoders/` | dieselbe Quelle |
| `ace_1.5_vae.safetensors` | `vae/` | dieselbe Quelle |

Der ACE-Step-Worker laedt diese Dateien beim ersten Boot. Wichtig: die Umgebung
muss **beide** Text-Encoder erlauben (`ACESTEP_LM=all`) – mit `ACESTEP_LM=qwen_4b`
liegt nur `qwen_4b_ace15.safetensors` im Image, und der Job scheitert mit
`clip_name1: 'qwen_0.6b_ace15.safetensors' not in ['qwen_4b_ace15.safetensors']`.
`ACESTEP_XL_VARIANT` bestimmt die Diffusionsmodelle (`xl_turbo` = 8 Steps, schnell;
`all` = zusaetzlich base/sft fuer die langsameren Qualitaets-Graphen).

## Prompt-Laufzeit: Werte landen IM Graphen

Workflow-Worker kennen keinen `prompt`-Parameter. `comfyui_adapter.apply_prompt_to_workflow`
schreibt `prompt`/`lyrics`/`bpm`/`duration`/`seed` in die ACE-Knoten
(`TextEncodeAceStepAudio1.5`) und zieht die Latent-Laenge (`EmptyAceStep1.5LatentAudio`)
mit, damit Konditionierung und Latent zusammenpassen. Verdrahtete Eingaenge bleiben
unangetastet; findet der Adapter keinen ACE-Textknoten, bleibt der Workflow
unveraendert und das wird als Warnung geloggt (kein stiller Fehlschlag).

## Workflow verifizieren (GPU, ein Job)

```bash
python3 scripts/build-music-workflow.py
python3 -c "import json,sys; sys.path.insert(0,'services/audiomonastry-ai-runtime'); \
import comfyui_adapter as a; wf=json.load(open('services/audiomonastry-ai-runtime/workflows/music.json')); \
json.dump({'workflow': a.apply_prompt_to_workflow(wf, {'prompt':'ambient drone','duration':10})}, open('/tmp/p.json','w'))"
python3 scripts/runpod-comfyui-probe.py --role music --payload "$(cat /tmp/p.json)" \
  --timeout 2400 --out logs/probes/music-workflow-check.json
```

Erwartet: `status: COMPLETED` und `files: [{filename: "ACESTEP_00001.mp3", kind: "audio", …}]`.

## Alternative: Workflow aus der UI exportieren

Wer lieber selbst in ComfyUI arbeitet: der Adapter erwartet das **API-Format**,
nicht das Speicherformat – in der UI also **Workflow → Export (API)** (nicht
„Save“/„Export“). Ein API-Workflow ist ein Objekt aus Knoten-IDs auf
`{class_type, inputs}` mit verdrahteten Eingaben als `[<node-id>, <slot>]`. Liegt
ein UI-Workflow vor, macht `scripts/comfyui-ui-to-api.py` daraus das API-Format
(dieselbe Umformung, nur nachvollziehbar und ohne UI).

Wichtig ist die passende ComfyUI-Version: der Health-Check der Worker nannte
Frontend **1.48.7** / Templates **0.11.39** / torch 2.8.0+cu128; ein Export aus
einer anderen Version kann Knoten enthalten, die im Image fehlen.

## Kontrakt-Probe (ein Job, mit Beleg)

```bash
python3 scripts/runpod-comfyui-probe.py --role imageHq --prompt "..." --out logs/probes/imagehq-prompt-20260916.json
python3 scripts/runpod-comfyui-probe.py --role videoReal --prompt "..." --out logs/probes/videoreal-prompt-20260916.json
python3 scripts/runpod-comfyui-probe.py --role music --health-check --out logs/probes/music-health-20260916.json
python3 scripts/runpod-comfyui-probe.py --role videoAbstract --out logs/probes/videoabstract-empty-workflow-20260916.json
```

`--out` schreibt die **vollstaendige** Antwort; auf stdout steht zusaetzlich eine
Kurzfassung (Feldname, Typ, Groesse). Ohne diesen Schalter war die Ausgabe bei
4000 Zeichen gedeckelt – bei einem base64-Bild/-Video also abgeschnitten.

**Zwei Eigenheiten, die der Adapter kennen muss** (beide live gemessen und in
`services/audiomonastry-ai-runtime/tests/test_comfyui_adapter.py` festgeschrieben):

* `imageHq` liefert die Nutzlast **doppelt** (`image_url` *und* `images[0]`, je
  1.198.258 Zeichen, dazu `seed`) – das darf nicht zu zwei Ausgabe-Items fuehren.
* `videoReal` liefert **rohes base64** statt eines `data:`-URI; `decode_item`
  behandelt beide Formen.

## Warum videoAbstract das Image gewechselt hat

Der Endpoint lief bis 2026-09-16 auf dem **generischen**
`runpod-workers/worker-comfyui` (ComfyUI 0.34.0). Der bringt keine Gewichte mit und
laedt auch keine nach (das Start-Skript des Repos hat keine Download-Logik), und am
Endpoint hing **kein Netzwerk-Volume** (`networkVolumes: []`). Live geprueft nannte
der Worker selbst leere Listen fuer `diffusion_models`, `text_encoders` und `vae`
(`unet_name: not in []`) – **kein Graph kann das beheben**.

Umgesetzt wurde deshalb die Variante „Video-Worker mit eigenen Gewichten“: derselbe
Endpoint (`fogwdyxp1zj8zv`) laeuft jetzt auf dem Image
`wlsdml1114/generate-video-ksampler` (Wan2.2, dasselbe wie `videoReal`) und auf der
GPU-Pool `ADA_24` (RTX 4090, **1,10 $/h** Serverless; eine 5090 waere 1,58 $/h).
Damit ist der Adapter fuer diese Rolle **prompt-basiert** – „abstrakt“ kommt aus dem
Prompt/Stil, nicht aus einem zweiten Modell. Kein neuer Endpoint, keine zusaetzlichen
Env-Verkabelungen, kein Volume-Abo.

Verifiziert (2026-09-16): Job COMPLETED in 3m48s, `{"video": "<rohes base64 MP4>"}`,
dekodiert H.264, 480×720, 161 Frames, 5,03 s, 1,1 MB
(`logs/probes/videoabstract-wan-prompt-20260916.json`).

**Noch offen dazu:** LoRA-Paare fuer eigene Stile (`lora_pairs[]` unterstuetzt der
Worker, der Adapter reicht sie durch) und die Frage, ob 480×720/5 s als Vorgabe fuer
„abstract loops“ reicht – beides per Prompt-Argumente steuerbar, sobald die
Prompt-/Adapter-Schicht echte Werte statt Platzhalter liefert.
