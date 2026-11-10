# Architecture Map — audioMONASTRY (Verified)

> **Historischer Bericht — nicht die gültige RunPod-SSOT (2026-11-10).** Datierten Angaben zu GPU, Gewichtsspiegel, Rollen, Deploy, Preisen und damaliger Live-Prüfung nicht als aktuelle Fakten verwenden. **Aktive Referenz:** [RunPod Fleet SSOT](docs/RUNPOD_FLEET_SSOT.md) mit `deploy/runpod/pod-fleet.json` und `services/audiomonastry-ai-runtime/model_manifest.json`: acht heterogene Pods (`brain`, `ears`, `voice`, `music`, `studio`, `audio-brain`, `song`, `vis`), RunPod-Gesamtbudget **8 €/h**. Historische Serverless-Bild-/Video-Rollen nicht deployen.


## System Boundaries

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            BROWSER (×4 Users)                               │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ React 19 + Vite 6 + Tailwind 4                                      │   │
│  │ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐    │   │
│  │ │ 16 Plugin   │ │ AudioWorklet│ │   WASM      │ │  State      │    │   │
│  │ │ Adapters    │ │ (16 procs)  │ │ (Rust DSP)  │ │  Sync       │    │   │
│  │ └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘    │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────┬────────────────────────────────────────────┘
                               │ HTTPS/WSS + WebRTC
                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          HETZNER FLEET (5 servers)                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐      │
│  │  app-1   │  │  sfu-1   │  │ media-1  │  │  edge-1  │  │ master-1 │      │
│  │  (cx43)  │  │  (cx33)  │  │  (cx43)  │  │  (cx23)  │  │  (cx43)  │      │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘      │
│       │             │             │             │             │              │
│       ▼             ▼             ▼             ▼             ▼              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ Express 4 + Socket.io                                              │   │
│  │ ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐        │   │
│  │ │ AI         │ │ Session    │ │ Plugin     │ │ Media      │        │   │
│  │ │ Orchestr.  │ │ Manager    │ │ Locks      │ │ Proxy      │        │   │
│  │ └────────────┘ └────────────┘ └────────────┘ └────────────┘        │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────┬────────────────────────────────────────────┘
                               │
         ┌─────────────────────┼─────────────────────┐
         ▼                     ▼                     ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│  RunPod          │  │  Supabase        │  │  Cloudflare R2   │
│  Serverless      │  │  (PostgreSQL)    │  │  (Object Store)  │
│  8 Endpoints     │  │  RLS Enforced    │  │  Presigned URLs  │
│  ┌────────────┐  │  │  anon=2 tables   │  │  No device store │
│  │ A40 48GB×8 │  │  service_role=all  │  │                  │
│  └────────────┘  │                    │  │                  │
└──────────────────┘  └──────────────────┘  └──────────────────┘
```

## Interface Contracts

### Plugin Interface (All 16 MONKs)
```typescript
interface PluginInterface {
  initialize(context: PluginRuntimeContext): Promise<void>;
  setState(state: PluginState): void;
  setParameter(parameter: PluginParameterValue): void;
  process(block: PluginAudioBlock): PluginAudioBlock;      // sync, realtime-safe
  handleCommand(command: PluginCommand): Promise<unknown>;
  snapshot(): PluginSnapshot;
  restore(snapshot: PluginSnapshot): void;
  dispose(): Promise<void>;                                // idempotent
}
```

### Audio Graph Contract
- **Sample Rate**: 48 kHz (CONTRACT_SAMPLE_RATE)
- **Block Size**: 128 frames
- **Channel Count**: 8 mixer channels (V2_CHANNELS)
- **PDC Reference**: masterMONK = 240 frames (5ms lookahead)

### AI Orchestration Contract
```typescript
interface OrchestrateRequest {
  userId: string;
  task: AiTask;
  model: string;
  input: unknown;
  sessionId?: string;
  mcpPermission?: 'READ'|'WRITE'|'EXECUTION'|'DESTRUCTIVE';
  idempotencyKey?: string;
}
```

### Session State Contract
- **Authority**: Server (AuthoritativeSession)
- **Locks**: Central per-plugin (pluginMode.ts)
- **Replication**: Socket.io events to all 4 users
- **Persistence**: Server-only, snapshot on change

## Data Flow

### Audio Path (Realtime)
```
User Input → Plugin Adapter.setParameter() 
  → Worklet port message 
  → AudioWorkletProcessor.process() 
  → V2StudioGraph.render() 
  → MasterSumNode (PDC) 
  → V2SinkProcessor 
  → AudioContext.destination
```

### AI Inference Path
```
User Action → aiMONK → AI Orchestrator.orchestrate()
  → JobManager.create() (dedup via idempotencyKey)
  → ProviderRouter.run() 
  → RunPod endpoint /run
  → Handler (Python) → Model inference
  → Result → JobManager.complete() 
  → Client receives via SSE/Socket.io
  → Plugin loads result (samples → SourceNode)
```

### Collaborative State Path
```
User Action → Plugin Adapter (holder only)
  → AuthoritativeSession.applyLock()
  → Socket.io broadcast (plugin-state)
  → All clients receive → UI updates
  → Non-holders see locked strip
```

## Component Dependencies

```
server.ts
├── AI Orchestrator → ProviderRouter → RunPod endpoints
├── Session Manager → AuthoritativeSession → Socket.io
├── Plugin Locks → pluginMode.ts → Socket.io
├── Fleet Wiring → fleetWiring.ts → RunPod REST
├── Routes (AI, Session, Media, Master, Voice, Stem, Admin, Ops, Agent)
└── Metrics → LatencyHistogram → Prometheus

src/core/audio/
├── V2StudioGraph → AudioGraph → Nodes (Source, Gain, Pan, MasterSum)
├── WorkletGraphRuntime → AudioWorkletNode[] (16 processors)
├── V2MonitorGraph → Cue/Main/Monitor routing
└── Worklets (16) → process() → port messages

src/plugins/
├── registry.ts → discoverPlugins() → plugin-manifest.json
├── pluginContract.ts → PLUGIN_CONTRACTS → signalTopology()
├── adapters/ (16) → BasePluginAdapter → audioEngine/worklets
└── legacyAliases.ts → migration mapping

services/audiomonastry-ai-runtime/
├── app.py → FastAPI → /run, /runsync, /ready, /metrics
├── handlers*.py → Model-specific inference
├── model_manager.py → VRAM budget, loading, caching
├── model_manifest.json → 43 model definitions
└── pod_start.py → Presigned R2 weights → SHA-256 verify
```

## Security Boundaries

| Boundary | Protection |
|----------|------------|
| API `/api/*` | Token required (x-studio-token, cookie, query) — constant-time compare |
| Database | RLS: anon key reads only `samples` + `music_tables` |
| RunPod | Presigned R2 URLs (TTL 6h), HF_TOKEN secret per pod |
| Audio | No device storage — server-authoritative |
| ffmpeg | Argument allowlist, no shell, -nostdin, timeout |
| CSP | Strict headers, no inline scripts, report-uri |

## Cost Constitution (Binding)

| Limit | Value | Enforcement |
|-------|-------|-------------|
| GPU Endpoints | ≤ 8 | `AI_MAX_GPU_ENDPOINTS` guard |
| Fleet Cost | ≤ 10 EUR/h | `assertFleetHourlyBudget()` pre-flight |
| AI Surcharge | ≤ 4 EUR/h | `AI_MAX_AI_EUR_PER_HOUR` |
| Storage | ≤ 5 EUR/mo | `assertStorageBudget()` |
| Hetzner Servers | ≤ 5 | `AI_MAX_HETZNER_SERVERS` |
| Visual Roles | On-demand only | `isVisualRole()` gate |

---

*Verified against commit 00f4b0b · 2026-11-09*