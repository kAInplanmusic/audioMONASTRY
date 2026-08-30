# midi-bridge (audioMONASTRY Sidecar)

Verbindet Hardware-MIDI mit der Web-App und OSC-fähigen Controllern.

- **MIDI-IN** (Controller/Keyboard) → WebSocket-Broadcast + OSC-Send
- **WebSocket** (Browser-Automation) → **MIDI-OUT**

## Start

```bash
cd services/midi-bridge
npm install          # kompiliert das native `midi`-Paket (Linux: libasound2-dev nötig)
MIDI_IN_NAME="Xonar" MIDI_OUT_NAME="Xonar" node index.js
```

## Env

| Variable | Default | Bedeutung |
|---|---|---|
| `MIDI_IN_NAME` | leer | Substring des MIDI-Inputs (sonst Port 0) |
| `MIDI_OUT_NAME` | leer | Substring des MIDI-Outputs (sonst Port 0) |
| `WS_PORT` | 9100 | WebSocket-Port |
| `OSC_HOST` | leer | OSC-Ziel (leer = deaktiviert) |
| `OSC_PORT` | 9000 | OSC-Port |

## WebSocket-Protokoll (JSON)

**Client → Server:**
```json
{ "type": "cc", "channel": 0, "controller": 7, "value": 100 }
{ "type": "noteOn", "channel": 0, "note": 60, "velocity": 100 }
{ "type": "noteOff", "channel": 0, "note": 60 }
{ "type": "pitchBend", "channel": 0, "value": 8192 }
{ "type": "nrpn", "channel": 0, "nrpn": 402, "value": 8192 }
{ "type": "sysex", "bytes": [125, 1, 2] }
```

**Server → Client:**
```json
{ "type": "midi", "bytes": [176, 7, 100] }
```

## OSC-Mapping (MIDI-IN → OSC)

- CC → `/midi/cc/{channel}/{cc}` (0..1)
- Note-On → `/midi/note/{channel}` (Note, Velocity 0..1)
- Pitch-Bend → `/midi/pitchbend/{channel}` (0..1)

## Docker

```bash
docker build -t samplemonk-midi-bridge .
docker run --rm -p 9100:9100 \
  -e MIDI_IN_NAME=Xonar -e MIDI_OUT_NAME=Xonar \
  --device /dev/snd \
  samplemonk-midi-bridge
```

Hinweis: Im Container brauchst du Zugriff auf ALSA (`--device /dev/snd`) bzw. die
Host-MIDI-Ports; unter macOS/Windows entsprechend CoreMIDI/WinMM (ohne ALSA).
