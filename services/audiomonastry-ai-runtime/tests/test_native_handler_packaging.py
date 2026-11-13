"""Native Vast overlays must ship the audio/LLM module and its consumers together."""
from pathlib import Path
import shlex
import unittest

ROOT = Path(__file__).resolve().parents[1]


class NativeHandlerPackagingTests(unittest.TestCase):
    def test_vast_overlay_copies_native_module_and_all_consumers(self):
        # BASE_IMAGE is immutable; changed Python consumers must not be inherited
        # from an older layer that still imports the deleted provider module.
        sources = set()
        for line in (ROOT / "Dockerfile.vast").read_text().splitlines():
            tokens = shlex.split(line)
            if tokens and tokens[0] == "COPY":
                sources.update(tokens[1:-1])
        required = {"handlers_native.py", "handlers.py", "handlers_voice.py",
                    "handlers_stems.py", "handlers_ears.py", "handlers_fleet2026.py",
                    "moa_orchestrator.py"}
        self.assertTrue(required <= sources, f"missing overlay sources: {required - sources}")
        for name in required:
            self.assertTrue((ROOT / name).is_file(), name)
            self.assertNotIn("handlers_runpod", (ROOT / name).read_text(), name)


if __name__ == "__main__":
    unittest.main()
