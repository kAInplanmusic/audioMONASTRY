# audit1_idea_destroyer — biblioMONK (Plugin `biblio`, Utility, kein Kanal)

**Status:** abgeschlossen (adversarial / Idea Destroyer)  
**Basis:** `src/components/LibraryTerminal.tsx` (476 Zeilen), `src/plugins/adapters/BiblioPluginAdapter.ts` (47 Zeilen), `src/plugins/pluginContract.ts` (Vertrag `biblio`, role `utility`, channel null, inputs 0, outputs 0, `producesAudio: false`)  
**Artefakte geprüft:** Hauptrepo + Worktree `audioMONASTRY-biblio` (byte-identisch)

---

## 1. Grundkonzept

biblioMONK ist die zentrale Mediathek: Samples, Musik-Tracks, Ordner (Favoriten, Bass/Mids/Highs, Musik), Suche, Semantische Sample-Suche, Vorschau mit Hüllkurven-Zeichnung, Cloud-Sync/Push zu Supabase (anon-key), QuickImport/USB-Import, Favoriten-Persistenz im Browser und automatische offline BPM/Key-Analyse. Vertraglich ist es ein `utility`-Plugin ohne eigenen Kanal, ohne Ein/Ausgänge und ohne Audio-Erzeugung — es "lädt nur in andere Plugins".

---

## 2. Architektur-Analyse

### Komponenten-Zusammenhang
```
Registry (registry.ts)
  └─ COMPONENT_MAP.biblio -> LibraryTerminal (lazy import)
  └─ Adapter: BiblioPluginAdapter (MANIFEST id 'biblio', kind 'library')
        └─ BasePluginAdapter
        └─ fetch('/api/cloud/sync')                        [direkter HTTP-Aufruf]
        └─ ControlBus (core/events/ControlBus)             ['monk:library-search', 'monk:library-load']
UI: LibraryTerminal (React.memo, 476 Zeilen)
   ├─ useSamples (SampleContext)                          [Samples, addSample, cloudEnabled, pushSampleToCloud, syncCloudDatabase]
   ├─ ../data/musicLibrary (SORTED_MUSIC_LIBRARY)
   ├─ ../lib/supabaseClient (fetchCloudMusic, pushMusicToCloud)
   ├─ ../utils/audioAnalyzer (analyzeMusic)
   ├─ ../utils/libraryFavorites (loadFavorites/saveFavorites)
   ├─ ./SemanticSampleSearch, ./Scratchpad, ./CloudStatusBadge, ./SampleUploadPanel, ./QuickImportPanel
   └─ audioEngine (preview/loadTrackSample auf channel1/channel5)
```

### Datenfluss
- Suche: `window`-Event `monk:library-search` (Adapter emits via ControlBus, Terminal lauscht auf window-Event) → Filterung lokaler Samples/Musik.
- Cloud: `handleCloudSync` → `syncCloudDatabase()` (Supabase); `handlePushSample`/`handlePushMusic` → einzelne Einträge pushen.
- Analyse: `analyzeMusic(t.url)` pro sichtbarer Musik-Track, Ergebnis-Cache per URL in `useRef<Map>`.
- Vorschau/Laden: `audioEngine.loadTrackSample('channel1', …)` bzw. `'channel5'` — hardkodierte Kanäle.

---

## 3. Technische Fehlannahmen

### Fehlannahme A: "biblio erzeugt keinen Ton und hat keine Audio-Auswirkung"
Vertrag: `producesAudio: false`, `outputs: 0`. Wirklichkeit: `audioEngine.loadTrackSample('channel1', previewMusic.url)` (Zeile 425) und `'channel5'` (Zeile 447) laden Samples **direkt in Mixer-Kanäle**. Biblio greift damit in den Audio-Graph ein, obwohl es vertraglich kein Audio hat und keinen Kanal besitzt. Das ist ein vertraglicher Widerspruch: Ein utility ohne Kanal darf nicht direkt in Kanal 1/5 schreiben.

### Fehlannahme B: "ControlBus und window-Events sind dasselbe"
Der Adapter emits `monk:library-search` über `controlBus.emit`; das Terminal lauscht aber auf `window.addEventListener('monk:library-search', …)`. ControlBus und window-Event sind zwei getrennte Kanäle — es gibt keine Gewähr, dass der Adapter-Event im Terminal ankommt, es sei denn, ControlBus leitet an window weiter (nicht ersichtlich im gelesenen Code). Das ist eine zerbrochene Schnittstelle.

### Fehlannahme C: "Cloud-Sync ist authentifiziert und sicher"
`fetch('/api/cloud/sync', { body: '{}', … })` — harter POST ohne Body, ohne Token, ohne Absender-Identifikation. Der Supabase-Zugriff nutzt den anon-key (`CLOUD READ` Badge). Es gibt keine ersichtliche RLS- oder Rechteprüfung; jeder Nutzer kann alle eingebauten Presets in die externe DB syncen und Samples/Tracks pushen. Datenleer- und Missbrauchsrisiko.

### Fehlannahme D: "Die BPM/Key-Analyse ist sicher cached"
`analysisCache` speichert per URL, aber der `cancelled`-Flag wird nur in `apply` geprüft, nicht vor dem Setzen des Cache-Eintrags. Nach Unmount/Filter-Wechsel laufen Analysen weiter und schreiben in den Cache/State (`setAnalysis` nach `cancelled = true` wird durch `if (cancelled || !a) return` abgefangen — gut), aber Race-Conditions bei schnellen Filter-Wechseln sind möglich (überschreibende `setAnalysis`-Aufrufe aus alten Promises).

### Fehlannahme E: "Sample-Drop/Zugang ist durch den Lock geschützt"
`lockStatus` wird in LibraryTerminal **nirgendwo abgefragt** (kein `usePluginState('biblio', …)` für Lock). Cloud-Push, Sample-ADD in Kanal 1/5 und Import funktionieren auch, wenn ein anderer Nutzer das Plugin über webRTC gesperrt hat. Der Lock existiert auf dem Papier, nicht in der UI.

---

## 4. Designschwächen

- **Gottes-Komponente LibraryTerminal (476 Zeilen):** Mischt UI, Cloud-Sync, Analyse-Cache, Favoriten-Persistenz, Pagination, Vorschau, Import-Panels. Keine Trennung von UI und Domain-Logik.
- **Logik-Duplikation Adapter ↔ Terminal:** `BiblioPluginAdapter` implementiert `sync`/`search`/`load`; das Terminal dupliziert Cloud-Logik (`handleCloudSync`, `handlePushSample`, `handlePushMusic`, `refreshCloudMusic`). Zwei Stellen, an denen sich Cloud-Verhalten ändern müsste.
- **Zwei Such-Kanäle:** ControlBus.emit (Adapter) vs. window-Event (Terminal) — unklar, welcher autoritativ ist.
- **Hardcodierte Kanäle:** `channel1` und `channel5` für `loadTrackSample` — ignoriert, dass biblio keinen Kanal haben darf.
- **Kein Error-Boundary für Cloud-Aufrufe:** `fetchCloudMusic` Fehler führen zu frühem `return` ohne Nutzer-Feedback außer `cloudStatus`-Text; `pushSampleToCloud` Fehler werden nur als Status-String angezeigt.
- **`navigator.clipboard.writeText` ohne Fehlerbehandlung** (Zeile 206 `handleCopy`) — kann ablehnen (z. B. nicht-sicheres Kontext, kein Nutzer-Gesture), ungedeckt.

---

## 5. Performance-/DSP-Risiken

| Risiko | Auswirkung |
|--------|------------|
| `analyzeMusic` auf jedem `musicTracks`-Update für alle sichtbaren Tracks | Bei 48+ Tracks und häufigem Filter-Wechsel: parallele Analysen, CPU-Last, redundante Fetchs/Analysen |
| Kein `URL.revokeObjectURL` (biblio selbst nicht, aber soundMONK erzeugt blob-URLs die hier vorgespielt werden können) | Speicherlecks bei Vorschau-Audio |
| Große JSON-Kopie via `navigator.clipboard.writeText(JSON.stringify(sample, null, 2))` | Bei umfangreichen Samples blockiert der Hauptthread kurz |
| Cloud-Sync pusht alle eingebauten Presets auf einen Klick | Unkontrollierter Datenvolumen-Upload, keine Drosselung, kein Fortschritt pro Eintrag |
| Lokale Favoriten in LocalStorage bei jeder Änderung (`saveFavorites` im `useEffect` von `favorites`) | Schreib-Last bei jedem Klick auf Favorit |

---

## 6. Schnittstellen-Probleme

- **ControlBus ↔ window-Event-Bruch:** Adapter nutzt `controlBus.emit`, Terminal nutzt `window.addEventListener` — kein gemeinsamer Vertrag, Gefahr, dass Such-Events im Nirgendwo landen.
- **`syncCloudDatabase` / `pushSampleToCloud` / `pushMusicToCloud`:** Signaturen aus `supabaseClient` nicht im Adapter widerspiegelt; Adapter `sync` ruft einen hardcodierten Endpunkt `/api/cloud/sync` auf, das Terminal nutzt andere Funktionen — zwei parallele Cloud-APIs ohne Absprache.
- **Hardcodierte Kanäle `channel1`/`channel5`:** Verletzt den Vertrag (biblio hat keinen Kanal) und koppelt biblio fest an die Mixer-Kanalbelegung.
- **`AudioSample`-Typ wird als clipboard-JSON serialisiert:** Kein stabiler Vertrag, welche Felder enthalten sind; Konsumenten (andere Plugins) können nicht darauf vertrauen.
- **Keine Abbruch-Möglichkeit für laufende Cloud-Pushes:** `cloudBusy` deaktiviert Buttons, aber ein laufender `fetch` kann nicht abgebrochen werden (kein AbortController).

---

## 7. Empfohlene Korrekturen

1. **Vertrag einhalten:** Biblio darf nicht direkt in Mixer-Kanäle laden (`audioEngine.loadTrackSample('channel1|5')` entfernen oder über ein source-Plugin routen). Entweder Vertrag auf `role: channel` mit Kanal ändern oder Kanal-Zugriffe entfernen.
2. **EinSuch-Kanal festlegen:** Entweder ControlBus oder window-Event, nicht beides. Adapter und Terminal auf denselben Bus einigen.
3. **Lock in die UI integrieren:** `usePluginState('biblio', 'PRO')` und `lockStatus` bei Cloud-Push, Import und ADD prüfen.
4. **Cloud-API konsolidieren:** Einen Cloud-Service (nicht hardcodierter Endpunkt im Adapter + separate Funktionen im Terminal) mit Auth/Token und AbortController; RLS-Rechte auf Serverseite prüfen.
5. **Analyse-Cache race-safe machen:** `cancelled` vor jedem State/Cache-Schreib prüfen, Analyse pro URL deduplizieren, laufende Analysen bei Filter-Wechsel abbrechen.
6. **LibraryTerminal aufteilen:** In `LibraryList`, `LibraryPreview`, `CloudPanel`, `AnalysisService`, `FavoritesService` — SRP einhalten.
7. `handleCopy` und alle `fetch`-Aufrufe mit try/catch und Nutzer-Feedback versehen.
8. Pagination auch für Favoriten und Musik konsistent anbieten (aktuell nur bedingt).
