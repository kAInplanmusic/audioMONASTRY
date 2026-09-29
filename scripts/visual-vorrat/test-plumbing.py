#!/usr/bin/env python3
"""Prueft die Pod-Plumbing-Kette lokal, BEVOR Geld ausgegeben wird.

Getestet wird genau das, was der Pod tun wird:
  1. presign (PUT/GET) gegen R2
  2. bundle/upload.py mit einer presign.json
  3. Tar-Bundle: entpacken und Struktur pruefen
  4. YAML-Konfigurationen syntaktisch/strukturell pruefen
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))
import r2  # noqa: E402

FAILS: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'OK  ' if ok else 'FEHL'} {name}{(' - ' + detail) if detail else ''}")
    if not ok:
        FAILS.append(name)


def test_presign() -> None:
    creds = r2._creds()
    key = "selftest/plumbing-probe.bin"
    payload = b"plumbing " + os.urandom(8)
    req = urllib.request.Request(r2.presign("PUT", key, **creds, expires=600), data=payload, method="PUT")
    with urllib.request.urlopen(req, timeout=60) as resp:
        check("presign PUT", resp.status == 200, f"HTTP {resp.status}")
    got = urllib.request.urlopen(r2.presign("GET", key, **creds, expires=600), timeout=60).read()
    check("presign GET identisch", got == payload)


def test_uploader() -> None:
    creds = r2._creds()
    key = "selftest/uploader-probe.json"
    with tempfile.TemporaryDirectory() as td:
        presign_file = Path(td) / "presign.json"
        presign_file.write_text(json.dumps({key: r2.presign("PUT", key, **creds, expires=600)}))
        src = Path(td) / "probe.json"
        payload = b'{"probe":"upload.py"}'
        src.write_bytes(payload)
        env = dict(os.environ, PRESIGN_FILE=str(presign_file))
        res = subprocess.run(
            [sys.executable, str(BASE / "bundle" / "upload.py"), "--key", key, "--file", str(src)],
            capture_output=True, text=True, env=env,
        )
        check("upload.py laeuft", res.returncode == 0, (res.stdout or res.stderr).strip()[:100])
        got = urllib.request.urlopen(r2.presign("GET", key, **creds, expires=600), timeout=60).read()
        check("upload.py Inhalt korrekt", got == payload)

        # fehlender Schluessel darf NICHT still als Erfolg gelten
        res2 = subprocess.run(
            [sys.executable, str(BASE / "bundle" / "upload.py"), "--key", "gibt/es/nicht", "--file", str(src)],
            capture_output=True, text=True, env=env,
        )
        check("upload.py meldet fehlenden Schluessel", res2.returncode != 0, (res2.stdout or "").strip()[:80])


def test_bundle_structure() -> None:
    tar = BASE / "bundle" / "bundle.tar.gz"
    if not tar.exists():
        check("bundle.tar.gz vorhanden", False, "noch nicht geschnuert")
        return
    with tarfile.open(tar) as tf:
        names = tf.getnames()
    check("Bundle enthaelt pod-run.sh", "pod-run.sh" in names)
    check("Bundle enthaelt upload.py", "upload.py" in names)
    themes = {n.split("/")[1] for n in names if n.startswith("themes/") and n.count("/") > 1}
    configs = {n.split("/")[1].replace(".yml", "") for n in names if n.startswith("configs/") and n.endswith(".yml")}
    check("Bundle: Theme-Ordner == Config-Anzahl", themes == configs, f"{len(themes)} Themen / {len(configs)} Configs")
    missing_imgs = [t for t in themes if not any(n.startswith(f"themes/{t}/images/") and n.endswith(".jpg") for n in names)]
    check("jedes Thema hat Bilder", not missing_imgs, str(missing_imgs[:5]))


def test_configs() -> None:
    cfgdir = BASE / "bundle" / "configs"
    ymls = sorted(cfgdir.glob("*.yml")) if cfgdir.exists() else []
    if not ymls:
        check("Konfigurationen vorhanden", False, "keine")
        return
    try:
        import yaml
    except ImportError:
        print("     (PyYAML fehlt - pruefe per Textmuster)")
        yaml = None
    must = ['arch: "sdxl"', "stabilityai/stable-diffusion-xl-base-1.0", "is_flux: false", 'dtype: "bf16"', "noise_scheduler: ddpm"]
    bad = []
    for y in ymls:
        txt = y.read_text()
        for m in must:
            if m not in txt:
                bad.append(f"{y.name}: fehlt {m}")
        if yaml:
            try:
                d = yaml.safe_load(txt)
                proc = d["config"]["process"][0]
                assert proc["type"] == "sd_trainer"
                assert proc["model"]["arch"] == "sdxl"
                assert proc["train"]["dtype"] == "bf16"
                assert proc["datasets"][0]["folder_path"].endswith(f"{y.stem}/images")
            except Exception as exc:
                bad.append(f"{y.name}: YAML/Struktur {exc}")
    check(f"{len(ymls)} Konfigurationen strukturell korrekt", not bad, "; ".join(bad[:4]))


def main() -> int:
    print("=== Plumbing-Test (kein GPU, keine Pods) ===\n")
    test_presign()
    test_uploader()
    test_configs()
    test_bundle_structure()
    print()
    if FAILS:
        print(f"ERGEBNIS: {len(FAILS)} Fehler -> {FAILS}")
        return 1
    print("ERGEBNIS: alles gruen")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
