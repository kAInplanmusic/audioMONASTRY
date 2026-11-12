# spatialMONK — MASTER TODO / SSOT v4
Status: 2026-11-09. This file consolidates decisions, requirements, implemented groundwork and unverified work. **Not a claim of production readiness.**

## 0. Product contract and release definition

- [ ] **P0** SpatialMONK is the one canonical 2D, ear-height spatial setup. Preserve mixerMONK / stereo DJ master, normal 2.2 Xonar U7 playback and unrelated plugins.
- [ ] **P0** UI has **X room width** and **Y room depth** as independent numeric metre inputs (e.g. 4 × 12 m). Dimensions describe the speaker area; do not silently subtract wall clearance.
- [ ] **P0** Club satellite selector contains **exactly 12 / 16 / 24 / 32**. Subwoofers are configured separately; 32 satellites + 2 independently driven subs requires 34 outputs.
- [ ] **P0** Optional two existing stereo front speakers: measured X/Y coordinates, immutable locked anchors, consume two satellite slots, never increase the total. Allow non-wall positions.
- [ ] **P0** Auto-plan placement, editable per-speaker positions and locked manual corrections. Preserve manual edits when toggling view modes; explicit reset/recalculate actions.
- [ ] **P0** Output hardware is a backend adapter; no changes to spatial DSP, project, scene or channel IDs when swapping Virtual ↔ USB ↔ LAN.
- [ ] **P0** Never claim perfect acoustic calibration from geometric coordinates alone. All measured EQ, delay, phase and SPL results require actual input measurements.

## 1. One spatialMONK rack and floating live visualizer (highest-priority feature)

- [ ] **P0** Merge the old square-only `SpatialXYRoomController` and new `SpatialClubSetup` into **one source of truth** for rectangular dimensions, speakers, subs, source positions and device mapping. Remove contradictory 12/16/18/24 selector from the active club flow; retain legacy layout migration.
- [ ] **P0** Rack contains a compact **ROOM / SPEAKERS** dropdown and **VISUALISIEREN** button.
- [ ] **P0** Clicking VISUALISIEREN opens a **persistent small floating panel** within the app: draggable, resizable, collapsible, closeable, remembered position and size; works while adjusting the rack and while music plays. Avoid popup blockers; prefer in-app overlay/window; optionally support separate browser window later.
- [ ] **P0** Draw rectangle at correct X:Y aspect ratio, speaker coordinates, locked L/R, subs, listener(s), channel IDs and source motion; scale for 4×12 and 12×4.
- [ ] **P0** Show **actual post-DSP/post-channel-map PCM** for each satellite as RMS/peak and activity LED, clip, mute, disconnected, unmapped, missing, latency/underrun; display meter units and threshold. A source trajectory animation is NOT proof of actual audio.
- [ ] **P0** Meter data pipeline: renderer PCM -> post-router metering -> bounded ring/MessagePort -> 20–30 Hz UI snapshots; audio thread must never wait for React.
- [ ] **P0** Built-in demo controls: FRONT/REAR/LEFT/RIGHT, front–rear alternating, circular motion, diagonal, square, figure-eight, all-off; individual channel solo/test with safe limits. Test the audio buffers, not only speaker icons.
- [ ] **P0** Visualizer stays open across parameter changes, adapts to new room/number of channels and clearly marks routing invalid until remapped.
- [ ] **P1** Allow user to inspect numeric per-channel meter history, export diagnostics and capture deterministic test traces.
- [ ] **P1** Accessible labels, keyboard shortcuts, reduced motion, small screens, UI lifecycle tests, cleanup on project close.

## 2. Virtual audio: internal by default; PipeWire only if needed

- [ ] **P0** Implement internal **VirtualSpatialOutput** as default when visualizing: accepts full 12/16/24/32 PCM frames, no OS sound device or driver, no install/uninstall, no interference with Xonar U7.
- [ ] **P0** Wire the AudioWorklet 32-channel DSP to the internal virtual sink via preallocated, lock-free or bounded IPC; test frames, channel order, timing, clipping and sample-rate changes.
- [ ] **P0** Create separate native **PipeWire bridge adapter** for Linux: enumerate server capabilities, negotiate 32-channel native SPA channel positions, create temporary sink/node **only when requested**, expose status in spatialMONK, attach PCM output and actual channel meters.
- [ ] **P0** Do not rely on PulseAudio AUX16–AUX31: not a portable documented channel map. Current `scripts/spatial-virtual-32.sh` deliberately fails safely; replace with verified native PipeWire implementation, not a fabricated working script.
- [ ] **P0** Lifecycle: start on demand, own node ID, detect collision, cleanly disconnect and remove owned node on Close/Stop/project exit; restore prior default device; never delete third-party nodes. Add crash recovery for orphaned nodes with ownership token and session ID.
- [ ] **P0** Security: per-user permissions, no root, no global system audio changes, localhost authenticated bridge only, bounded input sizes, no untrusted network audio by default.
- [ ] **P0** Browser capability gate: browser AudioDestinationNode may downmix/limit channels; do not claim OS 32-channel support from internal WebAudio alone. If necessary, use explicit native local bridge, and measure actual transmitted PCM.
- [ ] **P1** Support independent headless offline DSP render tests and 32-channel WAV/CAF export to inspect signals without hardware.
- [ ] **P1** Performance tests: 48 kHz / 128–512 sample blocks, 12/16/24/32, 4 collaborating users, high CPU load, underrun/overrun, sample drift, device loss, reopen, mute safety.

## 3. Canonical speaker geometry, motion and panning

- [ ] **P0** Deterministic layouts: 12=3 per wall; 16=3 per wall + four unique corners; 24=5 per wall + corners; 32=7 per wall + corners. Validate wall spacing and room aspect ratio; corner count only once.
- [ ] **P0** Validate fixed L/R coordinates, conflicts, minimum physical distances, obstructions and speaker mounting feasibility; if a locked speaker cannot be represented cleanly, show a warning and re-optimize unlocked positions rather than silently shifting locked points.
- [ ] **P0** Report speaker ID, X/Y metres, azimuth from listener, distance, channel mapping, max angular gap and theoretical delay. Distinguish estimated geometric data from measured corrections.
- [ ] **P0** Evaluate real panning quality: equal-power adjacent-azimuth interpolation vs 2D VBAP vs DBAP for off-centre audience / rectangular clubs. Use reference document `Deep Research Spatial Hifi Audio.txt` (user-supplied; its equations and citations must be independently verified before implementing). Include front/rear localization, stereo phantom behaviour, diffuse sources, low-frequency summation and audible discontinuities.
- [ ] **P0** Stable DSP automation for circle, horizontal, vertical, square, diagonal, figure-eight, and custom paths; no loop teleport, sample/block accurate ramping and click prevention.
- [ ] **P1** Four freely assignable effect buttons with dropdown and text-prompt interpretation, independent source positions and motion preview; preserve project persistence and collaboration semantics.
- [ ] **P1** Test 4 simultaneous users changing same speaker/layout/preset; lock ownership, deterministic state conflict handling, reconnect and scene versioning.

## 4. Device-agnostic output and sponsor hardware

- [ ] **P0** Keep stable logical SAT01..SAT32, SUB01..SUB02 and separate physical ports. Store per-device channel map and sample rate; never assume same numbering for all devices.
- [ ] **P0** Capability-driven adapter interface: probe, negotiate clock/rate/channel count, open, write, meter, stop, release. Fail closed on collisions, unsupported rates, missing outputs, disconnected devices and invalid maps.
- [ ] **P0** Implement **USB ALSA/PipeWire adapter** with detection, output identity test, correct PCM packing, latency, buffer and clock handling.
- [ ] **P0** Implement **LAN adapter** based on actual sponsor protocol: AES67/RTP+PTP, Dante through supported licensed endpoints, AVB/Milan or vendor API as applicable. Ethernet connector alone does NOT imply compatibility. Verify multicast, QoS, synchronization, packet loss, clock domain and security.
- [ ] **P0** The app selects detected adapter in one device dropdown, maps channels, offers TEST/CONFIRM, saves device profile and returns to virtual mode on explicit request. No changes to spatial renderer or project data.
- [ ] **P1** RME Digiface USB + four ADA8200 at 48 kHz as **reference only**, not a required purchase. Four ADAT banks × 8 = 32 analogue line outs; 96 kHz S/MUX reduces available ADAT count. 32+2 subs needs additional proper output plan. Verify ALSA driver/kernel and reported stream-start corruption before enabling amplifiers.
- [ ] **P1** Build mock device capability profiles (32 USB, 32 LAN, 34 discrete) and contract tests, then certify actual sponsor model with hardware loopback.
- [ ] **P0** Keep physical amp power and volume safe during mapping tests; require explicit user confirmation.

## 5. Xonar U7 and acoustic measurement wizard

- [ ] **P0** Preserve U7 stereo/2.2 listening independently of virtual spatial outputs. Verify actual Linux U7 capture/playback controls and full-duplex capabilities; do not assume mic jack phantom power.
- [ ] **P0** Separate `EINMESSEN` button in spatialMONK, enabled only if compatible interface and input are verified, permission is granted and output safety checklist passes.
- [ ] **P0** Mode A: calibrated measurement mic with imported frequency-response calibration TXT/FRD, optional sensitivity, sweep and timing reference; verify format, mic orientation and sample rate.
- [ ] **P0** Mode B: ordinary mic with approximate known response; only relative level, coarse bands and confidence-qualified arrival timing. Do NOT claim accurate absolute SPL or fine EQ; triangulation requires known multiple mic positions and timing reference.
- [ ] **P0** Iterative measurements: channel-by-channel low-level probe, logarithmic sweep, >=3 valid repetitions per position, 3–5 mic positions where feasible; detect noise, clipping, timing reference, impulse response reliability, speaker misrouting, polarity, gain and frequency response.
- [ ] **P0** Apply bounded delay, level and EQ only as user-confirmed **session-only** reversible corrections; A/B compare and rollback. Never automatically overwrite permanent settings or DJ stereo path.
- [ ] **P0** No acoustic correction when only virtual outputs exist: digital loopback tests verify routing/processing but not room response.
- [ ] **P1** Global app settings TODO: standalone **Audio Interface / Routing / Microphone / Measurement Setup** for every plugin, with calibrated mic, input quality, channel identity and session profiles.
- [ ] **P1** Use REW measurement methodology as reference (log sweeps, IR, mic calibration); REW is free-to-use but not generally open-source. Only use licensed/open DSP implementations or original code after license review.

## 6. Quality gates and test strategy

- [ ] **P0** Static checks and unit tests passing: `clubPlanner.ts`, `virtualInterface.ts`, `outputAdapter.ts`, channel layouts, motion, calibration schedule. Tests currently committed but NOT confirmed run.
- [ ] **P0** Fix and unify any duplicated UI state and output layout registries. Check TypeScript, lint, build, vitest, E2E in clean environment.
- [ ] **P0** Deterministic signal tests: channel 1..32 one at a time, front/rear oscillation, all mute, 32-channel identity matrix, phase polarity, panning energy, delayed impulse and clipping; assert actual post-routing PCM.
- [ ] **P0** Visual snapshot matches signal for each channel; zero false LEDs, missing mapping visible, measured update delay bounded and tested.
- [ ] **P0** Test process exit, browser refresh, unexpected crash, missing PipeWire, invalid PipeWire channel map, reconnect, different user sessions, Xonar U7 active simultaneously, default sink unchanged.
- [ ] **P0** Verify sample rate, bit depth and device output channels by capability probing; 32-channel browser limit and local bridge validated, not assumed.
- [ ] **P0** Hardware release only after real 32-channel device loopback, clock drift, multichannel DAC routing, speaker polarity, acoustic IR and safety tests. Simulation is NOT proof of hardware sound.
- [ ] **P1** Document test evidence: commands, environment, logs, audio checksums, failed cases, unresolved blockers, measured latency and acceptance criteria.

## 7. Implementation inventory (existing code; status must be verified)

- `src/core/spatial/v2/clubPlanner.ts`: rectangular 12/16/24/32 planner, fixed L/R, theoretical delays and adjacent panning.
- `src/components/spatial/SpatialClubSetup.tsx`: collapsible rectangular setup UI and static preview, **not a live PCM visualizer**.
- `src/components/spatial/SpatialXYRoomController.tsx`: legacy square-oriented XY controller and effect buttons; **not yet unified**.
- `src/core/spatial/v2/virtualInterface.ts`: pure PCM block metering, not connected to worklet.
- `src/core/spatial/v2/outputAdapter.ts`: adapter contract and virtual test prototype; USB and network implementations not present.
- `scripts/spatial-virtual-32.sh`: safety-gated experimental script; **does not currently start 32-channel native PipeWire node**.
- `docs/architecture/spatialMONK_REFERENCE_HARDWARE_VIRTUAL_MEASUREMENT.md` and `docs/architecture/spatialMONK_OUTPUT_TRANSPORT_CONTRACT.md`: design notes.
- `tests/spatialClubPlanner.test.ts`, `tests/spatialVirtualInterface.test.ts`, `tests/spatialOutputAdapter.test.ts`: committed tests; execution unverified.

## 8. Work order and definition of done

**Milestone A: In-app Virtual Spatial (first)**
- [ ] Canonical room setup + persistent floating live visualizer
- [ ] Full AudioWorklet PCM to internal 32-channel sink + post-routing meters
- [ ] Front/rear and individual channel identity tests
- [ ] Works with Xonar U7 2.2, no root, no PipeWire installation

**Milestone B: Linux virtual device**
- [ ] Native PipeWire bridge with verified 32-channel stream, auto create and safe cleanup
- [ ] Bridge diagnostics, crash recovery and explicit activation
- [ ] UI shows bridge state, real PCM activity and mapping validity

**Milestone C: Hardware-ready transport**
- [ ] USB/ALSA and LAN capability-based adapters + mock hardware tests
- [ ] Device picker, mapping, clock/latency and explicit hardware activation
- [ ] Sponsor hardware profile integration without DSP changes

**Milestone D: Acoustic measurements**
- [ ] U7 microphone verification, Mode A/Mode B, iterative sweeps
- [ ] Confidence-qualified room corrections, session-only reversible calibration
- [ ] Global audio interface/mic settings wizard

**Do not equate a 3-day implementation target with verified completion.** Milestone A may be developed rapidly, but real 32/34-channel physical validation requires hardware.

## Explicit acceptance scenario
User opens spatialMONK -> sets X=4m Y=12m, 32 satellites, optionally fixes L/R -> presses VISUALISIEREN -> persistent floating rectangle opens with correct aspect ratio -> plays front/rear alternation -> *actual PCM channel meters* on front/rear light correspondingly -> closes visualizer -> internal virtual sink releases with no system changes. If user selects native PipeWire mode, app creates and owns temporary node, verifies 32 channels, and cleans it on stop/crash recovery. Later a real USB/LAN interface can be selected by changing the output adapter and channel map only.
