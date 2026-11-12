# spatialMONK · Club Setup SSOT v3 — 12/16/24/32 XY

## Canonical requirements
- Independent room width X and depth Y, measured between the speaker boundaries; not necessarily square.
- Four fixed satellite counts: **12 / 16 / 24 / 32**. No 2/18 in the new *club setup selector*. Older engine layout IDs are retained for backwards compatibility and stereo/DJ monitoring.
- Four-wall plan: 12 = 3 per wall; 16 = 3 per wall + 4 corners; 24 = 5 per wall + 4 corners; 32 = 7 per wall + 4 corners. Corner counted once.
- Two existing front stereo speakers may be entered as real X/Y coordinates, locked, and consume two of the selected satellite slots. They are **not additional channels**.
- Optional 0/1/2 subwoofers use dedicated outputs and bass management; not counted as satellites.
- All source and speaker positions are 2D at ear height. Listener location defaults to centre but is adjustable in planner API.
- Speaker positions and actual device output mapping must be separate. No device assignment is inferred from physical position.
- Preserve existing mixerMONK/DJ stereo bus; Spatial Main is independent, fed by non-destructive taps and separate injections.

## Calculations
For each speaker i and listener L:
- Azimuth = atan2(x_i - x_L, y_i - y_L) in degrees modulo 360.
- Distance = hypot(x_i - x_L, y_i - y_L).
- Reference geometric delay = (max_j distance_j - distance_i)/343.2 * 1000 ms.
- Idealized free-field relative level = 20 log10(distance_i / max_j distance_j) dB.
- Adjacent-channel equal-power interpolation: g_i = cos(t*pi/2), g_j = sin(t*pi/2), with t = fraction of the angular interval between neighbours.
- Angular gaps must sum to 360°; the room's rectangular shape means uniform wall spacing is **not** equal to uniform angular spacing.
- These are theoretical suggestions only: they do not account for directivity, reflection, absorption, amplifier gain, speaker frequency response or device latency. Do not apply as final correction.

## Implemented in this commit
- `src/core/spatial/v2/clubPlanner.ts`: pure, deterministic rectangular planning, fixed stereo positions, 12/16/24/32 wall quotas, geometric metadata, adjacent-channel constant-power panning and safe channel probe schedule (no playback).
- `tests/spatialClubPlanner.test.ts`: rectangular room configurations, fixed L/R, exact channel counts, pan power, angle coverage and validation.
- Output setup registries must include 32.0/32.1/32.2; existing 12/16/24 layouts remain backward compatible.
- The existing `SpatialXYRoomController` still uses the earlier square-room editor; migration to the new rectangular planner is a separate UI integration task, not claimed complete.

## Measurement gate (future separate AudioWorklet/script)
1. User explicitly selects the correct output interface; enumerate and validate discrete output channel capacity, sample rate, permissions, exclusive-use constraints, and channel map.
2. Explicit user start + low-volume warning. Never autoplay, never output high-level test tones.
3. Confirm each speaker individually at e.g. -30 dBFS and 350 ms, with fade in/out, silence between, channel identity confirmation, cancel/stop, clipping and mute checks. Probe schedule is generated, playback **not implemented**.
4. Require supported measurement microphone/input, permission and loopback/latency calibration; ordinary browser mic input cannot guarantee calibrated SPL or absolute delay.
5. Estimate measured impulse responses, arrival times, relative polarity, level, spectral response and noise floor with confidence/quality checks. Reject unreliable readings.
6. Produce **session-only**, reversible calibration proposals; compare before/after, require confirmation. EQ, delay and gain should be bounded and applied outside the RT hot path. Never write over permanent presets automatically.
7. On device disconnect/reconnect, channel mismatch, xruns or measurement failure: abort calibration and preserve original routing and stereo mix.

## Later global settings TODO
Build independent **Audio Interface & Measurement Wizard** in app settings: calibrated microphone, loopback/latency, quality metrics, speaker routing matrix, output identity, channel tests, measured impulse responses, per-session correction and safe rollback. This is a separate task from the spatialMONK room editor.

## Non-negotiable release gates
- Real 12/16/24/32 discrete-channel hardware and browser/OS capabilities verified.
- No output channel collision, no stereo DJ changes, no unexpected gain increases.
- Geometry and pan tests passing; measured multi-speaker impulse responses verified in actual rooms.
- No claim of perfect acoustic response from geometry alone.
