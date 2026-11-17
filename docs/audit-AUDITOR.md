# audioMONASTRY – AUDITOR.MD
## Ideen-Zerstörer Audit-Protokoll

### Audit 1: mixerMONK (Idea Destroyer)
**Datum:** 2026-11-17
**Status:** IN_BEARBEITUNG

#### Grundkonzept
- Pult mit 8 Kanälen, 2 Bänken A/B
- Quellen: drop, song, drums, synth, instru, vox, sound, stems
- Crossfader mit Bank-Pegeln

#### Architektur-Analyse
**Schwachstellen gefunden:**

1. **Keine Multi-Room-Unterstützung**
   - Keine räumliche Trennung für Live-Performance vs. Practice
   - Kritisch: keine Möglichkeit, unterschiedliche Mixe gleichzeitig zu pflegen

2. **Hardcodierte EQ-Pegel**
   - `trim: -12..+12 dB`, `hi/mid/low: -26..+6 dB`
   - Keine Möglichkeit, Kanal-basierten EQ zu teilen (z.B. Low-Cut auf allen Kanälen)

3. **Kein Track-History-Management**
   - Kein Undo/Redo für Kanal-Patches
   - Kritisch für Live-Performance: versehentliche Änderungen unwiderruflich

4. **Single-Key-Autoload**
   - Nur Kanal 1 kann Autoload haben
   - Batch-Autoload (mehrere Kanäle gleichzeitig) nicht möglich

5. **FX-LOCK-Implementierung**
   - Makros ändern Effekte nicht, aber FX-LOCK-Button nicht sichtbar in visuellem Feedback
   - Kritisch: Der Halters-Modus kann nicht visuell abgebildet werden

#### Technische Fehlannahmen
1. **Assumption:** `audioEngine.setChannelGain()` ist echtzeit-sicher
   - **Risiko:** Keine Glasbruch-Prüfung bei Überladung
   
2. **Assumption:** `webRTCManager.isMainOutOwner` ist konsistent
   - **Risiko:** Race Condition bei Halterwechsel

3. **Assumption:** `performance.now()` für TAP-BPM ist präzise genug
   - **Risiko:** 2500ms Fenster zu eng für schnelle Töne

#### Designschwächen
1. **Crossfader-Kurve "smooth"** implementiert mit `Math.sin` - CPU-intensiv bei 8 Kanälen
2. **Keine Channel-Linking-Möglichkeit** für EQ/Pan (Standard in professionellen Pulten)
3. **Microphone-Regler** kommentiert als selten benutzt, aber kein UI-Element vorhanden

#### Performance-Risiken
1. **300ms Interval für Transport-Updates** - zu langsam für Live-Performance
2. **Kein Web Worker für Audio-Analyse** - UI-Blockierung möglich

#### DSP-Risiken
1. **Keine Sample-Accurate Transitions** bei Tempo-Änderungen
2. **Pitch-Bereich begrenzt auf ±100%** - keine Mikroton-Abstimmung

#### Schnittstellen-Probleme
1. **API nicht dokumentiert** - `channelMapFromContract()` Rückgabe nicht typisiert
2. **Keine TypeScript-Kontrakte** für Plugin-Einstellungen
3. **Session-Settings-Store** verwendet `any` für saved-Werte

#### Empfohlene Korrekturen
1. MULTI_ROOM: Füge `roomId` zu ChannelStrip-Props hinzu
2. CHANNEL_LINKING: Implementiere `linkEq?: boolean` in DeskChannel
3. UNDO_REDO: Füge `history: DeskState[]` zur Plugin-State-Serialisierung hinzu
4. TAP_BPM: Erweitere Fenster auf 5000ms, füge "tap-Tempo" Counter hinzu

---

*Nächster Audit: dropMONK (Source-Plugin)*