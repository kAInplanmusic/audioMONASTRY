# AI Control Layer – AudioMONASTRY

Stand: 2026-08-26 · App-weit gültig für alle Module.

## Provider-Priorität (Kosten zuerst)

| Rang | Provider | Modell | Kosten | Einsatz |
|---|---|---|---|---|
| 1 | Hugging Face Inference | `mistralai/Mistral-7B-Instruct-v0.3` (konfigurierbar) | kostenlos | Standard |
| 2 | DeepSeek V4 Flash | `deepseek-v4-flash` | sehr günstig | Fallback / moderate Tasks |
| 3 | DeepSeek V4 Pro | `deepseek-v4-pro` | günstig | komplexe Tasks |
| 4 | Gemini | `gemini-2.0-flash` | kostenpflichtig | letzter Ausweg |
| 5 | OpenAI | `gpt-4o-mini` | kostenpflichtig | letzter Ausweg |

Implementierung: `src/core/ai/LlmRouter.ts`

## Komponenten

### 1. LlmRouter (`src/core/ai/LlmRouter.ts`)
- `rankProviders(complexity)` liefert Provider in Kosten-Reihenfolge
- `complete(request)` versucht Provider der Reihe nach (Fallback-Kette)

### 2. VoiceControlService (`src/core/voice/VoiceControlService.ts`)
- **Getrennter Service** – kein Plugin
- Deckt **alle 4 User** ab (`execute(userId, command)`)
- Befehle werden **pro Plugin** registriert (`registerCommand(pluginId, intent, handler)`)
- Sprachbefehl-Automation ≠ VoiceMONK

### 3. VoiceMonkService (`src/core/voice/VoiceMonkService.ts`)
- **Plugin:** Text → Sprache (TTS) und Text → künstlicher Gesang
- Provider: Hugging Face TTS (`facebook/mms-tts-deu`) → deterministischer WAV-Fallback (offline/free)
- Ergebnis wird als Audio-Datei in die **Session-Datenbank** gelegt

### 4. SessionMediaStore (`src/core/session/SessionMediaStore.ts`)
- Gemeinsamer Zwischenspeicher: jeder User kann TTS/Gesang/Samples ablegen
- Andere Plugins (z. B. DJ) können die Medien aufgreifen

## API-Beispiel

```ts
// Sprachsteuerung (getrennt von VoiceMONK):
await voiceControlService.execute('User2', 'Tempo 128');

// VoiceMONK: Text → Stimme → Session-DB:
await voiceMonkService.speak('User1', 'Hallo meine Freunde der Tanykultur', {
  gender: 'male',
  character: 'dark',
  loudness: 'soft',
});

// VoiceMONK: Gesang:
await voiceMonkService.sing('User2', {
  notes: [{ lyric: 'Hal', midi: 60 }, { lyric: 'lo', midi: 64 }],
  bpm: 120,
});
```

## Offene Punkte

- Echte HF-TTS-Modellwahl (deutsch, männlich/dunkel) validieren
- Gesang: Pitch-/Timing-Synthese über TTS hinaus (z. B. lokale Vocoder-Kette)
- Persistenz des SessionMediaStore über die Browser-Session hinaus
