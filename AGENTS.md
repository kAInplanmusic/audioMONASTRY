# 🚨 CRITICAL ARCHITECTURE & PROJECT RULES – READ BEFORE CODING 🚨

This document defines the absolute, unbreakable core principles of this application. Every agent, developer, and architect MUST read, understand, and adhere to these rules before writing a single line of code. Failure to comply will result in major architectural regression.

---

## 1. Core Architectural Pillars

### 1.1 The "Orchestra" Backend & "Main Sound"
* **The Orchestra:** The main backend acts strictly as an orchestrator. It manages state, routing, synchronization, and multi-user inputs.
* **The Main Sound:** The master audio engine lives within the core backend. It compiles, mixes, renders, and outputs the final audio signal.
* **Decoupled Plugins:** Everything else is a plugin. Plugins can be built as Docker containers, inline code modules, APIs, or HTTP services. The core backend does not care about the underlying tech stack of a plugin, only its standardized interface.

### 1.2 Frontend & Multi-User State Synchronization
* **The Screen:** The frontend is a unified "Stream Screen" component layout.
* **Up to 4 Users:** Up to four concurrent users can log into the exact same frontend session. 
* **Identical State Mirroring:** Every user sees a 100% identical, real-time copy of the main UI screen.
* **Concurrency & Locking (B2B / Busy Mode):** 
  * When a user interacts with or controls a specific plugin, that plugin immediately switches to **Locked Mode** (Visual feedback: grayed out / unalterable) for all other 3 users.
  * Other users can *only* toggle their local view of that plugin (Icon vs. Terminal View). They cannot alter its parameters while locked.
  * Plugins not controlled by a human must run either in **Off** mode or **Auto AI** mode.
  * This architecture must fully support remote collaboration with zero state desync.

### 1.3 The Ultra-Low Latency Mandate
* Every routing decision, network packet, and audio buffer calculation must be optimized for **sub-millisecond execution**.
* The final **Mastering Tool** requires a tightly controlled, predictable, and ultra-short time delay to process and master the live audio signal perfectly. Latency accumulation across plugins is a critical fail condition.

---

## 2. UI/UX & Plugin Interface Conventions

### 2.1 Top Navigation Bar
* All plugin icons are positioned in a single, horizontal row at the very top of the UI.
* Each icon has a distinct color scheme. This color code dynamically dictates the entire visual design, borders, and theme of that specific plugin's window when opened.

### 2.2 The "Terminal Plugin" Concept
Every plugin operates in one of three UI states:
1. **OFF:** The plugin is inactive. The top bar icon is dimmed/non-glowing.
2. **Auto AI Mode:** The plugin runs autonomously via AI. The top bar icon is glowing. The main workspace is clear.
3. **Professional Mode:** The full "Terminal Plugin UI" (the advanced tweak interface) is completely visible in the workspace.

---

## 3. Mandatory Plugin Catalog & Specifications

You are tasked with maintaining, improving, or developing the following plugin ecosystem:

### #1 Mischpult (DJ Mixer)
* **Spec:** 5-channel DJ mixer with A/B deck assignment (effectively 10 channels).
* **Aesthetics:** Styled after a modern Pioneer DJ hardware mixer.
* **Control:** Native, zero-configuration Plug & Play mapping for all standard MIDI controllers.

### #2 Sequenzer
* **Spec:** Modern touch-optimized step-sequencer.
* **Grid:** 16 bars/steps horizontally, 8 tracks/channels vertically.
* **Aesthetics:** Vividly color-coded matching high-end hardware production gear.

### #3 Sample- & Sound-Bibliothek (Library)
* **Spec:** Central repository for all assets. Fully loaded with high-end samples, full tracks, add-ons, and AI prompts.
* **Behavior:** Any newly generated audio, stem, or preset must automatically and silently save to this library in the background.

### #4 Drum-Machines & Synths (Junket)
* **Spec:** Fully functional emulations of classic electronic and techno hardware.
* **Mandatory Inclusions:** Accurate functional replicas of the Dirtywave M8, Roland TR-808, and similar iconic gear.

### #5 Instrumenten-Plugins
* **Spec:** Multi-instance capable asset pool containing a pre-selection of at least 50 standard instruments (e.g., Violin, Piano, Guitar, Drums, Trombone, Theremin, etc.).
* **Requirement:** 100% acoustic authenticity in sound generation and mathematically correct interface controls.

### #6 Spatial Surround Audio
* **Spec:** Panning array for multi-channel/surround speaker setups.
* **Function:** Interactive 2D vector path movement for individual stems or the entire spatial audio mix.

### #7 Equalizer (EQ)
* *Status:* Finished. Maintain API stability and visual integration.

### #8 Mastering Tool
* *Status:* Finished. Maintain absolute priority on low-latency audio delivery to this node.

### #9 MIDI Controller Profiles
* **Spec:** Visual and functional profiles for the industry's most common MIDI controllers.
* **Requirement:** Real-time hardware integration via Plug & Play with full visual mirroring on screen.

### #10 Effektmaschine (FX Engine)
* **Spec:** Multi-FX unit capable of emulating the routing, algorithms, and characteristics of top-tier hardware effects processors.

### #11 Remix & Cover Stem Extractor
* **Spec:** Audio import utility. Automatically analyzes uploaded songs and splits them into **5 discrete stems**:
  1. Vocals (Gesang)
  2. Lows (Tiefen / Bass)
  3. Mids (Mitten)
  4. Highs (Höhen)
  5. Melody (Melodie)
* **Automation:** On import, the plugin must automatically warp, time-stretch, and analyze the audio to match the current running project's BPM and key attributes. Outputs are saved to the Library.

### #12 Voice Generator (AI Vocalist)
* **Spec:** AI-driven text-to-speech and text-to-singing plugin.
* **Interface:** Prompt inputs, selection masks, and style presets. Works seamlessly as an automated sample assistant.

### #13 Open Extension Slot
* **Spec:** Keep the plugin registry architecture open to modularly inject further utilities tailored for producers, live DJs, and sound engineers.

### #14 Master Recorder
* **Spec:** Bit-perfect capture & export des finalen Mixes.

### #15 DSP Engine
* **Spec:** Worklet-Automation (Cutoff/Resonance/ModIndex/Gain/LFO) + Stimmen-Monitoring.

### #16 Visualizer
* **Spec:** OffscreenCanvas-Waveform-Visualizer im Web Worker.

### #17 Performance-Monitor
* **Spec:** Echtzeit-FPS/Jitter/Latenz-Budgets (Slot 17).

---
## 4. Development Workflow Rule
Before submitting any Pull Request or completing a code generation task, verify:
1. Did I introduce latency?
2. Does this break the 4-user real-time state synchronization?
3. Is the plugin locking mechanism (B2B mode) preserved?
4. `npm run verify` ist grün (tsc + Vitest + Interface-Boundary-Scan = 0 Verstöße).
5. Keys bleiben serverseitig – keine Secrets in Client-Code oder Bundles.
