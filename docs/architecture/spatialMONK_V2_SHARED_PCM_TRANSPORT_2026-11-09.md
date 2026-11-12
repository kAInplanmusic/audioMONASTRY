# spatialMONK — V2 → binaural SharedArrayBuffer PCM transport (2026-11-09)

## Implemented
- `src/core/spatial/v2/spatialPcmTransport.ts`: bounded three-slot, single-producer/single-consumer, planar 128-frame shared PCM transport for 12/16/24/32 channels. Producer writes only the most recent block; consumer copies latest complete block or returns silence. Guards prevent stale replay and reject torn snapshots.
- `V2SinkEngine`: opt-in source-aware spatial PCM frame generated after one V2 graph render.
- `v2SinkProcessor`: accepts `spatial-pcm-transport` with separate `spatialPlan`, publishes pre-stereo PCM each quantum, accepts track position updates and disable.
- `virtualBinauralMonitorProcessor`: reads real source PCM directly from shared transport rather than WebAudio mono inputs when enabled, then renders stereo ITD/ILD and metering.
- `V2LiveSink.attachSpatialPcmTransport`, `LocalBinauralMonitor.attachSharedSpatialPcm`, `connectLocalV2SpatialPcm`: opt-in main-thread wiring, with format checks and cross-origin isolation requirement.
- `MonitorRoutingState.applyPlan/reset`: corrected remaining local headphone cue-gain multiplication.
- Regression tests: `tests/spatialPcmTransport.test.ts`, `tests/spatialFourUserPcmIsolation.test.ts`.

## Critical limits / integration risks
1. **Not automatically enabled by the app**. A UI/application controller must create a local monitor, call `connectLocalV2SpatialPcm(sink,monitor,plan,sampleRate)`, connect headphones, and ensure the existing dry V2 monitor is NOT also audible. The connector is opt-in and does not select devices.
2. **Source clock alignment**: shared transport is latest-block, not a timestamped jitter buffer. Separate AudioContexts / devices may drift; repeated silence or skipped blocks are possible. Use same sample-rate, preferably same AudioContext and audio device; measure clock drift before production use.
3. **Four-user simulation is not four-browser E2E**: tests instantiate four isolated SAB pairs. Real collaboration authorization, distinct sessions and per-user mix ownership require E2E verification.
4. **Pre-master spatial MAIN**: V2 spatial taps are before master EQ/FX/mastering; they are not parity with post-master stereo. PDC is not yet aligned.
5. **Browser security**: SharedArrayBuffer requires COOP/COEP and crossOriginIsolated. No silent fallback to copying 32 channels via MessagePort; connector throws if unsupported.
6. **Transport lifecycle**: the sink's layout reconnect creates a new worklet; the SAB must be reattached after reconnect. Readiness messages are emitted by both worklets but the coordinator currently does not await both acknowledgements. Add explicit handshake before exposing as a user-facing production feature.
7. **No measured HRTF**: approximate ITD/ILD only.
8. **No automatic per-user permission enforcement**: SAB references must never be distributed to unauthorized users.

## Verification
GitHub API commits only. Tests and typecheck not executed, no browser playback, no real 4-user test, no measured latency or headphone listening. No deployment or merge.

## Required validation
`npm run typecheck`
`npx vitest run tests/spatialPcmTransport.test.ts tests/spatialFourUserPcmIsolation.test.ts tests/spatialV2PreStereoSourceBus.test.ts tests/spatialMonitorLocalGainParity.test.ts`
`npm run build`
Run browser WebAudio worklet smoke and actual audio listening with same-context source+headphone monitor, check 32 distinct speaker channels, dry/wet exclusion, MON/PLUGIN/PFL and 4 user independent policies, cross-origin isolation, sample-rate mismatch, rapid reconnect, device switch, xruns.
