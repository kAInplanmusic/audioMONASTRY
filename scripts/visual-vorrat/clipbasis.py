#!/usr/bin/env python3
"""CLIP-Bildmerkmale lokal auf der CPU - ONNX, kein torch, keine GPU, keine Kosten.

Warum dieses Modul existiert
---------------------------
Der fruehere Qualitaetsbefund ("8 flaechige LoRAs") war wertlos, weil er auf dem
Trainer-Probe-Bild beruhte. Eine echte Pruefung braucht Bilder aus einer eigenen
Inferenz-Pipeline UND ein Mass, das man vergleichen kann.

Damit diese Pruefung nicht wieder GPU-Geld kostet, laeuft sie hier lokal:
das CLIP-Modell liegt bereits unter /home/patrick/bildanalyse-modell.

Belegte Signatur (mit onnxruntime geprueft, nicht geraten):
    IN  pixel_values  [batch, 3, 224, 224]  tensor(float)
    OUT image_embeds  [batch, 512]          tensor(float)   <- bereits projiziert
Modell: openai/clip-vit-base-patch32 (config.json: projection_dim 512).
Vorverarbeitung exakt nach CLIPFeatureExtractor (preprocessor_config.json):
    RGB -> kuerzeste Kante 224 (bicubic, resample=3) -> center crop 224x224
        -> /255 -> normalize(mean, std)
"""
from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image

MODELL = Path(os.environ.get("CLIP_MODELL", "/home/patrick/bildanalyse-modell"))

# aus preprocessor_config.json
MEAN = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32)
STD = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32)
KANTE = 224


@lru_cache(maxsize=2)
def _sitzung(quantisiert: bool = True):
    """Die ONNX-Sitzung einmal je Prozess. Quantisiert ist 100 MB statt 351 MB
    und auf der CPU deutlich schneller - die Rangfolge der Bilder aendert das
    nicht (geprueft: gleiche Reihenfolge, Abweichung < 0.01 Kosinus)."""
    import onnxruntime as ort

    name = "vision_model_quantized.onnx" if quantisiert else "vision_model.onnx"
    pfad = MODELL / name
    if not pfad.exists():
        raise FileNotFoundError(f"CLIP-Vision-Modell fehlt: {pfad}")

    so = ort.SessionOptions()
    so.intra_op_num_threads = max(1, (os.cpu_count() or 4))
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(str(pfad), so, providers=["CPUExecutionProvider"])


def vorbereiten(img: Image.Image) -> np.ndarray:
    """Ein Bild -> CHW-Array [3, 224, 224], genau wie CLIPFeatureExtractor."""
    img = img.convert("RGB")
    b, h = img.size
    if b <= h:                      # kuerzeste Kante auf 224
        nb, nh = KANTE, max(KANTE, round(h * KANTE / b))
    else:
        nb, nh = max(KANTE, round(b * KANTE / h)), KANTE
    img = img.resize((nb, nh), Image.BICUBIC)
    l, o = (nb - KANTE) // 2, (nh - KANTE) // 2   # center crop
    img = img.crop((l, o, l + KANTE, o + KANTE))
    a = np.asarray(img, dtype=np.float32) / 255.0
    a = (a - MEAN) / STD
    return np.transpose(a, (2, 0, 1)).astype(np.float32)


def merkmale(bilder, quantisiert: bool = True, stapel: int = 8,
             still: bool = False) -> np.ndarray:
    """Bilder (PIL) -> L2-normierte Merkmale [n, 512]. Kosinus = Skalarprodukt."""
    if isinstance(bilder, Image.Image):
        bilder = [bilder]
    bilder = list(bilder)
    if not bilder:
        return np.zeros((0, 512), dtype=np.float32)

    sitzung = _sitzung(quantisiert)
    eingang = sitzung.get_inputs()[0].name
    teile: list[np.ndarray] = []
    for i in range(0, len(bilder), stapel):
        block = np.stack([vorbereiten(b) for b in bilder[i:i + stapel]])
        aus = sitzung.run(None, {eingang: block})[0]
        teile.append(np.asarray(aus, dtype=np.float32))
        if not still:
            print(f"    CLIP {min(i + stapel, len(bilder))}/{len(bilder)}", flush=True)
    m = np.concatenate(teile, axis=0)
    norm = np.linalg.norm(m, axis=1, keepdims=True)
    return m / np.maximum(norm, 1e-8)


def kosinus(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Kosinus zwischen allen Zeilen von a und b (a: [n,d], b: [m,d]) -> [n,m]."""
    return np.asarray(a, dtype=np.float32) @ np.asarray(b, dtype=np.float32).T


def mittelpunkt(m: np.ndarray) -> np.ndarray:
    """Zentrum einer Merkmalsmenge, wieder L2-normiert."""
    if len(m) == 0:
        return np.zeros(m.shape[1] if m.ndim == 2 else 512, dtype=np.float32)
    z = m.mean(axis=0)
    return z / max(float(np.linalg.norm(z)), 1e-8)


def selbstaehnlichkeit(m: np.ndarray) -> float:
    """Mittlere paarweise Kosinus-Aehnlichkeit innerhalb einer Menge (ohne Diagonale).
    Hoher Wert = die Bilder sehen sich alle gleich -> Modus-Kollaps / Ueberanpassung."""
    n = len(m)
    if n < 2:
        return float("nan")
    k = kosinus(m, m)
    iu = np.triu_indices(n, k=1)
    return float(k[iu].mean())


if __name__ == "__main__":          # kleiner Selbsttest
    import sys

    p = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
        "/home/patrick/lora-themen-2026-09-27/out-v3/comic/images")
    dateien = sorted(p.glob("*.jpg"))[:4]
    if not dateien:
        raise SystemExit(f"keine JPGs in {p}")
    m = merkmale([Image.open(d) for d in dateien], still=True)
    print(f"Selbsttest: {len(dateien)} Bilder aus {p}")
    print(f"  Merkmale: {m.shape}, Norm je Zeile = {np.linalg.norm(m, axis=1).round(4)}")
    print(f"  Selbstaehnlichkeit: {selbstaehnlichkeit(m):.3f}")
