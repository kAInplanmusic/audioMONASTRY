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

## Warum hier (noch) keine Modelle stehen

Workflow-Graphen sind modell- und imagespezifisch (Knoten-, CLIP-, VAE- und
Sampler-Namen muessen exakt zu den Gewichten im Worker-Image passen). Sie werden
deshalb **nicht blind erfunden**, sondern pro Rolle einmal aus der ComfyUI-UI
exportiert und auf der GPU verifiziert. Bis dahin meldet der Adapter klar:

```
music: kein Workflow konfiguriert – COMFY_WORKFLOW_MUSIC setzen ...
```

## Offene Kontrakt-Punkte (Stand 2026-09-15)

| Rolle | Deploytes Image | Kontrakt | Status |
|---|---|---|---|
| music | ACE-Step 1.5 XL (RyoheiTanaka) | `{workflow}` → `{files:[{filename,kind,node_id,...}]}` | dokumentiert, Workflow fehlt |
| videoAbstract | worker-comfyui 5.10.0 | `{workflow, images[]}` → `{images:[...]}` | dokumentiert, Workflow fehlt |
| videoReal | wlsdml1114/generate-video-ksampler | unbekannt (Repo offline) | Prompt-Standard + Live-Probe offen |
| imageHq | PrunaAI/runpod-worker-FLUX.1-dev | unbekannt (Repo offline) | Prompt-Standard + Live-Probe offen |

Die Live-Probe je Rolle pinnt die beiden unbekannten Vertraege mit einem Job fest:
`python3 scripts/runpod-comfyui-probe.py --role imageHq --prompt "a red cube"`.
