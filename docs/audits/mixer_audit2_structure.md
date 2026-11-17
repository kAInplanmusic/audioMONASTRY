# audioMONASTRY – Struktur-Audit mixerMONK

**Plugin:** mixerMONK  
**ID:** mixer  
**Rolle:** channel  
**Kanal:** — (Summierungspunkt)  
**Format:** stereo  
**Inputs:** 8  
**Outputs:** 1  
**Latency:** 0  
**Bypassable:** false  
**Stand:** gm-v1.0.0 / f5538c63  
**Geprüfte Dateien:** `src/components/mixer/MixerDesk.tsx`, `src/components/mixer/DeckControllers.tsx`, `src/components/mixer/*.tsx`, `src/plugins/pluginContract.ts`, `src/plugins/signalChain.ts`, `src/plugins/registry.ts`, `src/context/PluginManagerContext.tsx`, `src/core/session/pluginTransport.ts`, `src/utils/pluginSettings.ts`

---

## Architektur-Analyse

### Komponenten-Hierarchie
```
MixerDesk (React.memo)
├── Header: Tempo, Tonart, Transport, Autoload, Controller-Toggles
├── Signalweg-Leiste (SIGNAL_CHAIN-Stufen)
├── DeckController L (links, optional)
├── Am-Zentrale:
│   ├── Rail: EQ/DYN/FX/PAN/REC Schnellzugriffe, FX LOCK, MIX LOCK
│   ├── Master: Fader, Meter, A/B Crossfader-Buttons
│   ├── Kanalzüge (Bank A: 0-3, Bank B: 4-7)
│   └── Bank-Wahl, Kanal-Sprünge 1-8, Makros (Filter/FX/Build)
└── DeckController R (rechts, optional)
```

### State-Management
- **Lokaler React-State** (`DeskState`) mit `readPluginSettings('mixer')` als Initialwert
- **Persistenz** via `writePluginSettings('mixer', { desk: s })` bei jeder Änderung (useEffect, [s]-Dependency)
- **Synchronisation** über `webRTCManager` (Main-Out-Halter, Transport, Tempo)
- **Polling-Intervall** 300ms für Transport, Owner, BPM, Spielzustand

### Schnittstellen
- `channelMapFromContract()` → Kanal-Quellen-Mapping (8 Quellen aus Vertrag)
- `audioEngine` (globaler Singleton) für Gain, EQ, Pan, PFL, Transport
- `webRTCManager` für Kollaboration, Main-Out-Eigentum, Updates
- `pluginModeOf`, `pluginOwnerOf`, `isPluginSynced`, `setPluginSync` für Plugin-Locks

---

## Technische Fehlannahmen

| # | Annahme | Problem |
|---|---------|---------|
| 1 | `audioEngine.setChannelGain()` ist echtzeit-sicher | Keine Überlast-/Clipping-Prüfung; `db2g(12) ≈ 4.0` kann hard-clippen |
| 2 | `webRTCManager.isMainOutOwner` ist konsistent | Race Condition bei Halterwechsel; kein Quorum/Heartbeat |
| 3 | 300ms Polling reicht für Live-Performance | Zu langsam für präzise Transport-Synchronisation (jitter ~150ms) |
| 4 | `performance.now()` TAP-BPM ist präzise genug | 2500ms Fenster zu eng für langsame Töne; keine Outlier-Filterung |
| 5 | `readPluginSettings()` liefert immer valides JSON | Keine Schema-Validierung; corrupt Settings crashen die Restauration |
| 6 | Nur der Halter bedient das Pult | `disabled = !isHolder` blockiert Nicht-Halter komplett, kein View-Modus |

---

## Designschwächen

1. **Kein Undo/Redo** für Kanal-Patches — versehentliche Änderungen unwiderruflich in Live-Performance
2. **Kein Channel-Linking** für EQ/Pan/Fader (Standard in professionellen Pulten)
3. **Kein Multi-Room** — kein räumliches Trennung Live/Practice-Mixe
4. **Single-Key-Autoload** — nur Kanal 1, kein Batch-Autoload
5. **FX LOCK ohne visuelles Feedback** — Button-Status nicht klar abbildbar
6. **MIX LOCK Text nur als Tooltip** — kein visuelles Indicator-Element im UI
7. **Keine Szenen** (kommentiert als "selten benutzt", aber keine UI-Vorbereitung)
8. **Kein Booth/Kopfhörer/Mic-Regler** (kommentiert, nicht implementiert)

---

## Performance-/DSP-Risiken

| Risiko | Schwere | Begründung |
|--------|---------|------------|
| 300ms Transport-Polling | Hoch | Jitter bei schnellen Tempo/Transport-Änderungen |
| `Math.sin()` Crossfader-Kurve | Mittel | CPU-intensiv bei 8 Kanälen pro Frame |
| Kein Web Worker für Audio-Analyse | Mittel | `analyzeMusic()` blockiert UI-Thread bei großen Libraries |
| `effectiveGain()` ohne Limiter | Hoch | `trim +12dB` × `fader 1.5` = clipping möglich |
| `writePluginSettings()` bei jeder State-Änderung | Mittel | Häufige Schreiboperationen, keine Debounce |

---

## Schnittstellen-Probleme

1. **`channelMapFromContract()` Rückgabe nicht typisiert** — `any` oder implizites String-Array
2. **Keine TypeScript-Kontrakte** für Plugin-Einstellungen (`Partial<DeskChannel>` ohne Schema)
3. **Session-Settings-Store verwendet `unknown`/`any`** für saved-Werte
4. **SIGNAL_CHAIN-Stufen hardcodiert** — keine dynamische Plugin-Registrierung
5. **Keine Versionierung** des Desk-State-Formats — Migration bei Änderungen nicht möglich

---

## Empfohlene Korrekturen

1. **UNDO_REDO:** `history: DeskState[]` zur Plugin-State-Serialisierung hinzufügen (max 50 Einträge)
2. **CHANNEL_LINKING:** `linkEq?: boolean` + `linkPan?: boolean` in `DeskChannel`
3. **MULTI_ROOM:** `roomId` zu ChannelStrip-Props und State hinzufügen
4. **TAP_BPM:** Fenster auf 5000ms erweitern, Median statt Mittelwert, Outlier-Filter
5. **CLIPPING_SCHUTZ:** `Math.min(1.0, effectiveGain(...))` mit Soft-Knee-Limiter
6. **DEBOUNCE_SETTINGS:** `writePluginSettings` mit 200ms Debounce
7. **VIEW_MODE:** Nicht-Halter können Pult betrachten (Read-Only), ohne Bearbeitung
8. **STATE_VERSION:** `version: number` in DeskState für zukünftige Migrationen

---

**Bewertung:** mixerMONK ist funktional vollständig, aber für Produktions-Live-Einsätze nicht robust genug (kein Undo, kein Clipping-Schutz, kein View-Modus, keine State-Versionierung).

**Priorität:** Hoch (Clipping-Schutz, Undo/Redo) → Mittel (Linking, Multi-Room, View-Modus)