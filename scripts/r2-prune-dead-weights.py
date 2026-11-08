#!/usr/bin/env python3
"""Loescht veraltete Modell-Gewichte aus dem R2-Bucket (nicht mehr in der Fleet).

Sicher: loescht nur die hier gelisteten Modell-Prefixe. Aktive Modelle
(brain/ears/voice/music/studio, plus on-demand in roles.models) stehen NICHT
in der Liste.
"""
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, "scripts")
import s3lite

NS = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}

DEAD = [
    # retiredRoles: imageHq, videoReal, videoAbstract
    "flux1-dev", "qwen-image-2512", "controlnet-canny", "controlnet-canny-video",
    "controlnet-depth", "controlnet-depth-video", "ip-adapter-image", "ip-adapter-video",
    "ltx-video-13b", "wan22-t2v-a14b", "realesrgan-x4", "realesrgan-video-x4", "rife-interpolation",
    # nie in der Pod-Fleet
    "bark-small", "bge-m3", "ministral-8b", "mistral-small-31", "phi-35-mini",
    "qwen3-30b-a3b", "qwen3-8b", "qwen3-14b", "gemma-3-4b", "llama-32-3b",
    # ersetzt
    "stable-audio-open-1.0", "mert-v1-330m",
]


def list_prefix(t, prefix):
    out, token = [], None
    while True:
        q = {"list-type": "2", "prefix": prefix, "max-keys": "1000"}
        if token:
            q["continuation-token"] = token
        status, _, body = t._request("GET", "", query=q)
        if status != 200:
            break
        root = ET.fromstring(body)
        for c in root.findall("s3:Contents", NS):
            out.append((c.find("s3:Key", NS).text, int(c.find("s3:Size", NS).text)))
        nt = root.find("s3:NextContinuationToken", NS)
        token = nt.text if nt is not None else None
        if not token:
            break
    return out


def main() -> int:
    t = s3lite.S3Target.from_r2_env()
    total_bytes = total_objs = failed = 0
    for model in DEAD:
        objs = list_prefix(t, f"weights/{model}/")
        if not objs:
            print(f"-  {model:28} (nichts vorhanden)", flush=True)
            continue
        size = sum(s for _, s in objs)
        for key, _ in objs:
            status, _, _ = t._request("DELETE", key)
            if status < 300:
                total_objs += 1
            else:
                failed += 1
        total_bytes += size
        print(f"OK {model:28} {len(objs):3} Obj  {size/1e9:7.2f} GB geloescht", flush=True)
    print(f"\nSumme: {total_objs} Objekte, {total_bytes/1e9:.2f} GB freigegeben, {failed} Fehler", flush=True)
    return 0 if not failed else 4


if __name__ == "__main__":
    sys.exit(main())
