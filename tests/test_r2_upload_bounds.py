"""The targeted mirror enforces a byte cap and never rewrites existing keys."""
import contextlib
import importlib.util
import io
from pathlib import Path
import sys
import unittest
import tempfile
import xml.etree.ElementTree as ET
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("bounded_assets", ROOT / "scripts/provision-model-assets.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Target:
    def __init__(self, existing=False):
        self.existing = existing
        self.writes = []

    def head(self, key):
        return {"content-length": "4"} if self.existing else None

    def put_file(self, *args, **kwargs):
        self.writes.append(args)

    def put_bytes(self, *args, **kwargs):
        self.writes.append(args)


class BoundTests(unittest.TestCase):
    def lock(self):
        return {"fixture": {"revision": "a" * 40, "files": [{"path": "model.bin", "size": 4, "sha256": "b" * 64}]}}

    def run_cli(self, target, cap):
        args = ["provision-model-assets.py", "--mirror", "--missing-only", "--only", "fixture", "--max-upload-bytes", str(cap)]
        with patch.object(sys, "argv", args), \
             patch.object(module, "read_lock", return_value=self.lock()), \
             patch.object(module.S3Target, "from_r2_env", return_value=target), \
             patch.object(module, "ensure_assets", return_value={}), \
             patch.object(module, "asset_path", return_value=Path("unused")), \
             patch.object(module, "verify_file", return_value=True), \
             contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return module.main()

    def test_excessive_plan_is_rejected_before_any_upload(self):
        target = Target()
        with self.assertRaises(SystemExit) as error:
            self.run_cli(target, cap=1)
        self.assertEqual(error.exception.code, 2)
        self.assertEqual(target.writes, [])

    def test_existing_objects_and_markers_are_not_overwritten(self):
        target = Target(existing=True)
        self.assertEqual(self.run_cli(target, cap=0), 0)
        self.assertEqual(target.writes, [])

    def test_parallel_parts_are_completed_in_numeric_order(self):
        completed = []
        def request(method, key, body=b"", query=None, headers=None, **kwargs):
            query = query or {}
            if "uploads" in query:
                return 200, {}, b"<Result><UploadId>test-upload</UploadId></Result>"
            if method == "PUT":
                return 200, {"ETag": f"part-{query['partNumber']}"}, b""
            if method == "POST":
                completed.extend(int(e.text) for e in ET.fromstring(body).findall("Part/PartNumber"))
            return 200, {}, b"<Complete/>"
        target = module.S3Target("https://example.test", "bucket", "key", "secret")
        with tempfile.NamedTemporaryFile() as file, patch.object(module.S3Target, "_request", side_effect=request):
            file.write(b"abcdefghijkl")
            file.flush()
            target.put_file("model", file.name, part_size=3, max_workers=4)
        self.assertEqual(completed, [1, 2, 3, 4])

    def test_failed_part_aborts_its_multipart_upload(self):
        aborted = []
        def request(method, key, body=b"", query=None, headers=None, **kwargs):
            query = query or {}
            if "uploads" in query:
                return 200, {}, b"<Result><UploadId>test-upload</UploadId></Result>"
            if method == "PUT":
                return 500, {}, b""
            if method == "DELETE":
                aborted.append(query["uploadId"])
            return 200, {}, b""
        target = module.S3Target("https://example.test", "bucket", "key", "secret")
        with tempfile.NamedTemporaryFile() as file, patch.object(module.S3Target, "_request", side_effect=request):
            file.write(b"abcdefgh")
            file.flush()
            with self.assertRaises(RuntimeError):
                target.put_file("model", file.name, part_size=3, max_workers=2)
        self.assertEqual(aborted, ["test-upload"])


if __name__ == "__main__":
    unittest.main()
