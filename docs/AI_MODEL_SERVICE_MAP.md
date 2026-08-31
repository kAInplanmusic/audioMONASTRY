# AI Model → Service Mapping (Phase 2)

> Stand 2026-08-31 · Verkabelung aller AI-Modelle mit verantwortlichem
> Service/Plugin, Schnittstellen und Evaluierungsstatus.

## 1. Modellinventur

| Modell | Task-Typ | Framework | Version/Revision | Status |
|---|---|---|---|---|
| DeepSeek V4 Flash | text-generation | HTTP API | `deepseek-v4-flash` | ✅ live |
| DeepSeek V4 Pro | text-generation | HTTP API | `deepseek-v4-pro` | ✅ konfiguriert |
| Qwen2.5-72B-Instruct | text-generation | HF Router | HF-Default | ✅ konfiguriert |
| Mistral Small | text-generation | HTTP API | `mistral-small-latest` | ✅ konfiguriert |
| Qwen2.5:7b | text-generation | Ollama | `qwen2.5:7b` | ✅ live ai-1 |
| MMS-TTS-deu | text-to-speech | transformers | `5cbe5218…` | ✅ Serverless live |
| Bark | text-to-speech/gesang | transformers | `70a8a7d3…` | ✅ Serverless live |
| MusicGen small | text-to-audio | transformers | `4c8334b0…` | ✅ Endpoint (Custom) |
| MusicGen medium | text-to-audio | transformers | `d3bd7b00…` | ✅ Endpoint on-demand |
| Whisper large-v3 | automatic-speech-recognition | transformers | `06f233fe…` | ✅ Pilot-Endpoint läuft |
| AST Audioset | audio-classification | transformers | `f826b80d…` | ✅ Endpoint CORE |
| CLAP larger_clap_music | audio-embedding | transformers | `a0b4534a…` | ✅ Endpoint FREQUENT |
| MERT-v1-95M | music-understanding | transformers | `12af15fe…` | ✅ privat/Forschung ok |
| PyAnnote 3.1 | diarization | transformers | `84fd2591…` | ✅ Endpoint on-demand |
| Qwen2.5-Omni-7B | multimodal | transformers | `ae9e1690…` | ⏳ RARE |
| Demucs cjwbw | stem-separation | Replicate | latest_version | ✅ live verifiziert |
| htdemucs-ONNX | stem-separation | ONNX Runtime Web | `smank/htdemucs-onnx` | ✅ lokal |
| MiniLM (transformers.js) | embeddings | ONNX/JS | ~80 MB | ✅ lokal |

## 2. Service-Zuordnung

| Modell | Verantwortlicher Service/Plugin | Provider im Orchestrator |
|---|---|---|
| DeepSeek/Mistral/HF-Qwen/Ollama | `server.ts` `/api/ai/complete` → `LlmRouter` → `MoaAgent`/`clientLlm` | `llmRouter` (bestehend) |
| MMS-TTS/Bark | `server.ts` `/api/voice/tts|sing` → `VoiceMonkService` | `HfServerlessProvider` |
| MusicGen small/medium | `server.ts` `/api/voice/song` + `SongGenerator` | `HfServerlessProvider` / `HfEndpointProvider` |
| Whisper/AST/CLAP/MERT/PyAnnote/Qwen-Omni | `services/samplemonk-ai-runtime/` (`/infer`) | `HfEndpointProvider` |
| Demucs | `server.ts` `/api/separate-stems` + `StemExtractorTerminal` | `ReplicateProvider` |
| htdemucs-ONNX | `src/ai/localDemucs.ts` (Browser) | `LocalProvider` |
| MiniLM | `src/utils/LocalEmbeddingProvider.ts` | `LocalProvider` |

## 3. Schnittstellen (Input/Output je Modell-Service-Paar)

| Paar | Input | Output |
|---|---|---|
| LlmRouter ← Prompt | `{prompt, complexity, maxTokens?, temperature?, reasoningEffort?}` | `{provider, text, latencyMs}` |
| VoiceMONK TTS ← Text | `{text, language?, model?}` | Audio-Blob (WAV) |
| VoiceMONK Sing ← Text | `{text/notes, bpm, model?}` | Audio-Blob (WAV) |
| SongGenerator ← Prompt | `{prompt, durationSeconds?, style?, bpm?, model?}` | Audio-Blob (WAV) |
| HF Runtime `/infer` classify | `{audioBase64}` | `{labels[], scores[]}` |
| HF Runtime `/infer` transcribe | `{audioBase64, language?}` | `{text}` |
| HF Runtime `/infer` embed | `{audioBase64}` | `{embedding[], dim}` |
| HF Runtime `/infer` generate | `{prompt, maxDuration?}` | `{audioBase64, sampleRate}` |
| HF Runtime `/infer` tts | `{text}` | `{audioBase64, sampleRate}` |
| Replicate stems | `{audioDataUri}` | `{status, stems:{vocals,bass,drums,other,…}}` |
| localDemucs | File/ArrayBuffer | WAV-Stems (4) |

## 4. Evaluierungs-Framework

Implementiert in `src/core/ai/orchestrator/evaluation.ts`:
- **Token-Usage:** Schätzung `tokens = ceil(chars/4)` (Prompt) + Completion
- **Latency:** gemessene `latencyMs` pro Call
- **Accuracy:** `exactMatch` (Klassifikation/Label-Vergleich)
- **BLEU (vereinfacht):** n-Gramm-Präzision 1–4 mit Brevity-Penalty
- **ROUGE-L:** längste gemeinsame Teilsequenz (Recall/Precision/F1)
- **EvalRunner:** sammelt Cases, aggregiert Metriken, schreibt JSON-Report

Tests: `tests/aiEvaluation.test.ts` (Metriken + Runner).

## 5. Prompt-Engineering

Dokumentiert in `docs/AI_PROMPTS.md`. Kern:
- **MOA-Planer** (`LlmRouter.plan`/`MoaAgent.plan`): System-Prompt mit
  erlaubten Plugin-IDs/Kommandos, JSON-Array-only, `temperature=0.3`,
  `reasoning_effort=low`, maxTokens 1024.
- **Voice/Sprachsteuerung:** `moaSystemPromptForPlugin` je Plugin (17),
  `moaCommandCatalog` als Few-Shot-Katalog.
- **AUTO_AI:** `PLUGIN_MOA_TASKS` (periodische Vorschlags-Prompts).
- **Kontextfenster-Strategie:** kurze Prompts (<2k Tokens), keine Historie im
  Default-Pfad; History nur in `MoaHistory` (clientseitig, IndexedDB).

## 6. Optimierungszyklus & Benchmarks

- **Quantisierung:** INT8 für große Modelle (Bark, MusicGen-medium, Qwen-Omni),
  FP16 für kleine – im Manifest festgelegt.
- **Batch-Optimierung:** AST/CLAP batch-fähig (`concurrency: 2`), Generation
  strikt `concurrency: 1` (SampleMONK-Regel).
- **Hyperparameter:** LLM `temperature 0.3` (Planung) / `0.7` (kreativ),
  `maxTokens` je Task gedeckelt.
- **Benchmarks:** GPU-Werte stehen aus (Sandbox ohne GPU). Messpunkte sind in
  `AITodo.md` Phase 21–23 vorbereitet; Latenz-/Token-Metriken werden bereits
  pro Job erfasst (`JobManager.durationMs`, `CostTracker`, `AiLogger`).
