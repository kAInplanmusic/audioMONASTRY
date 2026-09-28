#!/usr/bin/env python3
"""Schnuert das Pod-Bundle, signiert alle Ziel-URLs und laedt beides nach R2.

Ergebnis:
  r2://<bucket>/lora-themen/<lauf>/bundle.tar.gz   Themen + Konfigs + Skripte
  r2://<bucket>/lora-themen/<lauf>/presign.json    Schluessel -> PUT-URL (nur Pod-intern)
  build-urls.json                                  presigned GET/PUT fuer den Start (lokal)

Es werden KEINE Zugangsdaten ins Bundle geschrieben.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tarfile
import time
import urllib.request
from pathlib import Path

import r2

BASE = Path(__file__).parent
BUNDLE = BASE / "bundle"
THEMES_SRC = BASE / "out-v3"
CONFIGS_SRC = BUNDLE / "configs"

POD_NAMES = ["lora-p1", "lora-p2", "lora-p3", "lora-p4", "lora-p5", "lora-p6"]


def upload(key: str, path: Path, creds: dict[str, str], expires: int) -> int:
    url = r2.presign("PUT", key, **creds, expires=expires)
    data = path.read_bytes()
    req = urllib.request.Request(url, data=data, method="PUT")
    req.add_header("Content-Type", "application/octet-stream")
    with urllib.request.urlopen(req, timeout=1800) as r:
        print(f"  PUT {key}: HTTP {r.status} ({len(data)} Bytes)")
        return r.status


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default="lora-themen-v1")
    ap.add_argument("--expires", type=int, default=172800, help="Gueltigkeit der URLs in Sekunden (Default 48 h)")
    ap.add_argument("--skip-themes", action="store_true", help="nur Configs/Skripte neu schnueren")
    ap.add_argument("--steps", type=int, default=1000)
    ap.add_argument("--batch", type=int, default=2)
    args = ap.parse_args()

    summary = json.loads((THEMES_SRC / "_summary.json").read_text())
    slugs = [s for s, i in sorted(summary.items()) if i["written"] > 0]
    print(f"[bundle] {len(slugs)} Themen mit Bildern")

    # --- Configs erzeugen ----------------------------------------------------
    cmd = [sys.executable, str(BASE / "make-configs.py"),
           "--steps", str(args.steps), "--batch", str(args.batch)]
    subprocess.run(cmd, check=True, cwd=BASE)

    # --- Bundle-Verzeichnis aufbauen -----------------------------------------
    stages = BUNDLE / "themes"
    if not args.skip_themes:
        if stages.exists():
            subprocess.run(["rm", "-rf", str(stages)], check=True)
        stages.mkdir(parents=True)
        total_imgs = 0
        for slug in slugs:
            src = THEMES_SRC / slug / "images"
            dst = stages / slug / "images"
            dst.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(["cp", "-r", str(src), str(dst)], check=True)
            total_imgs += len(list(dst.glob("*.jpg")))
        print(f"[bundle] {total_imgs} Bilder in {stages}")

    # README ins Bundle
    (BUNDLE / "README.txt").write_text(
        "audioMONASTRY Themen-LoRA-Bundle (VISUAL-P1-009)\n"
        f"erzeugt: {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}\n\n"
        "themes/<slug>/images/  Bild + .txt-Caption (Trigger mstyle_<slug>)\n"
        "configs/<slug>.yml     ai-toolkit-Konfiguration (SDXL, arch: sdxl)\n"
        "pod-run.sh             Ablauf im Pod\n"
        "upload.py              Upload per vorab signierter URL\n",
        encoding="utf-8",
    )

    tar_path = BUNDLE / "bundle.tar.gz"
    if tar_path.exists():
        tar_path.unlink()
    with tarfile.open(tar_path, "w:gz") as tf:
        for name in ["themes", "configs", "pod-run.sh", "upload.py", "README.txt"]:
            p = BUNDLE / name
            if p.exists():
                tf.add(p, arcname=name)
    size_mb = tar_path.stat().st_size / 1e6
    print(f"[bundle] bundle.tar.gz: {size_mb:.1f} MB")

    # --- presign.json --------------------------------------------------------
    creds = r2._creds()
    missing = [k for k, v in creds.items() if not v]
    if missing:
        print(f"FEHLER: fehlende Zugangsdaten: {missing}")
        return 2

    targets: dict[str, str] = {}
    for slug in slugs:
        for name in [f"{slug}.safetensors", "train.log", "samples.tar", "meta.json"]:
            key = f"{args.run}/out/{slug}/{name}"
            targets[key] = r2.presign("PUT", key, **creds, expires=args.expires)
    for pod in POD_NAMES:
        key = f"{args.run}/status/{pod}.jsonl"
        targets[key] = r2.presign("PUT", key, **creds, expires=args.expires)
    # Der Pod nennt den Status-Schluessel ueber lora-out/_status/<pod>.jsonl
    for pod in POD_NAMES:
        key = f"lora-out/_status/{pod}.jsonl"
        targets[key] = r2.presign("PUT", key, **creds, expires=args.expires)
        skey = f"lora-out/{pod}.summary.txt"
        targets[skey] = r2.presign("PUT", skey, **creds, expires=args.expires)
    # Alias, damit pod-run.sh ohne Aenderung beide Schreibweisen findet
    for slug in slugs:
        for name in [f"{slug}.safetensors", "train.log", "samples.tar", "meta.json"]:
            for pre in ("lora-out",):
                key = f"{pre}/{slug}/{name}"
                if key not in targets:
                    targets[key] = r2.presign("PUT", key, **creds, expires=args.expires)

    presign_path = BUNDLE / "presign.json"
    presign_path.write_text(json.dumps(targets, indent=2), encoding="utf-8")
    print(f"[presign] {len(targets)} Ziel-URLs signiert -> {presign_path.name}")

    # --- hochladen -----------------------------------------------------------
    print("[upload] lade Bundle + presign.json nach R2 ...")
    upload(f"{args.run}/bundle.tar.gz", tar_path, creds, args.expires)
    upload(f"{args.run}/presign.json", presign_path, creds, args.expires)

    urls = {
        "run": args.run,
        "bundle_url": r2.presign("GET", f"{args.run}/bundle.tar.gz", **creds, expires=args.expires),
        "presign_url": r2.presign("GET", f"{args.run}/presign.json", **creds, expires=args.expires),
        "slugs": slugs,
        "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "expires_in_hours": args.expires / 3600,
    }
    (BASE / "build-urls.json").write_text(json.dumps(urls, indent=2), encoding="utf-8")
    print(f"[bundle] FERTIG. Start-URLs in build-urls.json ({len(slugs)} Themen, gueltig {args.expires/3600:.0f} h)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
