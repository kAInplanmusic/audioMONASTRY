# V2 source-aware pre-stereo spatial bus — 2026-11-09

## Implemented
- `src/core/spatial/v2/v2PreStereoSpatialBus.ts`: N-channel (12/16/24/32) planar PCM render from existing `V2MonitorGraph` post-fader mono gain taps and pre-fader cue taps, after the graph processes each block and before stereo summation is consumed. Uses canonical speaker mapping and adjacent-speaker constant-power panning. Per-track positions are configurable; output buffers are reused per block.
- `src/core/audio/live/V2SinkEngine.ts`: opt-in `configureSpatialSourceBus(plan)`, `setSpatialTrackPosition(track,position)`, and `getSpatialSourceFrame()`. Invokes source-bus rendering once after `studio.renderMonitor(ctx)` without rendering the graph twice. Existing V2 physical output remains unchanged.
- `tests/spatialV2PreStereoSourceBus.test.ts`: source/channel routing and cue-policy checks (not yet executed).

## Technical limitations and safety gates
1. The bus is a **real pre-stereo source-aware bus** but is NOT yet connected as an independent 32-channel WebAudio output to `LocalBinauralMonitor`. The existing V2 sink output remains capped at 24 channels; it cannot expose the new bus as a 32-channel WebAudio node without a dedicated transport/output design.
2. MAIN taps are **post-track-fader but pre-master EQ, FX, dynamics and mastering**. Therefore the spatial headphone signal is not master-processed parity with stereo MAIN. Cue taps are pre-fader. MAIN/Cue timing and PDC require measured alignment.
3. The monitor source policy applies locally, but actual four-browser collaboration, per-user ownership, role authorization, independent output devices and dry/wet exclusivity are not proven.
4. No measured HRTF; approximate ITD/ILD fallback only.
5. Tests, typecheck, build, browser audio and listening have NOT been executed in this API-only session.

## Next integration milestone
Design and implement a bounded 32-channel transport from the V2 worklet pre-stereo bus to a **local** spatial binaural sink, with no PCM MessagePort copy per quantum and no shared master disruption. Consider SAB ring buffers when crossOriginIsolated, fallback behavior when unavailable, and one independent monitor per user. Validate sample clock and PDC. Do not treat stereo output expansion as source-aware spatial audio.

## Required commands
`npm run typecheck`
`npx vitest run tests/spatialV2PreStereoSourceBus.test.ts tests/spatialCanonicalChannelMapping.test.ts tests/spatialAggregatedMeterBridge.test.ts`
`npm run build`
