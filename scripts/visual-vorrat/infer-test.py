#!/usr/bin/env python3
"""Inferenz-Test: erzeugt Bilder mit den fertigen LoRAs unter freien Prompts.

Zweck: trennt zwei Erklaerungen fuer die flaechigen Probe-Bilder.
  (a) Das LoRA ist ueberangepasst -> dann bleibt es auch mit freiem Prompt flach.
  (b) Nur der Probe-Prompt des Trainers war ungeeignet -> dann kommen hier
      normale Bilder heraus, und es muss NICHTS neu trainiert werden.

Der Test laeuft auf einem eigenen Pod und kostet nur wenige Minuten.
Ergebnisse landen unter r2://<bucket>/infer-test/.
"""
from __future__ import annotations

import argparse
import base64
import json
import subprocess
import sys

import r2

ENV = r2.load_env()

INNER = r'''
import json, os, urllib.request, pathlib
import torch
from diffusers import StableDiffusionXLPipeline

PLAN = json.loads(os.environ["PLAN"])
dev = "cuda"
pipe = StableDiffusionXLPipeline.from_pretrained(
    "stabilityai/stable-diffusion-xl-base-1.0",
    torch_dtype=torch.bfloat16, variant="fp16", use_safetensors=True,
).to(dev)
pipe.set_progress_bar_config(disable=True)

def put(url, path):
    with open(path, "rb") as fh:
        req = urllib.request.Request(url, data=fh.read(), method="PUT")
        req.add_header("Content-Type", "image/png")
        with urllib.request.urlopen(req, timeout=600) as r:
            print("  upload", r.status, path, flush=True)

for job in PLAN["jobs"]:
    theme = job["theme"]
    lora = "/tmp/%s.safetensors" % theme
    urllib.request.urlretrieve(job["lora_url"], lora)
    pipe.load_lora_weights(lora, adapter_name=theme)
    pipe.set_adapters([theme], adapter_weights=[0.9])
    print("=== %s geladen" % theme, flush=True)
    for k, prompt in enumerate(job["prompts"]):
        img = pipe(prompt=prompt, num_inference_steps=25, guidance_scale=job["cfg"],
                   width=1024, height=1024, generator=torch.Generator(device=dev).manual_seed(1234 + k)).images[0]
        out = "/tmp/%s_%d.png" % (theme, k)
        img.save(out)
        put(job["upload_urls"][k], out)
    pipe.unload_lora_weights()
print("FERTIG", flush=True)
'''

PROMPTS = [
    "a dancer on a stage, dynamic pose, dramatic lighting, photograph",
    "portrait of a person, detailed, studio light, 4k",
]

JOBS = ["taenzer", "geheimbund_moenche", "krieg_tod", "comic"]


def runpodctl(args: list[str], timeout: int = 300) -> tuple[int, str]:
    env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/home/patrick",
           "RUNPOD_API_KEY": ENV.get("RP_API_KEY", "")}
    r = subprocess.run(["runpodctl", *args], capture_output=True, text=True, env=env, timeout=timeout)
    return r.returncode, (r.stdout or r.stderr).strip()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--kill", default="")
    ap.add_argument("--themes", default=",".join(JOBS))
    ap.add_argument("--gpu", default="NVIDIA RTX PRO 5000 Blackwell,NVIDIA RTX PRO 6000 Blackwell Workstation Edition,NVIDIA H100 PCIe")
    args = ap.parse_args()

    if args.kill:
        print(runpodctl(["pod", "remove", args.kill]))
        return 0

    creds = r2._creds()
    plan = {"jobs": []}
    for theme in [t.strip() for t in args.themes.split(",") if t.strip()]:
        plan["jobs"].append({
            "theme": theme,
            "lora_url": r2.presign("GET", f"lora-out/{theme}/{theme}.safetensors", **creds, expires=7200),
            "prompts": PROMPTS,
            "cfg": 6.0,
            "upload_urls": [r2.presign("PUT", f"infer-test/{theme}_{i}.png", **creds, expires=7200)
                            for i in range(len(PROMPTS))],
        })

    plan_b64 = base64.b64encode(json.dumps(plan).encode()).decode()
    script_b64 = base64.b64encode(INNER.encode()).decode()
    cmdline = (
        "echo " + script_b64 + " | base64 -d > /tmp/infer.py && "
        "echo " + plan_b64 + " | base64 -d > /tmp/plan.json && "
        "PLAN=$(cat /tmp/plan.json) python /tmp/infer.py"
    )
    docker_args = f'bash -c "{cmdline}"'

    for gpu in [g.strip() for g in args.gpu.split(",") if g.strip()]:
        rc, out = runpodctl(["pod", "create", "--name", "lora-infer",
                             "--image", "ostris/aitoolkit:latest", "--gpu-id", gpu, "--gpu-count", "1",
                             "--cloud-type", "COMMUNITY", "--min-cuda-version", "13.0",
                             "--container-disk-in-gb", "30", "--docker-args", docker_args])
        if rc == 0:
            try:
                pid = json.loads(out).get("id")
            except Exception:
                pid = None
            print(f"Inferenz-Pod angelegt auf {gpu}: {pid}")
            print("Nach dem Auslesen beenden:  python3 infer-test.py --kill " + str(pid))
            return 0
        print(f"  {gpu}: {out[:120]}")
    print("keine Karte verfuegbar")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
