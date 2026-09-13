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

Brain seit 2026-09-11: Die Rolle brain laeuft auf dem vorgefertigten RunPod-vLLM-Worker
(Qwen3-14B-AWQ) statt auf unserem Image. Gemessen ~2x (kurze Calls) / ~3,6x (lange Outputs)
gegenueber transformers. Steuerung:
  RUNPOD_BRAIN_VLLM=0                    zurueck auf unser eigenes Brain-Image
  RUNPOD_BRAIN_VLLM_IMAGE / _MODEL / _REVISION / _QUANTIZATION / _MAX_MODEL_LEN
Der vLLM-Brain ist ein reiner LLM-Endpoint; ears/voiceGen bleiben auf unserem Image.
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
    # 4. Rolle (2026-09-11): generative Bilder (FLUX.1-dev) - eigener Hub-Worker,
    # NICHT unser Audio-Image.
    "vision": {"suffix": "vision", "gpuPoolId": "AMPERE_48", "gpuCount": 1, "workersMax": 1},
    # 5. Rolle (2026-09-11): Video (Wan2.2 image->video), ADA_24/32-Pool des Hub-Workers.
    "video": {"suffix": "video", "gpuPoolId": "ADA_24", "gpuCount": 1, "workersMax": 1},
}

DOCKER_START_CMD = "python runpod_worker.py"

#: Brain läuft seit 2026-09-11 auf dem vorgefertigten RunPod-vLLM-Worker
#: (v2.27.0 / vLLM 0.29.0). Der Brain ist ein reiner LLM-Endpoint; Audio-Modelle
#: bleiben auf ears/voiceGen. Gemessen: ~2x kurze Calls, ~3,6x lange Outputs.
BRAIN_VLLM_IMAGE_DEFAULT = "registry.runpod.net/runpod-workers-worker-vllm-main-dockerfile:76054c22c"
BRAIN_VLLM_MODEL_DEFAULT = "Qwen/Qwen3-14B-AWQ"
BRAIN_VLLM_REVISION_DEFAULT = "31c69efc29464b6bb0aee1398b5a7b50a99340c3"


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def brain_vllm_enabled() -> bool:
    """Default AN (Entscheidung 2026-09-11); `RUNPOD_BRAIN_VLLM=0` schaltet zurück."""
    raw = env("RUNPOD_BRAIN_VLLM").lower()
    return raw not in ("0", "false", "no", "off")


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


def build_env_vars_vllm() -> Dict[str, str]:
    """Container-Env des RunPod-vLLM-Workers (OpenAI-kompatibler Brain)."""
    env_vars = {
        "MODEL_NAME": env("RUNPOD_BRAIN_VLLM_MODEL", BRAIN_VLLM_MODEL_DEFAULT),
        "MODEL_REVISION": env("RUNPOD_BRAIN_VLLM_REVISION", BRAIN_VLLM_REVISION_DEFAULT),
        "QUANTIZATION": env("RUNPOD_BRAIN_VLLM_QUANTIZATION", "awq"),
        "MAX_MODEL_LEN": env("RUNPOD_BRAIN_VLLM_MAX_MODEL_LEN", "16384"),
        "GPU_MEMORY_UTILIZATION": env("RUNPOD_BRAIN_VLLM_GPU_MEMORY_UTILIZATION", "0.90"),
    }
    if env("HF_TOKEN"):
        env_vars["HF_TOKEN"] = env("HF_TOKEN")
    return env_vars


#: Rolle `vision` = vorgefertigter FLUX.1-dev-Worker (PrunaAI), AMPERE_48.
#: Der Worker laedt FLUX.1-dev selbst; optional anderes Modell ueber HF_MODEL.
VISION_IMAGE_DEFAULT = "registry.runpod.net/prunaai-runpod-worker-flux-1-dev-main-dockerfile:287a29201"


def build_env_vars_vision() -> Dict[str, str]:
    """Container-Env des FLUX-Workers (Rolle vision)."""
    env_vars: Dict[str, str] = {}
    if env("RUNPOD_VISION_MODEL"):
        env_vars["HF_MODEL"] = env("RUNPOD_VISION_MODEL")
    if env("HF_TOKEN"):
        env_vars["HF_TOKEN"] = env("HF_TOKEN")
    return env_vars


#: Rolle `video` = vorgefertigter Wan2.2-Image->Video-Worker (ComfyUI), ADA_24/32.
VIDEO_IMAGE_DEFAULT = "registry.runpod.net/wlsdml1114-generate-video-ksampler-dockerfile:a9247705c"


def build_env_vars_video() -> Dict[str, str]:
    """Container-Env des Video-Workers (Rolle video)."""
    env_vars: Dict[str, str] = {}
    if env("HF_TOKEN"):
        env_vars["HF_TOKEN"] = env("HF_TOKEN")
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


def save_template(
    template_name: str,
    image: str,
    env_vars: Dict[str, str],
    container_disk_gb: int,
    docker_args: str = DOCKER_START_CMD,
) -> Dict[str, Any]:
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
              dockerArgs: "{docker_args}"
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


def image_for_role(role: str) -> str:
    """Bild je Rolle: der Brain nutzt das Image mit eingebackenen Gewichten.

    Setzt `IMAGE_BRAIN` nicht, fällt alles auf `IMAGE` zurück (ein Image für alle).
    """
    if role == "brain":
        return env("IMAGE_BRAIN") or env("IMAGE")
    return env("IMAGE")


def deploy_role(role: str, image: str) -> Optional[str]:
    """Erstellt/aktualisiert den Endpoint einer Rolle; liefert die Endpoint-ID."""
    defaults = ROLE_DEFAULTS.get(role, {})
    endpoint_name = env("RUNPOD_ENDPOINT_NAME") or f"samplemonk-ai-{defaults.get('suffix', role)}"
    gpu_id = env("RUNPOD_GPU_ID") or str(defaults.get("gpuPoolId", "AMPERE_48"))
    gpu_count = int(env("RUNPOD_GPU_COUNT") or defaults.get("gpuCount", 1))
    workers_min = int(env("RUNPOD_WORKERS_MIN", "0"))
    workers_max = int(env("RUNPOD_WORKERS_MAX") or defaults.get("workersMax", 1))
    idle_timeout = int(env("RUNPOD_IDLE_TIMEOUT", "20"))
    # Brain (vLLM) braucht mehr Plattenplatz (Image + ~10 GB AWQ-Gewichte);
    # vision (FLUX) braucht 80 GB (Image + Gewichte).
    default_disk = "150" if role == "brain" else "80" if role == "vision" else "180" if role == "video" else "30"
    container_disk_gb = int(env("RUNPOD_CONTAINER_DISK_GB", default_disk))
    template_name = f"{endpoint_name}-template"

    # Brain = gepflegter RunPod-vLLM-Worker (OpenAI-kompatibel, AWQ).
    vllm_brain = role == "brain" and brain_vllm_enabled()
    if vllm_brain:
        image = env("RUNPOD_BRAIN_VLLM_IMAGE", BRAIN_VLLM_IMAGE_DEFAULT)
        env_vars = build_env_vars_vllm()
        template_name = "samplemonk-ai-brain-vllm-template"
        registry_auth_id = None
        docker_args = ""  # Image bringt seinen eigenen Entrypoint mit
        print(f"[deploy] {endpoint_name}: vLLM-Worker ({env_vars['MODEL_NAME']}, {env_vars['QUANTIZATION']})")
    elif role == "vision":
        # Rolle vision = vorgefertigter FLUX.1-dev-Worker (nicht unser Audio-Image).
        image = env("RUNPOD_VISION_IMAGE", VISION_IMAGE_DEFAULT)
        env_vars = build_env_vars_vision()
        template_name = "samplemonk-ai-vision-template"
        registry_auth_id = None
        docker_args = ""
        print(f"[deploy] {endpoint_name}: FLUX-Worker (Rolle vision)")
    elif role == "video":
        # Rolle video = vorgefertigter Wan2.2-image->video-Worker.
        image = env("RUNPOD_VIDEO_IMAGE", VIDEO_IMAGE_DEFAULT)
        env_vars = build_env_vars_video()
        template_name = "samplemonk-ai-video-template"
        registry_auth_id = None
        docker_args = ""
        print(f"[deploy] {endpoint_name}: Wan2.2-Video-Worker (Rolle video)")
    else:
        registry_auth_id = ensure_registry_auth(endpoint_name)
        env_vars = build_env_vars(role)
        docker_args = DOCKER_START_CMD

    template = save_template(template_name, image, env_vars, container_disk_gb, docker_args)
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
        volume_id = env("RUNPOD_NETWORK_VOLUME_ID") or None

        def create(volume: Optional[str]):
            return runpod.create_endpoint(
                name=endpoint_name,
                template_id=template_id,
                gpu_ids=gpu_id,
                network_volume_id=volume,
                idle_timeout=idle_timeout,
                scaler_type="QUEUE_DELAY",
                scaler_value=4,
                workers_min=workers_min,
                workers_max=workers_max,
                flashboot=False,
                gpu_count=gpu_count,
            )

        try:
            endpoint = create(volume_id)
        except Exception as exc:  # noqa: BLE001
            # Ein ungültiges/veraltetes RUNPOD_NETWORK_VOLUME_ID darf den Deploy
            # nicht verhindern: ohne Volume neu versuchen (Gewichte werden dann
            # pro Kaltstart erneut geladen).
            if not volume_id:
                print(f"[deploy] FEHLER {endpoint_name}: {type(exc).__name__}: {exc}", file=sys.stderr)
                return None
            print(
                f"[deploy] WARNUNG {endpoint_name}: Anlegen mit Network-Volume "
                f"{volume_id[:8]}… fehlgeschlagen ({type(exc).__name__}) → Retry ohne Volume",
                file=sys.stderr,
            )
            try:
                endpoint = create(None)
            except Exception as exc2:  # noqa: BLE001
                print(f"[deploy] FEHLER {endpoint_name}: {type(exc2).__name__}: {exc2}", file=sys.stderr)
                return None

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
    api_key = env("RP_AGENT_KEY") or env("RP_API_KEY") or env("RUNPOD_API_KEY")
    image = env("IMAGE")
    if not api_key:
        print("FEHLER: RP_AGENT_KEY/RP_API_KEY/RUNPOD_API_KEY fehlt", file=sys.stderr)
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

    # IMAGE nur nötig, wenn mindestens eine Rolle unser eigenes Image nutzt –
    # der vLLM-Brain bringt sein eigenes mit.
    needs_own_image = any(not ((r == "brain" and brain_vllm_enabled()) or r in ("vision", "video")) for r in roles)
    if needs_own_image and not image:
        print("FEHLER: IMAGE fehlt (z. B. ghcr.io/<owner>/samplemonk-ai-runtime-runpod:<sha>)", file=sys.stderr)
        return 2

    print(f"[deploy] Rollen: {roles or ['(legacy)']}")
    results: Dict[str, str] = {}
    for role in roles:
        endpoint_id = deploy_role(role, image_for_role(role))
        if not endpoint_id:
            print(f"[deploy] ABBRUCH – Rolle {role or 'legacy'} fehlgeschlagen", file=sys.stderr)
            return 5
        results[role or "legacy"] = endpoint_id

    print("[deploy] Zusammenfassung:")
    for role, endpoint_id in results.items():
        env_name = {
            "brain": "RP_ENDPOINT_ID_BRAIN",
            "ears": "RP_ENDPOINT_ID_EARS",
            "voiceGen": "RP_ENDPOINT_ID_VOICE",
        }.get(role, "RP_ENDPOINT_ID")
        print(f"[deploy]   {env_name}={endpoint_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
