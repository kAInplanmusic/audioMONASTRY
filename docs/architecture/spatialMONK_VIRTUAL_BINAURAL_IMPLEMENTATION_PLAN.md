# spatialMONK Virtual 32 + Sony WF-1000XM4 — implementation SSOT
Status 2026-11-09: design and implementation backlog, NOT finished hardware or audio feature.

## Product
- [ ] One canonical rectangular room editor: independent X/Y dimensions, 12/16/24/32 satellites, locked existing L/R, separate subs, preserved source motion and stereo DJ operation.
- [ ] VISUALISIEREN opens a small persistent draggable/resizable in-app floating window, accurate room aspect ratio, speaker IDs, positions and post-render/post-channel-map PCM meters, peak/RMS, clipping, mute, mapping and stream errors.
- [ ] In-app virtual 32-channel sink is the default; it needs no OS driver, installation, PipeWire or physical hardware. Use true PCM samples, never planned animation as meter values.
- [ ] Controls for front/rear alternation, individual channel solo, circle, figure-eight, mute, numeric dBFS and optional trace export.
- [ ] BINAURAL MONITOR converts all 32 virtual speaker feeds to independent stereo output with HRTF HRIR convolution. Keep full virtual 32-channel bus and its meters active; Sony WF-1000XM4 use normal Bluetooth A2DP stereo output.
- [ ] HRTF dataset: inventory existing WASM HRTF pipeline (`build:wasm-hrtf`) and assets; select legally redistributable SOFA HRIR set, check sample rate, license, coordinates, interpolation, normalization and left/right impulse response.
- [ ] HRTF: correct interaural time/level differences, listener yaw and optional manual head orientation, click-free direction interpolation, bounded CPU, headroom, limiter and independent headphone volume. Generic HRTF front/back errors must be stated; simple stereo panning is NOT binaural.
- [ ] Bluetooth: expect variable latency, profile changes when microphone enabled, disconnects; do not assume Sony head tracking is available on Linux. Optional smartphone IMU bridge later.
- [ ] Audio graph: source DSP -> canonical SAT01..SAT32 PCM -> actual post-router meter -> internal virtual sink; parallel headphone binaural HRTF 32-to-2 monitor; optional physical USB/LAN output adapter. SUB01/SUB02 are separate buses (32+2 requires 34 physical outputs).
- [ ] Browser AudioDestinationNode can cap/downmix channels; native PipeWire bridge requires explicit channel negotiation and actual PCM verification. Never use Pulse AUX16–AUX31.
- [ ] Native PipeWire 32-channel node only when explicitly selected: create under current user, verify actual channel count, own node ID, remove on close, recover orphan after crash, never change default system output without consent. No root.
- [ ] USB via ALSA/PipeWire and LAN via actual protocol (AES67/RTP/PTP, licensed Dante endpoints, AVB/Milan as supported) share one adapter contract. Sponsor hardware changes adapter/channel mapping only, never spatial scene/DSP.
- [ ] U7 2.2 stays independent. Later measurement wizard A calibrated mic+file, B standard mic approximate; repeat sweeps at known positions, confidence, reversible session-only correction, no absolute SPL claims.

## Agents and dependencies
**A / Room+UI**: inspect `SpatialScene.tsx`, `SpatialClubSetup.tsx`, `SpatialXYRoomController.tsx`; unify state and legacy migrations; implement floating overlay, aspect-correct layout, persisted placement, accessibility and cleanup.
**B / Audio**: inspect worklets, `virtualInterface.ts`, `outputAdapter.ts`; implement bounded real-time PCM tap, 20–30Hz meter aggregation, 32-channel identity and routing tests.
**C / HRTF**: inspect existing WASM HRTF and license; implement true 32-to-2 convolver, yaw, HRTF profile selection, smooth transitions, limiter and headphone device selection. No mock audio labelled as working.
**D / Linux+Devices**: native PipeWire bridge, owned node lifecycle, capability probe, USB/LAN mocks, future physical device certification.
**E / QA**: tests, evidence, regressions, security and performance.

## Detailed acceptance tests
- [ ] X=4 Y=12 and X=12 Y=4 preserve geometry, fixed anchors and output labels.
- [ ] Each 1..32 PCM impulse appears only on matching virtual channel and meter.
- [ ] Front/rear repeated movement lights corresponding real PCM output; no false LEDs.
- [ ] Closing/reopening visualizer does not change audio or default Linux sink.
- [ ] HRIR convolution impulse output matches known L/R HRIR kernels; orientation front/right/rear/left and yaw signs correct; no NaN, channel swaps or clicks.
- [ ] Binaural output plays stereo on Sony A2DP, while 32 virtual channels remain intact; manual actual hardware test required.
- [ ] Switching output modes never modifies project or DJ stereo bus; invalid mappings fail closed.
- [ ] PipeWire creates and removes only owned nodes, crash recovery and concurrent sessions tested.
- [ ] 48kHz / 128–512 samples / 12–32 channels / 4 collaborative users; record underruns, CPU and latency.
- [ ] npm run typecheck; npm run lint; npm test; npm run build; targeted E2E; document environment and logs. No tests claimed passed without execution.

## Sprint estimate (not guarantee)
Day 1: canonical room, persistent live visualizer, actual PCM identity tests.
Day 2: licensed HRIR and 32-to-2 binaural monitor, headphones, impulse and azimuth tests.
Day 3: integration, Linux bridge feasibility, lifecycle and regression gates. Sponsor hardware and acoustic validation are separate gates.

## Existing code and gaps
Existing: `clubPlanner.ts`, `SpatialClubSetup.tsx`, `SpatialXYRoomController.tsx`, `virtualInterface.ts`, `outputAdapter.ts`, `scripts/spatial-virtual-32.sh` (currently intentionally safety-disabled), SSOT v4. These are NOT a working 32-channel end-to-end pipeline. Old and new editors not unified; no confirmed Sony test; no functioning native 32-channel PipeWire node. Keep status honest.
