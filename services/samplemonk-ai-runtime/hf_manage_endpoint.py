#!/usr/bin/env python3
"""
SampleMONK AI Runtime – HF Endpoint Manager (create-or-update)
===============================================================
Legt den Custom-Container-Endpoint `samplemonk-ai` an bzw. aktualisiert ihn:
  - Custom Image (ghcr.io), Task `custom`, A100 x1 (us-east-1, AWS)
  - minReplicas 0 / maxReplicas 1 / Scale-to-Zero-Timeout 20 min
  - Secret `HF_TOKEN` für Gated-Gewichte (wird NIE ins Image geschrieben)
  - Health `/health`, Readiness `/ready`

Aufruf (lokal oder CI):
  HF_TOKEN=hf_... IMAGE=ghcr.io/<owner>/samplemonk-ai-runtime:latest \
  python3 hf_manage_endpoint.py [create|update|status|delete-legacy]

Regeln (GPU-Konsolidierung):
- MAXIMAL 1 A100: nur der Endpoint `samplemonk-ai` darf GPU betreiben.
- Alte Einzel-GPU-Endpoints (samplemonk-ai-pilot, samplemonk-ai-clap) sind
  deaktiviert; `delete-legacy` entfernt sie aus der HF-Infrastruktur.
- GPU-Wechsel nur mit Betreiber-Freigabe (aktuell A100 fixiert).
- Kein minReplicas=1 (24/7-Billing vermeiden).
"""
from __future__ import annotations

import os
import re
import sys

from huggingface_hub import (
    HfApi,
    create_inference_endpoint,
    delete_inference_endpoint,
    get_inference_endpoint,
    update_inference_endpoint,
)

# Harte Kostenregel: genau EIN GPU-Endpoint.
SINGLE_GPU_ENDPOINT_NAME = "samplemonk-ai"
LEGACY_GPU_ENDPOINT_NAMES = ["samplemonk-ai-pilot", "samplemonk-ai-clap"]

ENDPOINT_NAME = os.environ.get("HF_ENDPOINT_NAME", SINGLE_GPU_ENDPOINT_NAME)
NAMESPACE = os.environ.get("HF_NAMESPACE", "AnunnakiTools")
IMAGE = os.environ.get("IMAGE", "").strip()
REGION = os.environ.get("HF_REGION", "us-east-1")
VENDOR = os.environ.get("HF_VENDOR", "aws")
INSTANCE_TYPE = os.environ.get("HF_INSTANCE_TYPE", "nvidia-a100")
INSTANCE_SIZE = os.environ.get("HF_INSTANCE_SIZE", "x1")
SCALE_TO_ZERO_TIMEOUT_RAW = os.environ.get("HF_SCALE_TO_ZERO_TIMEOUT", "20").strip()
try:
    SCALE_TO_ZERO_TIMEOUT = int(SCALE_TO_ZERO_TIMEOUT_RAW)
except ValueError:
    SCALE_TO_ZERO_TIMEOUT = -1

_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,63}$")
_IMAGE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9._-]{1,128})?$")
_NO_CONTROL_RE = re.compile(r"^[^\x00-\x1f\x7f]{1,512}$")


def _validate_config() -> str:
    """Validiert Umgebungsvariablen vor HF-API-Aufrufen (keine Secrets im Log)."""
    if not _NAME_RE.fullmatch(ENDPOINT_NAME):
        return f"invalid HF_ENDPOINT_NAME: {ENDPOINT_NAME!r}"
    if not _NAME_RE.fullmatch(NAMESPACE):
        return f"invalid HF_NAMESPACE: {NAMESPACE!r}"
    if not _NAME_RE.fullmatch(REGION):
        return f"invalid HF_REGION: {REGION!r}"
    if not _NAME_RE.fullmatch(VENDOR):
        return f"invalid HF_VENDOR: {VENDOR!r}"
    if IMAGE and not _IMAGE_RE.fullmatch(IMAGE):
        return "invalid IMAGE: expected registry/image:tag"
    try:
        timeout = int(SCALE_TO_ZERO_TIMEOUT)
        if timeout < 0 or timeout > 1440:
            return "invalid HF_SCALE_TO_ZERO_TIMEOUT: must be 0..1440"
    except ValueError:
        return "invalid HF_SCALE_TO_ZERO_TIMEOUT: must be an integer"
    reg_user = os.environ.get("HF_REGISTRY_USERNAME", "").strip()
    reg_pass = os.environ.get("HF_REGISTRY_PASSWORD", "").strip()
    if (reg_user and not _NO_CONTROL_RE.fullmatch(reg_user)) or (reg_pass and not _NO_CONTROL_RE.fullmatch(reg_pass)):
        return "invalid HF_REGISTRY_USERNAME/PASSWORD: must not contain control characters"
    return ""


def _common_kwargs() -> dict:
    """Kwargs, die create und update akzeptieren."""
    image: dict = {
        "url": IMAGE,
        "port": 8000,
        "healthRoute": "/health",
    }
    # Private Registry (z. B. GHCR): optionale Credentials für den HF-Pull.
    reg_user = os.environ.get("HF_REGISTRY_USERNAME", "").strip()
    reg_pass = os.environ.get("HF_REGISTRY_PASSWORD", "").strip()
    if reg_user and reg_pass:
        image["credentials"] = {"username": reg_user, "password": reg_pass}
    return {
        "accelerator": "gpu",
        "instance_size": INSTANCE_SIZE,
        "instance_type": INSTANCE_TYPE,
        "min_replica": 0,
        "max_replica": 1,
        "scale_to_zero_timeout": SCALE_TO_ZERO_TIMEOUT,
        "task": "custom",
        "custom_image": image,
        "env": {
            "AI_RUNTIME_DEVICE": "cuda",
            "AI_MODEL_MANIFEST": "/opt/samplemonk-ai/model_manifest.json",
            "HF_HOME": "/data/hf-cache",
        },
        "secrets": {"HF_TOKEN": os.environ.get("HF_TOKEN", "")},
        "namespace": NAMESPACE,
    }


def _create_kwargs() -> dict:
    """Create akzeptiert zusätzlich region/vendor.

    repository/framework sind in create_inference_endpoint Pflicht-Keywords,
    für Custom-Container aber None (Modell kommt aus dem Image).
    """
    kwargs = _common_kwargs()
    kwargs["region"] = REGION
    kwargs["vendor"] = VENDOR
    kwargs["repository"] = "AnunnakiTools/samplemonk-ai-runtime"  # eigenes HF-Repo (Custom-Container verlangt existierendes Repo im Namespace)
    kwargs["framework"] = "pytorch"  # Custom-Container: framework muss gesetzt sein
    kwargs["type"] = "authenticated"  # nur create akzeptiert type (update nicht!)
    return kwargs


def _guard_single_gpu_endpoint() -> int:
    """Verhindert, dass versehentlich ein zweiter GPU-Endpoint angelegt wird."""
    allowed_override = os.environ.get("ALLOW_GPU_ENDPOINT_NAME", "").strip()
    if ENDPOINT_NAME != SINGLE_GPU_ENDPOINT_NAME and ENDPOINT_NAME != allowed_override:
        print(
            f"FEHLER: HF_ENDPOINT_NAME={ENDPOINT_NAME} ist nicht erlaubt. "
            f"GPU-Konsolidierung erlaubt nur {SINGLE_GPU_ENDPOINT_NAME} "
            "(maximal 1 A100).",
            file=sys.stderr,
        )
        return 2
    return 0


def main() -> int:
    command = sys.argv[1] if len(sys.argv) > 1 else "status"
    config_error = _validate_config()
    if config_error:
        print(f"FEHLER: {config_error}", file=sys.stderr)
        return 2
    if command == "delete-legacy":
        if not os.environ.get("HF_TOKEN", "").strip():
            print("FEHLER: HF_TOKEN env ist erforderlich", file=sys.stderr)
            return 2
        for name in LEGACY_GPU_ENDPOINT_NAMES:
            try:
                delete_inference_endpoint(name, namespace=NAMESPACE)
                print(f"deleted legacy endpoint: {name}")
            except Exception as exc:  # noqa: BLE001 – Endpoint evtl. schon weg
                print(f"legacy endpoint {name} nicht gelöscht ({type(exc).__name__}: {exc})")
        return 0
    guard = _guard_single_gpu_endpoint()
    if guard:
        return guard
    if command == "status":
        try:
            ep = get_inference_endpoint(ENDPOINT_NAME, namespace=NAMESPACE)
            print(f"status={ep.status} url={ep.url}")
        except Exception as exc:  # noqa: BLE001 – 404 = existiert nicht
            print(f"status=not-found ({type(exc).__name__}: {exc})")
            return 1
        return 0
    if not IMAGE:
        print("FEHLER: IMAGE env ist erforderlich (z. B. ghcr.io/<owner>/samplemonk-ai-runtime:latest)")
        return 2
    if not os.environ.get("HF_TOKEN", "").strip():
        print("FEHLER: HF_TOKEN env ist erforderlich (Gated-Gewichte + Endpoint-Secret)")
        return 2

    try:
        existing = get_inference_endpoint(ENDPOINT_NAME, namespace=NAMESPACE)
        print(f"Endpoint existiert (status={existing.status}) -> update")
        ep = update_inference_endpoint(ENDPOINT_NAME, **_common_kwargs())
    except Exception as get_error:  # noqa: BLE001 – FA-P1-3: nur 404/Not-Found → create
        text = str(get_error)
        not_found = "404" in text or "not found" in text.lower() or "does not exist" in text.lower()
        if not not_found:
            print(
                f"FEHLER: get_inference_endpoint fehlgeschlagen ({type(get_error).__name__}: {text}). "
                "Kein Create – Netz-/Auth-/Rate-Fehler müssen manuell geklärt werden.",
                file=sys.stderr,
            )
            return 3
        print(f"Endpoint existiert nicht (404) -> create")
        ep = create_inference_endpoint(ENDPOINT_NAME, **_create_kwargs())

    print(f"OK name={ep.name} status={ep.status} url={ep.url}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
