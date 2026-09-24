#!/usr/bin/env python3
"""audioMONASTRY · VISUAL-P1-007 – Segment-Anbindung fuer den Trainer ai-toolkit.

WARUM: `scripts/lora/bootstrap.sh` exportiert die Angaben des Abschnitts als Env
(`LORA_SEGMENT_START/END`, `LORA_MAX_STEPS`, `LORA_SAVE_EVERY_STEPS`,
`LORA_RESUME_FROM`, `LORA_CHECKPOINT_DIR`) – aber KEIN Trainer liest Env. Ohne
Uebersetzung passiert genau das, was den ersten bezahlten Lauf gekostet hat: der
Pod trainiert seine eigene Konfiguration (dort `steps: 1500`, geplant waren
3700) und der Starter hat nichts, was er anzeigen koennte.

Dieses Werkzeug uebersetzt die Env in die Form, die ai-toolkit wirklich liest.
Alle Regeln stammen aus dem QUELLCODE (Klon von github.com/ostris/ai-toolkit,
Commit a8dfcf7), nicht aus Blogs:

  * `run.py` kennt die Schalter `config_file_list`, `-r/--recover`, `-n/--name`,
    `-l/--log` – es gibt KEIN `--resume` (Blogs behaupten das; der Quellcode
    nicht). Aufruf: `python run.py <config.yml>`.
  * Fortsetzen ist IMPLIZIT: `BaseSDTrainProcess.get_latest_save_path()` sucht in
    `save_root` das NEUESTE `<name>*.safetensors` (Sortierung nach
    Erstellungszeit!) und `load_training_state_from_metadata()` liest daraus
    `training_info.step`; die Schleife laeuft `range(start_step, train.steps)`
    (`BaseSDTrainProcess.py` Z. 826/887/2528).
    => `train.steps` ist ein ABSOLUTER Zielschritt, und der Resume-Checkpoint
    muss IM `save_root` liegen, nicht irgendwo.
  * `save_root = <training_folder>/<name>` (`BaseTrainProcess.py` Z. 45),
    Checkpoint-Dateiname `<name>_<9-stellig>.<ext>` (`save()`, Z. 506-525).
  * Die Optimierer-Zustaende werden NICHT mitgesichert (nur Netzgewichte +
    Schrittzahl) – eine ehrliche Grenze des Abschnittsbetriebs.

Befehle (alle ohne Netz, ohne GPU, ohne Kosten):

  patch          Basis-Konfiguration auf den Abschnitt patchen (steps absolut,
                 save_every, Bilderordner, Trainingsordner, Name)
  step           Schritt aus den safetensors-Metadaten eines Checkpoints lesen
  place-resume   Resume-Checkpoint in den `save_root` legen – und LAUT abbrechen,
                 wenn sein Metadaten-Schritt nicht zum Abschnittsanfang passt
                 (sonst wuerde bezahlte Arbeit doppelt laufen)
  collect        neuesten Checkpoint flach in ein Verzeichnis kopieren, damit
                 `bootstrap.sh` ihn (flacher Glob) hochladen kann

Exit-Codes: 0 = ok · 2 = Aufruf/Konfiguration · 3 = Datei/Metadaten fehlen ·
            4 = Widerspruch (Schritt passt nicht zum Abschnitt)
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import struct
import sys
from typing import Any, Dict, List, Optional

DEFAULT_SAVE_EVERY_FALLBACK = None  # bewusst kein Default: ohne Vorgabe bleibt der Wert der Konfiguration


# --- safetensors-Metadaten (Standard-Layout, ohne Zusatzbibliothek) ----------
def read_safetensors_metadata(path: str) -> Dict[str, Any]:
    """Liest den JSON-Header eines safetensors-Containers.

    Layout: 8 Byte little-endian Laenge, danach JSON-Header (Header-Laenge in
    Byte). Enthaelt `__metadata__` mit den ai-toolkit-Angaben.
    """
    with open(path, "rb") as handle:
        raw_len = handle.read(8)
        if len(raw_len) != 8:
            raise ValueError("Datei ist zu kurz fuer einen safetensors-Header")
        header_len = struct.unpack("<Q", raw_len)[0]
        if header_len <= 0 or header_len > 100 * 1024 * 1024:
            raise ValueError(f"unplausible Header-Laenge: {header_len}")
        header = json.loads(handle.read(header_len).decode("utf-8"))
    if not isinstance(header, dict):
        raise ValueError("Header ist kein JSON-Objekt")
    return header


def checkpoint_step(path: str) -> Optional[int]:
    """Schritt aus `__metadata__['training_info']` (JSON-String) – None, wenn
    der Checkpoint die Angabe nicht traegt."""
    meta = read_safetensors_metadata(path).get("__metadata__") or {}
    info = meta.get("training_info")
    if isinstance(info, str):
        try:
            info = json.loads(info)
        except Exception:
            return None
    if not isinstance(info, dict):
        return None
    raw_step = info.get("step")
    if raw_step is None or isinstance(raw_step, (dict, list)):
        return None
    try:
        return int(raw_step)
    except (TypeError, ValueError):
        return None


def safe_step(path: str) -> tuple[Optional[int], Optional[str]]:
    """Schritt lesen, ohne Ausnahme: (step, fehlertext). Eine kaputte oder
    fremde Datei ist ein ERWARTETER Fall (Upload halb durch, falsches Format) –
    sie darf keinen Stack-Trace produzieren, aber auch nicht still durchgehen."""
    try:
        return checkpoint_step(path), None
    except FileNotFoundError:
        return None, "Datei fehlt"
    except (ValueError, OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        return None, f"Datei nicht lesbar ({type(error).__name__}: {error})"


def save_root(training_folder: str, name: str) -> str:
    # BaseTrainProcess.py Z. 45: os.path.join(self.training_folder, self.name)
    return os.path.join(training_folder, name)


def checkpoint_filename(name: str, step: int) -> str:
    # save() Z. 517-524: f'{self.job.name}{step_num}.safetensors', 9-stellig
    return f"{name}_{str(step).zfill(9)}.safetensors"


# --- Konfiguration patchen ---------------------------------------------------
def load_lines(path: str) -> List[str]:
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read().splitlines()


def patch_key(lines: List[str], pattern: str, value: str, label: str) -> Dict[str, Any]:
    """Ersetzt GENAU EINE Zeile. Mehrere oder keine Treffer = lauter Abbruch:
    dieses Werkzeug raet nicht, welcher Eintrag gemeint ist."""
    rx = re.compile(pattern)
    hits = [i for i, line in enumerate(lines) if rx.match(line)]
    if len(hits) != 1:
        print(
            f"FEHLER: '{label}' hat {len(hits)} Treffer in der Konfiguration "
            f"(erwartet: genau 1) – Zeilen: {[h + 1 for h in hits]}. "
            "Konfiguration pruefen, statt zu raten.",
            file=sys.stderr,
        )
        raise SystemExit(2)
    index = hits[0]
    old = lines[index]
    match = re.match(r"^(\s*)", old)
    indent = match.group(1) if match else ""
    lines[index] = f"{indent}{value}"
    return {"key": label, "line": index + 1, "old": old.strip(), "new": lines[index].strip()}


def yaml_str(value: str) -> str:
    return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"') + '"'


def cmd_patch(args: argparse.Namespace) -> int:
    lines = load_lines(args.config)
    patched: List[Dict[str, Any]] = []

    patched.append(patch_key(lines, r"^\s+name:\s*\S+", f"name: {yaml_str(args.name)}", "config.name"))
    patched.append(
        patch_key(lines, r"^\s*training_folder:\s*\S+",
                  f"training_folder: {yaml_str(args.training_folder)}", "training_folder")
    )
    patched.append(
        patch_key(lines, r"^\s*(-\s*)?folder_path:\s*\S+",
                  f"folder_path: {yaml_str(args.images_dir)}", "datasets[0].folder_path")
    )
    # `steps:` (train) – bewusst NICHT `sample_steps:`: das Praefix steht vor dem
    # Wort, deshalb greift ^\s*steps: nur bei der Trainingsangabe.
    patched.append(patch_key(lines, r"^\s*steps:\s*\d+\s*$", f"steps: {args.steps}", "train.steps"))
    # GEMESSEN AM 2026-09-24 (L40S, 45 GB VRAM): ohne `dtype: "bf16"` im TRAIN-Block
    # laedt ai-toolkit das Modell in fp32 (~47 GB) und scheitert am
    # `transformer.to(cuda:0, dtype=dtype)` mit CUDA out of memory - auch auf einer
    # 48-GB-Karte. Der dtype des MODELS kommt aus `self.train_config.dtype`
    # (BaseSDTrainProcess.py, `self.sd = ModelClass(... dtype=self.train_config.dtype)`),
    # NICHT aus `model.dtype`. Die R2-Vorlage hatte den Schluessel nicht; hier wird
    # er garantiert, damit die Vorlage nie wieder in den fp32-Pfad laeuft.
    dtype_lines = [i for i, line in enumerate(lines) if re.match(r"^\s*dtype:\s*\S+", line)]
    if not dtype_lines:
        batch_idx = next(i for i, line in enumerate(lines) if re.match(r"^\s*batch_size:", line))
        indent_match = re.match(r"^(\s*)", lines[batch_idx])
        lines.insert(batch_idx + 1, f"{indent_match.group(1)}dtype: \"bf16\"")
        patched.append({"key": "train.dtype", "before": "(fehlte)", "after": 'dtype: "bf16"'})
    if args.save_every is not None:
        patched.append(
            patch_key(lines, r"^\s*save_every:\s*\d+\s*$", f"save_every: {args.save_every}", "save.save_every")
        )
    if args.resolution:
        patched.append(
            patch_key(lines, r"^\s*resolution:\s*\[.*\]\s*$", f"resolution: [{args.resolution}]",
                      "datasets[0].resolution")
        )
    if args.base_model:
        patched.append(
            patch_key(lines, r"^\s*name_or_path:\s*\S+", f"name_or_path: {yaml_str(args.base_model)}",
                      "model.name_or_path")
        )
    if args.disable_sampling:
        # `disable_sampling` ist in ai-toolkits eigener Beispielkonfiguration
        # dokumentiert (config/examples/train_lora_flux_24gb.yaml, "uncomment to
        # completely disable sampling"). Eingefuegt wird es direkt unter `steps:`:
        # gleiche Einrueckung, damit es im `train:`-Block bleibt.
        index = next(i for i, line in enumerate(lines) if line.strip().startswith("steps:")
                     and not line.strip().startswith("sample_steps"))
        indent_match = re.match(r"^(\s*)", lines[index])
        indent = indent_match.group(1) if indent_match else ""
        lines.insert(index + 1, f"{indent}disable_sampling: true")
        patched.append({"key": "train.disable_sampling", "line": index + 2, "old": "(fehlte)", "new": "disable_sampling: true"})

    with open(args.out, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")

    report = {
        "schema": "aitk-segment-patch/1",
        "config_in": os.path.abspath(args.config),
        "config_out": os.path.abspath(args.out),
        "name": args.name,
        "steps_absolute": args.steps,
        "training_folder": os.path.abspath(args.training_folder),
        "save_root": os.path.abspath(save_root(args.training_folder, args.name)),
        "images_dir": os.path.abspath(args.images_dir),
        "patched": patched,
        "note": "train.steps ist ein ABSOLUTER Zielschritt (ai-toolkit: range(start_step, steps)).",
    }
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        for entry in patched:
            print(f"[aitk] {entry['key']:<26} {entry['old']}  ->  {entry['new']}")
        print(f"[aitk] Konfiguration geschrieben: {report['config_out']}")
        print(f"[aitk] Resume-Ordner (save_root): {report['save_root']}")
    return 0


# --- Resume-Checkpoint setzen ------------------------------------------------
def cmd_step(args: argparse.Namespace) -> int:
    step, problem = safe_step(args.file)
    if step is None:
        print(f"FEHLER: {args.file}: {problem or 'kein training_info.step in den Metadaten'} "
              "(ai-toolkit wuerde bei Schritt 0 beginnen)", file=sys.stderr)
        return 3
    if args.json:
        print(json.dumps({"file": os.path.abspath(args.file), "step": step}, ensure_ascii=False))
    else:
        print(step)
    return 0


def cmd_place_resume(args: argparse.Namespace) -> int:
    if not os.path.isfile(args.file):
        print(f"FEHLER: Resume-Checkpoint fehlt: {args.file}", file=sys.stderr)
        return 3
    step, problem = safe_step(args.file)
    if step is None:
        print(f"FEHLER: {args.file}: {problem or 'kein training_info.step'} – ai-toolkit wuerde "
              "bei Schritt 0 beginnen und der Abschnitt waere bezahlte Doppelarbeit", file=sys.stderr)
        return 3
    if args.expect_start is not None and step != args.expect_start:
        print(f"FEHLER: Checkpoint steht auf Schritt {step}, der Abschnitt soll aber bei "
              f"{args.expect_start} beginnen. Abbruch statt Doppelarbeit.", file=sys.stderr)
        return 4
    target_dir = save_root(args.training_folder, args.name)
    os.makedirs(target_dir, exist_ok=True)
    # ai-toolkit globbt `<name>*.safetensors`; ein fremder Dateiname wird deshalb
    # auf die eigene Namenskonvention umbenannt (nur der Name, nicht der Inhalt).
    target = os.path.join(target_dir, checkpoint_filename(args.name, step))
    shutil.copy2(args.file, target)
    report = {"file": os.path.abspath(args.file), "step": step, "placed": os.path.abspath(target)}
    if args.json:
        print(json.dumps(report, ensure_ascii=False))
    else:
        print(f"[aitk] Resume-Checkpoint gesetzt: Schritt {step} -> {report['placed']}")
    return 0


def cmd_collect(args: argparse.Namespace) -> int:
    """Kopiert den neuesten Checkpoint FLACH in ein Zielverzeichnis.

    Grund: `bootstrap.sh` sucht `*.safetensors` direkt in `LORA_CHECKPOINT_DIR`
    (nicht rekursiv), ai-toolkit legt sie aber in `<training_folder>/<name>/` ab.
    """
    root = save_root(args.training_folder, args.name)
    if not os.path.isdir(root):
        print(f"FEHLER: save_root fehlt: {root} (hat der Trainer geschrieben?)", file=sys.stderr)
        return 3
    def step_of(path: str) -> int:
        value, _ = safe_step(path)
        return value if value is not None else -1

    candidates = [os.path.join(root, f) for f in os.listdir(root)
                  if f.startswith(args.name) and f.endswith(".safetensors")]
    if args.min_step is not None:
        candidates = [c for c in candidates if step_of(c) >= args.min_step]
    if not candidates:
        print(f"FEHLER: kein Checkpoint in {root} (Name {args.name}*, min-Schritt {args.min_step})", file=sys.stderr)
        return 3
    # Nach SCHRITT sortieren, nicht nach Zeit: der Metadaten-Schritt ist die
    # Wahrheit (ai-toolkit selbst sortiert nach Erstellungszeit – hier bewusst
    # nicht, damit ein kopierter Checkpoint die Reihenfolge nicht verdreht).
    newest = max(candidates, key=step_of)
    os.makedirs(args.into, exist_ok=True)
    target = os.path.join(args.into, os.path.basename(newest))
    shutil.copy2(newest, target)
    report = {"source": os.path.abspath(newest), "step": checkpoint_step(newest),
              "copied_to": os.path.abspath(target), "count": len(candidates)}
    if args.json:
        print(json.dumps(report, ensure_ascii=False))
    else:
        print(f"[aitk] Checkpoint gesammelt: Schritt {report['step']} -> {report['copied_to']}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="ai-toolkit an den Abschnittsbetrieb anbinden (VISUAL-P1-007)")
    sub = parser.add_subparsers(dest="command", required=True)

    p_patch = sub.add_parser("patch", help="Konfiguration auf den Abschnitt patchen")
    p_patch.add_argument("--config", required=True)
    p_patch.add_argument("--out", required=True)
    p_patch.add_argument("--name", required=True)
    p_patch.add_argument("--steps", type=int, required=True, help="ABSOLUTER Zielschritt (nicht die Abschnittslaenge)")
    p_patch.add_argument("--save-every", type=int, default=None)
    p_patch.add_argument("--images-dir", required=True)
    p_patch.add_argument("--training-folder", required=True)
    p_patch.add_argument("--base-model", default=None)
    p_patch.add_argument("--resolution", type=int, default=None)
    p_patch.add_argument("--disable-sampling", action="store_true")
    p_patch.add_argument("--json", action="store_true")
    p_patch.set_defaults(func=cmd_patch)

    p_step = sub.add_parser("step", help="Schritt aus den Checkpoint-Metadaten lesen")
    p_step.add_argument("--file", required=True)
    p_step.add_argument("--json", action="store_true")
    p_step.set_defaults(func=cmd_step)

    p_place = sub.add_parser("place-resume", help="Resume-Checkpoint in save_root legen")
    p_place.add_argument("--file", required=True)
    p_place.add_argument("--training-folder", required=True)
    p_place.add_argument("--name", required=True)
    p_place.add_argument("--expect-start", type=int, default=None)
    p_place.add_argument("--json", action="store_true")
    p_place.set_defaults(func=cmd_place_resume)

    p_collect = sub.add_parser("collect", help="neuesten Checkpoint flach kopieren")
    p_collect.add_argument("--training-folder", required=True)
    p_collect.add_argument("--name", required=True)
    p_collect.add_argument("--into", required=True)
    p_collect.add_argument("--min-step", type=int, default=None)
    p_collect.add_argument("--json", action="store_true")
    p_collect.set_defaults(func=cmd_collect)
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
