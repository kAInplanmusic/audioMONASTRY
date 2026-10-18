"""DA-2026-10-17-016/017/018 (Python-Pfad): Budget, Aggregator-Guard, Args-Pruefung.

    python3 services/audiomonastry-ai-runtime/tests/test_moa_da016_017_018.py

Kein Netz, keine GPU, keine echte Wartezeit: `urlopen` und `time.sleep` sind
Stubs (wie in test_moa_network_resilience.py). Geprueft wird:

* DA-2026-10-17-017 - der Aggregator darf eine NAKTE LISTE liefern, ohne dass
  `moa_orchestrate` an `AttributeError: 'list' object has no attribute 'get'`
  stirbt (vorher: `[..] or {}` wahrte die Liste, `.get` warf).
* DA-2026-10-17-016 - `execute_steps` begrenzt die GESAMTE Pipeline auf ein
  Budget (Default 1200 s / MOA_EXECUTE_BUDGET_S): Schritte nach Ablauf laufen
  als SKIPPED, kein Schritt bekommt mehr als die Restzeit.
* DA-2026-10-17-018 - `call_tool` prueft die Werkzeug-Argumente VOR dem
  RunPod-Aufruf: unbekannte Schluessel kommen beim Worker nicht an, Listen als
  args und uebergrosse Payloads werden abgelehnt (FAILED, nicht Crash).
"""
from __future__ import annotations

import io
import json
import pathlib
import sys
import time
import unittest
import urllib.error
import urllib.request
from unittest import mock

RUNTIME_DIR = pathlib.Path(__file__).resolve().parent.parent
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

import moa_orchestrator as moa  # noqa: E402

ENV = {
    "RP_ENDPOINT_ID_EARS": "ears-ep",
    "RP_ENDPOINT_ID_MUSIC": "music-ep",
    "RP_AGENT_KEY": "test-key",
    "RUNPOD_API_BASE": "https://stub.local/v2",
}


def fake_urlopen(body: bytes, status: int = 200):
    """Statt HTTP: ein Kontext-Objekt mit ZAEHLER-strenger read()/headers/getcode().

    `_read_limited` liest wiederholt; read() muss daher EINMAL liefern und
    danach b"", sonst zaehlt der Streaming-Zaehler denselben Body endlos.
    """

    class R:
        def __init__(self) -> None:
            self.headers = {"Content-Length": str(len(body))}
            self._done = False

        def read(self, n: int = -1) -> bytes:
            if self._done:
                return b""
            self._done = True
            return body

        def getcode(self) -> int:
            return status

        def __enter__(self):
            return self

        def __exit__(self, *exc) -> bool:
            return False

    def _open(request, timeout: float = 30):  # noqa: ARG001
        return R()

    return _open


class Da017AggregatorListTest(unittest.TestCase):
    """Nackte Liste vom Aggregator: 'merged'-Fallback statt AttributeError."""

    def test_aggregate_als_liste_faellt_auf_merged_zurueck(self) -> None:
        payload = {"prompt": "mach einen song", "execute": False}
        plan_a = {"steps": [{"tool": "music.generate", "args": {"prompt": "a"}}]}
        plan_b = {"steps": [{"tool": "music.generate", "args": {"prompt": "b"}}]}
        calls = {"n": 0}

        def fake_generate_chat(model_name, definition, messages, max_new_tokens=512):
            calls["n"] += 1
            if calls["n"] == 1:  # classifier
                return {"text": json.dumps({"areas": ["music"], "intent": "song", "needs_tools": True})}
            if calls["n"] in (2, 3):  # planner a/b
                return {"text": json.dumps({"steps": []})}
            # 4. Call: Aggregator liefert eine NAKTE LISTE (der Befundfall).
            return {"text": json.dumps(["a", "b", "merged"])}

        with mock.patch.object(moa, "resolve_moa_models", return_value={
            "classifier": "m-c", "planner_a": "m-a", "planner_b": "m-b", "aggregator": "m-g",
        }), mock.patch("registry.load_manifest", return_value={"models": [
            {"id": "m-c", "repository": "r", "revision": "1"},
            {"id": "m-a", "repository": "r", "revision": "1"},
            {"id": "m-b", "repository": "r", "revision": "1"},
            {"id": "m-g", "repository": "r", "revision": "1"},
        ]}), mock.patch("handlers_runpod.generate_chat", side_effect=fake_generate_chat):
            result = moa.moa_orchestrate("m-c", None, payload)
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["choice"], "merged")
        self.assertEqual(result["reason"], "")


class Da016ExecuteBudgetTest(unittest.TestCase):
    """execute_steps: Gesamtbudget statt N x 600 s."""

    def setUp(self) -> None:
        self._sleeper = mock.patch.object(moa.time, "sleep", lambda *_: None)
        self._sleeper.start()

    def tearDown(self) -> None:
        self._sleeper.stop()

    def _patch_poll_run(self, states):
        """release/run ok, query_result immer 'in progress' (laeuft bis Timeout)."""
        n = {"i": 0}

        def _open(request, timeout: float = 30):
            n["i"] += 1
            url = getattr(request, "full_url", "")
            if url.endswith("/run"):
                body = json.dumps({"id": f"job-{n['i']}", "status": "IN_QUEUE"}).encode()
                return fake_urlopen(body)(request, timeout)
            # query_result: nie fertig
            body = json.dumps({"output": {"status": "IN_PROGRESS"}}).encode()
            return fake_urlopen(body)(request, timeout)

        return _open

    def test_budget_erschoepft_laeuft_schritte_als_skipped(self) -> None:
        steps = [{"tool": "ears.analyze", "args": {"tasks": ["bpm"]}} for _ in range(4)]
        with mock.patch.dict("os.environ", ENV, clear=False), \
                mock.patch.object(moa.urllib.request, "urlopen", self._patch_poll_run(states=None)):
            # Schritt 1 beendet das Budget (Timeout nach 0.05 s), Rest: SKIPPED.
            results = moa.execute_steps(steps, env=ENV, budget_s=0.05)
        self.assertEqual(len(results), 4)
        self.assertEqual(results[0]["status"], "TIMEOUT")
        for skipped in results[1:]:
            self.assertEqual(skipped["status"], "SKIPPED")
            self.assertIn("Budget", skipped["error"])

    def test_ungueltiges_budget_faellt_auf_default_zurueck(self) -> None:
        steps: list = []
        with mock.patch.dict("os.environ", {"MOA_EXECUTE_BUDGET_S": "banana"}, clear=False):
            results = moa.execute_steps(steps, env=ENV)  # nur Parsing-Pfad
        self.assertEqual(results, [])


class Da018ToolArgsTest(unittest.TestCase):
    """call_tool prueft die Argumente, bevor der RunPod-Request gebaut wird."""

    def setUp(self) -> None:
        self._sleeper = mock.patch.object(moa.time, "sleep", lambda *_: None)
        self._sleeper.start()
        self.sent: list = []
        self._urlopen = mock.patch.object(
            moa.urllib.request,
            "urlopen",
            self._capture_urlopen,
        )
        self._urlopen.start()

    def _capture_urlopen(self, request, timeout: float = 30):
        url = getattr(request, "full_url", "")
        raw = request.data or b"{}"
        try:
            self.sent.append((url, json.loads(raw.decode())))
        except (ValueError, UnicodeDecodeError):
            self.sent.append((url, None))
        if url.endswith("/run"):
            return fake_urlopen(json.dumps({"id": "job-1", "status": "IN_QUEUE"}).encode())(request, timeout)
        if "/status/" in url:
            # RunPod-/status-Vertrag: COMPLETED beendet den Poll-Loop sofort.
            output = {"audioBase64": "QUFB", "sampleRate": 24000}
            return fake_urlopen(json.dumps({"status": "COMPLETED", "output": output}).encode())(request, timeout)
        # alles andere ( sollte nicht passieren): hart scheitern statt hangen
        raise urllib.error.URLError(f"unerwarteter Stub-Aufruf: {url}")

    def tearDown(self) -> None:
        self._urlopen.stop()
        self._sleeper.stop()

    def test_unbekannte_schluessel_kommen_nicht_beim_worker_an(self) -> None:
        moa.call_tool(
            "ears.analyze",
            {"tasks": ["bpm"], "evil_injected": {"x": 1}, "prompt": "hai"},
            env=ENV,
        )
        run_inputs = [payload for url, payload in self.sent if url.endswith("/run")]
        self.assertTrue(run_inputs)
        inner = run_inputs[0]["input"]
        self.assertEqual(inner["input"]["tasks"], ["bpm"])
        self.assertNotIn("evil_injected", inner["input"])
        # prompt ist ein erlaubter Parameter und bleibt erhalten.
        self.assertEqual(inner["input"]["prompt"], "hai")

    def test_riese_string_wird_begrenzt_nicht_durchgereicht(self) -> None:
        moa.call_tool("ears.transcribe", {"prompt": "x" * 50_000}, env=ENV)
        run_inputs = [payload for url, payload in self.sent if url.endswith("/run")]
        self.assertTrue(run_inputs)
        prompt_value = run_inputs[0]["input"]["input"]["prompt"]
        self.assertLessEqual(len(prompt_value), moa.TOOL_ARG_LIMITS["maxStringChars"])

    def test_args_als_liste_scheitert_als_failed_nicht_als_crash(self) -> None:
        results = moa.execute_steps(
            [{"tool": "ears.analyze", "args": ["nicht", "ein", "objekt"]}],
            env=ENV,
        )
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["status"], "FAILED")
        self.assertIn("ToolArgsError", results[0]["error"])
        # Nichts wurde an den Worker geschickt.
        self.assertEqual([url for url, _ in self.sent if url.endswith("/run")], [])

    def test_validate_tool_args_rein(self) -> None:
        clean = moa.validate_tool_args("ears.analyze", {"tasks": ["bpm"], "__proto__": {"x": 1}})
        self.assertEqual(clean, {"tasks": ["bpm"]})
        with self.assertRaises(moa.ToolArgsError):
            moa.validate_tool_args("ears.analyze", "kein objekt")
        with self.assertRaises(moa.ToolArgsError):
            moa.validate_tool_args("ears.analyze", {f"k{i}": 1 for i in range(30)})
        # permission ist immer erlaubt, unbekannte Schluessel werden verworfen
        clean = moa.validate_tool_args("ears.analyze", {"permission": "read", "fremd": 1})
        self.assertEqual(clean, {"permission": "read"})
        # Werkzeug ausserhalb des Katalogs: nur Struktur-Grenzen (Allowlist=None)
        clean = moa.validate_tool_args("nicht.im.katalog", {"frei": 1})
        self.assertEqual(clean, {"frei": 1})


if __name__ == "__main__":
    unittest.main(verbosity=2)
