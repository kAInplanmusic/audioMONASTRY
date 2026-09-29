#!/usr/bin/env python3
"""Prueft eine LoRA-Datei technisch: ist sie wohlgeformt und hat sie den erwarteten Rang?"""
from __future__ import annotations

import json
import struct
import sys
import urllib.request
from pathlib import Path

import r2


def main() -> int:
    theme = sys.argv[1] if len(sys.argv) > 1 else "comic"
    key = f"lora-out/{theme}/{theme}.safetensors"
    c = r2._creds()
    url = r2.presign("GET", key, **c, expires=900)
    data = urllib.request.urlopen(url, timeout=600).read()
    Path(f"/tmp/{theme}.safetensors").write_bytes(data)
    print(f"{theme}: {len(data)} Bytes heruntergeladen")

    n = struct.unpack("<Q", data[:8])[0]
    hdr = json.loads(data[8 : 8 + n].decode("utf-8"))
    tensors = {k: v for k, v in hdr.items() if k != "__metadata__"}
    print("Tensoren:", len(tensors))

    meta = hdr.get("__metadata__", {})
    if meta:
        print("Metadaten (Auszug):")
        for k in list(meta)[:12]:
            print(f"    {k} = {str(meta[k])[:80]}")

    print("\nBeispiel-Tensoren:")
    for k in sorted(tensors)[:5]:
        print(f"    {k}  {tensors[k]['dtype']}  {tensors[k]['shape']}")

    ranks = set()
    for k, v in tensors.items():
        if "lora_A" in k or "lora_down" in k:
            ranks.add(v["shape"][0])
    print("\nLoRA-Rang:", sorted(ranks) or "(nicht erkannt)")

    last = max(v["data_offsets"][1] for v in tensors.values())
    ok = 8 + n + last == len(data)
    print(f"Struktur konsistent: {ok} (Header {8+n} + Daten {last} = {8+n+last} vs. Datei {len(data)})")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
