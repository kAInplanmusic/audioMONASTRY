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

---

# Mapping-Layer (MIDI-P2-001)

Der Mapping-Layer verbindet **abstrakte Ziele** (`mixer.channel3.volume`) mit
**physischen Bedienelementen** — und ist der einzige Ort, an dem ein Controller
auf den hörbaren Pfad wirkt.

## Kette

```
USB-MIDI/HID/OSC
   │  Adapter (midiAccess.ts, HIDAdapter, oscBridge.ts)
   ▼
ControlEvent { sourceProtocol, sourceDevice, channel, parameter, value, resolution, messageType }
   │  MappingEngine.map(ev)                      ← Regeln: src/core/mapping/MappingEngine.ts
   ▼
MappedParameter[] { ruleId, target, value01 }
   │  applyMappedParameter(target, value)        ← Dispatcher: src/hooks/useMappingApply.ts
   ▼
audioEngine.setChannelGain/… | setMasterVolume | setWorkletParam   → V2-Live-Pfad
```

Wichtig: Die Engine kennt **keine** Engine-Aufrufe, der Dispatcher kennt **keine**
Geräte. Diese Trennung macht Mappings transportagnostisch und in Tests prüfbar.

## Dateien

| Aufgabe | Datei |
|---|---|
| Regeln + Wertelogik (absolut/relativ), Zustand pro Regel | `src/core/mapping/MappingEngine.ts` |
| Persistenz + Export/Import (Mappings überleben Reloads) | `src/core/mapping/MappingStore.ts` |
| Learn-Modus, Regel-CRUD, Live-Mapping | `src/hooks/useMapping.ts` |
| Ziel-Auflösung → Engine-Aufruf, Liste der gültigen Ziele | `src/hooks/useMappingApply.ts` |
| UI (Learn-Panel) | `src/components/midi/MappingLearnPanel.tsx` |
| Rohdaten → ControlEvent (MIDI inkl. 14-Bit/Program-Change) | `src/core/hardware/midiCodec.ts`, `src/utils/midiAccess.ts` |
| MIDI-Ausgang (Clock/Feedback) | `src/utils/midiOut.ts`, `src/core/hardware/midiClockOut.ts` |

## Unterstützte Ziele (vom Dispatcher)

- `mixer.channel1..8.volume` — Kanal-Lautstärke (0…1, geklemmt)
- `mixer.channel1..8.pan` — Pan, intern auf −1…1 gerechnet
- `master.volume` — Master
- `worklet.<param>` — generischer Worklet-Parameter (leerer Parameter = **kein**
  Erfolg, kein stiller No-Op)

Alles andere wird mit `false` abgewiesen — der Aufrufer darf sich nicht auf
stille Wirkung verlassen.

## Learn-Modus

1. Learn starten (`useMapping.setLearning(true)`), Ziel und Art (absolut/relativ)
   wählen.
2. Ein beliebiges ControlEvent (echtes Gerät **oder** `HardwareSimulator`) wird
   zu einer Regel: `{ sourceProtocol, sourceDevice, channel, parameter, target, kind }`.
3. Die Regel wird im Store persistiert und ist sofort live (`exportJson()` /
   Import für Sicherung und Übertrag auf andere Rechner).

## Prüfstand (Stand 2026-09-11)

| Bereich | Test | Art |
|---|---|---|
| Codec (MIDI/HID/OSC/UMP) | `midiCodec`, `hidReport`, `oscCodec`, `ump`, `midi` | virtuell, byte-genau |
| Mapping-Engine + Store + Übersetzung | `mappingEngine`, `translationLayer`, `hardwareControlEvent` | virtuell |
| **Ziel-Auflösung + Learn-Hook** | `tests/mappingApply.test.tsx` (8 Tests, 2026-09-11 ergänzt) | jsdom, Engine gemockt |
| Learn-UI | `mappingLearnPanel.test.tsx` | jsdom |
| **Hörprobe an echter Hardware** | — | **OFFEN** (blockiert: kein Gerät in der Agent-Umgebung, siehe `HW-P1-001`) |

Der Test `mappingApply.test.tsx` hat beim Schreiben einen echten Fehler
aufgedeckt: ein Mapping auf `worklet.` (leerer Parameter) meldete Erfolg, ohne
etwas zu setzen (stiller Fake-Erfolg) — behoben.

