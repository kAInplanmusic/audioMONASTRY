"""DA-2026-10-17-010 / DA-2026-10-17-012: Netz-Robustheit der MCP-Bruecke.

    python3 services/audiomonastry-ai-runtime/tests/test_moa_network_resilience.py

Kein Netz, keine GPU, keine echte Wartezeit: `urlopen` und `time.sleep` sind
Stubs. Geprueft wird das Verhalten, das im Live-Betrieb zaehlt:

* DA-2026-10-17-010 – ein Timeout/ECONNRESET im Poll-Loop bricht den Task NICHT
  ab; erst N transiente Fehler IN FOLGE (oder die Deadline) beenden ihn. Harte
  Fehler (4xx, kaputtes JSON, Groessenlimit) werfen weiterhin sofort.
* DA-2026-10-17-012 – der Antwortkoerper wird mit Content-Length-Vorabpruefung
  UND Streaming-Zaehler gelesen; ueber dem Budget bricht der Aufruf ab, statt
  die Datei (Audio kommt base64 im JSON) komplett in den Heap zu laden.
"""
from __future__ import annotations

import json
import pathlib
import sys
import unittest
import urllib.error
from unittest import mock

RUNTIME_DIR = pathlib.Path(__file__).resolve().parent.parent
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

import moa_orchestrator as moa  # noqa: E402

ENV = {
    "RP_ENDPOINT_ID_EARS": "ears-ep",
    "RP_AGENT_KEY": "test-key",
    "RUNPOD_API_BASE": "https://stub.local/v2",
}


class FakeResponse:
    """Minimal-HTTP-Antwort: Header, Body, gezaehlte Reads."""

    def __init__(self, body: bytes = b"", headers=None, chunk: int = 4096) -> None:
        self._body = body
        self._pos = 0
        self._chunk = chunk
        self.headers = dict(headers or {})
        self.reads = 0
        self.bytes_read = 0

    def read(self, n: int = -1) -> bytes:
        self.reads += 1
        size = self._chunk if n is None or n < 0 else n
        block = self._body[self._pos : self._pos + size]
        self._pos += len(block)
        self.bytes_read += len(block)
        return block

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_exc) -> bool:
        return False


class EndlessResponse:
    """Chunked-Endlosstream ohne Content-Length (der OOM-Fall aus DA-012)."""

    def __init__(self) -> None:
        self.headers = {}
        self.bytes_read = 0

    def read(self, n: int = -1) -> bytes:
        size = 4096 if n is None or n < 0 else n
        self.bytes_read += size
        return b"x" * size

    def __enter__(self) -> "EndlessResponse":
        return self

    def __exit__(self, *_exc) -> bool:
        return False


class ScriptedUrlopen:
    """Antwortet der Reihe nach: Response-Objekt oder zu werfende Exception."""

    def __init__(self, *items) -> None:
        self.items = list(items)
        self.calls = []

    def __call__(self, request, timeout=None):
        self.calls.append((getattr(request, "full_url", str(request)), timeout))
        if not self.items:
            raise AssertionError("urlopen ohne Skript aufgerufen")
        item = self.items.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item


def _json(body) -> FakeResponse:
    raw = json.dumps(body).encode()
    return FakeResponse(raw, headers={"Content-Length": str(len(raw))})


def _run_ok(job_id: str = "job-1") -> FakeResponse:
    return _json({"id": job_id})


def _status_ok(status: str = "COMPLETED", output=None) -> FakeResponse:
    return _json({"status": status, "output": output if output is not None else {"bpm": 128}})


class PollRetryTest(unittest.TestCase):
    """DA-2026-10-17-010: transiente Netzfehler im Poll-Loop."""

    def _call(self, opener: ScriptedUrlopen, **kwargs):
        with mock.patch.object(moa.urllib.request, "urlopen", opener), \
                mock.patch.object(moa.time, "sleep", lambda _s: None):
            return moa.call_tool("ears.analyze", {"tasks": ["bpm"]}, env=ENV, timeout_s=30.0, poll_s=0, **kwargs)

    def test_ein_timeout_bricht_den_task_nicht_ab(self) -> None:
        opener = ScriptedUrlopen(_run_ok(), TimeoutError("read timed out"), _status_ok())
        result = self._call(opener)
        self.assertEqual(result["status"], "COMPLETED")
        self.assertEqual(result["output"], {"bpm": 128})
        # /run + erster Statusversuch + erfolgreicher zweiter Versuch
        self.assertEqual(len(opener.calls), 3)

    def test_ein_connection_reset_bricht_den_task_nicht_ab(self) -> None:
        opener = ScriptedUrlopen(_run_ok(), ConnectionResetError("reset by peer"), _status_ok())
        self.assertEqual(self._call(opener)["status"], "COMPLETED")

    def test_5xx_ist_transient_und_wird_wiederholt(self) -> None:
        error = urllib.error.HTTPError("https://stub.local/v2/status", 503, "Service Unavailable", None, None)
        self.addCleanup(error.close)  # HTTPError haelt sonst einen Temp-Handle bis zum GC
        opener = ScriptedUrlopen(_run_ok(), error, _status_ok())
        self.assertEqual(self._call(opener)["status"], "COMPLETED")

    def test_drei_transiente_fehler_in_folge_werden_toleriert(self) -> None:
        opener = ScriptedUrlopen(
            _run_ok(),
            TimeoutError("1"),
            TimeoutError("2"),
            TimeoutError("3"),
            _status_ok(),
        )
        self.assertEqual(self._call(opener)["status"], "COMPLETED")
        self.assertEqual(len(opener.calls), 5)

    def test_backoff_waechst_und_bleibt_gedeckelt(self) -> None:
        sleeps = []
        opener = ScriptedUrlopen(
            _run_ok(),
            TimeoutError("1"),
            TimeoutError("2"),
            TimeoutError("3"),
            _status_ok(),
        )
        with mock.patch.object(moa.urllib.request, "urlopen", opener), \
                mock.patch.object(moa.time, "sleep", sleeps.append):
            moa.call_tool("ears.analyze", {}, env=ENV, timeout_s=30.0, poll_s=0)
        # 1 s, 2 s, 4 s – exponentiell, aber gedeckelt (POLL_BACKOFF_MAX_S).
        self.assertEqual(sleeps, [1.0, 2.0, 4.0])
        self.assertTrue(all(s <= moa.POLL_BACKOFF_MAX_S for s in sleeps))

    def test_zu_viele_transiente_fehler_geben_auf(self) -> None:
        opener = ScriptedUrlopen(
            _run_ok(),
            *[TimeoutError(f"timeout-{i}") for i in range(moa.POLL_MAX_TRANSIENT_ERRORS + 1)],
        )
        with self.assertRaises(moa.TransientNetworkError) as ctx:
            self._call(opener)
        message = str(ctx.exception)
        self.assertIn("transiente Netzfehler", message)
        self.assertIn("laeuft auf RunPod weiter", message)
        # OSError-Vererbung: `execute_steps` fuehrt den Schritt als FAILED, statt zu werfen.
        self.assertIsInstance(ctx.exception, OSError)

    def test_harter_fehler_wirft_sofort(self) -> None:
        error = urllib.error.HTTPError("https://stub.local/v2/status", 404, "Not Found", None, None)
        self.addCleanup(error.close)
        opener = ScriptedUrlopen(_run_ok(), error, _status_ok())
        with self.assertRaises(urllib.error.HTTPError):
            self._call(opener)
        # Genau EIN Statusversuch: kein Retry auf einen 404.
        self.assertEqual(len(opener.calls), 2)

    def test_ungueltiges_json_ist_ein_harter_fehler(self) -> None:
        broken = FakeResponse(b"<html>kaputt</html>", headers={"Content-Length": "18"})
        opener = ScriptedUrlopen(_run_ok(), broken, _status_ok())
        with self.assertRaises(json.JSONDecodeError):
            self._call(opener)
        self.assertEqual(len(opener.calls), 2)

    def test_in_progress_wartet_weiter(self) -> None:
        opener = ScriptedUrlopen(_run_ok(), _status_ok("IN_QUEUE", None), _status_ok(), _status_ok())
        self.assertEqual(self._call(opener)["status"], "COMPLETED")


class ResponseBudgetTest(unittest.TestCase):
    """DA-2026-10-17-012: Groessenlimit fuer den Antwortkoerper."""

    def test_content_length_ueber_dem_limit_bricht_vor_dem_lesen_ab(self) -> None:
        response = FakeResponse(b"", headers={"Content-Length": str(10 * 1024 * 1024)})
        with self.assertRaises(moa.ResponseTooLargeError) as ctx:
            moa._read_limited(response, limit=1024, label="test /status")
        self.assertIn("Content-Length", str(ctx.exception))
        self.assertEqual(response.reads, 0, "Header-Pruefung muss VOR dem Lesen greifen")

    def test_streaming_zaehler_bricht_bei_chunked_endlosstrom_ab(self) -> None:
        response = EndlessResponse()
        with self.assertRaises(moa.ResponseTooLargeError) as ctx:
            moa._read_limited(response, limit=64 * 1024, label="test /status")
        self.assertIn("Streaming-Zaehler", str(ctx.exception))
        # Der Zaehler greift im Block ueber dem Limit - nicht erst nach Gigabytes.
        self.assertLessEqual(response.bytes_read, 2 * moa.READ_CHUNK_BYTES)

    def test_luegender_content_length_hebelt_den_zaehler_nicht_aus(self) -> None:
        body = b"x" * (256 * 1024)
        response = FakeResponse(body, headers={"Content-Length": "10"})
        with self.assertRaises(moa.ResponseTooLargeError) as ctx:
            moa._read_limited(response, limit=64 * 1024, label="test /status")
        self.assertIn("Streaming-Zaehler", str(ctx.exception))

    def test_antwort_innerhalb_des_budgets_wird_gelesen(self) -> None:
        body = b"y" * (200 * 1024)
        response = FakeResponse(body, headers={"Content-Length": str(len(body))})
        self.assertEqual(moa._read_limited(response, limit=1024 * 1024), body)

    def test_limit_gilt_auch_fuer_den_status_aufruf(self) -> None:
        huge = FakeResponse(b"", headers={"Content-Length": str(moa.MAX_RESPONSE_BYTES + 1)})
        opener = ScriptedUrlopen(_run_ok(), huge)
        with mock.patch.object(moa.urllib.request, "urlopen", opener), \
                mock.patch.object(moa.time, "sleep", lambda _s: None), \
                self.assertRaises(moa.ResponseTooLargeError):
            moa.call_tool("ears.analyze", {}, env=ENV, timeout_s=30.0, poll_s=0)

    def test_execute_steps_meldet_das_limit_als_failed(self) -> None:
        huge = _json({"b64": "z" * 10})
        huge.headers["Content-Length"] = str(moa.MAX_RESPONSE_BYTES + 1)
        opener = ScriptedUrlopen(huge)
        with mock.patch.object(moa.urllib.request, "urlopen", opener):
            results = moa.execute_steps([{"tool": "ears.analyze", "args": {}}], env=ENV)
        self.assertEqual(results[0]["status"], "FAILED")
        self.assertIn("ResponseTooLargeError", results[0]["error"])


class LimitsConfigTest(unittest.TestCase):
    """Ein Tippfehler in der Umgebung darf den Import nicht toeten."""

    def test_ungueltige_zahl_faellt_auf_den_default_zurueck(self) -> None:
        with mock.patch.dict(moa.os.environ, {"MOA_TEST_GARBAGE": "hundert"}):
            self.assertEqual(moa._env_number("MOA_TEST_GARBAGE", 3, int), 3)

    def test_gueltige_zahl_wird_uebernommen(self) -> None:
        with mock.patch.dict(moa.os.environ, {"MOA_TEST_GARBAGE": "7"}):
            self.assertEqual(moa._env_number("MOA_TEST_GARBAGE", 3, int), 7)

    def test_leere_umgebung_nutzt_den_default(self) -> None:
        with mock.patch.dict(moa.os.environ, {}, clear=False):
            moa.os.environ.pop("MOA_TEST_GARBAGE", None)
            self.assertEqual(moa._env_number("MOA_TEST_GARBAGE", 100, int), 100)


if __name__ == "__main__":
    unittest.main(verbosity=2)
