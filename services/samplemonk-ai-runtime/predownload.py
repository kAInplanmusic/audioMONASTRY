"""
SampleMONK AI Runtime – Gewichte vorladen (geteilt zwischen Build und Runtime)
=============================================================================
Ein Ort für die Logik, damit „ins Image backen" (Dockerfile) und „auf ein
Network Volume laden" (Worker-Task `predownload`) **identisch** arbeiten – sonst
driftet der Cache und das Vorladen greift nicht.

Kernpunkte:

- Lädt über `snapshot_download` in `HF_HOME` (Standard-Cache-Layout, das
  `from_pretrained(repo, revision=…)` offline wiederfindet).
- **Format-Auswahl:** bietet ein Repo `.safetensors`, werden die gleich großen
  `.bin`-Duplikate sowie TF/Flax/ONNX-Varianten übersprungen. Repos ohne
  `.safetensors` (z. B. CLAP) liefern weiterhin `.bin`. Das senkt den
  kuratierten Satz von ~105 GB auf ~36 GB.
- **Gruppen (`--group i --groups N`):** teilt die Dateien greedy nach
  kumulativer Größe auf N Gruppen. Damit kann das Dockerfile mehrere
  `RUN`-Schritte (und damit mehrere Layer) bauen, ohne dass ein einzelner
  Layer die Registry-Grenzen sprengt.

CLI:
  python predownload.py --role brain --groups 4              # alle Gruppen
  python predownload.py --role brain --group 0 --groups 4    # nur Gruppe 0
  python predownload.py --role ears --list                   # nur anzeigen
"""
from __future__ import annotations

import argparse
import os
import sys
from typing import Any, Dict, List, Tuple

#: Formate, die nur Duplikate anderer Gewichte sind.
IGNORE_ALWAYS = ["*.h5", "*.msgpack", "*.onnx", "*.tflite", "*.ot", "*.mlmodel", "*.fp32-*"]


def _repo_files(repo: str, revision: str) -> List[str]:
    from huggingface_hub import HfApi

    return list(HfApi().list_repo_files(repo_id=repo, revision=revision))


def select_ignore_patterns(names: List[str]) -> List[str]:
    """Überspringt `.bin` nur, wenn das Repo `.safetensors` hat."""
    ignore = list(IGNORE_ALWAYS)
    if any(n.endswith(".safetensors") for n in names):
        ignore.append("*.bin")
    return ignore


def _keep(names: List[str], ignore: List[str]) -> List[str]:
    """Wendet die Ignore-Patterns grob an (nur für die Gruppengröße nötig)."""
    import fnmatch

    out = []
    for n in names:
        if any(fnmatch.fnmatch(n, pat) for pat in ignore):
            continue
        out.append(n)
    return out


def _file_sizes(repo: str, revision: str, names: List[str]) -> Dict[str, int]:
    """Größen über die HF-API (bricht bei Fehlern auf 0 zurück)."""
    from huggingface_hub import HfApi

    sizes: Dict[str, int] = {n: 0 for n in names}
    try:
        info = HfApi().model_info(repo_id=repo, revision=revision, files_metadata=True)
        for sib in info.siblings or []:
            if sib.rfilename in sizes and sib.size:
                sizes[sib.rfilename] = int(sib.size)
    except Exception:  # noqa: BLE001
        pass
    return sizes


def selected_files(repo: str, revision: str) -> List[str]:
    """Dateien, die geladen werden sollen (Format-Auswahl bereits angewendet)."""
    names = _repo_files(repo, revision)
    return _keep(names, select_ignore_patterns(names))


def plan_groups(repo: str, revision: str, groups: int) -> List[List[str]]:
    """Teilt die zu ladenden Dateien greedy nach Größe auf `groups` Gruppen.

    Zweck: das Dockerfile kann so mehrere `RUN`-Schritte (= Layer) bauen, ohne
    dass ein einzelner Layer die Registry-Grenzen sprengt (Qwen3-14B fp16 hat
    8 Shards à ~4 GB).
    """
    keep = selected_files(repo, revision)
    sizes = _file_sizes(repo, revision, keep)
    ordered = sorted(keep, key=lambda n: -sizes.get(n, 0))
    buckets: List[Tuple[int, List[str]]] = [(0, []) for _ in range(max(1, groups))]
    for name in ordered:
        idx = min(range(len(buckets)), key=lambda i: buckets[i][0])
        total, items = buckets[idx]
        items.append(name)
        buckets[idx] = (total + sizes.get(name, 0), items)
    return [items for _total, items in buckets]


def download_group(repo: str, revision: str, files: List[str]) -> None:
    from huggingface_hub import snapshot_download

    if not files:
        print(f"  [skip] {repo}: keine Dateien in dieser Gruppe")
        return
    snapshot_download(repo_id=repo, revision=revision, allow_patterns=files, max_workers=8)


def role_targets(role: str, models: List[str] | None = None) -> List[Dict[str, Any]]:
    """Preload-Modelle der Rolle aus dem Rollen-Manifest (oder explizite Liste)."""
    from registry import load_manifest

    manifest = load_manifest(role or None)
    info = {m["id"]: m for m in manifest.get("models", [])}
    wanted = models if models else [mid for mid, m in info.items() if m.get("preload")]
    return [info[mid] for mid in wanted if mid in info]


def is_hf_repo(repo: str) -> bool:
    return bool(repo) and repo.count("/") == 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--role", default="")
    ap.add_argument("--groups", type=int, default=1)
    ap.add_argument("--group", type=int, default=-1, help="-1 = alle Gruppen")
    ap.add_argument("--models", default="", help="Komma-getrennte Modell-IDs statt Rollen-Preload")
    ap.add_argument("--list", action="store_true", help="nur Plan anzeigen, nichts laden")
    args = ap.parse_args()

    hf_home = os.environ.get("HF_HOME", "").strip() or "/data/hf-cache"
    os.environ.setdefault("HF_HOME", hf_home)
    os.makedirs(hf_home, exist_ok=True)

    models = [m for m in args.models.split(",") if m] or None
    targets = role_targets(args.role, models)
    print(f"[predownload] role={args.role or 'legacy'} hf_home={hf_home} models={[t['id'] for t in targets]}")

    total = 0
    for t in targets:
        repo, rev = str(t.get("repository") or ""), str(t.get("revision") or "")
        if not is_hf_repo(repo):
            print(f"  [skip] {t['id']}: kein HF-Repo ({repo or '-'})")
            continue
        groups = plan_groups(repo, rev, args.groups)
        for gi, files in enumerate(groups):
            if args.group >= 0 and gi != args.group:
                continue
            print(f"  [group {gi}/{args.groups}] {t['id']} ({repo}@{rev[:8]}): {len(files)} Dateien")
            for f in files:
                print(f"      - {f}")
            if not args.list:
                download_group(repo, rev, files)
            total += len(files)
    print(f"[predownload] fertig – {total} Dateien verplant")
    return 0


if __name__ == "__main__":
    sys.exit(main())
