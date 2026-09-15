"""Regressionstest: MoA-Orchestrator (Instanz 8) ohne GPU/Transformers.

Reiner Python-Smoke (nur stdlib + `moa_orchestrator`), damit er in jedem CI-Lauf
und lokal laeuft:

    python3 services/audiomonastry-ai-runtime/tests/test_moa_orchestrator.py

Geprueft wird die REINE Plan-Logik (JSON-Robustheit, Tool-Validierung,
Plan-Merging, Env-Aufloesung, MCP-Bruecke) – nicht die LLM-Inferenz, die eine
GPU braucht. Die MCP-Bruecke laeuft gegen ein Fake-Endpoint-Env.
"""
from __future__ import annotations

import pathlib
import sys
import unittest

RUNTIME_DIR = pathlib.Path(__file__).resolve().parent.parent
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

import moa_orchestrator as moa  # noqa: E402


class ExtractJsonTest(unittest.TestCase):
    def test_plain_json(self) -> None:
        self.assertEqual(moa.extract_json('{"a": 1}'), {"a": 1})

    def test_fenced_json(self) -> None:
        self.assertEqual(moa.extract_json('```json\n{"a": 1}\n```'), {"a": 1})

    def test_json_inside_prose(self) -> None:
        self.assertEqual(moa.extract_json('Klar: {"areas": ["audio"]} fertig'), {"areas": ["audio"]})

    def test_garbage_returns_none(self) -> None:
        self.assertIsNone(moa.extract_json("kein json hier"))


class ClassificationTest(unittest.TestCase):
    def test_valid_classification(self) -> None:
        result = moa.parse_classification('{"areas": ["audio", "music"], "intent": "track", "needs_tools": true}')
        self.assertEqual(result["areas"], ["audio", "music"])
        self.assertTrue(result["parsed"])
        self.assertTrue(result["needs_tools"])

    def test_unknown_areas_are_dropped(self) -> None:
        result = moa.parse_classification('{"areas": ["audio", "kubernetes"]}')
        self.assertEqual(result["areas"], ["audio"])

    def test_garbage_falls_back_to_audio(self) -> None:
        result = moa.parse_classification("no json")
        self.assertEqual(result["areas"], ["audio"])
        self.assertFalse(result["parsed"])

    def test_needs_tools_defaults_true(self) -> None:
        self.assertTrue(moa.parse_classification('{"areas": ["audio"]}')["needs_tools"])


class StepsTest(unittest.TestCase):
    def test_valid_steps(self) -> None:
        steps = moa.parse_steps('{"steps": [{"tool": "ears.analyze", "args": {"tasks": ["bpm"]}}]}')
        self.assertEqual(steps, [{"tool": "ears.analyze", "args": {"tasks": ["bpm"]}}])

    def test_unknown_tool_is_dropped(self) -> None:
        self.assertEqual(moa.parse_steps('{"steps": [{"tool": "hack.the.planet"}]}'), [])

    def test_missing_args_becomes_empty_dict(self) -> None:
        self.assertEqual(moa.parse_steps('{"steps": [{"tool": "voice.tts"}]}'), [{"tool": "voice.tts", "args": {}}])

    def test_bad_shape_is_empty(self) -> None:
        self.assertEqual(moa.parse_steps('{"steps": "nope"}'), [])


class MergeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.a = [{"tool": "ears.analyze", "args": {"tasks": ["bpm"]}}]
        self.b = [{"tool": "voice.tts", "args": {"text": "hi"}}]

    def test_choice_a(self) -> None:
        self.assertEqual(moa.merge_plans("a", self.a, self.b), ("a", self.a))

    def test_choice_b(self) -> None:
        self.assertEqual(moa.merge_plans("b", self.a, self.b), ("b", self.b))

    def test_merge_deduplicates(self) -> None:
        choice, steps = moa.merge_plans("merged", self.a, [*self.a, *self.b])
        self.assertEqual(choice, "merged")
        self.assertEqual(steps, [*self.a, *self.b])

    def test_unknown_choice_merges(self) -> None:
        self.assertEqual(moa.merge_plans("quatsch", self.a, self.b)[0], "merged")

    def test_empty_plan_falls_back_to_other(self) -> None:
        self.assertEqual(moa.merge_plans("a", [], self.b), ("b", self.b))


class CatalogTest(unittest.TestCase):
    def test_audio_areas_offer_ears_and_voice(self) -> None:
        tools = moa.tool_catalog_for(["audio"])
        self.assertIn("ears.analyze", tools)
        self.assertIn("voice.tts", tools)
        self.assertNotIn("image.generate", tools)

    def test_video_area_offers_both_video_roles(self) -> None:
        tools = moa.tool_catalog_for(["video"])
        self.assertIn("video_real.text2video", tools)
        self.assertIn("video_abstract.glitch", tools)

    def test_every_catalog_tool_is_addressable(self) -> None:
        for name, spec in moa.TOOL_CATALOG.items():
            self.assertIn(spec["role"], moa.ROLE_ENDPOINT_ENV, name)


class EnvTest(unittest.TestCase):
    def test_model_env_override(self) -> None:
        models = moa.resolve_moa_models({"MOA_AGGREGATOR_MODEL": "mistral-x"})
        self.assertEqual(models["aggregator"], "mistral-x")
        self.assertEqual(models["classifier"], "qwen3-4b")

    def test_endpoint_env_lookup(self) -> None:
        env = {"RP_ENDPOINT_ID_EARS": "ears-ep"}
        self.assertEqual(moa.endpoint_for_role("ears", env), "ears-ep")
        self.assertEqual(moa.endpoint_for_role("music", env), "")


class ToolBridgeTest(unittest.TestCase):
    def test_workflow_tool_without_workflow_is_rejected(self) -> None:
        # music laeuft auf einem Workflow-Worker: ohne Workflow kein stiller Fehlschlag.
        with self.assertRaises(ValueError) as ctx:
            moa.call_tool("music.generate", {"prompt": "techno"}, env={"RP_ENDPOINT_ID_MUSIC": "m-ep"})
        self.assertIn("kein Workflow konfiguriert", str(ctx.exception))

    def test_prompt_tool_without_prompt_is_rejected(self) -> None:
        with self.assertRaises(ValueError) as ctx:
            moa.call_tool("image.generate", {}, env={"RP_ENDPOINT_ID_IMAGE": "img-ep"})
        self.assertIn("leerer Request", str(ctx.exception))

    def test_unknown_tool_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            moa.call_tool("nope", {}, env={})

    def test_missing_endpoint_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            moa.call_tool("ears.analyze", {}, env={"RP_AGENT_KEY": "k"})

    def test_missing_credentials_are_rejected(self) -> None:
        with self.assertRaises(ValueError):
            moa.call_tool("ears.analyze", {}, env={"RP_ENDPOINT_ID_EARS": "ears-ep"})

    def test_execute_steps_keeps_going_after_failure(self) -> None:
        results = moa.execute_steps(
            [{"tool": "ears.analyze", "args": {}}, {"tool": "image.generate", "args": {}}],
            env={},
        )
        self.assertEqual(len(results), 2)
        self.assertTrue(all(r["status"] == "FAILED" for r in results))


if __name__ == "__main__":
    unittest.main(verbosity=2)
