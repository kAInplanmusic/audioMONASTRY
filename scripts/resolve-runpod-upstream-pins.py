#!/usr/bin/env python3
"""Verify upstream BVE/DeReverb file provenance using public Hugging Face URLs.

Read-only. Does not download 913-MB checkpoints and never uses credentials.
The *checkpoint* SHA256 values come from the HF file metadata; the YAML hashes
are calculated from the actual content downloaded at an immutable revision.
"""
from __future__ import annotations
import hashlib
import json
import pathlib
import sys
import urllib.parse
import urllib.request

ROOT=pathlib.Path(__file__).resolve().parent.parent
MANIFEST=ROOT/"services/audiomonastry-ai-runtime/model_manifest.json"
BVE_PREFIX="c73a679"
FILES={
    "mel-roformer-bve":("config_bve_gonza.yaml","mel_band_roformer_bve_gonza.ckpt",
        "e003bbb97ebef78c59cd6b46c5fc3d0f2303cd49f6fb98eb8b8f0f8075899ae3"),
    "mel-roformer-dereverb":("dereverb_mel_band_roformer_anvuew.yaml",
        "dereverb_mel_band_roformer_anvuew_sdr_19.1729.ckpt",
        "9262877b87e9ebb0fb808a456b0a411fa677f5df31c8383c1254af531c078970"),
}

def read_bytes(url: str, limit: int = 1_048_576) -> bytes:
    req=urllib.request.Request(url,headers={"User-Agent":"audioMONASTRY-public-provenance/1.0"})
    with urllib.request.urlopen(req,timeout=30) as resp:
        raw=resp.read(limit+1)
        if len(raw)>limit:
            raise ValueError("response larger than bounded provenance request")
        return raw

def main() -> int:
    models={m["id"]:m for m in json.loads(MANIFEST.read_text())["models"]}
    results={}
    try:
        for mid,(yaml_name,ckpt_name,expected) in FILES.items():
            m=models[mid]
            repo=m["repository"]
            rev=BVE_PREFIX if mid=="mel-roformer-bve" else m["revision"]
            meta_url=f"https://huggingface.co/api/models/{urllib.parse.quote(repo,safe='/')}/revision/{rev}?blobs=true"
            data=json.loads(read_bytes(meta_url,4_194_304))
            full=str(data.get("sha",""))
            if (len(full)!=40 or not all(c in "0123456789abcdef" for c in full) or
                 not full.startswith(rev)):
                raise ValueError(f"{mid}: HF returned an unexpected revision")
            siblings=data.get("siblings",[])
            checkpoint=[x for x in siblings if x.get("rfilename")==ckpt_name]
            if len(checkpoint)!=1:
                raise ValueError(f"{mid}: checkpoint not listed by HF API")
            item=checkpoint[0]
            published=((item.get("lfs") or {}).get("sha256")
                       or (item.get("xet") or {}).get("sha256"))
            if published and published != expected:
                raise ValueError(f"{mid}: published checkpoint digest mismatches manifest")
            # Do not claim a hash validation if the API omitted file digest.
            checkpointMetadataValidated=published==expected
            url=f"https://huggingface.co/{urllib.parse.quote(repo,safe='/')}/resolve/{full}/{yaml_name}"
            blob=read_bytes(url,1_048_576)
            if not blob or b"<html" in blob[:100].lower():
                raise ValueError(f"{mid}: YAML fetch returned no raw YAML")
            results[mid]={
                "repository":repo, "revision":full,
                "configName":yaml_name,"configSha256":hashlib.sha256(blob).hexdigest(),
                "configSize":len(blob),"checkpointName":ckpt_name,
                "checkpointSha256":expected,
                "checkpointDigestMetadataValidated":checkpointMetadataValidated,
            }
        print(json.dumps({"status":"verified-config-remote","models":results},indent=2))
        return 0
    except Exception as exc:
        print(json.dumps({"status":"blocked","errorType":type(exc).__name__}),file=sys.stderr)
        return 4

if __name__=="__main__":
    raise SystemExit(main())
