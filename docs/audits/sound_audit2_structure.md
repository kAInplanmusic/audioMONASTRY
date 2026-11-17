# audit2_structure — soundMONK (Plugin `sound`, Kanal 7, stereo)

**Status:** abgeschlossen (Struktur-Audit)  
**Basis:** `src/components/SoundTerminal.tsx`, `src/plugins/adapters/SoundPluginAdapter.ts`, `src/plugins/pluginContract.ts`, `src/core/events/ControlBus.ts`, `src/utils/aiRhythmGenerator.ts`, `src/core/audio/sequencerPatternApply.ts` (Referenz)  
**Artefakte geprüft:** Hauptrepo + Worktree `audioMONASTRY-sound` (byte-identisch)

---

## 1. Grundkonzept

soundMONK ist ein source-Plugin (Kanal 7, stereo) für KI-/Regel-basierte Klang-Generierung (beat, bass, atmosphere, oneshot). UI-Terminal (`SoundTerminal`) plus Adapter (`SoundPluginAdapter`). Ergebnisse werden als `AudioSample` in die Bibliothek geschrieben (außer beats, die als Patterns in den Sequencer gehen).

---

## 2. Architektur-Analyse

### Komponenten-Zusammenhang
```
Registry (registry.ts)
  └─ COMPONENT_MAP.sound -> SoundTerminal (lazy, React.memo)
  └─ SoundPluginAdapter extends BasePluginAdapter
        MANIFEST: id 'sound', kind 'audio-source', caps ['ai','audio-source'],
                  latencySamples 0, tailSamples 0
        onCommand: trigger -> scheduleSyncStart (audio.triggerEvent channel8)
                   generate -> controlBus.emit('monk:sound-generate')
UI SoundTerminal:
  ├─ usePluginState('sound','PRO') — lockStatus
  ├─ useSamples — samples, addSample
  ├─ utils/audioEngine — previewSynthesizedSample, preview (new Audio)
  ├─ core/events/ControlBus — APPLY_PATTERNS_EVENT an sequencerPatternApply
  ├─ utils/aiRhythmGenerator — generateRhythmicPattern('techno')
  ├─ utils/random — random()
  ├─ utils/pluginSettings — persist description/kind
  └─ utils/WebRTCManager — lock owner
```

### Datenfluss
- UI: `description` + `kind` State, per `writePluginSettings('sound', …)` persistiert.
- `generate(kind)`:
  - beat: `generateRhythmicPattern('techno')` → `controlBus.emit(APPLY_PATTERNS_EVENT, {patterns, bpm: 128})` → Sequencer (`core/audio/sequencerPatternApply` lädt Patterns in `audioEngine`). Kein `addSample`.
  - sonst: `synthesizeSample(kind, text)` → `fetch('/api/sound/generate')` (Server-AI, optional) → `sample.url = URL.createObjectURL(blob)` → `addSample(sample)` → `preview(sample)`.
- Preview: `new Audio(url).play()` oder `audioEngine.previewSynthesizedSample(parameters, 'channel5')`.

---

## 3. Technische Fehlannahmen (Strukturell)

- **Annahme: Adapter ist Command-Schicht.** Wirklichkeit: Das Terminal führt die eigentliche Erzeugung (`generate`, `synthesizeSample`, `preview`) selbst aus; der Adapter (`trigger`/`generate`) wird vom Terminal nicht genutzt. Geteilte, nicht abgestimmte Zuständigkeit.
- **Annahme: `APPLY_PATTERNS_EVENT` ist ein stabiler Vertrag.** Wirklichkeit: Das Event wird mit `{patterns, bpm: 128}` emittiert, ohne typisierte Schnittstelle zum Listener (`sequencerPatternApply`); BPM ist hardcodiert, nicht aus dem Projekt-BPM abgeleitet.
- **Annahme: `latencySamples: 0` im MANIFEST stimmt.** Wirklichkeit: Server-AI-Generierung hat Netzwerk-Latenz, die nirgendwo erfasst wird; lokale Synthese ist synchron, aber nicht als solche gekennzeichnet.
- **Annahme: `React.memo` hilft.** Wirklichkeit: `log`-State (`setLog((prev) => [...prev.slice(-9), line])`) erzeugt bei jedem Log-Eintrag ein neues Array und löst Re-Render aus — beabsichtigt, aber keine Memoisierung von teuren Ableitungen (`variants` wird über `useMemo` korrekt, aber `log` nicht).

---

## 4. Designschwächen

- **SRP-Verletzung:** `SoundTerminal` übernimmt Synthese, Server-Kommunikation, Sequencer-Steuerung, Bibliotheksschreibung, Preview, Log und UI auf 213 Zeilen.
- **Zwei Erzeugungspfade:** Terminal-`generate()` (direkt) vs. Adapter-`generate` (ControlBus-Event) — unklar, welcher autoritativ ist; der Adapter wird faktisch nicht für die Hauptfunktion verwendet.
- **Fehlerunterdrückung:** `catch {}` um `fetch` und `try/catch {}` um `new Audio().play()` unterdrücken Fehler vollständig; keine Fehleranzeige im UI-Log außer einem allgemeinen `✗`-Eintrag im `finally`-Adjacent-Catch.
- **Hardcodierte Werte:** BPM 128 für beats, Kanal 5 für Preview, Kanal 8 im Adapter, `durationSeconds` hardcodiert per Kind — keine Anbindung an Projekt-BPM oder vertragliche Kanalbelegung.
- **Kein Interface zwischen Terminal und Sequencer:** `APPLY_PATTERNS_EVENT` Payload nicht vertraglich abgesichert.

---

## 5. Performance-/DSP-Risiken

- **Speicherleck durch `URL.createObjectURL`:** Nie `revoked`; jede Server-AI Generierung hinterlässt eine Objekt-URL im Speicher.
- **Hängende Server-Anfrage:** `fetch('/api/sound/generate')` ohne Timeout/AbortController blockiert `busy`-State auf unbestimmte Zeit.
- **Unbegrenztes `samples`-Wachstum:** Jede Generierung ruft `addSample`; `variants` zeigt nur die letzten 6, aber der untere `samples`-Store wächst unbegrenzt.
- **Kein Audio-Cache:** Gleicher Prompt/Kind erzeugt jedes Mal neues Audio; keine Wiederverwendung.
- **`new Audio().play()` Autoplay-Block:** Stiller Fehler im Browser ohne Nutzer-Hinweis.

---

## 6. Schnittstellen-Probleme

| Schnittstelle | Problem |
|---------------|---------|
| UI Kanal 5 (Preview) vs. Adapter Kanal 8 (trigger) vs. Vertrag Kanal 7 | Drei uneinheitliche Kanal-Angaben; unklar welcher Kanal zu sound gehört. |
| Terminal `generate()` vs. Adapter `generate` (`monk:sound-generate`) | Zwei parallele Erzeugungspfade ohne Absprache; Adapter ist tot. |
| `APPLY_PATTERNS_EVENT` Payload `{patterns, bpm: 128}` | Nicht typisiert, BPM hardcodiert, kein Vertrag zum Listener. |
| `AudioSample.url = blob:-URL` | Session-lokal, nicht serialisierbar, nie revoked; Bibliothekseinträge überleben Reload nicht. |
| `onCommand(payload?: Record<string, unknown>)` | Keine Typisierung für `trigger`/`generate` Payloads. |

---

## 7. Empfohlene Korrekturen

1. **Kanal auf 7 vereinheitlichen:** Alle `audio_engine`-Aufrufe auf Kanal 7 (bzw. vertraglichen TrackType); Kanal 5/8 entfernen.
2. **Blob-URLs revoken:** `URL.revokeObjectURL` bei Sample-Entfernung/Component-Unmount; oder Server-URLs bevorzugen.
3. **Fetch mit Timeout & AbortController:** `fetch('/api/sound/generate')` abbrichtbar machen; Nutzer sichtbar machen ob KI oder lokaler Fallback.
4. **Ein Erzeugungspfad:** Adapter als einzige Command-Schicht etablieren ODER Adapter-Command entfernen; Doppelspurigkeit beenden.
5. **Beat konsistent behandeln:** Entweder auch als `AudioSample` in Bibliothek schreiben oder als reines Sequencer-Pattern dokumentieren und von `addSample` trennen.
6. **Fehler nicht verschlucken:** `catch`-Blöcke mit Logging und `pushLog`-Einträgen versehen.
7. **Determinismus:** Optionaler Seed für Zufallsparameter.
8. **Samples begrenzen:** Ringbuffer/Maximalanzahl für `soundmonk`-Samples, um Speicherwachstum zu vermeiden.
