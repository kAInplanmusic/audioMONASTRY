# NEXT-GEN BROWSER DAW – 50 Instruments & Hybrid Synthesis Engine

> Referenz-Spezifikation / Asset-Vorlage (Abgleich vom Nutzer bereitgestellt).
> Ziel: `instrumentMONK`/`synthesizerMONK` – ein programmatisch definierter
> Instrumenten-Pool von **50 definierten Instrument/Presets** mit
> Hybrid-Synthese (Analog-Synth, FM, Drum-Kit, Akustik-Modellierung, FX/AI-SFX).

## Kategorien der 50 Instrumente

| IDs | Kategorie | Typ | Anzahl |
|-----|-----------|-----|--------|
| 1–10 | Analog Synthesizer | `synth` | 10 |
| 11–20 | Digital & FM Synthesizer | `fm` | 10 |
| 21–30 | Drum-Kits & Percussion | `drum` | 10 |
| 31–40 | Akustische & Hybrid-Modellierung | `acoustic` | 10 |
| 41–50 | Experimental, FX & AI-ready | `fx` | 10 |

## Beispiel-Presets (Auszug pro Kategorie)

```jsonc
// Analog Synth
{ "id": 1, "name": "Juno-60 Classic Pad", "type": "synth", "osc": "sawtooth", "filter": "lowpass", "cutoff": 1200, "resonance": 4, "attack": 0.4, "release": 1.2 }
{ "id": 4, "name": "TB-303 Acid Bass",     "type": "synth", "osc": "sawtooth", "filter": "lowpass", "cutoff": 800,  "resonance": 15, "attack": 0.005, "release": 0.2 }
// FM
{ "id": 11, "name": "DX7 Electric Piano",  "type": "fm", "carrier": "sine", "modulator": "sine", "modIndex": 5, "attack": 0.01, "release": 1.5 }
{ "id": 12, "name": "FM Metallic Bell",    "type": "fm", "carrier": "triangle", "modulator": "sawtooth", "modIndex": 12, "attack": 0.005, "release": 2.0 }
// Drum
{ "id": 21, "name": "808 Kick Drum",       "type": "drum", "freqStart": 150, "freqEnd": 40, "decay": 0.5, "click": true }
{ "id": 23, "name": "909 Closed Hi-Hat",   "type": "drum", "noise": true, "filterFreq": 8000, "decay": 0.05 }
// Acoustic
{ "id": 31, "name": "Acoustic Grand Piano","type": "acoustic", "harmonics": [1, 0.5, 0.25], "attack": 0.01, "release": 1.0 }
{ "id": 38, "name": "Muted Trumpet",       "type": "acoustic", "harmonics": [1, 0.7, 0.5, 0.3], "attack": 0.05, "release": 0.3 }
// FX / AI-ready
{ "id": 41, "name": "AI Neural Ambient",   "type": "fx", "wave": "sine", "lfoRate": 0.2, "attack": 1.5, "release": 3.0 }
{ "id": 49, "name": "Subterranean Rumble", "type": "fx", "wave": "sine", "freq": 35, "attack": 1.0, "release": 3.5 }
```

## Umsetzungsempfehlung in audioMONASTRY

Die Instantiierung dieser Instrumente soll – gemäß Architecture Rules – **nicht**
direkt `window.AudioContext` erzeugen, sondern über den vorhandenen
`IAudioBackend` (`src/core/WebAudioBackend`) laufen. Der Synth-Kern (PolyBLEP,
FM, Additiv, Drum-Sweep, Noise) gehört in einen **AudioWorklet-Prozessor** /
`synthesizerMONK`, damit er sample-genau und blockfrei läuft.

---

# Referenz: Architecture-Governance & Interface-Definition (Phasen 0–7)

> Aus früherer Roadmap übernommen, konsolidiert für die integrale Planung von
> `instrumentMONK`, `synthesizerMONK`, `mixerMONK`, `effectMONK`, etc.

## PHASE 0 – Architektur-Governance & Interface-Definition
- 0.1 Definition verbindlicher Interfaces (`IAudioBackend`, `IAIRuntime`,
  `IComputeBackend`, `ISpatialRenderer`, `IHardwareAdapter`, `ITransport`,
  `ISessionStore`, `IPluginHost`) – Dependency Injection / Registry.
- 0.2 Objektbasiertes Session-Datenmodell mit Versionierung (UUID, CRDT/Lamport).
- 0.3 Schichtenarchitektur-Enforcement (ESLint, Dependency-Cruiser, keine Audio→UI-Imports).

## PHASE 1 – Echtzeit-Kern
- 1.1 AudioWorklet-Scheduler mit PLL-Timing (Jitter < 0,5 ms).
- 1.2 Zipper-Free Parameter Automation (`ParameterSmoother`).
- 1.3 Audio-Graph-Routing als gerichteter Signalgraph.
- 1.4 Lookahead-Mastering-Chain mit Latenz-Kompensation, True-Peak, LUFS.

## PHASE 2 – Modul-Kern (die 16 MONK-Module)
mixerMONK, sampler/drumMONK, sequencerMONK, effectMONK, synthesizerMONK,
eqMONK, dspMONK, spatialMONK, controllerMONK, biblioMONK, instrumentMONK,
recordingMONK, voiceMONK, stemMONK, masteringMONK, performance-Optimierung.

> **Aufg. 2.5 bzw. instrumentMONK:** Unterbringung der 50-Instrumenten-Liste
> (siehe oben) als programmatisch definierte Instanzierungen.

## PHASE 3 – Kollaboration (WebRTC/SFU)
- 3.1 Signaling-Server (Socket.io) · 3.2 State-Replication mit Locking ·
  3.3 Audio-Streaming zwischen Peers · 3.4 SFU-Vorbereitung (mediasoup).

## PHASE 4 – KI-Integration (providerunabhängig)
- 4.1 AI-Abstraktion (Local → Remote → Deterministic)
- 4.2 Lokale TTS (Kokoro-82M via transformers.js)
- 4.3 Lokale Stem-Separation (Demucs via ONNX/WASM)
- 4.4 Musik-Generierung (MusicGen) · 4.5 Audio-to-Audio (Denoise/Dereverb) ·
  4.6 Semantische Suche (Embeddings).

## PHASE 5 – Persistenz & Infrastruktur
OPFS-Cache, Session-Persistenz (IndexedDB+OPFS / SQLite / S3-kompatibel),
Deployment-Automatisierung (Docker/Compose), REST-API erweitern.

## PHASE 6 – UI & UX
Canvas-Skin-Engine, Touch-Optimierung, Visualisierung (Waveform/Spektrum/LUFS).

## PHASE 7 – Zukunftserweiterungen (Roadmap)
Native Audio-Backends (Desktop), GPU/NPU-Inferenz, erweiterte Spatial-Formate,
Hardware-Console, Skalierung >4 Nutzer, verteilte Compute-Services.

---

> Status: Diese Datei ist **Referenz/Asset-Vorlage**. Der konkrete iterative
> Umsetzungsstatus wird in `MASTER_TODO.md` gepflegt.
