#!/usr/bin/env python3
"""FLEET-P1-011 – ERSETZT (2026-10-24). NICHT MEHR VERWENDEN.

Dieses Skript maß die Agenten-Maschine statt des Pods: `device 0` bzw.
`nvidia-smi` lokal, und `simulate_concurrent_users` war ein `time.sleep` ohne
GPU-Wirkung. Es hat deshalb nur `{"error": "No such file or directory:
'nvidia-smi'"}` produziert (siehe MASTERTODOENDE FLEET-P1-011).

Die Messung läuft jetzt IM Pod:
  services/audiomonastry-ai-runtime/vram_probe.py  -> Sonde (torch/nvidia-smi)
  services/audiomonastry-ai-runtime/app.py         -> GET/POST /vram/report
  scripts/collect-vram-report.py                   -> Abholung je Rolle
    python3 scripts/collect-vram-report.py --group all

Dieser Aufruf bricht ab und schreibt keine Ergebnisdatei: eine lokale Zahl als
"A40-Messung" in test-results/ wäre schlimmer als keine Messung.
"""
import sys

NOTICE = (
    "vram_measure.py ist ersetzt: die Messung laeuft im Pod.\n"
    "  python3 scripts/collect-vram-report.py --group all\n"
    "(Sonde: services/audiomonastry-ai-runtime/vram_probe.py, Route /vram/report)"
)


def main() -> int:
    print(NOTICE, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
