"""Regressionstests fuer die Hetzner-Skripte (stdlib/unittest, ohne Netz).

INFRA-HETZNER-003: `scripts/hetzner/dns_setup.py` validiert jeden API-Pfad gegen
`_PATH_RE` und baute seine eigenen Aufrufe aus Zeichen, die die Regex verbot
(`?`, `=`, `@`) - jeder Lauf endete in einem ValueError, bevor ueberhaupt ein
Request entstand. Der Test faehrt deshalb die ECHTEN Code-Pfade des Skripts
(`find_zone`, `get_rrset`, `upsert_rrset`, `main`) mit einem gefakten `urlopen`
und prueft, dass jede gebaute URL die eigene Validierung passiert - und dass
feindliche Pfade weiter abgewiesen werden (die Sicherheitszusage bleibt also
erhalten, sie war nur zu eng gefasst).

Dazu die Regressionsanker der uebrigen Infra-Items, die sich anders nicht
automatisch pruefen lassen:
  * INFRA-HETZNER-005: Der Watchdog wird beim Flottenstart installiert und
    unterscheidet App (Container-Health/8080) von Caddy (Port 80).
  * INFRA-HETZNER-006: edge-1 startet NUR den Monitoring-Stack; die Summe der
    Speicher-Limits dieser Dienste passt in den Default-Typ cx23 (4 GB).
  * INFRA-HETZNER-007: Die Typ-/Rollen-Tabelle in docs/SERVER_FLEET.md stimmt
    mit beiden Code-Pfaden ueberein (CLI und Portal-Worker) und beide Pfade
    lesen dieselben `FLEET_TYPE_*`-Overrides.

INFRA-HETZNER-002 (Origin-TLS als Default): Drei Befunde, ein Fix - deshalb
pruefen zwei zusaetzliche Klassen genau diese drei Aussagen:
  * deploy.sh bringt den Knoten per Default in den Origin-Zustand
    (scripts/hetzner/Caddyfile.origin + Zertifikatspaar aus ORIGIN_CERT/ORIGIN_KEY
    nach certs/, 600/700), ohne die Zertifikatswerte je auszugeben. ACME ist nur
    noch der ausdrueckliche Notausgang (DEPLOY_INSTALL_CADDYFILE=1) - ein Deploy
    kann die hinter der Cloudflare-Worker-Route unbrauchbare ACME-Variante also
    nicht mehr beilaeufig installieren.
  * Der neue Unterbefehl `dns` in fleet-preflight.sh prueft die DNS-Verdrahtung
    lesend und meldet den echten Cloudflare-Fehler (z. B. 9109 Invalid access
    token) statt still zu scheitern: genau das liess origin.anunnakitools.de auf
    Cloudflare-IPs zeigen. Der Test laeuft gegen einen LOKALEN HTTP-Stub
    (CF_API_BASE=http://127.0.0.1:PORT/client/v4) - kein Test kontaktiert
    Cloudflare oder Hetzner.

Lauf: python3 tests/test_hetzner_scripts.py
"""
from __future__ import annotations

import base64
import contextlib
import http.server
import importlib.util
import io
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import threading
import unittest
import urllib.parse
from typing import Any
from unittest import mock

try:  # Compose-Dateien werden nur zur Verifikation geparst - kein Laufzeitbedarf.
    import yaml  # type: ignore
except ImportError:  # pragma: no cover - nur auf Rechnern ohne PyYAML
    yaml = None  # type: ignore

ROOT = pathlib.Path(__file__).resolve().parent.parent
HETZNER = ROOT / "scripts" / "hetzner"

DNS_SCRIPT = HETZNER / "dns_setup.py"
BRING_UP = HETZNER / "bring-up-fleet.sh"
PROVISION_FLEET = HETZNER / "provision-fleet.sh"
AUTO_REPAIR = HETZNER / "auto-repair.sh"
INSTALL_AUTO_REPAIR = HETZNER / "install-auto-repair.sh"
DEPLOY_SH = ROOT / "deploy.sh"
FLEET_PREFLIGHT = HETZNER / "fleet-preflight.sh"
PORTAL_WORKER = ROOT / "services" / "portal-worker" / "src" / "index.js"
SERVER_FLEET_DOC = ROOT / "docs" / "SERVER_FLEET.md"
COMPOSE_BASE = ROOT / "docker-compose.hetzner.yml"
COMPOSE_MONITORING = ROOT / "docker-compose.monitoring.yml"

#: Speicher-Limits, die mit `deploy.resources.limits.memory` gesetzt werden.
#: Compose v2 uebersetzt sie beim Start in `--memory` (dokumentiertes Verhalten);
#: die Zahlen im Test sind die Summe der DEKLARIERTEN Limits, kein Live-Messwert.
CX23_RAM_MIB = 4096

#: Hetzner-Servertypen, die im Repo vorkommen duerfen (Tippfehler-Waechter,
#: keine Empfehlung). Quelle der Defaults ist `provision-fleet.sh`.
KNOWN_SERVER_TYPES = {
    "cx22", "cx23", "cx32", "cx33", "cx42", "cx43", "cx52", "cx53",
    "cax11", "cax21", "cax31", "cax41",
    "cpx11", "cpx21", "cpx22", "cpx31", "cpx41", "cpx42",
    "ccx13", "ccx23", "ccx33", "ccx43", "ccx53",
}


def load_module(name: str, path: pathlib.Path) -> Any:
    """Skript als Modul laden (wie tests/test_runpod_deploy_defaults.py)."""
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:  # pragma: no cover
        raise ImportError(f"Skript nicht ladbar: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


dns = load_module("hetzner_dns_setup", DNS_SCRIPT)


class _Response:
    """Minimale urllib-Antwort (Kontextmanager + read())."""

    def __init__(self, body: bytes) -> None:
        self._body = body

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> "_Response":
        return self

    def __exit__(self, *exc: object) -> bool:
        return False


class FakeHetznerApi:
    """Hetzner-API-Attrappe: merkt sich jede angefragte URL, gibt feste Antworten."""

    def __init__(self, zone_exists: bool = True, rrset: dict | None = None) -> None:
        self.zone_exists = zone_exists
        self.rrset = rrset
        self.requests: list[tuple[str, str]] = []  # (method, url)
        self.payloads: list[dict] = []

    def __call__(self, req: Any, data: bytes | None = None, timeout: int | None = None) -> _Response:
        url = req.full_url
        method = req.get_method()
        self.requests.append((method, url))
        if data:
            self.payloads.append(json.loads(data.decode("utf-8")))
        path = url[len(dns.API_BASE):]
        if method == "GET" and path.startswith("/zones?"):
            zones = [{"id": 4711, "name": "anunnakitools.de"}] if self.zone_exists else []
            return _Response(json.dumps({"zones": zones}).encode("utf-8"))
        if method == "GET" and "/rrsets/" in path:
            if self.rrset is None:
                return _Response(b"")  # Hetzner: 404 -> api() liefert None
            return _Response(json.dumps({"rrset": self.rrset}).encode("utf-8"))
        return _Response(json.dumps({"rrset": {"name": "antwort"}}).encode("utf-8"))

    # --- Auswertung -------------------------------------------------------
    def paths(self) -> list[str]:
        return [url[len(dns.API_BASE):] for _method, url in self.requests]

    def urls(self) -> list[str]:
        return [url for _method, url in self.requests]


def built_paths_pass_own_validation(fake: FakeHetznerApi) -> None:
    """Jede gebaute URL muss die eigene Pfadvalidierung passieren (Kernzusage)."""
    assert fake.requests, "kein Request aufgezeichnet"
    for url in fake.urls():
        assert url.startswith(dns.API_BASE + "/"), f"URL ausserhalb der API-Basis: {url}"
        path = url[len(dns.API_BASE):]
        assert dns._PATH_RE.match(path), f"eigene Validierung weist eigenen Pfad ab: {path!r}"
        assert dns._safe_url(path) == url


class DnsSetupLauffaehigkeitTest(unittest.TestCase):
    """INFRA-HETZNER-003: das Skript ist mit seinen eigenen Aufrufen ausfuehrbar."""

    def _patch(self, fake: FakeHetznerApi):
        return mock.patch.object(dns.urllib.request, "urlopen", fake)

    def test_zonen_suche_mit_query_passiert_die_eigene_validierung(self) -> None:
        fake = FakeHetznerApi()
        with self._patch(fake):
            zone = dns.find_zone("token", "anunnakitools.de")
        self.assertEqual(zone, {"id": 4711, "name": "anunnakitools.de"})
        self.assertIn("/zones?name=anunnakitools.de", fake.paths())
        built_paths_pass_own_validation(fake)

    def test_apex_rrset_pfad_mit_at_zeichen_passiert_die_eigene_validierung(self) -> None:
        fake = FakeHetznerApi(rrset={"name": "@", "type": "A", "records": [{"value": "91.98.104.74"}]})
        with self._patch(fake):
            rrset = dns.get_rrset("token", 4711, "@", "A")
        self.assertIsNotNone(rrset)
        self.assertIn("/zones/4711/rrsets/@/A", fake.paths())
        built_paths_pass_own_validation(fake)

    def test_upsert_legt_fehlenden_apex_record_an(self) -> None:
        fake = FakeHetznerApi(rrset=None)
        with self._patch(fake):
            dns.upsert_rrset("token", 4711, "@", "A", "91.98.104.74")
        self.assertIn(("POST", dns.API_BASE + "/zones/4711/rrsets"), fake.requests)
        built_paths_pass_own_validation(fake)
        self.assertEqual(fake.payloads[-1]["name"], "@")
        self.assertEqual(fake.payloads[-1]["records"], [{"value": "91.98.104.74"}])

    def test_upsert_set_records_aktion_fuer_bestehenden_record(self) -> None:
        # Existiert der RRSet mit anderem Wert, muss die actions/set_records-Route
        # gebaut werden - auch sie enthaelt das '@' des Apex-Namens.
        fake = FakeHetznerApi(rrset={"name": "@", "type": "A", "records": [{"value": "1.1.1.1"}]})
        with self._patch(fake):
            dns.upsert_rrset("token", 4711, "@", "A", "91.98.104.74")
        self.assertIn("/zones/4711/rrsets/@/A/actions/set_records", fake.paths())
        built_paths_pass_own_validation(fake)

    def test_upsert_ist_idempotent_bei_gleichem_wert(self) -> None:
        fake = FakeHetznerApi(rrset={"name": "@", "type": "A", "records": [{"value": "91.98.104.74"}]})
        with self._patch(fake):
            dns.upsert_rrset("token", 4711, "@", "A", "91.98.104.74")
        self.assertEqual(fake.paths(), ["/zones/4711/rrsets/@/A"])
        built_paths_pass_own_validation(fake)

    def test_main_setzt_zone_und_alle_drei_records_ohne_valueerror(self) -> None:
        """Vollstaendiger Skriptlauf gegen die Attrappe: Zone + A/CNAME/TXT."""
        fake = FakeHetznerApi(rrset=None)
        argv = ["dns_setup.py", "--domain", "anunnakitools.de", "--target-ip", "91.98.104.74", "--token", "token"]
        stdout = io.StringIO()
        with self._patch(fake), mock.patch.object(sys, "argv", argv), contextlib.redirect_stdout(stdout):
            dns.main()
        built_paths_pass_own_validation(fake)
        names = [p["name"] for p in fake.payloads if "name" in p]
        self.assertEqual(names, ["@", "www", "_acme-challenge"])
        self.assertIn("DNS-Fertig: anunnakitools.de", stdout.getvalue())

    def test_validierung_weist_weiterhin_feindliche_pfade_ab(self) -> None:
        # Die Sicherheitszusage bleibt: nur Pfade auf der API-Basis, keine
        # Protokoll-/Host-Manipulation, keine Fragmente, keine Steuerzeichen.
        for bad in (
            "",
            "zones",
            "https://evil.example.org/zones",
            "/zones?name=x#fragment",
            "/zones?name=x\n/zones",
            "/zones/1/rrsets/@/A\\",
            "/zones/1/rrsets/häuser/A",
            "/zones/1/rrsets/%40/A",
        ):
            with self.subTest(path=bad):
                self.assertRaises(ValueError, dns._safe_url, bad)

    def test_kein_pfad_kann_die_api_basis_verlassen(self) -> None:
        # Auch ein auffaelliger, aber formal erlaubter Pfad bleibt am Ende auf dem
        # festen API-Host: die Basis wird vorangestellt, nicht ersetzt.
        for candidate in ("//evil.example.org/zones", "/../etc/passwd", "/zones?name=anunnakitools.de"):
            with self.subTest(path=candidate):
                url = dns._safe_url(candidate)
                self.assertEqual(urllib.parse.urlsplit(url).netloc, "api.hetzner.cloud")
                self.assertTrue(url.startswith(dns.API_BASE + "/"))

    def test_validierung_akzeptiert_die_eigenen_aufrufpfade(self) -> None:
        for good in (
            "/zones?name=anunnakitools.de",
            "/zones",
            "/zones/4711/rrsets/@/A",
            "/zones/4711/rrsets/@/A/actions/set_records",
            "/zones/4711/rrsets/www/CNAME",
            "/zones/4711/rrsets/_acme-challenge/TXT",
            "/servers?page=1&per_page=50",
        ):
            with self.subTest(path=good):
                self.assertEqual(dns._safe_url(good), dns.API_BASE + good)


def memory_limits_mib(compose_path: pathlib.Path) -> dict[str, int]:
    """Deklarierte `deploy.resources.limits.memory` je Service (MiB)."""
    if yaml is None:  # pragma: no cover
        raise unittest.SkipTest("PyYAML nicht installiert")
    document = yaml.safe_load(compose_path.read_text(encoding="utf-8")) or {}
    limits: dict[str, int] = {}
    for name, service in (document.get("services") or {}).items():
        deploy = (service or {}).get("deploy") or {}
        raw = ((deploy.get("resources") or {}).get("limits") or {}).get("memory")
        if raw is None:
            continue
        text = str(raw).strip().upper()
        if text.endswith("G"):
            limits[name] = int(float(text[:-1]) * 1024)
        elif text.endswith("M"):
            limits[name] = int(float(text[:-1]))
        else:  # pragma: no cover - Compose erlaubt auch reine Bytes
            limits[name] = int(int(text) / (1024 * 1024))
    return limits


def monitoring_service_list() -> list[str]:
    """Service-Liste, die bring-up-fleet.sh fuer edge-1 verwendet."""
    text = BRING_UP.read_text(encoding="utf-8")
    match = re.search(r'^MONITORING_SERVICES="([^"]+)"', text, re.MULTILINE)
    assert match is not None, "MONITORING_SERVICES fehlt in bring-up-fleet.sh"
    return match.group(1).split()


class WatchdogInstallationTest(unittest.TestCase):
    """INFRA-HETZNER-005: der Watchdog wird installiert und diagnostiziert getrennt."""

    def test_flottenstart_installiert_den_watchdog(self) -> None:
        text = BRING_UP.read_text(encoding="utf-8")
        self.assertIn("install-auto-repair.sh", text)

    def test_watchdog_fragt_app_und_caddy_getrennt_ab(self) -> None:
        text = AUTO_REPAIR.read_text(encoding="utf-8")
        # App: Container-Health bzw. Port 8080 (der App-Container ist der einzige,
        # der diese App-Port-Nummer kennt) - NICHT Port 80, das ist Caddy.
        self.assertIn("127.0.0.1:8080/api/health", text)
        # Caddy: eigener Check auf Port 80.
        self.assertIn("127.0.0.1:80", text)
        # Beide Reparaturen muessen unterscheidbar sein (App tot != Caddy tot).
        self.assertIn('compose_recreate "$APP_CONTAINER"', text)
        self.assertIn('compose_recreate "$CADDY_CONTAINER"', text)
        self.assertIn('up -d --force-recreate "$1"', text)

    def test_installer_installiert_units_aus_dem_systemd_verzeichnis(self) -> None:
        # Gleiches Muster wie install-backup-timer.sh: die Units liegen im Repo,
        # der Installer kopiert sie nur (sonst driften Repo und Knoten).
        for name in ("audiomonastry-auto-repair.service", "audiomonastry-auto-repair.timer"):
            unit = HETZNER / "systemd" / name
            self.assertTrue(unit.exists(), f"{unit} fehlt")
        text = INSTALL_AUTO_REPAIR.read_text(encoding="utf-8")
        self.assertIn('install -m 0644 "$HERE_SRC/systemd/${SERVICE}.service"', text)
        self.assertIn('install -m 0644 "$HERE_SRC/systemd/${SERVICE}.timer"', text)
        self.assertIn("auto-repair.sh", text)


class EdgeMonitoringLimitsTest(unittest.TestCase):
    """INFRA-HETZNER-006: edge-1 startet nur den Monitoring-Stack (Limit-Rechnung)."""

    def test_trockenlauf_zeigt_typ_und_service_listen(self) -> None:
        # Der Beleg-Pfad ohne API/Token: bring-up-fleet.sh --print-config gibt die
        # effektiven Typen UND die Service-Liste je Knoten aus.
        bash = shutil.which("bash")
        if bash is None:  # pragma: no cover - Windows/Exoten
            self.skipTest("bash nicht vorhanden")
        result = subprocess.run(
            [bash, str(BRING_UP), "--print-config"],
            capture_output=True, text=True, cwd=ROOT, timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        output = result.stdout
        self.assertIn("app=cx23 sfu=cx23 ai=cx23 master=cx23 edge=cx23", output)
        self.assertIn(
            "docker-compose.monitoring.yml up -d " + " ".join(monitoring_service_list()),
            output,
        )
        for role in ("app-1", "sfu-1", "ai-1", "master-1", "edge-1"):
            with self.subTest(node=role):
                self.assertIn(role, output)

    def test_edge_startet_nur_die_monitoring_dienste(self) -> None:
        text = BRING_UP.read_text(encoding="utf-8")
        services = monitoring_service_list()
        self.assertRegex(text, r"-f docker-compose\.monitoring\.yml up -d \$MONITORING_SERVICES")
        # Alt-Snapshots bringen die Basis-Dienste per restart-Policy zurueck ->
        # der CLI-Pfad stoppt sie explizit (sonst gilt die Rechnung nur frisch).
        self.assertIn("stop caddy audiomonastry master-player", text)
        if yaml is None:  # pragma: no cover
            self.skipTest("PyYAML nicht installiert")
        overlay = yaml.safe_load(COMPOSE_MONITORING.read_text(encoding="utf-8")) or {}
        self.assertEqual(sorted(services), sorted((overlay.get("services") or {}).keys()))
        # Rollenvermischung ausschliessen: keine Basis-Dienste in der Liste.
        self.assertTrue(set(services).isdisjoint({"caddy", "audiomonastry", "master-player"}))

    def test_limits_der_monitoring_dienste_passen_in_den_cx23(self) -> None:
        limits = memory_limits_mib(COMPOSE_MONITORING)
        total = sum(limits[name] for name in monitoring_service_list())
        self.assertEqual(total, 1472)  # 512+512+128+256+64 MiB
        self.assertLessEqual(total, CX23_RAM_MIB)
        # Gegenprobe der Ueberbuchung: mit den Basis-Diensten waere es zu viel.
        base = memory_limits_mib(COMPOSE_BASE)
        mixed = total + sum(base[name] for name in ("caddy", "audiomonastry", "master-player"))
        self.assertEqual(mixed, 4672)
        self.assertGreater(mixed, CX23_RAM_MIB)

    def test_portal_worker_startet_dieselbe_liste(self) -> None:
        text = PORTAL_WORKER.read_text(encoding="utf-8")
        match = re.search(r"const MONITORING_SERVICES = \[([^\]]+)\]", text)
        self.assertIsNotNone(match, "MONITORING_SERVICES fehlt im Portal-Worker")
        assert match is not None
        worker_services = re.findall(r"'([a-z0-9-]+)'", match.group(1))
        self.assertEqual(worker_services, monitoring_service_list())
        self.assertIn("-f docker-compose.monitoring.yml up -d ${MONITORING_SERVICES.join(' ')}", text)

    def test_grafana_ist_per_ssh_tunnel_erreichbar_ohne_firewall_regel(self) -> None:
        # Monitoring-Zugriff ohne 3000er-Firewall-Regel: Grafana wird nur auf
        # 127.0.0.1 veroeffentlicht (Zugriff per SSH-Tunnel), die uebrigen Dienste
        # bleiben rein intern. Eine Firewall-Regel waere dafuer Dekoration.
        text = BRING_UP.read_text(encoding="utf-8")
        self.assertIn("ssh -L 3000:127.0.0.1:3000", text)
        if yaml is None:  # pragma: no cover
            self.skipTest("PyYAML nicht installiert")
        overlay = yaml.safe_load(COMPOSE_MONITORING.read_text(encoding="utf-8")) or {}
        published = {
            name: (service or {}).get("ports") or []
            for name, service in (overlay.get("services") or {}).items()
        }
        self.assertEqual(published.pop("grafana"), ["127.0.0.1:3000:3000"])
        self.assertEqual({name: ports for name, ports in published.items() if ports}, {})


class ServertypRollenDriftTest(unittest.TestCase):
    """INFRA-HETZNER-007: eine Tabelle, zwei Pfade, dieselben Overrides."""

    ROLE_ORDER = ("app", "sfu", "ai", "master", "edge")

    def _cli_defaults(self) -> dict[str, str]:
        text = PROVISION_FLEET.read_text(encoding="utf-8")
        found = dict(re.findall(r'TYPE_([A-Z]+)="\$\{FLEET_TYPE_\1:-([a-z0-9]+)\}"', text))
        return {role: found[role.upper()] for role in self.ROLE_ORDER if role.upper() in found}

    def _worker_fleet(self) -> dict[str, dict[str, str]]:
        text = PORTAL_WORKER.read_text(encoding="utf-8")
        entries = re.findall(
            r"\{\s*name:\s*'([^']+)'\s*,\s*type:\s*'([^']+)'\s*,\s*role:\s*'([^']+)'\s*\}",
            text,
        )
        return {role: {"name": name, "type": typ} for name, typ, role in entries}

    def _doc_table(self) -> dict[str, dict[str, str]]:
        rows: dict[str, dict[str, str]] = {}
        for line in SERVER_FLEET_DOC.read_text(encoding="utf-8").splitlines():
            cells = [c.strip().strip("`") for c in line.strip().strip("|").split("|")]
            if len(cells) == 6 and cells[0] in self.ROLE_ORDER:
                rows[cells[0]] = {
                    "name": cells[1],
                    "override": cells[2],
                    "cli": cells[3],
                    "worker": cells[4],
                }
        return rows

    def test_beide_pfade_lesen_dieselben_overrides(self) -> None:
        cli = self._cli_defaults()
        self.assertEqual(set(cli), set(self.ROLE_ORDER), "provision-fleet.sh: Rollen/Overrides unvollstaendig")
        worker = PORTAL_WORKER.read_text(encoding="utf-8")
        self.assertIn("FLEET_TYPE_", worker, "Portal-Worker liest die Overrides nicht")
        self.assertIn("FLEET_TYPE_${String(role).toUpperCase()}", worker)
        self.assertEqual(set(self._worker_fleet()), set(self.ROLE_ORDER))

    def test_dokumentierte_tabelle_stimmt_mit_beiden_pfaden_ueberein(self) -> None:
        rows = self._doc_table()
        self.assertEqual(set(rows), set(self.ROLE_ORDER), "SERVER_FLEET.md: Rollen-Tabelle fehlt/unvollstaendig")
        cli = self._cli_defaults()
        worker = self._worker_fleet()
        for role in self.ROLE_ORDER:
            with self.subTest(role=role):
                row = rows[role]
                self.assertEqual(row["override"], f"FLEET_TYPE_{role.upper()}")
                self.assertEqual(row["cli"], cli[role])
                self.assertEqual(row["worker"], worker[role]["type"])
                self.assertEqual(row["name"], worker[role]["name"])

    def test_alle_genannten_typen_sind_hetzner_typen(self) -> None:
        types = set(self._cli_defaults().values())
        types |= {entry["type"] for entry in self._worker_fleet().values()}
        types |= {row["cli"] for row in self._doc_table().values()}
        types |= {row["worker"] for row in self._doc_table().values()}
        self.assertTrue(types <= KNOWN_SERVER_TYPES, f"unbekannte Servertypen: {sorted(types - KNOWN_SERVER_TYPES)}")

    def _fleet_table_types(self, path: pathlib.Path, columns: int) -> dict[str, str]:
        """Fleet-Tabelle einer Doku: Knotenname -> Typ (Rollen sind Freitext)."""
        found: dict[str, str] = {}
        for line in path.read_text(encoding="utf-8").splitlines():
            cells = [c.strip().strip("*`") for c in line.strip().strip("|").split("|")]
            if len(cells) != columns:
                continue
            name, typ = cells[1], cells[2]
            if name.endswith("-1") and re.fullmatch(r"[a-z]+[0-9]+", typ or ""):
                found[name] = typ
        return found

    def test_weitere_flotten_tabellen_nennen_dieselben_typen(self) -> None:
        # Die zweite und dritte Tabelle aus dem Audit (AI_ARCHITECTURE, README)
        # muessen dieselben Typen nennen wie die kanonische Rollen-Tabelle.
        cli = self._cli_defaults()
        expected = {f"{role}-1": cli[role] for role in self.ROLE_ORDER}
        self.assertEqual(self._fleet_table_types(ROOT / "docs" / "AI_ARCHITECTURE.md", 4), expected)
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        line = next(l for l in readme.splitlines() if l.startswith("- Hetzner fleet:"))
        readme_types = {name.replace("`", ""): typ for name, typ in re.findall(r"`([a-z0-9-]+)` \(([a-z0-9]+)[,)]", line)}
        self.assertEqual(readme_types, expected)


# ---------------------------------------------------------------------------
# INFRA-HETZNER-002: Origin-TLS als Default + lesende DNS-Pruefung
# ---------------------------------------------------------------------------

#: Platzhalter-Secrets: die Tests behaupten NICHT, dass sie echt sind, sondern
#: dass genau diese Strings nie im Output der Skripte auftauchen.
FAKE_CERT_PEM = b"-----BEGIN CERTIFICATE-----\nTEST-ORIGIN-CERT\n-----END CERTIFICATE-----\n"
FAKE_KEY_PEM = b"-----BEGIN PRIVATE KEY-----\nTEST-ORIGIN-KEY\n-----END PRIVATE KEY-----\n"
FAKE_CERT = base64.b64encode(FAKE_CERT_PEM).decode("ascii")
FAKE_KEY = base64.b64encode(FAKE_KEY_PEM).decode("ascii")
FAKE_TOKEN = "cf-token-nur-fuer-den-teststub-0000"

#: Variablen, die ein Testlauf selbst steuert. Sie werden vorher aus der
#: Prozessumgebung entfernt, damit ein Test nie von der Shell eines Rechners
#: abhaengt (und die echten Tokens aus der Umgebung nicht mitlaufen).
CONTROLLED_ENV = (
    "DEPLOY_PRINT_CONFIG", "DEPLOY_INSTALL_CADDYFILE", "CLOUDFLARE_API_TOKEN",
    "CF_API_BASE", "PORTAL_DOMAIN", "ORIGIN_HOST", "APP_IP", "ORIGIN_CERT", "ORIGIN_KEY",
)


def bash_path() -> str:
    bash = shutil.which("bash")
    if bash is None:  # pragma: no cover - Windows/Exoten
        raise unittest.SkipTest("bash nicht vorhanden")
    return bash


def clean_env(**overrides: str | None) -> dict[str, str]:
    """Prozessumgebung ohne Testfluesterer; `None` entfernt einen Schluessel."""
    env = os.environ.copy()
    for key in CONTROLLED_ENV:
        env.pop(key, None)
    for key, value in overrides.items():
        if value is None:
            env.pop(key, None)
        else:
            env[key] = value
    return env


class DeployOriginTlsTest(unittest.TestCase):
    """INFRA-HETZNER-002: der Origin-TLS-Pfad ist der Default des Rollen-Deploys."""

    def setUp(self) -> None:
        self.bash = bash_path()
        self.text = DEPLOY_SH.read_text(encoding="utf-8")
        self.lines = self.text.splitlines()

    def _line_of(self, needle: str) -> int:
        for index, line in enumerate(self.lines):
            if needle in line:
                return index
        self.fail(f"deploy.sh: Zeile mit {needle!r} fehlt")

    def _run(self, **overrides: str | None) -> subprocess.CompletedProcess:
        return subprocess.run(
            [self.bash, str(DEPLOY_SH)], capture_output=True, text=True,
            cwd=ROOT, env=clean_env(**overrides), timeout=60,
        )

    def test_default_kopiert_das_origin_caddyfile_per_scp(self) -> None:
        self.assertIn(
            'scp "${SCP_OPTS[@]}" ./scripts/hetzner/Caddyfile.origin "$SSH_TARGET:$DEPLOY_REMOTE_DIR/Caddyfile"',
            self.text,
        )
        # Der rsync-Ausschluss bleibt (der Worker-Pfad soll nicht beilaeufig
        # ueberschrieben werden) - die Installation laeuft ausdruecklich per scp.
        self.assertIn("--exclude 'Caddyfile'", self.text)
        self.assertIn('CADDYFILE_MODE="origin"', self.text)

    def test_acme_ist_nur_der_ausdrueckliche_notausgang(self) -> None:
        self.assertIn('if [[ "$DEPLOY_INSTALL_CADDYFILE" == "1" ]]; then\n  CADDYFILE_MODE="acme"', self.text)
        # Genau EIN scp des Repo-Caddyfiles (ACME) - und zwar im acme-Zweig.
        self.assertEqual(
            self.text.count('scp "${SCP_OPTS[@]}" ./Caddyfile "$SSH_TARGET:$DEPLOY_REMOTE_DIR/Caddyfile"'), 1,
        )
        self.assertLess(self._line_of('CADDYFILE_MODE" == "acme"'), self._line_of('scp "${SCP_OPTS[@]}" ./Caddyfile'))

    def test_zertifikate_liegen_vor_dem_caddy_start_und_mit_engen_rechten(self) -> None:
        # Der echte Startbefehl aus Schritt [4/5] (nicht der Kommentar, der ihn nennt).
        caddy_start = self._line_of("docker compose -f $COMPOSE_FILE up -d caddy")
        # Reihenfolge ist der Kern des Fixes: Caddyfile + Zertifikate VOR dem Start,
        # sonst startet Caddy in die Restart-Schleife (live: HTTP 522).
        self.assertLess(self._line_of("Caddyfile.origin"), caddy_start)
        self.assertLess(self._line_of("base64 -d"), caddy_start)
        # Secrets nur per Pipe in ein Remote-Kommando mit umask 077 - nie als Argument.
        self.assertIn(
            'printf \'%s\\n\' "$ORIGIN_CERT" | base64 -d | "${SSH[@]}" "$SSH_TARGET" "umask 077; cat > $DEPLOY_REMOTE_DIR/certs/origin.crt"',
            self.text,
        )
        self.assertIn(
            'printf \'%s\\n\' "$ORIGIN_KEY" | base64 -d | "${SSH[@]}" "$SSH_TARGET" "umask 077; cat > $DEPLOY_REMOTE_DIR/certs/origin.key"',
            self.text,
        )
        self.assertIn("chmod 700 $DEPLOY_REMOTE_DIR/certs", self.text)
        chmod_600 = [line for line in self.lines if "chmod 600" in line]
        self.assertEqual(len(chmod_600), 1, "genau eine chmod-600-Zeile erwartet")
        self.assertIn("origin.crt", chmod_600[0])
        self.assertIn("origin.key", chmod_600[0])

    def test_fehlende_variablen_ergeben_keinen_stillen_acme_fallback(self) -> None:
        self.assertIn("kein ACME-Fallback", self.text)
        self.assertIn("Restart-Schleife", self.text)
        self.assertIn("docs/ORIGIN_TLS_DNS_RUNBOOK.md", self.text)

    def test_meldung_ist_nur_ein_boolean_ohne_werte(self) -> None:
        self.assertIn('echo "   Origin-Zertifikat installiert: $ORIGIN_CERT_INSTALLED"', self.text)
        self.assertIn('ORIGIN_CERT_INSTALLED="ja"', self.text)
        self.assertIn('ORIGIN_CERT_INSTALLED="nein"', self.text)
        for leak in ('echo "$ORIGIN_CERT"', 'echo "$ORIGIN_KEY"', 'echo "${ORIGIN_CERT}"', 'echo "${ORIGIN_KEY}"'):
            with self.subTest(leak=leak):
                self.assertNotIn(leak, self.text)

    def test_ohne_domain_warnt_der_origin_modus_laut(self) -> None:
        # Caddyfile.origin hat `{$DOMAIN}` als Site-Adresse: ohne Domain kann Caddy
        # die Konfiguration nicht laden. Der Deploy muss das sagen, statt einen
        # Caddy in die Restart-Schleife zu schicken.
        self.assertIn("Caddyfile.origin hat ohne Domain keine Site-Adresse", self.text)
        self.assertIn("DEPLOY_INSTALL_CADDYFILE=1 bash $0", self.text)

    def test_bash_syntax_ist_sauber(self) -> None:
        result = subprocess.run([self.bash, "-n", str(DEPLOY_SH)], capture_output=True, text=True, cwd=ROOT, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_trockenlauf_meldet_modus_und_zertifikats_boolean(self) -> None:
        with_certs = self._run(DEPLOY_PRINT_CONFIG="1", ORIGIN_CERT=FAKE_CERT, ORIGIN_KEY=FAKE_KEY)
        self.assertEqual(with_certs.returncode, 0, with_certs.stderr)
        out = with_certs.stdout + with_certs.stderr
        self.assertIn("CADDYFILE_MODUS=origin", out)
        self.assertIn("Origin-Zertifikate im env vorhanden: ja", out)
        # Der Trockenlauf belegt den Modus, ohne einen Wert zu verraten.
        self.assertNotIn(FAKE_CERT, out)
        self.assertNotIn(FAKE_KEY, out)
        self.assertNotIn("TEST-ORIGIN-KEY", out)

    def test_trockenlauf_ohne_zertifikate_und_mit_acme_notausgang(self) -> None:
        without = self._run(DEPLOY_PRINT_CONFIG="1")
        self.assertEqual(without.returncode, 0, without.stderr)
        self.assertIn("Origin-Zertifikate im env vorhanden: nein", without.stdout)
        self.assertIn("CADDYFILE_MODUS=origin", without.stdout)

        acme = self._run(DEPLOY_PRINT_CONFIG="1", DEPLOY_INSTALL_CADDYFILE="1", ORIGIN_CERT=FAKE_CERT, ORIGIN_KEY=FAKE_KEY)
        self.assertEqual(acme.returncode, 0, acme.stderr)
        self.assertIn("CADDYFILE_MODUS=acme", acme.stdout)


class _CloudflareStub:
    """Lokaler HTTP-Stub der Cloudflare-API (kein Test spricht ins Internet).

    Beantwortet genau die beiden GET-Pfade, die `fleet-preflight.sh dns` braucht,
    und protokolliert jede Methode - so laesst sich die Zusage "nur lesend"
    pruefen. Schreibversuche werden mit 405 abgewiesen.
    """

    def __init__(
        self,
        zone: tuple[int, dict] | None = None,
        records: tuple[int, dict] | None = None,
    ) -> None:
        self.zone = zone or (200, {"success": True, "errors": [], "result": [{"id": "zone-4711", "name": "anunnakitools.de"}]})
        self.records = records or (200, {"success": True, "errors": [], "result": []})
        self.requests: list[tuple[str, str]] = []

    def __enter__(self) -> "_CloudflareStub":
        stub = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802 - Name kommt von BaseHTTPRequestHandler
                stub.requests.append(("GET", self.path))
                status, payload = stub.response_for(self.path)
                body = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self) -> None:  # noqa: N802
                stub.requests.append(("POST", self.path))
                self.send_error(405, "dieser Stub schreibt nicht")

            def do_PUT(self) -> None:  # noqa: N802
                stub.requests.append(("PUT", self.path))
                self.send_error(405, "dieser Stub schreibt nicht")

            def log_message(self, *args: Any) -> None:  # Testausgabe ruhig halten
                return

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *exc: object) -> bool:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        return False

    @property
    def api_base(self) -> str:
        host, port = self.server.server_address[0], self.server.server_address[1]
        return f"http://{host}:{port}/client/v4"

    def response_for(self, path: str) -> tuple[int, dict]:
        if path.startswith("/client/v4/zones?"):
            return self.zone
        if "/dns_records" in path:
            return self.records
        return 404, {"success": False, "errors": [{"code": 9999, "message": "unbekannter Pfad"}]}

    def methods(self) -> list[str]:
        return [method for method, _path in self.requests]

    def paths(self) -> list[str]:
        return [path for _method, path in self.requests]


class FleetPreflightDnsTest(unittest.TestCase):
    """INFRA-HETZNER-002: `dns` prueft lesend - offline gegen einen lokalen Stub."""

    ORIGIN = "origin.anunnakitools.de"

    def setUp(self) -> None:
        self.bash = bash_path()

    def _run_dns(
        self,
        stub: _CloudflareStub | None,
        *args: str,
        token: str | None = FAKE_TOKEN,
        app_ip: str | None = None,
        portal_domain: str = "anunnakitools.de",
        origin_host: str | None = None,
    ) -> subprocess.CompletedProcess:
        return subprocess.run(
            [self.bash, str(FLEET_PREFLIGHT), "dns", *args],
            capture_output=True, text=True, cwd=ROOT, timeout=120,
            env=clean_env(
                CF_API_BASE=(stub.api_base if stub is not None else "http://127.0.0.1:9/client/v4"),
                PORTAL_DOMAIN=portal_domain,
                ORIGIN_HOST=origin_host or f"origin.{portal_domain}",
                CLOUDFLARE_API_TOKEN=token,
                APP_IP=app_ip,
            ),
        )

    @staticmethod
    def _combined(result: subprocess.CompletedProcess) -> str:
        return result.stdout + result.stderr

    def test_9109_wird_im_klartext_gemeldet_und_der_token_nie_ausgegeben(self) -> None:
        stub = _CloudflareStub(zone=(403, {
            "success": False,
            "errors": [{"code": 9109, "message": "Invalid access token"}],
            "messages": [],
            "result": None,
        }))
        with stub:
            result = self._run_dns(stub)
        combined = self._combined(result)
        self.assertEqual(result.returncode, 2, combined)
        self.assertIn("Token ohne Zone:DNS:Edit", combined)
        self.assertIn("9109", combined)
        self.assertIn("Invalid access token", combined)
        self.assertIn("docs/ORIGIN_TLS_DNS_RUNBOOK.md", combined)
        self.assertNotIn(FAKE_TOKEN, combined)
        # Nach dem Token-Fehler wird nichts weiter abgefragt - und nur gelesen.
        self.assertEqual(stub.methods(), ["GET"])

    def test_leeres_zonen_result_ist_ebenfalls_ein_klartextfehler(self) -> None:
        stub = _CloudflareStub(zone=(200, {"success": True, "errors": [], "result": []}))
        with stub:
            result = self._run_dns(stub)
        combined = self._combined(result)
        self.assertEqual(result.returncode, 2, combined)
        self.assertIn("Token ohne Zone:DNS:Edit", combined)
        self.assertNotIn(FAKE_TOKEN, combined)

    def test_proxied_record_wird_abgelehnt(self) -> None:
        stub = _CloudflareStub(records=(200, {"success": True, "errors": [], "result": [
            {"id": "rec-1", "type": "A", "name": self.ORIGIN, "content": "91.98.104.74", "proxied": True},
        ]}))
        with stub:
            result = self._run_dns(stub, app_ip="91.98.104.74")
        combined = self._combined(result)
        self.assertEqual(result.returncode, 2, combined)
        self.assertIn("proxied=true", combined)
        self.assertIn("DNS-only", combined)
        self.assertIn(self.ORIGIN, combined)
        # Zone + Record: zwei GETs, kein Schreibzugriff.
        self.assertEqual(stub.methods(), ["GET", "GET"])

    def test_falsche_ziel_ip_wird_gemeldet(self) -> None:
        stub = _CloudflareStub(records=(200, {"success": True, "errors": [], "result": [
            {"id": "rec-1", "type": "A", "name": self.ORIGIN, "content": "1.1.1.1", "proxied": False},
        ]}))
        with stub:
            result = self._run_dns(stub, app_ip="203.0.113.5")
        combined = self._combined(result)
        self.assertEqual(result.returncode, 2, combined)
        self.assertIn("1.1.1.1", combined)
        self.assertIn("APP_IP", combined)
        self.assertIn("203.0.113.5", combined)

    def test_falscher_record_typ_wird_gemeldet(self) -> None:
        stub = _CloudflareStub(records=(200, {"success": True, "errors": [], "result": [
            {"id": "rec-1", "type": "CNAME", "name": self.ORIGIN, "content": "app.example", "proxied": False},
        ]}))
        with stub:
            result = self._run_dns(stub)
        combined = self._combined(result)
        self.assertEqual(result.returncode, 2, combined)
        self.assertIn("CNAME", combined)

    def test_fehlender_record_wird_gemeldet(self) -> None:
        stub = _CloudflareStub(records=(200, {"success": True, "errors": [], "result": []}))
        with stub:
            result = self._run_dns(stub)
        combined = self._combined(result)
        self.assertEqual(result.returncode, 2, combined)
        self.assertIn("existiert nicht", combined)

    def test_ohne_token_klartextfehler_ohne_netz(self) -> None:
        stub = _CloudflareStub()
        with stub:
            result = self._run_dns(stub, token=None)
        combined = self._combined(result)
        self.assertEqual(result.returncode, 2, combined)
        self.assertIn("CLOUDFLARE_API_TOKEN nicht gesetzt", combined)
        self.assertIn("docs/ORIGIN_TLS_DNS_RUNBOOK.md", combined)
        # Ohne Token darf kein Request entstehen.
        self.assertEqual(stub.requests, [])

    def test_gruener_fall_gibt_remediation_und_verify_aus(self) -> None:
        stub = _CloudflareStub(records=(200, {"success": True, "errors": [], "result": [
            {"id": "rec-1", "type": "A", "name": self.ORIGIN, "content": "203.0.113.5", "proxied": False},
        ]}))
        with stub:
            result = self._run_dns(stub, app_ip="203.0.113.5")
        combined = self._combined(result)
        self.assertEqual(result.returncode, 0, combined)
        self.assertIn("DNS-Verdrahtung ok", combined)
        self.assertIn(self.ORIGIN, combined)
        self.assertIn("203.0.113.5", combined)
        # Das Verify-Kommando steht mit dem curl-Statusplatzhalter im Output.
        self.assertIn("curl -sS -o /dev/null", combined)
        self.assertIn("%{http_code}", combined)
        self.assertIn("https://anunnakitools.de/api/health", combined)
        self.assertIn("/client/v4/zones/", stub.paths()[1])
        self.assertIn(f"name={self.ORIGIN}", stub.paths()[1])

    def test_token_gesetzt_aber_zone_nicht_erreichbar(self) -> None:
        # CF_API_BASE auf einen toten Port: der Zustand wird gemeldet, nicht verschluckt.
        result = self._run_dns(None)
        combined = self._combined(result)
        self.assertEqual(result.returncode, 2, combined)
        self.assertIn("nicht erreichbar", combined)
        self.assertNotIn(FAKE_TOKEN, combined)

    def test_print_config_ohne_netz_und_ohne_werte(self) -> None:
        stub = _CloudflareStub()
        with stub:
            with_token = self._run_dns(stub, "--print-config", token=FAKE_TOKEN, app_ip="203.0.113.5")
            without_token = self._run_dns(stub, "--print-config", token=None)
        for result in (with_token, without_token):
            self.assertEqual(result.returncode, 0, self._combined(result))
            self.assertIn("CF_API_BASE=", result.stdout)
            self.assertIn(f"ORIGIN_HOST={self.ORIGIN}", result.stdout)
        self.assertIn("CLOUDFLARE_API_TOKEN gesetzt: ja", with_token.stdout)
        self.assertIn("CLOUDFLARE_API_TOKEN gesetzt: nein", without_token.stdout)
        self.assertIn("APP_IP=203.0.113.5", with_token.stdout)
        self.assertNotIn(FAKE_TOKEN, with_token.stdout + with_token.stderr)
        # Der Trockenlauf darf keinen Request ausloesen.
        self.assertEqual(stub.requests, [])

    def test_print_config_ueber_deploy_print_config_env(self) -> None:
        result = subprocess.run(
            [self.bash, str(FLEET_PREFLIGHT), "dns"],
            capture_output=True, text=True, cwd=ROOT, timeout=120,
            env=clean_env(DEPLOY_PRINT_CONFIG="1", PORTAL_DOMAIN="anunnakitools.de",
                          CF_API_BASE="http://127.0.0.1:9/client/v4", CLOUDFLARE_API_TOKEN=None),
        )
        self.assertEqual(result.returncode, 0, self._combined(result))
        self.assertIn("CLOUDFLARE_API_TOKEN gesetzt: nein", result.stdout)

    def test_bash_syntax_ist_sauber(self) -> None:
        result = subprocess.run([self.bash, "-n", str(FLEET_PREFLIGHT)], capture_output=True, text=True, cwd=ROOT, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_check_verweist_auf_dns_ohne_token_zugriff(self) -> None:
        # Der bestehende check-Pfad bleibt bestehen und nennt 'dns' als Bruecke.
        text = FLEET_PREFLIGHT.read_text(encoding="utf-8")
        self.assertIn("bash scripts/hetzner/fleet-preflight.sh dns", text)
        self.assertIn("check) cmd_check ;;", text)
        self.assertIn("apply) cmd_apply ;;", text)
        # Der Token erscheint nie in einer Ausgabezeile.
        for line in text.splitlines():
            if "CLOUDFLARE_API_TOKEN" in line and line.strip().startswith("echo"):
                self.assertNotIn("$CLOUDFLARE_API_TOKEN", line)


if __name__ == "__main__":
    unittest.main()