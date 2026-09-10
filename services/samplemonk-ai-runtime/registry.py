"""
SampleMONK AI Runtime – Model Registry (Manifest-Loader)
=========================================================
Liest model_manifest.json. Produktionsregeln:

- **Feste Revisionen**: kein ``latest``, keine ungepinnten Revisionen.
  Platzhalter (``TBD-…``) sind nur mit ``status: "planned"`` erlaubt.
- **Rollen-Filter**: ``load_manifest("brain" | "ears" | "voiceGen")`` liefert
  genau die Modelle der Rolle plus deren VRAM-Budget und Preload-Satz. Der
  Rollen-Block im Manifest ist die einzige Quelle der Rollen-Zuordnung.
- **Geplante Modelle** (``status: "planned"``) sind im Betrieb ausgeschlossen,
  solange ``AI_INCLUDE_PLANNED`` nicht explizit gesetzt ist – so kann kein
  Modell ohne echten Revisions-Pin versehentlich geladen werden.

Spiegel der Rollen-IDs: ``src/config/aiInfrastructure.ts``.
"""
from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional

MANIFEST_PATH = os.environ.get("AI_MODEL_MANIFEST", os.path.join(os.path.dirname(__file__), "model_manifest.json"))

#: Rollen der GPU-Flotte (muss zu GPU_ROLE_IDS im TS-Spiegel passen).
ROLE_IDS = ("brain", "ears", "voiceGen")

_PLANNED_PREFIX = "TBD"

#: Runtime-Schlüssel, die der Rollen-Block übersteuern darf.
_ROLE_RUNTIME_KEYS = (
    "label",
    "gpuPoolId",
    "gpuCount",
    "vramBudgetGb",
    "vramSafetyMarginGb",
    "maxConcurrentInference",
    "idleTimeoutMinutes",
)


def _include_planned() -> bool:
    return os.environ.get("AI_INCLUDE_PLANNED", "").strip().lower() in ("1", "true", "yes")


def _is_planned(model: Dict[str, Any]) -> bool:
    return str(model.get("status", "")).strip().lower() == "planned"


def _validate_revision(model: Dict[str, Any]) -> None:
    model_id = model.get("id")
    raw_revision = model.get("revision")
    if raw_revision is None or not isinstance(raw_revision, str):
        raise ValueError(f"model {model_id}: revision pinning required (no 'latest', no null)")
    revision = raw_revision.strip()
    if not revision or revision.lower() == "latest":
        raise ValueError(f"model {model_id}: revision pinning required (no 'latest')")
    if revision.upper().startswith(_PLANNED_PREFIX) and not _is_planned(model):
        raise ValueError(
            f"model {model_id}: ungepinnte Revision {revision!r} ist nur mit status='planned' erlaubt",
        )


def read_manifest() -> Dict[str, Any]:
    """Liest und validiert das Manifest (ohne Rollen-Filter)."""
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
        _validate_revision(model)
    return data


def apply_role(data: Dict[str, Any], role: str) -> Dict[str, Any]:
    """Filtert ein Manifest auf eine Flotten-Rolle (Modelle + Runtime-Budget)."""
    roles = data.get("roles")
    if not isinstance(roles, dict) or not roles:
        raise ValueError("manifest hat keinen 'roles'-Block – Rollen-Betrieb nicht möglich")
    if role not in roles:
        raise ValueError(f"unbekannte AI_ROLE {role!r} (erwartet: {', '.join(sorted(roles))})")
    spec = roles[role]
    if not isinstance(spec, dict):
        raise ValueError(f"role {role}: Rollen-Definition muss ein Objekt sein")

    models = data["models"]
    by_id = {m["id"]: m for m in models}

    wanted = spec.get("models") or []
    if not isinstance(wanted, list) or not wanted:
        raise ValueError(f"role {role}: 'models' muss eine nicht-leere Liste sein")
    unknown = [mid for mid in wanted if mid not in by_id]
    if unknown:
        raise ValueError(f"role {role}: unbekannte Modelle {unknown}")

    preload_models = spec.get("preloadModels") or []
    if not isinstance(preload_models, list):
        raise ValueError(f"role {role}: 'preloadModels' muss eine Liste sein")
    outside = [mid for mid in preload_models if mid not in wanted]
    if outside:
        raise ValueError(f"role {role}: preloadModels außerhalb der Rolle: {outside}")

    include_planned = _include_planned()
    skipped_planned: List[str] = []
    selected: List[Dict[str, Any]] = []
    for model_id in wanted:
        source = by_id[model_id]
        if _is_planned(source) and not include_planned:
            skipped_planned.append(model_id)
            continue
        model = dict(source)
        model["preload"] = model_id in preload_models
        selected.append(model)

    runtime = dict(data.get("runtime") or {})
    for key in _ROLE_RUNTIME_KEYS:
        if key in spec:
            runtime[key] = spec[key]

    result = dict(data)
    result["role"] = role
    result["runtime"] = runtime
    result["models"] = selected
    result["skippedPlanned"] = skipped_planned
    return result


def load_manifest(role: Optional[str] = None) -> Dict[str, Any]:
    """Lädt das Manifest – optional auf eine Flotten-Rolle gefiltert.

    ``role=None`` liefert das vollständige Manifest (Legacy-Single-Endpoint-
    Betrieb, z. B. der bestehende H200-Endpoint).
    """
    data = read_manifest()
    if not role:
        return data
    return apply_role(data, role)
