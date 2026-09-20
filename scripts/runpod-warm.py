#!/usr/bin/env python3
"""
audioMONASTRY · RunPod-Warmhalter (workersMin=1 auf Zeit)
=========================================================
Hebt fuer EINE Rolle voruebergehend `workersMin=1` und stellt den Ausgangswert
danach GARANTIERT wieder her - auch bei Strg-C, Fehler oder Ausnahme (das
Zurueckstellen steht im `finally`). Der Ausgangswert wird VOR der Aenderung per
GET gelesen, nicht angenommen.

Warum es dieses Skript gibt (INFRA-RUNPOD-010, live belegt 2026-09-20)
----------------------------------------------------------------------
Die Flotte faehrt alle acht Endpoints mit `workersMax=1`. Ein einziger
`unhealthy` Worker hielt den Slot, also startete RunPod keinen frischen Worker und
die Jobs lagen fest: ein Messjob wartete **19,6 min** auf **7,6 s** echte Arbeit
(0/3 Hoerproben). Der Sofort-Ausweg war `PATCH {"workersMax":2}`, danach wieder
`1` - mit warmem Worker liefen 3/3 Proben in 36 s. Die zweite Ursache ist der
lange Kaltstart (keine Gewichte im Image, kein Network Volume, `HF_HOME` im
Container). Dieser Warmhalter ist die dritte, reversible Abhilfe: waehrend einer
Session ist der Worker schon da, also gibt es weder Kaltstart noch Deadlock.

Harte Regel: Kostenrechnung zuerst, dann Freigabe, dann erst API.
Der Kostenblock wird VOR jeder Aenderung gedruckt; ohne `--yes` (oder
`RP_WARM_APPROVE=1`) wird kein einziger HTTP-Aufruf gesendet (Exit 3).

Kostenrechnung (keine erfundenen Zahlen)
----------------------------------------
  Kosten = Stundensatz x Zeit
  Zeit   = --minutes + Idle-Nachlauf der Rolle
           (der Worker laeuft nach dem Zurueckstellen noch seinen `idleTimeout`
           weiter und wird in dieser Zeit WEITER abgerechnet)
  Stundensatz: PFLICHTWERT des Betreibers (--price-per-hour oder
           RP_WARM_PRICE_PER_H / RP_GPU_PRICE_PER_H). Quelle zum Ablesen:
           `runpodctl gpu list` (Feld `securePricePerHr`). Das Skript erfindet
           keinen Preis und liest ihn auch nicht selbst.

Zugang
------
  https://rest.runpod.io/v1/endpoints/<id> (GET/PATCH) mit
  `Authorization: Bearer <RP_API_KEY>` UND einem Browser-User-Agent: die
  REST-API liegt hinter Cloudflare und antwortet ohne Browser-UA mit HTTP 403
  (live belegt 2026-09-20).

  Endpoint-ID je Rolle aus der .env: RP_ENDPOINT_ID_<TOKEN>, kanonisch
  RP_ENDPOINT_ID_VOICE (voiceGen), RP_ENDPOINT_ID_IMAGE (imageHq),
  RP_ENDPOINT_ID_VIDEO_REAL, RP_ENDPOINT_ID_VIDEO_ABSTRACT, ...; zusaetzlich die
  mechanischen Namen (RP_ENDPOINT_ID_VOICEGEN), die Altnamen (RP_ENDPOINT_ID_VISION)
  und als letzter Fallback das generische RP_ENDPOINT_ID.

Modi
----
  --dry-run   Nur rechnen und zeigen, was passieren wuerde: KEIN HTTP-Aufruf.
  (Default)   Voller Lauf: Kostenblock -> Gate -> GET (Ausgangswert) ->
              PATCH workersMin=1 -> warten -> PATCH zurueck -> Ruecklesung.

Exit-Codes
----------
  0 = Warmhalter gefahren UND zurueckgestellt (Ruecklesung belegt es)
  2 = Aufruf-/Konfigurationsfehler (Rolle, Endpoint-ID, Preis, Minuten-Grenze,
      workersMin nicht lesbar)
  3 = Freigabe fehlt (--yes/RP_WARM_APPROVE) -> KEIN API-Aufruf
  4 = Lauf abgebrochen/fehlgeschlagen (zurueckgestellt wurde trotzdem)
  5 = Zurueckstellen fehlgeschlagen oder Ruecklesung weicht ab (JETZT handeln:
      `runpodctl endpoint update --id <id> --min-workers <wert>`)

Siehe docs/RUNPOD_COLDSTART.md fuer den Betreiber-Ablauf und die Abwaegungen.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_ENV_FILE = ROOT / ".env"

REST_BASE = "https://rest.runpod.io/v1"

#: Browser-User-Agent: Pflicht. Ohne ihn beantwortet Cloudflare die REST-API mit
#: HTTP 403 (live belegt 2026-09-20 beim PATCH gegen einen voice-Endpoint).
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_GATE = 3
EXIT_RUN_FAILED = 4
EXIT_RESTORE_FAILED = 5

#: Harte Obergrenze der Warmhalter-Dauer (Minuten). Sie begrenzt die Kosten nach
#: oben: laenger als 2 h bleibt ein Worker stehen, der weiter abgerechnet wird.
MAX_MINUTES = 120.0
DEFAULT_MINUTES = 30.0

#: Euro-Umrechnung nur fuer die Anzeige (derselbe Satz wie im Repo,
#: docs/AI_COST_GUIDE.md: $2.50/h ~ 2,30 EUR/h). Gerechnet wird in --currency.
DEFAULT_USD_EUR = 0.92

#: Altnamen der 5-Rollen-Architektur (Spiegel von LEGACY_ROLE_ALIASES im
#: Deploy-Skript; tests/test_runpod_warm.py vergleicht beide Tabellen).
LEGACY_ROLE_ALIASES: Dict[str, str] = {"vision": "imageHq", "video": "videoReal"}

# ---------------------------------------------------------------------------
# Rollen-Tabellen – Spiegel von ROLE_DEFAULTS/ENDPOINT_ENV_BY_ROLE in
# scripts/runpod-deploy.py. Das Skript bleibt bewusst ein reines stdlib-Skript
# (das Deploy-Skript importiert das runpod-SDK auf Modulebene), deshalb stehen
# die Werte hier UND werden von tests/test_runpod_warm.py gegen die Deploy-
# Tabelle geprueft, damit sie nicht auseinanderlaufen.
# ---------------------------------------------------------------------------
ROLE_DEFAULTS: Dict[str, Dict[str, Any]] = {
    "brain": {"suffix": "brain", "idleTimeout": 15},
    "ears": {"suffix": "ears", "idleTimeout": 15},
    "voiceGen": {"suffix": "voice", "idleTimeout": 120},
    "music": {"suffix": "music", "idleTimeout": 120},
    "imageHq": {"suffix": "image", "idleTimeout": 120},
    "videoReal": {"suffix": "video-real", "idleTimeout": 120},
    "videoAbstract": {"suffix": "video-abstract", "idleTimeout": 120},
    "orchestrator": {"suffix": "orchestrator", "idleTimeout": 120},
}

#: Env-Name der Endpoint-ID je Rolle (kanonisch; Spiegel von ENDPOINT_ENV_BY_ROLE).
ROLE_ENDPOINT_ENV: Dict[str, str] = {
    "brain": "RP_ENDPOINT_ID_BRAIN",
    "ears": "RP_ENDPOINT_ID_EARS",
    "voiceGen": "RP_ENDPOINT_ID_VOICE",
    "music": "RP_ENDPOINT_ID_MUSIC",
    "imageHq": "RP_ENDPOINT_ID_IMAGE",
    "videoReal": "RP_ENDPOINT_ID_VIDEO_REAL",
    "videoAbstract": "RP_ENDPOINT_ID_VIDEO_ABSTRACT",
    "orchestrator": "RP_ENDPOINT_ID_ORCHESTRATOR",
}

#: Generischer Fallback, falls nur ein Endpoint gepflegt ist.
GENERIC_ENDPOINT_ENV = "RP_ENDPOINT_ID"


class WarmUsageError(RuntimeError):
    """Aufruf-/Konfigurationsfehler (Exit 2) - es wurde nichts gesendet."""


class WarmRuntimeError(RuntimeError):
    """Laufzeitfehler nach dem Gate (Exit 4) - zurueckgestellt wird trotzdem."""


# ---------------------------------------------------------------------------
# Env-Aufloesung (Prozess-Env vor .env-Datei, dotenv-Verhalten)
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
    """Prozess-Env schlaegt .env-Datei - so gewinnt ein einmaliger Shell-Aufruf."""

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


def _env_token(role: str) -> str:
    """`voiceGen` → `VOICE_GEN`, `imageHq` → `IMAGE_HQ` (mechanischer Env-Token)."""
    out: List[str] = []
    for ch in role:
        if ch.isupper() and out:
            out.append("_")
        out.append(ch.upper())
    return "".join(out)


def resolve_role(name: str) -> str:
    """Rollennamen aufloesen (Altnamen abbilden, unbekannte = harter Fehler)."""
    role = (name or "").strip()
    if role in LEGACY_ROLE_ALIASES:
        mapped = LEGACY_ROLE_ALIASES[role]
        print(f"[warm] WARNUNG: Rolle '{role}' ist veraltet → '{mapped}'")
        return mapped
    if role not in ROLE_DEFAULTS:
        raise WarmUsageError(
            f"unbekannte Rolle {role!r} – erwartet: {', '.join(ROLE_DEFAULTS)} "
            f"(Altnamen: {', '.join(LEGACY_ROLE_ALIASES)})"
        )
    return role


def endpoint_env_names(role: str) -> List[str]:
    """Akzeptierte Env-Namen der Endpoint-ID, kanonisch zuerst."""
    names: List[str] = []
    canonical = ROLE_ENDPOINT_ENV.get(role)
    if canonical:
        names.append(canonical)
    mechanical = "RP_ENDPOINT_ID_" + _env_token(role)
    if mechanical not in names:
        names.append(mechanical)
    for legacy, mapped in LEGACY_ROLE_ALIASES.items():
        if mapped == role:
            legacy_name = "RP_ENDPOINT_ID_" + _env_token(legacy)
            if legacy_name not in names:
                names.append(legacy_name)
    return names


def resolve_endpoint_id(role: str, source: EnvSource) -> str:
    """Endpoint-ID der Rolle aus dem Env (kanonisch > mechanisch > Altname > generisch)."""
    for name in endpoint_env_names(role):
        value = source.get(name)
        if value:
            print(f"[warm] Endpoint-ID aus {name}")
            return value
    generic = source.get(GENERIC_ENDPOINT_ENV)
    if generic:
        print(f"[warm] WARNUNG: {GENERIC_ENDPOINT_ENV} (generisch) statt {ROLE_ENDPOINT_ENV[role]} genutzt")
        return generic
    raise WarmUsageError(
        f"Endpoint-ID fuer Rolle {role} fehlt – {ROLE_ENDPOINT_ENV[role]} in der .env setzen "
        f"(oder --endpoint-id / {GENERIC_ENDPOINT_ENV})."
    )


# ---------------------------------------------------------------------------
# Kostenrechnung (rein, testbar, keine erfundenen Zahlen)
# ---------------------------------------------------------------------------
def compute_plan(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Planwerte der Warmhalter-Dauer inkl. Idle-Nachlauf und harter Obergrenze."""
    price = float(cfg["price_per_hour"])
    minutes = float(cfg["minutes"])
    tail = float(cfg["idle_tail_minutes"])
    hours = (minutes + tail) / 60.0
    usd_eur = float(cfg.get("usd_eur") or 0.0)
    return {
        "price_per_hour": price,
        "currency": cfg.get("currency", "USD"),
        "minutes": round(minutes, 2),
        "idle_tail_minutes": round(tail, 2),
        "hours": round(hours, 4),
        "cost": round(price * hours, 4),
        "cost_eur": round(price * hours * usd_eur, 4) if usd_eur else None,
        "usd_eur": usd_eur or None,
    }


def cost_block(plan: Dict[str, Any], cfg: Dict[str, Any]) -> List[str]:
    """Menschenlesbarer Kostenblock - wird VOR dem Gate und VOR jeder Aenderung gedruckt."""
    currency = plan["currency"]
    tail_source = cfg.get("idle_tail_hint", "")
    lines = [
        "Kostenrechnung (Planwerte, kein Messwert):",
        f"  Stundensatz       : {plan['price_per_hour']:.2f} {currency}/h "
        f"(Eingabe des Betreibers; Quelle zum Ablesen: runpodctl gpu list → securePricePerHr)",
        f"  Warmhalter        : {plan['minutes']:.1f} min workersMin=1 (Rolle {cfg['role']})",
        f"  Idle-Nachlauf     : {plan['idle_tail_minutes']:.2f} min {tail_source} "
        f"- der Worker laeuft nach dem Zurueckstellen noch seinen idleTimeout weiter",
        f"  -> Plan           : {plan['hours']:.2f} h = {plan['cost']:.2f} {currency}"
        + (f" (~{plan['cost_eur']:.2f} EUR)" if plan.get("cost_eur") else ""),
        f"  -> HARTE OBERGRENZE: {MAX_MINUTES:.0f} min Warmhalter-Dauer "
        f"(danach wird zurueckgestellt; laengere Sessions = neuer Lauf mit neuer Freigabe)",
    ]
    return lines


def gate_check(*, approve: bool) -> Tuple[bool, str]:
    """Freigabe-Gate: ohne ausdrueckliche Freigabe kein einziger HTTP-Aufruf.

    Bewusst rein (kein Netz, kein SDK): `workersMin=1` erzeugt DAUERKOSTEN, auch
    wenn niemand etwas tut.
    """
    if not approve:
        return False, (
            "Freigabe fehlt: --yes (oder RP_WARM_APPROVE=1) wurde nicht gesetzt – "
            "workersMin=1 kostet dauerhaft und wird deshalb nur mit Freigabe gesetzt"
        )
    return True, "Freigabe erteilt (--yes)."


def read_workers_min(payload: Any) -> int:
    """`workersMin` aus der Endpoint-Antwort lesen (defensiv, mehrere Formen).

    Ohne lesbaren Ausgangswert wird NICHT geaendert: ein Zurueckstellen auf einen
    geratenen Wert waere schlimmer als kein Warmhalter.
    """
    if isinstance(payload, dict):
        for key in ("workersMin", "workers_min"):
            if payload.get(key) is not None:
                try:
                    return int(payload[key])
                except (TypeError, ValueError) as exc:
                    raise WarmUsageError(
                        f"workersMin={payload[key]!r} ist keine Zahl – Ausgangswert nicht verwertbar"
                    ) from exc
        workers = payload.get("workers")
        if isinstance(workers, dict):
            for key in ("min", "minWorkers", "workersMin"):
                if workers.get(key) is not None:
                    try:
                        return int(workers[key])
                    except (TypeError, ValueError) as exc:
                        raise WarmUsageError(
                            f"workers.min={workers[key]!r} ist keine Zahl – Ausgangswert nicht verwertbar"
                        ) from exc
    raise WarmUsageError(
        "workersMin ist aus der Endpoint-Antwort nicht lesbar – es wird NICHTS geaendert. "
        f"Antwort: {str(payload)[:200]}"
    )


# ---------------------------------------------------------------------------
# HTTP-Schicht (einziger Netzwerkzugang; tests/test_runpod_warm.py ersetzt sie)
# ---------------------------------------------------------------------------
def transport(method: str, url: str, payload: Optional[Dict[str, Any]] = None, token: str = "") -> Tuple[int, Any]:
    """Ein GET/PATCH gegen die RunPod-REST-API.

    Modulattribut mit Absicht: die Tests ersetzen `warm.transport` durch einen
    Stub, der die Aufrufe protokolliert - so beweisen sie Reihenfolge und
    Rueckstellung ohne Netz.
    """
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(url, data=body, method=method)
    request.add_header("Authorization", f"Bearer {token}")
    request.add_header("Content-Type", "application/json")
    request.add_header("Accept", "application/json")
    request.add_header("User-Agent", UA)  # ohne Browser-UA: HTTP 403 (Cloudflare)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read().decode("utf-8", "replace")
            return response.status, (json.loads(raw) if raw.strip().startswith(("{", "[")) else raw)
    except urllib.error.HTTPError as err:
        raw = err.read().decode("utf-8", "replace")
        try:
            parsed: Any = json.loads(raw)
        except json.JSONDecodeError:
            parsed = raw
        return err.code, parsed
    except Exception as exc:  # noqa: BLE001
        return 0, f"{type(exc).__name__}: {exc}"


def wait(seconds: float) -> None:
    """Wartezeit des Warmhalters. Tests ersetzen dieses Modulattribut."""
    time.sleep(seconds)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="RunPod-Warmhalter: workersMin=1 fuer eine Rolle auf Zeit, danach garantiert zurueck.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Beispiel:\n"
            "  python3 scripts/runpod-warm.py --role voiceGen --minutes 30 \\\n"
            "      --price-per-hour 0.69 --yes\n\n"
            "Quelle des Stundensatzes: runpodctl gpu list (securePricePerHr).\n"
            "Siehe docs/RUNPOD_COLDSTART.md."
        ),
    )
    parser.add_argument("--role", required=True, help="Rolle der Flotte (z. B. voiceGen, ears, orchestrator).")
    parser.add_argument("--minutes", type=float, default=None,
                        help=f"Dauer des Warmhalters in Minuten (Default {DEFAULT_MINUTES:.0f}, Maximum {MAX_MINUTES:.0f}).")
    parser.add_argument("--endpoint-id", default=None, help="Endpoint-ID direkt (schlaegt die .env).")
    parser.add_argument("--price-per-hour", type=float, default=None,
                        help="Stundensatz der GPU (Pflicht; auch RP_WARM_PRICE_PER_H/RP_GPU_PRICE_PER_H). "
                             "Quelle: runpodctl gpu list.")
    parser.add_argument("--currency", default=None, help="Waehrung des Stundensatzes (Default USD).")
    parser.add_argument("--usd-eur", type=float, default=None, help="Nur Anzeige: EUR je USD (Default 0.92).")
    parser.add_argument("--idle-tail-minutes", type=float, default=None,
                        help="Idle-Nachlauf nach dem Zurueckstellen in Minuten (Default: idleTimeout der Rolle).")
    parser.add_argument("--env-file", default=str(DEFAULT_ENV_FILE), help="Env-Datei (Default: <repo>/.env).")
    parser.add_argument("--yes", "--approve", dest="yes", action="store_true",
                        help="Freigabe erteilen (auch RP_WARM_APPROVE=1). Ohne sie: Exit 3, kein HTTP-Aufruf.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Nur rechnen und zeigen, was passieren wuerde – KEIN HTTP-Aufruf.")
    parser.add_argument("--quiet", action="store_true", help="Kostenblock kompakt ausgeben.")
    return parser


def resolve_config(args: argparse.Namespace) -> Dict[str, Any]:
    source = EnvSource(pathlib.Path(args.env_file) if args.env_file else None)
    role = resolve_role(args.role)

    raw_minutes = args.minutes
    if raw_minutes is None:
        raw_minutes = float(source.get("RP_WARM_MINUTES") or DEFAULT_MINUTES)
    minutes = float(raw_minutes)
    if minutes <= 0:
        raise WarmUsageError(f"--minutes muss > 0 sein (erhalten: {minutes:g})")
    if minutes > MAX_MINUTES:
        raise WarmUsageError(
            f"--minutes {minutes:g} liegt ueber der harten Obergrenze {MAX_MINUTES:.0f} min. "
            f"Fuer laengere Sessions den Lauf wiederholen (die Kosten laufen sonst weiter, "
            f"ohne dass jemand danach sieht)."
        )

    price = args.price_per_hour
    if price is None:
        raw_price = source.first(["RP_WARM_PRICE_PER_H", "RP_GPU_PRICE_PER_H"])
        if raw_price:
            try:
                price = float(raw_price)
            except ValueError as exc:
                raise WarmUsageError(f"Stundensatz {raw_price!r} ist keine Zahl") from exc
    if price is None or price <= 0:
        raise WarmUsageError(
            "Stundensatz fehlt: --price-per-hour (oder RP_WARM_PRICE_PER_H/RP_GPU_PRICE_PER_H) angeben. "
            "Quelle zum Ablesen: runpodctl gpu list → securePricePerHr. Das Skript erfindet keinen Preis."
        )

    role_defaults = ROLE_DEFAULTS[role]
    tail = args.idle_tail_minutes
    tail_hint = "(--idle-tail-minutes)"
    if tail is None:
        raw_tail = source.get("RP_WARM_IDLE_TAIL_MINUTES")
        if raw_tail:
            try:
                tail = float(raw_tail)
            except ValueError as exc:
                raise WarmUsageError(f"RP_WARM_IDLE_TAIL_MINUTES={raw_tail!r} ist keine Zahl") from exc
            tail_hint = "(aus RP_WARM_IDLE_TAIL_MINUTES)"
        else:
            tail = role_defaults["idleTimeout"] / 60.0
            tail_hint = f"(idleTimeout der Rolle {role}: {role_defaults['idleTimeout']} s)"
    if tail < 0:
        raise WarmUsageError("--idle-tail-minutes darf nicht negativ sein")

    endpoint_id = args.endpoint_id or resolve_endpoint_id(role, source)
    token = source.first(["RP_API_KEY", "RP_AGENT_KEY", "RUNPOD_API_KEY"])
    if not token and not args.dry_run:
        raise WarmUsageError("RP_API_KEY fehlt (aus der .env oder der Umgebung) – ohne Token kein API-Zugriff.")

    return {
        "role": role,
        "endpoint_id": endpoint_id,
        "endpoint_name": f"audiomonastry-ai-{role_defaults['suffix']}",
        "minutes": minutes,
        "price_per_hour": float(price),
        "currency": args.currency or source.get("RP_WARM_CURRENCY") or "USD",
        "usd_eur": args.usd_eur if args.usd_eur is not None else DEFAULT_USD_EUR,
        "idle_tail_minutes": float(tail),
        "idle_tail_hint": tail_hint,
        "token": token,
        "dry_run": bool(args.dry_run),
        "quiet": bool(args.quiet),
        "approve": bool(args.yes) or source.flag("RP_WARM_APPROVE") or source.flag("RP_WARM_YES"),
    }


def rest_url(cfg: Dict[str, Any]) -> str:
    return f"{REST_BASE}/endpoints/{cfg['endpoint_id']}"


def run_warm(cfg: Dict[str, Any]) -> int:
    """Warmhalter fahren: GET (Ausgangswert) -> PATCH 1 -> warten -> PATCH zurueck -> GET."""
    url = rest_url(cfg)
    print(f"[warm] GET {url} (Ausgangswert lesen) …", flush=True)
    status, payload = transport("GET", url, None, cfg["token"])
    if status != 200:
        print(f"[warm] FEHLER: GET lieferte HTTP {status}: {str(payload)[:300]}", file=sys.stderr)
        return EXIT_RUN_FAILED
    original = read_workers_min(payload)
    print(f"[warm] Ausgangswert: {cfg['endpoint_name']} workersMin={original}", flush=True)

    deadline = datetime.now(timezone.utc) + timedelta(minutes=cfg["minutes"])
    patched = False
    exit_code = EXIT_OK
    try:
        print(f"[warm] PATCH workersMin=1 … (bis {deadline.astimezone().strftime('%H:%M:%S')} Ortszeit)", flush=True)
        # `patched` steht VOR dem Aufruf: endet der Aufruf in einer Ausnahme, ist der
        # Zustand unbekannt - dann wird trotzdem zurueckgestellt (Erfolg per GET
        # bestaetigen, statt darauf zu vertrauen, dass nichts angekommen ist).
        patched = True
        status, payload = transport("PATCH", url, {"workersMin": 1}, cfg["token"])
        if status not in (200, 201):
            raise WarmRuntimeError(f"PATCH workersMin=1 lieferte HTTP {status}: {str(payload)[:300]}")
        print(
            f"[warm] GESETZT: workersMin=1 (HTTP {status}) – die Rolle {cfg['role']} haelt jetzt einen "
            f"warmen Worker fuer {cfg['minutes']:.1f} min",
            flush=True,
        )
        wait(cfg["minutes"] * 60.0)
        print(f"[warm] Wartezeit von {cfg['minutes']:.1f} min beendet.", flush=True)
    except KeyboardInterrupt:
        print("[warm] Abbruch (Strg-C) – der Ausgangswert wird trotzdem zurueckgestellt.", file=sys.stderr)
        exit_code = EXIT_RUN_FAILED
    except WarmRuntimeError as exc:
        print(f"[warm] FEHLER im Lauf: {exc}", file=sys.stderr)
        exit_code = EXIT_RUN_FAILED
    except Exception as exc:  # noqa: BLE001 - auch ein unbekannter Fehler stellt zurueck
        print(f"[warm] FEHLER im Lauf: {type(exc).__name__}: {exc}", file=sys.stderr)
        exit_code = EXIT_RUN_FAILED
    finally:
        if patched:
            if not restore(cfg, original):
                return EXIT_RESTORE_FAILED
        else:
            print("[warm] Kein PATCH gesendet – es gibt nichts zurueckzustellen.")
    return exit_code


def restore(cfg: Dict[str, Any], original: int) -> bool:
    """Zurueckstellen des Ausgangswerts UND Ruecklesen (der Beleg)."""
    url = rest_url(cfg)
    print(f"[warm] ZURUECKSTELLEN: PATCH workersMin={original} …", flush=True)
    status, payload = transport("PATCH", url, {"workersMin": original}, cfg["token"])
    if status not in (200, 201):
        print(
            f"[warm] FEHLER: Zurueckstellen lieferte HTTP {status}: {str(payload)[:300]}. "
            f"JETZT handeln: runpodctl endpoint update --id {cfg['endpoint_id']} --min-workers {original}",
            file=sys.stderr,
        )
        return False
    print(f"[warm] Rueckstell-Beleg: PATCH workersMin={original} → HTTP {status}", flush=True)
    status, payload = transport("GET", url, None, cfg["token"])
    if status != 200:
        print(
            f"[warm] WARNUNG: Ruecklesung nicht moeglich (HTTP {status}) – der PATCH war aber erfolgreich.",
            file=sys.stderr,
        )
        return True
    live = read_workers_min(payload)
    if live != original:
        print(
            f"[warm] FEHLER: Ruecklesung sagt workersMin={live}, erwartet {original}. "
            f"JETZT handeln: runpodctl endpoint update --id {cfg['endpoint_id']} --min-workers {original}",
            file=sys.stderr,
        )
        return False
    print(f"[warm] Rueckstell-Beleg: Ruecklesung workersMin={live} == Ausgangswert {original} ✓", flush=True)
    return True


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        cfg = resolve_config(args)
    except WarmUsageError as exc:
        print(f"[warm] FEHLER: {exc}", file=sys.stderr)
        return EXIT_USAGE

    plan = compute_plan(cfg)
    print(f"[warm] Rolle {cfg['role']} | Endpoint {cfg['endpoint_name']} ({cfg['endpoint_id']})")
    if not cfg["quiet"]:
        for line in cost_block(plan, cfg):
            print(f"[warm] {line}")
        print(
            f"[warm] Hinweis zur Konstitution: das ist eine BETREIBER-Entscheidung – "
            f"workersMin=1 laeuft gegen das Ziel 'Scale-to-Zero' und ist nur waehrend einer Session gedacht."
        )

    if cfg["dry_run"]:
        print("[warm] TROCKENLAUF – es wird KEIN HTTP-Aufruf gesendet.")
        print(
            f"[warm] Geplant: GET {rest_url(cfg)} → Ausgangswert; "
            f"PATCH {{\"workersMin\": 1}} fuer {cfg['minutes']:.1f} min; "
            f"danach PATCH {{'workersMin': <Ausgangswert>}} + Ruecklesung."
        )
        if not cfg["approve"]:
            print("[warm] Und mit einem echten Lauf: ohne --yes bleibt es bei Exit 3 (kein HTTP-Aufruf).")
        return EXIT_OK

    ok, message = gate_check(approve=cfg["approve"])
    print(("[warm] " if ok else "[warm] GATE: ") + message)
    if not ok:
        return EXIT_GATE

    try:
        return run_warm(cfg)
    except WarmUsageError as exc:
        # z. B. workersMin nicht lesbar: es wurde dann NICHTS geaendert.
        print(f"[warm] FEHLER: {exc}", file=sys.stderr)
        return EXIT_USAGE


if __name__ == "__main__":
    raise SystemExit(main())
