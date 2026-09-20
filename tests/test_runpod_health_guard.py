#!/usr/bin/env python3
"""
Tests fuer scripts/runpod-health-guard.py (INFRA-RUNPOD-010).

Kein Netz, keine Wartezeit, keine GPU: `warm.transport` und `warm.wait` werden
durch Stubs ersetzt, die jede Anfrage protokollieren. Damit ist belegbar, dass
ohne Freigabe KEIN Aufruf passiert und dass die Heilung den Ausgangswert
wirklich zurueckstellt.
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import pathlib
import sys
import tempfile
import types
import unittest
from typing import Any, Dict, List, Optional, Tuple

ROOT = pathlib.Path(__file__).resolve().parent.parent
GUARD_PATH = ROOT / "scripts" / "runpod-health-guard.py"


def load_guard() -> Any:
    spec = importlib.util.spec_from_file_location("runpod_health_guard", GUARD_PATH)
    if spec is None or spec.loader is None:  # pragma: no cover - nur bei kaputtem Repo
        raise RuntimeError(f"scripts/runpod-health-guard.py nicht ladbar: {GUARD_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["runpod_health_guard"] = module
    spec.loader.exec_module(module)
    return module


guard = load_guard()


class StubTransport:
    """Ersetzt warm.transport: protokolliert alles, antwortet nach Drehbuch."""

    def __init__(
        self,
        health: Dict[str, Dict[str, Any]],
        configs: Optional[Dict[str, Dict[str, Any]]] = None,
        health_error: Optional[Dict[str, int]] = None,
    ) -> None:
        self.health = health
        self.configs = dict(configs or {})
        self.health_error = dict(health_error or {})
        self.calls: List[Tuple[str, str, Optional[Dict[str, Any]]]] = []
        self.stdout_at_call: List[str] = []

    def __call__(
        self, method: str, url: str, payload: Optional[Dict[str, Any]] = None, token: str = ""
    ) -> Tuple[int, Any]:
        self.calls.append((method, url, payload))
        self.stdout_at_call.append("")
        if "/health" in url:
            endpoint = url.rsplit("/", 2)[-2]
            if endpoint in self.health_error:
                return self.health_error[endpoint], {"error": "stub"}
            return 200, self.health.get(endpoint, {"workers": {}, "jobs": {}})
        if "/endpoints/" in url:
            endpoint = url.rsplit("/", 1)[-1]
            if method == "PATCH":
                assert payload is not None
                self.configs.setdefault(endpoint, {}).update(payload)
                return 200, dict(self.configs[endpoint])
            return 200, dict(self.configs.get(endpoint, {"workersMax": 1}))
        return 404, {"error": "unbekannte URL"}


HEALTH_STUCK = {
    "workers": {"idle": 0, "initializing": 0, "ready": 0, "running": 0, "throttled": 0, "unhealthy": 1},
    "jobs": {"completed": 44, "failed": 0, "inProgress": 0, "inQueue": 4, "retried": 0},
}
HEALTH_HEALTHY = {
    "workers": {"idle": 2, "initializing": 0, "ready": 2, "running": 0, "throttled": 0, "unhealthy": 0},
    "jobs": {"completed": 48, "failed": 0, "inProgress": 0, "inQueue": 0, "retried": 0},
}
HEALTH_STARTING = {
    "workers": {"idle": 0, "initializing": 1, "ready": 0, "running": 0, "throttled": 0, "unhealthy": 0},
    "jobs": {"completed": 48, "failed": 0, "inProgress": 0, "inQueue": 2, "retried": 0},
}
HEALTH_UNHEALTHY_QUIET = {
    "workers": {"idle": 0, "initializing": 0, "ready": 0, "running": 0, "throttled": 0, "unhealthy": 1},
    "jobs": {"completed": 48, "failed": 0, "inProgress": 0, "inQueue": 0, "retried": 0},
}


class ClassifyStatusTest(unittest.TestCase):
    """Die Erkennungsregel ist rein - hier ohne I/O belegt."""

    def test_festgefahren_wird_erkannt(self) -> None:
        status, reason = guard.classify_status(HEALTH_STUCK)
        self.assertEqual(status, guard.STATUS_STUCK)
        self.assertIn("Slot blockiert", reason)

    def test_startender_kaltstart_ist_kein_alarm(self) -> None:
        self.assertEqual(guard.classify_status(HEALTH_STARTING)[0], guard.STATUS_STARTING)

    def test_unhealthy_ohne_queue_ist_vorstufe(self) -> None:
        self.assertEqual(guard.classify_status(HEALTH_UNHEALTHY_QUIET)[0], guard.STATUS_UNHEALTHY)

    def test_bereite_worker_sind_ok(self) -> None:
        self.assertEqual(guard.classify_status(HEALTH_HEALTHY)[0], guard.STATUS_OK)

    def test_scale_to_zero_ist_kein_fehler(self) -> None:
        payload = {"workers": {"idle": 0, "ready": 0, "running": 0, "unhealthy": 0}, "jobs": {"inQueue": 0}}
        self.assertEqual(guard.classify_status(payload)[0], guard.STATUS_OK)

    def test_unbrauchbare_antwort_wird_fehler(self) -> None:
        self.assertEqual(guard.classify_status("kaputt")[0], guard.STATUS_ERROR)
        self.assertEqual(guard.classify_status({"workers": []})[0], guard.STATUS_ERROR)


class _GuardCase(unittest.TestCase):
    """Gemeinsame Basis: temporaere .env, gestubbter Transport."""

    role = "voiceGen"
    endpoint = "gajmangfldpzrk"

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.env_file = pathlib.Path(self.tmp.name) / ".env"
        self.env_file.write_text(
            f"RP_API_KEY=test-key\nRP_ENDPOINT_ID_VOICE={self.endpoint}\n", encoding="utf-8"
        )
        self._saved_transport = guard.warm.transport
        self._saved_wait = guard.warm.wait
        self._saved_env = {k: os.environ.get(k) for k in ("RP_API_KEY", "RP_ENDPOINT_ID_VOICE")}
        os.environ.pop("RP_API_KEY", None)
        os.environ.pop("RP_ENDPOINT_ID_VOICE", None)
        guard.warm.wait = lambda seconds: None

    def tearDown(self) -> None:
        guard.warm.transport = self._saved_transport
        guard.warm.wait = self._saved_wait
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.tmp.cleanup()

    def run_guard(self, *extra: str, stub: Optional[StubTransport] = None) -> Tuple[int, str]:
        if stub is not None:
            guard.warm.transport = stub
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = guard.main(
                ["--role", self.role, "--env-file", str(self.env_file), *extra]
            )
        return code, buffer.getvalue()


class BerichtTest(_GuardCase):
    def test_festgefahrene_rolle_wird_gemeldet_mit_exit_4(self) -> None:
        stub = StubTransport({self.endpoint: HEALTH_STUCK})
        code, out = self.run_guard(stub=stub)
        self.assertEqual(code, guard.EXIT_STUCK)
        self.assertIn("FESTGEFAHREN", out)
        self.assertIn("HANDLUNGSBEDARF", out)
        # Nur gelesen, nie geschrieben.
        self.assertTrue(all(call[0] == "GET" for call in stub.calls), stub.calls)

    def test_gesunde_rolle_wird_nicht_alarmiert(self) -> None:
        stub = StubTransport({self.endpoint: HEALTH_HEALTHY})
        code, out = self.run_guard(stub=stub)
        self.assertEqual(code, guard.EXIT_OK)
        self.assertNotIn("HANDLUNGSBEDARF", out)

    def test_startende_rolle_ist_kein_handlungsbedarf(self) -> None:
        stub = StubTransport({self.endpoint: HEALTH_STARTING})
        code, _out = self.run_guard(stub=stub)
        self.assertEqual(code, guard.EXIT_OK)

    def test_nicht_abfragbare_rolle_endet_mit_exit_5(self) -> None:
        stub = StubTransport({}, health_error={self.endpoint: 500})
        code, out = self.run_guard(stub=stub)
        self.assertEqual(code, guard.EXIT_QUERY)
        self.assertIn("FEHLER", out)

    def test_json_bericht_ist_maschinenlesbar(self) -> None:
        stub = StubTransport({self.endpoint: HEALTH_STUCK})
        code, out = self.run_guard("--json", stub=stub)
        self.assertEqual(code, guard.EXIT_STUCK)
        payload = json.loads(out[out.index("{") :])
        self.assertEqual(payload["summary"]["stuck"], [self.role])
        self.assertEqual(payload["roles"][0]["status"], guard.STATUS_STUCK)


class GateTest(_GuardCase):
    def test_heilung_ohne_freigabe_sendet_keinen_aufruf(self) -> None:
        stub = StubTransport({self.endpoint: HEALTH_STUCK}, {self.endpoint: {"workersMax": 1}})
        code, _out = self.run_guard("--heal", "--price-per-hour", "0.69", stub=stub)
        self.assertEqual(code, guard.EXIT_NO_APPROVAL)
        self.assertEqual(stub.calls, [], "ohne Freigabe darf KEIN HTTP-Aufruf passieren")

    def test_heilung_ohne_stundensatz_ist_ein_aufruffehler(self) -> None:
        stub = StubTransport({self.endpoint: HEALTH_STUCK}, {self.endpoint: {"workersMax": 1}})
        code, _out = self.run_guard("--heal", "--yes", stub=stub)
        self.assertEqual(code, guard.EXIT_USAGE)
        self.assertEqual(stub.calls, [])

    def test_freigabe_per_umgebungsvariable_wird_akzeptiert(self) -> None:
        stub = StubTransport({self.endpoint: HEALTH_HEALTHY}, {self.endpoint: {"workersMax": 1}})
        os.environ["RP_HEALTH_APPROVE"] = "1"
        try:
            code, _out = self.run_guard("--heal", "--price-per-hour", "0.69", stub=stub)
        finally:
            os.environ.pop("RP_HEALTH_APPROVE", None)
        self.assertEqual(code, guard.EXIT_OK)


class HeilungTest(_GuardCase):
    def test_heilung_hebt_und_stellt_zurueck(self) -> None:
        stub = StubTransport({self.endpoint: HEALTH_STUCK}, {self.endpoint: {"workersMax": 1}})
        code, out = self.run_guard("--heal", "--price-per-hour", "0.69", "--yes", stub=stub)
        self.assertEqual(code, guard.EXIT_OK)
        patches = [call[2] for call in stub.calls if call[0] == "PATCH"]
        self.assertEqual(
            patches,
            [{"workersMax": 2}, {"workersMax": 1}],
            "erst heben auf 2, dann exakt auf den Ausgangswert zurueck",
        )
        self.assertIn("Rueckstellung: workersMax zurueck auf 1 (nachgelesen)", out)

    def test_kostenhinweis_steht_vor_der_ersten_aenderung(self) -> None:
        stub = StubTransport({self.endpoint: HEALTH_STUCK}, {self.endpoint: {"workersMax": 1}})
        _code, out = self.run_guard("--heal", "--price-per-hour", "0.69", "--yes", stub=stub)
        self.assertIn("Kostenhinweis vor der Heilung", out)
        self.assertIn("securePricePerHr", out)
        self.assertLess(out.index("Kostenhinweis"), out.index("Heilung: workersMax"))

    def test_gesunde_rolle_wird_nicht_angefasst(self) -> None:
        stub = StubTransport({self.endpoint: HEALTH_HEALTHY}, {self.endpoint: {"workersMax": 1}})
        code, _out = self.run_guard("--heal", "--price-per-hour", "0.69", "--yes", stub=stub)
        self.assertEqual(code, guard.EXIT_OK)
        self.assertEqual([c for c in stub.calls if c[0] == "PATCH"], [])

    def test_abweichende_ruecklesung_endet_mit_exit_6(self) -> None:
        endpoint_fixed = self.endpoint

        class Stubborn(StubTransport):
            def __call__(self, method, url, payload=None, token=""):
                code, answer = super().__call__(method, url, payload, token)
                if method == "PATCH":
                    self.configs[endpoint_fixed]["workersMax"] = 2  # ignoriert die Rueckstellung
                return code, answer

        stub = Stubborn({self.endpoint: HEALTH_STUCK}, {self.endpoint: {"workersMax": 1}})
        code, out = self.run_guard("--heal", "--price-per-hour", "0.69", "--yes", stub=stub)
        self.assertEqual(code, guard.EXIT_HEAL_FAILED)
        self.assertIn("Ruecklesung weicht ab", out)

    def test_bereits_gehobenes_workersmax_bleibt_unveraendert(self) -> None:
        """Kein Schreibzugriff ohne Anlass: steht workersMax schon auf 2, wird weder
        gehoben noch zurueckgestellt."""
        stub = StubTransport({self.endpoint: HEALTH_STUCK}, {self.endpoint: {"workersMax": 2}})
        code, out = self.run_guard("--heal", "--price-per-hour", "0.69", "--yes", stub=stub)
        self.assertEqual(code, guard.EXIT_OK)
        self.assertIn("bereits auf 2", out)
        self.assertIn("keine Aenderung noetig", out)
        self.assertEqual([c for c in stub.calls if c[0] == "PATCH"], [])


class DrainTest(_GuardCase):
    def test_drain_wartet_bis_die_queue_leer_ist(self) -> None:
        """Festgefahren -> geheilt -> Queue laeuft leer -> zurueckgestellt."""
        sequence = [HEALTH_STUCK, HEALTH_HEALTHY, HEALTH_HEALTHY]

        class Sequencing(StubTransport):
            def __call__(self, method, url, payload=None, token=""):
                if "/health" in url and sequence:
                    self.calls.append((method, url, payload))
                    return 200, sequence.pop(0) if len(sequence) > 1 else sequence[0]
                return super().__call__(method, url, payload, token)

        stub = Sequencing({self.endpoint: HEALTH_STUCK}, {self.endpoint: {"workersMax": 1}})
        code, out = self.run_guard(
            "--heal", "--price-per-hour", "0.69", "--drain-minutes", "5", "--yes", stub=stub
        )
        self.assertEqual(code, guard.EXIT_OK)
        self.assertIn("Queue leer nach", out)
        self.assertEqual([c[2] for c in stub.calls if c[0] == "PATCH"], [{"workersMax": 2}, {"workersMax": 1}])


if __name__ == "__main__":
    unittest.main()
