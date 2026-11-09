# spatialMONK binaural monitor — merge verification gates

Status: **NOT VERIFIED** (2026-11-09). This is a test protocol, not evidence of a passing test.

## Local and CI execution

Use Node 22 and `npm ci`. Run in this order:

```bash
npm run typecheck
npm run lint
npm run test:ci
npm run security
npm run audio:gate
npm run audit:rt:gate
npm run build
```

Run targeted regression tests:

```bash
npx vitest run tests/spatialAutoMonitorState.test.ts tests/spatialBinauralActivation.test.ts
```

CI entrypoint: `.github/workflows/ci.yml` (pull_request). Record run URL, head SHA, individual job conclusions, and any skipped checks. Do not infer success from an empty workflow-run response.

## Browser and audio acceptance matrix

Run on isolated staging only; never modify production session data.

| Case | Setup/action | Required observable result |
| --- | --- | --- |
| S1 | spatial module OFF; object enabled | Dry stereo, no spatial PCM transport |
| S2 | spatial module ON; all objects OFF | Dry stereo, no spatial PCM transport |
| S3 | spatial module ON; one object enabled | One local binaural output, no doubled dry feed |
| S4 | SpatialRack unmount/remount | Monitor remains correctly routed |
| S5 | Remote holder updates object position | Local listener receives new position without rack mount |
| S6 | Remote holder disables last object | Wet monitor stops, dry stereo restored |
| S7 | Module OFF via remote replicated state | Wet monitor stops regardless of object settings |
| S8 | AudioContext suspend/resume | No duplicate or silent output after recovery |
| S9 | V2 sink disconnect/reconnect | New transport bound, old SAB not reused |
| S10 | Rapid ON/OFF while async HRTF loading | No stale wet activation or double routing |
| S11 | Spatial setup changes | Output matches supported layout; no silent mismatch |
| S12 | No SharedArrayBuffer / no crossOriginIsolated | Normal stereo fallback |
| S13 | Active automation updates spatial parameters | Audible position follows engine, not stale rack snapshot |
| S14 | MAIN/MON/PLUGIN/MIX selected in user monitor | Selected source, gain, mute, solo and cue remain correct |
| S15 | 4 browsers, distinct MON1–MON4 | No cross-user local transport, no shared MAIN mutation |
| S16 | 4 simultaneous changes and lock handoff | Server authority preserved, no race/double output |

## Audio evidence

For S3/S6/S9/S14/S15 capture local stereo loopback per browser and MAIN separately; compare peak, RMS, silence periods and channel correlation. Listening must confirm directionality, continuity and no comb filtering/double path. Test with both mono and stereo material and a source at left/center/right.

## Blocking issues requiring investigation

- The auto monitor uses a fixed 16-speaker, 8x8m virtual plan; confirm this matches current session setup or implement layout mapping.
- The spatial activation gate uses replicated module state and enabled objects, not every direct engine command or automation entrypoint.
- Validate monitor source selection and local gains: bypassing the V2 dry path must not override user-specific MON routing or MAIN.
- Inspect concurrent start/stop/disconnect for stale asynchronous transport attachment and cleanup.
- The PR includes many unrelated changes: review diff before merge.

## Release decision

Do not merge PR #23 until TypeScript, lint, tests, build and the routing/multi-user/audio evidence above are recorded and passing. A mergeable GitHub PR is **not** proof of correctness.
