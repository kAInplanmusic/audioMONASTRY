#!/usr/bin/env python3
"""Laedt die geprueften Fremd-LoRAs ins Network Volume (EU-RO-1).

Elf Modelle, **ein** Pod-Lauf. Wer fuer jede LoRA einen eigenen Kaltstart bezahlt,
zahlt das Warten statt die Arbeit — das ist die teuerste Lehre aus dem Endpoint.

Die Auswahl und die verifizierten Basismodelle stehen in LORA-FREMDQUELLEN.md.
Alle Quellen sind oeffentlich, es braucht kein Token. Fremde LoRAs bekommen das
Praefix `fremd_`, damit im Volume unterscheidbar bleibt, was aus unserem eigenen
Training kommt und was nicht.

Das Projekt ist privat/Forschung — Lizenzen sind hier kein Ausschlussgrund,
nur das Basismodell entscheidet, in welchen Graphen eine LoRA passt.

Aufruf:
    python3 stage-fremd-loras.py --volume x8n6oeex5p --data-center EU-RO-1 --run --watch 40
"""
from __future__ import annotations

import argparse
import importlib.util
import pathlib
import urllib.parse

# Die vorhandene Vorstaging-Maschinerie weiterverwenden: sie kann Pods anlegen,
# Geister-Pods erkennen, Logs lesen und Beweise nach B2 legen. Nachbauen waere
# eine zweite Stelle, an der dieselben Fehler passieren koennen.
_hier = pathlib.Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("stage", _hier / "stage-image-lora-volume.py")
if _spec is None or _spec.loader is None:  # pragma: no cover
    raise SystemExit("stage-image-lora-volume.py nicht gefunden")
stage = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(stage)

B2_LOG_KEY = "audiomonastry/visual-lora-stack/fremd.log"

# (Zielname, Repo, Datei im Repo, Basis)  — Basis aus den Repo-Tags verifiziert
FREMD = [
    ("fremd_psychemelt", "Norod78/SDXL-Psychemelt-style-LoRA", "SDXL_Psychemelt_style_LoRA-000007.safetensors", "sdxl"),
    ("fremd_trip_slider", "ntc-ai/SDXL-LoRA-slider.psychedelic-trip", "psychedelic trip.safetensors", "sdxl"),
    ("fremd_giger", "mayakkkkkk/giger_style_LoRA", "pytorch_lora_weights.safetensors", "sdxl"),
    ("fremd_chrome", "RalFinger/chrome-style-sdxl-lora", "ral-chrome-sdxl.safetensors", "sdxl"),
    ("fremd_vhs", "CiroN2022/vhs-style-sdxl-v10", "VHS_Style.safetensors", "sdxl"),
    ("fremd_glowing", "xinhai342/lora-trained-style_glowing", "pytorch_lora_weights.safetensors", "sdxl"),
    ("fremd_surreal_collage", "KappaNeuro/surreal-collage", "Surreal Collage.safetensors", "sdxl"),
    ("fremd_surreal_harmony", "KappaNeuro/surreal-harmony", "Surreal Harmony.safetensors", "sdxl"),
    ("fremd_cbrpnk", "arsenichev/cbrpnk-style", "lora.safetensors", "flux1"),
    ("fremd_flame_fractal", "PLE/d15ff", "pytorch_lora_weights.safetensors", "flux1"),
    ("fremd_fractal_aliens", "ThalisAI/fractal-aliens-sci-fi-lora", "fractal-aliens-v02-flux.safetensors", "flux1"),
    # --- Nachtrag 28.09.: fertige FLUX-Entsprechungen zu den SDXL-Themen ---------
    # Ohne diese waere die FLUX-Seite auf drei Kombinationen gestanden. Das
    # Angebot an fertigen FLUX-LoRAs ist duenn und kommt fast vollstaendig von
    # einem Massen-Uploader (Muapi) — die Qualitaet ist NICHT geprueft, das
    # entscheidet der naechste Bildlauf. CtrlAltArt ist ein einzelner Autor (mit).
    ("fremd_flux_giger", "Muapi/biomechanical-h.r.giger", "biomechanical-h.r.giger.safetensors", "flux1"),
    ("fremd_flux_psychedelic", "Muapi/psychedelic-style-flux1.d", "psychedelic-style-flux1.d.safetensors", "flux1"),
    ("fremd_flux_fractal_psy", "Muapi/fractal-psychedelic", "fractal-psychedelic.safetensors", "flux1"),
    ("fremd_flux_cyberpunk", "Muapi/neon-cyberpunk-fl-xl-il-1.5", "neon-cyberpunk-fl-xl-il-1.5.safetensors", "flux1"),
    ("fremd_flux_chrome", "Muapi/chrome-style-flux-sdxl-1.5", "chrome-style-flux-sdxl-1.5.safetensors", "flux1"),
    ("fremd_flux_fractal_geo", "Muapi/fractal-geometry-style-flux-sdxl-1.5", "fractal-geometry-style-flux-sdxl-1.5.safetensors", "flux1"),
    ("fremd_flux_dreamlike", "CtrlAltArt/Flux_Dreamlike_surreal_digital_style", "Dreamlike Surreal Digital Style - (FLUX).safetensors", "flux1"),
]


def url_von(repo: str, datei: str) -> str:
    return f"https://huggingface.co/{repo}/resolve/main/{urllib.parse.quote(datei)}"


def build_script() -> str:
    zeilen = []
    for name, repo, datei, basis in FREMD:
        zeilen.append(f'add {name} "{url_von(repo, datei)}" "{basis}"')
    aufrufe = "\n".join(zeilen)
    return f"""#!/bin/bash
# Im Pod erzeugt von stage-fremd-loras.py. Keine Zugangsdaten im Skript:
# alle Quellen sind oeffentlich. Der Log geht vor der Terminierung nach B2.
set -u
LOG=/workspace/models/_fremd.log
mkdir -p /workspace/models
: > "$LOG"
say() {{ echo "[fremd] $*" | tee -a "$LOG"; }}

selbst_beenden() {{
  if [ -n "${{LOG_PUT_URL:-}}" ]; then
    curl -s -X PUT --data-binary "@$LOG" "$LOG_PUT_URL" > /dev/null 2>&1 || true
  fi
  if [ "${{SELF_TERMINATE:-0}}" = "1" ]; then
    curl -s -X DELETE -H "Authorization: Bearer $RUNPOD_API_KEY" \\
      "https://rest.runpod.io/v1/pods/$RUNPOD_POD_ID" > /dev/null 2>&1 || true
  fi
}}
trap selbst_beenden EXIT

say "Ziel: /workspace/models/loras  $(date -u +%H:%M:%SZ)"
mkdir -p /workspace/models/loras
ok=0; fehler=0; bytes=0; lora=0; flux=0
add() {{
  ziel="/workspace/models/loras/$1.safetensors"
  if [ -s "$ziel" ]; then
    groesse=$(stat -c%s "$ziel")
    say "vorhanden: $1 ($groesse Bytes)"; ok=$((ok+1)); bytes=$((bytes+groesse))
    [ "$3" = "sdxl" ] && lora=$((lora+1)) || flux=$((flux+1)); return
  fi
  code=$(curl -sSL --retry 3 --retry-delay 2 -w '%{{http_code}}' -o "$ziel" "$2")
  groesse=$(stat -c%s "$ziel" 2>/dev/null || echo 0)
  if [ "$code" = "200" ] && [ "$groesse" -gt 100000 ]; then
    say "geladen: $1 ($groesse Bytes, Basis $3)"; ok=$((ok+1)); bytes=$((bytes+groesse))
    [ "$3" = "sdxl" ] && lora=$((lora+1)) || flux=$((flux+1))
  else
    say "FEHLER $1: HTTP $code, $groesse Bytes"; rm -f "$ziel"; fehler=$((fehler+1))
  fi
}}

{aufrufe}

say "FERTIG — geladen/ok: $ok, Fehler: $fehler, Bytes: $bytes"
say "davon SDXL: $lora, FLUX: $flux"
say "--- Inhalt models/loras ---"
ls -l /workspace/models/loras | tail -n +2 | tee -a "$LOG"
say "--- Gegenprobe: Gesamtzahl LoRAs im Volume ---"
ls /workspace/models/loras | wc -l | tee -a "$LOG"
"""


def main() -> int:
    parser = argparse.ArgumentParser(description="Fremd-LoRAs ins Volume laden")
    parser.add_argument("--volume", required=True)
    parser.add_argument("--data-center", default="EU-RO-1")
    parser.add_argument("--gpu", default="NVIDIA RTX PRO 4500 Blackwell",
                        help="Katalog-ID; CPU-Pods werden auf diesem Konto nie platziert")
    parser.add_argument("--cloud", default="SECURE")
    parser.add_argument("--attempts", type=int, default=3)
    parser.add_argument("--watch", type=int, default=40)
    parser.add_argument("--run", action="store_true", help="wirklich anlegen")
    parser.add_argument("--print-only", action="store_true")
    args = parser.parse_args()

    skript = build_script()
    if args.print_only:
        print(skript)
        return 0
    print(f"Fremd-LoRAs: {len(FREMD)} Stueck "
          f"({sum(1 for *_, b in FREMD if b == 'sdxl')} SDXL, {sum(1 for *_, b in FREMD if b == 'flux1')} FLUX)")
    print(f"Skript: {len(skript)} Bytes")

    if not args.run:
        print("Trockenlauf — mit --run wirklich ausfuehren.")
        return 0

    url = stage.fetch_script_from_b2(skript.encode("utf-8"), "audiomonastry/visual-lora-stack/fremd-stage.sh")
    befehl = (
        'sh -c "apk add --no-cache bash curl >/dev/null 2>&1; '
        f"curl -sSL '{url}' -o /tmp/fremd.sh && bash /tmp/fremd.sh\""
    )
    # Die signierte Schreib-URL geht per Umgebung in den Pod, nicht ins Skript:
    # das Skript liegt in B2 und soll keine Zugangsdaten enthalten.
    return stage.stage_with_retries(
        args.data_center,
        args.volume,
        befehl,
        args.watch,
        args.attempts,
        args.gpu,
        args.cloud,
        {"LOG_PUT_URL": stage.b2.presign("PUT", B2_LOG_KEY, expires=7200)},
    )


if __name__ == "__main__":
    raise SystemExit(main())
