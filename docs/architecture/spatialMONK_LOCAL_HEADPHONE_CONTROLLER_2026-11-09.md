# spatialMONK — Local V2 binaural headphone controller (2026-11-09)

## Implemented
- `V2LiveSink.getAudioContext()`: read-only current AudioContext accessor.
- `src/audio/spatial/localV2SpatialMonitorController.ts`: one local controller per browser/user, opt-in `start(plan,destination?)`, `stop()`, `refresh(plan,destination?)`, `isActive`, and isolated `meter`.
- Startup creates `LocalBinauralMonitor` in the SAME AudioContext as V2 source, awaits monitor+source SAB handshakes, then diverts the V2 dry stereo output into a zero-gain node kept connected to the destination (to keep the source AudioWorklet pulled). The binaural monitor connects to the chosen destination only after dry suppression.
- Stop disconnects wet binaural output first, detaches source SAB, then restores direct V2 stereo if the original AudioContext is still current. Stale activation generations reject.
- `tests/spatialLocalV2Controller.test.ts`: unit test for dry suppression/restoration and disconnected sink.

## Integration API
```ts
const controller = new LocalV2SpatialMonitorController(v2LiveSink);
await controller.start(plan); // uses current ctx.destination
// or: await controller.start(plan, headphoneAudioNode);
controller.stop();
// after V2 sink reconnect, layout or device changes:
await controller.refresh(plan, newDestination);
```

## Unresolved
1. Existing DAW UI/state machine is NOT yet wired to controller start/stop, nor are automatic sink reconnect/devicechange events. `refresh` is an explicit API, not an automatic listener.
2. Selecting a real OS headphone output device needs `AudioContext.setSinkId` where supported or an appropriate output routing adapter; this controller only accepts a destination `AudioNode` in the same AudioContext. Browser permission/support and user selection are not implemented.
3. Dry suppression uses a zero-gain AudioNode. Browser-specific worklet pulling behavior and dry/wet click-free transitions need live verification.
4. The spatial PCM path is pre-master and does not guarantee mastering/PDC parity; actual four-browser authorization and measured HRTF are outstanding.
5. Worklet readiness and source PCM timing remain unverified. No browser E2E, typecheck, build, listening or actual CI run performed in this connector-only change set.

## Required validation
`npm run typecheck`
`npx vitest run tests/spatialLocalV2Controller.test.ts tests/spatialPcmHandshake.test.ts tests/spatialPcmTransport.test.ts tests/spatialFourUserPcmIsolation.test.ts`
`npm run build`
