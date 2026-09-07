# Status: DEPRECATED / EXPERIMENTELL (Stand 2026-09-07)

**Der Rust-Mixer (`rust_mixer`) ist ein nicht produktiver Prototype.**

## Befund (Audit 2026-09-07)

- `src/lib.rs` exportiert nur `mix_audio(buffer1, buffer2)` — ein simpler
  Sample-für-Sample-Addierer ohne Gain, Clip, EQ, Fader oder Kanal-Logik (10 Zeilen).
- Das Build-Output `*.node` wird **nirgends** importiert: weder `server.ts`,
  noch `src/`, noch ein Docker-Image referenzieren `services/mixer`.
- Die produktive Mixer-Logik lebt ausschließlich in
  - `src/utils/audioEngine.ts` (WebAudio-Graph, Kanalzüge, Master),
  - `src/components/DJ4ChMixer.tsx` (UI-Verdrahtung) und
  - `src/audio/worklets/dspProcessor.ts` (AudioThread-DSP).

## Optionen (Entscheidung offen)

| Option | Aufwand | Nutzen |
|---|---|---|
| **A) Löschen** | S | Weniger Wartungsfläche; `services/mixer/index.js` (NAPI-Loader) + Cargo-Artefakte weg. |
| **B) Ausbauen** | L | Natives Mixing jenseits der Worklet-Grenze (Zero-Copy zwischen Rust-Runtime und Worklets); lohnt erst, wenn `services/audio-runtime` (cpal/IPC) produktiv geht. |
| **C) Eingefroren lassen** | – | Aktueller Zustand. Funktioniert, aber irreführend (klingt produktiver als er ist). |

**Empfehlung:** Option A (löschen), sobald feststeht, dass Option B nicht in
`services/audio-runtime` aufgehen soll — das ist ohnehin der ortsgerechte
Platz für nativen Audio-Code (cpal-Streams, IPC-Protokoll stehen dort schon).

## Falls reaktiviert

1. `cargo build --release` (napi-RS CLI nötig, `.node`-Artefakt je Plattform)
2. Importpfad in `server.ts` oder einem Service einbauen + Tests
3. Erst danach `DEPRECATED`-Marker hier entfernen.
