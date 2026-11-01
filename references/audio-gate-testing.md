# Audio-Gate Testing Pattern (DB-011/017)

## Overview

`scripts/audio-gate.cjs` is an integration test that measures real audio output using headless Chromium with AudioContext. It tests DSP blocks in a real browser environment.

## Test Checks

| Check | Description |
|-------|-------------|
| Silence before trigger | Must be < -60 dBFS |
| Test-tone audible | Must be > -20 dBFS |
| Sample-trigger (L/R) | Left >= -30 dBFS, Right >= -30 dBFS |
| Channel separation | L - R >= 6 dB (stereo separation) |
| HQ-Reverb tail | Must be audible after tone off |
| Mod-Matrix Tremolo | Must have >= 3 dB spread |

## Headless Environment Failure

### Symptom
All amplitude measurements show `-inf dBFS` or 0 peak, even though the worklet loads and runs without errors.

### Root Cause
Headless Chromium (and CI containers) have no real audio output device. AudioWorkletNode runs but produces no audible output, so AnalyzerNode reports silence.

### Solution
- Use AudioGate for physical testing on real hardware
- Unit tests (DSP functions) are unaffected - they run in Node.js directly
- E2E Playwright tests that don't need audio (UI, actions, smoke) work fine

## Running Audio-Gate

```bash
node scripts/audio-gate.cjs
```

Exit 0 = all checks pass
Exit 1 = 1+ checks failed
Exit 3 = crash/error

## Results

Results are written to `reports/audio-gate.json` with:
- `log`: step-by-step console output
- `steps`: raw measurements per check
- `checks`: pass/fail per check
- `modSpread`: modulation depth measurement