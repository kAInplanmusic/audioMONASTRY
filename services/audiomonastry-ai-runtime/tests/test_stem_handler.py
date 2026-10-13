"""FLEET-P1-006: RP5-Stem-Handler (handlers_stems) – ohne GPU, ohne torch, ohne Netz.

Was hier belegt ist (Mock-/Unit-Tests):
- Repository UND Revision des Manifest-Eintrags gehen unveraendert an
  hf_hub_download; die Dateien werden gegen die dokumentierten SHA-256 geprueft.
- Ohne Pin (SCNet, Karaoke, Dereverb) bricht der Handler mit klarer Meldung ab,
  ohne etwas zu laden und ohne auf ein anderes Modell auszuweichen.
- Durchlauf Audio -> Chunk-Inferenz (gefaelschtes 6-Stem-Modell) -> 5 Stems,
  Summe = Mix; 4-Stem-Fallback mit leerer Melodie und Hinweis.
- Routing/Manifest: stem.separate zeigt auf bs-roformer-sw-6stem, htdemucs-6s
  bleibt Alias.

Was hier NICHT belegt ist: Laden des echten Checkpoints in die MSST-Klasse,
bf16-Qualitaet, Realtime-Faktor, VRAM (braucht einen GPU-Lauf auf dem stems-Pod).

    python3 services/audiomonastry-ai-runtime/tests/test_stem_handler.py
"""
from __future__ import annotations

import base64
import dataclasses
import hashlib
import os
import pathlib
import sys
import tempfile
import types
import unittest

import numpy as np

RUNTIME_DIR = pathlib.Path(__file__).resolve().parent.parent
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

import handlers_runpod  # noqa: E402
import handlers_stems as hs  # noqa: E402
import moa_orchestrator  # noqa: E402
import registry  # noqa: E402
from model_manager import ModelDefinition, ModelUnavailableError  # noqa: E402

try:
    import yaml  # noqa: F401

    HAVE_YAML = True
except Exception:  # noqa: BLE001
    HAVE_YAML = False

SR = 44100
SIX = ("bass", "drums", "other", "vocals", "guitar", "piano")
FOUR = ("bass", "drums", "vocals", "other")


def _config_yaml(instruments, chunk=4096, overlap=2, sample_rate=SR) -> str:
    return (
        "audio:\n"
        f"  chunk_size: {chunk}\n"
        f"  sample_rate: {sample_rate}\n"
        "model:\n"
        "  dim: 8\n"
        "  freqs_per_bands: !!python/tuple\n"
        "    - 2\n"
        "    - 4\n"
        "training:\n"
        f"  instruments: [{', '.join(repr(i) for i in instruments)}]\n"
        "inference:\n"
        f"  num_overlap: {overlap}\n"
    )


def _definition(model_id: str, **overrides) -> ModelDefinition:
    entry = next(m for m in registry.read_manifest()["models"] if m["id"] == model_id)
    return ModelDefinition.from_dict(dict(entry, **overrides))


class FakeHub:
    """Ersatz fuer huggingface_hub: schreibt Dateien und protokolliert die Aufrufe."""

    def __init__(self, tmp: str, contents: dict):
        self.tmp = tmp
        self.contents = contents
        self.calls = []

    def hf_hub_download(self, repo_id, filename, revision):
        self.calls.append((repo_id, filename, revision))
        path = os.path.join(self.tmp, revision, filename)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(self.contents.get(filename, b"dummy"))
        return path


class _Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = self._tmp.name
        self._saved_hub = sys.modules.get("huggingface_hub")
        self._saved_specs = dict(hs.STEM_MODEL_SPECS)
        self._saved = {name: getattr(hs, name) for name in ("build_chunk_fn", "decode_audio", "encode_wav", "wav_bytes", "put_object")}
        hs._SEPARATORS.clear()
        hs._VERIFIED.clear()

    def tearDown(self):
        if self._saved_hub is None:
            sys.modules.pop("huggingface_hub", None)
        else:
            sys.modules["huggingface_hub"] = self._saved_hub
        hs.STEM_MODEL_SPECS.clear()
        hs.STEM_MODEL_SPECS.update(self._saved_specs)
        for name, value in self._saved.items():
            setattr(hs, name, value)
        hs._SEPARATORS.clear()
        hs._VERIFIED.clear()
        self._tmp.cleanup()

    def install_hub(self, contents: dict) -> FakeHub:
        hub = FakeHub(self.tmp, contents)
        module = types.ModuleType("huggingface_hub")
        module.hf_hub_download = hub.hf_hub_download
        sys.modules["huggingface_hub"] = module
        return hub

    def pin_spec_to(self, model_id: str, contents: dict) -> None:
        """Test-Hashes fuer Test-Dateien (die echten Hashes bleiben unangetastet im Modul)."""
        spec = hs.STEM_MODEL_SPECS[model_id]
        hs.STEM_MODEL_SPECS[model_id] = dataclasses.replace(
            spec,
            checkpoint_sha256=hashlib.sha256(contents[spec.checkpoint]).hexdigest(),
            config_sha256=hashlib.sha256(contents[spec.config]).hexdigest(),
        )


class GewichteTest(_Base):
    def test_repo_und_revision_aus_dem_manifest_werden_genutzt(self):
        definition = _definition("bs-roformer-sw-6stem")
        hub = self.install_hub({})
        # Dummy-Dateien haben nicht den echten Hash -> Abbruch NACH dem Download.
        with self.assertRaises(ModelUnavailableError) as ctx:
            hs.resolve_weights("bs-roformer-sw-6stem", definition)
        self.assertIn("SHA-256", str(ctx.exception))
        self.assertEqual(
            hub.calls[0],
            ("FractalSurfer/BS-RoFormer-SW-6stem", "BS-Rofo-SW-Fixed.ckpt", "2b98254b19bdab07ce225d884ec4aa9dd8aafce1"),
        )
        self.assertEqual(hub.calls[0][0], definition.repository)
        self.assertEqual(hub.calls[0][2], definition.revision)

    def test_andere_revision_im_manifest_wird_durchgereicht(self):
        rev = "0123456789abcdef0123456789abcdef01234567"
        definition = _definition("bs-roformer-sw-6stem", repository="mirror-org/bs-rofo", revision=rev)
        contents = {"BS-Rofo-SW-Fixed.ckpt": b"ckpt", "BS-Rofo-SW-Fixed.yaml": b"cfg"}
        hub = self.install_hub(contents)
        self.pin_spec_to("bs-roformer-sw-6stem", contents)
        ckpt, cfg = hs.resolve_weights("bs-roformer-sw-6stem", definition)
        self.assertEqual(
            hub.calls,
            [("mirror-org/bs-rofo", "BS-Rofo-SW-Fixed.ckpt", rev), ("mirror-org/bs-rofo", "BS-Rofo-SW-Fixed.yaml", rev)],
        )
        self.assertTrue(ckpt.endswith("BS-Rofo-SW-Fixed.ckpt") and cfg.endswith("BS-Rofo-SW-Fixed.yaml"))

    def test_hash_falsch_bricht_ab(self):
        contents = {"BS-Rofo-SW-Fixed.ckpt": b"ckpt", "BS-Rofo-SW-Fixed.yaml": b"cfg"}
        self.pin_spec_to("bs-roformer-sw-6stem", contents)
        self.install_hub(dict(contents, **{"BS-Rofo-SW-Fixed.ckpt": b"manipuliert"}))
        with self.assertRaises(ModelUnavailableError):
            hs.resolve_weights("bs-roformer-sw-6stem", _definition("bs-roformer-sw-6stem"))

    def test_echte_hashes_stimmen_mit_dem_manifest_ueberein(self):
        spec = hs.STEM_MODEL_SPECS["bs-roformer-sw-6stem"]
        entry = next(m for m in registry.read_manifest()["models"] if m["id"] == "bs-roformer-sw-6stem")
        self.assertIn(spec.checkpoint_sha256, entry["note"])
        self.assertRegex(spec.checkpoint_sha256, r"^[0-9a-f]{64}$")
        self.assertRegex(spec.config_sha256, r"^[0-9a-f]{64}$")
        self.assertIn(spec.checkpoint, entry["note"])

    def test_ohne_pin_kein_download_und_klare_meldung(self):
        hub = self.install_hub({})
        with self.assertRaises(ModelUnavailableError) as ctx:
            hs.resolve_weights("scnet-xl-ihf", _definition("scnet-xl-ihf"))
        self.assertIn("nicht gepinnt", str(ctx.exception))
        for model_id in ("mel-roformer-karaoke", "mel-roformer-dereverb"):
            with self.assertRaises(ModelUnavailableError) as ctx:
                hs.resolve_weights(model_id, _definition(model_id))
            self.assertIn("SHA-256-Pin fehlt", str(ctx.exception))
        self.assertEqual(hub.calls, [])

    def test_msst_fehlt_klare_meldung_mit_pin(self):
        old = os.environ.get(hs.MSST_ROOT_ENV)
        os.environ[hs.MSST_ROOT_ENV] = self.tmp  # kein models/ darin
        try:
            with self.assertRaises(ModelUnavailableError) as ctx:
                hs._import_msst_class(hs.STEM_MODEL_SPECS["bs-roformer-sw-6stem"])
        finally:
            if old is None:
                os.environ.pop(hs.MSST_ROOT_ENV, None)
            else:
                os.environ[hs.MSST_ROOT_ENV] = old
        self.assertIn(hs.MSST_PIN["commit"], str(ctx.exception))
        self.assertIn("kein Rueckfall", str(ctx.exception))


@unittest.skipUnless(HAVE_YAML, "pyyaml fehlt")
class ConfigTest(_Base):
    def test_python_tuple_wird_sicher_gelesen(self):
        path = os.path.join(self.tmp, "c.yaml")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(_config_yaml(SIX, chunk=588800))
        cfg = hs.load_stem_config(path)
        self.assertEqual(cfg["model"]["freqs_per_bands"], (2, 4))
        self.assertEqual(hs.config_instruments(cfg), SIX)
        self.assertEqual(hs.config_chunking(cfg), (588800, 2))
        self.assertEqual(hs.config_sample_rate(cfg), SR)

    def test_unsichere_tags_werden_abgelehnt(self):
        path = os.path.join(self.tmp, "evil.yaml")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("model: !!python/object/apply:os.system ['echo boom']\n")
        with self.assertRaises(Exception):
            hs.load_stem_config(path)


@unittest.skipUnless(HAVE_YAML, "pyyaml fehlt")
class HandlerDurchlaufTest(_Base):
    """Handler-Pfad mit gefaelschtem Modell (Anteile des Eingangs je Stem)."""

    FRACTIONS = {"bass": 0.1, "drums": 0.2, "other": 0.1, "vocals": 0.3, "guitar": 0.2, "piano": 0.1}

    def _prepare(self, model_id, instruments, fractions, definition=None, mix=None):
        spec = hs.STEM_MODEL_SPECS[model_id]
        contents = {spec.checkpoint: b"ckpt-" + model_id.encode(), spec.config: _config_yaml(instruments).encode()}
        hub = self.install_hub(contents)
        self.pin_spec_to(model_id, contents)
        built = []

        def fake_build(mid, definition_, spec_, config, checkpoint_path):
            built.append((mid, definition_.repository, definition_.revision, checkpoint_path))

            def run(chunk):
                return np.stack([fractions[name] * chunk for name in instruments])

            return run

        rng = np.random.default_rng(42)
        self.mix = mix if mix is not None else rng.normal(0, 0.2, (2, SR + 123)).astype(np.float32)
        hs.build_chunk_fn = fake_build
        hs.decode_audio = lambda raw: (self.mix, SR)
        hs.encode_wav = lambda samples, sr, subtype="FLOAT": np.asarray(samples, dtype=np.float64)
        return hub, built

    def test_fuenf_stems_summe_gleich_mix(self):
        hub, built = self._prepare("bs-roformer-sw-6stem", SIX, self.FRACTIONS)
        definition = _definition("bs-roformer-sw-6stem")
        payload = {"audio": base64.b64encode(b"x").decode()}
        result = handlers_runpod.stem_separate_dispatch("bs-roformer-sw-6stem", definition, payload)
        self.assertEqual(list(result["stems"]), ["vocals", "lows", "mids", "highs", "melody"])
        self.assertEqual(result["stemSet"], ["vocals", "lows", "mids", "highs", "melody"])
        total = sum(result["stems"].values())
        err = float(np.max(np.abs(total - self.mix)))
        self.assertLess(err, 1e-4, f"Rekonstruktionsfehler {err:.2e}")
        self.assertLessEqual(float(np.max(np.abs(np.asarray(result["stems"]["vocals"]) - 0.3 * self.mix))), 1e-5)
        self.assertLessEqual(float(np.max(np.abs(np.asarray(result["stems"]["melody"]) - 0.3 * self.mix))), 1e-5)
        self.assertTrue(result["melodyAvailable"])
        self.assertEqual(result["notes"], [])
        self.assertEqual(result["modelStems"], list(SIX))
        self.assertEqual((result["repository"], result["revision"]), (definition.repository, definition.revision))
        self.assertEqual(built[0][:3], ("bs-roformer-sw-6stem", definition.repository, definition.revision))
        self.assertEqual({c[2] for c in hub.calls}, {definition.revision})
        self.assertEqual(result["crossover"]["lowHz"], 150.0)
        self.assertEqual(result["crossover"]["midHighHz"], 2500.0)
        self.assertNotIn("extras", result)

        # Zweiter Aufruf: Modell aus dem Cache, kein zweiter Download/Build.
        handlers_runpod.stem_separate_dispatch("bs-roformer-sw-6stem", definition, payload)
        self.assertEqual(len(built), 1)
        self.assertEqual(len(hub.calls), 2)

    def test_scnet_fallback_vier_stems_melodie_leer_mit_hinweis(self):
        fractions = {"bass": 0.25, "drums": 0.25, "vocals": 0.25, "other": 0.25}
        self._prepare("scnet-xl-ihf", FOUR, fractions)
        # Manifest hat PIN-ERFORDERLICH; fuer den Schnittstellen-Test eine gepinnte Kopie.
        definition = _definition("scnet-xl-ihf", repository="mirror-org/scnet-xl-ihf", revision="a" * 40)
        result = hs.msst_stem_separate("scnet-xl-ihf", definition, {"audio": base64.b64encode(b"x").decode()})
        self.assertFalse(result["melodyAvailable"])
        self.assertEqual(float(np.max(np.abs(result["stems"]["melody"]))), 0.0)
        self.assertTrue(any("Melodie" in n for n in result["notes"]))
        self.assertLess(float(np.max(np.abs(sum(result["stems"].values()) - self.mix))), 1e-4)

    def test_scnet_aus_dem_manifest_bricht_ohne_pin_ab(self):
        with self.assertRaises(ModelUnavailableError):
            handlers_runpod.stem_separate_dispatch(
                "scnet-xl-ihf", _definition("scnet-xl-ihf"), {"audio": base64.b64encode(b"x").decode()}
            )

    def test_karaoke_nur_auf_wunsch_und_abbruch_vor_der_trennung(self):
        _hub, built = self._prepare("bs-roformer-sw-6stem", SIX, self.FRACTIONS)
        definition = _definition("bs-roformer-sw-6stem")
        audio = base64.b64encode(b"x").decode()
        result = hs.msst_stem_separate("bs-roformer-sw-6stem", definition, {"audio": audio, "karaoke": False})
        self.assertNotIn("extras", result)
        hs._SEPARATORS.clear()
        built.clear()
        for flag in ("karaoke", "dereverb"):
            with self.assertRaises(ModelUnavailableError) as ctx:
                hs.msst_stem_separate("bs-roformer-sw-6stem", definition, {"audio": audio, flag: True})
            self.assertIn("SHA-256-Pin fehlt", str(ctx.exception))
        self.assertEqual(built, [], "Hauptmodell darf bei fehlendem Zusatz-Pin nicht geladen werden")

    def test_auf_wunsch_modell_ist_kein_trennmodell(self):
        with self.assertRaises(ModelUnavailableError):
            hs.msst_stem_separate("mel-roformer-karaoke", _definition("mel-roformer-karaoke"), {"audio": "eA=="})

    def test_parameter_werden_geprueft(self):
        self._prepare("bs-roformer-sw-6stem", SIX, self.FRACTIONS)
        definition = _definition("bs-roformer-sw-6stem")
        audio = base64.b64encode(b"x").decode()
        for bad in ({"lowHz": 5}, {"midHighHz": 20000}, {"lowHz": "abc"}, {"sampleFormat": "pcm16"}):
            with self.assertRaises(ModelUnavailableError, msg=str(bad)):
                hs.msst_stem_separate("bs-roformer-sw-6stem", definition, dict(bad, audio=audio))
        res = hs.msst_stem_separate("bs-roformer-sw-6stem", definition, {"audio": audio, "lowHz": 120, "midHighHz": 3000})
        self.assertEqual((res["crossover"]["lowHz"], res["crossover"]["midHighHz"]), (120.0, 3000.0))

    def test_modell_stems_nur_auf_wunsch(self):
        self._prepare("bs-roformer-sw-6stem", SIX, self.FRACTIONS)
        definition = _definition("bs-roformer-sw-6stem")
        res = hs.msst_stem_separate(
            "bs-roformer-sw-6stem", definition, {"audio": base64.b64encode(b"x").decode(), "includeModelStems": True}
        )
        self.assertEqual(list(res["modelStemAudio"]), list(SIX))

    def test_warp_auf_projekt_bpm_mit_einem_plan(self):
        self._prepare("bs-roformer-sw-6stem", SIX, self.FRACTIONS)
        definition = _definition("bs-roformer-sw-6stem")
        audio = base64.b64encode(b"x").decode()
        res = hs.msst_stem_separate(
            "bs-roformer-sw-6stem", definition,
            {"audio": audio, "warp": {"targetBpm": 128, "sourceBpm": 120}},
        )
        n = self.mix.shape[-1]
        self.assertTrue(res["warp"]["applied"])
        self.assertAlmostEqual(res["warp"]["stretch"], 120 / 128, places=6)
        for key in res["stemSet"]:
            self.assertEqual(np.asarray(res["stems"][key]).shape, (2, int(round(n * 120 / 128))))
        # Gemeinsamer Plan: Summe der gewarpten Stems = gewarpter Mix.
        import stem_warp
        plan = stem_warp.wsola_plan(self.mix.astype(np.float64).mean(axis=0), 120 / 128)
        warped_mix = stem_warp.wsola_apply(self.mix, plan, 120 / 128)
        total = sum(np.asarray(v, dtype=np.float64) for v in res["stems"].values())
        self.assertLess(float(np.max(np.abs(total - warped_mix))), 1e-4)

    def test_warp_fehler_klare_meldung(self):
        self._prepare("bs-roformer-sw-6stem", SIX, self.FRACTIONS)
        definition = _definition("bs-roformer-sw-6stem")
        audio = base64.b64encode(b"x").decode()
        for bad in ({"targetBpm": "schnell"}, {"targetKey": "Q"}, "128"):
            with self.assertRaises(ModelUnavailableError, msg=str(bad)):
                hs.msst_stem_separate("bs-roformer-sw-6stem", definition, {"audio": audio, "warp": bad})

    def test_ablage_per_presigned_put_statt_base64(self):
        self._prepare("bs-roformer-sw-6stem", SIX, self.FRACTIONS)
        definition = _definition("bs-roformer-sw-6stem")
        puts = []
        hs.wav_bytes = lambda samples, sr, subtype="FLOAT": b"RIFF" + bytes(8)
        hs.put_object = lambda url, data, content_type="audio/wav": puts.append((url, len(data), content_type))
        urls = {k: f"https://r2.example/stems/{k}.wav?sig=1" for k in hs.FIVE_STEM_KEYS}
        res = hs.msst_stem_separate(
            "bs-roformer-sw-6stem", definition, {"audio": base64.b64encode(b"x").decode(), "outputUrls": urls}
        )
        self.assertNotIn("stems", res)
        self.assertEqual(res["stemsUploaded"], list(hs.FIVE_STEM_KEYS))
        self.assertEqual([p[0] for p in puts], [urls[k] for k in hs.FIVE_STEM_KEYS])
        self.assertTrue(all(p[2] == "audio/wav" for p in puts))

    def test_ablage_nur_https_und_vollstaendig(self):
        self._prepare("bs-roformer-sw-6stem", SIX, self.FRACTIONS)
        definition = _definition("bs-roformer-sw-6stem")
        audio = base64.b64encode(b"x").decode()
        ok = {k: f"https://r2.example/{k}" for k in hs.FIVE_STEM_KEYS}
        for bad in (dict(ok, vocals="http://169.254.169.254/x"), dict(ok, vocals="file:///etc/passwd"),
                    {"vocals": ok["vocals"]}, dict(ok, drums="https://x"), "https://x"):
            with self.assertRaises(ModelUnavailableError, msg=str(bad)):
                hs.msst_stem_separate("bs-roformer-sw-6stem", definition, {"audio": audio, "outputUrls": bad})


class DispatchUndRoutingTest(unittest.TestCase):
    def test_htdemucs_bleibt_alias(self):
        saved = handlers_runpod.demucs_stem
        handlers_runpod.demucs_stem = lambda mid, d, p: {"demucs": mid}
        try:
            out = handlers_runpod.stem_separate_dispatch("htdemucs-6s", _definition("htdemucs-6s"), {})
        finally:
            handlers_runpod.demucs_stem = saved
        self.assertEqual(out, {"demucs": "htdemucs-6s"})

    def test_unbekanntes_modell_faellt_nicht_auf_demucs_zurueck(self):
        definition = ModelDefinition.from_dict({"id": "x-stem", "repository": "org/x", "revision": "a" * 40, "task": "stem.separate"})
        with self.assertRaises(ModelUnavailableError):
            handlers_runpod.stem_separate_dispatch("x-stem", definition, {})

    def test_stem_separate_zeigt_auf_das_rp5_hauptmodell(self):
        tool = moa_orchestrator.TOOL_CATALOG["voice.stem_separate"]
        self.assertEqual(tool["model"], "bs-roformer-sw-6stem")
        data = registry.read_manifest()
        self.assertIn(tool["model"], data["roles"][tool["role"]]["models"])
        self.assertIn("htdemucs-6s", data["roles"]["voiceGen"]["models"])  # Alias bis GPU-Beleg
        entry = next(m for m in data["models"] if m["id"] == "bs-roformer-sw-6stem")
        self.assertNotIn("status", entry)
        self.assertEqual(entry["quantization"], "bf16")
        self.assertEqual(entry["task"], "stem.separate")
        mcp_ts = (RUNTIME_DIR.parent.parent / "src" / "core" / "ai" / "orchestrator" / "mcpRuntime.ts").read_text(encoding="utf-8")
        self.assertIn("p.model ?? 'bs-roformer-sw-6stem'", mcp_ts)

    def test_alle_stem_specs_stehen_im_manifest(self):
        ids = {m["id"]: m for m in registry.read_manifest()["models"]}
        for model_id in hs.STEM_MODEL_SPECS:
            self.assertIn(model_id, ids)
            self.assertEqual(ids[model_id]["task"], "stem.separate")
        for model_id in ("scnet-xl-ihf", "mel-roformer-karaoke", "mel-roformer-dereverb"):
            self.assertEqual(ids[model_id].get("status"), "neu", model_id)

    def test_dockerfiles_kopieren_die_neuen_module(self):
        for name in ("Dockerfile", "Dockerfile.runpod"):
            text = (RUNTIME_DIR / name).read_text(encoding="utf-8")
            for module in ("handlers_stems.py", "stem_crossover.py", "stem_warp.py"):
                self.assertIn(module, text, f"{name}: {module}")


if __name__ == "__main__":
    unittest.main()
