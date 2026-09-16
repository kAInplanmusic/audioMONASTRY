"""AudioMONASTRY AI Runtime – Orchestrator (Mixture-of-Agents) + MCP-Tool-Bruecke
=============================================================================
Instanz 8 der Flotte (docs/runpod-8-instances-complete-plan.md). Der Orchestrator
nimmt einen multimodalen Auftrag entgegen und baut daraus eine ausfuehrbare
Pipeline ueber die Fach-Instanzen 2–7.

Drei Schichten (MoA), alle Modelle OEFFENTLICH (kein HF-Token noetig):
  1. Classifier      qwen3-4b     – Was ist das fuer eine Aufgabe? Welche
                                    Bereiche (audio/visual/music) braucht sie?
  2. Planner A/B     phi-35-mini  – zwei UNABHAENGIGE Pipeline-Plaene aus
                     ministral-8b   verschiedenen Modellfamilien (Diversitaet)
  3. Aggregator      qwen3-4b     – vergleicht beide Plaene, waehlt/merged
                                    den besseren und gibt den finalen Plan aus
  4. Ausfuehrung     MCP-Tools    – Schritte gegen die Fach-Instanzen

Die Modell-IDs kommen aus dem Rollen-Manifest (`orchestrator`), ueberschreibbar
per `MOA_CLASSIFIER_MODEL` / `MOA_PLANNER_A_MODEL` / `MOA_PLANNER_B_MODEL` /
`MOA_AGGREGATOR_MODEL`. Das Modul ist ohne GPU/Transformers importierbar – die
schweren Aufrufe sind lazy und die Plan-Logik ist rein (unit-testbar).
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

#: Rolle -> (Env-Override, Default-Modell-ID aus dem Rollen-Manifest).
#: Alle vier Modelle sind OEFFENTLICH (kein HF-Token, keine gated Repos) und
#: passen zusammen in 48 GB: Qwen3-4B (9) + Phi-3.5-mini (8) + Ministral-8B (16)
#: = 33 GB bei 42 GB nutzbarem Budget. Der Aggregator nutzt bewusst dasselbe
#: Modell wie der Classifier – dadurch kostet der vierte Stand keinen VRAM.
MOA_MODEL_ROLES: Dict[str, Tuple[str, str]] = {
    "classifier": ("MOA_CLASSIFIER_MODEL", "qwen3-4b"),
    "planner_a": ("MOA_PLANNER_A_MODEL", "phi-35-mini"),
    "planner_b": ("MOA_PLANNER_B_MODEL", "ministral-8b"),
    "aggregator": ("MOA_AGGREGATOR_MODEL", "qwen3-4b"),
}

#: MCP-Tool-Katalog: Tool -> (Rolle, Task, Modell, Protokoll).
#: `comfyui`-Tools laufen auf den vorgefertigten ComfyUI-/Hub-Workern und
#: brauchen den Adapter (Punkt 2 der Umsetzung); bis dahin melden sie einen
#: klaren, nicht-retrybaren Fehler statt still zu scheitern.
TOOL_CATALOG: Dict[str, Dict[str, str]] = {
    "ears.analyze": {"role": "ears", "task": "audio.analyze", "model": "essentia"},
    "ears.transcribe": {"role": "ears", "task": "audio.transcribe", "model": "whisper-large-v3"},
    "ears.embed": {"role": "ears", "task": "audio.embed", "model": "clap-music"},
    "ears.classify": {"role": "ears", "task": "audio.classify", "model": "ast-audioset"},
    "ears.diarize": {"role": "ears", "task": "audio.diarize", "model": "pyannote-diarization"},
    "ears.understand": {"role": "ears", "task": "audio.understand", "model": "qwen2-audio-7b"},
    "voice.tts": {"role": "voiceGen", "task": "tts", "model": "qwen3-tts-17b"},
    "voice.voice_design": {"role": "voiceGen", "task": "tts", "model": "qwen3-tts-voicedesign"},
    "voice.stem_separate": {"role": "voiceGen", "task": "stem.separate", "model": "htdemucs-6s"},
    "voice.sfx": {"role": "voiceGen", "task": "audio.generate", "model": "stable-audio-open-1.0"},
    "music.generate": {"role": "music", "task": "song", "model": "acestep-v15-xl-base", "protocol": "comfyui"},
    "music.remix": {"role": "music", "task": "song", "model": "acestep-v15-xl-sft", "protocol": "comfyui"},
    "music.drop": {"role": "music", "task": "song", "model": "acestep-v15-xl-turbo", "protocol": "comfyui"},
    "image.generate": {"role": "imageHq", "task": "image.generate", "model": "flux2-dev", "protocol": "comfyui"},
    "image.img2img": {"role": "imageHq", "task": "image.generate", "model": "qwen-image-2512", "protocol": "comfyui"},
    "image.upscale": {"role": "imageHq", "task": "image.generate", "model": "realesrgan-x4", "protocol": "comfyui"},
    "video_real.text2video": {"role": "videoReal", "task": "video.generate", "model": "wan22-t2v-a14b", "protocol": "comfyui"},
    "video_real.img2video": {"role": "videoReal", "task": "video.generate", "model": "wan22-t2v-a14b", "protocol": "comfyui"},
    "video_abstract.text2video": {"role": "videoAbstract", "task": "video.abstract", "model": "ltx-video-13b", "protocol": "comfyui"},
    "video_abstract.glitch": {"role": "videoAbstract", "task": "video.abstract", "model": "ltx-video-13b", "protocol": "comfyui"},
}

#: Rollen-Endpoint-Env (Spiegel von endpointRegistry.ts).
ROLE_ENDPOINT_ENV: Dict[str, str] = {
    "ears": "RP_ENDPOINT_ID_EARS",
    "voiceGen": "RP_ENDPOINT_ID_VOICE",
    "music": "RP_ENDPOINT_ID_MUSIC",
    "imageHq": "RP_ENDPOINT_ID_IMAGE",
    "videoReal": "RP_ENDPOINT_ID_VIDEO_REAL",
    "videoAbstract": "RP_ENDPOINT_ID_VIDEO_ABSTRACT",
}

CLASSIFIER_SYSTEM = (
    "Du bist der Klassifizierer eines Audio-/Visual-Produktionssystems. "
    "Antworte AUSSCHLIESSLICH mit einem JSON-Objekt der Form "
    '{"areas": ["audio"|"music"|"image"|"video"], "intent": "<kurz>", "needs_tools": true|false}. '
    "Keine Erklaerung, kein Markdown."
)
PLANNER_SYSTEM = (
    "Du bist ein Pipeline-Planer. Zerlege den Auftrag in konkrete Schritte und "
    "antworte AUSSCHLIESSLICH mit JSON: "
    '{"steps": [{"tool": "<tool-name>", "args": {...}, "why": "<kurz>"}]}. '
    "Erlaubte Tools stehen im Auftrag. Keine Erklaerung, kein Markdown."
)
AGGREGATOR_SYSTEM = (
    "Du bist der Aggregator eines Mixture-of-Agents. Du bekommst zwei unabhaengige "
    "Pipelines. Waehle die bessere oder kombiniere sie und antworte AUSSCHLIESSLICH mit JSON: "
    '{"chosen": "a"|"b"|"merged", "reason": "<kurz>", "steps": [{"tool": "...", "args": {...}}]}. '
    "Keine Erklaerung, kein Markdown."
)


def resolve_moa_models(env: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """Modell-ID je MoA-Rolle (Env-Override > Default)."""
    source = os.environ if env is None else env
    return {
        role: (source.get(env_name, "") or default).strip()
        for role, (env_name, default) in MOA_MODEL_ROLES.items()
    }


def _json_candidates(text: str, prefer: str = "dict") -> List[str]:
    """Kandidaten in der Reihenfolge, in der sie geparst werden.

    `prefer` bestimmt, welche FORM zuerst gesucht wird, weil die Erwartung je
    Aufrufer verschieden ist:
      * `dict` (Default) – Klassifikation und Aggregat: das aeussere Objekt.
        Sonst wuerde `{"areas": ["audio"]}` auf sein inneres Array verkuerzt.
      * `list` – Plan-Schritte: eine nackte Liste. Sonst gewinnt bei
        "Prosa + [ {...}, {...} ]" das ERSTE innere Schritt-Objekt und der Plan
        schrumpft auf einen Schritt bzw. faellt ganz aus (Live-Fund 2026-09-16:
        Plan B kam leer zurueck, waehrend das Ergebnis "merged" meldete).

    Beide Formen bleiben erlaubt – `prefer` dreht nur die Reihenfolge.
    """
    cleaned = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.MULTILINE).strip()
    objects = [r"\{.*\}", r"\{.*?\}"]   # greedy, dann kurz
    arrays = [r"\[.*\]", r"\[.*?\]"]
    patterns = arrays + objects if prefer == "list" else objects + arrays
    candidates = [cleaned]
    for pattern in patterns:
        candidates += re.findall(pattern, cleaned, flags=re.DOTALL)
    return candidates


def extract_json(text: str, prefer: str = "dict") -> Optional[Any]:
    """Erstes JSON-Objekt/-Array aus einer LLM-Antwort (ohne Code-Fences).

    Die vollstaendige Antwort hat immer Vorrang; erst danach greifen die
    Suchmuster in der durch `prefer` gesetzten Form-Reihenfolge.
    """
    if not isinstance(text, str):
        return None
    for candidate in _json_candidates(text, prefer):
        try:
            return json.loads(candidate)
        except (ValueError, TypeError):
            continue
    return None


def normalize_areas(value: Any) -> List[str]:
    """Bereiche auf die bekannte Menge begrenzen (audio/music/image/video)."""
    allowed = ["audio", "music", "image", "video"]
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return []
    return [str(v).strip().lower() for v in value if str(v).strip().lower() in allowed]


def parse_classification(text: str) -> Dict[str, Any]:
    """Klassifizierer-Antwort robust lesen (faellt auf 'audio' zurueck)."""
    data = extract_json(text)
    if not isinstance(data, dict):
        return {"areas": ["audio"], "intent": "", "needs_tools": True, "parsed": False}
    areas = normalize_areas(data.get("areas"))
    return {
        "areas": areas or ["audio"],
        "intent": str(data.get("intent", ""))[:200],
        "needs_tools": bool(data.get("needs_tools", True)),
        "parsed": True,
    }


def _step_list(data: Any) -> List[Any]:
    """Schritt-Liste aus einer geparsten Antwort ziehen (formtolerant).

    Akzeptiert `{"steps": [...]}` (Prompt-Vorgabe), eine nackte Liste und ein
    einzelnes Schritt-Objekt. Alles andere bleibt leer – aber nicht mehr still:
    `planner_report` weist einen leeren Plan als Parse-Fehler aus.
    """
    if isinstance(data, dict):
        steps = data.get("steps")
        if isinstance(steps, list):
            return steps
        if "tool" in data:
            return [data]
        return []
    if isinstance(data, list):
        return data
    return []


def parse_steps(text: str) -> List[Dict[str, Any]]:
    """Plan-Schritte lesen; unbekannte Tools werden verworfen.

    `prefer="list"`: ein Plan darf eine nackte Liste sein, und bei
    "Prosa + [ {...}, {...} ]" muss die GANZE Liste gewinnen – nicht das erste
    innere Schritt-Objekt (sonst schrumpft der Plan still auf einen Schritt).
    """
    out: List[Dict[str, Any]] = []
    for step in _step_list(extract_json(text, prefer="list")):
        if not isinstance(step, dict):
            continue
        tool = str(step.get("tool", "")).strip()
        if tool not in TOOL_CATALOG:
            continue
        args = step.get("args")
        out.append({"tool": tool, "args": args if isinstance(args, dict) else {}})
    return out


def planner_report(text: str, steps: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Parse-Beleg eines Plans – macht einen leeren Plan sichtbar.

    Ein nicht-leerer Text ohne einen einzigen gueltigen Schritt ist ein
    Parse-Fehler (unparsebare Formatierung oder ausschliesslich unbekannte
    Tools) und kein "leerer Plan". Live am 2026-09-16 blieb genau das
    unsichtbar: Plan B kam als `[]` zurueck und das Ergebnis stand trotzdem auf
    `merged` – der MoA-Gewinn war damit nicht belegt.
    """
    raw = text if isinstance(text, str) else ""
    return {
        "chars": len(raw),
        "steps": len(steps),
        "parsed": bool(steps),
        "suspicious": bool(raw.strip()) and not steps,
    }


def merge_plans(choice: str, plan_a: List[Dict[str, Any]], plan_b: List[Dict[str, Any]]) -> Tuple[str, List[Dict[str, Any]]]:
    """Aggregator-Entscheidung anwenden (a/b/merged); dedupliziert nach Tool+Args.

    Faellt der gewaehlte Plan leer aus, wird auf den anderen zurueckgefallen –
    das Label nennt dann die tatsaechlich verwendete Quelle, nicht die Wahl.
    """
    if choice == "a":
        return ("a", plan_a) if plan_a else (("b", plan_b) if plan_b else ("merged", []))
    if choice == "b":
        return ("b", plan_b) if plan_b else (("a", plan_a) if plan_a else ("merged", []))
    seen: set[str] = set()
    merged: List[Dict[str, Any]] = []
    for step in [*plan_a, *plan_b]:
        key = f"{step['tool']}:{json.dumps(step['args'], sort_keys=True)}"
        if key in seen:
            continue
        seen.add(key)
        merged.append(step)
    return "merged", merged


def tool_catalog_for(areas: List[str]) -> List[str]:
    """Tool-Namen, die zu den erkannten Bereichen passen (Prompt-Kontext)."""
    if not areas:
        return sorted(TOOL_CATALOG)
    prefixes = {"audio": ("ears.", "voice."), "music": ("music.",), "image": ("image.",), "video": ("video_",)}
    names: List[str] = []
    for area in areas:
        for prefix in prefixes.get(area, ()):
            names.extend(sorted(n for n in TOOL_CATALOG if n.startswith(prefix)))
    return names or sorted(TOOL_CATALOG)


def endpoint_for_role(role: str, env: Optional[Dict[str, str]] = None) -> str:
    """Endpoint-ID einer Fach-Rolle aus der Umgebung ('' wenn nicht gesetzt)."""
    source = os.environ if env is None else env
    return (source.get(ROLE_ENDPOINT_ENV.get(role, ""), "") or "").strip()


def _api_base(env: Optional[Dict[str, str]] = None) -> str:
    source = os.environ if env is None else env
    return (source.get("RUNPOD_API_BASE", "") or "https://api.runpod.ai/v2").rstrip("/")


def _api_key(env: Optional[Dict[str, str]] = None) -> str:
    source = os.environ if env is None else env
    return (source.get("RP_AGENT_KEY") or source.get("RP_API_KEY") or source.get("RUNPOD_API_KEY") or "").strip()


def call_tool(
    name: str,
    args: Dict[str, Any],
    *,
    env: Optional[Dict[str, str]] = None,
    timeout_s: float = 600.0,
    poll_s: float = 2.0,
) -> Dict[str, Any]:
    """Fuehrt einen MCP-Schritt gegen die zustaendige Fach-Instanz aus.

    Unser Protokoll (`{task, model, input}`) gilt fuer ears/voiceGen. Die
    `comfyui`-Tools (music/image/video) laufen auf vorgefertigten Workern; der
    `comfyui_adapter` uebersetzt Request UND Antwort in deren API.
    """
    spec = TOOL_CATALOG.get(name)
    if spec is None:
        raise ValueError(f"unknown tool: {name}")

    if spec.get("protocol") == "comfyui":
        from comfyui_adapter import build_request, normalize_output

        inner: Dict[str, Any] = build_request(name, spec["role"], spec["model"], args, payload=args, env=env)
        normalizer: Optional[Any] = normalize_output
    else:
        inner = {"task": spec["task"], "model": spec["model"], "input": args}
        normalizer = None

    endpoint_id = endpoint_for_role(spec["role"], env)
    if not endpoint_id:
        raise ValueError(f"{name}: Endpoint fehlt ({ROLE_ENDPOINT_ENV.get(spec['role'], '?')})")
    api_key = _api_key(env)
    if not api_key:
        raise ValueError(f"{name}: RP_AGENT_KEY/RP_API_KEY/RUNPOD_API_KEY fehlt")

    body = json.dumps({"input": inner}).encode()
    url = f"{_api_base(env)}/{urllib.parse.quote(endpoint_id)}/run"
    request = urllib.request.Request(
        url, data=body, headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    )
    with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310 (feste RunPod-API-Basis)
        job = json.loads(response.read().decode())
    job_id = str(job.get("id", ""))
    if not job_id:
        return {"tool": name, "status": "FAILED", "error": "RunPod lieferte keine Job-ID"}

    deadline = time.time() + timeout_s
    status_url = f"{_api_base(env)}/{urllib.parse.quote(endpoint_id)}/status/{urllib.parse.quote(job_id)}"
    while time.time() < deadline:
        with urllib.request.urlopen(  # noqa: S310
            urllib.request.Request(status_url, headers={"Authorization": f"Bearer {api_key}"}), timeout=60
        ) as response:
            state = json.loads(response.read().decode())
        status = str(state.get("status", "")).upper()
        if status and status not in ("IN_QUEUE", "IN_PROGRESS"):
            output = state.get("output")
            return {
                "tool": name,
                "jobId": job_id,
                "status": status,
                "output": normalizer(output) if normalizer else output,
            }
        time.sleep(poll_s)
    return {"tool": name, "jobId": job_id, "status": "TIMEOUT"}


def execute_steps(steps: List[Dict[str, Any]], *, env: Optional[Dict[str, str]] = None) -> List[Dict[str, Any]]:
    """Alle Schritte nacheinander ausfuehren; Fehler brechen die Kette nicht ab."""
    results: List[Dict[str, Any]] = []
    for step in steps:
        try:
            results.append(call_tool(step["tool"], step.get("args", {}), env=env))
        except (ValueError, NotImplementedError, urllib.error.URLError, OSError) as exc:
            results.append({"tool": step["tool"], "status": "FAILED", "error": f"{type(exc).__name__}: {exc}"})
    return results


def moa_orchestrate(model_id: str, definition: Any, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Handler `agent.orchestrate`: MoA-Planung (+ optionale Ausfuehrung).

    Erwartet im Payload den Auftrag als `prompt`/`task`/`text`. Mit
    `execute: true` werden die geplanten Schritte direkt gegen die
    Fach-Instanzen gefahren (MCP-Bruecke).
    """
    from model_manager import ModelDefinition
    from registry import load_manifest  # lokal: haelt den Import leicht

    from handlers_runpod import generate_chat

    request = str(payload.get("prompt") or payload.get("task") or payload.get("text") or "").strip()
    if not request:
        raise ValueError("prompt/task/text required for agent.orchestrate")

    models = resolve_moa_models()
    # `load_manifest` liefert ROHE Manifest-Eintraege (dicts); der gemeinsame
    # LLM-Pfad erwartet ModelDefinition-Objekte (definition.repository/revision).
    # Genau hier scheiterte der erste Live-Lauf: 'dict' has no attribute 'repository'.
    definitions = {
        entry["id"]: ModelDefinition.from_dict(entry)
        for entry in load_manifest("orchestrator").get("models", [])
        if isinstance(entry, dict) and entry.get("id")
    }

    def ask(role: str, system: str, user: str, max_new_tokens: int = 512) -> str:
        model_name = models[role]
        model_def = definitions.get(model_name)
        if model_def is None:
            raise ValueError(f"MoA-Modell {model_name!r} fehlt im Rollen-Manifest (Rolle {role})")
        return str(
            generate_chat(model_name, model_def, [{"role": "system", "content": system}, {"role": "user", "content": user}],
                          max_new_tokens=max_new_tokens)["text"]
        )

    started = time.time()
    classification = parse_classification(ask("classifier", CLASSIFIER_SYSTEM, request, 256))
    tools = tool_catalog_for(classification["areas"])

    planner_user = (
        f"Auftrag: {request}\nBereiche: {', '.join(classification['areas'])}\n"
        f"Erlaubte Tools: {', '.join(tools)}"
    )
    plan_a_text = ask("planner_a", PLANNER_SYSTEM, planner_user, 512)
    plan_b_text = ask("planner_b", PLANNER_SYSTEM, planner_user, 512)
    plan_a, plan_b = parse_steps(plan_a_text), parse_steps(plan_b_text)
    planner_parse = {
        "a": planner_report(plan_a_text, plan_a),
        "b": planner_report(plan_b_text, plan_b),
    }
    for side, report in planner_parse.items():
        if report["suspicious"]:
            logger.warning(
                "MoA-Planer %s (%s) lieferte %d Zeichen ohne auswertbaren Schritt",
                side, models[f"planner_{side}"], report["chars"],
            )

    aggregator_user = (
        f"Auftrag: {request}\nPlan A ({models['planner_a']}): {json.dumps(plan_a)}\n"
        f"Plan B ({models['planner_b']}): {json.dumps(plan_b)}"
    )
    aggregate = extract_json(ask("aggregator", AGGREGATOR_SYSTEM, aggregator_user, 512))
    choice = str((aggregate or {}).get("chosen", "merged")).lower()
    chosen, steps = merge_plans(choice, plan_a, plan_b)

    result: Dict[str, Any] = {
        "status": "success",
        "task": "agent.orchestrate",
        "request": request,
        "models": models,
        "classification": classification,
        "plans": {"a": plan_a, "b": plan_b},
        "plannerParse": planner_parse,
        "choice": chosen,
        "reason": str((aggregate or {}).get("reason", ""))[:300],
        "steps": steps,
        "plannedInMs": int((time.time() - started) * 1000),
    }
    if payload.get("execute") is True:
        result["execution"] = execute_steps(steps)
    return result
