"""Tests für scripts/s3lite.py – SigV4 gegen die Beispielvektoren der AWS-S3-Doku.

Kein Netz. Lauf: python3 tests/test_s3lite.py
"""
from __future__ import annotations

import datetime as dt
import importlib.util
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("s3lite", ROOT / "scripts" / "s3lite.py")
s3lite = importlib.util.module_from_spec(spec)
assert spec.loader
sys.modules["s3lite"] = s3lite
spec.loader.exec_module(s3lite)

AWS_KEY = "AKIAIOSFODNN7EXAMPLE"
AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
WHEN = dt.datetime(2013, 5, 24, 0, 0, 0, tzinfo=dt.timezone.utc)


class SigV4Test(unittest.TestCase):
    def setUp(self) -> None:
        # Virtueller Host wie in der AWS-Doku: Bucket steckt im Endpoint.
        self.target = s3lite.S3Target("https://examplebucket.s3.amazonaws.com", None, AWS_KEY, AWS_SECRET, "us-east-1")

    def test_presigned_url_entspricht_aws_beispiel(self) -> None:
        url = self.target.presign("GET", "test.txt", expires=86400, now=WHEN)
        self.assertTrue(url.startswith("https://examplebucket.s3.amazonaws.com/test.txt?"))
        self.assertIn("X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request", url)
        self.assertTrue(url.endswith("X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"))

    def test_header_signatur_get_mit_range_entspricht_aws_beispiel(self) -> None:
        _url, headers = self.target.sign_headers("GET", "test.txt", headers={"Range": "bytes=0-9"}, now=WHEN)
        self.assertIn("SignedHeaders=host;range;x-amz-content-sha256;x-amz-date", headers["authorization"])
        self.assertTrue(headers["authorization"].endswith(
            "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"))

    def test_path_style_fuer_r2(self) -> None:
        r2 = s3lite.S3Target("https://acc.r2.cloudflarestorage.com", "audiomonastry", "k", "s")
        url = r2.presign("GET", "weights/brain/qwen a.tar", expires=60, now=WHEN)
        self.assertTrue(url.startswith("https://acc.r2.cloudflarestorage.com/audiomonastry/weights/brain/qwen%20a.tar?"))
        self.assertIn("%2Fauto%2Fs3%2Faws4_request", url)

    def test_from_env_meldet_fehlende_variablen(self) -> None:
        with self.assertRaises(SystemExit) as ctx:
            s3lite.S3Target.from_env("NICHTGESETZT")
        self.assertIn("NICHTGESETZT_ENDPOINT", str(ctx.exception))


class R2EnvTest(unittest.TestCase):
    def test_aliase_entsprechen_dem_server(self) -> None:
        import re
        ts = (ROOT / "server" / "r2Config.ts").read_text(encoding="utf-8")
        block = ts[ts.index("export const R2_ENV_ALIASES"):ts.index("};", ts.index("export const R2_ENV_ALIASES"))]
        for field, names in s3lite.R2_ALIASES.items():
            part = block[block.index(f"  {field}: ["):]
            part = part[:part.index("]")]
            self.assertEqual(tuple(re.findall(r"'([A-Z0-9_]+)'", part)), names, field)

    def test_endpoint_aus_account_id(self) -> None:
        t = s3lite.S3Target.from_r2_env({"CFS3_ACCESS_KEY": "a", "CFS3_SECRET_KEY": "b", "CFS3_BUCKET": "bk",
                                         "CFR2_ACCOUNT_ID": "abc123"})
        self.assertEqual(t.endpoint, "https://abc123.r2.cloudflarestorage.com")
        self.assertEqual((t.bucket, t.region), ("bk", "auto"))

    def test_fehlende_r2_variablen(self) -> None:
        with self.assertRaises(SystemExit) as ctx:
            s3lite.S3Target.from_r2_env({})
        self.assertIn("CFS3_ACCESS_KEY", str(ctx.exception))

    def test_b2_region_aus_endpoint(self) -> None:
        t = s3lite.S3Target.from_b2_env({"B2_BUCKET": "audioMONASTRY", "B2_KEY_ID": "k", "B2_APP_KEY": "s"})
        self.assertEqual(t.region, "eu-central-003")


if __name__ == "__main__":
    unittest.main(verbosity=2)
