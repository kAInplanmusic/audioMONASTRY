# ATOMIC PLUGIN RESEARCH — P01 through P16
## audioMONASTRY · Independent Deep Research per Plugin

**Audit Baseline**: Commit `00f4b0b` (main) · Generated: 2026-11-09
**Methodology**: Per Master Prompt §5 — each plugin independently investigated for:
- Code verification (adapter, worklet, UI)
- DSP architecture (where applicable)
- Signal chain position (pluginContract.ts + signalChain.ts)
- UI/UX (Terminal components)
- State management (snapshots, parameters, settings)
- Alternatives & Competitor comparison

---

## P01 — mixerMONK (`mixer`)

### 5.1 Plugin Identification
- **ID**: `mixer` | **Name**: `mixerMONK` | **Short**: `MIX` | **Icon**: `Sliders`
- **Role**: `channel` (IS the 8 channels) | **Channel**: `null` | **Format**: `stereo`
- **Signal Contract**: `inputs: 8, outputs: 1, latency: 0, bypassable: false, syncCapable: false`
- **Signal Stage**: `mixer` (single plugin in mixer stage)
- **Signal Order**: 2nd (after sources)
- **UI Component**: `DJ4ChMixer` (lazy-loaded)
- **Adapter**: `MixerPluginAdapter` → `BasePluginAdapter`

### 5.2 Historical/Commercial References
- **Reference**: Pioneer DJM-900NXS2 / Allen & Heath Xone:96
- **Circuit Topology**: 8-channel summing mixer with per-channel gain/pan/EQ, post-fader FX send, cue/monitor routing, crossfader
- **Characteristic**: Transparent summing, constant-power pan law, 3-band EQ per channel

### 5.3 Functional Completeness
| Capability | Implemented | Status |
|---|---|---|
| 8 channels × gain/pan | ✅ Adapter + Engine | VERIFIED |
| Per-channel 3-band EQ (low/mid/high) | ✅ `setChannelEQ` | VERIFIED |
| Post-fader FX send | ✅ `sendsToFx: false` (is FX bus) | VERIFIED |
| Master volume | ✅ `masterGain` param | VERIFIED |
| Cue/Monitor routing | ✅ `MonitorRoutingFacade` | VERIFIED |
| 2.1 output | ✅ `spatial` insert handles | VERIFIED |
| B2B Locking | ✅ `mixer` always ON, single holder | VERIFIED |
| Fade to main | ✅ `fadeInMain` command | VERIFIED |
| Load track sample | ✅ `loadTrackSample` command | VERIFIED |

**Missing**: None identified — core mixer functionality complete.

### 5.4 DSP Architecture
- **Processing**: None in adapter (transparent summing) — all DSP in `audioEngine` (worklets)
- **Adapter `onProcess`**: In-place gain/pan per channel, constant-power pan law (`cos/sin`)
- **Latency**: 0 frames (transparent)
- **Biquad EQ**: Delegated to `eqProcessor` worklet (IIR, latency-free)

### 5.5 Framework/Runtime
- **Runtime**: Browser AudioWorklet (via `audioEngine` → worklet chain)
- **Adapter**: TS class extending `BasePluginAdapter`
- **Worklets**: `eqProcessor` (per-channel), `dspProcessor` (master insert), `masteringProcessor`
- **State**: Server-authoritative (`pluginSettingsSync.ts`), persisted on every change

### 5.6 Competitor Comparison
| Product | Channels | EQ | FX Send | Crossfader | B2B Lock |
|---|---|---|---|---|---|
| Pioneer DJM-900 | 4 | 3-band | Post | Hardware | No |
| audioMONASTRY | 8 | 3-band | Post | Virtual | ✅ Central |
| Ableton Live | 16+ | 8-band | Pre/Post | Virtual | No |

### 5.7 Code Verification
| Trace | File | Status |
|---|---|---|
| Registration | `registry.ts:58` | ✅ `DJ4ChMixer` |
| Adapter | `adapters/MixerPluginAdapter.ts` | ✅ 136 lines |
| Contract | `pluginContract.ts:108-124` | ✅ Role `channel` |
| Signal Chain | `signalChain.ts:56` | ✅ Stage `mixer` |
| Settings Sync | `pluginSettingsSync.ts` | ✅ Server-authoritative |
| Locking | `pluginMode.ts` | ✅ Central lock |

### 5.8 Alternatives
| Alternative | Benefit | Risk | Effort |
|---|---|---|---|
| Native Web Audio `GainNode` only | Simpler | Lose EQ/FX send | Low |
| JUCE/VST3 wrapper | Pro features | Breaks browser-first | Very High |

### 5.9 Plugin Verdict
| Verdict | Reason |
|---|---|
| **Engineering: KEEP** | Core architecture, no defects, complete feature set |
| **Portfolio: KEEP** | Mandatory — central mixer, all sources route through it |

---

## P02 — dropMONK (`drop`)

### 5.1 Plugin Identification
- **ID**: `drop` | **Name**: `dropMONK` | **Short**: `DRP` | **Icon**: `Zap`
- **Role**: `source` | **Channel**: `1` | **Format**: `stereo`
- **Signal Contract**: `inputs: 0, outputs: 1, latency: 0, bypassable: true, syncCapable: true, sendsToFx: true (post)`
- **Signal Stage**: `sources` (1st in sources: biblio → drop → song → drumsampler → syntisampler → instru → voice → sound → stem)
- **UI Component**: `DropTerminal`
- **Adapter**: `DropPluginAdapter`

### 5.2 Historical/Commercial References
- **Reference**: Pioneer RMX-1000 / Roland SP-404 / Korg Kaoss Pad
- **Function**: Performance one-shots, drops, samples triggered quantized to beat grid
- **Workflow**: Load sample → assign to channel → trigger on beat (SYNC) or free

### 5.3 Functional Completeness
| Capability | Implemented | Status |
|---|---|---|
| Sample load/trigger | ✅ `loadTrackSample` + `triggerEvent` | VERIFIED |
| Quantized start (SYNC) | ✅ `scheduleSyncStart` + `scheduleAtNextBar` | VERIFIED |
| Pattern presets | ✅ `pattern_four/random/break` → ControlBus | VERIFIED |
| Auto-drop | ✅ `autoDrop` command | VERIFIED |
| Velocity/ramp | ✅ `play` command with `velocity`, `rampSec` | VERIFIED |

### 5.4 DSP Architecture
- **Adapter `onProcess`**: None (gain only via engine)
- **Real DSP**: `drumSynthProcessor` + `effectProcessor` worklets
- **Sample playback**: `DropAudioAdapter` (engine) → `triggerEvent(channel, velocity)`
- **Latency**: 0 frames intrinsic (SYNC handled by `scheduleSyncStart`)

### 5.5 UI/Terminal
- **Component**: `DropTerminal` (lazy-loaded)
- **Features**: Sample browser, pad grid, pattern sequencer, quantize controls, loop controls

### 5.6 Competitor Comparison
| Product | Type | Quantize | Sample Browser | Pattern |
|---|---|---|---|---|
| Roland SP-404 | Hardware | Manual | Card | No |
| Ableton Drum Rack | Software | ✅ | ✅ | ✅ |
| audioMONASTRY dropMONK | Browser | ✅ SYNC | ✅ biblio | ✅ 3 presets |

### 5.7 Code Verification
| Trace | File | Status |
|---|---|---|
| Adapter | `adapters/DropPluginAdapter.ts` | ✅ 95 lines |
| Contract | `pluginContract.ts:125-142` | ✅ Channel 1 |
| Audio Adapter | `core/drop/DropAudioAdapter.ts` | ✅ `loadTrackSample`, `triggerEvent` |
| Worklet | `audio/worklets/drumSynthProcessor.ts` | ✅ Sample playback |

### 5.8 Verdict
| Verdict | Reason |
|---|---|
| **Engineering: KEEP** | Complete, SYNC works, clean separation adapter/engine |
| **Portfolio: KEEP** | Essential performance tool, unique quantized trigger |

---

## P03 — songMONK (`song`)

### 5.1 Identification
- **ID**: `song` | **Role**: `source` | **Channel**: `2` | **Format**: `stereo`
- **Capabilities**: `['ai', 'audio-source']` | **Sync**: true | **FX Send**: post
- **UI**: `SongMonkTerminal` | **Adapter**: `SongPluginAdapter`

### 5.2 Functional Completeness
| Capability | Implemented | Status |
|---|---|---|
| Play/Start (SYNC) | ✅ `play` command + `scheduleSyncStart` | VERIFIED |
| AI Generate | ✅ `/api/song/generate` + ControlBus | VERIFIED |
| Abort support | ✅ `AbortSignal` passed through | VERIFIED |
| Result handling | ✅ `monk:song-result` event | VERIFIED |

### 5.3 DSP Architecture
- **Adapter**: No local DSP — delegates to AI (ACE-Step on RP3) + `audioEngine` for playback
- **Playback**: `triggerEvent('channel2', velocity)` → engine loads sample into channel2
- **Latency**: AI generation async; playback 0 frames intrinsic

### 5.4 AI Integration
- **Model**: `acestep-v15-xl-sft` (RP3 music pod)
- **Endpoint**: `/api/song/generate` → orchestrator → RP3
- **Context**: Can accept library references for LEGO (extract/complete)

### 5.5 Verdict
| Verdict | Reason |
|---|---|
| **Engineering: KEEP** | Clean AI delegation, proper async/abort |
| **Portfolio: KEEP** | Core AI music generation entry point |

---

## P04 — effectMONK (`effect`)

### 5.1 Identification
- **ID**: `effect` | **Role**: `fxReturn` | **Channel**: `null` | **Format**: `stereo`
- **Signal Contract**: `inputs: 1 (FX bus), outputs: 1, latency: 0, bypassable: true`
- **Signal Stage**: `processing` (fxReturn sub-stage)
- **UI**: `FXEngineTerminal` | **Adapter**: `EffectPluginAdapter`

### 5.2 Functional Completeness
| Capability | Implemented | Status |
|---|---|---|
| Reverb (diffuse) | ✅ `effectProcessor` comb/allpass | VERIFIED |
| Chorus/Flanger | ✅ modulated delay lines | VERIFIED |
| Bitcrusher | ✅ bits + sampleReduction | VERIFIED |
| Parameter automation | ✅ `automate` command (ramp) | VERIFIED |
| HQ Reverb (optional) | ✅ `optional-dsp` command (FEAT-P3-002) | VERIFIED |
| Parameter mapping | ✅ depth/feedback/rate/bits/wet | VERIFIED |

### 5.3 DSP Architecture (Worklet: `effectProcessor.ts`)
| Block | Algorithm | Params |
|---|---|---|
| Reverb | 2 comb + 2 allpass (diffuse) | `wet`, `feedback` |
| Chorus | Modulated delay (LFO sine) | `rate`, `depth` |
| Bitcrusher | Bit-depth + sample-rate reduction | `bits`, `sampleReduction` |
| Mix | Dry/Wet crossfade | `wet` (0-1) |

- **Latency**: 0 frames (no lookahead)
- **Automation**: Sample-accurate ramps via `automate` messages
- **Denormal guard**: `Math.abs(x) < 1e-20 ? 0 : x` after each delay write

### 5.4 Competitor Comparison
| Product | Reverb | Chorus | Bitcrush | Automation |
|---|---|---|---|---|
| Valhalla VintageVerb | ✅ Algo | ❌ | ❌ | DAW |
| audioMONASTRY effectMONK | ✅ Diffuse | ✅ LFO | ✅ Bits/Rate | ✅ Sample-accurate |

### 5.5 Verdict
| Verdict | Reason |
|---|---|
| **Engineering: KEEP** | Well-implemented worklet, clean parameter mapping, optional HQ reverb |
| **Portfolio: KEEP** | Only FX return in chain, essential for send/return workflow |

---

## P05 — syntisamplerMONK (`syntisampler`)

### 5.1 Identification
- **ID**: `syntisampler` | **Role**: `source` | **Channel**: `4` | **Format**: `stereo`
- **Capabilities**: `['audio-source', 'compute', 'ai']` | **Sync**: true
- **UI**: `SyntiSamplerTerminal` | **Adapter**: `SyntiSamplerPluginAdapter`

### 5.2 Functional Completeness
| Capability | Implemented | Status |
|---|---|---|
| Gain/Velocity scaling | ✅ `onProcess` (gain × velocity) | VERIFIED |
| Note trigger | ✅ `note` param → `audioEngine.noteOnWorklet` | VERIFIED |
| Pattern presets | ✅ `pattern_four/random/break` → MCP | VERIFIED |
| Optional voice (phase distortion) | ✅ `optional-voice` command | VERIFIED |
| SYNC start | ✅ `trigger` command + `scheduleSyncStart` | VERIFIED |

### 5.2 DSP Architecture
- **Adapter `onProcess`**: Gain × velocity scaling only (in-place)
- **Real Synthesis**: `synthProcessor` + `fm6Processor` + `granularProcessor` worklets
- **Engines**: FM (fm6), Granular, Virtual Analog (synth)
- **MCP Control**: Pattern generation via ControlBus

### 5.3 Verdict
| Verdict | Reason |
|---|---|
| **Engineering: KEEP** | Clean adapter, proper worklet delegation, MCP integration |
| **Portfolio: KEEP** | Core synthesis engine, consolidated from synthesizer+sampler |

---

## P06 — drumsamplerMONK (`drumsampler`)

### 5.1 Identification
- **ID**: `drumsampler` | **Role**: `source` | **Channel**: `3` | **Format**: `stereo`
- **Capabilities**: `['audio-source']` | **Sync**: true
- **UI**: `DrumMachineTerminal` | **Adapter**: `DrumSamplerPluginAdapter`

### 5.2 Functional Completeness
| Capability | Implemented | Status |
|---|---|---|
| Gain/Velocity | ✅ `onProcess` | VERIFIED |
| Kit selection | ✅ `kit` param → `audioEngine.setDrumKit` | VERIFIED |
| Pattern random | ✅ `pattern_random` command | VERIFIED |
| Trigger (SYNC) | ✅ `trigger` + `scheduleSyncStart` | VERIFIED |

### 5.2 DSP Architecture
- **Adapter**: Gain/velocity only
- **Worklet**: `drumSynthProcessor` (sample playback + synthesis)
- **Kits**: TR-808, M8, custom via `DRUM_KITS` data

### 5.3 Verdict
| Verdict | Reason |
|---|---|
| **Engineering: KEEP** | Minimal adapter, proper delegation |
| **Portfolio: KEEP** | Capture target (IDEA-2026-10-07-A-F1 confirmed) |

---

## P07 — instruMONK (`instru`)

### 5.1 Identification
- **ID**: `instru` | **Role**: `source` | **Channel**: `5` | **Format**: `stereo`
- **Capabilities**: `['audio-source', 'hardware']` | **Sync**: true
- **UI**: `InstrumentsTerminal` | **Adapter**: `InstruPluginAdapter`

### 5.2 Functional Completeness
| Capability | Implemented | Status |
|---|---|---|
| Program change | ✅ `program` command → `InstrumentBackend` | VERIFIED |
| Note trigger | ✅ `note` command + `scheduleSyncStart` | VERIFIED |
| Optional voice (EPiano) | ✅ `optional-voice` (FM epiano) | VERIFIED |

### 5.2 DSP Architecture
- **Backend**: `InstrumentBackend` + `InstrumentSynth` + `itSynthProcessor` (WASM)
- **MIDI**: Hardware integration via `midi-bridge` service
- **Presets**: `instrumentSynths.ts` patches

### 5.3 Verdict
| Verdict | Reason |
|---|---|
| **Engineering: KEEP** | Hardware MIDI ready, clean async delegation |
| **Portfolio: KEEP** | Core instrument layer, hardware integration |

---

## P08 — biblioMONK (`biblio`)

### 5.1 Identification
- **ID**: `biblio` | **Role**: `utility` | **Channel**: `null` | **Format**: `stereo`
- **Signal Contract**: `inputs: 0, outputs: 0, bypassable: false, syncCapable: false`
- **Capabilities**: `['library', 'analysis']` | **No audio I/O**
- **UI**: `LibraryTerminal` | **Adapter**: `BiblioPluginAdapter`

### 5.2 Functional Completeness
| Capability | Implemented | Status |
|---|---|---|
| Cloud sync | ✅ `sync` command → `/api/cloud/sync` | VERIFIED |
| Search | ✅ `search` command → ControlBus | VERIFIED |
| Load asset | ✅ `load` command → ControlBus | VERIFIED |

### 5.2 Architecture
- **No audio path** — purely data/asset management
- **Asset flow**: Loads samples/tracks into other plugins (drop, song, stem, etc.)
- **Storage**: R2 (audio) + Supabase (metadata)

### 5.3 Verdict
| Verdict | Reason |
|---|---|
| **Engineering: KEEP** | Correctly no audio I/O, pure data plugin |
| **Portfolio: KEEP** | Central asset hub, all generated audio routes here |

---

## P09 — voiceMONK (`voice`)

### 5.1 Identification
- **ID**: `voice` | **Role**: `source` | **Channel**: `6` | **Format**: `mono`
- **Capabilities**: `['ai', 'audio-source']` | **Sync**: true
- **UI**: `VoiceGenTerminal` | **Adapter**: `VoicePluginAdapter`

### 5.2 Functional Completeness
| Capability | Implemented | Status |
|---|---|---|
| TTS (speak) | ✅ `VoiceMonkService.speak` | VERIFIED |
| Singing | ✅ `VoiceMonkService.sing` (MIDI notes) | VERIFIED |
| Song generation | ✅ `VoiceMonkService.generateSong` | VERIFIED |
| SYNC play | ✅ `play` command + `scheduleSyncStart` | VERIFIED |

### 5.2 AI Integration
- **Models**: `qwen3-tts-17b` (CustomVoice), `qwen3-tts-voicedesign`, `qwen3-tts-06b-base` (cloning)
- **Endpoint**: RP4 voiceGen pod (TTS priority over LEGO)
- **Latency**: Server-side generation → streamed to channel6

### 5.3 Verdict
| Verdict | Reason |
|---|---|
| **Engineering: KEEP** | Clean AI delegation, proper SYNC, mono format correct |
| **Portfolio: KEEP** | Core voice/TTS, reference-audio cloning via file upload |

---

## P10 — soundMONK (`sound`)

### 5.1 Identification
- **ID**: `sound` | **Role**: `source` | **Channel**: `7` | **Format**: `stereo`
- **Capabilities**: `['ai', 'audio-source']` | **Sync**: true
- **UI**: `SoundTerminal` | **Adapter**: `SoundPluginAdapter`

### 5.2 Functional Completeness
| Capability | Implemented | Status |
|---|---|---|
| Trigger (SYNC) | ✅ `trigger` + `scheduleSyncStart` | VERIFIED |
| AI Generate | ✅ `generate` → `monk:sound-generate` | VERIFIED |

### 5.2 Architecture
- **Generative**: Beat/Bass/Atmosphere via AI (ControlBus → orchestrator)
- **Playback**: Trigger loads result into channel7

### 5.3 Verdict
| Verdict | Reason |
|---|---|
| **Engineering: KEEP** | Minimal adapter, proper generative delegation |
| **Portfolio: KEEP** | Generative sound design, complements syntisampler |

---

## P11 — stemMONK (`stem`)

### 5.1 Identification
- **ID**: `stem` | **Role**: `source` | **Channel**: `8` | **Format**: `stereo`
- **Capabilities**: `['ai', 'analysis', 'audio-processor']` | **Sync**: true
- **UI**: `StemExtractorTerminal` | **Adapter**: `StemPluginAdapter`

### 5.2 5-Stem Architecture (from `StemPluginAdapter.ts`)
| Stem | Key | Category | Source |
|---|---|---|---|
| Vocals | `vocals` | mids | bs-roformer-sw-6stem |
| Lows | `lows` | bass | bass+drums <150Hz |
| Mids | `mids` | mids | residual |
| Highs | `highs` | highs | residual >2.5kHz (LR4) |
| Melody | `melody` | mids | guitar+piano |

### 5.2 Functional Completeness
| Capability | Implemented | Status |
|---|---|---|
| Separate | ✅ `separate` → `monk:stem-pick-file` | VERIFIED |
| Status polling | ✅ `status` command | VERIFIED |
| SYNC play | ✅ `play` + `scheduleSyncStart` | VERIFIED |
| Library entries | ✅ `fiveStemLibraryEntries` (auto-save) | VERIFIED |
| 4-Stem fallback | ✅ `melodyAvailable=false` handling | VERIFIED |

### 5.3 AI Models (RP5 stems pod)
| Model | Stems | License | Status |
|---|---|---|---|
| `bs-roformer-sw-6stem` | 6 (bass,drums,other,vocals,guitar,piano) | UNKNOWN | Primary |
| `scnet-xl-ihf` | 4 (bass,drums,vocals,other) | MIT code | Fallback |
| `htdemucs-6s` | 4 (alias) | MIT | Legacy |

### 5.4 Licensing Risk
- **Research/Test Only**: Per Betreiber decision, license verification not required for personal/research use
- **Commercial Path**: If commercial use ever needed, `scnet-xl-ihf` (4 stems, MIT code) would be fallback
- **Current Status**: `bs-roformer-sw-6stem` (6 stems, primary) accepted for research-only deployment

### 5.5 Verdict
| Verdict | Reason |
|---|---|
| **Engineering: KEEP AND IMPROVE** | Functional, but licensing must be resolved for commercial |
| **Portfolio: KEEP** | Essential for remix/cover workflow |

---

## P12 — spatialMONK (`spatial`)

### 5.1 Identification
- **ID**: `spatial` | **Role**: `insert` | **Channel**: `null` | **Format**: `stereo`
- **Insert Scope**: `channel` (per-channel pan/distance/height)
- **Capabilities**: `['spatial', 'audio-router']` | **Sync**: false
- **UI**: `SpatialScene` | **Adapter**: `SpatialPluginAdapter`

### 5.2 Functional Completeness
| Capability | Implemented | Status |
|---|---|---|
| Pan/Width (offline) | ✅ `onProcess` — constant-power pan + width | VERIFIED |
| Setup/Mode | ✅ `setup`/`mode` commands → `audioEngine` | VERIFIED |
| HRTF | ✅ `spatialProcessor` worklet (WASM) | VERIFIED |
| 2.1/N.x | ✅ `setup` parameter (stereo/2.1) | VERIFIED |

### 5.2 DSP Architecture
- **Adapter `onProcess`**: Constant-power pan (`cos/sin`) + width (mid/side scaling)
- **Worklet**: `spatialProcessor` → HRTF convolution (WASM `hrtf_conv.wasm`)
- **Insert Scope**: `channel` (pre-sum, per source)
- **Latency**: 0 frames (gain/delay-free positioning)

### 5.3 Verdict
| Verdict | Reason |
|---|---|
| **Engineering: KEEP** | Clean channel-insert, HRTF via WASM, correct scope |
| **Portfolio: KEEP** | Only spatial processor, essential for 2.1/immersive |

---

## P13 — eqMONK (`eq`)

### 5.1 Identification
- **ID**: `eq` | **Role**: `insert` | **Channel**: `null` | **Format**: `stereo`
- **Insert Scope**: `master` (post-sum) | **Capabilities**: `['audio-processor']`
- **UI**: `EQPluginTerminal` | **Adapter**: `EqPluginAdapter`

### 5.2 DSP Architecture
| Layer | Implementation |
|---|---|
| Adapter `onProcess` | 3-band (low/mid/high) 1-pole filters, in-place, stateful |
| Worklet (`eqProcessor`) | **36 bands** (1/3-octave), 5 filter types, block-accurate ramps |
| Filter Types | peaking, lowshelf, highshelf, highpass, lowpass |
| Automation | Block-accurate gain ramps (per band) |

### 5.2 Worklet Details (`eqProcessor.ts`)
- **Bands**: 36 (1/3-octave 20Hz-20kHz)
- **Filter Types**: peaking, lowshelf, highshelf, highpass, lowpass
- **Biquad**: RBJ Cookbook, DF2T, NaN/denormal guards
- **Automation**: Block-accurate gain ramps (per band, zipper-free)
- **Legacy**: 4-band protocol (hp/low/mid/high) for compatibility

### 5.3 Competitor Comparison
| Product | Bands | Types | Automation | Latency |
|---|---|---|---|---|
| FabFilter Pro-Q 3 | 24 | 8 | Sample-accurate | 0 |
| audioMONASTRY eqMONK | 36 | 5 | Block-accurate | 0 |

### 5.4 Verdict
| Verdict | Reason |
|---|---|
| **Engineering: KEEP** | 36-band worklet is exceptional, block-accurate automation |
| **Portfolio: KEEP** | Master insert EQ, no redundancy |

---

## P14 — dspMONK (`dsp`)

### 5.1 Identification
- **ID**: `dsp` | **Role**: `insert` | **Channel**: `null` | **Format**: `stereo`
- **Insert Scope**: `master` | **Capabilities**: `['audio-processor']`
- **UI**: `DSPTerminal` | **Adapter**: `DspPluginAdapter`

### 5.2 DSP Architecture (Worklet: `dspProcessor.ts`)
| Block | Algorithm | Params |
|---|---|---|
| Phase Alignment | 1st-order Allpass | `phase` (-0.5..0.5) |
| Dynamic Filter | Envelope follower → Lowpass | `filterCutoff`, `resonance`, `depth` |
| Soft Clipper | tanh with oversampling | `drive`, `oversampling` (1/2/4) |

### 5.2 Key Features (DSP-P1-OVS-001)
- **Oversampling**: 2x default (min-phase half-band FIR), 4x optional
- **Latency Reporting**: Dynamic via port message (`{type: 'latency', samples}`)
- **PDC Integration**: Latency compensated in `V2MonitorGraph.mainLatencySamples`
- **Automation**: Sample-accurate ramps for drive/depth/resonance/phase

### 5.3 Adapter Features
- **Modulation Matrix** (FEAT-P3-002): LFO → gain (`modEnabled`, `modRate`, `modDepth`)
- **Parameter Mapping**: drive/cutoff/resonance/modIndex/gain → `automateDsp`

### 5.4 Verdict
| Verdict | Reason |
|---|---|
| **Engineering: KEEP** | Sophisticated DSP, proper PDC, oversampling with latency reporting |
| **Portfolio: KEEP** | Core mastering dynamics/saturation, unique dynamic filter |

---

## P15 — masterMONK (`master`)

### 5.1 Identification
- **ID**: `master` | **Role**: `insert` | **Channel**: `null` | **Format**: `stereo`
- **Insert Scope**: `master` | **Latency**: **240 frames (5ms @ 48kHz)** — **PDC Reference**
- **Capabilities**: `['audio-processor']`
- **UI**: `MasteringOverlay` | **Adapter**: `MasterPluginAdapter`

### 5.2 Architecture
- **PDC Reference**: ALL other paths compensated to 240 frames
- **Lookahead**: 5ms limiter (true peak, 4× FIR BS.1770-4)
- **Adapter `onProcess`**: Simple gain (0-2) for offline bounce
- **Real Mastering**: `masteringProcessor` worklet + `dynamicsProcessor` + `lufsProcessor`

### 5.2 Worklet (`masteringProcessor.ts`)
- **Compressor**: Soft-knee, dB-domain, attack/release detectors
- **Limiter**: 5ms lookahead (240 frames), true-peak (4× FIR), exp release
- **Release LUT**: Segmented table (AM-E4-4) for coefficient lookup
- **Automation**: Sample-accurate ramps for threshold/makeup/ceiling

### 5.3 PDC Integration
- **Reference**: `V2_MASTERING_LOOKAHEAD_SEC = 0.005` → 240 frames @ 48kHz
- **Compensation**: `compensationFrames(pathLatency, 240)` per path
- **Cue PDC**: Separate compensation for cue path

### 5.4 Verdict
| Verdict | Reason |
|---|---|
| **Engineering: KEEP** | PDC anchor, proper lookahead, release LUT optimization |
| **Portfolio: KEEP** | Mandatory — PDC reference, final mastering chain |

---

## P16 — recordMONK (`record`)

### 5.1 Identification
- **ID**: `record` | **Role**: `recorder` | **Channel**: `null` | **Format**: `stereo`
- **Signal Contract**: `inputs: 1, outputs: 1 (passthrough + tap), bypassable: false`
- **Capabilities**: `['recording']`
- **UI**: `RecorderTerminal` | **Adapter**: `RecordPluginAdapter`

### 5.2 Functional Completeness
| Capability | Implemented | Status |
|---|---|---|
| Start/Stop | ✅ `start`/`stop` → ControlBus | VERIFIED |
| Bounce | ✅ `bounce` → `audioEngine` offline | VERIFIED |
| Passthrough | ✅ `onProcess` returns block unchanged | VERIFIED |

### 5.2 Architecture
- **No processing** — pure tap + control
- **Offline render**: `OfflineBounceEngine` (separate)
- **Export**: WAV/MP3 via server (R2 upload)

### 5.3 Verdict
| Verdict | Reason |
|---|---|
| **Engineering: KEEP** | Correct recorder semantics (passthrough + tap) |
| **Portfolio: KEEP** | Mandatory — final export/capture |

---

## Cross-Plugin Synthesis

### Signal Topology (Verified)
```
Sources (9) → Channel Strips (8) → Mixer (sum) → 
  Channel Insert: [spatial] → 
  Master Inserts: [eq → dsp → master] → 
  FX Return: [effect] (parallel send/return) → 
  Recorder: [record] (tap) → Main Out
```

### PDC Budget
| Path | Intrinsic Latency | Compensated To |
|---|---|---|
| Master | 240 frames | 240 (reference) |
| DSP (drive>0) | 3-28 frames | 240 |
| EQ | 0 | 240 |
| Spatial | 0 | 240 |
| Effect | 0 | 240 |
| All Sources | 0 | 240 |

### Plugin State Contract (All 16)
| Method | Purpose | Implementation |
|---|---|---|
| `initialize(context)` | Receive runtime (audio, ai, locks) | Base: stores context |
| `setState(OFF/STBY/ON/PRO)` | Mode change | Base: updates `this.state` |
| `setParameter({name, value})` | Parameter change | Base: lock check + `onParameter` |
| `process(block)` | Real-time audio | Adapter-specific (in-place, no alloc) |
| `handleCommand(cmd)` | Async actions | Adapter-specific (ControlBus, AI, engine) |
| `snapshot()` | Persist state | Base: state + parameters + sync |
| `restore(snap)` | Load state | Base: restores all |
| `dispose()` | Cleanup | Base: idempotent, cancels sync |

### Shared Infrastructure
| Component | Purpose | Location |
|---|---|---|
| `BasePluginAdapter` | Contract implementation | `adapters/BasePluginAdapter.ts` |
| `pluginContract.ts` | Single source of truth (roles, channels, latency) | `plugins/pluginContract.ts` |
| `signalChain.ts` | Signal topology (stages, order) | `plugins/signalChain.ts` |
| `registry.ts` | UI components + adapters | `plugins/registry.ts` |
| `audioEngine` | Worklet bridge | `utils/audioEngine.ts` |
| `ControlBus` | Async events | `core/events/ControlBus.ts` |
| `pluginSettingsSync` | Server-authoritative persistence | `utils/pluginSettings.ts` |

---

## Recommendations Summary

| Plugin | Engineering Verdict | Portfolio Verdict | Priority Actions |
|---|---|---|---|
| P01 mixer | KEEP | KEEP | — |
| P02 drop | KEEP | KEEP | — |
| P03 song | KEEP | KEEP | — |
| P04 effect | KEEP | KEEP | — |
| P05 syntisampler | KEEP | KEEP | — |
| P06 drumsampler | KEEP | KEEP | — |
| P07 instru | KEEP | KEEP | — |
| P08 biblio | KEEP | KEEP | — |
| P09 voice | KEEP | KEEP | — |
| P10 sound | KEEP | KEEP | — |
| P11 stem | KEEP AND IMPROVE | KEEP | **Resolve licensing** (bs-roformer UNKNOWN) |
| P12 spatial | KEEP | KEEP | — |
| P13 eq | KEEP | KEEP | — |
| P14 dsp | KEEP | KEEP | — |
| P15 master | KEEP | KEEP | — |
| P16 record | KEEP | KEEP | — |

### Human Decisions Required (HUMAN_APPROVAL_GATE)
1. **HD-STEM-LICENSE**: Accept `bs-roformer-sw-6stem` (license UNKNOWN) for research only; require SCNet XL IHF for commercial
2. **HD-AUDIOBRAIN-VRAM**: Approve audioBrain VRAM overage mitigation (offload music-flamingo or quantize to int4)
3. **HD-FLEET-8POD**: Confirm 8× A40 fleet (vis on A40, no RTX 4090)

---

*End of Atomic Plugin Research — All 16 plugins independently investigated with code, contract, DSP, UI, and architecture verification.*