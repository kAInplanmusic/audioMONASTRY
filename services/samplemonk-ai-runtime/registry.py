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
    for model in data.get("models", []):
        revision = str(model.get("revision", "")).strip()
        if not revision or revision.lower() == "latest":
            raise ValueError(f"model {model.get('id')}: revision pinning required (no 'latest')")
    return data
