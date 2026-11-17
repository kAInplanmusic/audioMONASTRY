# audit1_idea_destroyer — voiceMONK (Plugin `voice`, Kanal 6, mono)

**Status:** abgeschlossen (adversarial / Idea Destroyer)  
**Basis:** `src/components/VoiceGenTerminal.tsx` (170 Zeilen), `src/plugins/adapters/VoicePluginAdapter.ts` (54 Zeilen), `src/plugins/pluginContract.ts` (Vertrag `voice`, role `source`, channel 6, mono, `producesAudio: true`, `bypassable: true`)  
**Artefakte geprüft:** Hauptrepo + Worktree `audioMONASTRY-voice` (byte-identisch)

---

## 1. Grundkonzept

voiceMONK ist das Voice/TTS/Gesang-Plugin: Text-Prompt → KI-Stimme (Server-TTS über `useAudioAI().generateVoice`) mit Web-Speech-API-Fallback (offline), Stimme/Stilwahl, MIDI-Aufnahme über Pitch-Detektion (Mikrofon, 100-ms-Intervall), Ergebnis wird als `AudioSample` in die Bibliothek (`biblioMONK`) geschrieben und als `vocal_take_01.wav` vorgespielt. Besetzt Kanal 6 (mono, wird im Kanalzug auf Stereo gezogen), erzeugt Ton (`producesAudio: true`).

---

## 2. Architektur-Analyse

### Komponenten-Zusammenhang
```
Registry (registry.ts)
  └─ COMPONENT_MAP.voice -> VoiceGenTerminal (lazy, React.memo, {enabled})
  └─ VoicePluginAdapter extends BasePluginAdapter
        MANIFEST: id 'voice', kind 'audio-source', caps ['ai','audio-source']
        onCommand: play/start -> scheduleSyncStart (channel6 trigger)
                   speak/sing/song -> voiceMonkService (core/voice/VoiceMonkService)
UI VoiceGenTerminal:
  ├─ useAudioAI (generateVoice, streamStems)
  ├─ usePluginState('voice','PRO') (lockStatus)
  ├─ useAudio (audioContext)
  ├─ utils/PitchDetector (Mikrofon-Pitch, 100ms Intervall)
  ├─ utils/mediaDevices (requestUserMedia)
  ├─ utils/audioEngine (triggerEvent channel5/channel6)
  ├─ utils/WebRTCManager (lock owner)
  └─ utils/pluginSettings (persist prompt/style/voice/ttsMode)
```

### Datenfluss
1. Generate: `generateVoice(prompt, voice)` (Server-AI) → bei Erfolg Sample in `useSamples().addSample`; bei Fehler Web-Speech-Fallback (`speechSynthesis.speak`).
2. PlayResult: Web-Speech Utterance mit `prompt`, Stimme-Match über `synth.getVoices().find(v => v.lang === voice)`.
3. MIDI-Aufnahme: `requestUserMedia({audio:true})` → `PitchDetector.getNote()` alle 100 ms → `audioEngine.triggerEvent('channel5', 0.8)` — **hardcodiert Kanal 5**, obwohl voice auf Kanal 6 vertraglich sitzt.
4. Commands: `speak`/`sing`/`song` an `voiceMonkService`; `play`/`start` triggert `channel6` über `scheduleSyncStart`.

---

## 3. Technische Fehlannahmen

### Fehlannahme A: "Voice spielt auf Kanal 6 (Vertrag)"
Der Vertrag weist `voice` Kanal 6 zu. Die UI spielt aber auf **Kanal 5**:
- `startRecordingForMIDI`: `audioEngine.triggerEvent('channel5', 0.8)` (Zeile 60) — Kanal 5 ist vertraglich `instru`, nicht voice.
- `playResult` Fallback: `audioEngine.triggerEvent('channel5', 0.6)` (Zeile 109) — wieder Kanal 5.
- Der Adapter triggert `channel6` korrekt (Zeile 33), aber die UI-Komponente ignoriert den eigenen Vertrag und spielt auf 5.

### Fehlannahme B: "Stimme `voice` passt zur `lang` des Browsers"
`voices = ['FEMALE_ROBOTIC', 'MALE_GRITTY', 'ETHEREAL_CHOIR', 'DISTORTED_DEMON', 'AI_NEWSCASTER']` (Zeile 103). Beim Web-Speech-Match wird gesucht nach `synth.getVoices().find(v => v.lang === voice)`. Browser-Stimmen haben `lang` wie `'de-DE'` oder `'en-US'`, niemals `'FEMALE_ROBOTIC'`. Der Match findet praktisch nie statt; es wird immer `synth.getVoices()[0]` genommen — die gewählte Stimme wird ignoriert.

### Fehlannahme C: "KI-TTS ist zuverlässig, Fallback reicht"
`generateVoice` serverseitig; bei Fehler wird auf Web Speech umgeschaltet. Aber:
- Es gibt kein Retry, keine Quota/Rate-Limit für den Server-Aufruf.
- Web Speech API ist nicht in allen Browsern/Umgebungen verfügbar (Node/SSR, headless) — der `typeof window === 'undefined'` Check ist nur teilweise (Zeile 107 prüft es, aber `window.speechSynthesis` kann trotzdem undefined sein).
- Kein Nutzer-Hinweis, welcher Pfad aktiv war, außer einem kleinen Badge `WEB SPEECH OFFLINE`.

### Fehlannahme D: "Sample-IDs sind eindeutig"
`id: \`vocal-${Date.now()}\`` — bei schnellen aufeinanderfolgenden Generierungen (unter 1 ms) können Kollisionen entstehen; `Date.now()` ist keine zuverlässige ID.

### Fehlannahme E: "Mikrofon-Pitch-Aufnahme ist sicher"
`requestUserMedia({audio:true})` fordert Mikrofon-Berechtigung an, ohne den Nutzer darüber aufzuklären, wofür (Pitch-Detektion → MIDI). Bei verweigertem Zugriff bricht `startRecordingForMIDI` stillschweigend ab (kein `catch` um den `await requestUserMedia`-Aufruf, nur `if (!audioContext)` Prüfung danach). Pitch-Detektion läuft unendlich alle 100 ms, bis manuell gestoppt — kein Timeout, keine automatische Beendigung.

---

## 4. Designschwächen

- **UI mischt KI-Orchestration und Wiedergabe:** `VoiceGenTerminal` (170 Zeilen) verantwortet TTS-Generierung, Web-Speech-Fallback, Mikrofon-Pitch, Sample-Erstellung, Settings-Persistenz und Rendering. Keine Trennung.
- **Kanal 5 vs. 6 Widerspruch:** Die UI spielt auf Kanal 5, der Vertrag und der Adapter sagen Kanal 6 — unklar, welcher Kanal tatsächlich für voice zuständig ist.
- **Kein Interface für `generateVoice`:** `useAudioAI()` liefert eine Funktion ohne Typsicherung für Rückgabe/Fehler; Fehlerbehandlung ist ein generischer `catch`.
- **Settings-Schreib-Loop:** `writePluginSettings('voice', …)` läuft bei jeder Änderung von `prompt`/`style`/`voice`/`ttsMode` — bei Tastatur-Eingabe im `textarea` bei jedem Anschlag ein LocalStorage-Schreibvorgang.
- **Stimme-Liste statisch:** Die fünf `voices` sind UI-seitig fest definiert, haben keine Abbildung auf echte Server- oder Browser-Stimmen; der Nutzer wählt Namen, die technisch nicht existieren.
- **Keine Abbruch-Möglichkeit für laufende TTS-Generierung:** `isGenerating` deaktiviert den Button, aber `generateVoice` kann nicht abgebrochen werden (kein AbortController).

---

## 5. Performance-/DSP-Risiken

| Risiko | Auswirkung |
|--------|------------|
| Mikrofon-Pitch alle 100 ms ununterbrochen | Dauerhafte CPU-Last + Mikrofon aktiv, solange Aufnahme läuft; kein Auto-Stop |
| Server-TTS ohne Timeout/Retry | Hängende Generierung blockiert UI (`isGenerating = true` auf unbestimmte Zeit) |
| `audioEngine.triggerEvent('channel5', …)` bei jedem Pitch-Frame | Wiederholte Trigger-Events auf falschem Kanal können den Mixer-Kanal 5 (instru) verfälschen |
| `new SpeechSynthesisUtterance` bei jedem `playResult` | `synth.cancel()` bricht laufende Wiedergabe ab — keine Queue, Überlappung nicht möglich |
| Lokale Synthese-Fallback (Oszillator) bei fehlendem `speechSynthesis` | Hörbares Ersatzsignal ohne Kennzeichnung, dass kein echter Sprach-Output erfolgt |

---

## 6. Schnittstellen-Probleme

- **Kanal-Mismatch UI ↔ Vertrag ↔ Adapter:** UI spielt auf Kanal 5, Vertrag sagt Kanal 6, Adapter triggert Kanal 6. Drei Stellen, drei verschiedene Kanäle für dasselbe Plugin.
- **`voice`-Stimmen-Liste vs. `speechSynthesis` Stimmen:** Keine Abbildung zwischen UI-Namen (`FEMALE_ROBOTIC`) und tatsächlichen `SpeechSynthesisVoice`-Objekten; Selection ist wirkungslos.
- **`useAudioAI().generateVoice` Rückgabe:** Nicht klar ersichtlich, ob Promise auf Audio-Blob, URL oder bloßes Ack auflöst; Terminal behandelt es wie ein "fire and forget" und baut selbst ein `AudioSample` — Vertrag zwischen Hook und UI undefiniert.
- **`scheduleSyncStart` vs direkter `triggerEvent`:** Der Adapter nutzt `scheduleSyncStart` (SYNC-taktgerecht, UI2-P0-003-F1), die UI ruft `audioEngine.triggerEvent('channel5', …)` direkt auf — zwei getrennte Wiedergabepfade ohne Absprache, SYNC-Taktung wird von der UI umgangen.
- **Kein AbortController** für `generateVoice` oder Mikrofon-Stream — laufende Vorgänge können nicht sauber beendet werden.

---

## 7. Empfohlene Korrekturen

1. **Kanal konsistent auf 6 ziehen:** Alle `audioEngine.triggerEvent('channel5', …)` in `VoiceGenTerminal` auf Kanal 6 (oder den vertraglichen `TrackType`) umbiegen; Adapter und UI einigen auf einen Kanal.
2. **Stimmen-Match beheben:** UI-Stimmen-Liste auf echte `SpeechSynthesisVoice`-Objekte oder Server-Stimmen-IDs abbilden; nicht `v.lang === voice` vergleichen, sondern `voice`-Name/ID.
3. **Mikrofon-Nutzung transparente machen:** Erlaubnis-Dialog mit Zweckangabe; `catch` um `requestUserMedia`; automatischer Stop nach Timeout; klares UI-Signal, wenn Mikrofon aktiv ist.
4. **TTS-Generierung abbrechbar:** AbortController/Timeout für `generateVoice`; eindeutiger Nutzer-Status (Server-TTS vs. Web-Speech-Fallback).
5. **Sample-ID zuverlässig:** `crypto.randomUUID()` oder Zähler statt `Date.now()`.
6. **Settings debounced schreiben:** `writePluginSettings` nicht bei jedem Tastenanschlag, sondern debounced (z. B. 500 ms nach letzter Änderung).
7. **Web-Speech-Verfügbarkeit prüfen:** `speechSynthesis` Existenz vor Nutzung prüfen, klaren Fallback ohne Heu-Rhetorik anzeigen.
8. **Verantwortung trennen:** `VoiceService` für TTS/Wiedergabe extrahieren, Terminal rein als UI.
