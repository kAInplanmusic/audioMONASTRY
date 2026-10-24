#!/usr/bin/env python3
"""FLEET-P1-011: VRAM-Report je Pod-Rolle einsammeln.

Die Messung passiert IM Pod (`services/audiomonastry-ai-runtime/vram_probe.py`,
Route `GET/POST /vram/report`); dieses Skript startet je Rolle ein Lastfenster,
erzeugt parallel die 4 Nutzer über `POST /infer` und schreibt das Ergebnis nach
`test-results/vram/<role>-<datum>.json` (mit `peakMb`, `avgMb`, Datum, Commit,
Treiber – genau die Abhak-Bedingung aus docs/APPTEST_ABHAK_LISTE.md).

Aufruf (Pods laufen, `AI_POD_TOKEN`/`RP_API_KEY` in `.env.deploy`):

    python3 scripts/collect-vram-report.py --group all
    python3 scripts/collect-vram-report.py --roles ears --duration 30
    python3 scripts/collect-vram-report.py --url brain=http://127.0.0.1:8099   # lokal

Ohne GPU im Pod (oder ohne CUDA-torch) schreibt das Skript **keine** erfundenen
Zahlen: `status` ist dann `NOT_MEASURED` mit `reasons`, Exit-Code 4. Ein
`MEASURED` mit `peakMb`/`avgMb` entsteht nur aus echten Report-Werten.

Exit-Codes: 0 alle Rollen MEASURED · 2 Konfiguration · 3 Pod nicht erreichbar
(kein Token/keine Route) · 4 mindestens eine Rolle NICHT gemessen.
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import os
import pathlib
import statistics
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import wave
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

ROOT = pathlib.Path(__file__).resolve().parent.parent
FLEET_PATH = ROOT / "deploy" / "runpod" / "pod-fleet.json"
DEFAULT_OUT = ROOT / "test-results" / "vram"
SCRIPTS = pathlib.Path(__file__).resolve().parent
if str(SCRIPTS / "lib") not in sys.path:
    sys.path.insert(0, str(SCRIPTS / "lib"))

from envfile import EnvSource  # noqa: E402
from restclient import BROWSER_UA  # noqa: E402

TICKET = "FLEET-P1-011"
GROUPS = {
    "all": ["brain", "ears", "music", "voice", "stems"],
    "core": ["brain", "ears"],
    "generation": ["music", "voice", "stems"],
}
ACTIVE_POD_STATES = {"RUNNING", "EXITED"}  # EXITED = Proxy antwortet evtl. noch, Test entscheidet
#: Mindestabstand zweier Aufträge eines Nutzers: 4 Menschen, kein Lastgenerator.
USER_PACE_S = 0.5


# --------------------------------------------------------------------------- Last
def silence_wav_b64(seconds: int = 2, sample_rate: int = 16000) -> str:
    """Kurzes Stilles-WAV als base64: gültiger Audio-Eingang ohne Testdatei.

    Transkription/Trennung auf Stille ist billig, belastet aber den echten
    Modellpfad (Preprocessing + Forward) – genau das, was VRAM belegt.
    """
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(b"\x00\x00" * sample_rate * seconds)
    return base64.b64encode(buffer.getvalue()).decode()


def role_request(role: str) -> Dict[str, Any]:
    """Typischer Auftrag je Rolle (Modelle aus deploy/runpod/pod-fleet.json).

    Überschreibbar per `--load-file` – die Handler der Tickets FLEET-P1-002..010
    ändern Payload-Felder; dann hier nachziehen statt das Skript zu patchen.
    """
    audio = silence_wav_b64()
    table = {
        "brain": {"task": "llm", "model": "qwen3-30b-a3b-awq",
                  "input": {"text": "Nenne in einem Satz, was ein Kompressor mit einem Audiosignal macht.", "maxTokens": 48}},
        "ears": {"task": "transcribe", "model": "whisper-large-v3",
                 "input": {"audio": audio, "language": "de"}},
        "music": {"task": "song", "model": "acestep-v15-xl-turbo",
                  "input": {"prompt": "tight electronic techno loop, 122 bpm, dry drums", "durationSeconds": 8}},
        "voice": {"task": "tts", "model": "qwen3-tts-17b",
                  "input": {"text": "Dies ist ein Lasttest der Sprachausgabe mit vier Nutzern.", "language": "de"}},
        "stems": {"task": "stem.separate", "model": "htdemucs-6s", "input": {"audio": audio}},
    }
    if role not in table:
        raise ConfigError(f"kein Lastprofil für Rolle {role!r} – --load-file verwenden")
    return table[role]


# --------------------------------------------------------------------------- HTTP
def http_json(base: str, path: str, token: str, payload: Optional[Dict[str, Any]] = None,
              timeout: float = 60.0) -> Tuple[int, Any]:
    """JSON-Aufruf gegen den Pod; (Status, geparst). 0 = Netz-/Proxyfehler.

    Browser-UA wie in scripts/lib/restclient.py: Cloudflare beantwortet
    Standard-urllib sonst mit 403/1010 (RunPod-Proxy davor).
    """
    data = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(
        base.rstrip("/") + path, data=data, method="POST" if data is not None else "GET"
    )
    request.add_header("Content-Type", "application/json")
    request.add_header("Accept", "application/json")
    request.add_header("User-Agent", BROWSER_UA)
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode() or "null"
            try:
                return response.status, json.loads(raw)
            except ValueError:
                return response.status, {"_body": raw[:300]}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode(errors="replace") if exc.fp else ""
        try:
            return exc.code, json.loads(raw or "null")
        except ValueError:
            return exc.code, {"_body": raw[:300]}
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return 0, {"_error": f"{type(exc).__name__}: {exc}"[:200]}


def user_loop(base: str, token: str, load: Dict[str, Any], deadline: float,
              results: List[Dict[str, Any]], lock: threading.Lock) -> None:
    """Ein simulierter Nutzer: sendet Aufträge, bis das Messfenster endet."""
    while time.monotonic() < deadline:
        started = time.monotonic()
        status, body = http_json(base, "/infer", token, {"task": load["task"], "model": load["model"],
                                                         "input": load["input"]},
                                 timeout=max(30.0, deadline - time.monotonic() + 30.0))
        latency_ms = int((time.monotonic() - started) * 1000)
        ok = status == 200 and isinstance(body, dict) and body.get("status") == "success"
        error = None
        if not ok:
            if isinstance(body, dict):
                detail = body.get("detail") or body.get("error") or body.get("_error") or body.get("_body") or {}
                error = f"HTTP {status}: {json.dumps(detail, ensure_ascii=False)[:160]}"
            else:
                error = f"HTTP {status}"
        with lock:
            results.append({"status": status, "latencyMs": latency_ms, "ok": ok, "error": error})
        # Taktung je Nutzer: ein fehlschlagender Handler soll keinen Fehler-Hammer
        # auslösen, und ein sehr schneller soll aus 4 Nutzern keinen Loadtest machen.
        elapsed = time.monotonic() - started
        if elapsed < USER_PACE_S:
            time.sleep(USER_PACE_S - elapsed)


def summarize_requests(results: List[Dict[str, Any]], load: Dict[str, Any]) -> Dict[str, Any]:
    latencies = sorted(int(r["latencyMs"]) for r in results)
    errors = sorted({str(r["error"]) for r in results if not r["ok"]})
    return {
        "task": load["task"],
        "model": load["model"],
        "count": len(results),
        "ok": sum(1 for r in results if r["ok"]),
        "failed": sum(1 for r in results if not r["ok"]),
        "latencyMs": {
            "min": latencies[0],
            "p50": int(statistics.median(latencies)),
            "max": latencies[-1],
        } if latencies else None,
        "errors": errors[:5],
    }


# ---------------------------------------------------------------------- Bewertung
def evaluate(report: Dict[str, Any], requests: Dict[str, Any]) -> Tuple[str, List[str]]:
    """`MEASURED` nur mit echtem GPU-Befund, Samples und mindestens einem Erfolg."""
    reasons: List[str] = []
    gpu = report.get("gpu") or {}
    load = report.get("load") or {}
    if not gpu.get("gpuVisible"):
        notes = ", ".join(gpu.get("notes") or []) or "keine Angabe"
        reasons.append(f"keine GPU im Pod sichtbar ({notes})")
    if not load.get("sampleCount"):
        reasons.append("kein Sample im Lastfenster – Sampler lief nicht oder wurde abgelehnt")
    if report.get("load", {}).get("peakMb") is None or report.get("load", {}).get("avgMb") is None:
        reasons.append("peakMb/avgMb fehlen im Report")
    if requests["ok"] == 0:
        reasons.append(f"keine erfolgreiche Inferenz ({requests['failed']} Fehlversuche)")
    return ("MEASURED" if not reasons else "NOT_MEASURED"), reasons


# ------------------------------------------------------------------------ Pod-URLs
class ConfigError(Exception):
    """Aufruf ist ohne diese Angabe nicht möglich (Exit 2)."""


def git_info() -> Dict[str, Optional[str]]:
    def run(args: List[str]) -> Optional[str]:
        try:
            out = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, timeout=10)
        except Exception:  # noqa: BLE001
            return None
        return out.stdout.strip() if out.returncode == 0 else None

    return {"commit": run(["rev-parse", "HEAD"]), "branch": run(["rev-parse", "--abbrev-ref", "HEAD"])}


def fleet_roles() -> List[str]:
    fleet = json.loads(FLEET_PATH.read_text(encoding="utf-8"))
    return [str(pod.get("role")) for pod in fleet.get("pods", []) if pod.get("role")]


def resolve_urls(roles: List[str], overrides: Dict[str, str], env: EnvSource) -> Dict[str, str]:
    """URL je Rolle: `--url`, dann `AI_POD_URL_<ROLLE>`, dann RunPod-REST der Flotte."""
    urls: Dict[str, str] = {}
    missing: List[str] = []
    for role in roles:
        explicit = overrides.get(role) or env.get(f"AI_POD_URL_{role.upper()}")
        if explicit:
            urls[role] = explicit.rstrip("/")
        else:
            missing.append(role)
    if not missing:
        return urls

    if not (env.get("RP_API_KEY") or env.get("RUNPOD_API_KEY")):
        raise ConfigError(
            "keine Pod-URL für " + ", ".join(missing) +
            " (--url <rolle>=<url>, AI_POD_URL_<ROLLE> oder RP_API_KEY für die RunPod-Abfrage)"
        )

    # Gleiche Flotten-Auflösung wie scripts/runpod-pods.py – keine zweite Wahrheit.
    import importlib.util

    spec = importlib.util.spec_from_file_location("rp", SCRIPTS / "runpod-pods.py")
    if spec is None or spec.loader is None:  # pragma: no cover – Datei fehlt
        raise ConfigError("scripts/runpod-pods.py nicht lesbar")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    fleet = json.loads(FLEET_PATH.read_text(encoding="utf-8"))
    pods = module.fleet_pods(fleet)
    port = int(fleet["port"])
    by_name = {str(pod.get("name")): pod for pod in pods}
    for role in missing:
        pod = by_name.get(f"{fleet['namePrefix']}{role}")
        if pod is None:
            continue
        urls[role] = module.proxy_url(pod["id"], port)
    unresolved = [role for role in missing if role not in urls]
    if unresolved:
        raise ConfigError("Pods nicht gefunden (laufen sie?): " + ", ".join(unresolved))
    return urls


# ------------------------------------------------------------------------- Sammeln
def collect_role(role: str, base: str, token: str, load: Dict[str, Any],
                 duration: float, interval: float, users: int) -> Dict[str, Any]:
    """Ein Lastfenster: Sampler starten, 4 Nutzer fahren, Report abholen."""
    started_status, started = http_json(base, "/vram/report", token, {
        "action": "start", "durationSeconds": duration, "intervalSeconds": interval, "users": users,
    }, timeout=30.0)
    if started_status not in (202, 409):
        return {
            "report": {},
            "requests": summarize_requests([], load),
            "error": f"POST /vram/report action=start → HTTP {started_status}: "
                     f"{json.dumps(started, ensure_ascii=False)[:200]}",
            "reachable": started_status != 0,
        }

    results: List[Dict[str, Any]] = []
    lock = threading.Lock()
    deadline = time.monotonic() + duration
    workers = [
        threading.Thread(target=user_loop, args=(base, token, load, deadline, results, lock), daemon=True)
        for _ in range(users)
    ]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join(timeout=duration + 60)
    # Nutzer, die ein Modell erst laden, brauchen länger – aber nicht ewig.
    for worker in workers:
        if worker.is_alive():
            worker.join(timeout=30)

    wait_status, finished = http_json(base, "/vram/report", token, {
        "action": "wait", "waitSeconds": min(60.0, duration + 30.0),
    }, timeout=duration + 45.0)
    if wait_status in (200, 202) and isinstance(finished, dict) and "gpu" in finished:
        report = finished
    else:
        get_status, report = http_json(base, "/vram/report", token, timeout=30.0)
        if get_status != 200 or not isinstance(report, dict):
            return {
                "report": {},
                "requests": summarize_requests(results, load),
                "error": f"GET /vram/report → HTTP {get_status}: "
                         f"{json.dumps(report, ensure_ascii=False)[:200]}",
                "reachable": get_status != 0,
            }
    return {"report": report, "requests": summarize_requests(results, load), "error": None, "reachable": True}


def build_record(role: str, base: str, pod_id: Optional[str], collected: Dict[str, Any],
                 users: int, duration: float, interval: float, git: Dict[str, Optional[str]]) -> Dict[str, Any]:
    report = collected["report"]
    requests = collected["requests"]
    status, reasons = evaluate(report, requests)
    if collected.get("error"):
        status, reasons = "NOT_MEASURED", [collected["error"], *reasons]
    gpu = report.get("gpu") or {}
    load = report.get("load") or {}
    return {
        "schemaVersion": 1,
        "ticket": TICKET,
        "status": status,
        "reasons": reasons,
        "role": role,
        "podId": pod_id,
        "endpoint": base,
        "collectedAt": datetime.now(timezone.utc).isoformat(),
        "date": date.today().isoformat(),
        "gitCommit": git.get("commit"),
        "gitBranch": git.get("branch"),
        "driverVersion": gpu.get("driverVersion"),
        "cudaVersion": gpu.get("cudaVersion"),
        "gpu": gpu,
        "peakMb": load.get("peakMb"),
        "avgMb": load.get("avgMb"),
        "budgetMb": (report.get("verdict") or {}).get("budgetMb"),
        "withinBudget": (report.get("verdict") or {}).get("withinBudget"),
        "users": users,
        "durationSeconds": duration,
        "intervalSeconds": interval,
        "phases": report.get("phases") or {},
        "load": load,
        "requests": requests,
        "runtime": report.get("runtime") or {},
    }


def write_record(record: Dict[str, Any], out_dir: pathlib.Path) -> pathlib.Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{record['role']}-{record['date']}.json"
    path.write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


# ---------------------------------------------------------------------------- CLI
def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=f"{TICKET}: VRAM-Report je Pod-Rolle einsammeln")
    parser.add_argument("--group", default="all", help="all | core | generation (Default: all)")
    parser.add_argument("--roles", default="", help="Komma-Liste, überschreibt --group")
    parser.add_argument("--url", action="append", default=[], metavar="ROLLE=URL",
                        help="Pod-URL je Rolle (mehrfach); Default: AI_POD_URL_<ROLLE> oder RunPod-REST")
    parser.add_argument("--duration", type=float, default=20.0, help="Messfenster in s (Default: 20)")
    parser.add_argument("--interval", type=float, default=0.5, help="Sample-Intervall in s (Default: 0.5)")
    parser.add_argument("--users", type=int, default=4, help="parallele Nutzer (Default: 4)")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="Zielordner (Default: test-results/vram)")
    parser.add_argument("--env-file", default=str(ROOT / ".env.deploy"), help="Env-Datei (Default: .env.deploy)")
    parser.add_argument("--load-file", default="", help="JSON mit {rolle: {task, model, input}}")
    parser.add_argument("--dry-run", action="store_true", help="nur Plan zeigen, kein Netzaufruf")
    return parser.parse_args(argv)


def select_roles(args: argparse.Namespace) -> List[str]:
    known = fleet_roles()
    if args.roles:
        roles = [role.strip() for role in args.roles.split(",") if role.strip()]
    elif args.group in GROUPS:
        roles = GROUPS[args.group]
    elif args.group in known:
        roles = [args.group]
    else:
        raise ConfigError(f"unbekannte Gruppe {args.group!r} (erlaubt: {', '.join(GROUPS)}, {', '.join(known)})")
    unknown = [role for role in roles if role not in known]
    if unknown:
        raise ConfigError(f"Rolle nicht in der Flotte: {', '.join(unknown)}")
    return roles


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    env = EnvSource(pathlib.Path(args.env_file))
    try:
        roles = select_roles(args)
        overrides: Dict[str, str] = {}
        for item in args.url:
            role, _, url = item.partition("=")
            if not role or not url:
                raise ConfigError(f"--url erwartet ROLLE=URL, bekommen: {item!r}")
            overrides[role.strip()] = url.strip()

        loads = {role: role_request(role) for role in roles}
        if args.load_file:
            custom = json.loads(pathlib.Path(args.load_file).read_text(encoding="utf-8"))
            for role in roles:
                if role in custom:
                    loads[role] = {k: custom[role][k] for k in ("task", "model", "input")}

        token = env.get("AI_POD_TOKEN")
        if not token and not args.dry_run:
            print("Hinweis: AI_POD_TOKEN fehlt – Aufruf ohne Authorization (nur für lokalen Test gedacht).")

        if args.dry_run:
            print(f"{TICKET}: Plan (kein Netzaufruf)")
            for role in roles:
                url = overrides.get(role) or env.get(f"AI_POD_URL_{role.upper()}") or "<RunPod-REST>"
                load = loads[role]
                print(f"  {role:6} {url:40} task={load['task']:14} model={load['model']}")
            print(f"  Fenster: {args.duration:.0f}s, Intervall {args.interval:.1f}s, {args.users} Nutzer, "
                  f"Ziel: {pathlib.Path(args.out)}/<rolle>-<datum>.json")
            return 0

        urls = resolve_urls(roles, overrides, env)
        git = git_info()
        out_dir = pathlib.Path(args.out)
        exit_code = 0
        records: List[Dict[str, Any]] = []
        for role in roles:
            base = urls[role]
            host = base.split("//", 1)[-1].split("/", 1)[0]
            pod_id = host.split("-", 1)[0] if host.endswith(".proxy.runpod.net") else None
            print(f"\n=== {role} ({base}) ===", flush=True)
            collected = collect_role(role, base, token, loads[role], args.duration, args.interval, args.users)
            record = build_record(role, base, pod_id, collected, args.users, args.duration, args.interval, git)
            path = write_record(record, out_dir)
            records.append(record)
            peak = record["peakMb"]
            avg = record["avgMb"]
            numbers = f"peak {peak} MB · avg {avg} MB" if peak is not None else "keine Messwerte"
            print(f"  {record['status']}: {numbers} · Anfragen {record['requests']['ok']}/"
                  f"{record['requests']['count']} ok · {path}")
            for reason in record["reasons"]:
                print(f"    - {reason}")
            if record["status"] != "MEASURED" or record["withinBudget"] is False:
                exit_code = 4

        print("\n" + "=" * 78)
        for record in records:
            flag = "✔" if record["status"] == "MEASURED" else "✖"
            budget = "" if record["withinBudget"] is None else (" · < 42 GB" if record["withinBudget"] else " · ÜBER 42 GB")
            print(f"{flag} {record['role']:6} {record['status']:13} peak={record['peakMb']} avg={record['avgMb']}{budget}")
        if exit_code == 0:
            print("Alle Rollen gemessen.")
            if all(record.get("podId") for record in records):
                print("Werte in docs/AI_FLEET_STARTPLAN.md und model_manifest.json übernehmen.")
            else:
                print("ACHTUNG: mindestens ein Endpunkt war kein RunPod-Proxy. Nur übernehmen, "
                      "wenn der Lauf auf der echten A40 im Pod stattfand.")
        else:
            print("Mindestens eine Rolle NICHT gemessen – Report nennt die Gründe. Keine Zahlen raten.")
        return exit_code
    except ConfigError as exc:
        print(f"Konfigurationsfehler: {exc}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
