# Hardware-Protokoll-Spezifikation (8.2.1)

Generisches Control-Modell für USB/Netzwerk-Controller (MIDI/HID/OSC).

## ControlMessage
```ts
{ kind: 'noteOn' | 'noteOff' | 'cc' | 'pitch' | 'program' | 'osc',
  idNum: number, value: number, channel: number }
```
Referenz: `src/core/interfaces.ts`.

## Adapter
| Protokoll | Adapter | Anbindung |
|---|---|---|
| WebMIDI | `WebMIDIAdapter` | inkl. Program-Change 0xC |
| WebHID | `HIDAdapter` | Report → ControlMessage (Byte 0 = ID, Byte 1 = Wert/2) |
| OSC | `OSCAdapter` | WebSocket, `/control/<kind>/<id>/<value>[/<channel>]` |

## Entwicklung ohne Hardware
`src/core/hardware/HardwareSimulator.ts` emittiert identische ControlMessages
(Fader-Sweeps, Noten-Patterns, Program-Changes).

## Hot-Plug & Failover
`src/core/hardware/HotplugManager.ts` konserviert Geräte-Zustand bei Trennung
und stellt ihn bei Wiederanbindung wieder her (State-Preservation).
