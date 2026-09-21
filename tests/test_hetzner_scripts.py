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
  * PROD-P3-F9: Der Idle-Shutdown-Timer ist installations- und nachweisfaehig -
    die Units liegen im REPO (`scripts/hetzner/systemd/`, kein Heredoc-Nachbau
    wie vorher), der Installer ist idempotent, aktiviert genau `daemon-reload` +
    `enable --now` des EIGENEN Timers und bricht ohne Token mit Klartext ab,
    BEVOR er Einheiten installiert (ein Timer ohne Token kann strukturell nie
    ausloesen = dieselbe Fehlerklasse wie der F9-Befund). Der Recreate-Pfad
    (`bring-up-fleet.sh` Schritt 8 und der Portal-Wake) wird mit einem Fake-ssh
    gefahren, der die Kommandozeile LOKAL ausfuehrt - kein Knoten, kein systemd,
    kein Shutdown.

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

F10 (Namespace-Paritaet): Der Compose-Projektname hing am VERZEICHNISNAMEN - auf
sfu-1/master-1 liefen Container und Projekt noch unter dem Altnamen, waehrend das
Repo `audiomonastry-*` fuehrt. Die Klasse `NamespaceParitaetTest` prueft die
Vertraege dieses Fixes, ohne Docker/Netz:
  * `fleet-names.sh` bildet BEIDE Schreibweisen auf denselben Namen ab (Server,
    Container, Projektname, Pfade) und bleibt die einzige Quelle,
  * `docker-compose.hetzner.yml` nennt denselben Projektnamen wie fleet-names.sh
    (keine zweite Wahrheit, die auseinanderlaufen kann),
  * die Trockenlaeufe (`--print-config`) von provision-fleet.sh,
    bring-up-fleet.sh und fleet-deploy-live.sh zeigen den neuen Projektnamen,
  * der Watchdog (auto-repair.sh) findet den Container auch unter dem Altnamen
    und repariert ihn im KANONISCHEN Projekt - gefahren mit einem gefakten
    `docker` im PATH (echter Codepfad, kein Docker, kein Netz),
  * das Migrationsskript fuer Bestands-Knoten ist trockenlaufbar, loescht keine
    Volumes ohne ausdrueckliche Bestaetigung und nennt den Rueckweg.

PERF-P1-005 (2026-09-21): `bring-up-fleet.sh` setzt `DEPLOY_REMOTE_BUILD=1` als
Default und reicht den Schalter an `deploy.sh` durch (vorher lief jeder
Flottenstart den Image-Transfer: ~2,65 GB bei ~1 MB/s = 25-40 min je Knoten,
statt ~1 min Remote-Build bei warmem Layer-Cache). `FleetStartRemoteBuildDefaultTest`
faehrt dafuer den ECHTEN `deploy.sh`-Pfad mit gefaktem `ssh`/`scp`/`rsync`/`docker`
und einem lokalen `/api/health`-Stub (kein Knoten, kein Docker-Daemon, kein Netz):
im Remote-Build-Modus darf kein `docker save`/`docker load` in der Kommandoliste
stehen, die Abschaltung muss wirklich den Transfer fahren, und das zweite Image
(`audiomonastry-master-player:hetzner`) muss ueber den Compose-Build-Kontext
erfasst sein.

INFRA-HETZNER-014 (2026-09-21): Nach dem Neuaufbau der Flotte trugen drei
Hetzner-Firewalls noch die Quell-IPs der VORHERIGEN Flotte (app:8080 von der
alten edge-1, ai:8000/11434 und master:8000 von der alten app-1) - der
Querverkehr edge->app, app->ai und app->master war stumm blockiert, von aussen
unsichtbar, weil alles Oeffentliche ueber Cloudflare laeuft. Zwei Klassen halten
den Fix fest: `CrossNodeFirewallAbgleichTest` faehrt den ECHTEN Codepfad von
`scripts/hetzner/firewall-ensure.py` gegen einen LOKALEN HTTP-Stub der
Hetzner-API (kein Hetzner, kein Token, keine Flotte; der Stub fuehrt set_rules
wirklich nach und kann das Schreiben fuer die Gegenprobe bewusst ignorieren) und
prueft: veraltete Quelle ersetzt + alle uebrigen Regeln zeichengleich, "schon
aktuell" ohne Schreibaufruf, ohne Token kein Request, `--print-config`/`--dry-run`
schreiben nicht, abweichende Gegenprobe => Exit ungleich 0, keine erfundenen
Regeln, keine Verengung offener Regeln. `FirewallAbgleichImFlottenstartTest`
prueft die Einbindung (Schritt 3/9 NACH der Provisionierung und VOR den Deploys,
fortlaufende Schrittnummern, Abschaltbefehl `FLEET_FIREWALL_ENSURE=0` - am echten
Text der Verzweigung mit gefaktem python3 gefahren -, Trockenlauf nennt den
Vertrag).
"""
from __future__ import annotations

import base64
import contextlib
import hashlib
import hmac
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
import tempfile
import threading
import shlex
import unittest
import urllib.parse
from typing import Any, Literal
from unittest import mock

try:  # Compose-Dateien werden nur zur Verifikation geparst - kein Laufzeitbedarf.
    import yaml  # type: ignore
except ImportError:  # pragma: no cover - nur auf Rechnern ohne PyYAML
    yaml = None  # type: ignore

ROOT = pathlib.Path(__file__).resolve().parent.parent
HETZNER = ROOT / "scripts" / "hetzner"

DNS_SCRIPT = HETZNER / "dns_setup.py"
CF_DNS_ENSURE = HETZNER / "cf-dns-ensure.py"
BRING_UP = HETZNER / "bring-up-fleet.sh"
PROVISION_FLEET = HETZNER / "provision-fleet.sh"
AUTO_REPAIR = HETZNER / "auto-repair.sh"
INSTALL_AUTO_REPAIR = HETZNER / "install-auto-repair.sh"
# PROD-P3-F9: Idle-Shutdown-Timer (Installer + Units + Check im Repo).
INSTALL_IDLE_SHUTDOWN = HETZNER / "install-idle-shutdown.sh"
IDLE_CHECK_SRC = HETZNER / "systemd" / "idle-check.sh"
IDLE_SERVICE_UNIT = HETZNER / "systemd" / "audiomonastry-idle-shutdown.service"
IDLE_TIMER_UNIT = HETZNER / "systemd" / "audiomonastry-idle-shutdown.timer"
DEPLOY_SH = ROOT / "deploy.sh"
FLEET_PREFLIGHT = HETZNER / "fleet-preflight.sh"
# INFRA-HETZNER-014: Cross-Node-Firewall-Regeln auf die aktuellen Knoten-IPs.
FIREWALL_ENSURE = HETZNER / "firewall-ensure.py"
PORTAL_WORKER = ROOT / "services" / "portal-worker" / "src" / "index.js"
SERVER_FLEET_DOC = ROOT / "docs" / "SERVER_FLEET.md"
COMPOSE_BASE = ROOT / "docker-compose.hetzner.yml"
COMPOSE_MONITORING = ROOT / "docker-compose.monitoring.yml"
# F10: Namensquelle + Migrationsweg fuer Bestands-Knoten.
FLEET_NAMES = HETZNER / "fleet-names.sh"
MIGRATE_PROJECT = HETZNER / "migrate-project-name.sh"
FLEET_DEPLOY_LIVE = HETZNER / "fleet-deploy-live.sh"
INSTALL_AI1 = HETZNER / "install-ai1.sh"
# PROD-P2-REG: der Registry-Weg (Push-Werkzeug + gemeinsame Bibliothek + Doku).
REGISTRY_PUSH = HETZNER / "registry-push.sh"
REGISTRY_LIB = HETZNER / "lib" / "registry.sh"
HETZNER_DEPLOY_DOC = ROOT / "docs" / "HETZNER_DEPLOY.md"
# PERF-P1-005: Medienuebertragung mit 16 Verbindungen ueber R2.
DELIVER_MEDIA = HETZNER / "deliver-media.sh"
PARALLEL_TRANSFER = HETZNER / "parallel-transfer.sh"
R2_SIGV4_LIB = HETZNER / "lib" / "r2-sigv4.sh"
R2_NODE_FETCH = HETZNER / "lib" / "r2-node-fetch.sh"
COMPOSE_MEDIA = ROOT / "docker-compose.media.yml"

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
# PROD-P1-F1: eigenes Cloudflare-DNS-Werkzeug (A-Records fuer App/SFU).
cf_dns = load_module("hetzner_cf_dns_ensure", CF_DNS_ENSURE)


class _Response:
    """Minimale urllib-Antwort (Kontextmanager + read())."""

    def __init__(self, body: bytes) -> None:
        self._body = body

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> "_Response":
        return self

    def __exit__(self, *exc: object) -> Literal[False]:
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


class MedienAuslieferungTest(unittest.TestCase):
    """Medien/Codecs produktionsreif: Inhalte ausserhalb des Images, aber im
    Container gemountet - und EINE Quelle fuer Modellpfad + Download."""

    def setUp(self) -> None:
        self.bash = bash_path()
        self.overlay = ROOT / "docker-compose.media.yml"
        self.deliver = HETZNER / "deliver-media.sh"

    @staticmethod
    def _combined(result: subprocess.CompletedProcess) -> str:
        return result.stdout + result.stderr

    def test_overlay_mountet_die_inhalte_readonly_an_den_auslieferpfaden(self) -> None:
        self.assertTrue(self.overlay.exists(), "docker-compose.media.yml fehlt")
        text = self.overlay.read_text(encoding="utf-8")
        for mount in (
            "./media/orchestral:/app/dist/data/orchestral:ro",
            "./media/models:/app/dist/models:ro",
            "./media/music:/app/dist/music:ro",
        ):
            with self.subTest(mount=mount):
                self.assertIn(mount, text)
        # Kein Schreibzugriff auf Inhalte, keine Aenderung am Image selbst.
        for line in text.splitlines():
            if line.strip().startswith("- ./media/"):
                self.assertTrue(line.rstrip().endswith(":ro"), line)

    def test_auslieferSkript_ist_trockenlaufbar_und_meldet_fehlende_quellen(self) -> None:
        result = subprocess.run(
            [self.bash, str(self.deliver), "--print-config"],
            capture_output=True, text=True, cwd=ROOT, timeout=120, env=clean_env(),
        )
        combined = self._combined(result)
        self.assertEqual(result.returncode, 0, combined)
        self.assertIn("Ziel-Verzeichnis: /opt/audiomonastry/media", combined)
        self.assertIn("Demo-Tracks", combined)
        # Der Lizenzhinweis muss im Trockenlauf stehen (sonst wandern fremde
        # Aufnahmen unbemerkt in die Produktion).
        self.assertIn("NICHT Teil der Lieferung", combined)
        # Fehlende Quellen sind ein Fehler, kein stiller No-Op.
        text = self.deliver.read_text(encoding="utf-8")
        self.assertIn("Quelle(n) fehlen lokal", text)
        self.assertIn("exit 2", text)

    def test_modellpfad_ist_eine_wahrheit(self) -> None:
        """Der Client laedt /models/htdemucs.onnx; das Downloader-Skript muss
        GENAU dorthin schreiben, und der Alias darf keine zweite Quelle haben."""
        client = (ROOT / "src" / "ai" / "localDemucs.ts").read_text(encoding="utf-8")
        self.assertIn("/models/htdemucs.onnx", client)

        models_script = (ROOT / "scripts" / "download-models.sh").read_text(encoding="utf-8")
        self.assertIn("public/models/htdemucs.onnx", models_script)
        self.assertIn("huggingface.co/smank/htdemucs-onnx", models_script)

        alias = (ROOT / "scripts" / "download-htdemucs.sh").read_text(encoding="utf-8")
        self.assertIn("download-models.sh", alias)
        # Die alte, tote Quelle darf nicht zurueckkommen.
        self.assertNotIn("facebookresearch/htdemucs/raw/main/htdemucs.onnx", alias)


class FirewallWerkzeugeTest(unittest.TestCase):
    """TURN-Ports sichern und Legacy-Firewalls aufraeumen - beides ohne
    Ueberraschungen: Trockenlauf per Default, und nie etwas loeschen, das noch
    an einem Server haengt."""

    def setUp(self) -> None:
        self.bash = bash_path()
        self.ensure = HETZNER / "firewall-ensure-turn.py"
        self.inventory = HETZNER / "firewall-inventory.py"
        self.cleanup = HETZNER / "cleanup-legacy-firewalls.py"

    def test_werkzeuge_existieren_und_sind_syntaxgueltig(self) -> None:
        for script in (self.ensure, self.inventory, self.cleanup):
            with self.subTest(script=script.name):
                self.assertTrue(script.exists(), f"{script} fehlt")
                result = subprocess.run(
                    ["python3", "-c", "import ast,sys; ast.parse(open(sys.argv[1]).read())", str(script)],
                    capture_output=True, text=True, cwd=ROOT, timeout=60,
                )
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_turn_regeln_sind_identisch_mit_den_quellen(self) -> None:
        """Die vier Regeln liegen in portal-worker, provision.py und dem Werkzeug -
        dieselben Zahlen, sonst oeffnet das Werkzeug etwas anderes als der Code."""
        ensure = self.ensure.read_text(encoding="utf-8")
        for port in ('"3478"', '"49152-49201"'):
            with self.subTest(port=port):
                self.assertIn(port, ensure)
        worker = (ROOT / "services" / "portal-worker" / "src" / "index.js").read_text(encoding="utf-8")
        provision = (HETZNER / "provision.py").read_text(encoding="utf-8")
        for source in (worker, provision):
            self.assertIn("49152-49201", source)
        # Trockenlauf per Default: schreiben nur mit --apply.
        self.assertIn('"--apply" in args', ensure)
        self.assertIn("Trockenlauf", ensure)

    def test_aufraeumen_loescht_nur_ungebundene_firewalls(self) -> None:
        text = self.cleanup.read_text(encoding="utf-8")
        # Reihenfolge: erst applied_to pruefen, dann loeschen.
        check = text.index("applied_to")
        delete = text.index('"DELETE"')
        self.assertLess(check, delete, "applied_to muss VOR dem DELETE geprueft werden")
        self.assertIn("UEBERSPRUNGEN", text)
        self.assertIn('"--apply" in sys.argv', text)
        # Der Legacy-Praefix kommt aus der einen Namensquelle, nicht als Literal.
        self.assertIn("fleet-names.sh", text)

    def test_metrik_scrape_ist_verdrahtet(self) -> None:
        """Der App-Metrik-Job darf nicht an Cloudflare haengen: die App
        veroeffentlicht 8080 (nur per Firewall fuer den Monitoring-Knoten
        erreichbar), der Scrape laeuft direkt und bleibt token-geschuetzt."""
        metrics = HETZNER / "firewall-ensure-app-metrics.py"
        self.assertTrue(metrics.exists(), "firewall-ensure-app-metrics.py fehlt")
        text = metrics.read_text(encoding="utf-8")
        self.assertIn('"--apply" in args', text)
        self.assertIn("APP_IP", text)
        self.assertIn("EDGE_IP", text)

        compose = (ROOT / "docker-compose.hetzner.yml").read_text(encoding="utf-8")
        self.assertIn('"8080:8080"', compose, "App-Port fuer den Scrape muss veroeffentlicht sein")
        # Der Port darf nicht unkommentiert offen stehen - die Begrenzung liegt
        # in der Hetzner-Firewall, das muss an der Stelle stehen.
        block = compose[compose.index('"8080:8080"') - 900:compose.index('"8080:8080"')]
        self.assertIn("firewall-ensure-app-metrics", block)
        self.assertIn("SCRAPE_TOKEN", block)


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


#: Fake `systemctl` fuer den Idle-Timer-Vertrag (PROD-P3-F9): protokolliert JEDEN
#: Aufruf und tut nichts. Damit ist ohne root/systemd belegbar, welche Befehle der
#: Installer wirklich absendet - und dass kein Stopp/Disable darunter ist.
FAKE_SYSTEMCTL = r"""#!/usr/bin/env bash
set -uo pipefail
printf '%s\n' "$*" >> "${FAKE_SYSTEMCTL_LOG:?}"
case "${1:-}" in
  is-active) printf '%s\n' "${FAKE_SYSTEMCTL_ACTIVE:-active}" ;;
  list-timers) printf '%s\n' "${FAKE_SYSTEMCTL_TIMERS:-}" ;;
esac
exit 0
"""

#: Fake `ssh` fuer den Recreate-Pfad: protokolliert den entfernten Befehl und
#: fuehrt ihn LOKAL aus (bash -c). Der Knotenpfad /opt/audiomonastry wird auf das
#: Repo-Verzeichnis umgeschrieben, damit der ECHTE Installer-Codepfad laeuft -
#: kein Knoten, kein /etc, kein /usr, kein systemd, kein Netz.
FAKE_SSH_EXEC = r"""#!/usr/bin/env bash
set -uo pipefail
cmd="${*: -1}"
printf '%s\n' "$cmd" >> "${FAKE_SSH_LOG:?}"
exec bash -c "${cmd//\/opt\/audiomonastry/${FAKE_SSH_REPO:?}}"
"""


class IdleShutdownTimerTest(unittest.TestCase):
    """PROD-P3-F9: Der Idle-Shutdown-Timer ist installierbar, idempotent, im
    Recreate-Pfad verankert - und der Installer stoppt nichts.

    Gefahren wird der ECHTE Installer-Codepfad in einer Sandbox: ein Fake
    `systemctl` im PATH protokolliert die Befehle, `IDLE_BIN_DIR`/`IDLE_UNIT_DIR`/
    `ENV_DIR`/`APP_ENV_FILE`/`LOG` zeigen in ein Temp-Verzeichnis. Kein root,
    kein /etc, kein systemd, kein Knoten - und kein Shutdown: der Check selbst
    (der `shutdown -h now` enthaelt) wird hier nie gestartet.
    """

    #: Was der Installer an systemd senden DARF. Jede andere Zeile ist ein Befund
    #: (ein `stop`/`disable` waere ein Eingriff in laufende Dienste).
    ERLAUBTE_SYSTEMCTL_AUFRUFE = (
        r"daemon-reload",
        r"enable --now audiomonastry-idle-shutdown\.timer",
        r"is-active audiomonastry-idle-shutdown\.timer",
        r"list-timers audiomonastry-idle-shutdown\.timer --no-pager",
    )

    def setUp(self) -> None:
        self.bash = bash_path()
        for path in (INSTALL_IDLE_SHUTDOWN, IDLE_CHECK_SRC, IDLE_SERVICE_UNIT, IDLE_TIMER_UNIT):
            if not path.exists():  # pragma: no cover - Dateien sind eingecheckt
                self.fail(f"fehlt: {path}")

    # --- Helpers -----------------------------------------------------------
    def _sandbox(self, tmp: pathlib.Path, **extra: str) -> dict[str, str]:
        """Fake `systemctl` im PATH + Sandbox-Ziele (liefert die Umgebung)."""
        fake_bin = tmp / "bin"
        fake_bin.mkdir(parents=True, exist_ok=True)
        systemctl = fake_bin / "systemctl"
        systemctl.write_text(FAKE_SYSTEMCTL, encoding="utf-8")
        systemctl.chmod(0o755)
        return clean_env(
            PATH=f"{fake_bin}:{os.environ.get('PATH', '')}",
            FAKE_SYSTEMCTL_LOG=str(tmp / "systemctl.log"),
            IDLE_BIN_DIR=str(tmp / "local-bin"),
            IDLE_UNIT_DIR=str(tmp / "units"),
            ENV_DIR=str(tmp / "etc-audiomonastry"),
            APP_ENV_FILE=str(tmp / "app.env"),
            LOG=str(tmp / "idle-check.log"),
            **extra,
        )

    def _install(self, env: dict[str, str], *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [self.bash, str(INSTALL_IDLE_SHUTDOWN), *args],
            capture_output=True, text=True, cwd=ROOT, timeout=120, env=env,
        )

    @staticmethod
    def _combined(result: subprocess.CompletedProcess) -> str:
        return result.stdout + result.stderr

    @staticmethod
    def _calls(tmp: pathlib.Path) -> list[str]:
        """Die an systemd gesendeten Befehle (Fake-Protokoll)."""
        log = tmp / "systemctl.log"
        return log.read_text(encoding="utf-8").splitlines() if log.exists() else []

    def _assert_nur_erlaubte_aufrufe(self, calls: list[str]) -> None:
        for line in calls:
            self.assertTrue(
                any(re.fullmatch(muster, line) for muster in self.ERLAUBTE_SYSTEMCTL_AUFRUFE),
                f"unerwarteter systemctl-Aufruf: {line!r}",
            )

    @staticmethod
    def _unit_teil(teil: str) -> str:
        """Eine Abteilung aus `--print-units` ohne die fuehrende Pfad-Marke."""
        return teil.strip().split("\n", 1)[1].strip()

    @staticmethod
    def _code_only(text: str) -> str:
        """Quelltext ohne Kommentarzeilen (Pruefung auf KOMMANDOS, nicht auf
        Begruendungen - die nennen die alten Fehlerwege)."""
        return "\n".join(line for line in text.splitlines() if not line.strip().startswith("#"))

    # --- 1. Unit-Vertrag ----------------------------------------------------
    def test_units_liegen_im_repo_und_werden_kopiert(self) -> None:
        service = IDLE_SERVICE_UNIT.read_text(encoding="utf-8")
        self.assertIn("Type=oneshot", service)
        self.assertIn("ExecStart=/usr/local/bin/audiomonastry-idle-check.sh", service)
        # Ohne Token laeuft der Check fail-safe: die Datei ist optional ('-').
        self.assertIn("EnvironmentFile=-/etc/audiomonastry/idle-check.env", service)
        self.assertIn("Environment=IDLE_MINUTES=", service)
        self.assertNotIn("ExecStop", service)
        timer = IDLE_TIMER_UNIT.read_text(encoding="utf-8")
        # Boot-relativ statt Kalenderzeit: die Flotte wird je Session neu erzeugt.
        self.assertIn("OnBootSec=5min", timer)
        self.assertIn("OnUnitActiveSec=5min", timer)
        self.assertIn("Unit=audiomonastry-idle-shutdown.service", timer)
        self.assertIn("WantedBy=timers.target", timer)

        text = INSTALL_IDLE_SHUTDOWN.read_text(encoding="utf-8")
        self.assertIn('install -m 0755 "$CHECK_SRC" "$BIN_DIR/audiomonastry-idle-check.sh"', text)
        self.assertIn('install -m 0644 "$SERVICE_SRC" "$UNIT_DIR/${SERVICE}.service"', text)
        self.assertIn('install -m 0644 "$TIMER_SRC" "$UNIT_DIR/${SERVICE}.timer"', text)
        # Kein Heredoc-Nachbau der Units: genau das lief gegen die Repo-Fassung
        # auseinander (Lehre aus INFRA-HETZNER-005).
        self.assertNotIn("<< UNIT", text)
        self.assertNotIn("<< TIMER", text)

    # --- 2. Installation + Idempotenz ---------------------------------------
    def test_installer_installiert_idempotent_und_aktiviert_den_timer(self) -> None:
        with tempfile.TemporaryDirectory(prefix="p3f9-idle-") as tmpdir:
            tmp = pathlib.Path(tmpdir)
            (tmp / "app.env").write_text(
                "STUDIO_ACCESS_TOKEN=token-aus-der-knoten-env\n", encoding="utf-8"
            )
            env = self._sandbox(tmp)
            erste = self._install(env)
            combined_erste = self._combined(erste)
            calls_erste = self._calls(tmp)

            units = tmp / "units"
            service_kopie = units / "audiomonastry-idle-shutdown.service"
            timer_kopie = units / "audiomonastry-idle-shutdown.timer"
            check_kopie = tmp / "local-bin" / "audiomonastry-idle-check.sh"
            token_datei = tmp / "etc-audiomonastry" / "idle-check.env"

            self.assertEqual(erste.returncode, 0, combined_erste)
            self.assertIn("[done] Idle-Shutdown-Timer aktiv", combined_erste)
            self.assertTrue(service_kopie.exists())
            self.assertTrue(timer_kopie.exists())
            self.assertTrue(check_kopie.exists())
            self.assertTrue(token_datei.exists())
            # Modus 0600 wie dokumentiert - und der Tokenwert erscheint NIE in
            # der Ausgabe des Installers.
            self.assertEqual(token_datei.stat().st_mode & 0o777, 0o600)
            self.assertIn("STUDIO_ACCESS_TOKEN=token-aus-der-knoten-env", token_datei.read_text(encoding="utf-8"))
            self.assertIn("IDLE_CHECK_URL=http://127.0.0.1:8080/api/idle-signal", token_datei.read_text(encoding="utf-8"))
            self.assertNotIn("token-aus-der-knoten-env", combined_erste)
            # Der Check liegt ausfuehrbar im Zielverzeichnis und ist die Repo-Datei.
            self.assertEqual(check_kopie.stat().st_mode & 0o777, 0o755)
            self.assertEqual(check_kopie.read_text(encoding="utf-8"), IDLE_CHECK_SRC.read_text(encoding="utf-8"))
            # Der Timer ist byte-identisch mit der Repo-Fassung (Default-Intervall);
            # die Service-Kopie unterscheidet sich NUR in den Sandbox-Pfaden.
            self.assertEqual(timer_kopie.read_text(encoding="utf-8"), IDLE_TIMER_UNIT.read_text(encoding="utf-8"))
            service_kopie_text = service_kopie.read_text(encoding="utf-8")
            ueberschrieben = ("Environment=LOG=", "EnvironmentFile=-", "StandardOutput=append:", "StandardError=append:")
            for zeile in IDLE_SERVICE_UNIT.read_text(encoding="utf-8").splitlines():
                if zeile.startswith(ueberschrieben):
                    continue
                self.assertIn(zeile, service_kopie_text, f"Zeile fehlt in der Kopie: {zeile!r}")
            self.assertIn(f"Environment=LOG={tmp / 'idle-check.log'}", service_kopie_text)
            self.assertIn(f"EnvironmentFile=-{token_datei}", service_kopie_text)
            # Das Ziel IM LAUF muss dasselbe sein wie die EnvironmentFile der
            # Unit - sonst kommt der Token nie an (fail-safe, aber blind).
            self.assertIn(f"Environment=IDLE_CHECK_ENV_FILE={token_datei}", service_kopie_text)
            self.assertIn("daemon-reload", calls_erste)
            self.assertIn("enable --now audiomonastry-idle-shutdown.timer", calls_erste)
            self._assert_nur_erlaubte_aufrufe(calls_erste)

            # Zweiter Lauf: der Betreiber hat die Env-Datei von Hand ergaenzt - das
            # darf NICHT ueberschrieben werden (Token geht sonst verloren).
            erweitert = token_datei.read_text(encoding="utf-8") + "# vom Betreiber ergaenzt\n"
            token_datei.write_text(erweitert, encoding="utf-8")
            zweite = self._install(env)
            combined_zweite = self._combined(zweite)
            calls_alle = self._calls(tmp)
            token_nach_zweitem = token_datei.read_text(encoding="utf-8")
            timer_nach_zweitem = timer_kopie.read_text(encoding="utf-8")

        self.assertEqual(zweite.returncode, 0, combined_zweite)
        self.assertIn("bleibt unveraendert", combined_zweite)
        self.assertEqual(token_nach_zweitem, erweitert)
        self.assertEqual(timer_nach_zweitem, IDLE_TIMER_UNIT.read_text(encoding="utf-8"))
        # Beide Laeufe aktivieren denselben Timer, nichts anderes.
        self.assertEqual(calls_alle.count("daemon-reload"), 2)
        self.assertEqual(calls_alle.count("enable --now audiomonastry-idle-shutdown.timer"), 2)
        self._assert_nur_erlaubte_aufrufe(calls_alle)

    # --- 3. Parameter -------------------------------------------------------
    def test_parameter_landen_in_den_kopien_und_nicht_im_repo(self) -> None:
        with tempfile.TemporaryDirectory(prefix="p3f9-param-") as tmpdir:
            tmp = pathlib.Path(tmpdir)
            (tmp / "app.env").write_text("SCRAPE_TOKEN=token-aus-der-knoten-env\n", encoding="utf-8")
            env = self._sandbox(tmp, IDLE_MINUTES="60", CHECK_INTERVAL="3")
            ergebnis = self._install(env)
            combined = self._combined(ergebnis)
            service_kopie = (tmp / "units" / "audiomonastry-idle-shutdown.service").read_text(encoding="utf-8")
            timer_kopie = (tmp / "units" / "audiomonastry-idle-shutdown.timer").read_text(encoding="utf-8")

        self.assertEqual(ergebnis.returncode, 0, combined)
        self.assertIn("Environment=IDLE_MINUTES=60", service_kopie)
        self.assertIn("OnUnitActiveSec=3min", timer_kopie)
        self.assertIn("idle=60 min, Pruefung alle 3 min", combined)
        # Die Repo-Dateien bleiben die Quelle mit den Defaults (kein Drift).
        self.assertIn("Environment=IDLE_MINUTES=30", IDLE_SERVICE_UNIT.read_text(encoding="utf-8"))
        self.assertIn("OnUnitActiveSec=5min", IDLE_TIMER_UNIT.read_text(encoding="utf-8"))

    # --- 4. Unvollstaendiger Zustand: kein Token ---------------------------
    def test_ohne_token_bricht_der_installer_mit_klartext_ab(self) -> None:
        with tempfile.TemporaryDirectory(prefix="p3f9-notoken-") as tmpdir:
            tmp = pathlib.Path(tmpdir)
            (tmp / "app.env").write_text("# Knoten-.env ohne Token\n", encoding="utf-8")
            env = self._sandbox(tmp)
            ergebnis = self._install(env)
            combined = self._combined(ergebnis)
            calls = self._calls(tmp)
            units_da = (tmp / "units").exists()
            bin_da = (tmp / "local-bin").exists()
            token_da = (tmp / "etc-audiomonastry" / "idle-check.env").exists()

        self.assertEqual(ergebnis.returncode, 2, combined)
        self.assertIn("[fail] Kein Token gefunden", combined)
        self.assertIn("IDLE_ALLOW_TOKEN_LESS=1", combined)
        self.assertIn("NICHTS installiert", combined)
        # Fail-early: nichts kopiert, nichts aktiviert, nichts gestartet.
        self.assertFalse(units_da, "Der Installer hat trotz fehlendem Token Einheiten installiert")
        self.assertFalse(bin_da)
        self.assertFalse(token_da)
        self.assertEqual(calls, [])

    def test_allow_token_less_installiert_bewusst_den_blinden_check(self) -> None:
        with tempfile.TemporaryDirectory(prefix="p3f9-tokenless-") as tmpdir:
            tmp = pathlib.Path(tmpdir)
            (tmp / "app.env").write_text("# Knoten-.env ohne Token\n", encoding="utf-8")
            env = self._sandbox(tmp, IDLE_ALLOW_TOKEN_LESS="1")
            ergebnis = self._install(env)
            combined = self._combined(ergebnis)
            calls = self._calls(tmp)
            token_text = (tmp / "etc-audiomonastry" / "idle-check.env").read_text(encoding="utf-8")

        self.assertEqual(ergebnis.returncode, 0, combined)
        self.assertIn("[warn] IDLE_ALLOW_TOKEN_LESS=1", combined)
        self.assertIn("fail-safe", combined)
        self.assertIsNone(re.search(r"(?m)^SCRAPE_TOKEN=", token_text))
        self.assertIsNone(re.search(r"(?m)^STUDIO_ACCESS_TOKEN=", token_text))
        self.assertIn("enable --now audiomonastry-idle-shutdown.timer", calls)

    def test_unvollstaendige_quellen_brechen_mit_klartext_ab(self) -> None:
        """Fehlt eine Unit im Repo-Stand des Knotens (z. B. alte Repo-Kopie), darf
        der Installer nichts halb installieren - Exit 1 mit Klartext."""
        with tempfile.TemporaryDirectory(prefix="p3f9-src-") as tmpdir:
            tmp = pathlib.Path(tmpdir)
            fake_hetzner = tmp / "scripts" / "hetzner"
            (fake_hetzner / "systemd").mkdir(parents=True)
            shutil.copy(INSTALL_IDLE_SHUTDOWN, fake_hetzner / "install-idle-shutdown.sh")
            shutil.copy(IDLE_CHECK_SRC, fake_hetzner / "systemd" / "idle-check.sh")
            # Die Units fehlen absichtlich.
            env = self._sandbox(tmp)
            (tmp / "app.env").write_text("SCRAPE_TOKEN=token-aus-der-knoten-env\n", encoding="utf-8")
            ergebnis = subprocess.run(
                [self.bash, str(fake_hetzner / "install-idle-shutdown.sh")],
                capture_output=True, text=True, cwd=ROOT, timeout=120, env=env,
            )
            combined = self._combined(ergebnis)
            units_da = (tmp / "units").exists()

        self.assertEqual(ergebnis.returncode, 1, combined)
        self.assertIn("[fail] Quelle fehlt", combined)
        self.assertIn("audiomonastry-idle-shutdown.service", combined)
        self.assertIn("NICHTS installiert", combined)
        self.assertFalse(units_da)

    # --- 5. Gegenprobe: der Installer stoppt nichts -------------------------
    def test_gegenprobe_der_installer_stoppt_nichts(self) -> None:
        code = self._code_only(INSTALL_IDLE_SHUTDOWN.read_text(encoding="utf-8"))
        for verboten in (
            "lifecycle.sh",
            "systemctl stop",
            "systemctl disable",
            "shutdown -h",
            "poweroff",
            "reboot",
            "docker stop",
            "docker compose stop",
            "down -v",
            "rm -rf",
        ):
            self.assertNotIn(verboten, code, f"Der Installer darf '{verboten}' nicht ausfuehren")
        # ... und die Units tragen keinen Stopp-Pfad.
        self.assertNotIn("ExecStop", IDLE_SERVICE_UNIT.read_text(encoding="utf-8"))
        # Der Check selbst faehrt nur herunter, wenn die APP idle meldet - und der
        # Trockenlauf unterdrueckt das (die Zeile ist der Beleg im Skript).
        check = IDLE_CHECK_SRC.read_text(encoding="utf-8")
        self.assertIn('if [[ "$DRY_RUN" == "1" ]]', check)
        self.assertIn("shutdown -h now", check)

    # --- 6. Recreate-Pfad (Fake-ssh faehrt die Kommandozeile lokal) ---------
    def test_recreate_pfad_schickt_den_installer_ueber_ssh(self) -> None:
        command = "bash /opt/audiomonastry/scripts/hetzner/install-idle-shutdown.sh"
        bring_up = BRING_UP.read_text(encoding="utf-8")
        self.assertIn(f'ssh_host "$ip" \'{command}\'', bring_up)
        # Kein stilles Schlucken mehr: ein Fehlschlag wird benannt.
        self.assertNotIn("install-idle-shutdown.sh' 2>/dev/null || true", bring_up)
        self.assertIn("Idle-Timer konnte auf $ip nicht installiert werden", bring_up)
        self.assertIn("install-idle-shutdown.sh", PORTAL_WORKER.read_text(encoding="utf-8"))

        with tempfile.TemporaryDirectory(prefix="p3f9-recreate-") as tmpdir:
            tmp = pathlib.Path(tmpdir)
            (tmp / "app.env").write_text("SCRAPE_TOKEN=token-aus-der-knoten-env\n", encoding="utf-8")
            env = self._sandbox(tmp, FAKE_SSH_LOG=str(tmp / "ssh.log"), FAKE_SSH_REPO=str(ROOT))
            ssh = tmp / "bin" / "ssh"
            ssh.write_text(FAKE_SSH_EXEC, encoding="utf-8")
            ssh.chmod(0o755)
            ergebnis = subprocess.run(
                [self.bash, "-c", f"ssh root@203.0.113.7 '{command}'"],
                capture_output=True, text=True, cwd=ROOT, timeout=120, env=env,
            )
            combined = self._combined(ergebnis)
            ssh_log = (tmp / "ssh.log").read_text(encoding="utf-8") if (tmp / "ssh.log").exists() else ""
            calls = self._calls(tmp)

        self.assertEqual(ergebnis.returncode, 0, combined)
        self.assertIn(command, ssh_log)
        self.assertIn("[done] Idle-Shutdown-Timer aktiv", combined)
        self.assertIn("daemon-reload", calls)
        self.assertIn("enable --now audiomonastry-idle-shutdown.timer", calls)
        self._assert_nur_erlaubte_aufrufe(calls)

    # --- 7. Trockenlauf: Units offline pruefbar -----------------------------
    def test_print_units_gibt_die_repo_fassung_aus_und_installiert_nichts(self) -> None:
        with tempfile.TemporaryDirectory(prefix="p3f9-print-") as tmpdir:
            tmp = pathlib.Path(tmpdir)
            env = self._sandbox(tmp)  # bewusst OHNE Token: der Trockenlauf laeuft trotzdem
            ergebnis = self._install(env, "--print-units")
            combined = self._combined(ergebnis)
            teile = ergebnis.stdout.split("---8<---")
            calls = self._calls(tmp)
            units_da = (tmp / "units").exists()
            token_da = (tmp / "etc-audiomonastry" / "idle-check.env").exists()

        self.assertEqual(ergebnis.returncode, 0, combined)
        self.assertEqual(len(teile), 3, ergebnis.stdout)
        # Teil 1/2 sind die Repo-Units (die erste Zeile ist die Pfad-Marke).
        self.assertEqual(self._unit_teil(teile[0]), IDLE_SERVICE_UNIT.read_text(encoding="utf-8").strip())
        self.assertEqual(self._unit_teil(teile[1]), IDLE_TIMER_UNIT.read_text(encoding="utf-8").strip())
        # Teil 3 ist die Vorlage der Env-Datei - ohne Tokenwert.
        self.assertIn("IDLE_CHECK_URL=http://127.0.0.1:8080/api/idle-signal", teile[2])
        self.assertIn("Token-Werte werden nicht ausgegeben", ergebnis.stdout)
        self.assertNotIn("token-aus-der-knoten-env", combined)
        # Ein Trockenlauf installiert und aktiviert nichts.
        self.assertFalse(units_da)
        self.assertFalse(token_da)
        self.assertEqual(calls, [])

    # --- 8. systemd-analyze verify (Pfad-Trick, kein root) ------------------
    def test_units_bestehen_systemd_analyze_verify(self) -> None:
        """`systemd-analyze verify --root=<fake-root>`: der Trick braucht den
        ExecStart-Pfad im Root (sonst "Command ... is not executable") und die
        Basis-Targets (sonst "Unit sysinit.target not found")."""
        analyze = shutil.which("systemd-analyze")
        system_units = pathlib.Path("/usr/lib/systemd/system")
        if analyze is None or not (system_units / "basic.target").is_file():
            self.skipTest("systemd-analyze bzw. Basis-Units nicht vorhanden (z. B. Nicht-Linux-CI)")
        with tempfile.TemporaryDirectory(prefix="p3f9-verify-") as tmpdir:
            root = pathlib.Path(tmpdir) / "root"
            (root / "etc" / "systemd" / "system").mkdir(parents=True)
            (root / "usr" / "local" / "bin").mkdir(parents=True)
            (root / "usr" / "lib" / "systemd" / "system").mkdir(parents=True)
            for unit in (IDLE_SERVICE_UNIT, IDLE_TIMER_UNIT):
                shutil.copy(unit, root / "etc" / "systemd" / "system" / unit.name)
            check_kopie = root / "usr" / "local" / "bin" / "audiomonastry-idle-check.sh"
            shutil.copy(IDLE_CHECK_SRC, check_kopie)
            check_kopie.chmod(0o755)
            for target in system_units.glob("*.target"):
                shutil.copy(target, root / "usr" / "lib" / "systemd" / "system" / target.name)
            ergebnisse = {
                unit.name: subprocess.run(
                    # `verify` MUSS als Verb mitkommen - ohne Verb lehnt
                    # systemd-analyze `--root=` ab ("only supported for
                    # cat-config, verify, condition and security").
                    [analyze, "verify", f"--root={root}", unit.name],
                    capture_output=True, text=True, timeout=120,
                )
                for unit in (IDLE_TIMER_UNIT, IDLE_SERVICE_UNIT)
            }
        for name, ergebnis in ergebnisse.items():
            with self.subTest(unit=name):
                self.assertEqual(ergebnis.returncode, 0, ergebnis.stdout + ergebnis.stderr)
                self.assertEqual(ergebnis.stdout + ergebnis.stderr, "", f"systemd-analyze meldet etwas: {name}")


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
    # F1: der SFU-Record gehoert zur selben Pruefung (eigener Host, eigene IP).
    "SFU_IP", "SFU_SUBDOMAIN",
    # PROD-P1-F4: Build-Stempel und Parity-Schalter kommen IMMER aus dem Test.
    "DEPLOY_COMMIT", "DEPLOY_VERSION", "DEPLOY_ALLOW_STALE", "ALLOW_STALE", "PORTAL_URL",
    "ADMIN_USER", "ADMIN_PASSWORD", "AUDIOMONASTRY_VERSION", "AUDIOMONASTRY_COMMIT",
    "AUDIOMONASTRY_BUILD_TIME",
    # Env-Datei-Schalter (fleet-preflight.sh): Tests laufen OHNE die echte
    # .env.deploy des Betreiber-Rechners, siehe clean_env().
    "FLEET_ENV_FILE",
    # F10: Namens-/Pfadquellen und der Compose-Projektname - sonst haengt ein
    # Testlauf an der Shell des Rechners (die Skripte lesen sie per ${VAR:-...}).
    "COMPOSE_PROJECT_NAME", "COMPOSE_PROJECT", "FLEET_COMPOSE_PROJECT", "LEGACY_COMPOSE_PROJECT",
    "FLEET_PREFIX", "LEGACY_FLEET_PREFIX", "FLEET_HOME", "LEGACY_FLEET_HOME",
    "DEPLOY_LEGACY_REMOTE_DIR",
    # PROD-P2-REG: GHCR-Zugangsdaten + Registry-Schalter. Die Hermes-Shell kann
    # GHCR_USERNAME/GHCR_PASSWORD exportiert haben - dann liefe ein Test gegen die
    # ECHTEN Zugangsdaten des Betreibers (gemessen am 2026-09-21: GHCR_USERNAME
    # und GHCR_PASSWORD waren in der Prozessumgebung gesetzt). Tests setzen ihre
    # eigenen Werte, dieser Eintrag nimmt sie vorher heraus.
    "GHCR_USERNAME", "GHCR_TOKEN", "GHCR_PASSWORD", "GHCR_PAT_ALL_ACCESS",
    "REGISTRY_ENV_FILE", "REGISTRY_OWNER", "REGISTRY_TAG", "REGISTRY_DOCKER",
    "REGISTRY_SKIP_BUILD", "REGISTRY_FORCE_PUSH",
    "DEPLOY_IMAGE_SOURCE", "DEPLOY_REGISTRY_IMAGE", "DEPLOY_REGISTRY_IMAGE_MASTER",
    # PERF-P1-005: der Image-Weg des Flottenstarts (bring-up-fleet.sh Default 1).
    # Ohne diesen Eintrag haengt der Vertragstest an der Shell des Rechners.
    "DEPLOY_REMOTE_BUILD",
    # PERF-P1-005: R2-/Transfer-Konfiguration. Ohne diese Liste zoege ein Test
    # die Schluessel des Betreiber-Rechners (die Hermes-Shell exportiert z. B.
    # CFS3_BUCKET) und "ohne Schluessel" waere nicht pruefbar.
    "CFS3_ACCESS_KEY", "CFS3_SECRET_KEY", "CFS3_ENDPOINT", "CFS3_BUCKET",
    "CFR2_ACCOUNT_ID", "R2_ENV_FILE", "R2_ACCESS_KEY", "R2_SECRET_KEY",
    "R2_ENDPOINT", "R2_BUCKET", "R2_REGION", "R2_ACCOUNT_ID", "R2_SIGNED_AT",
    "TRANSFER_TMP", "PARALLEL_TRANSFER_CONNECTIONS", "PARALLEL_TRANSFER_ZSTD_LEVEL",
    "PARALLEL_TRANSFER_URL_TTL", "PARALLEL_TRANSFER_PREFIX", "PARALLEL_TRANSFER_REFERENCE_MBPS",
    "MEDIA_SRC_ORCHESTRAL", "MEDIA_SRC_MODELS", "MEDIA_SRC_MUSIC", "MEDIA_R2_NO_INSTALL",
    # INFRA-HETZNER-014: der Firewall-Abgleich liest HCLOUD_TOKEN/Grenzen aus der
    # Umgebung. Ohne diese Eintraege wuerde ein Testlauf den Token der Betreiber-
    # Shell nehmen (gemessen 2026-09-21: HCLOUD_TOKEN war in der Prozessumgebung
    # gesetzt) und "ohne Token" waere nicht pruefbar.
    "HCLOUD_TOKEN", "HCLOUD_ENV_FILE", "HCLOUD_API_BASE", "FLEET_PREFIX",
    "FLEET_FIREWALL_ENSURE",
)


def bash_path() -> str:
    bash = shutil.which("bash")
    if bash is None:  # pragma: no cover - Windows/Exoten
        raise unittest.SkipTest("bash nicht vorhanden")
    return bash


def clean_env(**overrides: str | None) -> dict[str, str]:
    """Prozessumgebung ohne Testfluesterer; `None` entfernt einen Schluessel.

    Zusaetzlich wird die Env-Datei-Isolation gesetzt: auf einem Betreiber-Rechner
    liegt im Repo-Root eine ECHTE `.env.deploy`, die fleet-preflight.sh selbst
    einliest und damit die Testwerte ueberschreibt. Gemessen am 2026-09-20: drei
    Tests dieses Moduls (DnsTest) wurden rot, weil CLOUDFLARE_API_TOKEN aus
    `.env.deploy` kam - "funktioniert nur auf Rechnern ohne Tokens" ist kein
    Test. `FLEET_ENV_FILE=none` schaltet das Laden ab; wer das Laden PRUEFEN
    will, setzt den Wert ausdruecklich.
    """
    env = os.environ.copy()
    for key in CONTROLLED_ENV:
        env.pop(key, None)
    env.setdefault("FLEET_ENV_FILE", "none")
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
        # Seit dem Medien-Overlay haengt hinter $COMPOSE_FILE optional
        # $MEDIA_OVERLAY - der Befehl bleibt derselbe, nur mit einem weiteren -f.
        caddy_start = self._line_of("docker compose -f $COMPOSE_FILE$MEDIA_OVERLAY up -d caddy")
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
        records_by_name: dict[str, tuple[int, dict]] | None = None,
    ) -> None:
        self.zone = zone or (200, {"success": True, "errors": [], "result": [{"id": "zone-4711", "name": "anunnakitools.de"}]})
        self.records = records or (200, {"success": True, "errors": [], "result": []})
        # Je Host eine eigene Antwort (Origin und SFU haben verschiedene Ziele).
        self.records_by_name = records_by_name or {}
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

    def __exit__(self, *exc: object) -> Literal[False]:
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
            query = urllib.parse.parse_qs(urllib.parse.urlparse(path).query)
            name = (query.get("name") or [""])[0]
            if name and name in self.records_by_name:
                return self.records_by_name[name]
            return self.records
        return 404, {"success": False, "errors": [{"code": 9999, "message": "unbekannter Pfad"}]}

    def methods(self) -> list[str]:
        return [method for method, _path in self.requests]

    def paths(self) -> list[str]:
        return [path for _method, path in self.requests]


class _CloudflareWriteStub:
    """Schreibender Cloudflare-Stub fuer `cf-dns-ensure.py` (offline, kein Netz).

    Haelt die Records im Speicher, damit Trockenlauf (kein Schreibzugriff),
    Anlegen/Korrigieren und Idempotenz echt pruefbar sind - die Zusage
    "Trockenlauf schreibt nichts" waere sonst nur ein Textversprechen.
    """

    def __init__(self, records: list[dict] | None = None) -> None:
        self.records = list(records or [])
        self.requests: list[tuple[str, str]] = []
        self.payloads: list[dict] = []

    def __enter__(self) -> "_CloudflareWriteStub":
        stub = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def _send(self, status: int, payload: dict) -> None:
                body = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _record_request(self) -> bytes:
                length = int(self.headers.get("content-length") or 0)
                raw = self.rfile.read(length) if length else b""
                if raw:
                    stub.payloads.append(json.loads(raw.decode("utf-8")))
                return raw

            def do_GET(self) -> None:  # noqa: N802 - Name kommt von BaseHTTPRequestHandler
                stub.requests.append(("GET", self.path))
                if self.path.startswith("/client/v4/zones?"):
                    return self._send(200, {"success": True, "errors": [], "result": [
                        {"id": "zone-4711", "name": "anunnakitools.de"},
                    ]})
                if "/dns_records" in self.path:
                    query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                    name = (query.get("name") or [""])[0]
                    result = [r for r in stub.records if not name or r["name"] == name]
                    return self._send(200, {"success": True, "errors": [], "result": result})
                return self._send(404, {"success": False, "errors": [{"code": 9999, "message": "unbekannter Pfad"}]})

            def do_POST(self) -> None:  # noqa: N802
                stub.requests.append(("POST", self.path))
                payload = json.loads(self._record_request().decode("utf-8"))
                record = {"id": f"neu-{len(stub.records) + 1}", **payload}
                stub.records.append(record)
                self._send(200, {"success": True, "errors": [], "result": record})

            def do_PUT(self) -> None:  # noqa: N802
                stub.requests.append(("PUT", self.path))
                payload = json.loads(self._record_request().decode("utf-8"))
                record_id = self.path.rsplit("/", 1)[-1]
                for record in stub.records:
                    if record["id"] == record_id:
                        record.update(payload)
                        return self._send(200, {"success": True, "errors": [], "result": record})
                self._send(404, {"success": False, "errors": [{"code": 81044, "message": "record not found"}]})

            def log_message(self, *args: Any) -> None:  # Testausgabe ruhig halten
                return

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *exc: object) -> Literal[False]:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        return False

    @property
    def api_base(self) -> str:
        host, port = self.server.server_address[0], self.server.server_address[1]
        return f"http://{host}:{port}/client/v4"

    def methods(self) -> list[str]:
        return [method for method, _path in self.requests]

    def record_for(self, name: str) -> dict:
        for record in self.records:
            if record.get("name") == name:
                return record
        raise AssertionError(f"kein Record fuer {name}: {self.records}")


class CfDnsEnsureTest(unittest.TestCase):
    """PROD-P1-F1: `cf-dns-ensure.py` haelt den DNS-Vertrag ein - offline geprueft.

    Der Vertrag (identisch mit dem Portal-Worker): beide Records sind A-Records,
    DNS-only, direkt auf den Knoten. Anlass war der Live-Befund vom 2026-09-21:
    `origin.anunnakitools.de` stand auf einem alten Server und war proxied, der
    SFU-Record fehlte ganz - die Domain lief in HTTP 521/522, WebRTC haette per
    `ws://` gegen Mixed Content verloren.
    """

    ORIGIN = "origin.anunnakitools.de"
    SFU = "sfu.anunnakitools.de"
    APP_IP = "203.0.113.10"
    SFU_IP = "203.0.113.20"

    def setUp(self) -> None:
        self.python = sys.executable

    def _run(self, stub: _CloudflareWriteStub | None, *args: str, token: str | None = "cf-token-test"):
        return subprocess.run(
            [self.python, str(CF_DNS_ENSURE), *args],
            capture_output=True, text=True, cwd=ROOT, timeout=60,
            env=clean_env(
                CF_API_BASE=(stub.api_base if stub is not None else "http://127.0.0.1:9/client/v4"),
                CLOUDFLARE_API_TOKEN=token,
                CLOUDFLARE_TOKEN=None,
                DOMAIN="anunnakitools.de",
                ORIGIN_HOST=self.ORIGIN,
                APP_IP=self.APP_IP,
                SFU_SUBDOMAIN="sfu",
                SFU_HOST=self.SFU,
                SFU_IP=self.SFU_IP,
            ),
        )

    def test_trockenlauf_schreibt_nichts(self) -> None:
        stub = _CloudflareWriteStub()
        with stub:
            result = self._run(stub)
        combined = result.stdout + result.stderr
        self.assertEqual(result.returncode, 0, combined)
        self.assertIn("Trockenlauf", combined)
        self.assertIn("wuerde angelegt", combined)
        # Nur GET-Requests, kein POST/PUT - das ist die Kernzusage.
        self.assertEqual(stub.methods(), ["GET", "GET"])
        self.assertEqual(stub.records, [])

    def test_apply_legt_beide_records_als_dns_only_an(self) -> None:
        stub = _CloudflareWriteStub()
        with stub:
            result = self._run(stub, "--apply")
        combined = result.stdout + result.stderr
        self.assertEqual(result.returncode, 0, combined)
        self.assertEqual(stub.methods(), ["GET", "GET", "POST", "POST"])
        for name, ip in ((self.ORIGIN, self.APP_IP), (self.SFU, self.SFU_IP)):
            record = stub.record_for(name)
            self.assertEqual(record["type"], "A")
            self.assertEqual(record["content"], ip)
            self.assertIs(record["proxied"], False, f"{name} muss DNS-only sein")

    def test_drift_wird_korrigiert_und_ist_danach_idempotent(self) -> None:
        # Live-Zustand vom 2026-09-21: falscher Server + proxied=true.
        stub = _CloudflareWriteStub(records=[
            {"id": "rec-origin", "name": self.ORIGIN, "type": "A", "content": "46.225.253.71", "proxied": True},
        ])
        with stub:
            first = self._run(stub, "--apply")
            second = self._run(stub, "--apply")
        combined = first.stdout + first.stderr
        self.assertEqual(first.returncode, 0, combined)
        self.assertIn("korrigiert", combined)
        self.assertIn("proxied=true", combined)
        record = stub.record_for(self.ORIGIN)
        self.assertEqual(record["content"], self.APP_IP)
        self.assertIs(record["proxied"], False)
        # Zweiter Lauf: nichts mehr zu tun, keine weiteren Schreibzugriffe.
        self.assertEqual(stub.methods(), ["GET", "GET", "PUT", "POST", "GET", "GET"])
        self.assertIn("Nichts zu tun", second.stdout)

    def test_ohne_token_kein_request_und_token_nie_im_output(self) -> None:
        stub = _CloudflareWriteStub()
        with stub:
            result = self._run(stub, "--apply", token=None)
        combined = result.stdout + result.stderr
        self.assertEqual(result.returncode, 1, combined)
        self.assertIn("CLOUDFLARE_API_TOKEN/CLOUDFLARE_TOKEN fehlt", combined)
        self.assertEqual(stub.requests, [])

        with stub:
            ok = self._run(stub, "--apply", token="cf-geheim-4711")
        self.assertNotIn("cf-geheim-4711", ok.stdout + ok.stderr)


class ModellDownloadTest(unittest.TestCase):
    """Security-TODO aus docs/ONNX_MODELS.md: der 291-MB-Blob wird geprueft.

    Anlass: `download-models.sh` lud die Datei ungeprueft in den Produktionspfad;
    der Client laedt sie von dort in die Inferenz (src/ai/localDemucs.ts). Der
    erwartete SHA-256 ist der LFS-OID der Quelle - beides muss sichtbar sein und
    eine falsche Datei muss abgelehnt werden.
    """

    SCRIPT = ROOT / "scripts" / "download-models.sh"
    PIN = "d2b401f322558cd57d67a752ed7be3fa55178a0626011eda8ac7bb74e17280c0"
    SIZE = "304321552"

    def setUp(self) -> None:
        self.bash = bash_path()

    def _run(self, *args: str, target: str | None = None):
        env = clean_env(TARGET=target) if target else clean_env()
        return subprocess.run([self.bash, str(self.SCRIPT), *args], capture_output=True, text=True, cwd=ROOT, timeout=120, env=env)

    def test_print_config_zeigt_pin_ohne_netz(self) -> None:
        result = self._run("--print-config")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(self.PIN, result.stdout)
        self.assertIn(self.SIZE, result.stdout)
        self.assertIn("kein Netz", result.stdout)

    def test_verify_only_lehnt_falsche_datei_ab(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fake = pathlib.Path(tmp) / "htdemucs.onnx"
            fake.write_bytes(b"kein echtes modell" * 10)
            result = self._run("--verify-only", target=str(fake))
            combined = result.stdout + result.stderr
            self.assertEqual(result.returncode, 1, combined)
            self.assertIn("Groesse stimmt nicht", combined)

    def test_verify_only_meldet_fehlende_datei(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result = self._run("--verify-only", target=str(pathlib.Path(tmp) / "nicht-da.onnx"))
            self.assertEqual(result.returncode, 1)
            self.assertIn("Modell fehlt", result.stdout + result.stderr)

    def test_verify_only_akzeptiert_echte_datei(self) -> None:
        target = ROOT / "public" / "models" / "htdemucs.onnx"
        if not target.exists():
            self.skipTest("Modell liegt lokal nicht vor (nicht eingecheckt)")
        result = self._run("--verify-only", target=str(target))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Hash-korrekt", result.stdout)

    def test_download_ist_gepinnt_und_laeuft_ueber_eine_part_datei(self) -> None:
        # Kein Download ohne Pruefung: erst .part laden, dann verifizieren, dann mv.
        text = self.SCRIPT.read_text(encoding="utf-8")
        self.assertIn("MODEL_SHA256=", text)
        self.assertIn('PART="$TARGET.part"', text)
        part_check = text.index("verify \"$PART\"")
        move = text.index('mv "$PART" "$TARGET"')
        self.assertLess(part_check, move, "Die Pruefung muss VOR dem Verschieben passieren")


class CfTokenSetTest(unittest.TestCase):
    """F1-Nachlauf: der Token-Setter schreibt nur die vorgesehenen Schluessel.

    Anlass: fuenf Fundstellen in `.env.deploy`/`.env.portal` trugen den toten
    Token (`1000 Invalid API Token`). Das Skript muss (a) im Trockenlauf nichts
    schreiben, (b) nur die genannten Schluesselnamen anfassen (keine Heuristik),
    (c) eine Sicherung anlegen und (d) den Wert nie ausgeben.
    """

    def _run(self, root: pathlib.Path, value: str, *args: str):
        return subprocess.run(
            [sys.executable, str(HETZNER / "cf-token-set.py"), "--value-stdin", *args],
            input=value + "\n", capture_output=True, text=True, cwd=ROOT, timeout=60,
            env=clean_env(CF_REPO_ROOT=str(root), CLOUDFLARE_API_TOKEN=None),
        )

    def _fixture(self, tmp: str) -> pathlib.Path:
        root = pathlib.Path(tmp)
        (root / ".env.deploy").write_text(
            "HCLOUD_TOKEN=behalten\nCLOUDFLARE_API_TOKEN=alter-token\nCF_API_KEY=alter-key\n", encoding="utf-8")
        (root / ".env.portal").write_text(
            "CLOUDFLARE_API_TOKEN=alter-token\nCF_ACCOUNT_TOKEN=alter-account\nADMIN_PASSWORD=behalten\n", encoding="utf-8")
        return root

    def test_trockenlauf_aendert_keine_datei(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = self._fixture(tmp)
            before = (root / ".env.deploy").read_text(encoding="utf-8")
            result = self._run(root, "neuer-token-1234")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("wuerde setzen", result.stdout)
            self.assertEqual((root / ".env.deploy").read_text(encoding="utf-8"), before)

    def test_apply_setzt_nur_die_token_schluessel_und_sichert(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = self._fixture(tmp)
            result = self._run(root, "neuer-token-1234", "--apply")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            deploy = (root / ".env.deploy").read_text(encoding="utf-8")
            portal = (root / ".env.portal").read_text(encoding="utf-8")
            # Gesetzt: die drei Token-Schluessel.
            self.assertIn("CLOUDFLARE_API_TOKEN=neuer-token-1234", deploy)
            self.assertIn("CF_API_KEY=neuer-token-1234", deploy)
            self.assertIn("CF_ACCOUNT_TOKEN=neuer-token-1234", portal)
            # Unberuehrt: alles andere.
            self.assertIn("HCLOUD_TOKEN=behalten", deploy)
            self.assertIn("ADMIN_PASSWORD=behalten", portal)
            self.assertNotIn("alter-token", deploy)
            self.assertNotIn("alter-key", deploy)
            # Sicherung liegt daneben und traegt den Altstand.
            backup = root / ".env.deploy.bak-cftoken"
            self.assertTrue(backup.exists())
            self.assertIn("alter-token", backup.read_text(encoding="utf-8"))
            # Der Wert selbst darf nie in der Ausgabe stehen.
            self.assertNotIn("neuer-token-1234", result.stdout + result.stderr)


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
        sfu_ip: str | None = "198.51.100.7",
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
                SFU_IP=sfu_ip,
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
        origin = "origin.anunnakitools.de"
        sfu = "sfu.anunnakitools.de"
        stub = _CloudflareStub(records_by_name={
            origin: (200, {"success": True, "errors": [], "result": [
                {"id": "rec-1", "type": "A", "name": origin, "content": "203.0.113.5", "proxied": False},
            ]}),
            sfu: (200, {"success": True, "errors": [], "result": [
                {"id": "rec-2", "type": "A", "name": sfu, "content": "198.51.100.7", "proxied": False},
            ]}),
        })
        with stub:
            result = self._run_dns(stub, app_ip="203.0.113.5")
        combined = self._combined(result)
        self.assertEqual(result.returncode, 0, combined)
        self.assertIn("DNS-Verdrahtung ok", combined)
        self.assertIn(origin, combined)
        self.assertIn("203.0.113.5", combined)
        # F1: der SFU-Record wird mitgeprueft (eigener Host, eigene IP).
        self.assertIn(sfu, combined)
        self.assertIn("198.51.100.7", combined)
        # Das Verify-Kommando steht mit dem curl-Statusplatzhalter im Output.
        self.assertIn("curl -sS -o /dev/null", combined)
        self.assertIn("%{http_code}", combined)
        self.assertIn("https://anunnakitools.de/api/health", combined)
        self.assertIn("cf-dns-ensure.py", combined)
        # Zone + Origin + SFU: drei GETs, kein Schreibzugriff.
        self.assertEqual(stub.methods(), ["GET", "GET", "GET"])
        self.assertIn("/client/v4/zones/", stub.paths()[1])
        self.assertIn(f"name={origin}", stub.paths()[1])
        self.assertIn(f"name={sfu}", stub.paths()[2])

    def test_sfu_record_proxied_wird_abgelehnt(self) -> None:
        """WebRTC ist kein HTTP - ein proxied SFU-Record bricht die Signalisierung."""
        origin = "origin.anunnakitools.de"
        sfu = "sfu.anunnakitools.de"
        stub = _CloudflareStub(records_by_name={
            origin: (200, {"success": True, "errors": [], "result": [
                {"id": "rec-1", "type": "A", "name": origin, "content": "203.0.113.5", "proxied": False},
            ]}),
            sfu: (200, {"success": True, "errors": [], "result": [
                {"id": "rec-2", "type": "A", "name": sfu, "content": "198.51.100.7", "proxied": True},
            ]}),
        })
        with stub:
            result = self._run_dns(stub, app_ip="203.0.113.5")
        combined = self._combined(result)
        self.assertEqual(result.returncode, 2, combined)
        self.assertIn(sfu, combined)
        self.assertIn("proxied=true", combined)
        self.assertEqual(stub.methods(), ["GET", "GET", "GET"])

    def test_fehlender_sfu_record_wird_gemeldet(self) -> None:
        origin = "origin.anunnakitools.de"
        stub = _CloudflareStub(records_by_name={
            origin: (200, {"success": True, "errors": [], "result": [
                {"id": "rec-1", "type": "A", "name": origin, "content": "203.0.113.5", "proxied": False},
            ]}),
            "sfu.anunnakitools.de": (200, {"success": True, "errors": [], "result": []}),
        })
        with stub:
            result = self._run_dns(stub, app_ip="203.0.113.5")
        combined = self._combined(result)
        self.assertEqual(result.returncode, 2, combined)
        self.assertIn("sfu.anunnakitools.de", combined)
        self.assertIn("existiert nicht", combined)
        self.assertIn("cf-dns-ensure.py", combined)

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

    def test_env_datei_schalter_steuert_das_laden(self) -> None:
        """FLEET_ENV_FILE: 'none' laedt nichts, ein Pfad laedt genau diese Datei.

        Ohne diesen Schalter liest fleet-preflight.sh auf dem Betreiber-Rechner
        die echte .env.deploy und ueberschreibt die Testwerte - die drei
        DnsTest-Tests waren am 2026-09-20 genau deshalb rot. Der Test haelt
        beide Richtungen fest: Isolation UND echtes Laden.
        """
        with tempfile.TemporaryDirectory() as tmp:
            env_file = pathlib.Path(tmp) / "fleet.env"
            env_file.write_text(f"CLOUDFLARE_API_TOKEN={FAKE_TOKEN}\n", encoding="utf-8")
            args = [self.bash, str(FLEET_PREFLIGHT), "dns", "--print-config"]
            isolated = subprocess.run(
                args, capture_output=True, text=True, cwd=ROOT, timeout=120,
                env=clean_env(FLEET_ENV_FILE="none", CLOUDFLARE_API_TOKEN=None),
            )
            from_file = subprocess.run(
                args, capture_output=True, text=True, cwd=ROOT, timeout=120,
                env=clean_env(FLEET_ENV_FILE=str(env_file), CLOUDFLARE_API_TOKEN=None),
            )
        self.assertEqual(isolated.returncode, 0, self._combined(isolated))
        self.assertIn("CLOUDFLARE_API_TOKEN gesetzt: nein", isolated.stdout)
        self.assertEqual(from_file.returncode, 0, self._combined(from_file))
        self.assertIn("CLOUDFLARE_API_TOKEN gesetzt: ja", from_file.stdout)
        # Der Token selbst darf nie im Klartext auftauchen.
        self.assertNotIn(FAKE_TOKEN, from_file.stdout + from_file.stderr)

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


class _HealthStub:
    """Lokaler `/api/health`-Stub (kein Test spricht ins Internet).

    Beantwortet genau einen Pfad: `/api/health`. Alles andere wird 404 - so
    laesst sich pruefen, dass der Paritaetsvergleich WIRKLICH den laufenden
    Knoten liest und nicht irgendeine andere Antwort.
    """

    def __init__(self, body: dict[str, Any] | None = None, status: int = 200) -> None:
        self.body = body if body is not None else {"status": "ok", "version": "1.210.001", "commit": "ae5e749"}
        self.status = status
        self.hits: list[str] = []

    def __enter__(self) -> "_HealthStub":
        stub = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802 - Name kommt von BaseHTTPRequestHandler
                stub.hits.append(self.path)
                if self.path.split("?")[0] != "/api/health":
                    self.send_error(404, "dieser Stub kennt nur /api/health")
                    return
                body = json.dumps(stub.body).encode("utf-8")
                self.send_response(stub.status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args: Any) -> None:  # Testausgabe ruhig halten
                return

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *exc: object) -> Literal[False]:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        return False

    @property
    def base_url(self) -> str:
        host, port = self.server.server_address[0], self.server.server_address[1]
        return f"http://{host}:{port}"


#: Bibliotheks-Funktionen, die die Skripte aufrufen. Der Waechter unten sucht
#: genau diese Namen (mit Suffix) in deploy.sh/fleet-preflight.sh und prueft,
#: dass sie die Bibliothek wirklich deklariert.
PARITY_LIB_CALLS = (
    "verify_build_parity", "parity_gate", "build_parity_report", "health_commit",
    "normalize_commit", "json_field",
)
_PARITY_CALL_RE = re.compile(r"(?<![\w-])(" + "|".join(f"{name}\\w*" for name in PARITY_LIB_CALLS) + r")\b")


class BuildParityTest(unittest.TestCase):
    """PROD-P1-F4: das Staleness-Gate - echt gefahren, nicht nur im Text gesucht.

    Anlass: app-1 lief am 2026-09-20 auf einem Image vom 18.09., das Repo stand
    auf `ae5e749` (20.09.). `/api/health` nannte nur eine Version, die sich nicht
    mit jedem Commit aendert - die Abweichung war unbelegbar.

    Der Test faehrt deshalb den ECHTEN Entscheidungspfad
    (`scripts/hetzner/lib/build-parity.sh`, dieselbe Bibliothek, die deploy.sh
    und fleet-preflight.sh sourcen) gegen einen lokalen /api/health-Stub: mit
    einem ALTEN Stand als `commit` muss er scheitern (Exit 1, Klartextmeldung),
    mit `allow-stale` bewusst durchgehen, und ohne commit-Feld (Image vor F4)
    NICHT blockieren.
    """

    LIB = ROOT / "scripts" / "hetzner" / "lib" / "build-parity.sh"

    def setUp(self) -> None:
        self.bash = bash_path()
        if (ROOT / ".env.deploy").exists():
            # fleet-preflight.sh sourcet .env.deploy und wuerde echtes Portal/Netz
            # ansprechen - dann ist dieser Offline-Test nicht aussagekraeftig.
            raise unittest.SkipTest(".env.deploy vorhanden: Offline-Test uebersprungen")
        self.local_commit = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True, cwd=ROOT, timeout=30,
        ).stdout.strip()
        self.assertTrue(self.local_commit, "git rev-parse --short HEAD lieferte nichts")
        self.assertTrue(self.LIB.exists(), f"Bibliothek fehlt: {self.LIB}")

    # --- Nutzlast ----------------------------------------------------------
    def _run_gate(self, base_url: str, expected: str, label: str = "app-1", allow_stale: str = "0") -> subprocess.CompletedProcess:
        script = 'source scripts/hetzner/lib/build-parity.sh\nparity_gate "$1" "$2" "${3:-app-1}" "${4:-0}"'
        return subprocess.run(
            [self.bash, "-c", script, "bash", base_url, expected, label, allow_stale],
            capture_output=True, text=True, cwd=ROOT, timeout=120, env=clean_env(),
        )

    @staticmethod
    def _combined(result: subprocess.CompletedProcess) -> str:
        return result.stdout + result.stderr

    # --- Regeln -----------------------------------------------------------
    def test_gleicher_commit_ist_paritaet(self) -> None:
        with _HealthStub({"status": "ok", "version": "1.210.001", "commit": self.local_commit}) as stub:
            result = self._run_gate(stub.base_url, self.local_commit)
            combined = self._combined(result)
            hits = list(stub.hits)
        self.assertEqual(result.returncode, 0, combined)
        self.assertIn("Commit-Paritaet ok", combined)
        self.assertIn("version=1.210.001", combined)
        self.assertEqual(hits, ["/api/health"])

    def test_kurzer_sha_trifft_langen_sha(self) -> None:
        long_commit = self.local_commit + "1234567890abcdef1234567890abcdef12"
        with _HealthStub({"status": "ok", "commit": long_commit}) as stub:
            kurz_gegen_lang = self._run_gate(stub.base_url, self.local_commit)
            lang_gegen_kurz = self._run_gate(stub.base_url, long_commit)
        self.assertEqual(kurz_gegen_lang.returncode, 0, self._combined(kurz_gegen_lang))
        self.assertEqual(lang_gegen_kurz.returncode, 0, self._combined(lang_gegen_kurz))

    def test_altes_label_ist_eine_belegte_abweichung_mit_klartext(self) -> None:
        # Genau der Live-Befund: der Knoten meldet einen ALTEN Commit.
        body = {"status": "ok", "version": "1.210.001", "commit": "deadbee", "buildTime": "2026-09-18T17:09:00Z"}
        with _HealthStub(body) as stub:
            result = self._run_gate(stub.base_url, self.local_commit)
            combined = self._combined(result)
        self.assertEqual(result.returncode, 1, combined)
        self.assertIn(f"Flotte laeuft Stand deadbee, Repo ist {self.local_commit}", combined)
        self.assertIn("buildTime=2026-09-18T17:09:00Z", combined)

    def test_allow_stale_laesst_die_abweichung_bewusst_durch(self) -> None:
        with _HealthStub({"status": "ok", "commit": "deadbee"}) as stub:
            result = self._run_gate(stub.base_url, self.local_commit, "app-1", "1")
            combined = self._combined(result)
        self.assertEqual(result.returncode, 0, combined)
        # Die Meldung bleibt SICHTBAR - nur blockiert sie nicht mehr.
        self.assertIn("Flotte laeuft Stand deadbee", combined)
        self.assertIn("BEWUSST akzeptiert", combined)

    def test_fehlendes_commit_feld_blockiert_nicht_aber_meldet(self) -> None:
        # Vor F4 gebaute Images tragen keinen Commit: KEIN Fehlalarm.
        for body in (
            {"status": "ok", "version": "1.210.001"},
            {"status": "ok", "version": "1.210.001", "commit": "unknown"},
        ):
            with self.subTest(body=body):
                with _HealthStub(body) as stub:
                    result = self._run_gate(stub.base_url, self.local_commit)
                    combined = self._combined(result)
                self.assertEqual(result.returncode, 0, combined)
                self.assertIn("nicht pruefbar", combined)
                self.assertNotIn("Flotte laeuft Stand", combined)

    def test_nicht_erreichbarer_knoten_blockiert_nicht(self) -> None:
        # Cloudflare-only-Firewall: der direkte IP-Zugriff scheitert regelmaessig.
        result = self._run_gate("http://127.0.0.1:9", self.local_commit)
        combined = self._combined(result)
        self.assertEqual(result.returncode, 0, combined)
        self.assertIn("nicht pruefbar", combined)

    def test_ohne_erwartung_wird_keine_paritaet_behauptet(self) -> None:
        with _HealthStub({"status": "ok", "commit": "deadbee"}) as stub:
            result = self._run_gate(stub.base_url, "")
            combined = self._combined(result)
        self.assertEqual(result.returncode, 0, combined)
        self.assertIn("Kein erwarteter Commit gesetzt", combined)

    # --- Verdrahtung der Skripte ------------------------------------------
    def test_deploy_sh_uebergibt_commit_und_zeit_als_build_args(self) -> None:
        result = subprocess.run(
            [self.bash, str(DEPLOY_SH)], capture_output=True, text=True, cwd=ROOT, timeout=60,
            env=clean_env(DEPLOY_PRINT_CONFIG="1", DEPLOY_COMMIT="deadbee"),
        )
        combined = self._combined(result)
        self.assertEqual(result.returncode, 0, combined)
        self.assertIn("BUILD_VERSION=", result.stdout)
        self.assertIn("BUILD_COMMIT=deadbee", result.stdout)
        self.assertIn("BUILD_TIME=", result.stdout)
        self.assertIn("DEPLOY_ALLOW_STALE=0", result.stdout)
        text = DEPLOY_SH.read_text(encoding="utf-8")
        self.assertIn('--build-arg "BUILD_COMMIT=$APP_COMMIT"', text)
        self.assertIn('--build-arg "BUILD_TIME=$BUILD_TIME"', text)

    def test_deploy_sh_bricht_bei_abweichung_ab(self) -> None:
        text = DEPLOY_SH.read_text(encoding="utf-8")
        # Der Deploy faehrt genau die Bibliotheks-Entscheidung und endet bei
        # belegter Abweichung mit Exit 1 (kein stilles Weiterlaufen).
        self.assertIn('parity_gate "$BASE_URL" "$APP_COMMIT" app-1 "$DEPLOY_ALLOW_STALE"', text)
        self.assertIn("Deployment-ABWEICHUNG", text)
        self.assertIn("DEPLOY_ALLOW_STALE=1", text)

    def test_preflight_check_meldet_abweichung_und_endet_mit_exit_1(self) -> None:
        with _HealthStub({"status": "ok", "commit": "deadbee"}) as stub:
            result = subprocess.run(
                [self.bash, str(FLEET_PREFLIGHT), "check"],
                capture_output=True, text=True, cwd=ROOT, timeout=120,
                env=clean_env(PORTAL_URL=stub.base_url),
            )
        combined = self._combined(result)
        self.assertEqual(result.returncode, 1, combined)
        self.assertIn(f"Flotte laeuft Stand deadbee, Repo ist {self.local_commit}", combined)
        self.assertIn("--allow-stale", combined)
        # Der laufende Knoten wurde wirklich gelesen (kein Textbeweis).
        self.assertIn("/api/health", stub.hits)

    def test_preflight_check_mit_allow_stale_meldet_aber_bricht_nicht_ab(self) -> None:
        with _HealthStub({"status": "ok", "commit": "deadbee"}) as stub:
            result = subprocess.run(
                [self.bash, str(FLEET_PREFLIGHT), "check", "--allow-stale"],
                capture_output=True, text=True, cwd=ROOT, timeout=120,
                env=clean_env(PORTAL_URL=stub.base_url),
            )
        combined = self._combined(result)
        self.assertEqual(result.returncode, 0, combined)
        self.assertIn("Flotte laeuft Stand deadbee", combined)
        self.assertIn("bewusst erlaubt", combined)

    def test_preflight_check_ist_gruen_wenn_der_knoten_den_repo_stand_meldet(self) -> None:
        with _HealthStub({"status": "ok", "commit": self.local_commit}) as stub:
            result = subprocess.run(
                [self.bash, str(FLEET_PREFLIGHT), "check"],
                capture_output=True, text=True, cwd=ROOT, timeout=120,
                env=clean_env(PORTAL_URL=stub.base_url),
            )
        combined = self._combined(result)
        self.assertEqual(result.returncode, 0, combined)
        self.assertIn("Commit-Paritaet ok", combined)

    def test_preflight_unbekannte_option_wird_abgewiesen(self) -> None:
        result = subprocess.run(
            [self.bash, str(FLEET_PREFLIGHT), "check", "--allow-stale=1"],
            capture_output=True, text=True, cwd=ROOT, timeout=60, env=clean_env(PORTAL_URL="http://127.0.0.1:9"),
        )
        combined = self._combined(result)
        self.assertEqual(result.returncode, 1, combined)
        self.assertIn("Unbekannte Option", combined)

    def test_jeder_bibliotheksaufruf_der_skripte_existiert_wirklich(self) -> None:
        # Genau der Bruch aus dem abgebrochenen F4-Lauf: deploy.sh rief
        # `verify_build_parity_url`, die Bibliothek kennt nur
        # `verify_build_parity` -> "command not found" erst im Live-Deploy.
        called: set[str] = set()
        for path in (DEPLOY_SH, FLEET_PREFLIGHT):
            called.update(_PARITY_CALL_RE.findall(path.read_text(encoding="utf-8")))
        # Beide Skripte fahren die Bibliothek (parity_gate entscheidet, health_commit
        # liest den laufenden Knoten) - kein Skript baut seinen eigenen Vergleich.
        self.assertIn("parity_gate", called)
        self.assertIn("health_commit", called)

        script = "source scripts/hetzner/lib/build-parity.sh\n" + "\n".join(
            f'declare -F {name} >/dev/null || {{ echo "FEHLT: {name}" >&2; exit 3; }}' for name in sorted(called)
        )
        result = subprocess.run([self.bash, "-c", script], capture_output=True, text=True, cwd=ROOT, timeout=60, env=clean_env())
        self.assertEqual(result.returncode, 0, self._combined(result))

    def test_regex_waechter_erkennt_den_alten_tippfehler(self) -> None:
        # Selbsttest des Waechters oben: der Name aus dem abgebrochenen Lauf
        # MUSS als Aufruf erkannt werden - sonst waere der Waechter wertlos.
        self.assertEqual(_PARITY_CALL_RE.findall('verify_build_parity_url "$1" app-1'), ["verify_build_parity_url"])

    def test_bibliothek_ist_sauber_und_deklariert_die_api(self) -> None:
        result = subprocess.run([self.bash, "-n", str(self.LIB)], capture_output=True, text=True, cwd=ROOT, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        text = self.LIB.read_text(encoding="utf-8")
        for name in PARITY_LIB_CALLS:
            self.assertIn(f"{name}() {{", text)


class RtcVerdrahtungTest(unittest.TestCase):
    """F6: SFU-Rolle und TURN/coturn sind im Standardpfad verdrahtet.

    Der Befund: `/api/webrtc-config` lieferte nur STUN, `SFU_ANNOUNCED_IP` war auf
    sfu-1 leer (bzw. im Portal-Pfad die PRIVATE 10.x-Adresse aus `hostname -I`),
    und coturn wurde von keinem Flottenskript installiert. Geprueft wird deshalb
    die ganze Kette - ohne Netz, ohne Server, ohne Secret:

      * Rollen-Verdrahtung: `wire-rtc.sh` schreibt ENABLE_SFU/SFU_ANNOUNCED_IP/
        TURN_* idempotent in die Knoten-.env (auch wenn dort eine LEERE Zeile
        steht - genau daran war die IP-Ankuendigung leer) und erzeugt die
        coturn-Konfiguration aus der eingecheckten Vorlage.
      * IP-Ermittlung: nur OEFFENTLICHE IPv4 werden akzeptiert; die Quellen sind
        Umgebung -> Hetzner-Metadata -> Cloud-Init-Datei -> Aussenprobe.
      * coturn als Service: Overlay startet, Ports sind in Firewall (beide
        Provisioning-Pfade), Vorlage und Doku identisch freigegeben.
      * Portal-Worker/Cloud-Init ziehen mit.
    """

    def setUp(self) -> None:
        self.bash = bash_path()
        self.lib = HETZNER / "lib" / "rtc-fleet.sh"
        self.wire = HETZNER / "wire-rtc.sh"
        self.turn_compose = ROOT / "docker-compose.turn.yml"
        self.sfu_compose = ROOT / "docker-compose.sfu.yml"
        self.turn_conf = ROOT / "services" / "turn" / "turnserver.conf"
        self.cloud_init = HETZNER / "cloud-init.yaml"

    def _run(self, args, env=None, cwd=ROOT):
        return subprocess.run(
            [self.bash, *args], capture_output=True, text=True, cwd=cwd, timeout=60,
            env=env if env is not None else clean_env(),
        )

    def _lib_run(self, script: str, env=None):
        """Fuehrt ein Shell-Schnipsel mit geladener Bibliothek aus (kein Netz)."""
        return self._run(["-c", f'source "{self.lib}"\n{script}'], env=env)

    @staticmethod
    def _without_comments(text: str) -> str:
        """Quelltext ohne Kommentarzeilen (Regressionspruefungen auf Kommandos).

        Die Begruendungen der Skripte NENNEN die alten Fehlerwege
        (`SFU_ANNOUNCED_IP=$(hostname -I ...)`); gesucht werden darf nur die
        ausfuehrbare Form.
        """
        keep = []
        for line in text.splitlines():
            stripped = line.strip()
            if stripped.startswith(("#", "//", "*", "/*")):
                continue
            keep.append(line)
        return "\n".join(keep)

    # --- Syntax ---------------------------------------------------------------
    def test_bash_syntax_der_neuen_skripte_ist_sauber(self) -> None:
        for path in (self.lib, self.wire, BRING_UP, HETZNER / "provision-fleet.sh", ROOT / "services" / "turn" / "deploy-turn.sh"):
            with self.subTest(script=path.name):
                result = self._run(["-n", str(path)])
                self.assertEqual(result.returncode, 0, result.stderr)

    # --- .env-Schreiben -------------------------------------------------------
    def test_env_upsert_ersetzt_auch_eine_leere_zeile(self) -> None:
        # Das war der F6-Fehler: `grep -q KEY .env || echo KEY=... >> .env` laesst
        # eine vorhandene LEERE Zeile stehen -> SFU_ANNOUNCED_IP blieb leer.
        with tempfile.TemporaryDirectory() as tmp:
            env_file = pathlib.Path(tmp) / ".env"
            env_file.write_text("DOMAIN=\nSFU_ANNOUNCED_IP=\nENABLE_SFU=\n", encoding="utf-8")
            result = self._lib_run(
                f'rtc_env_upsert "{env_file}" SFU_ANNOUNCED_IP 49.13.65.150\n'
                f'rtc_env_upsert "{env_file}" ENABLE_SFU 1\n'
                f'rtc_env_upsert "{env_file}" TURN_URLS "turn:49.13.65.150:3478?transport=udp,turn:49.13.65.150:3478?transport=tcp"\n'
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            lines = env_file.read_text(encoding="utf-8").splitlines()
            self.assertIn("SFU_ANNOUNCED_IP=49.13.65.150", lines)
            self.assertIn("ENABLE_SFU=1", lines)
            self.assertEqual(len([l for l in lines if l.startswith("SFU_ANNOUNCED_IP=")]), 1)
            self.assertNotIn("SFU_ANNOUNCED_IP=", lines)
            self.assertIn("DOMAIN=", lines)

    def test_env_upsert_ist_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            env_file = pathlib.Path(tmp) / ".env"
            env_file.write_text("A=1\n", encoding="utf-8")
            script = f'rtc_env_upsert "{env_file}" TURN_TTL_SECONDS 3600'
            self._lib_run(f"{script}\n{script}\n{script}")
            text = env_file.read_text(encoding="utf-8")
            self.assertEqual(text.count("TURN_TTL_SECONDS="), 1)
            self.assertIn("A=1", text)

    # --- IP-Regeln ------------------------------------------------------------
    def test_nur_oeffentliche_ipv4_werden_akzeptiert(self) -> None:
        # `true` am Ende: der letzte Aufruf ist absichtlich "nein" (Exit 1) und
        # darf den Testlauf nicht als Fehlschlag erscheinen lassen.
        result = self._lib_run(
            "rtc_is_public_ipv4 49.13.65.150; rtc_is_public_ipv4 10.0.0.5; "
            "rtc_is_public_ipv4 127.0.0.1; rtc_is_public_ipv4 169.254.169.254; "
            "rtc_is_public_ipv4 192.168.1.10; rtc_is_public_ipv4 172.16.0.9; rtc_is_public_ipv4 kaputt; true"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        # "kaputt" ist keine IPv4 -> die Funktion gibt GAR NICHTS aus (kein "ja"),
        # deshalb stehen hier sechs Antworten fuer sieben Aufrufe.
        self.assertEqual(result.stdout.split(), ["ja", "nein", "nein", "nein", "nein", "nein"])
        self.assertEqual(result.stdout.split().count("ja"), 1)

    def test_ip_kette_umgebung_metadata_cloudinit_aussenprobe(self) -> None:
        text = self.lib.read_text(encoding="utf-8")
        for marker in ("SFU_ANNOUNCED_IP", "SFU_PUBLIC_IP", "169.254.169.254", "NODE_IP_CONF", "api.ipify.org"):
            self.assertIn(marker, text)
        # Die Cloud-Init-Datei ist ausdruecklich Teil der Kette (Fallback).
        cloud = self.cloud_init.read_text(encoding="utf-8")
        self.assertIn("/etc/audiomonastry-node.conf", cloud)
        self.assertIn("public-ipv4", cloud)
        self.assertIn("/usr/local/bin/audiomonastry-node-public-ip.sh", cloud)

    # --- Trockenlauf ----------------------------------------------------------
    def test_print_config_zeigt_alle_rtc_variablen_ohne_secret(self) -> None:
        result = self._run([str(self.wire), "sfu", "--print-config"])
        self.assertEqual(result.returncode, 0, result.stderr)
        output = result.stdout
        for expected in ("ENABLE_SFU=1", "SFU_ANNOUNCED_IP", "SFU_LISTEN_IP", "TURN_URLS=", "TURN_TTL_SECONDS", "TURN_REALM"):
            with self.subTest(expected=expected):
                self.assertIn(expected, output)
        # Trockenlauf heisst: kein Netzzugriff, kein Schreiben, kein Secret.
        self.assertIn("Trockenlauf", output)
        self.assertNotIn(os.environ.get("TURN_STATIC_AUTH_SECRET", "\x00"), output)

    def test_print_config_der_app_rolle_nennt_sfu_url_und_turn(self) -> None:
        result = self._run([str(self.wire), "app", "--print-config"], env=clean_env(SFU_PUBLIC_IP="49.13.65.150"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("ENABLE_SFU=0", result.stdout)
        self.assertIn("SFU_SIGNALING_URL=http://49.13.65.150", result.stdout)
        self.assertIn("turn:49.13.65.150:3478?transport=udp", result.stdout)

    def test_flottenstart_trockenlauf_nennt_sfu_und_turn_schritte(self) -> None:
        result = self._run([str(BRING_UP), "--print-config"])
        self.assertEqual(result.returncode, 0, result.stderr)
        output = result.stdout
        self.assertIn("wire-rtc.sh sfu", output)
        self.assertIn("wire-rtc.sh app", output)
        self.assertIn("docker-compose.turn.yml", output)
        self.assertIn("coturn", output)
        # Die Portzahlen kommen aus der Bibliothek, nicht aus einer Annahme.
        self.assertIn("3478", output)
        self.assertIn("49152-49201", output)

    def test_wire_rtc_ohne_secret_bricht_laut_ab(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            env_file = pathlib.Path(tmp) / ".env"
            result = self._run(
                [str(self.wire), "sfu"],
                env=clean_env(SFU_ANNOUNCED_IP="49.13.65.150", ENV_FILE=str(env_file)),
            )
            self.assertEqual(result.returncode, 1, result.stdout)
            self.assertIn("TURN_STATIC_AUTH_SECRET fehlt", result.stderr)
            self.assertFalse(env_file.exists() and env_file.read_text())

    def test_wire_rtc_weist_private_ankuendigungs_ip_ab(self) -> None:
        # Genau der Portal-Fehler aus F6: die 10.x-Adresse aus `hostname -I`.
        with tempfile.TemporaryDirectory() as tmp:
            env_file = pathlib.Path(tmp) / ".env"
            result = self._run(
                [str(self.wire), "sfu"],
                env=clean_env(
                    TURN_STATIC_AUTH_SECRET="s3cret", SFU_ANNOUNCED_IP="10.0.0.5",
                    ENV_FILE=str(env_file), TURN_CONF_OUT=str(pathlib.Path(tmp) / "turnserver.conf"),
                ),
            )
            self.assertEqual(result.returncode, 1, result.stdout)
            self.assertIn("keine oeffentliche IPv4", result.stderr)

    def test_wire_rtc_schreibt_env_und_coturn_konfiguration(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            env_file = pathlib.Path(tmp) / ".env"
            conf_out = pathlib.Path(tmp) / "coturn" / "turnserver.conf"
            env_file.write_text("DOMAIN=\nSFU_ANNOUNCED_IP=\n", encoding="utf-8")
            env = clean_env(
                TURN_STATIC_AUTH_SECRET="s3cret-f6", SFU_ANNOUNCED_IP="49.13.65.150",
                ENV_FILE=str(env_file), TURN_CONF_OUT=str(conf_out),
            )
            result = self._run([str(self.wire), "sfu"], env=env)
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            text = env_file.read_text(encoding="utf-8")
            self.assertIn("ENABLE_SFU=1", text)
            self.assertIn("SFU_ANNOUNCED_IP=49.13.65.150", text)
            self.assertIn("SFU_SIGNALING_URL=http://49.13.65.150", text)
            self.assertIn("TURN_STATIC_AUTH_SECRET=s3cret-f6", text)
            self.assertIn("turn:49.13.65.150:3478?transport=udp", text)
            # Zweiter Lauf: nichts doppelt (idempotent).
            again = self._run([str(self.wire), "sfu"], env=env)
            self.assertEqual(again.returncode, 0, again.stderr)
            second = env_file.read_text(encoding="utf-8")
            self.assertEqual(second.count("SFU_ANNOUNCED_IP="), 1)
            self.assertEqual(second.count("TURN_URLS="), 1)

            conf = conf_out.read_text(encoding="utf-8")
            self.assertIn("static-auth-secret=s3cret-f6", conf)
            self.assertIn("relay-ip=49.13.65.150", conf)
            self.assertIn("min-port=49152", conf)
            self.assertIn("max-port=49201", conf)
            # Container-Besonderheiten (live verifiziert, siehe Overlay-Kommentare).
            self.assertIn("log-file=stdout", conf)
            self.assertIn("pidfile=/tmp/turnserver.pid", conf)
            self.assertNotIn("\nno-loopback-peers\n", conf)
            # Rechte: Gruppe darf lesen (Container laeuft als nobody:nogroup).
            mode = oct(conf_out.stat().st_mode)[-3:]
            self.assertEqual(mode, "640")

    # --- coturn als Service --------------------------------------------------
    def test_turn_overlay_startet_den_relay_als_service(self) -> None:
        if yaml is None:  # pragma: no cover
            self.skipTest("PyYAML nicht installiert")
        overlay = yaml.safe_load(self.turn_compose.read_text(encoding="utf-8")) or {}
        services = overlay.get("services") or {}
        self.assertIn("coturn", services)
        coturn = services["coturn"] or {}
        self.assertTrue(str(coturn.get("image", "")).startswith("coturn/coturn:"), coturn.get("image"))
        # Host-Netz: die Relay-Ports liegen direkt auf der oeffentlichen IP.
        self.assertEqual(coturn.get("network_mode"), "host")
        self.assertEqual(coturn.get("user"), "65534:65534")
        command = coturn.get("command") or []
        self.assertIn("-c", command)
        self.assertIn("/etc/coturn/turnserver.conf", command)
        self.assertTrue(any(str(c).startswith("--log-file=") for c in command))
        volumes = coturn.get("volumes") or []
        self.assertTrue(any("runtime/coturn/turnserver.conf" in str(v) for v in volumes), volumes)
        # Healthcheck beweist den antwortenden Dienst (nicht "Container laeuft").
        self.assertIn("turnutils_stunclient", " ".join(coturn.get("healthcheck", {}).get("test", [])))
        # Regression: `cap_drop: [ALL]` hat den Start live verhindert
        # ("/usr/bin/turnserver: Operation not permitted") - deshalb steht dort
        # eine Begruendung statt der Haertung.
        self.assertNotIn("cap_drop", coturn)
        self.assertIn("cap_drop", self.turn_compose.read_text(encoding="utf-8"))

    def test_portfreigaben_stimmen_in_allen_pfaden_ueberein(self) -> None:
        # Vorlage (coturn) -> Firewall (CLI-Pfad + Portal-Worker) -> Bibliothek.
        conf = self.turn_conf.read_text(encoding="utf-8")
        found: dict[str, str] = {}
        for key, pattern in (("min", r"^min-port=(\d+)"), ("max", r"^max-port=(\d+)"), ("listen", r"^listening-port=(\d+)")):
            match = re.search(pattern, conf, re.MULTILINE)
            self.assertIsNotNone(match, f"{key} fehlt in turnserver.conf")
            found[key] = match.group(1) if match else ""
        relay_range = f"{found['min']}-{found['max']}"
        listen_port = found["listen"]

        provision = (HETZNER / "provision.py").read_text(encoding="utf-8")
        worker = PORTAL_WORKER.read_text(encoding="utf-8")
        lib = self.lib.read_text(encoding="utf-8")
        docs = (ROOT / "docs" / "HETZNER_DEPLOY.md").read_text(encoding="utf-8")
        for name, text in (("provision.py", provision), ("portal-worker", worker), ("HETZNER_DEPLOY.md", docs)):
            with self.subTest(source=name):
                self.assertIn(relay_range, text)
                self.assertIn(listen_port, text)
        # Die Bibliothek haelt die Grenzen einzeln (RTC_TURN_MIN/MAX_PORT) - daraus
        # setzt sie den Bereich zusammen, statt ihn zu wiederholen.
        with self.subTest(source="rtc-fleet.sh"):
            self.assertIn(f'RTC_TURN_MIN_PORT="${{RTC_TURN_MIN_PORT:-{found["min"]}}}"', lib)
            self.assertIn(f'RTC_TURN_MAX_PORT="${{RTC_TURN_MAX_PORT:-{found["max"]}}}"', lib)
            self.assertIn(f'RTC_TURN_PORT="${{RTC_TURN_PORT:-{listen_port}}}"', lib)

        # Die Bibliothek definiert die Ports genau einmal (RTC_TURN_*).
        self.assertIn('RTC_TURN_PORT="${RTC_TURN_PORT:-3478}"', lib)
        self.assertIn('RTC_TURN_MIN_PORT="${RTC_TURN_MIN_PORT:-49152}"', lib)
        self.assertIn('RTC_TURN_MAX_PORT="${RTC_TURN_MAX_PORT:-49201}"', lib)

    def test_sfu_overlay_setzt_enable_sfu_und_announced_ip_aus_der_umgebung(self) -> None:
        if yaml is None:  # pragma: no cover
            self.skipTest("PyYAML nicht installiert")
        overlay = yaml.safe_load(self.sfu_compose.read_text(encoding="utf-8")) or {}
        env = ((overlay.get("services") or {}).get("audiomonastry") or {}).get("environment") or {}
        self.assertEqual(str(env.get("ENABLE_SFU")), "1")
        self.assertIn("SFU_ANNOUNCED_IP", env)
        # Leer ist erlaubt: der Server ermittelt die IP dann selbst
        # (server/sfuNetwork.ts) - aber der Platzhalter darf nicht hartkodiert sein.
        self.assertNotRegex(str(env.get("SFU_ANNOUNCED_IP")), r"\d+\.\d+\.\d+\.\d+")

    def test_compose_dateien_sind_gueltig_wenn_docker_verfuegbar_ist(self) -> None:
        docker = shutil.which("docker")
        if docker is None:  # pragma: no cover - CI ohne Docker-CLI
            self.skipTest("docker nicht vorhanden")
        probe = subprocess.run([docker, "compose", "version"], capture_output=True, text=True, timeout=60)
        if probe.returncode != 0:  # pragma: no cover
            self.skipTest("docker compose nicht verfuegbar")
        env_file = ROOT / ".env"
        created = False
        if not env_file.exists():  # env_file: .env ist gitignored - wie im CI-Job `compose`
            env_file.write_text("", encoding="utf-8")
            created = True
        try:
            combos = [
                ["-f", "docker-compose.turn.yml"],
                ["-f", "docker-compose.hetzner.yml", "-f", "docker-compose.sfu.yml"],
                ["-f", "docker-compose.hetzner.yml", "-f", "docker-compose.sfu.yml", "-f", "docker-compose.turn.yml"],
            ]
            for files in combos:
                with self.subTest(files=" ".join(files)):
                    result = subprocess.run(
                        [docker, "compose", *files, "config", "--quiet"],
                        capture_output=True, text=True, cwd=ROOT, timeout=120,
                        env=clean_env(SFU_ANNOUNCED_IP="127.0.0.1"),
                    )
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        finally:
            if created:
                env_file.unlink(missing_ok=True)

    # --- Portal-Worker + Cloud-Init -----------------------------------------
    def test_portal_worker_verdraehtet_die_sfu_rolle_ueber_wire_rtc(self) -> None:
        worker = PORTAL_WORKER.read_text(encoding="utf-8")
        self.assertIn("wire-rtc.sh sfu", worker)
        self.assertIn("docker-compose.turn.yml", worker)
        # Der alte Weg (private IP aus `hostname -I`) darf nicht zurueckkommen -
        # geprueft wird die ausfuehrbare Form, nicht die Nennung im Kommentar.
        self.assertNotIn("SFU_ANNOUNCED_IP=$(hostname -I", self._without_comments(worker))
        self.assertNotIn("hostname -I", self._without_comments(worker))
        # RTC-Schluessel sind Rollen-Konfiguration (App: Adresse + TURN, SFU: Secret).
        for key in ("SFU_SIGNALING_URL", "TURN_URLS", "TURN_STATIC_AUTH_SECRET"):
            with self.subTest(key=key):
                self.assertIn(key, worker)

    def test_portal_worker_meldet_fehlende_rtc_verdrahtung(self) -> None:
        worker = PORTAL_WORKER.read_text(encoding="utf-8")
        self.assertIn("export function rtcEnvWiring", worker)
        # Der Report haengt an /api/wiring - sonst sieht ihn niemand.
        self.assertIn("rtcEnvWiring(env)", worker)
        self.assertIn("rtc,", worker)

    def test_cloud_init_legt_die_oeffentliche_ip_ab(self) -> None:
        cloud = self.cloud_init.read_text(encoding="utf-8")
        self.assertIn("NODE_PUBLIC_IP=", cloud)
        self.assertIn("audiomonastry-node-public-ip.sh || true", cloud)
        # Keine private Adresse als Ankuendigungsadresse (ausfuehrbare Form,
        # nicht der erklaerende Kommentar).
        self.assertNotIn("hostname -I", self._without_comments(cloud))

# ---------------------------------------------------------------------------
# F10: Namespace-/Projektparitaet (Repo <-> Flotte)
# ---------------------------------------------------------------------------

#: Knoten, dessen Stack noch unter dem Altnamen laeuft - Fixture fuer den
#: Watchdog-Test. Der Altname steht hier BEWUSST als Literal (unabhaengig von
#: `fleet-names.sh`, sonst waere die Probe zirkulaer: eine Namensquelle, die sich
#: selbst bestaetigt, wuerde nie auffallen). Begruendung in der ALLOWED-Map von
#: tests/namingConventions.test.ts.
LEGACY_FIXTURE_PROJECT = "samplemonk"
LEGACY_FIXTURE_APP = "samplemonk"
LEGACY_FIXTURE_CADDY = "samplemonk-caddy"

#: Dateien, in denen der Altname stehen DARF (Bestands-Kompatibilitaet). Alles
#: andere unter scripts/ + services/ ist ein Befund: der Name darf nicht
#: wandern, sonst entsteht genau der Drift, den F10 beschreibt.
LEGACY_ALLOWED_FILES = {
    "scripts/hetzner/fleet-names.sh",                       # die EINE Namensquelle
    "services/portal-worker/src/index.js",                  # LEGACY_NAME_PREFIX (Bestand lesen)
    "services/audiomonastry-ai-runtime/Dockerfile.manifest",  # Alt-Basis-Image-Pfad (Build-Arg)
}

#: Wie ein Bestands-Knoten antwortet (kein Docker, kein Netz): der Stack laeuft
#: unter dem Altnamen, die App ist krank -> der Watchdog MUSS sie reparieren.
FAKE_DOCKER = r"""#!/usr/bin/env bash
# Fake `docker` fuer den F10-Watchdog-Test. Protokolliert jeden Aufruf mit dem
# effektiven COMPOSE_PROJECT_NAME (so laesst sich belegen, dass die Reparatur im
# KANONISCHEN Projekt laeuft) und antwortet wie ein Knoten mit Alt-Namen.
set -uo pipefail
{ for a in "$@"; do printf '%s ' "$a"; done
  printf '| COMPOSE_PROJECT_NAME=%s\n' "${COMPOSE_PROJECT_NAME:-<leer>}"; } >> "${FAKE_DOCKER_LOG:?}"
case "${1:-}" in
  ps)
    # `docker ps --filter health=unhealthy` -> nichts (keine ungesunden Container).
    if [[ " $* " == *" --filter "* ]]; then exit 0; fi
    printf '%s\n' ${FAKE_DOCKER_CONTAINERS}
    ;;
  inspect) echo "none" ;;   # kein Healthcheck -> der Watchdog probt selbst
  exec) exit 1 ;;            # App-Probe im Container scheitert
  compose)
    { for a in "$@"; do printf '%s ' "$a"; done
      printf '| COMPOSE_PROJECT_NAME=%s\n' "${COMPOSE_PROJECT_NAME:-<leer>}"; } >> "${FAKE_DOCKER_COMPOSE_LOG:?}"
    ;;
esac
exit 0
"""


FAKE_SSH = r"""#!/usr/bin/env bash
# Fake `ssh` fuer den F10-Migrationstest: protokolliert JEDEN entfernten Befehl
# und antwortet wie ein Bestands-Knoten. Damit laesst sich ohne Netz belegen,
# dass die Migration erst aufloest und dann stoppt - und im Fehlerfall GAR NICHT
# stoppt (live passiert am 2026-09-20: sfu-1 lag nach "no such service:
# audiomonastry" unten).
set -uo pipefail
cmd="${*: -1}"
printf '%s\n' "$cmd" >> "${FAKE_SSH_LOG:?}"
case "$cmd" in
  *"config --services"*)
    printf '%s\n' "${FAKE_SSH_SERVICES:-}"
    ;;
  *"volume ls"*)
    printf '%s\n' "${FAKE_SSH_VOLUMES:-}"
    ;;
  *"inspect -f"*)
    printf '%s\n' "${FAKE_SSH_INSPECT:-}"
    ;;
  *"docker ps --format"*)
    printf '%s\n' "${FAKE_SSH_PROJECTS:-samplemonk}"
    ;;
  *"=installation"*)
    printf '%s\n' "${FAKE_SSH_DIRS:-/opt/samplemonk=installation}"
    ;;
  *)
    printf '%s\n' "${FAKE_SSH_DEFAULT:-}"
    ;;
esac
exit 0
"""


class NamespaceParitaetTest(unittest.TestCase):
    """F10: EINE Namensquelle, beide Schreibweisen, Projektname explizit."""

    def setUp(self) -> None:
        self.bash = bash_path()
        if not FLEET_NAMES.exists():  # pragma: no cover - Datei ist eingecheckt
            self.fail(f"Namensquelle fehlt: {FLEET_NAMES}")

    # --- Helpers -----------------------------------------------------------
    def _bash(self, script: str, **env: str | None) -> subprocess.CompletedProcess:
        return subprocess.run(
            [self.bash, "-c", script], capture_output=True, text=True,
            cwd=ROOT, timeout=120, env=clean_env(**env),
        )

    def _names(self, **env: str | None) -> dict[str, str]:
        """Alle Namen AUSSCHLIESSLICH ueber scripts/hetzner/fleet-names.sh fragen."""
        script = "\n".join([
            "source scripts/hetzner/fleet-names.sh",
            'echo "prefix=$FLEET_PREFIX"',
            'echo "legacy_prefix=$LEGACY_FLEET_PREFIX"',
            'echo "project=$(fleet_compose_project)"',
            'echo "legacy_project=$(fleet_legacy_compose_project)"',
            'echo "home=$FLEET_HOME"',
            'echo "legacy_home=$(fleet_legacy_home)"',
            'echo "bare=$(fleet_name_variants audiomonastry | tr \'\\n\' \' \')"',
            'echo "caddy=$(fleet_name_variants audiomonastry-caddy | tr \'\\n\' \' \')"',
            'echo "app_node=$(fleet_candidates audiomonastry-app-1 | tr \'\\n\' \' \')"',
            'echo "fremd=$(fleet_name_variants web-1 | tr \'\\n\' \' \')"',
        ])
        result = self._bash(script, **env)
        self.assertEqual(result.returncode, 0, result.stderr)
        found: dict[str, str] = {}
        for line in result.stdout.splitlines():
            key, _, value = line.partition("=")
            # `tr '\n' ' '` laesst ein Leerzeichen am Ende stehen - das ist
            # Formatierung der Probe, nicht Teil des Namens.
            found[key] = value.strip()
        return found

    @staticmethod
    def _combined(result: subprocess.CompletedProcess) -> str:
        return result.stdout + result.stderr

    # --- 1. Namensaufloesung ----------------------------------------------
    def test_beide_schreibweisen_werden_auf_denselben_namen_abgebildet(self) -> None:
        names = self._names()
        self.assertEqual(names["bare"], f"{names['project']} {names['legacy_project']}")
        self.assertEqual(names["caddy"], f"{names['project']}-caddy {names['legacy_project']}-caddy")
        self.assertEqual(names["app_node"], "audiomonastry-app-1 samplemonk-app-1")
        # Reihenfolge ist Teil des Vertrags: der kanonische Name kommt ZUERST
        # (neu anlegen/ansprechen), der Altname nur als Rueckfall.
        self.assertTrue(names["bare"].startswith(names["project"] + " "))
        self.assertTrue(names["caddy"].startswith(names["project"] + "-"))
        # Ein fremder Name wird nicht umgeschrieben (nichts wird geraten).
        self.assertEqual(names["fremd"], "web-1")
        # Projekt + Pfade stammen aus derselben Quelle.
        self.assertEqual(names["legacy_project"], LEGACY_FIXTURE_PROJECT)
        self.assertEqual(names["home"], "/opt/audiomonastry")
        self.assertEqual(names["legacy_home"], "/opt/samplemonk")

    def test_die_quelle_ist_konfigurierbar_und_bleibt_eine_quelle(self) -> None:
        # Der Override wirkt auf die Funktionen, die die Skripte aufrufen -
        # kein Skript baut sich seinen eigenen Namen.
        names = self._names(FLEET_COMPOSE_PROJECT="probe-projekt")
        self.assertEqual(names["project"], "probe-projekt")
        self.assertEqual(names["bare"].split()[1], names["legacy_project"])

    def test_bash_syntax_der_namensquelle(self) -> None:
        result = subprocess.run([self.bash, "-n", str(FLEET_NAMES)], capture_output=True, text=True, cwd=ROOT, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)

    # --- 2. Compose-Datei vs. Namensquelle --------------------------------
    def test_compose_datei_nennt_denselben_projektnamen_wie_die_namensquelle(self) -> None:
        names = self._names()
        if yaml is None:  # pragma: no cover
            self.skipTest("PyYAML nicht installiert")
        document = yaml.safe_load(COMPOSE_BASE.read_text(encoding="utf-8")) or {}
        self.assertEqual(
            document.get("name"), names["project"],
            "docker-compose.hetzner.yml: top-level `name:` weicht von fleet-names.sh ab "
            "(zwei Wahrheiten laufen auseinander)",
        )
        # Der Compose-Projektname ist pfad-unabhaengig: genau das war der F10-Fehler
        # (Projektname = Verzeichnisname auf dem Knoten). Ein Handaufruf ausserhalb
        # von /opt/audiomonastry muss denselben Namen ergeben.
        self.assertNotRegex(COMPOSE_BASE.read_text(encoding="utf-8"), r"sample[-_]?monk")

    def test_compose_config_loest_das_projekt_unabhaengig_vom_verzeichnis_auf(self) -> None:
        # Beleg ohne Flotte: `docker compose config` in einem Verzeichnis, das
        # WEDER kanonisch noch alt heisst, muss den Projektnamen aus der Datei
        # nennen. Ohne Docker/Compose lokal wird der Test uebersprungen (der
        # Rest dieser Klasse deckt denselben Vertrag ohne Docker ab).
        if shutil.which("docker") is None:  # pragma: no cover
            self.skipTest("docker/compose nicht vorhanden")
        probe = subprocess.run(["docker", "compose", "version"], capture_output=True, text=True, timeout=60)
        if probe.returncode != 0:  # pragma: no cover - Compose fehlt/kein Daemon
            self.skipTest("docker compose nicht aufrufbar")
        with tempfile.TemporaryDirectory(prefix="f10-probe-") as tmp:
            tmpdir = pathlib.Path(tmp)
            for name in ("docker-compose.hetzner.yml", "docker-compose.monitoring.yml", "docker-compose.sfu.yml"):
                shutil.copy(COMPOSE_BASE.parent / name, tmpdir / name)
            # `env_file: .env` fehlt im Testverzeichnis - CI legt dafuer eine
            # leere Datei an; hier genauso (nur fuer die Syntaxaufloesung).
            (tmpdir / ".env").write_text("", encoding="utf-8")
            result = subprocess.run(
                ["docker", "compose", "-f", "docker-compose.hetzner.yml", "config"],
                capture_output=True, text=True, cwd=tmpdir, timeout=120,
                env={**os.environ, "SFU_ANNOUNCED_IP": "127.0.0.1"},
            )
        combined = result.stdout + result.stderr
        self.assertEqual(result.returncode, 0, combined)
        self.assertIn(f"name: {self._names()['project']}", result.stdout)

    # --- 3. Trockenlaeufe der Skripte --------------------------------------
    def test_trockenlaeufe_zeigen_den_neuen_projektnamen(self) -> None:
        project = self._names()["project"]
        expected = f"COMPOSE_PROJECT_NAME={project}"
        for script in (PROVISION_FLEET, BRING_UP, FLEET_DEPLOY_LIVE):
            with self.subTest(script=script.name):
                result = subprocess.run(
                    [self.bash, str(script), "--print-config"],
                    capture_output=True, text=True, cwd=ROOT, timeout=60, env=clean_env(),
                )
                self.assertEqual(result.returncode, 0, self._combined(result))
                self.assertIn(expected, result.stdout, f"{script.name}: Projektname fehlt im Trockenlauf")
        # deploy.sh hat den Trockenlauf als env-Schalter (kein CLI-Flag).
        deploy = subprocess.run(
            [self.bash, str(DEPLOY_SH)], capture_output=True, text=True, cwd=ROOT, timeout=60,
            env=clean_env(DEPLOY_PRINT_CONFIG="1"),
        )
        self.assertEqual(deploy.returncode, 0, self._combined(deploy))
        self.assertIn(expected, deploy.stdout)
        # ... und der Zielpfad kommt aus derselben Quelle.
        self.assertIn("DEPLOY_REMOTE_DIR=/opt/audiomonastry", deploy.stdout)

    def test_skripte_setzen_das_projekt_beim_compose_aufruf(self) -> None:
        # Ein Trockenlauf belegt die Anzeige; hier steht, dass der Wert auch
        # WIRKLICH am Compose-Aufruf haengt (sonst waere er nur Dekoration).
        for script in (DEPLOY_SH, BRING_UP, FLEET_DEPLOY_LIVE, AUTO_REPAIR):
            with self.subTest(script=script.name):
                text = script.read_text(encoding="utf-8")
                self.assertIn("COMPOSE_PROJECT_NAME", text)
        self.assertIn("COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT docker compose", DEPLOY_SH.read_text(encoding="utf-8"))
        self.assertIn("COMPOSE_PROJECT_NAME=$FLEET_COMPOSE_PROJECT docker compose", BRING_UP.read_text(encoding="utf-8"))
        self.assertIn('COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" docker compose', AUTO_REPAIR.read_text(encoding="utf-8"))

    # --- 4. Watchdog (Health-Skript) akzeptiert beide Schreibweisen --------
    def test_watchdog_findet_und_repariert_den_container_unter_dem_altnamen(self) -> None:
        project = self._names()["project"]
        with tempfile.TemporaryDirectory(prefix="f10-watchdog-") as tmp:
            tmpdir = pathlib.Path(tmp)
            fake_bin = tmpdir / "bin"
            fake_bin.mkdir()
            fake = fake_bin / "docker"
            fake.write_text(FAKE_DOCKER, encoding="utf-8")
            fake.chmod(0o755)
            docker_log = tmpdir / "docker.log"
            compose_log = tmpdir / "compose.log"
            repair_log = tmpdir / "auto-repair.log"
            app_dir = tmpdir / "opt"
            app_dir.mkdir()
            env = clean_env(
                PATH=f"{fake_bin}:{os.environ.get('PATH', '')}",
                FAKE_DOCKER_LOG=str(docker_log),
                FAKE_DOCKER_COMPOSE_LOG=str(compose_log),
                # Der Knoten laeuft noch unter dem Altnamen - genau der F10-Zustand.
                FAKE_DOCKER_CONTAINERS=f"{LEGACY_FIXTURE_APP} {LEGACY_FIXTURE_CADDY}",
                LOG=str(repair_log),
                APP_DIR=str(app_dir),
                CHECKS="1",  # eine Probe je Container reicht im Test
            )
            result = subprocess.run(
                [self.bash, str(AUTO_REPAIR)], capture_output=True, text=True,
                cwd=ROOT, env=env, timeout=180,
            )
            self.assertEqual(result.returncode, 0, self._combined(result))
            compose_calls = compose_log.read_text(encoding="utf-8") if compose_log.exists() else ""
            repair = repair_log.read_text(encoding="utf-8") if repair_log.exists() else ""
            calls = docker_log.read_text(encoding="utf-8") if docker_log.exists() else ""

        # 1. Der Watchdog probt ueberhaupt einen Container (sonst "nicht-vorhanden").
        self.assertIn(f"app-container={LEGACY_FIXTURE_APP}", repair, repair)
        self.assertIn(f"caddy-container={LEGACY_FIXTURE_CADDY}", repair, repair)
        # 2. Die Reparatur trifft den ALT-Container ...
        self.assertIn(f"up -d --force-recreate {LEGACY_FIXTURE_APP}", compose_calls, compose_calls)
        self.assertIn(f"up -d --force-recreate {LEGACY_FIXTURE_CADDY}", compose_calls, compose_calls)
        # ... 3. aber im KANONISCHEN Projekt (nicht im Alt-Projekt).
        self.assertIn(f"COMPOSE_PROJECT_NAME={project}", compose_calls, compose_calls)
        self.assertNotIn(f"COMPOSE_PROJECT_NAME={LEGACY_FIXTURE_PROJECT}", compose_calls, compose_calls)
        # 4. Der Betreiber sieht den Altnamen als Migrationshinweis (nicht still).
        self.assertIn(LEGACY_FIXTURE_PROJECT, repair, repair)
        self.assertIn("migrate-project-name.sh", repair, repair)
        # 5. Der Watchdog hat BEIDE Schreibweisen geprobt: der kanonische Name
        #    wird zuerst abgefragt (er laeuft nicht -> kein Treffer), danach der
        #    Altname, mit dem die Reparatur dann arbeitet.
        self.assertGreaterEqual(calls.count("ps --format"), 2, calls)
        self.assertIn(f"exec {LEGACY_FIXTURE_APP}", calls, calls)

    # --- 5. Health-Skript ohne zweite Namensliste --------------------------
    def test_health_skript_leitet_die_muster_aus_der_namensquelle_ab(self) -> None:
        text = (HETZNER / "fleet-status.sh").read_text(encoding="utf-8")
        self.assertIn('"${FLEET_PREFIX}"app-*|"${LEGACY_FLEET_PREFIX}"app-*', text)
        self.assertIn("LEGACY_COMPOSE_PROJECT", text)
        self.assertNotRegex(text, r"sample[-_]?monk", "fleet-status.sh: Altname steht in der Namensquelle, nicht hier")
        result = subprocess.run([self.bash, "-n", str(HETZNER / "fleet-status.sh")], capture_output=True, text=True, cwd=ROOT, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_altname_steht_nur_in_der_namensquelle_und_der_bestands_leser(self) -> None:
        pattern = re.compile(r"sample[-_]?monk", re.IGNORECASE)
        suffixes = {".sh", ".js", ".mjs", ".ts", ".yml", ".yaml", ".json", ".bash", ".manifest"}
        hits: set[str] = set()
        for base in (ROOT / "scripts", ROOT / "services"):
            for path in base.rglob("*"):
                if not path.is_file():
                    continue
                if {".git", "node_modules", ".venv", ".venv-runpod", "target"} & set(path.parts):
                    continue
                if path.suffix not in suffixes and not path.name.startswith("Dockerfile"):
                    continue
                try:
                    text = path.read_text(encoding="utf-8")
                except (UnicodeDecodeError, OSError):  # pragma: no cover
                    continue
                if pattern.search(text):
                    hits.add(str(path.relative_to(ROOT)))
        for extra in (ROOT / "deploy.sh", COMPOSE_BASE, COMPOSE_MONITORING):
            if pattern.search(extra.read_text(encoding="utf-8")):
                hits.add(str(extra.relative_to(ROOT)))
        self.assertEqual(hits - LEGACY_ALLOWED_FILES, set(), "Altname ausserhalb der Namensquelle gefunden")

    # --- 6. Migration eines Bestands-Knotens ------------------------------
    def test_migrationsskript_ist_trockenlaufbar_und_zerstoert_nichts(self) -> None:
        self.assertTrue(MIGRATE_PROJECT.exists(), f"{MIGRATE_PROJECT} fehlt")
        result = subprocess.run(
            [self.bash, str(MIGRATE_PROJECT), "--print-config"],
            capture_output=True, text=True, cwd=ROOT, timeout=60, env=clean_env(),
        )
        combined = self._combined(result)
        self.assertEqual(result.returncode, 0, combined)
        names = self._names()
        # Der Trockenlauf nennt beide Schreibweisen, beide Pfade und den Plan.
        self.assertIn(f"Compose-Projekt neu: {names['project']}", combined)
        self.assertIn(f"Compose-Projekt alt: {names['legacy_project']}", combined)
        self.assertIn(names["home"], combined)
        self.assertIn(names["legacy_home"], combined)
        self.assertIn("KOPIE", combined)
        # Kein SSH, kein Docker im Trockenlauf: die Ausgabe zeigt die Kommandos
        # nur als TEXT - ausgefuehrt wird nichts (kein Schritt-Banner, keine
        # Knoten-Abfrage).
        self.assertNotIn("ssh ", combined)
        self.assertNotIn("--- 1/6", combined)
        self.assertNotIn("laufende Compose-Projekte", combined)

        text = MIGRATE_PROJECT.read_text(encoding="utf-8")
        # Kein Volume-Loeschen und kein `down -v`: der Rueckweg muss bestehen.
        self.assertNotIn("down -v", text)
        self.assertNotIn("prune", text)
        self.assertIn("docker compose -f docker-compose.hetzner.yml down --remove-orphans", text)
        # Volumes werden erst nach ausdruecklicher Bestaetigung geloescht -
        # und danach steht der Rollback-Hinweis.
        cleanup = text.index('CLEANUP_LEGACY" == "1"')
        self.assertLess(cleanup, text.index("docker volume rm"))
        self.assertIn("Rueckweg", text)
        # Die Datei kennt den Altnamen nicht selbst (Quelle: fleet-names.sh).
        self.assertNotRegex(text, r"sample[-_]?monk")
        syntax = subprocess.run([self.bash, "-n", str(MIGRATE_PROJECT)], capture_output=True, text=True, cwd=ROOT, timeout=60)
        self.assertEqual(syntax.returncode, 0, syntax.stderr)

    def test_migration_ohne_rolle_bricht_mit_klartext_ab(self) -> None:
        # Ohne Rolle waere unklar, welche Dienste starten - das darf nicht
        # stillschweigend "irgendetwas" hochfahren.
        result = subprocess.run(
            [self.bash, str(MIGRATE_PROJECT), "203.0.113.5"],
            capture_output=True, text=True, cwd=ROOT, timeout=60, env=clean_env(),
        )
        combined = self._combined(result)
        self.assertEqual(result.returncode, 1, combined)
        self.assertIn("--role fehlt", combined)

    def test_migration_akzeptiert_die_zwei_argumentige_rollenform(self) -> None:
        """`--role app` (zwei Argumente) muss laufen - genau so steht es in der
        Nutzung. Live gemessen am 2026-09-20: die Form endete in "Unbekannte
        Option: --role", weil `--role` in den `-*`-Zweig fiel; die zweite
        Schleife danach wurde nie erreicht. Der Test faehrt den echten Codepfad
        gegen einen Fake-`ssh` (kein Netz), damit der Plan wirklich entsteht.
        """
        with tempfile.TemporaryDirectory(prefix="f10-role-") as tmp:
            env, _log = self._fake_ssh(
                pathlib.Path(tmp),
                FAKE_SSH_SERVICES="caddy audiomonastry",
                FAKE_SSH_DIRS="/opt/samplemonk=installation",
            )
            plain = subprocess.run(
                [self.bash, str(MIGRATE_PROJECT), "203.0.113.5", "--role", "app", "--dry-run"],
                capture_output=True, text=True, cwd=ROOT, timeout=120, env=env,
            )
            equals = subprocess.run(
                [self.bash, str(MIGRATE_PROJECT), "203.0.113.5", "--role=app", "--dry-run"],
                capture_output=True, text=True, cwd=ROOT, timeout=120, env=env,
            )
        combined = self._combined(plain)
        self.assertNotIn("Unbekannte Option", combined)
        self.assertEqual(plain.returncode, 0, combined)
        self.assertIn("(Rolle app)", plain.stdout)
        self.assertIn("Trockenlauf (--dry-run): keine Aenderung ausgefuehrt.", plain.stdout)

        # Die Gleichheitsform bleibt gleichwertig.
        self.assertEqual(equals.returncode, 0, self._combined(equals))
        self.assertIn("(Rolle app)", equals.stdout)

        # Ein fehlender Rollenwert ist ein Klartextfehler, keine stille Annahme
        # (bricht vor jedem SSH-Zugriff ab - deshalb ohne Fake).
        missing = subprocess.run(
            [self.bash, str(MIGRATE_PROJECT), "127.0.0.1", "--role"],
            capture_output=True, text=True, cwd=ROOT, timeout=60, env=clean_env(),
        )
        missing_combined = self._combined(missing)
        self.assertEqual(missing.returncode, 1, missing_combined)
        self.assertIn("--role ohne Wert", missing_combined)

    def _fake_ssh(self, tmp: pathlib.Path, **extra: str) -> tuple[dict[str, str], pathlib.Path]:
        """Fake-`ssh` im PATH; liefert (Umgebung, Protokolldatei)."""
        fake_bin = tmp / "bin"
        fake_bin.mkdir(exist_ok=True)
        fake = fake_bin / "ssh"
        fake.write_text(FAKE_SSH, encoding="utf-8")
        fake.chmod(0o755)
        log = tmp / "ssh.log"
        env = clean_env(
            PATH=f"{fake_bin}:{os.environ.get('PATH', '')}",
            FAKE_SSH_LOG=str(log),
            **extra,
        )
        return env, log

    def test_migration_loest_den_altservice_des_knotens_auf(self) -> None:
        """Der Knoten faehrt eine aeltere Repo-Kopie: dort heisst der App-Service
        `sample-monk` (Container `samplemonk`). Die Migration muss das erkennen -
        sonst stoppt sie den Knoten und kann ihn nicht mehr starten (live
        passiert: "no such service: audiomonastry" auf sfu-1)."""
        with tempfile.TemporaryDirectory(prefix="f10-migrate-") as tmp:
            env, log = self._fake_ssh(
                pathlib.Path(tmp),
                FAKE_SSH_SERVICES="master-player sample-monk caddy",
                FAKE_SSH_DIRS="/opt/samplemonk=installation",
            )
            result = subprocess.run(
                [self.bash, str(MIGRATE_PROJECT), "203.0.113.5", "--role", "sfu", "--dry-run"],
                capture_output=True, text=True, cwd=ROOT, env=env, timeout=120,
            )
            combined = self._combined(result)
            calls = log.read_text(encoding="utf-8") if log.exists() else ""

        self.assertEqual(result.returncode, 0, combined)
        self.assertIn("Service-Aufloesung: audiomonastry -> sample-monk", combined)
        self.assertIn("Services auf dem Knoten: master-player sample-monk caddy", combined)
        # Der Plan nennt den aufgeloesten Service UND die Basis-Compose-Datei.
        self.assertIn("docker compose -f docker-compose.hetzner.yml", combined)
        self.assertIn("up -d caddy sample-monk", combined)
        # Trockenlauf stoppt nichts.
        self.assertNotIn(" down ", calls)

    def test_migration_stoppt_nicht_wenn_ein_service_fehlt(self) -> None:
        """Fail-early: fehlt der Rollen-Service auf dem Knoten, darf NICHTS
        gestoppt werden. Genau das war der Live-Fehler vom 2026-09-20 - die
        Migration hatte schon `down` ausgefuehrt und scheiterte danach am Start,
        der Knoten lag unten."""
        with tempfile.TemporaryDirectory(prefix="f10-migrate-") as tmp:
            env, log = self._fake_ssh(
                pathlib.Path(tmp),
                FAKE_SSH_SERVICES="caddy master-player",  # kein App-Service
                FAKE_SSH_DIRS="/opt/samplemonk=installation",
            )
            result = subprocess.run(
                [self.bash, str(MIGRATE_PROJECT), "203.0.113.5", "--role", "sfu", "--yes"],
                capture_output=True, text=True, cwd=ROOT, env=env, timeout=120,
            )
            combined = self._combined(result)
            calls = log.read_text(encoding="utf-8") if log.exists() else ""

        self.assertEqual(result.returncode, 2, combined)
        self.assertIn("fehlen in der Compose-Datei des Knotens", combined)
        self.assertIn("audiomonastry", combined)
        self.assertIn("vorhanden: caddy master-player", combined)
        self.assertNotIn("docker compose -f docker-compose.hetzner.yml down", calls)
        self.assertNotIn("mv /opt/samplemonk", calls)

    def test_migration_stoppt_nicht_wenn_die_service_liste_unlesbar_ist(self) -> None:
        with tempfile.TemporaryDirectory(prefix="f10-migrate-") as tmp:
            env, log = self._fake_ssh(
                pathlib.Path(tmp), FAKE_SSH_SERVICES="", FAKE_SSH_DIRS="/opt/samplemonk=installation",
            )
            result = subprocess.run(
                [self.bash, str(MIGRATE_PROJECT), "203.0.113.5", "--role", "app", "--yes"],
                capture_output=True, text=True, cwd=ROOT, env=env, timeout=120,
            )
            combined = self._combined(result)
            calls = log.read_text(encoding="utf-8") if log.exists() else ""

        self.assertEqual(result.returncode, 2, combined)
        self.assertIn("Keine Service-Liste vom Knoten lesbar", combined)
        self.assertNotIn("docker compose -f docker-compose.hetzner.yml down", calls)

    def test_watchdog_laeuft_aus_usr_local_bin_ohne_namensquelle_daneben(self) -> None:
        """Live-Befund 2026-09-20: `install-auto-repair.sh` kopierte den Watchdog
        nach /usr/local/bin, die Namensquelle `fleet-names.sh` aber nicht. Der
        Timer schrieb bei JEDEM Lauf "No such file or directory" +
        "FLEET_COMPOSE_PROJECT: unbound variable" und reparierte nichts.

        Der Test faehrt genau diesen Zustand: die Kopie liegt in einem
        Verzeichnis OHNE `fleet-names.sh`, die Namensquelle ist nur ueber
        FLEET_NAMES_SOURCE erreichbar (auf dem Knoten der Repo-Pfad).
        """
        project = self._names()["project"]
        with tempfile.TemporaryDirectory(prefix="f10-install-") as tmp:
            tmpdir = pathlib.Path(tmp)
            fake_bin = tmpdir / "bin"
            fake_bin.mkdir()
            fake = fake_bin / "docker"
            fake.write_text(FAKE_DOCKER, encoding="utf-8")
            fake.chmod(0o755)

            install_dir = tmpdir / "usr-local-bin"
            install_dir.mkdir()
            watchdog = install_dir / "audiomonastry-auto-repair.sh"
            watchdog.write_text(AUTO_REPAIR.read_text(encoding="utf-8"), encoding="utf-8")
            watchdog.chmod(0o755)
            self.assertFalse((install_dir / "fleet-names.sh").exists(), "Testannahme verletzt")

            repair_log = tmpdir / "auto-repair.log"
            compose_log = tmpdir / "compose.log"
            env = clean_env(
                PATH=f"{fake_bin}:{os.environ.get('PATH', '')}",
                FAKE_DOCKER_LOG=str(tmpdir / "docker.log"),
                FAKE_DOCKER_COMPOSE_LOG=str(compose_log),
                FAKE_DOCKER_CONTAINERS=f"{LEGACY_FIXTURE_APP} {LEGACY_FIXTURE_CADDY}",
                FLEET_NAMES_SOURCE=str(FLEET_NAMES),
                LOG=str(repair_log),
                APP_DIR=str(tmpdir / "opt"),
                CHECKS="1",
            )
            result = subprocess.run(
                [self.bash, str(watchdog)], capture_output=True, text=True,
                cwd=ROOT, env=env, timeout=180,
            )
            combined = self._combined(result)
            repair = repair_log.read_text(encoding="utf-8") if repair_log.exists() else ""
            compose_calls = compose_log.read_text(encoding="utf-8") if compose_log.exists() else ""

        self.assertNotIn("No such file or directory", combined, combined)
        self.assertNotIn("unbound variable", combined, combined)
        self.assertEqual(result.returncode, 0, combined)
        # Die Namensaufloesung hat gegriffen: der Watchdog nennt die tatsaechlichen
        # Containernamen (ohne Namensquelle waere er vorher mit Fehler ausgestiegen).
        self.assertIn(LEGACY_FIXTURE_APP, repair + combined, repair + combined)

    def test_bash_syntax_aller_f10_skripte_ist_sauber(self) -> None:
        for script in (FLEET_NAMES, AUTO_REPAIR, (HETZNER / "fleet-status.sh"), FLEET_DEPLOY_LIVE,
                       BRING_UP, PROVISION_FLEET, MIGRATE_PROJECT, DEPLOY_SH):
            with self.subTest(script=script.name):
                result = subprocess.run([self.bash, "-n", str(script)], capture_output=True, text=True, cwd=ROOT, timeout=60)
                self.assertEqual(result.returncode, 0, result.stderr)


class DeployImageWegeTest(unittest.TestCase):
    """PERF-P1-003 (2026-09-21): die zwei Image-Wege von `deploy.sh` halten.

    Anlass: `DEPLOY_REMOTE_BUILD=1` baute auf dem Knoten, aber OHNE
    Medien-Overlay (Folge: leere Mounts maskieren die Image-Pfade - Library
    leer, /models 404, genau der Fehler vom 2026-09-20), OHNE Rollback-Image und
    OHNE die Build-Stempel, die docker-compose.hetzner.yml fuer /api/health
    liest ("unknown" -> Commit-Paritaet nach PROD-P1-F4 nicht pruefbar). Der Fix
    stand nur im Commit-Text - hier wird er festgenagelt, und zwar fuer BEIDE
    Wege (Transfer und Remote-Build), weil beide einzeln kaputt sein koennen.
    """

    def setUp(self) -> None:
        self.bash = bash_path()
        self.text = DEPLOY_SH.read_text(encoding="utf-8")
        # Zerlegung an den Verzweigungen des Skripts statt an Zeilennummern.
        nach_if = self.text.split('if [[ "$DEPLOY_REMOTE_BUILD" != "1" ]]; then')[1]
        self.transfer_zweig, rest = nach_if.split("\n  else", 1)
        self.build_zweig = rest.split("\n  fi", 1)[0]

    # --- Nutzlast ----------------------------------------------------------
    def _print_config(self, **overrides: str) -> str:
        result = subprocess.run(
            [self.bash, "deploy.sh", "--print-config"],
            capture_output=True, text=True, cwd=ROOT, timeout=120,
            env=clean_env(DEPLOY_PRINT_CONFIG="1", **overrides),
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout

    # --- Regeln ------------------------------------------------------------
    def test_schalter_ist_im_trockenlauf_sichtbar(self) -> None:
        self.assertIn("DEPLOY_REMOTE_BUILD=0", self._print_config())
        self.assertIn("DEPLOY_REMOTE_BUILD=1", self._print_config(DEPLOY_REMOTE_BUILD="1"))

    def test_rollback_tag_in_beiden_wegen_und_vor_dem_ersetzen(self) -> None:
        tag = "docker image tag $IMAGE_APP ${IMAGE_APP}-rollback"
        self.assertEqual(self.text.count(tag), 2, "Rollback-Tag fehlt in einem der Image-Wege")
        self.assertIn(tag, self.transfer_zweig)
        self.assertIn(tag, self.build_zweig)
        # Nach `docker load` bzw. nach dem Build zeigt der Tag auf den neuen Stand.
        self.assertLess(
            self.transfer_zweig.index(tag), self.transfer_zweig.index("docker save"),
            "Rollback-Tag muss VOR docker load gesetzt werden",
        )
        self.assertLess(
            self.build_zweig.index(tag), self.build_zweig.index("up -d --build"),
            "Rollback-Tag muss VOR dem Remote-Build gesetzt werden",
        )

    def test_medien_overlay_gilt_fuer_beide_wege(self) -> None:
        # Ohne -f docker-compose.media.yml maskieren leere Bind-Mounts die Pfade
        # des Images. Zwei Aufrufe im Transferweg (App+master-player, dann caddy),
        # einer im Build-Weg.
        self.assertGreaterEqual(self.text.count("$COMPOSE_FILE$MEDIA_OVERLAY"), 3)
        for name, zweig in (("transfer", self.transfer_zweig), ("build", self.build_zweig)):
            with self.subTest(zweig=name):
                self.assertIn("$COMPOSE_FILE$MEDIA_OVERLAY", zweig)

    def test_stempel_gehen_nur_im_remote_build_mit(self) -> None:
        for stempel in ("AUDIOMONASTRY_VERSION", "AUDIOMONASTRY_COMMIT", "AUDIOMONASTRY_BUILD_TIME"):
            with self.subTest(stempel=stempel):
                self.assertIn(stempel, self.build_zweig)
        # Der Build-Weg baut, der Transferweg nicht (sonst baut jeder Rollout neu).
        self.assertIn("up -d --build", self.build_zweig)
        self.assertNotIn("--no-build", self.build_zweig)
        self.assertIn("--no-build", self.transfer_zweig)

    def test_gleicher_vertrag_wie_der_live_deploy_weg(self) -> None:
        # deploy.sh und fleet-deploy-live.sh bauen dasselbe Image auf demselben
        # Knoten - gleiche Stempelnamen und derselbe Rueckweg, sonst laufen die
        # beiden Wege auseinander (genau das war PERF-P1-004).
        live = FLEET_DEPLOY_LIVE.read_text(encoding="utf-8")
        for name in ("AUDIOMONASTRY_VERSION", "AUDIOMONASTRY_COMMIT", "AUDIOMONASTRY_BUILD_TIME"):
            with self.subTest(name=name):
                self.assertIn(name, self.build_zweig)
                self.assertIn(name, live)
        self.assertIn("-rollback", live)
        self.assertIn("${IMAGE_APP}-rollback", self.text)
        # Beide bauen mit demselben Compose-Muster (Projektname explizit, --build).
        self.assertIn("COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT docker compose", self.build_zweig)
        self.assertIn("COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT docker compose", live)


class FleetRemoteBuildTest(unittest.TestCase):
    """PERF-P1-004 (2026-09-21): Fleet-Rollout ohne Image-Transfer.

    Gemessen: die Leitung Host -> Knoten macht ~1 MB/s hoch, das App-Image ist
    338 MB Tar -> ~6 min pro Knoten und die Layer sind schon gepackt (zstd -3
    holt 337 von 338 MB - nichts). `DEPLOY_REMOTE_BUILD=1` baut den per rsync
    uebertragenen Stand auf dem Knoten. Damit das den Stempel nicht verliert,
    MUESSEN Version/Commit/Zeit als Build-Args mitgehen; ohne sie stuende
    "unknown" in /api/health und die Commit-Paritaet waere nicht pruefbar.
    """

    def setUp(self) -> None:
        self.bash = shutil.which("bash")
        if self.bash is None:  # pragma: no cover - Windows/Exoten
            self.skipTest("bash nicht vorhanden")
        self.text = FLEET_DEPLOY_LIVE.read_text(encoding="utf-8")

    def _print_config(self, **env_extra: str) -> str:
        env = clean_env()
        env.update(env_extra)
        result = subprocess.run(
            [self.bash, str(FLEET_DEPLOY_LIVE), "--print-config"],
            capture_output=True, text=True, cwd=ROOT, timeout=60, env=env,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_schalter_ist_im_trockenlauf_sichtbar(self) -> None:
        self.assertIn("DEPLOY_REMOTE_BUILD=0", self._print_config())
        self.assertIn("DEPLOY_REMOTE_BUILD=1", self._print_config(DEPLOY_REMOTE_BUILD="1"))

    def test_remote_build_branch_uebergibt_die_stempel_werte(self) -> None:
        # Die drei Namen liest docker-compose.hetzner.yml als Build-Args.
        for name in ("AUDIOMONASTRY_VERSION", "AUDIOMONASTRY_COMMIT", "AUDIOMONASTRY_BUILD_TIME"):
            self.assertIn(name, self.text)
        # Der Build-Zweig muss --build fahren UND die Stempel setzen; der
        # Transfer-Zweig bleibt bei --no-build (sonst baut jeder Rollout neu).
        # Nur der Rumpf des if-Zweigs bis zum else - sonst zaehlt der Test die
        # Zeilen des Transfer-Zweigs mit und widerspricht sich selbst.
        build_branch = self.text.split('if [[ "$REMOTE_BUILD" == "1" ]]; then')[1].split("\nelse")[0]
        self.assertIn("--build --remove-orphans", build_branch)
        self.assertNotIn("--no-build", build_branch)
        transfer_branch = self.text.split('step "3/4 Image uebertragen')[1]
        self.assertIn("--no-build --remove-orphans", transfer_branch)

    def test_medien_overlay_gilt_fuer_alle_wege(self) -> None:
        # Ohne -f docker-compose.media.yml maskieren leere Mounts die Image-Pfade
        # (genau der Fehler vom 2026-09-20). Beide Wege muessen $OVERLAYS nutzen.
        self.assertIn("MEDIA_OVERLAY=", self.text)
        self.assertIn("ls -A $REMOTE_DIR/media", self.text)
        self.assertIn("OVERLAYS=", self.text)
        compose_calls = [line for line in self.text.splitlines() if "docker compose $OVERLAYS" in line]
        self.assertGreaterEqual(
            len(compose_calls), 3,
            "Start/Status muessen die Overlay-Dateien mitnehmen: " + repr(compose_calls),
        )
        # Kein Compose-Aufruf darf das Overlay vergessen.
        for line in self.text.splitlines():
            if "docker compose -f docker-compose.hetzner.yml" in line and "OVERLAYS" not in line:
                self.fail(f"Compose-Aufruf ohne Overlay-Dateien: {line.strip()}")

    def test_rollback_tag_in_beiden_image_wegen(self) -> None:
        # PERF-P1-004: der Rueckweg gehoert in BEIDE Image-Wege und muss VOR dem
        # Ersetzen des Images stehen - nach `docker load` waere das neue Image
        # schon da und der Tag wertlos.
        tag = "docker image tag $IMAGE ${IMAGE}-rollback"
        self.assertEqual(self.text.count(tag), 2, "Rollback-Tag fehlt in einem der Image-Wege")
        build_branch = self.text.split('if [[ "$REMOTE_BUILD" == "1" ]]; then')[1].split("\nelse")[0]
        self.assertIn(tag, build_branch)
        transfer_branch = self.text.split('step "3/4 Image uebertragen')[1]
        self.assertIn(tag, transfer_branch)
        self.assertLess(
            transfer_branch.index(tag), transfer_branch.index("docker save"),
            "Rollback-Tag muss VOR docker load gesetzt werden",
        )
        # Der Abschluss nennt den Rollback-Befehl mit denselben Overlay-Dateien.
        self.assertIn("docker tag $IMAGE ${IMAGE}-rollback && cd $REMOTE_DIR", self.text)

    def test_help_zeigt_hilfe_ohne_deploy(self) -> None:
        # Ohne diesen Zweig landete "--help" als IP im Guard (gemessen 2026-09-21:
        # rsync brach mit "Invalid remote host: hostnames may not start with '-'"
        # ab). Ein Hilfeaufruf darf NICHTS uebertragen.
        for flag in ("--help", "-h"):
            with self.subTest(flag=flag):
                result = subprocess.run(
                    [self.bash, str(FLEET_DEPLOY_LIVE), flag],
                    capture_output=True, text=True, cwd=ROOT, timeout=60, env=clean_env(),
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("Aufruf:", result.stdout)
                self.assertIn("DEPLOY_REMOTE_BUILD=1", result.stdout)
                for verboten in ("=== 1/4", "docker save"):
                    self.assertNotIn(verboten, result.stdout)
                self.assertEqual(result.stderr, "", "Hilfe darf nichts auf stderr schreiben")

    def test_stempel_werden_aus_dem_repo_abgeleitet(self) -> None:
        # Der Knoten baut den rsyncten Stand: Version/Commit kommen aus dem Repo,
        # die Zeit aus dem Deploy-Host (nicht aus dem Knoten - der haette keine
        # .git, rsync schliesst sie aus).
        self.assertIn("package.json", self.text)
        self.assertIn("rev-parse --short HEAD", self.text)
        self.assertIn("date -u +%Y-%m-%dT%H:%M:%SZ", self.text)
        self.assertIn("--exclude .git", self.text)



#: Fakes fuer den Vertragstest des Flottenstarts: jeder Aufruf wird mit Namen
#: protokolliert und mit Exit 0 beantwortet - kein Knoten, kein Docker-Daemon,
#: kein Netz. Damit ist die ECHTE Kommandozeile von deploy.sh lesbar: welcher
#: Image-Weg lief (`docker save`/`docker load` vs. `up -d --build`) und mit
#: welchen Build-Stempeln.
FAKE_CLI_LOG_ONLY = r"""#!/usr/bin/env bash
printf '%s\n' "{name} $*" >> "${FAKE_CMD_LOG:?}"
exit 0
"""


class FleetStartRemoteBuildDefaultTest(unittest.TestCase):
    """PERF-P1-005 (2026-09-21): der Flottenstart deployt app-1 per Remote-Build.

    Anlass (gemessen): `deploy.sh` kennt den schnellen Weg seit PERF-P1-003
    (`DEPLOY_REMOTE_BUILD=1` = rsync-Delta + Build auf dem Knoten; am 2026-09-21
    zweimal live auf app-1 gefahren, ~1 min bei warmem Layer-Cache). Der
    Flottenstart hat den Schalter aber NICHT gesetzt - und deploy.sh defaultet auf
    `0` -, also schob jeder Flottenstart ~2,65 GB (app 1,43 GB + master-player
    1,22 GB) ueber eine Leitung von ~1 MB/s hoch: 25-40 min je Knoten, bevor
    ueberhaupt Health/Smoke geprueft werden konnte. Der Grund fuer den
    Remote-Build (die Leitung, nicht der Build) gilt beim Flottenstart genauso.

    Vertraege, die hier festgenagelt sind:
      1. `bring-up-fleet.sh` setzt `DEPLOY_REMOTE_BUILD=1` als Default und reicht
         ihn an deploy.sh durch; der gewaehlte Weg steht als Klartext im
         Trockenlauf UND im Deploy-Schritt (im Log soll lesbar sein, warum es
         schnell oder langsam ist).
      2. Per Umgebung ist der Schalter auf `0` stellbar - dann laeuft bewusst der
         Transfer-Weg (Gegenprobe im Fake-Lauf).
      3. Im Remote-Build-Modus laeuft der Transfer-Weg NICHT: keine
         `docker save`/`docker load` in der Kommandoliste.
      4. Das ZWEITE Image (`audiomonastry-master-player:hetzner`) ist erfasst: es
         hat einen eigenen Compose-Service mit eigenem Build-Kontext, und der
         Remote-Build ruft Compose OHNE Service-Liste - damit baut Compose alle
         Default-Profil-Dienste mit `build:` (audiomonastry UND master-player),
         caddy hat kein `build:`. Ein eigener Transfer des zweiten Images ist
         deshalb nicht noetig - es gibt aber auch keinen Schritt, der es
         vergisst.
    """

    def setUp(self) -> None:
        self.bash = bash_path()
        self.text = BRING_UP.read_text(encoding="utf-8")
        self.deploy_text = DEPLOY_SH.read_text(encoding="utf-8")

    # --- Helfer ------------------------------------------------------------
    @staticmethod
    def _combined(result: subprocess.CompletedProcess) -> str:
        return result.stdout + result.stderr

    def _print_config(self, **overrides: str) -> str:
        result = subprocess.run(
            [self.bash, str(BRING_UP), "--print-config"],
            capture_output=True, text=True, cwd=ROOT, timeout=120, env=clean_env(**overrides),
        )
        self.assertEqual(result.returncode, 0, self._combined(result))
        return result.stdout

    def _deploy_lauf(self, **overrides: str) -> dict[str, Any]:
        """deploy.sh mit Fake-ssh/-scp/-rsync/-docker fahren: kein Knoten, kein Docker.

        Der lokale `/api/health`-Stub beantwortet den Health-Wait (sonst wartete
        der Lauf 30x4 s auf einen nicht erreichbaren Knoten) und meldet genau den
        Repo-Commit - damit ist die Commit-Paritaet (PROD-P1-F4) erfuellt und der
        Lauf endet mit Exit 0 statt im Stale-Gate. `DEPLOY_HOST` ist der
        Stub-Host; alle `ssh`/`scp`/`rsync`/`docker`-Aufrufe faengt der Fake ab
        und schreibt sie in das Kommando-Protokoll.
        """
        commit = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True,
            cwd=ROOT, timeout=60,
        ).stdout.strip()
        with tempfile.TemporaryDirectory(prefix="p1-005-deploy-") as tmpdir:
            tmp = pathlib.Path(tmpdir)
            fake_bin = tmp / "bin"
            fake_bin.mkdir()
            for tool_name in ("ssh", "scp", "rsync", "docker"):
                tool = fake_bin / tool_name
                tool.write_text(FAKE_CLI_LOG_ONLY.replace("{name}", tool_name), encoding="utf-8")
                tool.chmod(0o755)
            key = tmp / "id_test"
            key.write_text("KEIN-ECHTES-SCHLUESSELMATERIAL\n", encoding="utf-8")
            log = tmp / "kommandos.log"
            health = {"status": "ok", "version": "1.2.3", "commit": commit,
                      "buildTime": "2026-09-21T00:00:00Z"}
            with _HealthStub(health) as stub:
                env = clean_env(
                    PATH=f"{fake_bin}:{os.environ.get('PATH', '')}",
                    FAKE_CMD_LOG=str(log),
                    # `BASE_URL` wird als http://${DEPLOY_HOST#*@} gebildet - der
                    # Stub-Host hat kein "user@", also bleibt er unveraendert.
                    DEPLOY_HOST=stub.base_url.replace("http://", ""),
                    DEPLOY_SSH_KEY=str(key),
                    DEPLOY_SYNC_ENV="0",
                    DEPLOY_SMOKE="0",
                    DEPLOY_DOMAIN=None,
                    **overrides,
                )
                result = subprocess.run(
                    [self.bash, str(DEPLOY_SH)], capture_output=True, text=True,
                    cwd=ROOT, timeout=300, env=env,
                )
            kommandos = log.read_text(encoding="utf-8").splitlines() if log.exists() else []
        return {"result": result, "kommandos": kommandos, "commit": commit,
                "combined": self._combined(result)}

    # --- 1. Der Schalter im Flottenstart ----------------------------------
    def test_default_ist_remote_build_und_im_trockenlauf_lesbar(self) -> None:
        self.assertIn('DEPLOY_REMOTE_BUILD="${DEPLOY_REMOTE_BUILD:-1}"', self.text)
        stdout = self._print_config()
        self.assertIn("DEPLOY_REMOTE_BUILD=1", stdout)
        self.assertIn("Remote-Build auf dem Knoten", stdout)
        # Klartext-Grund: im Log muss die Zeitdifferenz erklaerbar sein.
        self.assertIn("gemessen ~1 min", stdout)
        # Die Gegenrichtung darf hier NICHT stehen (sonst waere die Anzeige
        # widerspruechlich zu dem, was der Deploy-Schritt faehrt).
        self.assertNotIn("Image-Transfer", stdout)

    def test_schalter_ist_per_umgebung_abschaltbar(self) -> None:
        stdout = self._print_config(DEPLOY_REMOTE_BUILD="0")
        self.assertIn("DEPLOY_REMOTE_BUILD=0", stdout)
        self.assertIn("Image-Transfer", stdout)
        self.assertIn("docker save | ssh docker load", stdout)
        self.assertIn("25-40 min", stdout)
        self.assertNotIn("Remote-Build auf dem Knoten", stdout)

    def test_flottenstart_reicht_den_schalter_an_deploy_sh_durch(self) -> None:
        # Der Schalter muss im AUFRUF stehen (nicht nur in einer Anzeige) - sonst
        # meldet der Flottenstart einen Weg, den er nicht faehrt.
        aufruf = self.text.split('step "5/9 app-1 deployen')[1].split("# --- 6.")[0]
        self.assertIn('DEPLOY_REMOTE_BUILD="$DEPLOY_REMOTE_BUILD"', aufruf)
        self.assertIn("sg docker -c", aufruf)
        # Und deploy.sh liest genau diesen Namen (kein zweiter Schaltername).
        self.assertIn('DEPLOY_REMOTE_BUILD="${DEPLOY_REMOTE_BUILD:-0}"', self.deploy_text)

    # --- 2. Der Image-Weg selbst (Fake-Tools, kein Knoten) ----------------
    def test_remote_build_modus_faehrt_keinen_image_transfer(self) -> None:
        lauf = self._deploy_lauf(DEPLOY_REMOTE_BUILD="1")
        self.assertEqual(lauf["result"].returncode, 0, lauf["combined"])
        kommandos = lauf["kommandos"]
        self.assertTrue(
            [k for k in kommandos if "up -d --build" in k],
            f"kein Remote-Build gefahren: {kommandos}",
        )
        for verboten in ("docker save", "docker load"):
            treffer = [k for k in kommandos if verboten in k]
            self.assertEqual(treffer, [], f"Transfer-Weg lief trotz Remote-Build: {treffer}")

    def test_abschalten_faehrt_bewusst_den_transfer_weg(self) -> None:
        # Gegenprobe (Haelfte 2 von "per Umgebung auf 0 stellbar"): mit 0 laeuft
        # wirklich der Image-Transfer - sonst waere der Schalter wirkungslos.
        lauf = self._deploy_lauf(DEPLOY_REMOTE_BUILD="0")
        self.assertEqual(lauf["result"].returncode, 0, lauf["combined"])
        kommandos = lauf["kommandos"]
        self.assertTrue([k for k in kommandos if "docker save" in k],
                        f"kein docker save trotz Transfer-Modus: {kommandos}")
        self.assertTrue([k for k in kommandos if "docker load" in k],
                        f"kein docker load trotz Transfer-Modus: {kommandos}")
        self.assertEqual([k for k in kommandos if "up -d --build" in k], [],
                         "Transfer-Modus hat trotzdem auf dem Knoten gebaut")

    def test_stempel_und_medien_overlay_gehen_mit(self) -> None:
        # PROD-P1-F4 + PERF-P1-003 gelten auch vom Flottenstart aus: der Knoten
        # baut den rsyncten Stand, also muessen Version/Commit/Zeit mitgehen
        # (sonst stuende "unknown" in /api/health) - und das Medien-Overlay muss
        # dabei sein (leere Mounts maskieren sonst die Image-Pfade).
        lauf = self._deploy_lauf(DEPLOY_REMOTE_BUILD="1")
        self.assertEqual(lauf["result"].returncode, 0, lauf["combined"])
        build_aufruf = next(k for k in lauf["kommandos"] if "up -d --build" in k)
        version = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
        for stempel, wert in (
            ("AUDIOMONASTRY_VERSION", version),
            ("AUDIOMONASTRY_COMMIT", lauf["commit"]),
        ):
            with self.subTest(stempel=stempel):
                self.assertIn(f"{stempel}='{wert}'", build_aufruf)
        self.assertIn("AUDIOMONASTRY_BUILD_TIME='", build_aufruf)
        # Die Fake-Antwort auf die Medien-Probe (Exit 0) faehrt denselben Zweig
        # wie ein Knoten MIT Inhalten unter media/: Overlay aktiv.
        self.assertIn("-f docker-compose.hetzner.yml -f docker-compose.media.yml", build_aufruf)
        self.assertIn("--- Medien-Overlay aktiv", lauf["combined"])

    # --- 3. Das zweite Image (master-player) ------------------------------
    def test_master_player_ist_vom_remote_build_erfasst(self) -> None:
        # Eigener Compose-Service, eigenes Image-Tag, KEIN Profil (also im
        # Default-Profil, das `up -d --build` ohne Service-Liste anfasst).
        block = COMPOSE_BASE.read_text(encoding="utf-8").split("  master-player:")[1].split("\n  redis:")[0]
        self.assertIn("build: ./services/master-player", block)
        self.assertIn("image: audiomonastry-master-player:hetzner", block)
        self.assertNotIn("profiles:", block)
        # Build-Kontext liegt im Repo und wird von KEINEM Sync-Weg ausgeschlossen
        # (sonst fehlte auf dem Knoten die Quelle fuer den Build).
        for datei in ("Dockerfile", "requirements.lock", "server.py"):
            self.assertTrue((ROOT / "services" / "master-player" / datei).exists(), datei)
        for inhalt, name in ((self.deploy_text, "deploy.sh"), (self.text, "bring-up-fleet.sh")):
            self.assertNotIn("--exclude services", inhalt, f"{name} schliesst den Build-Kontext aus")
        # Image-Name im Deploy = Image-Name im Compose-Service (sonst baut Compose
        # ein anderes Tag als deploy.sh erwartet).
        self.assertIn('IMAGE_MASTER="audiomonastry-master-player:hetzner"', self.deploy_text)
        # Der Remote-Build ruft Compose OHNE Service-Liste (oder nennt
        # master-player ausdruecklich) - beides erfasst das zweite Image.
        nach_if = self.deploy_text.split('if [[ "$DEPLOY_REMOTE_BUILD" != "1" ]]; then')[1]
        build_zweig = nach_if.split("\n  else", 1)[1].split("\n  fi", 1)[0]
        zeile = next(
            l for l in build_zweig.splitlines()
            if "COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT docker compose" in l and "up -d --build" in l
        )
        rest = zeile.split("up -d --build", 1)[1].strip().strip('"').strip()
        self.assertTrue(
            rest == "" or "master-player" in rest,
            f"Remote-Build nennt eine Service-Liste ohne master-player: {zeile.strip()}",
        )

    def test_master_player_ist_im_default_profil_mit_build_kontext(self) -> None:
        # Beleg ohne Knoten: was `docker compose up -d --build` ohne Service-Liste
        # anfasst, ist genau das Default-Profil der Compose-Datei. Ohne Docker
        # lokal wird uebersprungen (der Vertrag oben deckt denselben Punkt ab).
        if shutil.which("docker") is None:  # pragma: no cover
            self.skipTest("docker/compose nicht vorhanden")
        with tempfile.TemporaryDirectory(prefix="p1-005-compose-") as tmpdir:
            tmp = pathlib.Path(tmpdir)
            shutil.copy(COMPOSE_BASE, tmp / "docker-compose.hetzner.yml")
            (tmp / ".env").write_text("", encoding="utf-8")
            dienste = subprocess.run(
                ["docker", "compose", "-f", "docker-compose.hetzner.yml", "config", "--services"],
                capture_output=True, text=True, cwd=tmp, timeout=120,
            )
            if dienste.returncode != 0:  # pragma: no cover - Compose fehlt/kein Daemon
                self.skipTest(f"docker compose nicht aufrufbar: {dienste.stderr.strip()}")
            config = subprocess.run(
                ["docker", "compose", "-f", "docker-compose.hetzner.yml", "config"],
                capture_output=True, text=True, cwd=tmp, timeout=120,
            )
        self.assertEqual(dienste.returncode, 0, dienste.stderr)
        self.assertEqual(
            set(dienste.stdout.split()), {"audiomonastry", "caddy", "master-player"},
            "Default-Profil hat sich geaendert - der Remote-Build fasst andere Dienste an",
        )
        self.assertEqual(config.returncode, 0, config.stderr)
        # ... und der master-player bringt seinen Build-Kontext mit.
        self.assertIn("services/master-player", config.stdout)
        self.assertIn("audiomonastry-master-player:hetzner", config.stdout)


class FleetSyncDeleteGuardTest(unittest.TestCase):
    """PERF-P1-004 (2026-09-21): `rsync --delete` darf Knoten-lokale Laufzeitdaten
    nicht loeschen.

    `fleet-deploy-live.sh` spiegelt mit `--delete` - alles, was auf dem Knoten
    liegt und nicht ausgeschlossen ist, wird entfernt. Am Knoten app-1 gemessen
    liegen dort NUR lokal (nicht im Repo, nicht reproduzierbar):
      media/    3,3 GB Overlay-Inhalt (orchestral/models/music, deliver-media.sh)
      certs/    origin.crt/origin.key (0600) - Origin-Zertifikat, deploy.sh setzt es
      Caddyfile Knoten-Variante mit Origin-TLS (deploy.sh schuetzt sie ebenso)
    Diese Liste ist der Vertrag: faellt ein Ausschluss weg, raeumt der naechste
    Lauf den Pfad weg (Folge: leere Overlay-Mounts, Library/Instrumente leer,
    /models 404, TLS fuer origin.<domain>) tot - und die 3,3 GB muessten ueber
    eine Leitung von ~1 MB/s neu geliefert werden.
    """

    BASH: str
    text: str

    @classmethod
    def setUpClass(cls) -> None:
        bash = shutil.which("bash")
        if bash is None:  # pragma: no cover - Windows/Exoten
            raise unittest.SkipTest("bash nicht vorhanden")
        cls.BASH = bash

    def setUp(self) -> None:
        self.text = FLEET_DEPLOY_LIVE.read_text(encoding="utf-8")

    #: Skripte, die mit `rsync --delete` auf einen Knoten spiegeln. Neue Wege
    #: gehoeren hier hinein - der Waechter prueft dann denselben Vertrag.
    SYNC_SCRIPTS = (FLEET_DEPLOY_LIVE, BRING_UP, INSTALL_AI1)

    #: Knoten-lokale Laufzeitdaten (am 2026-09-21 auf der Flotte gemessen):
    #: media/ 3,3 GB (app-1), certs/ Origin-Zertifikat (app-1), Caddyfile
    #: (Rollen-Variante), runtime/coturn/turnserver.conf (sfu-1, Secret).
    KNOTEN_LOKAL = ("media", "certs", "Caddyfile", "runtime")

    #: Kein Repo-Sync noetig: lokale Test-/Python-Artefakte (entstehen bei jedem
    #: `npm run test:python` und haben auf dem Knoten nichts zu suchen).
    KEIN_SYNC = ("__pycache__",)

    #: Overlay-Baeume: liegen auf dem Knoten unter media/ und werden per
    #: docker-compose.media.yml gemountet - sie gehoeren in keinen Repo-Sync.
    OVERLAY_BAEUME = ("public/data/orchestral", "public/models", "public/music")

    def test_sync_laeuft_ueberhaupt_mit_delete(self) -> None:
        # Ohne --delete waere dieser Waechter gegenstandslos; dann muss auch die
        # Vertragsliste hier bewusst angepasst werden.
        for script in self.SYNC_SCRIPTS:
            with self.subTest(script=script.name):
                self.assertIn("--delete", script.read_text(encoding="utf-8"))

    def test_alle_knoten_lokalen_pfade_sind_ausgeschlossen(self) -> None:
        for script in self.SYNC_SCRIPTS:
            inhalt = script.read_text(encoding="utf-8")
            for pfad in self.KNOTEN_LOKAL:
                with self.subTest(script=script.name, pfad=pfad):
                    self.assertIn(f"--exclude {pfad}", inhalt)
        for script in self.SYNC_SCRIPTS:
            inhalt = script.read_text(encoding="utf-8")
            for pfad in self.KEIN_SYNC:
                with self.subTest(script=script.name, pfad=pfad):
                    self.assertIn(f"--exclude {pfad}", inhalt)
        # Die Rollen-.env (inkl. .env.bak-*) bleibt unangetastet.
        self.assertIn("--exclude .env --exclude '.env.*'", self.text)

    def test_overlay_baeume_werden_nicht_mitgeschoben(self) -> None:
        # Alle drei Overlay-Baeume liegen auf dem Knoten unter media/; ohne
        # Ausschluss wandern bei jedem Lauf Gigabytes mit bzw. werden geloescht.
        for script in self.SYNC_SCRIPTS:
            inhalt = script.read_text(encoding="utf-8")
            for baum in self.OVERLAY_BAEUME:
                with self.subTest(script=script.name, baum=baum):
                    self.assertIn(f"--exclude {baum}", inhalt)

    def test_sfu_1_verliert_die_coturn_konfiguration_nicht(self) -> None:
        # Der live gemessene Fall: sfu-1 haelt runtime/coturn/turnserver.conf
        # (0640, Secret) - die Datei entsteht AUF dem Knoten (wire-rtc.sh) und
        # wird von docker-compose.turn.yml gemountet. Kein Deploy bringt sie mit,
        # also darf der Sync sie weder loeschen noch ueberschreiben.
        self.assertFalse(
            (ROOT / "runtime").exists(),
            "runtime/ liegt jetzt im Repo - der Ausschluss waere nur noch Kosmetik, "
            "Vertrag in FleetSyncDeleteGuardTest pruefen",
        )
        self.assertIn(
            "./runtime/coturn/turnserver.conf",
            (ROOT / "docker-compose.turn.yml").read_text(encoding="utf-8"),
            "Mount-Pfad der coturn-Konfiguration hat sich geaendert",
        )
        for script in (FLEET_DEPLOY_LIVE, BRING_UP, INSTALL_AI1):
            with self.subTest(script=script.name):
                self.assertIn("--exclude runtime", script.read_text(encoding="utf-8"))

    def test_trockenlauf_zwei_zeigt_den_loeschplan_vor_dem_deploy(self) -> None:
        # DEPLOY_DRY_RUN=2 faehrt den ECHTEN Sync als Trockenlauf gegen den
        # Knoten und bricht danach ab - VOR Tunnel-Overlay, Medien-Check und
        # Image-Schritten. Nur so ist der Loeschplan von `--delete` lesbar,
        # bevor er zuschlaegt (der Fix oben schuetzt die Pfade, dieser Modus
        # macht den Schutz nachpruefbar).
        self.assertIn("--dry-run --itemize-changes", self.text)
        sync_block = self.text.split('step "1/4 Repo-Stand rsyncen')[1].split('step "2/4')[0]
        self.assertIn('"${RSYNC_DRY[@]}"', sync_block)
        self.assertIn('if [[ "$DRY_RUN" == "2" ]]', sync_block)
        self.assertIn("exit 0", sync_block)
        # Der Abbruch steht im Sync-Block, also zwingend vor den Image-Schritten.
        self.assertLess(
            self.text.index('Trockenlauf (DEPLOY_DRY_RUN=2)'),
            self.text.index('docker save "$IMAGE"'),
        )
        # Und der Modus ist im Trockenlauf sichtbar (Werkzeug-Charakter).
        config = subprocess.run(
            [shutil.which("bash") or "bash", str(FLEET_DEPLOY_LIVE), "--print-config"],
            capture_output=True, text=True, cwd=ROOT, timeout=60, env=clean_env(),
        )
        self.assertEqual(config.returncode, 0, config.stderr)
        self.assertIn("DEPLOY_DRY_RUN=0", config.stdout)
        self.assertIn("Sync-Trockenlauf", config.stdout)

    def test_gegenprobe_stand_vor_dem_fix_verletzt_den_vertrag(self) -> None:
        # Belegt, dass dieser Waechter den ECHTEN Fehler faengt: der Stand von
        # a9b1487 hatte --delete ohne media/certs/Caddyfile. Faellt dieser Test
        # eines Tages um, wurde er entschaerft - dann muss geprueft werden, ob
        # die Ausschluesse noch im Skript stehen.
        for rel in (
            "scripts/hetzner/fleet-deploy-live.sh",
            "scripts/hetzner/bring-up-fleet.sh",
            "scripts/hetzner/install-ai1.sh",
        ):
            with self.subTest(script=rel):
                alt = subprocess.run(
                    ["git", "show", f"a9b1487:{rel}"],
                    capture_output=True, text=True, cwd=ROOT, timeout=60,
                )
                self.assertEqual(alt.returncode, 0, alt.stderr)
                self.assertIn("--delete", alt.stdout)
                for pfad in ("--exclude media", "--exclude certs", "--exclude Caddyfile"):
                    self.assertNotIn(
                        pfad, alt.stdout,
                        "Der Altstand hatte den Ausschluss schon - Gegenprobe wertlos",
                    )


# =============================================================================
# PROD-P2-REG (2026-09-21): Registry-Weg (GHCR) - Push-Werkzeug + Pull-Modus
# =============================================================================
# Gemessen: die Leitung Betreiber-Rechner -> Knoten macht ~1 MB/s hoch, das
# App-Image ist 1,43 GB (+ master-player 1,22 GB) -> 25-40 min pro Knoten und
# jeder weitere Knoten zahlt erneut. Der Registry-Weg dreht das um: EINMAL
# pushen, danach zieht jeder Knoten mit `docker pull` im Rechenzentrums-Tempo.
#
# Fake `docker` fuer die Registry-Vertraege: protokolliert jeden Aufruf (argv)
# UND stdin. Damit ist ohne Docker/Netz belegbar,
#   * dass login/pull/tag laufen und KEIN `docker save`,
#   * dass das Token per Pipe ankommt (stdin) und NIE in argv steht,
#   * dass ein schon gepushter Tag nicht zweimal gepusht wird.
# Tests rufen das Skript mit stdin=DEVNULL auf, damit `cat` im Fake nicht wartet.
FAKE_REGISTRY_DOCKER = r"""#!/usr/bin/env bash
set -uo pipefail
printf '%s\n' "$*" >> "${FAKE_REGISTRY_DOCKER_LOG:?}"
if [[ ! -t 0 ]]; then cat >> "${FAKE_REGISTRY_DOCKER_STDIN:?}" 2>/dev/null || true; fi
case "${1:-}" in
  # `manifest inspect` scheitert bei "Tag noch nicht in der Registry" (Exit != 0).
  manifest) exit "${FAKE_REGISTRY_MANIFEST_EXIT:-1}" ;;
esac
exit 0
"""

#: Fake `ssh`: protokolliert den entfernten Befehl und fuehrt ihn LOKAL aus.
#: Damit laeuft der ECHTE Codepfad (Login -> pull -> tag -> compose up), aber
#: ohne Knoten, ohne Netz - und `docker` darin ist wieder der Fake oben.
FAKE_REGISTRY_SSH = r"""#!/usr/bin/env bash
set -uo pipefail
cmd="${*: -1}"
printf '%s\n' "$cmd" >> "${FAKE_SSH_LOG:?}"
if [[ -n "${FAKE_SSH_REPO:-}" ]]; then
  cmd="${cmd//\/opt\/audiomonastry/${FAKE_SSH_REPO}}"
fi
exec bash -c "$cmd"
"""

FAKE_REGISTRY_RSYNC = r"""#!/usr/bin/env bash
# Fake `rsync`: protokolliert und uebertraegt nichts (es geht hier um den
# Image-Weg, nicht um den Sync - der hat seinen eigenen Waechter).
printf '%s\n' "$*" >> "${FAKE_RSYNC_LOG:?}"
exit 0
"""

FAKE_REGISTRY_CURL = r"""#!/usr/bin/env bash
# Fake `curl`: die App-Health-Probe des Knotens bekommt eine Antwort, damit der
# Live-Weg durchlaeuft - ohne Netz und ohne Knoten.
case "$*" in
  *"/api/health"*)
    printf '{"status":"ok","version":"1.210.001","commit":"%s","buildTime":"1970-01-01T00:00:00Z"}\n' \
      "${FAKE_CURL_COMMIT:-unknown}"
    ;;
esac
exit 0
"""


class RegistryWegTest(unittest.TestCase):
    """PROD-P2-REG: Der Registry-Weg haelt seinen Vertrag.

    Erster Teil: das Push-Werkzeug `scripts/hetzner/registry-push.sh`
    (Trockenlauf ohne Docker/Netz, Tag-Bildung, Login per stdin, Idempotenz).
    Zweiter Teil: der Pull-Modus beider Deploy-Wege - im Registry-Modus laeuft
    login/pull/tag, aber KEIN `docker save`; der Default bleibt unveraendert.
    """

    #: Kanarienvogel-Wert: taucht er in einer Ausgabe oder in argv auf, ist der
    #: Vertrag "Token nur per stdin" gebrochen.
    TOKEN = "ghcr-canary-nur-fuer-den-test-0000"

    BASH: str

    @classmethod
    def setUpClass(cls) -> None:
        bash = shutil.which("bash")
        if bash is None:  # pragma: no cover - Windows/Exoten
            raise unittest.SkipTest("bash nicht vorhanden")
        cls.BASH = bash
        for path in (REGISTRY_PUSH, REGISTRY_LIB, DEPLOY_SH, FLEET_DEPLOY_LIVE):
            if not path.exists():  # pragma: no cover - Dateien sind eingecheckt
                raise AssertionError(f"fehlt: {path}")

    # --- Helfer ------------------------------------------------------------
    def _fake_bin(self, tmp: pathlib.Path, *, docker: bool = True, ssh: bool = True,
                  rsync: bool = False, curl: bool = False) -> pathlib.Path:
        fake = tmp / "bin"
        fake.mkdir(parents=True, exist_ok=True)
        if docker:
            (fake / "docker").write_text(FAKE_REGISTRY_DOCKER, encoding="utf-8")
        if ssh:
            (fake / "ssh").write_text(FAKE_REGISTRY_SSH, encoding="utf-8")
        if rsync:
            (fake / "rsync").write_text(FAKE_REGISTRY_RSYNC, encoding="utf-8")
        if curl:
            (fake / "curl").write_text(FAKE_REGISTRY_CURL, encoding="utf-8")
        for name in ("docker", "ssh", "rsync", "curl"):
            path = fake / name
            if path.exists():
                path.chmod(0o755)
        return fake

    def _env_file(self, tmp: pathlib.Path) -> pathlib.Path:
        """Ein Konto mit Token in einer Test-Env-Datei (Wert = Kanarienvogel)."""
        file = tmp / "betreiber.env"
        file.write_text(
            f"# Test-Env-Datei\nGHCR_USERNAME=probeuser\nGHCR_TOKEN={self.TOKEN}\n",
            encoding="utf-8",
        )
        return file

    def _logs(self, tmp: pathlib.Path) -> dict[str, str]:
        """Log-Ziele fuer die Fakes. Die Schluessel SIND die Env-Namen - so
        koennen sie direkt in `clean_env(**logs)` gehen (Kleinschreibung hatte
        den Fake dazu gebracht, ins Leere zu schreiben)."""
        return {
            "FAKE_REGISTRY_DOCKER_LOG": str(tmp / "docker.log"),
            "FAKE_REGISTRY_DOCKER_STDIN": str(tmp / "docker.stdin"),
            "FAKE_SSH_LOG": str(tmp / "ssh.log"),
            "FAKE_RSYNC_LOG": str(tmp / "rsync.log"),
        }

    @staticmethod
    def _befehlszeilen(zweig: str) -> str:
        """Nur Befehlszeilen eines Zweigs: Kommentare und Ausgabetexte zaehlen
        nicht. Ein Kommentar oder eine Meldung, die `docker save` ERKLAERT
        („hier wird nicht gespeichert"), ist kein `docker save`-Aufruf."""
        behalten = []
        for line in zweig.splitlines():
            stripped = line.strip()
            if stripped.startswith("#") or stripped.startswith("echo ") or stripped.startswith("step "):
                continue
            behalten.append(line)
        return "\n".join(behalten)

    def _read(self, name: str) -> str:
        path = pathlib.Path(name)
        return path.read_text(encoding="utf-8") if path.exists() else ""

    def _lib(self, script: str, **env: str | None) -> subprocess.CompletedProcess:
        """Faehrt Funktionen der gemeinsamen Bibliothek (echter Codepfad)."""
        return subprocess.run(
            [self.BASH, "-c", "cd " + str(ROOT) + " && source scripts/hetzner/lib/registry.sh\n" + script],
            capture_output=True, text=True, cwd=ROOT, timeout=120, env=clean_env(**env),
        )

    # --- 1. Tag-/Namensbildung --------------------------------------------
    def test_tag_kommt_aus_dem_kurzhash_sonst_aus_der_version(self) -> None:
        # Default: `git rev-parse --short HEAD` des Repos (derselbe Tag, den der
        # Push setzt und der Pull sucht - eine Bibliothek, kein zweiter Begriff).
        head = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True,
            cwd=ROOT, timeout=60,
        ).stdout.strip()
        result = self._lib("registry_default_tag " + str(ROOT))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), head)
        # Ohne .git (z. B. ein entpacktes Archiv) faellt der Tag auf die
        # package.json-Version zurueck statt zu raten.
        with tempfile.TemporaryDirectory(prefix="reg-tag-") as tmp:
            tmpdir = pathlib.Path(tmp)
            (tmpdir / "package.json").write_text('{"version":"9.9.9"}', encoding="utf-8")
            fallback = self._lib(f"registry_default_tag {tmpdir}")
            self.assertEqual(fallback.returncode, 0, fallback.stderr)
            self.assertEqual(fallback.stdout.strip(), "9.9.9")

    def test_referenz_und_owner_werden_aus_dem_repo_gebildet(self) -> None:
        # Owner aus dem git-Remote (kein hartkodiertes Konto) und klein
        # geschrieben - GHCR lehnt Grossbuchstaben ab. Das Repo-Remote ist
        # `kAInplanmusic/audioMONASTRY`, die Referenz muss also `kainplanmusic`
        # nennen.
        result = self._lib(
            "registry_owner " + str(ROOT) + "\n"
            'registry_image "$(registry_owner ' + str(ROOT) + ')" "$(registry_app_name)" 1234abcd'
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        zeilen = result.stdout.split()
        self.assertEqual(zeilen[0], "kainplanmusic")
        self.assertEqual(zeilen[1], "ghcr.io/kainplanmusic/audiomonastry:1234abcd")
        # Der lokale Name bleibt der, den docker-compose.hetzner.yml erwartet.
        local = self._lib("printf '%s|%s\\n' \"$(registry_local_app)\" \"$(registry_local_master)\"")
        self.assertEqual(local.stdout.strip(), "audiomonastry:hetzner|audiomonastry-master-player:hetzner")
        compose = COMPOSE_BASE.read_text(encoding="utf-8")
        for name in ("audiomonastry:hetzner", "audiomonastry-master-player:hetzner"):
            self.assertIn(f"image: {name}", compose)

    # --- 2. Trockenlauf ----------------------------------------------------
    def test_trockenlauf_ist_netzfrei_und_nennt_beide_referenzen(self) -> None:
        with tempfile.TemporaryDirectory(prefix="reg-dry-") as tmp:
            tmpdir = pathlib.Path(tmp)
            # KEIN fake docker im PATH: der Trockenlauf darf Docker nicht brauchen.
            result = subprocess.run(
                [self.BASH, str(REGISTRY_PUSH), "--print-config"],
                capture_output=True, text=True, cwd=ROOT, timeout=60,
                env=clean_env(REGISTRY_ENV_FILE=str(self._env_file(tmpdir))),
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("ghcr.io/kainplanmusic/audiomonastry:", result.stdout)
            self.assertIn("ghcr.io/kainplanmusic/audiomonastry-master-player:", result.stdout)
            self.assertIn("audiomonastry:hetzner", result.stdout)
            self.assertIn("audiomonastry-master-player:hetzner", result.stdout)
            self.assertIn("Wert wird nie ausgegeben", result.stdout)
            # Der Trockenlauf nennt den Pull-Befehl - der Weg ist ohne Flotte lesbar.
            self.assertIn("DEPLOY_IMAGE_SOURCE=registry", result.stdout)
            # Und das Token taucht nirgends auf (auch nicht auf stderr).
            self.assertNotIn(self.TOKEN, result.stdout + result.stderr)

    def test_trockenlauf_zeigt_ueberschriebenen_tag(self) -> None:
        with tempfile.TemporaryDirectory(prefix="reg-dry-tag-") as tmp:
            result = subprocess.run(
                [self.BASH, str(REGISTRY_PUSH), "--tag", "roll-2026-09-21", "--print-config"],
                capture_output=True, text=True, cwd=ROOT, timeout=60,
                env=clean_env(REGISTRY_ENV_FILE="none", REGISTRY_OWNER="probe"),
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("ghcr.io/probe/audiomonastry:roll-2026-09-21", result.stdout)
            self.assertIn("ghcr.io/probe/audiomonastry-master-player:roll-2026-09-21", result.stdout)
            self.assertIn("Owner=probe", result.stdout)

    # --- 3. Push: Login per stdin, beide Images, idempotent ---------------
    def test_push_schickt_das_token_per_stdin_und_pusht_beide_images(self) -> None:
        with tempfile.TemporaryDirectory(prefix="reg-push-") as tmp:
            tmpdir = pathlib.Path(tmp)
            fake = self._fake_bin(tmpdir)
            logs = self._logs(tmpdir)
            result = subprocess.run(
                [self.BASH, str(REGISTRY_PUSH), "--skip-build", "--tag", "probe123"],
                capture_output=True, text=True, cwd=ROOT, timeout=120, stdin=subprocess.DEVNULL,
                env=clean_env(
                    REGISTRY_ENV_FILE=str(self._env_file(tmpdir)),
                    PATH=f"{fake}:{os.environ.get('PATH', '')}",
                    **logs,
                ),
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            aufrufe = self._read(logs["FAKE_REGISTRY_DOCKER_LOG"])
            self.assertIn(f"login ghcr.io -u probeuser --password-stdin", aufrufe)
            self.assertIn("tag audiomonastry:hetzner ghcr.io/kainplanmusic/audiomonastry:probe123", aufrufe)
            self.assertIn(
                "tag audiomonastry-master-player:hetzner ghcr.io/kainplanmusic/audiomonastry-master-player:probe123",
                aufrufe,
            )
            self.assertIn("push ghcr.io/kainplanmusic/audiomonastry:probe123", aufrufe)
            self.assertIn("push ghcr.io/kainplanmusic/audiomonastry-master-player:probe123", aufrufe)
            # --skip-build bedeutet: kein zweiter Build (der kostet ~25 min).
            self.assertNotIn("build ", aufrufe)
            # Der Wert kommt per stdin und NICHT als Argument und nicht in der Ausgabe.
            self.assertIn(self.TOKEN, self._read(logs["FAKE_REGISTRY_DOCKER_STDIN"]))
            self.assertNotIn(self.TOKEN, aufrufe)
            self.assertNotIn(self.TOKEN, result.stdout + result.stderr)

    def test_gleicher_tag_wird_nicht_zweimal_gepusht(self) -> None:
        with tempfile.TemporaryDirectory(prefix="reg-idem-") as tmp:
            tmpdir = pathlib.Path(tmp)
            fake = self._fake_bin(tmpdir)
            logs = self._logs(tmpdir)
            base_env = dict(
                REGISTRY_ENV_FILE=str(self._env_file(tmpdir)),
                PATH=f"{fake}:{os.environ.get('PATH', '')}",
                **logs,
            )
            args = [self.BASH, str(REGISTRY_PUSH), "--skip-build", "--tag", "probe123"]
            # Erster Lauf: `manifest inspect` scheitert (Tag fehlt) -> Push.
            first = subprocess.run(
                args, capture_output=True, text=True, cwd=ROOT, timeout=120,
                stdin=subprocess.DEVNULL, env=clean_env(**base_env),
            )
            self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
            self.assertIn("push ghcr.io/kainplanmusic/audiomonastry:probe123", self._read(logs["FAKE_REGISTRY_DOCKER_LOG"]))
            pathlib.Path(logs["FAKE_REGISTRY_DOCKER_LOG"]).write_text("", encoding="utf-8")
            # Zweiter Lauf: derselbe Tag ist in der Registry -> KEIN zweiter Push.
            second = subprocess.run(
                args, capture_output=True, text=True, cwd=ROOT, timeout=120,
                stdin=subprocess.DEVNULL,
                env=clean_env(**base_env, FAKE_REGISTRY_MANIFEST_EXIT="0"),
            )
            self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
            zweiter_lauf = self._read(logs["FAKE_REGISTRY_DOCKER_LOG"])
            self.assertIn("manifest inspect", zweiter_lauf)
            self.assertNotIn("push ", zweiter_lauf)
            self.assertIn("uebersprungen (Tag existiert schon)", second.stdout)
            # --force ist der bewusste Gegenweg (z. B. nach einem ueberschriebenen Tag).
            forced = subprocess.run(
                args + ["--force"], capture_output=True, text=True, cwd=ROOT, timeout=120,
                stdin=subprocess.DEVNULL,
                env=clean_env(**base_env, FAKE_REGISTRY_MANIFEST_EXIT="0"),
            )
            self.assertEqual(forced.returncode, 0, forced.stdout + forced.stderr)
            self.assertIn("push ghcr.io/kainplanmusic/audiomonastry:probe123", self._read(logs["FAKE_REGISTRY_DOCKER_LOG"]))

    def test_push_bricht_ohne_zugangsdaten_ab_statt_zu_raten(self) -> None:
        with tempfile.TemporaryDirectory(prefix="reg-nocreds-") as tmp:
            tmpdir = pathlib.Path(tmp)
            fake = self._fake_bin(tmpdir)
            result = subprocess.run(
                [self.BASH, str(REGISTRY_PUSH), "--skip-build"],
                capture_output=True, text=True, cwd=ROOT, timeout=120,
                stdin=subprocess.DEVNULL,
                env=clean_env(REGISTRY_ENV_FILE="none", PATH=f"{fake}:{os.environ.get('PATH', '')}",
                              **self._logs(tmpdir)),
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Keine GHCR-Zugangsdaten", result.stderr)
            self.assertEqual(self._read(str(tmpdir / "docker.log")), "", "ohne Zugangsdaten darf nichts laufen")

    # --- 4. Pull-Weg: login/pull/tag, KEIN save ---------------------------
    def test_pull_weg_loggt_ein_zieht_und_taggt_ohne_save(self) -> None:
        # Der Registry-Weg des Deploys, direkt an der Bibliothek gefahren (echter
        # Codepfad mit Fake-ssh, der den entfernten Befehl lokal ausfuehrt).
        with tempfile.TemporaryDirectory(prefix="reg-pull-") as tmp:
            tmpdir = pathlib.Path(tmp)
            fake = self._fake_bin(tmpdir, rsync=False, curl=False)
            logs = self._logs(tmpdir)
            result = self._lib(
                'registry_pull_images "" "root@10.0.0.1" "' + str(ROOT) + '" "' + str(self._env_file(tmpdir)) + '" '
                'audiomonastry:hetzner ghcr.io/probe/audiomonastry:probe123',
                PATH=f"{fake}:{os.environ.get('PATH', '')}",
                **logs,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            docker = self._read(logs["FAKE_REGISTRY_DOCKER_LOG"])
            ssh = self._read(logs["FAKE_SSH_LOG"])
            self.assertIn("login ghcr.io -u probeuser --password-stdin", docker)
            self.assertIn("pull ghcr.io/probe/audiomonastry:probe123", docker)
            self.assertIn("tag ghcr.io/probe/audiomonastry:probe123 audiomonastry:hetzner", docker)
            # Der Rollback-Tag kommt VOR dem Ersetzen des Images - sonst zeigte der
            # Rueckweg auf den neuen Stand.
            self.assertIn("docker image tag audiomonastry:hetzner audiomonastry:hetzner-rollback", ssh)
            self.assertLess(
                ssh.index("audiomonastry:hetzner-rollback"),
                ssh.index("docker pull"),
                "Rollback-Tag muss VOR dem Pull/Ersetzen gesetzt werden",
            )
            # Der Kern des Registry-Wegs: kein Image-Transfer.
            self.assertNotIn("save", docker)
            # Token wieder nur per stdin.
            self.assertIn(self.TOKEN, self._read(logs["FAKE_REGISTRY_DOCKER_STDIN"]))
            self.assertNotIn(self.TOKEN, docker + ssh)
            self.assertNotIn(self.TOKEN, result.stdout + result.stderr)

    # --- 5. Beide Deploy-Wege: Registry-Zweig vs. Default ------------------
    def test_registry_zweig_beider_skripte_hat_kein_docker_save(self) -> None:
        deploy = DEPLOY_SH.read_text(encoding="utf-8")
        live = FLEET_DEPLOY_LIVE.read_text(encoding="utf-8")
        # Der LETZTE Treffer ist der echte Image-Zweig: in deploy.sh steht der
        # Schalter auch im Build-Gate von Schritt [1/5] und in den Abbruchpruefungen.
        deploy_registry = deploy.split('if [[ "$DEPLOY_IMAGE_SOURCE" == "registry" ]]; then')[-1].split("\n  elif")[0]
        live_registry = live.split('if [[ "$IMAGE_SOURCE" == "registry" ]]; then')[1].split("\n  else")[0]
        for name, zweig in (("deploy.sh", deploy_registry), ("fleet-deploy-live.sh", live_registry)):
            with self.subTest(script=name):
                self.assertIn("registry_pull_images", zweig)
                self.assertNotIn(
                    "docker save", self._befehlszeilen(zweig),
                    "im Registry-Modus darf KEIN docker save laufen",
                )
        # Der Transfer bleibt der Default-Weg und dort steht der Transfer auch.
        self.assertIn('docker save "$IMAGE_APP" "$IMAGE_MASTER"', deploy)
        self.assertIn('docker save "$IMAGE"', live)
        for name, script in (("deploy.sh", deploy), ("fleet-deploy-live.sh", live)):
            with self.subTest(script=name):
                self.assertIn("local", script)
                self.assertIn("registry", script)

    def test_trockenlaeufe_zeigen_die_quelle_default_local(self) -> None:
        deploy = subprocess.run(
            [self.BASH, str(DEPLOY_SH)], capture_output=True, text=True, cwd=ROOT, timeout=60,
            env=clean_env(DEPLOY_PRINT_CONFIG="1", REGISTRY_ENV_FILE="none"),
        )
        self.assertEqual(deploy.returncode, 0, deploy.stdout + deploy.stderr)
        self.assertIn("DEPLOY_IMAGE_SOURCE=local", deploy.stdout)
        # Ohne Registry-Wahl bleiben die Referenzen leer - nichts schwenkt still um.
        self.assertIn("DEPLOY_REGISTRY_IMAGE=<leer>", deploy.stdout)
        live = subprocess.run(
            [self.BASH, str(FLEET_DEPLOY_LIVE), "--print-config"], capture_output=True, text=True,
            cwd=ROOT, timeout=60, env=clean_env(REGISTRY_ENV_FILE="none"),
        )
        self.assertEqual(live.returncode, 0, live.stderr)
        self.assertIn("DEPLOY_IMAGE_SOURCE=local", live.stdout)
        self.assertIn("DEPLOY_REGISTRY_IMAGE=<leer>", live.stdout)
        # Mit Wahl: die Referenz wird gezeigt (Default-Owner aus dem git-Remote).
        chosen = subprocess.run(
            [self.BASH, str(FLEET_DEPLOY_LIVE), "--print-config"], capture_output=True, text=True,
            cwd=ROOT, timeout=60,
            env=clean_env(REGISTRY_ENV_FILE="none", DEPLOY_IMAGE_SOURCE="registry",
                          DEPLOY_REGISTRY_IMAGE="ghcr.io/probe/app:probe123"),
        )
        self.assertEqual(chosen.returncode, 0, chosen.stderr)
        self.assertIn("DEPLOY_IMAGE_SOURCE=registry", chosen.stdout)
        self.assertIn("DEPLOY_REGISTRY_IMAGE=ghcr.io/probe/app:probe123", chosen.stdout)

    def test_unbekannte_quelle_und_node_modus_brechen_laut_ab(self) -> None:
        for script, args in ((DEPLOY_SH, []), (FLEET_DEPLOY_LIVE, ["--print-config"])):
            with self.subTest(script=script.name):
                env = clean_env(REGISTRY_ENV_FILE="none", DEPLOY_IMAGE_SOURCE="schmuggel")
                if script is DEPLOY_SH:
                    env = clean_env(REGISTRY_ENV_FILE="none", DEPLOY_IMAGE_SOURCE="schmuggel",
                                    DEPLOY_PRINT_CONFIG="1")
                result = subprocess.run(
                    [self.BASH, str(script), *args], capture_output=True, text=True,
                    cwd=ROOT, timeout=60, env=env,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("unbekannt", result.stderr)
        # Registry-Weg im node-Modus wird nicht still ignoriert.
        node = subprocess.run(
            [self.BASH, str(DEPLOY_SH)], capture_output=True, text=True, cwd=ROOT, timeout=60,
            env=clean_env(DEPLOY_PRINT_CONFIG="1", REGISTRY_ENV_FILE="none",
                          DEPLOY_IMAGE_SOURCE="registry", DEPLOY_MODE="node"),
        )
        self.assertNotEqual(node.returncode, 0)
        self.assertIn("DEPLOY_IMAGE_SOURCE=registry setzt DEPLOY_MODE=docker", node.stderr)

    # --- 6. Ende-zu-Ende: der Live-Weg zieht wirklich ----------------------
    def test_live_weg_zieht_im_registry_modus_und_speichert_im_default(self) -> None:
        """Faehrt `fleet-deploy-live.sh` KOMPLETT durch - mit Fakes fuer
        ssh/rsync/curl/docker, also ohne Knoten und ohne Netz.

        Das ist der eigentliche Beweis: im Registry-Modus laufen login/pull/tag
        und KEIN `docker save`; im Default-Modus laeuft `docker save` und KEIN
        pull. Die Aussagen kommen aus dem protokollierten Docker-Verhalten, nicht
        aus einer Textsuche im Skript.
        """
        with tempfile.TemporaryDirectory(prefix="reg-e2e-") as tmp:
            tmpdir = pathlib.Path(tmp)
            remote = tmpdir / "remote"
            remote.mkdir()
            # Medien-Overlay „liegt auf dem Knoten": der Weg muss es mitnehmen.
            (remote / "docker-compose.media.yml").write_text("services: {}\n", encoding="utf-8")
            (remote / "media").mkdir()
            (remote / "media" / "marker.txt").write_text("overlay\n", encoding="utf-8")
            fake = self._fake_bin(tmpdir, rsync=True, curl=True)
            logs = self._logs(tmpdir)
            base = dict(
                REGISTRY_ENV_FILE=str(self._env_file(tmpdir)),
                PATH=f"{fake}:{os.environ.get('PATH', '')}",
                DEPLOY_REMOTE_DIR=str(remote),
                FAKE_SSH_REPO=str(remote),
                FAKE_CURL_COMMIT="6786809",
                **logs,
            )
            args = [self.BASH, str(FLEET_DEPLOY_LIVE), "10.0.0.1"]

            registry = subprocess.run(
                args + [], capture_output=True, text=True, cwd=ROOT, timeout=180,
                stdin=subprocess.DEVNULL,
                env=clean_env(**base, DEPLOY_IMAGE_SOURCE="registry",
                              DEPLOY_REGISTRY_IMAGE="ghcr.io/probe/audiomonastry:probe123"),
            )
            self.assertEqual(registry.returncode, 0, registry.stdout + registry.stderr)
            docker = self._read(logs["FAKE_REGISTRY_DOCKER_LOG"])
            ssh = self._read(logs["FAKE_SSH_LOG"])
            self.assertIn("pull ghcr.io/probe/audiomonastry:probe123", docker)
            self.assertIn("tag ghcr.io/probe/audiomonastry:probe123 audiomonastry:hetzner", docker)
            self.assertNotIn("save", docker, "im Registry-Modus darf KEIN docker save laufen")
            # Der Container-Start nimmt das Medien-Overlay mit und baut nicht neu.
            self.assertIn("--no-build --remove-orphans", ssh)
            self.assertIn("-f docker-compose.media.yml", ssh)
            self.assertIn("COMPOSE_PROJECT_NAME=audiomonastry", ssh)

            pathlib.Path(logs["FAKE_REGISTRY_DOCKER_LOG"]).write_text("", encoding="utf-8")
            pathlib.Path(logs["FAKE_SSH_LOG"]).write_text("", encoding="utf-8")
            local = subprocess.run(
                args + [], capture_output=True, text=True, cwd=ROOT, timeout=180,
                stdin=subprocess.DEVNULL, env=clean_env(**base),
            )
            self.assertEqual(local.returncode, 0, local.stdout + local.stderr)
            docker_local = self._read(logs["FAKE_REGISTRY_DOCKER_LOG"])
            self.assertIn("save audiomonastry:hetzner", docker_local,
                          "der Default-Weg muss weiterhin docker save fahren")
            self.assertNotIn("pull ", docker_local)

    # --- 7. Doku ----------------------------------------------------------
    def test_doku_beschreibt_den_registry_weg(self) -> None:
        # Die Doku ist Teil des Vertrags: ein Weg, den niemand findet, existiert
        # fuer den Betrieb nicht.
        doc = HETZNER_DEPLOY_DOC.read_text(encoding="utf-8")
        for needle in ("registry-push.sh", "DEPLOY_IMAGE_SOURCE", "DEPLOY_REGISTRY_IMAGE", "docker save"):
            with self.subTest(needle=needle):
                self.assertIn(needle, doc)
# ---------------------------------------------------------------------------
# PERF-P1-005 (2026-09-21): Medien in Teilen ueber R2 statt EINEM ssh-Strom
# ---------------------------------------------------------------------------
# Gemessen: EIN TCP-Strom Betreiber -> Hetzner macht ~1 MB/s (200 MB in 3:14),
# 3,7 GB Medien also ~60 min - pro Knoten und je Lieferung. Der neue Weg packt
# jeden Baum deterministisch (zstd), legt ihn EINMAL in Cloudflare R2 (Egress
# kostenfrei) und laesst den Knoten mit `aria2c -x16 -s16` ziehen; der
# Betreiber-Host schiebt danach nichts mehr nach.
#
# Diese Klassen nageln fest, was OHNE Live-Infrastruktur pruefbar ist:
#   * Die Signatur (lib/r2-sigv4.sh) stimmt mit einer ZWEITEN, unabhaengigen
#     Umsetzung (Python hmac/hashlib) ueberein; die Schluessel erscheinen nie
#     in der Ausgabe und nie im Kommando des Knotens.
#   * Der Knoten zieht mit -x16/-s16, prueft SHA256 VOR dem Auspacken, packt
#     bei falschem Hash NICHTS aus, meldet Rate + Dateizahlen und loescht die
#     URL-Datei wieder (sie ist ein Bearer-Token).
#   * Ein zweiter Knoten zieht DASSELBE Objekt, ohne erneuten Upload.
#   * Trockenlauf (--print-config/--help) uebertraegt kein Byte.
#   * `deliver-media.sh --via-r2` liefert dieselben Baeume an dieselben Pfade
#     (Mount-/Ausschlusslogik unveraendert) und laedt je Baum EINMAL hoch.
#
# Gefahren wird der ECHTE Codepfad: Fake-`ssh` (fuehrt den Knotenbefehl lokal
# aus), Fake-`aria2c` (protokolliert seine Schalter, liefert die Datei aber
# wirklich - Hash-Pruefung und Auspacken laufen also echt), Fake-`curl`
# (protokolliert PUT/HEAD der Signatur) und Fake-`rsync` (nur der Medienweg).
# Kein Test kontaktiert R2, Hetzner oder die Flotte.

#: Nur TESTWERTE. Die Tests behaupten nicht, dass sie echt sind, sondern dass
#: genau diese Strings nie in Ausgabe/argv/auf dem Knoten auftauchen.
TEST_R2_ACCESS_KEY = "R2TESTACCESSKEY0001"
TEST_R2_SECRET_KEY = "r2-test-secret-0001-nur-fuer-den-test"
TEST_R2_HOST = "testaccount123.r2.cloudflarestorage.com"
TEST_R2_BUCKET = "audiomonastrysamples-nur-test"
TEST_SIGNED_AT = "20260921T120000Z"

#: Fake-ssh fuer ALLE Transfer-Tests: protokolliert den entfernten Befehl und
#: fuehrt ihn LOKAL aus. Der Knotenpfad /opt/audiomonastry wird auf den
#: Testbaum umgeschrieben - kein Knoten, kein Netz.
FAKE_SSH_RUN = r"""#!/usr/bin/env bash
set -uo pipefail
cmd="${*: -1}"
printf '%s\n' "$cmd" >> "${FAKE_SSH_LOG:?}"
exec bash -c "${cmd//\/opt\/audiomonastry/${FAKE_SSH_REPO:?}}"
"""

#: Fake-aria2c: protokolliert seine Schalter (Beweis fuer -x16/-s16) und liefert
#: die Datei WIRKLICH aus, damit SHA256-Pruefung und Auspacken im echten
#: Codepfad laufen. Quelle: echte http/file-URL (echter curl, kein Netz) oder -
#: bei der synthetischen R2-URL der Attrappe - das von parallel-transfer.sh
#: gepackte Archiv aus dem Test-TMPDIR.
FAKE_ARIA2 = r"""#!/usr/bin/env bash
set -uo pipefail
printf '%s\n' "$*" >> "${FAKE_ARIA2_LOG:?}"
args=("$@"); d=""; o=""
for ((i=0;i<${#args[@]};i++)); do
  case "${args[i]}" in -d) d="${args[i+1]}" ;; -o) o="${args[i+1]}" ;; esac
done
url="${args[${#args[@]}-1]}"
mkdir -p "$d"
case "$url" in
  file://*|http://127.0.0.1*|http://localhost*)
    "$REAL_CURL" -fsS -o "$d/$o" "$url" || exit $? ;;
  *)
    src="$(ls -t "${TMPDIR:-/tmp}"/am-parallel-transfer.*/"$o" 2>/dev/null | head -1)"
    if [[ -z "$src" ]]; then echo "fake-aria2c: kein Testarchiv fuer $o" >&2; exit 1; fi
    cp "$src" "$d/$o" ;;
esac
if [[ "${FAKE_ARIA2_CORRUPT:-0}" == "1" ]]; then printf 'X' >> "$d/$o"; fi
"""

#: Fake-curl: protokolliert jeden Aufruf (Beweis fuer das presignierte PUT) und
#: haelt einen winzigen Objektspeicher: HEAD auf einen zuvor per PUT angelegten
#: Schluessel antwortet 200, sonst 404 - genau das braucht r2_object_exists.
FAKE_CURL_R2 = r"""#!/usr/bin/env bash
set -uo pipefail
printf '%s\n' "$*" >> "${FAKE_CURL_LOG:?}"
method=GET
for ((i=1;i<=$#;i++)); do
  case "${!i}" in
    -X) j=$((i+1)); method="${!j}" ;;
    -I) method=HEAD ;;
  esac
done
# Die URL ist NICHT immer das letzte Argument (beim Upload steht -o /dev/null
# dahinter) - sie wird am Schema erkannt.
url=""
for arg in "$@"; do
  case "$arg" in http://*|https://*) url="$arg"; break ;; esac
done
key="${url#*://}"; key="${key%%\?*}"
case "$method" in
  HEAD)
    if grep -qxF "$key" "${FAKE_CURL_STATE:-/dev/null}" 2>/dev/null; then echo 200; else echo 404; fi
    exit 0 ;;
  PUT)
    printf '%s\n' "$key" >> "${FAKE_CURL_STATE:?}"
    exit 0 ;;
esac
exec "$REAL_CURL" "$@"
"""

#: Fake-rsync: protokolliert und legt die Datei in den Testbaum. Ziele der Form
#: root@<host>:<pfad> werden wie beim Fake-ssh umgeschrieben (Knoten = lokal).
FAKE_RSYNC = r"""#!/usr/bin/env bash
set -uo pipefail
printf '%s\n' "$*" >> "${FAKE_RSYNC_LOG:?}"
src="${@: -2:1}"
dest="${!#}"
target="$dest"
case "$dest" in
  *@*:*) target="${dest#*:}"; target="${target//\/opt\/audiomonastry/${FAKE_SSH_REPO:?}}" ;;
esac
if [[ -z "$target" ]]; then echo "fake-rsync: kein Ziel" >&2; exit 1; fi
mkdir -p "$(dirname "$target")"
cp -a "$src" "$target"
"""


def reference_presign_url(
    method: str,
    key: str,
    ttl: int,
    amzdate: str = TEST_SIGNED_AT,
    *,
    access: str = TEST_R2_ACCESS_KEY,
    secret: str = TEST_R2_SECRET_KEY,
    host: str = TEST_R2_HOST,
    bucket: str = TEST_R2_BUCKET,
    region: str = "auto",
) -> str:
    """UNABHAENGIGE SigV4-Referenz (Python hmac/hashlib) fuer presignierte R2-URLs.

    Bewusst als zweite Umsetzung geschrieben: die Bash-Version in
    `scripts/hetzner/lib/r2-sigv4.sh` muss Zeichen fuer Zeichen dasselbe
    Ergebnis liefern. Eine Signatur, die nur "irgendwie" aussieht, faellt damit
    im Test auf, statt erst live als SignatureDoesNotMatch.
    """
    def enc(value: str) -> str:
        return urllib.parse.quote(value, safe="-_.~")

    datestamp = amzdate.split("T")[0]
    scope = f"{datestamp}/{region}/s3/aws4_request"
    canonical_uri = "/" + enc(bucket) + "/" + "/".join(enc(part) for part in key.split("/"))
    query = "&".join([
        "X-Amz-Algorithm=AWS4-HMAC-SHA256",
        f"X-Amz-Credential={enc(f'{access}/{scope}')}",
        f"X-Amz-Date={amzdate}",
        f"X-Amz-Expires={ttl}",
        "X-Amz-SignedHeaders=host",
    ])
    canonical_request = "\n".join([method, canonical_uri, query, f"host:{host}", "", "host", "UNSIGNED-PAYLOAD"])
    string_to_sign = "\n".join([
        "AWS4-HMAC-SHA256", amzdate, scope,
        hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
    ])
    signing_key = hmac.new(("AWS4" + secret).encode("utf-8"), datestamp.encode("utf-8"), hashlib.sha256).digest()
    for part in (region, "s3", "aws4_request"):
        signing_key = hmac.new(signing_key, part.encode("utf-8"), hashlib.sha256).digest()
    signature = hmac.new(signing_key, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"https://{host}{canonical_uri}?{query}&X-Amz-Signature={signature}"


def make_tree(root: pathlib.Path, dateien: int = 3) -> pathlib.Path:
    """Kleiner Testbaum (Medien-Ersatz). Der Verzeichnisname ist wichtig: der
    Archiv-Wurzelordner und das Zielverzeichnis tragen denselben Namen."""
    (root / "sub").mkdir(parents=True, exist_ok=True)
    for i in range(dateien):
        (root / "sub" / f"datei{i}.sfz").write_text(f"inhalt {i}\n" * 20, encoding="utf-8")
    return root


def tree_files(root: pathlib.Path) -> list[str]:
    return sorted(str(p.relative_to(root)) for p in root.rglob("*") if p.is_file())


class TransferSandbox:
    """Fake-Binaries + Test-R2-Konfiguration fuer die Transfer-Tests.

    TMPDIR zeigt in den Sandkasten (der Fake-aria2c findet dort das gepackte
    Archiv; nichts bleibt in /tmp liegen), TRANSFER_TMP ist der Knoten-Temp-Pfad
    IM Sandkasten - der Fake-ssh fuehrt den Knotenbefehl lokal aus.
    """

    def _sandbox(self, tmp: pathlib.Path, *, with_aria2c: bool = True, with_rsync: bool = False,
                 **extra: str | None) -> dict[str, str]:
        fake_bin = tmp / "bin"
        fake_bin.mkdir(parents=True, exist_ok=True)
        for name, content, aktiv in (
            ("ssh", FAKE_SSH_RUN, True),
            ("aria2c", FAKE_ARIA2, with_aria2c),
            ("curl", FAKE_CURL_R2, True),
            ("rsync", FAKE_RSYNC, with_rsync),
        ):
            if not aktiv:
                continue
            pfad = fake_bin / name
            pfad.write_text(content, encoding="utf-8")
            pfad.chmod(0o755)
        (tmp / "curl-state").write_text("", encoding="utf-8")
        (tmp / "tmp").mkdir(exist_ok=True)
        # Der echte curl MUSS absolut referenziert werden: im Sandkasten liegt
        # ein Fake-`curl` im PATH, und `exec curl` wuerde sich selbst aufrufen.
        real_curl = shutil.which("curl") or "/usr/bin/curl"
        env = clean_env(
            PATH=f"{fake_bin}:{os.environ.get('PATH', '')}",
            REAL_CURL=real_curl,
            FAKE_SSH_LOG=str(tmp / "ssh.log"),
            FAKE_ARIA2_LOG=str(tmp / "aria2c.log"),
            FAKE_CURL_LOG=str(tmp / "curl.log"),
            FAKE_RSYNC_LOG=str(tmp / "rsync.log"),
            FAKE_CURL_STATE=str(tmp / "curl-state"),
            FAKE_SSH_REPO=str(tmp / "node"),
            TMPDIR=str(tmp / "tmp"),
            TRANSFER_TMP=str(tmp / "node" / "var" / "tmp" / "audiomonastry-transfer"),
            R2_ACCESS_KEY=TEST_R2_ACCESS_KEY,
            R2_SECRET_KEY=TEST_R2_SECRET_KEY,
            R2_ENDPOINT=f"https://{TEST_R2_HOST}",
            R2_BUCKET=TEST_R2_BUCKET,
            R2_REGION="auto",
        )
        for key, value in extra.items():
            if value is None:
                env.pop(key, None)
            else:
                env[key] = value
        return env

    @staticmethod
    def _log(tmp: pathlib.Path, name: str) -> str:
        pfad = tmp / name
        return pfad.read_text(encoding="utf-8") if pfad.exists() else ""

    def _pack(self, tmp: pathlib.Path, src: pathlib.Path, env: dict[str, str] | None = None) -> dict[str, str]:
        result = subprocess.run(
            [bash_path(), str(PARALLEL_TRANSFER), "--src", str(src), "--pack-only"],
            capture_output=True, text=True, cwd=ROOT, timeout=300,
            env=env if env is not None else self._sandbox(tmp),
        )
        combined = result.stdout + result.stderr
        self.assertEqual(result.returncode, 0, combined)
        return dict(
            line.split("=", 1) for line in result.stdout.splitlines()
            if line.startswith("PARALLEL_TRANSFER_")
        )

    def _run(self, tmp: pathlib.Path, *args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
        return subprocess.run(
            [bash_path(), str(PARALLEL_TRANSFER), *args],
            capture_output=True, text=True, cwd=ROOT, timeout=300,
            env=env if env is not None else self._sandbox(tmp),
        )

    @staticmethod
    def _node_exec_zeile(tmp: pathlib.Path) -> str:
        """Die Zeile des Fake-ssh-Protokolls, die den Knotenbefehl enthaelt."""
        for line in TransferSandbox._log(tmp, "ssh.log").splitlines():
            if line.startswith("TRANSFER_ENV_FILE="):
                return line
        return ""


class ParallelTransferSigV4Test(TransferSandbox, unittest.TestCase):
    """Die Signatur ist das Sicherheitsfundament des R2-Weges: der Knoten kommt
    ohne Zugangsschluessel aus, weil eine kurzlebige URL ihn ersetzt."""

    def setUp(self) -> None:
        self.bash = bash_path()
        for pfad in (PARALLEL_TRANSFER, R2_SIGV4_LIB, R2_NODE_FETCH):
            if not pfad.exists():  # pragma: no cover - Dateien sind eingecheckt
                self.fail(f"fehlt: {pfad}")

    def _presign(self, method: str, key: str, ttl: int = 3600, amzdate: str = TEST_SIGNED_AT) -> subprocess.CompletedProcess:
        env = clean_env(
            R2_ENV_FILE="/nonexistent",
            R2_ACCESS_KEY=TEST_R2_ACCESS_KEY,
            R2_SECRET_KEY=TEST_R2_SECRET_KEY,
            R2_ENDPOINT=f"https://{TEST_R2_HOST}",
            R2_BUCKET=TEST_R2_BUCKET,
            R2_REGION="auto",
        )
        return subprocess.run(
            [self.bash, "-c", 'source "$1"; r2_load_config && r2_presign "$2" "$3" "$4" "$5"', "_",
             str(R2_SIGV4_LIB), method, key, str(ttl), amzdate],
            capture_output=True, text=True, cwd=ROOT, timeout=60, env=env,
        )

    def test_signatur_stimmt_mit_unabhaengiger_umsetzung(self) -> None:
        for method, key, ttl in (
            ("GET", "transfer/orchestral/abc.tar.zst", 3600),
            ("GET", "transfer/orchestral/abc.tar.zst", 43200),
            ("PUT", "transfer/models/htdemucs.onnx.tar.zst", 60),
            ("HEAD", "transfer/music/demo.tar.zst", 300),
            # Leerzeichen + Umlaut + Sonderzeichen: die Prozentkodierung muss
            # byteweise (UTF-8) stimmen, sonst weist R2 die Signatur ab.
            ("GET", "transfer/VSCO 2 CE/Ümlaut & Test.sfz", 7200),
        ):
            with self.subTest(method=method, key=key):
                result = self._presign(method, key, ttl)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(
                    result.stdout.strip(),
                    reference_presign_url(method, key, ttl),
                    "Bash-SigV4 weicht von der unabhaengigen Referenz ab",
                )

    def test_secret_erscheint_nie_in_der_ausgabe(self) -> None:
        result = self._presign("GET", "transfer/orchestral/abc.tar.zst")
        combined = result.stdout + result.stderr
        self.assertNotIn(TEST_R2_SECRET_KEY, combined)
        # Die ACCESS-KEY-ID steckt konstruktionsbedingt im Scope der URL
        # (SigV4-Vertrag) - das Geheimnis nicht. Die URL ist ein Bearer-Token
        # und wird deshalb nie ausgegeben, sondern nur per stdin uebergeben.
        self.assertIn("X-Amz-Credential=", combined)
        self.assertIn("X-Amz-Signature=", combined)

    def test_ohne_schluessel_kein_presign_nur_klartext(self) -> None:
        env = clean_env(R2_ENV_FILE="/nonexistent")
        result = subprocess.run(
            [self.bash, "-c", 'source "$1"; r2_load_config || echo "KONFIG-FEHLT"; r2_key_fingerprint', "_",
             str(R2_SIGV4_LIB)],
            capture_output=True, text=True, cwd=ROOT, timeout=60, env=env,
        )
        self.assertIn("KONFIG-FEHLT", result.stdout)
        self.assertIn("kein-Key", result.stdout)


class ParallelTransferTrockenlaufTest(TransferSandbox, unittest.TestCase):
    """--print-config/--help sind die akzeptierte Nachweisform fuer Infra-
    Aenderungen: sie muessen die Wahrheit zeigen und dabei kein Byte bewegen."""

    def setUp(self) -> None:
        self.bash = bash_path()

    def test_print_config_ist_netzfrei_und_nennt_die_knoten_voraussetzung(self) -> None:
        with tempfile.TemporaryDirectory(prefix="p1f5-dry-") as tmpdir:
            tmp = pathlib.Path(tmpdir)
            src = make_tree(tmp / "orchestral")
            env = self._sandbox(tmp)
            result = self._run(tmp, "10.0.0.1", "--src", str(src), "--dest", "/opt/audiomonastry/media",
                               "--print-config", env=env)
            combined = result.stdout + result.stderr
            self.assertEqual(result.returncode, 0, combined)
            self.assertIn("kein Netz", combined)
            # Der 16-fach-Split und die Knoten-Voraussetzung muessen im
            # Trockenlauf stehen (sonst ueberrascht der erste echte Lauf).
            self.assertIn("aria2c -x16 -s16", combined)
            self.assertIn("apt-get install -y --no-install-recommends aria2 zstd", combined)
            self.assertIn("Rueckfall: curl -fL, EIN Strom", combined)
            self.assertIn("deterministisch", combined)
            self.assertIn("Erwartungswert", combined)
            # NICHTS bewegt: kein ssh, kein aria2c, kein curl, kein Archiv.
            self.assertEqual(self._log(tmp, "ssh.log"), "")
            self.assertEqual(self._log(tmp, "aria2c.log"), "")
            self.assertEqual(self._log(tmp, "curl.log"), "")
            self.assertEqual(list((tmp / "tmp").glob("am-parallel-transfer.*")), [])

    def test_print_config_funktioniert_ohne_r2_schluessel(self) -> None:
        with tempfile.TemporaryDirectory(prefix="p1f5-dry-") as tmpdir:
            tmp = pathlib.Path(tmpdir)
            src = make_tree(tmp / "models")
            env = self._sandbox(tmp, R2_ACCESS_KEY=None, R2_SECRET_KEY=None, R2_BUCKET=None, R2_ENDPOINT=None)
            env["R2_ENV_FILE"] = "/nonexistent"
            result = self._run(tmp, "10.0.0.1", "--src", str(src), "--dest", "/opt/audiomonastry/media",
                               "--print-config", env=env)
            combined = result.stdout + result.stderr
            self.assertEqual(result.returncode, 0, combined)
            self.assertIn("FEHLEN (nur fuer den echten Lauf noetig)", combined)

    def test_help_zeigt_hilfe_ohne_netz_und_ohne_ip(self) -> None:
        with tempfile.TemporaryDirectory(prefix="p1f5-dry-") as tmpdir:
            tmp = pathlib.Path(tmpdir)
            env = self._sandbox(tmp)
            for flag in ("--help", "-h"):
                with self.subTest(flag=flag):
                    result = self._run(tmp, flag, env=env)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertIn("Aufruf:", result.stdout)
                    self.assertIn("--print-config", result.stdout)
                    self.assertEqual(result.stderr, "", "Hilfe darf nichts auf stderr schreiben")
            self.assertEqual(self._log(tmp, "ssh.log"), "")
            self.assertEqual(self._log(tmp, "aria2c.log"), "")

    def test_fehlerhafte_aufrufe_brechen_mit_klartext_ab(self) -> None:
        with tempfile.TemporaryDirectory(prefix="p1f5-dry-") as tmpdir:
            tmp = pathlib.Path(tmpdir)
            src = make_tree(tmp / "orchestral")
            env = self._sandbox(tmp)
            faelle = {
                "Knoten-IP fehlt": (["--src", str(src), "--dest", "/opt/audiomonastry/media"], env),
                "Quelle fehlt": (["10.0.0.1", "--dest", "/opt/audiomonastry/media"], env),
                "--dest <ziel auf dem knoten> fehlt": (["10.0.0.1", "--src", str(src)], env),
                "--source-url verlangt --sha256": (
                    ["10.0.0.1", "--src", str(src), "--dest", "/x", "--source-url", "https://example.invalid/a.tar.zst"],
                    env,
                ),
                "Unbekannte Option": (["--quatsch"], env),
            }
            for erwartet, (args, umgebung) in faelle.items():
                with self.subTest(fall=erwartet):
                    result = self._run(tmp, *args, env=umgebung)
                    combined = result.stdout + result.stderr
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(erwartet, combined)

    def test_ohne_r2_schluessel_bricht_der_echte_lauf_vor_dem_packen_ab(self) -> None:
        with tempfile.TemporaryDirectory(prefix="p1f5-dry-") as tmpdir:
            tmp = pathlib.Path(tmpdir)
            src = make_tree(tmp / "orchestral")
            env = self._sandbox(tmp, R2_ACCESS_KEY=None, R2_SECRET_KEY=None, R2_BUCKET=None, R2_ENDPOINT=None)
            env["R2_ENV_FILE"] = "/nonexistent"
            result = self._run(tmp, "10.0.0.1", "--src", str(src), "--dest", "/opt/audiomonastry/media", env=env)
            combined = result.stdout + result.stderr
            self.assertEqual(result.returncode, 2, combined)
            self.assertIn("R2-Zugangsdaten fehlen", combined)
            self.assertIn("NIE ausgegeben", combined)
            self.assertEqual(self._log(tmp, "ssh.log"), "", "ohne Schluessel darf kein ssh laufen")
            self.assertEqual(self._log(tmp, "aria2c.log"), "")
            # Und es wurde nicht gepackt (kein Gigabyte durch zstd, um dann
            # festzustellen, dass der Endpoint fehlt).
            self.assertEqual(list((tmp / "tmp").glob("am-parallel-transfer.*/*.tar.zst")), [])


class ParallelTransferKnotenVertragTest(TransferSandbox, unittest.TestCase):
    """Der Knoten-Vertrag: 16 Verbindungen, Integritaet VOR dem Auspacken,
    lauter Rueckfall ohne aria2c, Rate und Dateizahlen in der Ausgabe."""

    def setUp(self) -> None:
        self.bash = bash_path()

    def _vorbereitet(self, tmp: pathlib.Path, **extra: str | None):
        src = make_tree(tmp / "srcs" / "orchestral")
        env = self._sandbox(tmp, **extra)
        felder = self._pack(tmp, src, env=env)
        return src, env, felder

    @staticmethod
    def _args(ip: str, src: pathlib.Path, felder: dict[str, str], dest: pathlib.Path) -> list[str]:
        return [
            ip,
            "--src", str(src), "--dest", str(dest),
            "--source-url", f"file://{felder['PARALLEL_TRANSFER_ARCHIVE']}",
            "--sha256", felder["PARALLEL_TRANSFER_SHA256"],
            "--files", felder["PARALLEL_TRANSFER_FILES"],
        ]

    def test_knoten_zieht_mit_16_verbindungen_prueft_hash_und_packt_aus(self) -> None:
        with tempfile.TemporaryDirectory(prefix="p1f5-node-") as tmpdir:
            tmp = pathlib.Path(tmpdir)
            src, env, felder = self._vorbereitet(tmp)
            dest = tmp / "ziel"
            result = self._run(tmp, *self._args("10.0.0.1", src, felder, dest), env=env)
            combined = result.stdout + result.stderr
            self.assertEqual(result.returncode, 0, combined)

            aufruf = self._log(tmp, "aria2c.log")
            self.assertIn("-x16", aufruf, f"kein 16-fach-Split: {aufruf!r}")
            self.assertIn("-s16", aufruf)
            self.assertIn("-k1M", aufruf)
            self.assertIn("--allow-overwrite=true", aufruf)

            self.assertIn("TRANSFER_SHA256_OK=1", combined)
            self.assertIn("TRANSFER_RESULT=ok", combined)
            self.assertIn("TRANSFER_RATE_MBPS=", combined)
            self.assertIn("TRANSFER_FILES=3", combined)
            # Der Betreiber vergleicht die Knoten-Rate mit dem gemessenen
            # EIN-Strom-Referenzwert (Erwartungswert, kein Messwert).
            self.assertIn("Referenz EIN Strom", combined)
            self.assertIn("Faktor:", combined)
            self.assertIn("Dateizahlen:           erwartet 3, auf dem Knoten 3", combined)
            # Ausgepackt: identischer Baum am Ziel.
            self.assertEqual(tree_files(dest / "orchestral"), tree_files(src))
            # URL-Datei und Archiv sind weg (die URL ist ein Bearer-Token).
            remote = tmp / "node" / "var" / "tmp" / "audiomonastry-transfer"
            self.assertEqual(sorted(p.name for p in remote.iterdir()), ["r2-node-fetch.sh"])
            # Die URL stand NICHT im Kommando des Knotens (argv/ps), sondern nur
            # in der 0600-Datei, die der Knoten selbst wieder loescht.
            self.assertNotIn("file://", self._node_exec_zeile(tmp))
            self.assertIn("umask 077; cat > ", self._log(tmp, "ssh.log"))
            self.assertIn("/transfer.env'", self._log(tmp, "ssh.log"))

    def test_falscher_hash_packt_nichts_aus(self) -> None:
        with tempfile.TemporaryDirectory(prefix="p1f5-node-") as tmpdir:
            tmp = pathlib.Path(tmpdir)
            src, env, felder = self._vorbereitet(tmp, FAKE_ARIA2_CORRUPT="1")
            dest = tmp / "ziel"
            result = self._run(tmp, *self._args("10.0.0.1", src, felder, dest), env=env)
            combined = result.stdout + result.stderr
            self.assertEqual(result.returncode, 3, combined)
            self.assertIn("TRANSFER_SHA256_OK=0", combined)
            self.assertIn("NICHT ausgepackt", combined)
            self.assertIn("TRANSFER_RESULT=sha256-mismatch", combined)
            # Kernzusage: der Zielbaum bleibt leer - kein halb ausgepacktes
            # Medienverzeichnis, das im Container wie ein Feature aussieht.
            self.assertFalse(dest.exists() and any(dest.rglob("*")), "trotz falschem Hash ausgepackt")
            # Kaputtes Archiv und Parameterdatei sind entfernt.
            remote = tmp / "node" / "var" / "tmp" / "audiomonastry-transfer"
            self.assertEqual(sorted(p.name for p in remote.iterdir()), ["r2-node-fetch.sh"])

    def test_ohne_aria2c_lauter_rueckfall_auf_einen_curl_strom(self) -> None:
        with tempfile.TemporaryDirectory(prefix="p1f5-node-") as tmpdir:
            tmp = pathlib.Path(tmpdir)
            src = make_tree(tmp / "srcs" / "orchestral")
            env = self._sandbox(tmp, with_aria2c=False)
            felder = self._pack(tmp, src, env=env)
            dest = tmp / "ziel"
            result = self._run(tmp, *self._args("10.0.0.1", src, felder, dest), env=env)
            combined = result.stdout + result.stderr
            self.assertEqual(result.returncode, 0, combined)
            self.assertIn("aria2c fehlt", combined)
            self.assertIn("apt-get install -y --no-install-recommends aria2 zstd", combined)
            self.assertIn("TRANSFER_METHOD=curl (Einzelstrom)", combined)
            self.assertEqual(self._log(tmp, "aria2c.log"), "")
            # Auch ohne aria2c wird geprueft und ausgepackt.
            self.assertIn("TRANSFER_SHA256_OK=1", combined)
            self.assertEqual(tree_files(dest / "orchestral"), tree_files(src))

    def test_dateizahl_abweichung_bricht_ab(self) -> None:
        with tempfile.TemporaryDirectory(prefix="p1f5-node-") as tmpdir:
            tmp = pathlib.Path(tmpdir)
            src, env, felder = self._vorbereitet(tmp)
            dest = tmp / "ziel"
            args = self._args("10.0.0.1", src, felder, dest)
            args[args.index("--files") + 1] = "999"
            result = self._run(tmp, *args, env=env)
            combined = result.stdout + result.stderr
            self.assertEqual(result.returncode, 4, combined)
            self.assertIn("Dateizahl stimmt nicht", combined)
            self.assertIn("TRANSFER_RESULT=file-count-mismatch", combined)

    def test_tar_modus_liefert_einen_vorhandenen_tar_und_zaehlt_das_ziel(self) -> None:
        # `--tar` ist der zweite beworbene Eingang (z. B. ein Image-Tar). Der
        # Inhalt ist unbekannt, deshalb wird das ZIELVERZEICHNIS gezaehlt und
        # ohne --files NICHT verglichen (sonst waere der Modus unbrauchbar).
        with tempfile.TemporaryDirectory(prefix="p1f5-tar-") as tmpdir:
            tmp = pathlib.Path(tmpdir)
            inhalt = make_tree(tmp / "image" / "inner", dateien=2)
            (tmp / "image" / "README.txt").write_text("image-tar\n", encoding="utf-8")
            tar_pfad = tmp / "app-image.tar"
            subprocess.run(["tar", "-cf", str(tar_pfad), "-C", str(tmp / "image"), "."],
                           check=True, cwd=ROOT, timeout=60)
            env = self._sandbox(tmp)
            packed = subprocess.run(
                [bash_path(), str(PARALLEL_TRANSFER), "--tar", str(tar_pfad), "--pack-only"],
                capture_output=True, text=True, cwd=ROOT, timeout=300, env=env,
            )
            self.assertEqual(packed.returncode, 0, packed.stdout + packed.stderr)
            felder = dict(line.split("=", 1) for line in packed.stdout.splitlines()
                          if line.startswith("PARALLEL_TRANSFER_"))
            dest = tmp / "ziel"
            result = self._run(
                tmp, "10.0.0.1", "--tar", str(tar_pfad), "--dest", str(dest),
                "--source-url", f"file://{felder['PARALLEL_TRANSFER_ARCHIVE']}",
                "--sha256", felder["PARALLEL_TRANSFER_SHA256"], env=env,
            )
            combined = result.stdout + result.stderr
            self.assertEqual(result.returncode, 0, combined)
            self.assertIn("TRANSFER_RESULT=ok", combined)
            self.assertIn("auf dem Knoten 3", combined)
            self.assertEqual(sorted(str(p.relative_to(dest)) for p in dest.rglob("*") if p.is_file()),
                             sorted(tree_files(tmp / "image")))
            self.assertTrue(inhalt.exists())

    def test_packen_ist_deterministisch_und_mtime_unabhaengig(self) -> None:
        with tempfile.TemporaryDirectory(prefix="p1f5-det-") as tmpdir:
            tmp = pathlib.Path(tmpdir)
            src = make_tree(tmp / "srcs" / "orchestral")
            env = self._sandbox(tmp)
            erste = self._pack(tmp, src, env=env)
            # Nur die mtime aendern: derselbe Inhalt MUSS denselben Hash geben -
            # sonst laedt jeder Lauf ein neues Objekt nach R2 hoch und die
            # Zeitersparnis des Zwischenspeichers ist weg.
            os.utime(src / "sub" / "datei0.sfz", (1_600_000_000, 1_600_000_000))
            zweite = self._pack(tmp, src, env=env)
            self.assertEqual(erste["PARALLEL_TRANSFER_SHA256"], zweite["PARALLEL_TRANSFER_SHA256"])
            self.assertEqual(erste["PARALLEL_TRANSFER_KEY"], zweite["PARALLEL_TRANSFER_KEY"])
            self.assertIn("/orchestral/", erste["PARALLEL_TRANSFER_KEY"])
            self.assertIn(".tar.zst", erste["PARALLEL_TRANSFER_KEY"])


class ParallelTransferR2WegTest(TransferSandbox, unittest.TestCase):
    """Der R2-Zwischenspeicher: EINMAL hochladen, danach zieht jeder Knoten -
    und der Knoten sieht dabei nur eine signierte URL."""

    def setUp(self) -> None:
        self.bash = bash_path()

    def _zwei_knoten(self, tmp: pathlib.Path, src: pathlib.Path, env: dict[str, str]):
        args = ["--src", str(src), "--dest", "/opt/audiomonastry/media", "--name", "orchestral"]
        erst = self._run(tmp, "10.10.0.1", *args, env=env)
        zweit = self._run(tmp, "10.10.0.2", *args, env=env)
        return erst, zweit

    def test_ein_upload_danach_zieht_der_zweite_knoten_aus_r2(self) -> None:
        with tempfile.TemporaryDirectory(prefix="p1f5-r2-") as tmpdir:
            tmp = pathlib.Path(tmpdir)
            src = make_tree(tmp / "srcs" / "orchestral")
            env = self._sandbox(tmp)
            erst, zweit = self._zwei_knoten(tmp, src, env)
            combined = erst.stdout + erst.stderr
            self.assertEqual(erst.returncode, 0, combined)
            self.assertIn("hochgeladen", combined)
            self.assertIn("presignierte GET-URL erzeugt", combined)

            puts = [line for line in self._log(tmp, "curl.log").splitlines() if "-X PUT" in line]
            self.assertEqual(len(puts), 1, f"kein einzelnes presigned PUT: {puts!r}")
            self.assertIn("X-Amz-Signature", puts[0])
            self.assertIn("X-Amz-Expires", puts[0])
            # Der Objekt-Schluessel traegt den Archiv-Hash: gleicher Inhalt =
            # gleiches Objekt = kein zweiter Upload.
            self.assertIn("/transfer/orchestral/", puts[0])
            self.assertNotIn(TEST_R2_SECRET_KEY, puts[0])

            # Geheimnisse: nie in der Ausgabe, nie im Kommando des Knotens.
            ssh_log = self._log(tmp, "ssh.log")
            self.assertNotIn(TEST_R2_SECRET_KEY, combined + ssh_log)
            self.assertNotIn("X-Amz-Signature", ssh_log, "die signierte URL darf nicht in argv/ps stehen")
            self.assertNotIn("X-Amz-Signature", combined, "die URL ist ein Bearer-Token")

            # Der zweite Knoten zieht dasselbe Objekt: HEAD 200 -> kein Upload.
            combined_zweit = zweit.stdout + zweit.stderr
            self.assertEqual(zweit.returncode, 0, combined_zweit)
            self.assertIn("schon vorhanden - KEIN erneuter Upload", combined_zweit)
            puts_zweit = [line for line in self._log(tmp, "curl.log").splitlines() if "-X PUT" in line]
            self.assertEqual(len(puts_zweit), 1, "der zweite Knoten hat erneut hochgeladen")
            # Beide Knoten haben den vollstaendigen Baum.
            self.assertEqual(tree_files(tmp / "node" / "media" / "orchestral"), tree_files(src))
            self.assertIn("TRANSFER_RESULT=ok", combined_zweit)

    def test_force_upload_laedt_trotz_vorhandenem_objekt(self) -> None:
        with tempfile.TemporaryDirectory(prefix="p1f5-r2-") as tmpdir:
            tmp = pathlib.Path(tmpdir)
            src = make_tree(tmp / "srcs" / "models", dateien=2)
            env = self._sandbox(tmp)
            args = ["--src", str(src), "--dest", "/opt/audiomonastry/media", "--name", "models"]
            self.assertEqual(self._run(tmp, "10.10.0.1", *args, env=env).returncode, 0)
            erneut = self._run(tmp, "10.10.0.1", *args, "--force-upload", env=env)
            self.assertEqual(erneut.returncode, 0, erneut.stdout + erneut.stderr)
            puts = [line for line in self._log(tmp, "curl.log").splitlines() if "-X PUT" in line]
            self.assertEqual(len(puts), 2)


class DeliverMediaViaR2Test(TransferSandbox, unittest.TestCase):
    """`deliver-media.sh --via-r2`: derselbe Weg fuer die Medienbaeume, ohne
    Aenderung an Ausschluss-/Mount-Logik (README: READ-ONLY nach /app/dist)."""

    def setUp(self) -> None:
        self.bash = bash_path()
        self.text = DELIVER_MEDIA.read_text(encoding="utf-8")

    def _zweige(self) -> tuple[str, str]:
        """(R2-Zweig, rsync-Zweig) - zerlegt an den Verzweigungen, nicht an
        Zeilennummern. Der Anker ist `transfer_r2() {`, weil `$VIA_R2` auch im
        Trockenlauf-Block vorkommt."""
        r2_teil = self.text.split("transfer_r2() {", 1)[1]
        r2_zweig, rest = r2_teil.split('if [[ "$VIA_R2" == "1" ]]; then', 1)[1].split("\nelse\n", 1)
        return r2_zweig, rest.split("\nfi\n", 1)[0]

    def test_r2_zweig_nutzt_parallel_transfer_und_laesst_die_rsync_logik_stehen(self) -> None:
        r2_zweig, rsync_zweig = self._zweige()
        self.assertIn("--via-r2", self.text)
        for name in ("orchestral", "models", "music"):
            with self.subTest(baum=name):
                self.assertIn(f'transfer_r2 "$SRC_{name.upper()}" {name}', r2_zweig)
        # Der R2-Zweig schiebt KEINEN Baum per rsync (nur der kleine Overlay-Rest
        # laeuft weiter ueber rsync - und zwar in beiden Wegen).
        for verboten in ("rsync -az --info=stats2", "$SRC_ORCHESTRAL/", "$SRC_MODELS/"):
            with self.subTest(verboten=verboten):
                self.assertNotIn(verboten, r2_zweig)
        # Der rsync-Weg bleibt vollstaendig erhalten (Rueckfall ohne R2).
        self.assertIn('"$SRC_ORCHESTRAL/" "root@$IP:$MEDIA_DIR/orchestral/"', rsync_zweig)
        self.assertIn('"$SRC_MODELS/" "root@$IP:$MEDIA_DIR/models/"', rsync_zweig)
        # Ziel ist in beiden Wegen dasselbe MEDIA_DIR; ohne aria2c wird
        # nachinstalliert (abschaltbar) - sonst bliebe es bei EINEM Strom.
        self.assertIn('--dest "$MEDIA_DIR"', self.text)
        self.assertIn('--name "$name"', self.text)
        self.assertIn('[[ "${MEDIA_R2_NO_INSTALL:-0}" == "1" ]] || args+=(--install-missing)', self.text)

    def test_mount_logik_bleibt_readonly_und_unveraendert(self) -> None:
        overlay = COMPOSE_MEDIA.read_text(encoding="utf-8")
        for mount in (
            "./media/orchestral:/app/dist/data/orchestral:ro",
            "./media/models:/app/dist/models:ro",
            "./media/music:/app/dist/music:ro",
        ):
            with self.subTest(mount=mount):
                self.assertIn(mount, overlay)
        # Das Overlay wird in BEIDEN Wegen ausgeliefert: die Zeile steht VOR der
        # Verzweigung, also vor dem R2-/rsync-Zweig.
        self.assertLess(
            self.text.index('rsync -az -e "$RSYNC_E" docker-compose.media.yml'),
            self.text.index('transfer_r2() {'),
        )

    def test_trockenlauf_kuendigt_den_r2_weg_an(self) -> None:
        ohne = subprocess.run([self.bash, str(DELIVER_MEDIA), "--print-config"],
                              capture_output=True, text=True, cwd=ROOT, timeout=120, env=clean_env())
        mit = subprocess.run([self.bash, str(DELIVER_MEDIA), "10.0.0.1", "--via-r2", "--print-config"],
                             capture_output=True, text=True, cwd=ROOT, timeout=120, env=clean_env())
        self.assertEqual(ohne.returncode, 0, ohne.stderr)
        self.assertEqual(mit.returncode, 0, mit.stderr)
        self.assertIn("rsync ueber EINEN ssh-Strom", ohne.stdout)
        self.assertIn("--via-r2", ohne.stdout)
        self.assertIn("aria2c -x16 -s16", mit.stdout)
        self.assertIn("apt-get install -y --no-install-recommends aria2 zstd", mit.stdout)
        self.assertIn("Erwartungswert", mit.stdout)

    def test_via_r2_liefert_beide_baeume_an_dieselben_pfade(self) -> None:
        with tempfile.TemporaryDirectory(prefix="p1f5-media-") as tmpdir:
            tmp = pathlib.Path(tmpdir)
            orchestral = make_tree(tmp / "srcs" / "orchestral", dateien=4)
            models = make_tree(tmp / "srcs" / "models", dateien=2)
            (models / "htdemucs.onnx").write_text("onnx-ersatz\n" * 50, encoding="utf-8")
            env = self._sandbox(
                tmp, with_rsync=True,
                MEDIA_SRC_ORCHESTRAL=str(orchestral),
                MEDIA_SRC_MODELS=str(models),
            )
            result = subprocess.run(
                [self.bash, str(DELIVER_MEDIA), "10.10.0.3", "--via-r2", "--no-start"],
                capture_output=True, text=True, cwd=ROOT, timeout=300, env=env,
            )
            combined = result.stdout + result.stderr
            self.assertEqual(result.returncode, 0, combined)
            node = tmp / "node"
            # Dieselben Pfade wie im rsync-Weg: media/<baum> (READ-ONLY gemountet).
            self.assertEqual(tree_files(node / "media" / "orchestral"), tree_files(orchestral))
            self.assertEqual(tree_files(node / "media" / "models"), tree_files(models))
            self.assertTrue((node / "media" / "models" / "htdemucs.onnx").exists())
            # Genau EIN Upload je Baum; music ist nicht Teil der Lieferung.
            puts = [line for line in self._log(tmp, "curl.log").splitlines() if "-X PUT" in line]
            self.assertEqual(len(puts), 2, puts)
            self.assertIn("via R2", combined)
            # Der kleine Overlay-Rest laeuft weiter ueber rsync; die Baeume NICHT.
            rsync_log = self._log(tmp, "rsync.log")
            self.assertIn("docker-compose.media.yml", rsync_log)
            self.assertIn("deliver-media.sh", rsync_log)
            self.assertNotIn("srcs/orchestral", rsync_log)
            self.assertNotIn("srcs/models", rsync_log)
            # --no-start: kein Compose-Aufruf auf dem Knoten (der Lauf endet mit
            # dem Hinweis auf den naechsten Schritt).
            self.assertNotIn("docker compose", self._log(tmp, "ssh.log"))
            self.assertIn("Start uebersprungen", combined)


class TransferSyntaxTest(unittest.TestCase):
    """bash -n fuer die vier Dateien dieses Weges (Skript, zwei libs, Nutzer)."""

    def test_bash_syntax_ist_sauber(self) -> None:
        bash = bash_path()
        for pfad in (PARALLEL_TRANSFER, R2_SIGV4_LIB, R2_NODE_FETCH, DELIVER_MEDIA):
            with self.subTest(script=pfad.name):
                result = subprocess.run([bash, "-n", str(pfad)], capture_output=True, text=True, cwd=ROOT, timeout=60)
                self.assertEqual(result.returncode, 0, result.stderr)


class RegistryCredentialPrecedenceTest(unittest.TestCase):
    """PROD-P2-REG-Fix (2026-09-21): Die .env-DATEI gewinnt gegen die Umgebung.

    Gemessen: die Prozessumgebung des Betreiber-Rechners trug ein VERALTETES
    GHCR_PASSWORD (FP afab6df9), .env den gueltigen Token (FP b2e16ea5). Die
    fruehere Fassung nahm die Umgebung vorrangig und las die Datei nie -> der
    Login endete still in `denied: denied`, obwohl derselbe Aufruf mit den Werten
    aus .env sofort gelang. Dieser Test haelt die neue Reihenfolge fest.
    """

    # Wurzel aus der Dateilage, nicht aus einer Modulkonstante: die Testdatei
    # kennt keine REPO_ROOT (gemessen 2026-09-21, NameError).
    ROOT = pathlib.Path(__file__).resolve().parents[1]
    LIB = str(ROOT / "scripts" / "hetzner" / "lib" / "registry.sh")

    def test_datei_gewinnt_gegen_umgebung(self):
        with tempfile.TemporaryDirectory() as tmp:
            env_datei = os.path.join(tmp, ".env")
            with open(env_datei, "w", encoding="utf-8") as f:
                f.write("GHCR_USERNAME=aus-der-datei\nGHCR_TOKEN=datei-token-richtig\n")
            skript = (
                f"set -u; source {shlex.quote(self.LIB)}; "
                f"registry_load_credentials {shlex.quote(str(self.ROOT))} {shlex.quote(env_datei)} "
                '&& printf "%s|%s" "$REGISTRY_USER" "$REGISTRY_PASS"'
            )
            umgebung = dict(os.environ)
            umgebung["GHCR_PASSWORD"] = "veraltetes-umgebungs-token"
            umgebung.pop("GHCR_TOKEN", None)
            r = subprocess.run(["bash", "-c", skript], capture_output=True, text=True, env=umgebung)
            self.assertEqual(
                r.stdout.strip(), "aus-der-datei|datei-token-richtig",
                f"Es muss die Datei gelten, nicht die Umgebung. stdout={r.stdout!r} stderr={r.stderr!r}",
            )
            self.assertIn("widersprechen sich", r.stderr, "Der Widerspruch muss gemeldet werden.")
            self.assertNotIn("veraltetes-umgebungs-token", r.stdout + r.stderr,
                             "Der WERT darf nie in der Ausgabe stehen - nur der Fingerabdruck.")

    def test_ohne_umgebung_liest_die_datei(self):
        with tempfile.TemporaryDirectory() as tmp:
            env_datei = os.path.join(tmp, ".env")
            with open(env_datei, "w", encoding="utf-8") as f:
                f.write("GHCR_USERNAME=nur-datei\nGHCR_TOKEN=nur-datei-token\n")
            skript = (
                f"set -u; source {shlex.quote(self.LIB)}; "
                f"registry_load_credentials {shlex.quote(str(self.ROOT))} {shlex.quote(env_datei)} "
                '&& printf "%s|%s" "$REGISTRY_USER" "$REGISTRY_PASS"'
            )
            umgebung = {k: v for k, v in os.environ.items()
                        if not k.startswith("GHCR_") and k != "REGISTRY_PASSWORD"}
            r = subprocess.run(["bash", "-c", skript], capture_output=True, text=True, env=umgebung)
            self.assertEqual(r.stdout.strip(), "nur-datei|nur-datei-token")


class R2CredentialPrecedenceTest(unittest.TestCase):
    """R2-Zugangsdaten: die .env-DATEI gewinnt gegen die Prozessumgebung.

    Gemessen 2026-09-21: die Umgebung trug veraltete/fremde R2-Schluessel
    (R2_ACCESS_KEY FP e1f0bbcd, CLOUDFLARE_ACCESS_KEY_ID FP 1b8ac015) neben dem
    gueltigen Satz aus .env (CFS3_ACCESS_KEY FP dac81886 - Probe gegen R2:
    PUT+DELETE ok). Der fruehere Vorrang `R2_*` vor der Datei haette jeden
    Transfer still mit einem falschen Schluessel signiert.
    """

    ROOT = pathlib.Path(__file__).resolve().parents[1]
    LIB = str(ROOT / "scripts" / "hetzner" / "lib" / "r2-sigv4.sh")

    def _lauf(self, extra_env):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            env_datei = os.path.join(tmp, ".env")
            with open(env_datei, "w", encoding="utf-8") as f:
                f.write("CFS3_ACCESS_KEY=datei-key\nCFS3_SECRET_KEY=datei-secret\n"
                        "CFS3_ENDPOINT=https://x.r2.cloudflarestorage.com\nCFS3_BUCKET=eimer\n")
            skript = (
                f"set -u; source {shlex.quote(self.LIB)}; "
                f"R2_ENV_FILE={shlex.quote(env_datei)}; "
                "r2_load_config >/dev/null 2>/tmp/r2warn.$$; "
                'printf "%s|%s" "$R2_ACCESS_KEY" "$R2_SECRET_KEY"; rm -f /tmp/r2warn.$$'
            )
            umgebung = dict(os.environ)
            umgebung["R2_ACCESS_KEY"] = "umgebungs-key"
            umgebung["R2_SECRET_KEY"] = "umgebungs-secret"
            umgebung.update(extra_env)
            return subprocess.run(["bash", "-c", skript], capture_output=True, text=True, env=umgebung)

    def test_datei_gewinnt_gegen_umgebung(self):
        r = self._lauf({})
        self.assertEqual(r.stdout.strip(), "datei-key|datei-secret",
                         f"Es muss die Datei gelten: {r.stdout!r} {r.stderr!r}")
        self.assertNotIn("umgebungs-key", r.stdout + r.stderr,
                         "Der WERT darf nie in der Ausgabe stehen - nur der Fingerabdruck.")

    def test_ausdruecklicher_override_greift(self):
        r = self._lauf({"R2_ALLOW_ENV_OVERRIDE": "1"})
        self.assertEqual(r.stdout.strip(), "umgebungs-key|umgebungs-secret",
                         f"Mit R2_ALLOW_ENV_OVERRIDE=1 muss die Umgebung gelten: {r.stdout!r}")


# ---------------------------------------------------------------------------
# INFRA-HETZNER-014 (2026-09-21): Firewall-Regel-Drift nach einem Neuaufbau
# ---------------------------------------------------------------------------
# Befund (live gemessen): drei Firewalls trugen nach dem Neuaufbau der Flotte
# noch die Quell-IPs der VORHERIGEN Flotte -
#   audiomonastry-app:    8080 nur von 167.233.192.196/32 (alte edge-1)
#   audiomonastry-ai:     8000 + 11434 nur von 142.132.229.71/32 (alte app-1)
#   audiomonastry-master: 8000 nur von derselben alten app-1-IP.
# Der Querverkehr edge->app:8080 (Monitoring-Scrape), app->ai:8000/11434
# (Stem-AI/Ollama) und app->master:8000 (master-player) war damit stumm
# blockiert - von aussen unsichtbar, weil alles Oeffentliche ueber Cloudflare
# laeuft. `scripts/hetzner/firewall-ensure.py` gleicht die Quell-IPs gegen die
# TATSAECHLICHEN Knoten-IPs ab (idempotent, non-destruktiv).
#
# Gefahren wird der ECHTE Codepfad des Skripts gegen einen LOKALEN HTTP-Stub der
# Hetzner-API (127.0.0.1, kein Hetzner, kein Token, keine Flotte). Der Stub
# fuehrt set_rules wirklich nach, sonst waere "der Trockenlauf schreibt nichts"
# nur ein Textversprechen; fuer die Gegenprobe kann er das Schreiben bewusst
# ignorieren (Fall e).

#: Soll-Vertrag, den der Test unabhaengig nachrechnet (Firewall-Suffix, Port, Rolle).
#: Muss mit scripts/hetzner/firewall-ensure.py (CONTRACT) uebereinstimmen - der
#: letzte Test der Klasse haelt beide Quellen deckungsgleich.
CROSS_NODE_CONTRACT = (
    ("app", "8080", "edge"),
    ("ai", "8000", "app"),
    ("ai", "11434", "app"),
    ("master", "8000", "app"),
)

#: Knoten-IPs des Test-Szenarios (Testnetze nach RFC 5737, keine echten Adressen).
FLEET_TEST_IPS = {
    "app": "203.0.113.5",
    "sfu": "203.0.113.6",
    "ai": "203.0.113.7",
    "master": "203.0.113.8",
    "edge": "198.51.100.7",
}

#: Die ALTEN IPs aus dem Befund: sie duerfen in keiner Regel mehr stehen.
ALTE_APP_IP = "142.132.229.71"
ALTE_EDGE_IP = "167.233.192.196"


def fleet_stub_servers(rollen: tuple[str, ...] = ("app", "sfu", "ai", "master", "edge")) -> list[dict]:
    """Hetzner-Server-Objekte fuer die Namensaufloesung (Name + IPv4 genuegen)."""
    return [
        {
            "id": 1000 + index,
            "name": f"audiomonastry-{role}-1",
            "status": "running",
            "public_net": {"ipv4": {"ip": FLEET_TEST_IPS[role]}},
        }
        for index, role in enumerate(rollen)
    ]


def app_firewall_rules(old_edge_ip: str = ALTE_EDGE_IP) -> list[dict]:
    """Firewall `audiomonastry-app` im Live-Zustand des Befunds.

    Enthaelt bewusst alles, was NICHT angefasst werden darf: ICMP, SSH, die
    Cloudflare-Bereiche auf 80/443 und IPv6-Quellen - dazu den veralteten
    /32-Eintrag auf dem Metrik-Port 8080.
    """
    return [
        {"direction": "in", "protocol": "icmp", "source_ips": ["0.0.0.0/0", "::/0"], "description": "ICMP"},
        {"direction": "in", "protocol": "tcp", "port": "22", "source_ips": ["0.0.0.0/0", "::/0"], "description": "SSH"},
        {"direction": "in", "protocol": "tcp", "port": "80",
         "source_ips": ["172.64.0.0/13", "2606:4700::/32"], "description": "HTTP (Cloudflare)"},
        {"direction": "in", "protocol": "tcp", "port": "443",
         "source_ips": ["172.64.0.0/13", "2606:4700::/32"], "description": "HTTPS (Cloudflare)"},
        {"direction": "in", "protocol": "tcp", "port": "8080",
         "source_ips": [f"{old_edge_ip}/32"], "description": "App-Metriken (Monitoring-Scrape)"},
    ]


def ai_firewall_rules(old_app_ip: str = ALTE_APP_IP) -> list[dict]:
    """Firewall `audiomonastry-ai`: Stem-AI 8000 + Ollama 11434 nur fuer die alte app-1."""
    return [
        {"direction": "in", "protocol": "icmp", "source_ips": ["0.0.0.0/0", "::/0"], "description": "ICMP"},
        {"direction": "in", "protocol": "tcp", "port": "22", "source_ips": ["0.0.0.0/0", "::/0"], "description": "SSH"},
        {"direction": "in", "protocol": "tcp", "port": "8000", "source_ips": [f"{old_app_ip}/32"], "description": "Stem-AI"},
        {"direction": "in", "protocol": "tcp", "port": "11434", "source_ips": [f"{old_app_ip}/32"], "description": "Ollama"},
    ]


def master_firewall_rules(old_app_ip: str = ALTE_APP_IP) -> list[dict]:
    """Firewall `audiomonastry-master`: master-player 8000 nur fuer die alte app-1."""
    return [
        {"direction": "in", "protocol": "icmp", "source_ips": ["0.0.0.0/0", "::/0"], "description": "ICMP"},
        {"direction": "in", "protocol": "tcp", "port": "8000", "source_ips": [f"{old_app_ip}/32"], "description": "master-player"},
    ]


class _HetznerFleetStub:
    """Lokale Hetzner-API-Attrappe mit echtem Zustand (kein Netz, kein Token).

    Beantwortet genau die Pfade, die `firewall-ensure.py` faehrt: GET /servers,
    GET /firewalls, GET /firewalls/<id> und POST
    /firewalls/<id>/actions/set_rules. Der Schreibpfad aendert den Zustand
    wirklich - mit `ignore_writes=True` bewusst NICHT (Gegenprobe-Fall e).
    """

    def __init__(
        self,
        servers: list[dict] | None = None,
        firewalls: list[dict] | None = None,
        ignore_writes: bool = False,
    ) -> None:
        self.servers = servers if servers is not None else fleet_stub_servers()
        self.firewalls = firewalls or []
        self.ignore_writes = ignore_writes
        self.requests: list[tuple[str, str]] = []
        self.payloads: list[dict] = []

    def __enter__(self) -> "_HetznerFleetStub":
        stub = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def _send(self, status: int, payload: dict) -> None:
                body = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _read_payload(self) -> dict:
                length = int(self.headers.get("content-length") or 0)
                raw = self.rfile.read(length) if length else b""
                payload = json.loads(raw.decode("utf-8")) if raw else {}
                stub.payloads.append(payload)
                return payload

            def _firewall_by_id(self, fw_id: str) -> dict | None:
                for fw in stub.firewalls:
                    if str(fw.get("id")) == str(fw_id):
                        return fw
                return None

            def do_GET(self) -> None:  # noqa: N802 - Name kommt von BaseHTTPRequestHandler
                stub.requests.append(("GET", self.path))
                path = urllib.parse.urlparse(self.path).path
                if path == "/v1/servers":
                    return self._send(200, {"servers": stub.servers, "meta": {"pagination": {"last_page": 1}}})
                if path == "/v1/firewalls":
                    return self._send(200, {"firewalls": stub.firewalls, "meta": {"pagination": {"last_page": 1}}})
                if path.startswith("/v1/firewalls/"):
                    fw = self._firewall_by_id(path.rsplit("/", 1)[-1])
                    if fw is None:
                        return self._send(404, {"error": {"code": "not_found", "message": "Firewall nicht gefunden"}})
                    return self._send(200, {"firewall": fw})
                return self._send(404, {"error": {"code": "not_found", "message": "unbekannter Pfad"}})

            def do_POST(self) -> None:  # noqa: N802
                stub.requests.append(("POST", self.path))
                payload = self._read_payload()
                path = urllib.parse.urlparse(self.path).path
                if not path.startswith("/v1/firewalls/") or not path.endswith("/actions/set_rules"):
                    return self._send(404, {"error": {"code": "not_found", "message": "unbekannter Pfad"}})
                fw = self._firewall_by_id(path.split("/")[3])
                if fw is None:
                    return self._send(404, {"error": {"code": "not_found", "message": "Firewall nicht gefunden"}})
                if not stub.ignore_writes:
                    fw["rules"] = payload.get("rules") or []
                return self._send(200, {"actions": [{"id": 1, "status": "success"}]})

            def log_message(self, *args: Any) -> None:  # Testausgabe ruhig halten
                return

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *exc: object) -> Literal[False]:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        return False

    @property
    def api_base(self) -> str:
        host, port = self.server.server_address[0], self.server.server_address[1]
        return f"http://{host}:{port}/v1"

    # --- Auswertung -------------------------------------------------------
    def methods(self) -> list[str]:
        return [method for method, _path in self.requests]

    def writes(self) -> list[str]:
        return [path for method, path in self.requests if method == "POST"]

    def firewall(self, name: str) -> dict:
        for fw in self.firewalls:
            if fw.get("name") == name:
                return fw
        raise AssertionError(f"kein Firewall-Objekt {name}: {[f.get('name') for f in self.firewalls]}")

    def rule(self, name: str, port: str) -> dict:
        for entry in self.firewall(name).get("rules") or []:
            if str(entry.get("port") or "") == str(port):
                return entry
        raise AssertionError(f"keine Regel tcp/{port} auf {name}: {self.firewall(name).get('rules')}")


def voller_flotten_stub(ignore_writes: bool = False) -> _HetznerFleetStub:
    """Alle drei Vertrags-Firewalls im Drift-Zustand des Befunds (+ unbeteiligte sfu-Firewall)."""
    return _HetznerFleetStub(
        firewalls=[
            {"id": 4711, "name": "audiomonastry-app", "rules": app_firewall_rules()},
            {"id": 4712, "name": "audiomonastry-ai", "rules": ai_firewall_rules()},
            {"id": 4713, "name": "audiomonastry-master", "rules": master_firewall_rules()},
            # unbeteiligt: kein Vertrags-Port - darf nie geschrieben werden.
            {"id": 4714, "name": "audiomonastry-sfu",
             "rules": [{"direction": "in", "protocol": "udp", "port": "40000-40099",
                        "source_ips": ["0.0.0.0/0", "::/0"], "description": "RTP"}]},
        ],
        ignore_writes=ignore_writes,
    )


class CrossNodeFirewallAbgleichTest(unittest.TestCase):
    """INFRA-HETZNER-014: der Firewall-Abgleich ist idempotent und non-destruktiv.

    Kein Test kontaktiert Hetzner: die API-Basis zeigt auf den lokalen Stub.
    """

    TOKEN = "hcloud-nur-fuer-den-teststub-0000"

    def setUp(self) -> None:
        self.python = sys.executable

    def _run(
        self,
        stub: _HetznerFleetStub | None,
        *args: str,
        token: str | None = TOKEN,
        env_file: str | None = None,
    ) -> subprocess.CompletedProcess:
        return subprocess.run(
            [self.python, str(FIREWALL_ENSURE), *args],
            capture_output=True, text=True, cwd=ROOT, timeout=60,
            env=clean_env(
                HCLOUD_API_BASE=(stub.api_base if stub is not None else "http://127.0.0.1:9/v1"),
                HCLOUD_TOKEN=token,
                # Ohne diesen Schalter laese das Skript die ECHTE .env.deploy des
                # Betreiber-Rechners - dann waere "ohne Token" nicht pruefbar.
                HCLOUD_ENV_FILE=(env_file if env_file is not None else "/nonexistent/nur-test.env"),
            ),
        )

    @staticmethod
    def _combined(result: subprocess.CompletedProcess) -> str:
        return result.stdout + result.stderr

    @staticmethod
    def _regeln_ohne_vertragsquellen(rules: list[dict]) -> list[dict]:
        """Regeln, aber die source_ips der Vertragsports entfernt (Zeichengleich-Vergleich)."""
        vertragsports = {port for _suffix, port, _role in CROSS_NODE_CONTRACT}
        return [
            {**rule, "source_ips": None} if str(rule.get("port") or "") in vertragsports else dict(rule)
            for rule in rules
        ]

    # --- (a) veraltete Quelle wird ersetzt, der Rest bleibt zeichengleich --
    def test_veraltete_quelle_wird_ersetzt_und_alles_andere_bleibt(self) -> None:
        stub = voller_flotten_stub()
        with stub:
            before = {fw["name"]: json.loads(json.dumps(fw["rules"])) for fw in stub.firewalls}
            result = self._run(stub)
            after = {fw["name"]: json.loads(json.dumps(fw["rules"])) for fw in stub.firewalls}
        combined = self._combined(result)

        self.assertEqual(result.returncode, 0, combined)
        # Genau die drei driftenden Firewalls wurden geschrieben, die sfu-Firewall nicht.
        self.assertEqual(sorted(stub.writes()), [
            "/v1/firewalls/4711/actions/set_rules",
            "/v1/firewalls/4712/actions/set_rules",
            "/v1/firewalls/4713/actions/set_rules",
        ])
        # Soll-Quellen stehen in der API (nachgelesener Zustand, nicht die Antwort).
        self.assertEqual(stub.rule("audiomonastry-app", "8080")["source_ips"], [f"{FLEET_TEST_IPS['edge']}/32"])
        self.assertEqual(stub.rule("audiomonastry-ai", "8000")["source_ips"], [f"{FLEET_TEST_IPS['app']}/32"])
        self.assertEqual(stub.rule("audiomonastry-ai", "11434")["source_ips"], [f"{FLEET_TEST_IPS['app']}/32"])
        self.assertEqual(stub.rule("audiomonastry-master", "8000")["source_ips"], [f"{FLEET_TEST_IPS['app']}/32"])
        # Die ALTEN IPs sind weg - und die volle Regel-Liste ging raus (set_rules
        # ersetzt alles, deshalb muss sie vollstaendig sein).
        for fw in stub.firewalls:
            flach = json.dumps(fw["rules"])
            self.assertNotIn(ALTE_APP_IP, flach, flach)
            self.assertNotIn(ALTE_EDGE_IP, flach, flach)
        for name in ("audiomonastry-app", "audiomonastry-ai", "audiomonastry-master"):
            self.assertEqual(len(after[name]), len(before[name]), f"{name}: Regelanzahl hat sich geaendert")
        # ... und JEDE andere Regel ist zeichengleich geblieben (ICMP, SSH,
        # Cloudflare-Bereiche, IPv6, Beschreibungen, Reihenfolge der Regeln).
        for name in ("audiomonastry-app", "audiomonastry-ai", "audiomonastry-master"):
            self.assertEqual(
                self._regeln_ohne_vertragsquellen(before[name]),
                self._regeln_ohne_vertragsquellen(after[name]),
                f"{name}: eine Regel ausserhalb der Quell-IPs wurde veraendert",
            )
        self.assertEqual(before["audiomonastry-sfu"], after["audiomonastry-sfu"])
        # Vorher/Nachher, Zaehler und Firewall-IDs stehen im Log.
        self.assertIn(f"{ALTE_EDGE_IP}/32 -> {FLEET_TEST_IPS['edge']}/32", combined)
        self.assertIn(f"{ALTE_APP_IP}/32 -> {FLEET_TEST_IPS['app']}/32", combined)
        self.assertIn("geaendert=4", combined)
        self.assertIn("geprueft=4", combined)
        self.assertIn("audiomonastry-app=4711", combined)
        self.assertIn("audiomonastry-ai=4712", combined)
        self.assertIn("audiomonastry-master=4713", combined)
        # Der Token erscheint nie.
        self.assertNotIn(self.TOKEN, combined)

    def test_zweiter_lauf_ist_idempotent(self) -> None:
        stub = voller_flotten_stub()
        with stub:
            erster = self._run(stub)
            erster_writes = list(stub.writes())
            zweiter = self._run(stub)
            zweiter_writes = list(stub.writes())

        self.assertEqual(erster.returncode, 0, self._combined(erster))
        self.assertEqual(len(erster_writes), 3)
        self.assertEqual(zweiter.returncode, 0, self._combined(zweiter))
        self.assertEqual(len(zweiter_writes), 3, "der zweite Lauf darf nicht erneut schreiben")
        self.assertIn("unveraendert", zweiter.stdout)
        self.assertIn("geaendert=0", zweiter.stdout)
        self.assertIn("geprueft=4", zweiter.stdout)

    # --- (b) schon aktuell: kein Schreibaufruf, Exit 0 ---------------------
    def test_bereits_aktuell_schreibt_nichts_und_exit_null(self) -> None:
        aktuell = FLEET_TEST_IPS
        stub = _HetznerFleetStub(firewalls=[
            {"id": 4711, "name": "audiomonastry-app", "rules": app_firewall_rules(aktuell["edge"])},
            {"id": 4712, "name": "audiomonastry-ai", "rules": ai_firewall_rules(aktuell["app"])},
            {"id": 4713, "name": "audiomonastry-master", "rules": master_firewall_rules(aktuell["app"])},
        ])
        with stub:
            result = self._run(stub)

        combined = self._combined(result)
        self.assertEqual(result.returncode, 0, combined)
        self.assertEqual(stub.writes(), [], "kein Schreibaufruf, wenn alle Quellen aktuell sind")
        # Nur gelesen: /servers + /firewalls.
        self.assertEqual(stub.methods(), ["GET", "GET"])
        self.assertIn("unveraendert", result.stdout)
        self.assertIn("geaendert=0", result.stdout)
        self.assertIn("geprueft=4", result.stdout)

    # --- (c) fehlender Token: Exit != 0, kein Schreibaufruf ----------------
    def test_ohne_token_kein_request_und_exit_ungleich_null(self) -> None:
        stub = voller_flotten_stub()
        with stub:
            result = self._run(stub, token=None)

        combined = self._combined(result)
        self.assertNotEqual(result.returncode, 0, combined)
        self.assertIn("HCLOUD_TOKEN fehlt", combined)
        self.assertEqual(stub.requests, [], "ohne Token darf kein einziger Request entstehen")
        self.assertIn("nur-test.env", combined)  # der erwartete Env-Pfad wird benannt

    def test_token_aus_der_env_datei_wird_gelesen_aber_nie_ausgegeben(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fwsync-env-") as tmpdir:
            env_datei = pathlib.Path(tmpdir) / ".env.deploy"
            env_datei.write_text(f"HCLOUD_TOKEN={self.TOKEN}\n", encoding="utf-8")
            stub = _HetznerFleetStub(firewalls=[
                {"id": 4711, "name": "audiomonastry-app", "rules": app_firewall_rules()},
            ])
            with stub:
                result = self._run(stub, token=None, env_file=str(env_datei))
            combined = self._combined(result)

        self.assertEqual(result.returncode, 0, combined)
        self.assertEqual(stub.rule("audiomonastry-app", "8080")["source_ips"], [f"{FLEET_TEST_IPS['edge']}/32"])
        self.assertNotIn(self.TOKEN, combined, "der Tokenwert darf nie in der Ausgabe stehen")
        self.assertIn("Fingerabdruck", combined)

    # --- (d) --print-config und --dry-run schreiben nichts -----------------
    def test_print_config_ist_netzfrei_und_zeigt_den_soll_vertrag(self) -> None:
        stub = voller_flotten_stub()
        with tempfile.TemporaryDirectory(prefix="fwsync-print-") as tmpdir:
            env_datei = pathlib.Path(tmpdir) / ".env.deploy"
            env_datei.write_text("HCLOUD_TOKEN=nicht-ausgeben\n", encoding="utf-8")
            with stub:
                result = self._run(stub, "--print-config", env_file=str(env_datei))

        combined = self._combined(result)
        self.assertEqual(result.returncode, 0, combined)
        self.assertEqual(stub.requests, [], "--print-config darf keinen API-Aufruf machen")
        for fw_suffix, port, role in CROSS_NODE_CONTRACT:
            with self.subTest(port=port):
                self.assertRegex(combined, rf"audiomonastry-{fw_suffix}\s+tcp/{port}\s")
                self.assertIn(f"audiomonastry-{role}-1", combined)
        # Der Pfad der Env-Datei steht im Trockenlauf - aber kein Wert daraus.
        self.assertIn(str(env_datei), combined)
        self.assertNotIn("nicht-ausgeben", combined)
        self.assertIn("FLEET_FIREWALL_ENSURE=0", combined)
        self.assertNotIn(self.TOKEN, combined)

    def test_dry_run_zeigt_den_plan_und_schreibt_nichts(self) -> None:
        stub = voller_flotten_stub()
        with stub:
            before = json.loads(json.dumps([fw["rules"] for fw in stub.firewalls]))
            result = self._run(stub, "--dry-run")
            after = json.loads(json.dumps([fw["rules"] for fw in stub.firewalls]))

        combined = self._combined(result)
        self.assertEqual(result.returncode, 0, combined)
        self.assertEqual(stub.writes(), [], "--dry-run darf nicht schreiben")
        self.assertEqual(stub.methods(), ["GET", "GET"])
        self.assertEqual(before, after, "der Trockenlauf hat den Zustand veraendert")
        self.assertIn(f"{ALTE_EDGE_IP}/32 -> {FLEET_TEST_IPS['edge']}/32", combined)
        self.assertIn("Trockenlauf", combined)
        self.assertIn("geaendert=4", combined)
        self.assertNotIn(self.TOKEN, combined)

    # --- (e) Gegenprobe schlaegt fehl -------------------------------------
    def test_gegenprobe_weicht_ab_ergibt_exit_ungleich_null(self) -> None:
        # Der Stub quittiert set_rules mit Erfolg, AENDERT den Zustand aber nicht
        # (z. B. weil ein zweiter Schreiber dazwischenkam) - genau der Fall, den
        # ein blindes "Schreiben war erfolgreich" verschlucken wuerde.
        stub = voller_flotten_stub(ignore_writes=True)
        with stub:
            result = self._run(stub)

        combined = self._combined(result)
        self.assertNotEqual(result.returncode, 0, combined)
        self.assertIn("FEHLER: Gegenprobe von audiomonastry-app weicht ab", combined)
        self.assertIn("fehlt:", combined)
        self.assertEqual(len(stub.writes()), 3, "jede driftende Firewall wurde versucht")
        self.assertIn(ALTE_EDGE_IP, json.dumps(stub.firewall("audiomonastry-app")["rules"]))

    # --- Grenzen: kein Erfinden, keine Einschraenkung ---------------------
    def test_fehlende_rolle_wird_gemeldet_und_nicht_geraten(self) -> None:
        # app-1 fehlt: die Quelle fuer ai:8000/11434 und master:8000 ist unbekannt -
        # das Skript muss das melden und darf nichts schreiben.
        stub = _HetznerFleetStub(
            servers=fleet_stub_servers(("sfu", "ai", "master", "edge")),
            firewalls=[{"id": 4712, "name": "audiomonastry-ai", "rules": ai_firewall_rules()}],
        )
        with stub:
            result = self._run(stub)

        combined = self._combined(result)
        self.assertNotEqual(result.returncode, 0, combined)
        self.assertIn("audiomonastry-app-1", combined)
        self.assertIn("FEHLT", combined)
        self.assertIn("Soll-Zustand nicht ableitbar", combined)
        self.assertEqual(stub.writes(), [])

    def test_fehlende_regel_wird_gemeldet_aber_nichts_angelegt(self) -> None:
        # Ohne 8080-Regel ist der Scrape nicht verdrahtet: melden (Exit 0), aber
        # NICHT erfinden - Regeln anzulegen ist Sache des Verdrahtungs-Pfads.
        stub = _HetznerFleetStub(firewalls=[
            {"id": 4711, "name": "audiomonastry-app", "rules": app_firewall_rules()[:-1]},
        ])
        with stub:
            result = self._run(stub)

        combined = self._combined(result)
        self.assertEqual(result.returncode, 0, combined)
        self.assertIn("Regel fehlt", combined)
        self.assertIn("geprueft=0", combined)
        self.assertEqual(stub.writes(), [])

    def test_offene_regel_wird_nicht_eingeschraenkt(self) -> None:
        # 0.0.0.0/0 heisst "fuer alle offen": das ist keine veraltete Knoten-IP,
        # sondern eine bewusste Freigabe - sie wird nicht auf den Knoten verengt.
        rules = app_firewall_rules()
        rules[-1] = {"direction": "in", "protocol": "tcp", "port": "8080",
                     "source_ips": ["0.0.0.0/0", "::/0"], "description": "bewusst offen"}
        stub = _HetznerFleetStub(firewalls=[{"id": 4711, "name": "audiomonastry-app", "rules": rules}])
        with stub:
            result = self._run(stub)

        combined = self._combined(result)
        self.assertEqual(result.returncode, 0, combined)
        self.assertEqual(stub.writes(), [])
        self.assertEqual(stub.rule("audiomonastry-app", "8080")["source_ips"], ["0.0.0.0/0", "::/0"])
        self.assertIn("fuer ALLE offen", combined)

    def test_api_fehler_ergibt_exit_zwei(self) -> None:
        # Kein Server erreichbar (Port 9): der Lauf endet mit Befund, nicht mit 0.
        result = self._run(None)
        combined = self._combined(result)
        self.assertEqual(result.returncode, 2, combined)
        self.assertIn("FEHLER beim Lesen der Flotte", combined)

    def test_konfiguration_im_skript_ist_eine_quelle(self) -> None:
        # Der Soll-Vertrag im Skript muss mit dem hier nachgerechneten Vertrag
        # identisch sein - sonst prueft der Test etwas anderes als der Betrieb.
        module = load_module("hetzner_firewall_ensure", FIREWALL_ENSURE)
        self.assertEqual(tuple(tuple(eintrag) for eintrag in module.CONTRACT), CROSS_NODE_CONTRACT)


class FirewallAbgleichImFlottenstartTest(unittest.TestCase):
    """INFRA-HETZNER-014: der Abgleich laeuft im Flottenstart (Schritt 3/9)."""

    def setUp(self) -> None:
        self.bash = bash_path()
        self.text = BRING_UP.read_text(encoding="utf-8")

    def test_abgleich_laeuft_nach_der_provisionierung_vor_den_deploys(self) -> None:
        provision = self.text.index("bash scripts/hetzner/provision-fleet.sh")
        abgleich = self.text.index("python3 scripts/hetzner/firewall-ensure.py \\\n")
        ssh_warten = self.text.index('step "4/9 Auf Cloud-Init/SSH warten')
        deploy = self.text.index('step "5/9 app-1 deployen')
        self.assertLess(provision, abgleich, "der Abgleich muss NACH dem Anlegen der Knoten laufen")
        self.assertLess(abgleich, ssh_warten)
        self.assertLess(abgleich, deploy)

    def test_schrittnummerierung_ist_vollstaendig_und_fortlaufend(self) -> None:
        schritte = re.findall(r'^step "(\d+)/(\d+) ', self.text, re.MULTILINE)
        self.assertEqual([int(nummer) for nummer, _total in schritte], list(range(1, 10)))
        self.assertEqual({total for _nummer, total in schritte}, {"9"})

    def test_abschaltbefehl_ist_dokumentiert_und_nicht_still(self) -> None:
        self.assertIn('FLEET_FIREWALL_ENSURE="${FLEET_FIREWALL_ENSURE:-1}"', self.text)
        self.assertIn('if [[ "$FLEET_FIREWALL_ENSURE" == "1" ]]; then', self.text)
        self.assertIn("uebersprungen (FLEET_FIREWALL_ENSURE=0)", self.text)
        self.assertIn("FLEET_FIREWALL_ENSURE=0 bash scripts/hetzner/bring-up-fleet.sh", self.text)
        # Ein Fehlschlag darf nicht still sein (genau die Fehlerklasse des Befunds).
        self.assertIn("⚠ Firewall-Abgleich fehlgeschlagen", self.text)
        self.assertIn("docs/HETZNER_DEPLOY.md (INFRA-HETZNER-014)", self.text)

    def test_trockenlauf_zeigt_den_firewall_schritt_und_den_vertrag(self) -> None:
        result = subprocess.run(
            [self.bash, str(BRING_UP), "--print-config"],
            capture_output=True, text=True, cwd=ROOT, timeout=120, env=clean_env(),
        )
        combined = result.stdout + result.stderr
        self.assertEqual(result.returncode, 0, combined)
        self.assertIn("Firewall:  Schritt 3/9", result.stdout)
        self.assertIn("FLEET_FIREWALL_ENSURE=1", result.stdout)
        # Der Abgleich selbst wird netzfrei mitgedruckt (Rolle -> Firewall -> Ports).
        self.assertIn("Soll-Zuordnung", result.stdout)
        self.assertRegex(result.stdout, r"audiomonastry-app\s+tcp/8080")
        self.assertRegex(result.stdout, r"audiomonastry-master\s+tcp/8000")
        self.assertIn("Abschalten:  FLEET_FIREWALL_ENSURE=0", result.stdout)

    def test_abschalten_ueberspringt_den_aufruf_wirklich(self) -> None:
        # Gegenprobe des Schalters am ECHTEN Text der Verzweigung: mit
        # FLEET_FIREWALL_ENSURE=0 darf kein Abgleich starten, mit 1 muss er
        # starten (sonst waere der Schalter nur eine Zeile im Log).
        schritt_kopf = 'step "3/9 Cross-Node-Firewall-Regeln auf die aktuellen Knoten-IPs abgleichen"'
        rumpf = self.text.split(schritt_kopf)[1].split("# --- 4.")[0]
        aufruf = "  python3 scripts/hetzner/firewall-ensure.py \\\n"
        self.assertIn(aufruf, rumpf)
        with tempfile.TemporaryDirectory(prefix="fwsync-off-") as tmpdir:
            tmp = pathlib.Path(tmpdir)
            log = tmp / "python.log"
            log.write_text("", encoding="utf-8")
            fake = tmp / "python3"
            fake.write_text("#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"${FAKE_PY_LOG:?}\"\nexit 0\n", encoding="utf-8")
            fake.chmod(0o755)
            skript = 'step() { :; }\n' + rumpf.replace(
                aufruf, f"  {fake} scripts/hetzner/firewall-ensure.py \\\n"
            )
            env = clean_env(FAKE_PY_LOG=str(log))
            ohne = subprocess.run([self.bash, "-c", skript], capture_output=True, text=True,
                                  cwd=ROOT, timeout=60, env=dict(env, FLEET_FIREWALL_ENSURE="0"))
            log_ohne = log.read_text(encoding="utf-8")
            log.write_text("", encoding="utf-8")
            mit = subprocess.run([self.bash, "-c", skript], capture_output=True, text=True,
                                 cwd=ROOT, timeout=60, env=dict(env, FLEET_FIREWALL_ENSURE="1"))
            log_mit = log.read_text(encoding="utf-8")

        self.assertEqual(ohne.returncode, 0, ohne.stdout + ohne.stderr)
        self.assertIn("uebersprungen", ohne.stdout + ohne.stderr)
        self.assertEqual(log_ohne, "", "mit FLEET_FIREWALL_ENSURE=0 darf kein Abgleich laufen")
        self.assertEqual(mit.returncode, 0, mit.stdout + mit.stderr)
        self.assertIn("scripts/hetzner/firewall-ensure.py", log_mit,
                      "mit FLEET_FIREWALL_ENSURE=1 muss der Abgleich wirklich starten")

if __name__ == "__main__":
    unittest.main()


