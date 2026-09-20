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

Lauf: python3 tests/test_hetzner_scripts.py
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import pathlib
import re
import shutil
import subprocess
import sys
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


if __name__ == "__main__":
    unittest.main()
