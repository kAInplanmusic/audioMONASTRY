#!/usr/bin/env python3
"""Das Network Volume der Bild-Rolle fuellen — Vorbereitung, ohne GPU-Kosten.

Was auf das Volume gehoert und warum genau dort (Details: `docs/VISUAL_LORA_STACK.md`):

    /workspace/models/checkpoints/sd_xl_base_1.0.safetensors   SDXL 1.0, 6,46 GB
    /workspace/models/vae/sdxl-vae-fp16-fix.safetensors        VAE, 0,33 GB
    /workspace/models/loras/<thema>.safetensors                32 eigene Themen-LoRAs, 2,73 GB

FLUX.1-dev liegt **im Image** (`runpod/worker-comfyui:5.11.0-flux1-dev-fp8`) und
kommt deshalb hier nicht vor: dieselbe Datei auf dem Volume kostete 0,80 USD/Monat
und muesste 16 GB uebertragen werden — ohne Gegenwert, weil ein Basismodell sich
nicht aendert.

Ablauf:
  1. R2-URLs vorab signieren (48 h) — der Pod bekommt **keine** Zugangsdaten.
  2. Ein Pod-Skript erzeugen, das im Rechenzentrum laedt und nach `models/…` schreibt.
  3. Dieses Skript nach B2 legen und eine vorab signierte URL ausgeben.
  4. Den `runpodctl create`-Befehl ausdrucken, der den Pod startet.

Benutzung:
    python3 stage-image-lora-volume.py --volume x8n6oeex5p --data-center EU-RO-1
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import b2  # noqa: E402
import r2  # noqa: E402

#: SDXL-Basis und VAE sind oeffentlich (kein HF-Token noetig, SDXL ist nicht gated).
#: Die Sollgroessen sind am 27.09.2026 per Content-Length der Quelle gemessen und
#: gegen die Dateien auf dem Volume geprueft (beide exakt gleich). Sie werden an
#: `fetch` uebergeben, damit eine abgebrochene Uebertragung auffaellt — der erste
#: Entwurf hatte geratene Zahlen und gar keine Pruefung.
WEIGHTS = [
    {
        "name": "sd_xl_base_1.0.safetensors",
        "target": "checkpoints",
        "url": "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors",
        "bytes": 6938078334,
    },
    {
        "name": "sdxl-vae-fp16-fix.safetensors",
        "target": "vae",
        "url": "https://huggingface.co/madebyollin/sdxl-vae-fp16-fix/resolve/main/sdxl_vae.safetensors",
        "bytes": 334641162,
    },
]

R2_PREFIX = "lora-out"


def presign_r2(key: str, expires: int = 172800) -> str:
    """Vorab signierte R2-GET-URL. Der Pod bekommt damit **keine** Zugangsdaten."""
    creds = r2._creds()
    missing = [k for k in ("endpoint", "bucket", "access_key", "secret_key") if not creds.get(k)]
    if missing:
        raise SystemExit(f"R2 nicht konfiguriert: es fehlen {', '.join(missing)} in der .env")
    return r2.presign(
        "GET",
        key,
        endpoint=creds["endpoint"],
        bucket=creds["bucket"],
        access_key=creds["access_key"],
        secret_key=creds["secret_key"],
        region="auto",
        expires=expires,
    )


def themes(source_dir: pathlib.Path) -> list[str]:
    return sorted(p.name for p in source_dir.iterdir() if p.is_dir())


def build_pod_script(lora_urls: dict[str, str]) -> str:
    lora_lines = "\n".join(
        f'fetch "{url}" "/workspace/models/loras/{slug}.safetensors" "{slug}"'
        for slug, url in sorted(lora_urls.items())
    )
    weight_lines = "\n".join(
        f'fetch "{w["url"]}" "/workspace/models/{w["target"]}/{w["name"]}" "{w["name"]}" {w["bytes"]}'
        for w in WEIGHTS
    )
    return f"""#!/bin/bash
# Im Pod erzeugt von stage-image-lora-volume.py. Kein Zugangsdatum im Pod:
# alle Quellen sind vorab signierte URLs (R2) bzw. oeffentlich (HuggingFace).
set -uo pipefail

WORKSPACE=/workspace
BASE="$WORKSPACE/models"
REPORT="$WORKSPACE/models/_staging-report.json"
LOG="$WORKSPACE/staging.log"

log() {{ echo "[staging] $*"; echo "[staging] $*" >> "$LOG"; }}

upload_evidence() {{
  # Beweise VOR der Terminierung nach B2. Ein Pod, der ohne Log verschwindet,
  # ist nicht diagnostizierbar — genau das ist am 27.09. mehrfach passiert.
  [ -s "$LOG" ] || return 0
  if [ -n "${{LOG_PUT_URL:-}}" ]; then
    curl -sS -X PUT --data-binary "@$LOG" "$LOG_PUT_URL" > /dev/null 2>&1 \\
      && echo "[staging] Log nach B2 geladen" || echo "[staging] Log-Upload fehlgeschlagen"
  fi
  if [ -s "$REPORT" ] && [ -n "${{REPORT_PUT_URL:-}}" ]; then
    curl -sS -X PUT --data-binary "@$REPORT" "$REPORT_PUT_URL" > /dev/null 2>&1 \\
      && echo "[staging] Bericht nach B2 geladen" || echo "[staging] Bericht-Upload fehlgeschlagen"
  fi
}}

self_terminate() {{
  upload_evidence
  log "beende den Pod"
  if [ -n "${{RUNPOD_POD_ID:-}}" ] && [ -n "${{RUNPOD_API_KEY:-}}" ]; then
    curl -s -X POST "https://api.runpod.io/graphql?api_key=${{RUNPOD_API_KEY}}" \\
      -H 'Content-Type: application/json' \\
      -d "{{\\"query\\":\\"mutation {{ podTerminate(input: {{podId: \\\\\\"${{RUNPOD_POD_ID}}\\\\\\"}}) }}\\"}}" > /dev/null
  fi
}}
trap self_terminate EXIT

# python3 gehoert dazu: der Bericht unten ist in Python geschrieben, und beim
# ersten Lauf fehlte er genau deshalb (alpine bringt kein python3 mit).
apk add --no-cache bash curl python3 > /dev/null 2>&1 || true

mkdir -p "$BASE/checkpoints" "$BASE/vae" "$BASE/loras" "$BASE/unet" "$BASE/clip"
: > "$LOG"
log "Ziel: Volume an $BASE  $(date -u +%H:%M:%SZ)"

FAILED=0
TOTAL=0

fetch() {{
  local url="$1" dest="$2" label="$3" want="${{4:-0}}"
  if [ -s "$dest" ]; then
    local have
    have=$(stat -c %s "$dest")
    if [ "$want" = "0" ] || [ "$have" = "$want" ]; then
      log "vorhanden: $label ($have Bytes)"
      TOTAL=$((TOTAL + have))
      return 0
    fi
    log "unvollstaendig: $label ($have statt $want) — lade neu"
    rm -f "$dest"
  fi
  log "lade: $label"
  if ! curl -sSL --fail --retry 5 --retry-delay 5 --max-time 1800 -o "$dest.part" "$url"; then
    log "FEHLER beim Laden: $label"
    rm -f "$dest.part"
    FAILED=$((FAILED + 1))
    return 1
  fi
  if [ "$want" != "0" ]; then
    local got
    got=$(stat -c %s "$dest.part")
    if [ "$got" != "$want" ]; then
      log "FEHLER Groesse: $label — $got statt $want Bytes"
      rm -f "$dest.part"
      FAILED=$((FAILED + 1))
      return 1
    fi
  fi
  mv "$dest.part" "$dest"
  local size
  size=$(stat -c %s "$dest")
  TOTAL=$((TOTAL + size))
  log "fertig: $label ($size Bytes)"
}}

# --- Basismodelle (oeffentlich) ---
{weight_lines}

# --- eigene Themen-LoRAs (vorab signierte R2-URLs, 48 h gueltig) ---
{lora_lines}

log "geschrieben: $TOTAL Bytes, Fehler: $FAILED"

python3 - "$REPORT" "$TOTAL" "$FAILED" <<'PY' 2>/dev/null || true
import json, os, pathlib, sys
report, total, failed = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
base = pathlib.Path('/workspace/models')
files = []
for path in sorted(base.rglob('*.safetensors')):
    files.append({{'pfad': str(path.relative_to(base)), 'bytes': path.stat().st_size}})
out = {{
    'bytes_gesamt': total,
    'fehler': failed,
    'dateien': files,
    'anzahl': len(files),
}}
pathlib.Path(report).write_text(json.dumps(out, indent=2))
print(json.dumps({{k: v for k, v in out.items() if k != 'dateien'}}))
PY

ls -lR "$BASE" >> "$LOG" 2>&1
log "FERTIG — Bericht: $REPORT"
if [ "$FAILED" != "0" ]; then
  log "ACHTUNG: $FAILED Datei(en) fehlen. Log oben pruefen."
fi
exit 0
"""


def fetch_script_from_b2(script_bytes: bytes, key: str) -> str:
    """Skript nach B2 legen und eine vorab signierte GET-URL zurueckgeben."""
    import urllib.request

    request = urllib.request.Request(b2.presign("PUT", key, expires=7200), data=script_bytes, method="PUT")
    request.add_header("Content-Length", str(len(script_bytes)))
    with urllib.request.urlopen(request, timeout=300) as response:
        if response.status != 200:
            raise SystemExit(f"PUT nach B2 fehlgeschlagen: HTTP {response.status}")
    return b2.presign("GET", key, expires=172800)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--volume", required=True, help="Network-Volume-ID")
    parser.add_argument("--data-center", default="EU-RO-1")
    parser.add_argument("--themes-dir", default="/home/patrick/lora-themen-2026-09-27/out-v3")
    parser.add_argument("--b2-key", default="audiomonastry/visual-lora-stack/stage-volume.sh")
    parser.add_argument("--print-only", action="store_true")
    parser.add_argument("--run", action="store_true", help="den Pod wirklich anlegen (Ausgabe ohne Zugangsdaten)")
    parser.add_argument("--watch", type=int, default=25, help="Sekunden zwischen Log-Abfragen (0 = nicht ueberwachen)")
    parser.add_argument("--attempts", type=int, default=6, help="Versuche, falls der Pod nie platziert wird")
    parser.add_argument("--gpu", default="", help="GPU-ID; leer = CPU-Pod. In EU-RO-1 wurden am 27.09. sechs CPU-Pods nie platziert.")
    parser.add_argument("--cloud", default="SECURE", help="SECURE oder COMMUNITY")
    args = parser.parse_args()

    slugs = themes(pathlib.Path(args.themes_dir))
    print(f"Themen gefunden: {len(slugs)}")
    lora_urls = {
        slug: presign_r2(f"{R2_PREFIX}/{slug}/{slug}.safetensors")
        for slug in slugs
    }
    script = build_pod_script(lora_urls)
    script_bytes = script.encode("utf-8")
    print(f"Pod-Skript: {len(script_bytes)} Bytes, {len(lora_urls)} LoRA-URLs (48 h gueltig)")
    print(
        "Download-Volumen: "
        f"{(sum(w['bytes'] for w in WEIGHTS) + 32 * 85438356) / 1073741824:.2f} GB"
    )
    if args.print_only:
        pathlib.Path("/tmp/stage-volume.sh").write_bytes(script_bytes)
        print("geschrieben: /tmp/stage-volume.sh (kein Upload)")
        return 0

    url = fetch_script_from_b2(script_bytes, args.b2_key)
    print(f"Skript in B2: {args.b2_key}")
    command = (
        # `sh`, nicht `bash`: alpine bringt nur die Busybox-Shell mit. Ein
        # `bash -c` als Container-Kommando scheitert mit „executable file not
        # found" und laeuft in die RunPod-Neustart-Schleife (live erlebt).
        'sh -c "apk add --no-cache bash curl python3 >/dev/null 2>&1; '
        f"curl -sSL '{url}' -o /tmp/stage.sh && bash /tmp/stage.sh\""
    )
    if not args.run:
        print("\n--- Pod anlegen (Trockenlauf) ---")
        print(
            "runpodctl pod create --name image-lora-staging --compute-type cpu "
            f"--image alpine:3.20 --data-center-ids {args.data_center} "
            f"--network-volume-id {args.volume} --container-disk-in-gb 10 "
            '--env \'{"SELF_TERMINATE":"1","RUNPOD_API_KEY":"<aus .env>"}\' '
            f"--docker-args '{command}'"
        )
        return 0
    evidence = {
        "LOG_PUT_URL": b2.presign("PUT", "audiomonastry/visual-lora-stack/staging.log", expires=7200),
        "REPORT_PUT_URL": b2.presign("PUT", "audiomonastry/visual-lora-stack/staging-report.json", expires=7200),
    }
    print("Beweis-Uploads: staging.log + staging-report.json nach B2 (vor der Terminierung)")
    return stage_with_retries(args.data_center, args.volume, command, args.watch, args.attempts,
                              args.gpu, args.cloud, evidence)


def stage_with_retries(data_center: str, volume: str, command: str, watch: int, attempts: int, gpu: str = "", cloud: str = "SECURE", extra_env: dict | None = None) -> int:
    """Pod anlegen, Log mitlesen, bei Geister-Pods neu versuchen.

    Zwei live gemessene Fehlerbilder, die diesen Ablauf erzwingen:

    * `runpodctl pod create` meldet **Erfolg mit Pod-ID**, auch wenn keine
      Kapazitaet da ist. Der Pod wird nie platziert und ist Sekunden spaeter
      nicht mehr auffindbar (`pod logs` → `not found`). Kosten: null.
    * Ein Container, dessen Kommando scheitert, wird von RunPod **neu gestartet**
      — ohne `trap` im Skript entstuende eine bezahlte Neustart-Schleife.

    Deshalb: nach jeder Anlage pruefen, ob der Pod lebt, Log mitlesen, und den
    Abbruch am `FERTIG` des Skripts erkennen statt an der Pod-Existenz.
    """
    import time

    for attempt in range(1, attempts + 1):
        print(f"\n=== Versuch {attempt}/{attempts} ===")
        pod_id = create_pod(data_center, volume, command, gpu=gpu, cloud=cloud, extra_env=extra_env)
        if not pod_id:
            print("Anlage fehlgeschlagen — neuer Versuch")
            time.sleep(20)
            continue
        seen_lines = 0
        idle_reads = 0
        while True:
            time.sleep(watch or 25)
            alive = pod_exists(pod_id)
            lines = pod_log_lines(pod_id)
            if lines is None:
                print("Pod ist verschwunden (nie platziert oder selbst beendet).")
                break
            for line in lines[seen_lines:]:
                if "staging" in line or "error" in line.lower():
                    print("   ", line[:160])
            seen_lines = len(lines)
            if any("FERTIG" in line for line in lines):
                print("\nVorstaging gemeldet. Volume-Bericht:")
                for line in lines:
                    if line.startswith("{") and "bytes_gesamt" in line:
                        print("   ", line[:200])
                return 0
            if not alive:
                print("Pod nicht mehr vorhanden — Abbruch dieses Versuchs.")
                break
            if lines and lines[-1] == "":
                idle_reads += 1
            if idle_reads > 40 and not lines:
                print("Kein Log nach mehreren Abfragen — neuer Versuch.")
                break
        print("Naechster Versuch ...")
    print("AUFGEGEBEN: kein Pod wurde platziert oder das Skript kam nicht durch.")
    return 1


def _runpodctl(args: list[str]) -> tuple[int, str]:
    import os
    import subprocess

    env = r2.load_env()
    api_key = os.environ.get("RUNPOD_API_KEY") or env.get("RP_API_KEY", "")
    proc = subprocess.run(
        ["runpodctl", *args], capture_output=True, text=True, timeout=120,
        env={**os.environ, "RUNPOD_API_KEY": api_key},
    )
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


def pod_exists(pod_id: str) -> bool:
    code, out = _runpodctl(["pod", "get", pod_id, "-o", "json"])
    return code == 0 and "not_found" not in out and '"id"' in out


def pod_log_lines(pod_id: str) -> list[str] | None:
    """Container-Zeilen des Pods; None, wenn der Pod nicht mehr existiert."""
    import json

    code, out = _runpodctl(["pod", "logs", pod_id])
    if "not found" in out or '"code":"not_found"' in out.replace(" ", ""):
        return None
    lines: list[str] = []
    for raw in out.splitlines():
        raw = raw.strip()
        if not raw.startswith("{"):
            continue
        try:
            entry = json.loads(raw)
        except ValueError:
            continue
        if entry.get("source") == "container":
            lines.append(str(entry.get("line", "")))
    return lines


def create_pod(data_center: str, volume: str, command: str, *, gpu: str = "", cloud: str = "SECURE", extra_env: dict | None = None) -> str | None:
    """Pod anlegen. Die Ausgabe wird gefiltert: die Pod-Antwort enthaelt die env
    samt API-Schluessel und darf so nicht in ein Log oder einen Bericht geraten."""
    import os
    import subprocess

    env = r2.load_env()
    api_key = os.environ.get("RUNPOD_API_KEY") or env.get("RP_API_KEY", "")
    if not api_key:
        raise SystemExit("RUNPOD_API_KEY fehlt (weder in der Umgebung noch als RP_API_KEY in der .env)")
    argv = [
        "runpodctl", "pod", "create",
        "--name", "image-lora-staging",
        "--image", "alpine:3.20",
        "--data-center-ids", data_center,
        "--network-volume-id", volume,
        "--container-disk-in-gb", "10",
        "--env", json.dumps({"SELF_TERMINATE": "1", "RUNPOD_API_KEY": api_key, **(extra_env or {})}),
        "--docker-args", command,
        "-o", "json",
    ]
    if gpu:
        # Ein GPU-Pod, weil in EU-RO-1 am 27.09. sechs CPU-Pods nie platziert
        # wurden (Geister-Pods: angelegt, nie gestartet, kostenlos, aber nutzlos).
        # Der Pod laedt nur und beendet sich — die GPU bleibt ungenutzt.
        argv[3:3] = ["--gpu-id", gpu, "--gpu-count", "1", "--cloud-type", cloud]
    else:
        argv[3:3] = ["--compute-type", "cpu"]
    proc = subprocess.run(argv, capture_output=True, text=True, timeout=300, env={**os.environ, "RUNPOD_API_KEY": api_key})
    raw = proc.stdout.strip()
    try:
        pod = json.loads(raw)
    except ValueError:
        print("Antwort nicht lesbar:", raw[:400] or proc.stderr[:400])
        return None
    if isinstance(pod, dict) and pod.get("error"):
        print("Pod-Anlage abgelehnt:", json.dumps(pod)[:300])
        return None
    # Bewusst gefiltert: env/raw enthalten den API-Schluessel.
    keep = {k: pod.get(k) for k in ("id", "name", "costPerHr", "machine", "desiredStatus", "volumeInGb") if k in pod}
    print("Pod:", json.dumps(keep, ensure_ascii=False))
    machine = pod.get("machine") or {}
    print(f"Karte/Ort: {machine.get('gpuDisplayName', '-')} / {machine.get('location', '-')}")
    print(f"Stundenpreis: {pod.get('costPerHr')} USD/h")
    print("Log verfolgen:  runpodctl pod logs " + str(pod.get("id", "<id>")))
    return str(pod.get("id") or "") or None


if __name__ == "__main__":
    raise SystemExit(main())
