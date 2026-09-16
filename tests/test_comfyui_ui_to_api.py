"""Regressionstest: ComfyUI UI-Format -> API-Format (scripts/comfyui-ui-to-api.py).

Der Adapter braucht das API-Format, die ComfyUI-UI speichert das UI-Format. Damit
die Umformung nicht „irgendwie“ passiert, prueft dieser Test die Regeln, die den
Unterschied ausmachen:

* verdrahtete Eingaenge werden zu `[<node-id>, <slot>]`,
* Frontend-only-Knoten (PrimitiveNode/PrimitiveInt/MarkdownNote) verschwinden,
  ihre Werte wandern in die verdrahteten Eingaenge,
* reine Frontend-Schalter (`control_after_generate` hinter `seed`) tauchen im
  API-Format nicht auf, verschieben aber auch nicht die uebrigen Widget-Werte,
* Unstimmigkeiten brechen ab, statt still etwas Falsches zu erzeugen.

Lauf: python3 tests/test_comfyui_ui_to_api.py
"""
from __future__ import annotations

import importlib.util
import json
import pathlib
import sys
import unittest
from typing import Any

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "comfyui-ui-to-api.py"


def load_script() -> Any:
    spec = importlib.util.spec_from_file_location("comfyui_ui_to_api", SCRIPT)
    if spec is None or spec.loader is None:  # pragma: no cover
        raise ImportError(f"Skript nicht ladbar: {SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


ui_to_api = load_script()


def graph(nodes: list[dict[str, Any]], links: list[list[Any]]) -> dict[str, Any]:
    return {"nodes": nodes, "links": links}


class UiToApiTest(unittest.TestCase):
    def test_widgets_und_links_landen_richtig(self) -> None:
        api, _ = ui_to_api.ui_to_api(
            graph(
                nodes=[
                    {
                        "id": 1,
                        "type": "UNETLoader",
                        "widgets_values": ["model.safetensors", "default"],
                        "outputs": [{"name": "MODEL", "links": [10]}],
                    },
                    {
                        "id": 2,
                        "type": "KSampler",
                        # seed, control_after_generate (Frontend), steps, cfg, sampler, scheduler, denoise
                        "widgets_values": [7, "fixed", 20, 4.5, "euler", "normal", 1],
                        "inputs": [{"name": "model", "link": 10}],
                    },
                ],
                links=[[10, 1, 0, 2, 0, "MODEL"]],
            )
        )
        self.assertEqual(set(api), {"1", "2"})
        self.assertEqual(api["1"]["inputs"], {"unet_name": "model.safetensors", "weight_dtype": "default"})
        # Der Frontend-Schalter "fixed" ist weg, die restlichen Werte sitzen richtig.
        self.assertEqual(
            api["2"]["inputs"],
            {
                "seed": 7,
                "steps": 20,
                "cfg": 4.5,
                "sampler_name": "euler",
                "scheduler": "normal",
                "denoise": 1,
                "model": ["1", 0],
            },
        )

    def test_primitive_wird_in_den_eingang_gezogen(self) -> None:
        api, _ = ui_to_api.ui_to_api(
            graph(
                nodes=[
                    {"id": 5, "type": "PrimitiveInt", "widgets_values": [42, "fixed"], "outputs": [{"links": [11]}]},
                    {
                        "id": 6,
                        "type": "KSampler",
                        "widgets_values": [0, "fixed", 8, 1, "euler", "simple", 1],
                        "inputs": [{"name": "seed", "link": 11}],
                    },
                    {"id": 9, "type": "MarkdownNote", "widgets_values": ["Hinweis"]},
                ],
                links=[[11, 5, 0, 6, 0, "INT"]],
            )
        )
        # Primitive und Notiz existieren im API-Format nicht; der Wert steht im Ziel.
        self.assertEqual(set(api), {"6"})
        self.assertEqual(api["6"]["inputs"]["seed"], 42)

    def test_verdrahteter_eingang_gewinnt_gegen_widget_wert(self) -> None:
        api, _ = ui_to_api.ui_to_api(
            graph(
                nodes=[
                    {"id": 1, "type": "UNETLoader", "widgets_values": ["a.safetensors", "default"], "outputs": [{"links": [10]}]},
                    {
                        "id": 2,
                        "type": "ModelSamplingAuraFlow",
                        "widgets_values": [3],
                        "inputs": [{"name": "model", "link": 10}],
                    },
                ],
                links=[[10, 1, 0, 2, 0, "MODEL"]],
            )
        )
        self.assertEqual(api["2"]["inputs"], {"shift": 3, "model": ["1", 0]})

    def test_stummer_knoten_wird_weggelassen_und_gemeldet(self) -> None:
        api, notes = ui_to_api.ui_to_api(
            graph(
                nodes=[
                    {"id": 1, "type": "VAELoader", "widgets_values": ["v.safetensors"]},
                    {"id": 2, "type": "VAELoader", "mode": 2, "widgets_values": ["x.safetensors"]},
                ],
                links=[],
            )
        )
        self.assertEqual(set(api), {"1"})
        self.assertTrue(any("stumm" in note for note in notes))

    def test_unbekannte_klasse_bricht_ab(self) -> None:
        with self.assertRaises(ValueError) as ctx:
            ui_to_api.ui_to_api(graph(nodes=[{"id": 1, "type": "VoelligNeuerKnoten", "widgets_values": []}], links=[]))
        self.assertIn("VoelligNeuerKnoten", str(ctx.exception))

    def test_widget_anzahl_muss_stimmen(self) -> None:
        # Ein zusaetzlicher Widget-Wert heisst: WIDGETS ist nicht mehr aktuell.
        with self.assertRaises(ValueError) as ctx:
            ui_to_api.ui_to_api(graph(nodes=[{"id": 1, "type": "VAELoader", "widgets_values": ["a", "b"]}], links=[]))
        self.assertIn("Widget-Werte", str(ctx.exception))

    def test_fehlender_link_bricht_ab(self) -> None:
        with self.assertRaises(ValueError):
            ui_to_api.ui_to_api(
                graph(
                    nodes=[
                        {"id": 1, "type": "UNETLoader", "widgets_values": ["a", "default"]},
                        {"id": 2, "type": "VAEDecodeAudio", "inputs": [{"name": "samples", "link": 99}]},
                    ],
                    links=[],
                )
            )


class AusgelieferteWorkflowsTest(unittest.TestCase):
    """Die mitgelieferten Workflows muessen strukturell intakt sein (ohne GPU pruefbar)."""

    def test_music_workflow_ist_konsistent(self) -> None:
        path = ROOT / "services" / "audiomonastry-ai-runtime" / "workflows" / "music.json"
        workflow = json.loads(path.read_text(encoding="utf-8"))
        classes = {node["class_type"] for node in workflow.values()}
        for expected in ("UNETLoader", "DualCLIPLoader", "VAELoader", "TextEncodeAceStepAudio1.5", "KSampler"):
            self.assertIn(expected, classes, f"{expected} fehlt in music.json")

        # Jeder verdrahtete Eingang zeigt auf einen existierenden Knoten.
        for node_id, node in workflow.items():
            for name, value in node["inputs"].items():
                if isinstance(value, list):
                    self.assertEqual(len(value), 2, f"{node_id}.{name}: {value}")
                    self.assertIn(str(value[0]), workflow, f"{node_id}.{name} zeigt auf {value[0]}")

        # Genau die Modelle, die das Image mit ACESTEP_XL_VARIANT=xl_turbo bereitstellt.
        unet = next(n for n in workflow.values() if n["class_type"] == "UNETLoader")
        self.assertEqual(unet["inputs"]["unet_name"], "acestep_v1.5_xl_turbo_bf16.safetensors")
        clip = next(n for n in workflow.values() if n["class_type"] == "DualCLIPLoader")
        self.assertEqual(clip["inputs"]["type"], "ace")
        self.assertEqual(
            sorted([clip["inputs"]["clip_name1"], clip["inputs"]["clip_name2"]]),
            ["qwen_0.6b_ace15.safetensors", "qwen_4b_ace15.safetensors"],
        )

    def test_music_workflow_laesst_sich_mit_prompt_befuellen(self) -> None:
        sys.path.insert(0, str(ROOT / "services" / "audiomonastry-ai-runtime"))
        import comfyui_adapter as adapter

        path = ROOT / "services" / "audiomonastry-ai-runtime" / "workflows" / "music.json"
        workflow = json.loads(path.read_text(encoding="utf-8"))
        filled = adapter.apply_prompt_to_workflow(workflow, {"prompt": "Test-Prompt", "duration": 12})

        text_nodes = [n for n in filled.values() if n["class_type"] == "TextEncodeAceStepAudio1.5"]
        self.assertEqual(len(text_nodes), 1)
        self.assertEqual(text_nodes[0]["inputs"]["tags"], "Test-Prompt")
        self.assertEqual(text_nodes[0]["inputs"]["duration"], 12.0)
        latents = [n for n in filled.values() if n["class_type"] == "EmptyAceStep1.5LatentAudio"]
        self.assertEqual(latents[0]["inputs"]["seconds"], 12.0, "Latent-Laenge muss zur Duration passen")


if __name__ == "__main__":
    unittest.main()
