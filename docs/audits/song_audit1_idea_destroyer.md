# Audit song — 1/2 Idea Destroyer (adversarial)

## Metadaten
- Plugin: songMONK (id `song`, Rolle `source`, Kanal 2, Stereo)
- Vertrag: `src/plugins/pluginContract.ts` (`intrinsicLatencyFrames: 0`, `bypassable: true`, `sendsToFx: true` / `fxSendTap: 'post'`, `syncCapable: true`, `viaChannel: true`, `producesAudio: true`)
- Geprüfte Dateien: `src/components/SongMonkTerminal.tsx`, `src/plugins/registry.ts` (`song -> SongMonkTerminal`), `src/context/SampleContext` (verwendet), Endpunkt `POST /api/song/generate` (referenziert, nicht gelesen)
- Stand: gemischter Master-Tag gm-v1.0.0 / f5538c63

## 1. Grundkonzept
songMONK ist der KI-Song-Generator (Suno-artig): Der Nutzer gibt Prompt, Stil, BPM und Dauer ein, der Client POST-t an `/api/song/generate`, erhält ein Audio-Blob, legt es als `AudioSample` (Tag `songmonk`) in `SampleContext` (= biblioMONK-Bibliothek) ab und spielt es über ein `Audio`-Element ab. Eine kleine Spur visualisiert die Taktstruktur (4/4, 4-Takt-Phrasen), eine Playlist zeigt die letzten 8 erzeugten Songs. Einstellungspersistenz über `readPluginSettings('song')` / `writePluginSettings('song')`.

## 2. Architektur-Analyse
Reines UI-Terminal ohne eigenen DSP-Code. `SongMonkTerminal` verwaltet lokalen React-State (prompt, style, bpm, duration, busy, log, playingId, progress, audioRef), ruft `fetch('/api/song/generate', …)` auf, erstellt einen `AudioSample` mit `URL.createObjectURL(blob)`, übergibt ihn an `addSample` und startet die Wiedergabe. `usePluginState('song', 'PRO')` liefert einen Lock-Status, der das Modul bei fremdem Besitzer graulegt. Persistenz schreibt bei jeder Änderung von prompt/style/bpm/duration in den pluginSettings-Speicher. Keine Trennung von UI, Netzwerk und Audio-Wiedergabe.

## 3. Technische Fehlannahmen
1. **„producesAudio: true“** — song erzeugt selbst kein Audio; es bittet einen Server-Endpunkt um einen Stream und rendert das Ergebnis als Blob-URL. Wenn `/api/song/generate` ausfällt (kein HF-Fallback implementiert, nur im Kommentar erwähnt), ist das Plugin funktionslos. Der Vertrag suggeriert eine lokale Quelle.
2. **„intrinsicLatencyFrames: 0“** — Die KI-Generierung dauert Sekunden bis Minuten (Server-seitig). Diese Latenz ist nirgends erfasst, nicht im Vertrag, nicht im UI (außer einem `busy`-Flag). Der Nutzer wartet unbestimmt auf ein Ergebnis, das der Vertrag als latenzfreie Quelle deklariert.
3. **„viaChannel: true / Kanal 2“** — song spielt das Ergebnis über ein lokales `<audio>`-Element ab (`new Audio(url)`, `audio.volume = 0.9`), nicht über den Mixer-Kanal 2 oder den Signalweg. Es gibt keine Verbindung zwischen song und dem Vertragskanal; der Song bypassiert den gesamten Mixer und die PDC.
4. **„Dauer bis 30 s“** — Code deckelt `durationSeconds` auf 30 (`Math.min(30, …)`), während die UI `DURATIONS` bis 30 s anbietet und die Vertragsdokumentation keine solche Grenze nennt. Widerspruch zwischen UI, Code und Vertrag nicht aufgelöst.
5. **„Suno-artig“** — Kein Modell, kein Prompt-Engineering, keine Style-Control außer einem freien Textfeld und 7 Presets. Qualität und Rechte der generierten Songs sind vollständig unbestimmt.

## 4. Designschwächen
- **Blob-URLs nie freigegeben**: `URL.createObjectURL(blob)` wird nie mit `URL.revokeObjectURL` gepaart. Jeder generierte Song leakt Speicher, solange der Tab lebt; die Playlist hält Referenzen auf alle Blob-URLs (`s.url`).
- **`audioRef` ist ein einzelnes Ref**: `playUrl` pausiert das vorherige Audio, überschreibt aber `audioRef.current` ohne Referenz auf das alte Objekt zu halten; bei schnellen Folgegenerierungen können alte `Audio`-Instanzen orphaned im Browser verbleiben (kein `pause()`/`removeEventListener`-Cleanup auf der alten Instanz außer bei `ended`).
- **Keine Fehler-UI**: `generate` fängt Fehler ab und schreibt sie nur ins Log (`pushLog('✗ …')`). Ein fehlgeschlagener Generierungsversuch ändert `busy` nicht sichtbar für den Nutzer außerhalb des Logs; `generationPending` Ref verhindert Doppelauslösung, wird aber nie zurückgesetzt außer im `finally`.
- **Persistenz bei jedem Tastendruck**: `useEffect` schreibt `writePluginSettings('song', …)` bei jeder Änderung von `prompt`, `style`, `bpm`, `duration` — bei jedem Tipp im Prompt-Template ein Speicher-Schreibvorgang (debounced nicht implementiert).
- **Lock ist nur optisch**: `locked` graulegt das Modul (opacity/grayscale), verhindert aber nicht `generate()` — nur `disabled={busy}` auf dem Button. Ein fremder Besitzer kann den Prompt ändern und generieren, die visuelle Sperre ist trügerisch.

## 5. Performance-/DSP-Risiken
- **Keine Audio-Decodierung / kein Decoder**: Das Blob wird direkt als `src` eines `<audio>`-Elements gespielt. Kein Format-Check, keine Sample-Rate-Konvertierung (Vertrag: 48 kHz Invariante), kein Downmix auf Stereo. Ein Server, der Mono oder 44,1 kHz liefert, bricht die 48-kHz-Invariante des Systems still.
- **Kein Gain-Staging**: `audio.volume = 0.9` ist hardcodiert, kein Bezug zum Mixer-Fader von Kanal 2 oder zur Master-Lautstärke. KI-Songs können deutlich lauter oder leiser als der Rest des Signals sein → Clipping oder Unhörbarkeit.
- **Keine Pufferung / kein Preload**: `play()` wird sofort nach `URL.createObjectURL` aufgerufen; bei langsamen Netzwerken oder großen Blobs verzögert sich der Start unbestimmt, das `timeupdate`-Event liefert erst nach Metadaten-Laden Fortschritt.
- **`Math.random()`-IDs für Samples**: `song-${Date.now()}-${Math.random()...}` ist nicht kollisionssicher über Tabs/Sessions hinweg; `SampleContext` könnte doppelte IDs akzeptieren.

## 6. Schnittstellen-Probleme
- Endpunkt `/api/song/generate` ist ein Vertrags-Loch: `pluginContract.ts` erwähnt song nicht als Netzwerk-Client, `registry.ts` weiß nichts vom Endpunkt, `types.ts` definiert kein `SongGenerationRequest`/`Response`. Die Schnittstelle zwischen Client und Server ist undokumentiert (Body: `{prompt, style, bpm, durationSeconds}`, Antwort: `blob`).
- `SampleContext` (`addSample`) ist eine globale Bibliothek; song schreibt direkt dorthin, ohne dass biblioMONK (Rolle `utility`) eingeweiht wird. Die Zuordnung „Song → biblioMONK“ (Kommentar im Code) ist nur eine Konvention, keine Schnittstelle.
- `usePluginState('song', 'PRO')` — Lock-Status und Plugin-State kommen aus einer nicht geprüften Hook-Schicht; ob der Lock den Server-Endpunkt absichert, ist nicht erkennbar.
- Keine Typisierung der generierten Samples (`parameters: { frequency: 0 }` ist ein Platzhalter, keine echten Metadaten).

## 7. Empfohlene Korrekturen
1. Vertrag korrigieren: `producesAudio: false`, `viaChannel: false` (song spielt lokal ab), `intrinsicLatencyFrames` mit typischer Server-Latenz dokumentieren oder Latenz-Feld für Netzwerk-Plugins ergänzen.
2. `URL.revokeObjectURL` bei `ended` / Unmount / Playlist-Ersatz aufrufen; `audioRef`-Cleanup auf der vorherigen Instanz sicherstellen.
3. `generate()` nur ausführen, wenn `!locked` (echter Lock-Check, nicht nur optisch).
4. Persistenz debouncen (z. B. 500 ms) statt bei jedem State-Wechsel.
5. Audio aus dem Blob über die Audio-Engine / Mixer-Kanal 2 routen statt direktes `<audio>`; Gain an den Kanal-Fader koppeln.
6. Endpunkt `/api/song/generate` in einen Typenvertrag fassen (Request/Response, Fehler-Codes, Fallback-Verhalten), Timeout und Retry für den HF-Fallback implementieren.
7. Sample-IDs kollisionssicher (UUID oder serverseitig) und Metadaten (Sample-Rate, Kanäle, Dauer) vom Server mitliefern und prüfen.
