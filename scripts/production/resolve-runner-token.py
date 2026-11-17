#!/usr/bin/env python3
"""Run a production mode only after confirming a valid authorized Hetzner token.

Accept the dedicated runner credential or an explicitly configured HCLOUD_TOKEN
in the existing provider secret. Never print tokens or silently skip auth.
"""
import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request


def choose_token():
    try:
        provider = json.loads(os.environ.get("AUDIO_PROD_PROVIDER_ENV") or "{}")
    except ValueError:
        raise RuntimeError("PROVIDER_ENV_INVALID") from None
    candidates = [
        ("dedicated", os.environ.get("HETZNER_PRODUCTION_TOKEN", "")),
        ("provider", provider.get("HCLOUD_TOKEN", "")),
    ]
    for origin, token in candidates:
        if not token or not isinstance(token, str):
            continue
        req = urllib.request.Request(
            "https://api.hetzner.cloud/v1/servers?per_page=1",
            headers={"Authorization": "Bearer " + token},
        )
        try:
            with urllib.request.urlopen(req, timeout=25) as result:
                if result.status == 200:
                    print("HETZNER_AUTH_OK:" + origin, flush=True)
                    return token
        except (urllib.error.URLError, TimeoutError, OSError):
            continue
    raise RuntimeError("NO_VALID_HETZNER_TOKEN_401")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("inspect", "full"), required=True)
    args = parser.parse_args()
    try:
        token = choose_token()
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 10
    env = dict(os.environ, HETZNER_PRODUCTION_TOKEN=token)
    return subprocess.run(["python3", "-u", "scripts/production/deploy.py", "--mode", args.mode], env=env, check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())
