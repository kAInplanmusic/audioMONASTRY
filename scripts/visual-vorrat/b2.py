#!/usr/bin/env python3
"""Backblaze B2 als S3-kompatibler Speicher — nur stdlib (urllib + der SigV4-Rechner aus r2.py).

Warum: B2 wurde am 27.09.2026 in den Pool aufgenommen (0,006 USD/GB/Monat, ein
Achtel des RunPod-Network-Volumes). Es ist **Archiv und Quelle**, kein Mount: ein
Container kann B2 nicht als Verzeichnis sehen. Alles, was im Container liegen
soll, muss kopiert werden — von hier aus in ein Network Volume oder in ein Pod.

Zugangsdaten kommen aus der App-.env (`BB_KEY_ID`, `BB_MA_KEY`, `BB_ENDPOINT`,
`BB_BUCKET`) und werden **nie ausgegeben**.

Benutzung:
    python3 b2.py selftest                  # schreiben, lesen, vergleichen, aufraeumen
    python3 b2.py ls [prefix]               # Objekte auflisten
    python3 b2.py put <key> <datei>         # hochladen
    python3 b2.py get <key> [ziel]          # herunterladen (ohne ziel: nur Groesse)
    python3 b2.py presign GET <key> [sek]   # vorab signierte URL ausgeben

Achtung: `BB_MA_KEY` ist derzeit ein **Master Application Key** — nicht auf den
Bucket beschraenkt. Fuer den Dauerbetrieb gehoert ein auf `audioMONASTRY`
beschraenkter Key in die .env.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import r2  # noqa: E402  (nutzt nur den SigV4-Presigner, keine R2-Zugangsdaten)

REGION_HINT = "eu-central-003"


def _explain(exc: urllib.error.HTTPError) -> str:
    """B2-Fehler lesbar machen: Statuscode plus die XML-Antwort (ohne Zugangsdaten)."""
    try:
        body = exc.read().decode("utf-8", "replace")
    except Exception:  # noqa: BLE001 - Diagnose darf nie selbst scheitern
        body = ""
    return f"HTTP {exc.code}: {body[:400]}"


def credentials(env: dict[str, str] | None = None, *, master: bool = False) -> dict[str, str]:
    """B2-Zugangsdaten aus der App-.env. Fehlt etwas, wird das klar gemeldet.

    Standard sind die **S3**-Zugangsdaten (`BB_S3_KEY_ID`/`BB_S3_KEY`, auf einen
    Bucket beschraenkt). Mit ``master=True`` kommen die Verwaltungs-Zugangsdaten
    (`BB_KEY_ID`/`BB_MA_KEY`) — die braucht nur, wer Schluessel anlegt oder
    Buckets verwaltet, und die gehoeren **nicht** in einen Pod.

    Der Grund fuer die Trennung ist gemessen: die Account-ID des Kontos
    (`a05968581a09`) funktioniert an der **nativen** API, an der **S3**-API aber
    nicht (`InvalidAccessKeyId: Malformed Access Key Id` — derselbe Fehler mit
    eigener Signatur und mit rclone). Die S3-API braucht die *applicationKeyId*
    eines Application-Keys.
    """
    source = env if env is not None else r2.load_env()
    required = ("BB_KEY_ID", "BB_MA_KEY", "BB_ENDPOINT", "BB_BUCKET")
    missing = [k for k in required if not source.get(k)]
    if missing:
        raise SystemExit(f"B2 nicht konfiguriert: es fehlen {', '.join(missing)} in der .env")
    if not master and source.get("BB_S3_KEY_ID") and source.get("BB_S3_KEY"):
        key_id, secret = source["BB_S3_KEY_ID"], source["BB_S3_KEY"]
    else:
        if not master:
            raise SystemExit(
                "B2/S3 nicht konfiguriert: es fehlen BB_S3_KEY_ID und BB_S3_KEY in der .env. "
                "Anlegen mit: python3 b2.py mkscopedkey (die Account-ID BB_KEY_ID taugt fuer die "
                "S3-API nicht)."
            )
        key_id, secret = source["BB_KEY_ID"], source["BB_MA_KEY"]
    return {
        "access_key": key_id,
        "secret_key": secret,
        "endpoint": source["BB_ENDPOINT"],
        "bucket": source["BB_BUCKET"],
        "region": source.get("BB_REGION") or REGION_HINT,
    }


def presign(method: str, key: str, *, expires: int = 3600, creds: dict[str, str] | None = None) -> str:
    """Vorab signierte URL fuer ein Objekt (PUT/GET/DELETE/HEAD)."""
    c = creds or credentials()
    return r2.presign(
        method,
        key,
        endpoint=c["endpoint"],
        bucket=c["bucket"],
        access_key=c["access_key"],
        secret_key=c["secret_key"],
        region=c["region"],
        expires=expires,
    )


def put_file(path: pathlib.Path, key: str, *, creds: dict[str, str] | None = None) -> int:
    data = path.read_bytes()
    request = urllib.request.Request(presign("PUT", key, creds=creds), data=data, method="PUT")
    request.add_header("Content-Length", str(len(data)))
    with urllib.request.urlopen(request, timeout=300) as response:
        return response.status


def get_bytes(key: str, *, creds: dict[str, str] | None = None) -> bytes:
    with urllib.request.urlopen(presign("GET", key, creds=creds), timeout=300) as response:
        return response.read()


def list_keys(prefix: str = "", *, creds: dict[str, str] | None = None) -> list[tuple[int, str]]:
    """Objekte unter einem Prefix auflisten (SigV4 signiertes ListObjectsV2).

    ListObjectsV2 ist kein vorab signierbarer Aufruf mit Query-Auth ohne Body —
    deshalb hier die Signatur ueber den Authorization-Header, mit derselben
    Schlüsselableitung wie r2.presign (beide Wege ergeben dieselbe Signatur).
    """
    c = creds or credentials()
    host = urllib.parse.urlparse(c["endpoint"]).netloc
    query = {"list-type": "2", "max-keys": "1000"}
    if prefix:
        query["prefix"] = prefix
    canonical_query = "&".join(
        f"{urllib.parse.quote(k, safe='')}={urllib.parse.quote(v, safe='')}" for k, v in sorted(query.items())
    )
    now = dt.datetime.now(dt.timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")
    payload_hash = hashlib.sha256(b"").hexdigest()
    canonical_request = "\n".join(
        ["GET", f"/{c['bucket']}", canonical_query,
         f"host:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n",
         "host;x-amz-content-sha256;x-amz-date", payload_hash]
    )
    scope = f"{date_stamp}/{c['region']}/s3/aws4_request"
    string_to_sign = "\n".join(
        ["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(canonical_request.encode()).hexdigest()]
    )
    k_date = r2._sign(("AWS4" + c["secret_key"]).encode(), date_stamp)
    k_region = r2._sign(k_date, c["region"])
    k_service = r2._sign(k_region, "s3")
    k_signing = r2._sign(k_service, "aws4_request")
    signature = r2._sign(k_signing, string_to_sign).hex()
    authorization = (
        f"AWS4-HMAC-SHA256 Credential={c['access_key']}/{scope}, "
        f"SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature={signature}"
    )
    url = f"{c['endpoint']}/{c['bucket']}?{canonical_query}"
    request = urllib.request.Request(url, headers={
        "Authorization": authorization,
        "x-amz-content-sha256": payload_hash,
        "x-amz-date": amz_date,
    })
    with urllib.request.urlopen(request, timeout=120) as response:
        xml = response.read()
    root = ET.fromstring(xml)
    out: list[tuple[int, str]] = []
    for contents in root.iter():
        if contents.tag.endswith("Contents"):
            key = size = None
            for child in contents:
                if child.tag.endswith("Key"):
                    key = child.text or ""
                elif child.tag.endswith("Size"):
                    size = int(child.text or 0)
            if key is not None:
                out.append((size or 0, key))
    return out


def _authorize(creds: dict[str, str]) -> dict[str, str]:
    """Native B2-Autorisierung: Token, API-URL, Account-ID."""
    import base64
    import json

    token = base64.b64encode(f"{creds['access_key']}:{creds['secret_key']}".encode()).decode()
    request = urllib.request.Request(
        "https://api.backblazeb2.com/b2api/v3/b2_authorize_account",
        headers={"Authorization": f"Basic {token}"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        auth = json.loads(response.read().decode())
    return {
        "token": auth["authorizationToken"],
        "api_url": auth["apiInfo"]["storageApi"]["apiUrl"],
        "account_id": auth["accountId"],
    }


def _native_get(url: str, token: str) -> dict:
    import json

    request = urllib.request.Request(url, headers={"Authorization": token})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode())


def _env_append(pairs: dict[str, str], *, marker: str) -> None:
    """Werte an die App-.env anhaengen — idempotent, mit Backup, ohne Geheimnisse auszugeben."""
    env_path = r2.ENV_FILE
    text = env_path.read_text(encoding="utf-8")
    if marker in text:
        print(f"{marker} steht schon in der .env — nichts geaendert.")
        return
    backup = env_path.with_name(env_path.name + ".bak-s3key")
    backup.write_text(text, encoding="utf-8")
    with env_path.open("a", encoding="utf-8") as handle:
        handle.write("\n" + "".join(f"{k}={v}\n" for k, v in pairs.items()))
    print(f"in .env eingetragen (Backup: {backup.name})")


def create_scoped_key(
    key_name: str = "audiomonastry-visual-lora",
    bucket_name: str | None = None,
    *,
    write_env: bool = True,
) -> dict[str, str]:
    """Einen auf EINEN Bucket beschraenkten Application-Key anlegen.

    Der uebergebene Master-Key kann alles — Buckets anlegen und loeschen, alle
    Daten entfernen. Fuer den Dauerbetrieb ist das zu viel: dieser Key darf nur
    Dateien in einem Bucket lesen, schreiben, auflisten und loeschen.

    Die **applicationKeyId** ist zugleich der Zugangsschluessel der
    S3-kompatiblen API — dieser Schritt ist also nicht nur eine
    Sicherheitsverbesserung, sondern die Voraussetzung dafuer, dass B2
    ueberhaupt als S3-Speicher benutzt werden kann.
    """
    import json

    c = credentials(master=True)
    auth = _authorize(c)
    buckets = _native_get(
        f"{auth['api_url']}/b2api/v3/b2_list_buckets?accountId={auth['account_id']}", auth["token"]
    )
    target = bucket_name or c["bucket"]
    match = next((b for b in buckets.get("buckets", []) if b.get("bucketName") == target), None)
    if match is None:
        raise SystemExit(f"Bucket {target!r} nicht gefunden")

    payload = json.dumps({
        "accountId": auth["account_id"],
        "capabilities": ["listFiles", "readFiles", "writeFiles", "deleteFiles"],
        "keyName": key_name,
        "bucketId": match["bucketId"],
    }).encode()
    request = urllib.request.Request(
        f"{auth['api_url']}/b2api/v3/b2_create_key",
        data=payload,
        headers={"Authorization": auth["token"], "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        created = json.loads(response.read().decode())

    result = {
        "applicationKeyId": created["applicationKeyId"],
        "applicationKey": created["applicationKey"],
        "bucketId": match["bucketId"],
        "bucketName": target,
        "capabilities": ",".join(created.get("capabilities") or []),
    }
    print(f"Key angelegt: {result['applicationKeyId']} auf Bucket {target} ({result['capabilities']})")
    if write_env:
        _env_append(
            {
                "BB_S3_KEY_ID": result["applicationKeyId"],
                "BB_S3_KEY": result["applicationKey"],
                "BB_BUCKET_ID": result["bucketId"],
            },
            marker="BB_S3_KEY_ID=",
        )
    return result


def list_application_keys(*, creds: dict[str, str] | None = None) -> list[dict[str, str]]:
    """Application-Keys des Kontos auflisten (native B2-API, nicht S3).

    Warum das noetig ist: die **native** API akzeptiert das Paar
    Account-ID + Master-Application-Key. Die **S3-kompatible** API verlangt
    dagegen die *applicationKeyId* — eine andere Zeichenkette. Wer die
    Account-ID als S3-Zugangsschluessel einsetzt, bekommt
    `InvalidAccessKeyId: Malformed Access Key Id` (gemessen am 27.09.2026, auch
    mit rclone — es liegt also nicht an der Signatur).
    """
    c = creds or credentials(master=True)
    import base64
    import json

    token = base64.b64encode(f"{c['access_key']}:{c['secret_key']}".encode()).decode()
    request = urllib.request.Request(
        "https://api.backblazeb2.com/b2api/v3/b2_authorize_account",
        headers={"Authorization": f"Basic {token}"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        auth = json.loads(response.read().decode())
    api_url = auth["apiInfo"]["storageApi"]["apiUrl"]
    account_id = auth["accountId"]
    list_url = f"{api_url}/b2api/v3/b2_list_keys?accountId={account_id}&maxKeyCount=100"
    request = urllib.request.Request(
        list_url, headers={"Authorization": auth["authorizationToken"]}
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        data = json.loads(response.read().decode())
    out: list[dict[str, str]] = []
    for key in data.get("keys", []):
        out.append({
            "applicationKeyId": str(key.get("applicationKeyId", "")),
            "keyName": str(key.get("keyName", "")),
            "capabilities": ",".join(key.get("capabilities") or []),
            "bucketId": str(key.get("bucketId") or "-"),
        })
    return out


def selftest() -> int:
    creds = credentials()
    print(f"Bucket {creds['bucket']} @ {creds['endpoint']} (Region {creds['region']})")
    key = "audiomonastry/visual-lora-stack/_probe.txt"
    payload = b"B2 Schreib-/Lesetest 2026-09-27 - audioMONASTRY visual-lora-stack\n"
    try:
        print("PUT  status:", put_file_from_bytes(payload, key, creds=creds))
    except urllib.error.HTTPError as exc:
        print("PUT  FEHLER:", _explain(exc))
        return 1
    try:
        back = get_bytes(key, creds=creds)
        print("GET  status: 200 | identisch:", back == payload)
    except urllib.error.HTTPError as exc:
        print("GET  FEHLER:", _explain(exc))
        return 1
    try:
        request = urllib.request.Request(presign("DELETE", key, creds=creds), method="DELETE")
        with urllib.request.urlopen(request, timeout=60) as response:
            print("DELETE status:", response.status, "(aufgeraeumt)")
    except urllib.error.HTTPError as exc:
        print("DELETE FEHLER (nicht kritisch):", _explain(exc))
    ok = back == payload
    print("SELFTEST OK" if ok else "SELFTEST FEHLGESCHLAGEN")
    return 0 if ok else 1


def put_file_from_bytes(data: bytes, key: str, *, creds: dict[str, str] | None = None) -> int:
    request = urllib.request.Request(presign("PUT", key, creds=creds), data=data, method="PUT")
    with urllib.request.urlopen(request, timeout=300) as response:
        return response.status


def main() -> int:
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 2
    verb = args[0]
    if verb == "selftest":
        return selftest()
    if verb == "mkscopedkey":
        create_scoped_key()
        print("Jetzt pruefen: python3 b2.py selftest")
        return 0
    if verb == "keys":
        for key in list_application_keys():
            print(
                f"{key['applicationKeyId']:34} bucket={key['bucketId']:14} "
                f"{key['keyName'][:28]:28} {key['capabilities'][:70]}"
            )
        return 0
    if verb == "ls":
        prefix = args[1] if len(args) > 1 else ""
        rows = list_keys(prefix)
        for size, key in sorted(rows, key=lambda r: r[1]):
            print(f"{size/1048576:9.2f} MB  {key}")
        print(f"Objekte: {len(rows)}")
        return 0
    if verb == "put":
        key, path = args[1], pathlib.Path(args[2])
        print("PUT status:", put_file(path, key))
        return 0
    if verb == "get":
        key = args[1]
        data = get_bytes(key)
        if len(args) > 2:
            pathlib.Path(args[2]).write_bytes(data)
            print(f"geschrieben: {args[2]} ({len(data)} Bytes)")
        else:
            print(f"{key}: {len(data)} Bytes")
        return 0
    if verb == "presign":
        method, key = args[1], args[2]
        expires = int(args[3]) if len(args) > 3 else 86400
        print(presign(method, key, expires=expires))
        return 0
    print(f"unbekannt: {verb}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
