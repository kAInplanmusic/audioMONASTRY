#!/usr/bin/env python3
"""Brain-Endpoint auf das vorgefertigte RunPod-vLLM-Image umstellen.

Warum: `runpod/worker-vllm` ist vorgefertigt (kein eigener 30-GB-Build), kann das
Modell quantisiert laden (`QUANTIZATION=awq` -> Qwen3-14B-AWQ = 9,99 GB statt
29,54 GB fp16) und ist **OpenAI-kompatibel** unter
`https://api.runpod.ai/v2/<ENDPOINT_ID>/openai/v1` – genau der Pfad, fuer den der
Provider `runpod-local` in src/core/ai/LlmRouter.ts gebaut ist.

Aufruf: python3 scripts/runpod-brain-vllm.py [--dry-run]
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / ".env"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"

MODEL_NAME = "Qwen/Qwen3-14B-AWQ"
TEMPLATE_NAME = "samplemonk-ai-brain-vllm-template"
BRAIN_ENDPOINT = "ppxo7wrn599p0q"
CONTAINER_DISK_GB = 60
DRY = "--dry-run" in sys.argv


def env(name: str, default: str = "") -> str:
    for line in ENV.read_text(encoding="utf-8").splitlines():
        if line.strip().startswith(f"{name}="):
            return line.strip().split("=", 1)[1].strip()
    return default


KEY = env("RP_API_KEY")
HF = env("HF_TOKEN")
assert KEY, "RP_API_KEY fehlt in .env"


def api(url, body=None, method="GET", timeout=60, auth=None):
    data = json.dumps(body).encode() if body is not None else None
    h = {"User-Agent": UA, "Accept": "application/json"}
    # Ohne Authorization liefert die REST-API bei Schreibzugriffen 401.
    # `auth=False` unterdrueckt den Header gezielt (fremde Registries, z. B. Docker Hub).
    if auth is not False:
        h["Authorization"] = f"Bearer {auth or KEY}"
    if data:
        h["Content-Type"] = "application/json"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=h, method=method), timeout=timeout) as r:
            return r.status, json.loads(r.read().decode() or "null")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]
    except Exception as e:  # noqa: BLE001
        return -1, str(e)[:200]


# 1) Verfuegbaren Image-Tag ermitteln (RunPod-Regel: keine ungepinnten Tags in Produktion)
st, tags = api("https://hub.docker.com/v2/repositories/runpod/worker-vllm/tags?page_size=100", auth=False)
tag_names = [t["name"] for t in (tags.get("results") or [])] if isinstance(tags, dict) else []
print(f"[brain] Docker-Hub-Tags ({len(tag_names)}): {tag_names}")
# Bevorzugt ein gepinnter Tag mit CUDA >= 12.4 und expliziter vLLM-Version.
def score(t: str) -> tuple:
    cuda = 0.0
    if "cuda12.6" in t or "cuda12.5" in t:
        cuda = 3.0
    elif "cuda12.4" in t:
        cuda = 2.0
    elif "cuda12.1" in t:
        cuda = 1.0
    pinned = 1.0 if t[0].isdigit() else 0.0  # z. B. "0.8.5-cuda12.4.0"
    return (cuda, pinned)

candidates = [t for t in tag_names if t != "latest" and "preview" not in t and not t.startswith("dev")]
if not candidates:
    candidates = [t for t in tag_names if t != "latest"]
candidates.sort(key=score, reverse=True)
IMAGE = f"runpod/worker-vllm:{candidates[0]}" if candidates else "runpod/worker-vllm:latest"
print(f"[brain] gewaehlt (Score {score(candidates[0]) if candidates else '-'}): {IMAGE}")

env_vars = {
    "MODEL_NAME": MODEL_NAME,
    "QUANTIZATION": "awq",
    "MAX_MODEL_LEN": "16384",
    "GPU_MEMORY_UTILIZATION": "0.90",
    "TENSOR_PARALLEL_SIZE": "1",
    "OPENAI_SERVED_MODEL_NAME_OVERRIDE": "qwen3-14b-awq",
}
if HF:
    env_vars["HF_TOKEN"] = HF

if DRY:
    print(json.dumps({"image": IMAGE, "env": {k: ("***" if k == "HF_TOKEN" else v) for k, v in env_vars.items()}}, indent=2))
    sys.exit(0)

# 2) Template anlegen/aktualisieren (idempotent ueber den Namen)
import runpod  # noqa: E402
from runpod.api.graphql import run_graphql_query  # noqa: E402

runpod.api_key = KEY  # Pflicht: sonst AuthenticationError bei jeder GraphQL-Query

env_items = ", ".join([f'{{ key: "{k}", value: "{v}" }}' for k, v in env_vars.items()])
list_query = "query { myself { podTemplates { id name imageName } } }"
existing_id = ""
try:
    res = run_graphql_query(list_query)
    for tpl in (res.get("data", {}).get("myself", {}) or {}).get("podTemplates", []) or []:
        if tpl.get("name") == TEMPLATE_NAME:
            existing_id = tpl.get("id", "")
            break
except Exception as exc:  # noqa: BLE001
    print(f"[brain] WARNUNG Template-Lookup: {type(exc).__name__}")

payload_id = f'id: "{existing_id}"' if existing_id else ""
mutation = f"""
mutation {{
  saveTemplate(input: {{
    {payload_id}
    name: "{TEMPLATE_NAME}"
    imageName: "{IMAGE}"
    dockerArgs: ""
    containerDiskInGb: {CONTAINER_DISK_GB}
    volumeInGb: 0
    ports: ""
    env: [{env_items}]
    isServerless: true
    startSsh: false
    isPublic: false
    readme: ""
  }}) {{ id name imageName isServerless }}
}}
"""
print(f"[brain] Template '{TEMPLATE_NAME}' {'aktualisieren' if existing_id else 'anlegen'} …")
try:
    res = run_graphql_query(mutation)
    template = res.get("data", {}).get("saveTemplate", {})
except Exception as exc:  # noqa: BLE001
    print(f"[brain] FEHLER Template: {type(exc).__name__}: {exc}")
    sys.exit(2)
template_id = template.get("id", "")
if not template_id:
    print(f"[brain] FEHLER: keine Template-ID – Antwort: {json.dumps(res)[:300]}")
    sys.exit(3)
print(f"[brain] Template-ID {template_id}")

# 3) Brain-Endpoint auf dieses Template zeigen lassen
st, res = api(
    f"https://rest.runpod.io/v1/endpoints/{BRAIN_ENDPOINT}",
    {"templateId": template_id},  # containerDiskInGb gehoert ins Template, nicht in den Endpoint-PATCH
    method="PATCH",
)
print(f"[brain] Endpoint-PATCH http={st} {'' if st in (200, 201) else str(res)[:250]}")

st, ep = api(f"https://rest.runpod.io/v1/endpoints/{BRAIN_ENDPOINT}")
if isinstance(ep, dict):
    print(f"[brain] jetzt: template={ep.get('templateId')} gpu={ep.get('gpuTypeIds')} workers={ep.get('workersMin')}..{ep.get('workersMax')} idle={ep.get('idleTimeout')}")
print(f"[brain] OpenAI-Basis-URL: https://api.runpod.ai/v2/{BRAIN_ENDPOINT}/openai/v1")
Path("/tmp/brain_vllm.json").write_text(json.dumps({"endpoint": BRAIN_ENDPOINT, "template": template_id, "image": IMAGE, "model": MODEL_NAME, "openaiBase": f"https://api.runpod.ai/v2/{BRAIN_ENDPOINT}/openai/v1"}, indent=2), encoding="utf-8")
