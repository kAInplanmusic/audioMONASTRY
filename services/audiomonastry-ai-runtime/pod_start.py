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
    """Eintraege aus AI_WEIGHTS_URLS - zwei Formen, beide erlaubt:

    * TAR (bisher): `{"name": "<datei>.tar", "url": ..., "sha256": ...}` - wird nach
      HF_HOME entpackt.
    * Einzeldatei (neu, fuer den Edge-Spiegel): `{"path": "<repo-relativ>", "url": ...,
      "sha256": ..., "repo": "<org/name>", "commit": "<rev>"}` - wird im HF-Cache-Layout
      abgelegt (blobs/<sha256> + snapshots/<commit>/<pfad>, siehe place_file).
    """
    entries = json.loads(raw) if raw.strip() else []
    if not isinstance(entries, list):
        raise ValueError("AI_WEIGHTS_URLS muss eine JSON-Liste sein")
    for e in entries:
        if not isinstance(e, dict):
            raise ValueError("jeder Eintrag muss ein Objekt sein")
        if "path" in e:
            if not all(k in e for k in ("path", "url", "sha256", "repo", "commit")):
                raise ValueError("Datei-Eintrag braucht path, url, sha256, repo und commit")
            rel = str(e["path"])
            if rel.startswith("/") or "\\" in rel or any(part in ("", ".", "..") for part in rel.split("/")):
                raise ValueError(f"unsicherer Pfad: {rel!r}")
        else:
            if not all(k in e for k in ("name", "url", "sha256")):
                raise ValueError("jeder TAR-Eintrag braucht name, url, sha256")
            if "/" in e["name"] or "\\" in e["name"] or e["name"].startswith("."):
                raise ValueError(f"unsicherer Dateiname: {e['name']!r}")
    return entries


def hub_model_dir(hf_home: str, repo: str) -> str:
    """Verzeichnis des HF-Cache-Eintrags fuer ein Repo (`hub/models--org--name`)."""
    return os.path.join(hf_home, "hub", "models--" + repo.replace("/", "--"))


def place_file(entry: Dict[str, Any], local_path: str, hf_home: str) -> str:
    """Eine Einzeldatei ins HF-Cache-Layout legen (Blob + Snapshot-Symlink + refs).

    Der Blob-Name ist in diesem Layout der SHA256 der Datei - genau den liefert der
    Edge-Spiegel je Datei mit. `transformers` findet das Modell damit offline unter
    `revision=<commit>`, ohne dass ein TAR entpackt werden muss.
    """
    repo = str(entry["repo"])
    commit = str(entry["commit"])
    rel = str(entry["path"])
    sha = str(entry["sha256"])
    model_dir = hub_model_dir(hf_home, repo)
    blob = os.path.join(model_dir, "blobs", sha)
    os.makedirs(os.path.dirname(blob), exist_ok=True)
    if not os.path.exists(blob) or os.path.getsize(blob) != os.path.getsize(local_path):
        shutil.move(local_path, blob)
    snapshot = os.path.join(model_dir, "snapshots", commit, rel)
    os.makedirs(os.path.dirname(snapshot), exist_ok=True)
    if os.path.islink(snapshot) or os.path.exists(snapshot):
        os.remove(snapshot)
    os.symlink(os.path.relpath(blob, os.path.dirname(snapshot)), snapshot)
    refs = os.path.join(model_dir, "refs")
    os.makedirs(refs, exist_ok=True)
    for ref in {commit, "main"}:
        with open(os.path.join(refs, ref), "w", encoding="utf-8") as fh:
            fh.write(commit)
    return snapshot


def download(entry: Dict[str, Any], dest_dir: str, retries: int = 3) -> str:
    """Datei laden und den SHA256 pruefen.

    TAR-Eintraege landen unter ihrem `name`, Datei-Eintraege unter einem eindeutigen
    temporaeren Namen (Basename + SHA-Anfang), damit gleichnamige Dateien aus
    verschiedenen Repos sich nicht ueberschreiben.
    """
    if "path" in entry:
        base = str(entry["path"]).rsplit("/", 1)[-1]
        path = os.path.join(dest_dir, f"{str(entry['sha256'])[:12]}-{base}")
    else:
        path = os.path.join(dest_dir, entry["name"])
    for attempt in range(1, retries + 1):
        h = hashlib.sha256()
        try:
            with urllib.request.urlopen(entry["url"], timeout=120) as resp, open(path, "wb") as out:
                for block in iter(lambda: resp.read(CHUNK), b""):
                    h.update(block)
                    out.write(block)
            if h.hexdigest() != entry["sha256"]:
                raise ValueError(f"SHA-256 stimmt nicht für {entry.get('path') or entry.get('name')}")
            return path
        except Exception as exc:  # noqa: BLE001
            log("WARN", "download failed", file=entry.get("path") or entry.get("name") or "?",
                attempt=attempt, error=type(exc).__name__)
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
    """Alle Eintraege laden - TAR-Eintraege werden entpackt, Datei-Eintraege ins
    HF-Cache-Layout gelegt. Beide Formen duerfen gemischt auftreten."""
    os.makedirs(hf_home, exist_ok=True)
    os.makedirs(workdir, exist_ok=True)
    # Beim TAR liegen Gewichte doppelt (Archiv + entpackt), bei Einzeldateien einmal
    # (Temp-Datei wandert als Blob an ihren Platz) - die groessere Anforderung zaehlt.
    tar_bytes = sum(int(e.get("size", 0)) for e in entries if "path" not in e)
    file_bytes = sum(int(e.get("size", 0)) for e in entries if "path" in e)
    need = tar_bytes * 2 + file_bytes
    free = shutil.disk_usage(workdir).free
    if need and free < need:
        raise RuntimeError(f"zu wenig Platz: {free // 2**30} GB frei, {need // 2**30} GB nötig")
    started = time.time()
    with ThreadPoolExecutor(max_workers=parallel) as pool:
        paths = list(pool.map(lambda e: download(e, workdir), entries))
    placed = 0
    for entry, path in zip(entries, paths):
        if "path" in entry:
            place_file(entry, path, hf_home)
            placed += 1
        else:
            safe_extract(path, hf_home)
            os.remove(path)
    log("INFO", "weights ready", files=len(entries), placed_files=placed,
        archives=len(entries) - placed, seconds=round(time.time() - started, 1))


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
