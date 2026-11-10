#!/usr/bin/env python3
"""Read-only R2 inventory for the 20 unique GPU/support artifact IDs.

No keys, presigned URLs, raw headers, access tokens or audio are printed.
A successful inventory proves only object/sidecar presence, NOT actual bytes.
The Pod validates archive SHA256 during download; individual release assets
are revalidated by the specialized loader.
"""
from __future__ import annotations
import importlib.util
import json
import pathlib
import re
import sys

ROOT=pathlib.Path(__file__).resolve().parent.parent
SPEC=importlib.util.spec_from_file_location("runpod_pods",ROOT/"scripts/runpod-pods.py")
pod=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pod)
import s3lite  # noqa: E402 (scripts dir on sys.path when executed directly)
HEX=re.compile(r"^[a-f0-9]{64}$")

def inventory() -> dict:
    fleet, models=pod.load_fleet(),pod.load_models()
    store=s3lite.S3Target.from_r2_env()
    prefix=fleet["weights"]["prefix"]
    roles=[*fleet["pods"],*([fleet["visPod"]] if fleet.get("visPod",{}).get("enabled") else [])]
    entries={}
    for role in roles:
        for mid,rev in pod.models_with_weights(role,models):
            if mid in entries:
                entries[mid]["roles"].append(role["role"])
                continue
            key=pod.weight_key(prefix,mid,rev)
            obj=store.head(key)
            sidecar=store.get_bytes(key[:-4]+".sha256")
            metadata_present=obj is not None
            sha_present=False
            size=0
            if metadata_present:
                try: size=int(obj.get("content-length","0"))
                except (ValueError,TypeError): size=0
            if sidecar and len(sidecar)<1024:
                try:
                    sha=sidecar.decode("ascii").split()[0]
                    sha_present=bool(HEX.fullmatch(sha))
                except (ValueError,UnicodeDecodeError,IndexError):
                    pass
            entries[mid]={"roles":[role["role"]],"archiveExists":metadata_present,
                          "archiveNonEmpty":size>0,"sidecarDigestFormatValid":sha_present,
                          "byteHashVerified":False}
    errors=[m for m,proof in entries.items() if not (proof["archiveExists"] and proof["archiveNonEmpty"] and proof["sidecarDigestFormatValid"])]
    return {"ok":not errors,"verificationLevel":"R2_OBJECT_METADATA_ONLY",
            "entries":entries,"uniqueArtifactModels":len(entries),
            "missingOrInvalid":errors,"gpuVerified":False,"byteHashVerified":False}

if __name__=="__main__":
    try:
        report=inventory()
        print(json.dumps(report,indent=2,ensure_ascii=False))
        sys.exit(0 if report["ok"] else 4)
    except Exception as exc:
        print(json.dumps({"ok":False,"status":"BLOCKED_NO_R2_ACCESS_OR_ERROR",
                          "errorType":type(exc).__name__}),file=sys.stderr)
        sys.exit(4)
