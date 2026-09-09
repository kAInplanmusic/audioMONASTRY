#!/usr/bin/env python3
"""
audioMONASTRY · GHCR-Image-Check (RUN-ERR-001/007-Prüfpunkt)
=============================================================
Prüft ohne Docker, welchen ENTRYPOINT die öffentlichen GHCR-Images haben.
RunPod braucht `['python', 'runpod_worker.py']`; der HF-/Uvicorn-Pfad nutzt
`['./startup.sh']`. Verhindert den Fehler „Job hängt ewig IN_QUEUE", weil das
falsche Image im Serverless-Template steckt.

Verwendung:
  python3 scripts/ghcr-check.py                          # beide Repos prüfen
  python3 scripts/ghcr-check.py <owner>/<repo>           # einzelnes Repo prüfen
"""
from __future__ import annotations

import json
import sys
import urllib.request

DEFAULT_REPOS = [
    "kainplanmusic/samplemonk-ai-runtime",
    "kainplanmusic/samplemonk-ai-runtime-runpod",
]


def get_token(repo: str) -> str:
    url = f"https://ghcr.io/token?scope=repository:{repo}:pull"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp).get("token", "")


def get(url: str, token: str) -> bytes:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def inspect(repo: str) -> int:
    try:
        token = get_token(repo)
        tags = json.loads(get(f"https://ghcr.io/v2/{repo}/tags/list", token)).get("tags", [])
    except Exception as exc:
        print(f"FEHLER {repo}: {exc}")
        return 1

    print(f"=== {repo} ({len(tags)} Tags) ===")
    problems = 0
    for tag in tags:
        try:
            manifest = json.loads(get(f"https://ghcr.io/v2/{repo}/manifests/{tag}", token))
            if "manifests" in manifest:  # OCI-Index → erstes Plattform-Manifest
                digest = manifest["manifests"][0]["digest"]
                manifest = json.loads(get(f"https://ghcr.io/v2/{repo}/manifests/{digest}", token))
            config_digest = manifest.get("config", {}).get("digest")
            if not config_digest:
                print(f"{tag:50} no-config")
                problems += 1
                continue
            config = json.loads(get(f"https://ghcr.io/v2/{repo}/blobs/{config_digest}", token))
            entry = config.get("config", {}).get("Entrypoint")
            cmd = config.get("config", {}).get("Cmd")
            print(f"{tag:50} entry={entry} cmd={cmd}")
            if tag == "latest" and "runpod_worker" not in f"{entry} {cmd}":
                print("  ^ WARNUNG: latest hat KEINEN runpod_worker-Entrypoint (nicht für Serverless nutzbar)")
                problems += 1
        except Exception as exc:
            print(f"{tag:50} FEHLER: {str(exc)[:100]}")
            problems += 1
    print(f"Problems: {problems}\n")
    return 0


def main() -> int:
    repos = sys.argv[1:] or DEFAULT_REPOS
    rc = 0
    for repo in repos:
        rc |= inspect(repo)
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
