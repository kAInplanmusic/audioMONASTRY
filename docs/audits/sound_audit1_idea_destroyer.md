# audit1_idea_destroyer — soundMONK (Plugin `sound`, Kanal 7, stereo)

**Status:** abgeschlossen (adversarial / Idea Destroyer)  
**Basis:** `src/components/SoundTerminal.tsx` (213 Zeilen), `src/plugins/adapters/SoundPluginAdapter.ts` (37 Zeilen), `src/plugins/pluginContract.ts` (Vertrag `sound`, role `source`, channel 7, stereo, `producesAudio: true`, `bypassable: true`)  
**Artefakte geprüft:** Hauptrepo + Worktree `audioMONASTRY-sound` (byte-identisch)

---

## 1. Grundkonzept

soundMONK ist das generative Sound-Plugin: Text-Beschreibung → Klang (Server-AI über `/api/sound/generate`, z. B. MusicGen, mit lokaler Synthese als Fallback) oder Beat-Pattern über den ControlBus in den Sequencer (`APPLY_PATTERNS_EVENT`). Ergebnisse werden als `AudioSample` in die Bibliothek (`biblioMONK`) geschrieben und als Varianten mit Mini-Wellenform angezeigt. Vier Generator-Arten: beat, bass, atmosphere, oneshot. Besetzt vertraglich Kanal 7, erzeugt Ton (`producesAudio: true`).

---

## 2. Architektur-Analyse

### Komponenten-Zusammenhang
```
Registry (registry.ts)
  └─ COMPONENT_MAP.sound -> SoundTerminal (lazy, React.memo)
  └─ SoundPluginAdapter extends BasePluginAdapter
        MANIFEST: id 'sound', kind 'audio-source', caps ['ai','audio-source']
        onCommand: trigger -> scheduleSyncStart (audio.triggerEvent channel8)
                   generate -> controlBus.emit('monk:sound-generate')
UI SoundTerminal:
  ├─ usePluginState('sound','PRO') (lockStatus)
  ├─ useSamples (samples, addSample)
  ├─ utils/audioEngine (previewSynthesizedSample, preview via new Audio())
  ├─ core/events/ControlBus (APPLY_PATTERNS_EVENT an sequencerPatternApply)
  ├─ utils/aiRhythmGenerator (generateRhythmicPattern)
  ├─ utils/random (random())
  ├─ utils/pluginSettings (persist description/kind)
  └─ utils/WebRTCManager (lock owner)
```

### Datenfluss
- Generate (non-beat): `synthesizeSample(kind, text)` baut `AudioSample` mit zufälligen Parametern (frequency, decay, oscillatorType); dann `fetch('/api/sound/generate', …)` (Server-AI, MusicGen) → bei Erfolg `URL.createObjectURL(blob)` als `sample.url`; `addSample(sample)`; `preview(sample)`.
- Generate (beat): `generateRhythmicPattern('techno')` → `controlBus.emit(APPLY_PATTERNS_EVENT, {patterns, bpm: 128})` an `core/audio/sequencerPatternApply` → `audioEngine.loadPatterns(...)`. Es wird **kein Sample** in die Bibliothek geschrieben.
- Preview: `new Audio(sample.url).play()` bei URL, sonst `audioEngine.previewSynthesizedSample(parameters, 'channel5')` — wieder Kanal 5 hardcodiert, obwohl sound Kanal 7 sein sollte.

---

## 3. Technische Fehlannahmen

### Fehlannahme A: "sound spielt auf Kanal 7"
Vertrag: Kanal 7. Wirklichkeit: `preview` ruft `audioEngine.previewSynthesizedSample(..., 'channel5')` (Zeile 111) — Kanal 5 ist vertraglich `instru`. Der Adapter triggert `channel8` (Zeile 25) — Kanal 8 ist vertraglich `stem`. Drei Kanäle (5, 7, 8) für ein Plugin; der Vertrag wird von keiner Seite konsistent eingehalten.

### Fehlannahme B: "Server-AI zuerst, lokaler Fallback ist gleichwertig"
`fetch('/api/sound/generate')` wird aufgerufen; bei **jedem** Fehler (Netzwerk, 500, Timeout) wird stillschweigend auf lokale Synthese zurückgefallen (`catch {}` leert den Fehler). Der Nutzer erfährt nicht, ob er KI-Audio oder einen lokalen Oszillator hört — nur ein `em`-Tag "KI" in der Variante-Anzeige, das bei Server-Erfolg gesetzt wird. Keine Quota, kein Retry, keine Transparenz.

### Fehlannahme C: "Alle Generator-Arten landen gleich in der Bibliothek"
`beat` geht nur über den ControlBus in den Sequencer und schreibt **kein** `AudioSample` (`addSample` wird im beat-Zweig nicht aufgerufen). Die anderen drei Arten schreiben Samples. Inkonsistentes Verhalten je nach `kind`.

### Fehlannahme D: "Blob-URLs sind sicher"
`sample.url = URL.createObjectURL(blob)` (Zeile 144) wird nie mit `URL.revokeObjectURL` widerrufen. Jede Generierung hinterlässt eine nicht freigegebene Objekt-URL — klassischer Speicherleck in lang laufenden Sessions.

### Fehlannahme E: "Zufällige Parameter sind akzeptabel"
`random()` ohne Seed, keine Determinismus. Gleicher Prompt liefert nie denselben Klang — nicht reproduzierbar, nicht versionierbar, kein A/B-Vergleich möglich.

---

## 4. Designschwächen

- **SRP-Verletzung:** `SoundTerminal` (213 Zeilen) mischt Synthese-Logik, Server-Kommunikation, Sequencer-Steuerung, Bibliotheksschreibung, Preview, Log-Anzeige und UI.
- **Zwei parallele Pfade für "erzeugen":** `generate()` im Terminal vs. `controlBus.emit('monk:sound-generate')` im Adapter — der Adapter-Command wird vom Terminal selbst nicht genutzt, sondern das Terminal ruft `generate()` direkt. Der Adapter ist für sound nahezu tot.
- **Fehler werden verschluckt:** `catch {}` um den `fetch` (Zeile 148) und `try/catch {}` um `new Audio().play()` (Zeile 106–109) unterdrücken alle Fehler ohne Log oder Nutzer-Feedback.
- **Hardcodierte Parameter & Kanäle:** BPM 128 fest für beats, Kanal 5 für Preview, Kanal 8 im Adapter — keine Abfrage des Projekt-BPM oder des vertraglichen Kanals.
- **Kein Interface für `aiRhythmGenerator` / Sequencer-Event:** `APPLY_PATTERNS_EVENT` wird direkt emittiert, ohne Absprache über das Schema des Listeners (`core/audio/sequencerPatternApply`).

---

## 5. Performance-/DSP-Risiken

| Risiko | Auswirkung |
|--------|------------|
| `URL.createObjectURL` nie revoked | Speicherleck bei jeder Server-AI Generierung; wachsender RAM-Verbrauch über Session |
| `fetch('/api/sound/generate')` ohne Timeout | Hängende Anfrage blockiert `busy`-State und UI auf unbestimmte Zeit |
| `new Audio(sample.url).play()` ohne Fehlerbehandlung | Autoplay-Block im Browser führt zu stillem Fehlschlag, Nutzer hört nichts ohne Hinweis |
| Zufällige Synthese-Parameter ohne Cache | Jeder Klick erzeugt neues Audio, keine Wiederverwendung, hoher Audio-Engine-Druck bei häufigem Preview |
| Keine Begrenzung der Variant-Anzahl | `variants` filtert `slice(-6)`, aber `samples` wächst unbegrenzt mit jedem `addSample` |

---

## 6. Schnittstellen-Probleme

- **Kanal-Mismatch:** UI Preview Kanal 5, Adapter Trigger Kanal 8, Vertrag Kanal 7. Keine Stelle konsistent.
- **Adapter `generate` Command vs. Terminal `generate()`:** Der Adapter emittiert `monk:sound-generate` über ControlBus, das Terminal ruft aber seine eigene `generate()` auf. Zwei voneinander getrennte Erzeugungspfade ohne Absprache.
- **`APPLY_PATTERNS_EVENT` ohne typisierten Vertrag:** Event-Payload `{patterns, bpm: 128}` wird nicht zwischen Emittent und Listener (`sequencerPatternApply`) vertraglich abgesichert; Änderungen auf einer Seite brechen die andere stillschweigend.
- **`AudioSample.url` als blob:-URL:** Der `AudioSample`-Typ sieht `url` als String vor, aber blob:-URLs sind session-lokal und nicht serialisierbar; Bibliotheks-Einträge mit blob-URLs überleben keinen Reload nicht.
- **`random()` ohne Seed:** Keine deterministische Schnittstelle für Tests oder Reproduktion.

---

## 7. Empfohlene Korrekturen

1. **Kanal konsistent auf 7 ziehen:** Alle `audioEngine`-Aufrufe (Preview, Adapter-Trigger) auf Kanal 7 bzw. den vertraglichen TrackType umbiegen; Kanal 5/8 hardcodiert entfernen.
2. **Blob-URLs revoken:** `URL.revokeObjectURL(sample.url)` bei Sample-Entfernung/Reload aufrufen; oder Daten-URLs/Server-URLs bevorzugen.
3. **Server-AI mit Timeout & Retry:** `fetch` mit `AbortController` und Timeout; Nutzer sichtbar machen, ob KI oder lokaler Fallback aktiv war (mehr als ein `em`-Tag).
4. **Ein Erzeugungspfad:** Entweder Adapter als einzige Command-Schicht oder Terminal allein; den toten Adapter-Command `generate` entfernen oder zum Single-Pfad machen.
5. **Beat-Pfad konsistent:** Auch `beat` als `AudioSample` in die Bibliothek schreiben ODER dokumentieren, dass beats nur Sequencer-Patterns sind und nicht vorgespeichert werden.
6. **Fehler nicht verschlucken:** Alle `catch {}` mit Logging und Nutzer-Feedback versehen (`pushLog` mit Fehlerdetails).
7. **Determinismus:** Optionaler Seed für `random()` zur Reproduzierbarkeit von Klängen.
8. **Varianten/Samples begrenzen:** Maximalanzahl an `soundmonk`-Samples definieren, alte entfernen (Ringbuffer), damit `samples` nicht unbegrenzt wächst.
