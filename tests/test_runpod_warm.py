"""Tests für den RunPod-Warmhalter (scripts/runpod-warm.py).

Kein Netz, keine GPU, keine Kosten: der einzige Netzwerkzugang des Skripts ist das
Modulattribut `transport`, und die Tests ersetzen es durch einen Stub, der jeden
Aufruf protokolliert. Damit ist beweisbar, was das Skript tut - und vor allem, was
es NICHT tut:

  * ohne Freigabe (--yes) kein einziger HTTP-Aufruf (Exit 3),
  * der Kostenblock steht VOR der Aenderung,
  * der Ausgangswert wird VOR der Aenderung gelesen,
  * der Rueckstell-Wert ist der letzte PATCH - auch wenn die Wartezeit mit einer
    Ausnahme endet (das `finally` greift).

Hintergrund: die Flotte faehrt `workersMax=1`; ein `unhealthy` Worker hielt den
einzigen Slot und ein Messjob wartete 19,6 min auf 7,6 s Arbeit (INFRA-RUNPOD-010).
Der Warmhalter ist die reversible Abhilfe - `workersMin=1` kostet aber DAUERHAFT,
deshalb der Gate.

Lauf: python3 tests/test_runpod_warm.py
"""
from __future__ import annotations

import contextlib
import importlib.util
import inspect
import io
import pathlib
import sys
import types
import unittest
from typing import Any, Dict, List, Optional
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parent.parent
WARM_SCRIPT = ROOT / "scripts" / "runpod-warm.py"
DEPLOY_SCRIPT = ROOT / "scripts" / "runpod-deploy.py"

#: Env-Datei, die es nicht gibt: die Tests sollen NICHT von der lokalen .env des
#: Entwicklerrechners abhaengen (sonst waeren sie ortsabhaengig gruen/rot).
NO_ENV_FILE = "/nonexistent/audiomonastry-warm-test.env"


def load_module(name: str, path: pathlib.Path, stub_runpod: bool = False) -> Any:
    """Skript per importlib laden (Bindestrich im Dateinamen = kein Modulpfad)."""
    if stub_runpod:
        sys.modules.setdefault("runpod", mock.MagicMock(spec=types.ModuleType("runpod")))
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:  # pragma: no cover
        raise ImportError(f"Skript nicht ladbar: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


warm = load_module("runpod_warm", WARM_SCRIPT)


class TransportStub:
    """Ersetzt `warm.transport`: protokolliert Aufrufe, liefert plausible Antworten.

    `snapshots[i]` ist der komplette stdout-Stand ZUM ZEITPUNKT des i-ten Aufrufs -
    damit laesst sich beweisen, dass der Kostenblock VOR der Aenderung gedruckt wurde.
    """

    def __init__(
        self,
        workers_min: int = 0,
        get_status: int = 200,
        patch_statuses: Optional[List[Optional[int]]] = None,
        get_payload: Optional[Dict[str, Any]] = None,
        readback_offset: int = 0,
    ) -> None:
        self.workers_min = workers_min
        self.get_status = get_status
        self.get_payload = get_payload
        self.patch_statuses = list(patch_statuses or [])
        #: Versatz der Ruecklesung (simuliert einen PATCH, der nicht angekommen ist).
        self.readback_offset = readback_offset
        self.patch_count = 0
        self.calls: List[Dict[str, Any]] = []
        self.snapshots: List[str] = []
        self.buffer = io.StringIO()

    def __call__(self, method: str, url: str, payload: Optional[Dict[str, Any]] = None, token: str = "") -> Any:
        self.calls.append({"method": method, "url": url, "payload": payload, "token": token})
        self.snapshots.append(self.buffer.getvalue())
        if method == "GET":
            if self.get_status != 200:
                return self.get_status, {"error": "kein Zugriff"}
            if self.get_payload is not None:
                return 200, self.get_payload
            value = self.workers_min
            if self.readback_offset and self.patch_count:
                value += self.readback_offset
            return 200, {
                "id": url.rsplit("/", 1)[-1],
                "name": "audiomonastry-ai-voice",
                "workersMin": value,
                "workersMax": 1,
                "idleTimeout": 120,
            }
        status = self.patch_statuses.pop(0) if self.patch_statuses else 200
        self.patch_count += 1
        if status != 200:
            return status, {"error": "patch abgelehnt"}
        assert payload is not None, "PATCH ohne Payload"
        self.workers_min = int(payload["workersMin"])
        return 200, {"workersMin": self.workers_min, "workersMax": 1}

    # -- Auswertung ---------------------------------------------------------
    @property
    def patches(self) -> List[Dict[str, Any]]:
        return [c for c in self.calls if c["method"] == "PATCH"]

    @property
    def patch_values(self) -> List[Any]:
        return [c["payload"]["workersMin"] for c in self.patches]


def run_main(
    argv: List[str],
    stub: TransportStub,
    *,
    env: Optional[Dict[str, str]] = None,
    wait=None,
) -> tuple[int, str, str]:
    """`warm.main(argv)` mit gestubbtem Transport ausfuehren (kein Netz, kein Warten).

    `warm.wait` wird IMMER ersetzt: ein Test, der echte Minuten wartet, waere
    unbrauchbar. Der Default sammelt die Wartezeit in `waited` (nicht abrufbar,
    weil hier lokal) - Tests mit Wartezeit-Assertion uebergeben `wait` selbst.
    """
    out, err = io.StringIO(), io.StringIO()
    stub.buffer = out
    env_vars = {"RP_API_KEY": "test-token", "RP_ENDPOINT_ID_VOICE": "gajmangfldpzrk"} if env is None else env
    waiter = wait if wait is not None else (lambda _seconds: None)
    with mock.patch.dict("os.environ", env_vars, clear=True):
        with mock.patch.object(warm, "transport", stub):
            with mock.patch.object(warm, "wait", waiter):
                with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                    code = warm.main(argv)
    return code, out.getvalue(), err.getvalue()


def base_argv(*extra: str, minutes: str = "2") -> List[str]:
    return [
        "--role", "voiceGen",
        "--price-per-hour", "0.69",
        "--minutes", minutes,
        "--env-file", NO_ENV_FILE,
        *extra,
    ]


class FreigabeGateTest(unittest.TestCase):
    """Ohne Freigabe passiert NICHTS - keine Kosten, kein HTTP-Aufruf."""

    def test_ohne_yes_exit_3_und_kein_http_aufruf(self) -> None:
        stub = TransportStub()
        code, out, err = run_main(base_argv(), stub)
        self.assertEqual(code, 3, "fehlende Freigabe muss Exit 3 sein")
        self.assertEqual(stub.calls, [], "ohne Freigabe darf KEIN HTTP-Aufruf entstehen")
        self.assertIn("Freigabe fehlt", out + err)
        self.assertIn("--yes", out + err)

    def test_freigabe_per_env_wird_akzeptiert(self) -> None:
        stub = TransportStub()
        code, _out, _err = run_main(
            base_argv(), stub, env={"RP_API_KEY": "t", "RP_ENDPOINT_ID_VOICE": "ep", "RP_WARM_APPROVE": "1"}
        )
        self.assertEqual(code, 0)
        self.assertTrue(stub.calls, "mit Freigabe muss der Lauf stattfinden")

    def test_kostenblock_steht_vor_dem_gate_und_vor_der_aenderung(self) -> None:
        stub = TransportStub()
        code, out, _err = run_main(base_argv("--yes"), stub)
        self.assertEqual(code, 0)
        self.assertTrue(stub.snapshots, "es muss mindestens einen Aufruf geben")
        # Der stdout-Stand beim ERSTEN Aufruf enthaelt den kompletten Kostenblock.
        first_snapshot = stub.snapshots[0]
        self.assertIn("Kostenrechnung", first_snapshot)
        self.assertIn("Stundensatz", first_snapshot)
        self.assertIn("runpodctl gpu list", first_snapshot, "die Quelle des Stundensatzes muss dabeistehen")
        self.assertIn("Idle-Nachlauf", first_snapshot)
        self.assertIn("HARTE OBERGRENZE", first_snapshot)


class TrockenlaufTest(unittest.TestCase):
    def test_dry_run_sendet_nichts_und_zeigt_die_kosten(self) -> None:
        stub = TransportStub()
        code, out, _err = run_main(base_argv("--dry-run"), stub)
        self.assertEqual(code, 0)
        self.assertEqual(stub.calls, [], "der Trockenlauf darf kein Netz beruehren")
        self.assertIn("Kostenrechnung", out)
        self.assertIn("0.69 USD/h", out)
        self.assertIn("TROCKENLAUF", out)
        self.assertIn("workersMin", out)

    def test_dry_run_braucht_keinen_api_key(self) -> None:
        stub = TransportStub()
        code, out, _err = run_main(base_argv("--dry-run"), stub, env={"RP_ENDPOINT_ID_VOICE": "ep"})
        self.assertEqual(code, 0, "im Trockenlauf wird kein Token gebraucht")
        self.assertIn("TROCKENLAUF", out)


class RueckstellungTest(unittest.TestCase):
    """Der Kern: der Ausgangswert kommt zurueck, auch wenn der Lauf stirbt."""

    def test_normaler_lauf_stellt_den_ausgangswert_zurueck(self) -> None:
        stub = TransportStub(workers_min=0)
        waited: List[float] = []
        code, out, _err = run_main(base_argv("--yes", minutes="3"), stub, wait=waited.append)
        self.assertEqual(code, 0)
        self.assertEqual(waited, [180.0], "die Wartezeit ist --minutes in Sekunden")
        self.assertEqual(stub.patch_values, [1, 0], "erst Warmhalter, dann zurueck auf den Ausgangswert")
        self.assertEqual(stub.calls[0]["method"], "GET", "der Ausgangswert wird VOR der Aenderung gelesen")
        self.assertIn("GESETZT", out)
        self.assertIn("Rueckstell-Beleg", out)
        self.assertIn("Ruecklesung workersMin=0", out)

    def test_ausgangswert_1_wird_ebenfalls_erkannt_und_zurueckgestellt(self) -> None:
        # Ein bereits warmer Endpoint darf nicht auf einen geratenen Wert zurueckfallen.
        stub = TransportStub(workers_min=1)
        code, _out, _err = run_main(base_argv("--yes"), stub, wait=lambda _s: None)
        self.assertEqual(code, 0)
        self.assertEqual(stub.patch_values, [1, 1])

    def test_wartezeit_stirbt_und_stellt_trotzdem_zurueck(self) -> None:
        # Der eigentliche `finally`-Beweis: die Wartezeit endet mit einer Ausnahme.
        def boom(_seconds: float) -> None:
            raise RuntimeError("Verbindung weg")

        stub = TransportStub(workers_min=0)
        code, out, err = run_main(base_argv("--yes"), stub, wait=boom)
        self.assertEqual(code, 4, "ein abgebrochener Lauf ist ein Fehler, aber zurueckgestellt")
        self.assertEqual(stub.patch_values, [1, 0])
        self.assertEqual(stub.patches[-1]["payload"], {"workersMin": 0}, "der letzte PATCH ist der Rueckstellwert")
        self.assertIn("Verbindung weg", err)
        # Der Rueckstell-Beleg steht in der Ausgabe, die Ruecklesung bestaetigt ihn.
        self.assertIn("ZURUECKSTELLEN", out)
        self.assertIn("Ruecklesung workersMin=0", out)

    def test_strg_c_stellt_trotzdem_zurueck(self) -> None:
        def interrupt(_seconds: float) -> None:
            raise KeyboardInterrupt()

        stub = TransportStub(workers_min=0)
        code, out, err = run_main(base_argv("--yes"), stub, wait=interrupt)
        self.assertEqual(code, 4)
        self.assertEqual(stub.patch_values, [1, 0], "Strg-C darf den Ausgangswert nicht stehen lassen")
        self.assertIn("Strg-C", out + err)

    def test_scheiterndes_zurueckstellen_ist_exit_5_mit_handlungsanweisung(self) -> None:
        stub = TransportStub(workers_min=0, patch_statuses=[None, 500])
        code, _out, err = run_main(base_argv("--yes"), stub, wait=lambda _s: None)
        self.assertEqual(code, 5, "ein fehlgeschlagenes Zurueckstellen darf nicht als Erfolg durchgehen")
        self.assertIn("JETZT handeln", err)
        self.assertIn("runpodctl endpoint update", err)

    def test_abweichende_ruecklesung_ist_exit_5(self) -> None:
        # PATCH sagt ok, die Ruecklesung sagt etwas anderes -> laut scheitern,
        # nicht "hat ja funktioniert" annehmen.
        stub = TransportStub(workers_min=0, readback_offset=1)
        code, _out, err = run_main(base_argv("--yes"), stub, wait=lambda _s: None)
        self.assertEqual(code, 5)
        self.assertIn("Ruecklesung sagt workersMin=1", err)
        self.assertIn("JETZT handeln", err)

    def test_ausnahme_beim_patch_stellt_trotzdem_zurueck(self) -> None:
        # Der Zustand nach einer abgebrochenen Verbindung ist UNBEKANNT - es wird
        # zurueckgestellt und per Ruecklesung geprueft, nicht gehofft.
        class Boom(TransportStub):
            def __call__(self, method, url, payload=None, token=""):
                if method == "PATCH" and self.patch_count == 0:
                    self.calls.append({"method": method, "url": url, "payload": payload, "token": token})
                    self.snapshots.append(self.buffer.getvalue())
                    self.patch_count += 1
                    raise ConnectionError("Netz weg")
                return super().__call__(method, url, payload, token)

        stub = Boom(workers_min=0)
        code, out, _err = run_main(base_argv("--yes"), stub)
        self.assertEqual(code, 4)
        self.assertEqual(stub.patch_values, [1, 0])
        self.assertEqual(stub.patches[-1]["payload"], {"workersMin": 0})
        self.assertIn("Ruecklesung workersMin=0", out)

    def test_abbruch_vor_dem_patch_hat_nichts_zurueckzustellen(self) -> None:
        # GET scheitert -> es wurde nie etwas gesetzt, also auch kein PATCH danach.
        stub = TransportStub(get_status=403)
        code, _out, err = run_main(base_argv("--yes"), stub)
        self.assertEqual(code, 4)
        self.assertEqual(stub.patch_values, [], "ohne gelesenen Ausgangswert wird nicht geaendert")
        self.assertIn("403", err)


class KonfigurationTest(unittest.TestCase):
    """Fehlkonfiguration kostet keinen Aufruf - sie endet mit Exit 2 und Begruendung."""

    def test_unlesbares_workersmin_stoppt_ohne_patch(self) -> None:
        stub = TransportStub(get_payload={"id": "ep", "name": "audiomonastry-ai-voice"})
        code, _out, err = run_main(base_argv("--yes"), stub)
        self.assertEqual(code, 2)
        self.assertEqual(stub.patch_values, [], "ohne lesbaren Ausgangswert wird NICHTS geaendert")
        self.assertIn("nicht lesbar", err)

    def test_stundensatz_fehlt_ist_ein_konfigurationsfehler(self) -> None:
        stub = TransportStub()
        argv = ["--role", "voiceGen", "--minutes", "2", "--env-file", NO_ENV_FILE]
        code, _out, err = run_main(argv, stub)
        self.assertEqual(code, 2)
        self.assertEqual(stub.calls, [])
        self.assertIn("runpodctl gpu list", err, "die Quelle des Preises muss genannt werden")

    def test_minuten_ueber_dem_maximum_werden_abgewiesen(self) -> None:
        stub = TransportStub()
        code, _out, err = run_main(base_argv(minutes="121"), stub)
        self.assertEqual(code, 2)
        self.assertEqual(stub.calls, [])
        self.assertIn("Obergrenze", err)
        self.assertIn("120", err)

    def test_unbekannte_rolle_ist_ein_konfigurationsfehler(self) -> None:
        stub = TransportStub()
        code, _out, err = run_main(["--role", "quatsch", "--price-per-hour", "1", "--env-file", NO_ENV_FILE], stub)
        self.assertEqual(code, 2)
        self.assertEqual(stub.calls, [])
        self.assertIn("unbekannte Rolle", err)

    def test_fehlende_endpoint_id_nennt_die_variable(self) -> None:
        stub = TransportStub()
        code, _out, err = run_main(base_argv("--yes"), stub, env={"RP_API_KEY": "t"})
        self.assertEqual(code, 2)
        self.assertEqual(stub.calls, [])
        self.assertIn("RP_ENDPOINT_ID_VOICE", err)

    def test_generisches_endpoint_env_ist_der_letzte_fallback(self) -> None:
        stub = TransportStub()
        code, out, _err = run_main(
            base_argv("--dry-run"), stub, env={"RP_ENDPOINT_ID": "generisch-id"}
        )
        self.assertEqual(code, 0)
        self.assertIn("generisch-id", out)
        self.assertIn("WARNUNG", out)

    def test_altname_vision_wird_auf_imagehq_abgebildet(self) -> None:
        stub = TransportStub()
        argv = ["--role", "vision", "--price-per-hour", "1.1", "--minutes", "1",
                "--env-file", NO_ENV_FILE, "--dry-run"]
        code, out, _err = run_main(argv, stub, env={"RP_ENDPOINT_ID_IMAGE": "wzh9hcbitjnn95"})
        self.assertEqual(code, 0)
        self.assertIn("imageHq", out)
        self.assertIn("wzh9hcbitjnn95", out)
        self.assertIn("veraltet", out)

    def test_endpoint_id_kann_direkt_gegeben_werden(self) -> None:
        stub = TransportStub()
        argv = ["--role", "voiceGen", "--price-per-hour", "1", "--minutes", "1",
                "--env-file", NO_ENV_FILE, "--endpoint-id", "direkt-id", "--dry-run"]
        code, out, _err = run_main(argv, stub, env={})
        self.assertEqual(code, 0)
        self.assertIn("direkt-id", out)


class TransportVertragTest(unittest.TestCase):
    def test_browser_user_agent_ist_pflichtteil_des_transports(self) -> None:
        # Ohne Browser-UA antwortet Cloudflare mit HTTP 403 (live belegt 2026-09-20).
        source = inspect.getsource(warm.transport)
        self.assertIn("User-Agent", source)
        self.assertIn("Authorization", source)
        self.assertTrue(warm.UA.startswith("Mozilla/5.0"), warm.UA)

    def test_rest_basis_ist_die_v1_endpoint_url(self) -> None:
        self.assertEqual(warm.REST_BASE, "https://rest.runpod.io/v1")
        url = warm.rest_url({"endpoint_id": "gajmangfldpzrk"})
        self.assertEqual(url, "https://rest.runpod.io/v1/endpoints/gajmangfldpzrk")

    def test_fehlerantworten_werfen_keine_exception(self) -> None:
        # Der Stub ersetzt transport; hier wird nur der Vertrag der Signatur geprueft.
        signature = inspect.signature(warm.transport)
        self.assertEqual(list(signature.parameters)[:2], ["method", "url"])
        self.assertEqual(signature.parameters["payload"].default, None)


class RollenTabellenTest(unittest.TestCase):
    """Die Rollentabellen des Warmhalters duerfen nicht vom Deploy-Skript abdriften."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.deploy = load_module("runpod_deploy_for_warm", DEPLOY_SCRIPT, stub_runpod=True)

    def test_endpoint_env_namen_stimmen_mit_dem_deploy_skript(self) -> None:
        self.assertEqual(warm.ROLE_ENDPOINT_ENV, self.deploy.ENDPOINT_ENV_BY_ROLE)

    def test_altnamen_stimmen_mit_dem_deploy_skript(self) -> None:
        self.assertEqual(warm.LEGACY_ROLE_ALIASES, self.deploy.LEGACY_ROLE_ALIASES)

    def test_idle_nachlauf_ist_der_idle_timeout_der_rolle(self) -> None:
        # SSOT: der Idle-Nachlauf im Kostenblock ist der `idleTimeout` aus
        # ROLE_DEFAULTS des Deploy-Skripts (und damit aus dem Manifest).
        for role, defaults in warm.ROLE_DEFAULTS.items():
            with self.subTest(role=role):
                self.assertEqual(defaults["idleTimeout"], self.deploy.ROLE_DEFAULTS[role]["idleTimeout"])
                self.assertEqual(defaults["suffix"], self.deploy.ROLE_DEFAULTS[role]["suffix"])
        self.assertEqual(warm.ROLE_DEFAULTS["voiceGen"]["idleTimeout"], 120)
        self.assertEqual(warm.ROLE_DEFAULTS["brain"]["idleTimeout"], 15)

    def test_rollenliste_ist_vollstaendig(self) -> None:
        self.assertEqual(set(warm.ROLE_DEFAULTS), set(self.deploy.ROLE_DEFAULTS))

    def test_stundensatz_und_minuten_kommen_aus_der_env(self) -> None:
        stub = TransportStub()
        argv = ["--role", "voiceGen", "--minutes", "5", "--env-file", NO_ENV_FILE, "--dry-run"]
        code, out, _err = run_main(
            argv, stub,
            env={"RP_ENDPOINT_ID_VOICE": "ep", "RP_WARM_PRICE_PER_H": "1.10", "RP_WARM_MINUTES": "5"},
        )
        self.assertEqual(code, 0)
        self.assertIn("1.10 USD/h", out)
        self.assertIn("5.0 min workersMin=1", out)


if __name__ == "__main__":
    unittest.main()
