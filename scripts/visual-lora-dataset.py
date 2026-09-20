#!/usr/bin/env python3
"""
audioMONASTRY · VISUAL-P1-007 – Schritt 3: Dataset-Bauer (Bilder + Captions)
===========================================================================
Baut aus `logs/lora/<datum>/curated-pairs.json` (Ausgabe von
`scripts/visual-lora-curate.py`) ein **LoRA-Datenset** in einem dokumentierten
Format: je Bild eine Bilddatei **und** eine Caption-Datei mit gleichem
Basisnamen plus eine `metadata.jsonl`.

Format (was die Trainer wirklich lesen)
---------------------------------------
    <dataset>/
      images/0001_<id8>.png      ← Bild (Bytes werden 1:1 kopiert, NICHT neu kodiert)
      images/0001_<id8>.txt      ← Caption (Trigger-Wort zuerst)
      metadata.jsonl             ← eine Zeile je Bild: {"file_name","text",…}
      dataset_config.toml        ← Konfiguration im Format von kohya-ss/sd-scripts
      dataset.json               ← Manifest: Anzahl, Filter, Prüfsummen, Herkunft
      README.md                  ← Format-Erklärung für den Trainer-Lauf
      dataset.tar.gz             ← nur mit --tar (deterministisch, mit sha256)

Warum genau diese drei Artefakte: das klassische Caption-Verfahren (Sidecar
`.txt` neben dem Bild) und das Listen-Verfahren (`metadata.jsonl`) werden von
gängigen LoRA-Trainern (kohya-ss/sd-scripts, ai-toolkit, musubi-tuner) gelesen;
die `dataset_config.toml` ist das kohya-Format für `--dataset_config`. Wer ein
anderes Trainer-Format braucht, hat damit Captions und Zuordnung schon vorliegen.

Herkunft der Bilder (wichtig, ehrlich)
--------------------------------------
Die Bilder der Generierungen liegen NICHT im Repo. Sie liegen in Cloudflare R2
(`visual_generations.r2_url`/`r2_key`) oder – wenn R2 nicht erreichbar war – in
der lokalen Artefakt-Ablage des Servers (`VISION_ARTIFACT_DIR`, Server-Fallback
aus `server/visionArtifacts.ts`). Ohne Bild keine Caption – Paare ohne
auffindbares Bild werden als `ohne_bilddatei` gemeldet und verworfen.

Aufruf
------
    # Bilder liegen lokal (z. B. aus der Artefakt-Ablage kopiert)
    python3 scripts/visual-lora-dataset.py --images-dir /pfad/zu/bildern

    # Bilder per HTTP holen (nur GET; R2-URLs aus dem Kurationslauf)
    python3 scripts/visual-lora-dataset.py --fetch --name cosmic-v1

    # Zuordnung von Hand (id → Datei)
    python3 scripts/visual-lora-dataset.py --image-map bilder.json

Ausgabe: logs/lora-dataset-<name>-<zeitstempel>/  (Name aus --name, sonst "pairs")

Exit-Codes
----------
  0 = Dataset geschrieben (mindestens ein Bild)
  2 = Aufruf-/Konfigurationsfehler
  3 = ehrliche Leermenge: 0 Bilder geschrieben (Gründe auf stderr + im Manifest)
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import pathlib
import re
import sys
import tarfile
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

ROOT = pathlib.Path(__file__).resolve().parent.parent
EXIT_OK = 0
EXIT_USAGE = 2
EXIT_EMPTY = 3

#: Bildendungen, die als Datei akzeptiert werden (die Bytes werden nicht geprüft –
#: eine falsch benannte Datei wird nicht stillschweigend "repariert").
IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg", ".webp")

#: Caption-Länge: LoRA-Trainer schneiden bei ~75-225 Tokens ab; 400 Zeichen
#: Prompt+Tags bleiben darunter und halten die Datei lesbar.
CAPTION_MAX_CHARS = 400
WHITESPACE = re.compile(r"\s+")


# ---------------------------------------------------------------------------
# kleine Helfer (rein, testbar)
# ---------------------------------------------------------------------------
def clean_text(value: Any, limit: int) -> str:
    """Einzeiliger, kompakter Text (Zeilenumbrüche/Tabs → Leerzeichen)."""
    text = WHITESPACE.sub(" ", str(value or "")).strip()
    return text[:limit].strip()


def build_caption(pair: Dict[str, Any], trigger: str) -> str:
    """Caption: Trigger-Wort zuerst, dann Prompt, dann Tags (dedupliziert).

    Das Trigger-Wort ist der Anker, den der Prompt später trägt
    (`stilname, <motiv>`) – ohne ihn lernt das LoRA den Stil nicht adressierbar.
    """
    parts: List[str] = []
    trigger = clean_text(trigger, 60)
    if trigger:
        parts.append(trigger)
    prompt = clean_text(pair.get("prompt"), CAPTION_MAX_CHARS)
    if prompt:
        parts.append(prompt)
    for tag in pair.get("tags") or []:
        tag = clean_text(tag, 40)
        if tag and tag.lower() not in ", ".join(parts).lower():
            parts.append(tag)
    return clean_text(", ".join(parts), CAPTION_MAX_CHARS)


def flatten_artifact_name(object_key: str) -> str:
    """R2-Objekt-Key → flacher Dateiname (Spiegel von `flattenArtifactName`)."""
    flat = "__".join(part for part in str(object_key or "").split("/") if part)
    flat = re.sub(r"[^A-Za-z0-9._-]", "-", flat)
    if len(flat) <= 120:
        return flat
    dot = flat.rfind(".")
    suffix = flat[dot:] if dot > 0 else ""
    return flat[: 120 - len(suffix)] + suffix


def sha256_of(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def find_local_image(pair: Dict[str, Any], images_dir: pathlib.Path) -> Optional[pathlib.Path]:
    """Bild zu einem Paar in einem Verzeichnis suchen.

    Reihenfolge: exakter Dateiname, 8-Zeichen-Präfix, flachgelegter R2-Key,
    zuletzt der Seed als Teil des Dateinamens (nur wenn er eindeutig ist).
    """
    generation_id = str(pair.get("generation_id") or "")
    candidates: List[str] = []
    if generation_id:
        candidates.extend(f"{generation_id}{suffix}" for suffix in IMAGE_SUFFIXES)
    image_key = str(pair.get("image_key") or "")
    if image_key:
        flat = flatten_artifact_name(image_key)
        candidates.append(flat)
        stem = flat[:-4] if flat.lower().endswith(IMAGE_SUFFIXES) else flat
        candidates.extend(f"{stem}{suffix}" for suffix in IMAGE_SUFFIXES)
    for candidate in candidates:
        path = images_dir / candidate
        if path.is_file():
            return path
    if generation_id:
        prefix = generation_id[:8]
        matches = sorted(
            path for path in images_dir.iterdir()
            if path.is_file() and path.name.startswith(prefix) and path.suffix.lower() in IMAGE_SUFFIXES
        )
        if len(matches) == 1:
            return matches[0]
    return None


def fetch_image(url: str, timeout: int = 120) -> bytes:
    """Bild per HTTP holen (ausschließlich GET – kein Schreibzugriff)."""
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "audiomonastry-visual-lora-dataset"},
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


# ---------------------------------------------------------------------------
# Dataset schreiben
# ---------------------------------------------------------------------------
def write_reproducible_tar(source_dir: pathlib.Path, target: pathlib.Path) -> None:
    """`tar.gz` mit stabiler Reihenfolge/mtime (gleiche Eingabe → gleicher Hash)."""
    names = sorted(path for path in source_dir.rglob("*") if path.is_file())
    with target.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as gz:
            with tarfile.open(fileobj=gz, mode="w", format=tarfile.GNU_FORMAT) as tar:
                for path in names:
                    info = tar.gettarinfo(str(path), arcname=str(path.relative_to(source_dir)))
                    info.mtime = 0
                    info.uid = info.gid = 0
                    info.uname = info.gname = ""
                    info.mode = 0o644
                    with path.open("rb") as handle:
                        tar.addfile(info, handle)


def write_dataset_config_toml(
    path: pathlib.Path,
    *,
    image_dir_in_pod: str,
    trigger: str,
    repeats: int,
    resolution: int,
    batch_size: int,
) -> None:
    """kohya-ss/sd-scripts-Dataset-Config (`--dataset_config`)."""
    path.write_text(
        f"""# audioMONASTRY · VISUAL-P1-007 – Stil-LoRA-Datensatz
# Format: kohya-ss/sd-scripts dataset config. Beim ersten echten Lauf gegen die
# im Pod installierte Trainer-Version prüfen (Schlüsselnamen ändern sich zwischen
# Trainer-Versionen) – die Datei ist eine Vorlage, keine gemessene Wahrheit.

[general]
caption_extension = ".txt"
keep_tokens = 1
shuffle_caption = false

[[datasets]]
resolution = {resolution}
batch_size = {batch_size}
enable_bucket = true

  [[datasets.subsets]]
  image_dir = "{image_dir_in_pod}"
  class_tokens = "{trigger}"
  num_repeats = {repeats}
""",
        encoding="utf-8",
    )


def write_readme(path: pathlib.Path, *, counts: Dict[str, Any], trigger: str, name: str) -> None:
    path.write_text(
        f"""# LoRA-Datensatz `{name}` (VISUAL-P1-007)

Gebaut von `scripts/visual-lora-dataset.py` aus den bestbewerteten
Prompt/Bild-Paaren (`curated-pairs.json`). Ticket: VISUAL-P1-007.

## Inhalt

| Datei | Bedeutung |
|---|---|
| `images/<nr>_<id8>.<endung>` | Bild, 1:1 kopiert (kein Re-Encoding, keine Skalierung) |
| `images/<nr>_<id8>.txt` | Caption: Trigger-Wort `{trigger}`, dann der Generierungs-Prompt, dann Tags |
| `metadata.jsonl` | eine JSON-Zeile je Bild (`file_name`, `text` + Herkunft: Bewertung, Stil, Seed) |
| `dataset_config.toml` | Vorlage für kohya-ss/sd-scripts (`--dataset_config`) |
| `dataset.json` | Manifest: Anzahl, Filter, Prüfsummen, Herkunft (maschinenlesbar) |
| `dataset.tar.gz` | Archiv (nur mit `--tar`): der eine Artefakt-Upload für den Pod |

## Zahlen dieses Datensatzes

- Paare in der Eingabe: {counts.get('pairs_in', 0)}
- Bilder geschrieben: **{counts.get('images_written', 0)}**
- Paare ohne Bilddatei: {counts.get('without_image', 0)}
- Captions geschrieben: {counts.get('captions_written', 0)}
- Trigger-Wort: `{trigger}`

## Nutzung im Pod

1. `dataset.tar.gz` auf das Netz-Volume entpacken (z. B. nach `/workspace/lora-dataset`).
2. Trainer mit dieser Caption-Quelle starten: Sidecar-`.txt` **oder** `metadata.jsonl`
   (je nach Trainer; beide beschreiben dasselbe Bild).
3. `dataset_config.toml` nur nach Prüfung der Pfade verwenden – `image_dir` muss auf
   den Pfad **im Pod** zeigen (Default im Skript: `/workspace/lora-dataset/images`).

## Ehrliche Grenzen

- Captions sind **deterministisch aus Prompt + Tags** gebaut – kein Sprachmodell,
  keine Umformulierung. Sind die Prompts dünn, sind es die Captions auch.
- Die Bilder sind Rohausgaben des FLUX-Workers (`imageHq`), also mit dessen
  Auflösung/Qualität. Es wird nichts hochskaliert oder beschnitten.
- Es wird **nichts** erfunden: fehlt ein Bild, wird das Paar gemeldet und verworfen,
  nicht ersetzt.
""",
        encoding="utf-8",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="visual-lora-dataset.py",
        description="Baut aus kuratierten Prompt/Bild-Paaren ein LoRA-Datenset (Bilder + Captions + Metadaten).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Exit-Codes: 0 = Dataset geschrieben, 2 = Aufruf-/Konfigfehler, 3 = 0 Bilder.\n"
            "Ausgabe: logs/lora-dataset-<name>-<zeitstempel>/"
        ),
    )
    parser.add_argument("--pairs", metavar="DATEI", default=None,
                        help="curated-pairs.json (Default: jüngste Datei unter logs/lora/).")
    parser.add_argument("--images-dir", metavar="DIR", default=None,
                        help="Verzeichnis mit den Bilddateien (Dateiname = Generierungs-ID bzw. flacher R2-Key).")
    parser.add_argument("--image-map", metavar="DATEI", default=None,
                        help='JSON {generation_id: pfad} – schlägt die Suche im Bilder-Verzeichnis.' )
    parser.add_argument("--fetch", action="store_true",
                        help="Fehlende Bilder per HTTP-GET von r2_url laden (nur Lesen).")
    parser.add_argument("--name", default="pairs", help="Name des Datensatzes (Default 'pairs').")
    parser.add_argument("--trigger", default="monkstyle",
                        help="Trigger-Wort für Captions/Trainer (Default 'monkstyle').")
    parser.add_argument("--repeats", type=int, default=10, help="num_repeats für die dataset_config (Default 10).")
    parser.add_argument("--resolution", type=int, default=1024, help="Trainingsauflösung für die dataset_config (Default 1024).")
    parser.add_argument("--batch-size", type=int, default=1, help="batch_size für die dataset_config (Default 1).")
    parser.add_argument("--image-dir-in-pod", default="/workspace/lora-dataset/images",
                        help="image_dir in der dataset_config (Pfad IM Pod, Default /workspace/lora-dataset/images).")
    parser.add_argument("--out", metavar="DIR", help="Zielverzeichnis (Default logs/lora-dataset-<name>-<zeitstempel>).")
    parser.add_argument("--tar", action="store_true", help="Zusätzlich dataset.tar.gz (deterministisch) schreiben.")
    parser.add_argument("--limit", type=int, default=0, help="Höchstzahl verwendeter Paare (0 = alle).")
    return parser


def newest_pairs_file() -> Optional[pathlib.Path]:
    base = ROOT / "logs" / "lora"
    if not base.exists():
        return None
    candidates = sorted(base.glob("*/curated-pairs.json"))
    return candidates[-1] if candidates else None


def load_pairs(path: pathlib.Path) -> List[Dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, dict):
        rows = payload.get("pairs") or []
    elif isinstance(payload, list):
        rows = payload
    else:
        raise ValueError(f"{path}: unbekannte Form (erwartet {{'pairs':[…]}} oder eine Liste)")
    return [row for row in rows if isinstance(row, dict)]


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)

    pairs_path = pathlib.Path(args.pairs) if args.pairs else newest_pairs_file()
    if not pairs_path or not pairs_path.exists():
        print(
            "FEHLER: keine Kurationsdatei gefunden. Erst laufen lassen:\n"
            "        python3 scripts/visual-lora-curate.py --from-json <export.json>",
            file=sys.stderr,
        )
        return EXIT_USAGE
    try:
        pairs = load_pairs(pairs_path)
    except (ValueError, json.JSONDecodeError) as exc:
        print(f"FEHLER: Kurationsdatei nicht lesbar: {exc}", file=sys.stderr)
        return EXIT_USAGE

    if args.limit and args.limit > 0:
        pairs = pairs[: args.limit]

    images_dir = pathlib.Path(args.images_dir) if args.images_dir else None
    if images_dir and not images_dir.is_dir():
        print(f"FEHLER: --images-dir ist kein Verzeichnis: {images_dir}", file=sys.stderr)
        return EXIT_USAGE

    image_map: Dict[str, str] = {}
    if args.image_map:
        map_path = pathlib.Path(args.image_map)
        if not map_path.exists():
            print(f"FEHLER: --image-map fehlt: {map_path}", file=sys.stderr)
            return EXIT_USAGE
        try:
            raw_map = json.loads(map_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            print(f"FEHLER: --image-map ist kein JSON: {exc}", file=sys.stderr)
            return EXIT_USAGE
        if not isinstance(raw_map, dict):
            print("FEHLER: --image-map muss ein JSON-Objekt {generation_id: pfad} sein", file=sys.stderr)
            return EXIT_USAGE
        image_map = {str(k): str(v) for k, v in raw_map.items()}

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    out_dir = pathlib.Path(args.out) if args.out else (ROOT / "logs" / f"lora-dataset-{args.name}-{stamp}")
    images_out = out_dir / "images"
    images_out.mkdir(parents=True, exist_ok=True)

    skipped: List[Dict[str, str]] = []
    metadata: List[Dict[str, Any]] = []
    index = 0

    for pair in pairs:
        generation_id = str(pair.get("generation_id") or "").strip()
        prompt = clean_text(pair.get("prompt"), CAPTION_MAX_CHARS)
        if not generation_id or not prompt:
            skipped.append({"generation_id": generation_id, "reason": "ohne_prompt_oder_id"})
            continue

        source: Optional[pathlib.Path] = None
        mapped = image_map.get(generation_id)
        if mapped and pathlib.Path(mapped).is_file():
            source = pathlib.Path(mapped)
        elif images_dir:
            source = find_local_image(pair, images_dir)
        if source is None and args.fetch and pair.get("image_url"):
            suffix = pathlib.Path(str(pair["image_url"]).split("?")[0]).suffix.lower()
            suffix = suffix if suffix in IMAGE_SUFFIXES else ".png"
            target = images_out / f"{index + 1:04d}_{generation_id[:8]}{suffix}"
            try:
                blob = fetch_image(str(pair["image_url"]))
            except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
                skipped.append({"generation_id": generation_id, "reason": f"download_fehlgeschlagen: {exc}"})
                continue
            if not blob:
                skipped.append({"generation_id": generation_id, "reason": "leere_antwort"})
                continue
            target.write_bytes(blob)
            source = target
        if source is None:
            skipped.append({"generation_id": generation_id, "reason": "ohne_bilddatei"})
            continue
        if source.stat().st_size == 0:
            skipped.append({"generation_id": generation_id, "reason": "leere_bilddatei"})
            if args.fetch and source.parent == images_out:
                source.unlink()
            continue

        index += 1
        suffix = source.suffix.lower() if source.suffix.lower() in IMAGE_SUFFIXES else ".png"
        image_name = f"{index:04d}_{generation_id[:8]}{suffix}"
        caption_name = f"{index:04d}_{generation_id[:8]}.txt"
        image_target = images_out / image_name
        if source != image_target:
            image_target.write_bytes(source.read_bytes())
        caption = build_caption(pair, args.trigger)
        (images_out / caption_name).write_text(caption + "\n", encoding="utf-8")

        metadata.append(
            {
                "file_name": f"images/{image_name}",
                "text": caption,
                # Zusatzfelder: Herkunft und Bewertung. Trainer lesen die ersten
                # beiden Schlüssel; der Rest ist Nachvollziehbarkeit (kein Ersatz
                # für eine echte Lizenz-/Rechteprüfung).
                "caption_file": f"images/{caption_name}",
                "generation_id": generation_id,
                "rating": pair.get("rating"),
                "votes": pair.get("votes"),
                "style": pair.get("style"),
                "seed": pair.get("seed"),
                "model": pair.get("model"),
                "tags": pair.get("tags") or [],
            }
        )

    (out_dir / "metadata.jsonl").write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in metadata), encoding="utf-8"
    )

    counts = {
        "pairs_in": len(pairs),
        "images_written": len(metadata),
        "captions_written": len(metadata),
        "without_image": sum(1 for row in skipped if row["reason"].startswith("ohne_bild")),
        "skipped": len(skipped),
    }

    write_dataset_config_toml(
        out_dir / "dataset_config.toml",
        image_dir_in_pod=str(args.image_dir_in_pod),
        trigger=clean_text(args.trigger, 60),
        repeats=int(args.repeats),
        resolution=int(args.resolution),
        batch_size=int(args.batch_size),
    )
    write_readme(out_dir / "README.md", counts=counts, trigger=clean_text(args.trigger, 60), name=str(args.name))

    files = sorted(path for path in out_dir.rglob("*") if path.is_file())
    manifest = {
        "schema": "visual-lora-dataset/1",
        "ticket": "VISUAL-P1-007",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "name": str(args.name),
        "trigger": clean_text(args.trigger, 60),
        "source": {"pairs_file": str(pairs_path), "pairs_sha256": sha256_of(pairs_path)},
        "format": {
            "sidecar_captions": "images/<nr>_<id8>.txt (UTF-8, eine Zeile)",
            "metadata": "metadata.jsonl (file_name, text, …)",
            "trainer_config": "dataset_config.toml (kohya-ss/sd-scripts-Vorlage, Pfade prüfen)",
        },
        "counts": counts,
        "skipped": skipped,
        "files": [
            {
                "path": str(path.relative_to(out_dir)),
                "bytes": path.stat().st_size,
                "sha256": sha256_of(path),
            }
            for path in files
        ],
    }

    tar_path: Optional[pathlib.Path] = None
    if args.tar:
        tar_path = out_dir / "dataset.tar.gz"
        write_reproducible_tar(out_dir, tar_path)
        manifest["archive"] = {
            "path": tar_path.name,
            "bytes": tar_path.stat().st_size,
            "sha256": sha256_of(tar_path),
            "note": "deterministisch (mtime/uid/gid normalisiert) – gleiche Eingabe, gleicher Hash",
        }

    (out_dir / "dataset.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    summary = {
        "out": str(out_dir.relative_to(ROOT)) if out_dir.is_relative_to(ROOT) else str(out_dir),
        "images": counts["images_written"],
        "pairs_in": counts["pairs_in"],
        "skipped": counts["skipped"],
        "archive": manifest.get("archive", {}).get("path"),
    }
    print(json.dumps(summary, ensure_ascii=False))

    if not metadata:
        reasons = sorted({row["reason"] for row in skipped}) or ["keine Paare in der Eingabe"]
        print(
            "FEHLER: 0 Bilder geschrieben – " + "; ".join(reasons) + ".",
            file=sys.stderr,
        )
        print(
            "        Bilder liegen nicht im Repo: sie kommen aus dem R2-Bucket (r2_url) oder aus der "
            "lokalen Artefakt-Ablage (VISION_ARTIFACT_DIR). Beides einmal bereitstellen "
            "(--images-dir, --image-map oder --fetch). Details: docs/VISUAL_LORA_TRAINING.md",
            file=sys.stderr,
        )
        return EXIT_EMPTY
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
