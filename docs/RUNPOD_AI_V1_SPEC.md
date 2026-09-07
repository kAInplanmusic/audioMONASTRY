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
| RunPod Deployment | **Serverless Endpoint** mit Worker-Wrapper (`runpod.serverless.start`) |
| GPU | **H200** (Template `audio-multimodel-h200-agent`, ID `c0xdrua0mz`) |
| AI auf RunPod | „alles was AI angeht“, inkl. LLM |
| Stem | Demucs + BS-RoFormer auf derselben GPU |
| Singing | bestmögliche EN/DE-Qualität – Kandidaten: ACE-Step 1.5 / Bark / Fish Speech (Benchmark vor Fixierung) |
| Audio Understanding | Qwen2-Audio-7B neu; Qwen-Omni entfernen |
| Essentia | auf RunPod als CPU-Handler |
| LLM | ein LLM auf RunPod, soll alles abdecken; Basis Qwen3-14B, ggf. Qwen3-30B-A3B benchmarken |
| Replicate | komplett entfernen |
| HF löschen | Endpoint + Model-Repo + Space `spatialMONK` |
| Deployment | GitHub Actions: Image bauen + RunPod-Serverless-Endpoint aktualisieren |
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
        ├── Audio-Upload → Cloudflare R2 (Signed URL)
        ├── /api/ai/*           → RunPod Serverless API (runsync/run)
        ├── /api/voice/*        → RunPod Serverless API
        ├── /api/sound/*        → RunPod Serverless API
        ├── /api/song/*         → RunPod Serverless API
        └── /api/separate-stems → RunPod Serverless API
        │
        ▼
RunPod Serverless Endpoint (H200, Template `audio-multimodel-h200-agent`)
        │
        ▼
Worker-Wrapper (`runpod.serverless.start`)
        │
        ▼
samplemonk-ai-runtime (eine Worker-Runtime)
        │
        ├── Model Manager (LRU, VRAM-Budget, UNLOADED/CPU_CACHE/GPU_ACTIVE)
        ├── Handler-Dispatch (Job-Input aus RunPod-Queue)
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

**Wichtig:**
- Keine 6 Container mit eigenem CUDA-Zugriff. Eine Runtime, ein Model Manager, eine GPU.
- **RunPod Serverless = Worker-Modell:** Die App spricht nicht direkt HTTP `/infer` an, sondern submitted Jobs an die RunPod-API (`runsync`/`run`).
- Große Audiodateien liegen vorher in **R2**; der Worker bekommt URLs, lädt sie herunter und schreibt Ergebnisse zurück nach R2.
- Der bisherige FastAPI-`/infer`-Pfad kann für Pod-/Lokal-Tests erhalten bleiben, ist aber nicht der Serverless-Produktivpfad.

---

## 5. Finale Modell-/Service-Liste

| Task | Modell | Quelle | Bisher vorhanden? | Neu? |
|---|---|---|---|---|
| TTS | XTTS-v2 | Coqui | MMS-TTS/Qwen3-TTS | ✅ neu |
| TTS expressiv (optional) | Fish Speech 1.5 | Fish Audio | – | optional, Lizenz prüfen |
| Singing | bestmögliche EN/DE-Qualität (ACE-Step 1.5 / Bark / Fish Speech) | div. | Bark vorhanden | Benchmark vor Fixierung |
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

### 9.1 Neue RunPod-Config
```env
RUNPOD_ENDPOINT_ID=xxxxxxxxxxxxxxxx
RUNPOD_API_KEY=rp_...   # entspricht RP_API_KEY
RUNPOD_AI_TASK_TIMEOUT_MS=600000
R2_BUCKET=...           # bestehende R2-Anbindung für Audio-Upload/Download
```

### 9.2 Änderungen (Serverless-Job-Modell)
- Große Audiodateien vor dem Job in R2 ablegen und Signed-URLs übergeben.
- Neuer Client `RunPodServerlessClient`:
  - `POST https://api.runpod.io/v1/{endpoint_id}/runsync` oder `/run`
  - Auth: `Authorization: Bearer {RUNPOD_API_KEY}`
  - Job-Input: `{ task, model, input: { audioUrl?, prompt?, ... } }`
  - Output enthält Ergebnis-URL(s) in R2 oder direkt JSON/Base64 für kleine Ergebnisse
- `/api/separate-stems`:
  - Replicate-Branch entfernen
  - stem-ai-Fallback entfernen (kein Fallback)
  - Upload → R2 → `task: stem.separate` an RunPod → Ergebnis-URLs zurückgeben
- `/api/voice/*`, `/api/sound/*`, `/api/song/*`:
  - Upload/Prompt → RunPod-Job → WAV aus R2 laden und an UI ausliefern
- `/api/ai/orchestrate` → ProviderRouter nutzt `RunPodProvider`

### 9.3 `providerRouter.ts`
- `HfEndpointProvider` entfernen oder durch `RunPodProvider` ersetzen
- `HfServerlessProvider` entfernen (LLM/Voice laufen über RunPod)
- `ReplicateProvider` entfernen
- Neue Provider-ID: `runpod`
- `RunPodProvider` nutzt `RunPodServerlessClient` und mapped alle Tasks

### 9.4 `LlmRouter.ts`
- Neuer Provider: `runpod` über `RunPodServerlessClient` (`task: llm`) oder separaten OpenAI-kompatiblen Worker-Endpoint
- Modell: `qwen3-14b` (Basis), ggf. `qwen3-30b-a3b` nach Benchmark
- HF/Qwen-Coder-Provider entfernen/deaktivieren
- DeepSeek/Cerebras/Ollama optional behalten (Entscheidung: Qwen3-RunPod primär)

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
| `RUNPOD_ENDPOINT_ID` | Serverless-Endpoint-ID (wird beim ersten Deploy erzeugt) |
| `RUNPOD_API_KEY` | RunPod API Key = `RP_API_KEY` |
| `RUNPOD_AI_TASK_TIMEOUT_MS` | Timeout |
| `RUNPOD_MODEL_CACHE_VOLUME` | Network-Volume-Pfad für HF_HOME/Modelle |
| `RP_API_KEY` | RunPod Personal Access Token (CI/Deployment) |
| `RPS3_ACCESS_KEY` / `RPS3_SECRET_KEY` | RunPod S3-kompatible Storage-Zugänge (optional) |
| `R2_BUCKET` + bestehende `CFR2_*` | Audio-Upload/Download für Worker-Jobs |

GitHub Secrets für Actions:
- `RP_API_KEY`
- `RUNPOD_ENDPOINT_ID` (nach erstem Deploy)
- `HF_TOKEN` (nur falls Modelle von HF Hub geladen werden)

---

## 12. RunPod Deployment

### 12.1 Zielbild
- GitHub Actions baut **Worker-Image** (inkl. `runpod_worker.py` + Runtime)
- Push nach GHCR
- RunPod **Serverless Endpoint** wird per API erstellt/aktualisiert:
  - GPU: H200
  - Template/Container: `audio-multimodel-h200-agent` (`c0xdrua0mz`) als Basis
  - Worker-Image austauschen
- Network Volume für `/data/hf-cache` und `/data/models`
- Worker-Health: RunPod-eigener Worker-Start + Modell-`/ready`-Zustand intern

### 12.2 Workflow-Ersatz
`.github/workflows/hf-endpoint.yml` → `.github/workflows/runpod-deploy.yml`

Schritte:
1. Checkout
2. Docker Login GHCR
3. Build & Push `samplemonk-ai-runtime` (mit `runpod_worker.py`)
4. RunPod-Serverless-Endpoint per API erzeugen/aktualisieren:
   - Name: `samplemonk-ai-runpod` (Vorschlag)
   - GPU: H200
   - Image: GHCR-Image
   - Template-ID: `c0xdrua0mz`
5. Endpoint-Status abfragen (`RUNPOD_ENDPOINT_ID`)
6. Smoke-Job `runsync` senden

### 12.3 Schnellstart/Kosten
- **Serverless Endpoint:** Scale-to-Zero → keine Kosten bei Inaktivität
- Kaltstart minimieren: Network Volume + ggf. warme Worker/FlashBoot
- H200 ist großzügig für Multi-Modell-Betrieb; Kosten/Verfügbarkeit vor Produktions-Deploy prüfen

---

## 13. Storage & Queue

- **Audio-Dateien:** Cloudflare R2 (`original/`, `generated/`, `stems/`, `previews/`, `cache/`)
- **Metadaten/Jobs/Scores:** Supabase
- **Job-Queue:** vorhandene In-Memory-Jobs erweitern; optional Redis nur dann, wenn mehrere RunPod-Worker/Replicas nötig sind
- **WebSocket:** vorhandenes Socket.io-Gateway kann Job-Status an UI liefern; RunPod-intern optional eigener WS/Redis

---

## 14. Test-/Cutover-Plan

1. `npm run verify` grün
2. Python-Runtime lokal mit `AI_RUNTIME_DEVICE=simulated` importieren inkl. `runpod_worker.py`
3. RunPod Serverless Endpoint erstellen, Worker-Start prüfen, `runsync`-Smoke-Job senden
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

1. **Singing-Modell:** Benchmark EN/DE zwischen ACE-Step 1.5, Bark und Fish Speech – danach fixieren
2. **LLM-Endmodell:** Qwen3-14B vs. Qwen3-30B-A3B auf H200 benchmarken
3. **XTTS/Stable-Audio-Lizenzen** für späteren kommerziellen Betrieb prüfen
4. **BS-RoFormer-Checkpoint/Lizenz** konkret festlegen
5. Redis-Queue nur bei Bedarf oder sofort?
6. **DeepSeek/Cerebras/Ollama** bleiben optional im LLM-Router oder werden entfernt (Qwen3-RunPod primär)

---

## 17. Risiken

- Mehrere große Modelle auf einer H200 → LRU/VRAM-Management weiterhin kritisch (aber mehr Luft als 48 GB)
- ACE-Step braucht je nach Qualität 20–24 GB; nicht parallel zu Qwen2-Audio erzwingen
- Lizenzrisiken (XTTS, Stable Audio, BS-RoFormer, Fish Speech)
- HF Hub als Downloadquelle bleibt Abhängigkeit, solange Gewichte nicht im Volume/Image liegen
- RunPod Serverless-Preise/Verfügbarkeit schwanken; H200-Kosten vor Produktions-Deploy prüfen

---

## 18. Nächste Schritte

1. Diese Spezifikation reviewen/ergänzen
2. Offene Entscheidungen fixieren
3. RunPod-Zugangsdaten/Template/Endpoint konkretisieren
4. Danach Umsetzung in Phasen (Runtime → Gateway → Deployment → HF-Löschung)
