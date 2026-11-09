# spatialMONK integration checkpoint — 2026-11-09

## Implemented on feature branch
- V2 source-aware pre-stereo PCM spatial bus, 12/16/24/32-channel canonical speaker map
- Bounded SPSC SharedArrayBuffer PCM transport between source and binaural worklets
- Binaural ITD/ILD renderer, true PCM peak/RMS telemetry and per-user meter bridge
- Two-sided worklet readiness handshakes, rollback, and prohibition of simultaneous shared/bus/stem sources
- `LocalV2SpatialMonitorController`: opt-in activation, dry-output suppression, wet output and stop/refresh
- `LocalHeadphoneDevice`: optional browser-selected hardware output via MediaStream destination and HTMLAudioElement.setSinkId, exposed by `controller.startOnDevice(plan,deviceId)`. No global AudioContext sink change.
- Regression for stale dry-suppression insert when AudioContext changes
- GitHub Actions spatial validation workflow: typecheck, focused regression tests and build

## Critical non-completion items
1. **No verified green build**. GitHub API query for workflow runs on initial workflow commit returned an empty list; tests have not been executed in this environment. GitHub host DNS unavailable from local container.
2. **No automatic DAW UI wiring**. Controller API is available to UI, but no existing UI toggle or app-level controller instantiation was verified or connected.
3. **No automatic reconnect listener**. `refresh` is explicit; callers must invoke it after sink recreation and may need to reselect output device. `setOutputLayout` currently reconnects asynchronously without a controller callback.
4. **No live playback proof**: four-user simulation uses isolated transports, not four authenticated browser sessions. Clock drift, audio glitches, output device permission, dry/wet switching and real headphone tests remain.
5. **No measured HRTF**: ITD/ILD approximation only; no individual HRTF convolution.
6. **Spatial MAIN remains pre-master**, without verified parity with the stereo master EQ, dynamics, mastering or PDC.
7. The shared-memory path requires COOP/COEP and `crossOriginIsolated`. Browser permission and `setSinkId` support vary; device selection may reject.

## Suggested next gates
- Obtain an executable checkout, run `npm ci && npm run typecheck && npm run build` and the focused spatial Vitest suite.
- Review any compiler/test failures before merging; run the new GitHub Actions workflow and inspect logs.
- Integrate `LocalV2SpatialMonitorController` with the real DAW audio lifecycle and spatialMONK UI; include automatic device and sink reconnect with race cancellation.
- Perform instrumented WebAudio browser tests with 4 independent users, 32 distinguishable test tones, actual headphone hardware and continuous 30-minute underrun/clock monitoring.
- Keep this branch separate from production until verified.
