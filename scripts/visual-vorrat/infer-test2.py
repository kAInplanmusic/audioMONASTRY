#!/usr/bin/env python3
"""Inferenz-Test v2 - korrekt aufgesetzt und mit Diagnose.

Was am ersten Versuch falsch war (und warum er nichts bewiesen hat):
  1. Die Prompts enthielten NICHT den Trigger (mstyle_<thema>). Ein darauf
     trainiertes LoRA wird damit gar nicht aktiviert.
  2. Es wurde nicht geprueft, OB die LoRA-Gewichte ueberhaupt geladen wurden.
     Die Trainingsdatei nutzt kohya-Schluessel (lora_unet_...); diffusers muss
     die erst auf sein eigenes Schema abbilden.

Dieser Lauf:
  * Prompt MIT Trigger UND ohne Trigger (Kontrast: wirkt das LoRA ueberhaupt?)
  * zaehlt die LoRA-Schichten nach dem Laden und gibt die Zahl aus
  * laedt das LoRA ausserdem explizit ueber die kohya-Konvertierung
"""
from __future__ import annotations

import argparse
import base64
import json
import subprocess

import r2

ENV = r2.load_env()

INNER = r'''
import json, os, urllib.request
import torch
from diffusers import StableDiffusionXLPipeline

PLAN = json.loads(os.environ["PLAN"])
dev = "cuda"
pipe = StableDiffusionXLPipeline.from_pretrained(
    "stabilityai/stable-diffusion-xl-base-1.0",
    torch_dtype=torch.bfloat16, variant="fp16", use_safetensors=True,
).to(dev)
pipe.set_progress_bar_config(disable=True)

def lora_layers():
    n = 0
    for _, m in pipe.unet.named_modules():
        if hasattr(m, "lora_A") or hasattr(m, "lora_linear_layer"):
            n += 1
    return n

def put(url, path):
    with open(path, "rb") as fh:
        req = urllib.request.Request(url, data=fh.read(), method="PUT")
        req.add_header("Content-Type", "image/png")
        with urllib.request.urlopen(req, timeout=600) as r:
            print("  upload", r.status, flush=True)

for job in PLAN["jobs"]:
    theme = job["theme"]
    lora = "/tmp/%s.safetensors" % theme
    urllib.request.urlretrieve(job["lora_url"], lora)
    try:
        pipe.unload_lora_weights()
    except Exception:
        pass
    print("=== %s: LoRA-Schichten VOR dem Laden: %d" % (theme, lora_layers()), flush=True)
    pipe.load_lora_weights(lora, adapter_name="probe")
    n_after = lora_layers()
    print("=== %s: LoRA-Schichten NACH dem Laden: %d" % (theme, n_after), flush=True)
    pipe.set_adapters(["probe"], adapter_weights=[0.9])
    print("=== %s: aktive Adapter: %s" % (theme, pipe.get_active_adapters()), flush=True)
    for k, prompt in enumerate(job["prompts"]):
        img = pipe(prompt=prompt, num_inference_steps=25, guidance_scale=6.0,
                   width=1024, height=1024,
                   generator=torch.Generator(device=dev).manual_seed(777)).images[0]
        out = "/tmp/%s_%d.png" % (theme, k)
        img.save(out)
        put(job["upload_urls"][k], out)
print("FERTIG", flush=True)
'''

JOBS = ["taenzer", "krieg_tod", "comic"]


def runpodctl(args: list[str], timeout: int = 300) -> tuple[int, str]:
    env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/home/patrick",
           "RUNPOD_API_KEY": ENV.get("RP_API_KEY", "")}
    r = subprocess.run(["runpodctl", *args], capture_output=True, text=True, env=env, timeout=timeout)
    return r.returncode, (r.stdout or r.stderr).strip()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--kill", default="")
    ap.add_argument("--themes", default=",".join(JOBS))
    ap.add_argument("--tag", default="v2")
    ap.add_argument("--gpu", default="NVIDIA RTX PRO 5000 Blackwell,NVIDIA RTX PRO 6000 Blackwell Workstation Edition,NVIDIA H100 PCIe")
    args = ap.parse_args()

    if args.kill:
        print(runpodctl(["pod", "remove", args.kill]))
        return 0

    creds = r2._creds()
    plan = {"jobs": []}
    for theme in [t.strip() for t in args.themes.split(",") if t.strip()]:
        # MIT Trigger und OHNE Trigger - der Kontrast zeigt, ob das LoRA wirkt
        prompts = [
            f"mstyle_{theme}, a dancer on a stage, dynamic pose, dramatic lighting, photograph",
            f"mstyle_{theme}, portrait of a person, detailed, studio light",
            f"a dancer on a stage, dynamic pose, dramatic lighting, photograph",
        ]
        plan["jobs"].append({
            "theme": theme,
            "lora_url": r2.presign("GET", f"lora-out/{theme}/{theme}.safetensors", **creds, expires=7200),
            "prompts": prompts,
            "upload_urls": [r2.presign("PUT", f"infer-{args.tag}/{theme}_{i}.png", **creds, expires=7200)
                            for i in range(len(prompts))],
        })

    script_b64 = base64.b64encode(INNER.encode()).decode()
    plan_b64 = base64.b64encode(json.dumps(plan).encode()).decode()
    cmdline = (f"echo {script_b64} | base64 -d > /tmp/infer.py && "
               f"echo {plan_b64} | base64 -d > /tmp/plan.json && "
               f"PLAN=$(cat /tmp/plan.json) python /tmp/infer.py")
    docker_args = f'bash -c "{cmdline}"'

    for gpu in [g.strip() for g in args.gpu.split(",") if g.strip()]:
        rc, out = runpodctl(["pod", "create", "--name", "lora-infer2",
                             "--image", "ostris/aitoolkit:latest", "--gpu-id", gpu, "--gpu-count", "1",
                             "--cloud-type", "COMMUNITY", "--min-cuda-version", "13.0",
                             "--container-disk-in-gb", "30", "--docker-args", docker_args])
        if rc == 0:
            try:
                pid = json.loads(out).get("id")
            except Exception:
                pid = None
            print(f"Inferenz-Pod v2 auf {gpu}: {pid}")
            print(f"Beenden: python3 infer-test2.py --kill {pid}")
            return 0
        print(f"  {gpu}: {out[:120]}")
    print("keine Karte verfuegbar")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
