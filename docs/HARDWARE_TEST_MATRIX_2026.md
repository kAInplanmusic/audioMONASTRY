# Hardware-Testmatrix — audioMONASTRY (Stand 2026-08-30)

> Ehrliche Testdokumentation: Jede Zeile entspricht einem tatsächlich
> durchgeführten Test. **NOT TESTED** bedeutet: nicht getestet, keine
> Funktionsbehauptung.

## Testumgebung

| OS | Audio-Stack | Browser | Backend | Hinweis |
|---|---|---|---|---|
| Linux (audioMONASTRY, Kernel 7.0.0) | PipeWire/ALSA | Chromium (Dev) | Web Audio (`setSinkId`) | primäre Dev-Umgebung |
| Linux | — | — | Rust `audio-runtime` (cpal) | Prototyp, nicht in Web-App integriert |
| Supabase (pwtwtqbcynsjtkxlkrwh) | Cloud | service_role + anon | ✅ `cloudHealth`: `ok (service_role)` | ✅ Schema + RLS angewendet (4 Tabellen) |
| Supabase Sync (Seed) | Cloud | service_role | ✅ 29 Samples + 48 Music-Tracks upserted | ✅ Write-Pfad real verifiziert |
| Supabase Anon-Read | Cloud | anon REST | ✅ 5/5 Zeilen gelesen (z. B. `TR-909 Classic Kick`) | ✅ Read-Pfad real verifiziert |
| Cloudflare R2 | Cloud | S3 | ✅ `ListBuckets` + `PutObject` real verifiziert | Bucket `audiomonastrysamples` (5 Objekte vorhanden) |

## Automatisierte Tests (ohne Hardware, in CI reproduzierbar)

| Kategorie | Test | Gerät | Ergebnis |
|---|---|---|---|
| MIDI Codec | `tests/midiCodec.test.ts` | virtuell (Byte-Streams) | ✅ 13 Tests grün |
| HID Report | `tests/hidReport.test.ts` | virtuell (Descriptor-Samples) | ✅ 6 Tests grün |
| OSC Codec | `tests/oscCodec.test.ts` | virtuell (Roundtrip) | ✅ 3 Tests grün |
| Control Event | `tests/hardwareControlEvent.test.ts` | virtuell | ✅ 4 Tests grün |
| Mapping Engine | `tests/mappingEngine.test.ts` | virtuell | ✅ 7 Tests grün |
| Device Profiles | `tests/deviceProfile.test.ts` | virtuell | ✅ 4 Tests grün |
| Hot Plug | `tests/hotplugManager.test.ts` | virtuell | ✅ 5 Tests grün |
| Diagnostics | `tests/hardwareDiagnostics.test.ts` | virtuell | ✅ 3 Tests grün |
| Audio Engine | `tests/audioEngine.test.ts` | virtuell (Tone-Mock) | ✅ 11 Tests grün |
| MIDI 2.0 UMP | `tests/ump.test.ts` | virtuell (Wort-Roundtrips) | ✅ 8 Tests grün |
| HID-Output-Encoder | `tests/hidReport.test.ts` (LED) | virtuell (Descriptor-Samples) | ✅ 3 Tests grün |
| OSC-Bridge | `tests/oscBridge.test.ts` | virtuell | ✅ 6 Tests grün |
| Native Backend | `tests/nativeRuntimeBackend.test.ts` | Mock-IPC-Transport | ✅ 4 Tests grün |
| Mapping-UI | `tests/mappingLearnPanel.test.tsx` | jsdom + Testing Library | ✅ 3 Tests grün |
| E2E-Hardware | `tests/e2e/hardware.spec.ts` | Playwright + virtuelles Web MIDI | ✅ 1 Test grün |
| Upload-Helfer | `tests/sampleUpload.test.ts` | virtuell | ✅ 4 Tests grün |
| Instrument-Canvas | `tests/canvasDefs.test.ts` | virtuell (Geometrie/Noten) | ✅ 5 Tests grün |
| MOA-Abdeckung | `tests/moaCoverage.test.ts` | Registry-Audit | ✅ 2 Tests grün |

## Hardware-Testmatrix

Legende: ✅ getestet und funktioniert · ⚠️ getestet mit Einschränkung · ❌ getestet, fehlgeschlagen · ⬜ NOT TESTED

### USB AUDIO

| DEVICE | OS | BACKEND | DETECTED | OPENED | INPUT | OUTPUT | SAMPLE RATE | BUFFER | HOT PLUG | LATENCY | RESULT |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ASUS Xonar U7 (8-Kanal-USB-DAC) | Linux (cpal/ALSA) | Native Runtime `device.list` | ✅ (enumeriert: `hw:CARD=U7` in/out, 44,1 kHz, I16) | ⬜ | ⬜ | ⬜ | ✅ 44100 Hz (Default-Config) | ✅ 384000 Samples (gemeldet) | ⬜ | ⬜ | TEILWEISE: Enumeration ✅, Stream NOT TESTED |
| Generisches UAC1-Interface | — | Web Audio | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | NOT TESTED |
| Generisches UAC2-Interface | — | Web Audio | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | NOT TESTED |

### USB MIDI

| DEVICE | OS | BACKEND | DETECTED | OPENED | MIDI | HOT PLUG | RESULT |
|---|---|---|---|---|---|---|---|
| AKAI APC40 MKII | — | Web MIDI | ⬜ | ⬜ | ⬜ | ⬜ | NOT TESTED |
| AKAI MPK mini | — | Web MIDI | ⬜ | ⬜ | ⬜ | ⬜ | NOT TESTED |
| Novation Launchpad | — | Web MIDI | ⬜ | ⬜ | ⬜ | ⬜ | NOT TESTED |
| Generisches USB-MIDI-Keyboard | — | Web MIDI | ⬜ | ⬜ | ⬜ | ⬜ | NOT TESTED |

### USB HID

| DEVICE | OS | BACKEND | DETECTED | OPENED | HID | HOT PLUG | RESULT |
|---|---|---|---|---|---|---|---|
| Generic-Desktop-Joystick (virtuell) | Node | Report-Parser | ✅ (Mock-Descriptor) | — | ✅ | — | ✅ Parser verifiziert |
| Relativer Encoder/Dial (virtuell) | Node | Report-Parser | ✅ (Mock-Descriptor) | — | ✅ | — | ✅ Parser verifiziert |
| Physisches HID-Gerät | — | WebHID | ⬜ | ⬜ | ⬜ | ⬜ | NOT TESTED |
| HID-Encoder/Joystick (virtuell) | Node | Report-Encoder | ✅ | — | ✅ Output-Report-Bits | — | ✅ Encoder verifiziert |

### OSC

| DEVICE | OS | BACKEND | DETECTED | OPENED | OSC | RESULT |
|---|---|---|---|---|---|---|
| OSC-Codec (virtuell) | Node | Unit | ✅ | — | ✅ Roundtrip/Bundles/Timetags | ✅ |
| OSC-Bridge-Logik (virtuell) | Node | Unit | ✅ | — | ✅ OSC↔MIDI↔ControlEvent | ✅ |
| TouchOSC-Smartphone | — | WebSocket/UDP | ⬜ | ⬜ | ⬜ | NOT TESTED (Sidecar `OSC_LISTEN_PORT` vorbereitet) |

### MULTI DEVICE

| KOMBINATION | OS | ERGEBNIS |
|---|---|---|
| Audio-Interface + MIDI-Controller + HID + OSC | — | ⬜ NOT TESTED (Architektur vorbereitet) |
| Mehrere Audio-Interfaces (Clocking/Drift) | — | ⬜ NOT TESTED — Browser kann nur EIN Ausgabegerät; echte Sample-Synchronität wird NICHT behauptet |

### HOT PLUG

| SZENARIO | ERGEBNIS |
|---|---|
| MIDI-Gerät trennen/wieder einstecken | ⬜ NOT TESTED mit Hardware; Hook-Logik (Debounce/Rebind) vorhanden |
| HID-Gerät trennen/wieder einstecken | ⬜ NOT TESTED mit Hardware; Hook-Logik (connect/disconnect) vorhanden |
| Audio-Ausgabegerät trennen | ⬜ NOT TESTED mit Hardware; `setSinkId`-Fehlerpfad + Reconnect-Logik vorhanden (Unit-verifiziert) |
| Audio-Eingabegerät trennen | ⬜ NOT TESTED mit Hardware; `getUserMedia`-Fehlerpfad vorhanden |

## Bekannte Limitierungen (keine Funktionsbehauptung)

1. **Web Audio gibt keine VID/PID/Serial/Kanalzahl/Samplerates** für Audio-Geräte preis.
   Die App liest ausschließlich Browser-Metriken (`label`, `deviceId`, `sampleRate`,
   `baseLatency`, `outputLatency`). Kanalzahl-Erkennung erfolgt nur als dokumentierte
   Heuristik (Xonar-Label) – siehe Settings-Hinweis.
2. **Mehrgeräte-Audio** ist im Browser nicht möglich (ein `AudioContext` = ein Ziel).
   OS-Aggregation wird im UI angeleitet (PipeWire Combine-Sink / ASIO4ALL /
   macOS-Aggregat), aber nicht automatisiert.
3. **Native Backends** (cpal/ASIO/CoreAudio/PipeWire) sind implementiert und per
   `device.list` auf Linux verifiziert; der Spawner-Pfad ist Node/Electron —
   im reinen Browser nicht verfügbar.
4. **MIDI 2.0/UMP** ist als Codec implementiert und unit-getestet; echte
   MIDI-2.0-Hardware/Transporte sind NOT TESTED (Browser-Unterstützung fehlt).
5. **HID-Rückkanal (LEDs/Motorfader)** ist implementiert (Output-Report-Encoder +
   `sendReport`), unit-getestet; echte LED-Hardware NOT TESTED.
