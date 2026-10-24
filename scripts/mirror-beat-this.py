#!/usr/bin/env python3
"""Spiegelt den beat_this-Checkpoint (kein HF-Repo) nach R2 - FLEET-P1-014.

Quelle, Groesse und SHA-256 stammen aus handlers_ears.BEAT_THIS_PIN. Der Hash wird
VOR dem Upload geprueft und der Upload per HEAD (content-length) gegengelesen.
"""
import hashlib
import os
import sys
import tempfile
import urllib.request

sys.path.insert(0, "scripts")
sys.path.insert(0, "services/audiomonastry-ai-runtime")

from handlers_ears import BEAT_THIS_PIN  # noqa: E402
from s3lite import S3Target  # noqa: E402

KEY = "weights/beat-this/final0.ckpt"
URL = BEAT_THIS_PIN["checkpointUrl"]
SIZE = BEAT_THIS_PIN["checkpointSize"]
SHA = BEAT_THIS_PIN["checkpointSha256"]


def env_from_file(path=".env.deploy"):
    env = {}
    for line in open(path, encoding="utf-8"):
        if "=" in line and not line.startswith("#"):
            k, v = line.strip().split("=", 1)
            env[k] = v.strip('"').strip("'")
    return env


def main():
    target = S3Target.from_r2_env(env_from_file())
    with tempfile.TemporaryDirectory() as tmp:
        fp = os.path.join(tmp, "final0.ckpt")
        print(f"lade {URL}", flush=True)
        req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=120) as resp, open(fp, "wb") as out:
            while True:
                block = resp.read(1 << 20)
                if not block:
                    break
                out.write(block)
        got = os.path.getsize(fp)
        if got != SIZE:
            raise SystemExit(f"Groesse stimmt nicht: {got} != {SIZE}")
        h = hashlib.sha256()
        with open(fp, "rb") as fh:
            for block in iter(lambda: fh.read(1 << 20), b""):
                h.update(block)
        if h.hexdigest() != SHA:
            raise SystemExit(f"SHA-256 stimmt nicht: {h.hexdigest()}")
        print("Hash ok", SHA, flush=True)
        target.put_file(KEY, fp)
        head = target.head(KEY) or {}
        cl = int(head.get("content-length") or 0)
        print(f"R2 {KEY} content-length={cl}", flush=True)
        if cl != SIZE:
            raise SystemExit(f"R2-Gegenprobe falsch: {cl} != {SIZE}")
    print("OK gespiegelt")


if __name__ == "__main__":
    main()
