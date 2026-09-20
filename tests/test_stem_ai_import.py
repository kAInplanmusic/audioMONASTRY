"""Regressionstest fuer den stem-ai-Importpfad (Layout-Falle, 2026-09-20).

Befund: `services/stem-ai/main.py` importiert `device_utils` - ein Modul, das
unter `services/backend-core/python/` liegt. Das Dockerfile kopiert es neben
`main.py`, der venv-/systemd-Weg (`scripts/hetzner/install-ai1.sh`) tat das
NICHT. Auf ai-1 lief der Dienst deshalb in eine Restart-Schleife
(`ModuleNotFoundError: No module named 'device_utils'`), und der Stem-Pfad der
App zeigte auf einen toten Port 8000 - der Befund fiel erst beim Deploy auf,
weil der Container-Pfad funktionierte.

Dieser Test faehrt den ECHTEN Import des Dienstes nach, aber
  * mit einem Stub fuer `fastapi` (keine Netz-/Abhaengigkeitspruefung),
  * in einem Verzeichnis OHNE `device_utils.py` neben `main.py`
und belegt damit, dass der Fallback in `main.py` den gemeinsamen Modulort
findet, statt eine zweite Kopie zu verlangen.

Lauf: python3 tests/test_stem_ai_import.py
"""
from __future__ import annotations

import pathlib
import subprocess
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
SERVICE_DIR = ROOT / "services" / "stem-ai"
SHARED_MODULE = ROOT / "services" / "backend-core" / "python" / "device_utils.py"

#: Importiert main.py mit gestubbtem fastapi. Gibt den Pfad aus, aus dem
#: `device_utils` tatsaechlich geladen wurde (das ist der Beweis).
PROBE = r"""
import sys, types, pathlib

fake = types.ModuleType("fastapi")
class _HTTPException(Exception):
    def __init__(self, *args, **kwargs):
        super().__init__(*args)
fake.FastAPI = lambda **kwargs: types.SimpleNamespace(get=lambda *a, **k: (lambda f: f),
                                                      post=lambda *a, **k: (lambda f: f))
fake.File = lambda *a, **k: None
fake.HTTPException = _HTTPException
fake.UploadFile = object
responses = types.ModuleType("fastapi.responses")
responses.FileResponse = object
responses.JSONResponse = object
sys.modules["fastapi"] = fake
sys.modules["fastapi.responses"] = responses

service_dir = pathlib.Path(sys.argv[1]).resolve()
sys.path.insert(0, str(service_dir))
assert not (service_dir / "device_utils.py").exists(), "Testannahme verletzt: Kopie liegt doch daneben"

import main

print("resolve_device:", callable(main.resolve_device))
print("modul:", sys.modules["device_utils"].__file__)
"""


class StemAiImportTest(unittest.TestCase):
    def test_dienst_importiert_ohne_kopie_des_gemeinsamen_moduls(self) -> None:
        self.assertTrue(SHARED_MODULE.exists(), f"gemeinsames Modul fehlt: {SHARED_MODULE}")
        result = subprocess.run(
            ["python3", "-c", PROBE, str(SERVICE_DIR)],
            capture_output=True, text=True, timeout=120, cwd=ROOT,
        )
        combined = result.stdout + result.stderr
        self.assertEqual(result.returncode, 0, combined)
        self.assertIn("resolve_device: True", combined)
        # Geladen wurde das Modul aus backend-core/python - nicht aus einer Kopie.
        self.assertIn(str(SHARED_MODULE), combined, combined)

    def test_dockerfile_und_venv_weg_bleiben_deckungsgleich(self) -> None:
        """Beide Ablageorte muessen denselben Importpfad bedienen: der Container
        kopiert das Modul, der venv-Weg nicht - deshalb gibt es den Fallback in
        main.py. Der Test haelt fest, dass beide Wege im Repo existieren."""
        dockerfile = (SERVICE_DIR / "Dockerfile").read_text(encoding="utf-8")
        self.assertIn("backend-core/python/device_utils.py", dockerfile)
        main_py = (SERVICE_DIR / "main.py").read_text(encoding="utf-8")
        self.assertIn("except ModuleNotFoundError", main_py)
        self.assertIn("backend-core", main_py)


if __name__ == "__main__":
    unittest.main()
