#!/usr/bin/env python3
"""
audioMONASTRY · RunPod Serverless Endpoint Deployment (8-Rollen-Flotte)
=======================================================================
Erstellt/aktualisiert die Serverless-Endpoints der GPU-Flotte entsprechend
docs/runpod-8-instances-complete-plan.md:

    #  Rolle           Endpoint                        GPU-Pool    Idle   Disk
    1  brain           audiomonastry-ai-brain             AMPERE_48    15 s   50 GB
    2  ears            audiomonastry-ai-ears              AMPERE_48    15 s  100 GB
    3  voiceGen        audiomonastry-ai-voice             AMPERE_48   120 s  150 GB
    4  music           audiomonastry-ai-music             AMPERE_48   120 s  200 GB
    5  imageHq         audiomonastry-ai-image             AMPERE_48   120 s  200 GB
    6  videoReal       audiomonastry-ai-video-real        ADA_24      120 s  200 GB
    7  videoAbstract   audiomonastry-ai-video-abstract    ADA_24      120 s  200 GB
    8  orchestrator    audiomonastry-ai-orchestrator      AMPERE_48   120 s  100 GB

Diese Tabelle, `ROLE_DEFAULTS` unten und `model_manifest.json`
(`roles.<rolle>.gpuPoolId` / `idleTimeoutSeconds`) sind EINE Wahrheit – der Test
`tests/test_runpod_deploy_defaults.py` faellt, sobald sie auseinanderlaufen.
Zusaetzlich gilt die harte Obergrenze der Flotte (`ENDPOINT_LIMIT`, Konstitution
§1: max. 8 GPU-Endpoints): der Deploy zaehlt die Endpoints im Konto und bricht
ab, bevor ein neuer die Grenze reisst.

Die Rollen laufen auf zwei GPU-Klassen: `AMPERE_48` (A6000/A40 48 GB) fuer
Sprache, Musik und Bild, `ADA_24` (RTX 4090 24 GB) fuer die Video-Rollen – deren
Worker-Images sind auf Ada/CUDA 12.8 ausgelegt. Alle Rollen skalieren auf 0
(`workers_min=0`, Scale-to-Zero). Ein Worker laeuft nach dem letzten Job noch
`idleTimeout` Sekunden weiter und wird in dieser Zeit WEITER ABGERECHNET –
"keine Idle-Kosten" gilt also erst nach diesem Fenster. Die API setzt
`idleTimeout` nur beim ANLEGEN; bei bestehenden Endpoints wird eine Abweichung als
Warnung gemeldet (Template-Update allein aendert den Wert nicht).

**Idle-Timeout = 120 s** (gemessen 2026-09-16): mit 900 s blieben Worker nach
kurzen Probes ueber die Zeitgrenze hinaus auf `RUNNING` und die Abrechnung lief
mit bis zu 3,66 $/h weiter (`runpodctl user` -> `currentSpendPerHr`). Kuerzere
Werte raeumten sie in ~2 Minuten ab. Fuer lange Ketten (MOS-Laeufe, Voice)
kann eine Rolle bewusst hoeher stehen – dann aber mit Blick auf `currentSpendPerHr`.

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

Per-Rolle-Image-Override (INFRA-RUNPOD-010, fuer Rollen-Images mit eingebackenen
Gewichten) – hat Vorrang vor dem globalen `IMAGE`:
  RP_IMAGE_<TOKEN>       kanonisch aus dem Endpoint-Namen: RP_IMAGE_VOICE
                         (voiceGen), RP_IMAGE_IMAGE (imageHq), RP_IMAGE_VIDEO_REAL,
                         RP_IMAGE_VIDEO_ABSTRACT, RP_IMAGE_BRAIN, RP_IMAGE_EARS,
                         RP_IMAGE_MUSIC, RP_IMAGE_ORCHESTRATOR; zusaetzlich
                         RP_IMAGE_VOICE_GEN/RP_IMAGE_VOICEGEN (Grossschreibung des
                         Rollennamens) und die Altnamen RP_IMAGE_VISION/RP_IMAGE_VIDEO
  RP_IMAGE_MAP           JSON-Objekt {rolle: image} fuer CI-Matrizen
Ein unbekannter Rollenname oder ein leerer/ungueltiger Wert ist ein HARTER Fehler
(Exit 2) – ein still ignorierter Override waere teurer als ein Abbruch.
Der Deploy nennt je Rolle Image, Image-Quelle und Vorrang in der Ausgabe.

Voraussetzungen:
  - RP_API_KEY (RunPod Personal Access Token)
  - IMAGE (GHCR-Image, z. B. ghcr.io/<owner>/audiomonastry-ai-runtime-runpod:<sha>)
    nur noetig, wenn mindestens eine Rolle ein `own`-Image nutzt und kein
    Rollen-Override fuer sie gesetzt ist.

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

import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

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
        # 120 s wie live (Audit 4.1): mit 900 s blieben Worker nach kurzen Probes
        # ueber die Zeitgrenze hinaus auf RUNNING und wurden weiter abgerechnet.
        "workersMax": 1, "idleTimeout": 120, "containerDiskGb": 150, "imageKind": "own",
    },
    "music": {
        "suffix": "music", "gpuPoolId": "AMPERE_48", "gpuCount": 1,
        "workersMax": 1, "idleTimeout": 120, "containerDiskGb": 200, "imageKind": "prebuilt",
        "imageEnv": "RUNPOD_MUSIC_IMAGE", "imageDefault": "ACESTEP",
    },
    "imageHq": {
        "suffix": "image", "gpuPoolId": "AMPERE_48", "gpuCount": 1,
        "workersMax": 1, "idleTimeout": 120, "containerDiskGb": 200, "imageKind": "prebuilt",
        "imageEnv": "RUNPOD_IMAGE_HQ_IMAGE", "imageDefault": "FLUX_DEV",
    },
    "videoReal": {
        # Video-Rollen auf Ada: die Wan-Images sind auf CUDA 12.8/Ada ausgelegt,
        # und die 4090 kostet 1,10 $/h Serverless (eine 5090 waere 1,58 $/h).
        "suffix": "video-real", "gpuPoolId": "ADA_24", "gpuCount": 1,
        "workersMax": 1, "idleTimeout": 120, "containerDiskGb": 200, "imageKind": "prebuilt",
        "imageEnv": "RUNPOD_VIDEO_REAL_IMAGE", "imageDefault": "WAN22",
    },
    "videoAbstract": {
        # Muss der Wan-Worker sein: das frueher hier eingetragene generische
        # COMFYUI-Image bringt KEINE Gewichte mit und laedt auch keine nach - der
        # Worker meldete auf Nachfrage leere Modell-Listen, jeder Job scheiterte.
        # Seit 2026-09-16 laeuft die Rolle auf demselben Image wie videoReal.
        "suffix": "video-abstract", "gpuPoolId": "ADA_24", "gpuCount": 1,
        "workersMax": 1, "idleTimeout": 120, "containerDiskGb": 200, "imageKind": "prebuilt",
        "imageEnv": "RUNPOD_VIDEO_ABSTRACT_IMAGE", "imageDefault": "WAN22",
    },
    "orchestrator": {
        "suffix": "orchestrator", "gpuPoolId": "AMPERE_48", "gpuCount": 1,
        "workersMax": 1, "idleTimeout": 120, "containerDiskGb": 100, "imageKind": "own",
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

#: Env-Name des per-Rolle-Image-Overrides (INFRA-RUNPOD-010). Er wird aus dem
#: Endpoint-Namen der Rolle abgeleitet, damit beide dieselbe Rollen-Kennung
#: tragen (`RP_ENDPOINT_ID_VOICE` → `RP_IMAGE_VOICE`). Beispiel:
#: `RP_IMAGE_VOICE=ghcr.io/kainplanmusic/audiomonastry-ai-runtime-runpod:baked-voicegen-latest`.
IMAGE_ENV_BY_ROLE: Dict[str, str] = {
    role: name.replace("RP_ENDPOINT_ID_", "RP_IMAGE_") for role, name in ENDPOINT_ENV_BY_ROLE.items()
}

#: JSON-Form derselben Zuordnung: `RP_IMAGE_MAP={"voiceGen":"ghcr.io/…:baked-voicegen-latest"}`.
#: Gedacht fuer Stellen, die keine dynamischen Env-Namen setzen koennen (CI-Matrix).
IMAGE_MAP_ENV = "RP_IMAGE_MAP"

#: Praefix jedes Rollen-Image-Overrides.
IMAGE_ENV_PREFIX = "RP_IMAGE_"


DOCKER_START_CMD = "python runpod_worker.py"

#: Harte Obergrenze der Flotte in Endpoints (Konstitution §1: max. 8 Rollen).
#: SSR: derselbe Wert steht als `AI_MAX_GPU_ENDPOINTS` in
#: src/config/aiInfrastructure.ts; `tests/aiInfrastructure.test.ts` vergleicht
#: beide Seiten, damit sie nicht auseinanderlaufen.
ENDPOINT_LIMIT_DEFAULT = 8


def endpoint_limit() -> int:
    """Aktive Endpoint-Obergrenze (env `AI_MAX_GPU_ENDPOINTS`, Default 8)."""
    raw = env("AI_MAX_GPU_ENDPOINTS") or str(ENDPOINT_LIMIT_DEFAULT)
    try:
        value = int(raw)
    except ValueError:
        print(f"[deploy] WARNUNG: AI_MAX_GPU_ENDPOINTS={raw!r} ist keine Zahl → {ENDPOINT_LIMIT_DEFAULT}", file=sys.stderr)
        return ENDPOINT_LIMIT_DEFAULT
    return value if value > 0 else ENDPOINT_LIMIT_DEFAULT


def plan_endpoint_budget(
    existing_names: List[str],
    planned_names: List[str],
    limit: Optional[int] = None,
) -> "tuple[bool, List[str], str]":
    """Prueft VOR dem Anlegen, ob die Flotte die Endpoint-Obergrenze reisst.

    Das Konto ist die Wahrheit, nicht die Rollenliste: ein 9. Endpoint kann
    entstehen, wenn ein Run eine Rolle anlegt, die es noch nicht gibt, oder wenn
    verwaiste Endpoints (alte Namen, andere Projekte) dazukommen.

    Rueckgabe: ``(ok, neue_namen, meldung)``.
    """
    cap = endpoint_limit() if limit is None else limit
    existing = [n for n in existing_names if n]
    planned = [n for n in planned_names if n]
    new_names = [n for n in planned if n not in set(existing)]
    total = len(set(existing) | set(planned))
    if len(existing) > cap:
        return False, new_names, (
            f"Konto fuehrt {len(existing)} Endpoints, die Flotte erlaubt hoechstens {cap} "
            f"(Konstitution §1) – erst aufraeumen, dann deployen"
        )
    if total > cap:
        return False, new_names, (
            f"Deploy wuerde {total} Endpoints ergeben ({len(existing)} vorhanden, "
            f"{len(new_names)} neu) – Grenze {cap} (Konstitution §1)"
        )
    return True, new_names, f"{len(existing)} vorhanden, {len(new_names)} neu, gesamt {total} von {cap}"


def orphan_endpoint_names(existing_names: List[str], planned_names: List[str]) -> List[str]:
    """Fremd-/Altendpoints der Flotte (Namenspraefix, aber keine Rolle dieses Deploys).

    Sie kosten nichts im Idle (workersMin=0), zaehlen aber gegen die
    Endpoint-Obergrenze – und genau daran scheiterte die Diagnose „wo kommen die
    neun Endpoints her" (Audit Live-1).
    """
    prefix = "audiomonastry-ai-"
    planned = set(planned_names)
    return sorted(n for n in existing_names if n and n.startswith(prefix) and n not in planned)

#: Brain laeuft seit 2026-09-11 auf dem vorgefertigten RunPod-vLLM-Worker
#: (v2.27.0 / vLLM 0.29.0). Der Brain ist ein reiner LLM-Endpoint; Audio-Modelle
#: bleiben auf ears/voiceGen. Gemessen: ~2x kurze Calls, ~3,6x lange Outputs.
BRAIN_VLLM_IMAGE_DEFAULT = "registry.runpod.net/runpod-workers-worker-vllm-main-dockerfile:76054c22c"
BRAIN_VLLM_MODEL_DEFAULT = "Qwen/Qwen3-14B-AWQ"
BRAIN_VLLM_REVISION_DEFAULT = "31c69efc29464b6bb0aee1398b5a7b50a99340c3"

#: Vorgefertigte Worker der visuellen Rollen + Musik (Registry-Images des RunPod
#: Hub). Sie bringen ihre Gewichte selbst mit bzw. laden sie beim ersten Boot.
PREBUILT_IMAGES: Dict[str, str] = {
    # PrunaAI FLUX-Worker – das live laufende imageHq-Image. Braucht HF_TOKEN,
    # weil black-forest-labs/FLUX.1-dev auf HF `gated: auto` ist.
    "FLUX_DEV": "registry.runpod.net/prunaai-runpod-worker-flux-1-dev-main-dockerfile:287a29201",
    # Wan2.2 ksampler (wlsdml1114) – laeuft bei videoReal UND videoAbstract und
    # laedt seine Gewichte beim ersten Boot (Wan-AI/Wan2.2-*, nicht gated, daher
    # ohne HF_TOKEN). Live verifiziert 2026-09-16: H.264 480x720, 5,03 s.
    "WAN22": "registry.runpod.net/wlsdml1114-generate-video-ksampler-dockerfile:a9247705c",
    # ACE-Step 1.5 XL Musik-Generierung auf ComfyUI (Modelle werden beim ersten
    # Boot geladen, nichts ist ins Image eingebacken).
    "ACESTEP": "registry.runpod.net/ryoheitanaka-runpod-template-acestep15xl-main-dockerfile:16b9ccd80",
    # ACHTUNG: generischer ComfyUI-Worker OHNE Gewichte – er laedt auch keine
    # nach (live geprueft: der Worker meldet leere Modell-Listen). Nur mit
    # angeschlossenem Netzwerk-Volume sinnvoll; fuer die Bild-/Videorollen sind
    # FLUX_DEV bzw. WAN22 die richtige Wahl.
    "COMFYUI": "registry.runpod.net/runpod-workers-worker-comfyui-main-dockerfile:724802bf2",
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
        "AI_MODEL_MANIFEST": "/opt/audiomonastry-ai/model_manifest.json",
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
    if role == "orchestrator":
        env_vars.update(_orchestrator_tool_env())
    return env_vars


#: Fach-Instanzen, die der Orchestrator per MCP-Bruecke aufruft.
ORCHESTRATOR_TOOL_ENDPOINTS = (
    "RP_ENDPOINT_ID_EARS",
    "RP_ENDPOINT_ID_VOICE",
    "RP_ENDPOINT_ID_MUSIC",
    "RP_ENDPOINT_ID_IMAGE",
    "RP_ENDPOINT_ID_VIDEO_REAL",
    "RP_ENDPOINT_ID_VIDEO_ABSTRACT",
)

#: MoA-Rollen → Modell-Override (siehe services/audiomonastry-ai-runtime/moa_orchestrator.py).
ORCHESTRATOR_MODEL_ENVS = (
    "MOA_CLASSIFIER_MODEL",
    "MOA_PLANNER_A_MODEL",
    "MOA_PLANNER_B_MODEL",
    "MOA_AGGREGATOR_MODEL",
)


def _orchestrator_tool_env() -> Dict[str, str]:
    """Endpoint-IDs der Fach-Instanzen + MoA-Modell-Overrides durchreichen.

    Ohne diese IDs kann der Orchestrator die MCP-Tools nicht adressieren; die
    Werte kommen aus der Deploy-Umgebung (dieselben Variablen, die die App nutzt)
    und sind optional – fehlt eine, meldet `call_tool` sie beim Ausfuehren.
    Der API-Key ist PFLICHT fuer die MCP-Bruecke: der Orchestrator ruft die
    anderen Endpoints selbst auf.
    """
    env_vars: Dict[str, str] = {}
    for name in (*ORCHESTRATOR_TOOL_ENDPOINTS, *ORCHESTRATOR_MODEL_ENVS):
        value = env(name)
        if value:
            env_vars[name] = value
    api_key = env("RP_AGENT_KEY") or env("RP_API_KEY")
    if api_key:
        env_vars["RP_AGENT_KEY"] = api_key
    else:
        print(
            "[deploy] WARNUNG: RP_AGENT_KEY/RP_API_KEY fehlt – die MCP-Bruecke des Orchestrators "
            "kann die Fach-Instanzen nicht aufrufen (Plan ja, Ausfuehrung nein).",
            file=sys.stderr,
        )
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


# ---------------------------------------------------------------------------
# Per-Rolle-Image-Override (INFRA-RUNPOD-010)
# ---------------------------------------------------------------------------
def image_override_env_names(role: str) -> List[str]:
    """Akzeptierte Env-Namen des Image-Overrides einer Rolle, kanonisch zuerst.

    Reihenfolge und Vorrang:
      1. `IMAGE_ENV_BY_ROLE` – `RP_IMAGE_VOICE`, `RP_IMAGE_VIDEO_REAL` (dieselbe
         Rollen-Kennung wie `RP_ENDPOINT_ID_*`).
      2. mechanisch aus dem Rollennamen – `RP_IMAGE_VOICE_GEN`, `RP_IMAGE_IMAGE_HQ`.
      3. Grossschreibung ohne Trenner – `RP_IMAGE_VOICEGEN`, `RP_IMAGE_IMAGEHQ`.
      4. Altnamen der 5-Rollen-Architektur – `RP_IMAGE_VISION`, `RP_IMAGE_VIDEO`.

    Mehrere Schreibweisen sind Absicht: ein Tippfehler im Namen soll nicht als
    still wirkungsloser Override durchgehen (siehe `image_overrides`).
    """
    names: List[str] = []
    for candidate in (
        IMAGE_ENV_BY_ROLE.get(role, ""),
        IMAGE_ENV_PREFIX + _env_token(role),
        IMAGE_ENV_PREFIX + role.upper(),
    ):
        if candidate and candidate not in names:
            names.append(candidate)
    for legacy, mapped in LEGACY_ROLE_ALIASES.items():
        if mapped == role:
            candidate = IMAGE_ENV_PREFIX + _env_token(legacy)
            if candidate not in names:
                names.append(candidate)
    return names


def image_override_tokens() -> Dict[str, str]:
    """`RP_IMAGE_<TOKEN>` → Rolle (kanonische Zuordnung gewinnt bei Kollision)."""
    tokens: Dict[str, str] = {}
    for role in ROLE_DEFAULTS:
        for name in image_override_env_names(role):
            tokens.setdefault(name[len(IMAGE_ENV_PREFIX):], role)
    return tokens


def validate_image_reference(value: str, source: str) -> str:
    """Image-Referenz eines Overrides pruefen – laut scheitern statt still ignorieren.

    Ein Override, der aussieht wie gesetzt, aber kein ziehbares Image ist, waere
    der teuerste Fall: der Deploy wuerde die Rolle wieder auf ein Image ohne
    Gewichte stellen und der Fehler faellt erst als Kaltstart-Timeout auf.
    """
    text = (value or "").strip()
    if not text:
        raise SystemExit(
            f"FEHLER: {source} ist gesetzt, aber leer. Entweder einen vollen Image-Verweis "
            f"setzen (z. B. ghcr.io/<owner>/audiomonastry-ai-runtime-runpod:baked-voicegen-latest) "
            f"oder die Variable ganz entfernen."
        )
    if any(ch.isspace() for ch in text):
        raise SystemExit(f"FEHLER: {source}={text!r} enthaelt Leerzeichen – das ist kein Image-Verweis.")
    if "=" in text or "$" in text:
        raise SystemExit(
            f"FEHLER: {source}={text!r} sieht nach einer nicht aufgeloesten Variable/Env-Zuweisung aus. "
            f"Erwartet wird ein vollstaendiger Image-Verweis (registry/repo:tag)."
        )
    if "/" not in text:
        raise SystemExit(
            f"FEHLER: {source}={text!r} ist kein Image-Verweis – erwartet wird z. B. "
            f"ghcr.io/<owner>/audiomonastry-ai-runtime-runpod:<tag>."
        )
    # Registry-/Repository-Teil muss kleingeschrieben sein (Docker-Regel); der Tag darf
    # Grossbuchstaben tragen, deshalb wird nur der Teil VOR dem Tag geprueft.
    tail = text.rsplit("/", 1)[-1]
    repository = text[: text.rfind(":")] if ":" in tail else text
    if repository != repository.lower():
        raise SystemExit(
            f"FEHLER: {source}={text!r}: der Repository-Teil enthaelt Grossbuchstaben. "
            f"Registry-Namen sind kleingeschrieben (GHCR lehnt den Pull sonst mit "
            f"'invalid reference format' ab)."
        )
    return text


def image_overrides() -> Dict[str, Dict[str, str]]:
    """Rollen → Override-Image aus `RP_IMAGE_<TOKEN>` und `RP_IMAGE_MAP` (JSON).

    Rueckgabe: ``{role: {"image": <ref>, "source": <env-name>}}``. Ein unbekannter
    Rollenname im Override ist ein HARTER Fehler (SystemExit), kein Ignorieren:
    ein stillschweigend verworfener Override stellt die Rolle wieder auf das
    Image ohne Gewichte und kostet einen Kaltstart-Timeout je Job.
    """
    tokens = image_override_tokens()
    overrides: Dict[str, Dict[str, str]] = {}

    def take(role: str, source: str, value: str, first: bool) -> None:
        previous = overrides.get(role)
        if previous is not None:
            if previous["image"] == value:
                return
            winner = source if first else previous["source"]
            loser = previous["source"] if first else source
            print(
                f"[deploy] WARNUNG: Rolle {role} hat mehrere Image-Overrides mit verschiedenen "
                f"Werten – {winner} gewinnt gegen {loser} "
                f"(die kanonische Variable schlaegt den mechanischen Namen).",
                file=sys.stderr,
            )
            if first:
                overrides[role] = {"image": value, "source": source}
            return
        overrides[role] = {"image": value, "source": source}

    for name in os.environ:
        if not name.startswith(IMAGE_ENV_PREFIX) or name == IMAGE_MAP_ENV:
            continue
        token = name[len(IMAGE_ENV_PREFIX):]
        role = tokens.get(token)
        if role is None:
            raise SystemExit(
                f"FEHLER: {name} ist kein bekannter Rollen-Image-Override – die Rolle {token!r} "
                f"gibt es nicht. Erwartete Namen: "
                + ", ".join(sorted(IMAGE_ENV_PREFIX + t for t in tokens))
            )
        value = validate_image_reference(os.environ.get(name, ""), name)
        take(role, name, value, first=(name == image_override_env_names(role)[0]))

    raw_map = env(IMAGE_MAP_ENV)
    if raw_map:
        try:
            parsed = json.loads(raw_map)
        except json.JSONDecodeError as exc:
            raise SystemExit(
                f"FEHLER: {IMAGE_MAP_ENV} ist kein gueltiges JSON ({exc.msg} an Position {exc.pos}). "
                f'Beispiel: {IMAGE_MAP_ENV}=\'{{"voiceGen":"ghcr.io/<owner>/audiomonastry-ai-runtime-runpod:baked-voicegen-latest"}}\''
            ) from exc
        if not isinstance(parsed, dict):
            raise SystemExit(f"FEHLER: {IMAGE_MAP_ENV} muss ein JSON-Objekt (Rolle → Image) sein.")
        for key, value in parsed.items():
            role = str(key)
            if role in LEGACY_ROLE_ALIASES:
                print(f"[deploy] WARNUNG: Rolle '{role}' im {IMAGE_MAP_ENV} ist veraltet → '{LEGACY_ROLE_ALIASES[role]}'")
                role = LEGACY_ROLE_ALIASES[role]
            if role not in ROLE_DEFAULTS:
                raise SystemExit(
                    f"FEHLER: {IMAGE_MAP_ENV} nennt die unbekannte Rolle {key!r} – "
                    f"erwartet: {', '.join(ROLE_DEFAULTS)}"
                )
            if not isinstance(value, str):
                raise SystemExit(f"FEHLER: {IMAGE_MAP_ENV}[{key!r}] muss ein String sein (Image-Verweis).")
            take(role, f"{IMAGE_MAP_ENV}[{key}]", validate_image_reference(value, f"{IMAGE_MAP_ENV}[{key}]"), first=False)

    return overrides


def template_name_override(role: str) -> str:
    """Optionaler Template-Name je Rolle: `RUNPOD_TEMPLATE_NAME_<TOKEN>`.

    Warum es das gibt (live belegt 2026-09-20, Rolle music): der Endpoint hing an
    einem Template, das `myself.podTemplates` NICHT listet und das die Plattform
    nicht mehr aufloeste - neue Worker konnten deshalb nicht starten, Jobs lagen
    fest. `saveTemplate` ohne `id` scheitert dabei am Unique-Fehler, weil der alte
    Name unsichtbar weiter existiert. Ein NEUER Name ist damit der einzige API-Weg
    zurueck zu einem funktionierenden Endpoint.

    Beispiel: RUNPOD_TEMPLATE_NAME_MUSIC=audiomonastry-ai-music-template-v2
    """
    for name in (f"RUNPOD_TEMPLATE_NAME_{_env_token(role)}", f"RUNPOD_TEMPLATE_NAME_{role.upper()}"):
        value = env(name)
        if value:
            return value
    return ""


def role_template_name(role: str, defaults: Dict[str, Any]) -> str:
    """Template-Name der Rolle: Override schlaegt den Standardnamen."""
    return template_name_override(role) or f"audiomonastry-ai-{defaults['suffix']}-template"


def resolve_image(role: str, defaults: Dict[str, Any], overrides: Optional[Dict[str, Dict[str, str]]] = None) -> Dict[str, Any]:
    """Liefert image/docker_args/env_vars fuer eine Rolle.

    Rueckgabe enthaelt `image`, `docker_args`, `env_vars`, `template_name`,
    `image_origin` (woher das Image kommt – sichtbar in der Ausgabe) und
    `registry_auth` (True, wenn das Image ein privates GHCR-Image sein kann).

    Vorrang: per-Rolle-Override (`RP_IMAGE_<TOKEN>` / `RP_IMAGE_MAP`) > Rollen-Env
    (`RUNPOD_<ROLLE>_IMAGE`) > globales `IMAGE` / vLLM- bzw. Prebuilt-Default.
    """
    overrides = image_overrides() if overrides is None else overrides
    kind = defaults.get("imageKind", "own")
    # Rollen-Image per Env ueberschreiben; RUNPOD_OWN_IMAGE erzwingt unser Image.
    override = env(str(defaults.get("imageEnv", ""))) if defaults.get("imageEnv") else ""
    if env("RUNPOD_OWN_IMAGE").lower() in ("1", "true", "yes") and kind != "vllm":
        kind = "own"

    role_override = overrides.get(role)
    if role_override is not None:
        image = role_override["image"]
        source = f"Override {role_override['source']} (Vorrang vor IMAGE und Rollen-Default)"
        # Das Image entscheidet ueber den Startbefehl: ein Image unseres Runtimes
        # braucht `python runpod_worker.py` und das Rollen-Env, ein vorgefertigter
        # Hub-Worker bringt beides selbst mit.
        own_runtime = "audiomonastry-ai-runtime" in image
        if not own_runtime and kind == "own":
            print(
                f"[deploy] HINWEIS {role}: {role_override['source']} zeigt auf ein image OHNE unser Runtime-Kuerzel "
                f"({image.split('/')[-1]}) – der Worker startet ohne Rollen-Env. Fuer ein Rollen-Image des eigenen "
                f"Runtimes bitte den vollstaendigen ghcr.io/<owner>/audiomonastry-ai-runtime-runpod:<tag>-Verweis setzen.",
                file=sys.stderr,
            )
        return {
            "image": image,
            "docker_args": DOCKER_START_CMD if own_runtime else "",
            "env_vars": build_env_vars(role) if own_runtime else build_env_vars_prebuilt(role),
            "template_name": role_template_name(role, defaults),
            "image_origin": source,
            "registry_auth": own_runtime or image.startswith("ghcr.io/"),
        }

    if role == "brain" and brain_vllm_enabled() and kind != "own":
        return {
            "image": env("RUNPOD_BRAIN_VLLM_IMAGE", BRAIN_VLLM_IMAGE_DEFAULT),
            "docker_args": "",  # Image bringt seinen eigenen Entrypoint mit
            "env_vars": build_env_vars_vllm(),
            "template_name": template_name_override(role) or "audiomonastry-ai-brain-vllm-template",
            "image_origin": "Rollen-Default brain=vLLM (RUNPOD_BRAIN_VLLM_IMAGE / BRAIN_VLLM_IMAGE_DEFAULT)",
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
            "template_name": role_template_name(role, defaults),
            "image_origin": (
                f"Override {defaults['imageEnv']} (Rollenvariable)" if override else f"Prebuilt-Default {defaults.get('imageDefault', '')}"
            ),
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
        "template_name": role_template_name(role, defaults),
        "image_origin": (
            f"Override {defaults['imageEnv']} (Rollenvariable)" if override else "globales IMAGE (Rollout-Stand)"
        ),
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


class BoundTemplateError(RuntimeError):
    """Der Endpoint haengt an einem GEBUNDENEN Template (INFRA-RUNPOD-009).

    Die GraphQL-Mutation `updateEndpointTemplate` verweigert solche Endpoints -
    live belegt an `audiomonastry-ai-music`, `audiomonastry-ai-video-real` und
    `audiomonastry-ai-video-abstract` ("This endpoint has a bound template.").
    Der REST-Weg kann es aber: `PATCH /v1/endpoints/<id>` mit `templateId`
    setzt den Wert wirklich (live belegt 2026-09-20). Erst wenn AUCH das
    scheitert oder die Ruecklesung abweicht, gilt die Rolle als nicht
    aktualisierbar - dann ist es ein Betreiber-Schritt (Konsole).
    """


#: REST-Basis der RunPod-API. ACHTUNG: dieser Endpunkt validiert NICHTS -
#: ein offensichtlich falscher `templateId` wurde live wortwoertlich uebernommen
#: (2026-09-20, Rolle music, Wert "zz"). Deshalb wird nach jedem Schreibzugriff
#: nachgelesen und verglichen; ungepruefte Werte gehen hier nie raus.
REST_ENDPOINT_URL = "https://rest.runpod.io/v1/endpoints/{endpoint}"
REST_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/153.0.0.0 Safari/537.36"
)


def rest_transport(
    method: str, url: str, payload: Optional[Dict[str, Any]] = None, token: str = ""
) -> Tuple[int, Any]:
    """Ein GET/PATCH gegen die RunPod-REST-API.

    Modulattribut mit Absicht: Tests ersetzen es durch einen Stub, der die
    Aufrufe protokolliert - so ist die Reihenfolge ohne Netz belegbar. Der
    Browser-User-Agent ist Pflicht: ohne ihn antwortet Cloudflare mit HTTP 403
    (live belegt 2026-09-20).
    """
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(url, data=body, method=method)
    request.add_header("Authorization", f"Bearer {token}")
    request.add_header("Content-Type", "application/json")
    request.add_header("Accept", "application/json")
    request.add_header("User-Agent", REST_USER_AGENT)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read().decode("utf-8", "replace")
            return response.status, (json.loads(raw) if raw.strip().startswith(("{", "[")) else raw)
    except urllib.error.HTTPError as err:
        raw = err.read().decode("utf-8", "replace")
        try:
            parsed: Any = json.loads(raw)
        except json.JSONDecodeError:
            parsed = raw
        return err.code, parsed
    except Exception as exc:  # noqa: BLE001
        return 0, f"{type(exc).__name__}: {exc}"


def rest_set_endpoint_template(
    endpoint_id: str, template_id: str, token: Optional[str] = None
) -> Tuple[bool, str]:
    """Template eines GEBUNDENEN Endpoints per REST setzen und nachlesen.

    Rueckgabe: (ok, Meldung). `ok=False` heisst: nicht gesetzt ODER die
    Ruecklesung weicht ab - beides darf nicht als Erfolg durchgehen.
    """
    if not template_id:
        return False, "keine Template-ID uebergeben"
    key = token or env("RP_API_KEY")
    if not key:
        return False, "RP_API_KEY fehlt (REST-Zugang noetig)"
    url = REST_ENDPOINT_URL.format(endpoint=endpoint_id)
    code, res = rest_transport("PATCH", url, {"templateId": template_id}, key)
    if code != 200:
        return False, f"REST-PATCH fehlgeschlagen (HTTP {code}): {str(res)[:120]}"
    code2, cfg = rest_transport("GET", url, None, key)
    if code2 != 200 or not isinstance(cfg, dict):
        return False, f"Ruecklesung nicht lesbar (HTTP {code2})"
    now = str(cfg.get("templateId") or "")
    if now != template_id:
        return False, f"Ruecklesung weicht ab: templateId={now}, erwartet {template_id}"
    return True, f"Template per REST gesetzt und nachgelesen (templateId={now})"


def save_template(
    template_name: str,
    image: str,
    env_vars: Dict[str, str],
    container_disk_gb: int,
    docker_args: str = DOCKER_START_CMD,
    registry_auth_id: Optional[str] = None,
    fallback_template_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Idempotentes Template-Handling (kein 'Template name must be unique').

    INFRA-RUNPOD-009: `myself.podTemplates` listet NICHT zwangslaeufig alle
    Templates des Kontos - live belegt: der Endpoint `audiomonastry-ai-music`
    haengt an Template `9q9c60p6xh`, das in der Liste fehlt. Die Vorfassung wollte
    es dann NEU ANLEGEN und der Lauf brach mit 'Template name must be unique' ab,
    nachdem die Rollen davor schon aktualisiert waren (halber Rollout). Deshalb:
    (1) `fallback_template_id` - die Template-ID des BESTEHENDEN Endpoints wird
    aktualisiert, statt neu anzulegen; (2) faengt der Create-Zweig den
    Unique-Fehler ab und liefert eine klare Anweisung statt eines Tracebacks.
    """
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

    if not existing_template_id and fallback_template_id:
        existing_template_id = fallback_template_id
        print(
            f"[deploy] Template '{template_name}' wird von myself.podTemplates nicht "
            f"gelistet - es wird die Template-ID des bestehenden Endpoints aktualisiert "
            f"(id={fallback_template_id})."
        )

    if existing_template_id:
        print(f"[deploy] Template '{template_name}' aktualisieren (id={existing_template_id}) …")
        result = run_graphql_query(payload(existing_template_id))
    else:
        print(f"[deploy] Template '{template_name}' anlegen …")
        try:
            result = run_graphql_query(payload(None))
        except Exception as exc:  # noqa: BLE001
            if "unique" not in str(exc).lower():
                raise
            print(
                f"[deploy] FEHLER: Der Name '{template_name}' ist vergeben, das Template "
                f"wird aber von myself.podTemplates nicht gelistet (z. B. Rolle aus einer "
                f"anderen Ansicht/Team). Diese Rolle wird uebersprungen - Abhilfe: "
                f"RUNPOD_TEMPLATE_ID=<id der bestehenden Vorlage> setzen oder am "
                f"bestehenden Endpoint die Vorlage belassen.",
                file=sys.stderr,
            )
            return {}
    return result.get("data", {}).get("saveTemplate", {})


def deploy_role(role: str, defaults: Dict[str, Any]) -> Optional[str]:
    """Erstellt/aktualisiert den Endpoint einer Rolle; liefert die Endpoint-ID."""
    resolved = resolve_image(role, defaults)
    endpoint_name = env("RUNPOD_ENDPOINT_NAME") or f"audiomonastry-ai-{defaults['suffix']}"
    role_pool = str(defaults.get("gpuPoolId", "AMPERE_48"))
    gpu_id = env("RUNPOD_GPU_ID") or role_pool
    # INFRA-RUNPOD-002: Ein globaler Override kann die Rollen-Wahrheit kippen –
    # die CI setzte AMPERE_48 fuer ALLE Rollen, auch fuer die Video-Rollen, deren
    # Worker-Images auf Ada/CUDA 12.8 ausgelegt sind. Der Override gilt weiter
    # (Ops braucht ihn), aber laut und mit dem Rollen-Default daneben.
    if gpu_id != role_pool:
        print(
            f"[deploy] WARNUNG {endpoint_name}: GPU-Pool {gpu_id} weicht vom Rollen-Default "
            f"{role_pool} ab (RUNPOD_GPU_ID-Override). Manifest und Deploy-Default erwarten {role_pool}.",
            file=sys.stderr,
        )
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
    # INFRA-RUNPOD-010: WELCHES Image eine Rolle faehrt und WARUM - ohne diese Zeile
    # ist ein Rollen-Override nur in der Umgebung sichtbar, nicht im Lauf.
    print(f"[deploy] {endpoint_name}: Image-Quelle: {resolved.get('image_origin', 'unbekannt')}")
    print(f"[deploy] {endpoint_name}: Image: {resolved['image']}")

    # INFRA-RUNPOD-009: Der bestehende Endpoint wird VOR dem Template-Handling
    # gelesen - seine Template-ID ist der Rettungsanker, wenn die Konto-Liste das
    # Rollen-Template nicht zeigt (sonst entsteht der Unique-Fehler und der Lauf
    # bricht nach bereits aktualisierten Rollen ab).
    endpoints = runpod.get_endpoints() or []
    existing = next((e for e in endpoints if e.get("name") == endpoint_name), None)

    template = save_template(
        template_name,
        resolved["image"],
        resolved["env_vars"],
        container_disk_gb,
        resolved["docker_args"],
        registry_auth_id,
        fallback_template_id=(existing or {}).get("templateId") or None,
    )
    template_id = template.get("id", "")
    if not template_id:
        print(
            f"[deploy] FEHLER: Template-Handling lieferte keine ID für {endpoint_name} "
            f"(Details oben; die Rolle bleibt unveraendert)",
            file=sys.stderr,
        )
        return None
    print(f"[deploy] {endpoint_name}: Template-ID {template_id}")

    if existing:
        endpoint_id = existing.get("id", "")
        print(f"[deploy] {endpoint_name}: existiert ({endpoint_id}) → Template-Update")
        try:
            runpod.update_endpoint_template(endpoint_id, template_id)
        except Exception as exc:  # noqa: BLE001
            if "bound template" in str(exc).lower():
                # INFRA-RUNPOD-009: Die GraphQL-Mutation verweigert gebundene
                # Endpoints. Der REST-Weg setzt den templateId aber wirklich
                # (live belegt 2026-09-20) - deshalb erst dort versuchen und die
                # Ruecklesung abwarten, statt die Rolle aufzugeben.
                ok, message = rest_set_endpoint_template(endpoint_id, template_id)
                if not ok:
                    raise BoundTemplateError(f"{endpoint_name} ({message})") from exc
                print(f"[deploy] {endpoint_name}: {message}")
            else:
                raise
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


def planned_endpoint_names(roles: List[str]) -> List[str]:
    """Endpoint-Namen, die dieser Deploy anfasst (dieselbe Regel wie `deploy_role`)."""
    names: List[str] = []
    for role in roles:
        suffix = ROLE_DEFAULTS[role]["suffix"] if role in ROLE_DEFAULTS else "ai"
        names.append(env("RUNPOD_ENDPOINT_NAME") or f"audiomonastry-ai-{suffix}")
    return names


def main() -> int:
    api_key = env("RP_AGENT_KEY") or env("RP_API_KEY") or env("RUNPOD_API_KEY")
    if not api_key:
        print("FEHLER: RP_AGENT_KEY/RP_API_KEY/RUNPOD_API_KEY fehlt", file=sys.stderr)
        return 2

    runpod.api_key = api_key

    roles = resolve_roles()
    # INFRA-RUNPOD-010: Die Rollen-Image-Overrides werden VOR dem ersten API-Aufruf
    # aufgeloest - ein vertippter Rollenname soll den Lauf beenden, nicht eine Rolle
    # still auf ein fremdes Image stellen.
    try:
        overrides = image_overrides()
    except SystemExit as exc:
        print(str(exc), file=sys.stderr)
        return 2
    if overrides:
        for role, entry in sorted(overrides.items()):
            print(f"[deploy] Rollen-Image-Override: {role} → {entry['image']} (aus {entry['source']})")
        unused = [r for r in overrides if r not in roles]
        if unused:
            print(
                f"[deploy] HINWEIS: Override(s) gesetzt, aber die Rolle(n) {', '.join(sorted(unused))} "
                f"werden in diesem Lauf nicht deployt (Rollen: {', '.join(r or 'legacy' for r in roles)}) - "
                f"der Override bleibt fuer diese Rollen ungenutzt.",
                file=sys.stderr,
            )
    # IMAGE nur noetig, wenn mindestens eine Rolle unser eigenes Image nutzt –
    # der vLLM-Brain und die Prebuilt-Worker bringen ihr eigenes mit. Ein
    # Rollen-Override deckt seinen Bedarf selbst.
    needs_own_image = any(
        (ROLE_DEFAULTS.get(r, {}).get("imageKind") == "own" and r not in overrides) for r in roles if r
    )
    if needs_own_image and not env("IMAGE"):
        print("FEHLER: IMAGE fehlt (z. B. ghcr.io/<owner>/audiomonastry-ai-runtime-runpod:<sha>)", file=sys.stderr)
        return 2

    print(f"[deploy] Rollen: {roles or ['(legacy)']}")

    # INFRA-RUNPOD-001: harte Obergrenze VOR dem Anlegen prüfen. Nicht die
    # Rollenliste ist die Wahrheit, sondern das Konto - genau daran hing die
    # Diagnose „wo kommen die neun Endpoints her" (Audit Live-1).
    try:
        live_names = [str(e.get("name", "")) for e in (runpod.get_endpoints() or [])]
    except Exception as exc:  # noqa: BLE001
        print(
            f"[deploy] WARNUNG: Endpoint-Liste nicht abrufbar ({type(exc).__name__}) – Budget-Preflight übersprungen",
            file=sys.stderr,
        )
        live_names = []
    planned = planned_endpoint_names(roles)
    budget_ok, _new_names, budget_message = plan_endpoint_budget(live_names, planned)
    print(f"[deploy] Endpoint-Budget: {budget_message}")
    if not budget_ok:
        print(f"[deploy] ABBRUCH – {budget_message}", file=sys.stderr)
        return 3
    orphans = orphan_endpoint_names(live_names, planned)
    if orphans:
        print(
            f"[deploy] HINWEIS: {len(orphans)} Flotten-Endpoint(s) ohne Rolle in diesem Deploy: {', '.join(orphans)}",
            file=sys.stderr,
        )

    results: Dict[str, str] = {}
    failed: List[str] = []
    skipped: List[str] = []
    for role in roles:
        defaults = ROLE_DEFAULTS.get(role, {"suffix": env("RUNPOD_ENDPOINT_NAME") or "ai", "imageKind": "own"})
        try:
            endpoint_id = deploy_role(role, defaults)
        except BoundTemplateError as exc:
            # Kein Deploy-Fehler, sondern ein Betreiber-Schritt - deshalb zaehlt
            # das NICHT als fehlgeschlagene Rolle (sonst waere CI dauerhaft rot
            # und der echte Fehler unsichtbar).
            print(
                f"[deploy] UEBERSPRUNGEN (gebunden): {exc} haengt an einem gebundenen "
                f"Template - die API erlaubt kein Template-Update. Abhilfe: Endpoint in "
                f"der Konsole entbinden oder mit RUNPOD_ENDPOINT_NAME=<neuer Name> neu "
                f"anlegen (wie beim Vision-Endpoint 2026-09-13) und die Endpoint-ID in "
                f"der .env nachziehen.",
                file=sys.stderr,
            )
            skipped.append(role or "legacy")
            continue
        except Exception as exc:  # noqa: BLE001
            print(
                f"[deploy] FEHLER – Rolle {role or 'legacy'}: {type(exc).__name__}: {str(exc)[:200]} "
                f"(weiter mit der naechsten)",
                file=sys.stderr,
            )
            failed.append(role or "legacy")
            continue
        if not endpoint_id:
            # INFRA-RUNPOD-009: nicht mehr die ganze Flotte abbrechen. Live hat ein
            # einziger Rollenfehler (music) den Lauf beendet, nachdem voiceGen und
            # ears schon auf das neue Image gezogen waren - ein halber Rollout ohne
            # Zusammenfassung. Jetzt laufen alle Rollen durch, das Ergebnis steht
            # vollstaendig da und der Exit-Code bleibt trotzdem 5.
            print(f"[deploy] FEHLER – Rolle {role or 'legacy'} fehlgeschlagen (weiter mit der naechsten)", file=sys.stderr)
            failed.append(role or "legacy")
            continue
        results[role or "legacy"] = endpoint_id

    print("[deploy] Zusammenfassung:")
    for role, endpoint_id in results.items():
        env_name = ENDPOINT_ENV_BY_ROLE.get(role, "RP_ENDPOINT_ID")
        print(f"[deploy]   {env_name}={endpoint_id}")
    if skipped:
        print(
            f"[deploy] UEBERSPRUNGEN (gebundenes Template, Betreiber-Schritt): {', '.join(skipped)}",
            file=sys.stderr,
        )
    if failed:
        print(f"[deploy] NICHT deployt (Fehler): {', '.join(failed)}", file=sys.stderr)
        return 5
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
