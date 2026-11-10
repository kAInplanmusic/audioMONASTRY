#!/usr/bin/env python3
"""Read-only, FULL BYTE SHA-256 R2 audit of the 22-entry RunPod SSOT.

Streams every non-CPU mirrored object without persisting weights to disk.
Unlike metadata inventory, success proves the R2 bytes match pinned hashes.
NO GPU pods are created, and no credentials or presigned URLs are printed.
Usage: python3 scripts/runpod-r2-byte-audit.py --yes-network --max-gb 400
"""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys
import urllib.request

ROOT=Path(__file__).resolve().parent.parent
SPEC=importlib.util.spec_from_file_location("runpod_pods",ROOT/"scripts/runpod-pods.py")
mod=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)
SHA=re.compile(r"^[a-f0-9]{64}$")


def expected_objects(target, fleet, models):
    roles=[*fleet["pods"]]
    if fleet.get("visPod",{}).get("enabled"):
        roles.append(fleet["visPod"])
    prefix=fleet["weights"]["prefix"]
    ids={mid for p in roles for mid in p["models"]}
    if len(ids)!=22:
        raise RuntimeError("model inventory is not 22 unique entries")
    result=[]
    for mid in sorted(ids):
        model=models[mid]
        rev=str(model["revision"])
        if rev=="cpu-only":
            continue
        if not mod.REVISION_RE.fullmatch(rev):
            raise RuntimeError(f"{mid}: invalid pinned revision")
        # Per-file Edge manifest (takes precedence when present).
        raw=target.get_bytes(mod.manifest_key(prefix,mid,rev))
        if raw is not None:
            if len(raw)>4*1024*1024:
                raise RuntimeError(f"{mid}: Edge manifest too large")
            doc=json.loads(raw)
            files=doc.get("files")
            if not isinstance(files,list) or not files:
                raise RuntimeError(f"{mid}: invalid Edge manifest")
            for f in files:
                rel=str(f.get("path") or "")
                digest=str(f.get("sha256") or "")
                size=int(f.get("size") or 0)
                if not rel or rel.startswith("/") or ".." in rel.split("/") or not SHA.fullmatch(digest) or size<=0:
                    raise RuntimeError(f"{mid}: unsafe Edge manifest entry")
                result.append((mid,f"{prefix}/{mid}/{rev}/{rel}",digest,size))
            continue
        key=mod.weight_key(prefix,mid,rev)
        meta=target.head(key)
        sidecar=target.get_bytes(key[:-4]+".sha256")
        if meta is None or not sidecar or len(sidecar)>1024:
            raise RuntimeError(f"{mid}: missing TAR/sha256 sidecar")
        digest=sidecar.decode("ascii").split()[0]
        size=int(meta.get("content-length",0))
        if not SHA.fullmatch(digest) or size<=0:
            raise RuntimeError(f"{mid}: invalid TAR digest/size")
        result.append((mid,key,digest,size))
    return result


def stream_sha256(url, expected_size, max_timeout=1800):
    digest=hashlib.sha256()
    counted=0
    # URL is signed and must NEVER appear in logs/exception formatting.
    with urllib.request.urlopen(urllib.request.Request(url,method="GET"),timeout=max_timeout) as response:
        if response.status != 200:
            raise RuntimeError("R2 returned non-200 response")
        while True:
            data=response.read(8*1024*1024)
            if not data:
                break
            counted+=len(data)
            if counted>expected_size:
                raise RuntimeError("R2 object exceeds expected size")
            digest.update(data)
    if counted!=expected_size:
        raise RuntimeError("R2 object byte length does not match inventory")
    return digest.hexdigest()


def audit(target,max_gb):
    fleet,models=mod.load_fleet(),mod.load_models()
    items=expected_objects(target,fleet,models)
    total=sum(size for _,_,_,size in items)
    if total>max_gb*(1024**3):
        raise RuntimeError("R2 inventory exceeds transfer safety cap")
    stats={}
    for mid,key,sha,size in items:
        try:
            actual=stream_sha256(target.presign("GET",key,3600),size)
            if actual != sha:
                raise ValueError("object SHA256 mismatch")
            entry=stats.setdefault(mid,{"filesVerified":0,"bytesVerified":0,"status":"BYTE_SHA256_OK"})
            entry["filesVerified"]+=1
            entry["bytesVerified"]+=size
        except Exception as exc:
            stats[mid]={"status":"FAILED","errorType":type(exc).__name__}
            break
    ok=len(stats)==len({mid for mid,_,_,_ in items}) and all(
        x["status"]=="BYTE_SHA256_OK" for x in stats.values())
    return {"status":"PASS" if ok else "FAIL",
            "verificationLevel":"R2_FULL_OBJECT_BYTES_SHA256",
            "objectsExpected":len(items),"objectsVerified":sum(x.get("filesVerified",0) for x in stats.values()),
            "totalExpectedBytes":total,"gpuVerified":False,"models":stats}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--yes-network",action="store_true",
                   help="authorize streaming all mirrored model weights from R2")
    p.add_argument("--max-gb",type=int,default=400)
    opts=p.parse_args()
    if not opts.yes_network or not 1<=opts.max_gb<=1024:
        print(json.dumps({"status":"BLOCKED","reason":"network authorization/transfer cap missing"}))
        return 4
    try:
        target=mod.s3lite.S3Target.from_r2_env()
        result=audit(target,opts.max_gb)
        print(json.dumps(result,ensure_ascii=False,indent=2))
        return 0 if result["status"]=="PASS" else 4
    except BaseException as exc:
        # Never print urllib error text, headers, credentials, or signed URLs.
        print(json.dumps({"status":"BLOCKED","errorType":type(exc).__name__}),file=sys.stderr)
        return 4


if __name__=="__main__":
    raise SystemExit(main())
