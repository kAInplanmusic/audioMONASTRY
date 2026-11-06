#!/usr/bin/env bash
# SEC-2026-11-06-002: .env* im Repo-Root enthalten Roh-Secrets (API-Keys, Tokens).
# Sie gehoeren 0600 - fuer den Eigentuemer lesbar, sonst niemand.
#
# Aufruf:  bash scripts/fix-env-permissions.sh [verzeichnis]
#
# Grenze: Dateisysteme ohne POSIX-Modes (NTFS/exFAT ueber fuseblk, SMB ohne
# Unix-Extensions) quittieren `chmod` mit Exit 0, aendern aber nichts. Das Skript
# prueft das nach und warnt, statt faelschlich "OK" zu melden - dort hilft nur ein
# Wechsel auf ein POSIX-Dateisystem (oder ein Remount mit `permissions`).
set -euo pipefail

dir="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$dir"

shopt -s nullglob
files=(.env .env.*)
shopt -u nullglob

if ((${#files[@]} == 0)); then
  echo "keine .env* in $dir"
  exit 0
fi

rc=0
for f in "${files[@]}"; do
  [[ -f "$f" ]] || continue
  chmod 600 "$f" 2>/dev/null || true
  mode="$(stat -c '%a' "$f")"
  if [[ "$mode" == "600" ]]; then
    printf '  %-40s 600\n' "$f"
  else
    printf '  %-40s %s  (chmod 600 NICHT wirksam - Dateisystem ohne POSIX-Modes?)\n' "$f" "$mode"
    rc=1
  fi
done

if ((rc != 0)); then
  echo "WARNUNG: mindestens eine .env* ist weiterhin fuer Gruppe/Andere lesbar." >&2
fi
exit "$rc"
