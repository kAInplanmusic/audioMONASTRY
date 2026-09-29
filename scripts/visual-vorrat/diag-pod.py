#!/usr/bin/env python3
"""Diagnose-Pod: klaert, warum torch.cuda im Trainer-Image nicht verfuegbar war.

Kosten: wenige Minuten auf der billigsten verfuegbaren Community-Karte (~0,03 USD).
Der Pod wird NICHT selbst beendet, damit die Logs lesbar bleiben - nach dem
Auslesen MUSS er terminiert werden (scripts/diag-pod.py --kill <id>).
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys

from r2 import load_env

ENV = load_env()
API_KEY = ENV.get("RP_API_KEY", "")

DIAG = (
    "echo '### nvidia-smi'; nvidia-smi 2>&1 | head -15; "
    "echo '### treiber'; cat /proc/driver/nvidia/version 2>&1 | head -2; "
    "echo '### cuda-libs'; ls /usr/local/ | head -10; "
    "echo '### image-inhalt /app'; ls /app 2>&1 | head; ls /app/ai-toolkit 2>&1 | head -8; "
    "echo '### python'; python -V 2>&1; which -a python python3; "
    "echo '### torch'; python -c \"import torch;print('torch',torch.__version__,'cuda',torch.version.cuda,'avail',torch.cuda.is_available(),'count',torch.cuda.device_count())\" 2>&1 | tail -3; "
    "echo '### torch-fehler-detail'; python -c \"import torch;print(torch.cuda.get_device_name(0))\" 2>&1 | tail -4; "
    "echo '### nvcc'; nvcc --version 2>&1 | tail -2; "
    "echo '### env'; env | grep -iE 'nvidia|cuda|visible' | head -10; "
    "echo '### fertig'"
)


def runpodctl(args: list[str], timeout: int = 300) -> tuple[int, str]:
    env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/home/patrick", "RUNPOD_API_KEY": API_KEY}
    r = subprocess.run(["runpodctl", *args], capture_output=True, text=True, env=env, timeout=timeout)
    return r.returncode, (r.stdout or r.stderr).strip()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--kill", default="")
    ap.add_argument("--gpu", default="NVIDIA GeForce RTX 4090,NVIDIA RTX A6000,NVIDIA L40S,NVIDIA RTX PRO 5000 Blackwell")
    ap.add_argument("--min-cuda", default="13.0")
    args = ap.parse_args()

    if args.kill:
        rc, out = runpodctl(["pod", "remove", args.kill])
        print(f"remove {args.kill}: rc={rc} {out[:200]}")
        return 0

    for gpu in [g.strip() for g in args.gpu.split(",") if g.strip()]:
        cmd = [
            "pod", "create",
            "--name", "lora-diag",
            "--image", "ostris/aitoolkit:latest",
            "--gpu-id", gpu,
            "--gpu-count", "1",
            "--cloud-type", "COMMUNITY",
            "--min-cuda-version", args.min_cuda,
            "--container-disk-in-gb", "20",
            "--docker-args", f'bash -c "{DIAG}"',
        ]
        rc, out = runpodctl(cmd)
        if rc == 0:
            print(f"angelegt auf {gpu}")
            print(out[:900])
            return 0
        print(f"  {gpu}: {out[:140]}")
    print("keine Karte verfuegbar")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
