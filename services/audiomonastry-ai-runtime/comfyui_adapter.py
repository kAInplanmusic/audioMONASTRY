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
* **PrunaAI FLUX** (`imageHq`): prompt-basiert – `{prompt}` ->
  `{image_url: "data:image/png;base64,...", images: [<derselbe URI>], seed}`.

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
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

#: Rollen, die auf vorgefertigten Workern laufen, mit ihrem Erwartungsmodell.
COMFY_ROLES: Dict[str, Dict[str, str]] = {
    "music": {"worker": "acestep", "protocol": "workflow", "defaultModel": "acestep-v15-xl-base"},
    "imageHq": {"worker": "flux", "protocol": "prompt", "defaultModel": "flux1-dev-juiced"},
    "videoReal": {"worker": "ti2v", "protocol": "prompt", "defaultModel": "wan22-ti2v-5b"},
    "videoAbstract": {
        # Seit 2026-09-16 derselbe Wan-Worker wie videoReal: das vorher deployte
        # generische worker-comfyui hatte keine Gewichte (live geprueft: leere
        # Modell-Listen), ein Workflow haette das nicht geloest.
        "worker": "wan",
        "protocol": "prompt",
        "defaultModel": "wan22-ti2v-5b",
    },
}

WORKFLOW_DIR = pathlib.Path(__file__).resolve().parent / "workflows"

#: ComfyUI-Knoten, die bei ACE-Step den Prompt tragen (1.0 und 1.5).
ACE_TEXT_ENCODE_NODES = ("TextEncodeAceStepAudio1.5", "TextEncodeAceStepAudio")

#: Knoten, deren Laenge zur Duration passen muss (sonst passt das Latent nicht
#: zum Text-Konditionierungspfad).
ACE_LATENT_NODES = ("EmptyAceStep1.5LatentAudio", "EmptyAceStepLatentAudio")

#: Antwort-Felder, die einen Primaerwert direkt tragen (worker-comfyui < 5.0.0).
PRIMARY_MESSAGE_FIELDS = ("message", "image", "images", "video", "audio", "files", "output")


def workflow_for(role: str, payload: Optional[Dict[str, Any]] = None, env: Optional[Dict[str, str]] = None) -> Optional[Dict[str, Any]]:
    """Workflow-JSON einer Rolle: Payload > `COMFY_WORKFLOW_<ROLLE>` > `workflows/<rolle>.json`."""
    source = os.environ if env is None else env
    inline = (payload or {}).get("workflow")
    if isinstance(inline, dict):
        return inline
    for candidate in (source.get(f"COMFY_WORKFLOW_{role.upper()}"), str(WORKFLOW_DIR / f"{role}.json")):
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


def build_workflow_request(
    role: str,
    args: Dict[str, Any],
    payload: Optional[Dict[str, Any]] = None,
    env: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Workflow-basierter Request (ACE-Step / worker-comfyui)."""
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


def _item(kind: Optional[str], value: Dict[str, Any]) -> Dict[str, Any]:
    """Einen Ausgabe-Eintrag auf {kind, filename?, data?|url?, nodeId?} bringen."""
    entry: Dict[str, Any] = {"kind": kind or str(value.get("kind") or value.get("type") or "unknown")}
    for source_key, target_key in (("filename", "filename"), ("name", "filename"), ("node_id", "nodeId"), ("nodeId", "nodeId")):
        if value.get(source_key) is not None and target_key not in entry:
            entry[target_key] = value[source_key]
    for data_key in ("data", "image", "video", "audio", "base64"):
        data = value.get(data_key)
        if isinstance(data, str) and data:
            entry["data"] = data
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
