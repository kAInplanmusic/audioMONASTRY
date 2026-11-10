"""Network-free tests for safe BVE revision resolution."""
import importlib.util
import pathlib
import unittest

PATH = pathlib.Path(__file__).resolve().parent.parent / "scripts/resolve-bve-revision.py"
spec = importlib.util.spec_from_file_location("resolve_bve_revision", PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class ResolveBveTests(unittest.TestCase):
    def fixture(self, sha="c73a679" + "0"*33, digest=None):
        return {"sha":sha,"siblings":[{"rfilename":module.FILE,
                "lfs":{"sha256": digest if digest is not None else module.EXPECTED}}]}

    def test_full_revision_and_checkpoint_digest(self):
        self.assertEqual(module.verify(self.fixture()), "c73a679" + "0"*33)

    def test_refuses_unrelated_revision(self):
        with self.assertRaises(ValueError):
            module.verify(self.fixture(sha="a"*40))

    def test_refuses_short_revision(self):
        with self.assertRaises(ValueError):
            module.verify(self.fixture(sha="c73a679"))

    def test_refuses_wrong_checkpoint(self):
        with self.assertRaises(ValueError):
            module.verify(self.fixture(digest="0"*64))

    def test_refuses_absent_digest(self):
        data = self.fixture()
        data["siblings"][0]["lfs"] = {}
        with self.assertRaises(ValueError):
            module.verify(data)

    def test_refuses_missing_checkpoint(self):
        data = self.fixture()
        data["siblings"] = []
        with self.assertRaises(ValueError):
            module.verify(data)

if __name__ == "__main__":
    unittest.main()
