# spatialMONK — Worklet handshake hardening (2026-11-09)

## Changes committed
- `LocalBinauralMonitor.attachSharedSpatialPcm` now returns `Promise<void>`, waits for `spatial-pcm-ready` from its own binaural worklet, rejects `spatial-pcm-error`, and times out after 3 seconds. Pending readiness is cancelled on detach/dispose.
- `V2LiveSink.attachSpatialPcmTransport` now awaits a matching source worklet acknowledgement, rejects errors and times out after 3 seconds. It checks the worklet node identity on success to reject an acknowledgement from a replaced source node.
- `connectLocalV2SpatialPcm` now awaits both acknowledgements in order (monitor first, source second) and rolls back both on source failure.
- Shared PCM is now mutually exclusive with individual WebAudio stems and a separate WebAudio spatial bus.
- `tests/spatialPcmHandshake.test.ts` verifies order, shared SAB identity and rollback, using a cross-origin-isolated test stub.

## Still required
1. App controller must opt in, select/attach the user's headphone destination, and disconnect or mute the existing local dry monitor to avoid dry+wet doubling. No automatic app integration is claimed.
2. Worklet replacement/layout reconnect must trigger new handshake and new transport. Node identity checks reject stale acknowledgement but do not automatically reconnect.
3. PCM clock drift, jitter, underruns and sample-accurate PDC must be measured in an actual browser. Latest-frame SPSC transport is not a clock-aligned jitter buffer.
4. Four-user transport unit tests are not real multi-client collaboration tests; authorization/ownership remain external.
5. MAIN spatial signal remains pre-master, not post-master parity. Measured HRTF convolution remains open.
6. Worklet readiness and unit tests were not executed; this was GitHub connector code editing only.

## Verification commands
`npm run typecheck`
`npx vitest run tests/spatialPcmHandshake.test.ts tests/spatialPcmTransport.test.ts tests/spatialFourUserPcmIsolation.test.ts tests/spatialV2PreStereoSourceBus.test.ts`
`npm run build`
