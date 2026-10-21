"""INFRA-RUNPOD-020: pod_start._writable_dir - Schreibbarkeits-Fallback.

    python3 services/audiomonastry-ai-runtime/tests/test_pod_start_writable_dir.py

Der Live-Befund (2026-10-21, ears-debug-Pod): RunPod mountet bei
volumeInGb=0 das /workspace OHNE Schreibrechte - der bisherige Default
(/workspace/hf-cache) liess pod_start sofort mit
PermissionError [Errno 13] auf /workspace/hf-cache sterben (exit 3 ->
Restart-Loop, /ready nie erreichbar).

Geprueft wird der Fallback-Vertrag:
* bevorzugter Kandidat schreibbar -> er wird genutzt (kein Fallback-Log),
* bevorzugter Kandidat NICHT schreibbar -> Fallback-Verzeichnis wird
  angelegt und genutzt, lauter WARN im Log,
* ENV-Override schlaegt beide Kandidaten (betreiberkontrolliert),
* gar kein Kandidat schreibbar -> OSError mit allen Kandidaten im Text.
"""
from __future__ import annotations

import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

RUNTIME_DIR = pathlib.Path(__file__).resolve().parent.parent
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

import pod_start  # noqa: E402


class WritableDirFallbackTest(unittest.TestCase):
    def test_bevorzugter_kandidat_schreibbar_wird_genutzt(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            preferred = os.path.join(tmp, "hf-cache")
            fallback = os.path.join(tmp, "fallback")
            with mock.patch.object(pod_start, "log") as log_mock:
                result = pod_start._writable_dir("HF_HOME_TEST", preferred, fallback)
            self.assertEqual(result, preferred)
            self.assertTrue(os.path.isdir(preferred))
            warns = [c for c in log_mock.call_args_list if c.args and c.args[0] == "WARN"]
            self.assertEqual(warns, [], "bei schreibbarem Preferred darf kein WARN kommen")

    def test_nicht_schreibbarer_preferred_faellt_auf_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            # /dev/null ist kein Verzeichnis - makedirs/probe scheitert garantiert.
            preferred = "/dev/null/kein-verzeichnis"
            fallback = os.path.join(tmp, "weights-tmp")
            with mock.patch.object(pod_start, "log") as log_mock:
                result = pod_start._writable_dir("AI_WEIGHTS_TMP_TEST", preferred, fallback)
            self.assertEqual(result, fallback)
            self.assertTrue(os.path.isdir(fallback))
            # INFRA-RUNPOD-020: der Fallback muss LAUT sein (der Operator soll
            # den Volume-Weg sehen), nicht still.
            warns = [c for c in log_mock.call_args_list if c.args and c.args[0] == "WARN"]
            self.assertTrue(warns, "Fallback ohne WARN ist still - verboten")

    def test_env_override_schlaegt_beide_kandidaten(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            env_dir = os.path.join(tmp, "env-override")
            preferred = os.path.join(tmp, "preferred")
            fallback = os.path.join(tmp, "fallback")
            with mock.patch.dict(os.environ, {"HF_HOME_TEST": env_dir}):
                result = pod_start._writable_dir("HF_HOME_TEST", preferred, fallback)
            self.assertEqual(result, env_dir)

    def test_garnichts_schreibbar_wirft_oserror_mit_alle_kandidaten(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            # Beide Kandidaten durch eine DATEI im Pfad blockieren (a/b ist
            # eine Datei -> makedirs scheitert fuer alle Kinder darunter).
            open(os.path.join(tmp, "blocker"), "w").close()
            preferred = os.path.join(tmp, "blocker", "hf-cache")
            fallback = os.path.join(tmp, "blocker", "weights-tmp")
            with self.assertRaises(OSError) as ctx:
                pod_start._writable_dir("X_TEST", preferred, fallback)
            self.assertIn("X_TEST", str(ctx.exception))
            self.assertIn(preferred, str(ctx.exception))
            self.assertIn(fallback, str(ctx.exception))


if __name__ == "__main__":
    unittest.main(verbosity=2)
