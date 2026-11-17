# audit2_structure — stemMONK (Plugin `stem`, Kanal 8, stereo)

**Status:** abgeschlossen (Struktur-Audit)  
**Basis:** `src/components/StemExtractorTerminal.tsx`, `src/plugins/adapters/StemPluginAdapter.ts`, `src/plugins/pluginContract.ts`, `src/utils/StemRouter.ts`, `src/utils/stemUsage.ts`, `src/utils/stemSplitter.ts`, `src/ai/localDemucs.ts`, `src/hooks/useAudioAI.ts`  
**Artefakte geprüft:** Hauptrepo + Worktree `audioMONASTRY-stem` (byte-identisch)

---

## 1. Grundkonzept

stemMONK ist ein analysis/audio-processor-Plugin (Kanal 8, stereo) für Stem-Separation (5 Stems: Vocals, Lows, Mids, Highs, Melody; 4-Stem-Fallback; DSP-Notfall). UI-Terminal (`StemExtractorTerminal`) plus Adapter (`StemPluginAdapter`). Commands: `play`/`start` (SYNC-Trigger), `separate`, `status`. Ergebnisse werden in Mixer-Kanäle geroutet und in die Bibliothek geschrieben.

---

## 2. Architektur-Analyse

### Komponenten-Zusammenhang
```
Registry (registry.ts)
  └─ COMPONENT_MAP.stem -> StemExtractorTerminal (lazy, React.memo)
  └─ StemPluginAdapter extends BasePluginAdapter
        MANIFEST: id 'stem', kind 'analysis', caps ['ai','analysis','audio-processor'],
                  latencySamples 0, tailSamples 0
        FIVE_STEMS (5 Einträge), fiveStemLibraryEntries(sourceName, result)
        onCommand: play/start -> scheduleSyncStart (audio.triggerEvent channel8)
                   separate -> controlBus.emit('monk:stem-pick-file')
                   status    -> controlBus.emit('monk:stem-status')
UI StemExtractorTerminal (395 Zeilen):
  ├─ useAudioAI (streamStems) — Server-Streaming (RP5/4stem/auto)
  ├─ usePluginState('stem','PRO') — lockStatus
  ├─ useSamples (addSample)
  ├─ utils/StemRouter — routeStemToMixer, resolveStemChannel
  ├─ utils/audioEngine — previewSample, getBpm
  ├─ core/audio/mainLevel — useMainLevel (Pegel-Anzeige)
  ├─ utils/stemSplitter — splitStemsLocally (DSP-Notfall)
  ├─ ai/localDemucs — separateStemsWithDemucs (lokaler ONNX)
  ├─ utils/stemUsage — loadStemUsage, recordStemExtraction, formatUsd
  ├─ utils/WebRTCManager — lock owner
  ├─ utils/pluginSettings — persist providerChoice/warp/targetKey
  └─ ../plugins/adapters/StemPluginAdapter — FIVE_STEMS, fiveStemLibraryEntries
```

### Datenfluss & State
- State: `isExtracting`, `progress`, `file`, `error`, `usage`, `providerChoice`, `warpOn`, `targetKey`, `stemStatus`, `result`, `abortRef`.
- `startExtraction()`: Datei-Validierung (Typ, 500 MB) → Server-Stream `streamStems` (nicht `local`) → `applyServer` (Mixer-Routing + `addSample`) oder bei Fehler lokale ONNX / DSP-Notfall.
- `applyServer(data)`: `routeStemToMixer(key, url)` → `resolveStemChannel(key)` → `channels`-Map; `addSample` pro Stem-Eintrag; Warp-Notizen.
- Lokaler Pfad: `separateStemsWithDemucs` (ONNX) → `routeStemToMixer` + `addSample`; im Fehlerfall `splitStemsLocally` (Frequenzbänder).
- `playAll()`: `audioEngine.previewSample(ch)` über geroutete Kanäle.

---

## 3. Technische Fehlannahmen (Strukturell)

- **Annahme: Adapter ist Command/Schnittstelle-Schicht.** Wirklichkeit: Die Trennung läuft im Terminal (`startExtraction`); der Adapter behandelt nur `play`/`start`/`separate`/`status` über ControlBus. `separate` und `startExtraction` sind zwei Eintrittspunkte für dieselbe Funktion.
- **Annahme: `singleInstance: true` / `latencySamples: 0` sind aussagekräftig.** Wirklichkeit: Stem-Trennung ist ein asynchroner Server-/DSP-Prozess mit hoher, variabler Latenz; `latencySamples: 0` und `singleInstance` beschreiben das nicht.
- **Annahme: `FIVE_STEMS` (Adapter) ist die einzige Stem-Definition.** Wirklichkeit: Das Terminal definiert `DEMUCS_LANES` (4 Stems, andere Labels/Farben) separat — zwei nicht abgestimmte Definitionen.
- **Annahme: Ein Plugin = ein Kanal (8).** Wirklichkeit: stemMONK erzeugt bis zu 5 parallele Stems auf verschiedenen Mixer-Kanälen (`resolveStemChannel`); der Vertrags-Kanal 8 ist für das Ergebnis nicht abbildbar.

---

## 4. Designschwächen

- **SRP-Verletzung (schwerwiegend):** `StemExtractorTerminal` (395 Zeilen) übernimmt UI, Datei-Handling, Server-Streaming, lokale Trennung, DSP-Notfall, Mixer-Routing, Bibliotheksschreibung, Kosten-Tracking und Pegel-Anzeige. Der explizite `NOSONAR`-Kommentar bestätigt bekannte Komplexität ohne Abhilfe.
- **Zustandsfragmentierung:** 10+ State-/Ref-Variablen verteilt über lokalen State, `useRef`, `localStorage` (`pluginSettings`, `loadStemUsage`) ohne zentralen Store für stem.
- **Hardcodierte Server-Endpunkte:** `fetch('/api/stem/status')` und `streamStems` nutzen feste Pfade ohne Konfiguration oder Auth.
- **Kosten-Tracking ohne Limit:** `stemUsage` zählt und schätzt USD, aber kein Hard-Limit, keine automatische Abschaltung bei Kostenüberschreitung.
- **Zwei Stem-Definitionen:** `FIVE_STEMS` vs. `DEMUCS_LANES` divergen in Anzahl, Labeln und Farben.
- **Adapter quasi tot:** `separate` Command und Terminal `startExtraction` duplizieren den Einstieg; unklar welcher autoritativ ist.

---

## 5. Performance-/DSP-Risiken

- **500 MB Datei + lokale ONNX-Demucs-Trennung im Browser:** Hoher RAM/CPU-Verbrauch, möglicher Tab-Crash bei großen Dateien; keine serverseitige Absicherung des Limits.
- **Endloser Stream:** `while(true)` über `stream.next()` ohne Gesamt-Timeout; hängender Server-Stream blockiert `isExtracting` auf unbestimmte Zeit.
- **Speicherleck:** Server-Stem-URLs (ggf. blob-URLs) werden nicht revoked; `addSample` speichert URLs dauerhaft.
- **DSP-Notfall als Platzhalter:** `splitStemsLocally` (Frequenzbänder) verbraucht CPU, liefert aber keine echten Stems — irreführende Ressourcennutzung.
- **Kein Kosten-Hard-Limit:** RP5-Server-Modus kann unbegrenzt Kosten verursachen (`formatUsd` zeigt nur an).

---

## 6. Schnittstellen-Probleme

| Schnittstelle | Problem |
|---------------|---------|
| Vertrag Kanal 8 vs. Multi-Stem-Routing | Ein Plugin, 5 Stems, viele Mixer-Kanäle; Kanal 8 nicht abbildbar, kein Vertrag für Stem→Kanal-Matrix. |
| Adapter `separate` (`monk:stem-pick-file`) vs. Terminal `startExtraction` | Zwei Eintrittspunkte für die Trennung, keine Absprache über den autoritativen Pfad. |
| `FIVE_STEMS` (Adapter) vs. `DEMUCS_LANES` (Terminal) | 5 vs. 4 Stems, andere Labels/Farben; UI und Adapter sprechen nicht dieselbe Sprache. |
| `StemServerResult` ohne gemeinsames Interface | `code`/`status`/`simulated`/`provider`/`warp` werden ohne Typ gelesen; Server-Änderungen brechen den Client stillschweigend. |
| `routeStemToMixer` / `resolveStemChannel` (StemRouter) | Keine Rückmeldung über Routing-Erfolg oder Kanal-Belegungs-Konflikte. |
| `playAll()` → `audioEngine.previewSample(ch)` | Unklar, ob `previewSample` Kanal oder URL erwartet; potenzieller Typenfehler. |
| `onCommand(payload?: Record<string, unknown>)` | Keine Typisierung für `separate`/`status` Payloads. |

---

## 7. Empfohlene Korrekturen

1. **Kanal-Vertrag überdenken:** Entweder Vertrag auf kanal-unabhängige Rolle (`fxReturn`/`insert`/`utility`) ändern oder eine Stem→Kanal-Belegungs-Matrix vertraglich festlegen.
2. **DSP-Notfall vom KI-Stem trennen:** Visuell und typisch unterscheiden (anderes Badge, anderer `type`), nicht als "Stem" in derselben Darstellung.
3. **Stream mit Timeout & Abort:** `while(true)`-Loop mit Gesamt-Timeout; `abortRef` bei Netzwerkunterbrechung auslösen.
4. **Ein Eintrittspunkt für Trennung:** Adapter oder Terminal als alleinige Steuerung; Doppelspurigkeit beenden.
5. **Stem-Definition konsolidieren:** `FIVE_STEMS` und `DEMUCS_LANES` auf eine Quelle bringen (Adapter als Single Source of Truth).
6. **`StemServerResult` typisieren:** Shared Type zwischen Server und Client; simulierte Stubs (`simulated`) klar erkennbar machen.
7. **Kosten-Limit:** Hard-Limit für Cloud-Kosten, Warnung vor RP5, automatischer lokaler Fallback bei Überschreitung.
8. **Datei-Limit serverseitig:** Client-Check ergänzen; RAM-Warnung bei großen Dateien.
9. **Sample-ID zuverlässig:** `crypto.randomUUID()` statt `Date.now()`.
10. `NOSONAR`-Kommentar entfernen und Refactoring in `StemExtractorUI`, `StemExtractorService`, `StemRouter`, `StemUsageTracker` planen.
