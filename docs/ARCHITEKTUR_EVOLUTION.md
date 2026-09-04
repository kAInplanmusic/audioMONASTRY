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

## Entscheidungen 2026-08-31 (D1–D23, aus MASTER_TODO 9f)

- **D1/D6:** masterplayerMONK = Plugin 0 (fest oben, nur Visualisierung/Infos,
  keine Eingabe). mixerMONK ist die einzige MAIN-Einspeiseinstanz; nur der
  Halter entscheidet über MAIN. DJMixer bleibt feste Hardware-Sektion.
- **D2:** Plugin-Lifecycle hybrid – sanftes Ramp-Down bei MAIN-Verbindung,
  harter Disconnect/Dispose bei inaktiv/Monitor-only.
- **D3:** `usePluginState` entfernen; eine State-Quelle
  (`ModuleStateContext` + `PluginManager`).
- **D4:** Synth V1-Worklet zuerst produktiv, V2-AudioGraph parallel (beide
  hohe Priorität).
- **D5/D12:** 1 AudioContext pro User + Host-Main-Stream (P4-1); Server-Mixing
  erst > 4 User.
- **D7:** aiMONK als Bottom-Dock für alle User immer offen.
- **D8:** Skins: erst CSS-Variablen-Themes, später Komponenten-Neubau.
- **D9:** Session-Scratchpad als halbtransparente Overlay-Sidebar.
- **D10:** Output-Layouts 2.0/2.1/2.2/12.x/18.x/24.x; Xonar U7 (7.1) → reale
  2.1 als Standard.
- **D11:** Browser-First für 4 User; Native (cpal/ASIO) optional.
- **D13:** Bus-Modell MAIN / CUE1–4 / PLUGIN-Pre-Fader.
- **D15:** AI-Provider A100/HF-Endpoint bevorzugt; DevSettings „AI Server
  Shutdown“ aktiviert Fallbacks.
- **D22:** `STEM_AI_URL` runtime statt Modul-Konstante → schneller 502 bei
  Provider-Ausfall (umgesetzt in `server.ts`).
