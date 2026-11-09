# Spatial output transport contract · implementation notes

The spatial DSP outputs planar floating-point PCM in 12/16/24/32 logical satellite channels. The transport adapter is a separate dependency, not part of spatial panning.

- `src/core/spatial/v2/outputAdapter.ts` implements an explicit output adapter interface, capability probing, sample-rate/channel-map validation, a virtual 32-channel prototype and an output router.
- `tests/spatialOutputAdapter.test.ts` exercises virtual output and fail-closed mapping validation. Tests not executed in connector environment.
- A future USB interface uses an ALSA/PipeWire backend; LAN interfaces use a network adapter (e.g. Dante via licensed-compatible endpoints, AES67/RTP with PTP, or AVB where supported). Never assume protocol compatibility merely because a device has Ethernet.
- Hardware adapters must expose *actual* capabilities, independently validate stream channel order, block sizes, clock source, latency and device loss, and never silently remap to stereo.
- USB and LAN device adapters must implement `SpatialOutputAdapter`; the room plan, scene, DSP and automation do not change.
- The virtual adapter is an in-process PCM test prototype. It is NOT a Linux soundcard or completed AudioWorklet bridge.
- Future real-time bridge must use a bounded preallocated shared-memory ring buffer, nonblocking writes, explicit overrun/underrun counters, clock drift compensation, controlled reconnection, and post-router per-channel metering.
- Changing output backend requires explicit stop and validation. A failed switch should leave Spatial Main disabled or restore the previous known-good device with explicit confirmation; never send 32-channel audio into DJ stereo.
- 32 satellites + 2 independent subwoofers = 34 discrete output channels. Current adapter contract models satellites only; bass output needs a separately capability-validated sub-bus.
- Physical calibration is device-specific and session-only. Store mapping by stable device identity and physical port, not by an assumed universal USB/LAN channel order.
- This is a groundwork commit, not a completed end-to-end USB/LAN audio implementation.
