"""R2 streaming audit safety tests; all network/credential calls mocked."""
from __future__ import annotations
import importlib.util
import io
import hashlib
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parent.parent
SPEC=importlib.util.spec_from_file_location("runpod_r2_byte_audit",ROOT/"scripts/runpod-r2-byte-audit.py")
audit=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)
DIGEST=hashlib.sha256(b"testweight").hexdigest()

class FakeResponse(io.BytesIO):
    status=200
class FakeBucket:
    def get_bytes(self,key):
        return (DIGEST+"  model.tar").encode() if key.endswith(".sha256") else None
    def head(self,key):
        return {"content-length":str(len(b"testweight"))}
    def presign(self,method,key,ttl):
        return "https://example.invalid/opaque-signature"

class ReadOnlyByteAuditTest(unittest.TestCase):
    def test_stream_verifies_actual_bytes_not_head(self):
        with patch.object(audit.urllib.request,"urlopen",return_value=FakeResponse(b"testweight")):
            digest=audit.stream_sha256("https://example.invalid/data",len(b"testweight"))
            self.assertEqual(digest,DIGEST)
    def test_stream_refuses_size_overrun(self):
        with patch.object(audit.urllib.request,"urlopen",return_value=FakeResponse(b"testweight")):
            with self.assertRaisesRegex(RuntimeError,"exceeds expected"):
                audit.stream_sha256("https://example.invalid/data",3)
    def test_manifest_expands_all_twenty_artifact_ids(self):
        fleet,models=audit.mod.load_fleet(),audit.mod.load_models()
        entries=audit.expected_objects(FakeBucket(),fleet,models)
        self.assertEqual(len({m for m,_,_,_ in entries}),20)
        self.assertTrue(all(size>0 and digest==DIGEST for _,_,digest,size in entries))
    def test_audit_result_does_not_claim_cuda_verification(self):
        with patch.object(audit,"stream_sha256",return_value=DIGEST):
            report=audit.audit(FakeBucket(),1)
        self.assertEqual(report["status"],"PASS")
        self.assertEqual(report["objectsVerified"],20)
        self.assertFalse(report["gpuVerified"])
    def test_bad_object_digest_fails_closed(self):
        with patch.object(audit,"stream_sha256",return_value="0"*64):
            report=audit.audit(FakeBucket(),1)
        self.assertEqual(report["status"],"FAIL")
        self.assertEqual(report["objectsVerified"],0)
    def test_transfers_are_capped_before_reading(self):
        with patch.object(audit,"stream_sha256",side_effect=AssertionError("network must not start")):
            with self.assertRaisesRegex(RuntimeError,"transfer safety cap"):
                audit.audit(FakeBucket(),0)

if __name__=="__main__":
    unittest.main()
