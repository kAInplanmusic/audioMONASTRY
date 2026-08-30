# Phase 1 · Core-Abstraktionsschichten

> audioMONASTRY – Modulärer Kern. Ziel von Phase 1: Die 16 Kernmodule sprechen
> keinerlei Browser-/Provider-APIs mehr direkt an, sondern ausschließlich über
> die Interfaces in [`interfaces.ts`](./interfaces.ts). Dadurch wird jedes
> Backend (Audio, KI, Compute, Spatial, Hardware, Transport) austauschbar, ohne
> die Kernmodule refaktorieren zu müssen.

## 1.1.1 · `IAudioBackend`
Abstrahiert Klangsynthese, Sample-Aufruf, Mixer, Effekte und tempo.

| Beschreibung | Datei |
|---|---|
| Interface | [`interfaces.ts`](./interfaces.ts) |
| Referenz | [`WebAudioBackend.ts`](./WebAudioBackend.ts) – wrapper um die Tone.js/Engine-Kette |

**Erfolgskriterium 1.1.1:** Kernmodule kommunizieren nur noch über dieses Interface.

## 1.1.2 · `IAIRuntime`
Abstrahiert KI-Inferenz: lokal (WebGPU/ONNX/WASM) / remote (API) / deterministisch.

| Beschreibung | Datei |
|---|---|
| Interface + `AIBackendKind`/`AIResult` | [`interfaces.ts`](./interfaces.ts) |
| Referenz | [`adapters.ts`](./adapters.ts) → `AIRuntime` (Fallback deterministisch) |

**Nächste Schritte:** stemMONK (Stem-Separation), voiceMONK (TTS/Sing), biblioMONK
(Embedding) als lokale/remote Adapter an diese Schnittstelle hängen.

## 1.1.3 · `IComputeBackend`
Trennt **Live**- (kurz, Main-Thread) und **Offline**- (lange, Web-Worker) Jobs, damit
der Audio-/Echtzeitpfad nie blockiert wird.

| Beschreibung | Datei |
|---|---|
| Interface + `ComputeMode`/`IComputeJob` | [`interfaces.ts`](./interfaces.ts) |
| Referenz | [`adapters.ts`](./adapters.ts) → `ComputeBackend` (Worker mit Fallback) |

## 1.1.4 · `ISpatialRenderer`
Objektbasiertes Spatial-Modell (Position/Gain/Spread/Rotation), renderer-unabhängig.

| Beschreibung | Datei |
|---|---|
| Interface + `SpatialSource` | [`interfaces.ts`](./interfaces.ts) |
| Referenz | [`adapters.ts`](./adapters.ts) → `SpatialRenderer` (wrapper um `spatialMath`) |
| Stereo/Binaural/Multichannel | [`spatial/spatialRenderers.ts`](./spatial/spatialRenderers.ts) – drei produktionsreife Renderer hinter demselben Interface |

## 1.1.5 · `IHardwareAdapter`
Abstrahiert MIDI / HID / OSC über ein generisches `ControlMessage`-Modell.

| Beschreibung | Datei |
|---|---|
| Interface + `ControlMessage` | [`interfaces.ts`](./interfaces.ts) |
| MIDI | [`adapters.ts`](./adapters.ts) → `WebMIDIAdapter` (inkl. Program-Change 0xC) |
| HID | [`adapters.ts`](./adapters.ts) → `HIDAdapter` (WebHID, Report→Control-Mapping) |
| OSC | [`adapters.ts`](./adapters.ts) → `OSCAdapter` (WS-Endpoint, `/control/…`-Pfade) |

## 1.1.6 · `ITransport`
Abstrahiert Kollaborations-Transport: WebRTC Full-Mesh (P2P), SFU, sowie ein
deterministischer Local-Transport für Offline-Betrieb/Tests.

| Beschreibung | Datei |
|---|---|
| Interface + `TransportMode` | [`interfaces.ts`](./interfaces.ts) |
| P2P | [`adapters.ts`](./adapters.ts) → `WebRTCTransport` (wrapper um `WebRTCManager`) |
| SFU | [`transport/MediasoupTransport.ts`](./transport/MediasoupTransport.ts) |
| Local + Fallback-Kette | [`transport/TransportRegistry.ts`](./transport/TransportRegistry.ts) → `LocalTransport`, `TransportRegistry` (sfu→p2p→local) |

## 1.2.1 · Objekt-Identitätssystem
UUID-basierte, versionierte Session-Objekte mit zentraler Registry.

| Beschreibung | Datei |
|---|---|
| `SessionObject` + `ObjectRegistry` + `uuidV4` | [`session/ObjectRegistry.ts`](./session/ObjectRegistry.ts) |

## 1.2.2 · State-Replication (CRDT)
Deterministisches Replikationsprotokoll: LWW-Register/OR-Set mit Lamport-Clock
und Tombstones – Offline-Änderungen konvergieren bei Reconnect.

| Beschreibung | Datei |
|---|---|
| `LamportClock`, `mergeEntry(s)`, `converge`, `applyReplicationToRegistry` | [`session/stateReplication.ts`](./session/stateReplication.ts) |

## 1.2.3 · Lease-basiertes Locking
B2B-Locking mit Heartbeat und automatischer Freigabe abgelaufener Leases
(kein Deadlock bei Verbindungsabbruch). `now` ist injizierbar → testbar.

| Beschreibung | Datei |
|---|---|
| `LockManager` (acquire/renew/release/isLocked/ownerOf/expireAll/snapshot) | [`session/locking.ts`](./session/locking.ts) |

## 1.2.4 · Random-Seed-Management
Deterministische generative Prozesse: xmur3-Hash + mulberry32-PRNG,
Session-/Preset-Seeds, JSON-Serialisierung, reproduzierbare Ströme pro Scope.

| Beschreibung | Datei |
|---|---|
| `hashString`, `mulberry32`, `SeedManager` (session/preset/random/pick/toJSON/fromJSON) | [`session/seedManagement.ts`](./session/seedManagement.ts) |

## Zentraler Einstieg / Hot-Swapping

- [`index.ts`](./index.ts) exportiert die öffentliche Core-API.
- [`adapters.ts`](./adapters.ts) → `createBackends()` baut die Standard-Suite von Backends.

```
const backends = await createBackends();
backends.audio.setTempo(126);
backends.transport.broadcast({ type: 'tempo', value: 126 });
```

## Erweiterte Kern-Bausteine (ab neueste)

| Baustein | Pfad | Beschreibung |
|----------|------|--------------|
| WebGPU | [`gpu/WebGPUKernel.ts`](./gpu/WebGPUKernel.ts) | Tiled-GEMM + ReLU/Sigmoid/Tanh (WGSL) – Matrix-/GI-Basis |
| Worker-Pool | [`workers/WorkerPool.ts`](./workers/WorkerPool.ts) | Multi-Core-Offline-Compute mit CPU-Fallback |
| Local-Compute | [`computeLocal.ts`](./computeLocal.ts) | Komfort-Wrapper um den Worker-Pool |
| SFU-Transport | [`transport/MediasoupTransport.ts`](./transport/MediasoupTransport.ts) | Client-SFU (mediasoup-client) – Skalierung >4 Nutzer |
| instrumentMONK | [`instrument/`](./instrument/) | 50+50 Instrumenten-Katalog + Hybrid-Synthese-Engine |

## instrumentMONK-Engine (Plugin #5)

- [`instrument/types.ts`](./instrument/types.ts) – Typmodell (`AcousticDef`, `SynthDef`,
  `FmDef`, `DrumDef`, `FxDef`) und `InstrumentPreset`/`InstrumentChannel`.
- [`instrument/catalog.ts`](./instrument/catalog.ts) – Katalog aus den 50 akustischen
  Patches (`data/instrumentSynths`) + 50 Synthese-Presets (Analog/FM/Drum/FX).
- [`instrument/IInstrumentBackend.ts`](./instrument/IInstrumentBackend.ts) – Interface
  mit `load`, `noteOn`, `noteOff`, `setParam`, `savePreset`/`loadPreset`, `assignChannel`.
- [`instrument/InstrumentBackend.ts`](./instrument/InstrumentBackend.ts) – Referenz, delegiert
  audio-agnostisch an die Engine (`loadInstrument`/`playSynthesisInstrument`).
- **AudioWorklet (`it-synth-processor`):** `src/audio/worklets/itSynthProcessor.ts`
  rendert die Synthese sample-genau im Audio-Thread (additiv/subtraktiv/FM/Drum/FX,
  ADSR, resonanter Moog-Ladder, Noise pink/brown, LFO, Pitch-Sweep, multiBurst).
  Die `audioEngine` bevorzugt das Worklet und fällt auf Tone.js zurück, wenn es
  nicht geladen werden kann (Registrierung über `public/plugin-manifest.json`).

```
import { instrumentBackend } from '@/core';
await instrumentBackend.load(101);   // Juno-60 Classic Pad (Analog-Synth)
instrumentBackend.noteOn('C4', 0.9);
instrumentBackend.noteOff();
```

## Status in MASTER_TODO

- 1.1.1 – ✔ Interface + WebAudioBackend-Referenz
- 1.1.2 – ✔ Interface + AIRuntime-Referenz (deterministischer Fallback)
- 1.1.3 – ✔ Interface + ComputeBackend-Referenz (Worker mit Fallback)
- 1.1.4 – ✔ Interface + Stereo-/Binaural-/Multichannel-Renderer (spatialRenderers.ts)
- 1.1.5 – ✔ Interface + WebMIDI-/HID-/OSC-Adapter
- 1.1.6 – ✔ Interface + P2P/SFU/Local-Transport + TransportRegistry (Fallback-Kette)
- 1.2.1 – ✔ ObjectRegistry (UUID, Versionierung, Snapshot)
- 1.2.2 – ✔ CRDT-Replikationsprotokoll (LWW/OR-Set, Lamport-Clock, Tombstones)
- 1.2.3 – ✔ LockManager (Lease-Locking, Heartbeat, Auto-Release, kein Deadlock)
- 1.2.4 – ✔ SeedManager (xmur3/mulberry32, Session-/Preset-Seeds, reproduzierbar)
- 2.2.2 – ✔ Worker-Pool (siehe `workers/`)
- 3.1.1 – ✔ SFU-Client (siehe `transport/`) + Server (`server.ts`, `ENABLE_SFU=1`)
- 4.1.1 – ✔ WebGPU-GEMM/Activation (siehe `gpu/`), Modell-Gewichte folgen

> **Phase-1-Gesamtziele:** Import-Analyse (`scripts/validate-interface-boundaries.mjs`)
> meldet **0 direkte Plattform-API-Zugriffe** in den Kernmodulen; die Interface-
> Dokumentation ist in diesem README pro Schicht hinterlegt.
