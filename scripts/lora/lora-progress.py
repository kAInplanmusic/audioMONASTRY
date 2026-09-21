#!/usr/bin/env python3
"""
audioMONASTRY · VISUAL-P1-007 – Fortschrittsmarker für das Stil-LoRA-Training
============================================================================
Läuft IM RunPod-Pod (oder im Test) und beantwortet genau eine Frage:
**Wie weit ist das Training – mit Zahl, Loss und Zeitstempel?**

Warum das ein eigenes Skript ist: der Starter (`scripts/runpod-lora-train.py`)
konnte vorher nur den Pod-Zustand pollen (`RUNNING`) und wusste deshalb nicht, ob
überhaupt Schritte liefen oder die Loss fiel. Deshalb schreibt der Pod jetzt
Fortschrittsmarker als JSON-Zeilen; der Betreiber liest sie im Starter.

Aufruf (im Pod, typischerweise aus dem Trainer-Skript nach jedem Checkpoint)::

    python3 lora-progress.py --step 750 --loss 0.0812 --total-steps 2000 \
        --segment-index 1 --segment-start 0 --segment-end 1000 \
        --file /workspace/lora/progress.jsonl \
        --url "$LORA_PROGRESS_URL"                       # presigned PUT (R2)

Wirkung:
  1. eine Zeile an die Markerdatei anhängen (JSONL, Schema visual-lora-progress/1)
  2. die Markerdatei hochladen, wenn `--url` gesetzt ist (PUT, R2)
  3. optional den Checkpoint hochladen (`--checkpoint` + `--checkpoint-url`)

Der Schriftsteller ruft den Checkpoint-Upload bewusst NICHT auf: er meldet nur,
was passiert ist. In `scripts/lora/bootstrap.sh` läuft der Checkpoint-Upload
getrennt – und der Zustand `SEGMENT_DONE` (mit `checkpoint_url`) wird erst NACH
diesem Upload gesetzt, damit der Starter den Pod nicht zu früh terminiert.

Exit-Codes: 0 = Marker (und Uploads) ok · 2 = Aufruf-/Konfigfehler ·
            3 = Upload fehlgeschlagen (die lokale Markerzeile existiert trotzdem)
"""
from __future__ import annotations

import argparse
import json
import pathlib
import shutil
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple

SCHEMA = "visual-lora-progress/1"
UA = "audiomonastry-lora-progress/1 (pod)"

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_UPLOAD_FAILED = 3


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def build_marker(args: argparse.Namespace) -> Dict[str, Any]:
    """Markerzeile bauen (leere Felder werden weggelassen, nicht mit 0 erfunden)."""
    marker: Dict[str, Any] = {
        "schema": SCHEMA,
        "ts": utc_now_iso(),
        "step": int(args.step),
        "state": str(args.state),
    }
    if args.total_steps is not None:
        marker["total_steps"] = int(args.total_steps)
    if args.loss is not None:
        marker["loss"] = float(args.loss)
    if args.segment_index is not None:
        marker["segment"] = {
            "index": int(args.segment_index),
            "start_step": int(args.segment_start or 0),
            "end_step": int(args.segment_end or 0),
        }
    if args.checkpoint:
        marker["checkpoint"] = str(args.checkpoint)
    if args.checkpoint_url:
        marker["checkpoint_url"] = str(args.checkpoint_url)
    if args.checkpoint_step is not None:
        marker["checkpoint_step"] = int(args.checkpoint_step)
    if args.note:
        marker["note"] = str(args.note)
    return marker


def put_file(url: str, path: pathlib.Path, timeout: int = 300) -> Tuple[bool, str]:
    """Datei ablegen: http(s) per PUT, `file://` und reine Pfade per Kopie.

    Bewusst kein SDK und keine Signatur: der Betreiber gibt eine presigned URL
    (scripts/hetzner/lib/r2-sigv4.sh). `file://` ist die Notablage für Tests und
    für Läufe, in denen das Volume die Ablage übernimmt.
    """
    target = str(url).strip()
    if target.startswith("file://") or "://" not in target:
        destination = pathlib.Path(target[len("file://"):] if target.startswith("file://") else target)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, destination)
        return True, f"kopiert nach {destination}"
    try:
        request = urllib.request.Request(
            target,
            data=path.read_bytes(),
            method="PUT",
            headers={"User-Agent": UA, "Content-Type": "application/octet-stream"},
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:
            ok = not response.status or response.status < 400
            return ok, f"HTTP {response.status}"
    except urllib.error.HTTPError as exc:  # 403 = abgelaufene/ungueltige Signatur
        return False, f"HTTP {exc.code}"
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return False, f"{type(exc).__name__}: {exc}"


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="lora-progress.py",
        description="Fortschrittsmarker (Schritt, Loss, Zeitstempel) schreiben und hochladen.",
        epilog="Exit-Codes: 0 = ok, 2 = Aufruffehler, 3 = Upload fehlgeschlagen.",
    )
    parser.add_argument("--step", type=int, required=True, help="Trainingsschritt, der erreicht wurde.")
    parser.add_argument("--state", default="RUNNING",
                        help="Zustand: RUNNING, SEGMENT_DONE oder ERROR (Default RUNNING).")
    parser.add_argument("--file", default="", help="Markerdatei (JSONL); jede Zeile ein Marker.")
    parser.add_argument("--total-steps", type=int, default=None, help="Gesamtschritte des Laufs (für Prozent).")
    parser.add_argument("--loss", type=float, default=None, help="Trainingsverlust an diesem Schritt.")
    parser.add_argument("--url", default="", help="Ziel für den Marker-Upload (presigned PUT / file://).")
    parser.add_argument("--checkpoint", default="", help="Pfad des Checkpoints (wird nur im Marker vermerkt).")
    parser.add_argument("--checkpoint-url", default="", help="Presigned PUT-URL des Checkpoints (Info im Marker).")
    parser.add_argument("--checkpoint-step", type=int, default=None, help="Schrittnummer des Checkpoints.")
    parser.add_argument("--segment-index", type=int, default=None, help="Nummer des Abschnitts.")
    parser.add_argument("--segment-start", type=int, default=None, help="Erster Schritt des Abschnitts.")
    parser.add_argument("--segment-end", type=int, default=None, help="Zielschritt des Abschnitts.")
    parser.add_argument("--note", default="", help="Freitext (z. B. Ursache eines Fehlers).")
    parser.add_argument("--quiet", action="store_true", help="Nichts auf stdout ausgeben.")
    args = parser.parse_args(argv)

    marker_path = pathlib.Path(args.file) if args.file else None
    if marker_path is None:
        print("FEHLER: --file fehlt (Pfad der Markerdatei)", file=sys.stderr)
        return EXIT_USAGE

    marker = build_marker(args)
    line = json.dumps(marker, ensure_ascii=False) + "\n"
    try:
        marker_path.parent.mkdir(parents=True, exist_ok=True)
        with marker_path.open("a", encoding="utf-8") as handle:
            handle.write(line)
    except OSError as exc:
        print(f"FEHLER: Markerdatei nicht schreibbar ({marker_path}): {exc}", file=sys.stderr)
        return EXIT_USAGE

    if not args.quiet:
        print(f"[progress] Schritt {marker['step']}"
              + (f" | Loss {marker['loss']}" if "loss" in marker else "")
              + f" | Zustand {marker['state']} -> {marker_path}")

    failures = []
    # Der Checkpoint wird NICHT von diesem Skript hochgeladen (das macht
    # bootstrap.sh vor dem SEGMENT_DONE-Marker) – hier wird nur festgehalten,
    # WO er liegt und WOHIN er geht, damit der naechste Abschnitt ihn findet.
    uploads = [("Marker", args.url, marker_path)]
    for label, url, path in uploads:
        if not url:
            continue
        ok, detail = put_file(url, path)
        if not ok:
            failures.append(f"{label}-Upload fehlgeschlagen ({detail})")
        elif not args.quiet:
            print(f"[progress] {label} hochgeladen: {detail}")

    if failures:
        for entry in failures:
            print(f"FEHLER: {entry}", file=sys.stderr)
        print("Die Markerzeile liegt lokal vor; der Upload muss wiederholt werden.", file=sys.stderr)
        return EXIT_UPLOAD_FAILED
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
