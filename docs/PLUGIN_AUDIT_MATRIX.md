# Plugin-Audit-Matrix (GAP-3)

> Atomarer Check je Plugin: State-Lifecycle, Audio-Quelle, Routing, Parameter,
> Locking, Close/OFF, Clipboard, Skin, MOA-Prompt, Eval. Stand: 2026-08-31.

| # | Plugin | State (OFF/AUTO_AI/PRO) | Audio-Quelle | Routing-Ziel | Close/OFF | MOA | Eval | Status |
|---|---|---|---|---|---|---|---|---|
| 0 | masterplayer | fest (kein Toggle) | Main-Visualisierung | – | – | – | – | WARN |
| 1 | instrument | Grid | itSynth/Tone-Fallback | channel4 | ✕ (P0-3) | ⬜ | ⬜ | WARN |
| 2 | synthesizer | Grid | itSynth/Tone-Fallback | channel4 | ✕ | ⬜ | ⬜ | PASS (P0-5 erledigt) |
| 3 | drum | Grid | Tone-Drum-Kits | channel2 | ✕ | ⬜ | ⬜ | WARN |
| 4 | sampler | Grid | Sample-Player | channel5 | ✕ | ⬜ | ⬜ | WARN |
| 5 | sequencer | Grid | Transport-Patterns | channel1 | ✕ | ⬜ | ⬜ | WARN |
| 6 | voice | Grid | TTS/Singing | channel8 | ✕ | ⬜ | ⬜ | WARN |
| 7 | sound | Grid | Sampler/Drop | channel5 | ✕ | ⬜ | ⬜ | WARN |
| 8 | mixer | Grid (nicht mehr fix) | DJ-Kanäle | MAIN (Halter) | ✕ | ⬜ | ⬜ | WARN |
| 9 | controller | Grid | MIDI/Control | Mapping | ✕ | ⬜ | ⬜ | WARN |
| 10 | effect | Grid | effectProcessor | channel6 | ✕ | ⬜ | ⬜ | WARN |
| 11 | drop | Grid | Sampler | channel5 | ✕ | ⬜ | ⬜ | WARN |
| 12 | library | Grid | – (Daten) | – | ✕ | ⬜ | ⬜ | WARN |
| 13 | eq | Grid | eqProcessor | Master-Insert | ✕ | ⬜ | ⬜ | WARN |
| 14 | dsp | Grid | dspProcessor | Master-Insert | ✕ | ⬜ | ⬜ | WARN |
| 15 | mastering | Grid | masteringProcessor | Master-Insert | ✕ | ⬜ | ⬜ | WARN |
| 16 | stem | Grid | Replicate/stem-ai | Library | ✕ | ⬜ | ⬜ | WARN |
| 17 | spatial | Grid | Spatial-Bus | 2.1/12.x/18.x/24.x | ✕ | ⬜ | ⬜ | WARN |
| 18 | recording | Grid | Recorder | Master-Tap | ✕ | ⬜ | ⬜ | WARN |
| 19 | performance | Grid | Telemetrie | – | ✕ | ⬜ | ⬜ | WARN |
| 20 | ai | Bottom-Dock | MOA/MCP | – | – | ⬜ | ⬜ | WARN |

Legende: PASS = produktionsreif · WARN = teilweise/offene Teil-Tasks · FAIL = blockiert/kritisch.
Die Matrix wird je Implementierungsrunde aktualisiert (Single-Root-Regel).
