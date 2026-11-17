# audit2_structure — biblioMONK (Plugin `biblio`, Utility, kein Kanal)

**Status:** abgeschlossen (Struktur-Audit)  
**Basis:** `src/components/LibraryTerminal.tsx`, `src/plugins/adapters/BiblioPluginAdapter.ts`, `src/plugins/pluginContract.ts`, `src/context/SampleContext.ts`, `src/lib/supabaseClient.ts`, `src/utils/libraryFavorites.ts`, `src/utils/audioAnalyzer.ts`  
**Artefakte geprüft:** Hauptrepo + Worktree `audioMONASTRY-biblio` (byte-identisch)

---

## 1. Grundkonzept

biblioMONK ist das library/utility-Plug-in ohne Audio-Kanal: lokale + Cloud-Mediathek (Samples + Musik), Suche, semantische Suche, Vorschau, Import, Favoriten, Cloud-Sync/Push zu Supabase, offline BPM/Key-Analyse. Es versorgt andere Plugins mit Samples/Tracks, erzeugt selbst keinen Ton.

---

## 2. Architektur-Analyse

### Komponenten-Zusammenhang
```
Registry (registry.ts)
  └─ COMPONENT_MAP.biblio -> LibraryTerminal (lazy, React.memo)
  └─ BiblioPluginAdapter extends BasePluginAdapter
        MANIFEST: id 'biblio', kind 'library', caps ['library','analysis']
        onCommand: sync -> fetch('/api/cloud/sync')
                   search -> controlBus.emit('monk:library-search')
                   load  -> controlBus.emit('monk:library-load')
UI LibraryTerminal:
  ├─ SampleContext (samples, addSample, cloudEnabled, pushSampleToCloud, syncCloudDatabase, pendingSample)
  ├─ data/musicLibrary (SORTED_MUSIC_LIBRARY)
  ├─ lib/supabaseClient (fetchCloudMusic, pushMusicToCloud, CloudMusicRow)
  ├─ utils/audioAnalyzer (analyzeMusic)
  ├─ utils/libraryFavorites (load/save/toggle, localStorage)
  ├─ UI-Panels: SemanticSampleSearch, Scratchpad, CloudStatusBadge, SampleUploadPanel, QuickImportPanel
  └─ audioEngine (preview/loadTrackSample)
```

### Datenfluss & State
- `samples` aus SampleContext (global), gefiltert nach Folder/Query (useMemo).
- `musicTracks` = lokale SORTED_MUSIC_LIBRARY, beim Mount ergänzt durch `fetchCloudMusic()` (Supabase), re-fetch bei `monk:library-changed`.
- Favoriten: localStorage, geschrieben bei jeder Änderung (`useEffect` auf `favorites`).
- Analyse: `analysis` State + `analysisCache` Ref, pro sichtbarer Musik-Track triggered.
- Pagination: 9 Items/Page für Samples und Musik separat.

---

## 3. Technische Fehlannahmen (Strukturell)

- **Annahme: Der Adapter ist die alleinige Command/Schnittstelle-Schicht.** Wirklichkeit: Das Terminal implementiert fast dieselben Cloud-Operationen selbst (`handleCloudSync`, `handlePushSample`, `handlePushMusic`, `refreshCloudMusic`). Der Adapter deckt nur `sync`/`search`/`load` ab. Geteilte, nicht abgestimmte Zuständigkeit.
- **Annahme: `useMemo`-Filterung ist performant genug.** Wirklichkeit: `filteredSamples`/`filteredMusic` werden neu berechnet bei jeder `samples`/`favorites`/`query`-Änderung; bei großen Bibliotheken und jedem Tastendruck in der Suche neu gefiltert — kein Debounce der Suche.
- **Annahme: Cloud-Musik ergänzt die lokale Bibliothek idempotent.** Wirklichkeit: `refreshCloudMusic` merged über eine Map mit `t.id` als Key — Cloud-Einträge überschreiben lokale Einträge mit gleicher ID stillschweigend (kein Konflikt-Handling, keine Kennzeichnung der Herkunft).
- **Annahme: `analysisCache` verhindert doppelte Analysen.** Wirklichkeit: Der Cache wird per URL gesetzt, aber der Key ist die `url`; derselbe Track unter unterschiedlicher URL wird neu analysiert; Cache wächst unbegrenzt (keine Eviction, kein Größenlimit).

---

## 4. Designschwächen

- **SRP-Verletzung:** LibraryTerminal (476 Zeilen) übernimmt UI-Rendering, Cloud-Orchestration, Analyse-Steuerung, Favoriten-Persistenz, Pagination und Vorschau-Logik.
- **Importe nicht lazy:** Alle 18+ Imports (supabaseClient, audioAnalyzer, Panels, etc.) sind statisch; das Library-Chunk wird vollständig geladen, auch wenn nur die Liste angezeigt wird.
- **Zustandsfragmentierung:** `cloudStatus`, `cloudBusy`, `analysis`, `analysisCache`, `favorites`, `musicTracks`, `samples` — verteilt über lokalen State, Context, Ref und localStorage ohne zentralen Store für biblio.
- **Hardcodierte Cloud-Endpunkte:** Adapter nutzt `/api/cloud/sync` hardcodiert; Terminal nutzt `supabaseClient`-Funktionen. Zwei Cloud-APIs, keine zentrale Konfiguration.
- **Kein Test-Hooks:** Keine Interface-Abstraktion für `fetchCloudMusic`/`analyzeMusic` — nicht mockbar für Unit-Tests.

---

## 5. Performance-/DSP-Risiken

- **Kein Debounce der Suche:** Jeder Tastendruck setzt `query` und `setCurrentPage(1)`, löst `useMemo`-Neufilterung und ggf. `refreshCloudMusic`-Reaktionen aus.
- **Analyse bei jedem visible Track:** `useEffect` über `paginatedMusic` analysiert alle sichtbaren Tracks bei jedem Seiten-Wechsel; bei großen Cloud-Bibliotheken hohe CPU-/Netzlast.
- **LocalStorage-Schreib bei jedem Favoriten-Klick:** `saveFavorites(favorites)` im `useEffect` ohne Debounce.
- **Cloud-Sync pusht alle Presets auf einmal:** Keine Drosselung, kein Fortschritt pro Eintrag, kein Abbruch.
- **Kein `URL.revokeObjectURL` für Vorschau-Audio:** Falls blob-URLs in Samples landen, Speicherleck.

---

## 6. Schnittstellen-Probleme

| Schnittstelle | Problem |
|---------------|---------|
| Adapter `controlBus.emit('monk:library-search')` vs Terminal `window.addEventListener('monk:library-search')` | Zwei getrennte Event-Kanäle; kein gemeinsamer Vertrag, Events können im Nirgendwo landen. |
| `BiblioPluginAdapter.sync` (`fetch('/api/cloud/sync')`) vs Terminal `syncCloudDatabase()` | Zwei parallele Cloud-APIs, keine Absprache über Auth, Body oder Fehlerbehandlung. |
| Hardcodierte `channel1`/`channel5` in `audioEngine.loadTrackSample` | Verletzt Vertrag (biblio hat keinen Kanal), koppelt biblio fest an Mixer-Belegung. |
| `navigator.clipboard.writeText(JSON.stringify(sample))` | Kein stabiler Sample-Export-Vertrag, kein Fehler-Handling bei Ablehnung. |
| `AudioSample`-Objekt wird direkt zwischen UI und Context weitergereicht | Kein klarer Vertrag, welche Felder Pflicht sind; Konsumenten (andere Plugins) hängen an konkreter Struktur. |

---

## 7. Empfohlene Korrekturen

1. **Cloud-Logik konsolidieren:** Einen `biblioCloudService` (oder Adapter als einzige Cloud-Stelle) mit Auth/Token, AbortController und einheitlicher Fehlerbehandlung; hardcodierten Endpunkt im Adapter entfernen.
2. **Ein Event-Kanal:** Entweder ControlBus oder window-Event für `monk:library-search`/`monk:library-load`, nicht beides.
3. **Lock durchsetzen:** `usePluginState('biblio', 'PRO')` und `lockStatus` bei Cloud-Push, Import und `loadTrackSample`-Aufrufen prüfen.
4. **Vertrag einhalten:** Biblio nicht direkt in Mixer-Kanäle laden (`channel1`/`channel5` entfernen) oder Vertrag auf Kanal-Plugin ändern.
5. **Suche debouncen:** `query`-Änderung mit Debounce (z. B. 150 ms) filtern, um unnötige Neufilterungen zu vermeiden.
6. **Analyse-Cache limitieren & race-safe:** Größenbegrenzung (LRU), `cancelled` vor jedem Schreiben prüfen, laufende Analysen bei Unmount abbrechen.
7. **LibraryTerminal aufteilen:** In `LibraryList`, `LibraryPreview`, `CloudPanel`, `AnalysisService`; statische Imports wo sinnvoll lazy laden (`React.lazy` für Panels).
8. Favoriten-Schreiben debouncen; Cloud-Merge mit Herkunftskennzeichnung (lokal vs. cloud) und Konflikt-Handling.
