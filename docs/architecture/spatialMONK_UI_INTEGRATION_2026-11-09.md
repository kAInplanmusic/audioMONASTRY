# spatialMONK UI integration — 2026-11-09

## Implemented on feature branch
- `src/components/am/SpatialHeadphonePanel.tsx` provides local binaural on/off, 12/16/24/32 channel count, device enumeration/selection, loading/error/active status and cancellation guards.
- `src/components/am/SpatialRack.tsx` mounts the panel in the existing spatialMONK rack. XY position changes and path motion send `setSpatialTrackPosition` to the V2 source worklet; persisted positions are resent after monitor startup.
- The panel uses `LocalV2SpatialMonitorController(audioEngine.v2LiveSink)` and invokes `start()`, `startOnDevice()` and `stop()`. No shared session state is modified by the local monitor toggle.
- Existing SharedArrayBuffer handshake, pre-stereo V2 source tap, binaural renderer and dry monitor suppression are reused.

## Limitations / not yet production-ready
- No local TypeScript, Vitest, production build or browser test has been run; the GitHub Actions workflow exists but no passing result was verified.
- Output-device changes while active currently stop the monitor; the user must start again. Devicechange enumerates new devices but does not automatically reconnect.
- Sink layout reconnect or AudioContext replacement is not yet subscribed to by the panel. A stopped/stale source can leave the binaural monitor disconnected until manual restart.
- Speaker room dimensions in this UI are fixed at 8×8 m. Object XY normalized [-1,1] maps to ±3.5 m, not a measured room. No measured HRTF or post-master processing parity.
- A 32-channel WebAudio hardware sink is not required for the SAB binaural path, but cross-origin isolation and browser audio permissions are required.
- No four-browser E2E and no real headphone listening validation.

## Verification gates
`npm ci && npm run typecheck && npm run build`
`npx vitest run tests/spatialPcmTransport.test.ts tests/spatialFourUserPcmIsolation.test.ts tests/spatialPcmHandshake.test.ts tests/spatialLocalV2Controller.test.ts tests/spatialHeadphoneDevice.test.ts tests/spatialV2PreStereoSourceBus.test.ts tests/spatialCanonicalChannelMapping.test.ts`
Then run in a COOP/COEP-enabled browser with a real V2 sink, confirm audible headphone signal, correct channel isolation, MON/PLUGIN routing, dry/wet switching, device permission denial and repeated unmount/reconnect.
