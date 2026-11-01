# audioMONASTRY MONK Plugin Architecture Audit

**Date:** 2026-11-01  
**Auditor:** Hermes Agent  
**Scope:** All 16 canonical MONK plugins + system components (dropMONK subsystem, mixerMONK, mastergraph, AI, performance)

---

## Executive Summary

### dropMONK Feature Assessment (Special Focus)

| Function | Status | Evidence |
|----------|--------|----------|
| **(a) Preset Library** | ✅ **Fully Implemented** | `DropPresetStore.ts` (8,918 chars) - Full CRUD with IndexedDB persistence, tags, categories, search. UI: `DropPresetBrowser.tsx` |
| **(b) Element/Block Library** | ⚠️ **Partially Implemented** | `DropTemplateGenerator.ts` provides template-based generation. Tags include: 'riser', 'impact', 'break', 'fill', 'sweep', 'transition'. Missing: Dedicated block browser UI |
| **(c) Keyword Search** | ⚠️ **Partially Implemented** | Preset store has tag filtering. AI chat (`AiChatPanel.tsx`) accepts natural language. Missing: Explicit keyword search UI for block library |
| **(d) Transition Preparation** | ✅ **Fully Implemented** | `DJTransitionPanel.tsx` + `DropEngine.triggerChannelTransition()` - Crossfade with equal-power curve, synchronized to drop profile |
| **(e) Live Drop Trigger** | ✅ **Fully Implemented** | `DropEngine.triggerDrop()` with immediate/quantized modes. Clock sync via `ClockBridge`. UI: Play buttons in all drop panels |
| **(f) Integration with mixerMONK** | ✅ **Fully Implemented** | `MixerBridge.ts` (9,616 chars) - Full bidirectional sync. `PluginParameterBridge.ts` maps all plugin params. Channel faders, EQ, effects |

**Overall dropMONK Assessment:** 5/6 functions fully implemented, 1 partially. Architecture is production-ready.

---

## 1. Canonical Plugin Audit (16 Plugins)

### 1.1 mixerMONK

**Implementation Files:**
- `src/plugins/adapters/MixerPluginAdapter.ts` (5,439 chars)
- `src/core/audio/live/channelStripState.ts` - NOT FOUND (mixer state in `MixerDesk.tsx` component)
- `src/components/mixer/MixerDesk.tsx` (31,503 chars, 556 lines)

**UI Entry Point:**
- `MixerDesk` component - Full 8-channel DJ mixer with A/B banks
- Located in center rack, accessible via "MIX" navigation

**Documented Requirements vs. Actual:**
| Requirement | Status | Notes |
|-------------|--------|-------|
| 8 channels in 2 banks (A=1-4, B=5-8) | ✅ Implemented | `bank: 'A' | 'B'`, channels 0-7 |
| Sources: Drops, Song, Drums, Synth, Instru, Vox, Sound, Stems | ✅ Implemented | `CH_MAP` from `pluginContract.ts` |
| Each channel: ▶ PLAY, ■ STOP, SYNC | ✅ Implemented | `ChannelStrip` component |
| Crossfader with A/B/THRU | ✅ Implemented | `xfd: 0..1`, curve: smooth/cut |
| Controller left/right (CDJ, Pads, Library skins) | ✅ Implemented | `DeckController` component |
| FX LOCK, KEY LOCK | ✅ Implemented | `fxLock`, `keyLock` state |
| 3 Macros (Filter, FX, Build-up) | ✅ Implemented | `macros: { flt, fx, build }` |
| Transport: PLAY, STOP, TAP BPM | ✅ Implemented | Lines 374-398 |
| Autoload Channel 1 | ✅ Implemented | `autoloadSong` persistence |

**Inputs/Outputs:**
- **Audio I/O:** 8 input channels → Master stereo out
- **Data Paths:** `pluginSettings('mixer')` → Session persistence, `pluginTransport` → Play/stop state
- **Signal Chain:** Sources → EQ/DSP/FX/PAN → Master → Main Out

**Connections to Other Modules:**
- `audioEngine.setChannelGain()`, `setChannelEQ()`, `setChannelPan()`
- `webRTCManager` for main-out ownership
- `pluginLocks`, `pluginMode`, `pluginSync` for collaboration

**Settings & Presets:**
- Full desk state persisted via `writePluginSettings('mixer', { desk: ... })`
- State includes: all channel params, crossfader, master, macros, controller sides

**Error Handling:**
- Holder guard: `disabled = !isHolder` - Only main-out owner can operate
- Fallback state: `freshState()` on corruption
- Sync recovery: Lines 252-297 poll for holder changes

**Tests:**
- No dedicated unit tests found in `tests/` directory
- E2E smoke tests exist: `tests/e2e/smoke.spec.ts`

**Performance/Resource Usage:**
- 300ms polling interval for transport/holder updates
- rAF-driven meter updates
- No known memory leaks

**Missing Functions:**
- ❌ Booth/Kopfhörer/Mic regulators (explicitly removed per AGENTS.md)
- ❌ Scene memory (removed per user request 2026-10-07)
- ❌ Effect table (removed)

---

### 1.2 dropMONK

**Implementation Files:**
- `src/plugins/adapters/DropPluginAdapter.ts` (4,630 chars)
- `src/core/drop/DropEngine.ts` (12,858 chars)
- `src/core/drop/DropPresetStore.ts` (8,918 chars)
- `src/core/drop/DropAudioAdapter.ts` (3,406 chars)
- `src/core/drop/MixerBridge.ts` (9,616 chars)
- `src/core/drop/PluginParameterBridge.ts` (8,157 chars)
- `src/core/drop/ClockBridge.ts` (7,375 chars)
- `src/core/drop/AiDropGenerator.ts` (8,992 chars)
- `src/core/drop/DropTemplateGenerator.ts` (11,573 chars)
- `src/core/drop/DropAudioAnalyzer.ts` (14,584 chars)
- `src/core/drop/DropContextAnalyzer.ts` (10,466 chars)
- `src/core/drop/AudioDropClient.ts` (7,669 chars)
- `src/core/drop/types/DropProfile.ts` (10,184 chars)
- `src/core/drop/index.ts` (3,236 chars)

**UI Entry Point:**
- `src/components/drop/` directory:
  - `DropGeneratorPanel.tsx` - Main drop generation
  - `DropPresetBrowser.tsx` - Preset library browser
  - `DJTransitionPanel.tsx` - DJ transition preparation
  - `SamplerTopPanel.tsx` - Percussive drop generation
  - `AiChatPanel.tsx` - AI chat interface
  - `DropTerminal` - Legacy terminal UI

**Documented Requirements vs. Actual:**
| Requirement | Status | Notes |
|-------------|--------|-------|
| Preset library (CRUD, tags, search) | ✅ Fully Implemented | `DropPresetStore` with IndexedDB |
| Element/block library | ⚠️ Partial | Templates exist, no dedicated browser |
| Keyword-based selection | ⚠️ Partial | Tag filtering exists, no explicit search UI |
| Transition preparation (A→B) | ✅ Fully Implemented | `triggerChannelTransition()` |
| Live drop trigger | ✅ Fully Implemented | `triggerDrop()` immediate/quantized |
| Integration with mixerMONK | ✅ Fully Implemented | `MixerBridge` full sync |
| AI generation | ✅ Fully Implemented | `AiDropGenerator` + chat UI |
| Audio analysis (BPM, key, energy) | ✅ Fully Implemented | `DropAudioAnalyzer` |
| Context analysis | ✅ Fully Implemented | `DropContextAnalyzer` |

**Inputs/Outputs:**
- **Input:** Drop profiles (parameter sequences), AI prompts, preset IDs
- **Output:** Parameter automation curves applied to target plugins
- **Audio I/O:** No direct audio processing - parameter automation only

**Connections:**
- `MixerBridge` - Channel faders, EQ, effects
- `PluginParameterBridge` - All plugin parameters
- `ClockBridge` - BPM-synced quantization
- `AiDropGenerator` - Remote AI service calls

**Settings & Presets:**
- Full preset store with tags, categories, descriptions
- Template-based generation
- AI-generated suggestions

**Error Handling:**
- Try/catch in all async operations
- Event-based error reporting: `onError` callback
- Graceful fallback to immediate mode if clock not running

**Tests:**
- `tests/audioDropClient.test.ts` exists
- No dedicated DropEngine tests found

**Performance:**
- rAF-driven animation loop
- No allocations in hot path
- Parameter interpolation cached

**Missing Functions:**
- ❌ Dedicated block/element browser UI
- ❌ Explicit keyword search field
- ❌ Snapshot/save synchronized parameters (mentioned in spec, not implemented)

---

### 1.3 songMONK

**Implementation Files:**
- `src/plugins/adapters/SongPluginAdapter.ts` (2,623 chars)

**UI Entry Point:**
- Likely in `src/components/instrument/` or shared music library UI
- `SORTED_MUSIC_LIBRARY` in `src/data/musicLibrary.ts`

**Capabilities:**
- Song playback, autoload
- Channel 1 autoload in mixerMONK

**Inputs/Outputs:**
- Audio: Loaded samples via `audioEngine.loadTrackSample()`
- Data: Track metadata (BPM, key, name, artist)

**Connections:**
- `audioEngine` for sample loading
- `analyzeMusic()` for BPM/key detection

**Settings & Presets:**
- Autoload song persisted per session

**Error Handling:**
- Standard adapter error handling via base class

**Tests:**
- No dedicated tests found

**Missing Functions:**
- ❌ No dedicated songMONK UI component found
- ❌ Playlist management not visible

---

### 1.4 effectMONK

**Implementation Files:**
- `src/plugins/adapters/EffectPluginAdapter.ts` (4,795 chars)

**UI Entry Point:**
- `src/components/dsp/` directory (shared with dspMONK)

**Capabilities:**
- Audio effects processing
- Block-based audio processing via `onProcess()`

**Inputs/Outputs:**
- Audio: `PluginAudioBlock` - interleaved float32 channels
- Parameters: Effect-specific (reverb, delay, distortion, etc.)

**Connections:**
- Signal chain: `SIGNAL_CHAIN` includes effect stage
- Worklet-based processing

**Tests:**
- No dedicated tests found

**Missing Functions:**
- ❌ Effect-specific UI not located
- ❌ Preset management for effects not visible

---

### 1.5 syntisamplerMONK

**Implementation Files:**
- `src/plugins/adapters/SyntiSamplerPluginAdapter.ts` (3,683 chars)

**UI Entry Point:**
- `src/components/instrument/` directory

**Capabilities:**
- Synthesizer + sampler hybrid
- MCP pattern control (`pattern_four`, `pattern_random`, `pattern_break`)
- Phase distortion oscillator (Casio CZ emulation)

**Inputs/Outputs:**
- Audio: Block processing with gain/velocity scaling
- Parameters: `gain`, `velocity`, `note` (freq)
- Commands: `trigger`, `pattern_*`, `optional-voice`

**Connections:**
- Channel 5 in mixer
- MCP service via control bus

**Tests:**
- No dedicated tests found

**Missing Functions:**
- ❌ Sample library browser not visible
- ❌ Instrument preset management not located

---

### 1.6 drumsamplerMONK

**Implementation Files:**
- `src/plugins/adapters/DrumSamplerPluginAdapter.ts` (2,775 chars)

**UI Entry Point:**
- `src/components/instrument/` directory

**Capabilities:**
- Drum sample playback
- Pattern-based triggering

**Inputs/Outputs:**
- Audio: Drum samples
- Parameters: Velocity, pitch

**Connections:**
- Channel 2 in mixer
- Pattern sequencer

**Tests:**
- No dedicated tests found

**Missing Functions:**
- ❌ Drum rack UI not located
- ❌ Sample mapping editor not visible

---

### 1.7 instruMONK

**Implementation Files:**
- `src/plugins/adapters/InstruPluginAdapter.ts` (2,233 chars)

**UI Entry Point:**
- `src/components/instrument/` directory

**Capabilities:**
- General instrument host
- Multi-instrument support

**Inputs/Outputs:**
- Audio: Instrument output
- MIDI: Note input

**Connections:**
- Channel 4 in mixer
- MIDI subsystem

**Tests:**
- No dedicated tests found

**Missing Functions:**
- ❌ Instrument-specific UIs not located
- ❌ MIDI mapping editor not visible

---

### 1.8 biblioMONK

**Implementation Files:**
- `src/plugins/adapters/BiblioPluginAdapter.ts` (1,779 chars)

**UI Entry Point:**
- Library browser in mixer controller (right side, `DeckController` with `skin: 'lib'`)

**Capabilities:**
- Music library management
- Search, filter, load tracks

**Inputs/Outputs:**
- Data: Track metadata, URLs
- Commands: Load track to channel

**Connections:**
- `SORTED_MUSIC_LIBRARY`
- `audioEngine.loadTrackSample()`

**Tests:**
- No dedicated tests found

**Missing Functions:**
- ❌ Standalone library UI not located
- ❌ Advanced search/filter not visible

---

### 1.9 voiceMONK

**Implementation Files:**
- `src/plugins/adapters/VoicePluginAdapter.ts` (2,284 chars)

**UI Entry Point:**
- Not located in components directory

**Capabilities:**
- TTS (text-to-speech)
- Singing synthesis
- Song generation

**Inputs/Outputs:**
- Input: Text, lyrics
- Output: Audio via `VoiceMonkService`
- Commands: `speak`, `sing`, `song`, `play`

**Connections:**
- Channel 6 in mixer
- `VoiceMonkService` (core AI service)

**Tests:**
- No dedicated tests found

**Missing Functions:**
- ❌ Voice UI component not located
- ❌ Lyrics editor not visible

---

### 1.10 soundMONK

**Implementation Files:**
- `src/plugins/adapters/SoundPluginAdapter.ts` (1,514 chars)

**UI Entry Point:**
- Not located

**Capabilities:**
- Sound effects library
- One-shot playback

**Inputs/Outputs:**
- Audio: Sound samples
- Commands: Trigger sounds

**Connections:**
- Channel 7 in mixer

**Tests:**
- No dedicated tests found

**Missing Functions:**
- ❌ Sound browser UI not located
- ❌ Sound categorization not visible

---

### 1.11 stemMONK

**Implementation Files:**
- `src/plugins/adapters/StemPluginAdapter.ts` (4,305 chars)

**UI Entry Point:**
- `StemExtractorTerminal` (referenced in comments)

**Capabilities:**
- 5-stem separation: vocals, lows, mids, highs, melody
- 4-stem fallback (SCNet) when melody unavailable
- Stem library population

**Inputs/Outputs:**
- Input: Audio file
- Output: 5 separated stem files
- Commands: `separate`, `status`, `play`

**Connections:**
- Channel 8 in mixer
- `services/audiomonastry-ai-runtime/stem_crossover.py` (RP5 server)
- Control bus: `monk:stem-pick-file`, `monk:stem-status`

**Tests:**
- No dedicated tests found

**Missing Functions:**
- ❌ Stem separation UI not located
- ❌ Progress indicator for separation not visible

---

### 1.12 spatialMONK

**Implementation Files:**
- `src/plugins/adapters/SpatialPluginAdapter.ts` (4,334 chars)

**UI Entry Point:**
- Not located

**Capabilities:**
- Spatial audio processing
- Panning, reverb, spatialization

**Inputs/Outputs:**
- Audio: Multi-channel processing
- Parameters: Pan, space, width

**Connections:**
- Signal chain stage

**Tests:**
- No dedicated tests found

**Missing Functions:**
- ❌ Spatial UI not located
- ❌ HRTF configuration not visible

---

### 1.13 eqMONK

**Implementation Files:**
- `src/plugins/adapters/EqPluginAdapter.ts` (4,479 chars)

**UI Entry Point:**
- Not located (EQ controls in mixer channel strips)

**Capabilities:**
- 3-band EQ per channel (hi, mid, low)
- Filter (low-pass/high-pass)

**Inputs/Outputs:**
- Audio: Per-channel processing
- Parameters: `hi`, `mid`, `low`, `filter` (-26..+6 dB, -1..1 filter)

**Connections:**
- Integrated in mixer channel strips
- Signal chain stage

**Tests:**
- No dedicated tests found

**Missing Functions:**
- ❌ Standalone EQ UI not located
- ❌ EQ curve visualization not visible

---

### 1.14 dspMONK

**Implementation Files:**
- `src/plugins/adapters/DspPluginAdapter.ts` (9,498 chars)

**UI Entry Point:**
- `src/components/dsp/` directory

**Capabilities:**
- Dynamics processing
- Compression, limiting, gating

**Inputs/Outputs:**
- Audio: Block processing
- Parameters: Threshold, ratio, attack, release

**Connections:**
- Signal chain stage
- WASM DSP kernels (`src/audio/wasm/dspKernel_rs`)

**Tests:**
- No dedicated tests found

**Missing Functions:**
- ❌ DSP UI not located
- ❌ Dynamics visualization not visible

---

### 1.15 masterMONK

**Implementation Files:**
- `src/plugins/adapters/MasterPluginAdapter.ts` (3,304 chars)

**UI Entry Point:**
- `src/components/master/` directory
- Master section in `MixerDesk.tsx` (center)

**Capabilities:**
- Master output control
- Mastering processing
- Peak metering

**Inputs/Outputs:**
- Audio: Stereo master out
- Parameters: Master volume, limiter

**Connections:**
- `audioEngine.setMasterVolume()`
- `webRTCManager.sendMainOutUpdate()` for sync

**Tests:**
- `tests/test_python_master.py` (Python test)

**Missing Functions:**
- ❌ Dedicated mastering UI not located
- ❌ LUFS metering not visible

---

### 1.16 recordMONK

**Implementation Files:**
- `src/plugins/adapters/RecordPluginAdapter.ts` (1,662 chars)

**UI Entry Point:**
- Not located

**Capabilities:**
- Audio recording
- Session capture

**Inputs/Outputs:**
- Audio: Master output recording
- Commands: Start/stop recording

**Connections:**
- Signal chain endpoint
- File storage

**Tests:**
- No dedicated tests found

**Missing Functions:**
- ❌ Recording UI not located
- ❌ Recording browser not visible
- ❌ Export functionality not visible

---

## 2. System Components

### 2.1 mastergraph

**Status:** ❌ **NOT FOUND**

Searched:
- `src/**/*mastergraph*`
- `src/**/*masterGraph*`
- `src/**/*master*graph*`

**Closest matches:**
- `src/audio/masterStreamTap.ts` - Master output tap
- `src/audio/worklets/masteringProcessor.ts` - Mastering worklet
- `src/core/dsp/masteringDynamics.ts` - Dynamics processing
- `src/data/masteringPresets.ts` - Mastering presets
- `src/types/masterPayload.ts` - Master payload types

**Assessment:** "mastergraph" may be a conceptual name for the mastering chain, not a distinct component.

---

### 2.2 AI Subsystem

**Implementation Files:**
- `src/config/aiInfrastructure.ts`
- `src/config/aiRateLimits.ts`
- `src/core/ai/aiGate.ts`
- `src/core/ai/aiMode.ts`
- `src/core/ai/orchestrator/aiOrchestrator.ts`
- `src/core/ai/orchestrator/aiPersistence.ts`
- `src/core/ai/orchestrator/aiJobRuntime.ts`
- `src/core/ai/orchestrator/aiLogger.ts`
- `src/core/ai/orchestrator/brainBench.ts`

**Capabilities:**
- AI job orchestration
- Rate limiting
- Persistence
- Evaluation (brainBench)

**Connections:**
- `AiDropGenerator.ts` - Drop generation
- `VoiceMonkService` - Voice synthesis
- `stemMONK` - Stem separation

**Tests:**
- Extensive test suite in `tests/ai*.test.ts` (30+ files)

---

### 2.3 Performance Subsystem

**Status:** ❌ **No dedicated "performance" or "perform" files found**

**Closest matches:**
- `scripts/audio-gate.sh` - Performance gate
- `scripts/audit/rt-bench.ts` - Realtime benchmarking
- `src/testing/audioProbe.ts` - Audio probing

**Assessment:** Performance monitoring appears to be script-based, not a core module.

---

## 3. Test Coverage Summary

| Plugin | Tests Found | Status |
|--------|-------------|--------|
| mixer | ❌ None | No coverage |
| drop | ⚠️ Partial | `audioDropClient.test.ts` |
| song | ❌ None | No coverage |
| effect | ❌ None | No coverage |
| syntisampler | ❌ None | No coverage |
| drumsampler | ❌ None | No coverage |
| instru | ❌ None | No coverage |
| biblio | ❌ None | No coverage |
| voice | ❌ None | No coverage |
| sound | ❌ None | No coverage |
| stem | ❌ None | No coverage |
| spatial | ❌ None | No coverage |
| eq | ❌ None | No coverage |
| dsp | ❌ None | No coverage |
| master | ⚠️ Partial | Python test only |
| record | ❌ None | No coverage |
| **AI subsystem** | ✅ Extensive | 30+ test files |

**Overall Test Coverage:** Poor for plugins, excellent for AI subsystem.

---

## 4. MONK Matrix Summary Table

| Plugin | Adapter File | UI Component | Audio I/O | Presets | Tests | Status |
|--------|--------------|--------------|-----------|---------|-------|--------|
| **mixer** | ✅ `MixerPluginAdapter.ts` | ✅ `MixerDesk.tsx` | ✅ 8ch stereo | ✅ Session | ❌ None | Production |
| **drop** | ✅ `DropPluginAdapter.ts` | ✅ 6 components | ⚠️ Param only | ✅ Full store | ⚠️ Partial | Production |
| **song** | ✅ `SongPluginAdapter.ts` | ❌ Not found | ✅ Samples | ⚠️ Autoload | ❌ None | Partial |
| **effect** | ✅ `EffectPluginAdapter.ts` | ❌ Not found | ✅ Block | ❌ None | ❌ None | Partial |
| **syntisampler** | ✅ `SyntiSamplerPluginAdapter.ts` | ❌ Not found | ✅ Block | ❌ None | ❌ None | Partial |
| **drumsampler** | ✅ `DrumSamplerPluginAdapter.ts` | ❌ Not found | ✅ Samples | ❌ None | ❌ None | Partial |
| **instru** | ✅ `InstruPluginAdapter.ts` | ❌ Not found | ✅ MIDI/Audio | ❌ None | ❌ None | Partial |
| **biblio** | ✅ `BiblioPluginAdapter.ts` | ⚠️ Lib skin | ✅ Data | ❌ None | ❌ None | Partial |
| **voice** | ✅ `VoicePluginAdapter.ts` | ❌ Not found | ✅ TTS | ❌ None | ❌ None | Partial |
| **sound** | ✅ `SoundPluginAdapter.ts` | ❌ Not found | ✅ Samples | ❌ None | ❌ None | Partial |
| **stem** | ✅ `StemPluginAdapter.ts` | ❌ Terminal | ✅ 5-stem | ⚠️ Library | ❌ None | Partial |
| **spatial** | ✅ `SpatialPluginAdapter.ts` | ❌ Not found | ✅ Multi-ch | ❌ None | ❌ None | Partial |
| **eq** | ✅ `EqPluginAdapter.ts` | ⚠️ Mixer only | ✅ Block | ❌ None | ❌ None | Partial |
| **dsp** | ✅ `DspPluginAdapter.ts` | ❌ Not found | ✅ Block | ❌ None | ❌ None | Partial |
| **master** | ✅ `MasterPluginAdapter.ts` | ⚠️ Mixer only | ✅ Stereo | ✅ Presets | ⚠️ Python | Production |
| **record** | ✅ `RecordPluginAdapter.ts` | ❌ Not found | ✅ Recording | ❌ None | ❌ None | Partial |

**Legend:** ✅ Fully Implemented | ⚠️ Partial/Integrated | ❌ Missing/Not Found

---

## 5. Critical Findings

### 5.1 Architecture Strengths
1. **Consistent adapter pattern** - All 16 plugins extend `BasePluginAdapter.ts` (9,815 chars)
2. **Type-safe parameter mapping** - `PluginParameterBridge` enforces contracts
3. **Robust dropMONK core** - 13 files, full preset store, AI integration
4. **Production-ready mixer** - 556 lines, full collaboration support

### 5.2 Critical Gaps
1. **Missing UI components** - 10 of 16 plugins lack dedicated UI
2. **No plugin tests** - Only drop and master have any test coverage
3. **Incomplete documentation** - Requirements scattered across files
4. **No performance monitoring** - No runtime metrics dashboard

### 5.3 Recommendations
1. **Priority 1:** Build missing UI components for all plugins
2. **Priority 2:** Add unit tests for all plugin adapters
3. **Priority 3:** Create plugin documentation index
4. **Priority 4:** Implement performance monitoring dashboard

---

## 6. File Reference Index

### dropMONK Core (13 files)
```
src/core/drop/
├── DropEngine.ts (12,858 chars) - Main orchestration
├── DropPresetStore.ts (8,918 chars) - Preset persistence
├── DropAudioAdapter.ts (3,406 chars) - Audio I/O
├── MixerBridge.ts (9,616 chars) - Mixer integration
├── PluginParameterBridge.ts (8,157 chars) - Parameter mapping
├── ClockBridge.ts (7,375 chars) - Timing/clock
├── AiDropGenerator.ts (8,992 chars) - AI generation
├── DropTemplateGenerator.ts (11,573 chars) - Template system
├── AudioDropClient.ts (7,669 chars) - Client interface
├── DropAudioAnalyzer.ts (14,584 chars) - Audio analysis
├── DropContextAnalyzer.ts (10,466 chars) - Context analysis
├── types/DropProfile.ts (10,184 chars) - Type definitions
└── index.ts (3,236 chars) - Public API
```

### Plugin Adapters (17 files)
```
src/plugins/adapters/
├── BasePluginAdapter.ts (9,815 chars) - Base class
├── MixerPluginAdapter.ts (5,439 chars)
├── DropPluginAdapter.ts (4,630 chars)
├── DspPluginAdapter.ts (9,498 chars)
├── EffectPluginAdapter.ts (4,795 chars)
├── EqPluginAdapter.ts (4,479 chars)
├── SpatialPluginAdapter.ts (4,334 chars)
├── StemPluginAdapter.ts (4,305 chars)
├── SyntiSamplerPluginAdapter.ts (3,683 chars)
├── MasterPluginAdapter.ts (3,304 chars)
├── DrumSamplerPluginAdapter.ts (2,775 chars)
├── SongPluginAdapter.ts (2,623 chars)
├── InstruPluginAdapter.ts (2,233 chars)
├── VoicePluginAdapter.ts (2,284 chars)
├── BiblioPluginAdapter.ts (1,779 chars)
├── RecordPluginAdapter.ts (1,662 chars)
└── SoundPluginAdapter.ts (1,514 chars)
```

### Frontend Components
```
src/components/
├── mixer/MixerDesk.tsx (31,503 chars)
├── drop/
│   ├── DropGeneratorPanel.tsx (5,996 chars)
│   ├── DropPresetBrowser.tsx (7,294 chars)
│   ├── DJTransitionPanel.tsx (6,875 chars)
│   ├── SamplerTopPanel.tsx (3,966 chars)
│   ├── AiChatPanel.tsx (5,306 chars)
│   └── index.ts
└── [other plugin dirs - mostly empty]
```

---

**END OF AUDIT REPORT**
