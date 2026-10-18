"""Waechter fuer den ComfyUI-Antwortvertrag (ohne GPU, ohne Netz).

Anlass: DA-2026-09-29-049 (Deep-Audit, F52) - `contracts-20260916.json` war eine
Messprotokoll-Sammlung ohne Schema-Version und ohne Kennzeichnung, welche Felder
ein erfolgreicher Job GARANTIERT liefert. Wer den Adapter danach baute, konnte
Pflicht- und Kann-Felder nicht unterscheiden.

Dieser Test haelt drei Dinge fest:
  * `schemaVersion` und `kind` sind gesetzt (der Vertrag ist versioniert),
  * JEDES Antwortfeld traegt `required: true|false`,
  * die Felder, auf die der Adapter baut, sind als Pflicht markiert.

Lauf: python3 services/audiomonastry-ai-runtime/tests/test_contracts_schema.py
"""
from __future__ import annotations

import json
import pathlib
import unittest
from typing import Any, Dict, List

RUNTIME_DIR = pathlib.Path(__file__).resolve().parent.parent
CONTRACT = RUNTIME_DIR / "workflows" / "contracts-20260916.json"

#: Felder, ohne die der jeweilige Adapterpfad nicht arbeiten kann.
REQUIRED_BY_ADAPTER = {
    "imageHq": ["image_url"],
    "music": ["files"],
    "videoReal": ["video"],
}


def _contract() -> Dict[str, Any]:
    return json.loads(CONTRACT.read_text(encoding="utf-8"))


def _field_nodes(node: Any, prefix: str = "") -> List[tuple]:
    """Alle Vertragsfelder als (Pfad, Knoten) - auch verschachtelte wie `first`."""
    found: List[tuple] = []
    if isinstance(node, dict):
        for key, value in node.items():
            path = f"{prefix}.{key}" if prefix else key
            if isinstance(value, dict) and "type" in value:
                found.append((path, value))
                found.extend(_field_nodes(value, path))
            else:
                found.extend(_field_nodes(value, path))
    return found


class ContractSchemaTest(unittest.TestCase):
    def setUp(self) -> None:
        self.contract = _contract()

    def test_vertrag_ist_versioniert(self) -> None:
        self.assertIsInstance(self.contract.get("schemaVersion"), int)
        self.assertGreaterEqual(self.contract["schemaVersion"], 1)
        self.assertEqual(self.contract.get("kind"), "comfyui-worker-response-contract")
        # Ohne die Semantik von `required` ist die Kennzeichnung nicht lesbar.
        self.assertIn("required=true", self.contract.get("requiredSemantics", ""))

    def test_jedes_antwortfeld_hat_required(self) -> None:
        missing: List[str] = []
        checked = 0
        for role, spec in self.contract["roles"].items():
            for path, node in _field_nodes(spec.get("response", {})):
                checked += 1
                if not isinstance(node.get("required"), bool):
                    missing.append(f"{role}.response.{path}")
        # Der Vertrag hat 9 Antwortfelder (inkl. Unterfeldern); weniger waere ein
        # Zeichen dafuer, dass der Walker nichts mehr findet.
        self.assertGreaterEqual(checked, 9)
        self.assertEqual(missing, [])

    def test_adapter_pflichtfelder_sind_als_pflicht_markiert(self) -> None:
        for role, fields in REQUIRED_BY_ADAPTER.items():
            response = self.contract["roles"][role]["response"]
            for field in fields:
                with self.subTest(role=role, field=field):
                    self.assertIs(response[field].get("required"), True, f"{role}.{field}")

    def test_jede_rolle_hat_ein_protokoll(self) -> None:
        for role, spec in self.contract["roles"].items():
            with self.subTest(role=role):
                self.assertIn(spec.get("protocol"), {"prompt", "workflow"})

    def test_keine_offenen_messluecken_als_vertrag(self) -> None:
        # Der videoReal-Eintrag wurde ohne --out gemessen (chars/decodedBytes 0).
        # Das darf nicht als "Feld ist leer" gelesen werden - der Vermerk muss
        # die Luecke benennen, statt sie zu verschweigen (F52).
        note = self.contract["roles"]["videoReal"].get("note", "")
        self.assertIn("NICHT nachgemessen", note)


if __name__ == "__main__":
    unittest.main(verbosity=2)
