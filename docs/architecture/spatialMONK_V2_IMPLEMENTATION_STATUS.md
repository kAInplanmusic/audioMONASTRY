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

## Binding product requirement (2026-11-09)

- mixerMONK/MAIN-AUDIO continues as the canonical unchanged stereo mix for DJ, guests, recording, stream, monitor and other non-Spatial-Main endpoints.
- spatialMONK may non-destructively copy one or several active post-fader mixer channels and accept dedicated spatial-only audio injections.
- Only a designated MAIN device may carry multichannel spatial audio, subject to verified physical channel count and exclusive output ownership.
- Spatial-Main is separately composed: selected channel copies replace selected dry signal; non-selected channels plus FX returns form the stereo bed; independent injections are additional. Never sum complete stereo master plus copied selected dry again.
- No binaural/spatial Worklet output must return into GLOBAL_MASTER. The Legacy ROUTING button is disabled pending a separate Spatial-Main.
- Existing legacy `routeChannelToSpatialInput` is now a non-destructive send; its audio activity in V2 LiveSink remains unverified.

## Square-room XY UI (latest)

- `src/components/spatial/SpatialXYRoomController.tsx` is integrated into the active spatialMONK scene UI. It replaces the former circular floor UI and angled 3D visualization with a **square top-down, 2-axis XY** workspace at fixed ear height.
- Side length in metres; select 12, 16, 18 or 24 satellites and 0/1/2 subwoofers; speaker coordinates, room-perimeter pitch and virtual timing estimates come from `src/core/spatial/v2/squareRoom.ts`. The UI explicitly warns if its simulated speaker count differs from the saved Spatial setup; clicking SETUP ÜBERNEHMEN synchronizes them. Registries now include 16.0/16.1/16.2.
- Every speaker's X/Y coordinates can be manually edited in metres and stored in local preferences; manual entries are preview metadata only and cannot silently activate physical I/O, calibration EQ or output mapping.
- Source X/Y can be dragged or set numerically. SVG pointer conversion uses local viewBox geometry (actual square occupies 30..370 in 400x400), not the full SVG element bounding box.
- Four locally configurable motion buttons, dropdown motion choices, XY lines/circles/figure-eight/square paths, cycle time, radius, optional loop and bounded description-to-preset input are present. Text interpretation is deterministic and **not an LLM**.
- Motions are UI-timed **visual previews** and do not write per-frame positions into the persisted scene. The explicit POSITION control commits one result to the legacy scene. The Spatial-Main audio graph and real audio-clocked automation remain disabled pending verification.
- No Z axis, elevation controller, overhead channels or 3D visual mode. Internal azimuth derived from XY is an implementation detail.
- `squareRoom.ts` and `motion.ts` are the **canonical** geometry/motion implementations used by the UI and by `tests/spatialSquareMotion.test.ts`. Earlier unconnected duplicate modules were eliminated to maintain a single source of truth.
- **External evidence gap:** the three calculation/example photos referenced by the user are not available in the currently accessible Project files. Their speaker offset assumptions and actual measurements must be reconciled before claiming photo-exact installation coordinates.

## Four supplied reference images – reconciliation (2026-11-09)

- The supplied drawings show **8m × 8m** 12-, 18-, and 24-speaker wall-mounting layouts, plus a **4m × 4m** numbered installation plan. They are now available in this conversation as visual references, not automatically committed binaries.
- **Critical distinction:** equal *angular* coverage from the listener is different from equal *physical spacing* along a square wall. In the new `squareRoom.ts`, `calculateSquareAngularSpeakers` intersects equally spaced azimuth rays with the four square walls. `calculateSquarePerimeterSpeakers` remains the independent equal-perimeter option.
- The UI now exposes **360° · gleicher Winkel** versus **Wand · gleicher Meterabstand**, with an optional angular offset and individually editable speaker coordinates. Switching the algorithm clears manual offsets so stale measurements cannot silently override the selected reference.
- The 12-speaker reference is labelled 30°; 24 speakers 15°. The 18-speaker drawing claims 20° in its details but prints predominantly 22.5° labels and inconsistent speaker numbering; those printed labels cannot be used as an authoritative 18-channel output map. Use the mathematically validated 360/18 = 20° reference unless the real installation is measured and entered.
- The 4×4m reference uses differently filled/open dots and numbering. The drawing alone does not unambiguously define which points are live satellites, alternative placements, or channel outputs; do not infer their role. Enter surveyed coordinates through the manual LS editor.
- For a centered listener in an 8×8m room, a 30° ray intersects the front wall at (2.309401m, 4m) and a 15° ray at (1.071797m, 4m), with +X right, +Y front. These are *derived* wall intersections, not measured installation positions.
- Angular speaker ordering is 0° front, clockwise 90° right, 180° back, 270° left. UI and DSP must share that channel ordering, but physical output routing is still intentionally disabled.
- The 16-speaker reference remains a **design choice** because the provided reference set does not contain a labelled 16-speaker angular diagram.

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
