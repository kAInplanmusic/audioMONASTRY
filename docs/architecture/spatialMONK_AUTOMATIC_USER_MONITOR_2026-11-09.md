# spatialMONK local user monitor — automatic routing (2026-11-09)

## Desired routing
- The operating system/browser chooses the physical audio output. The DAW does not enumerate, name-match, or select headphones.
- If spatial source processing is active and the local V2 worklet + SharedArrayBuffer path is ready, the local user monitor renders binaural **two-channel PCM**.
- Otherwise the local user monitor uses its existing stereo path. Binaural PCM is already stereo, not a hardware multichannel signal requiring OS downmix.
- The global MAIN and other users' local monitor routing are never switched by this local preview.

## Current implementation
- `SpatialAutoMonitor` is mounted at the persistent App level; the rack publishes changes through `spatialMonitorState` and the app subscribes using `useSyncExternalStore`.
- No extra user on/off switch or headphone device picker.
- The local `LocalV2SpatialMonitorController` is responsible for swapping local dry monitor with wet binaural output and restoring stereo on stop/failure.
- A one-second check detects sink readiness/context changes while the App is mounted; failed starts back off for five seconds.

## Important limitations / acceptance gates
- App-lifetime ownership is implemented. Spatial settings are now observed from the plugin-settings transport (local holder writes, remote updates, session snapshots). Activation is gated by replicated `moduleStates.spatial` and enabled spatial objects. Remaining: verify all audio-engine automation/bypass entrypoints update these sources of truth; a plugin command changing engine state directly may still bypass the UI module-state gate.
- No confirmed end-to-end tests or successful CI build yet.
- A V2 sink worklet revision counter is now exposed and observed by the rack monitor, including same-AudioContext reconnects. This is not yet covered by an automated integration test.
- The current 16-speaker virtual plan is fixed 8 × 8 m; it does not derive a room layout from the project.
- Spatial source enablement is currently inferred from the rack's local `objects.on` state; it is not yet authoritative across remote session updates, plugin bypass, automation or other app entrypoints.
- The binaural renderer is an ITD/ILD approximation, not a measured HRTF. No hardware listening verification has been completed.

Do not claim the complete automatic user monitor is production-ready until the lifecycle and verification gates pass.

## Verification added
- `tests/spatialAutoMonitorState.test.ts` checks initial state, subscription updates and unsubscribe behavior. The test was committed but not executed in this environment.

- `tests/spatialBinauralActivation.test.ts` covers OFF/unknown/PRO/AUTO_AI and source activity; written, not executed.
