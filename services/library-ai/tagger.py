#!/usr/bin/env python3
"""
Library-AI Tagger – GOOGLE/FIRESTORE-ENTKOPPELT.

Frueher wartete dieser Service auf Aufgaben in einer Firestore-`tasks`-Collection.
Jetzt arbeitet er rein LOKAL als Kommandozeilen-Tool:
    python tagger.py <audio_datei.wav> [--out ausgabe.json]

Analysiert eine Audiodatei (BPM, Tags) und schreibt das Ergebnis als JSON-Datei
lokal weg. Es besteht KEINERLEI Verbindung zu Firebase/Firestore/Google.
"""
import argparse
import hashlib
import json
import os
import time

import librosa


def safe_resolve(path: str) -> str:
    """Verhindert Pfad-Escape aus dem Arbeitsverzeichnis (pythonsecurity:S8707)."""
    full = os.path.realpath(path)
    base = os.path.realpath(os.getcwd())
    if full != base and not full.startswith(base + os.sep):
        raise ValueError(f"Pfad außerhalb des Arbeitsverzeichnisses: {path}")
    return full


def get_file_hash(file_path: str) -> str:
    # SHA-256 über den DATEIINHALT (nicht den Pfad) – für echtes Dedup.
    # Streaming in Chunks, damit auch große Dateien sparsam gehasht werden.
    safe_path = safe_resolve(file_path)
    h = hashlib.sha256()
    with open(safe_path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def tag_audio(file_path: str) -> dict:
    safe_path = safe_resolve(file_path)
    y, sr = librosa.load(safe_path)
    tempo, _ = librosa.beat.beat_track(y=y, sr=sr)

    tags = ["audio", "sample"]
    if tempo and tempo > 120:
        tags.append("fast")
    else:
        tags.append("slow")

    duration = float(len(y)) / float(sr) if sr else 0.0

    return {
        "bpm": float(tempo),
        "tags": tags,
        "duration_seconds": round(duration, 3),
        "sample_rate": int(sr),
        "indexed_at": time.time(),
    }

def main() -> None:
    parser = argparse.ArgumentParser(description="Lokaler Audio-Tagger (Google-frei).")
    parser.add_argument("file_path", help="Pfad zur Audiodatei (.wav/.mp3 etc.)")
    parser.add_argument("--out", default="tagged.json", help="Ausgabedatei fuer das JSON (default: tagged.json)")
    args = parser.parse_args()

    try:
        in_path = safe_resolve(args.file_path)
        out_path = safe_resolve(args.out)
    except ValueError as exc:
        print(f"Fehler: {exc}")
        raise SystemExit(1)

    if not os.path.exists(in_path):
        print(f"Fehler: Datei nicht gefunden: {in_path}")
        raise SystemExit(1)

    print(f"Analysiere {in_path} ...")
    metadata = tag_audio(in_path)
    result = {
        "hash": get_file_hash(in_path),
        "file_path": in_path,
        "metadata": metadata,
    }
    with open(out_path, "w") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    print(f"Fertig. Ergebnis in {out_path} geschrieben.")

if __name__ == "__main__":
    main()
