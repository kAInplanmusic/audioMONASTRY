# Plugin-Audit-Matrix (GAP-3)

> Atomarer Check je Plugin: State-Lifecycle, Audio-Quelle, Routing, Parameter,
> Locking, Close/OFF, Clipboard, Skin, MOA-Prompt, Eval. Stand: 2026-08-31.

| # | Plugin | State (OFF/AUTO_AI/PRO) | Audio-Quelle | Routing-Ziel | Close/OFF | MOA | Eval | Status |
|---|---|---|---|---|---|---|---|---|
| 0 | masterplayer | fest (kein Toggle) | Main-Visualisierung | – | – | – | – | 🟡 D6 offen |
| 1 | instrument | Grid | itSynth/Tone-Fallback | channel4 | ✕ (P0-3) | ⬜ | ⬜ | 🟡 |
| 2 | synthesizer | Grid | ⬜ fehlt | Ziel-Button offen | ✕ | ⬜ | ⬜ | 🔴 P0-5 |
| 3 | drum | Grid | Tone-Drum-Kits | channel2 | ✕ | ⬜ | ⬜ | 🟡 |
| 4 | sampler | Grid | Sample-Player | channel5 | ✕ | ⬜ | ⬜ | 🟡 |
| 5 | sequencer | Grid | Transport-Patterns | channel1 | ✕ | ⬜ | ⬜ | 🟡 |
| 6 | voice | Grid | TTS/Singing | channel8 | ✕ | ⬜ | ⬜ | 🟡 |
| 7 | sound | Grid | Sampler/Drop | channel5 | ✕ | ⬜ | ⬜ | 🟡 |
| 8 | mixer | Grid (nicht mehr fix) | DJ-Kanäle | MAIN (Halter) | ✕ | ⬜ | ⬜ | 🟡 |
| 9 | controller | Grid | MIDI/Control | Mapping | ✕ | ⬜ | ⬜ | 🟡 |
| 10 | effect | Grid | effectProcessor | channel6 | ✕ | ⬜ | ⬜ | 🟡 |
| 11 | drop | Grid | Sampler | channel5 | ✕ | ⬜ | ⬜ | 🟡 |
| 12 | library | Grid | – (Daten) | – | ✕ | ⬜ | ⬜ | 🟡 |
| 13 | eq | Grid | eqProcessor | Master-Insert | ✕ | ⬜ | ⬜ | 🟡 |
| 14 | dsp | Grid | dspProcessor | Master-Insert | ✕ | ⬜ | ⬜ | 🟡 |
| 15 | mastering | Grid | masteringProcessor | Master-Insert | ✕ | ⬜ | ⬜ | 🟡 |
| 16 | stem | Grid | Replicate/stem-ai | Library | ✕ | ⬜ | ⬜ | 🟡 |
| 17 | spatial | Grid | Spatial-Bus | 2.1/12.x/18.x/24.x | ✕ | ⬜ | ⬜ | 🟡 |
| 18 | recording | Grid | Recorder | Master-Tap | ✕ | ⬜ | ⬜ | 🟡 |
| 19 | performance | Grid | Telemetrie | – | ✕ | ⬜ | ⬜ | 🟡 |
| 20 | ai | Bottom-Dock | MOA/MCP | – | – | ⬜ | ⬜ | 🟡 D7 |

Legende: ⬜ offen · 🟡 teilweise · 🔴 kritisch (Synth-Verdrahtung P0-5).
Die Matrix wird je Implementierungsrunde aktualisiert (Single-Root-Regel).
