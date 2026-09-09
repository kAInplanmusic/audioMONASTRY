# MONK_ARCHITECTURE — Finale 16-MONK-Struktur

> Stand: 2026-09-09 · Verbindliche Produktstruktur (ARCH-PLUGIN-001/006)

## 1. Finale Architektur

```
HEAD
 │
 ▼
masterplayerMONK          [SYSTEM — fest, alle 4 User, View-only]
 │
 ▼
DJ
 1. mixerMONK
 2. dropMONK
 3. songMONK
 4. effectMONK
 │
 ▼
PRODUCING
 5. syntisamplerMONK
 6. drumsamplerMONK
 7. instruMONK
 8. biblioMONK
 │
 ▼
AI
 9. voiceMONK
10. soundMONK
11. stemMONK
12. spatialMONK
 │
 ▼
MASTERING
13. eqMONK
14. dspMONK
15. masterMONK
16. recordMONK
 │
 ▼
aiMONK                    [SYSTEM — Chat/Steuerung, kein Audio-Render]
 │
 ▼
perforMONK                [SYSTEM — Telemetrie/Diagnose, kein Audio-Render]
```

## 2. Migrationsmatrix 21 → 16

| Alt (21) | Ziel | Ebene |
|---|---|---|
| masterplayerMONK | masterplayerMONK | SYSTEM |
| instrumentMONK | instruMONK | Plugin 7 |
| synthesizerMONK | syntisamplerMONK | Plugin 5 |
| samplerMONK | syntisamplerMONK | Plugin 5 |
| mcpMONK | syntisamplerMONK (MCP-driven control) | Plugin 5 |
| drumMONK | drumsamplerMONK | Plugin 6 |
| voiceMONK | voiceMONK | Plugin 9 |
| soundMONK | soundMONK | Plugin 10 |
| mixerMONK | mixerMONK | Plugin 1 |
| controllerMONK | Settings → MIDI / Controllers | SETTINGS/RUNTIME |
| effectMONK | effectMONK | Plugin 4 |
| dropMONK | dropMONK | Plugin 2 |
| biblioMONK | biblioMONK | Plugin 8 |
| eqMONK | eqMONK | Plugin 13 |
| dspMONK | dspMONK | Plugin 14 |
| masteringMONK | masterMONK | Plugin 15 |
| stemMONK | stemMONK | Plugin 11 |
| spatialMONK | spatialMONK | Plugin 12 |
| recordingMONK | recordMONK | Plugin 16 |
| perfMONK | perforMONK | SYSTEM |
| aiMONK | aiMONK | SYSTEM |
| songMONK | songMONK (neu, Arrangement/Set) | Plugin 3 |

## 3. Kategorien

- **Plugin (Registry, exakt 16):** mixer, drop, song, effect, syntisampler, drumsampler, instru, biblio, voice, sound, stem, spatial, eq, dsp, master, record.
- **System-Module (keine Plugins):** masterplayerMONK (oben, fest), aiMONK (nach recordMONK), perforMONK (ganz unten).
- **Runtime-Services:** Audio Runtime (V2 AudioGraph → AudioWorklet → Backend), AI Runtime, SFU/WebRTC, Supabase/R2, MIDI Runtime, Hardware Runtime.
- **Settings-Module:** MIDI / Controllers (USB-MIDI, Learn, CC/Note-Mapping, Routing, Clock/Sync, Controller-Presets, per-User-Mappings).

## 4. System-Module

| Modul | Position | Eigenschaften |
|---|---|---|
| masterplayerMONK | direkt nach Head | fest, alle 4 User, View-only, Playback/WaveTable/Info, kein Plugin-Slot, nicht in 16er-Registry |
| aiMONK | nach Plugin 16 | Chatfeld/systemweite AI-Steuerung, keine blockierende Audio-Runtime-Abhängigkeit |
| perforMONK | ganz unten | reine Informations-/Diagnoseausgabe (Session/Audio/System/Services), belastet Renderpfad nicht |

## 5. MIDI / Controller

MIDI ist **kein Plugin**. Pfad:

```
USB MIDI → MIDI Runtime → Mapping/Routing → MONK / Parameter / Transport
```

Ort: **Settings → MIDI / Controllers** (`SettingsDialog` + `MIDIControllerTerminal`).
Kein `midiMONK`, kein `controllerMONK` in der Registry.

## 6. Registry-Fakten (verifiziert)

- `src/plugins/registry.ts`: `EXPECTED_PLUGIN_COUNT = 16`, `COMPONENT_MAP` exakt 16 IDs, `SYSTEM_MODULES = { masterplayer, ai, perfor }`.
- `public/plugin-manifest.json`: 16 `ui_plugins`, IDs identisch zur Registry.
- Keine Einträge für midiMONK/controllerMONK/mcpMONK/perfMONK/masterplayerMONK/aiMONK als normale Plugins.
- `src/config/rolePresets.ts`: aktive Module ausschließlich aus den 16 Plugin-IDs.
- `src/core/voice/pluginCommandRegistry.ts`: Kommandos nur für 16 IDs + System-Module + `midi-controller` (Settings-Layer).
