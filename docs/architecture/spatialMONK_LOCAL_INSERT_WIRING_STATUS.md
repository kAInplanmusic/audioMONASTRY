# Local binaural insert: wiring status and contract (2026-11-09)

## Actual source trace
- `src/core/audio/monitorRouting.ts`: MAIN/MON/PLUGIN/MIX, MON1..MON4. This is existing policy and must remain intact.
- `src/core/audio/V2MonitorGraph.ts`: stereo local `monitorBus`; `render()` returns `main`, `cue`, `monitor`.
- `src/core/audio/backends/V2LiveSink.ts`: `v2-sink-processor` renders selected local monitor and previously connected directly to `AudioContext.destination`. The browser output channel count is currently clamped to 24, so it is **not** an actual 32-channel output path.
- `src/audio/spatial/node.ts`: separate `spatial-processor` worklet, currently stereo out with HRTF loader; cannot assume the already-mixed stereo monitor has spatial source metadata.

## Code implemented
`V2LiveSink.setLocalMonitorInsert(input: AudioNode|null)`:
- optional local post-monitor output insert point, with direct-output default;
- checks AudioContext identity;
- reconnects to default on connection failure;
- survives same-context sink reconnect; drops stale other-context insert;
- does not change monitor source policy, shared main, Visuals or other users;
- does NOT automatically connect the effect output to headphones; the caller must own and wire the real effect chain.

## Hard limitation
Connecting a stereo monitor signal to a stereo spatial-processor does not reconstruct a 32-source 3D scene. The next integration must inspect source positions and existing spatial worklet protocol, then select between (a) source-aware spatial HRTF processing before final stereo monitor summation and (b) an explicitly labelled front-centered stereo passthrough. Never advertise fake 3D.
Do not activate `setLocalMonitorInsert` until a verified HRTF processor with matching input contract and correct output-to-device wiring exists.

## Remaining verification
- [ ] Actual HRTF implementation, HRIR dataset license, initialization and response tests.
- [ ] Source-aware routing from 32 virtual channels or spatial source stems to the per-user HRTF insert.
- [ ] Four browser contexts, separate output preferences and no cross-user leakage.
- [ ] Browser worklet and build tests, sink disconnect/reconnect with active insert.
- [ ] Meter bridge actual 32-channel PCM producer; existing 2/24 output limitation addressed independently.
- [ ] PipeWire 32ch native bridge, device handshakes and hardware validation.
