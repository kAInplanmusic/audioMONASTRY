#!/usr/bin/env python3
"""DOC-2026-10-13-001: redaktionelle Durchsicht der zurueckgeholten Dokumente.

Liest die Liste aus docs/README.md (Abschnitt 2), sammelt Backtick-Pfade je Datei
und prueft sie gegen den heutigen Baum (git ls-files + Dateisystem, inkl. Basisname).
Ausgabe: je Datei die Zahl toter Pfade und die Pfade selbst.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
README = os.path.join(ROOT, "docs", "README.md")

PATHISH = re.compile(r"`([^`\n]+)`")
# Nur Dinge, die wie ein Pfad aussehen - keine Befehle, keine Flags, keine URLs.
LOOKS_LIKE_PATH = re.compile(
    r"^(?:\./)?(?:docs|src|server|scripts|tests|services|deploy|workers|shared|database|ops)"
    r"/[A-Za-z0-9_./\-\[\]*]+$"
)


def tracked() -> set[str]:
    out = subprocess.check_output(["git", "ls-files"], cwd=ROOT, text=True)
    files = set(out.splitlines())
    bases = {os.path.basename(f) for f in files}
    return files | {"basename:" + b for b in bases}


def restored_docs() -> list[str]:
    text = open(README, encoding="utf-8").read()
    section = text.split("## 2.", 1)[1].split("## 3.", 1)[0] if "## 3." in text else text.split("## 2.", 1)[1]
    docs = []
    for token in PATHISH.findall(section):
        token = token.strip()
        if token.endswith(".md") and token.startswith(("docs/", "services/")):
            docs.append(token)
    seen, out = set(), []
    for d in docs:
        if d not in seen:
            seen.add(d)
            out.append(d)
    return out


def main() -> int:
    known = tracked()
    docs = restored_docs()
    print(f"wiederhergestellte Dokumente in docs/README.md: {len(docs)}")
    total_dead = 0
    dead_docs = 0
    for rel in docs:
        path = os.path.join(ROOT, rel)
        if not os.path.exists(path):
            print(f"MISSING FILE {rel}")
            continue
        text = open(path, encoding="utf-8", errors="replace").read()
        dead = []
        for token in PATHISH.findall(text):
            token = token.strip().split("#", 1)[0].strip()
            if not LOOKS_LIKE_PATH.match(token) or token in known:
                continue
            if "basename:" + os.path.basename(token.rstrip("/")) in known:
                continue
            # Verzeichnisnennung ist kein toter Dateipfad, solange es das
            # Verzeichnis im Baum gibt (mit oder ohne abschliessenden Slash).
            if os.path.isdir(os.path.join(ROOT, token.rstrip("/"))):
                continue
            if "*" in token or "[" in token:
                continue
            dead.append(token)
        if dead:
            dead_docs += 1
            total_dead += len(dead)
            print(f"\n{rel}: {len(dead)} tote Pfade")
            for d in sorted(set(dead)):
                print(f"   - {d}")
    print(f"\nSumme: {dead_docs} Dokumente, {total_dead} tote Pfadnennungen")
    return 0


if __name__ == "__main__":
    sys.exit(main())
