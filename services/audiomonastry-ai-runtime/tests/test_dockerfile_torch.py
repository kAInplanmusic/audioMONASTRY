"""RT-AUDIT-P2-019: beide AI-Runtime-Images nutzen dieselbe torch-Basis >= 2.6.

Mit torch 2.5.1 verweigert ``torch.load`` Pickle-Checkpoints (z. B.
laion/larger_clap_music, nur pytorch_model.bin). Das Runpod-Image war bereits
auf 2.6, das generische Image (Hetzner/eigener GPU-Host) nicht – dort scheiterte
jedes ``task=embed``. Dieser Test verhindert, dass die Versionen wieder
auseinanderlaufen.
"""

import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
FROM_RE = re.compile(r"^FROM\s+pytorch/pytorch:(\d+)\.(\d+)\.(\d+)-", re.MULTILINE)


def torch_version(dockerfile: str) -> tuple:
    text = (ROOT / dockerfile).read_text(encoding="utf-8")
    match = FROM_RE.search(text)
    if not match:
        raise AssertionError(f"{dockerfile}: keine pytorch/pytorch-Basis gefunden")
    return tuple(int(x) for x in match.groups())


class DockerfileTorchTest(unittest.TestCase):
    def test_beide_images_mindestens_torch_2_6(self) -> None:
        for name in ("Dockerfile", "Dockerfile.runpod"):
            with self.subTest(dockerfile=name):
                self.assertGreaterEqual(torch_version(name)[:2], (2, 6))

    def test_beide_images_gleiche_torch_basis(self) -> None:
        self.assertEqual(torch_version("Dockerfile"), torch_version("Dockerfile.runpod"))


if __name__ == "__main__":
    unittest.main()
