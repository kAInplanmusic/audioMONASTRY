#!/usr/bin/env python3
"""Erzeugt je Thema eine ai-toolkit-Konfiguration fuer ein SDXL-LoRA.

Vorlage ist die BEWAEHRTE FLUX-Konfiguration aus dem erfolgreichen Lauf vom
24.09. (lora/cosmic-r16/config.yml in R2). Geaendert wurde nur, was SDXL
wirklich betrifft - jede Aenderung ist unten begruendet, nichts ist geraten:

  model.name_or_path : FLUX.1-dev            -> stabilityai/stable-diffusion-xl-base-1.0
  model.arch         : (fehlte)              -> "sdxl"
      Belegt in toolkit/config_modules.py: `elif self.arch == 'sdxl': self.is_xl = True`
      und `is_xl` steuert in stable_diffusion_model.py die Wahl von
      StableDiffusionXLPipeline. Ohne arch bleibt is_xl False -> falsche Pipeline.
  model.is_flux      : true                  -> false
  model.dtype        : bf16                  -> bf16 (bleibt; verhindert das Laden in fp32)
  train.dtype        : bf16                  -> bf16 (bleibt; DIE Lektion aus dem FLUX-Lauf:
      ohne diesen Schluessel laedt ai-toolkit fp32 und stirbt am .to(cuda))
  train.noise_scheduler / sample.sampler : flowmatch -> ddpm  (SDXL ist DDPM, Flowmatch ist FLUX)
  sample.guidance_scale : 4 -> 7             (SDXL-Standard CFG)
  train.batch_size   : 1 -> 2                (24-GB-Karten; Platz ist da)

Zusatz fuer den v2-Lauf (Nachtrainieren der zerfallenden Themen)
----------------------------------------------------------------
  --lr-scheduler cosine   belegt in jobs/process/BaseSDTrainProcess.py:2213:
      `lr_scheduler_params['total_iters'] = self.train_config.steps` und
      toolkit/scheduler.py baut daraus CosineAnnealingLR(T_max=total_iters).
      Die LR faellt also ueber den Lauf auf 0 - das ist der Hebel gegen die
      spaete Divergenz, die bei 7 Themen live nachgewiesen wurde.
  --keep-saves N / --save-every M   halten Zwischenstaende. Damit kann der Pod
      den Schritt waehlen, der NICHT zerfallen ist, statt blind den letzten zu
      liefern (genau das hat `taenzer`/`licht_rauch` kaputt gemacht).
  --sample-every muss == --save-every sein, damit sich die Bildmessung des
      Trainers eindeutig einem Gewichtsstand zuordnen laesst.
  --suffix TAG            erzeugt einen JOB `<slug>__<tag>`; Bilder liegen
      weiter unter themes/<slug>/images, Ergebnis unter out/<job>/.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

BASE = Path(__file__).parent

TEMPLATE = """---
# audioMONASTRY - Themen-LoRA (VISUAL-P1-009) - Thema: {theme}
# Job: {job}   (erzeugt von make-configs.py)
# Basis: bewaehrte FLUX-Konfiguration vom 2026-09-24
job: extension
config:
  name: "{job}"
  process:
    - type: sd_trainer
      training_folder: "/workspace/out/{job}"
      device: cuda:0
      network:
        type: lora
        linear: {rank}
        linear_alpha: {rank}
      save:
        dtype: float16
        save_every: {save_every}
        max_step_saves_to_keep: {keep_saves}
      datasets:
        - folder_path: "/workspace/themes/{slug}/images"
          caption_ext: txt
          caption_dropout_rate: 0.05
          shuffle_tokens: false
          cache_latents_to_disk: true
          resolution: [{resolution}]
      train:
        batch_size: {batch}
        dtype: "bf16"
        steps: {steps}
        gradient_accumulation_steps: 1
        train_unet: true
        train_text_encoder: false
        gradient_checkpointing: true
        noise_scheduler: ddpm
        optimizer: adamw8bit
        lr: {lr}
        lr_scheduler: {lr_scheduler}
{lr_params}        ema_config:
          use_ema: false
      model:
        name_or_path: "stabilityai/stable-diffusion-xl-base-1.0"
        arch: "sdxl"
        is_flux: false
        dtype: "bf16"
      sample:
        sampler: ddpm
        sample_every: {sample_every}
        width: {resolution}
        height: {resolution}
        prompts:
          - "{trigger}, {sample_extra}"
        neg: ""
        seed: 42
        walk_seed: false
        guidance_scale: 7
        sample_steps: 25
"""

SAMPLE_EXTRA = "high detail, natural light"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(BASE / "bundle" / "configs"))
    ap.add_argument("--steps", type=int, default=1000)
    ap.add_argument("--batch", type=int, default=2)
    ap.add_argument("--rank", type=int, default=16)
    ap.add_argument("--lr", default="1e-4")
    ap.add_argument("--lr-scheduler", default="constant",
                    help="constant | cosine | cosine_with_restarts | step | linear "
                         "(belegt in toolkit/scheduler.py)")
    ap.add_argument("--lr-scheduler-params", default="",
                    help="JSON, wird als lr_scheduler_params eingetragen")
    ap.add_argument("--save-every", type=int, default=0, help="0 = steps//4")
    ap.add_argument("--keep-saves", type=int, default=2)
    ap.add_argument("--sample-every", type=int, default=0, help="0 = save_every")
    ap.add_argument("--resolution", type=int, default=1024)
    ap.add_argument("--suffix", default="", help="Job-Name wird <slug>__<suffix>")
    ap.add_argument("--only", default="", help="kommagetrennte Slugs (Default: alle mit Bildern)")
    args = ap.parse_args()

    summary = json.loads((BASE / "out-v3" / "_summary.json").read_text())
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    save_every = args.save_every or max(100, args.steps // 4)
    sample_every = args.sample_every or save_every
    params = json.loads(args.lr_scheduler_params) if args.lr_scheduler_params else {}
    # lr_scheduler_params als YAML-Block (nur wenn vorhanden)
    lr_params = ""
    if params:
        zeilen = "\n".join(f"          {k}: {json.dumps(v)}" for k, v in params.items())
        lr_params = f"        lr_scheduler_params:\n{zeilen}\n"

    only = {s for s in args.only.split(",") if s}
    n = 0
    made: list[str] = []
    for slug, info in sorted(summary.items()):
        if info["written"] <= 0:
            continue
        if only and slug not in only:
            continue
        job = f"{slug}__{args.suffix}" if args.suffix else slug
        yml = TEMPLATE.format(
            theme=info["theme"],
            slug=slug,
            job=job,
            rank=args.rank,
            steps=args.steps,
            batch=args.batch,
            lr=args.lr,
            lr_scheduler=args.lr_scheduler,
            lr_params=lr_params,
            save_every=save_every,
            keep_saves=args.keep_saves,
            sample_every=sample_every,
            resolution=args.resolution,
            trigger=info["trigger"],
            sample_extra=SAMPLE_EXTRA,
        )
        (out / f"{job}.yml").write_text(yml, encoding="utf-8")
        made.append(job)
        n += 1

    (out / "_index.json").write_text(json.dumps(made, indent=2), encoding="utf-8")
    print(f"[configs] {n} Konfigurationen in {out} (steps={args.steps}, batch={args.batch}, "
          f"rank={args.rank}, lr={args.lr}, scheduler={args.lr_scheduler}, "
          f"save_every={save_every}, keep={args.keep_saves}, suffix='{args.suffix}')")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
