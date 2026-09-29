#!/usr/bin/env python3
"""SigV4-Presign fuer S3-kompatible Ziele (Cloudflare R2) - nur stdlib.

Warum selbst gerechnet: der Pod soll Ergebnisse hochladen koennen, ohne dass dort
aws-CLI, boto3 oder rclone vorhanden sein muessen. curl genuegt fuer eine
vorab signierte URL. Damit ist der Uploadweg vor dem ersten Cent pruefbar.

Benutzung:
    python3 r2.py selftest            # legt eine Testdatei ab, liest sie zurueck, loescht sie
    python3 r2.py presign PUT <key> [sekunden]
    python3 r2.py presign GET <key> [sekunden]
"""
from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ENV_FILE = Path("/home/patrick/AnunnakiTools Projekte/laufende Projekte/audioMONASTRY/.env")


def load_env(path: Path = ENV_FILE) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def _sign(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def presign(
    method: str,
    key: str,
    *,
    endpoint: str,
    bucket: str,
    access_key: str,
    secret_key: str,
    region: str = "auto",
    expires: int = 86400,
    now: dt.datetime | None = None,
) -> str:
    """Erzeugt eine presigned URL (Query-Auth) fuer ein Objekt."""
    ep = endpoint.replace("https://", "").replace("http://", "").rstrip("/")
    scheme = "https" if not endpoint.startswith("http://") else "http"
    host = ep

    now = now or dt.datetime.now(dt.timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    datestamp = now.strftime("%Y%m%d")

    canonical_uri = "/" + bucket + "/" + urllib.parse.quote(key, safe="/~")

    credential_scope = f"{datestamp}/{region}/s3/aws4_request"
    params = {
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Credential": f"{access_key}/{credential_scope}",
        "X-Amz-Date": amz_date,
        "X-Amz-Expires": str(expires),
        "X-Amz-SignedHeaders": "host",
    }
    canonical_query = "&".join(
        f"{urllib.parse.quote(k, safe='-_.~')}={urllib.parse.quote(v, safe='-_.~')}"
        for k, v in sorted(params.items())
    )

    canonical_request = "\n".join(
        [method.upper(), canonical_uri, canonical_query, f"host:{host}\n", "host", "UNSIGNED-PAYLOAD"]
    )

    string_to_sign = "\n".join(
        [
            "AWS4-HMAC-SHA256",
            amz_date,
            credential_scope,
            hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
        ]
    )

    k_date = _sign(("AWS4" + secret_key).encode("utf-8"), datestamp)
    k_region = _sign(k_date, region)
    k_service = _sign(k_region, "s3")
    k_signing = _sign(k_service, "aws4_request")
    signature = hmac.new(k_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()

    return f"{scheme}://{host}{canonical_uri}?{canonical_query}&X-Amz-Signature={signature}"


def _creds() -> dict[str, str]:
    env = load_env()
    return {
        "endpoint": env.get("CFS3_ENDPOINT", ""),
        "bucket": env.get("CFS3_BUCKET", ""),
        "access_key": env.get("CFS3_ACCESS_KEY", ""),
        "secret_key": env.get("CFS3_SECRET_KEY", ""),
    }


def selftest() -> int:
    c = _creds()
    missing = [k for k, v in c.items() if not v]
    if missing:
        print(f"FEHLER: fehlende Zugangsdaten in .env: {missing}")
        return 2
    key = "selftest/presign-probe.txt"
    payload = f"probe {dt.datetime.now(dt.timezone.utc).isoformat()}\n".encode()

    put = presign("PUT", key, **c, expires=600)
    req = urllib.request.Request(put, data=payload, method="PUT")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            print(f"PUT  -> HTTP {r.status}")
    except Exception as exc:
        print(f"PUT FEHLGESCHLAGEN: {exc}")
        return 3

    got = presign("GET", key, **c, expires=600)
    try:
        with urllib.request.urlopen(got, timeout=60) as r:
            body = r.read()
            print(f"GET  -> HTTP {r.status}, {len(body)} Bytes, identisch: {body == payload}")
    except Exception as exc:
        print(f"GET FEHLGESCHLAGEN: {exc}")
        return 4

    dele = presign("DELETE", key, **c, expires=600)
    req = urllib.request.Request(dele, method="DELETE")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            print(f"DEL  -> HTTP {r.status}")
    except Exception as exc:
        print(f"DEL FEHLGESCHLAGEN (nicht kritisch): {exc}")

    print("SELFTEST OK - presign funktioniert gegen R2")
    return 0


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    if sys.argv[1] == "selftest":
        return selftest()
    if sys.argv[1] == "presign":
        method = sys.argv[2]
        key = sys.argv[3]
        expires = int(sys.argv[4]) if len(sys.argv) > 4 else 86400
        print(presign(method, key, **_creds(), expires=expires))
        return 0
    print(f"unbekannt: {sys.argv[1]}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
