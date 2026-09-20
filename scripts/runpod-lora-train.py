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

Modi
----
  --plan                 Nur rechnen: Pod-Plan + Kostenrechnung. Kein API-Aufruf. (Default)
  --train                Voller Lauf: Plan → Gate → Pod anlegen → überwachen → terminieren
  --terminate <pod-id>   Not-Aus/Aufräumen: terminiert einen Pod sofort.
                         Braucht bewusst KEINE Kostenfreigabe – dieser Aufruf beendet
                         Ausgaben, er beginnt keine. Prüft die Terminierung nach.

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
  Pod          LORA_POD_NAME, LORA_GPU_TYPE, LORA_CLOUD_TYPE, LORA_POD_IMAGE,
               LORA_POD_TEMPLATE_ID, LORA_CONTAINER_DISK_GB, LORA_NETWORK_VOLUME_ID,
               LORA_VOLUME_MOUNT, LORA_POD_DOCKER_ARGS, LORA_DATASET_URL, LORA_RESULT_URL,
               LORA_KEEP_POD_ON_FAIL, LORA_POLL_SECONDS
  Zugang       RP_AGENT_KEY / RP_API_KEY / RUNPOD_API_KEY, HF_TOKEN (optional)

Exit-Codes
----------
  0 = Lauf erfolgreich (Pod angelegt, beendet, terminiert; Ergebnis geprüft)
  2 = Aufruf-/Konfigurationsfehler (fehlender Preis/Pod-Parameter, SDK fehlt, Name belegt)
  3 = Freigabe fehlt oder bestätigter Betrag zu niedrig → KEIN API-Aufruf
  4 = Lauf fehlgeschlagen/abgebrochen (Pod wurde trotzdem terminiert)
  5 = Lauf beendet, aber kein Ergebnis-Artefakt gefunden (LORA_RESULT_URL gesetzt)

Siehe docs/VISUAL_LORA_TRAINING.md für den Betreiber-Ablauf, die Kostenrechnung
und die ehrlichen Grenzen (u. a. der Trainer-Befehl im Pod ist ungeprüft).
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

#: Terminale Zustände eines Pods (defensiv gelesen – die SDK-Antwort nennt den
#: Zustand je nach Version `desiredStatus`, `runtimeStatus` oder `status`).
TERMINAL_STATES = {"EXITED", "TERMINATED", "STOPPED", "FAILED", "DEAD"}
RUNNING_STATES = {"RUNNING", "STARTING", "CREATED", "PROVISIONING", ""}


# ---------------------------------------------------------------------------
# Env-Auflösung (Prozess-Env vor .env-Datei, dotenv-Verhalten)
# ---------------------------------------------------------------------------
def read_env_file(path: pathlib.Path) -> Dict[str, str]:
    out: Dict[str, str] = {}
    if not path or not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        out[name.strip()] = value.strip().strip('"').strip("'")
    return out


class EnvSource:
    def __init__(self, env_file: Optional[pathlib.Path]) -> None:
        self.file_env = read_env_file(env_file) if env_file else {}

    def get(self, name: str, default: str = "") -> str:
        value = os.environ.get(name)
        if value is None:
            value = self.file_env.get(name)
        return value.strip() if value is not None else default

    def first(self, names: Sequence[str], default: str = "") -> str:
        for name in names:
            value = self.get(name)
            if value:
                return value
        return default

    def flag(self, name: str, default: bool = False) -> bool:
        raw = self.get(name)
        if not raw:
            return default
        return raw.strip().lower() in ("1", "true", "yes", "on", "ja")


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


def cost_block(plan: Dict[str, Any], cfg: Dict[str, Any]) -> List[str]:
    """Menschenlesbarer Kostenblock (wird VOR dem Gate gedruckt)."""
    currency = plan["currency"]
    lines = [
        "Kostenrechnung (Planwerte, kein Messwert):",
        f"  Stundensatz         : {plan['price_per_hour']:.4g} {currency}/h "
        f"(Eingabe des Betreibers; Quelle zum Ablesen: runpodctl gpu list)",
        f"  Kaltstart           : {plan['startup_minutes']:.0f} min "
        f"(gemessen 2026-09-11: Bild-Worker-Pull 15-25 min, docs/VISUALMONK_SPEC.md)",
    ]
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
    if cfg.get("keep_pod_on_fail"):
        lines.append(
            "  WARNUNG: LORA_KEEP_POD_ON_FAIL=1 - ein fehlgeschlagener Lauf laesst den Pod laufen "
            "(er kostet weiter, bis er terminiert wird)"
        )
    return lines


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
# Pod-Auftrag (Job-Spezifikation für den Pod)
# ---------------------------------------------------------------------------
def build_job_spec(cfg: Dict[str, Any], plan: Dict[str, Any]) -> Dict[str, Any]:
    """Auftrag, den der Pod beim Start liest (siehe scripts/lora/bootstrap.sh)."""
    return {
        "schema": "visual-lora-job/1",
        "ticket": "VISUAL-P1-007",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "name": cfg["pod_name"],
        "dataset": {
            "url": cfg.get("dataset_url") or None,
            "dir": cfg.get("dataset_dir_in_pod"),
            "sha256": cfg.get("dataset_sha256") or None,
        },
        "train": {
            "command": cfg.get("train_command") or None,
            "output_dir": cfg.get("output_dir_in_pod"),
            "expected_glob": cfg.get("expected_glob"),
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
            "dieser Auftrag nie an RunPod gesendet."
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
        # sonst ist die Container-Disk nach dem Terminieren weg.
        "HF_HOME": f"{cfg['volume_mount']}/hf-cache",
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
        "gate": cfg["gate"],
        "pod": {"gpu_type": cfg["gpu_type"], "cloud_type": cfg["cloud_type"],
                "template_id": cfg.get("template_id"), "image": cfg.get("image"),
                "volume_id": cfg.get("volume_id"), "max_runtime_minutes": cfg["max_runtime_minutes"]},
        "job_spec": build_job_spec(cfg, plan),
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

    try:
        kwargs = create_pod_kwargs(cfg, report["job_spec"])
        event(f"lege Pod an: {cfg['pod_name']} | {cfg['gpu_type']} | {cfg['cloud_type']} | Template/Image: "
              f"{cfg.get('template_id') or cfg.get('image')}")
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
            if cfg.get("result_url"):
                ok, detail = http_ok(str(cfg["result_url"]))
                if ok:
                    artifact = {"url": cfg["result_url"], "check": detail}
                    event(f"Ergebnis-Artefakt gefunden: {detail}")
                    break
            if status in TERMINAL_STATES:
                break
            if time.time() >= deadline:
                failure = f"harte Laufzeitgrenze erreicht ({plan['max_runtime_minutes']:.0f} min) – Pod wird terminiert"
                event(f"ABBRUCH: {failure}")
                break

        if not failure and cfg.get("result_url") and not artifact:
            failure = "Lauf beendet, aber das Ergebnis-Artefakt (LORA_RESULT_URL) fehlt"
            event(f"FEHLER: {failure}")
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
            }
        )
        write_report(report_path, report)

    if failure:
        return EXIT_NO_ARTIFACT if "Artefakt" in failure and pod_id else EXIT_RUN_FAILED
    return EXIT_OK


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

    parser.add_argument("--approve-spend", action="store_true", help="Freigabe erteilen (auch per LORA_APPROVE_SPEND=1).")
    parser.add_argument("--cost-confirm", metavar="BETRAG", default=None,
                        help="Bestätigter Betrag in der Planwährung (auch per KOSTENBESTAETIGUNG).")
    parser.add_argument("--price-per-hour", type=float, default=None,
                        help="GPU-Stundensatz des Pods (auch per LORA_GPU_PRICE_PER_H). Quelle: runpodctl gpu list.")
    parser.add_argument("--currency", default=None, help="Planwährung (Default USD).")
    parser.add_argument("--usd-eur", type=float, default=None, help="Nur Anzeige: EUR je USD (Default 0.92).")
    parser.add_argument("--startup-minutes", type=float, default=None, help="Kaltstart-Annahme in Minuten (Default 20).")
    parser.add_argument("--train-minutes", type=float, default=None, help="Trainingsdauer in Minuten (sonst aus Schritten gerechnet).")
    parser.add_argument("--images", type=int, default=None, help="Bilder im Datensatz (für die Schrittzahl).")
    parser.add_argument("--repeats", type=int, default=10, help="num_repeats des Datensatzes (Default 10).")
    parser.add_argument("--epochs", type=int, default=10, help="Epochen (Default 10).")
    parser.add_argument("--batch-size", type=int, default=1, help="batch_size (Default 1).")
    parser.add_argument("--seconds-per-step", type=float, default=None,
                        help="ANNAHME s/Schritt für die Kostenschätzung (Default 2.0; mit Messwert ersetzen).")
    parser.add_argument("--teardown-minutes", type=float, default=None, help="Aufräumen/Upload in Minuten (Default 5).")
    parser.add_argument("--max-runtime-minutes", type=float, default=None,
                        help="Harte Laufzeitgrenze in Minuten (Default 90); danach wird der Pod terminiert.")

    parser.add_argument("--pod-name", default=None, help="Pod-Name (Default audiomonastry-lora-<zeit>).")
    parser.add_argument("--gpu-type", default=None, help=f"Pod-GPU-Typ (Default {DEFAULT_GPU_TYPE}).")
    parser.add_argument("--cloud-type", default=None, choices=["SECURE", "COMMUNITY"],
                        help="SECURE (Default) oder COMMUNITY – der Preis muss zur Wahl passen.")
    parser.add_argument("--image", default=None, help="Container-Image des Pods (oder --template-id).")
    parser.add_argument("--template-id", default=None, help="RunPod-Template des Pods (schlägt --image).")
    parser.add_argument("--container-disk-gb", type=int, default=None, help="Container-Disk in GB (Default 50).")
    parser.add_argument("--volume-id", default=None, help="Netz-Volume (empfohlen: Gewichte/Ausgabe überleben den Pod).")
    parser.add_argument("--volume-mount", default=None, help="Mount-Pfad des Volumes (Default /workspace).")
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
    if train_minutes is None and images <= 0:
        missing.append(
            "Schrittzahl-Grundlage: --images <n> (Bilder im Datensatz) ODER --train-minutes <min>"
        )

    pod_name = str(pick(args.pod_name, "LORA_POD_NAME", "") or
                   f"audiomonastry-lora-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}")
    cfg: Dict[str, Any] = {
        "mode": "train" if args.train else ("terminate" if args.terminate else "plan"),
        "terminate_pod_id": args.terminate or "",
        "price_per_hour": price if price is not None else 0.0,
        "currency": currency,
        "usd_eur": usd_eur,
        "startup_minutes": float(parse_amount(pick(args.startup_minutes, "LORA_STARTUP_MINUTES", DEFAULT_STARTUP_MINUTES)) or 0),
        "teardown_minutes": float(parse_amount(pick(args.teardown_minutes, "LORA_TEARDOWN_MINUTES", DEFAULT_TEARDOWN_MINUTES)) or 0),
        "max_runtime_minutes": float(parse_amount(pick(args.max_runtime_minutes, "LORA_MAX_RUNTIME_MINUTES", DEFAULT_MAX_RUNTIME_MINUTES)) or 0),
        "seconds_per_step": float(seconds_per_step or DEFAULT_SECONDS_PER_STEP),
        "train_minutes": train_minutes,
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
        "volume_mount": str(pick(args.volume_mount, "LORA_VOLUME_MOUNT", "/workspace")),
        "docker_args": pick(args.docker_args, "LORA_POD_DOCKER_ARGS", None),
        "dataset_url": pick(args.dataset_url, "LORA_DATASET_URL", None),
        "dataset_sha256": pick(args.dataset_sha256, "LORA_DATASET_SHA256", None),
        "dataset_dir_in_pod": str(pick(args.dataset_dir_in_pod, "LORA_DATASET_DIR_IN_POD", "/workspace/lora-dataset")),
        "output_dir_in_pod": str(pick(args.output_dir_in_pod, "LORA_OUTPUT_DIR_IN_POD", "/workspace/lora-out")),
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
    if cfg["price_per_hour"] > 0:
        plan = compute_plan(cfg)
    else:
        plan = {
            "price_per_hour": 0.0, "currency": cfg["currency"], "seconds_per_step": cfg["seconds_per_step"],
            "steps": None, "train_minutes": cfg["train_minutes"] or 0.0,
            "startup_minutes": cfg["startup_minutes"], "teardown_minutes": cfg["teardown_minutes"],
            "max_runtime_minutes": cfg["max_runtime_minutes"],
            "hours_plan": 0.0, "hours_max": (cfg["startup_minutes"] + cfg["max_runtime_minutes"] + cfg["teardown_minutes"]) / 60.0,
            "cost_plan": 0.0, "cost_max": 0.0, "cost_plan_eur": None, "cost_max_eur": None, "usd_eur": None,
        }

    print(f"[lora] Modus: {cfg['mode']} | Pod: {cfg['pod_name']} | GPU: {cfg['gpu_type']} ({cfg['cloud_type']})")
    print(f"[lora] Env-Quelle: {cfg['env_source']}")
    if not args.quiet:
        for line in cost_block(plan, cfg):
            print("[lora] " + line)
    else:
        print(f"[lora] Plan {plan['cost_plan']:.2f} {plan['currency']} / Obergrenze {plan['cost_max']:.2f} {plan['currency']}")

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
            )
            if not value
        ]
        if runtime_missing:
            print("[lora] Vor dem Start noch einzutragen (Betreiber-Eingaben, s. docs/VISUAL_LORA_TRAINING.md):")
            for entry in runtime_missing:
                print(f"        - {entry}")
        print("[lora] Plan-Modus: kein API-Aufruf, keine Kosten. Start mit --train und Freigabe:")
        print(f"        LORA_APPROVE_SPEND=1 KOSTENBESTAETIGUNG={plan['cost_max']:.4f} \\")
        print("          python3 scripts/runpod-lora-train.py --train --images <n> --price-per-hour <satz>")
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
            f"python3 scripts/runpod-lora-train.py --train --images <n> --price-per-hour <satz>",
            file=sys.stderr,
        )
        return EXIT_GATE

    # Pflichtangaben sind bereits vor dem Gate geprüft (oben) – hier startet der Lauf.
    return run_training(cfg, plan)


if __name__ == "__main__":
    raise SystemExit(main())
