#!/usr/bin/env python3
"""Startet einen Trainings-Pod auf der Community-Cloud.

Aufruf:
    python3 start-pod.py --name lora-p1 --themes "comic abstrakt ..." [--gpu "NVIDIA GeForce RTX 4090"]
                         [--steps 1000] [--deadline-hours 8] [--dry-run]

Sicherheitsnetz:
  * --cloud-type COMMUNITY (billiger; der Betreiber hat das so entschieden)
  * --min-cuda-version 13.0 (das Trainer-Image bringt nvidia/cuda:13.0.3 mit)
  * SELF_TERMINATE=1 + RUNPOD_API_KEY im Pod: der Pod loescht sich am Ende SELBST.
    Damit kann kein Pod unbemerkt weiterrechnen.
  * --container-disk-in-gb 40 (SDXL ~7 GB + Latenz-Cache + Ergebnisse)
  * Namenssperre: existiert der Name schon, wird nichts angelegt.
"""
from __future__ import annotations

import argparse
import base64
import json
import subprocess
import sys
import time
from pathlib import Path

from r2 import load_env

BASE = Path(__file__).parent
ENV = load_env()
API_KEY = ENV.get("RP_API_KEY", "")


def runpodctl(args: list[str], timeout: int = 180) -> tuple[int, str]:
    env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/home/patrick", "RUNPOD_API_KEY": API_KEY}
    res = subprocess.run(["runpodctl", *args], capture_output=True, text=True, env=env, timeout=timeout)
    return res.returncode, (res.stdout or res.stderr).strip()


def existing_names() -> set[str]:
    rc, out = runpodctl(["pod", "list", "-o", "json"])
    if rc != 0:
        return set()
    try:
        pods = json.loads(out)
    except json.JSONDecodeError:
        return set()
    return {p.get("name", "") for p in pods}


def pod_ids() -> set[str]:
    rc, out = runpodctl(["pod", "list", "-o", "json"])
    if rc != 0:
        return set()
    try:
        return {p.get("id", "") for p in json.loads(out)}
    except json.JSONDecodeError:
        return set()


def auf_start_warten(pid: str, sekunden: int = 75) -> bool:
    """Prueft, ob der Pod WIRKLICH laeuft.

    `runpodctl pod create` meldet auch dann Erfolg (mit ID), wenn keine
    Kapazitaet vorhanden ist: der Pod wird nie auf einer Maschine platziert und
    verschwindet wenige Sekunden spaeter wieder - ohne Fehlermeldung und ohne
    Kosten. Genau das hat am 27.09. drei Anlaeufe in Folge gekostet, weil der
    GPU-Fallback nie weiterprobierte (die 5000 Blackwell war ausverkauft und
    stand als erste in der Kette).
    """
    ende = time.time() + sekunden
    gesehen = False
    while time.time() < ende:
        ids = pod_ids()
        if pid in ids:
            gesehen = True
        elif gesehen:
            return False            # war da, ist verschwunden -> keine Kapazitaet
        time.sleep(10)
    return gesehen


# Stundensatz je Karte (Community Cloud, Stand 27.09.2026).
# Der Pod rechnet seinen eigenen Verbrauch aus RATE_USD_H. Wird hier der Satz
# der FALSCHEN Karte eingetragen, greift die USD-Obergrenze viel zu spaet.
# Genau das passierte: --rate 0.33 (fuer die A6000) ging mit, gelaufen ist die
# PRO 6000 zu 1.69 - der Waechter haette das Fuenffache erlaubt.
RATE_USD_H = {
    "NVIDIA RTX A6000": 0.33,
    "NVIDIA RTX A5000": 0.27,
    "NVIDIA RTX PRO 4500 Blackwell": 0.34,
    "NVIDIA RTX PRO 4500 Blackwell Server Edition": 0.50,
    "NVIDIA RTX PRO 4000 Blackwell": 0.50,
    "NVIDIA GeForce RTX 4090": 0.34,
    "NVIDIA GeForce RTX 5090": 0.69,
    "NVIDIA L40S": 0.79,
    "NVIDIA RTX PRO 5000 Blackwell": 0.82,
    "NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 2g.48gb": 1.00,
    "NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 1g.24gb": 0.50,
    "NVIDIA A100 80GB PCIe": 1.19,
    "NVIDIA A100-SXM4-80GB": 1.39,
    "NVIDIA RTX PRO 6000 Blackwell Workstation Edition": 1.69,
    "NVIDIA RTX PRO 6000 Blackwell Server Edition": 1.69,
    "NVIDIA H100 PCIe": 2.49,
    "NVIDIA H100 NVL": 2.59,
    "NVIDIA H100 80GB HBM3": 2.69,
    "NVIDIA H200": 3.59,
    "NVIDIA B200": 5.98,
    "NVIDIA B300 SXM6 AC": 6.94,
}


def rate_fuer(gpu: str, ersatz: float, cloud: str = "COMMUNITY") -> float:
    """Satz der Karte; unbekannte Karten bekommen den hoeheren der beiden Werte,
    damit die Obergrenze im Zweifel zu frueh greift statt zu spaet.

    Secure Cloud ist teurer als Community (beobachtet: 2.19 statt 1.69 bei der
    PRO 6000 WK, also ~30 %). Der Tabellenwert ist der Community-Preis; fuer
    Secure kommt deshalb ein Aufschlag dazu, sonst greift der Deckel im Pod zu
    spaet - genau dieser Fehler ist hier schon einmal passiert (mit dem Faktor 5).
    """
    if gpu in RATE_USD_H:
        satz = RATE_USD_H[gpu]
    else:
        satz = max(ersatz, 2.49)
        print(f"  [warn] kein Preis fuer '{gpu}' hinterlegt - nutze {satz} USD/h")
    if cloud.upper() == "SECURE":
        satz = round(satz * 1.35, 2)
    return satz


def _build_cmd(name: str, gpu: str, args, env: dict, docker_args: str) -> list[str]:
    cmd = [
        "pod", "create",
        "--name", name,
        "--image", "ostris/aitoolkit:latest",
        "--gpu-id", gpu,
        "--gpu-count", "1",
        "--cloud-type", args.cloud,
        "--min-cuda-version", args.min_cuda,
        "--container-disk-in-gb", str(args.disk_gb),
        "--env", json.dumps(env),
        "--docker-args", docker_args,
    ]
    if args.public_ip:
        cmd += ["--ports", "22/tcp", "--public-ip"]
    return cmd


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--themes", default="",
                    help="v1: Themen fuer den einfachen Lauf (leerzeichengetrennt)")
    ap.add_argument("--versuche", default="",
                    help="v2 Phase 1: Messarme (Job-Namen <slug>__<tag>)")
    ap.add_argument("--anwendung", default="",
                    help="v2 Phase 2: Themen, auf die der gewaehlte Arm angewendet wird")
    ap.add_argument("--gpu", default="NVIDIA GeForce RTX 4090")
    ap.add_argument("--steps", type=int, default=1000)
    ap.add_argument("--deadline-hours", type=float, default=8.0)
    ap.add_argument("--max-theme-minutes", type=float, default=60.0,
                    help="hartes Zeitlimit JE THEMA - verhindert, dass ein haengendes Thema Stunden frisst")
    ap.add_argument("--disk-gb", type=int, default=40)
    ap.add_argument("--cloud", default="COMMUNITY")
    ap.add_argument("--min-cuda", default="13.0")
    ap.add_argument("--public-ip", action="store_true", help="oeffentliche IP verlangen (fuer SSH; schraenkt die Auswahl stark ein)")
    ap.add_argument("--max-usd", type=float, default=0.0,
                    help="HARTE Obergrenze in USD. Der Pod terminiert sich selbst, sobald sie erreicht ist (0 = aus)")
    ap.add_argument("--rate", type=float, default=0.82, help="Stundensatz der Karte in USD (Default 0.82)")
    ap.add_argument("--run", default="", help="Ausgabe-Praefix in R2 (Default: aus build-urls.json)")
    ap.add_argument("--suffix", default="",
                    help="v2 ohne Messphase: feste Einstellung, z.B. lr5e5cos "
                         "(die Konfigurationen heissen dann <slug>__<suffix>)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    urls = json.loads((BASE / "build-urls.json").read_text())
    themes = args.themes.split()
    deadline = int(time.time() + args.deadline_hours * 3600)
    run = args.run or urls.get("run") or "lora-themen-v1"

    if not API_KEY:
        print("FEHLER: RP_API_KEY fehlt")
        return 2
    if not (themes or args.versuche or args.anwendung):
        print("FEHLER: --themes (v1) bzw. --versuche/--anwendung (v2) noetig")
        return 2
    if not urls.get("bundle_url"):
        print("FEHLER: build-urls.json hat keine bundle_url - erst make-bundle.py laufen lassen")
        return 2
    # Der Lauf aus build-urls.json muss zum gewaehlten Aufruf passen, sonst
    # landen die Uploads unter einem Praefix, fuer das keine URL signiert ist.
    if not args.run and urls.get("run") and urls["run"] != run:
        print(f"FEHLER: build-urls.json gehoert zu '{urls['run']}', angefordert '{run}'")
        return 2

    if args.name in existing_names():
        print(f"ABBRUCH: Pod '{args.name}' existiert schon - kein zweiter Pod mit demselben Namen")
        return 3

    env = {
        "RUN": run,
        "BUNDLE_URL": urls["bundle_url"],
        "PRESIGN_URL": urls["presign_url"],
        "THEMES": " ".join(themes),
        "VERSUCHE": args.versuche,
        "ANWENDUNG": args.anwendung,
        "SUFFIX": args.suffix,
        "POD_NAME": args.name,
        "DEADLINE_EPOCH": str(deadline),
        "MAX_THEME_SECONDS": str(int(args.max_theme_minutes * 60)),
        "MAX_USD": str(args.max_usd),
        "RATE_USD_H": str(args.rate),
        "SELF_TERMINATE": "1",
        "RUNPOD_API_KEY": API_KEY,
        "HF_TOKEN": ENV.get("HF_TOKEN", ""),
    }

    # Der Start-Befehl war zu stumm: ein Pod verschwand ohne jeden Status, und
    # aus dem Log liess sich nicht sagen, ob Bundle, Entpacken oder das
    # Pod-Skript gescheitert war.
    #
    # Wichtig: NICHT versuchen, das direkt in `bash -c "..."` zu schreiben. Der
    # Wert wird von einer aeusseren Shell verarbeitet - Doppel-Anfuehrungszeichen
    # im Inneren beenden die Zeichenkette, und `$(...)` wird dort SOFORT
    # ausgewertet (also bevor die Datei existiert). Das Boot-Skript geht deshalb
    # base64-kodiert hinein (wie beim Inferenz-Pod) und wird im Container
    # dekodiert. Ein Fehlschlag haelt den Container 120 s offen, sonst raeumt
    # RunPod ihn weg, bevor man das Log lesen kann.
    boot = "\n".join([
        "#!/usr/bin/env bash",
        "mkdir -p /workspace; cd /workspace || exit 1",
        "echo '[boot] hole Bundle ...'",
        "if ! curl -fsSL \"$BUNDLE_URL\" -o bundle.tar.gz; then",
        "  echo '[boot] FEHLER: Bundle-Download fehlgeschlagen'; sleep 120; exit 1",
        "fi",
        "echo \"[boot] Bundle: $(stat -c%s bundle.tar.gz) Bytes\"",
        "if ! tar -xzf bundle.tar.gz; then",
        "  echo '[boot] FEHLER: Entpacken fehlgeschlagen'; sleep 120; exit 1",
        "fi",
        "if [ ! -f /workspace/pod-run.sh ]; then",
        "  echo '[boot] FEHLER: pod-run.sh fehlt im Bundle'; ls -la /workspace; sleep 120; exit 1",
        "fi",
        "echo '[boot] starte pod-run.sh'",
        "bash /workspace/pod-run.sh",
        "echo \"[boot] pod-run.sh beendet mit RC=$?\"",
        "sleep 30",
        "",
    ])
    boot_b64 = base64.b64encode(boot.encode()).decode()
    inner = (f"echo {boot_b64} | base64 -d > /tmp/boot.sh && bash /tmp/boot.sh")
    docker_args = f'bash -c "{inner}"'

    print(f"=== Pod '{args.name}'   (Lauf: {run})")
    print(f"    GPU-Kette  : {args.gpu} ({args.cloud}, min CUDA {args.min_cuda})")
    if args.versuche or args.anwendung:
        print(f"    v2 Phase 1 : {args.versuche or '-'}")
        print(f"    v2 Phase 2 : {args.anwendung or '-'}")
    else:
        print(f"    Themen     : {len(themes)} -> {' '.join(themes)}")
    print(f"    Frist      : {args.deadline_hours} h (danach startet kein neuer Job)")
    print(f"    Budget     : max {args.max_usd} USD bei {args.rate} USD/h"
          + (f" = {args.max_usd / args.rate:.2f} h" if args.rate and args.max_usd else " (aus)"))
    print(f"    Disk       : {args.disk_gb} GB (kein Network Volume - SDXL ist nur ~7 GB)")

    gpus = [g.strip() for g in args.gpu.split(",") if g.strip()]
    if args.dry_run:
        # Zugangsdaten und signierte URLs NICHT ausgeben. Die Ueberschrift
        # behauptete das vorher, gedruckt wurde trotzdem alles - ein
        # Widerruf-Risiko, sobald die Ausgabe in einem Log landet.
        cmd = _build_cmd(args.name, gpus[0], args, env, docker_args)
        geheim = [API_KEY, ENV.get("HF_TOKEN", ""), env.get("BUNDLE_URL", ""), env.get("PRESIGN_URL", "")]
        roh = " ".join(a if " " not in a else f"'{a}'" for a in cmd)
        for g in geheim:
            if g:
                roh = roh.replace(g, "<GEHEIM>")
        print("\n[--dry-run] Befehl (Zugangsdaten und signierte URLs ersetzt):")
        print("  runpodctl " + roh)
        return 0

    last_err = ""
    for i, gpu in enumerate(gpus):
        # Der Satz der KARTE bestimmt die USD-Obergrenze im Pod - nicht der
        # Satz, den der Aufrufer geraten hat. Sonst greift der Waechter zu spaet
        # (live passiert: Deckel fuer 0.33 gerechnet, Karte kostete 1.69).
        satz = rate_fuer(gpu, args.rate, args.cloud)
        env["RATE_USD_H"] = str(satz)
        deckel = f" -> Deckel {args.max_usd} USD = {args.max_usd / satz:.2f} h" if args.max_usd else " (kein Deckel)"
        print(f"  [{gpu}] {satz} USD/h{deckel}")
        cmd = _build_cmd(args.name, gpu, args, env, docker_args)
        rc, out = runpodctl(cmd, timeout=300)
        if rc == 0:
            try:
                pod = json.loads(out)
                pid = pod.get("id") or pod.get("podId")
            except json.JSONDecodeError:
                pid = None
            if not pid:
                last_err = "Antwort ohne Pod-ID"
                print(f"  {gpu}: Anlage ohne ID -> naechster Versuch")
                continue
            print(f"  {gpu}: angelegt ({pid}) - pruefe, ob er wirklich startet ...")
            if auf_start_warten(pid):
                print(f"\nangelegt auf: {gpu}\n\nPod-ID: {pid}")
                (BASE / f"pod-{args.name}.json").write_text(
                    json.dumps({"name": args.name, "id": pid, "gpu": gpu, "themes": themes,
                                "steps": args.steps, "created": int(time.time()), "raw": out},
                               indent=2)
                )
                return 0
            last_err = f"{gpu}: Pod verschwand nach der Anlage (keine Kapazitaet)"
            print(f"  {gpu}: Pod verschwand sofort -> naechste Karte "
                  f"(runpodctl meldet 'ausverkauft' trotzdem als Erfolg)")
            if i + 1 < len(gpus):
                time.sleep(5)
            continue
        last_err = out[:300]
        print(f"  {gpu}: nicht verfügbar -> nächster Versuch")
        if i + 1 < len(gpus):
            time.sleep(5)

    print(f"FEHLER: keine der Karten war verfügbar. Letzte Meldung: {last_err}")
    return 4


if __name__ == "__main__":
    raise SystemExit(main())
