#!/usr/bin/env python3
"""Stream HF model directly to R2 via tar pipe (ZERO local storage)."""
import os
import sys
import json
import hashlib
import subprocess
import requests
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import s3lite

# Config
REPO = "Qwen/Qwen3.5-4B"
REVISION = "851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a"
MODEL_ID = "qwen3-4b"
PREFIX = "weights"
BUCKET = "audiomonastrysamples"
ENDPOINT = "https://2a195733f62228991f55e60bbb397efa.r2.cloudflarestorage.com/"
ACCESS_KEY = "7a3d9b47b8bd046aa2b4662341aecbd7"
SECRET_KEY = "5f4e2056babef95a6b179f6c4f08551d4d6038f0327afabe59971d37b03a46bc"

def get_file_list(repo: str, revision: str, token: str = None) -> list:
    """Get all files in repo at revision via HF Hub API."""
    url = f"https://huggingface.co/api/models/{repo}/tree/{revision}"
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    resp = requests.get(url, headers=headers, timeout=30)
    resp.raise_for_status()
    return [f["path"] for f in resp.json() if f["type"] == "file"]

def stream_file(repo: str, revision: str, path: str, token: str = None):
    """Stream single file from HF Hub."""
    url = f"https://huggingface.co/{repo}/resolve/{revision}/{path}"
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    resp = requests.get(url, headers=headers, stream=True, timeout=60)
    resp.raise_for_status()
    for chunk in resp.iter_content(chunk_size=1024*1024):
        yield chunk

def main():
    token = os.environ.get("HF_TOKEN", "").strip() or None
    
    print(f"Fetching file list for {REPO}@{REVISION}...", flush=True)
    files = get_file_list(REPO, REVISION, token)
    print(f"  {len(files)} files", flush=True)
    
    key = f"{PREFIX}/{MODEL_ID}/{REVISION}.tar"
    sha256_key = f"{PREFIX}/{MODEL_ID}/{REVISION}.sha256"
    
    # AWS CLI multipart upload from stdin
    env = os.environ.copy()
    env.update({
        "AWS_ACCESS_KEY_ID": ACCESS_KEY,
        "AWS_SECRET_ACCESS_KEY": SECRET_KEY,
    })
    
    # Start tar process that reads from our generator
    # We'll create a subprocess that tars stdin -> stdout, but we need to feed it
    # Better: write tar ourselves and pipe to aws s3 cp
    
    import tarfile
    import io
    
    # Create a pipe: our tar writer -> aws s3 cp stdin
    aws_cmd = [
        "aws", "s3", "cp", "-",
        f"s3://{BUCKET}/{key}",
        "--endpoint-url", ENDPOINT,
    ]
    
    aws_proc = subprocess.Popen(
        aws_cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env
    )
    
    sha256 = hashlib.sha256()
    total_bytes = 0
    
    # Write tar stream to aws_proc.stdin
    with tarfile.open(fileobj=aws_proc.stdin, mode="w|") as tar:
        for fpath in files:
            print(f"  Streaming {fpath}...", flush=True)
            file_data = b""
            for chunk in stream_file(REPO, REVISION, fpath, token):
                file_data += chunk
            
            # Create tarinfo
            info = tarfile.TarInfo(name=f"hub/{fpath}")
            info.size = len(file_data)
            info.mtime = 0  # reproducible
            
            # Write to tar stream
            tar.addfile(info, io.BytesIO(file_data))
            
            # Update hash
            sha256.update(file_data)
            total_bytes += len(file_data)
            
            print(f"    {len(file_data)/1024/1024:.1f} MB", flush=True)
    
    aws_proc.stdin.close()
    aws_out, aws_err = aws_proc.communicate()
    
    if aws_proc.returncode != 0:
        print(f"AWS upload failed: {aws_err.decode()}", file=sys.stderr)
        sys.exit(1)
    
    sha = sha256.hexdigest()
    print(f"✔ Uploaded {key} ({total_bytes/1024/1024/1024:.2f} GB, sha256 {sha[:16]}...)", flush=True)
    
    # Upload sha256 sidecar
    sha_content = f"{sha}  {MODEL_ID.replace('/', '_')}-{REVISION}.tar\n"
    sha_cmd = [
        "aws", "s3", "cp", "-",
        f"s3://{BUCKET}/{sha256_key}",
        "--endpoint-url", ENDPOINT,
    ]
    sha_proc = subprocess.Popen(
        sha_cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env
    )
    sha_proc.communicate(input=sha_content.encode())
    
    if sha_proc.returncode != 0:
        print(f"SHA256 upload failed", file=sys.stderr)
        sys.exit(1)
    
    print(f"✔ Uploaded {sha256_key}", flush=True)

if __name__ == "__main__":
    main()