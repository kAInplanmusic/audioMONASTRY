# spatialMONK monitor routing regression — 2026-11-09

## Verified by source inspection (not by execution)
`MonitorRoutingState` constructs the local monitor plan in `src/audio/monitorRoutingFacade.ts`. Before this patch, `setLocalMonitorGain`, `applyPlan`, and `reset` multiplied the local headphone gain into `mainMonitorGain` only. The independent cue gain was left untouched.

For MON and PLUGIN, `mainMonitorGain=0` and the audible output is `cueGain`; local headphone volume at 0 therefore did not silence cue. MIX retained a cue component even when local main was muted. DJ-PFL forced MON and was likewise affected.

## Implemented
- Apply local headphone gain to BOTH `mainMonitorGain` and `cueGain` in all three plan-building paths.
- Preserve `cueTracks`, source, monitor user, role levels, and existing PFL selection.
- Preserve the shared master, monitor graph topology, and other users.
- New `tests/spatialMonitorLocalGainParity.test.ts` covers MAIN, MON, PLUGIN, MIX, DJ-PFL mute and two independent instances.

## Still outstanding
- Worklet 32-source PCM ingress from actual V2 spatial source stems; do NOT feed already-summed stereo to it.
- Four simultaneous browser instances with monitor routing and independent device selection.
- Real HRTF/HRIR data and direction-indexed convolution.
- Real PCM channel-meter producer and low-latency transport.
- Build, typecheck, Vitest, browser E2E, and listening validation. **No tests were run in this GitHub API session.**

## Gate
Before merging, execute `npm run typecheck`, `npx vitest run tests/spatialMonitorLocalGainParity.test.ts tests/monitorRoutingFacade.test.ts tests/spatialVirtualBinauralWorklet.test.ts tests/spatialVirtualBinauralRenderer.test.ts`, and `npm run build`; correct any failures and repeat. No production deploy authorized.
