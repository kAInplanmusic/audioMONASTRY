# audit1_idea_destroyer — stemMONK (Plugin `stem`, Kanal 8, stereo)

**Status:** abgeschlossen (adversarial / Idea Destroyer)  
**Basis:** `src/components/StemExtractorTerminal.tsx` (395 Zeilen), `src/plugins/adapters/StemPluginAdapter.ts` (98 Zeilen), `src/plugins/pluginContract.ts` (Vertrag `stem`, role `source`, channel 8, stereo, `producesAudio: true`, `bypassable: true`), `src/utils/StemRouter.ts` (Referenz), `src/utils/stemUsage.ts` (Referenz)  
**Artefakte geprüft:** Hauptrepo + Worktree `audioMONASTRY-stem` (byte-identisch)

---

## 1. Grundkonzept

stemMONK ist das Stem-Separation-Plugin: Eine Audio-Datei (WAV/MP3/FLAC/OGG/AIFF, bis 500 MB) wird in bis zu 5 Stems getrennt (Vocals, Lows, Mids, Highs, Melody). Drei Wege: RP5-Server (bs-roformer-sw-6stem, 5 echte Stems mit Warp), 4-Stem (htdemucs über stem-ai), Lokal (ONNX/Demucs im Browser), dazu DSP-Notfall (Frequenzbänder, ausdrücklich als Nicht-KI gekennzeichnet). Ergebnisse werden in Mixer-Kanäle geroutet und als `AudioSample` in die Bibliothek geschrieben. Besetzt vertraglich Kanal 8, erzeugt Ton (`producesAudio: true`).

---

## 2. Architektur-Analyse

### Komponenten-Zusammenhang
```
Registry (registry.ts)
  └─ COMPONENT_MAP.stem -> StemExtractorTerminal (lazy, React.memo)
  └─ StemPluginAdapter extends BasePluginAdapter
        MANIFEST: id 'stem', kind 'analysis', caps ['ai','analysis','audio-processor'],
                  latencySamples 0, tailSamples 0
        FIVE_STEMS (vocals/lows/mids/highs/melody), fiveStemLibraryEntries()
        onCommand: play/start -> scheduleSyncStart (audio.triggerEvent channel8)
                   separate -> controlBus.emit('monk:stem-pick-file')
                   status    -> controlBus.emit('monk:stem-status')
UI StemExtractorTerminal:
  ├─ useAudioAI (streamStems) — Server-Stream (RP5 / 4stem / auto)
  ├─ usePluginState('stem','PRO') — lockStatus
  ├─ useSamples (addSample)
  ├─ utils/StemRouter (routeStemToMixer, resolveStemChannel)
  ├─ utils/audioEngine (previewSample, getBpm)
  ├─ core/audio/mainLevel (useMainLevel für Pegel-Anzeige)
  ├─ utils/stemSplitter (splitStemsLocally — DSP-Notfall)
  ├─ ai/localDemucs (separateStemsWithDemucs — lokal ONNX)
  ├─ utils/stemUsage (loadStemUsage, recordStemExtraction, formatUsd — Kosten-Tracking)
  ├─ utils/WebRTCManager (lock owner)
  ├─ utils/pluginSettings (persist providerChoice/warp/targetKey)
  └─ ../plugins/adapters/StemPluginAdapter (FIVE_STEMS, fiveStemLibraryEntries)
```

### Datenfluss
1. Datei wählen (max. 500 MB, Typ-Validierung) → `startExtraction()`.
2. Falls nicht `local`: `streamStems(file, {mode, targetBpm, targetKey, signal})` — asynchroner Stream mit Progress-Zahlen; am Ende `StemServerResult`.
3. `applyServer(data)`: Stems via `routeStemToMixer(key, url)` in Mixer-Kanäle; `resolveStemChannel(key)`; `addSample` für Bibliotheks-Einträge; `finish()`.
4. Bei Server-Fehler im `auto`-Modus: lokale ONNX-Trennung (`separateStemsWithDemucs`) oder DSP-Notfall (`splitStemsLocally` = Frequenzbänder).
5. `playAll()`: `audioEngine.previewSample(ch)` über alle gerouteten Stem-Kanäle.

---

## 3. Technische Fehlannahmen

### Fehlannahme A: "stem spielt auf Kanal 8"
Vertrag: Kanal 8. Wirklichkeit: Stems werden über `resolveStemChannel(key)` auf **verschiedene Mixer-Kanäle** verteilt (jeder Stem ein eigener Kanal), nicht auf Kanal 8. Der Adapter triggert zwar `channel8` (Zeile 80), aber das ist nur der Transport-Start für den "play"-Befehl; die eigentlichen Stems landen auf beliebigen Kanälen. Der Vertrag "Kanal 8" ist für das multi-Stem-Ergebnis nicht abbildbar.

### Fehlannahme B: "DSP-Notfall ist eine Stem-Trennung"
`splitStemsLocally` erzeugt Frequenzbänder und wird als `kind: 'dsp'` mit dem Kommentar "DSP-Notfall: Frequenzbänder, KEINE KI-Trennung" gekennzeichnet. Dennoch werden diese Bänder als `AudioSample` vom Typ 'Stem' in die Bibliothek geschrieben und als Stems dargestellt — eine Irreführung: Der Nutzer bekommt Frequenzbänder, keine echten Stems, ohne dass dies auf den ersten Blick klar ist (Badge zeigt "DSP-Notfall · keine KI", aber die Spuren sehen aus wie echte Stems).

### Fehlannahme C: "Server liefert echte Stems oder es gibt einen klaren Fehler"
Im `auto`-Modus wird bei `data.simulated` (STEM_AI_PROVIDER=fallback) nur ein simulierter Stub geliefert. Die Prüfung `data.status === 'success' && !data.simulated && data.stems && ...` fängt das ab, aber die Unterscheidung zwischen "echte Stems", "simulierter Stub" und "Fehler" liegt in `data.code`/`data.status`/`data.simulated` ohne klaren Vertrag. Der Nutzer kann nicht sicher erkennen, ob er echte Trennung oder einen Placebo-Stub erhält.

### Fehlannahme D: "Der asynchrone Stream endet immer"
`while (true) { const step = await stream.next(); if (step.done) { data = step.value; break; } ... }` — Wenn der Stream nie `done` liefert (z. B. hängender Server-Stream, abgebrochene Verbindung ohne Abort), läuft die Schleife endlos. Es gibt keinen Timeout außerhalb des `abortRef.current.signal`.

### Fehlannahme E: "500 MB Datei-Limit ist sicher"
`MAX_FILE_SIZE = 500 * 1024 * 1024` wird client-seitig geprüft, aber es gibt keine serverseitige Bestätigung, keine Speicher-Kontrolle im Browser für große Dateien und keinen Hinweis, dass der RAM bei 500 MB Audio + Trennung überlaufen kann.

### Fehlannahme F: "Stem-IDs sind eindeutig"
`id: \`stem-${stamp}-${stem}\`` mit `stamp = Date.now()` — schnelle aufeinanderfolgende Extraktionen derselben Datei können Kollisionen erzeugen.

---

## 4. Designschwächen

- **SRP-Verletzung:** `StemExtractorTerminal` (395 Zeilen, mit explizitem `NOSONAR`-Kommentar: "bewusst komplexe Audio-/DSP-/UI-Logik; Refactoring würde Risiko erhöhen") mischt UI, Datei-Handling, Server-Streaming, lokale Trennung, DSP-Notfall, Mixer-Routing, Bibliotheksschreibung, Kosten-Tracking und Pegel-Anzeige. Das `NOSONAR` signalisiert anerkannte technische Schulden ohne Abhilfe.
- **Zustandsfragmentierung:** `isExtracting`, `progress`, `file`, `error`, `usage`, `providerChoice`, `warpOn`, `targetKey`, `stemStatus`, `result`, `abortRef` — verteilt über State, Ref und localStorage ohne zentralen Store.
- **Kosten-Tracking ohne Limit:** `stemUsage` zählt Extraktion und schätzt USD-Kosten, aber es gibt kein Hard-Limit, keine automatische Abschaltung bei Kostenüberschreitung, keine Warnung vor teurem RP5-Modus.
- **Hardcodierte Server-Endpunkte:** `fetch('/api/stem/status')` und `streamStems` nutzen feste Pfade ohne Konfiguration oder Auth-Token.
- **Adapter quasi tot:** `StemPluginAdapter` behandelt nur `play`/`start`/`separate`/`status` über ControlBus; die echte Trennung läuft im Terminal (`startExtraction`), nicht im Adapter. Wieder Doppelspurigkeit wie bei den anderen Plugins.
- **`FIVE_STEMS` vs. `DEMUCS_LANES` Divergenz:** Das Adapter-Modul definiert 5 Stems (inkl. `melody`), das Terminal definiert eigene 4-Stem-Lanes (`vocals/bass/drums/other`) mit anderen Labels und Farben. Zwei nicht abgestimmte Stem-Definitionen.

---

## 5. Performance-/DSP-Risiken

| Risiko | Auswirkung |
|--------|------------|
| 500 MB Datei im Browser + ONNX-Demucs lokal | Hoher RAM/CPU-Verbrauch, möglicher Tab-Crash bei großen Dateien |
| Endloser `while(true)`-Stream ohne Timeout | Hängende Extraktion bei Netzwerkunterbrechung, UI bleibt auf `isExtracting = true` |
| `URL.createObjectURL` / blob-URLs aus Server-Stems | Speicherleck, falls nie revoked (untersucht nicht im Code) |
| `streamStems` ohne Progress-Cap | Progress-Zahlen können beliebig sein, keine Validierung (0–100) |
| DSP-Notfall als Frequenzbänder statt echter Trennung | Irreführende CPU-Nutzung ohne echten Mehrwert; Nutzer wartet auf "Stems" und bekommt Bänder |
| Kein Hard-Limit bei Cloud-Kosten (RP5) | Unkontrollierte Kosten bei häufiger Nutzung des teuren Modus |

---

## 6. Schnittstellen-Probleme

- **Kanal-Vertrag nicht abbildbar:** Ein Plugin mit 5 parallelen Stems kann nicht auf einen einzigen Kanal 8 gemappt werden; `resolveStemChannel(key)` verteilt auf mehrere Kanäle ohne vertragliche Absprache.
- **Adapter vs. Terminal:** `separate` Command im Adapter emittiert `monk:stem-pick-file`, aber die Extraktion läuft im Terminal unabhängig davon (`startExtraction` via Button oder `monk:stem-pick-file` Window-Event). Zwei Eintrittspunkte, keine Absprache.
- **`FIVE_STEMS` (Adapter) vs. `DEMUCS_LANES` (Terminal) nicht konsistent:** Unterschiedliche Anzahl (5 vs. 4), unterschiedliche Labels, unterschiedliche Farben — UI und Adapter sprechen nicht dieselbe Stem-Sprache.
- **`StemServerResult` Struktur undefiniert:** `data.code`, `data.status`, `data.simulated`, `data.provider`, `data.warp`, `data.fallbackReason` werden ohne gemeinsames Interface gelesen; Änderungen im Server-Backend brechen den Client stillschweigend.
- **`routeStemToMixer` / `resolveStemChannel` aus `StemRouter` ohne Rückmeldung:** Nicht klar, ob das Routing erfolgreich war oder ob der Zielkanal bereits belegt ist.
- **`playAll()` nutzt `audioEngine.previewSample(ch)` mit `TrackType`:** Unklar, ob `previewSample` einen Kanal oder eine URL erwartet; potenzieller Typenfehler.

---

## 7. Empfohlene Korrekturen

1. **Kanal-Vertrag überdenken:** Ein Multi-Stem-Plugin kann nicht auf einen Kanal gemappt werden; entweder Vertrag auf `role: fxReturn`/`insert` ohne Kanal ändern oder Stem-Kanal-Belegung vertraglich festlegen (Stem → Kanal-Matrix).
2. **DSP-Notfall kennzeichnen:** DSP-Frequenzbänder dürfen nicht als "Stems" im selben Look & Feel dargestellt werden; klarer visueller Unterschied (anderes Badge, anderer Typ) und keine Gleichsetzung mit KI-Stems.
3. **Stream mit Timeout & Abort:** `while(true)`-Loop mit Gesamt-Timeout versehen; `abortRef` auch bei Netzwerkunterbrechung auslösen; keine endlosen Schleifen.
4. **Ein Eintrittspunkt für Trennung:** Entweder Adapter oder Terminal als alleinige Steuerung; Doppelspurigkeit (`separate` Command vs. `startExtraction`) beenden.
5. **Stem-Definition konsolidieren:** `FIVE_STEMS` und `DEMUCS_LANES` auf eine einzige Quelle bringen (Adapter als Single Source of Truth).
6. **`StemServerResult` typisieren:** Shared Type zwischen Server und Client für `code`/`status`/`simulated`/`provider`/`warp`, damit simulierte Stubs erkennbar sind.
7. **Kosten-Limit einführen:** Hard-Limit für Cloud-Kosten (RP5), Warnung vor teurem Modus, automatischer Fallback auf lokal bei Überschreitung.
8. **Datei-Limit serverseitig absichern:** Client-Check ergänzen, nicht ersetzen; RAM-Warnung bei großen Dateien.
9. **Sample-ID zuverlässig:** `crypto.randomUUID()` statt `Date.now()`.
10. `NOSONAR`-Kommentar entfernen und Refactoring in kleinere Module planen (UI, Extractor, Router, Usage-Tracker).
