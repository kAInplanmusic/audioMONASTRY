#!/usr/bin/env python3
"""
audioMONASTRY · RunPod Serverless Endpoint Deployment
======================================================
Erstellt/aktualisiert einen RunPod Serverless Endpoint für die
samplemonk-ai-runtime.

Voraussetzungen:
  - RP_API_KEY (RunPod Personal Access Token)
  - IMAGE (GHCR-Image, z. B. ghcr.io/<owner>/samplemonk-ai-runtime:<sha>)

Optional:
  - RUNPOD_ENDPOINT_NAME (Default: samplemonk-ai-runpod)
  - RUNPOD_GPU_ID (Default: NVIDIA H200)
  - RUNPOD_NETWORK_VOLUME_ID
  - RUNPOD_WORKERS_MIN / RUNPOD_WORKERS_MAX
  - RUNPOD_IDLE_TIMEOUT
  - GHCR_USERNAME / GHCR_PASSWORD (falls GHCR-Image privat ist)
"""
from __future__ import annotations

import os
import sys

import runpod


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def main() -> int:
    api_key = env("RP_API_KEY") or env("RUNPOD_API_KEY")
    image = env("IMAGE")
    if not api_key:
        print("FEHLER: RP_API_KEY/RUNPOD_API_KEY fehlt", file=sys.stderr)
        return 2
    if not image:
        print("FEHLER: IMAGE fehlt (z. B. ghcr.io/<owner>/samplemonk-ai-runtime:<sha>)", file=sys.stderr)
        return 2

    runpod.api_key = api_key

    endpoint_name = env("RUNPOD_ENDPOINT_NAME", "samplemonk-ai-runpod")
    # RunPod verlangt GPU-POOL-IDs (nicht Marketing-Namen). H200 = HOPPER_141.
    gpu_id = env("RUNPOD_GPU_ID", "HOPPER_141")
    network_volume_id = env("RUNPOD_NETWORK_VOLUME_ID") or None
    workers_min = int(env("RUNPOD_WORKERS_MIN", "0"))
    workers_max = int(env("RUNPOD_WORKERS_MAX", "2"))
    idle_timeout = int(env("RUNPOD_IDLE_TIMEOUT", "5"))
    template_name = f"{endpoint_name}-template"
    container_disk_gb = int(env("RUNPOD_CONTAINER_DISK_GB", "30"))

    docker_start_cmd = "python runpod_worker.py"
    registry_auth_id = None
    ghcr_user = env("GHCR_USERNAME")
    ghcr_pass = env("GHCR_PASSWORD") or env("GHCR_PAT_ALL_ACCESS")
    if ghcr_user and ghcr_pass:
        print("[deploy] Lege GHCR-Registry-Auth an …")
        try:
            auth = runpod.create_container_registry_auth(
                name=f"{endpoint_name}-ghcr",
                username=ghcr_user,
                password=ghcr_pass,
            )
            registry_auth_id = auth.get("id", auth if isinstance(auth, str) else None)
        except Exception as exc:  # noqa: BLE001
            print(f"[deploy] Registry-Auth konnte nicht angelegt werden: {exc}", file=sys.stderr)
            return 3

    env_vars = {
        "AI_RUNTIME_DEVICE": env("AI_RUNTIME_DEVICE", "cuda"),
        "AI_MODEL_MANIFEST": "/opt/samplemonk-ai/model_manifest.json",
        "HF_HOME": env("HF_HOME", "/data/hf-cache"),
        "AI_RUNPOD_PRELOAD": env("AI_RUNPOD_PRELOAD", "0"),
    }
    if env("HF_TOKEN"):
        env_vars["HF_TOKEN"] = env("HF_TOKEN")

    print(f"[deploy] Erstelle/aktualisiere Serverless-Template '{template_name}' …")
    # ARCH: Idempotentes Template-Handling. Wenn RUNPOD_TEMPLATE_ID gesetzt ist,
    # wird das bestehende Template per saveTemplate(id=…) aktualisiert, statt
    # ein Duplikat anzulegen ("Template name must be unique").
    existing_template_id = env("RUNPOD_TEMPLATE_ID")
    if existing_template_id:
        from runpod.api.graphql import run_graphql_query

        env_items = ", ".join(
            [f'{{ key: "{key}", value: "{value}" }}' for key, value in env_vars.items()]
        )
        mutation = f"""
        mutation {{
          saveTemplate(
            input: {{
              id: "{existing_template_id}"
              name: "{template_name}"
              imageName: "{image}"
              dockerArgs: "{docker_start_cmd}"
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
        try:
            result = run_graphql_query(mutation)
            template = result.get("data", {}).get("saveTemplate", {})
        except Exception as exc:  # noqa: BLE001
            print(f"[deploy] Template-Update fehlgeschlagen: {exc}", file=sys.stderr)
            return 4
    else:
        # Ohne explizite ID: existierendes Template per podTemplates-Query suchen
        # (idempotent), sonst neu anlegen.
        from runpod.api.graphql import run_graphql_query

        list_query = """
        query {
          myself {
            podTemplates {
              id
              name
              imageName
              isServerless
            }
          }
        }
        """
        existing = {}
        try:
            result = run_graphql_query(list_query)
            for tpl in result.get("data", {}).get("myself", {}).get("podTemplates", []) or []:
                if tpl.get("name") == template_name:
                    existing = tpl
                    break
        except Exception:  # noqa: BLE001
            existing = {}

        if existing:
            existing_template_id = existing.get("id", "")
            print(f"[deploy] Template existiert bereits (id={existing_template_id}) → update …")
            env_items = ", ".join(
                [f'{{ key: "{key}", value: "{value}" }}' for key, value in env_vars.items()]
            )
            mutation = f"""
            mutation {{
              saveTemplate(
                input: {{
                  id: "{existing_template_id}"
                  name: "{template_name}"
                  imageName: "{image}"
                  dockerArgs: "{docker_start_cmd}"
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
            try:
                result = run_graphql_query(mutation)
                template = result.get("data", {}).get("saveTemplate", {})
            except Exception as exc:  # noqa: BLE001
                print(f"[deploy] Template-Update fehlgeschlagen: {exc}", file=sys.stderr)
                return 4
        else:
            template = runpod.create_template(
                name=template_name,
                image_name=image,
                docker_start_cmd=docker_start_cmd,
                container_disk_in_gb=container_disk_gb,
                env=env_vars,
                is_serverless=True,
                registry_auth_id=registry_auth_id,
            )
    template_id = template.get("id", "")
    if not template_id:
        print("FEHLER: Template-Erstellung lieferte keine ID", file=sys.stderr)
        return 4

    print(f"[deploy] Template-ID: {template_id}")

    endpoints = runpod.get_endpoints() or []
    existing = next((e for e in endpoints if e.get("name") == endpoint_name), None)

    if existing:
        endpoint_id = existing.get("id", "")
        print(f"[deploy] Endpoint '{endpoint_name}' existiert ({endpoint_id}) → Template-Update")
        runpod.update_endpoint_template(endpoint_id, template_id)
    else:
        print(f"[deploy] Lege Serverless Endpoint '{endpoint_name}' an (GPU {gpu_id}) …")
        endpoint = runpod.create_endpoint(
            name=endpoint_name,
            template_id=template_id,
            gpu_ids=gpu_id,
            network_volume_id=network_volume_id,
            idle_timeout=idle_timeout,
            scaler_type="QUEUE_DELAY",
            scaler_value=4,
            workers_min=workers_min,
            workers_max=workers_max,
            flashboot=False,
            gpu_count=1,
        )
        endpoint_id = endpoint.get("id", "")

    if not endpoint_id:
        print("FEHLER: Endpoint-ID fehlt", file=sys.stderr)
        return 5

    print(f"[deploy] OK endpoint_name={endpoint_name}")
    print(f"[deploy] RUNPOD_ENDPOINT_ID={endpoint_id}")
    print(f"[deploy] runsync: https://api.runpod.ai/v2/{endpoint_id}/runsync")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
