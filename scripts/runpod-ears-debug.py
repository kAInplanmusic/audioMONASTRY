#!/usr/bin/env python3
"""INFRA-RUNPOD-020 Diagnose: ears-Pod mit Debug-Entrypoint + Log-Upload nach R2.

Der normale ears-Pod crash-loopt (/ready nie erreichbar, RunPod-Pods haben kein
Log-API). Dieser Debug-Lauf:
  1. baut EXAKT dieselbe Pod-Env wie runpod-pods.py pod_body() (gleiche
     AI_WEIGHTS_URLS, gleiche GPU-Pools, gleiches Image),
  2. ersetzt den Entrypoint durch ein Skript, das nvidia-smi/torch/env
     diagnostiziert, pod_start.py MIT Log ausfuehrt, /ready abfragt und
     alles per Presigned-PUT (UNSIGNED-PAYLOAD, kein Secret im Pod) nach R2
     laedt,
  3. wartet kurz, laedt das Log herunter und TERMINIERT den Pod wieder
     (Kostenstopp, ~0.06 $ bei 6 min).

Aufruf:  set -a; . ./.env.deploy; set +a; python3 scripts/hetzner/../runpod-ears-debug.py
(Das Skript liegt in scripts/ und braucht AI_POD_TOKEN, RP_API_KEY, RP_POD_IMAGE,
RP_REGISTRY_AUTH_ID, die CFS3_*-Keys und --budget-Env wie cmd_up.)
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import time
import urllib.request
import urllib.error

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))

spec = importlib.util.spec_from_file_location("rp", os.path.join(os.path.dirname(os.path.abspath(__file__)), "runpod-pods.py"))
rp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rp)

import s3lite  # noqa: E402

TS = time.strftime("%Y%m%d-%H%M%S")
DEBUG_KEY = f"debug/ears2-{TS}-step1.log"
UPLOAD_KEYS = [DEBUG_KEY, f"debug/ears2-{TS}-step2.log", f"debug/ears2-{TS}-step3.log"]
BUDGET_WAIT_S = 360


def gql(query: str, token: str):
    req = urllib.request.Request(
        "https://api.runpod.io/graphql",
        data=json.dumps({"query": query}).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "User-Agent": "Mozilla/5.0"},
    )
    try:
        return json.load(urllib.request.urlopen(req, timeout=60))
    except urllib.error.HTTPError as exc:
        return {"_http_error": exc.read().decode()[:300], "status": exc.code}


def main() -> int:
    fleet = json.load(open("deploy/runpod/pod-fleet.json"))
    manifest = json.load(open("services/audiomonastry-ai-runtime/model_manifest.json"))
    models = {m["id"]: m for m in manifest.get("models", []) if isinstance(m, dict) and m.get("id")}
    pod = next((p for p in fleet.get("pods", []) if p.get("role") == "ears"), None)
    if pod is None:
        print("ears-Pod nicht im Fleet-Manifest")
        return 1

    image = rp.require(fleet["imageEnv"])
    token = rp.require("AI_POD_TOKEN", 32)
    if not rp.api_key():
        print("RP_API_KEY fehlt")
        return 1

    target = s3lite.S3Target.from_r2_env({k: v for k, v in os.environ.items() if k.startswith(("CFS3", "CFR2"))})
    prefix, ttl = fleet["weights"]["prefix"], int(fleet["weights"]["urlTtlSeconds"])
    entries, missing = rp.weight_entries(pod, models, target, prefix, ttl)
    if missing:
        print(f"Gewichte fehlen: {missing}")
        return 1
    print(f"entries={len(entries)} missing=[] (Basis identisch zum echten Pod)")

    upload_url = target.presign("PUT", DEBUG_KEY, 3600)

    body = rp.pod_body(fleet, pod, image, token, entries)
    body["name"] = f"{fleet['namePrefix']}ears-debug"
    # Diagnose-Entrypoint: env-Diagnose -> pod_start MIT Log -> /ready-Probe -> Upload.
    # Alles nach /workspace/pod_debug.log; der Upload geht per Presigned-PUT
    # (UNSIGNED-PAYLOAD), im Pod liegt NUR die URL, kein R2-Secret.
    diag = r'''
# RUN 4: EXAKT der echte Entrypoint (python pod_start.py, /workspace-Defaults,
# KEINE Env-Overrides) - Gegenbeweis fuer die /workspace-Hypothese.
set -x
python -u pod_start.py > /tmp/step2.log 2>&1 &
FETCH_PID=$!
(
  while true; do
    python - <<'PYU2' 2>/dev/null
import os, urllib.request
try:
    req = urllib.request.Request(os.environ["UPLOAD_URL2"], data=open("/tmp/step2.log","rb").read(), method="PUT")
    urllib.request.urlopen(req, timeout=30)
except Exception:
    pass
PYU2
    sleep 10
  done
) &
UP_PID=$!
wait $FETCH_PID
echo "POD_START_EXIT=$? $(date -u +%FT%TZ)" >> /tmp/step2.log
kill $UP_PID 2>/dev/null
sleep 2
python - <<'PYUF' 2>&1
import os, urllib.request
req = urllib.request.Request(os.environ["UPLOAD_URL2"], data=open("/tmp/step2.log","rb").read(), method="PUT")
print("final up", urllib.request.urlopen(req, timeout=30).status)
PYUF
echo "=== /ready Probe ==="
python - <<'PYR' 2>&1
import time, urllib.request, urllib.error
for i in range(3):
    try:
        r = urllib.request.urlopen("http://127.0.0.1:8000/ready", timeout=8)
        print("ready", r.status, r.read()[:200]); break
    except urllib.error.HTTPError as e:
        print("ready HTTP", e.code, e.read()[:200])
    except Exception as e:
        print("ready ERR", type(e).__name__, str(e)[:100])
    time.sleep(8)
PYR
echo done
'''
    body["dockerEntrypoint"] = ["bash", "-lc", diag]
    body["env"]["DEBUG_UPLOAD_URL"] = upload_url
    body["env"]["UPLOAD_URL1"] = target.presign("PUT", UPLOAD_KEYS[0], 3600)
    body["env"]["UPLOAD_URL2"] = target.presign("PUT", UPLOAD_KEYS[1], 3600)
    body["env"]["UPLOAD_URL3"] = target.presign("PUT", UPLOAD_KEYS[2], 3600)
    body["ports"] = [f"{fleet['port']}/http"]
    body["dockerEntrypoint"] = ["bash", "-lc", diag]
    body["env"]["DEBUG_UPLOAD_URL"] = upload_url
    body["env"]["UPLOAD_URL1"] = target.presign("PUT", UPLOAD_KEYS[0], 3600)
    body["env"]["UPLOAD_URL2"] = target.presign("PUT", UPLOAD_KEYS[1], 3600)
    body["env"]["UPLOAD_URL3"] = target.presign("PUT", UPLOAD_KEYS[2], 3600)
    body["ports"] = [f"{fleet['port']}/http"]
    body["dockerEntrypoint"] = ["bash", "-lc", diag]
    body["env"]["DEBUG_UPLOAD_URL"] = upload_url
    body["env"]["UPLOAD_URL1"] = target.presign("PUT", UPLOAD_KEYS[0], 3600)
    body["env"]["UPLOAD_URL2"] = target.presign("PUT", UPLOAD_KEYS[1], 3600)
    body["env"]["UPLOAD_URL3"] = target.presign("PUT", UPLOAD_KEYS[2], 3600)
    body["ports"] = [f"{fleet['port']}/http"]
    body["dockerEntrypoint"] = ["bash", "-lc", diag]
    body["env"]["DEBUG_UPLOAD_URL"] = upload_url
    # Debug-Pod braucht GPU-Init nicht zu ende zu bringen - kurzer Lauf reicht.
    body["ports"] = [f"{fleet['port']}/http"]

    status, data = rp.api("POST", "/pods", body)
    if status not in (200, 201) or not isinstance(data, dict) or not data.get("id"):
        print(f"Pod-Anlegen fehlgeschlagen (HTTP {status}) {str(data)[:300]}")
        return 1
    pod_id = data["id"]
    print(f"+ ears-debug angelegt {pod_id} ({data.get('costPerHr', '?')} $/h)")

    # Warten bis alle drei Step-Logs da sind (oder Budget aus).
    deadline = time.time() + BUDGET_WAIT_S
    while time.time() < deadline:
        done = sum(1 for k in UPLOAD_KEYS if target.get_bytes(k))
        if done == len(UPLOAD_KEYS):
            break
        time.sleep(15)

    for i, key in enumerate(UPLOAD_KEYS, 1):
        raw = target.get_bytes(key)
        if raw:
            print(f"======== STEP {i} ({key}) ========")
            print(raw.decode("utf-8", errors="replace")[:3000])
        else:
            print(f"======== STEP {i}: FEHLT ========")

    # Kostenstopp: Pod immer terminieren.
    st, ddown = rp.api("DELETE", f"/pods/{pod_id}")
    print(f"Pod terminiert: HTTP {st}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
