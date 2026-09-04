# VISIONS_TODO.md – audioMONASTRY Zukunfts-/Sandbox-Zweig

> Zweck: Visionäre, zukunftsträchtige Ideen sammeln, die **noch nicht** in den
> Haupt-Branch implementiert werden. Jede Idee wird hier als Experiment/Sandbox
> geführt und erst nach Messung + Architektur-Entscheid in `main` übernommen.
>
> Regel: **Kein High-End-Feature wegen des Namens.** Erst Nutzen messen, dann bauen.

---

## 💶 Allgemeine Hintergrundinfos (Budget, für uns)

- **Gesamtprojekt:** hartes Maximum **20 €/h** (nur wenn wirklich nötig)
- **Zielwert:** **4–6 €/h** im Regelbetrieb
- **Produktions-/Testnutzung:** bestmöglich **< 1 €/h** (Idle-Auto-Shutdown nutzen)
- Prinzip: **so günstig wie möglich** – teuer nur bei echtem, gemessenem Nutzen
- Aktuelle Flotte: 5/5 Hetzner-Instanzen in Benutzung (stündlich abgerechnet)

---

## 🧪 V1 – Sandbox-Experimente (nächster Vision-Zweig `vision/…`)

| # | Idee | Hypothese / Messlatte | Status |
|---|---|---|---|
| V1.1 | **WASM-SIMD-DSP-Kernel** für Mixer/Summenbildung (128 Kanäle) | Nur einbauen, wenn Benchmark ≥1,5× schneller als JS-Worklet bei 8+ Kanälen | 🔵 Sandbox |
| V1.2 | **WebCodecs AudioEncoder/Decoder** für Stem-Upload/-Download (Opus) | Weniger CPU als JS-WAV-Encode bei >50 MB Uploads | 🔵 Sandbox |
| V1.3 | **WebTransport** für Stem-Streaming (QUIC, unreliable datagrams) | Erst ab >10 Usern oder >100 MB Transfers sinnvoll | 🔵 Sandbox |
| V1.4 | **WebGPU-Spektral-Effekte** (FFT/Convolution/Realtime-Analyzer) | GPU-Transfer-Overhead < CPU-Ersparnis bei ≥8192-Punkt-FFT | 🔵 Sandbox |
| V1.5 | **Hybride Engine:** Low-Latency-Pfad (Worklet) + High-Quality-Pfad (Offline/WASM) mit PDC | Messbar weniger Dropouts bei Mastering/Reverb unter Last | 🔵 Sandbox |
| V1.6 | **OPFS-Sample-Cache** (Origin Private File System) für Bibliothek >2 GB | Laden <50 ms aus OPFS vs. IndexedDB/Netz | 🔵 Sandbox |
| V1.7 | **MPE / Polyphonic Aftertouch** (MIDI 2.0-fähig) | Erst wenn Hardware/User-Anforderung existiert | 🔵 Sandbox |
| V1.8 | **DAWproject-Export** (Interop mit Bitwig/Studio One) | Erst bei Anforderung Session-Austausch | 🔵 Sandbox |
| V1.9 | **Native Client (Tauri)** für ASIO/CoreAudio/PipeWire + Xonar-U7-Mehrgeräte | Erst wenn Browser-Audio-Grenzen real schmerzen | 🔵 Sandbox |
| V1.10 | **CRDT-Framework (Yjs/Automerge)** für Undo/Redo-Historie + >10 User | Erst wenn LWW-CRDT an Grenzen stößt | 🔵 Sandbox |

---

## 🚀 V2 – Fernere Visionen (kein aktiver Plan)

- **Eigene Modell-Runtime:** ONNX/WASM lokal für Demucs-lite + Embedding (GPU via WebGPU)
- **KI-Co-Producer:** MoaAgent Level 2 (Plant→Hört→Bewertet→Iteriert, geschlossener Loop)
- **Spatial-Objekt-Mixing bis 24.2 mit Kopfhörer-Binaural-Fallback** (Ambisonics HOA 3rd Order)
- **Session-Cloud:** Ende-zu-Ende verschlüsselte Projekt-Sessions mit CRDT-Merge
- **Live-Events:** Broadcast-Modus (1 Produzent → N Zuhörer, nur MAIN-Stream)

---

## 🧭 Aufnahme-Kriterien (von Sandbox → main)

1. Benchmark liegt vor (vorher/nachher, gleiche Hardware)
2. Audio-Integrität: 0 zusätzliche Dropouts, kein Qualitätsverlust
3. Latenz-Budget eingehalten (lokal 8–15 ms, Netz <50 ms, Kollab <100 ms)
4. Wartbarkeit: klare Modulgrenze, Fallback-Pfad vorhanden
5. Browser-Matrix: Chromium/Firefox/Safari geprüft (oder klar deklariert)
6. **Kosten (nur die Integration, nicht das Gesamtbudget – Budget steht oben):**
   - Integration in die **bestehende Hetzner-Flotte** (stündlich abgerechnet;
     aktuell 5/5 belegt → betroffene Instanz skalieren oder Instanz ergänzen)
     **oder** via **Replicate (GPU, Pay-per-Use)**
     **oder** über einen **kostenlosen bzw. stundenbasierten Zusatzhost**

---

## 📌 Bereits in `main` als optionaler Pfad (Benchmark/Entscheid ausstehend)

> Diese Experimente liegen aktuell in `main`, sind dort aber nur **optional
> mit JS-Fallback** verdrahtet. Sie gehören konzeptionell hierher (Sandbox),
> bis die Aufnahme-Kriterien oben erfüllt sind. Entscheidung 2026-09-04:
> dokumentieren statt verschieben (kein Umbau-Risiko).

| # | Modul in main | VISIONS-Punkt | Offener Benchmark/Entscheid |
|---|---|---|---|
| 1 | `src/core/gpu/WebGPUKernel.ts`, `SpatialConvKernel.ts`, `src/webgpu/webgpu_adapter.ts` | V1.4 WebGPU-Spektral-Effekte | GPU-Transfer < CPU-Ersparnis bei ≥8192-FFT |
| 2 | `services/audio-runtime/` (Rust/cpal), `src/core/audio/runtime/`, `NativeBackend.ts` | V1.9 Native Client | ASIO/CoreAudio-Mehrgeräte-Bedarf messen |
| 3 | `services/mixer/` (Rust-Mixer) | R3 Server-Side Mixer | Lasttest >4 User |
| 4 | `src/core/audio/V2StudioGraph.ts`, `OfflineBounceEngine.ts` | V1.5 Hybride Engine | Dropouts Mastering/Reverb unter Last |
| 5 | `src/audio/wasm/dspKernel.c`, `WasmPluginHost.ts`, `WasmBackend.ts` | V1.1 WASM-SIMD-DSP | ≥1,5× schneller als JS-Worklet bei 8+ Kanälen |
| 6 | `src/audio/wasm/hrtf_conv/`, `src/audio/spatial/wasmHrtf.ts` | V2 Binaural/HRTF High-Quality | Qualitäts-/CPU-Vergleich JS-Kernel |
| 7 | `src/ai/localDemucs.ts` (onnxruntime-web lazy) | V2 Eigene Modell-Runtime | Latenz <100 ms / Qualität vs. Replicate |
| 8 | `src/utils/opfs.ts` + SampleContext-Integration | V1.6 OPFS-Sample-Cache | >2-GB-Benchmark (Laden <50 ms) |

