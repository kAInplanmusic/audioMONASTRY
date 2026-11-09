# Dependency Graph — audioMONASTRY

## Component Dependencies (Mermaid)

```mermaid
graph TD
    %% Browser Layer
    Browser[Browser ×4 Users]
    React[React 19 App]
    Adapters[16 Plugin Adapters]
    Worklets[AW Processors ×16]
    WASM[Rust WASM Kernels]
    StateSync[State Sync Socket.io]

    Browser --> React
    React --> Adapters
    React --> Worklets
    React --> WASM
    React --> StateSync

    %% Server Layer
    Server[server.ts Express]
    AIOrch[AI Orchestrator]
    SessionMgr[Session Manager]
    PluginLocks[Plugin Locks]
    FleetWiring[Fleet Wiring]
    Routes[API Routes]

    Server --> AIOrch
    Server --> SessionMgr
    Server --> PluginLocks
    Server --> FleetWiring
    Server --> Routes

    %% AI Layer
    ProviderRouter[Provider Router]
    JobManager[Job Manager]
    ModelManager[Model Manager]
    MCPRuntime[MCP Runtime]
    CostTracker[Cost Tracker]

    AIOrch --> ProviderRouter
    AIOrch --> JobManager
    AIOrch --> ModelManager
    AIOrch --> MCPRuntime
    AIOrch --> CostTracker

    %% RunPod Layer
    RunPodBrain[Brain Pod A40]
    RunPodEars[Ears Pod A40]
    RunPodVoice[Voice Pod A40]
    RunPodMusic[Music Pod A40]
    RunPodAudioGen[AudioGen Pod 4090]
    RunPodStudio[Studio Pod A40]
    RunPodAudioBrain[AudioBrain Pod 4090]
    RunPodSong[Song Pod 4090]
    RunPodVis[Vis Pod A40]

    ProviderRouter --> RunPodBrain
    ProviderRouter --> RunPodEars
    ProviderRouter --> RunPodVoice
    ProviderRouter --> RunPodMusic
    ProviderRouter --> RunPodAudioGen
    ProviderRouter --> RunPodStudio
    ProviderRouter --> RunPodAudioBrain
    ProviderRouter --> RunPodSong
    ProviderRouter --> RunPodVis

    %% Data Layer
    Supabase[(Supabase PostgreSQL)]
    R2[(Cloudflare R2)]
    HetznerFleet[Hetzner Fleet 5]

    Server --> Supabase
    Server --> R2
    Server --> HetznerFleet

    %% Plugin Contracts
    Contract[pluginContract.ts]
    Registry[registry.ts]
    SignalTopo[signalTopology()]

    Adapters -.-> Contract
    Registry -.-> Contract
    Worklets -.-> Contract

    %% Audio Graph
    V2Graph[V2StudioGraph]
    V2Monitor[V2MonitorGraph]
    V2Sink[V2SinkProcessor]
    MasterSum[MasterSumNode 240f]
    PDC[PDC Compensation]

    Worklets --> V2Graph
    V2Graph --> MasterSum
    MasterSum --> PDC
    V2Graph --> V2Monitor
    V2Sink --> AudioCtx[AudioContext Dest]

    %% Cross-cutting
    StateSync <---> SessionMgr
    PluginLocks <---> SessionMgr
    FleetWiring -.-> RunPodBrain
    FleetWiring -.-> RunPodEars
```

## Plugin Signal Topology

```mermaid
graph LR
    %% Sources (via Channel Strips)
    Drop[drop Ch1] --> Channel1[Channel Strip 1]
    Song[song Ch2] --> Channel2[Channel Strip 2]
    Drum[drumsampler Ch3] --> Channel3[Channel Strip 3]
    Synth[syntisampler Ch4] --> Channel4[Channel Strip 4]
    Instru[instru Ch5] --> Channel5[Channel Strip 5]
    Voice[voice Ch6] --> Channel6[Channel Strip 6]
    Sound[sound Ch7] --> Channel7[Channel Strip 7]
    Stem[stem Ch8] --> Channel8[Channel Strip 8]

    %% Channel Inserts (pre-sum)
    Channel1 --> Spatial[spatial Insert]
    Channel2 --> Spatial
    Channel3 --> Spatial
    Channel4 --> Spatial
    Channel5 --> Spatial
    Channel6 --> Spatial
    Channel7 --> Spatial
    Channel8 --> Spatial

    %% FX Send (post-fader)
    Channel1 -.-> FXBus[FX Bus]
    Channel2 -.-> FXBus
    Channel3 -.-> FXBus
    Channel4 -.-> FXBus
    Channel5 -.-> FXBus
    Channel6 -.-> FXBus
    Channel7 -.-> FXBus
    Channel8 -.-> FXBus

    FXBus --> Effect[effectMONK Return]
    Effect --> MasterSum

    %% Channel Strips → Master Sum
    Spatial --> MasterSum[MasterSumNode]
    Channel1 --> MasterSum
    Channel2 --> MasterSum
    Channel3 --> MasterSum
    Channel4 --> MasterSum
    Channel5 --> MasterSum
    Channel6 --> MasterSum
    Channel7 --> MasterSum
    Channel8 --> MasterSum

    %% Master Inserts (serial)
    MasterSum --> EQ[eqMONK]
    EQ --> DSP[dspMONK]
    DSP --> Master[masterMONK 240f]
    Master --> Record[recordMONK Tap]
    Record --> Output[AudioContext]

    %% PDC Compensation
    PDC[PDC: all paths → 240f] -.-> Master
    PDC -.-> Spatial
    PDC -.-> Effect
```

## AI Model → Pod Mapping

```mermaid
graph TD
    subgraph "A40 48GB Pods (8)"
        Brain[Brain Pod] --> Qwen30B[qwen3-30b-a3b-awq 22.78GB]
        Brain --> Qwen4B[qwen3-4b 8.70GB]
        
        Ears[Ears Pod] --> Whisper[whisper-large-v3 5.75GB]
        Ears --> CLAP[clap-music 0.73GB]
        Ears --> MERT[mert-v2-330m 2.36GB]
        Ears --> QwenAudio[qwen2-audio-7b 15.65GB]
        Ears --> Pyannote[pyannote-diarization 0.04GB]
        Ears --> AST[ast-audioset 0.65GB]
        
        Voice[Voice Pod] --> TTS17B[qwen3-tts-17b 4.21GB]
        Voice --> TTSVD[qwen3-tts-voicedesign 4.21GB]
        Voice --> TTSBase[qwen3-tts-06b-base 2.34GB]
        Voice --> ACE_Shared[acestep-v15-shared 9.40GB]
        
        Music[Music Pod] --> ACE_SFT[acestep-v15-xl-sft 20.02GB]
        Music --> ACE_Turbo[acestep-v15-xl-turbo 20.02GB]
        Music --> ACE_LM[acestep-5hz-lm-4b 7.85GB]
        Music --> ACE_Shared2[acestep-v15-shared 9.40GB]
        
        Studio[Studio Pod] --> BS6[bs-roformer-sw-6stem 0.83GB]
        Studio --> HTDemucs[htdemucs-6s 0.31GB]
        Studio --> MOSS_SFX[moss-soundeffect-v2.0 10.46GB]
        Studio --> ACE_XL[acestep-v15-xl-base 20.02GB]
        
        AudioBrain[AudioBrain Pod] --> Omni[qwen3-omni-30b 25.68GB]
        AudioBrain --> MFlamingo[music-flamingo 15.42GB]
        
        Song[Song Pod] --> MFlamingo2[music-flamingo 15.42GB]
        Song --> Yue2[yue2-3b ~24GB]
        
        Vis[Vis Pod] --> MasterPlayer[master-player 8GB]
        Vis --> MFlamingo3[music-flamingo 15.42GB]
        Vis --> MGSmall[musicgen-small 4GB]
        Vis --> SongStart[nateraw/musicgen-songstarter 6GB]
        Vis --> NVENC[NVENC H.264/HEVC]
        Vis --> VisualOut[/visual-out stream]
    end
```

## Task Dependencies (Backlog)

```mermaid
graph TD
    %% Wave 1: RT Audio Fixes
    AUD001[AUD-001: Synth Voice Cutoff] --> AUD002[AUD-002: Swing/Steps]
    AUD002 --> AUD003[AUD-003: Mastering THD]
    AUD003 --> AUD004[AUD-004: Dropout Detection]
    AUD004 --> AUD005[AUD-005: itSynth Audible]
    AUD005 --> AUD006[AUD-006: Error Paths]
    
    %% Wave 2: Fleet Measurement
    AUD006 --> AUD007[AUD-007: GPU Measurements]
    
    %% Wave 3: Licensing (parallel after AUD007)
    AUD007 --> AUD009[AUD-009: BS-RoFormer License]
    AUD007 --> AUD010[AUD-010: SongFormer License]
    AUD007 --> AUD011[AUD-011: beat_this License]
    AUD007 --> AUD012[AUD-012: Mel-RoFormer License]
    
    %% Wave 4: Config Resolution (need measurements)
    AUD007 --> AUD014[AUD-014: Ears VRAM]
    AUD007 --> AUD015[AUD-015: Music vLLM Tuning]
    
    %% RP1 Decision (blocker)
    HD001[HD-001: RP1 Model Decision] --> AUD013[AUD-013: RP1 Contradiction]
    
    %% Visual Cleanup (independent)
    AUD016[AUD-016: Visual Pod Cleanup]
    
    %% Orchestrator Merge
    AUD013 --> AUD017[AUD-017: Orchestrator Merge]
    
    %% AI Mutex (independent)
    AUD018[AUD-018: AI Execution Mutex]
    
    %% Policy & Quality (parallel)
    AUD019[AUD-019: Quant Policy]
    AUD020[AUD-020: Prompt Governance]
    AUD021[AUD-021: Capture Measurement]
    AUD022[AUD-022: Golden WAVs CI]
    AUD023[AUD-023: Dead Exports]
    AUD024[AUD-024: jscpd Duplicates]
    AUD025[AUD-025: Doc Updates]
```

## Critical Path

```
AUD-001 → AUD-002 → AUD-003 → AUD-007 → AUD-014 → AUD-013 (HD-001)
     │       │       │       │       │       │
    2d      3d      2d      5d      2d      1d
    ──────────────────────────────────────────
    Total: ~15 days minimum (sequential critical path)
```

*Generated from commit 00f4b0b · 2026-11-09*