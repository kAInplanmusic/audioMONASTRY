# AI Prompt Engineering (Phase 2)

> System-Prompts, Few-Shot-Templates und Kontextfenster-Strategien der
> audioMONASTRY-KI.
>
> **Quellen im Code (verbindlich):**
> `src/core/ai/orchestrator/promptRoles.ts` (Rollen-Prompt-Katalog),
> `src/utils/prompts.ts` (Rollen-Sätze, Kommando-Katalog, Aufgaben),
> `src/core/ai/orchestrator/evalMatrix.ts` (verbindliche Rollenliste + Gate),
> `src/core/ai/orchestrator/promptStore.ts` (Versionierung),
> `src/core/ai/orchestrator/promptSeed.ts` (DB-Seed),
> `src/core/ai/vision/visionPrompt.ts` (Bild-/Video-Prompt-Bauer),
> `src/core/ai/MoaAgent.ts` (Plan-Aufruf),
> `src/core/ai/LlmRouter.ts` (Provider-Kette).
>
> Die Abdeckung je Rolle (Prompt-Version, Few-Shots, MCP-Tools, Eval-Fälle,
> Min-Score, Status) steht in `docs/PLUGIN_PROMPT_MATRIX.md` und wird aus
> `promptRoles.ts` generiert.

## 1. Rollen und ihre Systemprompts (v2)

Jede verbindliche Rolle (`EVAL_PLUGIN_IDS`: 16 MONKs + `ai`/`perfor`) hat eine
Prompt-Version **v2**:

```
{PLUGIN_MOA_SYSTEM_PROMPTS[roleId]}          ← Rollensatz (Altbestand, unverändert)

## Erlaubte Kommandos (nur diese, Syntax command(parameter))
{roleId}: {PLUGIN_COMMAND_CATALOG[roleId]}

## Fehlerregel
Fehlerbehandlung: Wenn ein Kommando nicht verfügbar ist, …

## Antwortformat
Antworte NUR als JSON-Array, ohne Erklärung und ohne Markdown:
[{"pluginId":"string","command":"string","prompt":"string"}]

## Beispiele (Few-Shot)
Eingabe: {Aufgabe aus PLUGIN_MOA_TASKS}
Antwort: [{"pluginId":"…","command":"…","prompt":"…"}]
```

Erzeugt von `composeRoleSystemPrompt(roleId)`; der operative Block allein ist
`roleCommandBlock(roleId)`. v1 (der nackte Rollensatz) bleibt als Historie
bestehen – `docs/PLUGIN_PROMPT_MATRIX.md` dokumentiert den Wechsel.

**Planer-Rolle `moa` (globaler MOA/MCP-Planer):** `MOA_GLOBAL_SYSTEM_PROMPT` in
`promptRoles.ts`. Der Text stand vorher nur in dieser Doku; im Code fiel
`moaSystemPromptForPlugin('')` auf einen generischen Satz zurück. Aktiv wird der
Planer-Prompt über den Prompt-Store (`MOA_GLOBAL_PROMPT_KEY`), gespeist aus dem
Seed.

**Bild-/Video-Rollen (`imageHq`, `videoReal`, `videoAbstract`):** kein
LLM-Systemprompt, sondern der Bau-Vertrag der Prompt-Bauer – siehe §4.

## 2. Few-Shots

* Quelle: `promptRoles.fewShotsFor(roleId)` – **ein Beispiel je Kommando** aus
  `PLUGIN_COMMAND_CATALOG`, gedeckelt auf `MAX_FEW_SHOTS_PER_ROLE` (3).
* Eingabe: `PLUGIN_MOA_TASKS[roleId]` (bestehende deutsche Aufgabe) plus
  Kommandoname; Antwort: gültiger JSON-Plan (`{pluginId, command, prompt}`).
* Geprüft: jeder Few-Shot muss die echte Bewertung
  (`evalGrading.gradePlanAnswer`) mit ≥ 4/5 bestehen; das erste Beispiel exakt
  (5/5). Ein Few-Shot mit einem Kommando außerhalb des Katalogs macht
  `roleCoverageGaps()` rot.
* Kein Few-Shot ist ein erfundener Zielzustand: es gibt keine neuen Kommandos,
  keine neuen Rollen, keine neuen Marken – nur Katalog-Kommandos der eigenen
  Rolle.

## 3. MCP-Tools je Rolle

* Namen entstehen im `mcpRuntime` als `${pluginId}.${action}` aus genau dem
  Kommando-Katalog (`createDefaultMcpRuntime`). Der Katalog der Rolle und die
  registrierten Tools sind deckungsgleich (Test:
  `tests/promptCatalog.test.ts`).
* Der Server plant nur (`plugin.command`, `${rolle}.${kommando}`, Permission
  `WRITE`); die Audio-Ausführung passiert client-seitig über die
  `pluginCommandRegistry` – keine Fake-Audio-Tools.
* Bild/Video: `image.generate`, `image.img2img`, `image.keyframes`,
  `image.upscale`, `video_real.*`, `video_abstract.*` (Permission `EXECUTION`) –
  sie gehören zu den GPU-Rollen, nicht zu Plugin-Rollen.

## 4. Bild-/Video-Prompts (Bild-KI)

Bewusst **ohne** Sprachmodell: `buildVisionPrompt({text, style, bpm, energy,
moodTags})` und `buildMotionPrompt({…})` setzen den Prompt deterministisch aus
bestehenden Bausteinen zusammen:

* Stile: `VISION_STYLES` (realism, abstract, noir, comic, psychedelic,
  industrial, cosmic, fantasy, dystopia, geometry, liquid, fire) mit
  `VISION_STYLE_SUFFIX` (englisch, Bild) bzw. `motionStyleHintFor(style)`
  (englisch, Bewegung).
* Energie/Tempo steuern die Wortwahl (z. B. 140 BPM + energy 0.8 ⇒
  „explosive high energy“, „fast tempo“, „steam vents“-Bewegung).
* Grenzen: Bild-Prompt max. 1200 Zeichen, Bewegungs-Prompt max. 500 Zeichen;
  der Clip behält Motiv und Komposition („keep the subject and composition
  identical, no cuts, no text“).
* Ohne Eingaben greift ein neutraler Ambient-Prompt – kein Fehler, keine
  Erfindung.

## 5. Voice/Song-Generierung

* TTS: Text wird serverseitig gesäubert (`cleanVoiceText`, max. 500 Zeichen).
* Song: `SongGenerator` → HF MusicGen-Prompt `{prompt, style, bpm}`;
  Fallback lokaler Formant-Synth (kein Prompt-Engineering nötig).

## 6. Kontextfenster-Strategie

* Planungs-Prompts bleiben **< 2k Tokens** (kein langer Chat-Verlauf).
* Verlauf/Historie liegt clientseitig in `MoaHistory` (IndexedDB), wird dem
  LLM **nicht** erneut zugesendet.
* `maxTokens` je Task gedeckelt: Planung 1024, Voice/Describe 512, LLM-Router
  Default 256–1024 je Provider; der Iterations-/Eval-Aufruf nutzt 256.
* Kreative Tasks `temperature 0.7`, deterministische Planung/Eval `0.3` bzw. `0`.

## 7. Prompt-Versionen, Seed und Messung

* `promptStore.upsert()/hydrate()` versioniert je Rolle; die höchste aktive
  Version gewinnt und geht in den Plan-Prompt (`MoaAgent.plan`, INFRA-AI-003).
* `promptSeed.buildPromptEvalSeed()` erzeugt die DB-Zeilen
  (`system_prompts`, `plugin_prompt_versions`, Schema
  `database/ai_migration_002.sql`) für alle Rollen inkl. Planer. Fehlt ein
  Rollenprompt, wirft der Seed `MissingRolePromptError` – kein stiller Fallback.
* **Scores:** nur aus einem echten Lauf (`npm run eval:ai`,
  `npm run iterate:prompts --mode=effect`). Ohne erreichbares Modell lautet der
  Status **UNCHECKED**; erfundene oder „mock“-Scores sind unzulässig (Audit
  INFRA-AI-001).
* Offline-Zahlen (Struktur, Abdeckung, Few-Shots, Eval-Fälle) liefert
  `npx tsx scripts/seed-prompt-evals.ts` → `test-results/prompt-coverage.json`.

## 8. Sicherheitsregeln für Prompts

* Kein Prompt-Injection-Rauschen: Steuerzeichen werden entfernt
  (`cleanVoiceText`), Längenlimits überall.
* KI erhält keine Secrets/Keys; Server baut die finalen Requests.
* MCP-Tools nur über Registry mit Permission-Check – Prompts können keine
  beliebigen Kommandos erzeugen; ein erfundenes Kommando fällt im Grader auf 1/5
  zurück und damit unter jedes Gate.
