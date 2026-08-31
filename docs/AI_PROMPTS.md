# AI Prompt Engineering (Phase 2)

> System-Prompts, Few-Shot-Templates und Kontextfenster-Strategien der
> audioMONASTRY-KI. Quelle im Code: `src/core/ai/LlmRouter.ts`,
> `src/core/ai/MoaAgent.ts`, `src/utils/prompts.ts`.

## 1. MOA/MCP-Planer (DeepSeek V4 Flash)

**System-Prompt (Kern):**
```
Du bist der MOA/MCP-Planer von audioMONASTRY. Zerlege die Aufgabe in klare
Einzelschritte und antworte NUR als JSON-Array (keine Erklärung, kein Markdown):
[{"pluginId":"string","command":"string","prompt":"string"}]
```

**Plugin-bewusst (MoaAgent):**
```
{moaSystemPromptForPlugin(pluginId)}
Du darfst NUR diese Plugin-IDs und Kommandos verwenden (Syntax command(parameter)):
{moaCommandCatalog()}
Antworte NUR als JSON-Array: [{"pluginId":"string","command":"string","prompt":"string"}]
Aufgabe: {task}
```

**Parameter:** `temperature=0.3`, `reasoning_effort=low`, `maxTokens=1024`.

## 2. Few-Shot-Templates

- `moaCommandCatalog()` liefert die erlaubten Kommandos als Few-Shot-Katalog
  (17 Plugin-IDs; sampler hat echten `trigger`-Handler, stem/recording/
  mastering/visualizer/performance melden Status).
- `PLUGIN_MOA_TASKS` (AUTO_AI): periodische, plugin-spezifische
  Vorschlags-Prompts (z. B. „Schlage einen Mix-Schritt vor: …").
- `moaSystemPromptForPlugin(id)`: Rolle je Plugin (DJ, Producer, Engineer,
  Stem/AI-Assistent).

## 3. Voice/Song-Generierung

- TTS: Text wird serverseitig gesäubert (`cleanVoiceText`, max 500 Zeichen).
- Song: `SongGenerator` → HF MusicGen-Prompt `{prompt, style, bpm}`;
  Fallback lokaler Formant-Synth (kein Prompt-Engineering nötig).

## 4. Kontextfenster-Strategie

- Planungs-Prompts bleiben **< 2k Tokens** (kein langer Chat-Verlauf).
- Verlauf/Historie liegt clientseitig in `MoaHistory` (IndexedDB), wird dem
  LLM **nicht** erneut zugesendet.
- `maxTokens` je Task gedeckelt: Planung 1024, Voice/Describe 512, LLM-Router
  Default 256–1024 je Provider.
- Kreative Tasks `temperature 0.7`, deterministische Planung `0.3`.

## 5. Sicherheitsregeln für Prompts

- Kein Prompt-Injection-Rauschen: Steuerzeichen werden entfernt
  (`cleanVoiceText`), Längenlimits überall.
- KI erhält keine Secrets/Keys; Server baut die finalen Requests.
- MCP-Tools nur über Registry mit Permission-Check – Prompts können keine
  beliebigen Kommandos erzeugen.
