"""Regressionstest: repository/revision-Validierung (FA-P2-2 / QUAL-P2-005).

Reiner Python-Smoke ohne schwere Abhängigkeiten (nur stdlib + `model_manager`),
damit er in jedem CI-Lauf und lokal läuft:

    python3 services/samplemonk-ai-runtime/tests/test_model_definition.py

Er prüft genau die Lücke aus dem Fremdaudit: dass `ModelDefinition.from_dict`
unsichere `repository`-/`revision`-Werte ablehnt und dass das eingecheckte
`model_manifest.json` ausschließlich gepinnte Revisionen (kein `latest`) enthält.
"""
from __future__ import annotations

import json
import pathlib
import sys
import unittest

RUNTIME_DIR = pathlib.Path(__file__).resolve().parent.parent
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from model_manager import ModelDefinition  # noqa: E402


def definition(**overrides: object) -> dict:
    base = {
        "id": "test-model",
        "repository": "Qwen/Qwen3-14B",
        "revision": "31c69efc29464b6bb0aee1398b5a7b50a99340c3",
        "task": "llm",
    }
    base.update(overrides)
    return base


class TestModelDefinitionValidation(unittest.TestCase):
    def test_akzeptiert_gepinnte_definition(self) -> None:
        model = ModelDefinition.from_dict(definition())
        self.assertEqual(model.repository, "Qwen/Qwen3-14B")
        self.assertEqual(model.revision, "31c69efc29464b6bb0aee1398b5a7b50a99340c3")

    def test_lehnt_unsichere_repositories_ab(self) -> None:
        for bad in ("../etc/passwd", "has space/repo", "http://evil.example/repo", "/abs/path", "-leading-dash"):
            with self.subTest(repository=bad):
                with self.assertRaises(ValueError):
                    ModelDefinition.from_dict(definition(repository=bad))

    def test_lehnt_unsichere_revisionen_ab(self) -> None:
        for bad in ("abc$", "a b", "rev;rm -rf /", "rev\nlatest", "x" * 200):
            with self.subTest(revision=bad):
                with self.assertRaises(ValueError):
                    ModelDefinition.from_dict(definition(revision=bad))

    def test_leere_revision_bleibt_erlaubt(self) -> None:
        # Leer = kein Pin (Alt-Verhalten); nur ein gesetzter Wert wird geprüft.
        self.assertEqual(ModelDefinition.from_dict(definition(revision="")).revision, "")

    def test_lehnt_ungueltige_id_und_klassen_ab(self) -> None:
        with self.assertRaises(ValueError):
            ModelDefinition.from_dict(definition(id="../evil"))
        with self.assertRaises(ValueError):
            ModelDefinition.from_dict(definition(loadClass="TURBO"))
        with self.assertRaises(ValueError):
            ModelDefinition.from_dict(definition(framework="magic"))
        with self.assertRaises(ValueError):
            ModelDefinition.from_dict(definition(quantization="q4_k_m"))


class TestModelManifest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest = json.loads((RUNTIME_DIR / "model_manifest.json").read_text(encoding="utf-8"))

    def test_alle_modelle_sind_gueltig_und_gepinnt(self) -> None:
        models = self.manifest.get("models", [])
        self.assertGreater(len(models), 0, "Manifest enthält keine Modelle")
        for entry in models:
            with self.subTest(model=entry.get("id")):
                model = ModelDefinition.from_dict(entry)
                self.assertNotEqual(model.revision.lower(), "latest")
                self.assertTrue(model.revision, "jedes Modell braucht eine gepinnte revision")

    def test_modell_ids_sind_eindeutig(self) -> None:
        ids = [entry.get("id") for entry in self.manifest.get("models", [])]
        self.assertEqual(len(ids), len(set(ids)), "doppelte Modell-ID im Manifest")


if __name__ == "__main__":
    unittest.main()
