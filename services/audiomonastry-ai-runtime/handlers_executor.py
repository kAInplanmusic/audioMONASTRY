"""A06 text-to-typed-GUI commands. This module NEVER executes user commands."""
from __future__ import annotations

import json
import math
import re
from typing import Any, Dict, List

from model_manager import ModelDefinition, ModelUnavailableError

_ALLOWED = {
    "track.setGain": ("trackId", "gainDb"),
    "track.setPan": ("trackId", "pan"),
    "track.setMute": ("trackId", "muted"),
    "track.setSolo": ("trackId", "solo"),
    "plugin.setParameter": ("pluginInstanceId", "parameterId", "value"),
    "transport.seek": ("positionSeconds",),
    "clip.move": ("clipId", "startSeconds"),
    "clip.trim": ("clipId", "startSeconds", "durationSeconds"),
    "project.setTempo": ("bpm",),
}
_ID = re.compile(r"^[A-Za-z0-9_-]{1,100}$")
_NUMERIC = {"gainDb": (-90, 18), "pan": (-1, 1), "value": (-1e6, 1e6),
            "positionSeconds": (0, 86400), "startSeconds": (0, 86400),
            "durationSeconds": (0.001, 86400), "bpm": (20, 400)}
_BOOLEAN = {"muted", "solo"}
_SYSTEM = (
    "You are the audioMONASTRY GUI command COMPILER, not an OS agent. "
    "Output ONLY JSON: {\"commands\":[{\"op\":\"...\",\"args\":{...}}]}. "
    "Allowed ops: " + ", ".join(_ALLOWED) + ". "
    "Use exact IDs present in the provided projectState, never make up missing IDs. "
    "No shell, file access, browser or network. If unsure return {\"commands\":[]}."
)


def validate_commands(raw: Any) -> List[Dict[str, Any]]:
    if not isinstance(raw, dict) or set(raw) != {"commands"}:
        raise ModelUnavailableError("executor output must contain only commands")
    commands = raw["commands"]
    if not isinstance(commands, list) or len(commands) > 8:
        raise ModelUnavailableError("executor maximum 8 commands")
    checked = []
    for cmd in commands:
        if not isinstance(cmd, dict) or set(cmd) != {"op", "args"}:
            raise ModelUnavailableError("invalid executor command shape")
        op, args = cmd["op"], cmd["args"]
        if op not in _ALLOWED or not isinstance(args, dict) or set(args) != set(_ALLOWED[op]):
            raise ModelUnavailableError("disallowed operation or argument")
        for name, value in args.items():
            if name in _NUMERIC:
                lo, hi = _NUMERIC[name]
                if type(value) not in (int, float) or not math.isfinite(value) or not lo <= value <= hi:
                    raise ModelUnavailableError("invalid numeric parameter " + name)
            elif name in _BOOLEAN:
                if type(value) is not bool:
                    raise ModelUnavailableError("invalid boolean")
            elif not isinstance(value, str) or not _ID.fullmatch(value):
                raise ModelUnavailableError("invalid identifier")
        checked.append(cmd)
    return checked


def propose_gui_commands(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Dict[str, Any]:
    if model_id != "qwen3-4b":
        raise ModelUnavailableError("A06 only supports qwen3-4b")
    instruction, state = payload.get("instruction"), payload.get("projectState")
    if not isinstance(instruction, str) or not 1 <= len(instruction) <= 2500:
        raise ModelUnavailableError("missing or oversized instruction")
    if not isinstance(state, dict) or len(json.dumps(state, default=str)) > 12000:
        raise ModelUnavailableError("projectState missing or too large")
    from handlers_runpod import generate_chat
    r = generate_chat(model_id, definition, [
        {"role": "system", "content": _SYSTEM},
        {"role": "user", "content": json.dumps({"instruction": instruction, "projectState": state},
                                              ensure_ascii=False)}
    ], max_new_tokens=512, do_sample=False, enable_thinking=False)
    text = str(r.get("text", "")).strip()
    fence = chr(96) * 3
    if text.startswith(fence + "json") and text.endswith(fence):
        text = text[len(fence) + 4:-len(fence)].strip()
    try:
        output = json.loads(text)
    except ValueError as exc:
        raise ModelUnavailableError("executor returned invalid JSON") from exc
    return {"modelId": model_id, "status": "PROPOSED_NOT_EXECUTED",
            "commands": validate_commands(output),
            "requires": "trusted app permissions, B2B locks, project revision and undo"}
