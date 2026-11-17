# Audit song — 2/2 Struktur-Audit (Architektur, Schnittstellen, Abhängigkeiten)

## Metadaten
- Plugin: songMONK (id `song`, Rolle `source`, Kanal 2, Stereo, 0 In / 1 Out)
- Vertrag: `src/plugins/pluginContract.ts`; Registry: `src/plugins/registry.ts` (`song -> SongMonkTerminal`); Signalkette: `src/plugins/signalChain.ts` (Stufe `sources`, nach `drop`, vor `drumsampler`)
- Geprüfte Dateien: `src/components/SongMonkTerminal.tsx`, `src/context/SampleContext` (verwendet, nicht gelesen), Endpunkt `POST /api/song/generate` (referenziert, nicht Teil des Repos)
- Stand: gemischter Master-Tag gm-v1.0.0 / f5538c63

## 1. Grundkonzept
songMONK ist der KI-Song-Generator (Suno-artig): Der Nutzer gibt Prompt, Stil, BPM und Dauer ein, der Client POST-t an `/api/song/generate`, erhält ein Audio-Blob, legt es als `AudioSample` (Tag `songmonk`) in `SampleContext` (= biblioMONK-Bibliothek) ab und spielt es über ein `<audio>`-Element ab. Eine kleine Spur visualisiert die Taktstruktur (4/4, 4-Takt-Phrasen), eine Playlist zeigt die letzten 8 erzeugten Songs. Einstellungen persistieren über `readPluginSettings('song')` / `writePluginSettings('song')`.

## 2. Architektur-Analyse
**Komponenten-Hierarchie**: `SongMonkTerminal` (`React.memo`) ist eine flache Komponente ohne Kind-Komponenten außer UI-Basisteilen (`AmCard`, `AmKnob`). Alles (State, Netzwerk, Audio, Rendering) lebt in einer einzigen Datei (209 Zeilen).

**State-Management**: Lokaler React-State (`prompt`, `style`, `bpm`, `duration`, `busy`, `generationPending` Ref, `log`, `playingId`, `progress`, `audioRef`). Persistenz über `useState(() => mergeKnown(..., readPluginSettings('song')))` beim Mount und ein `useEffect`, der bei jeder Änderung von `prompt`, `style`, `bpm`, `duration` `writePluginSettings('song', …)` aufruft.

**Datenfluss**: UI-Eingabe → `generate()` → `fetch('/api/song/generate', {method:'POST', body:{prompt, style, bpm, durationSeconds}})` → `resp.blob()` → `URL.createObjectURL(blob)` → `AudioSample` → `addSample(sample)` (SampleContext) → `playUrl(sample.id, url)` (`new Audio(url)`, `audio.volume = 0.9`). Ein `window`-Event `monk:song-generate` erlaubt externes Auslösen (bei `isPluginSettingsHolder('song')`).

**Externe Abhängigkeiten**: `/api/song/generate` (Server-Endpunkt, nicht im Repo, nicht typisiert, kein Timeout, kein Retry, „HF-Fallback“ nur im Kommentar erwähnt), `SampleContext` (globale Bibliothek, keine Typen in dieser Datei), `usePluginState('song', 'PRO')` (Lock-Status, Quelle unbekannt), `webRTCManager.userId` (Lock-Vergleich).

**Vertragsbindung**: `pluginContract.ts` deklariert `song` als Quelle (Kanal 2, Stereo, bypassable, sendsToFx post, syncCapable, producesAudio, latency 0). `signalChain.ts` ordnet `song` der Stufe `sources` zu. `registry.ts` mappt `song -> SongMonkTerminal`. Keine dieser Dateien erwähnt den Netzwerk-Endpunkt oder die Audio-Wiedergabe über `<audio>`.

## 3. Technische Fehlannahmen
1. **`producesAudio: true` vs. Implementierung**: song erzeugt selbst kein Audio; es bittet einen Server-Endpunkt um einen Stream und rendert das Ergebnis als Blob-URL. Wenn `/api/song/generate` ausfällt, ist das Plugin funktionslos (kein lokaler Fallback im Code).
2. **`intrinsicLatencyFrames: 0` vs. Server-Latenz**: Die KI-Generierung dauert Sekunden bis Minuten. Diese Latenz ist nirgends erfasst (Vertrag, UI, Code). Der Nutzer wartet unbestimmt; der Vertrag deklariert eine latenzfreie Quelle.
3. **`viaChannel: true / Kanal 2` vs. lokales `<audio>`**: song spielt über ein lokales `Audio`-Element ab, nicht über Mixer-Kanal 2 oder den Signalweg. Es gibt keine Verbindung zwischen song und dem Vertragskanal; der Song bypassiert Mixer und PDC vollständig.
4. **`durationSeconds` auf 30 s gedeckelt**: Code (`Math.min(30, …)`) und UI (`DURATIONS` bis 30) decken sich, der Vertrag nennt keine Grenze; ob der Server länger als 30 s verarbeitet, ist unklar.
5. **Suno-artig ohne Modell-Contract**: Kein Modell, kein Prompt-Engineering, keine Style-Control außer freiem Text und 7 Presets. Qualität und Rechte der generierten Songs sind vollständig unbestimmt.

## 4. Designschwächen
- **Blob-URLs nie freigegeben**: `URL.createObjectURL(blob)` wird nie mit `URL.revokeObjectURL` gepaart. Jeder generierte Song leakt Speicher, solange der Tab lebt; die Playlist hält Referenzen auf alle Blob-URLs (`s.url`).
- **Ein einzelnes `audioRef`**: `playUrl` pausiert das vorherige Audio, überschreibt aber `audioRef.current`, ohne auf der alten Instanz `pause()`/`removeEventListener` aufzurufen (außer beim `ended`-Event der neuen Instanz). Alte `Audio`-Instanzen können orphaned im Browser verbleiben.
- **Keine Fehler-UI**: Fehler landen nur im Log (`pushLog('✗ …')`); `busy` wird im `finally` zurückgesetzt, aber der Nutzer erhält außerhalb des Logs kein sichtbares Feedback. `generationPending` Ref verhindert Doppelauslösung, wird aber nie außerhalb von `generate` zurückgesetzt.
- **Persistenz bei jedem Tastendruck**: `useEffect` schreibt bei jeder Änderung von `prompt`, `style`, `bpm`, `duration` in den pluginSettings-Speicher — kein Debounce.
- **Lock ist nur optisch**: `locked` graulegt das Modul (opacity/grayscale), `generate()` wird aber nicht durch den Lock blockiert (nur `disabled={busy}` auf dem Button). Ein fremder Besitzer kann den Prompt ändern und generieren.

## 5. Performance-/DSP-Risiken
- **Keine Audio-Decodierung / kein Decoder**: Das Blob wird direkt als `src` eines `<audio>`-Elements gespielt. Kein Format-Check, keine Sample-Rate-Konvertierung (Vertrag: 48-kHz-Invariante), kein Downmix auf Stereo. Ein Server, der Mono oder 44,1 kHz liefert, bricht die 48-kHz-Invariante still.
- **Kein Gain-Staging**: `audio.volume = 0.9` ist hardcodiert, kein Bezug zum Mixer-Fader von Kanal 2 oder zur Master-Lautstärke. KI-Songs können deutlich lauter oder leiser sein als der Rest des Signals → Clipping oder Unhörbarkeit.
- **Keine Pufferung / kein Preload**: `play()` wird sofort nach `URL.createObjectURL` aufgerufen; bei langsamen Netzwerken oder großen Blobs verzögert sich der Start unbestimmt; `timeupdate` liefert erst nach Metadaten-Laden Fortschritt.
- **`Math.random()`-IDs für Samples**: `song-${Date.now()}-${Math.random()...}` ist nicht kollisionssicher über Tabs/Sessions hinweg; `SampleContext` könnte doppelte IDs akzeptieren.

## 6. Schnittstellen- und Abhängigkeits-Probleme
- Endpunkt `/api/song/generate` ist ein Vertrags-Loch: `pluginContract.ts` erwähnt song nicht als Netzwerk-Client, `registry.ts` weiß nichts vom Endpunkt, `types.ts` definiert kein `SongGenerationRequest`/`Response`. Die Schnittstelle zwischen Client und Server ist undokumentiert (Body: `{prompt, style, bpm, durationSeconds}`, Antwort: `blob`).
- `SampleContext` (`addSample`) ist eine globale Bibliothek; song schreibt direkt dorthin, ohne dass biblioMONK (Rolle `utility`) eingeweiht wird. Die Zuordnung „Song → biblioMONK“ ist nur eine Code-Kommentar-Konvention, keine Schnittstelle.
- `usePluginState('song', 'PRO')` — Lock-Status und Plugin-State kommen aus einer nicht geprüften Hook-Schicht; ob der Lock den Server-Endpunkt absichert, ist nicht erkennbar.
- Keine Typisierung der generierten Samples (`parameters: { frequency: 0 }` ist ein Platzhalter, keine echten Metadaten wie Sample-Rate, Kanäle, Dauer).

## 7. Empfohlene Korrekturen
1. Vertrag korrigieren: `producesAudio: false`, `viaChannel: false` (song spielt lokal ab), `intrinsicLatencyFrames` mit typischer Server-Latenz dokumentieren oder ein Latenz-Feld für Netzwerk-Plugins ergänzen.
2. `URL.revokeObjectURL` bei `ended` / Unmount / Playlist-Ersatz aufrufen; `audioRef`-Cleanup auf der vorherigen Instanz sicherstellen.
3. `generate()` nur ausführen, wenn `!locked` (echter Lock-Check, nicht nur optisch).
4. Persistenz debouncen (z. B. 500 ms) statt bei jedem State-Wechsel.
5. Audio aus dem Blob über die Audio-Engine / Mixer-Kanal 2 routen statt direktes `<audio>`; Gain an den Kanal-Fader koppeln.
6. Endpunkt `/api/song/generate` in einen Typenvertrag fassen (Request/Response, Fehler-Codes, Fallback-Verhalten), Timeout und Retry für den HF-Fallback implementieren.
7. Sample-IDs kollisionssicher (UUID oder serverseitig) und Metadaten (Sample-Rate, Kanäle, Dauer) vom Server mitliefern und prüfen.
