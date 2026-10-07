"""s3lite – S3-kompatibler Mini-Client (Cloudflare R2, Backblaze B2, AWS) nur mit der Standardbibliothek.

Wird von `runpod-pods.py` (Presigned-URLs für die Pod-Gewichte), `weights-mirror.py`
und `media-ingest.py` benutzt. Kein boto3 nötig, damit die Skripte auf jedem Rechner
mit Python 3.9+ laufen (auch auf dem Rechner mit der BRAIN-Platte).

Signatur: AWS Signature Version 4, geprüft gegen die Beispielvektoren der AWS-Doku
(`tests/test_s3lite.py`).
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import hmac
import os
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Tuple

EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()

#: Spiegel von `R2_ENV_ALIASES` in server/r2Config.ts (gleiche Reihenfolge).
R2_ALIASES: Dict[str, Tuple[str, ...]] = {
    "accessKeyId": ("CFS3_ACCESS_KEY", "CFS3_ACCESS_KEY_ID", "CFR2_ACCESS_KEY_ID", "CFR2_ACCESS_KEY", "CLOUDFLARE_ACCESS_KEY_ID"),
    "secretAccessKey": ("CFS3_SECRET_KEY", "CFS3_SECRET_ACCESS_KEY", "CFR2_SECRET_ACCESS_KEY", "CFR2_SECRET_KEY", "CLOUDFLARE_SECRET_ACCESS_KEY"),
    "endpoint": ("CFS3_ENDPOINT", "CFR2_ENDPOINT", "CFR2_URL"),
    "bucket": ("CFS3_BUCKET", "CFR2_BUCKET"),
    "accountId": ("CFR2_ACCOUNT_ID", "CFS3_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID", "CF_ACCOUNT_ID"),
}
#: R2 erlaubt Einzel-PUT bis 5 GB; darüber Multipart. Teilgröße 64 MiB (Minimum 5 MiB).
DEFAULT_PART_SIZE = 64 * 1024 * 1024


def _quote(value: str, safe: str = "-_.~") -> str:
    return urllib.parse.quote(value, safe=safe)


def _sign(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def _signing_key(secret: str, date: str, region: str, service: str) -> bytes:
    k = _sign(("AWS4" + secret).encode("utf-8"), date)
    k = _sign(k, region)
    k = _sign(k, service)
    return _sign(k, "aws4_request")


@dataclass(frozen=True)
class S3Target:
    """Ziel-Bucket. `bucket=None` = virtueller Host (Bucket steckt schon im Endpoint)."""

    endpoint: str
    bucket: Optional[str]
    access_key: str
    secret_key: str
    region: str = "auto"
    service: str = "s3"

    @staticmethod
    def from_env(prefix: str = "R2") -> "S3Target":
        """Liest `<PREFIX>_ENDPOINT`, `<PREFIX>_BUCKET`, `<PREFIX>_ACCESS_KEY_ID`,
        `<PREFIX>_SECRET_ACCESS_KEY`, optional `<PREFIX>_REGION`. Fehlt etwas, klare Meldung."""
        names = {
            "endpoint": f"{prefix}_ENDPOINT",
            "bucket": f"{prefix}_BUCKET",
            "access_key": f"{prefix}_ACCESS_KEY_ID",
            "secret_key": f"{prefix}_SECRET_ACCESS_KEY",
        }
        values = {k: os.environ.get(v, "").strip() for k, v in names.items()}
        missing = [names[k] for k, v in values.items() if not v]
        if missing:
            raise SystemExit(f"Fehlende Umgebungsvariablen: {', '.join(missing)} (siehe .env.example)")
        region = os.environ.get(f"{prefix}_REGION", "").strip() or ("auto" if prefix == "R2" else "us-east-1")
        return S3Target(values["endpoint"].rstrip("/"), values["bucket"], values["access_key"], values["secret_key"], region)

    @staticmethod
    def from_r2_env(env: Optional[Dict[str, str]] = None) -> "S3Target":
        """R2 mit denselben Variablennamen wie der Server (`server/r2Config.ts`, R2_ENV_ALIASES):
        CFS3_ACCESS_KEY, CFS3_SECRET_KEY, CFS3_BUCKET, CFS3_ENDPOINT oder CFR2_ACCOUNT_ID."""
        e = os.environ if env is None else env

        def first(names: Iterable[str]) -> str:
            for n in names:
                v = (e.get(n) or "").strip()
                if v:
                    return v
            return ""

        access = first(R2_ALIASES["accessKeyId"])
        secret = first(R2_ALIASES["secretAccessKey"])
        bucket = first(R2_ALIASES["bucket"])
        endpoint = first(R2_ALIASES["endpoint"])
        account = first(R2_ALIASES["accountId"])
        if not endpoint and account:
            endpoint = f"https://{account}.r2.cloudflarestorage.com"
        missing = [label for label, v in (("CFS3_ACCESS_KEY", access), ("CFS3_SECRET_KEY", secret),
                                          ("CFS3_BUCKET", bucket), ("CFS3_ENDPOINT oder CFR2_ACCOUNT_ID", endpoint)) if not v]
        if missing:
            raise SystemExit(f"R2 nicht konfiguriert, es fehlt: {', '.join(missing)} (siehe .env.example)")
        return S3Target(endpoint.rstrip("/"), bucket, access, secret, "auto")

    @staticmethod
    def from_b2_env(env: Optional[Dict[str, str]] = None) -> "S3Target":
        """Backblaze B2 (S3-API): B2_ENDPOINT, B2_BUCKET, B2_KEY_ID, B2_APP_KEY; Region aus dem Endpoint."""
        e = os.environ if env is None else env
        endpoint = (e.get("B2_ENDPOINT") or "https://s3.eu-central-003.backblazeb2.com").strip()
        bucket = (e.get("B2_BUCKET") or "").strip()
        key_id = (e.get("B2_KEY_ID") or "").strip()
        app_key = (e.get("B2_APP_KEY") or "").strip()
        missing = [n for n, v in (("B2_BUCKET", bucket), ("B2_KEY_ID", key_id), ("B2_APP_KEY", app_key)) if not v]
        if missing:
            raise SystemExit(f"B2 nicht konfiguriert, es fehlt: {', '.join(missing)}")
        host = urllib.parse.urlsplit(endpoint).netloc
        region = host.split(".")[1] if host.startswith("s3.") else "us-east-1"
        return S3Target(endpoint.rstrip("/"), bucket, key_id, app_key, region)

    # ------------------------------------------------------------------ Pfade
    def _host_and_path(self, key: str) -> Tuple[str, str, str]:
        parsed = urllib.parse.urlsplit(self.endpoint)
        host = parsed.netloc
        base = parsed.path.rstrip("/")
        key_part = "/".join(_quote(seg) for seg in key.lstrip("/").split("/"))
        path = f"{base}/{_quote(self.bucket)}/{key_part}" if self.bucket else f"{base}/{key_part}"
        return parsed.scheme, host, path

    # ------------------------------------------------------------------ Presign
    def presign(self, method: str, key: str, expires: int = 3600, now: Optional[_dt.datetime] = None) -> str:
        """Presigned URL (Query-Signatur). Für GET-Downloads im Pod ohne Schlüssel im Pod."""
        now = now or _dt.datetime.now(_dt.timezone.utc)
        amz_date = now.strftime("%Y%m%dT%H%M%SZ")
        date = now.strftime("%Y%m%d")
        scheme, host, path = self._host_and_path(key)
        scope = f"{date}/{self.region}/{self.service}/aws4_request"
        query = {
            "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
            "X-Amz-Credential": f"{self.access_key}/{scope}",
            "X-Amz-Date": amz_date,
            "X-Amz-Expires": str(int(expires)),
            "X-Amz-SignedHeaders": "host",
        }
        canonical_query = "&".join(f"{_quote(k)}={_quote(v)}" for k, v in sorted(query.items()))
        canonical_request = "\n".join([method.upper(), path, canonical_query, f"host:{host}\n", "host", "UNSIGNED-PAYLOAD"])
        string_to_sign = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(canonical_request.encode()).hexdigest()])
        signature = hmac.new(_signing_key(self.secret_key, date, self.region, self.service), string_to_sign.encode(), hashlib.sha256).hexdigest()
        return f"{scheme}://{host}{path}?{canonical_query}&X-Amz-Signature={signature}"

    # ------------------------------------------------------------------ Header-Signatur
    def sign_headers(
        self,
        method: str,
        key: str,
        query: Optional[Dict[str, str]] = None,
        headers: Optional[Dict[str, str]] = None,
        payload_sha256: str = EMPTY_SHA256,
        now: Optional[_dt.datetime] = None,
    ) -> Tuple[str, Dict[str, str]]:
        """Liefert (URL, Header) für eine per Header signierte Anfrage."""
        now = now or _dt.datetime.now(_dt.timezone.utc)
        amz_date = now.strftime("%Y%m%dT%H%M%SZ")
        date = now.strftime("%Y%m%d")
        scheme, host, path = self._host_and_path(key)
        hdrs = {k.lower(): str(v).strip() for k, v in (headers or {}).items()}
        hdrs["host"] = host
        hdrs["x-amz-date"] = amz_date
        hdrs["x-amz-content-sha256"] = payload_sha256
        signed = sorted(hdrs)
        canonical_headers = "".join(f"{h}:{hdrs[h]}\n" for h in signed)
        q = query or {}
        canonical_query = "&".join(f"{_quote(k)}={_quote(v)}" for k, v in sorted(q.items()))
        canonical_request = "\n".join([method.upper(), path, canonical_query, canonical_headers, ";".join(signed), payload_sha256])
        scope = f"{date}/{self.region}/{self.service}/aws4_request"
        string_to_sign = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(canonical_request.encode()).hexdigest()])
        signature = hmac.new(_signing_key(self.secret_key, date, self.region, self.service), string_to_sign.encode(), hashlib.sha256).hexdigest()
        hdrs["authorization"] = (
            f"AWS4-HMAC-SHA256 Credential={self.access_key}/{scope}, SignedHeaders={';'.join(signed)}, Signature={signature}"
        )
        url = f"{scheme}://{host}{path}" + (f"?{canonical_query}" if canonical_query else "")
        del hdrs["host"]
        return url, hdrs

    # ------------------------------------------------------------------ Netzwerk
    def _request(self, method: str, key: str, body: bytes = b"", query: Optional[Dict[str, str]] = None,
                 headers: Optional[Dict[str, str]] = None, timeout: float = 300) -> Tuple[int, Dict[str, str], bytes]:
        url, hdrs = self.sign_headers(method, key, query, headers, hashlib.sha256(body).hexdigest())
        req = urllib.request.Request(url, data=body if method in ("PUT", "POST") else None, method=method, headers=hdrs)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.status, dict(resp.headers.items()), resp.read()
        except urllib.error.HTTPError as exc:
            return exc.code, dict(exc.headers.items()) if exc.headers else {}, exc.read() if exc.fp else b""

    def head(self, key: str) -> Optional[Dict[str, str]]:
        """Metadaten oder None, wenn das Objekt fehlt."""
        status, headers, _ = self._request("HEAD", key)
        if status == 404:
            return None
        if status >= 300:
            raise RuntimeError(f"HEAD {key}: HTTP {status}")
        return {k.lower(): v for k, v in headers.items()}

    def put_bytes(self, key: str, data: bytes, content_type: str = "application/octet-stream",
                  meta: Optional[Dict[str, str]] = None) -> None:
        headers = {"content-type": content_type}
        for k, v in (meta or {}).items():
            headers[f"x-amz-meta-{k.lower()}"] = v
        status, _, body = self._request("PUT", key, data, headers=headers)
        if status >= 300:
            raise RuntimeError(f"PUT {key}: HTTP {status} {body[:200]!r}")

    def get_bytes(self, key: str) -> Optional[bytes]:
        status, _, body = self._request("GET", key)
        if status == 404:
            return None
        if status >= 300:
            raise RuntimeError(f"GET {key}: HTTP {status}")
        return body

    def put_file(self, key: str, path: str, content_type: str = "application/octet-stream",
                 meta: Optional[Dict[str, str]] = None, part_size: int = DEFAULT_PART_SIZE) -> None:
        """Lädt eine Datei hoch; ab `part_size` als Multipart (große Videos, Gewichte)."""
        size = os.path.getsize(path)
        if size <= part_size:
            with open(path, "rb") as fh:
                self.put_bytes(key, fh.read(), content_type, meta)
            return
        headers = {"content-type": content_type}
        for k, v in (meta or {}).items():
            headers[f"x-amz-meta-{k.lower()}"] = v
        status, _, body = self._request("POST", key, query={"uploads": ""}, headers=headers)
        if status >= 300:
            raise RuntimeError(f"Multipart-Start {key}: HTTP {status}")
        upload_id = _xml_text(body, "UploadId")
        etags: List[Tuple[int, str]] = []
        try:
            with open(path, "rb") as fh:
                number = 1
                while True:
                    chunk = fh.read(part_size)
                    if not chunk:
                        break
                    st, hdrs, _ = self._request("PUT", key, chunk, query={"partNumber": str(number), "uploadId": upload_id})
                    if st >= 300:
                        raise RuntimeError(f"Teil {number} von {key}: HTTP {st}")
                    etag = {k.lower(): v for k, v in hdrs.items()}.get("etag", "")
                    etags.append((number, etag))
                    number += 1
            xml = "<CompleteMultipartUpload>" + "".join(
                f"<Part><PartNumber>{n}</PartNumber><ETag>{e}</ETag></Part>" for n, e in etags
            ) + "</CompleteMultipartUpload>"
            st, _, body = self._request("POST", key, xml.encode(), query={"uploadId": upload_id},
                                        headers={"content-type": "application/xml"})
            if st >= 300 or b"<Error>" in body:
                raise RuntimeError(f"Multipart-Abschluss {key}: HTTP {st}")
        except Exception:
            self._request("DELETE", key, query={"uploadId": upload_id})
            raise


def _xml_text(body: bytes, tag: str) -> str:
    root = ET.fromstring(body)
    for el in root.iter():
        if el.tag.split("}")[-1] == tag:
            return el.text or ""
    raise RuntimeError(f"Antwort ohne <{tag}>")


def sha256_file(path: str, chunk: int = 8 * 1024 * 1024) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def iter_chunks(path: str, size: int) -> Iterable[bytes]:
    with open(path, "rb") as fh:
        yield from iter(lambda: fh.read(size), b"")
