# spatialMONK — PCM meter bridge + multichannel source tap (2026-11-09)

## Implemented on feature branch
1. `VirtualBinauralMonitorProcessor` measures the actual 12/16/24/32 incoming mono channels (peak/RMS) and posts aggregate packets every 2048 frames when metering is enabled.
2. `SpatialMeterBridge.ingestAggregatedPCM` converts validated measured peak/RMS packets into existing `VirtualFrame` format. No fabricated PCM. Sequence numbers and subscribers remain supported.
3. `LocalBinauralMonitor.attachMeterBridge` connects the worklet telemetry to a per-user bridge. Use `new SpatialMeterBridge()` for each user. Do not reuse the global singleton for concurrent users.
4. `LocalBinauralMonitor.connectSpatialBus(source)` uses a `ChannelSplitterNode` to route a real N-channel WebAudio source to N worklet mono inputs. `disconnectSpatialBus` and `dispose` clean up. Stem/bus simultaneous attachment is rejected.
5. `tests/spatialAggregatedMeterBridge.test.ts` covers 32-channel aggregate, malformed packets, and isolated bridges.

## Source routing requirements before audible acceptance
- The source supplied to `connectSpatialBus` MUST contain actual planar spatial speaker channels with exact index mapping. A stereo master output is not acceptable and cannot be expanded into independent speaker sources.
- `V2LiveSink` currently constructs `outputChannelCount` capped at 24; 32-channel routing therefore requires a separate genuine 32-channel bus/tap or a verified redesign of the live sink output contract. Do not silently treat stereo/24 as 32.
- Four-user MAIN/MON/PLUGIN/MIX policies, PFL, role authorization, monitor volume, and device selection must be applied to each user's PRE-SUM signal BEFORE feeding this bus.
- Never route an already-audible dry monitor in parallel with the binaural wet output.
- `connectSpatialBus` is an adapter, not proof that the existing V2 graph currently emits the required bus.
- Real HRTF convolution and browser/device capability verification remain open.

## Verification status
GitHub API changes only. No local checkout, npm install, TypeScript compile, Vitest, browser playback, four-user load or listening test has been run. No production deployment or merge.

## Suggested gates
`npm run typecheck`
`npx vitest run tests/spatialAggregatedMeterBridge.test.ts tests/spatialMonitorPcmMeter.test.ts tests/spatialVirtualBinauralWorklet.test.ts tests/spatialMonitorLocalGainParity.test.ts tests/spatialV2LayoutReconnect.test.ts`
`npm run build`
Then validate four independent browser monitor instances with actual N-channel source data, no dry+wet doubling, no cross-user leak, and channel-accurate audible test signals.
