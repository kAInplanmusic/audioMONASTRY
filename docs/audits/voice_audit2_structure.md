# audit2_structure — voiceMONK (Plugin `voice`, Kanal 6, mono)

**Status:** abgeschlossen (Struktur-Audit)  
**Basis:** `src/components/VoiceGenTerminal.tsx`, `src/plugins/adapters/VoicePluginAdapter.ts`, `src/plugins/pluginContract.ts`, `src/hooks/useAudioAI.ts`, `src/core/voice/VoiceMonkService.ts` (Referenz), `src/utils/PitchDetector.ts`  
**Artefakte geprüft:** Hauptrepo + Worktree `audioMONASTRY-voice` (byte-identisch)

---

## 1. Grundkonzept

voiceMONK ist ein source-Plugin (Kanal 6, mono) für KI-Stimme/TTS/Gesang. Ein UI-Terminal (`VoiceGenTerminal`) plus Adapter (`VoicePluginAdapter`). Commands: `speak`/`sing`/`song` an `VoiceMonkService`, `play`/`start` als SYNC-taktgerechter Trigger auf Kanal 6. Ergebnisse landen als `AudioSample` in der Bibliothek.

---

## 2. Architektur-Analyse

### Komponenten-Zusammenhang
```
Registry (registry.ts)
  └─ COMPONENT_MAP.voice -> VoiceGenTerminal (lazy import, React.memo)
  └─ VoicePluginAdapter extends BasePluginAdapter
        MANIFEST: id 'voice', kind 'audio-source', caps ['ai','audio-source'],
                  latencySamples 0, tailSamples 0
        onCommand: play/start -> scheduleSyncStart (audio.triggerEvent channel6)
                   speak/sing/song -> VoiceMonkService (import lazy)
UI VoiceGenTerminal:
  ├─ useAudioAI (generateVoice) — Server-KI TTS
  ├─ usePluginState('voice','PRO') — lockStatus
  ├─ useAudio — audioContext
  ├─ utils/PitchDetector — Mikrofon-Pitch-Detektion (100ms Intervall)
  ├─ utils/mediaDevices — requestUserMedia
  ├─ utils/audioEngine — triggerEvent channel5 [Widerspruch zu Kanal 6]
  ├─ utils/WebRTCManager — lock owner
  └─ utils/pluginSettings — persist prompt/style/voice/ttsMode
```

### Datenfluss
- Prompt/Stimme/Stil werden in lokalem State gehalten und per `writePluginSettings('voice', …)` persistiert.
- `generate()` ruft `generateVoice(prompt, voice)`; bei Erfolg → `addSample` (neues `AudioSample` mit id `vocal-${Date.now()}`); bei Fehler → Web-Speech-Fallback, kein Sample.
- `playResult()` nutzt `window.speechSynthesis` mit dem `prompt` und Stil-abhängigen Rate/Pitch.
- MIDI-Modus: Mikrofon → PitchDetector → alle 100 ms `audioEngine.triggerEvent('channel5', 0.8)`.

---

## 3. Technische Fehlannahmen (Strukturell)

- **Annahme: Adapter kapselt den voice-spezifischen Command-Pfad.** Wirklichkeit: `VoicePluginAdapter.onCommand` behandelt nur `speak`/`sing`/`song` (Service) und `play`/`start` (Schedule). Das Terminal führt `generate()`, `playResult()`, `startRecordingForMIDI()` selbst aus und ruft `audioEngine`/`useAudioAI` direkt auf. Doppelspurige Verantwortung wie bei instru.
- **Annahme: `latencySamples: 0` im MANIFEST stimmt.** Wirklichkeit: Server-TTS hat merkliche Latenz (Netzwerk + Generierung), die nirgendwo erfasst oder gemeldet wird; `latencyNote` im Vertrag verweist auf Server-Latenz, aber der Adapter-MANIFEST behauptet 0.
- **Annahme: `React.memo` verhindert unnötige Re-Renders.** Wirklichkeit: `bars` (Zeile 126) wird bei jedem Render neu berechnet (Array von 28 Objekten) — referenziell instabil, `memo` bringt nichts, daProps (`enabled`) selten wechseln aber internes State sich ständig ändert (`isGenerating`, `bars`).

---

## 4. Designschwächen

- **SRP-Verletzung:** `VoiceGenTerminal` mischt TTS-Orchestration, Web-Speech-Fallback, Mikrofon-Pitch, Sample-Erstellung, Settings-Persistenz und UI auf 170 Zeilen.
- **Globale/hardcodierte Abhängigkeiten:** `audioEngine`, `PitchDetector`, `useAudioAI`, `webRTCManager` werden direkt importiert/verwendet, nicht injected — nicht mockbar für Unit-Tests.
- **Lazy-Service-Import mitten im Command-Pfad:** `import('../../core/voice/VoiceMonkService')` innerhalb `onCommand` — erste `speak`-Ausführung löst Code-Loading aus, nicht deterministisch für Echtzeit.
- **Stimme-Liste ohne technische Abbildung:** `['FEMALE_ROBOTIC', …]` sind reines UI-Label ohne Mapping auf echte Stimmen (Server oder Browser).
- **Keine Abbruch-Möglichkeit:** `generateVoice` und Mikrofon-Stream können nicht abgebrochen werden; `isGenerating` sperrt nur den Button.
- **Settings bei jeder Änderung persistiert:** `writePluginSettings` im `useEffect` ohne Debounce bei Tastatureingabe im `textarea`.

---

## 5. Performance-/DSP-Risiken

- **Server-TTS ohne Timeout:** `await generateVoice(...)` kann unendlich hängen; UI bleibt auf `isGenerating = true`, kein Abbruch, kein Timeout.
- **Mikrofon-Pitch dauerhaft aktiv:** `setInterval(…, 100)` läuft bis manueller Stopp; dauerhafte CPU-Last und Mikrofon-Nutzung.
- **`audioEngine.triggerEvent('channel5', …)` pro Pitch-Frame:** Wiederholte Trigger auf Kanal 5 (falscher Kanal) können Mixer und instru-Zustand beeinflussen.
- **`new Audio()` / `speechSynthesis.speak()` ohne Quota-Kontrolle:** Mehrfache schnelle `playResult` Aufrufe überlappen sich (`synth.cancel()` bricht laufende Wiedergabe ab).
- **Kein `URL.revokeObjectURL`:** Falls `generateVoice` blob-URLs zurückgibt, Speicherleck.

---

## 6. Schnittstellen-Probleme

| Schnittstelle | Problem |
|---------------|---------|
| UI spielt Kanal 5, Adapter Kanal 6, Vertrag Kanal 6 | Drei uneinheitliche Kanal-Angaben für dasselbe Plugin; unklar, welcher Kanal gehört zu voice. |
| `voice` UI-Stimmen vs. `speechSynthesis.getVoices().lang` | Vergleich `v.lang === voice` findet nie einen Match (Browser-`lang` ≠ UI-Namen); Auswahl wirkungslos. |
| `useAudioAI().generateVoice` Rückgabe | Undefinierter Vertrag (Blob? URL? Ack?); Terminal baut selbst `AudioSample` ohne Absprache mit dem Hook. |
| `scheduleSyncStart` (Adapter) vs. direkter `audioEngine.triggerEvent` (UI) | Zwei Wiedergabepfade; UI umgehet SYNC-Taktung (UI2-P0-003-F1). |
| `onCommand(payload?: Record<string, unknown>)` | Keine Typisierung; `text` wird mit `String(…)` erzwungen, ungültige Payloads stillschweigend akzeptiert. |

---

## 7. Empfohlene Korrekturen

1. **Kanal auf 6 vereinheitlichen:** Alle Audio-Aufrufe in der UI auf Kanal 6 (`audioEngine.triggerEvent('channel6', …)`); Adapter und UI auf einen Pfad einigen.
2. **Stimmen-Mapping korrigieren:** UI-Stimmen-Liste mit echten `SpeechSynthesisVoice`- oder Server-Stimmen-IDs abbilden; Auswahl tatsächlich wirksam machen.
3. **TTS mit Timeout & Abort:** `generateVoice` über AbortController und Timeout steuerbar machen; klaren Status (Server/Fallback) anzeigen.
4. **Mikrofon-Stream abbrechbar & Zeitlimit:** `catch` um `requestUserMedia`, automatischer Stop nach Timeout, Zweckangabe im Berechtigungs-Dialog.
5. **Sample-ID zuverlässig:** `crypto.randomUUID()` statt `Date.now()`.
6. **Settings debounced schreiben:** Nicht bei jedem Tastenanschlag, sondern nach Ruhezeit (z. B. 500 ms).
7. **Verantwortung trennen:** `VoiceService` für TTS/Wiedergabe/Mikrofon extrahieren, Terminal nur UI.
8. **MANIFEST `latencySamples` realistisch:** Server-TTS-Latenz erfassen oder MANIFEST anpassen; `latencyNote` im Vertrag einhalten.
