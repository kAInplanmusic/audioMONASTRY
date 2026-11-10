"""A01: Qwen3.8-27B-FP8 internal DAW brain and typed task router.

Supports an independently started local vLLM service, otherwise official
Transformers multimodal LM. Never performs UI actions or exposes chat directly.
"""
from __future__ import annotations

import json
import os
import threading
import urllib.request
from typing import Any, Dict

from model_manager import ModelDefinition, ModelUnavailableError

_LOCK = threading.Lock()
_CACHE: Dict[str, Any] = {}
_ROLES = frozenset({"ears", "voice", "music", "studio", "executor", "song", "vis"})
_SYSTEM = (
    "You are audioMONASTRY's internal music-production brain. "
    "Understand music theory, acoustics, psychoacoustics and available plugin routing. "
    "You are NOT a software-developer agent and never execute actions. "
    "Return exactly a JSON object with keys: targetRole, task, prompt, parameters. "
    "targetRole must be one of: ears, voice, music, studio, executor, song, vis. "
    "The GUI executor is only needed when changing app controls. "
    "If insufficient information, use targetRole ears and task music.describe "
    "with a short clarification prompt. Never include shell commands."
)


def _load_local(definition: ModelDefinition) -> Any:
    if definition.repository != "Qwen/Qwen3.8-27B-FP8":
        raise ModelUnavailableError("A01 source must be pinned Qwen3.8-27B-FP8")
    with _LOCK:
        if definition.revision in _CACHE:
            return _CACHE[definition.revision]
        try:
            import torch
            from transformers import AutoProcessor, AutoModelForMultimodalLM
            if not torch.cuda.is_available():
                raise ModelUnavailableError("Qwen3.8 FP8 requires CUDA")
            processor = AutoProcessor.from_pretrained(definition.repository, revision=definition.revision)
            model = AutoModelForMultimodalLM.from_pretrained(
                definition.repository, revision=definition.revision,
                device_map="cuda:0").eval()
            _CACHE[definition.revision] = (processor, model)
            return processor, model
        except ModelUnavailableError:
            raise
        except Exception as exc:
            raise ModelUnavailableError("Qwen3.8 FP8 load failed: " + type(exc).__name__ + ": " + str(exc)) from exc


def _inference(definition: ModelDefinition, messages: list, max_tokens: int) -> str:
    import urllib.parse
    base = os.environ.get("AI_BRAIN_LOCAL_VLLM_URL", "").strip()
    if base:
        u = urllib.parse.urlparse(base)
        if u.scheme != "http" or u.hostname not in ("127.0.0.1", "localhost") or u.username or u.password:
            raise ModelUnavailableError("vLLM URL must be loopback HTTP")
        body = json.dumps({
            "model": definition.repository, "messages": messages, "max_tokens": max_tokens,
            "temperature": 0.0
        }).encode("utf-8")
        req = urllib.request.Request(base.rstrip("/") + "/v1/chat/completions", body,
                                     {"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                result = json.load(resp)
            return str(result["choices"][0]["message"]["content"])
        except Exception as exc:
            raise ModelUnavailableError("local Qwen3.8 vLLM request failed: " + str(exc)) from exc
    try:
        import torch
        processor, model = _load_local(definition)
        data = processor.apply_chat_template(messages, add_generation_prompt=True,
                                             tokenize=True, return_dict=True,
                                             return_tensors="pt").to(model.device)
        with torch.inference_mode():
            out = model.generate(**data, max_new_tokens=max_tokens, do_sample=False)
        return str(processor.decode(out[0][data["input_ids"].shape[-1]:], skip_special_tokens=True))
    except ModelUnavailableError:
        raise
    except Exception as exc:
        raise ModelUnavailableError("Qwen3.8 inference failed: " + type(exc).__name__ + ": " + str(exc)) from exc


def brain_plan(model_id: str, definition: ModelDefinition, payload: Dict[str, Any]) -> Dict[str, Any]:
    instruction = str(payload.get("text") or payload.get("prompt") or "").strip()
    if not 1 <= len(instruction) <= 5000:
        raise ModelUnavailableError("Brain requires a bounded text instruction")
    state = payload.get("projectState") or {}
    if not isinstance(state, dict) or len(json.dumps(state, default=str)) > 12000:
        raise ModelUnavailableError("invalid projectState")
    tokens = max(128, min(1200, int(payload.get("maxTokens", 640))))
    messages = [{"role": "system", "content": _SYSTEM},
                {"role": "user", "content": json.dumps(
                    {"instruction": instruction, "projectState": state}, ensure_ascii=False)}]
    raw = _inference(definition, messages, tokens).strip()
    try:
        result = json.loads(raw)
    except ValueError as exc:
        raise ModelUnavailableError("Brain response not a structured JSON plan") from exc
    if not isinstance(result, dict) or set(result) != {"targetRole", "task", "prompt", "parameters"}:
        raise ModelUnavailableError("Brain must return the exact routing schema")
    role, task, prompt, params = (result[k] for k in ("targetRole", "task", "prompt", "parameters"))
    if role not in _ROLES or not isinstance(task, str) or not 1 <= len(task) <= 64:
        raise ModelUnavailableError("Brain returned an unauthorized role/task")
    if not isinstance(prompt, str) or len(prompt) > 4000 or not isinstance(params, dict):
        raise ModelUnavailableError("Brain returned an invalid prompt/parameter object")
    if len(json.dumps(params)) > 6000:
        raise ModelUnavailableError("Brain parameter payload too large")
    return {"modelId": model_id, "revision": definition.revision,
            "status": "PLAN_ONLY", "targetRole": role, "task": task,
            "prompt": prompt, "parameters": params}
