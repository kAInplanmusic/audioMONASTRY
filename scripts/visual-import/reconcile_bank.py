#!/usr/bin/env python3
"""Gleicht die R2-Indizes (`bank-index.json`, `varianten-index.json`) mit dem
tatsächlichen Bucket-Inhalt ab (LIST statt Render-Annahmen) und repariert die
Befunde H2, M1, N1, N5 des Visual-Bank-Audits.

Grundsatz: Der **Bucket-Inhalt** ist die Wahrheit. Der Plan (`plan.json`) liefert
die reichen Metadaten (Lizenz, Attribution, Mood, Tags) für die m*/w*/p*/v*/n*-
Clips; die Alt-`b*`-Einträge behalten ihre Prompt/Motiv-Felder. Alles, was der
Bucket tatsächlich enthält, wird indexiert — nichts, was es nicht gibt.

Repariert je Clip:
* H2  – `varianten-index.json` enthält nur noch Varianten, die als Objekt
        existieren (keine „toten" URLs aus einem alten Vorlagen-Schema mehr);
        IDs, die im Bucket liegen, aber im Index fehlen (z. B. `b016`–`b034`),
        werden nachgetragen.
* M1  – `sekunden`/`laenge` werden per ffprobe aus der echten Datei gemessen
        (lokal für Plan-Clips, per presigned URL für `b*`).
* N1  – Graustufen-Clips (erkannt über gleichen ETag von `_grau`/`_hue15`)
        verlieren die redundante `hue15`-Variante; die Datei wird gelöscht.
* N5  – `start`-Feld für Clips mit `_start.jpg` (insbesondere `b*`).

Aufruf:
    python3 scripts/visual-import/reconcile_bank.py [--dry-run] [--drop-license-blocked]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, List, Optional, Tuple

REPO = "/mnt/wd-elements/Medien/Projekte/audioMONASTRY"
PLAN = os.path.join(REPO, ".visual-import", "plan.json")
PREFIX = "visuals/bank/"
BANK_KEY = "visuals/bank/bank-index.json"
VIDX_KEY = "visuals/bank/varianten-index.json"

#: Lizenzen ohne Weiterverbreitungsrecht (öffentliche Bank = Weiterverbreitung).
NOT_REDISTRIBUTABLE = ("coverr license", "unsplash license", "mixkit free license")

#: Bank-ID-Schema: `m01a`, `b000`, `w032`, `p016`, `v042`, oder `n<6 hex>`.
ID_RE = re.compile(r"^(n[0-9a-f]{6}|[a-z]\d+[a-z]?)$")


def load_r2():
    sys.path.insert(0, os.path.join(REPO, "scripts"))
    env = os.path.join(REPO, ".env")
    if os.path.exists(env):
        for line in open(env, "r", encoding="utf-8"):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    import s3lite
    return s3lite.S3Target.from_r2_env()


def public_url(key: str) -> str:
    # N4: keine hartcodierte r2.dev-URL — Basis kommt aus CFR2_PUBLIC_URL (.env).
    base = os.environ.get("CFR2_PUBLIC_URL", "").rstrip("/")
    if not base:
        sys.exit("CFR2_PUBLIC_URL fehlt in .env — keine öffentliche URL-Basis konfiguriert.")
    return f"{base}/{key}"


def run(cmd: List[str], timeout: int = 300) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


# --------------------------------------------------------------------- LIST
def list_bank(t) -> List[dict]:
    """Alle Objekte unter `visuals/bank/` per ListObjectsV2 (paginiert)."""
    objs: List[dict] = []
    token: Optional[str] = None
    while True:
        q = {"list-type": "2", "prefix": PREFIX, "max-keys": "1000"}
        if token:
            q["continuation-token"] = token
        status, _hdrs, body = t._request("GET", "", query=q)  # noqa: SLF001
        if status >= 300:
            raise RuntimeError(f"LIST error {status}: {body[:200]!r}")
        root = ET.fromstring(body)
        ns = "{http://s3.amazonaws.com/doc/2006-03-01/}"
        for c in root.findall(f"{ns}Contents"):
            objs.append({
                "key": c.findtext(f"{ns}Key"),
                "size": int(c.findtext(f"{ns}Size") or 0),
                "etag": c.findtext(f"{ns}ETag"),
            })
        if root.findtext(f"{ns}IsTruncated") == "true":
            token = root.findtext(f"{ns}NextContinuationToken")
        else:
            return objs


def parse_id(key: str) -> Optional[str]:
    name = key[len(PREFIX):]
    stem = name.rsplit(".", 1)[0]
    if ID_RE.match(stem):
        return stem
    if "_" in stem:
        head = stem.split("_", 1)[0]
        if ID_RE.match(head):
            return head
    return None


def group_objects(objs: List[dict]) -> Dict[str, dict]:
    by_id: Dict[str, dict] = {}
    for o in objs:
        cid = parse_id(o["key"])
        if not cid:
            continue
        e = by_id.setdefault(cid, {
            "base": None, "start": None, "variants": {}, "sizes": {}, "etags": {},
        })
        name = o["key"][len(PREFIX):]
        e["sizes"][name] = o["size"]
        e["etags"][name] = o["etag"]
        if name == f"{cid}.mp4":
            e["base"] = o["key"]
        elif name == f"{cid}_start.jpg":
            e["start"] = o["key"]
        elif name.endswith(".mp4") and name.startswith(cid + "_"):
            e["variants"][name[len(cid) + 1:-4]] = o["key"]
    return by_id


# ------------------------------------------------------------------ ffprobe
def _probe(source: str) -> Tuple[float, int]:
    r = run([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=nb_frames:format=duration", "-of", "json", source,
    ], timeout=180)
    try:
        j = json.loads(r.stdout or "{}")
    except json.JSONDecodeError:
        return (6.0, 180)
    st = (j.get("streams") or [{}])[0]
    dur = float((j.get("format") or {}).get("duration") or 0)
    frames = int(st.get("nb_frames") or 0) or round((dur or 6.0) * 30)
    return (round(dur, 2) if dur else 6.0, frames)


def probe_durations(by_id: Dict[str, dict], plan_by_id: Dict[str, dict], t) -> Dict[str, Tuple[float, int]]:
    """Plan-Clips lokal messen (schnell), `b*` per presigned URL (remote)."""
    local: Dict[str, str] = {}
    remote: List[str] = []
    for cid, e in by_id.items():
        if not e["base"]:
            continue
        base_path = (plan_by_id.get(cid) or {}).get("rendered", {}).get("base")
        if base_path and os.path.exists(base_path):
            local[cid] = base_path
        else:
            remote.append(cid)

    out: Dict[str, Tuple[float, int]] = {}

    def do_local(cid: str) -> Tuple[str, Tuple[float, int]]:
        return cid, _probe(local[cid])

    with ThreadPoolExecutor(max_workers=8) as ex:
        for cid, val in ex.map(do_local, list(local)):
            out[cid] = val

    for cid in remote:
        u = t.presign("GET", by_id[cid]["base"], expires=600)
        out[cid] = _probe(u)
    return out


# ------------------------------------------------------------------- build
def build_indices(by_id, plan_by_id, old_bank, durations, grayscale):
    new_bank: Dict = {}
    new_vidx: Dict = {}
    for cid in sorted(by_id):
        e = by_id[cid]
        if not e["base"]:
            continue
        variants = dict(e["variants"])
        if cid in grayscale:
            variants.pop("hue15", None)  # N1: redundante Variante entfernen
        dur, frames = durations.get(cid, (6.0, 180))

        plan_it = plan_by_id.get(cid)
        old = old_bank.get(cid, {})
        if plan_it:
            entry: Dict = {
                "name": cid,
                "datei": f"{cid}.mp4",
                "prompt_art": (plan_it.get("tags") or ["import"])[0],
                "prompt": plan_it.get("title", ""),
                "motiv": plan_it.get("title", ""),
                "quelle": plan_it.get("path", ""),
                "kategorie": plan_it.get("cat"),
                "mood": plan_it.get("mood"),
                "energy": plan_it.get("energy"),
                "tags": plan_it.get("tags", []),
                "license": plan_it.get("license", ""),
                "attribution": plan_it.get("attribution", ""),
                "source_url": plan_it.get("source_url", ""),
                "source": plan_it.get("source", ""),
            }
        else:
            # Alt-`b*`-Clip: Prompt/Motiv/Quelle aus dem Bestand übernehmen.
            entry = {
                "name": cid,
                "datei": f"{cid}.mp4",
                "prompt_art": old.get("prompt_art", "import"),
                "prompt": old.get("prompt", ""),
                "motiv": old.get("motiv", ""),
                "quelle": old.get("quelle", ""),
            }
            for f in ("kategorie", "mood", "energy", "tags", "license",
                      "attribution", "source_url", "source"):
                if old.get(f):
                    entry[f] = old[f]

        entry.update({
            "bytes": e["sizes"].get(f"{cid}.mp4", 0),
            "sekunden": dur,
            "laenge": frames,
            "url": public_url(e["base"]),
            "imported": True,
            "varianten": {v: public_url(k) for v, k in sorted(variants.items())},
        })
        if e["start"]:
            entry["start"] = public_url(e["start"])  # N5
        new_bank[cid] = entry
        new_vidx[cid] = {
            "quelle": f"{cid}.mp4",
            "varianten": {v: {"url": public_url(k)} for v, k in sorted(variants.items())},
        }
    return new_bank, new_vidx


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--drop-license-blocked", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    t = load_r2()
    plan: List[Dict] = json.load(open(PLAN, encoding="utf-8"))
    plan_by_id: Dict[str, Dict] = {i["cid"]: i for i in plan}

    # --- 1. Lizenz-Blocker (Coverr/Unsplash/Mixkit) entfernen ---------------
    dropped: List[str] = []
    if a.drop_license_blocked:
        keep = []
        for it in plan:
            lic = (it.get("license") or "").lower()
            if any(x in lic for x in NOT_REDISTRIBUTABLE):
                dropped.append(it["cid"])
                continue
            keep.append(it)
        plan = keep
        plan_by_id = {i["cid"]: i for i in plan}
        for cid in dropped:
            for v in ["base", "start.jpg"] + it_variants():
                key = (f"visuals/bank/{cid}_start.jpg" if v == "start.jpg"
                       else f"visuals/bank/{cid}.mp4" if v == "base"
                       else f"visuals/bank/{cid}_{v}.mp4")
                if not a.dry_run:
                    t._request("DELETE", key)  # noqa: SLF001
        if not a.dry_run:
            json.dump(plan, open(PLAN, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print(f"lizenzwidrig entfernt: {len(dropped)} {dropped}")

    # --- 2. Bucket listen und gruppieren ------------------------------------
    objs = list_bank(t)
    by_id = group_objects(objs)

    # Graustufen-Clips über gleichen ETag von _grau/_hue15 erkennen (N1).
    grayscale = {
        cid for cid, e in by_id.items()
        if e["etags"].get(f"{cid}_grau.mp4")
        and e["etags"].get(f"{cid}_hue15.mp4")
        and e["etags"][f"{cid}_grau.mp4"] == e["etags"][f"{cid}_hue15.mp4"]
    }

    # --- 3. Echte Längen messen (M1) ----------------------------------------
    durations = probe_durations(by_id, plan_by_id, t)

    # --- 4. Indizes neu aufbauen (H2/M1/N1/N5) ------------------------------
    old_bank = json.loads(t.get_bytes(BANK_KEY) or b"{}")
    new_bank, new_vidx = build_indices(by_id, plan_by_id, old_bank, durations, grayscale)
    for cid in dropped:
        new_bank.pop(cid, None)
        new_vidx.pop(cid, None)

    # --- 5. Redundante hue15-Dateien löschen (N1) ----------------------------
    deleted_hue15 = 0
    if not a.dry_run:
        for cid in sorted(grayscale):
            t._request("DELETE", f"visuals/bank/{cid}_hue15.mp4")  # noqa: SLF001
            deleted_hue15 += 1
            # Plan + gerenderte Referenz bereinigen, damit der generierte TS
            # die gelöschte Datei nicht mehr referenziert.
            it = plan_by_id.get(cid)
            if it:
                it.get("rendered", {}).pop("hue15", None)
                it.get("uploaded", {}).pop("hue15", None)

    if not a.dry_run and (grayscale or dropped):
        # Plan zurückschreiben, falls hue15/Lizenz-Drops ihn geändert haben.
        json.dump(plan, open(PLAN, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    # --- 6. Ergebnis ausgeben ------------------------------------------------
    b_keys = sum(1 for c in new_bank if c.startswith("b"))
    print(f"Bucket: {len(by_id)} IDs, Indizes: {len(new_bank)} bank / {len(new_vidx)} varianten")
    print(f"b*: {b_keys} im Index, grayscale-Clips (hue15 entfernt): {len(grayscale)} {sorted(grayscale)}")
    print(f"hue15-Dateien gelöscht: {deleted_hue15}")

    if a.dry_run:
        print("dry-run: nichts geschrieben")
        return
    t.put_bytes(BANK_KEY, json.dumps(new_bank, ensure_ascii=False, indent=1).encode(), "application/json")
    t.put_bytes(VIDX_KEY, json.dumps(new_vidx, ensure_ascii=False, indent=1).encode(), "application/json")
    print("Indizes auf R2 geschrieben")


def it_variants() -> List[str]:
    return ["loop", "quadrat", "wide", "slow", "fast", "mirror", "hue15", "grau"]


if __name__ == "__main__":
    main()
