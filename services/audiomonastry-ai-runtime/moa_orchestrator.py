"""AudioMONASTRY AI Runtime – Orchestrator (Mixture-of-Agents) + MCP-Tool-Bruecke
=============================================================================
INFRA-AI-006 – ROLLE: das ist die SERVERSEITIGE **MoA-Ausfuehrung** (Instanz 8 der
Flotte, docs/runpod-8-instances-complete-plan.md). Die client-/appseitige
**MoA-Planung** liegt in `src/core/ai/MoaAgent.ts` (ein LLM-Call, Schema
`[{pluginId, command, prompt}]`). Verbunden sind beide ueber GENAU EINE Kante:
das MCP-Tool `agent.orchestrate` (`POST /api/ai/mcp/tools/agent.orchestrate`,
Bruecke in `src/core/ai/orchestrator/mcpRuntime.ts`). Kein gemeinsamer Code,
bewusst: hier Planung + Ausfuehrung ueber die Fach-Instanzen, dort die schnelle
UI-nahe Zerlegung. Waechter: tests/moaBoundary.test.ts.

Der Orchestrator nimmt einen multimodalen Auftrag entgegen und baut daraus eine
ausfuehrbare Pipeline ueber die Fach-Instanzen 2–7.

Drei Schichten (MoA) mit EINEM starken und EINEM schnellen Modell – beide
native Qwen3 (Apache-2.0, oeffentlich, kein Repo-Code, kein HF-Token):
  1. Classifier      qwen3-4b     – schnell: Was ist das fuer eine Aufgabe?
                                    Welche Bereiche (audio/visual/music)?
  2. Planner A/B     qwen3-8b     – stark: Hauptplan
                     qwen3-4b     – schnell: zweiter, unabhaengiger Plan
  3. Aggregator      qwen3-8b     – stark: vergleicht beide Plaene, waehlt/merged
                                    und gibt den finalen Plan aus
  4. Ausfuehrung     MCP-Tools    – Schritte gegen die Fach-Instanzen

Die Modell-IDs kommen aus dem Rollen-Manifest (`orchestrator`), ueberschreibbar
per `MOA_CLASSIFIER_MODEL` / `MOA_PLANNER_A_MODEL` / `MOA_PLANNER_B_MODEL` /
`MOA_AGGREGATOR_MODEL`. Das Modul ist ohne GPU/Transformers importierbar – die
schweren Aufrufe sind lazy und die Plan-Logik ist rein (unit-testbar).
"""
from __future__ import annotations

import json
import logging
import math
import os
import re
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

#: Rolle -> (Env-Override, Default-Modell-ID aus dem Rollen-Manifest).
#: Zwei Modelle, beide OEFFENTLICH und native Qwen3 (kein HF-Token, keine gated
#: Repos, kein Repo-Code): qwen3-4b schnell (9 GB) + qwen3-8b stark (16 GB)
#: = 25 GB bei 42 GB nutzbarem Budget (48 - 6 GB Sicherheitsabstand).
#: Classifier und Planner B teilen sich bewusst das schnelle Modell, Planner A
#: und Aggregator das starke – so bleibt der VRAM-Bedarf bei zwei Staenden.
MOA_MODEL_ROLES: Dict[str, Tuple[str, str]] = {
    "classifier": ("MOA_CLASSIFIER_MODEL", "qwen3-4b"),
    "planner_a": ("MOA_PLANNER_A_MODEL", "qwen3-8b"),
    "planner_b": ("MOA_PLANNER_B_MODEL", "qwen3-4b"),
    "aggregator": ("MOA_AGGREGATOR_MODEL", "qwen3-8b"),
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
    # FLEET-P1-006: RP5-Hauptmodell (5 Stems per Crossover); htdemucs-6s bleibt als Alias waehlbar.
    "voice.stem_separate": {"role": "voiceGen", "task": "stem.separate", "model": "bs-roformer-sw-6stem"},
    "voice.sfx": {"role": "voiceGen", "task": "audio.generate", "model": "stable-audio-open-1.0"},
    # Modellregel (Betreiber 2026-10-13): xl-sft = generate/remix/repaint (RP3),
    # xl-turbo = Drops/Loops (RP3), xl-base NUR lego/extract/complete (RP4, nicht
    # in diesem Katalog: braucht serverseitige Bibliotheks-Vorspuren, MCP music.lego).
    # Spiegel von mcpRuntime.ts, Drift-Test tests/aceStepModelRouting.test.ts.
    "music.generate": {"role": "music", "task": "song", "model": "acestep-v15-xl-sft", "protocol": "comfyui"},
    "music.remix": {"role": "music", "task": "song", "model": "acestep-v15-xl-sft", "protocol": "comfyui"},
    "music.drop": {"role": "music", "task": "song", "model": "acestep-v15-xl-turbo", "protocol": "comfyui"},
    "image.generate": {"role": "imageHq", "task": "image.generate", "model": "flux1-dev", "protocol": "comfyui"},
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

# ---------------------------------------------------------------------------
# DA-2026-10-17-018 · Werkzeug-Argumente vor der Ausfuehrung pruefen
# ---------------------------------------------------------------------------
# Die Argumente eines MCP-Schritts kommen aus der Antwort eines LLM
# (Planner/Aggregator) und flogen bisher ungeprueft in den `input` eines
# RunPod-Jobs (Prompt-Injection -> beliebige Payloads, riesige Strings,
# unbekannte Schluessel). `parse_steps` prueft nur den Tool-Namen. Diese
# Pruefstelle ist die ENGE im `call_tool` - damit ist jeder Weg abgedeckt.
#
# Strukturelle Limits (Spiegel von src/core/ai/toolArgs.ts, TOOL_ARG_LIMITS):
#   - nur echte Objekte, max. 24 Schluessel, Schluessel <= 64 Zeichen
#   - keine Prototype-Schluessel (`__proto__`, `constructor`, `prototype`)
#   - je Werkzeug eine Allowlist; unbekannte Schluessel werden VERWORFEN
#     (nicht durchgereicht) - silent, ohne die Werte zu spiegeln
#   - Strings 2000 Zeichen (Medien-Base64 ausgenommen), Arrays 64 Eintraege,
#     Verschachtelung 2 Ebenen, Gesamtgroesse 20 kB
TOOL_ARG_LIMITS: Dict[str, int] = {
    "maxKeys": 24,
    "maxKeyChars": 64,
    "maxStringChars": 2000,
    "maxMediaChars": 20_000_000,
    "maxArrayItems": 64,
    "maxDepth": 2,
    "maxTotalChars": 20_000,
}

#: Immer erlaubt: die Rechteangabe wertet der Aufrufer selbst aus.
_TOOL_ARG_PERMISSION_KEY = "permission"
#: Prototype-Poisoning-Schluessel.
_TOOL_ARG_FORBIDDEN = frozenset({"__proto__", "constructor", "prototype"})
_TOOL_ARG_SAFE_KEY = re.compile(r"^[A-Za-z][A-Za-z0-9_.\-]*$")
#: Schluessel, deren Wert Medien-Inhalt ist (eigenes, hoeheres Limit).
_TOOL_ARG_MEDIA_KEYS = frozenset({
    "dataUri", "contextAudio", "audio", "images",
    "audioBase64", "imageBase64", "videoBase64",
    "image_base64", "audio_base64", "video_base64",
})

#: Vereinigte Parameter dieser Runtime. Die comfyui-Tools lesen sie in
#: `comfyui_adapter.build_*` (prompt/text/tags/lyrics/...), die ears-Tools
#: `tasks` (Planner-Beispiel im System-Prompt), die voice-Tools tts/speaker.
#: Alles was hier NICHT steht, kommt beim Fach-Worker nicht an - ein LLM kann
#: also keine fremden Felder injizieren.
_TOOL_ARG_GENERATION = (
    # Prompt-/Text-Familie
    "prompt", "text", "tags", "lyrics", "caption", "instruct", "language",
    "negative", "negativePrompt", "negative_prompt", "style",
    # Song-/Generierungs-Parameter
    "model", "duration", "seconds", "durationSeconds", "maxDuration",
    "bpm", "keyscale", "seed", "steps", "cfg", "cfg_scale", "denoise",
    "sampler_name", "scheduler", "width", "height", "length",
    "task_type", "aceTask", "instrument",
    # Bilder/Video/Medien
    "image_url", "image_base64", "image_path", "images", "base",
    "imageUrl", "audioBase64", "imageBase64", "videoBase64", "dataUri",
    "audio", "contextAudio", "track", "tracks", "repaintStart", "repaintEnd",
    "repaintMode", "lora_pairs", "workflow",
    # MCP-Hausfelder
    "query", "limit", "stream", "speaker", "tasks", "permission",
    # Job-ID (job_token, wird ohnehin auf [A-Za-z0-9._-] gesaniert)
    "jobId", "job_id", "requestId", "request_id",
)

#: Allowlist je Werkzeug des Katalogs. Einheitlich, weil die Fach-Worker je
#: Rolle dieselbe Generierungs-/Analyse-API sprechen; Differenzierung ist
#: hier nicht noetig (die TTS-Rolle ignoriert image_* Felder im Handler).
TOOL_ARG_ALLOW: Dict[str, frozenset] = {
    name: frozenset(_TOOL_ARG_GENERATION) for name in TOOL_CATALOG
}


class ToolArgsError(ValueError):
    """Werkzeug-Argumente verletzen die Struktur-Grenzen (DA-2026-10-17-018)."""


def _is_media_key(key: str) -> bool:
    lowered = key.lower()
    return key in _TOOL_ARG_MEDIA_KEYS or lowered.endswith("base64") or lowered.endswith("base_64")


def _sanitize_tool_value(value: Any, key: str, depth: int) -> Tuple[bool, Any]:
    """Rein: Wert strukturbegrenzt kopieren (keep=False = verwerfen)."""
    if isinstance(value, str):
        limit = TOOL_ARG_LIMITS["maxMediaChars"] if _is_media_key(key) else TOOL_ARG_LIMITS["maxStringChars"]
        return True, (value[:limit] if len(value) > limit else value)
    if isinstance(value, bool):
        return True, value
    if isinstance(value, (int, float)):
        return (math.isfinite(value) if isinstance(value, float) else True), value
    if value is None:
        return False, None
    if isinstance(value, list):
        if depth >= TOOL_ARG_LIMITS["maxDepth"]:
            return False, None
        out: List[Any] = []
        for entry in value[: TOOL_ARG_LIMITS["maxArrayItems"]]:
            keep, item = _sanitize_tool_value(entry, key, depth + 1)
            if keep:
                out.append(item)
        return True, out
    if isinstance(value, dict):
        if depth >= TOOL_ARG_LIMITS["maxDepth"]:
            return False, None
        clean: Dict[str, Any] = {}
        count = 0
        for child_key, child_value in value.items():
            if count >= TOOL_ARG_LIMITS["maxKeys"]:
                break
            ck = str(child_key)
            if ck in _TOOL_ARG_FORBIDDEN or not _TOOL_ARG_SAFE_KEY.match(ck) or len(ck) > TOOL_ARG_LIMITS["maxKeyChars"]:
                continue
            keep, item = _sanitize_tool_value(child_value, ck, depth + 1)
            if keep:
                clean[ck] = item
                count += 1
        return True, clean
    # Funktionen, Sets, bytes ... haben in Werkzeug-Argumenten nichts verloren.
    return False, None


def validate_tool_args(name: str, raw_args: Any) -> Dict[str, Any]:
    """Prueft und normalisiert die Argumente eines Werkzeugs (fail-closed).

    Strukturverstoesse (kein Objekt, zu viele/grosse Argumente) werfen
    `ToolArgsError` (ein ValueError) - `execute_steps` fuehrt den Schritt
    damit als FAILED weiter, die Kette bricht nicht ab. Unbekannte oder
    unsichere EINZELNE Schluessel werden stillschweigend verworfen (kein
    Echo der Werte), wie in der TS-Praefstelle `validateToolArgs`.
    Werkzeuge ausserhalb des Katalogs: nur Struktur-Grenzen (die
    Werkzeugnamen-Pruefung sitzt im `call_tool` davor).
    """
    if raw_args is None:
        return {}
    if not isinstance(raw_args, dict):
        raise ToolArgsError(f"{name}: Argumente muessen ein Objekt sein")
    if len(raw_args) > TOOL_ARG_LIMITS["maxKeys"]:
        raise ToolArgsError(f"{name}: zu viele Argumente")
    allow = TOOL_ARG_ALLOW.get(name)
    out: Dict[str, Any] = {}
    for key, value in raw_args.items():
        ks = str(key)
        if ks in _TOOL_ARG_FORBIDDEN or not _TOOL_ARG_SAFE_KEY.match(ks) or len(ks) > TOOL_ARG_LIMITS["maxKeyChars"]:
            continue
        if allow is not None and ks != _TOOL_ARG_PERMISSION_KEY and ks not in allow:
            continue
        keep, clean = _sanitize_tool_value(value, ks, 0)
        if keep:
            out[ks] = clean
    if len(json.dumps(out, ensure_ascii=True, default=str)) > TOOL_ARG_LIMITS["maxTotalChars"]:
        raise ToolArgsError(f"{name}: Argumente zu gross")
    return out


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
    "Beginne deine Antwort direkt mit { - KEINE Vorrede, keine Analyse, keine "
    "Begruendung ausserhalb des JSON, kein Markdown, keine Code-Fences. "
    "Verwende ausschliesslich Tool-Namen aus der Liste 'Erlaubte Tools' im Auftrag. "
    'Beispiel: {"steps": [{"tool": "ears.analyze", "args": {"tasks": ["bpm"]}, "why": "BPM messen"}]}'
)
#: Zweiter, strengerer Versuch, wenn ein Planer keinen auswertbaren Schritt
#: geliefert hat. Live belegt (2026-09-16): Ministral-8B schrieb 1753 Zeichen
#: Prosa ohne JSON - bei 512 Token Budget (Verdacht: Prosa hat das Budget
#: aufgebraucht). Der Reparatur-Prompt nennt Form UND erlaubte Tools erneut und
#: verlangt die kuerzestmoegliche Antwort.
PLANNER_REPAIR_SYSTEM = (
    "Deine vorige Antwort war kein auswertbares JSON. Antworte JETZT nur mit dem "
    'JSON-Objekt {"steps": [{"tool": "<tool-name>", "args": {...}}]} und sonst mit '
    "nichts - keine Vorrede, kein Markdown. Erlaubt sind ausschliesslich diese "
    "Tool-Namen: %s"
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


def planner_report(
    text: str,
    steps: List[Dict[str, Any]],
    *,
    attempts: int = 1,
    preview_chars: int = 200,
) -> Dict[str, Any]:
    """Parse-Beleg eines Plans – macht einen leeren Plan sichtbar.

    Ein nicht-leerer Text ohne einen einzigen gueltigen Schritt ist ein
    Parse-Fehler (unparsebare Formatierung oder ausschliesslich unbekannte
    Tools) und kein "leerer Plan". Live am 2026-09-16 blieb genau das
    unsichtbar: Plan B kam als `[]` zurueck und das Ergebnis stand trotzdem auf
    `merged` – der MoA-Gewinn war damit nicht belegt.

    Bei Verdacht enthaelt der Beleg einen gekuerzten Auszug des Rohtexts: ohne
    ihn ist "kein JSON" nicht von "nur unbekannte Tools" zu unterscheiden, und
    die Container-Logs sind mit dem Worker wieder weg.
    """
    raw = text if isinstance(text, str) else ""
    suspicious = bool(raw.strip()) and not steps
    report: Dict[str, Any] = {
        "chars": len(raw),
        "steps": len(steps),
        "parsed": bool(steps),
        "attempts": max(1, int(attempts)),
        "suspicious": suspicious,
    }
    if suspicious:
        report["preview"] = " ".join(raw.split())[: max(0, int(preview_chars))]
    return report


def plan_with_retry(
    ask: Callable[..., str],
    role: str,
    planner_user: str,
    tools: List[str],
    *,
    max_new_tokens: int = 1024,
) -> Tuple[str, List[Dict[str, Any]], int]:
    """Einen Planer-Stand holen und bei erfolglosem Parse EINMAL nachfassen.

    Hintergrund: kleine Instruct-Modelle schreiben gern erst Prosa und liefern
    das JSON nie (live 2026-09-16: Ministral-8B, 1753 Zeichen ohne einen
    auswertbaren Schritt). Deshalb ein grosszuegiges Token-Budget und, wenn
    trotzdem kein Schritt herauskommt, ein zweiter Versuch mit
    `PLANNER_REPAIR_SYSTEM` (nennt Form und erlaubte Tools erneut und verlangt
    die kuerzestmoegliche Antwort). Rueckgabe: (Rohtext des letzten Versuchs,
    Schritte, Anzahl der Versuche).
    """
    text = str(ask(role, PLANNER_SYSTEM, planner_user, max_new_tokens))
    steps = parse_steps(text)
    if steps:
        return text, steps, 1
    repair_user = f"{planner_user}\n\nDeine vorige Antwort war:\n{text.strip()[:600]}"
    repaired = str(
        ask(
            role,
            PLANNER_REPAIR_SYSTEM % ", ".join(tools),
            repair_user,
            max_new_tokens,
        )
    )
    return repaired, parse_steps(repaired), 2


#: Rollen, fuer die ein Aufrufer Vorgaben machen kann (Katalog + Endpoint-Env).
KNOWN_ROLES = frozenset({spec.get("role") for spec in TOOL_CATALOG.values()} | set(ROLE_ENDPOINT_ENV))


def merge_step_defaults(
    steps: List[Dict[str, Any]], defaults: Dict[str, Any]
) -> List[Dict[str, Any]]:
    """Vorgaben des Aufrufers (je Rolle) in die Schritt-Argumente mischen.

    Der Planer kennt den Auftrag, aber nicht die Rahmenbedingungen des Aufrufers:
    Aufloesung, Laenge, Tempo oder Stil-LoRAs wuerde er raten. `roleDefaults`
    setzt diese Groessen je Rolle (z. B. `{"videoAbstract": {"width": 768,
    "height": 1280, "length": 97, "lora_pairs": [...]}}`). Argumente des Plans
    gewinnen gegen die Vorgabe, weil sie sich auf den konkreten Auftrag beziehen;
    die Vorgabe ist der Rahmen.

    Unbekannte Rollen werden abgelehnt: ein Tippfehler soll nicht still
    wirkungslos bleiben.
    """
    if not defaults:
        return steps
    if not isinstance(defaults, dict):
        raise ValueError("roleDefaults muss ein Objekt 'Rolle -> Argumente' sein")
    unknown = sorted(set(defaults) - KNOWN_ROLES)
    if unknown:
        raise ValueError(
            f"roleDefaults: unbekannte Rolle(n) {unknown}; bekannt sind {sorted(KNOWN_ROLES)}"
        )
    merged: List[Dict[str, Any]] = []
    for step in steps:
        role = (TOOL_CATALOG.get(str(step.get("tool"))) or {}).get("role")
        preset = defaults.get(role) if role else None
        if isinstance(preset, dict) and preset:
            merged.append({**step, "args": {**preset, **(step.get("args") or {})}})
        else:
            merged.append(step)
    return merged


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


# ---------------------------------------------------------------------------
# Netz-Robustheit der MCP-Bruecke (DA-2026-10-17-010 / DA-2026-10-17-012)
# ---------------------------------------------------------------------------
#: Budget fuer EINEN Antwortkoerper. Die Fach-Rollen liefern Audio inzwischen als
#: base64 im Ergebnis-JSON; ohne Grenze laedt ein fehlerhafter Wrapper eine
#: riesige Datei (oder einen Chunked-Endlosstream) komplett in den Heap und
#: reisst die Orchestrierung mit (DA-2026-10-17-012). 100 MB deckt einen
#: 5-Minuten-WAV in 48 kHz/24 bit (~50 MB) mit Reserve ab.
def _env_number(name: str, default, cast):  # noqa: ANN001 – winziger Helfer
    """Zahl aus der Umgebung, aber ein Tippfehler darf den Import nicht toeten."""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return cast(raw)
    except (TypeError, ValueError):
        logger.warning("%s=%r ist keine Zahl - Default %r bleibt", name, raw, default)
        return default


MAX_RESPONSE_BYTES = _env_number("MOA_MAX_RESPONSE_BYTES", 100 * 1024 * 1024, int)
#: Lesegroesse des Streaming-Zaehlers (nie `read()` ohne Argument: das ist genau
#: der Weg, der den ganzen Body in den Speicher zieht).
READ_CHUNK_BYTES = 64 * 1024
#: So viele TRANSIENTE Fehler in Folge toleriert der Poll-Loop, bevor er aufgibt
#: (DA-2026-10-17-010: ein einzelner Timeout darf keinen laufenden GPU-Job
#: verfallen lassen - die Deadline entscheidet, nicht der erste Netzfehler).
POLL_MAX_TRANSIENT_ERRORS = _env_number("MOA_POLL_MAX_TRANSIENT_ERRORS", 3, int)
#: Backoff des Poll-Loops: 1 s, 2 s, 4 s ... gedeckelt, damit die Deadline gilt.
POLL_BACKOFF_BASE_S = _env_number("MOA_POLL_BACKOFF_S", 1.0, float)
POLL_BACKOFF_MAX_S = 8.0


class ResponseTooLargeError(ValueError):
    """Antwort ueberschreitet das Groessenbudget - bewusst KEIN Retry (DA-012)."""


class TransientNetworkError(OSError):
    """Poll-Loop hat nach N transienten Fehlern in Folge aufgegeben (DA-010).

    Erbt von `OSError`, damit `execute_steps` den Schritt wie bisher als
    FAILED-Ergebnis fuehrt statt die ganze Orchestrierung zu werfen.
    """


def _is_transient_network_error(exc: BaseException) -> bool:
    """Nur echte Netz-/Server-Klemmer sind transient - alles andere ist hart.

    Transient: Timeout, Verbindungsabbruch (-reset/-refused), DNS-/TLS-Fehler
    (beides `URLError`) und HTTP 5xx/429/408. HART bleiben 4xx (falscher
    Endpoint, falsches Token), kaputtes JSON und das Groessenlimit - ein Retry
    wuerde dort nur Zeit verbrennen.
    """
    if isinstance(exc, urllib.error.HTTPError):
        return exc.code in (408, 425, 429) or 500 <= exc.code <= 599
    if isinstance(exc, urllib.error.URLError):
        return True
    return isinstance(exc, (TimeoutError, socket.timeout, ConnectionError))


def _read_limited(response: Any, limit: Optional[int] = None, label: str = "") -> bytes:
    """Body mit Groessenlimit lesen: Content-Length VORAB, dann Streaming-Zaehler.

    Zwei Schranken, weil eine allein nicht reicht: `Content-Length` fehlt bei
    `Transfer-Encoding: chunked` (dann greift der Zaehler), und ein luegender
    Header darf den Zaehler nicht aushebeln.
    """
    budget = MAX_RESPONSE_BYTES if limit is None else int(limit)
    headers = getattr(response, "headers", None)
    declared: Optional[int] = None
    if headers is not None:
        raw = headers.get("Content-Length")
        if raw is not None:
            try:
                declared = int(raw)
            except (TypeError, ValueError):
                declared = None
    if declared is not None and declared > budget:
        raise ResponseTooLargeError(
            f"{label} Content-Length {declared} B ueberschreitet das Limit von {budget} B - abgebrochen"
        )
    body = bytearray()
    while True:
        block = response.read(READ_CHUNK_BYTES)
        if not block:
            break
        if len(body) + len(block) > budget:
            raise ResponseTooLargeError(
                f"{label} Antwort ueberschreitet das Limit von {budget} B (Streaming-Zaehler) - abgebrochen"
            )
        body += block
    return bytes(body)


def _http_json(request: Any, *, timeout: float, label: str) -> Any:
    """HTTP-Aufruf mit begrenztem Body; das Limit gilt auch fuer Audio-base64."""
    with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 (feste RunPod-API-Basis)
        return json.loads(_read_limited(response, label=label).decode("utf-8"))


def _backoff_seconds(attempt: int) -> float:
    """Exponentieller Backoff, gedeckelt (attempt ab 1)."""
    return min(POLL_BACKOFF_BASE_S * (2 ** max(0, attempt - 1)), POLL_BACKOFF_MAX_S)


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

    # DA-2026-10-17-018: Argumente kommen aus LLM-Antworten (Planner/
    # Aggregator) - Struktur und Schluessel werden VOR dem RunPod-Aufruf
    # geprueft und normalisiert (unbekannte Schluessel verworfen, Laengen
    # begrenzt). Ein Strukturverstoß -> ToolArgsError -> FAILED-Ergebnis.
    args = validate_tool_args(name, args)

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
    job = _http_json(request, timeout=60, label=f"{name} /run")
    job_id = str(job.get("id", ""))
    if not job_id:
        return {"tool": name, "status": "FAILED", "error": "RunPod lieferte keine Job-ID"}

    deadline = time.time() + timeout_s
    status_url = f"{_api_base(env)}/{urllib.parse.quote(endpoint_id)}/status/{urllib.parse.quote(job_id)}"
    # DA-2026-10-17-010: Ein einzelner Timeout/ECONNRESET beendet den Task NICHT.
    # Der Job laeuft auf der GPU weiter; ein Abbruch hier verwirft bezahlte Arbeit.
    # Deshalb: transiente Fehler zaehlen, mit Backoff erneut lesen, und erst nach
    # POLL_MAX_TRANSIENT_ERRORS in Folge (oder Ablauf der Deadline) aufgeben.
    transient_errors = 0
    while time.time() < deadline:
        try:
            state = _http_json(
                urllib.request.Request(status_url, headers={"Authorization": f"Bearer {api_key}"}),
                timeout=60,
                label=f"{name} /status",
            )
        except Exception as exc:  # noqa: BLE001 – Klassifikation entscheidet, nicht der Typ allein
            if not _is_transient_network_error(exc):
                raise  # harter Fehler (4xx, kaputtes JSON, Groessenlimit): sofort melden
            transient_errors += 1
            if transient_errors > POLL_MAX_TRANSIENT_ERRORS:
                raise TransientNetworkError(
                    f"{name}: {transient_errors} transiente Netzfehler in Folge "
                    f"({type(exc).__name__}: {exc}) - Job {job_id} laeuft auf RunPod weiter, "
                    f"Aufgabe nach {timeout_s:.0f} s Fenster abgebrochen"
                ) from exc
            delay = _backoff_seconds(transient_errors)
            remaining = deadline - time.time()
            if remaining <= 0:
                break
            time.sleep(min(delay, remaining))
            continue
        transient_errors = 0
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


#: DA-2026-10-17-016: GESAMTBudget der Ausfuehrung (Umwelt: MOA_EXECUTE_BUDGET_S).
#: Vorher belegte ein Plan mit N Schritten einen Worker bis zu N x 600 s - der
#: Wert gilt fuer die GANZE Kette, nicht pro Schritt.
DEFAULT_EXECUTE_BUDGET_S = 1200.0
#: DA-2026-10-17-018: harte Obergrenze der Schritte pro Auftrag.
MAX_PIPELINE_STEPS = 12


def execute_steps(
    steps: List[Dict[str, Any]],
    *,
    env: Optional[Dict[str, str]] = None,
    budget_s: Optional[float] = None,
) -> List[Dict[str, Any]]:
    """Alle Schritte nacheinander ausfuehren; Fehler brechen die Kette nicht ab.

    DA-2026-10-17-016: das Budget gilt fuer die GANZE Pipeline (Default
    MOA_EXECUTE_BUDGET_S, 1200 s). Jeder Schritt bekommt hoechstens die
    Restzeit; ist das Budget zwischen zwei Schritten leer, werden die
    verbleibenden als SKIPPED gemeldet statt noch 600 s zu belegen.
    """
    if budget_s is not None:
        raw = budget_s
    else:
        raw = os.environ.get("MOA_EXECUTE_BUDGET_S", "") or DEFAULT_EXECUTE_BUDGET_S
    try:
        total = float(raw)
    except (TypeError, ValueError):
        total = DEFAULT_EXECUTE_BUDGET_S
    if not (total > 0):
        total = DEFAULT_EXECUTE_BUDGET_S
    deadline = time.time() + total
    results: List[Dict[str, Any]] = []
    for step in steps:
        remaining = deadline - time.time()
        if remaining <= 0:
            results.append({
                "tool": str(step.get("tool", "?")),
                "status": "SKIPPED",
                "error": "Pipeline-Budget erschoepft (DA-2026-10-17-016)",
            })
            continue
        try:
            results.append(
                call_tool(step["tool"], step.get("args", {}), env=env, timeout_s=min(600.0, remaining))
            )
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
    plan_a_text, plan_a, attempts_a = plan_with_retry(ask, "planner_a", planner_user, tools)
    plan_b_text, plan_b, attempts_b = plan_with_retry(ask, "planner_b", planner_user, tools)
    planner_parse = {
        "a": planner_report(plan_a_text, plan_a, attempts=attempts_a),
        "b": planner_report(plan_b_text, plan_b, attempts=attempts_b),
    }
    for side, report in planner_parse.items():
        if report["suspicious"]:
            logger.warning(
                "MoA-Planer %s (%s) lieferte nach %d Versuch(en) %d Zeichen ohne "
                "auswertbaren Schritt: %s",
                side, models[f"planner_{side}"], report["attempts"], report["chars"],
                report.get("preview", ""),
            )

    aggregator_user = (
        f"Auftrag: {request}\nPlan A ({models['planner_a']}): {json.dumps(plan_a)}\n"
        f"Plan B ({models['planner_b']}): {json.dumps(plan_b)}"
    )
    aggregate = extract_json(ask("aggregator", AGGREGATOR_SYSTEM, aggregator_user, 512))
    # DA-2026-10-17-017: `extract_json` liefert das erste parsebare JSON -
    # auch eine nackte Liste. `["a", "b"] or {}` ist wahrheitsgemaess die
    # Liste, `.get` warf dann AttributeError und der komplette Lauf (inkl.
    # Ausfuehrung) verfaell. Nach dem Parsen normalisieren, analog zu
    # `parse_classification` (dict-Check mit Rueckfall).
    if not isinstance(aggregate, dict):
        logger.warning(
            "MoA-Aggregator lieferte kein Objekt (%s) - Fallback auf 'merged'",
            type(aggregate).__name__,
        )
        aggregate = {}
    choice = str(aggregate.get("chosen", "merged")).lower()
    chosen, steps = merge_plans(choice, plan_a, plan_b)

    # Rahmenbedingungen des Aufrufers (Aufloesung, Laenge, Tempo, Stil-LoRAs)
    # je Rolle einsetzen - der Planer wuerde sie sonst raten. Plan-Argumente
    # gewinnen gegen die Vorgabe.
    role_defaults = payload.get("roleDefaults", payload.get("role_defaults"))
    if role_defaults:
        steps = merge_step_defaults(steps, role_defaults)

    # DA-2026-10-17-018: harte Obergrenze der Schritte - ein LLM-Plan (oder
    # ein gemedgter Doppelplan) belegt sonst die Worker unbeschraenkt.
    if len(steps) > MAX_PIPELINE_STEPS:
        logger.warning("MoA-Plan mit %d Schritten - auf %d begrenzt", len(steps), MAX_PIPELINE_STEPS)
        steps = steps[:MAX_PIPELINE_STEPS]

    result: Dict[str, Any] = {
        "status": "success",
        "task": "agent.orchestrate",
        "request": request,
        "models": models,
        "classification": classification,
        "plans": {"a": plan_a, "b": plan_b},
        "plannerParse": planner_parse,
        "choice": chosen,
        "reason": str(aggregate.get("reason", ""))[:300],
        "roleDefaults": role_defaults or {},
        "steps": steps,
        "plannedInMs": int((time.time() - started) * 1000),
    }
    if payload.get("execute") is True:
        result["execution"] = execute_steps(steps)
    return result
