#!/usr/bin/env python3
"""Schreibt gespeicherte R2-Public-URLs auf die same-origin Route um.

Hintergrund: `samples.url`, `music_tracks.url` und die Manifeste in
`data/r2-pakete/` zeigen auf `https://pub-<bucket>.r2.dev/<key>`. Sobald der
Public Access des Buckets abgeschaltet wird, sind diese Links tot. Die App
liefert dieselben Objekte über `GET /api/media/r2/<key>` aus (Studio-Cookie,
Range-fähig) — dieses Skript stellt die Verweise um.

Aufruf:
    python3 scripts/migrate-r2-urls.py --dry-run     # nur zählen
    python3 scripts/migrate-r2-urls.py               # DB + Manifeste
    python3 scripts/migrate-r2-urls.py --json-only   # nur data/r2-pakete/*.json

Umgebung: VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (oder SB_SERVICE_ROLE)
aus der `.env` des Repos. Es werden nur URLs mit dem Public-Host angefasst.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote, urlparse

REPO = "/mnt/wd-elements/Medien/Projekte/audioMONASTRY"
TABLES = [("samples", "url"), ("music_tracks", "url")]
PROXY_PREFIX = "/api/media/r2/"


def env() -> dict:
    out = {}
    path = os.path.join(REPO, ".env")
    if os.path.exists(path):
        for line in open(path, encoding="utf-8"):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                out.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    return out


def rewrite(url: str) -> str:
    """Public-URL -> Proxy-Pfad (key bleibt identisch, inkl. Unterordner)."""
    try:
        u = urlparse(url)
    except ValueError:
        return url
    if not u.netloc.endswith(".r2.dev"):
        return url
    key = u.path.lstrip("/")
    if not key:
        return url
    return PROXY_PREFIX + "/".join(
        quote(seg, safe="") for seg in key.split("/")
    )


class Supabase:
    def __init__(self, url: str, key: str) -> None:
        self.base = url.rstrip("/") + "/rest/v1"
        self.key = key

    def _req(self, path: str, method="GET", body: bytes | None = None, extra: dict | None = None):
        headers = {"apikey": self.key, "Authorization": f"Bearer {self.key}",
                   "Accept": "application/json", "Content-Type": "application/json"}
        headers.update(extra or {})
        req = urllib.request.Request(self.base + path, data=body, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.status, r.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()[:300]

    def rows(self, table: str, column: str) -> list[dict]:
        out: list[dict] = []
        offset = 0
        while True:
            st, body = self._req(f"/{table}?select=id,{column}&{column}=not.is.null&limit=1000&offset={offset}")
            if st != 200:
                print(f"  {table}: LESEN fehlgeschlagen ({st}) {body[:120]}")
                return out
            chunk = json.loads(body or "[]")
            out.extend(chunk)
            if len(chunk) < 1000:
                return out
            offset += 1000

    def patch(self, table: str, column: str, row_id: str, value: str) -> bool:
        st, _ = self._req(f"/{table}?id=eq.{quote(row_id, safe='')}", "PATCH",
                          json.dumps({column: value}).encode(),
                          {"Prefer": "return=minimal"})
        return st in (200, 204)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--json-only", action="store_true")
    ap.add_argument("--workers", type=int, default=8)
    a = ap.parse_args()

    e = env()
    url = e.get("VITE_SUPABASE_URL") or e.get("VITE_SB_URL")
    key = e.get("SUPABASE_SERVICE_ROLE_KEY") or e.get("SB_SERVICE_ROLE")

    total_db = 0
    if not a.json_only:
        if not (url and key):
            print("Supabase nicht konfiguriert — nur Manifeste.")
        else:
            sb = Supabase(url, key)
            for table, column in TABLES:
                rows = sb.rows(table, column)
                todo = [(r["id"], rewrite(r[column])) for r in rows
                        if isinstance(r.get(column), str) and ".r2.dev/" in r[column]]
                print(f"{table}.{column}: {len(rows)} Zeilen, {len(todo)} mit Public-URL")
                if a.dry_run or not todo:
                    continue
                with ThreadPoolExecutor(max_workers=a.workers) as ex:
                    ok = list(ex.map(lambda t: sb.patch(table, column, t[0], t[1]), todo))
                total_db += sum(1 for x in ok if x)
                print(f"  umgeschrieben: {sum(1 for x in ok if x)}/{len(todo)}")

    changed_files = 0
    for path in sorted(glob.glob(os.path.join(REPO, "data", "r2-pakete", "*.json"))):
        raw = open(path, encoding="utf-8").read()
        if ".r2.dev/" not in raw:
            continue
        new = re.sub(r'https://[a-z0-9-]+\.r2\.dev/', PROXY_PREFIX, raw)
        hits = raw.count(".r2.dev/")
        if a.dry_run:
            print(f"{os.path.basename(path)}: {hits} URLs")
            continue
        open(path, "w", encoding="utf-8").write(new)
        changed_files += 1
        print(f"{os.path.basename(path)}: {hits} URLs umgeschrieben")

    if a.dry_run:
        print("dry-run: nichts geschrieben")
    else:
        print(f"fertig: DB {total_db} Zeilen, {changed_files} Manifeste")
        if total_db == 0 and changed_files == 0:
            sys.exit(0)


if __name__ == "__main__":
    main()
