# Spatial implementation batch 2026-11-09 — 32-source renderer groundwork

## Code committed
- `src/core/spatial/v2/virtualBinauralRenderer.ts`: reusable planar PCM 12/16/24/32-to-stereo **approximate** binaural downmix, per-channel room positions, per-user head yaw, fixed delay buffers, no per-block buffer allocations. Uses ILD/ITD, not measured HRTF. Intended as source-aware fallback and test oracle, not a claimed final HRTF.
- `tests/spatialVirtualBinauralRenderer.test.ts`: four channel counts, yaw response, malformed input.
- `src/audio/worklets/spatialProcessor.ts`: spatial worklet now allocates up to 32 slots based on `processorOptions.maxSources` (previously fixed at 8 even when wrapper requested 32).
- `src/audio/spatial/node.ts`: sends maxSources to processorOptions.
- `tests/spatialWorkletSlotCount.test.ts`: checks 32-source slot negotiation.
- Existing `V2LiveSink.setLocalMonitorInsert` remains a local stereo insert hook, not automatically wired to the 32-channel renderer.

## Important blockers and risk
1. `V2SinkEngine` renders a *stereo* local monitor; feeding it into a 32-source spatial renderer would be mathematically invalid. Need a pre-sum source-aware monitor branch, with user-selected source policy preserved.
2. `VirtualBinauralRenderer` is a pure TypeScript DSP primitive, not yet executed inside AudioWorklet or connected to a live sink. Actual 32ch input transport, routing and backpressure are still pending.
3. Current `SpatialProcessor` uses generic fixed FIR kernels, not azimuth-indexed HRIRs. It cannot claim fully accurate individualized HRTF despite its loader. Proper HRIR dataset interpolation, licensing, per-source history and CPU tests remain.
4. 32 separate WebAudio inputs may hit browser limits; production implementation should prefer one 32-channel bus where supported or a bounded grouped channel topology, with capability detection.
5. Existing browser V2 output clamp to 24 is separate from this 32-source worklet fix.
6. No test runner/build/browser environment was executed by these GitHub API edits; all tests remain unverified.
7. Four user audio streams must remain isolated. Main and Visuals must not be rewritten or touched by local monitor preference.

## Next implementation gates
- Locate spatial source-to-monitor membership/provenance and worklet input wiring for MAIN/MON/PLUGIN/MIX, then build local user-selected source-aware spatial bus.
- Implement a dedicated per-user binaural AudioWorklet processing this bus, with licensed HRIR interpolation; keep stereo bypass safe.
- Wire the binaural effect output to the user's actual headphone destination and implement independent UI toggle and device changes.
- Add 32ch post-routing PCM tap into the floating meter bridge, with bounded frame transfer and explicit channel map.
- Run TypeScript, Vitest, build, E2E, 4-browser isolation and listening tests before marking ready.
