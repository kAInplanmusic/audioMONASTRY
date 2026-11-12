# Implementation handoff: existing four monitor routes -> optional local binaural HRTF
Date: 2026-11-09. Branch: feat/spatial-virtual-binaural-sony-xm4.

## Source-verified routing
`src/core/audio/monitorRouting.ts`: MON1..MON4; MAIN, MON, PLUGIN, MIX. Pure policy preserves shared MAIN.
`src/audio/monitorRoutingFacade.ts`: per-user selected source and gain; sends plan to V2LiveSink.
`src/core/audio/V2MonitorGraph.ts`: main and cue processed independently, then combined into local stereo monitor; render() returns main/cue/monitor.
`src/audio/spatial/node.ts`: existing spatial worklet output is stereo; HRTF/WASM load APIs exist, functionality still to be verified.

## Insert location
DO NOT change planMonitorRouting semantics or add another global monitor bus.
User's selected local V2 monitor output -> OPTIONAL local spatial/HRTF headphone insert -> user's own stereo sink.
Use `decideBinauralMonitor` from `src/core/spatial/v2/monitorBinauralPolicy.ts` as a *pure gate*, not an audio processor.
When bypassed, existing monitor output must be bit-identical and still audible.
When enabled, spatialized sources must have meaningful position metadata. Avoid converting a finished stereo mix to a fake 3D scene without explicit dry/front fallback.
Per-user preference is local, no global scene mutation; no master or Visuals modification.

## Next engineering tasks
- [ ] Find the concrete V2LiveSink and AudioWorklet monitor output connection. Trace render result to device.
- [ ] Inspect spatial processor HRTF implementation and availability; reuse existing HRTF rather than duplicating.
- [ ] Implement per-user post-insert wiring and toggle on local audio graph, with click-free crossfade, independent HRTF profile/yaw and lifecycle.
- [ ] Guarantee no parallel dry+wet doubling, feedback, cross-user leakage, or changes to master output.
- [ ] Feed actual 12/16/24/32-channel spatial PCM into the visualizer bridge at bounded rate; current SpatialNode is 2ch and not a 32ch producer.
- [ ] Test four separate users, each with different MAIN/MON/PLUGIN/MIX source; independent opt-in and bypass, PFL, gain, device loss, spatial disabled, stereo Bluetooth.
- [ ] Execute TypeScript/lint/test/build/E2E in a checked-out environment. GitHub commits alone do not execute these gates.

## Implemented in this batch
`src/core/spatial/v2/monitorBinauralPolicy.ts`: per-user decision, validates user-to-monitor binding and required readiness flags.
`tests/spatialFourUserBinauralPolicy.test.ts`: independent 4-user routing, fail-safe conditions, mismatched-user rejection.
Both are groundwork, not a connected audio effect.
