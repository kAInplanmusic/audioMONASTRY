"""Messlauf 2026-11-18: brain (vLLM-Download -> TypeError) und voice (from_pretrained(repo) -> OfflineModeIsEnabled).
Beide Lader bekommen jetzt einen lokalen Snapshot-Pfad statt Repo-ID, dazu die ears-Abhaengigkeiten fuer SongFormer."""
import importlib
import importlib.util
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / 'services/audiomonastry-ai-runtime'
sys.path.insert(0, str(RUNTIME))


def load(name):
    try:
        return importlib.import_module(name)
    except Exception as exc:  # noqa: BLE001  (Laufzeit-Abhaengigkeiten fehlen in schlanken Umgebungen)
        raise unittest.SkipTest('%s nicht importierbar: %s' % (name, exc))


class BrainLoaderTests(unittest.TestCase):
    def test_vllm_gets_the_local_snapshot_path_not_the_repo_id(self):
        fleet = load('handlers_fleet2026')
        voice = load('handlers_voice')
        seen = {}

        class FakeLLM:
            def __init__(self, **kwargs):
                seen.update(kwargs)

            def get_tokenizer(self):
                return SimpleNamespace(apply_chat_template=lambda *a, **k: 'chat')

            def generate(self, prompts, options):
                return [SimpleNamespace(outputs=[SimpleNamespace(text='ok')])]

        fake_vllm = SimpleNamespace(LLM=FakeLLM, SamplingParams=lambda **k: k)
        definition = SimpleNamespace(repository='Qwen/Qwen3.5-27B-FP8', revision='a' * 40)
        with patch.object(fleet, '_require', return_value=fake_vllm), \
                patch.object(fleet, '_cached', side_effect=lambda key, factory: factory()), \
                patch.object(voice, 'snapshot', return_value='/data/hf-cache/snapshots/abc') as snap:
            result = fleet.brain_infer('qwen38-27b-fp8', definition, {'prompt': 'hallo'})
        self.assertEqual('ok', result['text'])
        self.assertEqual('/data/hf-cache/snapshots/abc', seen['model'])
        self.assertNotIn('revision', seen)                               # lokaler Pfad: kein Hub-Zugriff durch vLLM
        snap.assert_called_once_with('qwen38-27b-fp8', 'Qwen/Qwen3.5-27B-FP8', 'a' * 40)


class QwenTtsLoaderTests(unittest.TestCase):
    def test_every_qwen3_tts_loader_passes_a_local_snapshot_path_and_no_revision(self):
        import re
        total = 0
        for name in ('handlers.py', 'handlers_voice.py', 'handlers_fleet2026.py'):
            text = (RUNTIME / name).read_text()
            for match in re.finditer(r'Qwen3TTSModel\.from_pretrained\(', text):
                total += 1
                call = text[match.end():match.end() + 260]
                self.assertRegex(call.lstrip(), r'^(_local_snapshot|snapshot)\(', name)       # erstes Argument: lokaler Pfad
                self.assertNotIn('revision=', call.split(')', 2)[0] + ')', name)
        self.assertEqual(3, total)                                                      # alle drei Ladestellen erfasst


class EarsLockTests(unittest.TestCase):
    NEEDED = ('ema-pytorch', 'loguru', 'x-transformers', 'muq', 'einx', 'nnAudio', 'easydict', 'x-clip')

    def test_songformer_imports_are_pinned_in_the_ears_lock(self):
        lock = (RUNTIME / 'requirements-ears-ai.lock').read_text().lower()
        for pkg in self.NEEDED:
            self.assertRegex(lock, r'(?m)^%s==[0-9]' % pkg.lower(), pkg)

    def test_the_install_keeps_torch_and_transformers_fixed_and_the_build_checks_the_imports(self):
        text = (RUNTIME / 'Dockerfile.vast').read_text()
        self.assertIn('-c requirements-torch28.constraints -r requirements-ears-ai.lock', text)
        self.assertIn('ema_pytorch, loguru, x_transformers, muq', text)          # Build bricht ab statt erst der Pod


class SongImageTests(unittest.TestCase):
    def test_song_stage_does_not_need_the_visual_directory(self):
        # vast_app importiert visual_renderer nur noch optional (siehe test_runtime_diagnostics); die song-Stufe kopiert `visual/` nicht.
        text = (RUNTIME / 'vast_app.py').read_text()
        self.assertIn('except (FileNotFoundError, ImportError):', text)


if __name__ == '__main__':
    unittest.main()
