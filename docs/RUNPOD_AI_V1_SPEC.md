# audioMONASTRY · RunPod AI V1 – Umsetzungs-Spezifikation

> Status: **Plan / Entwurf** – noch keine Code-Änderungen
> Stand: 2026-09-07
> Ziel: HF-Inference-Endpoint + HF-Serverless + Replicate ablösen, gesamte AI-Infrastruktur auf RunPod betreiben.

---

## 1. Ziel & Scope

- Kompletter Wechsel der AI-Inferenz von Hugging Face auf **RunPod**.
- **HF-Inference-Endpoint `samplemonk-ai` löschen** (aktuell `paused`).
- **HF-Serverless-Pfade** (TTS/Sing/Song/LLM) durch RunPod ersetzen.
- **Replicate komplett entfernen** – kein Fallback.
- **Stem-Separation läuft mit auf der RunPod-GPU** (Demucs + BS-RoFormer).
- **LLM läuft ebenfalls auf RunPod** (Qwen3-14B als Orchestrator/Chat).
- Kein neues separates „ai-infrastructure“-Monorepo von Grund auf; stattdessen vorhandene `services/samplemonk-ai-runtime` zur zentralen RunPod-AI-Runtime ausbauen.

---

## 2. Getroffene Entscheidungen (aus Abstimmung)

| Thema | Entscheidung |
|---|---|
| RunPod Deployment | egal – muss laufen, 0 $ wenn aus/abgeschaltet, schnell hochfahrbar → Ziel: RunPod Serverless oder Pod mit Network Volume/Scale-to-Zero-Praxis |
| AI auf RunPod | „alles was AI angeht“, inkl. LLM |
| Stem | Demucs + BS-RoFormer auf derselben GPU |
| Replicate | komplett entfernen |
| HF löschen | Endpoint + Model-Repo + Space `spatialMONK` |
| Deployment | GitHub Actions: Image bauen + RunPod aktualisieren |
| Architektur | eine GPU, ein Model Manager, dynamisches Laden – keine Multi-Container-GPU-Zerstückelung |

---

## 3. Ist-Zustand (relevant)

| Komponente | Pfad | Rolle |
|---|---|---|
| AI-Runtime (Custom Container) | `services/samplemonk-ai-runtime/` | FastAPI, Model Manager, `/infer`, `/mcp/tools`, `/metrics` |
| Model-Manifest | `services/samplemonk-ai-runtime/model_manifest.json` | Modell-Registry, Revision-Pinning |
| Runtime-Config | `services/samplemonk-ai-runtime/runtime_config.yaml` | VRAM-Budget, Device, Cache |
| HF-Endpoint-Manager | `services/samplemonk-ai-runtime/hf_manage_endpoint.py` | bisher HF create/update/delete |
| Stem-Service | `services/stem-ai/` | Demucs FastAPI (separater Container) |
| Master/Analyse | `services/master-player/` | Mixing/Mastering/Analyse (bleibt außerhalb RunPod) |
| API-Gateway | `server.ts` | Express: `/api/ai/*`, `/api/voice/*`, `/api/sound/*`, `/api/song/*`, `/api/separate-stems` |
| Provider-Router | `src/core/ai/orchestrator/providerRouter.ts` | HF-Endpoint / HF-Serverless / Replicate / Local |
| LLM-Router | `src/core/ai/LlmRouter.ts` | DeepSeek, Cerebras, HF, Ollama usw. |
| HF-Workflow | `.github/workflows/hf-endpoint.yml` | baut Image + deployed HF-Endpoint |
| Storage | Supabase + Cloudflare R2 | Metadaten + Audiofiles (bleibt) |

---

## 4. Zielarchitektur

```text
audioMONASTRY Web/Frontend
        │
        ▼
server.ts (Node/Express API Gateway – bleibt)
        │
        ├── /api/ai/*           → RunPod AI Runtime
        ├── /api/voice/*        → RunPod AI Runtime
        ├── /api/sound/*        → RunPod AI Runtime
        ├── /api/song/*         → RunPod AI Runtime
        └── /api/separate-stems → RunPod AI Runtime
        │
        ▼
RunPod GPU (A6000 48 GB o. ä.)
        │
        ▼
samplemonk-ai-runtime (ein Container/Worker)
        │
        ├── API Gateway (FastAPI): /health /ready /status /infer /jobs /ws
        ├── Model Manager (LRU, VRAM-Budget, UNLOADED/CPU_CACHE/GPU_ACTIVE)
        ├── Job Queue / Scheduler (intern, optional Redis)
        └── Handler:
              TTS (XTTS-v2)
              SFX (Stable Audio Open)
              Music/Song (ACE-Step 1.5)
              Stem (BS-RoFormer + Demucs)
              ASR (Whisper large-v3)
              Diarization (PyAnnote)
              Audio Analysis (Essentia, CPU)
              Audio Embedding (CLAP)
              Audio Understanding (Qwen2-Audio-7B)
              LLM/Orchestrator (Qwen3-14B)
        │
        ▼
Cloudflare R2 (Audio) + Supabase (Metadaten/Jobs) – bleibt
```

**Wichtig:** Keine 6 Container mit eigenem CUDA-Zugriff. Eine Runtime, ein Model Manager, eine GPU.

---

## 5. Finale Modell-/Service-Liste

| Task | Modell | Quelle | Bisher vorhanden? | Neu? |
|---|---|---|---|---|
| TTS | XTTS-v2 | Coqui | MMS-TTS/Qwen3-TTS | ✅ neu |
| TTS expressiv (optional) | Fish Speech 1.5 | Fish Audio | – | optional, Lizenz prüfen |
| Singing | ACE-Step 1.5 oder Bark | Stability/Meta | Bark vorhanden | Entscheidung offen |
| Sound FX | Stable Audio Open 1.0 | Stability AI | bereits im Manifest | Handler prüfen |
| Song/Music | ACE-Step 1.5 (Turbo + XL/SFT) | ACE-Step | MusicGen + ACE-Step-Client | ✅ neu als Runtime-Handler |
| Stem (Vocal) | BS-RoFormer | diverse HF-Checkpoints | – | ✅ neu |
| Stem (4-Stem) | Demucs v4 / htdemucs | Meta | `services/stem-ai` vorhanden | in Runtime integrieren |
| ASR | Whisper large-v3 | OpenAI | bereits im Manifest | in RunPod übernehmen |
| Diarization | PyAnnote 3.1 | pyannote | bereits im Manifest | in RunPod übernehmen |
| Audio Analyse (deterministisch) | Essentia + librosa + NumPy | Essentia | master-player Teil-Analyse | ✅ neu als Analyse-Handler (CPU) |
| Audio Semantic/Embedding | CLAP | LAION | bereits im Manifest | in RunPod übernehmen |
| Audio Understanding | Qwen2-Audio-7B-Instruct | Alibaba | Qwen2.5-Omni vorhanden | ✅ neu / ersetzen |
| Orchestrator/Chat/LLM | Qwen3-14B | Alibaba | externe LLM-Provider | ✅ neu auf RunPod |
| Text-Embedding/Retrieval | MiniLM / local | transformers.js | lokal vorhanden | bleibt lokal im Browser/Server |
| NLU / Voice Control | Qwen3-14B | Alibaba | Cerebras/DeepSeek | auf Qwen3-RunPod umstellen |

**Zusätzlich zu deiner Liste ergänzt:**
1. Whisper / ASR
2. PyAnnote / Diarization
3. Singing-Voice-Entscheidung
4. Essentia als deterministischer Analyse-Service
5. Text-Embedding/Retrieval (lokal)
6. CLAP als Semantic-Embedding
7. Qwen2-Audio statt/neben Qwen-Omni
8. Job-/WebSocket-Schnittstelle
9. Monitoring/Health/Metrics

---

## 6. Modell-Manifest-Erweiterung

`services/samplemonk-ai-runtime/model_manifest.json` um neue Einträge erweitern. Beispiel-Struktur (Planungswerte):

```json
{
  "id": "xtts-v2",
  "repository": "coqui/XTTS-v2",
  "revision": "<commit-hash>",
  "task": "tts",
  "framework": "custom",
  "estimatedVRAM": 6000,
  "loadClass": "FREQUENT",
  "preload": false,
  "concurrency": 1,
  "license": "coqui-public-model-license"
}
```

Weitere geplante Einträge:

| id | task | approx VRAM |
|---|---|---|
| `acestep-v15-turbo` | song | 20–24 GB |
| `bs-roformer` | stem.separate | 8–12 GB |
| `demucs` / `htdemucs` | stem.separate | 4–8 GB |
| `qwen2-audio-7b` | audio.understand | 14–20 GB |
| `qwen3-14b` | llm / nlu | 10–16 GB (quantisiert) |
| `stable-audio-open-1.0` | audio.generate | 10–16 GB |
| `whisper-large-v3` | audio.transcribe | 5–8 GB |
| `pyannote-diarization` | audio.diarize | 6–8 GB |
| `clap-music` | audio.embed | 4–6 GB |
| `essentia` | audio.analyze | CPU |

**Regel:** VRAM-Werte sind Budgets, keine Garantien. Vor dem produktiven Aktivieren je Modell benchmarken und Manifest korrigieren.

---

## 7. Handler-/Task-Mapping

Task im Orchestrator → Runtime-Handler:

| Orchestrator-Task | Runtime-Handler | Modell |
|---|---|---|
| `llm` / `nlu` | `llm_chat` | Qwen3-14B |
| `tts` | `xtts` | XTTS-v2 |
| `sing` | `sing` | Bark oder ACE-Step (Entscheidung offen) |
| `song` | `acestep` | ACE-Step 1.5 |
| `audio.generate` | `stable_audio` | Stable Audio Open |
| `audio.transcribe` | `transcribe` | Whisper large-v3 |
| `audio.diarize` | `diarize` | PyAnnote |
| `audio.analyze` | `essentia_analyze` | Essentia (CPU) |
| `audio.embed` | `clap_embed` | CLAP |
| `audio.understand` | `qwen_audio_understand` | Qwen2-Audio-7B |
| `audio.classify` | `classify` | AST (optional) |
| `stem.separate` | `stem_separate` | BS-RoFormer / Demucs (Router) |
| `multimodal` | optional Qwen2-Audio/Qwen-Omni | Entscheidung offen |

---

## 8. Runtime-Erweiterung `samplemonk-ai-runtime`

### 8.1 Vorhandene Basis nutzen
- `app.py` – FastAPI-Routen
- `model_manager.py` – Laden/Entladen/VRAM
- `handlers.py` – Inferenz-Handler
- `registry.py` / `model_manifest.json` – Registry
- `mcp_runtime.py` – MCP-Tools

### 8.2 Ergänzungen
1. Neue Handler in `handlers.py`:
   - `xtts`, `acestep`, `bs_roformer`, `demucs`, `qwen_audio`, `qwen3_llm`, `essentia`
2. Modell-Loader mit CPU-Cache/GPU-Cache-Stufen:
   - `UNLOADED`
   - `CPU_CACHE`
   - `GPU_ACTIVE`
3. LRU-Eviction im `model_manager.py`:
   - VRAM-Budget konfigurierbar (`runtime_config.yaml`)
   - Safety Margin 15–20 %
   - bei Bedarf ältestes/geringstpriores Modell entladen
4. Stem-Router:
   - Vocals/Instrumental → BS-RoFormer
   - 4-Stem → Demucs/htdemucs
5. LLM-Endpoint:
   - OpenAI-kompatibel (`/v1/chat/completions`) für Qwen3-14B via vLLM/TGI oder direkt im Handler
6. Essentia:
   - CPU-Handler oder separater interner Worker im selben Container/System
7. Job-/WebSocket-Endpunkte:
   - `POST /jobs`, `GET /jobs/{id}`, `WS /ws/jobs/{id}`
   - optional Redis-Queue

---

## 9. API-Gateway-Anbindung (`server.ts`)

### 9.1 Neue RunPod-URL-Config
```env
RUNPOD_AI_URL=https://<pod-or-endpoint>.runpod.ai
RUNPOD_AI_TOKEN=<token>
RUNPOD_AI_TASK_TIMEOUT_MS=600000
```

### 9.2 Änderungen
- `voiceRuntimeUrl()` → nutzt `RUNPOD_AI_URL`
- `voiceRuntimeInference()` → gleiche `/infer`-Signatur, Auth via `RUNPOD_AI_TOKEN`
- `/api/separate-stems`:
  - Replicate-Branch entfernen
  - stem-ai-Fallback entfernen (kein Fallback)
  - Aufruf: `POST {RUNPOD_AI_URL}/infer` mit `task: stem.separate`
- `/api/ai/orchestrate` → ProviderRouter nutzt `RunPodProvider`
- `/api/sound/generate`, `/api/song/generate` → RunPod statt HF-Serverless

### 9.3 `providerRouter.ts`
- `HfEndpointProvider` entfernen oder durch `RunPodProvider` ersetzen
- `HfServerlessProvider` entfernen (LLM/Voice laufen über RunPod)
- `ReplicateProvider` entfernen
- Neue Provider-ID: `runpod`

### 9.4 `LlmRouter.ts`
- Neuer Provider: `runpod` mit Base URL `{RUNPOD_AI_URL}/v1/chat/completions`
- Modell: `qwen3-14b`
- HF/Qwen-Coder-Provider entfernen/deaktivieren
- DeepSeek/Cerebras/Ollama optional behalten oder entfernen (Entscheidung)

---

## 10. Replicate + HF-Endpoint entfernen

### Replicate
- `ReplicateProvider` in `providerRouter.ts` löschen
- `/api/separate-stems`-Replicate-Branch löschen
- `scripts/replicate-smoke.ts` löschen
- `mcpRuntime.ts`: `stem.separate`-Beschreibung anpassen
- Env/Templates: `REPLICATE_API_TOKEN`, `REPLICATE_STEM_MODEL`, `VOICE_PROVIDER=replicate`, `REPLICATE_TTS_MODEL` usw. entfernen
- Doku/README-Referenzen entfernen

### HF-Inference
- `hf_manage_endpoint.py` nicht mehr im CI verwenden
- `.github/workflows/hf-endpoint.yml` durch RunPod-Workflow ersetzen
- `HF_ENDPOINT_URL`, `HF_PILOT_ENDPOINT_URL`, `HF_CLAP_ENDPOINT_URL` aus Env/Templates entfernen
- `HF_API_KEY`/`HF_TOKEN` nur behalten, wenn Modelle weiterhin von HF Hub geladen werden

---

## 11. Env & Secrets

Geplante neue Variablen:

| Variable | Zweck |
|---|---|
| `RUNPOD_AI_URL` | Basis-URL der RunPod-Instanz/des Endpoints |
| `RUNPOD_AI_TOKEN` | Auth-Token für die RunPod-Instanz |
| `RUNPOD_AI_TASK_TIMEOUT_MS` | Timeout |
| `RUNPOD_MODEL_CACHE_VOLUME` | Network-Volume-Pfad für HF_HOME/Modelle |
| `RP_API_KEY` | RunPod Personal Access Token (CI/Deployment) |
| `RPS3_ACCESS_KEY` / `RPS3_SECRET_KEY` | RunPod S3-kompatible Storage-Zugänge (optional) |

GitHub Secrets für Actions:
- `RP_API_KEY`
- optional `RUNPOD_ENDPOINT_ID` / Template-ID / Pod-ID
- `HF_TOKEN` (nur falls Modelle von HF Hub geladen werden)

---

## 12. RunPod Deployment

### 12.1 Zielbild
- GitHub Actions baut `services/samplemonk-ai-runtime` als Image
- Push nach GHCR
- RunPod wird per API aktualisiert:
  - Serverless Endpoint: Worker-Image austauschen
  - Pod: Template/Image aktualisieren und ggf. Pod neu starten
- Network Volume für `/data/hf-cache` und `/data/models`
- Healthcheck `/health`, Readiness `/ready`

### 12.2 Workflow-Ersatz
`.github/workflows/hf-endpoint.yml` → `.github/workflows/runpod-deploy.yml`

Schritte:
1. Checkout
2. Docker Login GHCR
3. Build & Push `samplemonk-ai-runtime`
4. RunPod-Update per API/Skript (`scripts/runpod-deploy.mjs` o. Ä.)
5. Status/Health abfragen

### 12.3 Schnellstart/Kosten
- **Serverless:** Scale-to-Zero → keine Kosten bei Inaktivität; Kaltstart akzeptabel, wenn Network Volume + warme Worker
- **Pod:** stoppen bei Inaktivität → keine Compute-Kosten; schneller Start über Template + Network Volume
- Empfehlung: zuerst Pod/Serverless testen, dann für Produktion die kostengünstigste Variante fixieren

---

## 13. Storage & Queue

- **Audio-Dateien:** Cloudflare R2 (`original/`, `generated/`, `stems/`, `previews/`, `cache/`)
- **Metadaten/Jobs/Scores:** Supabase
- **Job-Queue:** vorhandene In-Memory-Jobs erweitern; optional Redis nur dann, wenn mehrere RunPod-Worker/Replicas nötig sind
- **WebSocket:** vorhandenes Socket.io-Gateway kann Job-Status an UI liefern; RunPod-intern optional eigener WS/Redis

---

## 14. Test-/Cutover-Plan

1. `npm run verify` grün
2. Python-Runtime lokal mit `AI_RUNTIME_DEVICE=simulated` importieren
3. RunPod-Instanz starten, `/health` + `/ready` prüfen
4. Je Task Smoke-Test:
   - TTS (XTTS)
   - Song (ACE-Step Turbo)
   - Sound FX (Stable Audio)
   - Stem (Demucs + BS-RoFormer)
   - ASR (Whisper)
   - Embedding (CLAP)
   - Audio Understanding (Qwen2-Audio)
   - LLM/Chat (Qwen3)
5. API-Gateway auf RunPod-URL umstellen
6. E2E-Tests gegen RunPod
7. Replicate-Code entfernen
8. HF-Endpoint pausiert lassen → erst nach erfolgreichem Betrieb löschen

---

## 15. HF-Lösch-Checkliste

Erst nach erfolgreichem RunPod-Cutover:

```bash
# Endpoint löschen (mit .env-HF_TOKEN möglich)
python services/samplemonk-ai-runtime/hf_manage_endpoint.py delete  # ggf. erweitern

# oder manuell:
# HF-Console → Inference Endpoints → samplemonk-ai → Delete
```

Danach:
- [ ] Endpoint `samplemonk-ai` löschen
- [ ] Model-Repo `AnunnakiTools/samplemonk-ai-runtime` löschen
- [ ] Space `AnunnakiTools/spatialMONK` löschen
- [ ] GitHub Secrets/Workflows `hf-endpoint.yml` entfernen
- [ ] `.env`/Templates von HF-Endpoint-Variablen bereinigen
- [ ] `HF_TOKEN` nur behalten, falls Modell-Downloads von HF Hub weiter nötig

---

## 16. Offene Entscheidungen

1. RunPod **Pod vs. Serverless Endpoint** final festlegen
2. **Singing-Modell:** Bark behalten / ACE-Step / Fish Speech?
3. **Qwen2-Audio vs. Qwen-Omni** (ersetzen oder parallel)
4. **Essentia:** auf RunPod (CPU) oder separater Hetzner-Service?
5. **DeepSeek/Cerebras/Ollama** im LLM-Router behalten oder nur Qwen3-RunPod?
6. **XTTS/Stable-Audio-Lizenzen** für späteren kommerziellen Betrieb prüfen
7. **BS-RoFormer-Checkpoint/Lizenz** konkret festlegen
8. Redis-Queue nur bei Bedarf oder sofort?

---

## 17. Risiken

- Mehrere große Modelle auf einer 48-GB-GPU → LRU/VRAM-Management kritisch
- ACE-Step braucht je nach Qualität 20–24 GB; nicht parallel zu Qwen2-Audio erzwingen
- Lizenzrisiken (XTTS, Stable Audio, BS-RoFormer, Fish Speech)
- HF Hub als Downloadquelle bleibt Abhängigkeit, solange Gewichte nicht im Volume/Image liegen
- RunPod-Preise/Verfügbarkeit schwanken; A6000-48GB ist Startempfehlung, aber L40S/RTX-6000-Ada/Serverless-Angebote vergleichen

---

## 18. Nächste Schritte

1. Diese Spezifikation reviewen/ergänzen
2. Offene Entscheidungen fixieren
3. RunPod-Zugangsdaten/Template/Endpoint konkretisieren
4. Danach Umsetzung in Phasen (Runtime → Gateway → Deployment → HF-Löschung)
