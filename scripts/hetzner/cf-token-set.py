#!/usr/bin/env python3
"""Setzt EINEN Cloudflare-Token in alle lokalen Secret-Dateien ein, die ihn fuehren.

Warum: die fuenf Fundstellen in `.env.deploy` / `.env.portal` waren alle tot
(`1000 Invalid API Token`, gemessen mit scripts/hetzner/cf-token-diagnose.py).
fleet-preflight.sh sourct `.env.deploy` - ein dort veralteter Wert ueberschreibt
sogar einen gueltigen Token aus der Umgebung.

Eigenschaften:
  * Der Wert wird NIE ausgegeben (nur die Zahl geaenderter Zeilen).
  * Schreibt nur Schluessel, deren NAME in der Ziella liste steht (kein Raten).
  * Dateirechte bleiben unverandert (0600) - eine Sicherung wird angelegt.
  * Trockenlauf per Default.

Aufruf:
  python3 scripts/hetzner/cf-token-set.py --value-stdin            # Trockenlauf
  python3 scripts/hetzner/cf-token-set.py --value-stdin --apply    # schreiben
"""
from __future__ import annotations

import os
import pathlib
import shutil
import sys

REPO = pathlib.Path(os.environ.get("CF_REPO_ROOT", pathlib.Path(__file__).resolve().parent.parent.parent))
TARGETS = {
    ".env.deploy": ("CLOUDFLARE_API_TOKEN", "CF_API_KEY"),
    ".env.portal": ("CLOUDFLARE_API_TOKEN", "CF_API_KEY", "CF_ACCOUNT_TOKEN"),
}


def read_value() -> str:
    if "--value-stdin" in sys.argv[1:]:
        return sys.stdin.readline().strip()
    return os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()


def main() -> int:
    apply_changes = "--apply" in sys.argv[1:]
    value = read_value()
    if not value:
        print("kein Wert: --value-stdin (stdin) oder CLOUDFLARE_API_TOKEN setzen")
        return 1
    print(f"Wert: {len(value)} Zeichen, Praefix {value[:4]}… (wird nicht ausgegeben)")

    touched = 0
    for filename, keys in TARGETS.items():
        path = REPO / filename
        if not path.exists():
            print(f"  {filename}: fehlt (uebersprungen)")
            continue
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        changed_keys: list[str] = []
        for index, line in enumerate(lines):
            if "=" not in line or line.lstrip().startswith("#"):
                continue
            key = line.split("=", 1)[0].strip()
            if key in keys and line.split("=", 1)[1].strip() != value:
                lines[index] = f"{key}={value}"
                changed_keys.append(key)
        if not changed_keys:
            print(f"  {filename}: bereits aktuell ({', '.join(keys)})")
            continue
        if not apply_changes:
            print(f"  {filename}: wuerde setzen -> {', '.join(changed_keys)}")
            touched += 1
            continue
        backup = path.with_suffix(path.suffix + ".bak-cftoken")
        shutil.copy2(path, backup)
        mode = path.stat().st_mode & 0o777
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        os.chmod(path, mode or 0o600)
        print(f"  {filename}: gesetzt -> {', '.join(changed_keys)} (Sicherung {backup.name})")
        touched += 1

    if not touched:
        print("Nichts zu tun.")
    elif not apply_changes:
        print("Trockenlauf beendet - mit --apply schreiben.")
    print("Kontrolle: python3 scripts/hetzner/cf-token-diagnose.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
