# Architektur-Audit: KI-Vermittlung, Prompts und Pipeline

**Repo:** `/home/patrick/audioMONASTRY` · **Branch:** `main` · **HEAD:** `902e9c3`
**Art:** reines Lese-Audit (kein Code-Umbau, kein Commit außer dieser Datei)
**Stand:** Erstellungslauf 2026-09-20

**Belegkonvention:** Jede Aussage trägt `pfad/zur/datei.ts:ZEILE`. Nicht geprüfte Punkte sind ausdrücklich als *NICHT GEPRÜFT* markiert. Es werden keine Modellnamen oder Zahlen erfunden; alle genannten Modell-IDs und Preise stammen wörtlich aus dem Code/Doku.

---

## Gliederung

1. [ROUTING: Provider-/Endpoint-Wahl in `LlmRouter.ts` und `aiMode.ts`](#1-routing)
2. [PIPELINE: Nutzeraktion → GPU (UI → Route → taskWorker → Python-Handler)](#2-pipeline)
3. [PROMPTS: Store, Matrix, Vision-Prompt, Versionierung, Tests](#3-prompts)
4. [MOA/AGENT: `MoaAgent.ts`, `moa_orchestrator.py`, `agentLoop.ts`, `agentRuns.ts`](#4-moaagent)
5. [SELBSTLERNEN: vorhandene Lernschleifen und ihr Schließungsgrad](#5-selbstlernen)
6. [SCHWACHSTELLEN: tote Module, fehlende Bewertung, Doku-Drift, Tests](#6-schwachstellen)
7. [Kernbefunde nach Schwere](#7-kernbefunde-nach-schwere)

---

## 1. ROUTING

### 1.1 Registrierung der Provider

`LlmRouter` ist ein Modul-Singleton (`src/core/ai/LlmRouter.ts:478`) und registriert im Konstruktor in fester Reihenfolge (`src/core/ai/LlmRouter.ts:398-419`):

| # | Zeile | Provider-ID | Klasse / Endpoint | Verfügbarkeitsbedingung |
|---|-------|-------------|-------------------|--------------------------|
| 1 | :400 | `runpod-local` | `RunPodLocalProvider` | s.u. 1.3 |
| 2 | :401 | `mistral` | `OpenAiCompatibleProvider` (`api.mistral.ai`) | `MISTRAL_API_KEY` (`LlmRouter.ts:161-163`) |
| 3 | :402 | `ollama` | `OllamaProvider` (`/api/chat`) | `OLLAMA_URL` **oder** `OLLAMA_MODEL` (`LlmRouter.ts:185-187`) |
| 4 | :403 | `deepseek-flash` | OpenAI-kompatibel (`api.deepseek.com`) | `DEEPSEEK_API_KEY` |
| 5 | :404 | `deepseek-pro` | OpenAI-kompatibel (gleicher Endpoint) | `DEEPSEEK_API_KEY` |
| 6 | :407 | `publicai` | OpenAI-kompatibel (`PUBLICAI_BASE_URL` oder Default `https://api.publicai.co/v1`) | `PUBLICAI_KEY` |
| 7 | :410 | `cerebras` | OpenAI-kompatibel (`api.cerebras.ai`) | `CB_API_KEY` |
| 8 | :412 | `openrouter` | OpenAI-kompatibel (`openrouter.ai/api/v1`) | `OR_API_KEY` |
| 9 | :415-418 | `gemini`, `openai` | nur wenn `AI_EMERGENCY_PROVIDERS === 'true'` | `GEMINI_API_KEY` / `OPENAI_API_KEY` |

Die Registrierungsreihenfolge bestimmt **nicht** die Nutzungsreihenfolge — diese legt ausschließlich `rankProviders()` fest (1.2). Das ist eine unnötige Doppelquelle; die Registrierung ist nur ein Set (`this.providers.set(...)`, `LlmRouter.ts:422`), die Ordnung dort ist irrelevant. Kommentar und Realität weichen aber auseinander: Kopfkommentar `LlmRouter.ts:4-18` beschreibt eine Kosten-Priorität („1. SCHNELL Cerebras … 2. GÜNSTIG DeepSeek …“), der Code setzt `runpod-local`/`ollama` immer an Position 1-2 (1.2). Der Kommentar ist in `:23-25` nachträglich relativiert, bleibt aber als Widerspruch stehen → **Doku-Drift** (siehe §6).

### 1.2 Prioritätsliste und Verfügbarkeitsprüfung

`rankProviders(complexity)` (`src/core/ai/LlmRouter.ts:437-449`) ist die einzige Auswahlstelle. Drei feste Ordnungen:

- `complex` (`:440`): `runpod-local, ollama, cerebras, deepseek-pro, deepseek-flash, openrouter, mistral, publicai, gemini, openai`
- `moderate` (`:442`): `runpod-local, ollama, cerebras, deepseek-flash, openrouter, mistral, publicai, deepseek-pro`
- `simple` (`:443`): `runpod-local, ollama, cerebras, deepseek-flash, mistral, openrouter, publicai`

Verfügbarkeitsprüfung in drei Stufen:
1. `filter((id) => allowExternal || LOCAL_LLM_PROVIDERS.has(id))` (`:446`) mit `allowExternal = envKey('AI_ALLOW_EXTERNAL_LLM') === 'true'` (`:444`). `LOCAL_LLM_PROVIDERS = {'runpod-local','ollama'}` (`:102`).
2. `.map((id) => this.providers.get(id))` (`:447`) — nicht registrierte IDs werden zu `undefined`.
3. `.filter((p): p is ILlmProvider => Boolean(p) && p.available)` (`:448`).

**Kernbefund R-1 (Default-Konfiguration ohne Netz):** Ohne `AI_ALLOW_EXTERNAL_LLM=true` und mit nicht verfügbarem RunPod-Brain bleibt effektiv nur `ollama`. Da `OllamaProvider.available` bereits bei gesetztem `OLLAMA_URL` **oder** `OLLAMA_MODEL` `true` ist (`LlmRouter.ts:185-187`) — ohne Erreichbarkeitsprüfung — kann `rankProviders` einen Provider als verfügbar melden, der nicht antwortet. Der Fehler fällt erst in `complete()` (`:457`) und wird nur als „alle Provider fehlgeschlagen“ sichtbar.

**Kernbefund R-2 (Fallback ist stumm):** Die Fallback-Kette in `complete()` (`:451-463`) probiert sequenziell und fängt **jeden** Fehler (`catch { lastError = error }`, `:458-460`). Es gibt keine Telemetrie pro Fehlversuch, keine Latenz-/Kostenrücksicht: ein toter `runpod-local`-Call kostet erst einen vollen Netzwerk-/Poll-Zyklus (1.4), bevor `ollama` drankommt.

### 1.3 `runpod-local`: zwei Betriebsarten und ihr Verfügbarkeitsbruch

`RunPodLocalProvider` (`src/core/ai/LlmRouter.ts:260-378`):

- **OpenAI-kompatibler Weg** (aktiv, wenn `RP_BRAIN_OPENAI_URL` oder `RUNPOD_BRAIN_OPENAI_URL` gesetzt, `:286-288`): `POST <url>/chat/completions` (`:331`), Modell aus `RUNPOD_BRAIN_OPENAI_MODEL` → `RP_BRAIN_OPENAI_MODEL` → `RUNPOD_BRAIN_MODEL` → Default `OPENAI_COMPAT_BRAIN_MODEL_DEFAULT` (`:312-313`, Konstante `:75`).
- **Nativer Weg** (Default): `RunPodProvider('brain').run('llm', model, {...})` (`:370-375`). Modellwahl: `simple` → `RUNPOD_EXECUTOR_MODEL` oder `qwen3-4b` (`:316`); sonst `RUNPOD_BRAIN_MODEL` oder Default `qwen3-14b` (`:318`, `:86`).

`available` (`:290-293`): beim OpenAI-kompatiblen Weg wird nur ein API-Key (`RP_AGENT_KEY || RP_API_KEY || RUNPOD_API_KEY`) geprüft — **keine** Erreichbarkeits-/Modellprüfung. Beim nativen Weg wird `this.brainProvider().available` delegiert.

**Kernbefund R-3 (Namen-Mismatch als echter Ausfall dokumentiert):** `LlmRouter.ts:64-75` hält live belegte Fehlerhistorie fest: Der Endpoint lehnt `qwen3-14b` mit `The model ... does not exist.` / `NotFoundError` / HTTP 404 ab, weil der OpenAI-kompatible Worker den HF-Namen serviert. Der Kommentar nennt explizit die Folge „aufrufende Features fielen STILL auf lokale Ersatzpfade zurück“ (`:72-73`). Der Fix ist eine Konstante, kein Test — siehe §6.
Zusätzlich (`:278-285`) dokumentiert: vorher prüfte `available` beide Env-Schreibweisen, `complete` nur `RUNPOD_` → Provider galt als verfügbar, der Aufruf landete im falschen Worker-Pfad. Auch dies ist „per Kommentar gefixt“, nicht per Test.

### 1.4 Timeouts

**Kernbefund R-4 (keine expliziten Timeouts im LLM-Pfad):** In `LlmRouter.ts` gibt es **kein** `AbortController`, `signal`, `timeout` oder `AbortSignal.timeout`. `postJson` (`:109-115`) nutzt ein nacktes `fetch` ohne Signal. Die einzigen Zeitsteuerungen liegen außerhalb:
- `RunPodProvider.run(...)` (nativer Weg) — Polling/Timeout dort zu prüfen (§2).
- `circuitBreaker.ts` (`src/core/ai/orchestrator/circuitBreaker.ts`) — nur in der Orchestrator-Schicht, **nicht** in `LlmRouter.complete()` verdrahtet (siehe §2/§6).

Konsequenz: Ein hängender Provider blockiert die Fallback-Kette bis zum Browser-/Node-Fetch-Default-Timeout.

### 1.5 `aiMode.ts` — was es tatsächlich steuert

**Kernbefund R-5 (Namens-Irreführung):** `src/core/ai/aiMode.ts` (17 Zeilen) ist **kein** OFF/AI/PRO-Modus und hat **keinen** Bezug zu `LlmRouter`. Es ist ein einzelnes Modul-Boolean (`let aiModeActive`, `:9`) mit Getter/Setter (`:11-17`). Der Kommentar `:4-6` beschreibt den Zweck präzise: Es erlaubt dem mixerMONK-Halter den Lock-Takeover, solange das aiMONK-Modul nicht OFF ist. Es beantwortet also die Frage „darf der AI-Lock den Halter übernehmen“, nicht „welcher Provider wird gewählt“. Die Frage-Aussage „wie greift aiMode.ts auf LlmRouter zu“ ist mit dem Code nicht zu belegen: **es gibt keine Kante `aiMode.ts → LlmRouter.ts`** (grep siehe §6).

Der tatsächliche OFF/AI/PRO-Modus ist der **Modul-State** `'OFF' | 'AUTO_AI' | 'PRO'` (`src/context/ModuleStateContext.tsx:13`). Die Kante zu `aiMode.ts` besteht aus genau zwei Zeilen, beide im Modul-State-Handler:

- `src/context/ModuleStateContext.tsx:85`: `if (id === 'ai') setAiModeActive(state !== 'OFF');` (lokaler Setter)
- `src/context/ModuleStateContext.tsx:204`: dieselbe Zeile im Peer-Update-Handler (fremde Zustandswechsel)

**Also:** `aiMode.ts` ist ein *Boolescher Sichtbarkeits-/Lock-Flag*, kein Provider-Schalter. Es gibt **keine** Kante `aiMode.ts → LlmRouter.ts` und **keine** Zuweisung, die den Modul-State `PRO` oder `AUTO_AI` an `LlmRouter` weiterreicht. Wer `PRO` wählt, ändert damit **nicht** die Provider-Auswahl — die hängt allein an `process.env` (`LlmRouter.ts:444`) und `complexity` (`LlmRouter.ts:437-443`). Das ist eine offene Lücke gegenüber der Erwartung „PRO = bessere Modelle“.

----

## 2. PIPELINE

### 2.1 Der Weg einer Nutzeraktion (Sprach-/UI-Befehl) bis zum Ausführungsort

```
UI/Sprachbefehl
  └─ pluginCommandRegistry.ts:175-178   'ai'/'plan' → controlBus.emit('monk:ai-plan', { text })
       └─ (UI-Listener) → VoiceControlService.runTask → AiAgentLoop.runTask
            ├─ agentLoop.ts:34-45   assembleAgentContext()  (routing.json + sessionState, gekappt auf 2000 Zeichen)
            └─ MoaAgent.run(task, { context, confirmWrite, maxCorrections })
                 ├─ MoaAgent.ts:256-293  plan()    → EIN LLM-Call (completeLlm → /api/ai/complete → llmRouter)
                 ├─ MoaAgent.ts:327-377  executePlanGated()  ← WRITE-Gate + Abbruch
                 └─ MoaAgent.ts:394-453  runPlan()  → Korrekturrunde (max. 1 Default)
```

Ausführungsort eines Schritts ist **nicht** der Server, sondern der Client-Registry:

- `MoaAgent.ts:362-366` → `voiceControlService.executePluginCommand(userId, pluginId, command)`
- `VoiceControlService.ts:173` exakter Action-Match → `:179-187` Keyword-Match mit Score → `:188-211` **Cerebras-NLU-Fallback** für freie Sprache
- Der Handler selbst ist ein Plugin-Kommando, z. B. `pluginCommandRegistry.ts:163-166` (`song.generate` → `controlBus.emit('monk:song-generate')`) oder `:191-196` (`mixer.fade_in_main` → `audioEngine.fadeChannelToMain`)

Konsequenz: Der Loop plant auf **Server-Seite** (LLM), führt aber **Client-seitig** aus. Der Server kennt die Wirkung eines Schritts nicht.

### 2.2 HTTP-Schienen und ihre Queue-/Blockade-Eigenschaften

| Route | Datei:Zeile | Verhalten |
|---|---|---|
| `POST /api/ai/complete` | `server/routes/aiRoutes.ts:640-666` | synchron, wartet auf `llmRouter.complete`; 502 bei Fehler |
| `POST /api/ai/agent/runs` | `server/routes/agentRoutes.ts:39-60` | **202 + Sofortzustand**; `runner.begin()` kehrt sofort zurück (`agentRuns.ts:200-213`) |
| `GET /api/ai/agent/runs/:runId` | `agentRoutes.ts:71-79` | Zustandsabfrage (Polling durch den Client) |
| `POST /api/ai/agent/runs/:runId/cancel` | `agentRoutes.ts:81-88` | kooperativer Abbruch (`agentRuns.ts:299-315`) |
| `POST /api/ai/orchestrate` | `server/routes/aiRoutes.ts:673-716` | synchron; Job über `aiOrchestrator.orchestrate` |
| `POST /api/ai/generate-drop` | `aiRoutes.ts:580-637` | 3-stufig: `llmRouter` → Ollama → **deterministischer lokaler Generator** (`:634-636`) |
| `POST /api/ai/vision`, `/video`, `/clip` | `aiRoutes.ts:259-329`, `:333-375`, `:384-464` | synchron, GPU-Roundtrip |
| `POST /api/ai/mcp/tools/:name` | `aiRoutes.ts:793-804` | MCP-Werkzeug, u. a. `agent.orchestrate` (`mcpRuntime.ts:137`) → erreicht den Python-MoA |

Queueing passiert an zwei Stellen, die **nichts voneinander wissen**:

1. **Server-Job-Manager:** Concurrency-Slots je Task (`jobManager.ts:181` `running < limits[task]`, `:192` Inkrement, `:254-259` Freigabe). `agent.orchestrate` bekommt Slot-Limit 2 (`jobManager.ts:70`). Laufzeitdeckel über `jobTimeoutMs` (`aiOrchestrator.ts:132`) und `AbortSignal` (`aiOrchestrator.ts:125-130`).
2. **`services/taskWorker.ts`:** eine **Datei-basierte Legacy-Queue** (`TASK_QUEUE.json`), Poll-Intervall 10 s (`taskWorker.ts:88-90`), **ein** Task pro Tick (`:47` `find(pending)`), HTTP-POST an `BACKEND_URL` mit `AXIOS_TIMEOUT_MS` Default 120 000 (`:10`, `:58-68`).

**Kernbefund P-1 (zwei Pipelines ohne gemeinsame Kante):** `taskWorker.ts:15` kennt nur `'separate-stems' | 'generate-voice' | 'apply-fx' | 'render'`. **Kein** AI-/LLM-/MoA-Task-Typ ist dort definiert. Die KI-Vermittlung läuft ausschließlich über die HTTP-Routen des Express-Servers (`server/routes/*`, `server.ts`) direkt in den Node-/Python-Worker — nicht über den Task-Worker. Der Nutzen von `taskWorker.ts` für die KI-Kette ist **nicht belegt**; er ist formal ein paralleler Pfad.

**Kernbefund P-2 (Blockade-/Timeout-Asymmetrie):** Der Orchestrator-Pfad hat Zeitlimits (`runpodProvider.ts:134-136` `RUNPOD_AI_TASK_TIMEOUT_MS` Default 600 000, `:322-326` `AbortSignal.timeout`, `:342-371` Polling mit Deadline, `:299`/`:371` klare `TIMEOUT`-Fehler). Der **Router-Pfad hat keines** (§1.4). Ein über `/api/ai/complete` angestoßener Provider-Call hat daher keinen Server-seitigen Deckel außer dem HTTP-Client des Aufrufers.

**Kernbefund P-3 (Rollen-Polling im Brain-Call):** `RunPodLocalProvider.complete` geht über `run('llm', …)` (`LlmRouter.ts:370-375`). `llm` steht in `LONG_RUNNING_TASKS` (`endpointRegistry.ts:243-245`) → der Provider pollt, d. h. die **Fallback-Kette in `LlmRouter.complete` hängt hinter einem Poll-Zyklus**. Bei kaltem Worker sind das laut Kommentar `endpointRegistry.ts:239-241` zweistellige GB Gewichte.

### 2.3 Die Echtzeit-/Audio-Grenze

Regel aus `AGENTS.md:151-152`: *„No network, storage, React state update or blocking lock operation inside `process()`. Time-critical DSP must use the existing AudioWorklet/WASM/audio backend boundaries.“* Ergänzend `AGENTS.md:25` (sub-millisecond).

**Geprüft und eingehalten (Stichprobe, nicht vollständig):**

- Kein `fetch`/`XMLHttpRequest` in `process()`. Der einzige Netz-Treffer in den Worklets ist `src/audio/worklets/spatialProcessor.ts:297` — er liegt im **Message-Handler** (`case 'loadHRTFWasm'`, `:290-305`), nicht im Render-Quantum (`process()` beginnt erst `:395`). Damit ist die Grenze hier korrekt gezogen.
- Der KI-Pfad selbst berührt den Audio-Thread nicht: alle LLM-/GPU-Aufrufe laufen in Express-Handlern bzw. im Client-Haupt-Thread über `fetch` (`clientLlm.ts:10-21`).
- Der Audio-Zugriff der Kommandos ist ein API-Aufruf über `audioEngine` (`pluginCommandRegistry.ts:72-73`, `:195`, `:207-212`), kein direkter Puffer-Eingriff.

**Kernbefund P-4 (Wirkung, nicht Thread-Verletzung):** `pluginCommandRegistry.ts:199-214` (`drop.auto_drop`) lädt einen Track **asynchron** (`:207 await audioEngine.loadTrackSample`) und triggert ihn dann bar-synchron (`:209-212 scheduleAtNextBar`). Das ist technisch sauber (Trigger-Zeitpunkt liegt auf der Bar, `audioEngine.ts:1022`), aber der Planer erfährt **kein** Ergebnis dieser Asynchronität — `executePluginCommand` gibt nur `{handled}` zurück (`VoiceControlService.ts:164-169`). Ein Lade-Fehlschlag nach erfolgreichem `handled` ist für den Agent-Loop unsichtbar.

### 2.4 Python-Seite (Worker)

- Wire-Protokoll: `POST {task, model, input}` (`app.py:212-227`), Task-Whitelist per Regex (`app.py:230-231`), Dispatch über `STATE.manager.infer` (`app.py:248`).
- Task-Normalisierung: `audio.classify` → `classify` (`handlers.py:128-134`).
- Handler-Registry: `handlers.py:575-590`, u. a. `llm → qwen3_llm` (`:584`), `agent.orchestrate → moa_orchestrate` (`:589`).
- RunPod-Einstieg: `runpod_worker.py:334-364` (`handler(job)`), Sondertasks `warmup`/`predownload` (`:353`, `:362`).
- Rollen-Manifest: `endpointRegistry.ts:213-232` (`orchestrator`, GPU-Pool `AMPERE_48`, Preload `qwen3-4b`, `qwen3-8b`) mit Drift-Test `tests/manifestRoles.test.ts` — die **einzige** im Audit gefundene belastbare Drift-Absicherung zwischen TS und Python.

----

## 3. PROMPTS

### 3.1 Prompt-Store

`src/core/ai/orchestrator/promptStore.ts` (85 Zeilen) ist ein **In-Memory-Store**:

- Datenmodell `SystemPrompt` mit `version`, `enabled`, `meta` (`:9-18`)
- `upsert()` vergibt bei fehlender Angabe `highestVersion + 1` (`:30`), setzt `active` nur bei `enabled` (`:43`)
- `getActive()` (`:48-51`), `listVersions()` neueste zuerst (`:54-58`), `highestVersion()` (`:60-63`)
- `disable()` wechselt die aktive Version nur, wenn sie betroffen ist (`:66-77`) — inkl. `active.delete`, wenn keine aktive Version bleibt
- `exportJson()` (`:80-82`), Singleton `promptStore` (`:85`)
- Kopfkommentar `:4-6`: Persistenz soll über Supabase `system_prompts` / `plugin_prompt_versions` (`database/ai_migration_002.sql`) laufen

**Kernbefund PR-1 (Versionierung ohne Leser):** `promptStore` wird **außerhalb von Tests und `scripts/iterate-prompts.ts` von keiner Produktionsdatei importiert** — insbesondere **nicht** von `MoaAgent.ts` oder `LlmRouter.ts`. `MoaAgent.plan` holt seinen Systemprompt direkt aus der Konstante: `moaSystemPromptForPlugin(pluginId)` (`MoaAgent.ts:260`) bzw. `moaCommandCatalog()` (`:259`). Ergebnis: Eine im Store angelegte und „optimierte“ Prompt-Version (`promptIteration.ts:101-103`) erreicht **nie** einen echten LLM-Aufruf. Die Versionierung ist damit strukturell korrekt, aber wirkungslos.

### 3.2 Seed / Katalog

- `promptSeed.ts:16-20` `PLUGIN_IDS` = **18** IDs (16 MONKs + `ai`, `perfor`)
- `buildPromptEvalSeed()` (`:43-60`) erzeugt je Plugin einen `system_prompts`- und einen `plugin_prompt_versions`-Datensatz, jeweils `version: 1`, `enabled: true`, Inhalt aus `PLUGIN_MOA_SYSTEM_PROMPTS` bzw. `PLUGIN_COMMAND_CATALOG`
- Fallback-Text, wenn kein Systemprompt existiert: `promptSeed.ts:49`
- **Doku-Drift:** Der Funktionskommentar `promptSeed.ts:42` sagt „für alle **21** Plugins“ — `PLUGIN_IDS` hat 18 (`:16-20`), und `tests/promptMatrix.test.ts:36-37` fixiert korrekt `18`.
- Katalogquelle: `src/utils/prompts.ts` — `HYPERSONIC_MOA_SYSTEM_PROMPTS` (`:3`), `PLUGIN_COMMAND_CATALOG` (`:30-51`), `PLUGIN_MOA_SYSTEM_PROMPTS` (`:58`), `PLUGIN_MOA_TASKS` (`:81`), `moaTaskForPlugin` (`:105`), `moaCommandCatalog` (`:110-115`), `moaSystemPromptForPlugin` (`:117-119`). `PLUGIN_COMMAND_CATALOG` hat **21** Schlüssel (inkl. `transport` `:31` und `midi-controller` `:50`), die nicht Teil der 18 kanonischen Plugin-IDs sind — `transport` ist im Router als eigener Satz registriert (`pluginAudioRouter.ts` kennt `transport` nicht; `pluginCommandRegistry.ts:49-62` registriert `transport` separat).

### 3.3 Vision-Prompt

`src/core/ai/vision/visionPrompt.ts`:

- `VISION_STYLES` (`:9-24`) ist die geschlossene Stil-Menge; `VisionStyle` wird daraus abgeleitet (`:24`)
- `VISION_STYLE_SUFFIX: Record<VisionStyle, string>` (`:27-40`) — vollständige Abbildung, kein Default-Zweig nötig
- Harte Längengrenze `MAX_PROMPT = 1200` (`:54`)
- `energyWord()` in 4 Stufen (`:61-64`), bedingte Bausteine nur bei endlichen Eingaben (`:80-85`): `energy` → Wort, `bpm` → drei Tempo-Klassen (≥140 / ≥110 / sonst), `style` → Suffix
- `suggestVisionStyle()` (`:107-114`) ist eine reine Heuristik aus `energy` × `bpm` → **kein** Modell, **keine** Historie
- `MOTION_STYLE_HINT` (`:117`) + `buildMotionPrompt()` (`:146`)

Die Vision-Selbstlern-Kante läuft **nicht** über diese Datei, sondern über `visualFeedback.ts` (siehe §5.5).

### 3.4 Doku gegenüber Code

- `docs/AI_PROMPTS.md:9-14` beschreibt den Kern-Prompt korrekt inhaltsgleich zu `LlmRouter.plan` (`LlmRouter.ts:471-474`) und `MoaAgent.plan` (`MoaAgent.ts:266-271`).
- **Drift A:** `docs/AI_PROMPTS.md:25` nennt `maxTokens=1024`. `MoaAgent.plan` setzt `maxTokens: 1536` (`MoaAgent.ts:276`) — mit Begründung im Kommentar `:273-275` (Reasoning verbraucht Tokens, bei 1024 kam „NUR der Denktext“ an). Die Doku ist älter als der Fix.
- **Drift B:** `docs/AI_PROMPTS.md:7` überschreibt den Abschnitt mit „MOA/MCP-Planer (DeepSeek V4 Flash)“. Der Plan-Call läuft mit `complexity: 'moderate'` (`MoaAgent.ts:272`), und für `moderate` steht `runpod-local` an Position 1, `ollama` an 2 (`LlmRouter.ts:442`). Ohne `AI_ALLOW_EXTERNAL_LLM=true` ist DeepSeek **gar nicht zugelassen** (`LlmRouter.ts:444-446`). Der Doku-Titel beschreibt damit den nicht-Default-Fall als Normalfall.
- **Drift C:** `docs/AI_PROMPTS.md:30` nennt „17 Plugin-IDs“; Code = 18 (§3.2).
- **Drift D (gravierend):** `docs/PLUGIN_PROMPT_MATRIX.md:3` behauptet „**21 Plugins**“ und listet (`:10-30`) IDs, die im Code **nicht existieren**: `masterplayer, instrument, synthesizer, drum, sampler, mcp, controller, library, mastering, recording, performance`. Die kanonischen IDs sind `mixer, drop, song, effect, syntisampler, drumsampler, instru, biblio, voice, sound, stem, spatial, eq, dsp, master, record, ai, perfor` (`pluginCommandRegistry.ts:20-24`, `promptSeed.ts:16-20`, `evalMatrix.ts:15-19`, `pluginAudioRouter.ts:34-54`). Namensabbildung: `synthesizer≠syntisampler`, `drum≠drumsampler`, `instrument≠instru`, `library≠biblio`, `mastering≠master`, `recording≠record`, `performance≠perfor`, `mcp` ist kein Plugin (MCP-Funktionen liegen in `syntisampler`, vgl. `pluginCommandRegistry.ts:64-67`), `masterplayer` ist ein System-Modul.
- **Drift E:** Die Score-Spalte in `docs/PLUGIN_PROMPT_MATRIX.md:10-30` steht durchgehend auf `5.00 | ✅ PASS`. Das ist exakt die Ausgabe von `scripts/eval-ai.ts`, dessen Score hart auf `5` gesetzt wird (siehe §6.2) — die Matrix dokumentiert damit eine Zahl, die nichts gemessen hat. Der Min-Score stimmt dagegen mit `evalMatrix.ts` überein (kritisch = `mixer, master, eq, dsp` → 4.5, `evalMatrix.ts:40-43`).

### 3.5 Tests

| Test | Datei:Zeile | Prüft |
|---|---|---|
| `promptCatalog.test.ts` | `:18-24` | je Router-ID: Katalog, Systemprompt-Länge > 20, Task-Länge > 5 |
| | `:26-33` | 16 Registry-IDs ⊆ Router-IDs |
| | `:35-40` | `moaCommandCatalog()` enthält jede Router-ID |
| `promptMatrix.test.ts` | `:17-23` | Katalog + Prompt + Task für 18 IDs vorhanden |
| | `:25-32` | Katalogtexte nicht leer, kein `undefined`/`null` |
| | `:34-46` | Seed hat 18+18 Einträge, alle `enabled`, Inhalte nicht leer |
| | `:48-68` | Eval-Suite je Plugin ≥ 1 Datensatz und Ø ≥ 4 |
| `aiPromptEval.test.ts` | `:5-22` | `PromptStore`: Versionen, `getActive`, `disable`-Wechsel |
| | `:24-34` | `EvaluationStore`: `averageScore`, `finishRun` PASS/FAIL |

Bewertung: Das sind **Struktur-/Bestandstests** (Existenz, Länge, Vollständigkeit). Keiner davon prüft, ob ein LLM mit diesen Prompts ein *korrektes* Ergebnis liefert. `promptMatrix.test.ts:48-68` ist der problematischste Fall: Der Test erzeugt seine Scores selbst (`score: 5`, `:60`), gibt sie in den Store und behauptet anschließend `avgScore ≥ 4` und Status `PASS` (`:65-66`) — er testet den Store gegen seine eigene Eingabe, nicht das System (§6.5).

----

## 4. MOA/AGENT

### 4.1 Zwei voneinander unabhängige „MoA"-Implementierungen

Der Begriff „Mixture-of-Agents" ist im Repo zweimal belegt, mit **unterschiedlichem Aufbau, unterschiedlichem Schema und ohne gemeinsamen Code**:

| | TypeScript | Python |
|---|---|---|
| Datei | `src/core/ai/MoaAgent.ts` (480 Z.) | `services/audiomonastry-ai-runtime/moa_orchestrator.py` (552 Z.) |
| Schritte | **1** LLM-Call (`MoaAgent.ts:264-279`) | Classifier → Planner A + Planner B → Aggregator (`moa_orchestrator.py:499-527`) |
| Modelle | ein Rollen-Endpoint `brain` (`LlmRouter.ts:370`) | 4 Rollen, 2 Modelle (`moa_orchestrator.py:42-47`) |
| Plan-Schema | `[{pluginId, command, prompt}]` (`MoaAgent.ts:269`) | `{"steps":[{tool, args, why}]}` (`moa_orchestrator.py:95`) |
| Ausführung | Client-Registry (`MoaAgent.ts:362-366`) | MCP-Brücke zu Fach-Instanzen (`moa_orchestrator.py:451-459`) |
| Merge | nur Korrektur-Ersatz (`MoaAgent.ts:460-477`) | A/B/merged mit Dedupe (`moa_orchestrator.py:337-355`) |

Die Python-Seite ist damit die **einzige echte MoA-Architektur** (mehrstufig, zwei unabhängige Pläne, Aggregation). Die TS-Seite heißt ebenso, ist aber ein Single-Prompt-Planer mit Korrekturschleife. Erreichbar ist die Python-Seite über `mcpRuntime.ts:137` (`agent.orchestrate`, Modell `qwen3-4b`) → `POST /api/ai/mcp/tools/agent.orchestrate` (`aiRoutes.ts:793-804`) → Provider `orchestrator` (`endpointRegistry.ts:213-232`). **Ein direkter Aufruf der Python-MoA aus dem Agent-Loop oder aus `MoaAgent` existiert nicht.**

### 4.2 MoaAgent (TS) im Detail

**Planen** (`MoaAgent.ts:256-293`): ein `completeLlm`-Call mit
`{role} + Katalogzwang + JSON-Formvorgabe + optionaler Kontext (gekappt 2000 Zeichen)` (`:266-271`),
`complexity: 'moderate'`, `maxTokens: 1536`, `temperature: 0.3`, `reasoningEffort: 'low'` (`:272-278`), umhüllt von `withTimeout(…, timeoutMs)` (`:264`, `:279`).

**Zeitlimit:** `withTimeout` (`:181-194`) ist reines `Promise.race` — es **bricht den darunterliegenden Call nicht ab** (kein `AbortSignal`). Bei Ablauf bleibt der Netzwerk-/Poll-Vorgang laufen; nur das Ergebnis wird verworfen. Default `DEFAULT_PLAN_TIMEOUT_MS = 45_000` (`:213`), überschreibbar via `AI_AGENT_PLAN_TIMEOUT_MS` (`:263`) — mit dokumentiertem Anlassfall: mit `AI_AGENT_PLAN_TIMEOUT_MS=240000` brach ein Kaltstart trotzdem nach 45 s ab, weil der Konstruktor-Default die Env unwirksam machte (`:240-245`).

**Parsen:** `parseMoaSteps` (`:140-170`) entfernt Code-Fences (`:142-144`), schneidet auf den ersten `[ … ]`-Block (`:149-151`, indexbasiert statt Regex wegen Sonar S8786, `:147-148`), kappt Felder (`pluginId` 64, `command` 200, `prompt` 2000, `:160-162`) und die Schrittzahl auf **16** (`:166`). Bei Parse-Fehler `[]` (`:167-168`).

**Ausführen mit Gate** (`:327-377`): je Schritt
1. Wiederaufnahme-Skip (`:344`),
2. Abbruch **vor** dem Schritt (`:346` → `cancelled = true; break`),
3. READ/WRITE-Klassifikation: `isWriteCommand` (`:133-137`) – fail-safe, alles außer `status/search/get/list` (`:126`) gilt als WRITE; Executor darf `isReadOnly?` überschreiben (`:356`),
4. ohne Bestätigung → `handled: false, error: 'WRITE nicht bestätigt'` (`:357-359`),
5. sonst `executePluginCommand` bzw. `execute` (`:362-366`), danach `onStep`-Callback (`:374`).

**Prüfen/Korrigieren** (`runPlan`, `:394-453`): Schleife `while (!cancelled && (hasFailures || planIsEmpty) && corrections < maxCorrections)` (`:416`), Default `maxCorrections = 1` (`:400`). Zwei Sonderfälle sind explizit gebaut: ein **leerer Plan** zählt als Fehlschlag und bekommt einen Ersatz-Prompt (`:415`, `:419-422`), und ein brauchbarer Ersatzplan wird übernommen (`:429-432`). Anlassfall im Kommentar: Lauf meldete „succeeded" bei null Schritten (`:411-414`).

**Merge** (`:460-477`): **positional** — fehlgeschlagene Ergebnisse werden der Reihe nach durch die Korrekturergebnisse ersetzt, überzählige angehängt. Es wird **nicht** nach `pluginId`/`command` zugeordnet. Liefert der Korrekturplan dieselben Schritte in anderer Reihenfolge, werden Ergebnisse falsch zugeordnet. Kein Test deckt diese Ordnungsannahme ab (siehe §6.5).

**Kosten** (`:202-206`, `:388`, `:440`): `chars/4/1000 × AI_AGENT_COST_PER_1K_USD` (Default 0.0002), getrennt nach Planung/Korrektur, immer `estimated: true`. Der Router liefert keinen Preis — die Zahl ist ausdrücklich eine Schätzung.

### 4.3 `agentLoop.ts` und `agentRuns.ts`

`agentLoop.ts` (69 Z.): `assembleAgentContext` (`:34-45`) baut einen kompakten, deterministischen String aus `routing.global`, `routing.tracks.length`, `routing.buses`, `routing.connections.length` und `session` (JSON), hart gekappt auf 2000 Zeichen (`:44`) — deckungsgleich mit dem Prompt-Limit in `MoaAgent.plan` (`:270`). `AiAgentLoop.runTask` (`:51-68`) injiziert Defaults (`userId: 'localUser'` `:63`) und reicht `confirmWrite`/`maxCorrections` durch. Der Einstieg ist bewusst eine **testbare Bibliotheksfunktion ohne UI-Bindung** (`:12-13`).

`agentRuns.ts` (380 Z.) macht den Loop wiederaufnehmbar:
- `AgentRunStore` (`:100-138`) schreibt je Lauf eine JSON-Datei, Verzeichnis aus `AI_AGENT_RUN_DIR` oder `tmpdir()` (`:140-149`), Dateiname per Sanitizing (`:104`). `list()` sortiert neueste zuerst (`:129`), kaputte Dateien werden ignoriert (`:127`). **Kein Lock, kein atomares Schreiben** – zwei Prozesse auf demselben Verzeichnis würden sich überschreiben.
- `ResumableAgentRunner` (`:166-379`): `begin()` legt an und startet den Loop im Hintergrund (`:200-213`), `cancel()` setzt das Flag, ruft `controller.abort()` und **wartet** auf das Ende (`:299-315`), `resume()` benutzt **den Originalplan** statt neu zu planen (`:16-20`, `:276-297`) — mit `startIndex`/`priorResults` (`:344-345`), gelesen aus `record.executedCount`/`record.steps`.
- `succeeded`-Ableitung: `status: result.cancelled || cancelRequested ? 'cancelled' : (result.succeeded ? 'done' : 'failed')` (`:360`) — ein Abbruch wird nicht als Erfolg verbucht.

### 4.4 `moa_orchestrator.py` im Detail

**Modellset** (`:42-47`): `classifier qwen3-4b`, `planner_a qwen3-8b`, `planner_b qwen3-4b`, `aggregator qwen3-8b`; Env-Overrides `MOA_CLASSIFIER_MODEL` / `MOA_PLANNER_A_MODEL` / `MOA_PLANNER_B_MODEL` / `MOA_AGGREGATOR_MODEL`. Auflösung über `resolve_moa_models()` (`:120-126`). Die VRAM-Rechnung ist offen dokumentiert (25 GB bei 42 GB nutzbar, `:36-41`) und deckt sich mit `endpointRegistry.ts:228-231`.

**Tool-Katalog** (`:53-74`): 20 Tools über 6 Rollen. `protocol: 'comfyui'` für music/image/video (`:64-73`), der Rest nutzt `{task, model, input}` (`:410`). Rollen-Env `:77-84` (Spiegel von `endpointRegistry.ts`).

**Robustheit (der belegenste Teil des Moduls):**
- `_json_candidates` (`:129-150`) mit `prefer='dict'|'list'` — Reihenfolge wird je Aufrufer gedreht, mit begründetem Live-Fall (`:137-139`: bei Prosa + `[ {...} ]` gewann sonst das erste innere Objekt und der Plan schrumpfte auf einen Schritt).
- `parse_steps` (`:212-228`) verwirft Tools, die nicht im Katalog stehen (`:224-225`).
- `planner_report` (`:231-261`) weist einen nicht-leeren Text ohne gültigen Schritt als `suspicious` aus und legt einen 200-Zeichen-Auszug bei (`:259-260`) — Anlassfall dokumentiert (`:241-248`: Plan B kam leer zurück, Ergebnis stand trotzdem auf `merged`, „der MoA-Gewinn war damit nicht belegt").
- `plan_with_retry` (`:264-295`) macht **genau einen** Repair-Versuch mit verschärftem Prompt (`PLANNER_REPAIR_SYSTEM` `:106-111`).
- `merge_step_defaults` (`:302-334`) lehnt unbekannte Rollen ab (`:321-325`) statt still zu ignorieren.

**Aggregation** (`merge_plans`, `:337-355`): `a`/`b` mit Leer-Fallback auf die andere Seite und korrigiertem Label (`:343-346`), `merged` = Dedupe über `tool + json.dumps(args, sort_keys=True)` (`:350-353`). Der Aggregator-Prompt ist ein LLM-Call (`:525`), die Entscheidung `chosen` wird aus dessen JSON gelesen (`:526`).

**Ausführung** (`execute_steps`, `:451-459`): sequentiell, Fehler brechen die Kette **nicht** ab (`:457-458` fängt `ValueError/NotImplementedError/URLError/OSError`). `call_tool` (`:386-448`): `POST /run` + Polling bis Deadline, Default `timeout_s = 600` (`:391`), `poll_s = 2` (`:392`), HTTP-Timeout 60 s (`:425`, `:435`), Endzustand `TIMEOUT` (`:448`). Fehlende Endpoint- oder Key-Konfiguration wird als klarer Fehler geworfen (`:415`, `:418`).

**Nicht abgedeckt:** Es gibt keine Prüfstufe nach der Ausführung (kein „Verify" wie im TS-Loop). `status: FAILED` aus `execute_steps` wird in `moa_orchestrate` nur mitgeliefert (`:550-551`), nicht bewertet oder korrigiert.

----

## 5. SELBSTLERNEN

Geprüft wurden sechs Kandidaten. Ergebnis vorweg: **der Selbstlern-Loop ist teilweise geschlossen — und dort, wo er formal geschlossen ist, misst er sich selbst.**

### 5.1 `promptIteration.ts` — formal geschlossene Schleife, tautologische Metrik

Ablauf (`promptIteration.ts:63-117`): Initial-Prompt anlegen, dann in der Schleife
`score = evaluate(...)` (`:82`) → `evals.record(...)` (`:84-94`) → bei `score >= minScore` `KEEP` (`:96-98`) → sonst `optimizePromptContent` (`:100`) → `upsert` als neue Version (`:101-103`).

Geschlossen ist sie mechanisch: Ergebnis → Bewertung → Anpassung → neue Version → erneute Bewertung.

**Kernbefund L-1 (Metrik misst Text, nicht Wirkung):** Der Default-Evaluator ist
`evaluatePromptCoverage` (`:38-48`): er zählt, wie viele Kommando-Namen aus `PLUGIN_COMMAND_CATALOG` **als Substring im Prompt-Text** vorkommen (`:46` `promptContent.includes(cmd)`).
Der Optimierer `optimizePromptContent` (`:51-56`) hängt genau diese Kommandoliste an den Prompt an (`:53`).

Damit konvergiert der Loop **garantiert** in der zweiten Runde auf 1.0, unabhängig davon, ob das Modell die Kommandos korrekt benutzt. Es wird die Anwesenheit der Zeichenkette gemessen, die der Optimierer selbst einfügt. Ein Modell wird nie aufgerufen: `model: 'heuristic'`, `provider: 'offline'` (`:88-89`).

Zusätzlich: `promptIteration` wird nur von `scripts/iterate-prompts.ts:19` und den Tests aufgerufen; der erzeugte Prompt landet in `promptStore`/Supabase (`iterate-prompts.ts:36-52`), den niemand liest (§3.1) → **die Verbesserung erreicht den LLM-Prompt nicht.**

### 5.2 MOS-Wertungen (AI-P1-007) — Erfassung ja, Steuerung nein

Erfassung ist sauber gebaut (`mosHarness.ts`):
- Validierung ohne Toleranz: `modelId`, `evaluatorId`, `language ∈ {DE,EN}`, `score` ganzzahlig 1..5 (`:142-149`)
- Persistenz `void aiPersistence.saveEvaluation({ task: 'voice.mos', provider: 'mos-listener', … })` (`:163-175`) mit Fehler-Log statt Throw (`:173-175`)
- Ladepfad `loadPersisted()` (`:282`) + Statusausweis `persistenceStatus()` (`:300-303`) — laut Kommentar `:20-23` war der Ladepfad vorher nicht vorhanden
- Gate-Berechnung `summaryFor` (`:182-209`): `evaluators` = Anzahl **verschiedener Hörer** (`:188`, nicht Wertungen — begründet `:185-187`), `avg` (`:190`), `pass = evaluators >= requiredCount && avg >= minScore` (`:191`), Klartext-`reason` (`:192-196`)
- Schwellen aus Env: `AI_MOS_MIN_SCORE` Default 4 (`:133`), `AI_MOS_MIN_RATINGS` Default 3 (`:137`)

**Kernbefund L-2 (Gate ohne Abnehmer — der Loop ist offen):** `gateFor()`/`summaryFor()` werden **ausschließlich in `tests/mosHarness.test.ts`** konsumiert (Belege `:29`, `:40`, `:42`, `:48`, `:57`, `:66`, `:76`, `:173`, `:190`, `:204`). In `src/`, `server/` und `scripts/` gibt es **keinen** Aufrufer von `gateFor`, **kein** Lesen von `.pass` und **keine** Verwendung von `AI_MOS_MIN_SCORE` außerhalb von `mosHarness.ts`. Der Server bietet die Wertung nur an:

- `POST /api/ai/voice/mos` (`aiRoutes.ts:232-240`) und `GET /api/ai/voice/mos` (`:246-254`, mit `loadPersisted()` `:247` und ehrlichem `persistence`-Feld `:252`)

Kein UI-Aufrufer für diese Route wurde gefunden (Suche in `src/components`, `src/hooks`, `src/context` ergab keinen Treffer für `voice/mos`). Folge: Es wird eine Hörer-Wertung erfasst, persistiert und ausgewiesen — aber **keine Modellwahl, kein Rollout und keine Prompt-Anpassung hängt davon ab**. Ergebnis → Bewertung existiert; Bewertung → Anpassung fehlt.

### 5.3 `src/ai/embeddingCache.ts` — tote Datei

`embeddingCache.ts` ist ein reiner Key→Vektor-Cache (Memory-`Map` + Storage, FIFO-Kappung bei 500, `:15-40`) mit Statistikfunktion (`:43-45`). **Kein Importer** in `src/`, `server/`, `tests/` oder `scripts/`. `knip.json:35` führt die Datei in der `ignore`-Liste, d. h. der Unused-Code-Check ist für sie bewusst abgeschaltet. Es gibt **keine** Indexierungs-/Ähnlichkeitssuche in dieser Datei (kein Vektorvergleich, keine DB) — belegt auch in `docs/PGVECTOR_LINT0014.md:162` („in-memory only, not database-backed").

### 5.4 `modelRegistry.ts` — Namenskollision, eine Hälfte tot

Es existieren **zwei** Dateien mit demselben Basisnamen:

- `src/ai/modelRegistry.ts` (52 Z.): `ModelRegistry` mit `kind`, `version`, `backend`, `qualities` und `activate()` als Hot-Swap (`:22-50`). **Kein Importer**; `knip.json:37` ignoriert sie. → tot.
- `src/core/ai/orchestrator/modelRegistry.ts`: **live** — `aiOrchestrator.ts:17`, `mcpRuntime.ts:13`, `modelManager.ts:14`, `tests/modelRegistry.test.ts:6`, `tests/aiE2eScenario.test.ts:14`; Doku `docs/MODEL_REGISTRY_GUIDE.md`; Endpunkt `GET /api/ai/models` (`aiRoutes.ts:784-786`).

**Kernbefund L-3:** Die Registry ist ein Modell-**Katalog** (Nachschlagen/Validieren), **keine** Lernkomponente. Es gibt in beiden Dateien keine Rückkopplung aus Bewertungen — Hot-Swap ist ein manueller Aufruf (`src/ai/modelRegistry.ts:32-39`), und diese Variante wird nicht einmal importiert. Eine automatische „aktiviere das besser bewertete Modell"-Kante existiert nicht.

### 5.5 Vision-Selbstlern-Loop (`visualSelfLearning`) — im Code verdrahtet, im Betrieb blockiert

**Die Kette ist tatsächlich End-to-End vorhanden:**

1. Generierung speichern: `POST /api/ai/vision` → `insertVisualGeneration({ prompt, style, energy, bpm, seed, r2Url, durationMs, model })` (`aiRoutes.ts:296-311`), ID kommt als `generationId` zurück (`:318`)
2. Bewerten (UI): `VisualMonkOverlay.tsx:144-154` → `POST /api/ai/vision/feedback` mit `{ generationId, rating, keep: rating >= 3 }`
3. Feedback speichern: `aiRoutes.ts:532-549` → `insertVisualFeedback(...)`
4. Ranking lesen: `GET /api/ai/vision/styles` (`aiRoutes.ts:558-574`) → `fetchVisualStyleRanking` (`cloudAutomation.ts:304-311`, View `visual_style_ranking`) → `normalizeStyleRanking` → `suggestStyleFromRanking` (`visualFeedback.ts:132-163`); ohne Daten kommt ehrlich `source: 'fallback'` (`:159-161`) bzw. `source: 'none'` (`aiRoutes.ts:571`)
5. Anpassung: `VisualMonkOverlay.tsx:200-224` setzt `aiStyle` aus dem Vorschlag; die nächste Generierung nutzt genau diesen Wert (`:163-165`) — aber **nur im AUTO-Modus** (`:163` `aiAuto ? (aiSuggestion ? aiSuggestion.style : suggestVisionStyle(...)) : aiStyle`)

Auch die Ausfall-Ehrlichkeit ist gebaut: Der Server liefert `source: 'db' | 'none'` und reicht den Fehler als `note` durch (`aiRoutes.ts:571-572`), die UI weist einen unbekannten Stil als Fehler aus (`VisualMonkOverlay.tsx:211-213`).

**Kernbefund L-4 (Loop teilweise geschlossen):** Drei Einschränkungen, alle belegt:

a) **Nur manuell.** Der Vorschlag wird über einen Knopf geholt (`VisualMonkOverlay.tsx:514` `title="RAG-Vorschlag: … holen"`), nicht automatisch nach einer Bewertung. Zwischen Bewertung und Anpassung muss ein Mensch klicken.
b) **Vom Betreiber selbst als offen markiert.** `MASTERTODOENDE.json`, Knoten `/visualSelfLearning`: `"open": ["Migration anwenden", "RAG: topStyles -> naechster Prompt", "LoRA-Training (Pod) aus Top-Feedback"]`, dazu `"schema": "database/ai_migration_008_visual.sql (nicht angewendet)"`. Die Datei liegt im Repo (`database/ai_migration_008_visual.sql` existiert, Titel „VisualMONK-Selbstlern-Loop"), ist laut todo aber **nicht angewendet**. Ohne die Tabellen/View liefert der Ladepfad keine Daten, und der Loop degeneriert auf den Heuristik-Fallback.
c) **Anpassungsfläche ist ein Enum, nicht der Prompt.** Gelernt wird der `style` (18 feste Werte, `visionPrompt.ts:24`). `topStyles`/`aggregateFeedback` (`visualFeedback.ts:45-69`) — die Funktionen, die eine echte Prompt-Anpassung tragen könnten — werden nur von `tests/vision.test.ts:5` und `tests/visualRagStyles.test.ts:6` aufgerufen. „RAG: topStyles → nächster Prompt" ist damit genau die offene Lücke, die die Todo nennt.

### 5.6 Weitere Kandidaten

- **`parameterPrediction.ts`** (heuristische Automation-Vorschläge, Rezenz-Halbwertszeit 30 min `:29`, Konfidenz = Gewichtsanteil `:79`): pure Funktionen ohne Storage. **Kein Importer außer `tests/parameterPrediction.test.ts:7`** — die UI-Chips, von denen der Kommentar `:11` spricht, existieren nicht. Kein geschlossener Loop, sondern eine unverdratete Bibliotheksfunktion.
- **`evalMatrix.ts`** (`minScore` je Plugin, `:38-48`): das Gate **existiert** und ist scharf formuliert (`DEFAULT_MIN_SCORE = 4` `:31`, kritische Plugins 4.5 `:40-43`). Es wird aber mit Mock-Scores gespeist (§6.2) und daher nie auslösen.
- **`MoaHistory.ts`** (Verlaufshistorie, clientseitig IndexedDB laut `docs/AI_PROMPTS.md:46-47`): vom Agent-Loop **nicht** konsumiert — `MoaAgent` bekommt nur den statischen `context`-String (`agentLoop.ts:61-67`). Der Loop sieht seine eigene Vergangenheit nicht.

### 5.7 Antwort auf die Leitfrage

**Ist der Loop geschlossen? → TEILWEISE.**

- **Geschlossen (mechanisch, aber selbstreferenziell):** `promptIteration` — Ergebnis → Bewertung → neue Version → erneute Bewertung. Die Bewertung ist jedoch ein Substring-Check des Prompt-Texts gegen den Katalog, den der Optimierer selbst einfügt (`promptIteration.ts:38-48` vs `:51-56`), mit `model: 'heuristic'` (`:88`). Der Loop misst also seine eigene Schreiboperation. Zusätzlich erreicht die neue Version keinen echten LLM-Call (§3.1).
- **Geschlossen und wirksam (mit Betriebs-Vorbehalt):** der Vision-Loop (`visualSelfLearning`) — Generierung → UI-Bewertung → DB → Ranking → Stilwahl → nächste Generierung ist vollständig verdrahtet und über `source: 'db' | 'fallback' | 'none'` ehrlich instrumentiert. Er ist aber **manuell getriggert** (`VisualMonkOverlay.tsx:514`), hängt an einer laut `MASTERTODOENDE.json` **nicht angewendeten** Migration 008, und lernt nur `style`, nicht den Prompt.
- **Offen:** MOS-Gate (Bewertung existiert, kein Abnehmer — `gateFor` nur in Tests), `parameterPrediction` (kein Aufrufer), `embeddingCache` + `src/ai/modelRegistry.ts` (tote Dateien), `MoaHistory` (nicht in den Loop eingespeist), Modellwahl-Registry (keine Kante von Bewertung zu Aktivierung).

----

## 6. SCHWACHSTELLEN

### 6.1 Tote bzw. heinwired Module (belegt durch fehlende Importer + `knip.json`-Ignore)

| Datei | Beleg | Status |
|---|---|---|
| `src/ai/embeddingCache.ts` | kein Importer; `knip.json:35` | tot |
| `src/ai/modelRegistry.ts` | kein Importer; `knip.json:37` | tot (Namensdublette zu `src/core/ai/orchestrator/modelRegistry.ts`) |
| `src/ai/localVoice.ts` | kein Importer; `knip.json:36` | tot |
| `src/core/ai/parameterPrediction.ts` | nur `tests/parameterPrediction.test.ts:7` | unverdrahtet |
| `src/core/ai/agentLoop.ts` | nur Tests (`tests/agentLoop.test.ts:2`, `tests/voiceAgentTask.test.ts:3`) | Bibliothek ohne UI-Einstieg (im Kommentar als bewusst bezeichnet, `agentLoop.ts:12-13`) |
| `src/core/ai/orchestrator/promptIteration.ts` | nur `scripts/iterate-prompts.ts:11` + Tests | wirkt nur über einen manuell/CI gestarteten Skript-Lauf |
| `src/core/ai/orchestrator/evaluationStore.ts` | nur Skripte/Tests (`scripts/eval-ai.ts:17`, `scripts/benchmark-brain.ts:35`) | In-Memory, kein Server-Leser |
| `src/ai/localDemucs.ts` | `src/components/StemExtractorTerminal.tsx:9` | **lebendig** (Gegenbeispiel) |

Hinweis zur Methode: geprüft wurde per Import-Suche in `src/`, `server/`, `server.ts`, `services/`, `tests/`, `scripts/` plus Abgleich mit der `ignore`-Liste in `knip.json`. Nicht ausgeschlossen sind indirekte Referenzen über `@/`-Alias oder dynamische Pfadkonstruktion — **nicht abschließend geprüft**.

### 6.2 Fehlende Bewertungsgrundlage — der Kernbefund

Die gesamte AI-Eval-Kette auf der Plugin-/Prompt-Seite stützt sich auf **einen hart kodierten Score**:

`scripts/eval-ai.ts`:
- `:38-50` legt je Plugin einen Case an, in dem `expected` und `actual` **identisch konstruiert** werden (`:46` vs `:47`);
- `:70-80` schreibt direkt in den Store: `model: 'mock'`, `provider: 'offline'`, `score: 5`, `metrics: { latencyMs: 5, exactMatch: true }` (`:74-79`);
- es wird **kein** LLM, **kein** Netz, **kein** Modell aufgerufen.

Dieser Score speist:
- das Gate `evaluationStore.finishRun(run.runId, spec.minScore)` (`eval-ai.ts:81`) mit `spec` aus `evalMatrix.ts` (`:62-63`);
- den Nightly-Job „AI-Eval-Run (Gate bei Score-Abfall)" (`.github/workflows/nightly.yml:41-42`) und den Prompt-Loop „Gate bei Nicht-Konvergenz" (`:44-46`), dessen Artefakte hochgeladen und in die Job-Summary geschrieben werden (`:48-61`);
- die Score-Spalte der Doku-Matrix `docs/PLUGIN_PROMPT_MATRIX.md:10-30` (5.00 / PASS).

**Folge:** Die Gates können per Konstruktion nicht fehlschlagen. Der Nightly-Job erzeugt Evidence, die keine Messung ist — dieselbe Sorte „erfundener Evidenz", die `mosHarness.ts:185-187` für das Gate korrekt ausschließt. Der einzige im Audit gefundene *echte* Messpunkt ist `mosHarness` (Hörerwertung), und dessen Gate hat keinen Abnehmer (§5.2).

### 6.3 Routing-Schwachstellen

- **R-1** `OllamaProvider.available` prüft nur Env-Präsenz, nicht Erreichbarkeit (`LlmRouter.ts:185-187`) → Provider gilt als verfügbar, obwohl er nicht antwortet.
- **R-2** Fallback-Kette ohne Telemetrie pro Versuch (`LlmRouter.ts:455-461`): nur der letzte Fehler wird geworfen.
- **R-3** Keine Timeouts/kein `AbortSignal` im Router (§1.4) — im Kontrast zum Orchestrator (`runpodProvider.ts:322-326`, `:342-371`).
- **R-4** `runpod-local` `available` prüft im OpenAI-kompatiblen Modus nur den Key (`LlmRouter.ts:291`), nicht Modell/Erreichbarkeit — der dokumentierte 404-Ausfall (`:64-75`) wäre damit weiterhin erst zur Laufzeit sichtbar.
- **R-5** `aiMode.ts` hat keine Verbindung zur Provider-Wahl (§1.5) → `PRO` ist kein Qualitätsversprechen.
- **R-6** Der Kopfkommentar (`LlmRouter.ts:4-18`) beschreibt eine Kosten-Priorität (Cerebras zuerst), die der Code nicht umsetzt (`rankProviders` setzt `runpod-local`/`ollama` immer vorn, `:440-443`). Der Widerspruch ist in `:23-25` halb relativiert, aber nicht entfernt.
- **R-7** Kosten-/Qualitätssteuerung `costTracker.ts` und `circuitBreaker.ts` liegen in `src/core/ai/orchestrator/` und sind **nicht** in `LlmRouter.complete` verdrahtet — `LlmRouter.ts` importiert ausschließlich `RunPodProvider` (`:27`). Ein Provider-Ausfall zählt damit nirgends.

### 6.4 Pipeline-Schwachstellen

- **P-1** `taskWorker.ts` ist ein paralleler Legacy-Pfad ohne KI-Task-Typen (`:15`) und ohne Kante zur AI-Runtime (§2.2).
- **P-4** Asynchronität des Kommandos ist für den Loop unsichtbar: `handled: true` auch bei späterem Lade-Fehlschlag (`pluginCommandRegistry.ts:199-214` vs `VoiceControlService.ts:164-169`).
- **P-5** `withTimeout` in `MoaAgent` (`:181-194`) bricht den unterliegenden Call nicht ab → ein hängender Brain-Call bleibt als Ressource bestehen, obwohl der Loop „Zeitlimit überschritten" meldet. Anlassfall dokumentiert (`MoaAgent.ts:208-211`).
- **P-6** `mergeResults` ordnet Korrekturergebnisse **positional** zu (`MoaAgent.ts:460-477`) — bei geänderter Reihenfolge des Korrekturplans wird falsch zugeordnet, ohne Fehlermeldung.
- **P-7** `AgentRunStore` schreibt ohne Lock und nicht atomar (`agentRuns.ts:107-110`) bei einem Verzeichnis, das per `tmpdir()` geteilt sein kann (`:140-149`).

### 6.5 Tests, die den Zustand statt der Wirkung prüfen

- **`tests/promptMatrix.test.ts:48-68`** — schreibt `score: 5` selbst (`:60`) und behauptet `avgScore >= 4`, Status `PASS` (`:65-66`). Prüft den Store gegen die eigene Eingabe.
- **`scripts/eval-ai.ts:70-81`** — dasselbe Muster im Nightly-Gate, mit `expected === actual` (`:46-47`). Kein Test fängt das ab.
- **`tests/promptCatalog.test.ts:18-40`** und **`tests/promptMatrix.test.ts:17-46`** — Existenz-/Längen-/Vollständigkeitsprüfungen. Korrekt und nützlich (sie sichern z. B. die 18 IDs), aber sie sagen nichts über Prompt-Qualität.
- **Nicht abgedeckt:** die Ordnungsannahme in `mergeResults` (§6.4/P-6); die Provider-Fallback-Kette in `LlmRouter.complete` gegen einen *antwortenden-aber-falschen* Provider; die Konvergenz der Korrekturschleife gegen einen echten LLM.
- **Positiv (Gegenbeispiele):** `tests/mosHarness.test.ts` prüft die Gate-Entscheidung inkl. Mehrfachwertung desselben Hörers (`:173-174`, `:190-191`) — also Fehlerfälle, nicht nur Erfolg. `tests/manifestRoles.test.ts` sichert TS↔Python-Drift der Rollen ab (`endpointRegistry.ts:226-227`).

**Nicht geprüft (Budgetgrenze):** die vollständige Testsuite wurde nicht ausgeführt (Auftrag: keine repo-weiten Gates). Aussagen über Tests stützen sich ausschließlich auf den Dateiinhalt der in §3.5 und §6.5 genannten Dateien. Die übrigen ~40 AI-nahen Testdateien (`aiE2eScenario`, `aiFailureSuite`, `aiOrchestratorRuntime`, `vision`, `agentRuns`, `llmRouter` …) wurden **nicht** im Detail gelesen.

### 6.6 Doku-Drift (Zusammenfassung)

| Doku | Datei:Zeile | Code | Drift |
|---|---|---|---|
| „MOA/MCP-Planer (DeepSeek V4 Flash)" | `docs/AI_PROMPTS.md:7` | `complexity: 'moderate'` → `runpod-local`/`ollama` zuerst (`LlmRouter.ts:442`); DeepSeek nur mit `AI_ALLOW_EXTERNAL_LLM=true` (`:444`) | Titel beschreibt Nicht-Default |
| `maxTokens=1024` | `docs/AI_PROMPTS.md:25` | `maxTokens: 1536` (`MoaAgent.ts:276`) | Zahl veraltet |
| „17 Plugin-IDs" | `docs/AI_PROMPTS.md:30` | 18 (`promptSeed.ts:16-20`) | Zahl falsch |
| „21 Plugins" mit IDs wie `synthesizer`, `library`, `mastering` | `docs/PLUGIN_PROMPT_MATRIX.md:3`, `:10-30` | 18 IDs, andere Namen (`evalMatrix.ts:15-19`) | **Namens- und Mengendrift** |
| Score-Spalte durchgehend 5.00 / PASS | `docs/PLUGIN_PROMPT_MATRIX.md:10-30` | Mock-Score (`scripts/eval-ai.ts:78`) | **fiktive Evidenz in der Doku** |
| „für alle 21 Plugins" | `promptSeed.ts:42` (Kommentar) | `PLUGIN_IDS` = 18 (`:16-20`) | Kommentar falsch |
| Kosten-Priorität Cerebras/DeepSeek zuerst | `LlmRouter.ts:4-18` | `rankProviders` (`:440-443`) | Kommentar überholt |
| Vision-Migration als offen | `MASTERTODOENDE.json` `/visualSelfLearning` | Datei existiert (`database/ai_migration_008_visual.sql`) | offen laut eigener Todo; Anwendungsstatus **nicht geprüft** |

----

## 7. KERNBEFUNDE NACH SCHWERE

### Kritisch (untergräbt die Aussagekraft des Systems)

1. **Bewertung ohne Messung.** `scripts/eval-ai.ts:70-81` schreibt je Plugin `score: 5` mit `model: 'mock'`; `expected`/`actual` sind identisch konstruiert (`:46-47`). Dieses Ergebnis trägt das Nightly-Gate (`.github/workflows/nightly.yml:41-42`), das Prompt-Konvergenz-Gate (`:44-46`) und die Score-Spalte in `docs/PLUGIN_PROMPT_MATRIX.md:10-30`. Kein LLM wird aufgerufen.
2. **Prompt-Versionierung ohne Leser.** `promptStore` (`promptStore.ts:24-85`) wird von keiner Produktionsdatei gelesen; `MoaAgent.plan` nutzt die Konstante `moaSystemPromptForPlugin` (`MoaAgent.ts:260`). Optimierte Versionen (`promptIteration.ts:101-103`) erreichen keinen LLM-Call.
3. **Der Prompt-Iterations-Loop misst sich selbst.** `evaluatePromptCoverage` zählt Substrings (`promptIteration.ts:38-48`), `optimizePromptContent` fügt genau diese Substrings ein (`:51-56`); `model: 'heuristic'`, `provider: 'offline'` (`:88-89`). Konvergenz ist garantiert und bedeutungslos.

### Hoch (Architektur-/Betriebslücken)

4. **MOS-Gate ohne Abnehmer.** `gateFor`/`pass` nur in `tests/mosHarness.test.ts`; kein `AI_MOS_MIN_SCORE`-Verbraucher außerhalb von `mosHarness.ts`. Erfassung/Persistenz/Anzeige sind sauber (`mosHarness.ts:141-175`, `aiRoutes.ts:232-254`), die Steuerung fehlt.
5. **Keine Timeouts/Abbruch im LLM-Router.** Kein `AbortSignal`/`AbortController` in `LlmRouter.ts`; `postJson` (`:109-115`) ist ein nacktes `fetch`. `circuitBreaker.ts`/`costTracker.ts` sind nicht verdrahtet (`LlmRouter.ts:27` importiert nur `RunPodProvider`).
5a. **Fallback ohne Auskunft.** `complete()` (`:451-463`) verschluckt alle Fehlversuche bis auf den letzten; `available` prüft bei `ollama`/`runpod-local(openai)` nur Env-Präsenz (`:185-187`, `:291`).
6. **Modul-State `PRO` hat keine Wirkung auf die Modellwahl.** `aiMode.ts` ist nur ein Lock-Flag (`:9-17`), gesetzt aus `ModuleStateContext.tsx:85`/`:204`; keine Kante zum Router.
7. **Zwei unverbundene „MoA"-Implementierungen und zwei Pipelines.** TS-Single-Planner (`MoaAgent.ts:256-293`) vs. Python-4-Rollen-MoA (`moa_orchestrator.py:42-47`, `:499-527`) ohne gemeinsamen Code; zusätzlich `taskWorker.ts` als paralleler Pfad ohne KI-Tasks (`taskWorker.ts:15`).

### Mittel (Doku, Tests, Robustheit)

8. **Doku-Drift mit Namens- und Mengenfehlern** in `docs/PLUGIN_PROMPT_MATRIX.md:3`, `:10-30` (IDs existieren nicht im Code) und `docs/AI_PROMPTS.md:7`, `:25`, `:30`; dazu `promptSeed.ts:42` und `LlmRouter.ts:4-18`.
9. **Tests, die den Zustand statt der Wirkung prüfen:** `tests/promptMatrix.test.ts:48-68` (selbst erzeugter Score), `tests/promptCatalog.test.ts:18-40`. Kein Test deckt die positional Merge-Annahme (`MoaAgent.ts:460-477`) oder die Fallback-Kette ab.
10. **Tote Module:** `src/ai/embeddingCache.ts`, `src/ai/modelRegistry.ts`, `src/ai/localVoice.ts` (je `knip.json:35-37`), `parameterPrediction.ts` (nur Test-Importer). Namensdublette `modelRegistry.ts` an zwei Pfaden mit verschiedener Semantik.
11. **Robustheitslücken im Agent-Loop:** `withTimeout` ohne echten Abbruch (`MoaAgent.ts:181-194`), positional Merge (`:460-477`), nicht-atomarer Run-Store (`agentRuns.ts:107-110`), asynchrone Kommandowirkung unsichtbar (`pluginCommandRegistry.ts:199-214`).
12. **Vision-Selbstlern nur manuell + Migrationsvorbehalt:** Knopf statt Automatik (`VisualMonkOverlay.tsx:514`), `"open": ["Migration anwenden", "RAG: topStyles -> naechster Prompt", …]` (`MASTERTODOENDE.json` `/visualSelfLearning`), Lernfläche = `style`-Enum (`visionPrompt.ts:24`).

### Positiv belegt (kein Handlungsbedarf)

- **WRITE-Gate ist fail-safe:** unbekanntes Kommando = WRITE (`MoaAgent.ts:126`, `:133-137`); `allowWrite` ist opt-in (`agentRuns.ts:340-341`); ein Abbruch wird nicht als Erfolg verbucht (`:360`, `:448`).
- **Leerer Plan zählt als Fehlschlag** mit Ersatzplan-Logik (`MoaAgent.ts:410-432`).
- **Python-MoA-Parsing ist belastbar:** `prefer='dict'|'list'` (`moa_orchestrator.py:129-150`), Tool-Whitelist (`:224-225`), `suspicious`-Report mit Rohtext-Auszug (`:231-261`), ein Repair-Versuch (`:264-295`), Rollen-Validierung (`:321-325`), Dedupe beim Merge (`:350-353`).
- **Echtzeitgrenze gehalten:** kein Netzwerk in `process()`; der einzige Worklet-`fetch` liegt im Message-Handler (`spatialProcessor.ts:290-305` vs `:395`), passend zu `AGENTS.md:151-152`.
- **Ehrliche Fehlerausweise statt stiller Ersatz:** `aiRoutes.ts:571-572` (`source: 'db'|'none'` + `note`), `:325`/`:371`/`:460` (Statuscode-Mapping `NO_ENDPOINT`/`NO_KEY` → 503, `TIMEOUT` → 504), `mosHarness.ts:192-196` (Klartext-Begründung), `visualFeedback.ts:159-161` (`fallback` mit `confidence: 0.25`).
- **TS↔Python-Drift ist testgesichert:** `endpointRegistry.ts:226-227` mit `tests/manifestRoles.test.ts`.

### Offene Punkte (Budgetgrenze, ausdrücklich nicht abschließend geprüft)

- Anwendungsstatus von `database/ai_migration_008_visual.sql` und `ai_migration_002.sql` in der Live-Supabase (**nicht geprüft**; nur die Todo-Aussage „nicht angewendet" zitiert).
- Vollständige Testsuite wurde **nicht** ausgeführt (Auftrag: keine repo-weiten Gates); ~40 weitere AI-Testdateien nicht gelesen.
- Keine Live-Verifikation von Provider-Erreichbarkeit, Modell-IDs oder GPU-Endpunkten (**nicht geprüft**, kein Netz-/Key-Zugriff im Audit).
- Tote-Modul-Analyse per Import-Suche; dynamische `@/`-Alias- oder pfadkonstruierte Referenzen nicht ausgeschlossen (**nicht abschließend geprüft**).
- `src/core/ai/vision/{runpodVision,runpodVideo,clipPipeline}.ts`, `src/core/ai/orchestrator/{fleetWake,jobManager,providerRouter,costTracker,circuitBreaker,mcpRuntime,aiPersistence,evalMatrix}.ts` nur strukturell (grep-Ebene) betrachtet, nicht zeilenweise gelesen.

