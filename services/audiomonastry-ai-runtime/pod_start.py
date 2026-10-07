"""Pod-Start: Gewichte holen → prüfen → entpacken → Runtime als HTTP-Dienst starten.

Ablauf (Startbefehl des Pods, gesetzt von `scripts/runpod-pods.py`):
  1. `AI_WEIGHTS_URLS` (JSON-Liste {name, url, sha256, size}) enthält Presigned-URLs
     auf die Gewichte-Archive der Rolle im Speicher (R2). Der Pod hat KEINE
     Speicher-Schlüssel, nur die zeitlich begrenzten URLs.
  2. Jede Datei wird parallel geladen, per SHA-256 geprüft und in `HF_HOME`
     entpackt (Archive enthalten `hub/models--<org>--<name>/…`).
  3. `HF_HUB_OFFLINE=1`: die Runtime lädt ausschließlich aus dem lokalen Cache.
     Es gibt keinen Rückgriff auf Hugging Face (Betreiber: keine Fallbacks).
  4. Start von uvicorn auf 0.0.0.0:PORT mit `AI_RESIDENT_ONLY=1`.

Fehlt eine Datei oder stimmt ein Hash nicht, bricht der Start ab (Exit != 0):
der Pod meldet nie „bereit" mit fehlenden Gewichten.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import tarfile
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List

CHUNK = 8 * 1024 * 1024


def log(level: str, msg: str, **fields: Any) -> None:
    print(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "level": level,
                      "service": "pod-start", "msg": msg, **fields}), flush=True)


def parse_entries(raw: str) -> List[Dict[str, Any]]:
    entries = json.loads(raw) if raw.strip() else []
    if not isinstance(entries, list):
        raise ValueError("AI_WEIGHTS_URLS muss eine JSON-Liste sein")
    for e in entries:
        if not isinstance(e, dict) or not all(k in e for k in ("name", "url", "sha256")):
            raise ValueError("jeder Eintrag braucht name, url, sha256")
        if "/" in e["name"] or "\\" in e["name"] or e["name"].startswith("."):
            raise ValueError(f"unsicherer Dateiname: {e['name']!r}")
    return entries


def download(entry: Dict[str, Any], dest_dir: str, retries: int = 3) -> str:
    path = os.path.join(dest_dir, entry["name"])
    for attempt in range(1, retries + 1):
        h = hashlib.sha256()
        try:
            with urllib.request.urlopen(entry["url"], timeout=120) as resp, open(path, "wb") as out:
                for block in iter(lambda: resp.read(CHUNK), b""):
                    h.update(block)
                    out.write(block)
            if h.hexdigest() != entry["sha256"]:
                raise ValueError(f"SHA-256 stimmt nicht für {entry['name']}")
            return path
        except Exception as exc:  # noqa: BLE001
            log("WARN", "download failed", file=entry["name"], attempt=attempt, error=type(exc).__name__)
            if attempt == retries:
                raise
            time.sleep(2 ** attempt)
    raise RuntimeError("unreachable")


def safe_extract(archive: str, target: str) -> None:
    """Entpackt nur Einträge innerhalb von `target` (kein Pfad-Ausbruch, keine Links nach außen)."""
    root = os.path.realpath(target)
    with tarfile.open(archive) as tar:
        for member in tar.getmembers():
            dest = os.path.realpath(os.path.join(root, member.name))
            if not (dest == root or dest.startswith(root + os.sep)):
                raise ValueError(f"unsicherer Pfad im Archiv: {member.name}")
            if member.issym() or member.islnk():
                link = os.path.realpath(os.path.join(os.path.dirname(dest), member.linkname))
                if not link.startswith(root + os.sep):
                    raise ValueError(f"Link zeigt aus dem Ziel heraus: {member.name}")
        try:
            tar.extractall(root, filter="data")  # zusätzlich zur Prüfung oben
        except TypeError:  # Python ohne tarfile-Filter
            tar.extractall(root)  # noqa: S202 – oben geprüft


def fetch_weights(entries: List[Dict[str, Any]], hf_home: str, workdir: str, parallel: int = 4) -> None:
    os.makedirs(hf_home, exist_ok=True)
    os.makedirs(workdir, exist_ok=True)
    need = sum(int(e.get("size", 0)) for e in entries) * 2
    free = shutil.disk_usage(workdir).free
    if need and free < need:
        raise RuntimeError(f"zu wenig Platz: {free // 2**30} GB frei, {need // 2**30} GB nötig")
    started = time.time()
    with ThreadPoolExecutor(max_workers=parallel) as pool:
        paths = list(pool.map(lambda e: download(e, workdir), entries))
    for path in paths:
        safe_extract(path, hf_home)
        os.remove(path)
    log("INFO", "weights ready", files=len(entries), seconds=round(time.time() - started, 1))


def main() -> int:
    hf_home = os.environ.setdefault("HF_HOME", "/workspace/hf-cache")
    try:
        entries = parse_entries(os.environ.get("AI_WEIGHTS_URLS", ""))
        if entries:
            fetch_weights(entries, hf_home, os.environ.get("AI_WEIGHTS_TMP", "/workspace/weights-tmp"))
        else:
            log("WARN", "AI_WEIGHTS_URLS leer – nur Gewichte, die im Image liegen, sind verfügbar")
    except Exception as exc:  # noqa: BLE001
        log("FATAL", "weights fetch failed", error=f"{type(exc).__name__}: {exc}")
        return 3
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ.setdefault("AI_RESIDENT_ONLY", "1")
    port = os.environ.get("PORT", "8000")
    log("INFO", "starting runtime", role=os.environ.get("AI_ROLE", ""), port=port)
    os.execvp("uvicorn", ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", port, "--workers", "1",
                          "--timeout-graceful-shutdown", "30"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
