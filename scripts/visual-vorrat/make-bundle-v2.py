#!/usr/bin/env python3
"""Schnuert das v2-Bundle (Nachtrainieren) und signiert die Ziel-URLs.

Unterschiede zu make-bundle.py
------------------------------
  * Es kommen NUR die Themen ins Bundle, die wirklich laufen. v1 packte alle 32
    (299 MB) ein - das kostete Download-Zeit im Pod, also Geld.
  * Mess-ARME: `--arm TAG|lr|scheduler` erzeugt Jobs `<slug>__<TAG>`. So faehrt
    derselbe Pod mehrere Einstellungen am selben Bildmaterial.
  * Ausgabe-Run ist getrennt (Default lora-themen-v2), damit v1 unberuehrt
    bleibt, bis das Ergebnis geprueft ist.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request
from pathlib import Path

import r2

BASE = Path(__file__).parent
BV2 = BASE / "bundle-v2"
THEMES_SRC = BASE / "out-v3"


def upload(key: str, path: Path, creds: dict[str, str], expires: int) -> int:
    url = r2.presign("PUT", key, **creds, expires=expires)
    data = path.read_bytes()
    req = urllib.request.Request(url, data=data, method="PUT")
    req.add_header("Content-Type", "application/octet-stream")
    with urllib.request.urlopen(req, timeout=3600) as r:
        print(f"  PUT {key}: HTTP {r.status} ({len(data) / 1e6:.1f} MB)")
        return r.status


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default="lora-themen-v2")
    ap.add_argument("--themes", required=True, help="kommagetrennte Basis-Slugs")
    ap.add_argument("--versuch-thema", default="",
                    help="Slug, an dem die Arme verglichen werden (muss in --themes sein). "
                         "Leer = keine Messphase, alle Themen direkt anwenden.")
    ap.add_argument("--arm", action="append", default=[],
                    help="TAG|lr|scheduler  (mehrfach; ohne Angabe: der Slug selbst)")
    ap.add_argument("--steps", type=int, default=800)
    ap.add_argument("--rank", type=int, default=16)
    ap.add_argument("--batch", type=int, default=2)
    ap.add_argument("--save-every", type=int, default=100)
    ap.add_argument("--keep-saves", type=int, default=12)
    ap.add_argument("--pods", default="",
                    help="zusaetzliche Pod-Namen fuer die Status-Schluessel "
                         "(Standard: ein breites Namensraster)")
    ap.add_argument("--expires", type=int, default=172800)
    args = ap.parse_args()

    # Status-Schluessel fuer ein BREITES Namensraster signieren. Der Pod kennt
    # seinen Namen erst beim Start; wird er hier nicht erfasst, kann er seinen
    # Status und sein Log NICHT hochladen - der Lauf ist dann nicht
    # diagnostizierbar (live passiert: Pod 'lora-v2-w1s' lief 5 min und
    # verschwand ohne jede Spur). Signieren kostet nichts.
    pod_namen = [f"lora-v2-{p}{i}" for p in ("p",) for i in range(1, 21)]
    pod_namen += [f"lora-v2-w{r}{s}" for r in range(1, 21) for s in ("c", "s")]
    for extra in args.pods.split(","):
        if extra.strip():
            pod_namen.append(extra.strip())
    pod_namen = sorted(set(pod_namen))

    slugs = [s.strip() for s in args.themes.split(",") if s.strip()]
    summary = json.loads((THEMES_SRC / "_summary.json").read_text())
    fehlend = [s for s in slugs if s not in summary or summary[s]["written"] <= 0]
    if fehlend:
        print(f"FEHLER: unbekannte/leere Themen: {fehlend}")
        return 2

    # save_every muss == sample_every sein UND alle Staende muessen erhalten
    # bleiben, sonst kann der Pod den brauchbaren Schritt nicht waehlen.
    n_saves = args.steps // args.save_every
    if args.keep_saves < n_saves + 1:
        print(f"[warn] keep-saves {args.keep_saves} < {n_saves + 1} noetige Staende "
              f"-> auf {n_saves + 1} erhoeht (sonst fehlt der gute Schritt)")
        args.keep_saves = n_saves + 1

    # --- Configs -------------------------------------------------------------
    cfg_dir = BV2 / "configs"
    if cfg_dir.exists():
        shutil.rmtree(cfg_dir)
    cfg_dir.mkdir(parents=True)

    jobs: list[str] = []
    arme = args.arm or ["|1e-4|constant"]
    for arm in arme:
        teile = arm.split("|")
        tag = teile[0].strip()
        lr = teile[1].strip() if len(teile) > 1 and teile[1].strip() else "1e-4"
        sched = teile[2].strip() if len(teile) > 2 and teile[2].strip() else "constant"
        cmd = [sys.executable, str(BASE / "make-configs.py"),
               "--out", str(cfg_dir), "--steps", str(args.steps),
               "--batch", str(args.batch), "--rank", str(args.rank),
               "--lr", lr, "--lr-scheduler", sched,
               "--save-every", str(args.save_every),
               "--keep-saves", str(args.keep_saves),
               "--sample-every", str(args.save_every),
               "--only", ",".join(slugs)]
        if tag:
            cmd += ["--suffix", tag]
        subprocess.run(cmd, check=True, cwd=BASE)
        jobs += [f"{s}__{tag}" if tag else s for s in slugs]

    versuch_thema = args.versuch_thema.strip()
    if versuch_thema and versuch_thema not in slugs:
        print(f"FEHLER: --versuch-thema '{versuch_thema}' ist nicht in --themes")
        return 2
    tags = []
    for arm in arme:
        t = arm.split("|")[0].strip()
        if t:
            tags.append(t)
    if versuch_thema and tags:
        versuche = [f"{versuch_thema}__{t}" for t in tags]
        anwendung = [s for s in slugs if s != versuch_thema]
        # Der erste Arm ist die konservative Voreinstellung (Pattsituation).
        haupt_suffix = tags[0]
    else:
        versuche = []
        anwendung = list(slugs)
        haupt_suffix = tags[0] if tags else ""

    print(f"[v2] {len(jobs)} Konfigurationen, {len(versuche)} Messarme, "
          f"{len(anwendung)} Anwendungsthema(en)")
    if versuche:
        print(f"[v2] Arme: {' '.join(versuche)}  -> Gewinner wird auf die anderen angewendet")

    # --- Themenbilder (nur die betroffenen) ----------------------------------
    stages = BV2 / "themes"
    if stages.exists():
        shutil.rmtree(stages)
    stages.mkdir(parents=True)
    n_bilder = 0
    for slug in slugs:
        dst = stages / slug / "images"
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(THEMES_SRC / slug / "images", dst)
        n_bilder += len(list(dst.glob("*.jpg")))
    print(f"[v2] {n_bilder} Bilder in {stages} ({len(slugs)} Themen)")

    (BV2 / "README.txt").write_text(
        "audioMONASTRY Themen-LoRA - v2 (Nachtrainieren)\n"
        f"erzeugt: {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}\n"
        f"Jobs: {' '.join(jobs)}\n\n"
        "themes/<slug>/images/    nur die betroffenen Themen\n"
        "configs/<job>.yml        Job-Konfiguration (lr_scheduler, save_every)\n"
        "pod-run.sh               Ablauf im Pod (Budget-Waechter, Schritt-Wahl)\n"
        "schrittwahl.py           waehlt den nicht zerfallenen Schritt\n"
        "upload.py                Upload per vorab signierter URL\n",
        encoding="utf-8")

    tar_path = BV2 / "bundle.tar.gz"
    if tar_path.exists():
        tar_path.unlink()
    with tarfile.open(tar_path, "w:gz") as tf:
        for name in ["themes", "configs", "pod-run.sh", "schrittwahl.py", "armwahl.py",
                     "upload.py", "README.txt"]:
            p = BV2 / name
            if p.exists():
                tf.add(p, arcname=name)
            else:
                # Ein fehlendes Skript hat den v2-Lauf schon einmal lahmgelegt:
                # armwahl.py fehlte im Bundle, der Pod nahm den Traceback-Text als
                # Suffix und uebersprang alle Themen. Lieber hier laut scheitern.
                print(f"FEHLER: {p} fehlt - Bundle waere unvollstaendig")
                return 2
    print(f"[v2] bundle.tar.gz: {tar_path.stat().st_size / 1e6:.1f} MB")

    # --- presign.json --------------------------------------------------------
    creds = r2._creds()
    targets: dict[str, str] = {}
    for job in jobs:
        for name in [f"{job}.safetensors", "samples.tar", "train.log", "meta.json", "step-wahl.json"]:
            key = f"{args.run}/out/{job}/{name}"
            targets[key] = r2.presign("PUT", key, **creds, expires=args.expires)
    # Sauberer Schluessel je Anwendungsthema: der Pod legt das GEWAEHLTE
    # Ergebnis zusaetzlich unter out/<slug>/<slug>.safetensors ab, damit die
    # Ablage hinterher nicht von der gewaehlten Einstellung abhaengt.
    for slug in anwendung:
        key = f"{args.run}/out/{slug}/{slug}.safetensors"
        targets[key] = r2.presign("PUT", key, **creds, expires=args.expires)
    key = f"{args.run}/arm-wahl.json"
    targets[key] = r2.presign("PUT", key, **creds, expires=args.expires)
    for pod in pod_namen:
        for name in [f"{pod}.jsonl", f"{pod}.summary.txt"]:
            key = f"{args.run}/status/{name}"
            targets[key] = r2.presign("PUT", key, **creds, expires=args.expires)

    presign_path = BV2 / "presign.json"
    presign_path.write_text(json.dumps(targets, indent=2), encoding="utf-8")
    print(f"[presign] {len(targets)} Ziel-URLs signiert")

    print("[upload] lade nach R2 ...")
    upload(f"{args.run}/bundle.tar.gz", tar_path, creds, args.expires)
    upload(f"{args.run}/presign.json", presign_path, creds, args.expires)

    urls = {
        "run": args.run,
        "bundle_url": r2.presign("GET", f"{args.run}/bundle.tar.gz", **creds, expires=args.expires),
        "presign_url": r2.presign("GET", f"{args.run}/presign.json", **creds, expires=args.expires),
        "slugs": slugs,
        "jobs": jobs,
        "versuche": versuche,
        "anwendung": anwendung,
        "haupt_suffix": haupt_suffix,
        "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "expires_in_hours": args.expires / 3600,
    }
    (BASE / "build-urls.json").write_text(json.dumps(urls, indent=2), encoding="utf-8")
    print(f"[v2] FERTIG: {len(jobs)} Konfigurationen, {len(versuche)} Arme, "
          f"{len(anwendung)} Anwendung. URLs in build-urls.json (gueltig {args.expires / 3600:.0f} h)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
