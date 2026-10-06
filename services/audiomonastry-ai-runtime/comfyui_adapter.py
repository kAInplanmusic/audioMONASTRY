"""AudioMONASTRY AI Runtime – ComfyUI-Adapter (Instanz 5/6/7 + music)
====================================================================
Die Rollen `music`, `imageHq`, `videoReal` und `videoAbstract` laufen auf
VORGEFERTIGTEN Hub-Workern, nicht auf unserem Image. Sie sprechen deshalb nicht
unser `{task, model, input}`-Protokoll, sondern die jeweilige Worker-API. Dieser
Adapter uebersetzt in beide Richtungen:

  unser Protokoll  ->  Worker-Request   (`build_request`)
  Worker-Antwort   ->  normierte Ausgabe (`normalize_output`)

Dokumentierte Vertraege (live gemessen, Belege in `logs/probes/`):

* **Wan2.2 TI2V** (`videoReal` **und** `videoAbstract`, beide auf
  wlsdml1114/generate-video-ksampler): prompt-basiert – `{prompt, negative_prompt,
  image_url|image_base64|image_path, width, height, length, steps, cfg, seed,
  lora_pairs[]}` -> `{video: "<rohes base64 MP4>"}` (kein `data:`-Praefix).
* **ACE-Step 1.5 XL** (`music`, RyoheiTanaka/runpod-template-acestep15xl):
  workflow-basiert – `{workflow: <ComfyUI-API-JSON>}` ->
  `{files: [{filename, kind: "audio", node_id, ...}]}`; `{health_check: true}`
  liefert die system_stats. Den Graphen liefert `workflows/music.json`.
* **PrunaAI FLUX** (`imageHq`, **historisch bis 2026-09-27**, b90f7a8):
  prompt-basiert – `{prompt}` ->
  `{image_url: "data:image/png;base64,...", images: [<derselbe URI>], seed}`.
* **worker-comfyui** (`imageHq` seit 2026-09-27 (b90f7a8), `imageLora`):
  workflow-basiert – `{workflow: <ComfyUI-API-JSON>, images?: [...]}` ->
  `{images: [{filename, type: "base64", data: "<rohes base64>"}]}`.
  Die Gewichte liegen auf einem Network Volume (`/runpod-volume/models/...`,
  Layout in `docs/VISUAL_LORA_STACK.md`); den Graphen liefern
  `workflows/image_sdxl.json` und `workflows/image_flux1.json` (bzw. fuer
  `imageHq` der Code-Graph in `src/core/ai/vision/runpodVision.ts`).

### `imageLora` – zwei Basismodelle, ein Endpoint

Die Rolle faehrt **SDXL** und **FLUX.1-dev** in demselben Worker. Welcher
Workflow laeuft, entscheidet der Aufruf ueber `base`:

```
{prompt, seed, base: "sdxl"|"flux1", lora_pairs: [{name, weight}], steps?, cfg?, width?, height?}
```

* `base` waehlt die Datei `workflows/image_<base>.json` (Default `sdxl`).
* `lora_pairs` werden **in den Graphen eingekettet** (`apply_loras_to_workflow`):
  eine `LoraLoader`-Kette zwischen Basismodell und Verbrauchern, gewichtet.
  Die Namen werden gegen ein strenges Muster geprueft – ein Name mit `/` oder
  `..` wird **abgelehnt**, nicht stillschweigend ignoriert.
* Prompt/Seed/Steps/CFG/Aufloesung landen ueber
  `apply_prompt_to_image_workflow` im Graphen, indem den **verdrahteten**
  Verbindungen des Samplers gefolgt wird (nicht ueber Knoten-IDs geraten).

Warum das noetig ist: ein Workflow-Worker kennt keinen `prompt`-Parameter. Ohne
diesen Schritt erzeugt jeder Aufruf das im Workflow hinterlegte Demo-Bild,
waehrend der Aufrufer sein Ergebnis fuer erledigt haelt – ein stiller Fehlschlag
(dieselbe Falle wie beim ACE-Step-Demo-Song, §`apply_prompt_to_workflow`).

`videoAbstract` lief bis 2026-09-16 auf dem generischen runpod-workers/worker-comfyui.
Der bringt keine Gewichte mit, laedt auch keine nach, und der Endpoint hatte kein
Volume – der Worker nannte auf Nachfrage leere Modell-Listen
(`unet_name: not in []`). Ein Workflow haette das nicht geloest; die Rolle laeuft
seitdem auf demselben Wan-Worker wie `videoReal` (Abstraktion kommt aus dem
Prompt/Stil, nicht aus einem zweiten Modell).

Workflow-JSONs werden NICHT erfunden: der Adapter laedt sie aus
`COMFY_WORKFLOW_<ROLLE>` (Pfad) oder `workflows/<rolle>.json` und meldet sonst
klar, was fehlt.
"""
from __future__ import annotations

import base64
import copy
import json
import logging
import os
import pathlib
import re
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

#: Rollen, die auf vorgefertigten Workern laufen, mit ihrem Erwartungsmodell.
COMFY_ROLES: Dict[str, Dict[str, str]] = {
    "music": {"worker": "acestep", "protocol": "workflow", "defaultModel": "acestep-v15-xl-base"},
    # Historisch bis 2026-09-27 (b90f7a8): lief auf PrunaAI-FLUX, prompt-basiert
    #   {"worker": "flux", "protocol": "prompt", "defaultModel": "flux1-dev-juiced"},
    # Seit 2026-09-27 laeuft imageHq auf demselben worker-comfyui wie imageLora
    # (Entscheidung "Weg A", b90f7a8): Workflow-Vertrag, kein prompt-Feld - ein
    # prompt wuerde stillschweigend ignoriert und das Demo-Bild des Graphen
    # geliefert. Aufruf mit `workflow` inline oder workflows/imageHq.json /
    # COMFY_WORKFLOW_IMAGEHQ; die Struktur von workflows/image_flux1.json passt.
    # `kind: image` ist PFLICHT: ohne es gilt der ACE-Step-Weg, und dann landen
    # Prompt/Seed/Groesse an Musik-Knoten, die es im Bildgraphen nicht gibt.
    # `imagePath: single` waehlt den eigenen Graphen statt der Basismodell-Wahl
    # (die gehoert zu imageLora).
    "imageHq": {
        "worker": "comfyui",
        "protocol": "workflow",
        "kind": "image",
        "imagePath": "single",
        "defaultModel": "flux1-dev",
    },
    "videoReal": {"worker": "ti2v", "protocol": "prompt", "defaultModel": "wan22-ti2v-5b"},
    "videoAbstract": {
        # Seit 2026-09-16 derselbe Wan-Worker wie videoReal: das vorher deployte
        # generische worker-comfyui hatte keine Gewichte (live geprueft: leere
        # Modell-Listen), ein Workflow haette das nicht geloest.
        "worker": "wan",
        "protocol": "prompt",
        "defaultModel": "wan22-ti2v-5b",
    },
    "imageLora": {
        # Anders als beim alten videoAbstract-Experiment bringt DIESER
        # worker-comfyui die Gewichte mit bzw. liest sie von einem Network
        # Volume (Release 5.11.0, Layout: /runpod-volume/models/...).
        "worker": "comfyui",
        "protocol": "workflow",
        # `kind` steuert, WIE Prompt/Seed/LoRAs in den Graphen kommen.
        # Ohne `kind` gilt der ACE-Step-Weg (Rueckwaertsvertraeglichkeit: music).
        "kind": "image",
        "defaultModel": "image-lora-stack",
    },
}

WORKFLOW_DIR = pathlib.Path(__file__).resolve().parent / "workflows"

#: Basis-Modelle der Rolle `imageLora` -> Workflow-Datei ohne `.json`.
#: `base` ist der einzige Schalter im Aufruf; die Dateinamen sind bewusst
#: identisch mit den Dateinamen im worker-comfyui-Image bzw. auf dem Volume
#: (siehe docs/VISUAL_LORA_STACK.md), damit ein Umzug Image<->Volume die
#: Workflows nicht aendert.
IMAGE_BASES: Dict[str, str] = {
    "sdxl": "image_sdxl",
    "flux1": "image_flux1",
}

#: Basis, wenn der Aufrufer keine nennt. SDXL, weil es die kommerziell saubere
#: Spur ist (openrail++) und die 32 eigenen Themen-LoRAs traegt.
DEFAULT_IMAGE_BASE = "sdxl"

#: Knoten, die ein Basisgewicht laden. Genau EINER darf im Graphen stehen –
#: bei mehreren waere nicht entscheidbar, wo die LoRA-Kette ansetzt.
IMAGE_BASE_LOADER_NODES = ("CheckpointLoaderSimple", "CheckpointLoader", "UNETLoader", "UnetLoaderGGUF")

#: Sampler-Knoten, an denen Seed/Steps/CFG haengen.
IMAGE_SAMPLER_NODES = ("KSampler", "KSamplerAdvanced")

#: Latent-Knoten, an denen die Aufloesung haengt.
IMAGE_LATENT_NODES = ("EmptyLatentImage", "EmptySD3LatentImage", "EmptyLatentImagePresets")

#: Textknoten, in die der Prompt geschrieben wird.
IMAGE_TEXT_NODES = ("CLIPTextEncode", "CLIPTextEncodeFlux", "T5TextEncode")

#: Knoten, die eine Konditionierung unveraendert weiterreichen. Aus ComfyUI
#: exportierte FLUX-Graphen haben regelmaessig ein `FluxGuidance` zwischen
#: Sampler und Textknoten; ohne diese Liste kaeme der Prompt dort nicht an.
CONDITIONING_PASSTHROUGH_NODES = (
    "FluxGuidance",
    "ConditioningConcat",
    "ConditioningCombine",
    "ConditioningSetArea",
    "ConditioningSetAreaPercentage",
    "ConditioningSetTimestepRange",
    "ConditioningZeroOut",
)

#: LoRA-Dateinamen: nur Basename, nur .safetensors. Ein Name mit `/`, `\` oder
#: `..` wird abgelehnt – sonst koennte ein Aufruf Dateien ausserhalb von
#: models/loras/ laden, und auf einem geteilten Volume waere das eine
#: Grenzueberschreitung.
LORA_NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\-]*\.safetensors$")

#: ComfyUI-Knoten, die bei ACE-Step den Prompt tragen (1.0 und 1.5).
ACE_TEXT_ENCODE_NODES = ("TextEncodeAceStepAudio1.5", "TextEncodeAceStepAudio")

#: Knoten, deren Laenge zur Duration passen muss (sonst passt das Latent nicht
#: zum Text-Konditionierungspfad).
ACE_LATENT_NODES = ("EmptyAceStep1.5LatentAudio", "EmptyAceStepLatentAudio")

#: Antwort-Felder, die einen Primaerwert direkt tragen (worker-comfyui < 5.0.0).
PRIMARY_MESSAGE_FIELDS = ("message", "image", "images", "video", "audio", "files", "output")


def workflow_for(
    role: str,
    payload: Optional[Dict[str, Any]] = None,
    env: Optional[Dict[str, str]] = None,
    name: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Workflow-JSON: Payload > `COMFY_WORKFLOW_<NAME>` > `workflows/<name>.json`.

    ``name`` erlaubt eine Rolle mit MEHREREN Graphen (`imageLora` faehrt SDXL und
    FLUX.1-dev aus einem Worker). Ohne Angabe ist ``name`` die Rolle selbst –
    das bisherige Verhalten bleibt damit unveraendert.
    """
    source = os.environ if env is None else env
    inline = (payload or {}).get("workflow")
    if isinstance(inline, dict):
        return inline
    workflow_name = name or role
    for candidate in (
        source.get(f"COMFY_WORKFLOW_{workflow_name.upper()}"),
        str(WORKFLOW_DIR / f"{workflow_name}.json"),
    ):
        if not candidate:
            continue
        path = pathlib.Path(candidate)
        if not path.is_file():
            continue
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
    return None


def build_prompt_request(args: Dict[str, Any], model: str) -> Dict[str, Any]:
    """Prompt-basierter Request (Wan2.2-/FLUX-Klasse)."""
    request: Dict[str, Any] = {}
    prompt = str(args.get("prompt") or args.get("text") or "").strip()
    if prompt:
        request["prompt"] = prompt
    negative = str(args.get("negative_prompt") or args.get("negativePrompt") or "").strip()
    if negative:
        request["negative_prompt"] = negative
    for key in ("width", "height", "length", "steps", "cfg", "seed", "image_url", "image_base64", "image_path"):
        if key in args and args[key] is not None:
            request[key] = args[key]
    loras = args.get("lora_pairs")
    if isinstance(loras, list):
        request["lora_pairs"] = loras
    if not request:
        raise ValueError(f"{model}: leerer Request – prompt oder image_url/image_base64 erwartet")
    return request


def apply_prompt_to_workflow(workflow: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
    """Prompt/Laenge/Seed eines Tool-Aufrufs in einen ComfyUI-Graphen schreiben.

    Workflow-Worker kennen keinen `prompt`-Parameter: der Text steckt IM Graphen.
    Ohne diesen Schritt wuerde jeder Aufruf den im Workflow hinterlegten
    Demo-Song erzeugen, waehrend der Aufrufer seinen Prompt fuer erledigt haelt -
    ein stiller Fehlschlag. Deshalb setzt der Adapter die Werte in die
    ACE-Step-Knoten ein (Tags/Lyrics/BPM/Seed/Duration) und zieht die
    Latent-Laenge mit, damit Konditionierung und Latent zusammenpassen.

    Erkannt wird ueber die Knotenklassen der eingesetzten ComfyUI-Version
    (`comfy_extras/nodes_ace.py`). Findet der Adapter keinen solchen Knoten,
    bleibt der Workflow unveraendert und das wird als Warnung geloggt.
    """
    if not isinstance(workflow, dict) or not workflow:
        return workflow

    prompt = str(args.get("prompt") or args.get("tags") or args.get("text") or "").strip()
    lyrics = str(args.get("lyrics") or "").strip()
    seconds = args.get("duration", args.get("seconds"))
    bpm = args.get("bpm")
    seed = args.get("seed")
    if not prompt and not lyrics and seconds is None and bpm is None and seed is None:
        return workflow

    result = copy.deepcopy(workflow)
    touched_text = False
    for node in result.values():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        class_type = str(node.get("class_type") or "")
        if class_type in ACE_TEXT_ENCODE_NODES:
            if prompt:
                inputs["tags"] = prompt
            if lyrics:
                inputs["lyrics"] = lyrics
            if bpm is not None:
                inputs["bpm"] = int(bpm)
            if seed is not None and not isinstance(inputs.get("seed"), list):
                inputs["seed"] = int(seed)
            if seconds is not None and not isinstance(inputs.get("duration"), list):
                # Ein verdrahteter duration-Eingang bleibt unangetastet.
                inputs["duration"] = float(seconds)
            touched_text = True
        elif class_type in ACE_LATENT_NODES and seconds is not None and not isinstance(inputs.get("seconds"), list):
            inputs["seconds"] = float(seconds)
        elif class_type == "KSampler" and seed is not None and not isinstance(inputs.get("seed"), list):
            inputs["seed"] = int(seed)

    if not touched_text and (prompt or lyrics):
        logger.warning(
            "Workflow ohne ACE-Step-Textknoten (%s): Prompt/Lyrics wurden NICHT eingesetzt",
            sorted({str(node.get("class_type")) for node in result.values() if isinstance(node, dict)}),
        )
        return workflow
    return result


def _loader_node_id(workflow: Dict[str, Any]) -> Optional[str]:
    """Node-ID des Basisgewichts. Genau eine wird erwartet, sonst None."""
    ids = [
        nid
        for nid, node in workflow.items()
        if isinstance(node, dict) and node.get("class_type") in IMAGE_BASE_LOADER_NODES
    ]
    return ids[0] if len(ids) == 1 else None


def parse_lora_pairs(lora_pairs: Any) -> List[Any]:
    """LoRA-Eingaben in ``(name, weight)`` bringen – oder klar ablehnen.

    Akzeptiert wird ``[{"name": "x.safetensors", "weight": 0.8}]`` (die Form des
    Adapters), ``[["x.safetensors", 0.8]]`` und ``["x.safetensors"]``.
    Ein ungueltiger Name wird **abgelehnt** statt still uebersprungen: eine
    stillschweigend weggelassene LoRA sieht im Ergebnis wie eine
    nicht-wirksame LoRA aus, und genau das soll der Qualitaetsnachweis
    unterscheiden koennen.
    """
    if not lora_pairs:
        return []
    if not isinstance(lora_pairs, list):
        raise ValueError("lora_pairs muss eine Liste sein")
    parsed: List[Any] = []
    for index, entry in enumerate(lora_pairs):
        if isinstance(entry, str):
            raw_name, raw_weight = entry, 1.0
        elif isinstance(entry, (list, tuple)) and entry:
            raw_name = entry[0]
            raw_weight = entry[1] if len(entry) > 1 else 1.0
        elif isinstance(entry, dict):
            raw_name = entry.get("name") or entry.get("lora_name") or entry.get("lora")
            raw_weight = entry.get("weight", entry.get("strength", 1.0))
        else:
            raise ValueError(f"lora_pairs[{index}]: weder Name noch Objekt: {entry!r}")
        name = str(raw_name or "").strip()
        if not LORA_NAME_PATTERN.match(name):
            raise ValueError(
                f"lora_pairs[{index}]: ungueltiger LoRA-Name {name!r} – erwartet wird ein "
                "Dateiname wie 'mstyle_comic.safetensors' (kein Pfad, keine Ordner)"
            )
        try:
            weight = float(raw_weight)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"lora_pairs[{index}]: Gewicht {raw_weight!r} ist keine Zahl") from exc
        parsed.append((name, weight))
    return parsed


def apply_loras_to_workflow(workflow: Dict[str, Any], lora_pairs: Any) -> Dict[str, Any]:
    """LoRA-Kette zwischen Basisgewicht und Verbraucher einziehen.

    Der Graph wird **nicht** umgeschrieben, sondern erweitert: nach dem
    Basis-Loader haengt eine `LoraLoader`-Kette (eine Stufe je LoRA, gewichtet),
    und jede Verbindung, die vorher auf die MODEL-/CLIP-Ausgaenge des Loaders
    zeigte, zeigt danach auf die Kette. Die VAE-Verbindung (Slot 2) bleibt
    unangetastet – LoRAs aendern den VAE nicht.

    Reihenfolge: die Liste wird von links nach rechts gekettet, die **letzte**
    LoRA liegt also am naechsten am Sampler. Bei mehreren LoRAs ist das die
    uebliche Konvention (die spezifischste zuletzt).
    """
    parsed = parse_lora_pairs(lora_pairs)
    if not parsed:
        return workflow
    if not isinstance(workflow, dict) or not workflow:
        raise ValueError("apply_loras_to_workflow: leerer Workflow")

    loader_id = _loader_node_id(workflow)
    if loader_id is None:
        raise ValueError(
            "apply_loras_to_workflow: der Workflow hat nicht genau einen Basis-Loader "
            f"({', '.join(IMAGE_BASE_LOADER_NODES)}) – ohne ihn ist nicht entscheidbar, "
            "wo die LoRA-Kette ansetzt"
        )

    result = copy.deepcopy(workflow)
    previous = loader_id
    chain: Dict[str, Any] = {}
    for index, (name, weight) in enumerate(parsed, start=1):
        node_id = f"lora{index}"
        while node_id in result:  # Kollision mit einer echten Knoten-ID
            node_id = f"_{node_id}"
        chain[node_id] = {
            "class_type": "LoraLoader",
            "inputs": {
                "lora_name": name,
                "strength_model": weight,
                "strength_clip": weight,
                "model": [previous, 0],
                "clip": [previous, 1],
            },
            "_meta": {"title": f"LoRA {index}: {name} ({weight})"},
        }
        previous = node_id

    # Verbraucher umhaengen: [loader, 0|1] -> [letzte LoRA, 0|1]. Der VAE-Slot 2 bleibt.
    for node in result.values():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        for key, value in list(inputs.items()):
            if (
                isinstance(value, list)
                and len(value) == 2
                and str(value[0]) == str(loader_id)
                and value[1] in (0, 1)
            ):
                inputs[key] = [previous, value[1]]
    result.update(chain)
    return result


def _linked_node(workflow: Dict[str, Any], value: Any) -> Optional[str]:
    """Node-ID hinter einer ComfyUI-Verbindung ``[node_id, slot]``."""
    if isinstance(value, list) and len(value) == 2 and isinstance(value[0], (str, int)):
        return str(value[0])
    return None


def _text_node_for(workflow: Dict[str, Any], start: Any) -> Optional[str]:
    """Vom Sampler-Eingang zum Textknoten – auch durch Durchleit-Knoten.

    In echten, aus ComfyUI exportierten FLUX-Graphen haengt zwischen Sampler und
    Textknoten oft noch ein `FluxGuidance`. Ohne diesen Schritt wuerde der
    Prompt dort nicht ankommen.
    """
    node_id = _linked_node(workflow, start)
    for _ in range(8):  # begrenzt, damit ein Zyklus nicht endlos laeuft
        if node_id is None:
            return None
        node = workflow.get(node_id)
        if not isinstance(node, dict):
            return None
        class_type = str(node.get("class_type") or "")
        if class_type in IMAGE_TEXT_NODES:
            return node_id
        if class_type not in CONDITIONING_PASSTHROUGH_NODES:
            return None
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            return None
        node_id = _linked_node(workflow, inputs.get("conditioning"))
    return None


def apply_prompt_to_image_workflow(workflow: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
    """Prompt/Seed/Sampler/Aufloesung in einen Bild-Graphen schreiben.

    Zugeordnet wird **ueber die Verdrahtung**, nicht ueber Knoten-IDs: der
    Sampler nennt in `positive`/`negative`, welcher Textknoten gemeint ist, und
    `latent_image` nennt den Latent-Knoten. Damit funktioniert derselbe Code fuer
    SDXL und FLUX.1-dev, obwohl die beiden Graphen aehnlich, aber nicht gleich
    sind.

    Findet der Adapter den Sampler nicht, bleibt der Workflow unveraendert und
    das wird als Warnung geloggt – nie ein stiller Fehlschlag.
    """
    if not isinstance(workflow, dict) or not workflow:
        return workflow

    prompt = str(args.get("prompt") or args.get("text") or "").strip()
    negative = str(
        args.get("negative_prompt") or args.get("negativePrompt") or args.get("negative") or ""
    ).strip()
    seed = args.get("seed")
    steps = args.get("steps")
    cfg = args.get("cfg", args.get("cfg_scale"))
    denoise = args.get("denoise")
    sampler_name = args.get("sampler_name")
    scheduler = args.get("scheduler")
    width, height = args.get("width"), args.get("height")

    wants_text = bool(prompt or negative)
    wants_sampler = any(v is not None for v in (seed, steps, cfg, denoise, sampler_name, scheduler))
    wants_size = width is not None or height is not None
    if not (wants_text or wants_sampler or wants_size):
        return workflow

    samplers = [
        nid
        for nid, node in workflow.items()
        if isinstance(node, dict) and node.get("class_type") in IMAGE_SAMPLER_NODES
    ]
    if not samplers:
        logger.warning(
            "Bild-Workflow ohne Sampler (%s): Prompt/Seed/Groesse wurden NICHT eingesetzt",
            sorted({str(node.get("class_type")) for node in workflow.values() if isinstance(node, dict)}),
        )
        return workflow

    result = copy.deepcopy(workflow)
    filled_text: List[str] = []
    filled_size: List[str] = []
    for sampler_id in samplers:
        inputs = result[sampler_id].setdefault("inputs", {})
        if isinstance(inputs, dict):
            if prompt:
                target = _text_node_for(result, inputs.get("positive"))
                if target:
                    result[target].setdefault("inputs", {})["text"] = prompt
                    filled_text.append(target)
            if negative:
                target = _text_node_for(result, inputs.get("negative"))
                if target:
                    result[target].setdefault("inputs", {})["text"] = negative
                    filled_text.append(target)
            for key, value in (
                ("seed", seed),
                ("steps", steps),
                ("cfg", cfg),
                ("denoise", denoise),
                ("sampler_name", sampler_name),
                ("scheduler", scheduler),
            ):
                # Ein verdrahteter Eingang bleibt unangetastet (wie bei ACE-Step).
                if value is not None and not isinstance(inputs.get(key), list):
                    inputs[key] = value
            if wants_size:
                latent_id = _linked_node(result, inputs.get("latent_image"))
                latent = result.get(latent_id) if latent_id else None
                if isinstance(latent, dict) and latent.get("class_type") in IMAGE_LATENT_NODES:
                    latent_inputs = latent.setdefault("inputs", {})
                    if width is not None:
                        latent_inputs["width"] = int(width)
                    if height is not None:
                        latent_inputs["height"] = int(height)
                    filled_size.append(str(latent_id))

    if prompt and not filled_text:
        logger.warning(
            "Bild-Workflow: Prompt %r kam an keinem Textknoten an (positive/negative nicht "
            "verdrahtet) – der Aufruf wuerde das Demo-Bild erzeugen",
            prompt[:60],
        )
        return workflow
    if wants_size and not filled_size:
        logger.warning(
            "Bild-Workflow: Aufloesung %sx%s kam an keinem Latent-Knoten an", width, height
        )
    return result


def build_workflow_request(
    role: str,
    args: Dict[str, Any],
    payload: Optional[Dict[str, Any]] = None,
    env: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Workflow-basierter Request (ACE-Step / worker-comfyui)."""
    spec = COMFY_ROLES.get(role) or {}
    if spec.get("kind") == "image":
        # `imageLora` waehlt aus mehreren Basismodellen und kettet LoRAs;
        # `imageHq` faehrt EINEN eigenen Graphen (workflows/imageHq.json).
        if spec.get("imagePath") == "single":
            return build_single_image_request(role, args, payload, env)
        return build_image_request(role, args, payload, env)

    workflow = workflow_for(role, {**(payload or {}), **args}, env)
    if workflow is None:
        raise ValueError(
            f"{role}: kein Workflow konfiguriert – COMFY_WORKFLOW_{role.upper()} setzen "
            f"(Export aus der ComfyUI-UI mit 'Workflow → Export (API)') oder workflows/{role}.json ablegen"
        )
    workflow = apply_prompt_to_workflow(workflow, args)
    request: Dict[str, Any] = {"workflow": workflow}
    images = args.get("images")
    if isinstance(images, list) and images:
        request["images"] = [img for img in images if isinstance(img, dict) and img.get("name") and img.get("image")]
    return request


def build_single_image_request(
    role: str,
    args: Dict[str, Any],
    payload: Optional[Dict[str, Any]] = None,
    env: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Request einer Bild-Rolle mit EINEM eigenen Graphen (`imageHq`).

    Anders als `imageLora` gibt es hier keine Basismodell-Wahl und keine
    LoRA-Kette: der Graph kommt aus `workflow` inline, `COMFY_WORKFLOW_<ROLLE>`
    oder `workflows/<rolle>.json`. Prompt/Seed/Groesse werden ueber die
    Sampler-Verdrahtung eingesetzt (`apply_prompt_to_image_workflow`) - ohne
    das wuerde jeder Aufruf das Demo-Bild des Graphen liefern.
    """
    workflow = workflow_for(role, {**(payload or {}), **args}, env)
    if workflow is None:
        raise ValueError(
            f"{role}: kein Workflow konfiguriert – COMFY_WORKFLOW_{role.upper()} setzen "
            f"(Export aus der ComfyUI-UI mit 'Workflow → Export (API)') oder workflows/{role}.json ablegen"
        )
    workflow = apply_prompt_to_image_workflow(workflow, args)
    request: Dict[str, Any] = {"workflow": workflow}
    images = args.get("images")
    if isinstance(images, list) and images:
        request["images"] = [
            img for img in images if isinstance(img, dict) and img.get("name") and img.get("image")
        ]
    return request


def build_image_request(
    role: str,
    args: Dict[str, Any],
    payload: Optional[Dict[str, Any]] = None,
    env: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Request der Bild-Rolle `imageLora`: Basis waehlen, Prompt setzen, LoRAs ketten.

    Der Aufruf nennt nur `base` (`sdxl`/`flux1`) – welcher Dateiname dahinter
    steht, weiss der Workflow. Damit kommt ein neues Basismodell ohne Aenderung
    am Aufrufer dazu: Workflow ablegen, `IMAGE_BASES` ergaenzen.

    Anders als `imageHq` liefert worker-comfyui **kein** `seed` in der Antwort
    zurueck. Der Aufrufer behaelt den Seed aus seinem eigenen Request – die
    Reproduzierbarkeit haengt nicht daran, dass der Worker ihn zurueckspiegelt.
    """
    base = str(args.get("base") or DEFAULT_IMAGE_BASE).strip().lower()
    if base not in IMAGE_BASES:
        raise ValueError(
            f"{role}: unbekannte base {base!r} (erwartet: {', '.join(sorted(IMAGE_BASES))})"
        )
    name = IMAGE_BASES[base]
    workflow = workflow_for(role, {**(payload or {}), **args}, env, name=name)
    if workflow is None:
        raise ValueError(
            f"{role}: kein Workflow fuer base {base!r} – COMFY_WORKFLOW_{name.upper()} setzen "
            f"oder workflows/{name}.json ablegen (Export aus der ComfyUI-UI mit 'Workflow → Export (API)')"
        )
    workflow = apply_prompt_to_image_workflow(workflow, args)
    workflow = apply_loras_to_workflow(workflow, args.get("lora_pairs"))
    request: Dict[str, Any] = {"workflow": workflow}
    images = args.get("images")
    if isinstance(images, list) and images:
        request["images"] = [
            img for img in images if isinstance(img, dict) and img.get("name") and img.get("image")
        ]
    return request


def build_request(
    name: str,
    role: str,
    model: str,
    args: Dict[str, Any],
    payload: Optional[Dict[str, Any]] = None,
    env: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Unser Tool-Aufruf -> Request-Koerper des vorgefertigten Workers."""
    spec = COMFY_ROLES.get(role)
    if spec is None:
        raise ValueError(f"{name}: Rolle {role} laeuft nicht auf einem ComfyUI-Worker")
    if spec["protocol"] == "workflow":
        return build_workflow_request(role, args, payload, env)
    if args.get("workflow"):
        # Manche prompt-Worker akzeptieren trotzdem einen expliziten Workflow.
        return build_workflow_request(role, args, payload, env)
    return build_prompt_request(args, model)


def _data_uri_kind(value: str) -> Optional[str]:
    """`data:image/png;base64,...` -> 'image' (nur der Medientyp, kein Inhalt)."""
    if not value.startswith("data:"):
        return None
    head = value[5:].split(";", 1)[0].split("/", 1)
    return head[0] if len(head) == 2 else None


def _classify_value(key: str, value: Any) -> Optional[str]:
    """Erwartete Medienart aus Feldname/Wert ableiten."""
    if isinstance(value, str):
        media = _data_uri_kind(value)
        if media in ("image", "video", "audio"):
            return media
        if key in ("image", "images"):
            return "image"
        if key in ("video", "videos"):
            return "video"
        if key in ("audio", "files"):
            return "audio"
    return None


def _as_data_uri(kind: str, data: str) -> str:
    """Rohes base64 -> `data:<mime>;base64,…`.

    worker-comfyui liefert Bilder als **rohes** base64 ohne Praefix
    (`{filename, type: "base64", data: "iVBORw0…"}`), `imageHq` dagegen als
    `data:image/png;base64,…`. Der Aufrufer soll beide Formen gleich behandeln
    koennen, deshalb wird hier angeglichen – ein blosses base64 ist im
    Ergebnis-JSON sonst nicht von einem Textfeld zu unterscheiden.
    """
    if not data or data.startswith("data:"):
        return data
    mime = {"image": "image/png", "video": "video/mp4", "audio": "audio/mpeg"}.get(kind)
    return f"data:{mime};base64,{data}" if mime else data


def _item(kind: Optional[str], value: Dict[str, Any]) -> Dict[str, Any]:
    """Einen Ausgabe-Eintrag auf {kind, filename?, data?|url?, nodeId?} bringen."""
    entry: Dict[str, Any] = {"kind": kind or str(value.get("kind") or value.get("type") or "unknown")}
    for source_key, target_key in (("filename", "filename"), ("name", "filename"), ("node_id", "nodeId"), ("nodeId", "nodeId")):
        if value.get(source_key) is not None and target_key not in entry:
            entry[target_key] = value[source_key]
    for data_key in ("data", "image", "video", "audio", "base64"):
        data = value.get(data_key)
        if isinstance(data, str) and data:
            # Nur ein echtes base64 wird zum data:-URI. worker-comfyui liefert
            # bei konfiguriertem S3 stattdessen `type: "s3"` mit einem Pfad.
            if str(value.get("type") or "").lower() in ("s3", "url"):
                entry.setdefault("url", data)
            else:
                entry["data"] = _as_data_uri(entry["kind"], data)
            break
    for url_key in ("url", "s3_url", "s3Url", "download_url"):
        url = value.get(url_key)
        if isinstance(url, str) and url:
            entry["url"] = url
            break
    return entry


def normalize_output(output: Any) -> Dict[str, Any]:
    """Worker-Antwort -> {kind, items[], count} (formtolerant ueber alle Familien).

    Erkennt die vier live gepinnten Familien: Wan2.2 `video` (rohes base64),
    ACE-Step `files`, worker-comfyui `images`/`message` und FLUX `image_url`
    (`data:image/png;base64,…`, gemessen 2026-09-16). Zusaetzlich wird jedes
    unbekannte Feld mit einer `data:`-Nutzlast erkannt, damit ein neuer
    Feldname nicht still als `raw` durchfaellt. Bei unbekannter Form bleibt es
    bei `kind: "raw"` mit der unveraenderten Antwort – nie ein stiller Verlust.
    """
    if isinstance(output, dict):
        for field in ("video", "audio"):
            value = output.get(field)
            if isinstance(value, str) and value:
                return {"kind": field, "items": [{"kind": field, "data": value}], "count": 1}
        files = output.get("files")
        if isinstance(files, list) and files:
            items = [_item(None, f) for f in files if isinstance(f, dict)]
            kinds = {i["kind"] for i in items}
            kind = kinds.pop() if len(kinds) == 1 else ("mixed" if items else "unknown")
            return {"kind": kind, "items": items, "count": len(items)}
        images = output.get("images")
        if isinstance(images, list) and images:
            if all(isinstance(i, str) for i in images):
                return {"kind": "image", "items": [_item("image", {"data": i}) for i in images], "count": len(images)}
            items = [_item("image", i) for i in images if isinstance(i, dict)]
            return {"kind": "image", "items": items, "count": len(items)}
        # Prompt-Worker: imageHq (PrunaAI FLUX) liefert genau dieses Feld.
        for field in ("image_url", "imageUrl", "image"):
            value = output.get(field)
            if isinstance(value, str) and value:
                return {"kind": "image", "items": [{"kind": "image", "data": value}], "count": 1}
        message = output.get("message")
        if isinstance(message, (str, dict, list)) and message not in ("", None, [], {}):
            nested = normalize_output(message)
            return nested if nested["kind"] != "raw" else {"kind": "raw", "items": [], "count": 0, "payload": message}
        # Letzte Rettung: ein unbekanntes Feld mit data:-Nutzlast (formtolerant).
        for value in output.values():
            media = _data_uri_kind(value) if isinstance(value, str) else None
            if media in ("image", "video", "audio"):
                return {"kind": media, "items": [{"kind": media, "data": value}], "count": 1}
    if isinstance(output, list) and output and all(isinstance(i, str) for i in output):
        return {"kind": "unknown", "items": [_item(None, {"data": i}) for i in output], "count": len(output)}
    if isinstance(output, str) and output:
        media = _data_uri_kind(output)
        kind = media or "unknown"
        return {"kind": kind, "items": [{"kind": kind, "data": output}], "count": 1}
    return {"kind": "raw", "items": [], "count": 0, "payload": output}


def decode_item(item: Dict[str, Any], destination: pathlib.Path) -> Optional[pathlib.Path]:
    """Base64-Ausgabe auf Platte schreiben (R2-Upload uebernimmt die Pipeline)."""
    data = item.get("data")
    if not isinstance(data, str) or not data:
        return None
    payload = data.split(",", 1)[1] if data.startswith("data:") else data
    try:
        raw = base64.b64decode(payload, validate=True)
    except (ValueError, TypeError):
        return None
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(raw)
    return destination
