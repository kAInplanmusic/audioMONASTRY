# spatialMONK — Live V2 source boundary audit (2026-11-09)

## Verified code paths
- `V2SinkEngine.render` calls `studio.renderMonitor(ctx)` to produce **stereo**, then passes `stereo[0]` and `stereo[1]` into `V2OutputGraph.setInputStereo`.
- `V2OutputGraph` builds a multichannel `MultichannelBusNode` for N.x layouts, but this is downstream of stereo summation and does not recover independent spatial sources.
- `V2LiveSink.connect` caps the AudioWorklet output channel count to 24.
- `LocalBinauralMonitor.connectSpatialBus` accepts a genuine multichannel WebAudio node through a splitter. This is an ingress adapter, NOT a producer of real 32-channel source-aware PCM.

## Consequence
Simply increasing 24 to 32 or attaching the existing `V2LiveSink` output to `connectSpatialBus` would create a misleading 32-channel experience: channels would be derived from an already summed stereo monitor, with no per-speaker object identity. **Do not make that shortcut.**

## Implemented this batch
- `assignSpatialOutputChannels`: canonical immutable speaker-to-channel mapping; fixed reservations and automatic assignments; duplicate/out-of-range validation.
- `VirtualBinauralRenderer` and `LocalBinauralMonitor.create` now use the canonical map.
- `tests/spatialCanonicalChannelMapping.test.ts`: checks 12/16/24/32 mapping, meter alignment, no source mutation, duplicate rejection.

## Required integration design
1. Introduce a dedicated N-channel spatial render bus **before** the V2 monitor stereo summation, with object/track positions and actual PCM sources.
2. Apply local monitor policy separately for each user (MAIN/MON/PLUGIN/MIX, PFL, role authorization, gain). Never mutate the global master bus to achieve this.
3. Send each user's N-channel bus to that user's local `LocalBinauralMonitor`. Keep the source bus separate from the shared stereo/physical output.
4. Test 4 simultaneous users, rapid mode/device/layout changes, source collisions, head tracking, channel accuracy, CPU underruns and no audible dry/wet doubling.
5. Add measured HRTF/HRIR convolution as a separate validated DSP stage. Current ITD/ILD is approximate only.

## Verification
Changes pushed through GitHub connector. No runnable workspace or live browser/audio device was used in this batch. Typecheck, Vitest, build, 4-user E2E and listening tests are NOT verified. Combined GitHub commit statuses queried at latest commit: empty statuses array, which is **not** a passing CI result. No merge or production deployment performed.
