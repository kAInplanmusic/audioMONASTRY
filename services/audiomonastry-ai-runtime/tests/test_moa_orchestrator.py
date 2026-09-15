"""Regressionstest: MoA-Orchestrator (Instanz 8) ohne GPU/Transformers.

Reiner Python-Smoke (nur stdlib + `moa_orchestrator`), damit er in jedem CI-Lauf
und lokal laeuft:

    python3 services/audiomonastry-ai-runtime/tests/test_moa_orchestrator.py

Geprueft wird die REINE Plan-Logik (JSON-Robustheit, Tool-Validierung,
Plan-Merging, Env-Aufloesung, MCP-Bruecke) – nicht die LLM-Inferenz, die eine
GPU braucht. Die MCP-Bruecke laeuft gegen ein Fake-Endpoint-Env.
"""
from __future__ import annotations

import os
import pathlib
import sys
import types
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


def _stub_llm(replies: dict) -> "types.ModuleType":
    """Fake `handlers_runpod.generate_chat` – die Inferenz wird ersetzt, alles
    andere (Manifest, Rollen, Prompts, Parsing, Merging) bleibt echt.

    Der Stub prueft ZUSAETZLICH, dass die Modelldefinition wirklich ein
    `ModelDefinition`-Objekt ist: der erste Live-Lauf scheiterte genau daran,
    dass `load_manifest` rohe Dicts liefert (`'dict' has no attribute
    'repository'`) – die reine Text-Antwort des Stubs haette das nie gemerkt.
    """
    module = types.ModuleType("handlers_runpod")
    calls: list = []

    def fake_generate_chat(model_id, definition, messages, **kwargs):  # noqa: ANN001, ARG001
        if not hasattr(definition, "repository"):
            raise TypeError(f"{model_id}: Definition ist kein ModelDefinition-Objekt, sondern {type(definition).__name__}")
        calls.append(model_id)
        return {"text": replies.get(model_id, "{}")}

    module.generate_chat = fake_generate_chat  # type: ignore[attr-defined]
    module.calls = calls  # type: ignore[attr-defined]
    return module


class PipelineTest(unittest.TestCase):
    """Ende-zu-Ende ohne GPU: Manifest -> Rollen -> 4 Staenden -> Plan."""

    def setUp(self) -> None:
        self.saved = sys.modules.get("handlers_runpod")
        self.manager = _stub_llm(
            {
                "qwen3-4b": '{"areas": ["audio"], "intent": "track analysieren", "needs_tools": true}',
                "llama-32-3b": '{"steps": [{"tool": "ears.analyze", "args": {"tasks": ["bpm"]}}]}',
                "gemma-3-4b": '{"steps": [{"tool": "voice.tts", "args": {"text": "hi"}}, {"tool": "hack.it", "args": {}}]}',
                "mistral-small-31": '{"chosen": "merged", "reason": "beide decks ab"}',
            }
        )
        sys.modules["handlers_runpod"] = self.manager

    def tearDown(self) -> None:
        if self.saved is not None:
            sys.modules["handlers_runpod"] = self.saved
        else:
            sys.modules.pop("handlers_runpod", None)

    def test_full_pipeline_resolves_manifest_models(self) -> None:
        result = moa.moa_orchestrate("mistral-small-31", None, {"prompt": "analysiere track.wav"})
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["classification"]["areas"], ["audio"])
        self.assertEqual(result["choice"], "merged")
        # Unbekanntes Tool aus Plan B wurde verworfen, beide gueltigen gemerged.
        self.assertEqual([s["tool"] for s in result["steps"]], ["ears.analyze", "voice.tts"])
        # Alle vier MoA-Rollen liefen in der erwarteten Reihenfolge.
        self.assertEqual(self.manager.calls, ["qwen3-4b", "llama-32-3b", "gemma-3-4b", "mistral-small-31"])
        self.assertNotIn("execution", result)

    def test_missing_prompt_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            moa.moa_orchestrate("mistral-small-31", None, {})

    def test_unknown_model_in_manifest_raises_clear_error(self) -> None:
        os.environ["MOA_CLASSIFIER_MODEL"] = "gibt-es-nicht"
        try:
            with self.assertRaises(ValueError) as ctx:
                moa.moa_orchestrate("mistral-small-31", None, {"prompt": "x"})
        finally:
            del os.environ["MOA_CLASSIFIER_MODEL"]
        self.assertIn("fehlt im Rollen-Manifest", str(ctx.exception))


if __name__ == "__main__":
    unittest.main(verbosity=2)
