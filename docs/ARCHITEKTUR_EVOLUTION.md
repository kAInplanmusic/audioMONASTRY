# ARCHITEKTUR-EVOLUTION – AudioMONASTRY

Stand: 2026-08-26 · Phase 1–5 Grundgerüst implementiert.

## Architektur-Überblick

```text
┌─────────────────────────────────────────────────────────────┐
│ React UI (Terminals)                                        │
│  · spricht NUR über IPC mit der Audio-Runtime (Phase 2)      │
└───────────────────────────┬─────────────────────────────────┘
                            │ IpcMessage (src/core/audio/runtime/ipc.ts)
┌───────────────────────────▼─────────────────────────────────┐
│ Backend-unabhängiger AudioGraph (src/core/audio)            │
│  IAudioNode · IAudioPort · IAudioParameter · ProcessingPlan │
└───────┬──────────────────┬──────────────────┬───────────────┘
        │                  │                  │
┌───────▼───────┐ ┌────────▼───────┐ ┌────────▼────────┐
│ WebAudioBackend│ │ WasmBackend    │ │ NativeBackend  │
│ (Browser)      │ │ (WASM-Kernel)  │ │ (Rust-Runtime) │
└───────────────┘ └────────────────┘ └─────────────────┘

SpatialScene (src/core/spatial)  →  Renderer: Stereo/VBAP/Ambisonics/HRTF
VoiceMONK (src/core/voice)       →  SpeechToIntent · SingingEngine · AutomationAgent
OfflineRenderer (src/core/render) →  gleiche Graph-Struktur, Faktoren 1x/4x/20x
OutputConfig (src/core/output)   →  Stereo bis 24.2 (26 Kanäle)
AudioDeviceManager (src/core/hardware) → ASIO/CoreAudio/PipeWire, generisches USB-Audio
```

## Zentrale Interfaces

| Interface | Pfad |
|---|---|
| `IAudioNode`, `IAudioBuffer`, `IAudioPort`, `IAudioParameter` | `src/core/audio/types.ts` |
| `IAudioGraph`, `ProcessingPlan` | `src/core/audio/types.ts` |
| `IAudioGraphBackend` | `src/core/audio/backends/types.ts` |
| `AudioObject`, `SpatialScene`, `Room`, `Listener` | `src/core/spatial/SpatialScene.ts` |
| `ISpatialSceneRenderer` | `src/core/spatial/SceneRenderers.ts` |
| `ISpeechToIntent`, `ISingingEngine`, `AutomationAgent` | `src/core/voice/` |
| `IpcMessage`, `IpcTransport` | `src/core/audio/runtime/ipc.ts` |
| `IAudioDeviceBackend` | `src/core/hardware/AudioDeviceManager.ts` |

## Migrations-Guide (bestehende Module)

1. **Keine WebAudio-Typen in Business-Logik.**  
   `AudioContext`, `AudioNode`, `AudioParam` usw. dürfen nur in Adaptern unter
   `src/core/audio/backends/` bzw. `src/utils/audioEngine.ts` (Referenzadapter) liegen.
2. **Graph-Logik auf `AudioGraph` umstellen.**  
   Neue DSP-Module bauen auf `IAudioNode` auf; `AudioGraph.compile()` liefert den
   deterministischen `ProcessingPlan`.
3. **Tracks → AudioObjects.**  
   Räumliche Positionen werden als `AudioObject` in der `SpatialScene` verwaltet,
   nicht mehr direkt am Track.
4. **UI ↔ Runtime nur über IPC.**  
   React-Komponenten senden `IpcMessage`; kein direkter Zugriff auf Audio-Knoten.
5. **Offline = Realtime.**  
   `OfflineRenderer` nutzt denselben `IAudioGraph` wie die Live-Pipeline.

## Noch offen (nächste Schritte)

- Migration der bestehenden `audioEngine.ts` auf den neuen Graph
- Echte Backend-Implementierungen (WebAudio/WASM/Native) statt Stubs
- Source → Extraction → AudioObject Pipeline
- OpenAI-Control-Layer-Anbindung
- Rust-Runtime-Prozess bauen
