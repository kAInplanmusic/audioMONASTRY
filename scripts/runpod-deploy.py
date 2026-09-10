#!/usr/bin/env python3
"""
audioMONASTRY · RunPod Serverless Endpoint Deployment (3-Rollen-Flotte)
=======================================================================
Erstellt/aktualisiert die Serverless-Endpoints der GPU-Flotte:

    brain     samplemonk-ai-brain   AMPERE_48  (A6000 48 GB)
    ears      samplemonk-ai-ears    AMPERE_48  (A6000 48 GB)
    voiceGen  samplemonk-ai-voice   AMPERE_48  (A6000 48 GB)

Jeder Endpoint bekommt dieselben Gewichte-Caches, aber eine andere Rolle per
`AI_ROLE` – der Worker lädt daraus nur die Modelle seines Rollen-Manifests.

Alle Endpoints starten mit `workers_min=0` (Scale-to-Zero, keine Idle-Kosten).
Der Session-Wake (`src/core/ai/orchestrator/fleetWake.ts`) hebt `workersMin`
beim Studio-Eintritt temporär auf 1 und feuert einen Warmup-Job.

Voraussetzungen:
  - RP_API_KEY (RunPod Personal Access Token)
  - IMAGE (GHCR-Image, z. B. ghcr.io/<owner>/samplemonk-ai-runtime-runpod:<sha>)

Betriebsarten:
  RUNPOD_DEPLOY_ALL_ROLES=1        alle drei Rollen deployen (Default im Workflow)
  RUNPOD_ROLE=brain                nur eine Rolle deployen
  RUNPOD_ENDPOINT_NAME=...         Legacy: ein einzelner Endpoint ohne Rolle
                                   (AI_ROLE bleibt leer, alle Modelle des Manifests)

Optional:
  RUNPOD_NETWORK_VOLUME_ID, RUNPOD_WORKERS_MAX, RUNPOD_IDLE_TIMEOUT,
  RUNPOD_TEMPLATE_ID, GHCR_USERNAME/GHCR_PASSWORD
"""
from __future__ import annotations

import os
import sys
from typing import Any, Dict, List, Optional

import runpod

#: Rollen der Flotte (Spiegel von GPU_ROLE_IDS im TS-Spiegel).
ROLE_DEFAULTS: Dict[str, Dict[str, Any]] = {
    "brain": {"suffix": "brain", "gpuPoolId": "AMPERE_48", "gpuCount": 1, "workersMax": 1},
    "ears": {"suffix": "ears", "gpuPoolId": "AMPERE_48", "gpuCount": 1, "workersMax": 1},
    "voiceGen": {"suffix": "voice", "gpuPoolId": "AMPERE_48", "gpuCount": 1, "workersMax": 1},
}

DOCKER_START_CMD = "python runpod_worker.py"


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def build_env_vars(role: str) -> Dict[str, str]:
    """Container-Env eines Rollen-Workers."""
    env_vars = {
        "AI_RUNTIME_DEVICE": env("AI_RUNTIME_DEVICE", "cuda"),
        "AI_MODEL_MANIFEST": "/opt/samplemonk-ai/model_manifest.json",
        "HF_HOME": env("HF_HOME", "/data/hf-cache"),
        "AI_RUNPOD_PRELOAD": env("AI_RUNPOD_PRELOAD", "0"),
        # Nur für Diagnose: hängt die echte Fehlermeldung an Worker-Fehler an.
        "AI_RUNTIME_DEBUG": env("AI_RUNTIME_DEBUG", "0"),
    }
    if role:
        env_vars["AI_ROLE"] = role
    if env("HF_TOKEN"):
        env_vars["HF_TOKEN"] = env("HF_TOKEN")
    if env("AI_INCLUDE_PLANNED"):
        env_vars["AI_INCLUDE_PLANNED"] = env("AI_INCLUDE_PLANNED")
    return env_vars


def ensure_registry_auth(endpoint_name: str) -> Optional[str]:
    ghcr_user = env("GHCR_USERNAME")
    ghcr_pass = env("GHCR_PASSWORD") or env("GHCR_PAT_ALL_ACCESS")
    if not (ghcr_user and ghcr_pass):
        return None
    try:
        auth = runpod.create_container_registry_auth(name=f"{endpoint_name}-ghcr", username=ghcr_user, password=ghcr_pass)
        return auth.get("id", auth if isinstance(auth, str) else None)
    except Exception as exc:  # noqa: BLE001
        print(f"[deploy] Registry-Auth konnte nicht angelegt werden: {exc}", file=sys.stderr)
        return None


def save_template(template_name: str, image: str, env_vars: Dict[str, str], container_disk_gb: int) -> Dict[str, Any]:
    """Idempotentes Template-Handling (kein 'Template name must be unique')."""
    from runpod.api.graphql import run_graphql_query

    env_items = ", ".join([f'{{ key: "{k}", value: "{v}" }}' for k, v in env_vars.items()])

    def payload(template_id: Optional[str]) -> str:
        id_line = f'id: "{template_id}"' if template_id else ""
        return f"""
        mutation {{
          saveTemplate(
            input: {{
              {id_line}
              name: "{template_name}"
              imageName: "{image}"
              dockerArgs: "{DOCKER_START_CMD}"
              containerDiskInGb: {container_disk_gb}
              volumeInGb: 0
              ports: ""
              env: [{env_items}]
              isServerless: true
              startSsh: true
              isPublic: false
              readme: ""
            }}
          ) {{
            id
            name
            imageName
            isServerless
          }}
        }}
        """

    existing_template_id = env("RUNPOD_TEMPLATE_ID")
    if not existing_template_id:
        list_query = """
        query {
          myself {
            podTemplates { id name imageName isServerless }
          }
        }
        """
        try:
            result = run_graphql_query(list_query)
            for tpl in result.get("data", {}).get("myself", {}).get("podTemplates", []) or []:
                if tpl.get("name") == template_name:
                    existing_template_id = tpl.get("id", "")
                    break
        except Exception:  # noqa: BLE001
            existing_template_id = ""

    if existing_template_id:
        print(f"[deploy] Template '{template_name}' aktualisieren (id={existing_template_id}) …")
        result = run_graphql_query(payload(existing_template_id))
    else:
        print(f"[deploy] Template '{template_name}' anlegen …")
        result = run_graphql_query(payload(None))
    return result.get("data", {}).get("saveTemplate", {})


def deploy_role(role: str, image: str) -> Optional[str]:
    """Erstellt/aktualisiert den Endpoint einer Rolle; liefert die Endpoint-ID."""
    defaults = ROLE_DEFAULTS.get(role, {})
    endpoint_name = env("RUNPOD_ENDPOINT_NAME") or f"samplemonk-ai-{defaults.get('suffix', role)}"
    gpu_id = env("RUNPOD_GPU_ID") or str(defaults.get("gpuPoolId", "AMPERE_48"))
    gpu_count = int(env("RUNPOD_GPU_COUNT") or defaults.get("gpuCount", 1))
    workers_min = int(env("RUNPOD_WORKERS_MIN", "0"))
    workers_max = int(env("RUNPOD_WORKERS_MAX") or defaults.get("workersMax", 1))
    idle_timeout = int(env("RUNPOD_IDLE_TIMEOUT", "20"))
    container_disk_gb = int(env("RUNPOD_CONTAINER_DISK_GB", "40"))
    template_name = f"{endpoint_name}-template"

    registry_auth_id = ensure_registry_auth(endpoint_name)
    env_vars = build_env_vars(role)

    template = save_template(template_name, image, env_vars, container_disk_gb)
    template_id = template.get("id", "")
    if not template_id:
        print(f"[deploy] FEHLER: Template-Erstellung lieferte keine ID für {endpoint_name}", file=sys.stderr)
        return None
    print(f"[deploy] {endpoint_name}: Template-ID {template_id}")

    endpoints = runpod.get_endpoints() or []
    existing = next((e for e in endpoints if e.get("name") == endpoint_name), None)
    if existing:
        endpoint_id = existing.get("id", "")
        print(f"[deploy] {endpoint_name}: existiert ({endpoint_id}) → Template-Update")
        runpod.update_endpoint_template(endpoint_id, template_id)
    else:
        print(f"[deploy] {endpoint_name}: anlegen (GPU {gpu_id} x{gpu_count}) …")
        endpoint = runpod.create_endpoint(
            name=endpoint_name,
            template_id=template_id,
            gpu_ids=gpu_id,
            network_volume_id=env("RUNPOD_NETWORK_VOLUME_ID") or None,
            idle_timeout=idle_timeout,
            scaler_type="QUEUE_DELAY",
            scaler_value=4,
            workers_min=workers_min,
            workers_max=workers_max,
            flashboot=False,
            gpu_count=gpu_count,
        )
        endpoint_id = endpoint.get("id", "")
        if registry_auth_id:
            print(f"[deploy] {endpoint_name}: Registry-Auth {registry_auth_id} aktiv")

    if not endpoint_id:
        print(f"[deploy] FEHLER: Endpoint-ID fehlt für {endpoint_name}", file=sys.stderr)
        return None
    print(f"[deploy] OK {endpoint_name} → ENDPOINT_ID={endpoint_id}")
    print(f"[deploy]    runsync: https://api.runpod.ai/v2/{endpoint_id}/runsync")
    return endpoint_id


def main() -> int:
    api_key = env("RP_API_KEY") or env("RUNPOD_API_KEY")
    image = env("IMAGE")
    if not api_key:
        print("FEHLER: RP_API_KEY/RUNPOD_API_KEY fehlt", file=sys.stderr)
        return 2
    if not image:
        print("FEHLER: IMAGE fehlt (z. B. ghcr.io/<owner>/samplemonk-ai-runtime-runpod:<sha>)", file=sys.stderr)
        return 2

    runpod.api_key = api_key

    single_role = env("RUNPOD_ROLE")
    if single_role and single_role not in ROLE_DEFAULTS:
        print(f"FEHLER: unbekannte RUNPOD_ROLE {single_role!r} (erwartet: {', '.join(ROLE_DEFAULTS)})", file=sys.stderr)
        return 2

    # Legacy: expliziter Einzel-Endpoint ohne Rolle (AI_ROLE leer).
    if not single_role and not env("RUNPOD_DEPLOY_ALL_ROLES") and env("RUNPOD_ENDPOINT_NAME"):
        roles: List[str] = [""]
    elif single_role:
        roles = [single_role]
    else:
        roles = list(ROLE_DEFAULTS)

    print(f"[deploy] Rollen: {roles or ['(legacy)']}")
    results: Dict[str, str] = {}
    for role in roles:
        endpoint_id = deploy_role(role, image)
        if not endpoint_id:
            print(f"[deploy] ABBRUCH – Rolle {role or 'legacy'} fehlgeschlagen", file=sys.stderr)
            return 5
        results[role or "legacy"] = endpoint_id

    print("[deploy] Zusammenfassung:")
    for role, endpoint_id in results.items():
        env_name = {
            "brain": "RUNPOD_ENDPOINT_ID_BRAIN",
            "ears": "RUNPOD_ENDPOINT_ID_EARS",
            "voiceGen": "RUNPOD_ENDPOINT_ID_VOICE",
        }.get(role, "RUNPOD_ENDPOINT_ID")
        print(f"[deploy]   {env_name}={endpoint_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
