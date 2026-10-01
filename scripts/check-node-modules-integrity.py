#!/usr/bin/env python3
"""
Integritaetspruefung: lokale node_modules-Dateien gegen die veroeffentlichten
npm-Tarballs (package-lock.json -> resolved + integrity).

READ-ONLY: es wird nichts geschrieben ausser dem Report nach --out.
Kein root, keine Netz-Schreibzugriffe, keine Attribut-Vergleiche
(fuseblk/NTFS-3g schreibt 755/777, das ist kein Integritaetssignal).

Nutzung:
  python3 node-modules-integrity.py --scope testkette
  python3 node-modules-integrity.py --scope full --jobs 6
"""
from __future__ import annotations
import argparse, base64, hashlib, json, os, re, subprocess, sys, tarfile, io, tempfile, time
from concurrent.futures import ThreadPoolExecutor
from urllib.request import urlopen, Request

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
LOCK = os.path.join(ROOT, "package-lock.json")
NM = os.path.join(ROOT, "node_modules")

# Pfade der Testkette (vitest/expect/chai/vite/playwright + deren Verbuende)
SCOPE_PATTERNS = {
    "testkette": [
        r"^node_modules/(@vitest|vitest|chai|@vitest/[a-z-]+|tinyspy|tinyrainbow|@types/chai|chai-)",
        r"^node_modules/(vite|rollup|esbuild|@rollup/|fsevents|picomatch|postcss|nanoid|source-map|magic-string)",
        r"^node_modules/(@playwright|playwright|playwright-core|puppeteer|puppeteer-core|@puppeteer/)",
    ],
    "verdacht": [r"^node_modules/(@vitest/expect|chai)"],
    "full": [r"^node_modules/"],
}

MAX_TARBALL = 80 * 1024 * 1024  # Sicherung: ein einzelnes Riesenpaket darf den Lauf nicht sprengen


def sha512_b64(data: bytes) -> str:
    return "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()


def load_lock_packages() -> dict:
    with open(LOCK, "r", encoding="utf-8") as fh:
        lock = json.load(fh)
    return lock.get("packages", {})


def select(packages: dict, patterns: list[str]) -> list[tuple[str, dict]]:
    out = []
    for path, meta in packages.items():
        if not path.startswith("node_modules/"):
            continue
        if not meta.get("resolved") and not meta.get("version"):
            continue
        for pat in patterns:
            if re.search(pat, path):
                out.append((path, meta))
                break
    return out


def fetch_tarball(meta: dict) -> bytes | None:
    url = meta.get("resolved")
    if not url:
        return None
    try:
        req = Request(url, headers={"User-Agent": "integrity-check/1.0"})
        with urlopen(req, timeout=120) as fh:
            return fh.read()
    except Exception as exc:  # Netz-/Registry-Fehler nicht verschweigen
        print(f"    !Download fehlgeschlagen: {url} -> {exc}", file=sys.stderr)
        return None


def check_one(item: tuple[str, dict]) -> dict:
    path, meta = item
    name = meta.get("name") or path.split("node_modules/")[-1]
    version = meta.get("version")
    integrity = meta.get("integrity")
    local_dir = os.path.join(ROOT, path)
    res = {"path": path, "name": name, "version": version, "status": "?", "details": []}

    if not os.path.isdir(local_dir):
        res["status"] = "FEHLT-LOKAL"
        return res

    blob = fetch_tarball(meta)
    if blob is None:
        res["status"] = "NICHT-PRUEFBAR"
        return res

    if len(blob) > MAX_TARBALL:
        res["status"] = "UEBERSPRUNGEN-GROSS"
        res["details"].append(f"{len(blob)} bytes")
        return res

    actual = sha512_b64(blob)
    if integrity:
        res["tarball_integrity"] = "OK" if actual == integrity else "ABWEICHEND"
        if actual != integrity:
            res["details"].append(f"registry={integrity} geladen={actual}")

    # Tarball-Inhalt gegen lokalen Baum
    try:
        tf = tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz")
    except Exception as exc:
        res["status"] = "TARBALL-UNLESBAR"
        res["details"].append(str(exc))
        return res

    mismatched, missing, checked = [], [], 0
    for member in tf.getmembers():
        if not member.isfile():
            continue
        rel = member.name.split("/", 1)[1] if "/" in member.name else member.name
        target = os.path.join(local_dir, rel)
        checked += 1
        if not os.path.isfile(target):
            missing.append(rel)
            continue
        try:
            with open(target, "rb") as fh:
                local = fh.read()
        except Exception as exc:
            mismatched.append(f"{rel} (LESEFEHLER: {exc})")
            continue
        if hashlib.sha512(local).digest() != hashlib.sha512(member.tobytes() if False else b"").digest() or True:
            # echte Bytes des Tarball-Members lesen
            extracted = tf.extractfile(member)
            want = extracted.read() if extracted else b""
            if hashlib.sha512(local).digest() != hashlib.sha512(want).digest():
                mismatched.append(rel)
    tf.close()

    res["dateien_geprueft"] = checked
    res["abweichend"] = mismatched
    res["fehlend"] = missing
    if mismatched or missing:
        res["status"] = "KORRUPT"
    else:
        res["status"] = "OK"
    return res


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scope", default="testkette", choices=sorted(SCOPE_PATTERNS))
    ap.add_argument("--jobs", type=int, default=6)
    ap.add_argument("--out", default=f"/tmp/audioMONASTRY-integrity-{time.strftime('%Y%m%d-%H%M%S')}.json")
    ap.add_argument("--limit", type=int, default=0, help="nur die ersten N Pakete (Pilotlauf)")
    args = ap.parse_args()

    packages = load_lock_packages()
    work = select(packages, SCOPE_PATTERNS[args.scope])
    if args.limit:
        work = work[: args.limit]
    print(f"Scope={args.scope}  Pakete={len(work)}  Jobs={args.jobs}  Report={args.out}")

    results = []
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for n, res in enumerate(pool.map(check_one, work), 1):
            results.append(res)
            flag = {"OK": "ok", "KORRUPT": "KORRUPT", "FEHLT-LOKAL": "FEHLT", "NICHT-PRUEFBAR": "netz"}.get(res["status"], res["status"])
            print(f"[{n}/{len(work)}] {flag:8s} {res['name']}@{res['version']}" +
                  (f"  abweichend={len(res.get('abweichend') or [])} fehlend={len(res.get('fehlend') or [])}"
                   if res["status"] == "KORRUPT" else ""))

    summary = {
        "scope": args.scope,
        "zeitpunkt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "repo": ROOT,
        "pakete_geprueft": len(results),
        "dauer_s": round(time.time() - t0, 1),
        "ok": sum(1 for r in results if r["status"] == "OK"),
        "korrupt": [r for r in results if r["status"] == "KORRUPT"],
        "fehlt_lokal": [r["path"] for r in results if r["status"] == "FEHLT-LOKAL"],
        "nicht_pruefbar": [r["path"] for r in results if r["status"] != "OK" and r["status"] not in ("KORRUPT", "FEHLT-LOKAL")],
        "ergebnisse": results,
    }
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(summary, fh, ensure_ascii=False, indent=2)

    print("\n=== Zusammenfassung ===")
    print(f"OK: {summary['ok']}  KORRUPT: {len(summary['korrupt'])}  fehlt: {len(summary['fehlt_lokal'])}  nicht pruefbar: {len(summary['nicht_pruefbar'])}  Dauer: {summary['dauer_s']}s")
    for r in summary["korrupt"]:
        print(f"  KORRUPT {r['name']}@{r['version']}: {len(r['abweichend'])} abweichende, {len(r['fehlend'])} fehlende Dateien")
        for f in (r["abweichend"] or [])[:5]:
            print(f"      - {f}")
        for f in (r["fehlend"] or [])[:5]:
            print(f"      - (fehlt) {f}")
    print(f"Report: {args.out}")
    return 0 if not summary["korrupt"] else 1


if __name__ == "__main__":
    sys.exit(main())
