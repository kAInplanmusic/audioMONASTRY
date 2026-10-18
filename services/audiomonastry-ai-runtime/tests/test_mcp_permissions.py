"""Tests der MCP-Berechtigungsleiter (ohne GPU, ohne Netz).

Anlass: DA-2026-09-29-049 (Deep-Audit, F41) - nach der Stufenpruefung stand eine
zweite, unerreichbare Pruefung `required == "DESTRUCTIVE" and granted !=
"DESTRUCTIVE"`. Sie konnte nie greifen (die Stufenpruefung weist alles unter
Stufe 4 schon ab) und behauptete trotzdem eine zweite Regel.

Dieser Test haelt die EINE Regel fest: eine Aktion laeuft genau dann, wenn die
gewaehrte Stufe >= der geforderten ist - und die Stufe kommt aus dem
Server-Kontext, nie aus dem Payload.

Lauf: python3 services/audiomonastry-ai-runtime/tests/test_mcp_permissions.py
"""
from __future__ import annotations

import pathlib
import sys
import unittest

RUNTIME_DIR = pathlib.Path(__file__).resolve().parent.parent
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

import mcp_runtime as runtime  # noqa: E402


class _StubManager:
    """Minimaler Manager: die Handler werden hier nicht gebraucht."""

    def gpu_state(self) -> dict:
        return {"device": "cpu"}

    def get_model_info(self) -> list:
        return []

    def get_status(self) -> dict:
        return {}

    def load(self, model_id: str) -> None:  # pragma: no cover - nicht benutzt
        raise AssertionError("darf nicht geladen werden")

    def unload(self, model_id: str) -> None:  # pragma: no cover - nicht benutzt
        raise AssertionError("darf nicht entladen werden")


class PermissionLadderTest(unittest.TestCase):
    def setUp(self) -> None:
        self.runtime = runtime.McpRuntime(_StubManager())

    def test_read_tool_mit_lesestufe_ist_erlaubt(self) -> None:
        result = self.runtime.invoke("runtime.status", {}, server_permission="READ")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["result"], {"device": "cpu"})

    def test_hoehere_stufe_darf_niedrigere_tools_nutzen(self) -> None:
        for granted in ("WRITE", "EXECUTION", "DESTRUCTIVE"):
            with self.subTest(granted=granted):
                self.assertTrue(self.runtime.invoke("session.getState", {}, server_permission=granted)["ok"])

    def test_niedrigere_stufe_wird_abgewiesen(self) -> None:
        # sample.search verlangt EXECUTION (DA-2026-09-29-021).
        for granted in ("READ", "WRITE"):
            with self.subTest(granted=granted):
                result = self.runtime.invoke(
                    "sample.search", {"model": "clap", "query": "kick"}, server_permission=granted
                )
                self.assertFalse(result["ok"], result)
                self.assertIn("permission denied", result["error"])

    def test_unbekannte_stufe_faellt_auf_read_zurueck(self) -> None:
        result = self.runtime.invoke(
            "sample.search", {"model": "clap", "query": "kick"}, server_permission="ROOT"
        )
        self.assertFalse(result["ok"], result)
        self.assertIn("permission denied", result["error"])

    def test_payload_kann_die_stufe_nicht_erhoehen(self) -> None:
        # FA-P0-1: eine im Payload mitgeschickte Stufe wird ignoriert.
        result = self.runtime.invoke(
            "sample.search",
            {"model": "clap", "query": "kick", "permission": "DESTRUCTIVE", "server_permission": "DESTRUCTIVE"},
            server_permission="READ",
        )
        self.assertFalse(result["ok"], result)

    def test_kein_tool_ist_derzeit_destructive(self) -> None:
        # Solange kein Handler DESTRUCTIVE verlangt, ist die Stufe 4 die reine
        # Obergrenze der Leiter - sie bleibt trotzdem geprueft (siehe unten).
        self.assertEqual([name for name, spec in runtime.TOOLS.items() if spec["permission"] == "DESTRUCTIVE"], [])

    def test_stufe_4_ist_die_obergrenze(self) -> None:
        self.assertEqual(runtime.PERMISSION_LEVELS, {"READ": 1, "WRITE": 2, "EXECUTION": 3, "DESTRUCTIVE": 4})

    def test_zweite_destructive_pruefung_ist_weg(self) -> None:
        # F41: der unerreichbare Sonderfall darf nicht zurueckkommen - er wuerde
        # eine zweite Regel behaupten, die die Stufenpruefung schon abdeckt.
        # Geprueft wird die CODE-Wirkung (die eigene Fehlermeldung des Zweigs),
        # nicht das Wort im Kommentar, der den Befund dokumentiert.
        source = (RUNTIME_DIR / "mcp_runtime.py").read_text(encoding="utf-8")
        self.assertNotIn("destructive action requires explicit DESTRUCTIVE permission", source)
        self.assertEqual(source.count('"error": f"permission denied'), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
