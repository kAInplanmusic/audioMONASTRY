# spatialMONK · Reference hardware + Virtual Audio + Measurement SSOT
Status: architecture and virtual-meter prototype only. Hardware and microphone measurement NOT live tested.

## Physical reference: RME Digiface USB + 4 x Behringer ADA8200
- USB RME Digiface: four ADAT banks x eight 24-bit channels at 44.1/48k = 32 optical satellite outputs.
- 96k S/MUX halves available ADAT channels to 16; 192k to 8. Lock 48k for 32 satellite reference.
- 4 ADA8200 ADAT inputs => 32 balanced analog XLR line outputs. Connect RME ADAT OUT A/B/C/D to ADA8200 ADAT IN 1/2/3/4, each ADA8200 slave to ADAT input and verify lock. All four units require mains power.
- RME extra headphone channels 33/34 are NOT a substitute for balanced analog sub outputs. 32+2 independent subs requires separately designed physical routing/expansion.
- Linux native ALSA support is kernel-quirk based (in-kernel 6.12+), not generic USB audio class compliance.
- CRITICAL: 2026-11-07 linux-usb mailing-list report documents intermittent corrupted playback on some Digiface USB stream starts, potentially xHCI scheduling/USB frame alignment. Never assume this is fixed; verify kernel and workarounds and require repeated starts/loopback before enabling amps.
- Hardware routing matrix: logical SAT01..SAT32 => ADAT A ch1..8, B ch1..8, C ch1..8, D ch1..8. ALSA PCM stream may expose 34 channels (two extra headphone), so DO NOT equate the total ALSA stream length with 32 satellites.

## Virtual interface: three layers, not a fake hardware device
1. Pure TypeScript VirtualSpatialInterface meters *actual* per-channel PCM buffers, independent of hardware, and rejects NaN/Inf, channel mismatch, duplicate channel mapping. This is not inferred activity from a visual motion preset.
2. Browser AudioWorklet multi-output spatial renderer -> post-render meter tap -> MessagePort/SAB frame meter aggregation at 20–30 Hz -> UI spatial speaker LEDs. Worklet must preallocate buffers and must not run the pure JS map/frame allocations in the RT loop.
3. Optional Linux PipeWire virtual sink with 32 channels for other desktop apps, created explicitly using module-null-sink, rate=48000, channels=32. Verify support for 32-channel channel maps on target PipeWire version. Monitor ports do not prove audio was rendered by the browser. For browser output to PipeWire virtual sink, explicitly negotiate and verify channelCount/channelInterpretation; browsers may downmix or limit to stereo. Prefer a local bridge with native ALSA/PipeWire client for authoritative 32-channel routing. No root or permanent system audio change by default.

## UX
- One canonical 12/16/24/32 rectangular room setup, with optional locked L/R front coordinates.
- Render 32 virtual satellites on the same XY coordinate map as planner.
- Each speaker shows: speaker ID, actual channel, current peak/rms, clip, unmapped/invalid, muted and verified status. Front/back sequence must light real channels, not planned trajectories.
- Device toggle: VIRTUAL (no hardware), XONAR U7 2.2 (physical limited), DIGIFACE 32 REFERENCE (only selectable if detected), OTHER HARDWARE (capability-gated).
- Never claim virtual testing proves ALSA/USB/ADAT clock synchronization, analog speaker polarity, acoustic localization or channel cable mapping.

## Measurement modes
A: calibrated microphone (manufacturer serial calibration TXT/FRD and sensitivity if available) with sweep/deconvolution, level checks, repeat measurements and IR confidence. Verify calibration format, orientation, mic preamp, loopback timing, sample rate and clipping. Frequency-response corrections, polarity, timing, EQ proposals are applied only after user confirmation; session-only and rollbackable.
B: ordinary mic with approximate sensitivity/response: relative levels, arrival timing where identifiable, gross routing/polarity clues, coarse frequency bands. No trustworthy absolute SPL, fine EQ or guaranteed acoustic triangulation from one mic position. Multiple known mic positions and measured time-of-flight plus latency reference improve geometric localization; reflections and unknown ADC delay make inference uncertain. Display confidence, don't auto-correct unreliable values.
- For Xonar U7: mic input capability/ALSA capture controls and full-duplex support must be checked on the actual Linux host; don't assume the mic jack supports phantom power or calibrated measurement.
- Use Room EQ Wizard's documented logarithmic sweeps, calibration file, timing reference, and impulse response workflows as methodological reference. REW is free-to-use, NOT automatically open-source; do not copy proprietary REW source. Implement own sweep/deconvolution or integrate permitted open-source DSP libraries with license review.
- Measurement pipeline: identify I/O -> select channel -> -30dBFS fade-in test -> repeat sweep (3+ valid) -> noise/clipping/SNR/IR quality -> timing/level/frequency response -> compare 3–5 mic positions -> robust average -> bounded correction -> preview/confirm -> session-only commit/rollback.
- Safety: low-level first, hard cancel, limiter, mute non-target channels, no loopback feedback, no automatically armed microphone, no permanent global EQ modifications.

## Implementation status
- `src/core/spatial/v2/virtualInterface.ts`: 12/16/24/32 actual-sample virtual meter sink (pure prototype).
- `tests/spatialVirtualInterface.test.ts`: sample-level meter and routing tests (not executed in this connector environment).
- Still required: AudioWorklet DSP integration, PipeWire local daemon, UI real meter binding, Xonar U7 capture verification, sweep measurement DSP, hardware tests, Linux automated repeated-stream-start test, browser multichannel negotiation, real audio output validation.

## Primary documentation
- https://rme-audio.de/de_digiface-usb.html
- https://archiv.rme-audio.de/download/dface_usb_d.pdf
- https://www.behringer.com/de/products/0800-AAB
- https://lists.openwall.net/linux-kernel/2024/09/01/368
- https://lore-kernel.gnuweeb.org/linux-usb/20261107122335.182f01c2.michal.pecio%40gmail.com/T/
- https://docs.pipewire.org/page_pulse_module_null_sink.html
- https://www.roomeqwizard.com/help/help_en-GB/html/gettingstarted.html
