#!/usr/bin/env python3
"""
audioMONASTRY · RunPod Serverless Endpoint Deployment (8-Rollen-Flotte)
=======================================================================
Erstellt/aktualisiert die Serverless-Endpoints der GPU-Flotte entsprechend
docs/runpod-8-instances-complete-plan.md:

    #  Rolle           Endpoint                        GPU-Pool    Idle   Disk
    1  brain           audiomonastry-ai-brain             AMPERE_48    15 s   50 GB
    2  ears            audiomonastry-ai-ears              AMPERE_48    15 s  100 GB
    3  voiceGen        audiomonastry-ai-voice             AMPERE_48   900 s  150 GB
    4  music           audiomonastry-ai-music             AMPERE_48   900 s  200 GB
    5  imageHq         audiomonastry-ai-image             AMPERE_48   900 s  200 GB
    6  videoReal       audiomonastry-ai-video-real        AMPERE_48   900 s  200 GB
    7  videoAbstract   audiomonastry-ai-video-abstract    AMPERE_48   900 s  200 GB
    8  orchestrator    audiomonastry-ai-orchestrator      AMPERE_48   900 s  100 GB

Alle acht Rollen laufen auf EINER A6000 48 GB (GPU-POOL `AMPERE_48`) und
skalieren auf 0 (`workers_min=0`, Scale-to-Zero). Ein Worker laeuft nach dem
letzten Job noch `idleTimeout` Sekunden weiter und wird in dieser Zeit WEITER
ABGERECHNET – "keine Idle-Kosten" gilt also erst nach diesem Fenster. Die API
setzt `idleTimeout` nur beim ANLEGEN; bei bestehenden Endpoints wird eine
Abweichung als Warnung gemeldet (Template-Update allein aendert den Wert nicht).

Bild-Herkunft je Rolle (Bildquellen)
------------------------------------
`AI_ROLE` waehlt im Worker die Modelle des Rollen-Manifests. Zwei Bildquellen:

  * `own`      – unser Image `services/audiomonastry-ai-runtime/Dockerfile.runpod`
                 (spricht das audioMONASTRY-`{task, model, input}`-Protokoll).
                 Rollen: ears, voiceGen, orchestrator (und optional music).
  * `vllm`     – der vorgefertigte RunPod-vLLM-Worker (OpenAI-kompatibel) fuer
                 brain.
  * `prebuilt` – vorgefertigte ComfyUI-/Hub-Worker fuer die visuellen Rollen
                 (imageHq / videoReal / videoAbstract) und standardmaessig music
                 (ACE-Step 1.5 XL). Diese Worker sprechen die ComfyUI-
                 Workflow-API, nicht unser Protokoll – der Orchestrator bindet
                 sie ueber MCP-Tools an. Empfehlung aus dem Runpod-Skill:
                 vorgefertigten Worker statt Eigenbau bevorzugen.

Jede Rolle ist per Env uebersteuerbar:
  RUNPOD_IMAGE_<ROLLE>   z. B. RUNPOD_IMAGE_MUSIC, RUNPOD_IMAGE_IMAGE_HQ
  RUNPOD_OWN_IMAGE=1     erzwingt unser Image fuer eine sonst prebuilt Rolle

Voraussetzungen:
  - RP_API_KEY (RunPod Personal Access Token)
  - IMAGE (GHCR-Image, z. B. ghcr.io/<owner>/audiomonastry-ai-runtime-runpod:<sha>)
    nur noetig, wenn mindestens eine Rolle ein `own`-Image nutzt.

Betriebsarten:
  RUNPOD_DEPLOY_ALL_ROLES=1        alle acht Rollen deployen (Default)
  RUNPOD_ROLE=music                nur eine Rolle deployen
  RUNPOD_ENDPOINT_NAME=...         Legacy: ein einzelner Endpoint ohne Rolle
                                   (AI_ROLE bleibt leer)

Optional:
  RUNPOD_NETWORK_VOLUME_ID, RUNPOD_WORKERS_MAX, RUNPOD_IDLE_TIMEOUT,
  RUNPOD_CONTAINER_DISK_GB, RUNPOD_TEMPLATE_ID, RUNPOD_GPU_ID,
  GHCR_USERNAME/GHCR_PASSWORD

Brain seit 2026-09-11: Die Rolle brain laeuft auf dem vorgefertigten RunPod-vLLM-Worker
(Qwen3-14B-AWQ) statt auf unserem Image. Gemessen ~2x (kurze Calls) / ~3,6x (lange Outputs)
gegenueber transformers. Steuerung:
  RUNPOD_BRAIN_VLLM=0                    zurueck auf unser eigenes Brain-Image
  RUNPOD_BRAIN_VLLM_IMAGE / _MODEL / _REVISION / _QUANTIZATION / _MAX_MODEL_LEN
Unser eigener Worker waehlt die Rolle zur Laufzeit ueber AI_ROLE und laedt daraus
nur die Modelle des Rollen-Manifests (model_manifest.json → "roles").
"""
from __future__ import annotations

import os
import sys
from typing import Any, Dict, List, Optional

import runpod

# ---------------------------------------------------------------------------
# Rollen (Spiegel von GPU_ROLE_IDS im TS-Spiegel src/config/aiInfrastructure.ts)
# ---------------------------------------------------------------------------
#: `idleTimeout` (Sekunden) = wie lange ein Worker nach dem letzten Job
#: weiterlaeuft. Er wird in dieser Zeit WEITER ABGERECHNET, ist also eine
#: Kosten-/Kaltstart-Abwaegung: kurz fuer Rollen, die der Session-Wake ohnehin
#: vorwaermt; lang fuer Rollen mit wiederholten Einzelaufrufen (MOS-Hoerproben,
#: Bild-/Video-Iteration), die sonst jeden Aufruf mit einem Kaltstart bezahlen.
#: `containerDiskGb` = Image + Gewichte/Downloads im Container-Dateisystem.
ROLE_DEFAULTS: Dict[str, Dict[str, Any]] = {
    "brain": {
        "suffix": "brain", "gpuPoolId": "AMPERE_48", "gpuCount": 1,
        "workersMax": 1, "idleTimeout": 15, "containerDiskGb": 50, "imageKind": "vllm",
    },
    "ears": {
        "suffix": "ears", "gpuPoolId": "AMPERE_48", "gpuCount": 1,
        "workersMax": 1, "idleTimeout": 15, "containerDiskGb": 100, "imageKind": "own",
    },
    "voiceGen": {
        "suffix": "voice", "gpuPoolId": "AMPERE_48", "gpuCount": 1,
        "workersMax": 1, "idleTimeout": 900, "containerDiskGb": 150, "imageKind": "own",
    },
    "music": {
        "suffix": "music", "gpuPoolId": "AMPERE_48", "gpuCount": 1,
        "workersMax": 1, "idleTimeout": 900, "containerDiskGb": 200, "imageKind": "prebuilt",
        "imageEnv": "RUNPOD_MUSIC_IMAGE", "imageDefault": "ACESTEP",
    },
    "imageHq": {
        "suffix": "image", "gpuPoolId": "AMPERE_48", "gpuCount": 1,
        "workersMax": 1, "idleTimeout": 900, "containerDiskGb": 200, "imageKind": "prebuilt",
        "imageEnv": "RUNPOD_IMAGE_HQ_IMAGE", "imageDefault": "COMFYUI",
    },
    "videoReal": {
        "suffix": "video-real", "gpuPoolId": "AMPERE_48", "gpuCount": 1,
        "workersMax": 1, "idleTimeout": 900, "containerDiskGb": 200, "imageKind": "prebuilt",
        "imageEnv": "RUNPOD_VIDEO_REAL_IMAGE", "imageDefault": "WAN22",
    },
    "videoAbstract": {
        "suffix": "video-abstract", "gpuPoolId": "AMPERE_48", "gpuCount": 1,
        "workersMax": 1, "idleTimeout": 900, "containerDiskGb": 200, "imageKind": "prebuilt",
        "imageEnv": "RUNPOD_VIDEO_ABSTRACT_IMAGE", "imageDefault": "COMFYUI",
    },
    "orchestrator": {
        "suffix": "orchestrator", "gpuPoolId": "AMPERE_48", "gpuCount": 1,
        "workersMax": 1, "idleTimeout": 900, "containerDiskGb": 100, "imageKind": "own",
    },
}

#: Alte Rollen-IDs aus der 5-Rollen-Vorarchitektur. Sie werden auf die neuen
#: Rollen abgebildet, damit bestehende Deploy-Skripte nicht hart brechen.
LEGACY_ROLE_ALIASES: Dict[str, str] = {"vision": "imageHq", "video": "videoReal"}

#: Container-Env-Schluessel → Endpoint-Env-Name fuer die Deploy-Zusammenfassung.
ENDPOINT_ENV_BY_ROLE: Dict[str, str] = {
    "brain": "RP_ENDPOINT_ID_BRAIN",
    "ears": "RP_ENDPOINT_ID_EARS",
    "voiceGen": "RP_ENDPOINT_ID_VOICE",
    "music": "RP_ENDPOINT_ID_MUSIC",
    "imageHq": "RP_ENDPOINT_ID_IMAGE",
    "videoReal": "RP_ENDPOINT_ID_VIDEO_REAL",
    "videoAbstract": "RP_ENDPOINT_ID_VIDEO_ABSTRACT",
    "orchestrator": "RP_ENDPOINT_ID_ORCHESTRATOR",
}

DOCKER_START_CMD = "python runpod_worker.py"

#: Brain laeuft seit 2026-09-11 auf dem vorgefertigten RunPod-vLLM-Worker
#: (v2.27.0 / vLLM 0.29.0). Der Brain ist ein reiner LLM-Endpoint; Audio-Modelle
#: bleiben auf ears/voiceGen. Gemessen: ~2x kurze Calls, ~3,6x lange Outputs.
BRAIN_VLLM_IMAGE_DEFAULT = "registry.runpod.net/runpod-workers-worker-vllm-main-dockerfile:76054c22c"
BRAIN_VLLM_MODEL_DEFAULT = "Qwen/Qwen3-14B-AWQ"
BRAIN_VLLM_REVISION_DEFAULT = "31c69efc29464b6bb0aee1398b5a7b50a99340c3"

#: Vorgefertigte Worker der visuellen Rollen + Musik (Registry-Images des RunPod
#: Hub). Sie bringen ihre Gewichte selbst mit bzw. laden sie beim ersten Boot.
PREBUILT_IMAGES: Dict[str, str] = {
    # Offizieller ComfyUI-Serverless-Worker (FLUX.1-dev fp8) – Basis fuer
    # imageHq (FLUX.2/Qwen-Image-Workflows) und videoAbstract (LTX-Workflows).
    "COMFYUI": "registry.runpod.net/runpod-workers-worker-comfyui-main-dockerfile:724802bf2",
    # Wan2.2 text/image-to-video Serverless-Worker (LoRA-faehig).
    "WAN22": "registry.runpod.net/averystormknight-hue-wan22-ti2v-runpod-main-dockerfile:81fc2044f",
    # ACE-Step 1.5 XL Musik-Generierung auf ComfyUI (Modelle werden beim ersten
    # Boot geladen, nichts ist ins Image eingebacken).
    "ACESTEP": "registry.runpod.net/ryoheitanaka-runpod-template-acestep15xl-main-dockerfile:16b9ccd80",
}

#: Rollen, die ohne Rollen-Env ein minimales Prebuilt-Env bekommen.
PREBUILT_ENV_KEYS = ("HF_TOKEN", "COMFYUI_START", "AI_ROLE")


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def brain_vllm_enabled() -> bool:
    """Default AN (Entscheidung 2026-09-11); `RUNPOD_BRAIN_VLLM=0` schaltet zurueck."""
    raw = env("RUNPOD_BRAIN_VLLM").lower()
    return raw not in ("0", "false", "no", "off")


def build_env_vars(role: str) -> Dict[str, str]:
    """Container-Env eines Rollen-Workers unseres eigenen Images."""
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


def build_env_vars_prebuilt(role: str) -> Dict[str, str]:
    """Minimales Env eines vorgefertigten Hub-Workers (ComfyUI/Wan/ACE-Step).

    Diese Worker kennen unser Rollen-Manifest nicht. Wir setzen nur, was sie
    verstehen: HF_TOKEN fuer gated Modelle und AI_ROLE zur Nachvollziehbarkeit
    in Logs. Rollenspezifische Optionen bleiben per RUNPOD_<ROLLE>_ENV_<KEY>
    setzbar (z. B. RUNPOD_MUSIC_ENV_COMFYUI_START=true).
    """
    env_vars: Dict[str, str] = {"AI_ROLE": role}
    if env("HF_TOKEN"):
        env_vars["HF_TOKEN"] = env("HF_TOKEN")
    prefix = f"RUNPOD_{_env_token(role)}_ENV_"
    for key, value in os.environ.items():
        if key.startswith(prefix) and value:
            env_vars[key[len(prefix):]] = value
    return env_vars


def _env_token(role: str) -> str:
    """`voiceGen`/`imageHq` → `VOICEGEN`/`IMAGEHQ` (Env-Token einer Rolle)."""
    out = []
    for ch in role:
        if ch.isupper() and out:
            out.append("_")
        out.append(ch.upper())
    return "".join(out)


def resolve_image(role: str, defaults: Dict[str, Any]) -> Dict[str, Any]:
    """Liefert image/docker_args/env_vars fuer eine Rolle.

    Rueckgabe enthaelt `image`, `docker_args`, `env_vars`, `template_name`,
    `registry_auth` (True, wenn unser privates GHCR-Image genutzt wird).
    """
    kind = defaults.get("imageKind", "own")
    # Rollen-Image per Env ueberschreiben; RUNPOD_OWN_IMAGE erzwingt unser Image.
    override = env(str(defaults.get("imageEnv", ""))) if defaults.get("imageEnv") else ""
    if env("RUNPOD_OWN_IMAGE").lower() in ("1", "true", "yes") and kind != "vllm":
        kind = "own"

    if role == "brain" and brain_vllm_enabled() and kind != "own":
        return {
            "image": env("RUNPOD_BRAIN_VLLM_IMAGE", BRAIN_VLLM_IMAGE_DEFAULT),
            "docker_args": "",  # Image bringt seinen eigenen Entrypoint mit
            "env_vars": build_env_vars_vllm(),
            "template_name": "audiomonastry-ai-brain-vllm-template",
            "registry_auth": False,
        }

    if kind == "prebuilt":
        image = override or PREBUILT_IMAGES.get(str(defaults.get("imageDefault", "")), "")
        if not image:
            raise SystemExit(f"FEHLER: kein Prebuilt-Image fuer Rolle {role} aufgeloest")
        return {
            "image": image,
            "docker_args": "",  # vorgefertigter Entrypoint
            "env_vars": build_env_vars_prebuilt(role),
            "template_name": f"audiomonastry-ai-{defaults['suffix']}-template",
            "registry_auth": False,
        }

    # `own`: unser Image (braucht IMAGE + optional GHCR-Auth).
    image = override or env("IMAGE")
    if not image:
        raise SystemExit(
            f"FEHLER: IMAGE fehlt fuer Rolle {role} "
            "(z. B. ghcr.io/<owner>/audiomonastry-ai-runtime-runpod:<sha>)"
        )
    return {
        "image": image,
        "docker_args": DOCKER_START_CMD,
        "env_vars": build_env_vars(role),
        "template_name": f"audiomonastry-ai-{defaults['suffix']}-template",
        "registry_auth": True,
    }


def ensure_registry_auth(endpoint_name: str) -> Optional[str]:
    """Registry-Credential fuer ein privates Image (z. B. GHCR).

    Reihenfolge: `RUNPOD_REGISTRY_AUTH_ID` (kein Anlegen) > vorhandenes
    GHCR-Credential via Env > neu anlegen. Ohne das Credential scheitert der
    Worker-Pull mit `unauthorized` und der Endpoint laeuft in einen Crash-Loop
    (live belegt 2026-09-15 beim Wechsel auf ein NEUES GHCR-Paket: neue Pakete
    sind privat, auch wenn das alte oeffentlich war).
    """
    explicit = env("RUNPOD_REGISTRY_AUTH_ID")
    if explicit:
        print(f"[deploy] nutze RUNPOD_REGISTRY_AUTH_ID={explicit}")
        return explicit
    ghcr_user = env("GHCR_USERNAME")
    ghcr_pass = env("GHCR_PASSWORD") or env("GHCR_PAT_ALL_ACCESS")
    if not (ghcr_user and ghcr_pass):
        print(
            "[deploy] WARNUNG: weder RUNPOD_REGISTRY_AUTH_ID noch GHCR_USERNAME/GHCR_PASSWORD gesetzt – "
            "ein privates Image laesst sich dann nicht ziehen.",
            file=sys.stderr,
        )
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
    registry_auth_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Idempotentes Template-Handling (kein 'Template name must be unique')."""
    from runpod.api.graphql import run_graphql_query

    env_items = ", ".join([f'{{ key: "{k}", value: "{v}" }}' for k, v in env_vars.items()])
    # Ohne containerRegistryAuthId zieht RunPod nur oeffentliche Images. Das Feld
    # muss im saveTemplate-Input stehen (nicht am Endpoint) – nur so erbt jeder
    # Worker des Endpoints die Credentials.
    registry_line = f'containerRegistryAuthId: "{registry_auth_id}"' if registry_auth_id else ""

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
              {registry_line}
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


def deploy_role(role: str, defaults: Dict[str, Any]) -> Optional[str]:
    """Erstellt/aktualisiert den Endpoint einer Rolle; liefert die Endpoint-ID."""
    resolved = resolve_image(role, defaults)
    endpoint_name = env("RUNPOD_ENDPOINT_NAME") or f"audiomonastry-ai-{defaults['suffix']}"
    gpu_id = env("RUNPOD_GPU_ID") or str(defaults.get("gpuPoolId", "AMPERE_48"))
    gpu_count = int(env("RUNPOD_GPU_COUNT") or defaults.get("gpuCount", 1))
    workers_min = int(env("RUNPOD_WORKERS_MIN", "0"))
    workers_max = int(env("RUNPOD_WORKERS_MAX") or defaults.get("workersMax", 1))
    # Reihenfolge: globaler Env-Override > Rollen-Default.
    idle_timeout = int(env("RUNPOD_IDLE_TIMEOUT") or defaults.get("idleTimeout", 900))
    container_disk_gb = int(env("RUNPOD_CONTAINER_DISK_GB") or defaults.get("containerDiskGb", 100))
    template_name = resolved["template_name"]

    registry_auth_id = ensure_registry_auth(endpoint_name) if resolved["registry_auth"] else None
    print(
        f"[deploy] {endpoint_name}: Rolle {role} | {resolved['image'].split('/')[-1]} "
        f"| idle {idle_timeout}s | disk {container_disk_gb} GB"
    )

    template = save_template(
        template_name,
        resolved["image"],
        resolved["env_vars"],
        container_disk_gb,
        resolved["docker_args"],
        registry_auth_id,
    )
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
        # `idleTimeout` setzt die API nur beim ANLEGEN; ein Template-Update laesst
        # den laufenden Wert unberuehrt. Genau so driftete die Flotte still
        # auseinander (live 15 s vs. Repo-Default), deshalb hier sichtbar machen.
        live_idle = existing.get("idleTimeout")
        if live_idle is not None and int(live_idle) != idle_timeout:
            print(
                f"[deploy] WARNUNG {endpoint_name}: idleTimeout live={int(live_idle)}s, "
                f"gewuenscht={idle_timeout}s. Die API setzt das nur beim Anlegen - "
                f"laufenden Endpoint per API/Console nachziehen (workers.idleTimeout).",
                file=sys.stderr,
            )
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


def resolve_roles() -> List[str]:
    """Bestimmt die zu deployenden Rollen aus RUNPOD_ROLE / RUNPOD_DEPLOY_ALL_ROLES."""
    single_role = env("RUNPOD_ROLE")
    if single_role in LEGACY_ROLE_ALIASES:
        mapped = LEGACY_ROLE_ALIASES[single_role]
        print(f"[deploy] WARNUNG: Rolle '{single_role}' ist veraltet → '{mapped}'")
        single_role = mapped
    if single_role and single_role not in ROLE_DEFAULTS:
        print(f"FEHLER: unbekannte RUNPOD_ROLE {single_role!r} (erwartet: {', '.join(ROLE_DEFAULTS)})", file=sys.stderr)
        raise SystemExit(2)

    # Legacy: expliziter Einzel-Endpoint ohne Rolle (AI_ROLE leer).
    if not single_role and not env("RUNPOD_DEPLOY_ALL_ROLES") and env("RUNPOD_ENDPOINT_NAME"):
        return [""]
    if single_role:
        return [single_role]
    return list(ROLE_DEFAULTS)


def main() -> int:
    api_key = env("RP_AGENT_KEY") or env("RP_API_KEY") or env("RUNPOD_API_KEY")
    if not api_key:
        print("FEHLER: RP_AGENT_KEY/RP_API_KEY/RUNPOD_API_KEY fehlt", file=sys.stderr)
        return 2

    runpod.api_key = api_key

    roles = resolve_roles()
    # IMAGE nur noetig, wenn mindestens eine Rolle unser eigenes Image nutzt –
    # der vLLM-Brain und die Prebuilt-Worker bringen ihr eigenes mit.
    needs_own_image = any(
        (ROLE_DEFAULTS.get(r, {}).get("imageKind") == "own") for r in roles if r
    )
    if needs_own_image and not env("IMAGE"):
        print("FEHLER: IMAGE fehlt (z. B. ghcr.io/<owner>/audiomonastry-ai-runtime-runpod:<sha>)", file=sys.stderr)
        return 2

    print(f"[deploy] Rollen: {roles or ['(legacy)']}")
    results: Dict[str, str] = {}
    for role in roles:
        defaults = ROLE_DEFAULTS.get(role, {"suffix": env("RUNPOD_ENDPOINT_NAME") or "ai", "imageKind": "own"})
        endpoint_id = deploy_role(role, defaults)
        if not endpoint_id:
            print(f"[deploy] ABBRUCH – Rolle {role or 'legacy'} fehlgeschlagen", file=sys.stderr)
            return 5
        results[role or "legacy"] = endpoint_id

    print("[deploy] Zusammenfassung:")
    for role, endpoint_id in results.items():
        env_name = ENDPOINT_ENV_BY_ROLE.get(role, "RP_ENDPOINT_ID")
        print(f"[deploy]   {env_name}={endpoint_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
