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

    def test_bare_array_inside_prose_mit_form_hinweis(self) -> None:
        # Live-Fund 2026-09-16: Plan B kam als nackte Liste hinter Prosa.
        # Nur mit `prefer="list"` gewinnt die ganze Liste statt des inneren
        # Schritt-Objekts.
        self.assertEqual(
            moa.extract_json('Hier der Plan:\n[{"tool": "voice.tts"}]\nViel Erfolg', prefer="list"),
            [{"tool": "voice.tts"}],
        )

    def test_ohne_hinweis_gewinnt_das_objekt(self) -> None:
        # Gegenprobe: der Default (dict) haelt das Verhalten unveraendert.
        self.assertEqual(
            moa.extract_json('Hier der Plan:\n[{"tool": "voice.tts"}]'),
            {"tool": "voice.tts"},
        )

    def test_object_shape_wins_over_inner_array(self) -> None:
        # Die Reihenfolge bleibt: eine dict-Antwort (Klassifikation, Aggregat)
        # darf nicht auf ihr inneres Array verkuerzt werden.
        self.assertEqual(moa.extract_json('Klar: {"areas": ["audio"]} fertig'), {"areas": ["audio"]})


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

    def test_bare_array_is_accepted(self) -> None:
        steps = moa.parse_steps('[{"tool": "ears.analyze", "args": {"tasks": ["bpm"]}}]')
        self.assertEqual(steps, [{"tool": "ears.analyze", "args": {"tasks": ["bpm"]}}])

    def test_array_inside_prose_is_accepted(self) -> None:
        # Genau der Live-Fall: Prosa + nackte Liste ergab vorher still [].
        steps = moa.parse_steps('Hier der Plan:\n[{"tool": "music.generate", "args": {"genre": "ambient"}}]')
        self.assertEqual(steps, [{"tool": "music.generate", "args": {"genre": "ambient"}}])

    def test_single_step_object_is_accepted(self) -> None:
        steps = moa.parse_steps('{"tool": "voice.tts", "args": {"text": "hi"}}')
        self.assertEqual(steps, [{"tool": "voice.tts", "args": {"text": "hi"}}])

    def test_unknown_tool_in_bare_array_is_dropped(self) -> None:
        self.assertEqual(moa.parse_steps('[{"tool": "hack.it"}]'), [])

    def test_mehrere_schritte_werden_nicht_abgeschnitten(self) -> None:
        # Schutz gegen die Teil-Lesung: bei Prosa + Liste darf nicht nur das
        # erste innere Objekt uebrig bleiben.
        text = 'Mein Plan:\n[{"tool": "music.generate"}, {"tool": "voice.tts"}, {"tool": "ears.embed"}]'
        steps = moa.parse_steps(text)
        self.assertEqual([s["tool"] for s in steps], ["music.generate", "voice.tts", "ears.embed"])


class PlannerReportTest(unittest.TestCase):
    """Ein leerer Plan darf nicht mehr still durchgehen (Live 2026-09-16)."""

    def test_valid_plan_is_not_suspicious(self) -> None:
        text = '{"steps": [{"tool": "ears.analyze", "args": {}}]}'
        report = moa.planner_report(text, moa.parse_steps(text))
        self.assertEqual(report["steps"], 1)
        self.assertTrue(report["parsed"])
        self.assertFalse(report["suspicious"])
        self.assertEqual(report["chars"], len(text))

    def test_text_without_a_single_step_is_suspicious(self) -> None:
        report = moa.planner_report("Ich wuerde zuerst die Musik generieren.", [])
        self.assertEqual(report["steps"], 0)
        self.assertFalse(report["parsed"])
        self.assertTrue(report["suspicious"])

    def test_only_unknown_tools_is_suspicious(self) -> None:
        text = '{"steps": [{"tool": "hack.it"}]}'
        self.assertTrue(moa.planner_report(text, moa.parse_steps(text))["suspicious"])

    def test_empty_text_is_not_suspicious(self) -> None:
        # Ein wirklich leerer Text ist ein anderes Problem als ein Parse-Fehler.
        self.assertFalse(moa.planner_report("   ", [])["suspicious"])

    def test_versuche_und_auszug_im_beleg(self) -> None:
        # Bei Verdacht muss der Beleg die Diagnose tragen: Versuchszahl und ein
        # Auszug des Rohtexts (die Container-Logs sind mit dem Worker weg).
        lang = "x" * 500
        report = moa.planner_report(lang, [], attempts=2, preview_chars=120)
        self.assertEqual(report["attempts"], 2)
        self.assertEqual(report["chars"], 500)
        self.assertEqual(len(report["preview"]), 120)
        # Ohne Verdacht kein Auszug (kein Rauschen im Erfolgsfall).
        clean = moa.planner_report('{"steps": [{"tool": "ears.analyze"}]}', [{"tool": "ears.analyze", "args": {}}])
        self.assertNotIn("preview", clean)


class PlanWithRetryTest(unittest.TestCase):
    """Ein Planer, der Prosa statt JSON liefert, wird einmal nachgefasst."""

    class _Ask:
        def __init__(self, replies: list) -> None:
            self.replies = list(replies)
            self.calls: list = []

        def __call__(self, role: str, system: str, user: str, max_new_tokens: int = 512) -> str:
            self.calls.append(
                {"role": role, "system": system, "user": user, "max_new_tokens": max_new_tokens}
            )
            return self.replies.pop(0) if self.replies else ""

    TOOLS = ["ears.analyze", "voice.tts"]
    USER = "Auftrag: mach was\nErlaubte Tools: ears.analyze, voice.tts"

    def test_direkter_treffer_ohne_zweiten_versuch(self) -> None:
        ask = self._Ask(['{"steps": [{"tool": "ears.analyze", "args": {}}]}'])
        text, steps, attempts = moa.plan_with_retry(ask, "planner_b", self.USER, self.TOOLS)
        self.assertEqual(attempts, 1)
        self.assertEqual(len(ask.calls), 1)
        self.assertEqual([s["tool"] for s in steps], ["ears.analyze"])
        self.assertTrue(text)

    def test_reparatur_nennt_form_und_tools(self) -> None:
        ask = self._Ask([
            "Ich wuerde zuerst die Musik generieren.",
            '{"steps": [{"tool": "voice.tts", "args": {"text": "hi"}}]}',
        ])
        _text, steps, attempts = moa.plan_with_retry(ask, "planner_b", self.USER, self.TOOLS)
        self.assertEqual(attempts, 2)
        self.assertEqual(len(ask.calls), 2)
        self.assertEqual([s["tool"] for s in steps], ["voice.tts"])
        # Der zweite Aufruf nutzt den Reparatur-Prompt und nennt die Tools erneut.
        self.assertIn("kein auswertbares JSON", ask.calls[1]["system"])
        self.assertIn("ears.analyze", ask.calls[1]["system"])
        # ... und zeigt dem Modell seine vorige Antwort.
        self.assertIn("Ich wuerde zuerst die Musik generieren.", ask.calls[1]["user"])

    def test_zwei_fehlversuche_bleiben_leer(self) -> None:
        ask = self._Ask(["Prosa eins.", "Prosa zwei."])
        _text, steps, attempts = moa.plan_with_retry(ask, "planner_b", self.USER, self.TOOLS)
        self.assertEqual(attempts, 2)
        self.assertEqual(steps, [])

    def test_grosszuegiges_token_budget(self) -> None:
        # Ein verboses Modell muss sein JSON noch erreichen koennen.
        ask = self._Ask(['{"steps": [{"tool": "ears.analyze", "args": {}}]}'])
        moa.plan_with_retry(ask, "planner_b", self.USER, self.TOOLS)
        self.assertGreaterEqual(ask.calls[0]["max_new_tokens"], 1024)


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


class RoleDefaultsTest(unittest.TestCase):
    """Vorgaben des Aufrufers je Rolle (Aufloesung, Laenge, Tempo, LoRAs)."""

    def test_vorgaben_landen_in_den_schritt_argumenten(self) -> None:
        steps = [{"tool": "video_abstract.text2video", "args": {"prompt": "colors"}}]
        merged = moa.merge_step_defaults(
            steps, {"videoAbstract": {"width": 768, "height": 1280, "length": 97, "lora_pairs": [{"name": "glitch.safetensors", "strength": 0.8}]}}
        )
        self.assertEqual(merged[0]["args"]["prompt"], "colors")
        self.assertEqual(merged[0]["args"]["width"], 768)
        self.assertEqual(merged[0]["args"]["length"], 97)
        self.assertEqual(len(merged[0]["args"]["lora_pairs"]), 1)

    def test_argumente_des_plans_gewinnen(self) -> None:
        # Der Planer kennt den Auftrag, die Vorgabe ist nur der Rahmen.
        steps = [{"tool": "music.generate", "args": {"prompt": "techno", "bpm": 140}}]
        merged = moa.merge_step_defaults(steps, {"music": {"bpm": 90, "duration": 30}})
        self.assertEqual(merged[0]["args"]["bpm"], 140)
        self.assertEqual(merged[0]["args"]["duration"], 30)

    def test_nur_die_genannte_rolle_wird_veraendert(self) -> None:
        steps = [
            {"tool": "video_abstract.text2video", "args": {"prompt": "a"}},
            {"tool": "music.generate", "args": {"prompt": "b"}},
        ]
        merged = moa.merge_step_defaults(steps, {"music": {"duration": 20}})
        self.assertEqual(merged[0], steps[0])
        self.assertEqual(merged[1]["args"]["duration"], 20)

    def test_ohne_vorgaben_bleiben_die_schritte_unveraendert(self) -> None:
        steps = [{"tool": "music.generate", "args": {"prompt": "x"}}]
        self.assertIs(moa.merge_step_defaults(steps, {}), steps)
        self.assertIs(moa.merge_step_defaults(steps, None), steps)

    def test_unbekannte_rolle_wird_abgelehnt(self) -> None:
        # Ein Tippfehler soll nicht still wirkungslos bleiben.
        with self.assertRaises(ValueError) as ctx:
            moa.merge_step_defaults([], {"videoAbtract": {"width": 1}})
        self.assertIn("videoAbtract", str(ctx.exception))

    def test_falscher_typ_wird_abgelehnt(self) -> None:
        with self.assertRaises(ValueError):
            moa.merge_step_defaults([], ["kein objekt"])  # type: ignore[arg-type]


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
    def test_music_tool_baut_jetzt_einen_workflow_request(self) -> None:
        # Bis 2026-09-16 fehlte der Graph (Fehler 'kein Workflow konfiguriert');
        # jetzt kommt er aus workflows/music.json. Die Kette scheitert daher erst
        # an fehlenden Credentials - der Workflow selbst ist da.
        with self.assertRaises(ValueError) as ctx:
            moa.call_tool("music.generate", {"prompt": "techno"}, env={"RP_ENDPOINT_ID_MUSIC": "m-ep"})
        self.assertIn("RP_AGENT_KEY", str(ctx.exception))

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

    `replies` bildet Modell-ID auf eine LISTE von Antworten ab, die der Reihe
    nach verbraucht wird. Der Classifier und der Aggregator teilen sich bewusst
    dasselbe Modell (`qwen3-4b`) – eine Antwort pro Modell waere dafuer zu
    grob und wuerde die Rolle des Aggregators nicht pruefen.

    Der Stub prueft ZUSAETZLICH, dass die Modelldefinition wirklich ein
    `ModelDefinition`-Objekt ist: der erste Live-Lauf scheiterte genau daran,
    dass `load_manifest` rohe Dicts liefert (`'dict' has no attribute
    'repository'`) – die reine Text-Antwort des Stubs haette das nie gemerkt.
    """
    module = types.ModuleType("handlers_runpod")
    calls: list = []
    queues = {model: list(texts) for model, texts in replies.items()}

    def fake_generate_chat(model_id, definition, messages, **kwargs):  # noqa: ANN001, ARG001
        if not hasattr(definition, "repository"):
            raise TypeError(f"{model_id}: Definition ist kein ModelDefinition-Objekt, sondern {type(definition).__name__}")
        calls.append(model_id)
        queue = queues.get(model_id) or []
        return {"text": queue.pop(0) if queue else "{}"}

    module.generate_chat = fake_generate_chat  # type: ignore[attr-defined]
    module.calls = calls  # type: ignore[attr-defined]
    return module


class PipelineTest(unittest.TestCase):
    """Ende-zu-Ende ohne GPU: Manifest -> Rollen -> 4 Staenden -> Plan."""

    def setUp(self) -> None:
        self.saved = sys.modules.get("handlers_runpod")
        # Ein starkes (qwen3-8b) + ein schnelles (qwen3-4b) Modell:
        # Aufruffolge = Classifier(4b), Planner A(8b), Planner B(4b), Aggregator(8b).
        self.manager = _stub_llm(
            {
                "qwen3-4b": [
                    '{"areas": ["audio"], "intent": "track analysieren", "needs_tools": true}',
                    '{"steps": [{"tool": "voice.tts", "args": {"text": "hi"}}, {"tool": "hack.it", "args": {}}]}',
                ],
                "qwen3-8b": [
                    '{"steps": [{"tool": "ears.analyze", "args": {"tasks": ["bpm"]}}]}',
                    '{"chosen": "merged", "reason": "beide decks ab"}',
                ],
            }
        )
        sys.modules["handlers_runpod"] = self.manager

    def tearDown(self) -> None:
        if self.saved is not None:
            sys.modules["handlers_runpod"] = self.saved
        else:
            sys.modules.pop("handlers_runpod", None)

    def test_default_model_set_is_public_and_manifest_backed(self) -> None:
        """Die Defaults muessen oeffentliche Modelle sein UND im Rollen-Manifest stehen."""
        import registry

        models = moa.resolve_moa_models({})
        # Ein starkes (8B) und ein schnelles (4B) Modell, beide Qwen3/Apache-2.0.
        self.assertEqual(models["classifier"], "qwen3-4b")
        self.assertEqual(models["planner_a"], "qwen3-8b")
        self.assertEqual(models["planner_b"], "qwen3-4b")
        self.assertEqual(models["aggregator"], "qwen3-8b")
        known = {entry["id"] for entry in registry.load_manifest("orchestrator")["models"]}
        for role, model_id in models.items():
            self.assertIn(model_id, known, f"{role}: {model_id} fehlt im Rollen-Manifest")

    def test_full_pipeline_resolves_manifest_models(self) -> None:
        result = moa.moa_orchestrate("qwen3-4b", None, {"prompt": "analysiere track.wav"})
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["classification"]["areas"], ["audio"])
        self.assertEqual(result["choice"], "merged")
        # Unbekanntes Tool aus Plan B wurde verworfen, beide gueltigen gemerged.
        self.assertEqual([s["tool"] for s in result["steps"]], ["ears.analyze", "voice.tts"])
        # Vier Staende in der erwarteten Reihenfolge: Classifier und Planner B
        # teilen sich das schnelle 4B-Modell, Planner A und Aggregator das 8B.
        self.assertEqual(self.manager.calls, ["qwen3-4b", "qwen3-8b", "qwen3-4b", "qwen3-8b"])
        self.assertNotIn("execution", result)

    def test_gueltige_plaene_sind_nicht_verdaechtig(self) -> None:
        result = moa.moa_orchestrate("qwen3-4b", None, {"prompt": "analysiere track.wav"})
        self.assertFalse(result["plannerParse"]["a"]["suspicious"])
        self.assertFalse(result["plannerParse"]["b"]["suspicious"])
        self.assertTrue(result["plannerParse"]["a"]["parsed"])
        self.assertTrue(result["plannerParse"]["b"]["parsed"])
        # Gueltiger Plan = genau EIN Versuch je Planer, kein Reparatur-Nachfassen.
        self.assertEqual(result["plannerParse"]["a"]["attempts"], 1)
        self.assertEqual(result["plannerParse"]["b"]["attempts"], 1)
        self.assertNotIn("preview", result["plannerParse"]["a"])

    def test_plan_als_nackte_liste_wird_jetzt_gelesen(self) -> None:
        # Live-Fall als Regressionstest: Plan B antwortete mit Prosa + Liste.
        sys.modules["handlers_runpod"] = _stub_llm({
            "qwen3-4b": [
                '{"areas": ["audio"], "intent": "x", "needs_tools": true}',
                'Hier der Plan:\n[{"tool": "voice.tts", "args": {"text": "hi"}}]',
            ],
            "qwen3-8b": [
                '{"steps": [{"tool": "ears.analyze", "args": {}}]}',
                '{"chosen": "merged", "reason": "kombiniert"}',
            ],
        })
        result = moa.moa_orchestrate("qwen3-4b", None, {"prompt": "mach was"})
        self.assertEqual([s["tool"] for s in result["steps"]], ["ears.analyze", "voice.tts"])
        self.assertFalse(result["plannerParse"]["b"]["suspicious"])

    def test_unparsebarer_plan_wird_ausgewiesen(self) -> None:
        # Genau der Live-Befund 2026-09-16: Plan B kam als [] zurueck und das
        # Ergebnis stand trotzdem auf "merged" – der MoA-Gewinn war unbelegt.
        # Der Reparatur-Versuch (zweiter Aufruf) scheitert hier ebenfalls.
        sys.modules["handlers_runpod"] = _stub_llm({
            "qwen3-4b": [
                '{"areas": ["audio"], "intent": "x", "needs_tools": true}',
                "Ich wuerde mit der Musik anfangen, dann das Video.",
                "Wie gesagt: erst Musik, dann Video, dann Ton.",
            ],
            "qwen3-8b": [
                '{"steps": [{"tool": "ears.analyze", "args": {}}]}',
                '{"chosen": "merged", "reason": "nur A"}',
            ],
        })
        result = moa.moa_orchestrate("qwen3-4b", None, {"prompt": "mach was"})
        self.assertEqual([s["tool"] for s in result["steps"]], ["ears.analyze"])
        self.assertFalse(result["plannerParse"]["a"]["suspicious"])
        report_b = result["plannerParse"]["b"]
        self.assertTrue(report_b["suspicious"])
        self.assertFalse(report_b["parsed"])
        self.assertEqual(report_b["steps"], 0)
        self.assertEqual(report_b["attempts"], 2)
        self.assertGreater(report_b["chars"], 0)
        # Der Beleg nennt den Rohtext-Auszug, damit die Ursache diagnostizierbar
        # bleibt (die Container-Logs sind mit dem Worker weg).
        self.assertIn("Musik", report_b["preview"])

    def test_reparatur_versuch_holt_den_plan(self) -> None:
        # Der eigentliche Zweck: ein Planer, der beim ersten Versuch Prosa
        # liefert, wird mit strengerer Anweisung nachgefasst - und liefert dann.
        sys.modules["handlers_runpod"] = _stub_llm({
            "qwen3-4b": [
                '{"areas": ["audio"], "intent": "x", "needs_tools": true}',
                "Ich wuerde mit der Musik anfangen, dann das Video.",
                '{"steps": [{"tool": "voice.tts", "args": {"text": "hi"}}]}',
            ],
            "qwen3-8b": [
                '{"steps": [{"tool": "ears.analyze", "args": {}}]}',
                '{"chosen": "merged", "reason": "beides"}',
            ],
        })
        result = moa.moa_orchestrate("qwen3-4b", None, {"prompt": "mach was"})
        self.assertEqual([s["tool"] for s in result["steps"]], ["ears.analyze", "voice.tts"])
        report_b = result["plannerParse"]["b"]
        self.assertEqual(report_b["attempts"], 2)
        self.assertTrue(report_b["parsed"])
        self.assertFalse(report_b["suspicious"])

    def test_missing_prompt_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            moa.moa_orchestrate("qwen3-4b", None, {})

    def test_unknown_model_in_manifest_raises_clear_error(self) -> None:
        os.environ["MOA_CLASSIFIER_MODEL"] = "gibt-es-nicht"
        try:
            with self.assertRaises(ValueError) as ctx:
                moa.moa_orchestrate("qwen3-4b", None, {"prompt": "x"})
        finally:
            del os.environ["MOA_CLASSIFIER_MODEL"]
        self.assertIn("fehlt im Rollen-Manifest", str(ctx.exception))

    def test_rolevorgaben_landen_im_ergebnis_und_in_den_schritten(self) -> None:
        # Der Aufrufer gibt Aufloesung/Laenge/LoRAs vor; der Planer wuerde sie raten.
        result = moa.moa_orchestrate(
            "qwen3-4b",
            None,
            {
                "prompt": "abstract loop",
                "roleDefaults": {"videoAbstract": {"width": 768, "height": 1280, "length": 97}},
            },
        )
        self.assertEqual(result["roleDefaults"]["videoAbstract"]["width"], 768)
        # Der Stub-Plan enthaelt keinen videoAbstract-Schritt; die Schritte selbst
        # bleiben also unveraendert - die Vorgabe steht aber im Ergebnis, damit der
        # Aufrufer sieht, was gilt.
        self.assertTrue(all("width" not in (step.get("args") or {}) for step in result["steps"]))

    def test_unbekannte_rolle_in_vorgaben_bricht_ab(self) -> None:
        with self.assertRaises(ValueError) as ctx:
            moa.moa_orchestrate("qwen3-4b", None, {"prompt": "x", "roleDefaults": {"tippfehler": {"width": 1}}})
        self.assertIn("tippfehler", str(ctx.exception))


if __name__ == "__main__":
    unittest.main(verbosity=2)
