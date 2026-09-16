# ComfyUI-Workflows je Rolle

`comfyui_adapter.py` laedt den Workflow einer Rolle in dieser Reihenfolge:

1. `workflow` direkt im Job-Args (Inline-Override, hoechste Prioritaet)
2. `COMFY_WORKFLOW_<ROLLE>` (Pfad, z. B. `/data/workflows/music.json`)
3. `workflows/<rolle>.json` in diesem Verzeichnis

Rollen mit Workflow-Protokoll: **music**, **videoAbstract**.
Rollen mit Prompt-Protokoll (kein Workflow noetig): **imageHq**, **videoReal**.

## Workflow exportieren

Der Adapter erwartet ComfyUIs **API-Format**, nicht das normale Speicherformat:

> In der ComfyUI-UI: **Workflow → Export (API)** (nicht „Save“/„Export“).
> Ausgabe als z. B. `services/audiomonastry-ai-runtime/workflows/music.json` ablegen.

Ein Workflow im API-Format ist ein Objekt aus Knoten-IDs auf `{class_type, inputs}`
mit verdrahteten Eingaben als `[<node-id>, <slot>]`.

**Version der ComfyUI, aus der exportiert werden muss** (aus dem Health-Check der
Worker, 2026-09-16): Frontend **1.48.7**, Templates **0.11.39**, PyTorch 2.8.0+cu128.
Ein Export aus einer aelteren/neueren UI kann Knoten enthalten, die im Image fehlen.

## Kontrakt-Stand (live gemessen 2026-09-16, `scripts/runpod-comfyui-probe.py`)

| Rolle | Deploytes Image | Kontrakt | Status |
|---|---|---|---|
| imageHq | PrunaAI/runpod-worker-FLUX.1-dev | `{prompt}` → `{image_url: "data:image/png;base64,…", images: [<derselbe URI>], seed: <int>}` | **gepinnt** (COMPLETED) |
| videoReal | wlsdml1114/generate-video-ksampler | `{prompt}` → `{video: "<rohes base64 MP4>"}` – **kein** `data:`-Praefix | **gepinnt** (COMPLETED) |
| music | ACE-Step 1.5 XL (RyoheiTanaka/runpod-template-acestep15xl) | `{health_check: true}` → `{comfyui: <system_stats>, status: "ready", usage: "POST {\"input\": {\"workflow\": <API-Format>}}"}`; `{workflow}` → `{files: [{filename, kind, node_id, …}]}` | Health-Pfad **gepinnt**; Workflow-Graph **fehlt** |
| videoAbstract | worker-comfyui 5.10.0 (offiziell) | `{workflow, images[]}` → `{images: […]}`; leerer Graph → `FAILED` mit `error` = rohe ComfyUI-Antwort (`prompt_no_outputs`) | Protokoll **gepinnt**; Workflow-Graph **fehlt** |

Belege (vollstaendige Rohantworten, inkl. base64):

```bash
python3 scripts/runpod-comfyui-probe.py --role imageHq --prompt "..." --out logs/probes/imagehq-prompt-20260916.json
python3 scripts/runpod-comfyui-probe.py --role videoReal --prompt "..." --out logs/probes/videoreal-prompt-20260916.json
python3 scripts/runpod-comfyui-probe.py --role music --health-check --out logs/probes/music-health-20260916.json
python3 scripts/runpod-comfyui-probe.py --role videoAbstract --out logs/probes/videoabstract-empty-workflow-20260916.json
```

`--out` schreibt die **vollstaendige** Antwort; auf stdout steht zusaetzlich eine
Kurzfassung (Feldname, Typ, Groesse). Ohne diesen Schalter war die Ausgabe bei
4000 Zeichen gedeckelt – bei einem base64-Bild/-Video also abgeschnitten.

Die `logs/`-Dateien sind gitignored (base64, mehrere MB). Die auswertbare Fassung
ohne Nutzlast – Anfrage, Felder, Typen, Groessen – liegt im Repo daneben:
`contracts-20260916.json` (neu erzeugbar mit `python3 scripts/write-comfyui-contracts.py`).

**Zwei Eigenheiten, die der Adapter kennen muss** (beide live gemessen und in
`tests/test_comfyui_adapter.py` festgeschrieben):

* `imageHq` liefert die Nutzlast **doppelt** (`image_url` *und* `images[0]`, je
  1.198.258 Zeichen, dazu `seed`) – das darf nicht zu zwei Ausgabe-Items fuehren.
* `videoReal` liefert **rohes base64** statt eines `data:`-URI; `decode_item`
  behandelt beide Formen.

## Warum hier (noch) keine Modelle stehen

Workflow-Graphen sind modell- und imagespezifisch (Knoten-, CLIP-, VAE- und
Sampler-Namen muessen exakt zu den Gewichten im Worker-Image passen). Sie werden
deshalb **nicht blind erfunden**: der ACE-Step-Upstream liefert nur einen Graphen im
UI-Format (`nodes`/`links`), und worker-comfyui bringt nur Bild-Beispiele mit – fuer
`videoAbstract` gibt es dort gar keinen Video-Graphen. Bis ein Export vorliegt,
meldet der Adapter klar:

```
music: kein Workflow konfiguriert – COMFY_WORKFLOW_MUSIC setzen ...
```

Ein abgelegter Graph wird unmittelbar danach **auf der GPU geprueft**, sonst gilt
er nicht als fertig:

```bash
python3 scripts/runpod-comfyui-probe.py --role music \
  --payload "$(python3 -c 'import json,sys; print(json.dumps({"workflow": json.load(open(sys.argv[1]))}))' \
  services/audiomonastry-ai-runtime/workflows/music.json)" \
  --out logs/probes/music-workflow-check.json
```
