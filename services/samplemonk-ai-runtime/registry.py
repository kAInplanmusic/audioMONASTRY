"""
SampleMONK AI Runtime – Model Registry (Manifest-Loader)
=========================================================
Liest model_manifest.json. Produktionsregel: feste Revisionen (kein `latest`).
"""
from __future__ import annotations

import json
import os
from typing import Any, Dict

MANIFEST_PATH = os.environ.get("AI_MODEL_MANIFEST", os.path.join(os.path.dirname(__file__), "model_manifest.json"))


def load_manifest() -> Dict[str, Any]:
    with open(MANIFEST_PATH, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise ValueError("manifest must be a JSON object")
    models = data.get("models") or []
    if not isinstance(models, list):
        raise ValueError("manifest 'models' must be a list")
    for model in models:
        if not isinstance(model, dict):
            raise ValueError("manifest model entries must be objects")
        revision = str(model.get("revision", "")).strip()
        if not revision or revision.lower() == "latest":
            raise ValueError(f"model {model.get('id')}: revision pinning required (no 'latest')")
    return data
