# audioMONASTRY — Phase C Audit 2 (Struktur): recordMONK

**Plugin:** `record` / `recordMONK`
**Stand:** Commit f5538c63
**Art:** Struktur-Audit — Architektur, Schnittstellen, Abhängigkeiten, Konsistenz.

---

## 1. Grundkonzept

Recorder als Abgriff (Tap) ohne Signalveränderung: Aufnahme des Master- oder Eingangs-Signals, Takes-Management, Bounce durch die 16-Plugins-Kette, WAV-Export (STORE-P1-001).

## 2. Architektur-Analyse

**Schicht 1 — Vertrag (`src/plugins/pluginContract.ts`):**
- `id: 'record'`, `role: 'recorder'`, `channel: null`, `format: 'stereo'`, `inputs: 1`, `outputs: 1` (Durchleitung + Abgriff)
- `intrinsicLatencyFrames: 0`, `bypassable: false`, `sendsToFx: false`, `viaChannel: false`, `producesAudio: false`, `insertScope: null`

**Schicht 2 — UI (`src/components/RecorderTerminal.tsx`):**
- `MediaRecorder` über `audioContext.createMediaStreamDestination()` (MASTER_OUT) oder `requestUserMedia` (Mikrofon)
- `INPUT_SOURCES = ['MASTER_OUT','VOCAL_STEM','DRUM_BUS','SYNTH_GROUP']`
- Takes-State (In-Memory), `RecScope`-Wellenform (`useMainLevel`), `RecMeters`
- `bounceThroughChain`: `audioEngine.getTrackSampleUrl('channel1')` → `getMusicSampleChannels` → `bounceThroughPluginChain` → `encodeWavFromChannels` → Take
- `downloadTake`: `downloadRecordingAsWav` vom Server (STORE-P1-001)
- Persistenz: `writePluginSettings('read')` (inputSource)
- Events: `window.addEventListener('monk:recorder-start/stop')` → `controlBus`

**Schicht 3 — Adapter (`src/plugins/adapters/RecordPluginAdapter.ts`):**
- Manifest: `kind: 'recording'`, `capabilities: ['recording']`, `latencySamples: 0`, `tailSamples: 0`
- `onCommand start/stop`: `controlBus.emit('monk:recorder-start/stop')`
- `onCommand bounce`: `audioEngine.ensureDemoPattern()` → `{ ok: true, note: 'bounce delegated to existing offline engine' }`
- Kein `onProcess` überschrieben → Passthrough via `BaseAdapter`

**Schicht 4 — Utils:**
- `src/utils/recordingDownload.ts`: `downloadRecordingAsWav` (STORE-P1-001, Nutzeraktion, `decodeAudioData`)
- `src/utils/wavEncode.ts`: `encodeWavFromChannels`
- `src/utils/mediaDevices.ts`: `requestUserMedia`

**Schicht 5 — Engine:**
- `src/utils/audioEngine.ts`: `getTrackSampleUrl`, `getMusicSampleChannels`, `ensureDemoPattern`, `getLufsValue`, `previewSample`
- `src/audio/pluginChainBounce.ts`: `bounceThroughPluginChain` über alle Adapter in `SIGNAL_CHAIN_ORDER`

**Schicht 6 — Router (`src/core/pluginAudioRouter.ts`):**
- Zeile 73: `['record', 'ui-only', false]` → `isolation: 'ui-only'`, `mainFeeder: false`, `chainStage: recorder`

**Schicht 7 — Signal chain:**
- `src/plugins/signalChain.ts`: recorder-Stufe (`['record']`) vor Out — konsistent mit Vertrag

## 3. Technische Fehlannahmen (Strukturell)

1. **Annahme: Der Recorder greift das Master-Signal ab.** Die UI erstellt `createMediaStreamDestination()` aber verbindet den Ausgang nicht damit — der Abgriff existiert strukturell nicht.
2. **Annahme: Der Bounce rendert den aktuellen Song.** UI und Adapter widersprechen sich: UI will Kanal 1 durch die Kette rendern, Adapter rendert `ensureDemoPattern()`. Keine konsistente Bounce-Definition.
3. **Annahme: Takes sind dauerhaft.** Takes existieren nur als flüchtige Blob-URLs im React-State; kein Persistenz-Layer, kein Revoke, kein Upload.
4. **Annahme: `ui-only` im Router ist konsistent mit einem Recorder-Tap.** Der Router schließt record aus dem Audio-Graph aus, während der Vertrag einen 1in/1out-Tap vorspricht.
5. **Annahme: `bypassable: false` ist eine sinnvolle Audio-Regel.** Ein Passthrough-Recorder, der nicht zeichnet, ist transparent; die Regel schützt kein Audio-Verhalten.

## 4. Designschwächen

- **MediaRecorder-Ziel nie verbunden.** Kernfunktion (Aufnahme) strukturell defekt.
- **Zwei widersprüchliche Bounce-Pfade.** UI `bounceThroughChain` (Kanal 1 → Kette) vs. Adapter `bounce` (Demo-Muster).
- **Format-Entkopplung.** `detectRecordFormat()` erkennt, `onstop` ignoriert und hardcodiert WebM.
- **Keine Take-Persistenz.** In-Memory nur; kein Server-Upload im UI, kein Reload-Überleben, kein Revoke.
- **Dünne Fehlerbehandlung.** `console.error` als einzige Reaktion; keine UI-Fehlermeldung.
- **`controlBus`-Events ohne Rückkanal.** UI abonniert `monk:recorder-start/stop`, erhält aber keine Bestätigung/Fehler vom Adapter.
- **`eslint-disable exhaustive-deps`** (Zeile 213) als struktureller Hinweis auf instabile Hook-Abhängigkeiten.

## 5. Performance-/DSP-Risiken

- Adapter ist reiner Passthrough — kein DSP-Risiko, aber keine Verarbeitung.
- `URL.createObjectURL` ohne `revoke` → linearer Speicherverbrauch pro Take.
- MediaRecorder `start(100)` → alle 100 ms ein Blob-Event; bei langen Aufnahmen viele kleine Blobs im Array.
- `setInterval(1000)` für `recordTime` solange montiert.

## 6. Schnittstellen-Probleme

| Schnittstelle | Zustand | Problem |
|---|---|---|
| `audioContext` ↔ MediaRecorder | `createMediaStreamDestination()` nicht verbunden | Aufnahme zeichnet Stille |
| `detectRecordFormat()` ↔ `onstop` | Format erkannt, Blob hartkodiert `audio/webm` + `.webm` | Formatwahl ignoriert |
| UI-Bounce ↔ Adapter-Bounce | Kanal-1-Kette vs. `ensureDemoPattern()` | Widersprüchliche Bounce-Definition |
| Takes ↔ Persistenz | In-Memory Blob-URLs, kein Revoke | Datenverlust bei Reload, Speicherleck |
| `controlBus` ↔ UI | Events einseitig | Keine Bestätigung/Fehler-Rückmeldung |
| Vertrag ↔ Router | Recorder 1in/1out vs. `'ui-only'` | Router schließt record aus dem Graph aus |
| Vertrag ↔ Realität | `bypassable: false` | Keine Audio-Begründung für das Verbot |
| STORE-P1-001 ↔ Code | WAV-Download gefordert | WebM hartkodiert, Download nur nach Server-Upload |

## 7. Empfohlene Korrekturen

1. **Audio-Ausgang an MediaStreamDestination anbinden.** Damit MASTER_OUT-Aufnahme wirklich das Master-Signal aufzeichnet.
2. **Blob-Typ und Endung dynamisch.** Den erkannten MIME-Type verwenden; Endung (`.wav`/`.webm`) zum MIME passen.
3. **Einen konsistenten Bounce-Pfad definieren.** Entweder Adapter rendert Kanal 1 durch die Kette (wie UI beschreibt) oder UI ruft Adapter-Bounce auf; `ensureDemoPattern()` ersetzen durch echtes Material.
4. **Takes persistieren.** `URL.revokeObjectURL` nach Gebrauch; serverseitigen Upload oder persistente Speicherung (IndexedDB/Server) für Reload-Überleben.
5. **`bypassable` überdenken.** `true` setzen (passthrough ist transparent) oder Begründung liefern.
6. **MediaRecorder-Zustand prüfen.** Vor `start()` auf `recorder.state === 'recording'` prüfen; Nutzerfehler anzeigen statt nur `console.error`.
7. **Hook-Abhängigkeiten bereinigen.** `eslint-disable` entfernen, stabile Dependencies (Refs) verwenden.
8. **Router konsistent.** `record` als Recorder-Tap im Router oder Vertrag auf Nicht-Audio ändern.

**Fazit Struktur:** recordMONK hat einen sauberen Vertrag (Recorder-Tap, passthrough, Latenz 0), aber die Umsetzung bricht an drei strukturellen Punkten: der Abgriff ist nicht verkabelt, der Bounce rendert ein Demo-Muster statt des Songs, und Takes sind flüchtige In-Memory-Daten ohne Persistenz. Der Router (`'ui-only'`) widerspricht zudem dem 1in/1out-Tap-Vertrag.