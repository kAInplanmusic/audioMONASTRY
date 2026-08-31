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
  python3 hf_manage_endpoint.py [create|update|status]

Regeln:
- GPU-Wechsel nur mit Betreiber-Freigabe (aktuell A100 fixiert).
- Kein minReplicas=1 (24/7-Billing vermeiden).
"""
from __future__ import annotations

import os
import sys

from huggingface_hub import (
    HfApi,
    create_inference_endpoint,
    get_inference_endpoint,
    update_inference_endpoint,
)

ENDPOINT_NAME = os.environ.get("HF_ENDPOINT_NAME", "samplemonk-ai")
NAMESPACE = os.environ.get("HF_NAMESPACE", "AnunnakiTools")
IMAGE = os.environ.get("IMAGE", "").strip()
REGION = os.environ.get("HF_REGION", "us-east-1")
VENDOR = os.environ.get("HF_VENDOR", "aws")
INSTANCE_TYPE = os.environ.get("HF_INSTANCE_TYPE", "nvidia-a100")
INSTANCE_SIZE = os.environ.get("HF_INSTANCE_SIZE", "x1")
SCALE_TO_ZERO_TIMEOUT = int(os.environ.get("HF_SCALE_TO_ZERO_TIMEOUT", "20"))


def _common_kwargs() -> dict:
    """Kwargs, die create und update akzeptieren."""
    image: dict = {
        "url": IMAGE,
        "health_route": "/health",
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
        "type": "authenticated",
        "namespace": NAMESPACE,
    }


def _create_kwargs() -> dict:
    """Create akzeptiert zusätzlich region/vendor."""
    kwargs = _common_kwargs()
    kwargs["region"] = REGION
    kwargs["vendor"] = VENDOR
    return kwargs


def main() -> int:
    command = sys.argv[1] if len(sys.argv) > 1 else "status"
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
    except Exception as get_error:
        print(f"Endpoint existiert nicht ({type(get_error).__name__}) -> create")
        ep = create_inference_endpoint(ENDPOINT_NAME, **_create_kwargs())

    print(f"OK name={ep.name} status={ep.status} url={ep.url}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
