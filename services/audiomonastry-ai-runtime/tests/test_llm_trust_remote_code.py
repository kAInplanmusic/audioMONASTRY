"""Regressionstest: LLM-Laden ohne Repo-eigenen Code (RUNPOD-P1-002).

Hintergrund (live belegt 2026-09-15 am Orchestrator-Endpoint
`xu4sqszdfk8lp8`, Image `:moa-comfy-v5`): Der gemeinsame LLM-Lader
`handlers_runpod.load_causal_lm` setzte `trust_remote_code=True` fest. Damit
gewann fuer `microsoft/Phi-3.5-mini-instruct` (Revision 2fe19245...) die
mitgelieferte `modeling_phi3.py` aus der transformers-4.43-Zeit statt der
nativen `Phi3ForCausalLM`. Diese Datei liest `past_key_values.seen_tokens`
(Zeilen 1291/1298); transformers 4.57.3 im Image hat das Attribut entfernt ->
jeder Planungslauf brach mit

    AttributeError: 'DynamicCache' object has no attribute 'seen_tokens'

ab (Job-Status COMPLETED, Output `{"code": "INFERENCE_FAILED", ...}`, im
Worker-Log direkt vor dem Fehler die `GenerationConfig` von Phi-3.5 mit
`eos_token_id` 32007/32001/32000 – der Fehlertext nannte nur das *angeforderte*
Modell `qwen3-4b`).

Dieser Test prueft beide Seiten des Fixes, ohne schwere Abhaengigkeiten:

1. `load_causal_lm` reicht das Flag aus dem Katalogeintrag durch (der Loader ist
   damit nativ-by-default) – mit einem aufzeichnenden transformers-Ersatz.
2. Das eingecheckte Manifest markiert JEDEN `task: llm`-Eintrag explizit, und
   zwar mit `trustRemoteCode: false`. Ein neuer LLM-Eintrag ohne die Angabe
   faellt hier auf, statt erst zur Laufzeit auf einer GPU.

Lauf: python3 services/audiomonastry-ai-runtime/tests/test_llm_trust_remote_code.py
"""
from __future__ import annotations

import json
import pathlib
import sys
import unittest
from typing import Any, Dict, List, Tuple
from unittest import mock

RUNTIME_DIR = pathlib.Path(__file__).resolve().parent.parent
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

import handlers_runpod  # noqa: E402
from model_manager import ModelDefinition  # noqa: E402


def definition(**overrides: object) -> Dict[str, Any]:
    base: Dict[str, Any] = {
        "id": "probe-model",
        "repository": "Qwen/Qwen3-4B",
        "revision": "1cfa9a7208912126459214e8b04321603b3df60c",
        "task": "llm",
    }
    base.update(overrides)
    return base


class _Loaded:
    """Steht fuer das Model-Objekt; `load_causal_lm` ruft nur `.to(...)`."""

    def to(self, _device: Any) -> "_Loaded":
        return self


class _RecordingTransformer:
    """Minimaler transformers-Ersatz, der die Lade-Kwargs mitschreibt."""

    def __init__(self) -> None:
        self.calls: List[Tuple[str, str, Dict[str, Any]]] = []
        outer = self

        class _Tokenizer:
            @staticmethod
            def from_pretrained(repository: str, **kwargs: Any) -> str:
                outer.calls.append(("tokenizer", repository, kwargs))
                return "tokenizer"

        class _Model:
            @staticmethod
            def from_pretrained(repository: str, **kwargs: Any) -> _Loaded:
                outer.calls.append(("model", repository, kwargs))
                return _Loaded()

        self.AutoTokenizer = _Tokenizer
        self.AutoModelForCausalLM = _Model


class _FakeTorch:
    bfloat16 = "bfloat16"
    float16 = "float16"


class TestLoadCausalLmForwardsFlag(unittest.TestCase):
    def _load(self, entry: Dict[str, Any]) -> List[Tuple[str, str, Dict[str, Any]]]:
        handlers_runpod._MODEL_CACHE.clear()
        recorder = _RecordingTransformer()
        fake_torch = _FakeTorch()

        def fake_require_lib(import_name: str, _pip_name: str = "") -> Any:
            return fake_torch if import_name == "torch" else recorder

        with mock.patch.object(handlers_runpod, "_require_lib", fake_require_lib), \
                mock.patch.object(handlers_runpod, "_device", lambda: "cpu"):
            handlers_runpod.load_causal_lm("probe-model", ModelDefinition.from_dict(entry))
        return recorder.calls

    def test_nativ_ist_der_standard(self) -> None:
        calls = self._load(definition())
        self.assertEqual([kind for kind, _repo, _kw in calls], ["tokenizer", "model"])
        for kind, repo, kwargs in calls:
            with self.subTest(kind=kind):
                self.assertEqual(repo, "Qwen/Qwen3-4B")
                self.assertIs(kwargs["trust_remote_code"], False)
                self.assertEqual(kwargs["revision"], "1cfa9a7208912126459214e8b04321603b3df60c")

    def test_opt_in_wird_durchgereicht(self) -> None:
        calls = self._load(definition(trustRemoteCode=True))
        for kind, _repo, kwargs in calls:
            with self.subTest(kind=kind):
                self.assertIs(kwargs["trust_remote_code"], True)

    def test_phi_35_laedt_nativ(self) -> None:
        # Genau der Live-Fall: Phi-3.5-mini darf NICHT ueber seinen Repo-Code
        # geladen werden, sonst bricht `seen_tokens`.
        calls = self._load(definition(
            id="phi-35-mini",
            repository="microsoft/Phi-3.5-mini-instruct",
            revision="2fe192450127e6a83f7441aef6e3ca586c338b77",
            trustRemoteCode=False,
        ))
        for kind, _repo, kwargs in calls:
            with self.subTest(kind=kind):
                self.assertIs(kwargs["trust_remote_code"], False)

    def test_bf16_waehlt_den_dtype(self) -> None:
        calls = self._load(definition(quantization="bf16"))
        model_kwargs = next(kw for kind, _repo, kw in calls if kind == "model")
        self.assertEqual(model_kwargs["torch_dtype"], "bfloat16")


class TestManifestIstExplizitNativ(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest = json.loads((RUNTIME_DIR / "model_manifest.json").read_text(encoding="utf-8"))
        cls.llm_entries = [
            entry for entry in cls.manifest.get("models", [])
            if isinstance(entry, dict) and entry.get("task") == "llm"
        ]

    def test_es_gibt_llm_eintraege(self) -> None:
        # Nicht-vakuos: ohne LLM-Eintraege waere der Test still gruen.
        self.assertGreater(len(self.llm_entries), 0, "kein task=llm-Eintrag im Manifest")

    def test_jeder_llm_eintrag_markiert_das_flag(self) -> None:
        for entry in self.llm_entries:
            with self.subTest(model=entry.get("id")):
                self.assertIn(
                    "trustRemoteCode", entry,
                    "LLM-Eintraege muessen trustRemoteCode explizit setzen (nativ-by-default, "
                    "Opt-in nur wo die native Klasse fehlt)",
                )

    def test_alle_llm_eintraege_sind_nativ(self) -> None:
        for entry in self.llm_entries:
            with self.subTest(model=entry.get("id")):
                self.assertIs(entry["trustRemoteCode"], False)

    def test_phi_35_mini_ist_nativ_markiert(self) -> None:
        phi = next((e for e in self.llm_entries if e.get("id") == "phi-35-mini"), None)
        self.assertIsNotNone(phi, "phi-35-mini fehlt im Manifest")
        assert phi is not None  # fuer den Typpruefer
        self.assertEqual(phi["repository"], "microsoft/Phi-3.5-mini-instruct")
        self.assertIs(phi["trustRemoteCode"], False)


if __name__ == "__main__":
    unittest.main()
