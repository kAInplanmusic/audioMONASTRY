# spatialMONK – 4-user binaural AudioWorklet implementation handoff (2026-11-09)

## Code delivered in this batch
- `src/audio/worklets/virtualBinauralMonitorProcessor.ts`: dedicated 12/16/24/32 separate mono inputs to stereo headphone worklet; explicitly silent until configured; source-aware spatial processing; independent yaw.
- `src/audio/spatial/localBinauralMonitor.ts`: per-local-AudioContext wrapper, readiness handshake, mono stem input mapping, headphone output, yaw, source detachment and disposal.
- `src/core/spatial/v2/virtualBinauralRenderer.ts`: explicit speaker channel map now reserves mapped channel indices before filling unassigned indices; prevents accidental collisions.
- `tests/spatialVirtualBinauralWorklet.test.ts`: silent-unconfigured and 32-input render tests (written, NOT run).
- Existing tests: `tests/spatialVirtualBinauralRenderer.test.ts`, `tests/spatialFourUserBinauralPolicy.test.ts`, `tests/spatialWorkletSlotCount.test.ts`.

## Build discovery
`build-worklets.mjs` automatically discovers every `src/audio/worklets/*.ts` and bundles it to both `dist/worklets` and `public/worklets`. No manual manifest entry is required for direct `AudioContext.audioWorklet.addModule` in `LocalBinauralMonitor`.

## Crucial integration boundary (still OPEN)
`V2SinkEngine` and `V2MonitorGraph` currently sum selected monitor sources to stereo. A local 32-input binaural worklet cannot recover original positions from that stereo sum.
To finish the user request:
1. In the existing V2 engine, preserve the four user-specific monitor modes and isolate the correct per-user source membership BEFORE stereo summation. Do not bypass gain, mute, solo, permissions, PFL, DJ exclusion or master policy.
2. Expose 12/16/24/32 planar spatial speaker PCM via a real bounded RT-safe worklet routing bus. It must be local to each user and respect output channel IDs.
3. Connect each local mono stem to the matching `LocalBinauralMonitor.connectStem(source,channel)`, then connect headphones to the local output sink. Never connect both dry and wet paths concurrently.
4. Use existing `decideBinauralMonitor` to enable or bypass per user, with click-free transitions and device-change recovery.
5. Connect the actual post-routing PCM to `spatialMeterBridge` with bounded ~20-30 Hz main-thread metering updates. Do not fake signal presence.
6. Add a licensed azimuth/elevation-indexed HRIR/HRTF convolution engine. Current renderer is **approximate ITD/ILD only**.
7. Verify that 32 mono AudioWorklet inputs are accepted by target browsers. Fall back to grouped buses when browser input counts limit it.
8. Run npm typecheck, tests, lint, build, Playwright, four-browser monitoring and real listening/latency checks. NOT EXECUTED in this API-only session.

## Known pre-existing DSP issue
`src/audio/worklets/spatialProcessor.ts` high/WASM path uses a shared convolution state across multiple sources, as documented in `docs/CODE_AUDIT_VERBESSERUNGEN_2026-10-31.md`. Do not reuse that global state for per-source measured HRTF without isolation.

## Acceptance gate
Not done until four independently selected monitor mixes are audibly spatialized with distinct head yaw, no DJ bleed into PLUGIN-only, no dry+wet doubling, no shared MAIN changes, no output feedback, no device-loss silence, verified 32ch virtual metering and passing automated and listening tests.
