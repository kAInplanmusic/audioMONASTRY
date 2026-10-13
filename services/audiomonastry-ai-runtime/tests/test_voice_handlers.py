"""RP4 voice + Gesang (FLEET-P1-007 bis -010): Handler ohne GPU, alles gefaelscht.

    python3 services/audiomonastry-ai-runtime/tests/test_voice_handlers.py

Gefaelscht: torch, soundfile (stdlib `wave`, PCM16), huggingface_hub
(snapshot_download -> Temp-Ordner), qwen_tts, moss_soundeffect_v2, acestep.
Geprueft wird der Vertrag der Adapter (Pins, Schemata, Grenzen, bf16, Fehler,
Abbruchpunkt), NICHT die Inferenz – kein Handler ist auf einer GPU gelaufen.
"""
from __future__ import annotations

import base64
import hashlib
import io
import os
import pathlib
import shutil
import sys
import tempfile
import threading
import time
import types
import unittest
import wave
from unittest import mock

RUNTIME_DIR = pathlib.Path(__file__).resolve().parent.parent
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

try:
    import numpy as np

    HAS_NUMPY = True
except Exception:  # noqa: BLE001
    HAS_NUMPY = False

from model_manager import ModelDefinition, ModelUnavailableError  # noqa: E402
import pod_jobs  # noqa: E402

REV = "a" * 40
FAKE_MODULE_NAMES = ("torch", "soundfile", "huggingface_hub", "qwen_tts", "moss_soundeffect_v2",
                     "acestep", "acestep.handler", "acestep.inference")
SHARED_REV = "19671f406d603126926c1b7e2adc169acbcade22"


# ---------------------------------------------------------------------------
# Faelschungen
# ---------------------------------------------------------------------------
def fake_soundfile() -> types.ModuleType:
    sf = types.ModuleType("soundfile")

    def read(fh, dtype="float32", always_2d=False):  # noqa: ANN001, ARG001
        with wave.open(fh, "rb") as w:
            ch, rate, n = w.getnchannels(), w.getframerate(), w.getnframes()
            raw = w.readframes(n)
        data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
        data = data.reshape(-1, ch)
        return (data if always_2d or ch > 1 else data[:, 0]), rate

    def write(target, data, rate, format=None, subtype=None):  # noqa: A002, ANN001, ARG001
        arr = np.asarray(data, dtype=np.float32)
        if arr.ndim == 1:
            arr = arr[:, None]
        pcm = (np.clip(arr, -1, 1) * 32767).astype("<i2")
        sf.calls.append({"rate": int(rate), "subtype": subtype, "shape": arr.shape})
        fh = open(target, "wb") if isinstance(target, str) else target
        try:
            with wave.open(fh, "wb") as w:
                w.setnchannels(arr.shape[1])
                w.setsampwidth(2)
                w.setframerate(int(rate))
                w.writeframes(pcm.tobytes())
        finally:
            if isinstance(target, str):
                fh.close()

    sf.read, sf.write, sf.calls = read, write, []
    return sf


def wav_b64(seconds: float, rate: int = 24000, channels: int = 1, value: float = 0.25) -> str:
    n = int(seconds * rate)
    pcm = np.full((n, channels), value, dtype=np.float32)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes((pcm * 32767).astype("<i2").tobytes())
    return base64.b64encode(buf.getvalue()).decode()


def fake_torch(cuda: bool = True) -> types.ModuleType:
    torch = types.ModuleType("torch")
    torch.bfloat16, torch.float32, torch.float16 = "bfloat16", "float32", "float16"
    torch.cuda = types.SimpleNamespace(is_available=lambda: cuda, current_device=lambda: 0)
    torch.device = lambda name: types.SimpleNamespace(type=name)
    return torch


class FakeHub:
    """snapshot_download -> vorbereitete Ordner je (repo, revision)."""

    def __init__(self, root: str) -> None:
        self.root = root
        self.calls = []
        self.dirs = {}

    def add(self, repo: str, revision: str, files: dict) -> str:
        path = os.path.join(self.root, repo.replace("/", "--"), revision)
        for rel, content in files.items():
            full = os.path.join(path, rel)
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, "wb") as fh:
                fh.write(content)
        self.dirs[(repo, revision)] = path
        return path

    def snapshot_download(self, repo_id, revision=None, allow_patterns=None, local_files_only=False):  # noqa: ANN001
        self.calls.append({"repo": repo_id, "revision": revision, "patterns": allow_patterns, "offline": local_files_only})
        if (repo_id, revision) not in self.dirs:
            raise FileNotFoundError(f"{repo_id}@{revision} nicht im Cache")
        return self.dirs[(repo_id, revision)]

    def module(self) -> types.ModuleType:
        mod = types.ModuleType("huggingface_hub")
        mod.snapshot_download = self.snapshot_download
        return mod


def definition(model_id: str, repo: str, task: str, revision: str = REV) -> ModelDefinition:
    return ModelDefinition.from_dict(
        {"id": model_id, "repository": repo, "revision": revision, "task": task, "framework": "custom", "quantization": "bf16"}
    )


class Base(unittest.TestCase):
    cuda = True

    def setUp(self) -> None:
        import handlers_runpod

        handlers_runpod._MODEL_CACHE.clear()
        self.tmp = tempfile.mkdtemp(prefix="voice-test-")
        self.hub = FakeHub(os.path.join(self.tmp, "hub"))
        self.sf = fake_soundfile()
        # Nur die gefaelschten Namen ersetzen und danach exakt zuruecksetzen (kein
        # patch.dict ueber ganz sys.modules: das wuerde z. B. numpy-Untermodule entladen).
        self._saved = {name: sys.modules.get(name) for name in FAKE_MODULE_NAMES}
        sys.modules.update({"torch": fake_torch(self.cuda), "soundfile": self.sf, "huggingface_hub": self.hub.module()})
        import handlers_voice

        self.hv = handlers_voice
        self.hv._HASHES.clear()

    def tearDown(self) -> None:
        for name, module in self._saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module
        import handlers_runpod

        handlers_runpod._MODEL_CACHE.clear()
        shutil.rmtree(self.tmp, ignore_errors=True)


# ---------------------------------------------------------------------------
# FLEET-P1-007: Qwen3-TTS-0.6B-Base Cloning
# ---------------------------------------------------------------------------
class FakeQwen:
    calls: list = []
    kind = "base"

    @classmethod
    def from_pretrained(cls, repo, **kwargs):  # noqa: ANN001, ANN206
        cls.calls.append({"from_pretrained": repo, **kwargs})
        inst = cls()
        inst.model = types.SimpleNamespace(tts_model_type=cls.kind)
        return inst

    def generate_voice_clone(self, **kwargs):  # noqa: ANN003
        type(self).calls.append(kwargs)
        return [np.zeros(2400, dtype=np.float32)], 24000


@unittest.skipUnless(HAS_NUMPY, "numpy fehlt")
class CloneTest(Base):
    def setUp(self) -> None:
        super().setUp()
        FakeQwen.calls, FakeQwen.kind = [], "base"
        qwen = types.ModuleType("qwen_tts")
        qwen.Qwen3TTSModel = FakeQwen
        sys.modules["qwen_tts"] = qwen
        self.defn = definition("qwen3-tts-06b-base", "Qwen/Qwen3-TTS-12Hz-0.6B-Base", "tts", "5d83992436eae1d760afd27aff78a71d676296fc")

    def test_icl_mit_referenztext_bf16_und_pin(self) -> None:
        out = self.hv.qwen3_tts_clone("qwen3-tts-06b-base", self.defn, {
            "text": "Hallo Welt", "language": "DE", "refAudio": wav_b64(4.0), "refText": "Das ist meine Stimme."})
        load, call = FakeQwen.calls
        self.assertEqual(load["from_pretrained"], "Qwen/Qwen3-TTS-12Hz-0.6B-Base")
        self.assertEqual(load["revision"], "5d83992436eae1d760afd27aff78a71d676296fc")
        self.assertEqual(load["dtype"], "bfloat16")
        self.assertEqual(load["device_map"], "cuda:0")
        self.assertEqual(call["language"], "german")
        self.assertEqual(call["ref_text"], "Das ist meine Stimme.")
        self.assertFalse(call["x_vector_only_mode"])
        ref, sr = call["ref_audio"]  # (np, sr) – nie eine URL/ein Pfad
        self.assertEqual(sr, 24000)
        self.assertEqual(ref.ndim, 1)
        self.assertEqual(out["cloneMode"], "icl")
        self.assertEqual(out["sampleRate"], 24000)
        self.assertAlmostEqual(out["referenceSeconds"], 4.0, places=2)
        self.assertTrue(base64.b64decode(out["audioBase64"]).startswith(b"RIFF"))

    def test_ohne_referenztext_nur_sprechervektor(self) -> None:
        out = self.hv.qwen3_tts_clone("qwen3-tts-06b-base", self.defn, {"text": "Hi", "speakerWav": wav_b64(3.5)})
        self.assertTrue(FakeQwen.calls[-1]["x_vector_only_mode"])
        self.assertIsNone(FakeQwen.calls[-1]["ref_text"])
        self.assertEqual(out["cloneMode"], "x-vector")

    def test_grenzen_und_klare_fehler(self) -> None:
        cases = {
            "zu kurz": {"text": "x", "refAudio": wav_b64(2.0)},
            "zu lang": {"text": "x", "refAudio": wav_b64(31.0, rate=8000)},
            "URLs": {"text": "x", "refAudio": "https://example.org/stimme.wav"},
            "erforderlich": {"text": "", "refAudio": wav_b64(4.0)},
            "refAudio": {"text": "x"},
            "stumm": {"text": "x", "refAudio": wav_b64(4.0, value=0.0)},
            "Kanaele": {"text": "x", "refAudio": wav_b64(4.0, channels=3)},
            "zu lang (hoechstens 1000": {"text": "x" * 1001, "refAudio": wav_b64(4.0)},
            "unsupported tts language": {"text": "x", "refAudio": wav_b64(4.0), "language": "klingon"},
        }
        for needle, payload in cases.items():
            with self.subTest(needle), self.assertRaises(ModelUnavailableError) as ctx:
                self.hv.qwen3_tts_clone("qwen3-tts-06b-base", self.defn, payload)
            self.assertIn(needle, str(ctx.exception))
        self.assertEqual([c for c in FakeQwen.calls if "text" in c], [], "Modell darf bei Fehleingaben nicht laufen")

    def test_zu_grosse_referenz_vor_dem_dekodieren(self) -> None:
        with self.assertRaises(ModelUnavailableError) as ctx:
            self.hv.decode_base64_audio("A" * (self.hv.CLONE_REF_MAX_BYTES * 2), max_bytes=self.hv.CLONE_REF_MAX_BYTES, label="refAudio")
        self.assertIn("zu gross", str(ctx.exception))

    def test_kein_base_modell_wird_abgelehnt(self) -> None:
        FakeQwen.kind = "custom_voice"
        with self.assertRaises(ModelUnavailableError) as ctx:
            self.hv.qwen3_tts_clone("qwen3-tts-06b-base", self.defn, {"text": "x", "refAudio": wav_b64(4.0)})
        self.assertIn("kein Base-Modell", str(ctx.exception))

    def test_ungepinnte_revision(self) -> None:
        bad = definition("qwen3-tts-06b-base", "Qwen/Qwen3-TTS-12Hz-0.6B-Base", "tts", "main")
        with self.assertRaises(ModelUnavailableError):
            self.hv.qwen3_tts_clone("qwen3-tts-06b-base", bad, {"text": "x", "refAudio": wav_b64(4.0)})

    def test_dispatch_tts(self) -> None:
        import handlers

        with mock.patch.object(handlers, "qwen3_tts_clone", return_value={"ok": "clone"}), \
                mock.patch.object(handlers, "qwen3_tts", return_value={"ok": "custom"}):
            self.assertEqual(handlers.run_inference("tts", "qwen3-tts-06b-base", self.defn, {"text": "x"}), {"ok": "clone"})
            custom = definition("qwen3-tts-17b", "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice", "tts")
            self.assertEqual(handlers.run_inference("tts", "qwen3-tts-17b", custom, {"text": "x"}), {"ok": "custom"})


# ---------------------------------------------------------------------------
# FLEET-P1-008: MOSS-SoundEffect-v2.0
# ---------------------------------------------------------------------------
class FakeMossPipeline:
    calls: list = []
    fail = None

    def __init__(self) -> None:
        self.sample_rate = 48000

    @classmethod
    def from_pretrained(cls, path, torch_dtype=None, device=None):  # noqa: ANN001, ANN206
        cls.calls.append({"from_pretrained": path, "torch_dtype": torch_dtype, "device": device})
        return cls()

    def __call__(self, **kwargs):  # noqa: ANN003
        type(self).calls.append(kwargs)
        if type(self).fail:
            raise type(self).fail
        return np.zeros((1, 1, int(48000 * kwargs["seconds"])), dtype=np.float32)


@unittest.skipUnless(HAS_NUMPY, "numpy fehlt")
class SoundEffectTest(Base):
    def setUp(self) -> None:
        super().setUp()
        FakeMossPipeline.calls, FakeMossPipeline.fail = [], None
        code_root = os.path.join(self.tmp, "moss")
        os.makedirs(os.path.join(code_root, "moss_soundeffect_v2"))
        os.environ[self.hv.MOSS_SFX_ROOT_ENV] = code_root
        mod = types.ModuleType("moss_soundeffect_v2")
        mod.MossSoundEffectPipeline = FakeMossPipeline
        sys.modules["moss_soundeffect_v2"] = mod
        files = {rel: rel.encode() * 3 for rel in self.hv.MOSS_SFX_FILES}
        self.snap = self.hub.add("OpenMOSS-Team/MOSS-SoundEffect-v2.0", self.hv.MOSS_SFX_REVISION, files)
        self.hashes = {rel: hashlib.sha256(data).hexdigest() for rel, data in files.items()}
        self.defn = definition("moss-soundeffect-v2.0", "OpenMOSS-Team/MOSS-SoundEffect-v2.0", "generate", self.hv.MOSS_SFX_REVISION)

    def tearDown(self) -> None:
        os.environ.pop(self.hv.MOSS_SFX_ROOT_ENV, None)
        super().tearDown()

    def run_sfx(self, payload):  # noqa: ANN001, ANN201
        with mock.patch.dict(self.hv.MOSS_SFX_FILES, self.hashes):
            return self.hv.moss_soundeffect("moss-soundeffect-v2.0", self.defn, payload)

    def test_48khz_dauer_parameter_bf16(self) -> None:
        out = self.run_sfx({"prompt": " Tuer knarrt ", "durationSeconds": 2.5, "steps": 50, "seed": 7})
        load, call = FakeMossPipeline.calls
        self.assertEqual(load["from_pretrained"], self.snap)
        self.assertEqual(load["torch_dtype"], "bfloat16")
        self.assertEqual(load["device"], "cuda")
        self.assertEqual(call["prompt"], "Tuer knarrt")
        self.assertEqual(call["seconds"], 2.5)
        self.assertEqual(call["num_inference_steps"], 50)
        self.assertEqual(call["cfg_scale"], 4.0)
        self.assertEqual(call["sigma_shift"], 5.0)
        self.assertEqual(out["sampleRate"], 48000)
        self.assertEqual(out["durationSeconds"], 2.5)
        self.assertEqual(self.sf.calls[-1]["subtype"], "PCM_24")
        self.assertEqual(self.hub.calls[-1]["revision"], self.hv.MOSS_SFX_REVISION)

    def test_maxDuration_des_alten_pfads_und_offline(self) -> None:
        with mock.patch.dict(os.environ, {"HF_HUB_OFFLINE": "1"}):
            self.run_sfx({"prompt": "wind", "maxDuration": 3})
        self.assertEqual(FakeMossPipeline.calls[-1]["seconds"], 3.0)
        self.assertTrue(self.hub.calls[-1]["offline"])

    def test_grenzen(self) -> None:
        for payload in ({"prompt": "x", "durationSeconds": 31}, {"prompt": ""}, {"prompt": "x", "durationSeconds": 0.1},
                        {"prompt": "x", "steps": 0}, {"prompt": "x", "seed": -1}, {"prompt": "x", "durationSeconds": float("nan")}):
            with self.subTest(payload=payload), self.assertRaises(ModelUnavailableError):
                self.run_sfx(payload)
        self.assertEqual(FakeMossPipeline.calls, [])

    def test_hash_falsch_bricht_ab(self) -> None:
        bad = dict(self.hashes, **{"vae/vae_128d_48k.pth": "0" * 64})
        with mock.patch.dict(self.hv.MOSS_SFX_FILES, bad), self.assertRaises(ModelUnavailableError) as ctx:
            self.hv.moss_soundeffect("moss-soundeffect-v2.0", self.defn, {"prompt": "x"})
        self.assertIn("SHA-256", str(ctx.exception))
        self.assertEqual(FakeMossPipeline.calls, [], "Pickle-VAE darf ungeprueft nie geladen werden")

    def test_andere_revision_ohne_hashes(self) -> None:
        other = definition("moss-soundeffect-v2.0", "OpenMOSS-Team/MOSS-SoundEffect-v2.0", "generate", "b" * 40)
        self.hub.add("OpenMOSS-Team/MOSS-SoundEffect-v2.0", "b" * 40, {"x": b"1"})
        with self.assertRaises(ModelUnavailableError) as ctx:
            self.hv.moss_soundeffect("moss-soundeffect-v2.0", other, {"prompt": "x"})
        self.assertIn("keine Hash-Pins", str(ctx.exception))

    def test_code_fehlt(self) -> None:
        os.environ[self.hv.MOSS_SFX_ROOT_ENV] = os.path.join(self.tmp, "fehlt")
        with self.assertRaises(ModelUnavailableError) as ctx:
            self.run_sfx({"prompt": "x"})
        self.assertIn(self.hv.MOSS_SFX_PIN["commit"], str(ctx.exception))

    def test_dispatch_generate(self) -> None:
        import handlers

        with mock.patch.object(handlers, "moss_soundeffect", return_value={"ok": "moss"}):
            self.assertEqual(handlers.run_inference("audio.generate", "moss-soundeffect-v2.0", self.defn, {"prompt": "x"}), {"ok": "moss"})

    def test_startup_warmup_vor_ready(self) -> None:
        class Manager:
            def __init__(self, defn):  # noqa: ANN001
                self.defn = defn

            def get_model_info(self):  # noqa: ANN201
                return [{"id": "moss-soundeffect-v2.0", "loaded": True}, {"id": "qwen3-tts-17b", "loaded": True}]

            def get_definition(self, mid):  # noqa: ANN001, ANN201
                return self.defn if mid == "moss-soundeffect-v2.0" else None

        with mock.patch.dict(self.hv.MOSS_SFX_FILES, self.hashes):
            errors = self.hv.run_startup_warmups(Manager(self.defn))
        self.assertEqual(errors, [])
        self.assertEqual(FakeMossPipeline.calls[-1]["num_inference_steps"], 2)
        FakeMossPipeline.fail = RuntimeError("triton kaputt")
        import handlers_runpod

        handlers_runpod._MODEL_CACHE.clear()
        with mock.patch.dict(self.hv.MOSS_SFX_FILES, self.hashes):
            errors = self.hv.run_startup_warmups(Manager(self.defn))
        self.assertEqual(len(errors), 1)
        self.assertIn("torch.compile-Warmup", errors[0])


# ---------------------------------------------------------------------------
# ACE-Step-Faelschung (LEGO + sing)
# ---------------------------------------------------------------------------
class FakeDecoder:
    def __init__(self) -> None:
        self.hooks = []

    def register_forward_pre_hook(self, fn):  # noqa: ANN001, ANN201
        self.hooks.append(fn)
        return types.SimpleNamespace(remove=lambda: self.hooks.remove(fn))

    def __call__(self, *args):  # noqa: ANN002
        for hook in list(self.hooks):
            hook(self, args)


class FakeAceHandler:
    instances: list = []
    dtype = "bfloat16"

    def __init__(self) -> None:
        self.model = types.SimpleNamespace(decoder=FakeDecoder())
        self.init = None
        FakeAceHandler.instances.append(self)

    def _ensure_models_present(self, **_kw):  # noqa: ANN003, ANN202
        raise AssertionError("ACE-Step-Auto-Download darf nie laufen")

    def initialize_service(self, **kwargs):  # noqa: ANN003, ANN201
        self.init = kwargs
        ckpt = os.path.join(kwargs["project_root"], "checkpoints")
        failure = self._ensure_models_present(checkpoint_path=ckpt, config_path=kwargs["config_path"])
        if failure is not None:
            return failure
        self.dtype = type(self).dtype
        return "ok", True


class AceRecorder:
    params = []
    configs = []
    steps = 4
    step_hook = None  # callable(step) im Diffusionsschritt


def fake_acestep_modules() -> dict:
    pkg = types.ModuleType("acestep")
    handler = types.ModuleType("acestep.handler")
    handler.AceStepHandler = FakeAceHandler
    inference = types.ModuleType("acestep.inference")

    class GenerationParams:
        def __init__(self, **kw):  # noqa: ANN003
            self.__dict__.update(kw)

    class GenerationConfig(GenerationParams):
        pass

    def generate_music(dit, llm_handler, params, config, save_dir=None):  # noqa: ANN001, ANN202
        AceRecorder.params.append(params.__dict__)
        AceRecorder.configs.append(config.__dict__)
        assert llm_handler is None
        try:  # wie ACE-Step: Fehler aus der Diffusion -> success=False
            for step in range(AceRecorder.steps):
                if AceRecorder.step_hook:
                    AceRecorder.step_hook(step)
                dit.model.decoder("x")
        except Exception as exc:  # noqa: BLE001
            return types.SimpleNamespace(success=False, error=str(exc), audios=[])
        path = os.path.join(save_dir, "out.wav")
        with open(path, "wb") as fh:
            fh.write(base64.b64decode(wav_b64(1.0, rate=48000, channels=2)))
        return types.SimpleNamespace(success=True, error=None, audios=[{"path": path, "sample_rate": 48000}])

    inference.GenerationParams, inference.GenerationConfig, inference.generate_music = GenerationParams, GenerationConfig, generate_music
    pkg.handler, pkg.inference = handler, inference
    return {"acestep": pkg, "acestep.handler": handler, "acestep.inference": inference}


class AceBase(Base):
    def setUp(self) -> None:
        super().setUp()
        AceRecorder.params, AceRecorder.configs, AceRecorder.steps, AceRecorder.step_hook = [], [], 4, None
        FakeAceHandler.instances, FakeAceHandler.dtype = [], "bfloat16"
        sys.modules.update(fake_acestep_modules())
        self.project = os.path.join(self.tmp, "project")
        self._env = mock.patch.dict(os.environ, {"ACESTEP_PROJECT_ROOT": self.project})
        self._env.start()
        os.environ.pop("ACESTEP_CHECKPOINTS_DIR", None)
        weights = {"model.safetensors": b"w", "config.json": b"{}", "modeling_acestep.py": b"# code"}
        for name in ("acestep-v15-xl-base", "acestep-v15-xl-sft", "acestep-v15-xl-turbo"):
            self.hub.add(f"ACE-Step/{name}", REV, weights)
        self.shared = self.hub.add("ACE-Step/Ace-Step1.5", SHARED_REV, {
            "vae/diffusion_pytorch_model.safetensors": b"v", "vae/config.json": b"{}",
            "Qwen3-Embedding-0.6B/model.safetensors": b"t", "Qwen3-Embedding-0.6B/tokenizer.json": b"{}"})
        self.base = definition("acestep-v15-xl-base", "ACE-Step/acestep-v15-xl-base", "song")
        self.sft = definition("acestep-v15-xl-sft", "ACE-Step/acestep-v15-xl-sft", "song")
        self.turbo = definition("acestep-v15-xl-turbo", "ACE-Step/acestep-v15-xl-turbo", "song")

    def tearDown(self) -> None:
        self._env.stop()
        super().tearDown()


def ctx(n: int = 1, **kw) -> list:  # noqa: ANN003
    return [{"id": f"t{i}", "audioBase64": wav_b64(1.0, rate=48000, **kw)} for i in range(n)]


# ---------------------------------------------------------------------------
# FLEET-P1-009: LEGO auf xl-base
# ---------------------------------------------------------------------------
@unittest.skipUnless(HAS_NUMPY, "numpy fehlt")
class LegoTest(AceBase):
    def lego(self, defn=None, **payload):  # noqa: ANN001, ANN003, ANN201
        body = {"aceTask": "lego", "track": "bass", "prompt": "deep bass", "contextAudio": ctx(2)}
        body.update(payload)
        d = defn or self.base
        return self.hv.acestep_context_task(d.id, d, body)

    def test_lego_auf_xl_base_mit_shared_vae_und_text_encoder(self) -> None:
        out = self.lego(seed=5)
        params, config = AceRecorder.params[-1], AceRecorder.configs[-1]
        self.assertEqual(params["task_type"], "lego")
        self.assertEqual(params["inference_steps"], 32)
        self.assertFalse(params["thinking"])
        self.assertTrue(params["src_audio"].endswith("context.wav"))
        self.assertEqual(config["batch_size"], 1)
        self.assertEqual(config["seeds"], [5])
        self.assertEqual(config["audio_format"], "wav")
        dit = FakeAceHandler.instances[-1]
        self.assertEqual(dit.init["config_path"], "acestep-v15-xl-base")
        self.assertEqual(dit.init["device"], "cuda")
        ckpt = os.path.join(self.project, "checkpoints")
        for name in ("acestep-v15-xl-base", "vae", "Qwen3-Embedding-0.6B"):
            self.assertTrue(os.path.isdir(os.path.join(ckpt, name)), name)
        # Gewichte als Link in den Cache, Code als Kopie (ACE-Step-Code-Sync schreibt nie in den Cache).
        self.assertTrue(os.path.islink(os.path.join(ckpt, "acestep-v15-xl-base", "model.safetensors")))
        self.assertFalse(os.path.islink(os.path.join(ckpt, "acestep-v15-xl-base", "modeling_acestep.py")))
        shared_call = [c for c in self.hub.calls if c["repo"] == "ACE-Step/Ace-Step1.5"][-1]
        self.assertEqual(shared_call["revision"], SHARED_REV)
        self.assertEqual(shared_call["patterns"], ["vae/*", "Qwen3-Embedding-0.6B/*"])
        self.assertEqual(out["abortPoint"], "none")  # ausserhalb eines Pod-Jobs kein Token
        self.assertEqual(out["contextIds"], [])
        self.assertTrue(base64.b64decode(out["audioBase64"]).startswith(b"RIFF"))

    def test_lego_extract_complete_nur_auf_xl_base(self) -> None:
        for task, extra in (("lego", {}), ("extract", {"contextAudio": ctx(1)}), ("complete", {"tracks": ["drums"]})):
            for defn in (self.sft, self.turbo):
                with self.subTest(task=task, model=defn.id), self.assertRaises(ModelUnavailableError) as c:
                    self.lego(defn, aceTask=task, **extra)
                self.assertIn("acestep-v15-xl-base", str(c.exception))
        self.assertEqual(AceRecorder.params, [])

    def test_repaint_darf_auf_turbo(self) -> None:
        out = self.lego(self.turbo, aceTask="repaint", contextAudio=ctx(1), repaintStart=0, repaintEnd=0.5)
        self.assertEqual(out["taskType"], "repaint")

    def test_kontext_audio_gehaertet(self) -> None:
        nan = io.BytesIO()
        with wave.open(nan, "wb") as w:
            w.setnchannels(1), w.setsampwidth(2), w.setframerate(48000), w.writeframes(b"\x00\x00" * 4800)
        cases = {
            "Kanaele": {"contextAudio": ctx(1, channels=3)},
            "zu kurz": {"contextAudio": [{"audioBase64": base64.b64encode(nan.getvalue()).decode()}]},
            "ungueltiges Base64": {"contextAudio": [{"audioBase64": "@@@@" * 10}]},
            "hoechstens 8": {"contextAudio": ctx(9)},
            "URLs": {"contextAudio": [{"audioBase64": "https://example.org/a.wav" + "x" * 10}]},
            "audioBase64 erforderlich": {"contextAudio": [{"id": "x"}]},
            "mindestens 1": {"contextAudio": []},
            "inferenceSteps": {"inferenceSteps": 500},
        }
        for needle, extra in cases.items():
            with self.subTest(needle), self.assertRaises(ModelUnavailableError) as c:
                self.lego(**extra)
            self.assertIn(needle, str(c.exception))
        self.assertEqual(AceRecorder.params, [])

    def test_nan_im_kontext(self) -> None:
        samples = np.array([[0.1], [np.nan]] * 48000, dtype=np.float32)
        with mock.patch.object(self.sf, "read", return_value=(samples, 48000)), self.assertRaises(ModelUnavailableError) as c:
            self.lego()
        self.assertIn("NaN", str(c.exception))

    def test_vae_fehlt_klare_meldung_kein_download(self) -> None:
        shutil.rmtree(os.path.join(self.shared, "vae"))
        with self.assertRaises(ModelUnavailableError) as c:
            self.lego()
        self.assertIn("vae/ fehlt", str(c.exception))

    def test_nicht_bf16_auf_cuda(self) -> None:
        FakeAceHandler.dtype = "float16"
        with self.assertRaises(ModelUnavailableError) as c:
            self.lego()
        self.assertIn("statt bf16", str(c.exception))

    def test_abbruch_im_diffusionsschritt(self) -> None:
        token = pod_jobs.CancelToken()
        AceRecorder.step_hook = lambda step: token.cancel("tts") if step == 2 else None
        with pod_jobs.bind_cancel_token(token), self.assertRaises(pod_jobs.JobCancelled) as c:
            self.lego()
        self.assertIn("3 Schritten", str(c.exception))  # Hook vor Schritt 3 hat abgebrochen
        self.assertEqual(FakeAceHandler.instances[-1].model.decoder.hooks, [], "Hook muss entfernt sein")

    def test_abbruch_vor_dem_start_laedt_nichts(self) -> None:
        token = pod_jobs.CancelToken()
        token.cancel("tts")
        with pod_jobs.bind_cancel_token(token), self.assertRaises(pod_jobs.JobCancelled):
            self.lego()
        self.assertEqual(FakeAceHandler.instances, [])

    def test_pod_jobstore_tts_vorrang_ende_zu_ende(self) -> None:
        """LEGO laeuft (1 Worker), TTS kommt, Server schickt /cancel -> LEGO steigt am
        naechsten Schritt aus, die TTS laeuft sofort danach."""
        started, release = threading.Event(), threading.Event()
        AceRecorder.steps = 50

        def slow(step):  # noqa: ANN001, ANN202
            started.set()
            release.wait(0.02)

        AceRecorder.step_hook = slow
        order = []

        def runner(job):  # noqa: ANN001, ANN202
            if job["task"] == "song":
                try:
                    self.lego()
                finally:
                    order.append("lego-end")
                return {"status": "success"}
            order.append("tts")
            return {"status": "success", "task": "tts"}

        store = pod_jobs.JobStore(runner, workers=1)
        try:
            lego = store.submit({"task": "song"})
            self.assertTrue(started.wait(5))
            tts = store.submit({"task": "tts"})
            self.assertEqual(store.cancel(lego["id"])["cancelRequested"], True)
            deadline = time.time() + 5
            while (store.get(tts["id"]) or {}).get("status") != "COMPLETED" and time.time() < deadline:
                time.sleep(0.01)
            self.assertEqual(store.get(lego["id"])["status"], "CANCELLED")
            self.assertEqual(store.get(lego["id"])["output"]["code"], "CANCELLED")
            self.assertEqual(store.get(tts["id"])["status"], "COMPLETED")
            self.assertEqual(order, ["lego-end", "tts"])
            self.assertLess(len([p for p in AceRecorder.params]), 2)
        finally:
            release.set()
            store.shutdown()

    def test_alter_einstieg_handlers_runpod_delegiert(self) -> None:
        import handlers_runpod

        out = handlers_runpod.acestep_context_task("acestep-v15-xl-base", self.base,
                                                   {"aceTask": "extract", "track": "vocals", "contextAudio": ctx(1)})
        self.assertEqual(out["taskType"], "extract")


# ---------------------------------------------------------------------------
# FLEET-P1-010: sing ueber ACE-Step-Lyrics
# ---------------------------------------------------------------------------
@unittest.skipUnless(HAS_NUMPY, "numpy fehlt")
class SingTest(AceBase):
    def test_sing_auf_xl_sft_mit_lyrics(self) -> None:
        out = self.hv.acestep_sing("acestep-v15-xl-sft", self.sft, {"text": "♪ La la Liebe ♪", "language": "de-DE", "bpm": 120})
        params = AceRecorder.params[-1]
        self.assertEqual(params["task_type"], "text2music")
        self.assertEqual(params["lyrics"], "La la Liebe")
        self.assertFalse(params["instrumental"])
        self.assertEqual(params["vocal_language"], "de")
        self.assertEqual(params["bpm"], 120)
        self.assertEqual(params["duration"], 30.0)
        self.assertNotIn("src_audio", params)
        self.assertEqual(FakeAceHandler.instances[-1].init["config_path"], "acestep-v15-xl-sft")
        self.assertEqual(AceRecorder.configs[-1]["batch_size"], 1)
        self.assertEqual(out["sampleRate"], 48000)

    def test_sing_grenzen(self) -> None:
        for payload, needle in (({"lyrics": "x" * 5000}, "zu lang"), ({"lyrics": "la", "language": "tlh"}, "Sprache"),
                                ({"lyrics": "la", "durationSeconds": 5}, "kleiner"), ({}, "lyrics erforderlich")):
            with self.subTest(payload=payload), self.assertRaises(ModelUnavailableError) as c:
                self.hv.acestep_sing("acestep-v15-xl-sft", self.sft, payload)
            self.assertIn(needle, str(c.exception))

    def test_lm_ist_kein_sing_modell(self) -> None:
        lm = definition("acestep-5hz-lm-4b", "ACE-Step/acestep-5Hz-lm-4B", "song")
        with self.assertRaises(ModelUnavailableError):
            self.hv.acestep_sing("acestep-5hz-lm-4b", lm, {"lyrics": "la"})

    def test_sing_dispatch_bark_bleibt_bis_gpu_beleg(self) -> None:
        import handlers

        bark = definition("bark-small", "suno/bark-small", "sing")
        with mock.patch.object(handlers, "hf_bark_sing", return_value={"ok": "bark"}), \
                mock.patch.object(handlers, "acestep_sing", return_value={"ok": "ace"}):
            self.assertEqual(handlers.run_inference("sing", "bark-small", bark, {"text": "x"}), {"ok": "bark"})
            self.assertEqual(handlers.run_inference("sing", "acestep-v15-xl-sft", self.sft, {"text": "x"}), {"ok": "ace"})


# ---------------------------------------------------------------------------
# vLLM-Deckel (geschaetzt)
# ---------------------------------------------------------------------------
class LmCapTest(unittest.TestCase):
    def setUp(self) -> None:
        import handlers_voice

        self.hv = handlers_voice

    def test_deckel_ist_geschaetzt_und_nur_nach_unten(self) -> None:
        self.assertEqual(self.hv.ACESTEP_LM_GPU_MEMORY_UTILIZATION, 0.33)
        self.assertEqual(self.hv.ACESTEP_LM_GPU_MEMORY_UTILIZATION_STATUS, "geschaetzt")
        with mock.patch.dict(os.environ, {self.hv.LM_GPU_MEMORY_ENV: "0.25"}):
            self.assertEqual(self.hv.lm_gpu_memory_utilization(), 0.25)
        with mock.patch.dict(os.environ, {self.hv.LM_GPU_MEMORY_ENV: "0.9"}), self.assertRaises(ModelUnavailableError):
            self.hv.lm_gpu_memory_utilization()

    def test_adaptive_wahl_von_ace_step_wird_gedeckelt(self) -> None:
        handler = types.SimpleNamespace(get_gpu_memory_utilization=lambda **kw: (0.9, False))
        self.assertEqual(self.hv.cap_lm_gpu_memory(handler), 0.33)
        self.assertEqual(handler.get_gpu_memory_utilization(model_path="x"), (0.33, False))
        with self.assertRaises(ModelUnavailableError):
            self.hv.cap_lm_gpu_memory(object())

    def test_manifest_spiegelt_den_deckel(self) -> None:
        import registry

        lm = {m["id"]: m for m in registry.read_manifest()["models"]}["acestep-5hz-lm-4b"]
        self.assertEqual(lm["vllmGpuMemoryUtilization"], {"max": 0.33, "status": "geschaetzt"})


# ---------------------------------------------------------------------------
# Pod-Jobs: /cancel
# ---------------------------------------------------------------------------
class CancelStoreTest(unittest.TestCase):
    def test_wartender_job_laeuft_nie_an(self) -> None:
        gate, ran = threading.Event(), []

        def runner(job):  # noqa: ANN001, ANN202
            if job == "block":
                gate.wait(5)
            ran.append(job)
            return {"status": "success"}

        store = pod_jobs.JobStore(runner, workers=1)
        try:
            store.submit("block")
            queued = store.submit("never")
            self.assertEqual(store.cancel(queued["id"])["status"], "CANCELLED")
            gate.set()
            time.sleep(0.1)
            self.assertNotIn("never", ran)
            self.assertEqual(store.get(queued["id"])["output"]["code"], "CANCELLED")
            self.assertNotIn("cancel", store.get(queued["id"]))
        finally:
            store.shutdown()

    def test_unbekannt_und_fertig(self) -> None:
        store = pod_jobs.JobStore(lambda job: {"status": "success"}, workers=1)
        try:
            self.assertIsNone(store.cancel("nope"))
            done = store.run_sync("x", wait_s=5)
            self.assertEqual(store.cancel(done["id"]), {"id": done["id"], "status": "COMPLETED", "cancelled": False})
        finally:
            store.shutdown()

    def test_handler_ohne_abbruchpunkt_ergebnis_wird_verworfen(self) -> None:
        gate = threading.Event()

        def runner(job):  # noqa: ANN001, ANN202
            gate.wait(5)
            return {"status": "success", "result": "spaet"}

        store = pod_jobs.JobStore(runner, workers=1)
        try:
            job = store.submit("x")
            time.sleep(0.05)
            store.cancel(job["id"])
            gate.set()
            deadline = time.time() + 5
            while store.get(job["id"])["status"] != "CANCELLED" and time.time() < deadline:
                time.sleep(0.01)
            self.assertEqual(store.get(job["id"])["output"]["code"], "CANCELLED")
        finally:
            store.shutdown()

    def test_run_job_meldet_cancelled(self) -> None:
        class M:
            def is_loaded(self, _m):  # noqa: ANN001, ANN202
                return True

            def infer(self, *_a):  # noqa: ANN002, ANN202
                raise pod_jobs.JobCancelled("x")

        out = pod_jobs.run_job(M(), {"task": "song", "model": "m", "input": {}}, resident_only=True)
        self.assertEqual(out["code"], "CANCELLED")


# ---------------------------------------------------------------------------
# Manifest: neue Handler in der Rolle, bark-small bleibt
# ---------------------------------------------------------------------------
class ManifestTest(unittest.TestCase):
    def setUp(self) -> None:
        import registry

        self.data = registry.read_manifest()
        self.by_id = {m["id"]: m for m in self.data["models"]}

    def test_neue_rp4_modelle_haben_handler_und_stehen_in_voicegen(self) -> None:
        voice = self.data["roles"]["voiceGen"]
        for mid in ("qwen3-tts-06b-base", "moss-soundeffect-v2.0"):
            self.assertNotEqual(self.by_id[mid].get("status"), "neu", mid)
            self.assertIn(mid, voice["models"])
            self.assertNotIn(mid, voice["preloadModels"], f"{mid}: erst nach GPU-Beleg vorladen")
        self.assertEqual(self.by_id["moss-soundeffect-v2.0"]["revision"], "e35df4d82fbe87fcd5d14e5d100e349c0c3c076d")

    def test_stable_audio_und_bark_bleiben_bis_gpu_beleg(self) -> None:
        self.assertIn("stable-audio-open-1.0", self.data["roles"]["voiceGen"]["models"])
        self.assertIn("bark-small", self.data["roles"]["music"]["models"])
        self.assertIn("acestep-v15-xl-sft", self.data["roles"]["music"]["models"])

    def test_shared_ist_kein_ladbares_modell(self) -> None:
        self.assertEqual(self.by_id["acestep-v15-shared"]["status"], "neu")


if __name__ == "__main__":
    unittest.main(verbosity=2)
