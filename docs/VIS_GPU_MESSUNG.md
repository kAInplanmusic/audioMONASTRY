# vis · erste Messung auf echter GPU (RTX 4090, 2026-11-18)

Rohdaten: `docs/vis-gpu-test/rtx4090-2026-11-18/` (`results.json`, `summary.txt`).
Maschine: Vast-Instanz, 1× RTX 4090 (24 GB), Treiber 610.57, 12 vCPU, 32 GB RAM, Rumänien, ca. 0,44 $/h.
Lauf: `scripts/vis-gpu-selftest.py` in `nvidia/cuda:12.4.1-runtime` mit `NVIDIA_DRIVER_CAPABILITIES=all`,
Laufzeit rund 5 Minuten, 12 echte R2-Medien (6 Bilder, 6 Clips). Instanz danach zerstört.
Das ist die Testumgebung, nicht das gebaute vis-Image; der Nachweis am echten Image steht noch aus.

## Was funktioniert
- **WebGL auf der GPU nur mit `--use-angle=gl-egl`** (ANGLE/NVIDIA, OpenGL ES 3.2) oder `--use-angle=vulkan`.
  Ohne Flag und mit `--use-gl=egl` / `--use-angle=gl` fällt Chromium auf SwiftShader (Software) zurück.
- NVENC (`h264_nvenc`) läuft: 4 s 1080p30 in 0,55 s.
- Alle 25 Effekte kompilieren und rendern auf der GPU; 12/12 Medien geladen, keine übersprungen.
- Der Stream ist gültiger H.264 (1080p24/25/30 und 1440p30, ffprobe ok).

## Was das Ziel (24/25/30 fps) noch verfehlt
| Lauf | erreicht | späte Frames |
| --- | --- | --- |
| 1080p@30 NVENC | 19,1 fps | 269 / 383 |
| 1080p@25 NVENC | 18,2 fps | 235 / 364 |
| 1080p@24 NVENC | 18,3 fps | 233 / 367 |
| 1440p@30 NVENC | 16,6 fps | 333 / 333 |
| 1080p@30 libx264 | 15,5 fps | 206 |

Ursache liegt nicht im Shader: Ohne Effekt braucht ein 1080p-Frame 26 ms, mit Effekten 27–32 ms
(Regisseur mit bis zu 3 Effekten: 39,5 ms). Einzige Ausnahme `noise` mit 79,5 ms (grob 53 ms Aufpreis).
Die 26 ms Grundkosten sind Frame-Auslesen und JPEG-Kodierung (`toDataURL`) samt Übertragung, also CPU-seitig.
In der laufenden Session kommen Pipe und ffmpeg dazu, deshalb fallen 38 auf 19 fps.
Das ist eine Schlussfolgerung aus den Zeiten; die Aufteilung der 26 ms ist nicht einzeln gemessen.

## Nächste Schritte (nicht umgesetzt)
1. Frame-Pfad entlasten: Rohpixel (`readPixels`/Pixelpuffer) oder niedrigere JPEG-Qualität statt voller `toDataURL`-Kodierung,
   und Rendern/Übertragen/Encodieren überlappen.
2. Danach 1080p@30 erneut messen; erst dann 1440p bewerten.
3. `noise` vereinfachen oder nur bei niedriger Auflösung zulassen.
4. Wahl der Chromium-Flags (`--use-angle=gl-egl`) im Pod fest verdrahten, Vulkan als Rückfall.
5. Gleiche Messung am gebauten vis-Image und auf einer zweiten Karte (A40/L40/5090).
