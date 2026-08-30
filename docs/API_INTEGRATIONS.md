# audioMONASTRY – API-Integrationen

Stand: **V. 1|001|420 CODENAME AnunnakiDNA** (2026-08-30)

Übersicht aller API-Integrationen: interner Server (Express), externe KI-APIs,
Cloud-Dienste, lokale Dienste und Echtzeit-/Transport-Infrastruktur.

> Sicherheitsregel: Alle externen Keys liegen **ausschließlich serverseitig** in
> `.env` (Dateirechte 600, gitignored). Der Browser erreicht externe Anbieter
> nur über die internen `/api/*`-Proxys. Client-sichtbar sind ausschließlich
> Publishable-Keys (Supabase anon, R2-Read-URLs).

---

## A. Interne Server-API (Express, gleicher Origin)

| Endpunkt | App-Teil | Modul | Zweck |
|---|---|---|---|
| `GET /api/health` | System | `server.ts`, `useAudioAI` (Status-Poll) | Healthcheck/Online-Status |
| `POST /api/ai/compose` | sequencerMONK | `server.ts` (deterministisch), `SequencerPluginTerminal`, `useAIComposition` | KI-Pattern (kick/hat/clap/synth + BPM) generieren |
| `POST /api/ai/generate` | sequencerMONK | `server.ts` → Ollama | LLM-gestützte Komposition (JSON-Patterns), Fallback deterministisch |
| `POST /api/ai/describe` | Mix/Empfehlung | `server.ts` → Ollama | Stil-/Mix-Empfehlung per LLM |
| `POST /api/ai/complete` | MOA/MCP-Planer | `server.ts` → `LlmRouter`, Client: `core/ai/clientLlm` | LLM-Aufrufe mit Kosten-Routing (Keys bleiben serverseitig) |
| `POST /api/separate-stems` | stemMONK | `server.ts` → `STEM_AI_URL`, Client: `useAudioAI.streamStems` | Stem-Trennung (Demucs-Dienst) als SSE-Stream |
| `GET/POST /api/master/*` | masteringMONK | `server.ts` → `proxyMasterPlayer`, `MasterPlayerTerminal` | Mastering/Mix/Analyse über Python-Dienst (FFmpeg) |
| `POST /api/upload/sample` | samplerMONK | `server.ts`, Uploads | Sample-Upload (lokal/Cloud) |
| `POST /api/generate-voice` | voiceMONK | `server.ts` (RVC/VITS-CLI optional), `useAudioAI`, `localVoice` | Legacy-Voice-Stub (Web-Speech-Fallback) |
| `POST /api/voice/tts` | voiceMONK | `server.ts` → HF MMS → Replicate Bark, Client: `core/voice/hfApi` | Text → Stimme |
| `POST /api/voice/sing` | voiceMONK | `server.ts` → HF Bark → Replicate Bark | Text → Gesang |
| `POST /api/voice/song` | voiceMONK | `server.ts` → HF MusicGen medium→small | Text → Song (Suno-artig) |
| `POST /api/cloud/sync` | libraryMONK | `server.ts`, `pluginCommandRegistry` | Cloud-Datenbank-Sync anstoßen |
| `POST /api/cloud/samples` / `music` / `upload` | libraryMONK | `server.ts` → Supabase/R2 | Samples/Tracks pushen, Audio nach R2 |

---

## B. Externe KI-APIs (alle serverseitig, Keys in `.env`)

| API | App-Teil | Modul | Zweck |
|---|---|---|---|
| **DeepSeek** (`api.deepseek.com/chat/completions`) | MOA/MCP + LLM-Router | `core/ai/LlmRouter.ts` (`deepseek-v4-flash`/`-pro`) | Primärer Planer + komplexe LLM-Aufgaben (sehr günstig) |
| **Hugging Face** (`api-inference.huggingface.co/models/…`) | LLM + Voice | `LlmRouter` (HF-LLM), `server.ts` (MMS-TTS/Bark/MusicGen) | Kostenlose/PAYG Inferenz: Sprache, Gesang, Songs, LLM |
| **Mistral** (`api.mistral.ai`) | LLM-Router | `core/ai/LlmRouter.ts` | EU-LLM (`mistral-small-latest`), Function-Calling |
| **Replicate** (`api.replicate.com/v1`) | stemMONK + voiceMONK | `server.ts` (`replicateStem`, `replicateTts`/`replicateSing`) | Serverless-GPU: Demucs-Stems, Bark TTS/Sing – **Token fehlt aktuell in `.env`!** |
| **OpenAI** (`api.openai.com`) | LLM-Router (Notfall) | `core/ai/LlmRouter.ts` | Nur bei `AI_EMERGENCY_PROVIDERS=true` (bezahlt) |
| **Gemini** (`generativelanguage.googleapis.com`) | LLM-Router (Notfall) | `core/ai/LlmRouter.ts` | Nur bei `AI_EMERGENCY_PROVIDERS=true` (bezahlt) |

Fallback-Kette LLM (Kosten-Priorität, Stand 2026-08):
`DeepSeek V4 Flash (MOA/MCP) → Hugging Face → Mistral → Ollama (lokal) → DeepSeek V4 Pro → (Notfall: Gemini/OpenAI)`
*(Groq und SambaNova wurden entfernt – Free-Tier-Kontingente bzw. Provider-Politik.)*

Voice-Fallback-Kette (Server):
`HF MMS/Bark/MusicGen → Replicate (falls REPLICATE_API_TOKEN) → lokaler Formant-Synth`

### Moderne HF-Modelle 2026 (Recherche-Stand Aug 2026)

Falls die Default-Modelle getauscht werden sollen (per Env konfigurierbar):

| Zweck | Bisher | Moderner HF-Kandidat | Hinweis |
|---|---|---|---|
| TTS deutsch | `facebook/mms-tts-deu` | **Kokoro 82M** (Apache-2.0, CPU-fähig) oder **Qwen3-TTS** (3s-Cloning) | Kokoro = Effizienz-King, Qwen3 = Cloning |
| Gesang (SVS) | `suno/bark` | **SoulX-Singer** (42k h Training, MIDI/F0-Steuerung) | zero-shot Singing-Voice |
| Song | `facebook/musicgen-medium` | MusicGen bleibt HF-Standard; **ACE-Step 1.5** ist neuer, aber nicht auf HF-Inference | MusicGen-Weights CC-BY-NC beachten |
| Stems | `ryan5453/demucs` (Replicate) | **`StemSplitio/htdemucs-ft-pytorch`** oder `htdemucs_6s` | htdemucs_ft = beste Vocals; 6s = Piano/Gitarre extra |

HF-Serving: **Inference Providers** (Pay-as-you-go, 100k Credits/Monat frei) für
variable Last; **Inference Endpoints** (stundenweise GPU) erst ab Dauerlast.

---

## C. Cloud-Dienste

| Dienst | App-Teil | Modul | Zweck |
|---|---|---|---|
| **Supabase** (Postgres/REST) | libraryMONK, Kollaboration | `src/lib/supabaseClient.ts` (Browser, anon), `server/cloud.ts` + `cloudAutomation.ts` (Service-Role) | Musik-/Sample-Datenbank, Cloud-Sync, Upload-Metadaten |
| **Cloudflare R2** (S3-kompatibel) | libraryMONK | `server/cloud.ts`, `cloudAutomation.ts` | Objekt-Storage für Audio-Blobs |
| **GitHub** (SSH/API) | Deployment | Git-Remote, Actions-Workflows | Versionskontrolle + CI (Build & Verify, SonarCloud) |
| **SonarCloud** | Qualität | `.github/workflows/sonarcloud.yml` + `sonar-project.properties` | Statische Analyse, Quality Gate |

---

## D. Lokale Dienste (self-hosted, optional)

| Dienst | App-Teil | Modul | Zweck |
|---|---|---|---|
| **Ollama** (`http://127.0.0.1:11434`) | sequencerMONK/Describe | `server.ts` `ollamaGenerate()` | Lokales LLM für Komposition/Beschreibung (cloud-frei) |
| **Stem-AI-Dienst** (`STEM_AI_URL`, Python/Demucs) | stemMONK | `server.ts` `/api/separate-stems` | Lokale Stem-Trennung |
| **Master-Player-Dienst** (`services/master-player`, Python/FFmpeg) | masteringMONK | `server.ts` `proxyMasterPlayer` | Lokales Mastering/Mixing |
| **Audio-Runtime (Rust)** | NativeBackend | `core/audio/backends/NativeBackend.ts` + `RuntimeProcessManager` | Native DSP-Kette (EQ/Drive/Ceiling) per IPC |
| **Voice-Engine-CLI** (`VOICE_ENGINE`/`VOICE_CLI`) | voiceMONK | `server.ts` `/api/generate-voice` | Optionaler RVC/VITS-Synth |

---

## E. Echtzeit-/Transport-Infrastruktur

| Protokoll | App-Teil | Modul | Zweck |
|---|---|---|---|
| **Socket.io** (`/socket.io`) | Kollaboration | `server.ts` | WebRTC-Signaling, State-Sync |
| **WebRTC DataChannels** | Kollaboration | `src/utils/WebRTCManager.ts` | Plugin-Parameter/State-Replikation (4 User) |
| **Mediasoup (SFU)** | Kollaboration | `server.ts` | Audio-Streaming (vorbereitet) |
| **WebMIDI/WebHID/OSC** | controllerMONK | `core/adapters.ts` | Hardware-Anbindung (lokal, keine HTTP-API) |
