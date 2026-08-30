# DEEP CODE — Forensic Audio/Hardware Architecture Audit
**audioMONASTRY · Stand Commit `4da627a` (2026-08-30) · NUR ANALYSE, KEINE CODE-ÄNDERUNGEN**

> Jede Feststellung beruht auf tatsächlich gelesenem Code. Wo etwas nicht
> abschließend feststellbar ist, steht **STATUS = UNKNOWN** mit Begründung.

---

## 1. CODEBASE INVENTAR

| COMPONENT | PURPOSE | LOCATION | DEPENDENCIES | PLATFORM | STATUS |
|---|---|---|---|---|---|
| Web-App (React/TS) | UI, Plugins, Session, Collaboration | `src/**` | React 19, Tone.js 15, lucide-react, zod | Browser (Chromium/Firefox/WebKit) | ✅ produktiv |
| Audio-Engine (V1) | Tone.js/Web-Audio-Kette, Worklets, Mixer, Spatial, Sampling | `src/utils/audioEngine.ts` (~2100 Z.) | tone, Web Audio, AudioWorklets | Browser | ✅ produktiv |
| Audio-Engine (V2) | Abstrakter AudioGraph + Offline-Render | `src/core/audio/**`, `src/audio/bounce/**` | — (eigene Nodes) | Browser | 🟡 partiell verdrahtet |
| AudioWorklets | DSP (Synth, Mastering, Analyzer, LUFS, EQ, DSP, Clock, Fallback) | `src/audio/worklets/**` | Web Audio Worklet-API | Browser | ✅ produktiv |
| Device-Manager (Browser) | Output-Enumeration, `setSinkId`, Xonar-U7-Kanalplan | `src/utils/audioDeviceManager.ts`, `src/utils/mediaDevices.ts` | Web Audio `setSinkId`, `enumerateDevices` | Browser (Chromium für setSinkId) | 🟡 basis |
| Device-Manager (Core) | Backend-Abstraktion ASIO/CoreAudio/PipeWire/WASAPI | `src/core/hardware/AudioDeviceManager.ts` | nur Interfaces | plattformneutral | 🟠 Interface, keine Implementierung |
| Native Runtime (Rust) | cpal device.list/open, 440-Hz-Testton, JSON-Lines-IPC | `services/audio-runtime/src/main.rs` | cpal 0.15, serde | Linux (gebaut+getestet), macOS/Win via cpal möglich | 🟡 Prototyp |
| Rust-Mixer | NAPI `mix_audio` | `services/mixer/**` | napi, Rust | Linux (Binary aus Quelle) | ✅ minimal |
| MIDI-Utils | CC/Note/Pitch/NRPN/SysEx Encode/Decode, NrpnParser | `src/utils/midi.ts` | — | plattformneutral | ✅ produktiv |
| Web-MIDI-Hook | Enumeration, Hotplug, Auto-Profil | `src/hooks/useMIDI.ts` | Web MIDI API | Browser | ✅ produktiv |
| MIDI-Adapter | `IHardwareAdapter`-Implementierung | `src/core/adapters.ts` (WebMIDIAdapter) | Web MIDI API | Browser | 🟡 Referenz |
| MIDI-Bridge | nativer MIDI⇄WS⇄OSC-Sidecar | `services/midi-bridge/**` | node `midi` (RtMidi), `osc`, `ws` | Linux/macOS/Win (Node) | 🟡 optional |
| MIDI-Program-Map | Program Change → 100 Instrumente | `src/core/instrument/midiProgramMap.ts` | — | plattformneutral | ✅ produktiv |
| HID-Hook | WebHID Enumeration + Pairing | `src/hooks/useHID.ts` | WebHID API | Browser (Chromium) | 🟠 nur Enumeration |
| HID-Adapter | naive Byte→CC-Abbildung | `src/core/adapters.ts` (HIDAdapter) | WebHID API | Browser (Chromium) | 🟠 Prototyp |
| OSC-Adapter | WS/Text-Pfad `/control/...` | `src/core/adapters.ts` (OSCAdapter) | WebSocket | Browser/Netz | 🟠 Prototyp (kein UDP-OSC) |
| Hardware-Simulator | ControlMessage-Simulation | `src/core/hardware/HardwareSimulator.ts` | — | plattformneutral | ✅ Testwerkzeug |
| Hotplug-Manager | Zustands-Preservation (Callback-basiert) | `src/core/hardware/HotplugManager.ts` | — | plattformneutral | 🟠 nicht verdrahtet |
| Persistenz | localStorage (Prefs/Presets), IndexedDB (Scratchpad/KV), OPFS (Samples), Supabase/R2 (Cloud) | `src/utils/storage.ts`, `indexedDB.ts`, `opfs.ts`, `src/lib/supabaseClient.ts` | Browser-APIs, Supabase | Browser + Server | ✅ produktiv |
| Build | Vite + esbuild + cargo + Docker | `package.json`, `vite.config.ts`, `services/*/Cargo.toml`, `Dockerfile*` | npm, cargo, Docker | Linux/macOS/Win | ✅ produktiv |
| Tests | Vitest (Unit), Playwright (E2E) | `tests/**` | vitest, playwright | Linux (CI ubuntu) | ✅ 210+ Tests |

---

## 2. AUDIO ARCHITEKTUR

**Schichten (Ist):**

```
UI (React-Terminals)
  ↓
App-Logik (Hooks, Contexts)
  ↓
audioEngine.ts  ←— einzige Stelle, die Web Audio/Tone.js spricht
  ↓ (AudioContext/Tone.Transport/Worklets)
Browser-Web-Audio-Implementierung
  ↓
OS-Audio-Stack (WASAPI/CoreAudio/PipeWire/ALSA — unsichtbar für die App)
  ↓
Hardware (USB Audio Class 1/2, DAC, Interface)
```

- **OS-Ansprache:** nur der Browser (Web Audio API). Kein direkter OS-Audio-Code im Web-Pfad.
- **Audio-Device-Ansprache:** `audioEngine.setOutputDevice()` → `AudioContext.setSinkId()` (nur Chromium; Firefox/WebKit: kein `setSinkId`). Eingang: `getUserMedia({audio})` in `webRTCManager.startLocalAudio()` (Mikrofon, kein Device-Picker für Interfaces).
- **Konkrete Hardware kennt:** nur `src/core/spatial/roomPlanner.ts` + `audioDeviceManager.ts` (Label-Match „Xonar U7") und die MIDI-Profil-Registry (Name/Manufacturer).
- **Audio Processing:** (a) Echtzeit in AudioWorklets (`src/audio/worklets/**`), (b) Scheduling auf dem Main-Thread über Tone.js-Transport/Lookahead (`scheduleTick`), (c) Offline über `OfflineAudioContext` (Stems) und V2-OfflineRenderer.
- **Threads:** Browser-Audio-Thread (Worklets), Visualizer-WebWorker, WorkerPool (Offline-Jobs); nativer cpal-Callback-Thread im Rust-Runtime.
- **Audio-Thread-Operationen:** in den Worklets nur DSP auf Float32Array/Atomics (verifiziert: `analyzerProcessor`, `lufsProcessor`, `itSynthProcessor`, `masteringProcessor` – keine Allokation im Regelpfad, keine Locks, kein I/O).

**Fazit:** Der Browser ist die tatsächliche Device-Schicht. Die native Schicht (`services/audio-runtime`) ist ein nicht integrierter Prototyp.

---

## 3. REAL-TIME AUDIO AUDIT

| Stelle | Fund | Bewertung | Warum |
|---|---|---|---|
| `analyzerProcessor.ts`, `lufsProcessor.ts` | Float32Array + Atomics, kein `slice`, keine Objekte im Hot-Path | ✅ SAFE | reine DSP-Schleife |
| `itSynthProcessor.ts` | deterministischer xorshift32, Rampen-Automator, Preallocation | ✅ SAFE | kein GC-Druck |
| `masteringProcessor.ts` | Delay-Line/Scratch nur bei Kanalzahl-Wechsel allokiert | ✅ SAFE | Allokation außerhalb des Regelpfads |
| `eq/dsp/effect/synth/clock/fallback` | NaN/Inf-Guards am Ausgang, geklemmte Parameter | ✅ SAFE | keine instabilen Filter |
| `audioEngine.scheduleTick/lookahead` | `setTimeout(…, 25 ms)`-Lookahead auf Main-Thread | 🟡 QUESTIONABLE | Main-Thread-Timing, Jitter-abhängig; funktional ok, aber nicht sample-genau |
| Tone.js-interne Nodes (Player/Synth/Filter) | Drittanbieter-DSP im Main-Thread-Kontext | 🟡 QUESTIONABLE | Tone.js allokiert intern; für 4-User-Last akzeptabel, nicht für große Projekte |
| `previewSynthesizedSample()` | `new Tone.Synth()` + `setTimeout(dispose, 1200)` | 🟡 QUESTIONABLE | einmalige Allokation pro Preview, kein Hot-Path |
| `audioEngine.play()/stop()` | Transport-Start/Stop | 🟡 QUESTIONABLE | ruft Tone-Transport; UI-seitig erlaubt |
| `audioEngine` Console-/Telemetrie-Aufrufe | `console.warn`/`fetch('/api/telemetry')` in Fehlerpfaden | 🟡 QUESTIONABLE | nur Fehlerpfade, nie im Worklet |
| Rust `start_tone_stream` | cpal-Callback erzeugt Sinus | ✅ SAFE | keine Locks/Allokation im Callback |
| `master-player` (Python) | ffmpeg-Subprocess mit Timeout + 64-MB-Limit | ✅ SAFE (nicht echtzeit) | Offline-Rendering, kein Echtzeitpfad |

**UNKNOWN:** exakte Tone.js-Interna (nicht im Repo, node_modules) — eine vollständige Allokations-Analyse des Tone-Kerns wurde nicht durchgeführt.

---

## 4. AUDIO DEVICE CAPABILITIES

**Dynamisch erkannt (Ist):**
- Ausgabe: `enumerateDevices()` → `label`, `deviceId`, `kind` → Xonar-U7-Label-Match (`isXonarU7`).
- `setSinkId(deviceId)` zum Umschalten der Ausgabe (Chromium).
- Kontext-Metriken: `sampleRate`, `baseLatency` werden gelesen (`getAudioHealth()`).

**Nicht erkannt:**
VID, PID, Serial, Manufacturer (Audio), Input-Kanalzahl des Interfaces, Output-Kanalzahl, unterstützte Samplerates, Bit-Tiefe, Puffergrößen, Clock-Infos, Device-Type, Backend. Web Audio gibt diese Daten schlicht nicht her.

**Harte Annahmen im Code:**
| Annahme | Ort |
|---|---|
| 48 kHz Default | `OfflineBounceEngine.ts:34`, `OutputConfig.ts:19`, `GraphPlaybackEngine.ts:19`, `basicNodes.ts:31`, `NativeAudioBackend.ts:32` |
| 44,1 kHz | `localDemucs.ts:114-117,173`, `stemSplitter.ts` (komplett 44,1 kHz) |
| Stereo (2 Kanäle) | `stemSplitter.ts:34,69`, `localDemucs.ts:114`, viele `channelData[0]/[1]`-Zugriffe |
| 8 feste Mixer-Kanäle | `audioEngine` `TrackType` (channel1–channel8) |
| 16/32 Steps | Sequencer (`stepCount`) |
| 1 Ausgabegerät | Browser-`setSinkId` (ein `AudioContext`) — Mehrgeräte nur als Kanalplan (`xonarChannelMap`), nicht ansteuerbar |
| „Mikrofon = Input" | `getUserMedia({audio})` ohne `deviceId`-Wahl |

---

## 5. PLATTFORM-AUDIT

| Plattform | Audio | MIDI | HID | USB | Bewertung |
|---|---|---|---|---|---|
| **Browser Chromium** | Web Audio + `setSinkId` (Ausgabe), `getUserMedia` (Eingang) | Web MIDI (volle API, sysex:false im Hook, sysex:true in `midiAccess`) | WebHID (Enumeration + naive Reports) | kein WebUSB | ✅ beste Plattform |
| **Browser Firefox** | Web Audio (kein `setSinkId`) | Web MIDI laut Code-Kommentar „nur Chromium" – tatsächlich unterstützt Firefox Web MIDI seit v108 (Desktop); Code-Kommentar ist veraltet → **UNKNOWN/veraltet** | ❌ kein WebHID | ❌ | 🟡 |
| **Browser Safari/iOS** | Web Audio (kein `setSinkId`, kein Input-Device-Picker) | ❌ kein Web MIDI (iOS) | ❌ | ❌ | 🔴 eingeschränkt |
| **Linux (nativ)** | Rust `audio-runtime` (cpal→ALSA/PipeWire/JACK, nur device.list + Testton gebaut), `mixer` (NAPI) | `midi-bridge` (RtMidi) | — (kein HID-Sidecar) | — | 🟡 Prototyp |
| **macOS (nativ)** | cpal/CoreAudio theoretisch, nicht gebaut/getestet | midi-bridge (RtMidi/CoreMIDI) theoretisch | — | — | ⚪ UNKNOWN (nicht getestet) |
| **Windows (nativ)** | cpal/WASAPI theoretisch, nicht gebaut/getestet; ASIO nicht vorhanden | midi-bridge (RtMidi/Windows MIDI) theoretisch | — | — | ⚪ UNKNOWN (nicht getestet) |
| **iOS/iPadOS** | nur Browser-Sandbox (Core Audio verdeckt) | ❌ | ❌ | ❌ | 🔴 |
| **Android** | nicht berücksichtigt | ❌ | ❌ | ❌ | ⚪ UNKNOWN (kein Code) |

---

## 6. MIDI FORENSICS

| Feature | Status | Ort |
|---|---|---|
| Device Enumeration | ✅ Web MIDI (`useMIDI`), nativ (`midi-bridge`) | `useMIDI.ts`, `midi-bridge/index.js` |
| MIDI Input | ✅ `onmidimessage` → `lastMessage` | `useMIDI.ts:41` |
| MIDI Output | 🟡 nur Enumeration; `WebMIDIAdapter.send()` ist no-op, midi-bridge kann senden | `adapters.ts`, `midi-bridge` |
| Note On/Off | ✅ dekodiert + genutzt (Pads) | `midi.ts`, `MIDIControllerTerminal.tsx:69` |
| CC | ✅ dekodiert (`parseStatus`, `cc()`), Mapping nur Pad-Bereich | `midi.ts`, `MIDIControllerTerminal` |
| Program Change | ✅ `programChange` Status + `midiProgramMap` (100 Instrumente) + `InstrumentBackend.handleProgramChange` | `midi.ts`, `midiProgramMap.ts`, `InstrumentBackend.ts:121` |
| Pitch Bend | ✅ dekodiert (`pitchBend`, `parseStatus`) | `midi.ts` |
| Poly Aftertouch | 🟡 Status bekannt (`0xa0`), kein Konsument | `midi.ts:13` |
| Channel Pressure | 🟡 Status bekannt (`0xd0`), kein Konsument | `midi.ts:16` |
| MIDI Clock (F8) | ❌ nicht geparst | — |
| Start/Stop/Continue (FA/FB/FC) | ❌ nicht geparst | — |
| Song Position (F2) | ❌ nicht geparst | — |
| SysEx | ✅ Encode/Decode-Helfer (`sysex`, `isSysex`, `parseSysex`); Empfang im UI nicht verdrahtet; midi-bridge leitet SysEx weiter | `midi.ts:91-106`, `midi-bridge` |
| RPN | 🟡 nur „RPN-Null" (CC 101/100) als Teil von `nrpn()`; kein RPN-Parser | `midi.ts:85-86` |
| NRPN | ✅ Builder `nrpn()` + zustandsbehafteter `NrpnParser` | `midi.ts:75-148` |
| MIDI 2.0 | ❌ nicht vorhanden | — |
| Bluetooth MIDI | 🟡 OS-abhängig, sofern als MIDI-Port exponiert (Web MIDI sieht ihn); kein expliziter Code | — |

---

## 7. HID FORENSICS

- Enumeration/Pairing: ✅ `useHID.ts` (`getDevices`, `requestDevice`, connect/disconnect-Events).
- Report-Verarbeitung: 🟠 `HIDAdapter.connect()` öffnet Geräte und mappt **pauschal** `data[0]`=Control-ID, `data[1]/2`=Wert → `cc`. Kein VID/PID, keine Usage Page/Usage, kein Report-Descriptor, keine Input/Output/Feature-Report-Trennung, keine Encoder-/Jog-/Fader-Semantik.
- **Generische HID-Erkennung: NEIN.** Exakte Begründung: Der Report-Descriptor wird nie gelesen; ohne Usage Page (0x09 Button/Generic Desktop), Usage (X/Y/Z/Rx…), Report-ID und Logical Min/Max kann die App nicht wissen, ob Byte 1 ein Button, ein relativer Encoder oder ein absoluter Fader ist. Die einzige Abbildung ist das fest verdrahtete Byte-Muster in `HIDAdapter` und die MIDI-Namens-Registry (die MIDI-Geräte, keine HID-Geräte betrifft).

---

## 8. USB FORENSICS

| Ebene | Einsatz | Ort |
|---|---|---|
| OS-API | ✅ (Web Audio/Web MIDI/WebHID via Browser; cpal/RtMidi nativ) | Browser + `services/audio-runtime`, `midi-bridge` |
| Class-API | ✅ USB Audio Class via Web Audio/cpal; USB MIDI Class via Web MIDI/RtMidi; HID via WebHID | — |
| Vendor-API | ❌ keine | — |
| Direct USB | ❌ kein libusb/WinUSB/IOKit/hidapi/WebUSB | — |

**Bewertung der Abstraktionsgrenze:** korrekt auf OS/Class-API gehalten. Direktes USB ist aktuell nicht nötig und nirgends eingebaut. (Einzige Ausnahme wäre künftiges USB Audio Class Vendor-Extension-Handling oder Multi-Device-Clocking.)

---

## 9. CONTROL ABSTRACTION

**Vorhanden (teilweise):**
```
PHYSICAL DEVICE → PROTOCOL → CONTROL EVENT → (MAPPING) → APP-PARAMETER
```
- `ControlMessage` (`kind: noteOn|noteOff|cc|pitch|program|osc`, `idNum`, `value`, `channel`) ist die zentrale Control-Event-Struktur. ✅
- `IHardwareAdapter` (connect/disconnect/onControl/send) ist das Protokoll-Interface. ✅
- Mapping-Schicht: ❌ **fehlt als zentrale Engine.** MIDI→Parameter passiert direkt in Komponenten (z. B. `MIDIControllerTerminal` `padMappings`), Program Change direkt im `InstrumentBackend`; HID/OSC mappen in ihren Adaptern direkt auf `cc`.
- **Architekturproblem bestätigt:** MIDI/HID/OSC sind nicht gleichwertig hinter einer Mapping-Engine; jeder Adapter erzeugt zwar `ControlMessage`, aber es gibt keinen zentralen, persistierbaren Mapping-Layer („ControlEvent → App-Parameter") und kein Rückkanal (`send()` ist überall no-op → keine LED/Motorfader-Rückmeldung).

---

## 10. MAPPING ENGINE

| Aspekt | Status |
|---|---|
| MIDI Mapping | 🟡 nur fixe Pad-Mappings im Terminal + Program-Map |
| HID Mapping | ❌ kein Mapping, nur Byte-Heuristik |
| OSC Mapping | 🟡 nur Text-Pfad-Regex im Adapter |
| Absolute/Relative, Toggle/Momentary, Fader/Knob/Jog | ❌ keine Semantik-Klassen |
| Mapping-Persistenz | ❌ keine (außer generischem Module-State) |
| Transport-Unabhängigkeit | ❌ Mappings sind an Protokoll/UI gebunden, nicht an `ControlMessage`-Semantik zentralisiert |

---

## 11. HOT PLUG

- **MIDI:** ✅ robust — `onstatechange` mit 50-ms-Debounce re-enumeriert und bindet neue Inputs, entfernt alte Handler; Cleanup beim Unmount.
- **HID:** ✅ Enumeration bleibt live (`connect`/`disconnect`-Listener); geöffnete Reports werden beim Disconnect nicht explizit geschlossen (nur `refresh`).
- **Audio-Ausgabe:** 🟡 `setSinkId`-Fehler (Gerät weg) wird gefangen, `lastDeviceError` gesetzt, Default-Device bleibt aktiv — **App läuft weiter, kein Crash.** Aber: keine automatische Wiederanbindung an dasselbe Gerät, kein Routing-Erhalt, keine UI-Benachrichtigung (nur Warn-Log + Fehlerfeld).
- **Audio-Eingang (Mikrofon):** 🟡 `startLocalAudio` schlägt bei fehlendem Gerät weich fehl; kein Reconnect.
- **Nativ (Rust-Runtime):** ❌ kein Hotplug (cpal-Stream wird nicht überwacht).
- **HotplugManager (Klasse):** existiert mit `attach/detach/preserve/restore`, ist aber **nicht** mit echten Browser-Events verdrahtet (nur manuell/Simulator).

---

## 12. MULTI DEVICE

- **MIDI:** ✅ mehrere Inputs werden parallel gebunden und einzeln gemeldet.
- **HID:** 🟡 mehrere Geräte können geöffnet werden; Kollisionen mehrerer Reports werden nicht entflochten.
- **Audio:** ❌ Browser erlaubt nur **ein** Ausgabegerät pro `AudioContext`; Mehrgeräte existiert nur als statischer Kanalplan (`xonarChannelMap`, `planRoom`) für spätere OS-Aggregation. Kein Clocking/Sync zwischen mehreren Interfaces.
- **Nativ:** `device.list` kann mehrere Geräte auflisten; `device.open` öffnet genau eines (Testton). Kein Multi-Device-Streaming.

---

## 13. DEVICE PROFILES

- **Wiedererkennung:** nur **Name/Manufacturer-Substring** (MIDI-Registry `MIDI_DEVICE_REGISTRY`) und Label-Substring (Xonar). **Kein VID/PID/Serial.**
- **Persistenz:** keine gerätespezifischen Einstellungen (kein Preferred Sample Rate/Buffer je Gerät, kein Routing je Gerät, kein Mapping je Gerät). Nur globale UI-Präferenzen (Module-States) und Presets.

---

## 14. OSC

- **OSC UDP:** ❌ im Web-Pfad (nur WebSocket-Text-JSON). ✅ nativ im `midi-bridge` (sendet echte OSC-Pakete via `osc`-Paket).
- **Address/Arguments:** 🟡 nur Regex `/control/<kind>/<idNum>/<value>[/<channel>]`.
- **Bundles/Timetags:** ❌.
- **Incoming/Outgoing:** 🟡 eingehend (Text), ausgehend (JSON im Adapter, OSC im Bridge). Kein echter OSC-Server im Browser.
- **Integration in Control-Abstraktion:** möglich, da der Adapter bereits `ControlMessage` erzeugt — es fehlt nur echtes OSC-Encoding und die Mapping-Schicht.

---

## 15. ARCHITEKTURDIAGRAMM (IST)

```
┌─────────────────────────────── UI (React-Terminals, 17 Plugins) ───────────────────────────────┐
│  MIDIControllerTerminal  DSPTerminal  DJMixer  InstrumentsTerminal  SettingsDialog …          │
└───────────────┬───────────────────────┬───────────────────────────────┬────────────────────────┘
                │ (lastMessage, detected)│ (direct)                      │ (setSinkId/refresh)
                ▼                        ▼                               ▼
        ┌──────────────┐   ┌──────────────────────────┐   ┌──────────────────────────────┐
        │ useMIDI      │   │ audioEngine.ts            │   │ audioDeviceManager.ts       │
        │ useHID       │   │ (Tone.js + Worklets)      │   │ (Browser-Output-Manager)    │
        └──────┬───────┘   └──────┬───────────┬────────┘   └──────────────┬───────────────┘
               │                  │           │                           │
        Web MIDI / WebHID   AudioWorklets  Tone.Context          Web Audio enumerateDevices/setSinkId
               │                  │           │                           │
        ┌──────▼──────────────────▼───────────▼───────────────────────────▼──────────────┐
        │                          BROWSER (OS-Audio/MIDI/HID unsichtbar)                │
        └─────────────────────────────────────────────────────────────────────────────────┘
                                   │  (nur Chromium: setSinkId, WebHID; Web MIDI)
                                   ▼
                          OS-Audio-Stack (WASAPI/CoreAudio/PipeWire/ALSA) → USB-Hardware

  Sidecars (nicht mit Web-App verdrahtet):
  ┌─────────────────────────┐   ┌──────────────────────────────┐   ┌────────────────────────┐
  │ services/audio-runtime  │   │ services/midi-bridge         │   │ services/mixer (NAPI)  │
  │ Rust/cpal JSON-IPC      │   │ RtMidi ⇄ WebSocket ⇄ OSC     │   │ mix_audio              │
  │ device.list/open        │   │ (nativ, optional)            │   │                        │
  └─────────────────────────┘   └──────────────────────────────┘   └────────────────────────┘

  Core-Abstraktionen (teilweise ungenutzt): IAudioBackend · IHardwareAdapter ·
  ControlMessage · AudioDeviceManager(Interface) · HotplugManager · HardwareSimulator
```

---

## 16. GAP ANALYSIS

| # | FEATURE | CURRENT STATUS | CODE LOCATION | SEVERITY | TECHNICAL PROBLEM | RECOMMENDED SOLUTION | DEPENDENCIES | RISK |
|---|---|---|---|---|---|---|---|---|
| G1 | Audio-Output-Gerätewahl | 🟡 Chromium-only, Xonar-Label-Match | `audioDeviceManager.ts`, `audioEngine.setOutputDevice` | P1 | `setSinkId` fehlt in Firefox/Safari; kein Input-Device-Picker | Device-Picker mit Capability-Anzeige; für Firefox/Safari dokumentieren; nativer Fallback via Runtime | — | mittel |
| G2 | Audio-Input-Gerätewahl | 🔴 nur default `getUserMedia` | `WebRTCManager.startLocalAudio` | P1 | kein `deviceId`, keine Kanalzahl | `enumerateDevices` + `deviceId`-Constraint im SettingsDialog | — | gering |
| G3 | Native Backend-Anbindung | 🔴 Prototyp nicht integriert | `services/audio-runtime`, `core/hardware/AudioDeviceManager.ts` | P1 | JSON-IPC existiert, aber App nutzt ihn nicht | IPC-Client (`ipc.ts` vorhanden) an SettingsDialog anbinden; device.open um echte Streams erweitern | cpal, IPC | hoch |
| G4 | Capability-Erkennung | 🔴 nur Label/String-Match | `roomPlanner.isXonarU7` | P1 | keine VID/PID/Serial/Kanäle/Samplerates | nativ: cpal-configs auslesen; Web: aus Label nur heuristisch | cpal | mittel |
| G5 | Hot Plug Audio | 🟡 kein Crash, aber kein Reconnect/Routing-Erhalt | `setOutputDevice` catch | P1 | Gerät weg → Default; Rückkehr wird nicht erkannt | `devicechange`-Listener + HotplugManager verdrahten + Re-Apply des letzten Geräts | — | gering |
| G6 | Multi-Device Audio | 🔴 statischer Kanalplan ohne Ansteuerung | `xonarChannelMap` | P2 | Browser kann nur 1 Output | OS-Aggregation (PipeWire Combine-Sink, macOS Aggregate) dokumentieren + native Runtime | OS-Tools | hoch |
| G7 | Control-Abstraktion | 🟡 ControlMessage existiert, Mapping fehlt zentral | `core/interfaces.ts`, Adapter | P1 | MIDI/HID/OSC mappen direkt in UI | zentrale Mapping-Engine (ControlEvent→Parameter, absolut/relativ/toggle/jog) + Persistenz | — | mittel |
| G8 | MIDI Clock/Transport | 🔴 fehlt | `midi.ts` (kein F8/FA/FB/FC) | P2 | kein externes Sync | Clock-Parser + Transport-Mapping (Start/Stop/Position) | — | gering |
| G9 | SysEx-Empfang im UI | 🟡 Helfer vorhanden, nicht verdrahtet | `midi.ts`, `useMIDI` | P2 | `sysex:false` im Hook | Sysex-Option aktivieren + Parser anbinden (mit Längen-Limit) | — | gering |
| G10 | RPN | 🟡 nur RPN-Null | `midi.ts` | P3 | kein RPN-Parser | RPN-Parser analog `NrpnParser` | — | gering |
| G11 | MIDI 2.0 | 🔴 fehlt | — | P3 | UMP-Protokoll nicht vorhanden | erst nach Hardware-Bedarf; Web MIDI 2.0 noch unklar | — | hoch |
| G12 | HID generisch | 🔴 Byte-Heuristik, kein Report-Descriptor | `HIDAdapter` | P1 | ohne Usage-Parsing keine generische Erkennung | Report-Descriptor-Parser + Usage-Mapping + Control-Klassen | WebHID | hoch |
| G13 | OSC | 🟠 Text-WS-Fallback, kein UDP/Bundle | `OSCAdapter` | P2 | kein echtes OSC | OSC-Encoder (UDP via Server-Bridge oder WS-Transport) + Mapping | osc | mittel |
| G14 | Device-Profile (VID/PID) | 🔴 nur Namens-Match | `midiDevices.ts` | P2 | Namenskollisionen, keine Serial | Profil um VID/PID/Serial erweitern (WebHID liefert IDs; Web MIDI nicht) | — | gering |
| G15 | Mapping-Persistenz | 🔴 fehlt | — | P1 | Mappings gehen verloren | Mapping-Store (IndexedDB) + Export/Import | — | gering |
| G16 | LED/Motorfader-Rückkanal | 🔴 `send()` no-op | `adapters.ts` | P2 | kein Hardware-Feedback | `send()` in WebMIDIAdapter (Outputs) + HID-Output-Reports | Web MIDI Out/WebHID | mittel |
| G17 | Bluetooth MIDI | 🟡 nur falls OS-Port | — | P3 | plattformabhängig | Doku + Test auf Zielgerät | — | gering |

---

## 17. PRIORISIERUNG (nach Stabilität → RT-Safety → Architektur → …)

1. **P0:** G5 (Hot Plug Audio — kein Datenverlust/Absturz, Reconnect), G2 (Input-Wahl) — Stabilität zuerst.
2. **P1:** G7 (Control-Abstraktion/Mapping-Engine), G1 (Output-Wahl + Fallback), G3 (natives Backend anbinden), G4 (Capabilities), G12 (HID-Descriptor), G15 (Mapping-Persistenz).
3. **P2:** G6 (Multi-Device), G8 (MIDI-Clock), G9 (SysEx-Empfang), G13 (OSC), G14 (Profile VID/PID), G16 (Rückkanal).
4. **P3:** G10 (RPN), G11 (MIDI 2.0), G17 (BT-MIDI).

---

## 18. ZIELARCHITEKTUR

**CURRENT → PROPOSED → MIGRATION PATH**

```
CURRENT:  UI ──► audioEngine (Browser-only)   ·   MIDI/HID/OSC direkt in UI/Adapter
PROPOSED: UI ──► ControlLayer ──► MappingEngine ──► ParameterStore ──► audioEngine
                 ▲                    ▲
        HardwareAdapterRegistry        │
        ├─ WebMIDIAdapter  (Ports+Sysex)      └─ Persistenz (IndexedDB)
        ├─ HIDAdapter      (ReportDescriptor-Parser → ControlEvent)
        ├─ OSCAdapter      (UDP/Bundle → ControlEvent)
        ├─ NativeMidiBridgeAdapter (WS zum midi-bridge)
        └─ VirtualDevice   (HardwareSimulator)

        DeviceLayer ──► IAudioBackend ──► WebAudioBackend | NativeRuntimeBackend (cpal)
                        AudioDeviceManager (Enumeration, Capabilities, HotPlug, Reconnect)
```

**Migration:** bestehende Interfaces (`IAudioBackend`, `IHardwareAdapter`, `ControlMessage`) sind bereits richtig → **nicht neu bauen**, sondern: (1) Mapping-Engine als neue Schicht zwischen Adaptern und UI einfügen, (2) Adapter auf `ControlEvent`-Semantik (absolut/relativ/toggle/jog) erweitern, (3) `AudioDeviceManager`-Interface mit echter Implementierung füllen (Web zuerst, dann cpal-IPC), (4) HotplugManager an echte Events binden.

---

## 19. IMPLEMENTIERUNGSPLAN

| Phase | Inhalt | Dateien/Komponenten | Abhängigkeiten | Risiken | Tests | Erwartetes Ergebnis |
|---|---|---|---|---|---|---|
| **0 Safety/Regression** | Baseline: Tests, Boundary, E2E | `tests/**`, CI | — | gering | alle grün | belastbare Basis |
| **1 Core Device Architecture** | `ControlEvent`-Typ (abs/rel/toggle/momentary/jog), Adapter-Registry, Event-Bus | `src/core/interfaces.ts`, neu `src/core/hardware/ControlBus.ts` | Phase 0 | mittel | Unit | einheitliches Event-Modell |
| **2 Audio Device Layer** | Output-Picker + `devicechange`, Input-Picker (`deviceId`), Reconnect, Capability-Anzeige | `audioDeviceManager.ts`, `WebRTCManager`, `SettingsDialog` | Phase 0/1 | mittel | Unit+E2E | Gerätewechsel ohne Reload, Reconnect |
| **3 Hot Plug** | `HotplugManager` an echte Events binden, State-Preserve/Restore für Audio+MIDI+HID | `HotplugManager.ts`, `useMIDI`, `useHID` | Phase 1/2 | gering | Unit+Mock | Trennen/Wiedereinstecken ohne Verlust |
| **4 MIDI** | Clock/Start/Stop/SongPosition, SysEx-Empfang, RPN-Parser, Output senden | `midi.ts`, `useMIDI`, `WebMIDIAdapter` | Phase 1 | gering | Unit | volle MIDI-1.0-Abdeckung |
| **5 HID** | Report-Descriptor-Parser, Usage-Mapping, Control-Klassen | neu `src/core/hardware/hidReport.ts`, `HIDAdapter` | Phase 1 | hoch | Unit mit Mock-Reports | generische HID-Erkennung |
| **6 Control Abstraction** | Mapping-Engine: ControlEvent → Parameter, Semantik-Klassen, Routing | neu `src/core/mapping/**` | Phase 1/4/5 | mittel | Unit | transport-unabhängiges Mapping |
| **7 Mapping** | Persistenz (IndexedDB), Export/Import, UI | neu `MappingStore`, UI-Panel | Phase 6 | gering | Unit+E2E | Mappings überleben Reload |
| **8 OSC** | echter OSC-Codec (UDP via Bridge/WS), Bundles, Timetags | `OSCAdapter`, `midi-bridge` | Phase 6 | mittel | Unit | OSC wie MIDI/HID nutzbar |
| **9 Vendor-specific** | Profile mit VID/PID/Serial, LED/Motorfader-Rückkanal | `midiDevices.ts`, Adapter `send()` | Phase 5/7 | mittel | Mock | Geräte-Feedback |
| **10 Advanced/MIDI 2.0** | UMP-Decoder, Capability Inquiry | neu `src/core/midi/ump.ts` | Phase 4 | hoch | Unit | MIDI-2.0-ready |

---

## 20. TESTSTRATEGIE

**Mit Hardware (manuell/CI-Sonderläufer):** Audio-Enumeration (Geräteanzahl), Capability-Detection, Device Open/Close, Hot-Plug/Removal/Reconnect, Routing-Erhalt, Sample-Rate/Buffer-Wechsel (nur nativ), MIDI Note/CC/PC/Pitch/SysEx/RPN/NRPN, HID-Reports, OSC, Mapping, Profile, Error-Recovery.

**Ohne Hardware (automatisiert):**
- **Mock-Strategie Browser:** `HardwareSimulator` (vorhanden) für ControlMessages; `MockMIDIAccess` (Map von Ports + `onmidimessage`-Feuerung); `MockHIDDevice` (Report-Arrays); `MockAudioContext` mit `setSinkId`/`enumerateDevices`.
- **Mock-Strategie nativ:** Rust-Unit-Tests für `list_devices_cpal`-Parsing und IPC-Ser/Deser; `midi-bridge` mit virtuellen RtMidi-Ports (Linux `snd-virmidi`) oder injiziertem Fake-Port-Objekt.
- **Property-basiert:** MIDI-Codec-Roundtrips (`cc/noteOn/nrpn/sysex`), `NrpnParser`-Sequenzen, HID-Report-Parser mit zufälligen Descriptor-Samples.
- **E2E:** Playwright mit `--use-fake-device-for-media-stream` (vorhanden) + MIDI über Mock-Page-API.

---

## ABSCHLUSS

Die App ist eine **Browser-First-Audio-Workstation**: Die reale Device-Schicht ist
Web Audio/Web MIDI/WebHID. Die Core-Abstraktionen (`IAudioBackend`,
`IHardwareAdapter`, `ControlMessage`, `AudioDeviceManager`-Interface,
`HotplugManager`, `HardwareSimulator`) sind **architektonisch richtig angelegt,
aber erst teilweise mit Leben gefüllt**. Die größten Lücken: (1) keine zentrale
Mapping-Engine, (2) HID ohne Report-Descriptor-Parsing, (3) Audio-Hotplug ohne
Reconnect/Routing-Erhalt, (4) native Runtime nicht integriert, (5) kein
MIDI-Clock/SysEx-Empfang im UI, (6) keine VID/PID/Serial-Profile.

**NO CODE CHANGES IN THIS PHASE.** Der Bericht ist als Implementierungsgrundlage
für einen zweiten Coding-Agenten geeignet; alle Ortsangaben beziehen sich auf
Commit `4da627a`.
