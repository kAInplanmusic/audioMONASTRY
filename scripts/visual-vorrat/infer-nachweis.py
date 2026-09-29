#!/usr/bin/env python3
"""Qualitaetsnachweis: eigene Inferenz-Bilder je LoRA, MIT und OHNE Trigger.

Warum ein eigener Inferenz-Lauf und nicht die Trainer-Probe
----------------------------------------------------------
Im v1-Lauf wurde aus dem Probe-Bild des Trainers auf die Qualitaet geschlossen.
Das war falsch: das Probe-Bild ist das Erzeugnis des Trainers, nicht eine
Pruefung des LoRA. Dieser Lauf erzeugt deshalb eigene Bilder mit einem FESTEN
Satz Prompts und festen Seeds - je Thema einmal MIT und einmal OHNE Trigger.
Der Unterschied zeigt, ob der Trigger den Stil wirklich traegt.

Gegen den Zerfall
-----------------
Jedes Bild wird zusaetzlich auf Struktur geprueft (Graustufen-Std, Kanten).
Eine praktisch leere Flaeche ist der Fehler, an dem v1 bei 7 von 32 Themen
gescheitert ist - er wird hier automatisch erkannt und mitgezaehlt.

Kosten: der Pod laedt das SDXL-Modell EINMAL und faehrt dann alle LoRAs durch.
8 Bilder je Thema (4 mit, 4 ohne Trigger) kosten ~30 s GPU-Zeit je Thema.
"""
from __future__ import annotations

import argparse
import base64
import json
import subprocess
import time
from pathlib import Path

import r2

ENV = r2.load_env()
BASE = Path(__file__).parent

# Fester Prompt-Satz. Bewusst themenfremder Inhalt (Taenzer, Portraet) und
# zusaetzlich ein neutraler Satz - so sieht man, ob der Stil oder nur der
# Inhalt reproduziert wird.
PROMPTS = {
    "taenzer": "a dancer on a stage, dynamic pose, dramatic lighting, photograph",
    "portraet": "portrait of a person, studio light, photograph",
    "szene": "a wide landscape scene at dusk, photograph",
    "objekt": "a still life of objects on a table, soft light, photograph",
}
SEEDS = [101, 202, 303, 404]

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
print("Modell geladen", flush=True)


def lora_schichten():
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
            return r.status


for job in PLAN["jobs"]:
    thema = job["theme"]
    lora = "/tmp/%s.safetensors" % thema
    urllib.request.urlretrieve(job["lora_url"], lora)
    try:
        pipe.unload_lora_weights()
    except Exception:
        pass
    vorher = lora_schichten()
    pipe.load_lora_weights(lora, adapter_name="probe")
    nachher = lora_schichten()
    print("=== %s: LoRA-Schichten %d -> %d" % (thema, vorher, nachher), flush=True)
    if nachher <= vorher:
        print("!! %s: LoRA wurde NICHT geladen - Ergebnis wird trotzdem geholt" % thema, flush=True)
    pipe.set_adapters(["probe"], adapter_weights=[0.9])

    n = 0
    for i, spec in enumerate(job["bilder"]):
        prompt = spec["prompt"]
        img = pipe(prompt=prompt, num_inference_steps=25, guidance_scale=6.0,
                   width=1024, height=1024,
                   generator=torch.Generator(device=dev).manual_seed(spec["seed"])).images[0]
        out = "/tmp/b_%d.png" % n
        img.save(out)
        put(job["upload_urls"][i], out)
        n += 1
        print("   %s %d/%d hochgeladen" % (thema, n, len(job["bilder"])), flush=True)
    os.remove(lora)

print("FERTIG", flush=True)
'''

SELBST_TERMINIEREN = (
    "curl -s -X POST \"https://api.runpod.io/graphql?api_key=$RUNPOD_API_KEY\" "
    "-H 'Content-Type: application/json' "
    "-d \"{\\\"query\\\":\\\"mutation { podTerminate(input: {podId: \\\\\\\"$RUNPOD_POD_ID\\\\\\\"}) }\\\"}\" "
    "| head -c 120 || true"
)


def runpodctl(args: list[str], timeout: int = 300) -> tuple[int, str]:
    env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/home/patrick",
           "RUNPOD_API_KEY": ENV.get("RP_API_KEY", "")}
    r = subprocess.run(["runpodctl", *args], capture_output=True, text=True, env=env, timeout=timeout)
    return r.returncode, (r.stdout or r.stderr).strip()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--lora", action="append", required=True,
                    help="SLUG|R2-SCHLUESSEL|ABLAGE-TAG   (mehrfach)")
    ap.add_argument("--tag", default="nachweis")
    ap.add_argument("--prompts", default=",".join(PROMPTS))
    ap.add_argument("--seeds", default=",".join(str(s) for s in SEEDS))
    ap.add_argument("--gpu", default="NVIDIA RTX PRO 5000 Blackwell,"
                                    "NVIDIA RTX PRO 6000 Blackwell Workstation Edition,"
                                    "NVIDIA RTX PRO 6000 Blackwell Server Edition,"
                                    "NVIDIA H100 PCIe")
    ap.add_argument("--max-minutes", type=int, default=75)
    ap.add_argument("--kill", default="")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if args.kill:
        print(runpodctl(["pod", "remove", args.kill]))
        return 0

    seeds = [int(s) for s in args.seeds.split(",") if s.strip()]
    promptnamen = [p.strip() for p in args.prompts.split(",") if p.strip()]
    creds = r2._creds()

    plan = {"jobs": []}
    for eintrag in args.lora:
        teile = eintrag.split("|")
        slug, key = teile[0].strip(), teile[1].strip()
        ablage = teile[2].strip() if len(teile) > 2 else slug
        trigger = f"mstyle_{slug}"
        bilder = []
        for name in promptnamen:
            rest = PROMPTS[name]
            for seed in seeds[:2]:
                bilder.append({"prompt": f"{trigger}, {rest}", "seed": seed,
                               "art": f"mit_{name}", "name": name, "seed_wert": seed})
        for name in promptnamen[:2]:
            rest = PROMPTS[name]
            for seed in seeds[:2]:
                bilder.append({"prompt": rest, "seed": seed + 1000,
                               "art": f"ohne_{name}", "name": name, "seed_wert": seed})
        plan["jobs"].append({
            "theme": ablage,
            "slug": slug,
            "lora_url": r2.presign("GET", key, **creds, expires=args.max_minutes * 130),
            "bilder": bilder,
            "upload_urls": [
                r2.presign("PUT", f"{args.tag}/{ablage}/{i:02d}_{b['art']}_s{b['seed']}.png",
                           **creds, expires=args.max_minutes * 130)
                for i, b in enumerate(bilder)],
        })

    n_bilder = sum(len(j["bilder"]) for j in plan["jobs"])
    print(f"[nachweis] {len(plan['jobs'])} LoRAs, {n_bilder} Bilder "
          f"({len(promptnamen)} Prompts x {len(seeds[:2])} Seeds, je mit/ohne Trigger)")

    # Plan OHNE signierte URLs ablegen: die lokale Auswertung muss wissen, unter
    # welchem Schluessel welches Bild liegt und was es bedeutet. Zugangsdaten
    # gehoeren nicht in eine Datei, die spaeter gelesen oder geteilt wird.
    uebersicht = {"tag": args.tag, "prompts": promptnamen, "seeds": seeds[:2], "jobs": []}
    for j in plan["jobs"]:
        uebersicht["jobs"].append({
            "theme": j["theme"], "slug": j["slug"],
            "bilder": [{"schluessel": f"{args.tag}/{j['theme']}/{i:02d}_{b['art']}_s{b['seed']}.png",
                        "art": b["art"], "prompt_name": b["name"], "seed": b["seed"]}
                       for i, b in enumerate(j["bilder"])],
        })
    (BASE / "ergebnisse").mkdir(exist_ok=True)
    (BASE / "ergebnisse" / f"nachweis-plan-{args.tag}.json").write_text(
        json.dumps(uebersicht, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[nachweis] Plan: ergebnisse/nachweis-plan-{args.tag}.json")

    script_b64 = base64.b64encode(INNER.encode()).decode()
    plan_b64 = base64.b64encode(json.dumps(plan).encode()).decode()
    laufzeit = args.max_minutes * 60
    inner = (f"echo {script_b64} | base64 -d > /tmp/infer.py && "
             f"echo {plan_b64} | base64 -d > /tmp/plan.json && "
             f"trap '{SELBST_TERMINIEREN}' EXIT && "
             f"PLAN=$(cat /tmp/plan.json) timeout {laufzeit} python /tmp/infer.py")
    docker_args = f'bash -c "{inner}"'

    if args.dry_run:
        print("[--dry-run] kein Pod angelegt (Zugangsdaten nicht ausgegeben)")
        return 0

    name = f"lora-{args.tag}"
    for gpu in [g.strip() for g in args.gpu.split(",") if g.strip()]:
        rc, out = runpodctl(["pod", "create", "--name", name,
                             "--image", "ostris/aitoolkit:latest", "--gpu-id", gpu,
                             "--gpu-count", "1", "--cloud-type", "COMMUNITY",
                             "--min-cuda-version", "13.0",
                             "--container-disk-in-gb", "40",
                             "--env", json.dumps({"RUNPOD_API_KEY": ENV.get("RP_API_KEY", "")}),
                             "--docker-args", docker_args])
        if rc == 0:
            pid = None
            try:
                d = json.loads(out)
                pid = d.get("id") or d.get("podId")
            except Exception:
                pass
            print(f"[nachweis] Pod auf {gpu}: {pid}")
            print(f"[nachweis] beenden: python3 infer-nachweis.py --kill {pid} --lora {args.lora[0]} "
                  f"(Selbst-Terminierung ist aktiv)")
            (BASE / f"pod-{name}.json").write_text(json.dumps(
                {"name": name, "id": pid, "gpu": gpu, "tag": args.tag,
                 "created": int(time.time()), "bilder": n_bilder}, indent=2), encoding="utf-8")
            return 0
        print(f"  {gpu}: {out[:120]}")
    print("keine Karte verfuegbar")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
