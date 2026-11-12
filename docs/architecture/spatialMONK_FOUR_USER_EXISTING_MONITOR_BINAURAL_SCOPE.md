# Corrected scope: four existing AudioWorklet monitors + spatialMONK binaural
Date: 2026-11-09. Supersedes assumptions that Visuals Out or monitor matrix must be created.

## Verified code evidence
- `src/audio/spatial/node.ts`: SpatialNode.create currently instantiates stereo `spatial-processor` AudioWorkletNode (`outputChannelCount:[2]`); supports `loadHrtf` and `loadHrtfWasm`. Existing HRTF capability should be investigated and reused, not reimplemented by default.
- `src/components/SpatialScene.tsx`: spatialMONK uses SpatialCluster and legacy audio engine. It does not by itself prove existing monitor routing is connected to the SpatialCluster.
- User confirms Visuals Out and monitor routing already exist in AudioWorklet. Do NOT create duplicate Visuals or monitor matrix.

## Single requested feature
For each of four independent users: retain the user's existing monitor selection, and when spatialMONK is active AND user enables binaural headphone monitoring, route THAT USER'S selected monitor audio through the existing spatial HRTF-capable renderer and deliver stereo to THAT USER'S headphones. All four may enable independently. The shared main output, Visuals Out, other users' monitors and scene must remain unchanged.

## Implementation tasks
- [ ] Locate the exact existing monitor AudioWorklet processor and its four-user routing, input/output contracts, device-selection code, monitor source selection, and transport; map without rewriting.
- [ ] Audit existing spatial processor HRTF path, WASM loading, initialization and audio correctness. Distinguish actual binaural HRIR convolution from ordinary stereo panning.
- [ ] Design a per-user monitor post-insert: existing selected monitor mix -> spatial/binaural render -> stereo headphone device. For sources already spatialized, reuse their spatial coordinates; for non-spatial monitor signals define an explicit dry/front or bypass policy. Do not blindly HRTF-process already binaural stereo twice.
- [ ] Binaural enable is local user preference and must not modify global spatialMONK scene or other users' settings. If spatialMONK off or no headphone sink, bypass to existing monitor path safely; no forced muting or silent loss.
- [ ] Use existing source-to-spatial channel routing and worklet topology; avoid double-audio feedback, routing cycles, duplicate master feeds and accidental inclusion of DJ audio when plugin-only monitor selected.
- [ ] If four users each render locally, each receives permitted monitor sources via existing transport; assess source-count, network bandwidth, HRTF CPU and cross-user authorization. No central four-way HRTF render by default.
- [ ] Monitor mode selection: unchanged existing choices; optional local `Binaural 3D` toggle only when spatialMONK active and stereo headphone output selected. Normal stereo headphones including Sony WF-1000XM4 work; no hardware HRTF requirement. Sony A2DP latency is variable; do not use Bluetooth for low-latency measurement.
- [ ] Independent head yaw and HRTF profile per user; start with fixed orientation/manual yaw; smartphone IMU optional. No assumption that WF-1000XM4 exposes usable tracking.
- [ ] Automated tests: 4 users with different monitor selections, toggle each independently, correct 2ch output, no change to main/visuals, no audio leakage, bypass on spatial off, device loss, no double binaural processing, CPU stress and deterministic source mapping.
- [ ] Verify typecheck, lint, unit, build, E2E; record logs. No test execution or live functionality claimed by this planning document.

## Scope control
The larger `spatialMONK_VIRTUAL_BINAURAL_IMPLEMENTATION_PLAN.md` describes other requested work (virtual 32-channel visualizer and hardware adapters). This document governs **this particular feature**. Do not schedule duplicate monitor or Visuals Out implementation.
