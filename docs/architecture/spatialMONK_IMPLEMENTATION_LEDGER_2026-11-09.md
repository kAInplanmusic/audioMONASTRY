# spatialMONK implementation ledger — 2026-11-09
Branch: `feat/spatial-virtual-binaural-sony-xm4`
Parent: `spatial`. This document is a delivery ledger, not a claim that audio hardware or 32-channel worklet streaming is functional.

## Decisions (consolidated)
1. Canonical rectangular room, 12/16/24/32 satellites, 0–2 independent subs, optional locked stereo anchors. No global device changes during virtual tests.
2. Spatial UI: small floating live room visualizer with accurate aspect ratio and **actual PCM** meters; no animated pretend audio.
3. Internal virtual PCM sink as primary test environment. Native PipeWire device optional/on-demand with owned-node cleanup. Future USB/LAN adapters capability-negotiated, preserving scene and DSP.
4. Binaural stereo monitoring using HRTF for Sony WF-1000XM4 and ordinary stereo headphones. Do not assume headset-provided headtracking.
5. **Visuals Out and four monitor selections already exist** per product owner. Do not rebuild them. Each user's existing selected monitor feed may be post-processed binaurally locally when spatialMONK active and user opts in. Main/Visuals unaffected.
6. Preserve DJ stereo and Xonar U7. Acoustic calibration requires real microphone and speakers, distinct from digital routing simulation.

## Commits in this implementation batch
- `11d3ea8`: `SpatialLiveVisualizer.tsx`, floating room panel, PCM meter input, status for missing PCM.
- `e1b8880`: setup VISUALISIEREN action and X/Y aspect ratio correction.
- `986893a`: `meterBridge.ts`, observable PCM meter boundary (non-real-time).
- `edd9cabb`: connect setup visualizer to bridge subscriptions.
- `6e88ea4`: bridge tests.
- `66b8d0b`, `93a7577`: reconcile binaural front coordinate with existing club planner (+Y = front).

## Verified by code inspection
- `src/audio/spatial/node.ts`: existing SpatialNode worklet is **currently stereo** (`outputChannelCount:[2]`), has HRTF and WASM loading hooks.
- `src/components/SpatialScene.tsx`: SpatialCluster + legacy audio path; no proof that a 32-channel bus reaches the meter bridge.
- `src/components/spatial/SpatialClubSetup.tsx`: 12/16/24/32 geometry editor; floating visualizer now mounted by user action.
- `src/core/spatial/v2/virtualInterface.ts`: PCM meter implementation, but its input must come from actual output bus.
- `src/core/spatial/v2/outputAdapter.ts`: virtual adapter prototype, not RT transport.
- Monitor AudioWorklet implementation not yet located/verified: must inspect before modifying any monitor routing.

## Critical pending wiring — next tasks
- [ ] Inspect actual existing monitor AudioWorklet and four user monitor paths. Identify exact source selection, transport and output nodes.
- [ ] Inspect `spatialProcessor.js` source and HRTF WASM convolver. Confirm whether current 2ch spatial rendering can be reused for each monitor or whether 32-channel PCM renderer is separate.
- [ ] Define stable 32-channel canonical PCM bus; route real post-DSP PCM via bounded RT-safe tap to `spatialMeterBridge.ingestPostRoutingPCM` **outside** audio render thread. Rate limit UI updates to ~20–30Hz; avoid 32x audio-block copies.
- [ ] Replace temporary speaker index fallback with explicit logical speaker ID -> output channel map once actual routing is known.
- [ ] Implement per-user opt-in BINAURAL monitor insert without altering global scene, shared main, Visuals or other users.
- [ ] Load validated licensed HRIR, test 32->2 output, azimuth, listener yaw, latency, gain/limiter, headset A2DP.
- [ ] Add device capability probes and optional native PipeWire 32ch node lifecycle, no root/no default-sink changes.
- [ ] Verify 32+2 requires 34 hardware outputs, mock USB/LAN adapters, calibration only with physical hardware.
- [ ] Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` and browser E2E. **Not executed by this GitHub-only batch**.
- [ ] Check React floating window accessibility, mobile viewport bounds, drag behaviour and performance.

## Blocking correctness caveat
The visualizer is intentionally in **WARTET AUF PCM** state until the actual audio graph publishes frames. The bridge exists and is subscribed, but no real AudioWorklet producer is connected yet. Do not mark live metering or binaural 4-user feature complete.
