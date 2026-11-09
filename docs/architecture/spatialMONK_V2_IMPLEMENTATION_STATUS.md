# spatialMONK V2 – Implementation status

**Branch:** spatial  
**Stage:** Phase A (P0 hardening), Phase B (passive V2 scaffolding)  
**Not enabled:** new object renderer, 16-channel device output, calibrated loudspeaker DSP.

## Implemented on the spatial branch

- Mono source in SpatialPluginAdapter no longer muted when pan is changed.
- AudioWorklet modules cached per BaseAudioContext, with retry after failures.
- SpatialBus owns and disconnects its full graph generation on rebuild/reset.
- Cluster auto-split and manual UI split are disabled until safe audio rewiring is implemented.
- New isolated V2 source model (schemaVersion=2, validation, optimistic scene revisions, legacy source projection).
- New pure 2D VBAP reference geometry, 16-speaker 4×4-m reference layout, offline mono-block utility.
- Conservative physical-device capability resolver; virtual multi-channel requests fall back to stereo.
- Regression tests for pure geometry, schema, mono routing and device guards.

## Critical architectural constraints

- V2 modules are NOT plugged into the production audio chain.
- Never route object-mono signals by blindly upmixing a stereo master and calling it object audio.
- This VBAP function is a control-plane / offline reference; it allocates arrays and is not suitable as-is for a Worklet render quantum.
- Real-time renderer requires precomputed geometry, parameter smoothing, preallocated output buffers and measured CPU.
- Never assume browser ChannelMerger(N) means hardware N-channel output; only a verified bridge/device adapter can assert this.
- Bass management and LFE routing must be developed independently of azimuthal satellite panning.
- Source-cluster redistribution must include real AudioNode input cabling, output destination connections, gain state, mute, and seamless crossfade.

## Open gate checklist

- [ ] Run typecheck, full Vitest suite, lint and integration smoke against the spatial branch.
- [ ] Verify stereo / mono output parity and spatialBus lifecycle after resets.
- [ ] Verify hot path and all channels of the real V2OutputGraph / AudioEngine.
- [ ] Integrate a real multi-object channel tap into the graph (flagged off by default).
- [ ] Build dedicated N-channel AudioWorklet and separate headphone binaural cue.
- [ ] Build calibrated satellite HPF / subwoofer LPF with configurable delay, phase and trims.
- [ ] Implement host-authorized scene command service, idempotent opId handling and reconnect.
- [ ] Test four collaborators and measure real-device multichannel playback.
- [ ] Test recording/export taps, latency alignment, clipping and listener sweet-spot performance.
