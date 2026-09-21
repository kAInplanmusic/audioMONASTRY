#!/usr/bin/env python3
"""
audioMONASTRY · VISUAL-P1-007 – Schritt 4: Stil-LoRA-Training auf einem RunPod-POD
==================================================================================
Erstellt für einen Trainingslauf einen **Pod** (nicht Serverless), übergibt den
Datensatz-Auftrag an den Pod und **terminiert den Pod danach wieder**. Der
Trainingslauf selbst ist ein GPU-Job und läuft beim Betreiber.

Harte Regel dieses Skripts: **Kostenrechnung zuerst, dann Freigabe, dann erst API.**
Ohne Freigabe wird kein einziger HTTP-Aufruf gesendet – das `runpod`-SDK wird
vor dem Gate nicht einmal importiert (der Test
`tests/test_visual_lora_pipeline.py` belegt genau das).

Abschnittsbetrieb (Entscheidung des Betreibers 2026-09-22)
---------------------------------------------------------
Das Training wird NICHT in einem langen Lauf gefahren, sondern in Abschnitten
(„1000 Schritte, dann wieder 1000, …"). Ein Abschnitt ist ein eigener Pod-Lauf:

  1. Abschnitt starten (--segment 1 | --segment auto)
  2. Fortschritt verfolgen: der Pod schreibt Fortschrittsmarker (Schritt, Loss,
     Zeitstempel) nach R2; der Starter liest sie und zeigt sie an – statt nur den
     Pod-Zustand zu pollen.
  3. Ergebnis sichern: der Pod lädt Checkpoint + Fortschrittsmarker nach R2 hoch.
  4. Pod terminieren (Kostenstopp) – der Starter bricht ab, sobald der Marker den
     Abschnitt als fertig meldet (`state=SEGMENT_DONE`, gesetzt NACH dem Upload).
  5. Nächster Abschnitt setzt aus dem Checkpoint fort (--segment auto liest den
     Marker: Schritt + Checkpoint-URL).

Warum: der erste Lauf (A40 secure, 0,49 USD/h) lief 90,4 min in die harte
Laufzeitgrenze und wurde abgebrochen – 0,74 USD, KEIN LoRA. Die Planrechnung
(3700 Schritte × 2,0 s/Schritt = 123 min) passte nie in ein 90-min-Fenster; das
Skript hat das vorher NICHT gemerkt. Deshalb die VORAB-RECHNUNG (s. u.).

Modi
----
  --plan                 Nur rechnen: Pod-Plan + Kostenrechnung. Kein API-Aufruf. (Default)
  --train                Voller Lauf: Plan → Vorab-Rechnung → Gate → Pod anlegen →
                         überwachen (Zustand UND Fortschritt) → terminieren
  --terminate <pod-id>   Not-Aus/Aufräumen: terminiert einen Pod sofort.
                         Braucht bewusst KEINE Kostenfreigabe – dieser Aufruf beendet
                         Ausgaben, er beginnt keine. Prüft die Terminierung nach.

VORAB-RECHNUNG (Abbruch VOR dem Gate, Exit 2)
---------------------------------------------
  Kaltstart + Abschnittsschritte × s/Schritt  >  Laufzeitgrenze        → ABBRUCH

  Geprüft wird der Abschnitt (das ist die Arbeit EINES Pod-Laufs), nicht der
  Gesamtlauf: was nicht in ein Fenster passt, wird in Abschnitte geteilt
  (--segment-steps). Nur wenn schon der Abschnitt zu groß ist, bricht der Lauf ab:
  dann stimmt die Aufteilung nicht. `--allow-overrun` erzwingt den Lauf bewusst
  (nur für Tests/absichtliche Hängerläufe, nie für einen echten Trainingslauf).

Freigabe-Gate (beide Bedingungen, sonst Exit 3)
-----------------------------------------------
  LORA_APPROVE_SPEND=1            ausdrückliche Freigabe des Betreibers
  KOSTENBESTAETIGUNG=<betrag>     bestätigter Betrag in der Planwährung, muss
                                  >= harter Obergrenze sein (Alias: LORA_COST_CONFIRM)

Kostenrechnung (keine erfundenen Zahlen)
----------------------------------------
  Kosten = Stundensatz × Zeit
  Zeit_Plan  = Kaltstart + Training + Aufräumen
  Zeit_max   = Kaltstart + LORA_MAX_RUNTIME_MINUTES + Aufräumen   ← harte Obergrenze,
               der Pod wird spätestens dann terminiert
  Stundensatz: PFLICHTWERT des Betreibers (--price-per-hour / LORA_GPU_PRICE_PER_H).
               Quelle zum Ablesen: `runpodctl gpu list` (Felder `securePricePerHr` /
               `communityPricePerHr`) – das Skript erfindet keinen Preis und liest
               ihn auch nicht selbst (jeder API-Lesе wäre schon ein API-Aufruf).

Umgebungsvariablen (CLI schlägt Env, Env schlägt --env-file):
  Preis/Zeit   LORA_GPU_PRICE_PER_H, LORA_CURRENCY, LORA_USD_EUR,
               LORA_STARTUP_MINUTES, LORA_TRAIN_MINUTES, LORA_SECONDS_PER_STEP,
               LORA_TEARDOWN_MINUTES, LORA_MAX_RUNTIME_MINUTES
  Abschnitte   LORA_STEPS (Gesamtschritte, Default 2000), LORA_SEGMENT_STEPS
               (Schritte je Abschnitt, Default 1000), LORA_SEGMENT (Nummer oder
               "auto"), LORA_RESUME_FROM, LORA_CHECKPOINT_EVERY (Default 250),
               LORA_CHECKPOINT_DIR, LORA_CHECKPOINT_PUT_URL,
               LORA_ALLOW_OVERRUN (VORAB-RECHNUNG bewusst übergehen)
  Fortschritt  LORA_PROGRESS_PUT_URL (Pod schreibt), LORA_PROGRESS_GET_URL
               (Starter liest), LORA_PROGRESS_FILE (im Pod),
               LORA_PROGRESS_STALE_MINUTES (Default 15)
  Pod          LORA_POD_NAME, LORA_GPU_TYPE, LORA_CLOUD_TYPE, LORA_POD_IMAGE,
               LORA_POD_TEMPLATE_ID, LORA_CONTAINER_DISK_GB, LORA_NETWORK_VOLUME_ID,
               LORA_VOLUME_MOUNT, LORA_POD_DOCKER_ARGS, LORA_DATASET_URL, LORA_RESULT_URL,
               LORA_KEEP_POD_ON_FAIL, LORA_POLL_SECONDS
  Zugang       RP_AGENT_KEY / RP_API_KEY / RUNPOD_API_KEY, HF_TOKEN (optional)

Exit-Codes
----------
  0 = Lauf erfolgreich (Pod angelegt, beendet, terminiert; Ergebnis geprüft)
  2 = Aufruf-/Konfigurationsfehler (fehlender Preis/Pod-Parameter, SDK fehlt, Name belegt)
      ODER die VORAB-RECHNUNG passt nicht (Abschnitt größer als die Laufzeitgrenze) –
      in beiden Fällen: KEIN API-Aufruf, kein Pod, keine Kosten
  3 = Freigabe fehlt oder bestätigter Betrag zu niedrig → KEIN API-Aufruf
  4 = Lauf fehlgeschlagen/abgebrochen (Pod wurde trotzdem terminiert)
  5 = Lauf beendet, aber kein Ergebnis-Artefakt gefunden (LORA_RESULT_URL gesetzt)

Siehe docs/VISUAL_LORA_TRAINING.md für den Betreiber-Ablauf, die Kostenrechnung,
den Abschnittsbetrieb (Checkpoints/Resume/Fortschrittsmarker) und die ehrlichen
Grenzen (u. a. der Trainer-Befehl im Pod ist ungeprüft).
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

# Gemeinsame Helfer aus scripts/lib/ (Pfad relativ zur eigenen Datei, damit das
# Skript direkt UND per importlib aus tests/ laeuft).
_LIB = pathlib.Path(__file__).resolve().parents[0] / "lib"
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))
from envfile import EnvSource, read_env_file  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_ENV_FILE = ROOT / ".env"

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_GATE = 3
EXIT_RUN_FAILED = 4
EXIT_NO_ARTIFACT = 5

#: Pod-Typ für das Training. Der Standardwert ist der im Runpod-Skill live
#: verifizierte Trainings-Pod (Golden Path 04: RTX 4090, LoRA-Training, EU-RO-1).
#: Die Bild-Rolle der Flotte (`imageHq`) läuft auf `AMPERE_48` (A6000/A40, 48 GB);
#: für ein Stil-LoRA ist die 24-GB-Karte ausreichend, bei VRAM-Mangel größer
#: wählen (`--gpu-type`, z. B. `NVIDIA RTX A6000`).
DEFAULT_GPU_TYPE = "NVIDIA GeForce RTX 4090"
DEFAULT_CLOUD_TYPE = "SECURE"

#: Kaltstart (Image-Pull + Gewichte) eines Bild-Workers, gemessen 2026-09-11:
#: 15–25 min (docs/VISUALMONK_SPEC.md, Abschnitt „Live-Versuch").
#: Für eine Pod-Karte mit großem Trainer-Image gilt dieselbe Größenordnung.
DEFAULT_STARTUP_MINUTES = 20.0

#: Aufräumen/Ergebnis-Upload nach dem Training (Planungsannahme, s. Doku).
DEFAULT_TEARDOWN_MINUTES = 5.0

#: ANNAHME, kein Messwert: Sekunden je Trainingsschritt. Streut stark nach
#: Modell/Auflösung/Batch und Karte. Wird im Kostenblock als Annahme
#: ausgewiesen und muss vom Betreiber durch einen Messwert ersetzt werden
#: (`--seconds-per-step`), sobald ein Lauf gemessen wurde.
DEFAULT_SECONDS_PER_STEP = 2.0

#: Harte Obergrenze der Laufzeit (Minuten): nach dieser Zeit wird der Pod
#: terminiert, egal was das Training tut. Begrenzt die Kosten nach oben.
DEFAULT_MAX_RUNTIME_MINUTES = 90.0

#: Euro-Umrechnung – der Satz, den das Repo selbst benutzt
#: (docs/AI_COST_GUIDE.md, „Preisquellen": $2.50/h ≈ 2,30 €/h → 0,92). Nur für
#: die Anzeige; gerechnet und bestätigt wird in der Planwährung (Default USD).
DEFAULT_USD_EUR = 0.92

#: Schrittzahl des GESAMTlaufs, wenn weder --steps noch --images angegeben ist.
#: BETREIBER-ENTSCHEIDUNG 2026-09-22: statt eines langen Laufs werden Abschnitte
#: gefahren; 2000 Schritte sind die dafür vereinbarte Zielgröße.
DEFAULT_STEPS = 2000

#: Schritte je Abschnitt (= ein Pod-Lauf). Der Abschnitt muss in die
#: Laufzeitgrenze passen – genau das prüft die VORAB-RECHNUNG.
DEFAULT_SEGMENT_STEPS = 1000

#: Checkpoint-Intervall in Schritten: so oft schreibt der Trainer einen
#: Zwischenstand, aus dem der nächste Abschnitt fortsetzen kann. Kleiner als der
#: Abschnitt, damit ein Abbruch bei Schritt ~900 nicht 900 Schritte kostet.
DEFAULT_CHECKPOINT_EVERY = 250

#: Ab wie vielen Minuten ohne neuen Fortschrittsmarker der Starter warnt.
DEFAULT_PROGRESS_STALE_MINUTES = 15.0

#: Schema des Fortschrittsmarkers (eine JSON-Zeile je Marker; der Starter liest
#: die LETZTE Zeile). Der Pod schreibt ihn, der Starter liest ihn.
PROGRESS_SCHEMA = "visual-lora-progress/1"

#: Zustände, die einen ABGESCHLOSSENEN Abschnitt melden. `SEGMENT_DONE` setzt der
#: In-Pod-Runner (scripts/lora/bootstrap.sh) NACH dem Checkpoint-Upload – deshalb
#: ist dieser Zustand das gefahrlose Signal, den Pod zu terminieren.
SEGMENT_DONE_STATES = {"SEGMENT_DONE"}

#: Preis eines RunPod-Network-Volumes in USD je GB und Monat (Betreiber-Angabe
#: 2026-09-22: 0,05 USD/GB/Monat). Wie der GPU-Satz eine BETREIBER-EINGABE, keine
#: Erfindung des Skripts – nachprüfbar in der RunPod-Preisliste.
DEFAULT_VOLUME_PRICE_PER_GB_MONTH = 0.05

#: Kaltstart-Annahme für einen Abschnitt OHNE vorgestagtes Volume: Image-Pull
#: 15-25 min (gemessen) PLUS Download der Basisgewichte (~24 GB) – der Betreiber
#: nennt dafür ~30 min (Messung 2026-09-22). Nur für die Anzeige der Mehrkosten.
DEFAULT_COLDSTART_WITHOUT_VOLUME_MINUTES = 30.0

#: Terminale Zustände eines Pods (defensiv gelesen – die SDK-Antwort nennt den
#: Zustand je nach Version `desiredStatus`, `runtimeStatus` oder `status`).
TERMINAL_STATES = {"EXITED", "TERMINATED", "STOPPED", "FAILED", "DEAD"}
RUNNING_STATES = {"RUNNING", "STARTING", "CREATED", "PROVISIONING", ""}


# ---------------------------------------------------------------------------
# Env-Auflösung (Prozess-Env vor .env-Datei, dotenv-Verhalten)
# ---------------------------------------------------------------------------
# `read_env_file` und `EnvSource` liegen in scripts/lib/envfile.py und werden
# oben importiert - dieselbe Bauart nutzt der Warmhalter (runpod-warm.py).


# ---------------------------------------------------------------------------
# Kostenrechnung (rein, testbar)
# ---------------------------------------------------------------------------
def plan_steps(images: int, repeats: int, epochs: int, batch_size: int) -> int:
    """Trainingsschritte aus Datensatzgröße (wie der Trainer sie zählt)."""
    images = max(0, int(images))
    repeats = max(1, int(repeats))
    epochs = max(1, int(epochs))
    batch_size = max(1, int(batch_size))
    return int(math.ceil(images * repeats * epochs / batch_size))


def resolve_segment(
    total_steps: int,
    segment_steps: int,
    *,
    segment_index: Optional[int] = None,
    resume_step: Optional[int] = None,
) -> Dict[str, Any]:
    """Abschnitt bestimmen, den dieser Pod-Lauf fährt (rein, kein Zustand).

    Zwei Wege, und die Rangfolge ist Absicht:

    * `segment_index` (--segment N) gewinnt: der Betreiber nennt den Abschnitt,
      der Start liegt auf dem Raster (N-1) × segment_steps. Damit ist ein Lauf
      wiederholbar, auch wenn kein Fortschrittsmarker lesbar ist.
    * sonst entscheidet der FORTSCHRITTSMARKER (`resume_step` = zuletzt gemeldeter
      Schritt, also der des letzten Checkpoints): die Arbeit geht AB diesem Schritt
      weiter, endet aber am Ende des Rasters, in dem er liegt. Nach einem Abbruch
      bei Schritt 250 wird also derselbe Abschnitt zu Ende gefahren (250 → 1000);
      nichts wird wiederholt und kein neuer Abschnitt begonnen.

    `finished` heißt: für diesen Abschnitt ist nichts mehr zu tun (alle Schritte
    erreicht) – dann wird VOR dem Gate abgebrochen, es entstehen keine Kosten.
    """
    total = max(0, int(total_steps))
    size = max(1, int(segment_steps))
    count = int(math.ceil(total / size)) if total > 0 else 0

    if segment_index is not None:
        index = max(1, int(segment_index))
        start = (index - 1) * size
        end = min(total, start + size)
        source = "cli"
    else:
        start = max(0, min(int(resume_step or 0), total))
        index = (start // size + 1) if total > start else max(1, count)
        end = min(total, index * size) if total > start else start
        source = "marker" if resume_step else "erstlauf"

    return {
        "index": index,
        "count": count,
        "size": size,
        "start_step": start,
        "end_step": end,
        "steps": max(0, end - start),
        "total_steps": total,
        "finished": end <= start,
        "is_last": total == 0 or end >= total,
        "source": source,
        "seconds_per_step_is_assumption": True,
    }


def segment_label(segment: Dict[str, Any]) -> str:
    """Kurztext eines Abschnitts, z. B. „Abschnitt 1/2: Schritte 0-1000"."""
    if segment.get("finished"):
        return f"Abschnitt {segment['index']}/{max(1, segment['count'])}: nichts mehr zu tun"
    if segment.get("steps") is None or segment.get("end_step") is None:
        # --train-minutes: der Betreiber gibt die Dauer vor, es gibt kein Raster.
        return "ein Lauf ohne Abschnittsraster (Trainingsdauer vorgegeben)"
    return (
        f"Abschnitt {segment['index']}/{max(1, segment['count'])}: "
        f"Schritte {segment['start_step']}-{segment['end_step']}"
        f" ({segment['steps']} Schritte)"
    )


def compute_plan(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Kosten- und Zeitplan eines Trainingslaufs.

    `price_per_hour` ist keine Annahme des Skripts, sondern Eingabe des
    Betreibers (s. Modulkopf). Alle Zeiten sind Planwerte; die **harte
    Obergrenze** ist der Betrag, der nicht überschritten werden kann, weil der
    Pod spätestens nach `max_runtime_minutes` terminiert wird.
    """
    price = float(cfg["price_per_hour"])
    startup = float(cfg["startup_minutes"])
    teardown = float(cfg["teardown_minutes"])
    max_runtime = float(cfg["max_runtime_minutes"])

    steps = cfg.get("steps")
    if steps is None and cfg.get("train_minutes") is None:
        steps = plan_steps(cfg["images"], cfg["repeats"], cfg["epochs"], cfg["batch_size"])
    train_minutes = cfg.get("train_minutes")
    if train_minutes is None:
        seconds_per_step = float(cfg["seconds_per_step"])
        step_count = int(steps or 0)
        train_minutes = round(step_count * seconds_per_step / 60.0, 2)
    else:
        seconds_per_step = None
        steps = None

    hours_plan = (startup + float(train_minutes) + teardown) / 60.0
    hours_max = (startup + max_runtime + teardown) / 60.0
    usd_eur = float(cfg.get("usd_eur") or 0.0)

    return {
        "price_per_hour": price,
        "currency": cfg.get("currency", "USD"),
        "seconds_per_step": seconds_per_step,
        "steps": steps,
        "train_minutes": round(float(train_minutes), 2),
        "startup_minutes": startup,
        "teardown_minutes": teardown,
        "max_runtime_minutes": max_runtime,
        "hours_plan": round(hours_plan, 4),
        "hours_max": round(hours_max, 4),
        "cost_plan": round(price * hours_plan, 4),
        "cost_max": round(price * hours_max, 4),
        "cost_plan_eur": round(price * hours_plan * usd_eur, 4) if usd_eur else None,
        "cost_max_eur": round(price * hours_max * usd_eur, 4) if usd_eur else None,
        "usd_eur": usd_eur or None,
    }


def cost_block(
    plan: Dict[str, Any],
    cfg: Dict[str, Any],
    segment: Optional[Dict[str, Any]] = None,
    total_plan: Optional[Dict[str, Any]] = None,
) -> List[str]:
    """Menschenlesbarer Kostenblock (wird VOR dem Gate gedruckt).

    `plan` ist der Plan DIESES Pod-Laufs (im Abschnittsbetrieb: des Abschnitts).
    `total_plan` ist der Gesamtlauf über alle Abschnitte – er wird nur angezeigt,
    damit die Summe der Obergrenzen sichtbar ist (bezahlt wird Abschnitt für
    Abschnitt, jeder mit eigener Freigabe).
    """
    currency = plan["currency"]
    lines = [
        "Kostenrechnung (Planwerte, kein Messwert):",
        f"  Stundensatz         : {plan['price_per_hour']:.4g} {currency}/h "
        f"(Eingabe des Betreibers; Quelle zum Ablesen: runpodctl gpu list)",
        f"  Kaltstart           : {plan['startup_minutes']:.0f} min "
        f"(gemessen 2026-09-11: Bild-Worker-Pull 15-25 min, docs/VISUALMONK_SPEC.md)",
    ]
    if segment:
        lines.append(f"  Abschnitt           : {segment_label(segment)} (Quelle: {segment.get('source')})")
    if plan["steps"] is not None:
        lines.append(
            f"  Training            : {plan['train_minutes']:.2f} min "
            f"= {plan['steps']} Schritte x {plan['seconds_per_step']:.2f} s/Schritt (ANNAHME, kein Messwert)"
        )
    else:
        lines.append(f"  Training            : {plan['train_minutes']:.2f} min (vom Betreiber vorgegeben)")
    lines.append(f"  Aufräumen/Upload    : {plan['teardown_minutes']:.0f} min")
    lines.append(
        f"  -> Plan            : {plan['hours_plan']:.2f} h = {plan['cost_plan']:.2f} {currency}"
        + (f" (~{plan['cost_plan_eur']:.2f} EUR)" if plan.get("cost_plan_eur") else "")
    )
    lines.append(
        f"  -> HARTE OBERGRENZE: {plan['hours_max']:.2f} h = {plan['cost_max']:.2f} {currency} "
        f"(Kaltstart + max. {plan['max_runtime_minutes']:.0f} min Laufzeit + Aufräumen; "
        f"der Pod wird spaetestens dann terminiert)"
        + (f" (~{plan['cost_max_eur']:.2f} EUR)" if plan.get("cost_max_eur") else "")
    )
    if total_plan and segment and (total_plan.get("steps") or 0) > (plan.get("steps") or 0):
        segments = max(1, int(segment["count"]))
        worst = total_plan["cost_max"] * segments
        lines.append(
            f"  Gesamtlauf          : {total_plan['steps']} Schritte x {total_plan['seconds_per_step']:.2f} s/Schritt "
            f"= {total_plan['train_minutes']:.2f} min -> {segments} Abschnitte "
            f"zu je max. {total_plan['max_runtime_minutes']:.0f} min"
        )
        lines.append(
            f"  -> Obergrenze ALLER {segments} Abschnitte zusammen: {worst:.2f} {currency} "
            f"(Kaltstart und Aufräumen fallen je Abschnitt an) – freigegeben wird trotzdem je Abschnitt"
            + (f" (~{worst * float(total_plan.get('usd_eur') or 0):.2f} EUR)" if total_plan.get("usd_eur") else "")
        )
    if cfg.get("checkpoint_every"):
        lines.append(
            f"  Checkpoints         : alle {int(cfg['checkpoint_every'])} Schritte nach "
            f"{cfg.get('checkpoint_dir')} (Resume-Grundlage des naechsten Abschnitts)"
        )
    if cfg.get("progress_read_url"):
        lines.append("  Fortschritt         : Marker werden gelesen (URL = Bearer-Token, wird nicht ausgegeben)")
    elif cfg.get("progress_upload_url"):
        lines.append(
            "  Fortschritt         : der Pod schreibt Marker hoch, der Starter liest sie NICHT "
            "(kein --progress-read-url) – Anzeige bleibt beim Pod-Polling"
        )
    lines.extend(volume_cost_lines(cfg, segment, plan))
    if cfg.get("keep_pod_on_fail"):
        lines.append(
            "  WARNUNG: LORA_KEEP_POD_ON_FAIL=1 - ein fehlgeschlagener Lauf laesst den Pod laufen "
            "(er kostet weiter, bis er terminiert wird)"
        )
    return lines


def runtime_check(
    *,
    startup_minutes: float,
    train_minutes: float,
    max_runtime_minutes: float,
    steps: Optional[int] = None,
    seconds_per_step: Optional[float] = None,
) -> Dict[str, Any]:
    """VORAB-RECHNUNG: passt die geplante Arbeit dieses Pod-Laufs ins Zeitfenster?

    Geprüft wird genau die Rechnung, die den ersten Lauf 0,74 USD gekostet hat::

        Kaltstart + Schritte × Sekunden_je_Schritt  >  Laufzeitgrenze

    Ist sie wahr, wird der Lauf VOR dem Gate abgebrochen (Exit 2) – es entsteht
    kein Pod und keine Ausgabe. `seconds_per_step` bleibt eine ANNAHME (Default
    2,0), bis ein Lauf einen Messwert geliefert hat; das steht auch in der
    Abbruchmeldung, damit die Zahl nicht für gemessen gehalten wird.
    """
    need = float(startup_minutes) + float(train_minutes)
    window = float(max_runtime_minutes)
    return {
        "ok": need <= window + 1e-9,
        "need_minutes": round(need, 4),
        "train_minutes": round(float(train_minutes), 4),
        "startup_minutes": float(startup_minutes),
        "window_minutes": window,
        "overrun_minutes": round(max(0.0, need - window), 4),
        "margin_minutes": round(window - need, 4),
        "steps": steps,
        "seconds_per_step": seconds_per_step,
        "seconds_per_step_is_assumption": True,
    }


def runtime_check_lines(check: Dict[str, Any], *, currency: str = "USD", price_per_hour: float = 0.0,
                        allow_overrun: bool = False) -> List[str]:
    """Zeilen der VORAB-RECHNUNG – bei Überlauf die laute Abbruchbegründung."""
    if check.get("steps") is not None:
        work = (
            f"{check['steps']} Schritte x {float(check['seconds_per_step'] or 0):.2f} s/Schritt "
            f"(ANNAHME, kein Messwert) = {check['train_minutes']:.2f} min"
        )
    else:
        work = f"vom Betreiber vorgegebene Trainingsdauer = {check['train_minutes']:.2f} min"
    head = "VORAB-RECHNUNG: " + ("passt ins Laufzeitfenster" if check["ok"] else "PASST NICHT ins Laufzeitfenster")
    lines = [head]
    lines.append(
        f"  Kaltstart {check['startup_minutes']:.2f} min + Training {work}"
        f" = {check['need_minutes']:.2f} min"
    )
    lines.append(f"  Laufzeitgrenze (--max-runtime-minutes): {check['window_minutes']:.2f} min")
    if check["ok"]:
        lines.append(f"  Reserve: {check['margin_minutes']:.2f} min")
        return lines
    extra_hours = check["overrun_minutes"] / 60.0  # Überschreitung in Stunden (nur für die Meldung)
    lines.append(
        f"  UEBERSCHREITUNG: {check['overrun_minutes']:.2f} min ({extra_hours:.2f} h) – der Pod wuerde ab der "
        f"Grenze terminiert, die Arbeit waere NICHT fertig (und trotzdem bezahlt)."
    )
    if price_per_hour:
        wasted = price_per_hour * check["window_minutes"] / 60.0
        lines.append(
            f"  Bisher einmal passiert (A40 secure, 0,49 USD/h): 90,4 min Lauf, Abbruch an der Grenze, "
            f"0,74 USD, kein LoRA. Verbrannt waeren hier bis zu {wasted:.4f} {currency} ohne Ergebnis."
        )
    lines.append("  Drei Wege heraus (in dieser Reihenfolge):")
    lines.append(
        "    1) Abschnitt kleiner machen: --segment-steps verkleinern (Standard 1000) "
        "und/oder --steps senken"
    )
    lines.append(
        f"    2) Laufzeitgrenze bewusst erhoehen: --max-runtime-minutes <groesser als {check['need_minutes']:.1f}> "
        f"– die harte Obergrenze und damit der zu bestaetigende Betrag steigen mit"
    )
    lines.append(
        "    3) Messwert statt Annahme: --seconds-per-step <gemessen> – erst damit rechnet der Plan mit der Wahrheit"
    )
    if allow_overrun:
        lines.append("  --allow-overrun war gesetzt: der Lauf wird TROTZDEM versucht (bewusste Entscheidung).")
    return lines


def volume_cost(
    size_gb: Optional[float],
    price_per_gb_month: float = DEFAULT_VOLUME_PRICE_PER_GB_MONTH,
    usd_eur: float = 0.0,
) -> Dict[str, Any]:
    """Kosten eines RunPod-Network-Volumes (rein, testbar).

    Ein Volume rechnet MONATLICH, nicht pro Lauf: es läuft weiter, solange es
    existiert – auch wenn kein Pod läuft. Deshalb steht der Monatsbetrag im
    Kostenblock, und der Löschbefehl gleich daneben.
    """
    size = float(size_gb or 0)
    monthly = size * float(price_per_gb_month or 0)
    return {
        "size_gb": size or None,
        "price_per_gb_month": float(price_per_gb_month or 0),
        "usd_per_month": round(monthly, 4),
        "eur_per_month": round(monthly * float(usd_eur or 0), 4) if usd_eur else None,
        "known": bool(size > 0),
    }


def volume_cost_lines(
    cfg: Dict[str, Any],
    segment: Optional[Dict[str, Any]] = None,
    plan: Optional[Dict[str, Any]] = None,
) -> List[str]:
    """Kostenhinweis + Löschbefehl für das Network Volume (--print-config und Plan).

    Ohne Volume läuft das Skript weiter – aber dann zahlt JEDER Abschnitt den
    Kaltstart neu (Image-Pull 15-25 min gemessen + ~24 GB Gewichte). Das wird
    hier beziffert, damit die Entscheidung nicht im Dunkeln fällt.
    """
    currency = str((plan or {}).get("currency") or cfg.get("currency") or "USD")
    price = float((plan or {}).get("price_per_hour") or cfg.get("price_per_hour") or 0.0)
    usd_eur = float(cfg.get("usd_eur") or 0.0)
    segments = max(1, int((segment or {}).get("count") or 1))
    lines: List[str] = []

    if not cfg.get("volume_id"):
        coldstart_hours = DEFAULT_COLDSTART_WITHOUT_VOLUME_MINUTES / 60.0
        per_segment = price * coldstart_hours
        lines.append(
            "Volume              : KEINES gesetzt (--volume-id) – jeder Abschnitt laedt die Basisgewichte "
            f"(~24 GB) und das Image neu: ~{DEFAULT_COLDSTART_WITHOUT_VOLUME_MINUTES:.0f} min Kaltstart je Abschnitt "
            f"(Betreiber-Messung 2026-09-22; Kaltstart-Annahme im Plan: {float((plan or {}).get('startup_minutes') or cfg.get('startup_minutes') or 0):.0f} min)"
        )
        if segments > 1:
            lines.append(
                f"  -> {segments} Abschnitte x ~{coldstart_hours:.2f} h Kaltstart = {segments * coldstart_hours:.2f} h "
                f"= {segments * per_segment:.4f} {currency} NUR Kaltstart"
                + (f" (~{segments * per_segment * usd_eur:.4f} EUR)" if usd_eur else "")
                + " – mit einem Network Volume entfaellt der Gewichte-Download"
            )
        lines.append(
            "  Anlegen (Betreiber): runpodctl network-volume create --name audiomonastry-lora "
            "--size <GB> --data-center-id <DC-des-Pods>   # DC muss zur Karte passen"
        )
        lines.append(
            "  Einmalig fuellen (CPU-Pod, NICHT GPU): bash scripts/lora/vorstaging.sh --volume <mount> "
            "--model black-forest-labs/FLUX.1-dev --dataset-url <url> --dataset-key <stabile Kennung>"
        )
        return lines

    cost = volume_cost(cfg.get("volume_size_gb"), cfg.get("volume_price_per_gb_month") or 0.0, usd_eur)
    if cost["known"]:
        lines.append(
            f"Volume              : {cost['size_gb']:.0f} GB x {cost['price_per_gb_month']:.2f} {currency}/GB/Monat "
            f"= {cost['usd_per_month']:.2f} {currency}/Monat"
            + (f" (~{cost['eur_per_month']:.2f} EUR/Monat)" if cost.get("eur_per_month") else "")
            + " – laeuft monatlich weiter, solange das Volume existiert (auch ohne Pod!)"
        )
    else:
        lines.append(
            f"Volume              : {cfg['volume_id']} gemountet nach {cfg.get('volume_mount')} – Groesse unbekannt "
            "(--volume-size-gb fehlt), Monatskosten nicht berechenbar "
            f"(Preis: {cost['price_per_gb_month']:.2f} {currency}/GB/Monat)"
        )
    lines.append(
        f"  Vorgestagte Daten : Gewichte (HF_HOME={cfg.get('hf_home')}), Datensatz ({cfg.get('dataset_dir_in_pod')}), "
        "Trainer-Checkout – der Abschnittsstart ueberspringt Downloads, die schon im Volume liegen"
    )
    lines.append(
        f"  Loeschen NACH dem Training (sonst laufen die Monatskosten weiter): "
        f"runpodctl network-volume delete {cfg['volume_id']}"
    )
    return lines


def mask_value(value: Any) -> str:
    """Geheimnisse nie ausgeben: presigned URLs sind Bearer-Token.

    (`scripts/hetzner/lib/r2-sigv4.sh` sagt dasselbe für R2-URLs: sie werden nie
    von selbst ausgegeben.) Deshalb steht hier nur, OB etwas gesetzt ist.
    """
    return "gesetzt (Wert wird nicht ausgegeben)" if value else "nicht gesetzt"


def parse_amount(value: Any) -> Optional[float]:
    """Betrag aus einer Eingabe lesen (Komma und Punkt als Dezimaltrenner)."""
    if value is None:
        return None
    text = str(value).strip().replace("€", "").replace("$", "").replace(" ", "")
    if not text:
        return None
    if "," in text and "." in text:
        text = text.replace(".", "").replace(",", ".")
    elif "," in text:
        text = text.replace(",", ".")
    try:
        return float(text)
    except ValueError:
        return None


def gate_check(
    *,
    approve: bool,
    confirm_amount: Optional[float],
    required_amount: float,
    currency: str,
) -> Tuple[bool, str]:
    """Freigabe-Gate: Freigabeflag UND bestätigter Betrag >= harte Obergrenze.

    Bewusst rein (kein Netz, kein SDK): diese Funktion entscheidet, ob überhaupt
    ein API-Aufruf entstehen darf.
    """
    if not approve:
        return False, (
            "Freigabe fehlt: LORA_APPROVE_SPEND=1 (oder --approve-spend) wurde nicht gesetzt"
        )
    if confirm_amount is None:
        return False, (
            f"KOSTENBESTAETIGUNG fehlt: bitte den Betrag >= {required_amount:.4f} {currency} "
            "ausdrücklich nennen (Alias: LORA_COST_CONFIRM)"
        )
    if confirm_amount + 1e-9 < required_amount:
        return False, (
            f"KOSTENBESTAETIGUNG {confirm_amount:.4f} {currency} liegt unter der harten Obergrenze "
            f"{required_amount:.4f} {currency} – Freigabe deckt den Lauf nicht"
        )
    return True, (
        f"Freigabe erteilt: {confirm_amount:.4f} {currency} bestätigt, "
        f"Obergrenze {required_amount:.4f} {currency}"
    )


# ---------------------------------------------------------------------------
# Fortschrittsmarker (Pod schreibt, Starter liest)
# ---------------------------------------------------------------------------
# Der Pod legt je Ereignis eine JSON-Zeile nach $LORA_WORK/progress.jsonl und
# laedt die Datei nach R2 (presigned PUT). Der Starter liest sie (presigned GET)
# und zeigt Schritt/Loss/Zeitstempel an – statt nur „Pod laeuft". Der Vertrag ist
# bewusst klein: der Starter braucht nur `step` und optional `loss`, `state` und
# `checkpoint_url`.
def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def build_marker(
    *,
    step: int,
    total_steps: Optional[int] = None,
    loss: Optional[float] = None,
    state: str = "RUNNING",
    segment: Optional[Dict[str, Any]] = None,
    checkpoint: Optional[str] = None,
    checkpoint_url: Optional[str] = None,
    checkpoint_step: Optional[int] = None,
    ts: Optional[str] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Einen Fortschrittsmarker bauen (rein; der Pod schreibt ihn als JSON-Zeile)."""
    marker: Dict[str, Any] = {
        "schema": PROGRESS_SCHEMA,
        "ts": ts or utc_now_iso(),
        "step": int(step),
        "state": str(state),
    }
    if total_steps is not None:
        marker["total_steps"] = int(total_steps)
    if loss is not None:
        marker["loss"] = float(loss)
    if segment:
        marker["segment"] = {
            "index": segment.get("index"),
            "start_step": segment.get("start_step"),
            "end_step": segment.get("end_step"),
        }
    if checkpoint:
        marker["checkpoint"] = str(checkpoint)
    if checkpoint_url:
        marker["checkpoint_url"] = str(checkpoint_url)
    if checkpoint_step is not None:
        marker["checkpoint_step"] = int(checkpoint_step)
    if extra:
        marker.update(extra)
    return marker


def _as_int(value: Any) -> Optional[int]:
    """Zahl aus einem Marker-Feld lesen (None, wenn nicht lesbar)."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def marker_line(marker: Dict[str, Any]) -> str:
    """Marker als kompakte JSON-Zeile (so schreibt ihn der Pod)."""
    return json.dumps(marker, ensure_ascii=False) + "\n"


def parse_marker(text: str) -> Optional[Dict[str, Any]]:
    """Letzte GUELTIGE Marker-Zeile lesen (kaputte/leere Zeilen werden uebersprungen).

    Liefert `None`, wenn keine Zeile lesbar ist – der Aufrufer muss den
    Unterschied zwischen „kein Marker" und „Marker sagt Schritt 0" kennen.
    """
    last: Optional[Dict[str, Any]] = None
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict):
            continue
        step = _as_int(entry.get("step"))
        if step is None:
            continue
        entry["step"] = step
        last = entry
    return last


def marker_age_minutes(marker: Optional[Dict[str, Any]], now: Optional[float] = None) -> Optional[float]:
    """Alter eines Markers in Minuten (None, wenn kein Zeitstempel lesbar ist)."""
    if not marker or not marker.get("ts"):
        return None
    raw = str(marker["ts"]).strip().replace("Z", "+00:00")
    try:
        stamp = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    reference = now if now is not None else time.time()
    return round((reference - stamp.timestamp()) / 60.0, 2)


def segment_complete(marker: Optional[Dict[str, Any]], segment: Optional[Dict[str, Any]]) -> bool:
    """Meldet der Marker den Abschnitt als FERTIG?

    Bewusst NICHT „Schritt >= Ziel": der Checkpoint-Upload laeuft NACH dem letzten
    Trainingsschritt. Wuerde der Starter den Pod zu diesem Zeitpunkt terminieren,
    waere der Abschnitt verloren. `state=SEGMENT_DONE` setzt bootstrap.sh erst
    nach dem Checkpoint-Upload.
    """
    if not marker or not segment:
        return False
    state = str(marker.get("state") or "").upper()
    end = _as_int(segment.get("end_step"))
    step = _as_int(marker.get("step"))
    reached = end is None or (step is not None and step >= end)
    return state in SEGMENT_DONE_STATES and reached


def format_progress_lines(
    marker: Optional[Dict[str, Any]],
    *,
    segment: Optional[Dict[str, Any]] = None,
    stale_minutes: float = DEFAULT_PROGRESS_STALE_MINUTES,
    detail: str = "",
    now: Optional[float] = None,
) -> List[str]:
    """Anzeigezeilen für den Starter (Schritt, Loss, Zeitstempel, Warnungen)."""
    if marker is None:
        hint = f" ({detail})" if detail else ""
        return [f"Fortschritt: kein Fortschrittsmarker lesbar{hint} – Anzeige bleibt beim Pod-Zustand"]
    step = int(marker["step"])
    total = marker.get("total_steps")
    part = f"Schritt {step}"
    if total:
        part += f"/{int(total)} ({100.0 * step / float(total):.1f}%)"
    if segment and not segment.get("finished"):
        part += f" | {segment_label(segment)}"
    loss = marker.get("loss")
    if loss is not None:
        try:
            part += f" | Loss {float(loss):.4f}"
        except (TypeError, ValueError):
            part += f" | Loss {loss}"
    state = str(marker.get("state") or "?")
    part += f" | Zustand {state} | Marker {marker.get('ts')}"
    age = marker_age_minutes(marker, now)
    lines = [f"Fortschritt: {part}" + (f" (vor {age:.2f} min)" if age is not None else "")]
    if age is not None and age > float(stale_minutes):
        lines.append(
            f"  WARNUNG: seit {age:.2f} min kein neuer Marker (Grenze {stale_minutes:.0f} min) – "
            "Trainer haengt, meldet nichts oder schreibt nicht nach R2. Log im Pod pruefen, "
            "notfalls mit --terminate <pod-id> Kosten stoppen."
        )
    if segment_complete(marker, segment):
        lines.append(
            f"  ABSCHNITT FERTIG: Checkpoint liegt in R2 (Marker-Zustand {state}) – der Pod wird jetzt "
            "terminiert (Kostenstopp); der naechste Abschnitt setzt daraus fort."
        )
    return lines


def fetch_text(url: str, timeout: int = 20) -> Tuple[bool, str]:
    """Text von einer URL holen (http/https oder file://). Nur lesend, kein SDK.

    Bewusst dieselbe Bauart wie `http_ok`: der Starter liest den Fortschritt mit
    Boardmitteln (urllib) – eine Signatur/Bibliothek fuer R2 waere ein weiterer
    beweglicher Teil, den niemand braucht (der Betreiber gibt eine presigned URL,
    siehe scripts/hetzner/lib/r2-sigv4.sh).
    """
    try:
        request = urllib.request.Request(
            url, headers={"User-Agent": "audiomonastry-lora-progress"}
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:
            if response.status and response.status >= 400:
                return False, f"HTTP {response.status}"
            return True, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return False, f"HTTP {exc.code}"
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return False, f"{type(exc).__name__}: {exc}"


def read_progress(url: str, timeout: int = 20) -> Tuple[Optional[Dict[str, Any]], str]:
    """Fortschrittsmarker lesen. Liefert (marker|None, Klartext zum Zustand)."""
    ok, payload = fetch_text(url, timeout=timeout)
    if not ok:
        return None, f"nicht lesbar: {payload}"
    marker = parse_marker(payload)
    if marker is None:
        return None, "erreichbar, aber keine gueltige Marker-Zeile"
    return marker, f"gelesen ({len(payload)} B)"


# ---------------------------------------------------------------------------
# Pod-Auftrag (Job-Spezifikation für den Pod)
# ---------------------------------------------------------------------------
def resolve_resume(cfg: Dict[str, Any], marker: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Wo setzt dieser Abschnitt fort? (rein, kein Zustand)

    Rangfolge: `--resume-from` (Betreiber) schlägt den Fortschrittsmarker, der
    Marker schlägt „auto" (der Pod nimmt den neuesten Checkpoint auf dem Volume).
    `from_step` ist der Schritt, ab dem dieser Abschnitt zählt – er kommt aus dem
    Marker (letzter gemeldeter Schritt), nicht aus einer Annahme.
    """
    explicit = str(cfg.get("resume_from") or "").strip()
    marker_url = (marker or {}).get("checkpoint_url")
    marker_step = _as_int((marker or {}).get("checkpoint_step"))
    if marker_step is None:
        marker_step = _as_int((marker or {}).get("step"))
    if explicit and explicit.lower() not in ("auto", "latest", "neuester", "marker"):
        return {"mode": "cli", "resume_from": explicit, "from_step": cfg["segment"]["start_step"],
                "marker_step": marker_step,
                "source": "--resume-from", "hint": "Betreiber hat den Checkpoint ausdruecklich genannt"}
    if marker_url:
        return {"mode": "marker", "resume_from": str(marker_url), "from_step": cfg["segment"]["start_step"],
                "marker_step": marker_step,
                "source": "Fortschrittsmarker", "hint": "Checkpoint-URL aus dem Marker (Segment zuvor hochgeladen)"}
    return {"mode": "auto", "resume_from": "auto", "from_step": cfg["segment"]["start_step"],
            "marker_step": marker_step,
            "source": "auto", "hint": "Pod nimmt den neuesten Checkpoint aus --checkpoint-dir (Volume)"}


def build_job_spec(cfg: Dict[str, Any], plan: Dict[str, Any]) -> Dict[str, Any]:
    """Auftrag, den der Pod beim Start liest (siehe scripts/lora/bootstrap.sh).

    Enthält seit dem Abschnittsbetrieb auch das Abschnittsziel (`train.max_steps`,
    `train.segment`), die Checkpoint-Regeln (`train.save_every_steps`,
    `train.checkpoint_dir`, `train.resume_from`) und den Fortschrittsspeicher
    (`progress.*`) – der Pod braucht keine zweite Quelle für diese Angaben.
    """
    segment = cfg.get("segment") or {}
    resume = cfg.get("resume") or {}
    return {
        "schema": "visual-lora-job/1",
        "ticket": "VISUAL-P1-007",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "name": cfg["pod_name"],
        "dataset": {
            "url": cfg.get("dataset_url") or None,
            "dir": cfg.get("dataset_dir_in_pod"),
            "sha256": cfg.get("dataset_sha256") or None,
            # Idempotenz: liegt der Datensatz schon im (Network-)Volume, wird der
            # Download im Pod uebersprungen (Nachweis im STATUS: "uebersprungen: ...").
            "reuse_existing": bool(cfg.get("dataset_reuse_existing", True)),
        },
        "volume": {
            "id": cfg.get("volume_id") or None,
            "mount": cfg.get("volume_mount"),
            "hf_home": cfg.get("hf_home"),
            # Der Pod meldet im STATUS, ob die Gewichte vorgestaged waren.
            "prestaged_report": f"{(cfg.get('volume_mount') or '').rstrip('/')}/vorstaging/report.json",
            "note": "Network Volume (einmalig vorgestaged mit scripts/lora/vorstaging.sh auf einem CPU-Pod): "
                    "Gewichte + Datensatz + Trainer-Checkout liegen dort und werden beim Abschnittsstart "
                    "uebersprungen. Preis 0,05 USD/GB/Monat – nach dem Training loeschen.",
        },
        "train": {
            "command": cfg.get("train_command") or None,
            "output_dir": cfg.get("output_dir_in_pod"),
            "expected_glob": cfg.get("expected_glob"),
            # Abschnitt: bis hierher wird trainiert (Ende des Abschnitts)
            "max_steps": segment.get("end_step"),
            "segment": dict(segment) if segment else None,
            # Resume: "auto" = neuester Checkpoint auf dem Volume; sonst URL/Pfad
            "resume_from": resume.get("resume_from") or cfg.get("resume_from") or "auto",
            "save_every_steps": cfg.get("checkpoint_every"),
            "checkpoint_dir": cfg.get("checkpoint_dir"),
            "checkpoint_upload_url": cfg.get("checkpoint_upload_url") or None,
            "hf_home": cfg.get("hf_home"),
            "base_model": cfg.get("base_model") or None,
        },
        "progress": {
            "upload_url": cfg.get("progress_upload_url") or None,
            "read_url": cfg.get("progress_read_url") or None,
            "file": cfg.get("progress_file_in_pod"),
        },
        "result": {
            "upload_url": cfg.get("result_url") or None,
        },
        "limits": {
            "max_runtime_minutes": plan["max_runtime_minutes"],
            "cost_max": plan["cost_max"],
            "currency": plan["currency"],
        },
        "note": (
            "Erzeugt von scripts/runpod-lora-train.py. Der Pod fuehrt den Auftrag "
            "ueber scripts/lora/bootstrap.sh aus; ohne Freigabe des Betreibers wurde "
            "dieser Auftrag nie an RunPod gesendet. Der Pod trainiert NUR bis "
            "train.max_steps (Ende des Abschnitts), laedt Checkpoint + "
            "Fortschrittsmarker hoch und beendet sich – danach terminiert der "
            "Starter den Pod (Kostenstopp)."
        ),
    }


def create_pod_kwargs(cfg: Dict[str, Any], job_spec: Dict[str, Any]) -> Dict[str, Any]:
    """Argumente für `runpod.create_pod` (rein baubar, daher testbar ohne Netz).

    Bild-/Disk-Felder kommen nur, wenn kein Template gesetzt ist – ein Template
    bringt sein eigenes Image mit.
    """
    pod_env: Dict[str, str] = {
        # Der Pod liest den Auftrag aus dem Env (base64, damit keine
        # Quoting-Probleme in docker_args/JSON entstehen).
        "LORA_JOB_SPEC_B64": base64.b64encode(
            json.dumps(job_spec, ensure_ascii=False).encode("utf-8")
        ).decode("ascii"),
        # Gewichte + Datensatz + Ausgabe gehören auf das (DC-gebundene) Volume,
        # sonst ist die Container-Disk nach dem Terminieren weg. HF_HOME zeigt auf
        # den vorstaged Bereich des Volumens: liegen die Gewichte dort schon
        # (scripts/lora/vorstaging.sh auf einem CPU-Pod), entfaellt der
        # ~24-GB-Download im teuren GPU-Pod.
        "HF_HOME": str(cfg.get("hf_home") or f"{cfg['volume_mount']}/hf-cache"),
        "HF_HUB_ENABLE_HF_TRANSFER": str(cfg.get("hf_hub_enable_hf_transfer") or "1"),
    }
    hf_token = cfg.get("hf_token")
    if hf_token:
        pod_env["HF_TOKEN"] = hf_token
    for name, value in (cfg.get("extra_env") or {}).items():
        pod_env[str(name)] = str(value)

    kwargs: Dict[str, Any] = {
        "name": cfg["pod_name"],
        "gpu_type_id": cfg["gpu_type"],
        "gpu_count": int(cfg.get("gpu_count", 1)),
        "cloud_type": cfg["cloud_type"],
        "container_disk_in_gb": int(cfg["container_disk_gb"]),
        "start_ssh": True,
        "env": pod_env,
    }
    if cfg.get("template_id"):
        kwargs["template_id"] = cfg["template_id"]
    else:
        kwargs["image_name"] = cfg["image"]
    if cfg.get("docker_args"):
        kwargs["docker_args"] = cfg["docker_args"]
    if cfg.get("volume_id"):
        kwargs["network_volume_id"] = cfg["volume_id"]
        kwargs["volume_mount_path"] = cfg["volume_mount"]
    return kwargs


# ---------------------------------------------------------------------------
# SDK + Pod-Zustand (erst NACH dem Gate erreichbar)
# ---------------------------------------------------------------------------
_RUNPOD: Any = None


def sdk() -> Any:
    """`runpod` erst hier importieren – vor dem Gate darf das SDK nicht existieren."""
    global _RUNPOD
    if _RUNPOD is None:
        try:
            import runpod  # type: ignore  # noqa: PLC0415
        except ImportError as exc:  # pragma: no cover - nur ohne SDK
            raise RuntimeError(
                "RunPod-SDK fehlt (pip install runpod) – "
                "der Pod kann ohne SDK nicht angelegt werden"
            ) from exc
        _RUNPOD = runpod
    return _RUNPOD


def pod_state(pod: Any) -> str:
    """Zustand eines Pods defensiv lesen (Feldname variiert je SDK-Version)."""
    if not isinstance(pod, dict):
        return ""
    for key in ("desiredStatus", "runtimeStatus", "status"):
        value = pod.get(key)
        if value:
            return str(value).upper()
    runtime = pod.get("runtime")
    if isinstance(runtime, dict):
        for key in ("status", "desiredStatus"):
            value = runtime.get(key)
            if value:
                return str(value).upper()
    return ""


def http_ok(url: str, timeout: int = 20) -> Tuple[bool, str]:
    """Ergebnis-Artefakt per HEAD/GET prüfen (nur lesend)."""
    for method in ("HEAD", "GET"):
        try:
            request = urllib.request.Request(
                url,
                headers={"User-Agent": "audiomonastry-lora-result-check"},
                method=method,
            )
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.status < 400, f"HTTP {response.status} ({method})"
        except urllib.error.HTTPError as exc:
            if method == "GET":
                return False, f"HTTP {exc.code} ({method})"
        except (urllib.error.URLError, OSError) as exc:
            if method == "GET":
                return False, f"{type(exc).__name__} ({method})"
    return False, "nicht erreichbar"


def write_report(path: pathlib.Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# Lauf
# ---------------------------------------------------------------------------
def terminate_pod(pod_id: str, verify_attempts: int = 3, verify_delay: float = 2.0) -> Tuple[bool, str]:
    """Pod terminieren UND die Terminierung nachprüfen (Kosten wirklich gestoppt)."""
    runpod = sdk()
    runpod.terminate_pod(pod_id)
    last = ""
    for attempt in range(max(1, verify_attempts)):
        try:
            pod = runpod.get_pod(pod_id)
        except Exception as exc:  # noqa: BLE001 - jede Fehlerform ist hier "unbestätigt"
            last = f"get_pod nach terminate fehlgeschlagen: {type(exc).__name__}: {exc}"
            time.sleep(verify_delay)
            continue
        state = pod_state(pod)
        if pod is None:
            return True, "terminiert (get_pod liefert keinen Pod mehr)"
        if state in TERMINAL_STATES:
            return True, f"terminiert (Zustand {state or 'unbekannt'})"
        last = f"Zustand nach terminate: {state or 'unbekannt'}"
        time.sleep(verify_delay)
    return False, f"Terminierung NICHT bestaetigt – bitte pruefen: runpodctl pod list ({last})"


def run_training(cfg: Dict[str, Any], plan: Dict[str, Any]) -> int:
    runpod = sdk()
    api_key = cfg["api_key"]
    runpod.api_key = api_key

    # --- Preflight (kein Anlegen, keine Kosten) ------------------------------
    try:
        existing = runpod.get_pods() or []
    except Exception as exc:  # noqa: BLE001
        print(f"[lora] WARNUNG: Pod-Liste nicht lesbar ({type(exc).__name__}) – Doppelname nicht geprueft", file=sys.stderr)
        existing = []
    for pod in existing:
        if isinstance(pod, dict) and str(pod.get("name") or "") == cfg["pod_name"]:
            print(
                f"FEHLER: es gibt bereits einen Pod namens {cfg['pod_name']} "
                f"(id={pod.get('id')}). Erst aufraeumen: "
                f"python3 scripts/runpod-lora-train.py --terminate {pod.get('id')}",
                file=sys.stderr,
            )
            return EXIT_USAGE

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    report_path = pathlib.Path(cfg.get("report_dir") or (ROOT / "logs" / "lora-runs")) / f"{stamp}-{cfg['pod_name']}.json"
    report: Dict[str, Any] = {
        "schema": "visual-lora-run/1",
        "ticket": "VISUAL-P1-007",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "pod_name": cfg["pod_name"],
        "plan": plan,
        "plan_total": cfg.get("plan_total"),
        "segment": cfg.get("segment"),
        "resume": cfg.get("resume"),
        "gate": cfg["gate"],
        "pod": {"gpu_type": cfg["gpu_type"], "cloud_type": cfg["cloud_type"],
                "template_id": cfg.get("template_id"), "image": cfg.get("image"),
                "volume_id": cfg.get("volume_id"), "max_runtime_minutes": cfg["max_runtime_minutes"]},
        "job_spec": build_job_spec(cfg, plan),
        "progress": {"read_url": cfg.get("progress_read_url"), "upload_url": cfg.get("progress_upload_url"),
                     "last_marker": None, "read_detail": None, "stale_warned": False, "segment_done": False},
        "events": [],
    }

    def event(message: str) -> None:
        line = f"{datetime.now(timezone.utc).isoformat()} {message}"
        report["events"].append(line)
        print(f"[lora] {message}")

    pod_id = ""
    status = "unbekannt"
    artifact: Optional[Dict[str, Any]] = None
    started = time.time()
    deadline = started + float(cfg["max_runtime_minutes"]) * 60.0
    failure = ""
    progress_done = False
    # Der letzte Abschnitt liefert das LoRA; Zwischenabschnitte liefern Checkpoints.
    # Deshalb wird das Ergebnis-Artefakt nur im letzten Abschnitt verlangt.
    segment = cfg.get("segment") or {}
    require_artifact = bool(cfg.get("result_url")) and bool(segment.get("is_last", True))

    try:
        kwargs = create_pod_kwargs(cfg, report["job_spec"])
        event(f"lege Pod an: {cfg['pod_name']} | {cfg['gpu_type']} | {cfg['cloud_type']} | Template/Image: "
              f"{cfg.get('template_id') or cfg.get('image')}")
        if segment:
            event(f"{segment_label(segment)} | Resume: {report['resume'] and report['resume']['resume_from']} "
                  f"({report['resume'] and report['resume']['source']})")
        created = runpod.create_pod(**kwargs)
        pod_id = str((created or {}).get("id") or "")
        if not pod_id:
            failure = f"create_pod lieferte keine Pod-ID: {str(created)[:200]}"
            event(f"FEHLER: {failure}")
            return EXIT_RUN_FAILED
        report["pod"]["id"] = pod_id
        # Sofort persistieren: bricht der Lauf hier ab, ist die Pod-ID schriftlich da.
        write_report(report_path, report)
        shown_path = str(report_path.relative_to(ROOT)) if report_path.is_relative_to(ROOT) else str(report_path)
        event(f"Pod angelegt: {pod_id} (Report: {shown_path}) – "
              f"harte Obergrenze {plan['max_runtime_minutes']:.0f} min")

        while True:
            time.sleep(float(cfg["poll_seconds"]))
            try:
                pod = runpod.get_pod(pod_id)
            except Exception as exc:  # noqa: BLE001
                event(f"Statusabfrage fehlgeschlagen: {type(exc).__name__}")
                pod = None
            status = pod_state(pod)
            if pod is not None:
                event(f"Zustand: {status or 'unbekannt'} | elapsed {int(time.time() - started)}s")

            # --- Fortschritt: Schritt/Loss/Zeitstempel statt nur Pod-Zustand ---
            marker: Optional[Dict[str, Any]] = None
            if cfg.get("progress_read_url"):
                marker, detail = read_progress(str(cfg["progress_read_url"]))
                report["progress"]["read_detail"] = detail
                for line in format_progress_lines(
                    marker,
                    segment=segment or None,
                    stale_minutes=float(cfg.get("progress_stale_minutes") or DEFAULT_PROGRESS_STALE_MINUTES),
                ):
                    event(line)
                if marker is not None:
                    report["progress"]["last_marker"] = marker
                    age = marker_age_minutes(marker)
                    stale_limit = float(cfg.get("progress_stale_minutes") or DEFAULT_PROGRESS_STALE_MINUTES)
                    if age is not None and age > stale_limit:
                        report["progress"]["stale_warned"] = True

            if require_artifact:
                ok, detail = http_ok(str(cfg["result_url"]))
                if ok:
                    artifact = {"url": cfg["result_url"], "check": detail}
                    event(f"Ergebnis-Artefakt gefunden: {detail}")
                    break

            # --- Abschnitt fertig: Checkpoint ist hochgeladen, Pod kann weg ------
            if marker is not None and cfg.get("progress_read_url") and segment_complete(marker, segment or None):
                report["progress"]["segment_done"] = True
                progress_done = True
                event(f"Abschnittsziel erreicht (Schritt {marker.get('step')} von {segment.get('end_step')}) – "
                      "Checkpoint liegt in R2. Pod wird terminiert (Kostenstopp), der naechste Abschnitt "
                      "setzt daraus fort.")
                break

            if status in TERMINAL_STATES:
                break
            if time.time() >= deadline:
                failure = f"harte Laufzeitgrenze erreicht ({plan['max_runtime_minutes']:.0f} min) – Pod wird terminiert"
                event(f"ABBRUCH: {failure}")
                break

        if not failure and require_artifact and not artifact:
            failure = "Lauf beendet, aber das Ergebnis-Artefakt (LORA_RESULT_URL) fehlt"
            event(f"FEHLER: {failure}")
        elif not failure and cfg.get("result_url") and not require_artifact:
            event(f"Zwischenabschnitt ({segment_label(segment)}): das LoRA im Ergebnis-Artefakt wird erst im "
                  "letzten Abschnitt erwartet – Erfolg wird hier am Fortschrittsmarker/Checkpoint gemessen")
        elif not failure and not cfg.get("result_url"):
            event("kein LORA_RESULT_URL gesetzt – Erfolg wird nicht am Artefakt gemessen "
                  "(Ergebnis auf dem Volume pruefen: LoRA-Datei + train.log)")
    except Exception as exc:  # noqa: BLE001 - jeder Fehler muss zur Terminierung fuehren
        failure = f"{type(exc).__name__}: {exc}"
        event(f"FEHLER im Lauf: {failure}")
    finally:
        if pod_id:
            keep = bool(cfg.get("keep_pod_on_fail")) and bool(failure)
            if keep:
                event("WARNUNG: LORA_KEEP_POD_ON_FAIL=1 – Pod bleibt absichtlich am Leben (kostet weiter!)")
                report["pod"]["terminated"] = False
                report["pod"]["termination_detail"] = "absichtlich behalten (LORA_KEEP_POD_ON_FAIL=1)"
            else:
                event(f"terminiere Pod {pod_id} …")
                ok, detail = terminate_pod(pod_id)
                report["pod"]["terminated"] = ok
                report["pod"]["termination_detail"] = detail
                event(("Aufraeumen ok: " if ok else "WARNUNG: ") + detail)
                if not ok:
                    failure = failure or detail
        report.update(
            {
                "finished_at": datetime.now(timezone.utc).isoformat(),
                "final_state": status,
                "artifact": artifact,
                "failure": failure or None,
                "status": "failed" if failure else "ok",
                "next_segment": next_segment_hint(cfg, report),
            }
        )
        write_report(report_path, report)

    if not failure and progress_done and not cfg.get("keep_pod_on_fail"):
        print(
            "[lora] Abschnitt beendet und Pod terminiert. Naechster Abschnitt: dieselben Argumente "
            "+ --segment auto (liest den Fortschrittsmarker und setzt aus dem Checkpoint fort)."
        )
    if failure:
        return EXIT_NO_ARTIFACT if "Artefakt" in failure and pod_id else EXIT_RUN_FAILED
    return EXIT_OK


def next_segment_hint(cfg: Dict[str, Any], report: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Was ist nach diesem Abschnitt zu tun? (im Report, damit es schriftlich bleibt)"""
    segment = cfg.get("segment") or {}
    marker = (report.get("progress") or {}).get("last_marker") or {}
    step = _as_int(marker.get("step"))
    total = _as_int(marker.get("total_steps")) or _as_int(segment.get("total_steps"))
    if not segment:
        return None
    if report.get("progress", {}).get("segment_done") or (
        step is not None and total is not None and total > 0 and step >= total
    ):
        return {"done": True, "reason": f"alle Schritte erreicht (Marker: {step}/{total})", "steps_done": step,
                "total_steps": total}
    return {
        "done": False,
        "reason": "Abschnitt nicht abgeschlossen" if not report.get("progress", {}).get("segment_done") else "offen",
        "steps_done": step,
        "total_steps": total,
        "command": "--segment auto (mit denselben Argumenten erneut starten; der Pod setzt ab dem Checkpoint fort)",
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="runpod-lora-train.py",
        description="Stil-LoRA-Training auf einem RunPod-Pod mit Kostenrechnung und Freigabe-Gate (VISUAL-P1-007).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Exit-Codes: 0 = ok, 2 = Aufruffehler, 3 = keine Freigabe (kein API-Aufruf), "
            "4 = Lauf fehlgeschlagen (Pod terminiert), 5 = kein Ergebnis-Artefakt.\n"
            "Ohne --train (bzw. --terminate) wird nur geplant und gerechnet – kein API-Aufruf."
        ),
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--plan", action="store_true", help="Nur rechnen (Default): Pod-Plan + Kosten, kein API-Aufruf.")
    mode.add_argument("--train", action="store_true", help="Voller Lauf: Gate, Pod anlegen, überwachen, terminieren.")
    mode.add_argument("--terminate", "--terminate-pod", metavar="POD_ID", dest="terminate",
                      help="Pod sofort terminieren (Not-Aus/Aufräumen).")
    mode.add_argument("--print-config", action="store_true", dest="print_config",
                      help="Wirksame Konfiguration ausgeben (ohne Geheimnisse, ohne API-Aufruf): "
                           "Abschnitt, Volume, Kosten des Volumens, Löschbefehl.")

    parser.add_argument("--approve-spend", action="store_true", help="Freigabe erteilen (auch per LORA_APPROVE_SPEND=1).")
    parser.add_argument("--cost-confirm", metavar="BETRAG", default=None,
                        help="Bestätigter Betrag in der Planwährung (auch per KOSTENBESTAETIGUNG).")
    parser.add_argument("--price-per-hour", type=float, default=None,
                        help="GPU-Stundensatz des Pods (auch per LORA_GPU_PRICE_PER_H). Quelle: runpodctl gpu list.")
    parser.add_argument("--currency", default=None, help="Planwährung (Default USD).")
    parser.add_argument("--usd-eur", type=float, default=None, help="Nur Anzeige: EUR je USD (Default 0.92).")
    parser.add_argument("--startup-minutes", type=float, default=None, help="Kaltstart-Annahme in Minuten (Default 20).")
    parser.add_argument("--train-minutes", type=float, default=None,
                        help="Trainingsdauer in Minuten (sonst aus Schritten gerechnet).")
    parser.add_argument("--images", type=int, default=None, help="Bilder im Datensatz (für die Schrittzahl).")
    parser.add_argument("--steps", type=int, default=None,
                        help=f"Schritte des GESAMTlaufs (Default {DEFAULT_STEPS}; --images rechnet sie sonst aus).")
    parser.add_argument("--repeats", type=int, default=10, help="num_repeats des Datensatzes (Default 10).")
    parser.add_argument("--epochs", type=int, default=10, help="Epochen (Default 10).")
    parser.add_argument("--batch-size", type=int, default=1, help="batch_size (Default 1).")
    parser.add_argument("--seconds-per-step", type=float, default=None,
                        help="ANNAHME s/Schritt für die Kostenschätzung (Default 2.0; mit Messwert ersetzen).")
    parser.add_argument("--teardown-minutes", type=float, default=None, help="Aufräumen/Upload in Minuten (Default 5).")
    parser.add_argument("--max-runtime-minutes", type=float, default=None,
                        help="Harte Laufzeitgrenze in Minuten (Default 90); danach wird der Pod terminiert.")

    # --- Abschnittsbetrieb ---------------------------------------------------
    parser.add_argument("--segment-steps", type=int, default=None,
                        help=f"Schritte je Abschnitt = ein Pod-Lauf (Default {DEFAULT_SEGMENT_STEPS}).")
    parser.add_argument("--segment", default=None, metavar="N|auto",
                        help="Abschnitt fahren: Nummer (1,2,…) oder 'auto' (aus dem Fortschrittsmarker fortsetzen).")
    parser.add_argument("--resume-from", default=None, metavar="URL|PFAD|auto",
                        help="Checkpoint, aus dem fortgesetzt wird (Default auto: neuester in --checkpoint-dir).")
    parser.add_argument("--checkpoint-every", type=int, default=None,
                        help=f"Checkpoint alle N Schritte (Default {DEFAULT_CHECKPOINT_EVERY}).")
    parser.add_argument("--checkpoint-dir", default=None,
                        help="Checkpoint-Verzeichnis IM Pod (Default <volume>/lora/ckpt; muss AUSSERHALB von "
                             "--output-dir-in-pod liegen).")
    parser.add_argument("--checkpoint-upload-url", default=None,
                        help="Presigned PUT-URL für den Checkpoint des Abschnitts (auch LORA_CHECKPOINT_PUT_URL).")
    parser.add_argument("--allow-overrun", action="store_true",
                        help="VORAB-RECHNUNG bewusst übergehen (nur für Tests/absichtliche Hängerläufe).")

    # --- Fortschrittsmarker --------------------------------------------------
    parser.add_argument("--progress-read-url", default=None,
                        help="URL des Fortschrittsmarkers, den der Starter liest (auch LORA_PROGRESS_GET_URL).")
    parser.add_argument("--progress-upload-url", default=None,
                        help="Presigned PUT-URL, an die der Pod den Marker schreibt (auch LORA_PROGRESS_PUT_URL).")
    parser.add_argument("--progress-file-in-pod", default=None,
                        help="Pfad der Markerdatei IM Pod (Default /workspace/lora/progress.jsonl).")
    parser.add_argument("--progress-stale-minutes", type=float, default=None,
                        help=f"Warnung, wenn der Marker älter ist (Default {DEFAULT_PROGRESS_STALE_MINUTES:.0f} min).")

    parser.add_argument("--pod-name", default=None, help="Pod-Name (Default audiomonastry-lora-<zeit>).")
    parser.add_argument("--gpu-type", default=None, help=f"Pod-GPU-Typ (Default {DEFAULT_GPU_TYPE}).")
    parser.add_argument("--cloud-type", default=None, choices=["SECURE", "COMMUNITY"],
                        help="SECURE (Default) oder COMMUNITY – der Preis muss zur Wahl passen.")
    parser.add_argument("--image", default=None, help="Container-Image des Pods (oder --template-id).")
    parser.add_argument("--template-id", default=None, help="RunPod-Template des Pods (schlägt --image).")
    parser.add_argument("--container-disk-gb", type=int, default=None, help="Container-Disk in GB (Default 50).")
    parser.add_argument("--volume-id", default=None,
                        help="Netz-Volume (empfohlen: Gewichte/Ausgabe überleben den Pod).")
    parser.add_argument("--volume-mount", default=None, help="Mount-Pfad des Volumes (Default /workspace).")
    parser.add_argument("--volume-size-gb", type=float, default=None,
                        help="Größe des Network Volumes in GB (für den Monatskosten-Hinweis; auch LORA_VOLUME_SIZE_GB).")
    parser.add_argument("--volume-price-per-gb-month", type=float, default=None,
                        help=f"Preis des Volumes je GB/Monat (Default {DEFAULT_VOLUME_PRICE_PER_GB_MONTH} USD; auch "
                             "LORA_VOLUME_PRICE_PER_GB_MONTH). Betreiber-Eingabe aus der RunPod-Preisliste.")
    parser.add_argument("--hf-home", default=None,
                        help="HF_HOME im Pod (Default <volume-mount>/hf-cache); dort liegen die vorgestagten Gewichte.")
    parser.add_argument("--base-model", default=None,
                        help="HF-Kennung der Basisgewichte (z. B. black-forest-labs/FLUX.1-dev); der Pod meldet, "
                             "ob sie vorgestaged sind (auch LORA_BASE_MODEL).")
    parser.add_argument("--no-dataset-reuse", action="store_true",
                        help="Datensatz im Pod IMMER neu laden (Default: liegt er schon im Volume, wird der "
                             "Download uebersprungen).")
    parser.add_argument("--docker-args", default=None, help="Startbefehl im Pod (auch per LORA_POD_DOCKER_ARGS).")
    parser.add_argument("--train-command", default=None,
                        help="Trainer-Kommando IM Pod (auch per LORA_TRAIN_COMMAND); landet im Pod-Auftrag.")
    parser.add_argument("--dataset-url", default=None, help="URL des Datensatzes, den der Pod lädt (auch LORA_DATASET_URL).")
    parser.add_argument("--dataset-sha256", default=None, help="Erwartete Prüfsumme des Datensatzes (optional, wird im Auftrag mitgegeben).")
    parser.add_argument("--dataset-dir-in-pod", default="/workspace/lora-dataset", help="Zielverzeichnis des Datensatzes im Pod.")
    parser.add_argument("--output-dir-in-pod", default="/workspace/lora-out", help="Ausgabeverzeichnis des LoRA im Pod.")
    parser.add_argument("--expected-glob", default="*.safetensors", help="Dateimuster des LoRA im Pod (Erfolgskontrolle).")
    parser.add_argument("--result-url", default=None,
                        help="Presigned PUT/GET-URL des LoRA (auch LORA_RESULT_URL); dient als Erfolgssignal.")
    parser.add_argument("--env", action="append", default=[], metavar="KEY=VALUE",
                        help="Weitere Env-Variable für den Pod (mehrfach angebbar).")
    parser.add_argument("--poll-seconds", type=float, default=None, help="Sekunden zwischen Statusabfragen (Default 30).")
    parser.add_argument("--report-dir", default=None,
                        help="Ablage der Lauf-Reports (Default logs/lora-runs; auch LORA_REPORT_DIR).")
    parser.add_argument("--keep-pod-on-fail", action="store_true",
                        help="Pod bei Fehlschlag NICHT terminieren (kostet weiter – bewusst).")
    parser.add_argument("--env-file", default=str(DEFAULT_ENV_FILE),
                        help="Env-Datei (Default .env; 'none' = nur Prozess-Env).")
    parser.add_argument("--quiet", action="store_true", help="Kostenblock kompakt ausgeben.")
    return parser


def resolve_config(args: argparse.Namespace) -> Tuple[Dict[str, Any], List[str]]:
    """CLI + Env zu einer Konfiguration verbinden; liefert (cfg, fehlende Pflichtfelder)."""
    env_file = None if str(args.env_file).strip().lower() in ("none", "-", "") else pathlib.Path(args.env_file)
    env = EnvSource(env_file)
    missing: List[str] = []

    def pick(cli_value: Any, env_name: str, default: Any = None) -> Any:
        if cli_value is not None:
            return cli_value
        raw = env.get(env_name)
        if raw:
            return raw
        return default

    price_raw = pick(args.price_per_hour, "LORA_GPU_PRICE_PER_H", None)
    price = None
    if price_raw is not None:
        price = parse_amount(price_raw)
    if price is None or price <= 0:
        missing.append(
            "Stundensatz des Pods (--price-per-hour / LORA_GPU_PRICE_PER_H) – "
            "Quelle zum Ablesen: runpodctl gpu list (securePricePerHr/communityPricePerHr) "
            "oder die RunPod-Preisseite; das Skript erfindet keinen Preis"
        )

    currency = str(pick(args.currency, "LORA_CURRENCY", "USD")).upper()
    usd_eur = parse_amount(pick(args.usd_eur, "LORA_USD_EUR", DEFAULT_USD_EUR)) or 0.0

    images = int(parse_amount(pick(args.images, "LORA_IMAGES", 0)) or 0)
    train_minutes = pick(args.train_minutes, "LORA_TRAIN_MINUTES", None)
    train_minutes = parse_amount(train_minutes) if train_minutes is not None else None
    seconds_per_step = parse_amount(pick(args.seconds_per_step, "LORA_SECONDS_PER_STEP", DEFAULT_SECONDS_PER_STEP))

    # Gesamtschritte: --steps schlägt --images; ohne beides gilt der Default
    # (BETREIBER-ENTSCHEIDUNG: 2000 Schritte, in Abschnitten gefahren).
    steps = parse_amount(pick(args.steps, "LORA_STEPS", None))
    steps = int(steps) if steps else None
    steps_source = ""
    if train_minutes is None:
        if steps is None and images > 0:
            steps = plan_steps(images, int(parse_amount(pick(args.repeats, "LORA_REPEATS", 10)) or 10),
                               int(parse_amount(pick(args.epochs, "LORA_EPOCHS", 10)) or 10),
                               int(parse_amount(pick(args.batch_size, "LORA_BATCH_SIZE", 1)) or 1))
            steps_source = f"aus --images {images} x repeats x Epochen / batch_size"
        elif steps is None:
            steps = DEFAULT_STEPS
            steps_source = f"Default {DEFAULT_STEPS} (kein --steps/--images angegeben)"
        else:
            steps_source = "--steps"
    if steps is not None and steps <= 0:
        missing.append(f"Schrittzahl muss > 0 sein (--steps {steps} gelesen)")

    segment_steps_raw = parse_amount(pick(args.segment_steps, "LORA_SEGMENT_STEPS", DEFAULT_SEGMENT_STEPS))
    segment_steps = int(segment_steps_raw) if segment_steps_raw else DEFAULT_SEGMENT_STEPS

    segment_raw = str(pick(args.segment, "LORA_SEGMENT", "") or "").strip()
    segment_index: Optional[int] = None
    if segment_raw and segment_raw.lower() not in ("auto", "weiter", "-"):
        parsed_index = parse_amount(segment_raw)
        if parsed_index is None or int(parsed_index) < 1:
            missing.append(f"--segment erwartet eine Nummer >= 1 oder 'auto' (gelesen: {segment_raw!r})")
        else:
            segment_index = int(parsed_index)

    checkpoint_every_raw = parse_amount(pick(args.checkpoint_every, "LORA_CHECKPOINT_EVERY", DEFAULT_CHECKPOINT_EVERY))
    checkpoint_every = int(checkpoint_every_raw) if checkpoint_every_raw else DEFAULT_CHECKPOINT_EVERY

    volume_mount = str(pick(args.volume_mount, "LORA_VOLUME_MOUNT", "/workspace"))
    checkpoint_dir = str(
        pick(args.checkpoint_dir, "LORA_CHECKPOINT_DIR", "") or f"{volume_mount.rstrip('/')}/lora/ckpt"
    )
    output_dir_in_pod = str(pick(args.output_dir_in_pod, "LORA_OUTPUT_DIR_IN_POD", "/workspace/lora-out"))
    if checkpoint_dir.rstrip("/").startswith(output_dir_in_pod.rstrip("/") + "/") or checkpoint_dir == output_dir_in_pod:
        # Sonst hielte die Ergebnispruefung einen Zwischenstand fuer das LoRA.
        missing.append(
            f"Checkpoint-Verzeichnis ({checkpoint_dir}) darf nicht im Ausgabeverzeichnis "
            f"({output_dir_in_pod}) liegen – sonst wird ein Checkpoint fuer das LoRA gehalten"
        )

    progress_file_in_pod = str(
        pick(args.progress_file_in_pod, "LORA_PROGRESS_FILE", "") or f"{volume_mount.rstrip('/')}/lora/progress.jsonl"
    )

    hf_home = str(pick(args.hf_home, "LORA_HF_HOME", "") or f"{volume_mount.rstrip('/')}/hf-cache")
    volume_size_raw = parse_amount(pick(args.volume_size_gb, "LORA_VOLUME_SIZE_GB", None))
    volume_price_raw = parse_amount(
        pick(args.volume_price_per_gb_month, "LORA_VOLUME_PRICE_PER_GB_MONTH", DEFAULT_VOLUME_PRICE_PER_GB_MONTH)
    )

    pod_name = str(pick(args.pod_name, "LORA_POD_NAME", "") or
                   f"audiomonastry-lora-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}")
    cfg: Dict[str, Any] = {
        "mode": "train" if args.train else (
            "terminate" if args.terminate else ("print-config" if getattr(args, "print_config", False) else "plan")
        ),
        "terminate_pod_id": args.terminate or "",
        "price_per_hour": price if price is not None else 0.0,
        "currency": currency,
        "usd_eur": usd_eur,
        "startup_minutes": float(parse_amount(pick(args.startup_minutes, "LORA_STARTUP_MINUTES", DEFAULT_STARTUP_MINUTES)) or 0),
        "teardown_minutes": float(parse_amount(pick(args.teardown_minutes, "LORA_TEARDOWN_MINUTES", DEFAULT_TEARDOWN_MINUTES)) or 0),
        "max_runtime_minutes": float(parse_amount(pick(args.max_runtime_minutes, "LORA_MAX_RUNTIME_MINUTES", DEFAULT_MAX_RUNTIME_MINUTES)) or 0),
        "seconds_per_step": float(seconds_per_step or DEFAULT_SECONDS_PER_STEP),
        "train_minutes": train_minutes,
        "steps": steps,
        "steps_source": steps_source,
        "segment_steps": segment_steps,
        "segment_index": segment_index,
        "segment_arg": segment_raw or ("auto" if steps is not None else ""),
        "resume_from": pick(args.resume_from, "LORA_RESUME_FROM", "auto"),
        "checkpoint_every": checkpoint_every,
        "checkpoint_dir": checkpoint_dir,
        "checkpoint_upload_url": pick(args.checkpoint_upload_url, "LORA_CHECKPOINT_PUT_URL", None),
        "progress_read_url": pick(args.progress_read_url, "LORA_PROGRESS_GET_URL", None),
        "progress_upload_url": pick(args.progress_upload_url, "LORA_PROGRESS_PUT_URL", None),
        "progress_file_in_pod": progress_file_in_pod,
        "progress_stale_minutes": float(
            parse_amount(pick(args.progress_stale_minutes, "LORA_PROGRESS_STALE_MINUTES", DEFAULT_PROGRESS_STALE_MINUTES))
            or DEFAULT_PROGRESS_STALE_MINUTES
        ),
        "allow_overrun": bool(args.allow_overrun or env.flag("LORA_ALLOW_OVERRUN")),
        "images": images,
        "repeats": int(parse_amount(pick(args.repeats, "LORA_REPEATS", 10)) or 10),
        "epochs": int(parse_amount(pick(args.epochs, "LORA_EPOCHS", 10)) or 10),
        "batch_size": int(parse_amount(pick(args.batch_size, "LORA_BATCH_SIZE", 1)) or 1),
        "pod_name": pod_name,
        "gpu_type": str(pick(args.gpu_type, "LORA_GPU_TYPE", DEFAULT_GPU_TYPE)),
        "cloud_type": str(pick(args.cloud_type, "LORA_CLOUD_TYPE", DEFAULT_CLOUD_TYPE)).upper(),
        "image": pick(args.image, "LORA_POD_IMAGE", None),
        "template_id": pick(args.template_id, "LORA_POD_TEMPLATE_ID", None),
        "container_disk_gb": int(parse_amount(pick(args.container_disk_gb, "LORA_CONTAINER_DISK_GB", 50)) or 50),
        "volume_id": pick(args.volume_id, "LORA_NETWORK_VOLUME_ID", None),
        "volume_mount": volume_mount,
        "volume_size_gb": float(volume_size_raw) if volume_size_raw else None,
        "volume_price_per_gb_month": float(volume_price_raw) if volume_price_raw is not None
        else DEFAULT_VOLUME_PRICE_PER_GB_MONTH,
        "hf_home": hf_home,
        "hf_hub_enable_hf_transfer": env.flag("LORA_HF_HUB_ENABLE_HF_TRANSFER", True),
        "base_model": pick(args.base_model, "LORA_BASE_MODEL", None),
        "dataset_reuse_existing": not bool(args.no_dataset_reuse),
        "docker_args": pick(args.docker_args, "LORA_POD_DOCKER_ARGS", None),
        "dataset_url": pick(args.dataset_url, "LORA_DATASET_URL", None),
        "dataset_sha256": pick(args.dataset_sha256, "LORA_DATASET_SHA256", None),
        "dataset_dir_in_pod": str(pick(args.dataset_dir_in_pod, "LORA_DATASET_DIR_IN_POD", "/workspace/lora-dataset")),
        "output_dir_in_pod": output_dir_in_pod,
        "expected_glob": str(pick(args.expected_glob, "LORA_EXPECTED_GLOB", "*.safetensors")),
        "result_url": pick(args.result_url, "LORA_RESULT_URL", None),
        "poll_seconds": float(parse_amount(pick(args.poll_seconds, "LORA_POLL_SECONDS", 30)) or 30),
        "report_dir": str(pick(args.report_dir, "LORA_REPORT_DIR", "") or (ROOT / "logs" / "lora-runs")),
        "keep_pod_on_fail": bool(args.keep_pod_on_fail or env.flag("LORA_KEEP_POD_ON_FAIL")),
        "hf_token": env.first(("HF_TOKEN",)),
        "api_key": env.first(("RP_AGENT_KEY", "RP_API_KEY", "RUNPOD_API_KEY")),
        "approve": bool(args.approve_spend or env.flag("LORA_APPROVE_SPEND")),
        "train_command": pick(args.train_command, "LORA_TRAIN_COMMAND", "") or "",
        "extra_env": {},
        "env_source": str(env_file) if env_file else "none (nur Prozess-Env)",
    }
    for entry in args.env:
        if "=" in str(entry):
            name, value = str(entry).split("=", 1)
            cfg["extra_env"][name.strip()] = value.strip()
    return cfg, missing


def print_config_block(
    cfg: Dict[str, Any],
    plan: Dict[str, Any],
    segment: Dict[str, Any],
    total_plan: Optional[Dict[str, Any]],
    missing: List[str],
) -> str:
    """Wirksame Konfiguration ausgeben (--print-config): keine Geheimnisse, kein API-Aufruf.

    Presigned URLs und Tokens erscheinen NUR als „gesetzt/nicht gesetzt": eine
    presigned URL ist ein Bearer-Token (dieselbe Regel wie in
    scripts/hetzner/lib/r2-sigv4.sh) und darf nicht in Logs landen. Der
    Kostenhinweis des Network Volumes steht hier ausdrücklich mit dabei – ein
    Volume kostet monatlich weiter, auch wenn kein Pod läuft.
    """
    currency = plan["currency"]
    lines = [
        "Konfiguration (--print-config; kein API-Aufruf, keine Kosten):",
        f"  Pod                 : {cfg['pod_name']} | {cfg['gpu_type']} | {cfg['cloud_type']} | "
        f"{cfg.get('template_id') or cfg.get('image') or '<kein Image/Template>'}",
        f"  Env-Quelle          : {cfg['env_source']}",
        f"  Laufzeitgrenze      : {plan['max_runtime_minutes']:.0f} min je Abschnitt | "
        f"Stundensatz {plan['price_per_hour']:.4g} {currency}/h (Betreiber-Eingabe)",
    ]
    if segment.get("steps") is not None or segment.get("source") == "train-minutes":
        lines.append(
            f"  Abschnitt           : {segment_label(segment)} | Gesamtschritte {cfg.get('steps')} "
            f"({cfg.get('steps_source') or '-'}) | Groesse --segment-steps {cfg.get('segment_steps')}"
        )
    lines.append(
        f"  Resume              : {cfg['resume']['resume_from']} (Quelle: {cfg['resume']['source']}) | "
        f"Checkpoints alle {cfg.get('checkpoint_every')} Schritte nach {cfg.get('checkpoint_dir')}"
    )
    lines.append(
        f"  Checkpoint-Upload   : {mask_value(cfg.get('checkpoint_upload_url'))} | "
        f"Fortschritt lesen: {mask_value(cfg.get('progress_read_url'))} | "
        f"schreiben: {mask_value(cfg.get('progress_upload_url'))}"
    )
    lines.extend(volume_cost_lines(cfg, segment, plan))
    lines.append(
        f"  Datensatz           : {cfg.get('dataset_dir_in_pod')} | "
        f"URL {mask_value(cfg.get('dataset_url'))} | "
        f"bestehende Daten wiederverwenden: {'ja' if cfg.get('dataset_reuse_existing') else 'nein'}"
    )
    lines.append(
        f"  Pfade im Pod        : HF_HOME {cfg.get('hf_home')} | Ausgabe {cfg.get('output_dir_in_pod')} | "
        f"Markerdatei {cfg.get('progress_file_in_pod')}"
    )
    lines.append(
        f"  Zugang/ Artefakt    : RunPod-Key {mask_value(cfg.get('api_key'))} | "
        f"HF_TOKEN {mask_value(cfg.get('hf_token'))} | LoRA-URL {mask_value(cfg.get('result_url'))}"
    )
    lines.append(
        f"  Gate                : Freigabe {'erteilt' if cfg.get('approve') else 'fehlt'} | "
        f"zu bestaetigen {plan['cost_max']:.4f} {currency} (harte Obergrenze dieses Abschnitts)"
    )
    if total_plan and segment.get("count"):
        lines.append(
            f"  Gesamtlauf          : {segment['count']} Abschnitte, worst case "
            f"{total_plan['cost_max'] * max(1, int(segment['count'])):.4f} {currency} + Volume-Monatskosten"
        )
    if cfg.get("warn_no_volume"):
        lines.append(f"  Hinweis             : {cfg['warn_no_volume']}")
    if missing:
        lines.append("  NOCH EINZUTRAGEN (sonst Exit 2):")
        for entry in missing:
            lines.append(f"    - {entry}")
    else:
        lines.append("  Konfiguration vollstaendig (Preis + Schritte gesetzt)")
    return "\n".join("[lora] " + line for line in lines)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    cfg, missing = resolve_config(args)

    # --- Not-Aus: Aufräumen braucht kein Gate (beendet Ausgaben) -------------
    if cfg["mode"] == "terminate":
        pod_id = cfg["terminate_pod_id"]
        if not cfg["api_key"]:
            print("FEHLER: RP_AGENT_KEY/RP_API_KEY/RUNPOD_API_KEY fehlt", file=sys.stderr)
            return EXIT_USAGE
        try:
            print(f"[lora] terminiere Pod {pod_id} (Aufraeumen, keine Kostenfreigabe noetig) …")
            ok, detail = terminate_pod(pod_id)
        except Exception as exc:  # noqa: BLE001
            print(f"FEHLER: Terminierung fehlgeschlagen: {type(exc).__name__}: {exc}", file=sys.stderr)
            return EXIT_RUN_FAILED
        print(("[lora] OK: " if ok else "[lora] WARNUNG: ") + detail)
        return EXIT_OK if ok else EXIT_RUN_FAILED

    # --- Plan (rein rechnerisch) --------------------------------------------
    # Gesamtlauf (alle Abschnitte) und der Plan DIESES Pod-Laufs (Abschnitt).
    steps_total = cfg["steps"] if cfg["train_minutes"] is None else None

    # Fortschrittsmarker lesen: er entscheidet, WO der Abschnitt fortsetzt
    # (kein API-Aufruf des RunPod-SDK – nur ein GET auf die URL des Betreibers).
    marker: Optional[Dict[str, Any]] = None
    progress_detail = "kein --progress-read-url gesetzt"
    if cfg.get("progress_read_url") and cfg["mode"] != "terminate":
        marker, progress_detail = read_progress(str(cfg["progress_read_url"]))
        # Die URL selbst wird NICHT gedruckt: eine presigned URL ist ein
        # Bearer-Token (siehe scripts/hetzner/lib/r2-sigv4.sh).
        print(f"[lora] Fortschrittsmarker: {progress_detail}")
        for line in format_progress_lines(
            marker, stale_minutes=cfg["progress_stale_minutes"], detail=progress_detail
        ):
            print("[lora] " + line)
    elif cfg["mode"] != "terminate":
        print("[lora] Fortschrittsmarker: keiner gesetzt (--progress-read-url) – "
              "Fortschritt ist dann nur am Pod-Zustand ablesbar")

    resume_step = _as_int((marker or {}).get("step")) or 0
    if steps_total is None:
        # Vom Betreiber vorgegebene Dauer (--train-minutes): keine Schrittzahl,
        # also auch keine Aufteilung – ein Lauf, geprüft wird die Dauer.
        segment: Dict[str, Any] = {
            "index": 1, "count": 1, "size": cfg["segment_steps"], "start_step": 0, "end_step": None,
            "steps": None, "total_steps": None, "finished": False, "is_last": True,
            "source": "train-minutes", "seconds_per_step_is_assumption": True,
        }
    else:
        segment = resolve_segment(
            steps_total,
            cfg["segment_steps"],
            segment_index=cfg["segment_index"],
            resume_step=resume_step,
        )
    cfg["segment"] = segment
    cfg["resume"] = resolve_resume(cfg, marker)
    cfg["progress_read_state"] = progress_detail

    def plan_for(local_steps: Optional[int]) -> Dict[str, Any]:
        """Zeit/Kosten für eine bestimmte Schrittzahl (Abschnitt oder Gesamtlauf)."""
        local: Dict[str, Any] = dict(cfg)
        if local_steps is not None:
            local["steps"] = int(local_steps)
            local["train_minutes"] = None
        return compute_plan(local)

    total_plan = plan_for(steps_total) if steps_total is not None else None
    plan = plan_for(segment.get("steps") if segment.get("steps") is not None else steps_total)
    cfg["plan_total"] = total_plan

    print(f"[lora] Modus: {cfg['mode']} | Pod: {cfg['pod_name']} | GPU: {cfg['gpu_type']} ({cfg['cloud_type']})")
    print(f"[lora] Env-Quelle: {cfg['env_source']}")
    if segment.get("source") != "train-minutes":
        print(f"[lora] Schritte: {steps_total} ({cfg['steps_source']}) | {segment_label(segment)} "
              f"| Quelle: {segment.get('source')}")
        print(f"[lora] Resume: {cfg['resume']['resume_from']} (Quelle: {cfg['resume']['source']} – "
              f"{cfg['resume']['hint']})")
    if not cfg.get("volume_id") and int(segment.get("count") or 1) > 1:
        # Ohne Volume zahlt JEDER Abschnitt den Kaltstart neu (Image-Pull + ~24 GB
        # Gewichte). Das ist genau der Kostenfaktor, den der Abschnittsbetrieb
        # tragen muss – deshalb steht es hier laut und nicht nur in der Doku.
        cfg["warn_no_volume"] = (
            f"{segment['count']} Abschnitte ohne Network Volume: jeder Start laedt die Basisgewichte (~24 GB) neu "
            "– einmalig vorstagen (CPU-Pod, kostenlos gegen GPU-Zeit) mit "
            "scripts/lora/vorstaging.sh, danach --volume-id/--volume-size-gb setzen"
        )
        print("[lora] WARNUNG: " + cfg["warn_no_volume"])
    if not args.quiet:
        for line in cost_block(plan, cfg, segment, total_plan):
            print("[lora] " + line)
    else:
        print(f"[lora] Plan {plan['cost_plan']:.2f} {plan['currency']} / Obergrenze {plan['cost_max']:.2f} {plan['currency']}")

    # --- VORAB-RECHNUNG: passt die Arbeit dieses Pod-Laufs ins Fenster? -------
    # Genau diese Rechnung fehlte beim ersten Lauf (3700 Schritte x 2,0 s =
    # 123 min gegen eine 90-min-Grenze) – er lief 90,4 min in den Abbruch,
    # kostete 0,74 USD und lieferte kein LoRA.
    check = runtime_check(
        startup_minutes=cfg["startup_minutes"],
        train_minutes=plan["train_minutes"],
        max_runtime_minutes=cfg["max_runtime_minutes"],
        steps=plan["steps"],
        seconds_per_step=plan["seconds_per_step"],
    )
    for line in runtime_check_lines(
        check,
        currency=plan["currency"],
        price_per_hour=cfg["price_per_hour"],
        allow_overrun=cfg["allow_overrun"],
    ):
        print("[lora] " + line)
    if not check["ok"] and not cfg["allow_overrun"]:
        print("ABBRUCH (VORAB-RECHNUNG) – es wurde KEIN POD angelegt und KEINE Kosten freigegeben:", file=sys.stderr)
        for line in runtime_check_lines(check, currency=plan["currency"], price_per_hour=cfg["price_per_hour"]):
            print("  " + line, file=sys.stderr)
        # Konkrete Zahl, die noch ins Fenster passt (gerundet auf 50 Schritte).
        fit_steps = int(
            (check["window_minutes"] - check["startup_minutes"]) * 60.0
            / max(0.01, float(plan["seconds_per_step"] or cfg["seconds_per_step"]))
        )
        fit_steps = max(50, fit_steps // 50 * 50)
        print(
            f"  Der Abschnitt braucht {check['need_minutes']:.2f} min, das Fenster ist "
            f"{check['window_minutes']:.2f} min. In dieses Fenster passen bei {cfg['seconds_per_step']:.2f} s/Schritt "
            f"(ANNAHME) hoechstens ~{fit_steps} Schritte je Abschnitt "
            f"(--segment-steps {fit_steps}); die Gesamtschritte bleiben unveraendert.",
            file=sys.stderr,
        )
        return EXIT_USAGE

    if cfg["mode"] == "print-config":
        print(print_config_block(cfg, plan, segment, total_plan, missing))
        return EXIT_OK if not missing else EXIT_USAGE

    # Alle Schritte erreicht: dieser Abschnitt hat nichts zu tun. Bewusst OHNE
    # Freigabe und ohne API-Aufruf – es gibt nichts zu bezahlen.
    if segment["finished"]:
        print(
            f"[lora] NICHTS ZU TUN: alle Schritte erreicht "
            f"(Fortschrittsmarker sagt Schritt {resume_step} von {segment['total_steps']}). "
            "Kein Pod, kein API-Aufruf, keine Kosten."
        )
        return EXIT_OK

    if missing:
        print("FEHLER: unvollstaendige Konfiguration:", file=sys.stderr)
        for entry in missing:
            print(f"  - {entry}", file=sys.stderr)
        return EXIT_USAGE

    # Pflichtangaben des Laufs VOR dem Gate prüfen: sonst würde der Betreiber
    # Kosten freigeben, die gar nicht ausgegeben werden können (Abbruch danach).
    if cfg["mode"] == "train":
        pod_missing = [
            name
            for name, value in (
                ("RunPod-Zugang: RP_API_KEY in .env oder Umgebung", cfg.get("api_key")),
                ("Trainer-Image: --template-id oder --image", cfg.get("template_id") or cfg.get("image")),
                ("Startbefehl im Pod: --docker-args", cfg.get("docker_args")),
            )
            if not value
        ]
        if pod_missing:
            print("FEHLER: der Lauf ist noch nicht startfaehig (keine Kostenfreigabe angefragt):", file=sys.stderr)
            for entry in pod_missing:
                print(f"  - {entry}", file=sys.stderr)
            return EXIT_USAGE

    if cfg["mode"] == "plan":
        # Was würde der Pod bekommen? (Ohne API-Aufruf sichtbar machen.)
        spec = build_job_spec(cfg, plan)
        print("[lora] Pod-Auftrag (wird im Env LORA_JOB_SPEC_B64 an den Pod gegeben):")
        print(json.dumps(spec, indent=2, ensure_ascii=False))
        runtime_missing = [
            name
            for name, value in (
                ("Trainer-Image (--image oder --template-id)", cfg.get("image") or cfg.get("template_id")),
                ("Startbefehl im Pod (--docker-args)", cfg.get("docker_args")),
                ("Trainer-Kommando im Pod (--train-command)", cfg.get("train_command")),
                ("Datensatz-URL (--dataset-url) ODER Datensatz auf dem Volume", cfg.get("dataset_url") or cfg.get("volume_id")),
                ("RunPod-Zugang (RP_API_KEY in .env)", cfg.get("api_key")),
                ("Fortschrittsmarker zum LESEN (--progress-read-url)", cfg.get("progress_read_url")),
                ("Fortschrittsmarker zum SCHREIBEN (--progress-upload-url)", cfg.get("progress_upload_url")),
                ("Checkpoint-Ablage in R2 (--checkpoint-upload-url)", cfg.get("checkpoint_upload_url")),
            )
            if not value
        ]
        if runtime_missing:
            print("[lora] Vor dem Start noch einzutragen (Betreiber-Eingaben, s. docs/VISUAL_LORA_TRAINING.md):")
            for entry in runtime_missing:
                print(f"        - {entry}")
        print("[lora] Plan-Modus: kein API-Aufruf, keine Kosten. Start mit --train und Freigabe:")
        print(f"        LORA_APPROVE_SPEND=1 KOSTENBESTAETIGUNG={plan['cost_max']:.4f} \\")
        print("          python3 scripts/runpod-lora-train.py --train --steps <n> --segment auto "
              "--price-per-hour <satz> …")
        print("[lora] Weiterer Abschnitt nach diesem Lauf: dieselben Argumente + --segment auto "
              "(setzt aus dem Checkpoint fort)")
        return EXIT_OK

    # --- Gate: ab hier ist die einzige Stelle, an der es weitergeht ----------
    confirm_raw = args.cost_confirm if args.cost_confirm is not None else (
        os.environ.get("KOSTENBESTAETIGUNG") or os.environ.get("LORA_COST_CONFIRM")
        or EnvSource(None if str(args.env_file).strip().lower() in ("none", "-", "") else pathlib.Path(args.env_file)).first(
            ("KOSTENBESTAETIGUNG", "LORA_COST_CONFIRM")
        )
    )
    confirm_amount = parse_amount(confirm_raw)
    ok, message = gate_check(
        approve=cfg["approve"],
        confirm_amount=confirm_amount,
        required_amount=plan["cost_max"],
        currency=plan["currency"],
    )
    cfg["gate"] = {
        "approved": cfg["approve"],
        "confirm_raw": str(confirm_raw) if confirm_raw is not None else None,
        "confirm_amount": confirm_amount,
        "required_amount": plan["cost_max"],
        "currency": plan["currency"],
        "ok": ok,
    }
    print(("[lora] " if ok else "[lora] GATE: ") + message)
    if not ok:
        print(
            "ABBRUCH vor jedem API-Aufruf: keine Kostenfreigabe. Es wurde kein Pod angelegt, "
            "kein HTTP-Request gesendet und das RunPod-SDK nicht geladen.",
            file=sys.stderr,
        )
        print(
            f"Freigabe-Beispiel: LORA_APPROVE_SPEND=1 KOSTENBESTAETIGUNG={plan['cost_max']:.4f} "
            f"python3 scripts/runpod-lora-train.py --train --steps <n> --segment auto --price-per-hour <satz>",
            file=sys.stderr,
        )
        return EXIT_GATE

    # Pflichtangaben sind bereits vor dem Gate geprüft (oben) – hier startet der Lauf.
    return run_training(cfg, plan)


if __name__ == "__main__":
    raise SystemExit(main())
