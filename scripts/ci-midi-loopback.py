#!/usr/bin/env python3
"""
CI-MIDI-Loopback-Test (Linux)
=============================
Nutzt python-rtmidi + ALSA virmidi (snd-virmidi), um MIDI-Bytes durch echte
Kernel-Ports zu schicken und zu empfangen. Ohne virmidi/Ports wird mit
Exit-Code 2 (SKIP) beendet, damit CI-Jobs nicht hart fehlschlagen.

Aufruf:  python3 scripts/ci-midi-loopback.py
"""
import sys
import time


def main() -> int:
    try:
        import rtmidi  # type: ignore
    except ImportError:
        print("[midi-loopback] python-rtmidi fehlt – SKIP")
        return 2

    out = rtmidi.MidiOut()
    midi_in = rtmidi.MidiIn()
    out_ports = out.get_ports()
    in_ports = midi_in.get_ports()
    print("[midi-loopback] Outputs:", out_ports)
    print("[midi-loopback] Inputs:", in_ports)

    if not out_ports or not in_ports:
        print("[midi-loopback] Keine MIDI-Ports (snd-virmidi fehlt?) – SKIP")
        return 2

    out.open_port(0)
    midi_in.open_port(0)
    midi_in.ignore_types(sysex=False, timing=False, active_sense=False)

    received = []

    def on_message(event, data=None):
        msg, _dt = event
        received.extend(msg)

    midi_in.set_callback(on_message)

    payload = [0xB0, 7, 100]  # CC7 Volume Kanal 1
    out.send_message(payload)
    deadline = time.time() + 2.0
    while time.time() < deadline and len(received) < len(payload):
        time.sleep(0.01)

    midi_in.cancel_callback()
    if received[: len(payload)] == payload:
        print("[midi-loopback] OK:", received)
        return 0

    print("[midi-loopback] FEHLER: erwartet", payload, "erhalten", received)
    return 1


if __name__ == "__main__":
    sys.exit(main())
