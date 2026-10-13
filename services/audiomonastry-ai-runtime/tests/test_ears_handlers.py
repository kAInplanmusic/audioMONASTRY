"""FLEET-P1-002..005: RP2-ears-Handler (handlers_ears) – ohne GPU, ohne Gewichte, ohne Netz.

Gefaelscht: huggingface_hub, torch, vllm, qwen_asr, transformers, pyannote.audio,
beat_this, PIL, der MOSS-Audio-Code-Checkout. Belegt ist damit:
- Repo + Revision kommen aus dem Manifest; ungepinnte Revisionen laden nichts.
- bf16 auf CUDA, float32 auf CPU; trust_remote_code nur mit Manifest-Opt-in.
- Antwortformate (JSON-Schemata unten), Eingabe-/Dauergrenzen, klare Fehler.
- Dispatch: neue Modelle nur bei ausdruecklicher Wahl, Altmodelle unveraendert.

NICHT belegt: echte Gewichte, echte Paket-APIs, Qualitaet, Latenz, VRAM.

    python3 services/audiomonastry-ai-runtime/tests/test_ears_handlers.py
"""
from __future__ import annotations

import base64
import contextlib
import hashlib
import io
import os
import pathlib
import sys
import tempfile
import types
import unittest
import wave
from typing import Any, Dict, List
from unittest import mock

import numpy as np

RUNTIME_DIR = pathlib.Path(__file__).resolve().parent.parent
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

import handlers  # noqa: E402
import handlers_ears as he  # noqa: E402
import registry  # noqa: E402
from model_manager import ModelDefinition, ModelUnavailableError  # noqa: E402

MANIFEST = {m["id"]: m for m in registry.read_manifest()["models"]}


def definition(model_id: str, **overrides: Any) -> ModelDefinition:
    data = dict(MANIFEST[model_id])
    data.update(overrides)
    return ModelDefinition.from_dict(data)


def wav_b64(seconds: float = 1.0, sr: int = 16000, freq: float = 440.0, channels: int = 1) -> str:
    t = np.arange(int(seconds * sr)) / sr
    x = (0.3 * np.sin(2 * np.pi * freq * t) * 32767).astype("<i2")
    if channels == 2:
        x = np.repeat(x[:, None], 2, axis=1)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(x.tobytes())
    return base64.b64encode(buf.getvalue()).decode()


# ---------------------------------------------------------------------------
# Faelschungen
# ---------------------------------------------------------------------------
class FakeTensor:
    def __init__(self, arr: Any) -> None:
        self.arr = np.asarray(arr)

    @property
    def shape(self):
        return self.arr.shape

    def float(self):
        return self

    def cpu(self):
        return self

    def numpy(self):
        return self.arr

    def to(self, *_a: Any, **_k: Any):
        return self


def fake_torch(cuda: bool = True) -> types.ModuleType:
    torch = types.ModuleType("torch")
    torch.bfloat16, torch.float16, torch.float32 = "bf16", "fp16", "fp32"
    torch.cuda = types.SimpleNamespace(is_available=lambda: cuda)
    torch.device = lambda name: types.SimpleNamespace(type=str(name).split(":")[0], name=str(name))
    torch.autocast_calls = []

    @contextlib.contextmanager
    def _ctx(*_a: Any, **kw: Any):
        if kw:
            torch.autocast_calls.append(kw)
        yield

    torch.no_grad = _ctx
    torch.inference_mode = _ctx
    torch.autocast = _ctx
    torch.from_numpy = FakeTensor
    return torch


def fake_hub(calls: List[Dict[str, Any]], local_dir: str = "/snap/x") -> types.ModuleType:
    hub = types.ModuleType("huggingface_hub")

    def snapshot_download(**kwargs: Any) -> str:
        calls.append(kwargs)
        return local_dir

    hub.snapshot_download = snapshot_download
    return hub


class EarsTestBase(unittest.TestCase):
    def setUp(self) -> None:
        he._CACHE.clear()
        he._STREAMS.clear()
        self.hub_calls: List[Dict[str, Any]] = []
        self.torch = fake_torch(cuda=True)
        self.modules: Dict[str, Any] = {"torch": self.torch, "huggingface_hub": fake_hub(self.hub_calls)}
        self._env = mock.patch.dict(os.environ, {}, clear=False)
        self._env.start()
        for key in (he.QWEN3_ASR_BACKEND_ENV, "HF_TOKEN", he.BEAT_THIS_CHECKPOINT_ENV, he.MOSS_AUDIO_ROOT_ENV):
            os.environ.pop(key, None)

    def tearDown(self) -> None:
        self._env.stop()
        he._CACHE.clear()
        he._STREAMS.clear()

    @contextlib.contextmanager
    def fakes(self, **extra: Any):
        mods = dict(self.modules)
        mods.update(extra)
        with mock.patch.dict(sys.modules, mods):
            yield


# ---------------------------------------------------------------------------
# FLEET-P1-002: Qwen3-ASR
# ---------------------------------------------------------------------------
class FakeAsrModel:
    def __init__(self, kind: str, args: tuple, kwargs: Dict[str, Any]) -> None:
        self.kind, self.args, self.kwargs = kind, args, kwargs
        self.transcribe_calls: List[Dict[str, Any]] = []
        self.chunks: List[int] = []

    def transcribe(self, audio: Any, language: Any = None):
        self.transcribe_calls.append({"audio": audio, "language": language})
        return [types.SimpleNamespace(text="hallo welt", language=language or "German")]

    def init_streaming_state(self, **kwargs: Any):
        return types.SimpleNamespace(text="", language=None, kwargs=kwargs, finished=False)

    def streaming_transcribe(self, pcm: np.ndarray, state: Any) -> None:
        self.chunks.append(int(pcm.shape[0]))
        state.text = (state.text + " teil").strip()
        state.language = "German"

    def finish_streaming_transcribe(self, state: Any) -> None:
        state.finished = True
        state.text += "."


def fake_qwen_asr(models: List[FakeAsrModel]) -> types.ModuleType:
    mod = types.ModuleType("qwen_asr")

    class Qwen3ASRModel:
        @staticmethod
        def from_pretrained(*args: Any, **kwargs: Any) -> FakeAsrModel:
            models.append(FakeAsrModel("transformers", args, kwargs))
            return models[-1]

        @staticmethod
        def LLM(*args: Any, **kwargs: Any) -> FakeAsrModel:  # noqa: N802 - API-Name
            models.append(FakeAsrModel("vllm", args, kwargs))
            return models[-1]

    mod.Qwen3ASRModel = Qwen3ASRModel
    return mod


class Qwen3AsrTest(EarsTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.models: List[FakeAsrModel] = []
        self.modules["qwen_asr"] = fake_qwen_asr(self.models)
        self.d = definition("qwen3-asr-1.7b")

    def test_transformers_backend_repo_revision_bf16_deutsch(self):
        with self.fakes():
            out = he.qwen3_asr_transcribe("qwen3-asr-1.7b", self.d, {"audio": wav_b64()})
        self.assertEqual(self.hub_calls, [{"repo_id": "Qwen/Qwen3-ASR-1.7B", "revision": "7278e1e70fe206f11671096ffdd38061171dd6e5"}])
        model = self.models[0]
        self.assertEqual(model.kind, "transformers")
        self.assertEqual(model.args, ("/snap/x",))
        self.assertEqual(model.kwargs["dtype"], "bf16")
        self.assertEqual(model.kwargs["device_map"], "cuda:0")
        call = model.transcribe_calls[0]
        self.assertEqual(call["language"], "German")
        samples, sr = call["audio"]
        self.assertEqual((samples.dtype, samples.ndim, sr), (np.float32, 1, 16000))
        self.assertEqual(set(out), {"text", "language", "model", "backend", "durationSeconds", "wordTimestamps"})
        self.assertEqual(out["text"], "hallo welt")
        self.assertIs(out["wordTimestamps"], False)

    def test_cpu_bleibt_fp32(self):
        self.modules["torch"] = fake_torch(cuda=False)
        with self.fakes():
            he.qwen3_asr_transcribe("qwen3-asr-1.7b", self.d, {"audio": wav_b64()})
        self.assertEqual(self.models[0].kwargs["dtype"], "fp32")
        self.assertEqual(self.models[0].kwargs["device_map"], "cpu")

    def test_sprachen(self):
        self.assertEqual(he.normalize_asr_language(None), "German")
        self.assertEqual(he.normalize_asr_language("de-DE"), "German")
        self.assertEqual(he.normalize_asr_language("Deutsch"), "German")
        self.assertEqual(he.normalize_asr_language("en"), "English")
        self.assertIsNone(he.normalize_asr_language("auto"))
        with self.assertRaises(ModelUnavailableError):
            he.normalize_asr_language("klingonisch")

    def test_wort_timestamps_klarer_fehler(self):
        with self.fakes(), self.assertRaisesRegex(ModelUnavailableError, "ForcedAligner"):
            he.qwen3_asr_transcribe("qwen3-asr-1.7b", self.d, {"audio": wav_b64(), "wordTimestamps": True})
        self.assertEqual(self.hub_calls, [])

    def test_streaming_ohne_vllm_backend_klarer_fehler(self):
        with self.fakes(), self.assertRaisesRegex(ModelUnavailableError, "vLLM"):
            he.qwen3_asr_transcribe("qwen3-asr-1.7b", self.d, {"audio": wav_b64(), "streamId": "s1"})

    def test_vllm_backend_braucht_vllm(self):
        os.environ[he.QWEN3_ASR_BACKEND_ENV] = "vllm"
        with self.fakes(vllm=None), self.assertRaisesRegex(ModelUnavailableError, "vllm"):
            he.qwen3_asr_transcribe("qwen3-asr-1.7b", self.d, {"audio": wav_b64()})

    def test_streaming_sitzung_mit_vllm(self):
        os.environ[he.QWEN3_ASR_BACKEND_ENV] = "vllm"
        with self.fakes(vllm=types.ModuleType("vllm")):
            a = he.qwen3_asr_transcribe("qwen3-asr-1.7b", self.d, {"audio": wav_b64(0.5), "streamId": "u1"})
            b = he.qwen3_asr_transcribe("qwen3-asr-1.7b", self.d, {"audio": wav_b64(0.5), "streamId": "u1"})
            c = he.qwen3_asr_transcribe("qwen3-asr-1.7b", self.d, {"streamId": "u1", "final": True})
        model = self.models[0]
        self.assertEqual(model.kind, "vllm")
        self.assertEqual(model.kwargs["gpu_memory_utilization"], he.QWEN3_ASR_GPU_UTIL_DEFAULT)
        self.assertEqual(model.chunks, [8000, 8000])
        self.assertEqual((a["text"], a["final"]), ("teil", False))
        self.assertEqual(b["text"], "teil teil")
        self.assertEqual((c["text"], c["final"], c["streamSeconds"]), ("teil teil.", True, 1.0))
        self.assertNotIn("u1", he._STREAMS)
        self.assertEqual(len(self.models), 1)  # Modell gecacht, nicht je Happen geladen

    def test_streaming_grenzen(self):
        os.environ[he.QWEN3_ASR_BACKEND_ENV] = "vllm"
        with self.fakes(vllm=types.ModuleType("vllm")):
            with self.assertRaisesRegex(ModelUnavailableError, "streamId"):
                he.qwen3_asr_transcribe("qwen3-asr-1.7b", self.d, {"audio": wav_b64(), "streamId": "../x", "stream": True})
            with self.assertRaisesRegex(ModelUnavailableError, "too long"):
                he.qwen3_asr_transcribe("qwen3-asr-1.7b", self.d, {"audio": wav_b64(31.0, sr=8000), "streamId": "u2"})
            with mock.patch.object(he, "MAX_STREAMS", 1):
                he.qwen3_asr_transcribe("qwen3-asr-1.7b", self.d, {"audio": wav_b64(0.2), "streamId": "a"})
                with self.assertRaisesRegex(ModelUnavailableError, "Streaming-Sitzungen"):
                    he.qwen3_asr_transcribe("qwen3-asr-1.7b", self.d, {"audio": wav_b64(0.2), "streamId": "b"})

    def test_ungepinnte_revision_laedt_nichts(self):
        d = definition("qwen3-asr-1.7b", revision="main")
        with self.fakes(), self.assertRaisesRegex(ModelUnavailableError, "Commit-Hash"):
            he.qwen3_asr_transcribe("qwen3-asr-1.7b", d, {"audio": wav_b64()})
        self.assertEqual(self.hub_calls, [])

    def test_paket_fehlt_klarer_fehler(self):
        with self.fakes(qwen_asr=None), self.assertRaisesRegex(ModelUnavailableError, "pip install qwen-asr"):
            he.qwen3_asr_transcribe("qwen3-asr-1.7b", self.d, {"audio": wav_b64()})

    def test_dauer_und_groesse(self):
        d = definition("qwen3-asr-1.7b", maxDuration=1)
        with self.fakes():
            with self.assertRaisesRegex(ModelUnavailableError, "too long"):
                he.qwen3_asr_transcribe("qwen3-asr-1.7b", d, {"audio": wav_b64(2.0)})
            with self.assertRaisesRegex(ModelUnavailableError, "too small"):
                he.qwen3_asr_transcribe("qwen3-asr-1.7b", d, {"audio": base64.b64encode(b"RIFF").decode()})
            with self.assertRaisesRegex(ModelUnavailableError, "required"):
                he.qwen3_asr_transcribe("qwen3-asr-1.7b", d, {})

    def test_dispatch_whisper_bleibt_alter_handler(self):
        with mock.patch.object(handlers, "hf_transcribe", return_value={"text": "w"}) as legacy:
            out = handlers.run_inference("audio.transcribe", "whisper-large-v3", definition("whisper-large-v3"), {"audio": "x"})
        self.assertEqual(out, {"text": "w"})
        legacy.assert_called_once()
        with self.fakes():
            out = handlers.run_inference("audio.transcribe", "qwen3-asr-1.7b", self.d, {"audio": wav_b64()})
        self.assertEqual(out["model"], "qwen3-asr-1.7b")


# ---------------------------------------------------------------------------
# FLEET-P1-003: MOSS-Audio-8B-Instruct
# ---------------------------------------------------------------------------
MOSS_FAKE_CODE = '''
import numpy as np
CALLS = {}

class _T:
    def __init__(self, a): self.a = a
    def to(self, dtype): CALLS["audio_dtype"] = dtype; return self

class _Inputs(dict):
    def to(self, device): CALLS["inputs_device"] = device; return self

class MossAudioModel:
    device = "cuda:0"
    dtype = "bf16"
    @classmethod
    def from_pretrained(cls, path, **kw):
        CALLS["model"] = (path, kw); return cls()
    def eval(self): CALLS["eval"] = True
    def generate(self, **kw):
        CALLS["generate"] = kw
        ids = kw["input_ids"]
        return np.concatenate([ids, np.array([[7, 8, 9]])], axis=1)

class _Cfg:
    mel_sr = 16000

class MossAudioProcessor:
    audio_token_id = 5
    config = _Cfg()
    @classmethod
    def from_pretrained(cls, path, **kw):
        CALLS["processor"] = (path, kw); return cls()
    def __call__(self, text, audios, return_tensors):
        CALLS["prompt"] = text; CALLS["audio_len"] = len(audios[0])
        return _Inputs(input_ids=np.array([[1, 5, 5, 2]]), audio_data=_T(audios[0]))
    def decode(self, ids, skip_special_tokens=True):
        return " antwort " + ",".join(str(int(i)) for i in ids)
'''


class MossAudioTest(EarsTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.d = definition("moss-audio-8b-instruct")
        self.tmp = tempfile.TemporaryDirectory()
        src = pathlib.Path(self.tmp.name, "src")
        src.mkdir()
        (src / "__init__.py").write_text("")
        (src / "modeling_moss_audio.py").write_text(MOSS_FAKE_CODE)
        (src / "processing_moss_audio.py").write_text("from src.modeling_moss_audio import MossAudioProcessor  # noqa\n")
        for name in [m for m in sys.modules if m == "src" or m.startswith("src.")]:
            sys.modules.pop(name)

    def tearDown(self) -> None:
        for name in [m for m in sys.modules if m == "src" or m.startswith("src.")]:
            sys.modules.pop(name)
        if self.tmp.name in sys.path:
            sys.path.remove(self.tmp.name)
        self.tmp.cleanup()
        super().tearDown()

    def test_manifest_entscheidung(self):
        self.assertIs(self.d.trustRemoteCode, True)
        self.assertEqual(self.d.quantization, "bf16")
        self.assertTrue(self.d.repository.endswith("-Instruct"))

    def test_durchlauf_mit_gepinntem_code(self):
        os.environ[he.MOSS_AUDIO_ROOT_ENV] = self.tmp.name
        with self.fakes():
            out = he.moss_audio_understand("moss-audio-8b-instruct", self.d, {"audio": wav_b64(), "question": "Was hoerst du?"})
            calls = sys.modules["src.modeling_moss_audio"].CALLS
        self.assertEqual(self.hub_calls[0]["revision"], "d4dc5a6d8cd79b43dcd82884c75e303b1ecd016d")
        path, kw = calls["model"]
        self.assertEqual(path, "/snap/x")
        self.assertEqual(kw, {"trust_remote_code": True, "dtype": "bf16", "device_map": "cuda:0"})
        self.assertEqual(calls["processor"][1], {"trust_remote_code": True, "enable_time_marker": True})
        self.assertEqual(calls["audio_len"], 16000)
        self.assertEqual(calls["audio_dtype"], "bf16")
        self.assertEqual(calls["generate"]["audio_input_mask"].tolist(), [[False, True, True, False]])
        self.assertIs(calls["generate"]["do_sample"], False)
        self.assertEqual(calls["generate"]["max_new_tokens"], 512)
        self.assertEqual(out, {"text": "antwort 7,8,9", "model": "moss-audio-8b-instruct", "variant": "instruct", "durationSeconds": 1.0})

    def test_ohne_code_checkout_klarer_fehler(self):
        os.environ[he.MOSS_AUDIO_ROOT_ENV] = os.path.join(self.tmp.name, "fehlt")
        with self.fakes(), self.assertRaisesRegex(ModelUnavailableError, he.MOSS_AUDIO_PIN["commit"]) as ctx:
            he.moss_audio_understand("moss-audio-8b-instruct", self.d, {"audio": wav_b64(), "question": "x"})
        self.assertIn("sglang", str(ctx.exception))
        self.assertIn("qwen2-audio-7b", str(ctx.exception))

    def test_ohne_opt_in_kein_repo_code(self):
        d = definition("moss-audio-8b-instruct", trustRemoteCode=False)
        with self.fakes(), self.assertRaisesRegex(ModelUnavailableError, "trust_remote_code"):
            he.moss_audio_understand("moss-audio-8b-instruct", d, {"audio": wav_b64(), "question": "x"})
        self.assertEqual(self.hub_calls, [])

    def test_thinking_variante_abgelehnt(self):
        d = definition("moss-audio-8b-instruct", repository="OpenMOSS-Team/MOSS-Audio-8B-Thinking")
        with self.assertRaisesRegex(ModelUnavailableError, "Thinking"):
            he.moss_audio_understand("moss-audio-8b-instruct", d, {"audio": wav_b64(), "question": "x"})

    def test_eingaben(self):
        with self.assertRaisesRegex(ModelUnavailableError, "question"):
            he.moss_audio_understand("moss-audio-8b-instruct", self.d, {"audio": wav_b64()})
        with self.assertRaisesRegex(ModelUnavailableError, "too long"):
            he.moss_audio_understand("moss-audio-8b-instruct", self.d, {"audio": wav_b64(), "question": "x" * 2001})
        with self.assertRaisesRegex(ModelUnavailableError, "maxTokens"):
            he.moss_audio_understand("moss-audio-8b-instruct", self.d, {"audio": wav_b64(), "question": "x", "maxTokens": 99999})

    def test_dispatch_qwen2_bleibt_alter_handler(self):
        import handlers_runpod

        with mock.patch.object(handlers_runpod, "qwen2_audio_understand", return_value={"text": "q2"}) as legacy:
            out = handlers.run_inference("audio.understand", "qwen2-audio-7b", definition("qwen2-audio-7b"), {})
        self.assertEqual(out, {"text": "q2"})
        legacy.assert_called_once()


# ---------------------------------------------------------------------------
# FLEET-P1-004: pyannote community-1 (4.x)
# ---------------------------------------------------------------------------
class _Turn:
    def __init__(self, start: float, end: float) -> None:
        self.start, self.end = start, end


class _Annotation:
    def __init__(self, items) -> None:
        self.items = items

    def itertracks(self, yield_label: bool = False):
        for start, end, spk in self.items:
            yield _Turn(start, end), "_", spk


def fake_pyannote(version: str, calls: Dict[str, Any]) -> Dict[str, types.ModuleType]:
    pkg = types.ModuleType("pyannote")
    audio = types.ModuleType("pyannote.audio")
    audio.__version__ = version

    class _Pipeline:
        def to(self, device):
            calls["device"] = device
            return self

        def __call__(self, data, **kwargs):
            calls["input"] = data
            calls["kwargs"] = kwargs
            return types.SimpleNamespace(
                speaker_diarization=_Annotation([(0.0, 1.23456, "SPEAKER_00"), (1.3, 2.0, "SPEAKER_01")]),
                exclusive_speaker_diarization=_Annotation([(0.0, 1.2, "SPEAKER_00")]),
            )

    class Pipeline:
        @staticmethod
        def from_pretrained(repo, **kwargs):
            calls["from_pretrained"] = (repo, kwargs)
            return _Pipeline()

    audio.Pipeline = Pipeline
    pkg.audio = audio
    return {"pyannote": pkg, "pyannote.audio": audio}


class PyannoteTest(EarsTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.d = definition("pyannote-community-1")
        self.calls: Dict[str, Any] = {}
        self._meta = mock.patch("importlib.metadata.version", side_effect=Exception("nicht installiert"))
        self._meta.start()

    def tearDown(self) -> None:
        self._meta.stop()
        super().tearDown()

    def test_durchlauf_4x(self):
        os.environ["HF_TOKEN"] = "hf_test"
        with self.fakes(**fake_pyannote("4.0.7", self.calls)):
            out = he.pyannote4_diarize("pyannote-community-1", self.d, {"audio": wav_b64(2.0, channels=2), "numSpeakers": 2})
        repo, kw = self.calls["from_pretrained"]
        self.assertEqual(repo, "pyannote/speaker-diarization-community-1")
        self.assertEqual(kw, {"revision": "3533c8cf8e369892e6b79ff1bf80f7b0286a54ee", "token": "hf_test"})
        self.assertEqual(self.calls["kwargs"], {"num_speakers": 2})
        self.assertEqual(self.calls["input"]["waveform"].shape, (1, 32000))
        self.assertEqual(self.calls["input"]["sample_rate"], 16000)
        self.assertEqual(out["segments"][0], {"start": 0.0, "end": 1.235, "speaker": "SPEAKER_00"})
        self.assertEqual(out["speakers"], ["SPEAKER_00", "SPEAKER_01"])
        self.assertEqual(out["exclusiveSegments"], [{"start": 0.0, "end": 1.2, "speaker": "SPEAKER_00"}])
        self.assertEqual(out["pyannoteMajor"], 4)

    def test_ohne_token_klarer_fehler(self):
        with self.fakes(**fake_pyannote("4.0.7", self.calls)), self.assertRaisesRegex(ModelUnavailableError, "HF_TOKEN"):
            he.pyannote4_diarize("pyannote-community-1", self.d, {"audio": wav_b64()})
        self.assertNotIn("from_pretrained", self.calls)

    def test_3x_installiert_klarer_fehler(self):
        os.environ["HF_TOKEN"] = "hf_test"
        with self.fakes(**fake_pyannote("3.3.2", self.calls)), self.assertRaisesRegex(ModelUnavailableError, "4.x"):
            he.pyannote4_diarize("pyannote-community-1", self.d, {"audio": wav_b64()})

    def test_sprecher_grenzen(self):
        os.environ["HF_TOKEN"] = "hf_test"
        with self.fakes(**fake_pyannote("4.0.7", self.calls)):
            with self.assertRaisesRegex(ModelUnavailableError, "numSpeakers"):
                he.pyannote4_diarize("pyannote-community-1", self.d, {"audio": wav_b64(), "numSpeakers": 99})
            with self.assertRaisesRegex(ModelUnavailableError, "minSpeakers > maxSpeakers"):
                he.pyannote4_diarize("pyannote-community-1", self.d, {"audio": wav_b64(), "minSpeakers": 5, "maxSpeakers": 2})

    def test_dispatch_31_mit_3x_alter_handler_mit_4x_neuer_pfad(self):
        import handlers_runpod

        os.environ["HF_TOKEN"] = "hf_test"
        legacy_def = definition("pyannote-diarization")
        with self.fakes(**fake_pyannote("3.3.2", self.calls)), mock.patch.object(
            handlers_runpod, "pyannote_diarize", return_value={"segments": []}
        ) as legacy:
            self.assertEqual(handlers.run_inference("audio.diarize", "pyannote-diarization", legacy_def, {}), {"segments": []})
            legacy.assert_called_once()
        with self.fakes(**fake_pyannote("4.0.7", self.calls)):
            out = handlers.run_inference("audio.diarize", "pyannote-diarization", legacy_def, {"audio": wav_b64()})
        self.assertEqual(self.calls["from_pretrained"][0], "pyannote/speaker-diarization-3.1")
        self.assertEqual(out["model"], "pyannote-diarization")


# ---------------------------------------------------------------------------
# FLEET-P1-005: SongFormer, beat_this, CLIP
# ---------------------------------------------------------------------------
class SongFormerTest(EarsTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.d = definition("songformer")
        self.calls: Dict[str, Any] = {}
        calls = self.calls

        class _Model:
            def to(self, device):
                calls["device"] = device
                return self

            def eval(self):
                calls["eval"] = True

            def __call__(self, audio):
                calls["audio"] = audio
                return calls.get("result", [{"start": 0, "end": 12.3456, "label": "intro"}, {"start": 12.3456, "end": 40, "label": "verse"}])

        tr = types.ModuleType("transformers")

        class AutoModel:
            @staticmethod
            def from_pretrained(path, **kw):
                calls["from_pretrained"] = (path, kw)
                return _Model()

        tr.AutoModel = AutoModel
        self.modules["transformers"] = tr
        self._path = list(sys.path)

    def tearDown(self) -> None:
        sys.path[:] = self._path
        super().tearDown()

    def test_durchlauf(self):
        with self.fakes():
            out = he.songformer_structure("songformer", self.d, {"audio": wav_b64(1.0, sr=24000)})
        self.assertEqual(self.hub_calls, [{
            "repo_id": "ASLP-lab/SongFormer", "revision": "a75880ed1b7375ac71860ec6c4fc9c899cf99515",
            "ignore_patterns": ["SongFormer.pt", "SongFormer.safetensors"],
        }])
        self.assertEqual(self.calls["from_pretrained"], ("/snap/x", {"trust_remote_code": True, "low_cpu_mem_usage": False}))
        self.assertEqual(os.environ["SONGFORMER_LOCAL_DIR"], "/snap/x")
        self.assertEqual(self.calls["audio"].shape, (24000,))
        self.assertEqual(self.torch.autocast_calls, [{"device_type": "cuda", "dtype": "bf16"}])
        self.assertEqual(out["sections"], [{"start": 0.0, "end": 12.346, "label": "intro"}, {"start": 12.346, "end": 40.0, "label": "verse"}])
        self.assertEqual(out["analysis"], "structure")

    def test_resampling_ohne_scipy_klarer_fehler(self):
        with self.fakes(**{"scipy": None, "scipy.signal": None}), self.assertRaisesRegex(ModelUnavailableError, "scipy"):
            he.songformer_structure("songformer", self.d, {"audio": wav_b64(1.0, sr=16000)})

    def test_kaputtes_ergebnis(self):
        self.calls["result"] = [{"start": 5, "end": 1, "label": "x"}]
        with self.fakes(), self.assertRaisesRegex(ModelUnavailableError, "ungueltiger Zeit"):
            he.songformer_structure("songformer", self.d, {"audio": wav_b64(1.0, sr=24000)})

    def test_ohne_opt_in(self):
        d = definition("songformer", trustRemoteCode=False)
        with self.assertRaisesRegex(ModelUnavailableError, "trust_remote_code"):
            he.songformer_structure("songformer", d, {"audio": wav_b64(1.0, sr=24000)})


class BeatThisTest(EarsTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.tmp = tempfile.TemporaryDirectory()
        self.ckpt = os.path.join(self.tmp.name, "final0.ckpt")
        with open(self.ckpt, "wb") as fh:
            fh.write(b"checkpoint")
        self.calls: Dict[str, Any] = {}
        calls = self.calls
        inference = types.ModuleType("beat_this.inference")

        class Audio2Beats:
            def __init__(self, **kw):
                calls["init"] = kw

            def __call__(self, signal, sr):
                calls["signal"] = (signal.shape, sr)
                return np.arange(0.5, 4.0, 0.5), np.array([0.5, 2.5])

        inference.Audio2Beats = Audio2Beats
        self.modules["beat_this"] = types.ModuleType("beat_this")
        self.modules["beat_this.inference"] = inference

    def tearDown(self) -> None:
        self.tmp.cleanup()
        super().tearDown()

    def pinned(self):
        return definition("beat-this", revision=he.BEAT_THIS_PIN["commit"], status=None)

    def test_manifest_ohne_pin_klarer_fehler(self):
        d = definition("beat-this")
        self.assertEqual(d.revision, "PIN-ERFORDERLICH")
        with self.fakes(), self.assertRaisesRegex(ModelUnavailableError, "PIN-ERFORDERLICH") as ctx:
            he.beat_this_track("beat-this", d, {"audio": wav_b64()})
        self.assertIn("FLEET-P1-005", str(ctx.exception))
        self.assertNotIn("init", self.calls)

    def test_fremde_revision_abgelehnt(self):
        d = definition("beat-this", revision="0" * 40)
        with self.assertRaisesRegex(ModelUnavailableError, "passt nicht"):
            he.beat_this_track("beat-this", d, {"audio": wav_b64()})

    def test_hash_abweichung_bricht_ab(self):
        os.environ[he.BEAT_THIS_CHECKPOINT_ENV] = self.ckpt
        with self.fakes(), self.assertRaisesRegex(ModelUnavailableError, "SHA-256"):
            he.beat_this_track("beat-this", self.pinned(), {"audio": wav_b64()})
        self.assertNotIn("init", self.calls)

    def test_checkpoint_fehlt(self):
        os.environ[he.BEAT_THIS_CHECKPOINT_ENV] = os.path.join(self.tmp.name, "nix.ckpt")
        with self.assertRaisesRegex(ModelUnavailableError, "Checkpoint fehlt"):
            he.beat_this_track("beat-this", self.pinned(), {"audio": wav_b64()})

    def test_durchlauf_mit_passendem_hash(self):
        os.environ[he.BEAT_THIS_CHECKPOINT_ENV] = self.ckpt
        digest = hashlib.sha256(b"checkpoint").hexdigest()
        with self.fakes(), mock.patch.dict(he.BEAT_THIS_PIN, {"checkpointSha256": digest}):
            out = he.beat_this_track("beat-this", self.pinned(), {"audio": wav_b64(1.0, sr=22050)})
        self.assertEqual(self.calls["init"], {"checkpoint_path": self.ckpt, "device": str(self.torch.device("cuda")), "float16": False, "dbn": False})
        self.assertEqual(self.calls["signal"], ((22050,), 22050))
        self.assertEqual(out["beats"][:3], [0.5, 1.0, 1.5])
        self.assertEqual(out["downbeats"], [0.5, 2.5])
        self.assertEqual(out["bpm"], 120.0)

    def test_bpm(self):
        self.assertIsNone(he.estimate_bpm([1.0]))
        self.assertEqual(he.estimate_bpm([0.0, 0.4, 0.8, 1.2]), 150.0)


class _Img:
    def __init__(self, size=(64, 48)) -> None:
        self.size = size

    def convert(self, mode):
        return ("img", mode)


class ClipTest(EarsTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.d = definition("clip-vit-l14")
        self.calls: Dict[str, Any] = {"dim": 768}
        calls = self.calls
        pil_pkg = types.ModuleType("PIL")
        pil_image = types.ModuleType("PIL.Image")

        def _open(fp):
            data = fp.read()
            if data == b"kaputt":
                raise OSError("cannot identify image file")
            return _Img((10000, 10000)) if data == b"riesig" else _Img()

        pil_image.open = _open
        pil_pkg.Image = pil_image
        tr = types.ModuleType("transformers")

        class _Model:
            def to(self, device):
                calls["device"] = device
                return self

            def eval(self):
                pass

            def get_image_features(self, pixel_values):
                n = pixel_values.shape[0]
                arr = np.zeros((n, calls["dim"]), dtype=np.float32)
                arr[:, 0] = 3.0
                arr[:, 1] = np.arange(n) * 4.0
                return FakeTensor(arr)

            def get_text_features(self, input_ids, attention_mask):
                return FakeTensor(np.full((input_ids.shape[0], calls["dim"]), 2.0, dtype=np.float32))

        class CLIPModel:
            @staticmethod
            def from_pretrained(repo, **kw):
                calls["model"] = (repo, kw)
                return _Model()

        class _Proc:
            def __call__(self, images=None, text=None, **kw):
                if images is not None:
                    calls["images"] = images
                    return {"pixel_values": FakeTensor(np.zeros((len(images), 3, 224, 224)))}
                calls["text_kw"] = kw
                return {"input_ids": FakeTensor(np.zeros((len(text), 7))), "attention_mask": FakeTensor(np.ones((len(text), 7)))}

        class CLIPProcessor:
            @staticmethod
            def from_pretrained(repo, **kw):
                calls["processor"] = (repo, kw)
                return _Proc()

        tr.CLIPModel, tr.CLIPProcessor = CLIPModel, CLIPProcessor
        self.modules.update({"PIL": pil_pkg, "PIL.Image": pil_image, "transformers": tr})

    @staticmethod
    def b64(data: bytes) -> str:
        return base64.b64encode(data).decode()

    def test_manifest_task_und_rolle(self):
        self.assertEqual(MANIFEST["clip-vit-l14"]["task"], "image.embed")
        self.assertIn("clip-vit-l14", registry.read_manifest()["roles"]["ears"]["models"])

    def test_bilder_und_text_768_normiert(self):
        with self.fakes():
            out = he.clip_embed("clip-vit-l14", self.d, {"images": [self.b64(b"a"), self.b64(b"b")], "texts": ["sonnenuntergang"]})
        self.assertEqual(self.calls["model"], ("openai/clip-vit-large-patch14", {"revision": "32bd64288804d66eefd0ccbe215aa642df71cc41", "torch_dtype": "bf16"}))
        self.assertEqual(self.calls["images"], [("img", "RGB"), ("img", "RGB")])
        self.assertEqual(self.calls["text_kw"]["max_length"], 77)
        self.assertEqual(out["dim"], 768)
        self.assertEqual(len(out["imageEmbeddings"]), 2)
        for row in out["imageEmbeddings"] + out["textEmbeddings"]:
            self.assertEqual(len(row), 768)
            self.assertAlmostEqual(float(np.linalg.norm(row)), 1.0, places=4)
        self.assertNotIn("videoEmbedding", out)

    def test_video_frames_mittelwert(self):
        with self.fakes():
            out = he.clip_embed("clip-vit-l14", self.d, {"frames": [self.b64(b"a"), self.b64(b"b"), self.b64(b"c")]})
        self.assertEqual(out["frameCount"], 3)
        self.assertAlmostEqual(float(np.linalg.norm(out["videoEmbedding"])), 1.0, places=4)

    def test_grenzen_und_fehler(self):
        with self.fakes():
            with self.assertRaisesRegex(ModelUnavailableError, "required"):
                he.clip_embed("clip-vit-l14", self.d, {})
            with self.assertRaisesRegex(ModelUnavailableError, "zu viele"):
                he.clip_embed("clip-vit-l14", self.d, {"images": [self.b64(b"a")] * 33})
            with self.assertRaisesRegex(ModelUnavailableError, "base64"):
                he.clip_embed("clip-vit-l14", self.d, {"image": "@@@"})
            with self.assertRaisesRegex(ModelUnavailableError, "decode"):
                he.clip_embed("clip-vit-l14", self.d, {"image": self.b64(b"kaputt")})
            with self.assertRaisesRegex(ModelUnavailableError, "px"):
                he.clip_embed("clip-vit-l14", self.d, {"image": self.b64(b"riesig")})
            with self.assertRaisesRegex(ModelUnavailableError, "Suchtext"):
                he.clip_embed("clip-vit-l14", self.d, {"texts": ["x" * 301]})
            self.calls["dim"] = 512
            he._CACHE.clear()
            with self.assertRaisesRegex(ModelUnavailableError, "768"):
                he.clip_embed("clip-vit-l14", self.d, {"image": self.b64(b"a")})

    def test_dispatch(self):
        with self.fakes():
            out = handlers.run_inference("image.embed", "clip-vit-l14", self.d, {"text": "wald"})
            self.assertEqual(len(out["textEmbeddings"]), 1)
            out = handlers.run_inference("embed", "clip-vit-l14", self.d, {"text": "wald"})
            self.assertEqual(out["dim"], 768)
        with mock.patch.object(handlers, "hf_embed", return_value={"dim": 512}) as legacy:
            self.assertEqual(handlers.run_inference("audio.embed", "clap-music", definition("clap-music"), {}), {"dim": 512})
        legacy.assert_called_once()


# ---------------------------------------------------------------------------
# Manifest + Dispatch insgesamt
# ---------------------------------------------------------------------------
class ManifestDispatchTest(unittest.TestCase):
    def test_neue_modelle_waehlbar_altmodelle_bleiben_standard(self):
        data = registry.read_manifest()
        ears = data["roles"]["ears"]
        for mid in ("qwen3-asr-1.7b", "moss-audio-8b-instruct", "pyannote-community-1", "songformer", "clip-vit-l14"):
            self.assertIn(mid, ears["models"], mid)
            self.assertNotIn(mid, ears["preloadModels"], mid)
            self.assertNotEqual(MANIFEST[mid].get("status"), "neu", mid)
        for mid in ("whisper-large-v3", "qwen2-audio-7b", "pyannote-diarization", "essentia"):
            self.assertIn(mid, ears["preloadModels"], mid)
        self.assertEqual(MANIFEST["beat-this"]["status"], "neu")
        self.assertEqual(MANIFEST["beat-this"]["revision"], "PIN-ERFORDERLICH")
        for mid in he.EARS_MODELS:
            if MANIFEST[mid]["revision"] != "PIN-ERFORDERLICH":
                self.assertRegex(MANIFEST[mid]["revision"], r"^[0-9a-f]{40}$", mid)

    def test_remote_code_nur_wo_noetig(self):
        flagged = {m for m in he.EARS_MODELS if MANIFEST[m].get("trustRemoteCode") is True}
        self.assertEqual(flagged, {"moss-audio-8b-instruct", "songformer"})

    def test_essentia_bleibt_alter_handler(self):
        with mock.patch.object(handlers, "essentia_analyze", return_value={"bpm": 1}) as legacy:
            self.assertEqual(handlers.run_inference("audio.analyze", "essentia", definition("essentia"), {}), {"bpm": 1})
        legacy.assert_called_once()

    def test_handler_tabelle(self):
        self.assertIs(handlers.HANDLERS["transcribe"], he.transcribe_dispatch)
        self.assertIs(handlers.HANDLERS["understand"], he.understand_dispatch)
        self.assertIs(handlers.HANDLERS["diarize"], he.diarize_dispatch)
        self.assertIs(handlers.HANDLERS["analyze"], he.analyze_dispatch)
        self.assertIs(handlers.HANDLERS["image.embed"], he.clip_embed)

    def test_stereo_wav_ohne_soundfile_wird_mono(self):
        with mock.patch.dict(sys.modules, {"soundfile": None}):
            samples, sr = he.decode_audio(base64.b64decode(wav_b64(0.1, sr=8000, channels=2)))
        self.assertEqual((samples.shape, sr), ((800,), 8000))
        self.assertLessEqual(float(np.max(np.abs(samples))), 0.31)


if __name__ == "__main__":
    unittest.main(verbosity=2)
