"""
SampleMONK AI Runtime – MCP Runtime (Tools + Permissions)
==========================================================
Nur tatsächlich existierende Runtime-Funktionen werden exponiert.

Permissions: READ | WRITE | EXECUTION | DESTRUCTIVE
- DESTRUCTIVE-Aktionen sind ohne explizite Permission im Request blockiert.
"""
from __future__ import annotations

from typing import Any, Dict, List

PERMISSION_LEVELS = {"READ": 1, "WRITE": 2, "EXECUTION": 3, "DESTRUCTIVE": 4}

TOOLS: Dict[str, Dict[str, Any]] = {
    "runtime.status": {"category": "session", "permission": "READ", "description": "Status der AI Runtime"},
    "models.list": {"category": "session", "permission": "READ", "description": "Geladene/verfügbare Modelle"},
    "model.load": {"category": "session", "permission": "EXECUTION", "description": "Modell laden"},
    "model.unload": {"category": "session", "permission": "EXECUTION", "description": "Modell entladen"},
    "audio.analyze": {"category": "analysis", "permission": "EXECUTION", "description": "Audio-Analyse (Task-spezifisch)"},
    "audio.classify": {"category": "analysis", "permission": "EXECUTION", "description": "Audio-Klassifikation (AST)"},
    "audio.transcribe": {"category": "analysis", "permission": "EXECUTION", "description": "Speech-to-Text (Whisper)"},
    "audio.embed": {"category": "analysis", "permission": "EXECUTION", "description": "Audio-Embeddings (CLAP/MERT)"},
    "audio.generate": {"category": "generation", "permission": "EXECUTION", "description": "Audio-/Musik-Generierung"},
    "sample.search": {"category": "sample", "permission": "READ", "description": "Sample-Suche über Embeddings"},
    "session.getState": {"category": "session", "permission": "READ", "description": "Session-Zustand"},
}


class McpRuntime:
    def __init__(self, manager) -> None:
        self._manager = manager

    # Tool-Namen, die ein nicht-leeres "model"-Feld im Payload benötigen.
    _MODEL_REQUIRED_TOOLS = frozenset({
        "model.load",
        "model.unload",
        "audio.analyze",
        "audio.classify",
        "audio.transcribe",
        "audio.embed",
        "audio.generate",
        "sample.search",
    })

    @staticmethod
    def _validate_payload(tool_name: str, payload: Dict[str, Any]) -> str:
        """Gibt eine Fehlermeldung zurück oder einen leeren String bei gültigem Payload."""
        if not isinstance(payload, dict):
            return "payload must be a JSON object"
        if tool_name in McpRuntime._MODEL_REQUIRED_TOOLS:
            model_id = str(payload.get("model", "")).strip()
            if not model_id:
                return "payload.model is required and must be a non-empty string"
            if len(model_id) > 512:
                return "payload.model is too long"
        return ""

    def list_tools(self) -> List[Dict[str, Any]]:
        return [
            {"name": name, "category": spec["category"], "permission": spec["permission"], "description": spec["description"]}
            for name, spec in sorted(TOOLS.items())
        ]

    def invoke(self, tool_name: str, payload: Any, server_permission: str = "") -> Dict[str, Any]:
        spec = TOOLS.get(tool_name)
        if spec is None:
            return {"ok": False, "error": f"unknown tool: {tool_name}"}
        required = spec["permission"]
        # FA-P0-1: Permission kommt NIE aus dem Client-Body, sondern aus dem
        # serverseitigen Trust-Context (Env AI_MCP_PERMISSION, Default READ).
        import os
        granted = (server_permission or os.environ.get("AI_MCP_PERMISSION") or "READ").strip().upper()
        if granted not in PERMISSION_LEVELS:
            granted = "READ"
        if PERMISSION_LEVELS.get(granted, 0) < PERMISSION_LEVELS[required]:
            return {"ok": False, "error": f"permission denied: {tool_name} requires {required}"}
        if required == "DESTRUCTIVE" and granted != "DESTRUCTIVE":
            return {"ok": False, "error": "destructive action requires explicit DESTRUCTIVE permission"}

        validation_error = self._validate_payload(tool_name, payload)
        if validation_error:
            return {"ok": False, "error": f"invalid payload: {validation_error}"}

        handler = getattr(self, f"_tool_{tool_name.replace('.', '_')}", None)
        if handler is None:
            return {"ok": False, "error": f"tool not implemented: {tool_name}"}
        try:
            return {"ok": True, "result": handler(payload)}
        except Exception as exc:  # noqa: BLE001 – MCP-Fehler sauber zurückgeben
            return {"ok": False, "error": str(exc)}

    # ---------------------------------------------------------------- Handler
    def _tool_runtime_status(self, _payload: Dict[str, Any]) -> Dict[str, Any]:
        return self._manager.gpu_state()

    def _tool_models_list(self, _payload: Dict[str, Any]) -> List[Dict[str, Any]]:
        return self._manager.get_model_info()

    def _tool_model_load(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        model_id = str(payload.get("model", "")).strip()
        self._manager.load(model_id)
        return {"loaded": model_id}

    def _tool_model_unload(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        model_id = str(payload.get("model", "")).strip()
        self._manager.unload(model_id)
        return {"unloaded": model_id}

    def _tool_session_getState(self, _payload: Dict[str, Any]) -> Dict[str, Any]:
        return {"gpu": self._manager.gpu_state(), "models": self._manager.get_status()}

    def _tool_audio_classify(self, payload: Dict[str, Any]) -> Any:
        return self._infer("classify", payload)

    def _tool_audio_transcribe(self, payload: Dict[str, Any]) -> Any:
        return self._infer("transcribe", payload)

    def _tool_audio_embed(self, payload: Dict[str, Any]) -> Any:
        return self._infer("embed", payload)

    def _tool_audio_analyze(self, payload: Dict[str, Any]) -> Any:
        return self._infer(payload.get("analysis", "classify"), payload)

    def _tool_audio_generate(self, payload: Dict[str, Any]) -> Any:
        return self._infer("generate", payload)

    def _tool_sample_search(self, payload: Dict[str, Any]) -> Any:
        return self._infer("embed", payload)

    def _infer(self, task: str, payload: Dict[str, Any]) -> Any:
        model_id = str(payload.get("model", "")).strip()
        if not model_id:
            raise ValueError("model is required")
        return self._manager.infer(task, model_id, payload)
