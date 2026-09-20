#!/usr/bin/env python3
"""
audioMONASTRY · RunPod-Flottenwache (festgefahrene Rollen erkennen)
==================================================================
Liest fuer JEDE Rolle den Serverless-Health-Zustand und meldet den Ausfallmodus,
der am 2026-09-20 die Stimmen-Rolle stillgelegt hat, BEVOR jemand ihn bemerkt.

Warum es dieses Skript gibt (INFRA-RUNPOD-010, live belegt 2026-09-20)
----------------------------------------------------------------------
Alle acht Endpoints fahren `workersMax=1`. Ein einziger `unhealthy` Worker hielt
den Slot, also startete RunPod keinen frischen Worker und die Jobs lagen fest -
gemessen: **19,6 min** Wartezeit (`delayTime=1175156 ms`) auf **7,6 s** echte
Arbeit, dazu 0/3 Hoerproben mit Status `IN_QUEUE`. Niemand wurde gewarnt; es
faellt nur auf, wenn jemand auf Ton wartet. Diese Wache macht den Zustand
sichtbar und (auf Freigabe) mit einem PATCH wieder loesbar.

Erkennungsregel (rein, in `classify_status`, ohne I/O testbar)
--------------------------------------------------------------
  FESTGEFAHREN  jobs.inQueue > 0 UND workers.running == 0 UND workers.ready == 0
                UND workers.initializing == 0 -> niemand kann bedienen.
  STARTET       jobs.inQueue > 0 UND workers.initializing > 0 -> Kaltstart laeuft.
  UNGESUND      workers.unhealthy > 0 UND workers.running == 0 (unhealthy belegt den
                Slot, bedient aber nicht) -> Vorstufe zum Stillstand, beobachten.
  VERDAECHTIG   jobs.inQueue > 0 UND workers.running > 0 UND nichts frei (ready/idle 0)
                -> ein laufender Worker arbeitet die Queue nicht ab. Live belegt
                2026-09-20 (Rolle music: Job 15 min auf IN_QUEUE). Ehrlich als Verdacht
                gemeldet, weil ein legitim langer Job genauso aussieht.
  FESTGEFAHREN wird mit `--confirm-seconds` (Default 30) ein zweites Mal geprueft, damit
                das kurze Fenster direkt nach dem Absetzen eines Jobs keinen Fehlalarm
                ausloest (live passiert: orchestrator).
  OK            sonst (auch scale-to-zero ohne Queue: kein Worker ist normal).

Zugang
------
  Health:  https://api.runpod.ai/v2/<endpoint-id>/health   (Bearer-Token)
  Config:  https://rest.runpod.io/v1/endpoints/<id>        (GET/PATCH)
  Beide brauchen einen Browser-User-Agent - ohne ihn antwortet Cloudflare mit
  HTTP 403 (live belegt 2026-09-20). Das uebernimmt `transport()` aus
  scripts/runpod-warm.py, das dieses Skript per importlib wiederverwendet:
  eine Implementierung, ein Verhalten, kein Zweitcode.

Heilung (nur mit --heal UND Freigabe UND Stundensatz)
----------------------------------------------------
  PATCH {"workersMax": max(ist, 2)} - der festgefahrene Worker kann den Slot nicht
  mehr allein blockieren. Mit --drain-minutes wartet die Wache, bis die Queue leer
  ist, und stellt `workersMax` danach auf den Ausgangswert zurueck (Ruecklesung).
  Der Ausgangswert wird VOR der Aenderung gelesen, nicht angenommen.
  Kosten entstehen dabei durch einen moeglichen zweiten Worker - der Stundensatz
  ist PFLICHTEINGABE (--price-per-hour, Quelle zum Ablesen: `runpodctl gpu list`,
  Feld `securePricePerHr`); das Skript erfindet keinen Preis.

Exit-Codes
----------
  0 = alles gesund - oder geheilt und zurueckgestellt
  2 = Aufruf-/Konfigurationsfehler (Rolle, Endpoint-ID, Preis, Modus)
  3 = --heal ohne Freigabe (--yes/RP_HEALTH_APPROVE) -> KEIN einziger HTTP-Aufruf
  4 = Handlungsbedarf: mindestens eine Rolle ist festgefahren (ohne --heal)
  5 = Health-/Config-Abfrage fehlgeschlagen
  6 = Heilung fehlgeschlagen oder Rueckstellung nicht bestaetigt (JETZT handeln:
      `scripts/runpod-warm.py --role <rolle>` bzw. workersMax in der Konsole)

Siehe docs/RUNPOD_COLDSTART.md fuer den Betreiber-Ablauf.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import pathlib
import sys
from typing import Any, Dict, List, Optional, Sequence, Tuple

ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_ENV_FILE = ROOT / ".env"
HEALTH_URL = "https://api.runpod.ai/v2/{endpoint}/health"
REST_ENDPOINT_URL = "https://rest.runpod.io/v1/endpoints/{endpoint}"

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_NO_APPROVAL = 3
EXIT_STUCK = 4
EXIT_QUERY = 5
EXIT_HEAL_FAILED = 6

STATUS_OK = "OK"
STATUS_STARTING = "STARTET"
STATUS_UNHEALTHY = "UNGESUND"
STATUS_SUSPICIOUS = "VERDAECHTIG"
STATUS_STUCK = "FESTGEFAHREN"
STATUS_ERROR = "FEHLER"


def _load_warm_module() -> Any:
    """scripts/runpod-warm.py laden (Bindestrich-Dateiname -> importlib).

    Bewusst KEIN Zweitcode: Endpoint-Aufloesung, .env-Lesen und `transport()`
    (inkl. Browser-UA gegen Cloudflare-403) kommen unveraendert von dort.
    """
    path = pathlib.Path(__file__).resolve().parent / "runpod-warm.py"
    spec = importlib.util.spec_from_file_location("runpod_warm_for_guard", path)
    if spec is None or spec.loader is None:  # pragma: no cover - nur bei kaputtem Repo
        raise RuntimeError(f"scripts/runpod-warm.py nicht ladbar: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


warm = _load_warm_module()


# ---------------------------------------------------------------------------
# Erkennung (rein, ohne I/O)
# ---------------------------------------------------------------------------
def _as_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def classify_status(payload: Any) -> Tuple[str, str]:
    """Health-Antwort -> (Status, Begruendung). Rein und damit testbar."""
    if not isinstance(payload, dict):
        return STATUS_ERROR, "Health-Antwort nicht lesbar"
    workers = payload.get("workers")
    jobs = payload.get("jobs")
    # Streng mit Absicht: fehlt einer der Bloecke oder hat er den falschen Typ, darf
    # die Wache NICHT "gesund" melden - eine geaenderte API-Antwort soll auffallen,
    # nicht still als scale-to-zero durchgehen.
    if not isinstance(workers, dict) or not isinstance(jobs, dict):
        return STATUS_ERROR, "Health-Antwort ohne workers/jobs (Block fehlt oder falscher Typ)"
    q = _as_int(jobs.get("inQueue"))
    running = _as_int(workers.get("running"))
    ready = _as_int(workers.get("ready"))
    idle = _as_int(workers.get("idle"))
    initializing = _as_int(workers.get("initializing"))
    unhealthy = _as_int(workers.get("unhealthy"))

    if q > 0 and running == 0 and ready == 0 and initializing == 0:
        return (
            STATUS_STUCK,
            f"{q} Job(s) in der Queue, aber kein bedienender Worker "
            f"(unhealthy={unhealthy}) - Slot blockiert",
        )
    if q > 0 and initializing > 0:
        return STATUS_STARTING, f"{q} Job(s) warten, {initializing} Worker startet (Kaltstart)"
    if q > 0 and running > 0 and ready == 0 and idle == 0:
        # Live belegt 2026-09-20 (Rolle music): ein Worker meldet "laufend", arbeitet die
        # Queue aber nicht ab - mein Job stand 15 min auf IN_QUEUE. EHRLICH als Verdacht
        # gemeldet, nicht als Gewissheit: ein legitim langer Job sieht genauso aus.
        return (
            STATUS_SUSPICIOUS,
            f"{q} Job(s) warten, {running} Worker laeuft, aber keiner ist frei "
            f"(kann ein langer Job sein - oder ein haengender)",
        )
    if running == 0 and unhealthy > 0:
        return STATUS_UNHEALTHY, f"unhealthy={unhealthy}, kein laufender Worker, Queue leer"
    if ready > 0 or idle > 0 or running > 0:
        return STATUS_OK, f"{ready} bereit, {running} laufend, Queue {q}"
    return STATUS_OK, "scale-to-zero, kein Worker noetig"


def cost_block(price_per_hour: float, usd_eur: float) -> List[str]:
    """Kostenhinweis VOR jeder Aenderung - ohne erfundene Zahlen."""
    worst = price_per_hour * 1.0
    return [
        "[wache] Kostenhinweis vor der Heilung:",
        f"[wache]   Stundensatz        : {price_per_hour:.2f} USD/h (Eingabe des Betreibers; Quelle: runpodctl gpu list securePricePerHr)",
        f"[wache]   Moeglicher zweiter Worker: {worst:.2f} USD/h (~{worst * usd_eur:.2f} EUR/h) fuer die Dauer der Heilung",
        "[wache]   Die Heilung laeuft nur so lange wie noetig; ohne --drain-minutes wartet sie nicht und stellt sofort zurueck.",
    ]


# ---------------------------------------------------------------------------
# I/O
# ---------------------------------------------------------------------------
def read_role_health(
    role: str, endpoint_id: str, token: str, confirm_seconds: float = 0.0
) -> Tuple[str, str, Dict[str, Any]]:
    """Health einer Rolle lesen und einordnen.

    `confirm_seconds > 0` prueft einen FESTGEFAHREN-Verdacht ein zweites Mal nach
    dieser Wartezeit. Grund (live belegt 2026-09-20): direkt nach dem Absetzen eines
    Jobs gibt es ein kurzes Fenster, in dem der Job schon in der Queue steht, der
    Worker aber noch in keinem Zaehler auftaucht - die erste Lesung meldete da
    faelschlich FESTGEFAHREN fuer `orchestrator`, der Job lief danach sauber durch.
    """
    status_code, payload = warm.transport(
        "GET", HEALTH_URL.format(endpoint=endpoint_id), None, token
    )
    if status_code != 200 or not isinstance(payload, dict):
        return STATUS_ERROR, f"HTTP {status_code}: {str(payload)[:120]}", {}
    status, reason = classify_status(payload)
    if status == STATUS_STUCK and confirm_seconds > 0:
        warm.wait(confirm_seconds)
        code2, payload2 = warm.transport(
            "GET", HEALTH_URL.format(endpoint=endpoint_id), None, token
        )
        if code2 == 200 and isinstance(payload2, dict):
            status2, reason2 = classify_status(payload2)
            if status2 != STATUS_STUCK:
                return status2, f"nach {int(confirm_seconds)} s bestaetigt: {reason2}", payload2
            return status2, f"{reason2} (nach {int(confirm_seconds)} s erneut bestaetigt)", payload2
    return status, reason, payload


def heal_role(role: str, endpoint_id: str, token: str) -> Tuple[bool, str, Optional[int], bool]:
    """workersMax auf mindestens 2 heben.

    Rueckgabe: (ok, Meldung, Ausgangswert, geaendert). `geaendert=False` heisst:
    der Wert war schon hoch genug - dann darf auch NICHT zurueckgestellt werden,
    sonst schreibt die Wache ohne Anlass in die Produktion.
    """
    code, cfg = warm.transport("GET", REST_ENDPOINT_URL.format(endpoint=endpoint_id), None, token)
    if code != 200 or not isinstance(cfg, dict):
        return False, f"Endpoint-Config nicht lesbar (HTTP {code})", None, False
    original = _as_int(cfg.get("workersMax"))
    target = max(original, 2)
    if target == original:
        return True, f"workersMax steht bereits auf {original} - nichts zu heben", original, False
    code2, answer = warm.transport(
        "PATCH", REST_ENDPOINT_URL.format(endpoint=endpoint_id), {"workersMax": target}, token
    )
    if code2 != 200:
        return False, f"PATCH workersMax={target} fehlgeschlagen (HTTP {code2}): {str(answer)[:120]}", original, False
    return True, f"workersMax {original} -> {target} gesetzt", original, True


def restore_role(endpoint_id: str, original: Optional[int], token: str) -> Tuple[bool, str]:
    """workersMax auf den Ausgangswert zurueckstellen UND nachlesen."""
    if original is None:
        return True, "kein Ausgangswert bekannt - nichts zurueckzustellen"
    code, answer = warm.transport(
        "PATCH", REST_ENDPOINT_URL.format(endpoint=endpoint_id), {"workersMax": original}, token
    )
    if code != 200:
        return False, f"PATCH workersMax={original} fehlgeschlagen (HTTP {code}): {str(answer)[:120]}"
    code2, cfg = warm.transport("GET", REST_ENDPOINT_URL.format(endpoint=endpoint_id), None, token)
    if code2 != 200 or not isinstance(cfg, dict):
        return False, f"Rueckstellung nicht nachlesbar (HTTP {code2})"
    now = _as_int(cfg.get("workersMax"))
    if now != original:
        return False, f"Ruecklesung weicht ab: workersMax={now}, erwartet {original}"
    return True, f"workersMax zurueck auf {original} (nachgelesen)"


def drain_wait(endpoint_id: str, token: str, minutes: float) -> bool:
    """Warten, bis die Queue leer ist (max. `minutes`). Tests ersetzen `wait`."""
    if minutes <= 0:
        return True
    deadline = minutes * 60.0
    waited = 0.0
    step = 10.0
    while waited < deadline:
        code, payload = warm.transport(
            "GET", HEALTH_URL.format(endpoint=endpoint_id), None, token
        )
        if code == 200 and isinstance(payload, dict):
            q = _as_int((payload.get("jobs") or {}).get("inQueue"))
            if q == 0:
                print(f"[wache]   Queue leer nach {int(waited)} s Wartezeit")
                return True
        else:
            print(f"[wache]   Health beim Warten nicht lesbar (HTTP {code})")
        warm.wait(step)
        waited += step
    print(f"[wache]   Queue nach {int(minutes)} min noch nicht leer - trotzdem zurueckstellen")
    return False


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="RunPod-Flottenwache: erkennt festgefahrene Rollen (unhealthy Worker hält den Slot).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Beispiele:\n"
            "  python3 scripts/runpod-health-guard.py                      # nur berichten\n"
            "  python3 scripts/runpod-health-guard.py --json                # Bericht als JSON\n"
            "  python3 scripts/runpod-health-guard.py --heal --price-per-hour 0.69 --yes\n"
            "  python3 scripts/runpod-health-guard.py --heal --role voiceGen --drain-minutes 15 \\\n"
            "      --price-per-hour 0.69 --yes\n"
        ),
    )
    parser.add_argument("--role", action="append", default=None, help="nur diese Rolle(n) pruefen")
    parser.add_argument("--env-file", default=str(DEFAULT_ENV_FILE), help="Pfad zur .env")
    parser.add_argument("--heal", action="store_true", help="festgefahrene Rollen heben workersMax auf mind. 2")
    parser.add_argument("--drain-minutes", type=float, default=0.0, help="nach der Heilung auf leere Queue warten (max.)")
    parser.add_argument(
        "--confirm-seconds",
        type=float,
        default=30.0,
        help="einen FESTGEFAHREN-Verdacht nach dieser Wartezeit erneut pruefen (Default 30, 0 = aus)",
    )
    parser.add_argument("--price-per-hour", type=float, default=None, help="Stundensatz (PFLICHT bei --heal)")
    parser.add_argument("--usd-eur", type=float, default=0.92, help="nur Anzeige (Default 0.92)")
    parser.add_argument("--yes", action="store_true", help="Freigabe erteilen (auch RP_HEALTH_APPROVE=1)")
    parser.add_argument("--json", action="store_true", dest="as_json", help="Bericht als JSON (fuer Cron/Logs)")
    return parser


def resolve_roles(requested: Optional[List[str]]) -> List[str]:
    known = sorted(warm.ROLE_DEFAULTS.keys())
    if not requested:
        return known
    resolved: List[str] = []
    for name in requested:
        role = warm.resolve_role(name)
        if role not in resolved:
            resolved.append(role)
    return resolved


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    approve = args.yes or (sys_approve())
    if args.heal and not approve:
        print(
            "[wache] GATE: --heal ohne Freigabe - es wird KEIN HTTP-Aufruf gesendet. "
            "Freigabe: --yes oder RP_HEALTH_APPROVE=1",
            file=sys.stderr,
        )
        return EXIT_NO_APPROVAL
    if args.heal and (args.price_per_hour is None or args.price_per_hour <= 0):
        print(
            "[wache] FEHLER: --heal braucht den Stundensatz (--price-per-hour). "
            "Quelle zum Ablesen: runpodctl gpu list (securePricePerHr). "
            "Das Skript erfindet keinen Preis.",
            file=sys.stderr,
        )
        return EXIT_USAGE

    try:
        source = warm.EnvSource(pathlib.Path(args.env_file) if args.env_file else None)
        token = source.get("RP_API_KEY")
        if not token:
            print("[wache] FEHLER: RP_API_KEY fehlt (Prozess-Env oder .env)", file=sys.stderr)
            return EXIT_USAGE
        roles = resolve_roles(args.role)
    except Exception as exc:  # noqa: BLE001
        print(f"[wache] FEHLER: {exc}", file=sys.stderr)
        return EXIT_USAGE

    if args.heal and args.price_per_hour:
        for line in cost_block(args.price_per_hour, args.usd_eur):
            print(line)

    report: List[Dict[str, Any]] = []
    query_failed = False
    stuck: List[str] = []
    healed: List[str] = []
    heal_failed = False

    for role in roles:
        try:
            endpoint_id = warm.resolve_endpoint_id(role, source)
            status, reason, _payload = read_role_health(
                role, endpoint_id, token, args.confirm_seconds
            )
        except Exception as exc:  # noqa: BLE001
            status, reason, endpoint_id = STATUS_ERROR, f"{type(exc).__name__}: {exc}", ""
        entry: Dict[str, Any] = {
            "role": role,
            "endpoint": endpoint_id,
            "status": status,
            "reason": reason,
        }
        if status == STATUS_ERROR:
            query_failed = True
        if status == STATUS_STUCK:
            stuck.append(role)
            if args.heal:
                ok, message, original, changed = heal_role(role, endpoint_id, token)
                entry["heal"] = message
                if not ok:
                    heal_failed = True
                elif not changed:
                    # Nichts gehoben -> nichts zurueckzustellen (kein Schreibzugriff ohne Anlass).
                    entry["restore"] = "keine Aenderung noetig"
                    healed.append(role)
                else:
                    drain_wait(endpoint_id, token, args.drain_minutes)
                    ok_back, message_back = restore_role(endpoint_id, original, token)
                    entry["restore"] = message_back
                    if ok_back:
                        healed.append(role)
                    else:
                        heal_failed = True
        report.append(entry)
        if not args.as_json:
            print(f"[wache] {role:14s} {status:12s} {reason}")
            if entry.get("heal"):
                print(f"[wache]   Heilung: {entry['heal']}")
            if entry.get("restore"):
                print(f"[wache]   Rueckstellung: {entry['restore']}")

    summary = {
        "checked": len(roles),
        "stuck": stuck,
        "healed": healed,
        "healthy": [e["role"] for e in report if e["status"] in (STATUS_OK, STATUS_STARTING)],
        "unhealthy": [e["role"] for e in report if e["status"] == STATUS_UNHEALTHY],
        "suspicious": [e["role"] for e in report if e["status"] == STATUS_SUSPICIOUS],
        "errors": [e["role"] for e in report if e["status"] == STATUS_ERROR],
    }
    if args.as_json:
        print(json.dumps({"roles": report, "summary": summary}, ensure_ascii=False, indent=2))
    else:
        print(
            f"[wache] Ergebnis: {summary['checked']} Rollen geprueft, "
            f"{len(summary['healthy'])} gesund/startend, {len(summary['unhealthy'])} ungesund, "
            f"{len(summary['suspicious'])} verdaechtig, "
            f"{len(stuck)} festgefahren, {len(summary['errors'])} nicht abfragbar"
        )
        if summary["suspicious"]:
            print(
                "[wache] VERDAECHTIG (kann ein langer Job sein, bitte ansehen): "
                + ", ".join(summary["suspicious"])
            )
        if stuck and not args.heal:
            print(
                "[wache] HANDLUNGSBEDARF: festgefahren = "
                + ", ".join(stuck)
                + " -> sofort loesen mit:\n"
                "  python3 scripts/runpod-health-guard.py --heal --role <rolle> "
                "--price-per-hour <satz> --yes\n"
                "  (oder in der Konsole den Worker neu starten)"
            )

    if heal_failed:
        return EXIT_HEAL_FAILED
    if query_failed:
        return EXIT_QUERY
    if stuck and not args.heal:
        return EXIT_STUCK
    return EXIT_OK


def sys_approve() -> bool:
    """Freigabe per Umgebungsvariable (fuer Cron/systemd)."""
    import os

    return os.environ.get("RP_HEALTH_APPROVE", "") == "1"


if __name__ == "__main__":
    raise SystemExit(main())
