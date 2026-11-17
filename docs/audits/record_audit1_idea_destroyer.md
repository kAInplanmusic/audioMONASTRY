# audioMONASTRY — Phase C Audit 1 (Idea Destroyer): recordMONK

**Plugin:** `record` / `recordMONK`, Rolle `recorder` (Abgriff, verändert das Signal nicht)
**Stand:** Commit f5538c63
**Art:** adversarial — die Idee einer verlässlichen Aufnahme/Wiedergabe wird an jeder Stelle angegriffen.

---

## 1. Grundkonzept (wie behauptet)

`pluginContract.ts` (Zeile 396–412): `record` ist Recorder, 1×1 Stereo, Latenz 0, `bypassable: false` ("ein Recorder, der aus ist, nimmt nicht auf – er verändert nichts"), `sendsToFx: false`, `producesAudio: false`, `insertScope: null`. Aufgabe: reiner Abgriff + Durchleitung, Aufnahme, Bounce durch die Kette, WAV-Export.

UI: `src/components/RecorderTerminal.tsx` — MediaRecorder, Eingabequelle (MASTER_OUT/Mikrofon), Takes, Wellenform, Bounce durch die 16-Plugins-Kette, WAV-Download (STORE-P1-001).

Adapter: `src/plugins/adapters/RecordPluginAdapter.ts` — Commands start/stop/bounce via `controlBus`; bounce delegiert an `audioEngine.ensureDemoPattern()`.

## 2. Architektur-Analyse (Ist-Zustand)

- Vertrag: `src/plugins/pluginContract.ts` — Recorder, passthrough + Tap.
- UI: `src/components/RecorderTerminal.tsx` (MediaRecorder, takes, bounce, format detection).
- Adapter: `src/plugins/adapters/RecordPluginAdapter.ts` (start/stop/bounce Commands).
- Utils: `src/utils/recordingDownload.ts` (STORE-P1-001), `src/utils/wavEncode.ts`, `src/audio/pluginChainBounce.ts` (Bounce durch 16 Adapter).
- Engine: `audioEngine.getTrackSampleUrl`, `getMusicSampleChannels`, `bounceThroughPluginChain`, `ensureDemoPattern`.
- Router: `src/core/pluginAudioRouter.ts` Zeile 73 — `['record', 'ui-only', false]`, `chainStage: recorder`.
- Signal chain: recorder-Stufe vor Out — konsistent mit Vertrag.
- ControlBus: `src/core/events/ControlBus.ts` (`monk:recorder-start/stop`).

## 3. Technische Fehlannahmen

1. **Fehlannahme: Die Aufnahme zeichnet das Master-Signal auf.** Falsch. `RecorderTerminal.tsx` Zeile 159 erstellt `audioContext.createMediaStreamDestination()`, verbindet den Audio-Ausgang aber **niemals** mit diesem Ziel (kein `connect`). `dest.stream` wird an den MediaRecorder übergeben, aber es fließt kein Audio hinein. Jede "Aufnahme" über MASTER_OUT ist digitales Schweigen.

2. **Fehlannahme: Das gewählte Format wird eingehalten.** `detectRecordFormat()` prüft, ob `audio/wav` unterstützt wird. Aber `recorder.onstop` (Zeile 179) baut den Blob mit festem Typ `'audio/webm'`, unabhängig vom gewählten MIME. Die Dateiendung ist fest `'.webm'` (Zeile 186), auch wenn der Nutzer WAV erwartet. STORE-P1-001 (verlustfreier WAV-Download) ist damit für Browser ohne WAV-MediaRecorder nicht erreichbar — und für solche mit WAV-Unterstützung wird dennoch WebM geschrieben.

3. **Fehlannahme: Der Bounce rendert Nutzer-Material.** `RecordPluginAdapter.onCommand 'bounce'` (Zeile 36) ruft `audioEngine.ensureDemoPattern()` auf — ein **Demo-Muster**, nicht den aktuellen Song auf Kanal 1. Die UI `bounceThroughChain` liest zwar Kanal 1 (`getTrackSampleUrl('channel1')`), delegiert den eigentlichen Render aber an den Adapter, der das Demo-Muster rendert. Die Bounce-Idee ("Kette hörbar vor dem Live-Umzug") liefert nie das echte Material.

4. **Fehlannahme: Takes sind persistent.** Takes leben als `URL.createObjectURL`-Blob-URLs im Speicher (Zeile 180), werden nie mit `URL.revokeObjectURL` freigegeben → Speicherleck bei vielen Takes. Nach einem Reload sind alle Takes weg; es gibt keinen automatischen Server-Upload im UI-Pfad.

5. **Fehlannahme: `bypassable: false` schützt etwas.** Der Vertrag verbietet das Umgehen des Recorders, weil ein "auser" Recorder nicht aufnimmt. Aber ein Recorder, der nicht zeichnet, ist ohnehin transparent (passthrough). Die Regel schützt keine Audio-Eigenschaft, verbietet aber das legitime Stilllegen und kompliziert die Zustandmaschine unnötig.

6. **Fehlannahme: MediaRecorder-Start ist sicher.** `recorder.start(100)` ohne Zustandsprüfung. Wiederholter Start während einer laufenden Aufnahme wirft `InvalidStateError` — nur im äußeren `try/catch` geloggt, keine Nutzerinformation, kein Abbruch der laufenden Aufnahme.

7. **Fehlannahme: Der Hook ist sauber.** Zeile 213: `eslint-disable-next-line react-hooks/exhaustive-deps -- bewusst beibehalten`. `startRecording` hängt von `takes.length`, `recordTime`, `addSample` ab — Stale-Closure-Risiko bei schnellen Start/Stop-Folgen.

## 4. Designschwächen

- **MediaRecorder-Ziel nie verbunden.** Die zentrale Aufnahmefunktion zeichnet Stille.
- **Format/Endung hardcodiert.** Ignoriert die Format-Erkennung und die Nutzerwahl.
- **Bounce rendert Demo, nicht Song.** `ensureDemoPattern()` statt Kanal-1-Material.
- **Takes flüchtig + Speicherleck.** Blob-URLs nicht revoked, kein Server-Persistenz-Pfad im UI.
- **`bypassable: false` ohne Audio-Begründung.** Starrer Vertrag ohne funktionalen Nutzen.
- **Fehlerbehandlung dünn.** `console.error` als einzige Reaktion auf Aufnahmefehler; keine UI-Fehlermeldung.
- **Doppelter Bounce-Pfad.** UI `bounceThroughChain` (Kanal 1 → Plugin-Kette) vs. Adapter `bounce` (Demo-Muster) — widersprüchlich.

## 5. Performance-/DSP-Risiken

- Der Adapter ist reiner Passthrough (`BaseAdapter.state === 'OFF'` → Durchlass; `onProcess` nicht überschrieben) — kein DSP-Risiko, aber auch kein Signalverarbeitung.
- `URL.createObjectURL` ohne `revoke` bei jedem Take → linear wachsender Speicherverbrauch bei langwierigen Sessions.
- `setInterval(1000 ms)` für `recordTime` läuft, solange die Komponente montiert ist — geringer, aber unnötiger Overhead.
- MediaRecorder mit `start(100)` erzeugt alle 100 ms ein `ondataavailable`-Event — bei sehr langen Aufnahmen viele kleine Blobs im Array (Speicherfragmentierung).

## 6. Schnittstellen-Probleme

| Schnittstelle | Problem |
|---|---|
| `audioContext` ↔ MediaRecorder | `createMediaStreamDestination()` nie verbunden → Aufnahme zeichnet Stille |
| `detectRecordFormat()` ↔ Blob-Erstellung | Format wird erkannt, aber Blob hartkodiert auf `audio/webm` + Endung `.webm` |
| UI-Bounce ↔ Adapter-Bounce | UI rendert Kanal 1 durch Kette; Adapter rendert Demo-Muster → widersprüchliche Ergebnisse |
| Takes ↔ Persistenz | Takes nur als In-Memory-Blob-URLs; kein Upload, kein Reload-Überleben, kein Revoke |
| `controlBus` ↔ UI | `monk:recorder-start/stop` Events werden abonniert, aber keine Rückmeldung bei Fehler |
| Vertrag ↔ Realität | `bypassable: false` schützt keine Audio-Eigenschaft |
| STORE-P1-001 ↔ Implementierung | Verlustfreier WAV-Download gefordert; Implementierung schreibt WebM und ignoriert Formatwahl |

## 7. Empfohlene Korrekturen

1. **Audio-Ausgang an MediaStreamDestination anbinden.** `dest` muss den kontextweiten Ausgang abnehmen (z. B. über einen Gain-Knoten oder `audioContext.destination` → `dest`), sonst bleibt die Aufnahme stumm.
2. **Blob-Typ und Endung an das erkannte Format anpassen.** `recorder.onstop` muss den zuvor ermittelten MIME-Type verwenden; die Dateiendung (`.wav`/`.webm`) muss zum MIME passen.
3. **Bounce auf Kanal-1-Material umstellen.** `RecordPluginAdapter.bounce` soll das aktuelle Kanal-1-Signal durch die Kette rendern (wie `bounceThroughChain` in der UI beschreibt), nicht `ensureDemoPattern()`.
4. **Takes persistieren.** Blob-URLs nach Download mit `URL.revokeObjectURL` freigeben; serverseitigen Upload oder persistente Speicherung anbieten; Takes über Reload hinweg sichern (IndexedDB oder Server).
5. **`bypassable` überdenken.** Entweder `true` setzen (passthrough ist ohnehin transparent) oder die Regel mit einer tatsächlichen Audio-Auswirkung begründen.
6. **MediaRecorder-Zustand prüfen.** Vor `start()` prüfen, ob bereits aufgenommen wird (`recorder.state === 'recording'`), um `InvalidStateError` zu vermeiden; Nutzer bei Fehlern informieren.
7. **Hook-Abhängigkeiten bereinigen.** `eslint-disable` entfernen und `startRecording` auf stabile Dependencies umstellen (Refs statt `takes.length`/`recordTime`).
8. **Fehlerbehandlung im UI.** Aufnahmefehler (Mediengeräte, Codec, Quota) müssen dem Nutzer angezeigt werden, nicht nur in die Konsole geloggt.

**Fazit Idea Destroyer:** recordMONK nimmt auf MASTER_OUT stumm auf (Ziel nie verbunden), schreibt trotz Format-Erkennung hartkodiert WebM, rendert im Bounce ein Demo-Muster statt des Songs, und verliert alle Takes beim Reload. Die Idee eines verlässlichen Recorders mit WAV-Export ist aktuell nicht realisiert.