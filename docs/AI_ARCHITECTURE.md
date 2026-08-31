# audioMONASTRY – AI-Architektur (Deep Audit, 2026-08-29)

## Rollen & Zuständigkeiten (final)

| Aufgabe | Provider | Warum |
|---|---|---|
| Text, Prompts, Daten, Agent, MOA/MCP-Planung | **DeepSeek V4 Flash** | günstig, reasoning-fähig, JSON-stabil |
| Komplexe Reasoning-Tasks | **DeepSeek V4 Pro** | nur wenn Flash nicht reicht |
| TTS, Gesang, Song-Generierung | **Hugging Face** (MMS-TTS, Bark, MusicGen) | Free-Tier/PRO, spezialisierte Audio-Modelle |
| Stems (Demucs) | **Replicate** (`ryan5453/demucs`) | Serverless-GPU, ~3–5 Cent/Song, schnell (~25–45 s) |
| Lokaler Fallback (MOA/Sprachbefehle/TTS) | **Ollama** (`qwen2.5:7b`) auf ai-1 (CCX33) | offline, keine API-Kosten |
| Notfall | Gemini/OpenAI | nur `AI_EMERGENCY_PROVIDERS=true` |

**Groq ist entfernt** (Pay-as-you-go-Umstellung offen).

## Wer managt die 17 Plugins im AI-Modus?

- **Server-seitig:** `MoaAgent` (DeepSeek) zerlegt die Aufgabe in Schritte
  (`[{pluginId, command, prompt}]`) und `VoiceControlService` führt sie über die
  `pluginCommandRegistry` aus.
- **Client-seitig:** `AUTO_AI`-Module zeigen den AI-Vorschlag; der **User**
  bestätigt. `PRO`-Module werden über das Lock-System exklusiv gesteuert.
- **Admin/Root-Debugging:** `GET /api/admin/debug` mit Header
  `x-admin-token: <ADMIN_TOKEN>` liefert Metriken, Stem-Status, LLM-Provider,
  Node-/RAM-Info. `ADMIN_TOKEN` in `.env` setzen.

## Empfehlung Guthaben

- **Hugging Face:** Free-Tier reicht für den Start. Bei Limits → **PRO $9/Monat**
  (nicht nötig, 10 € aufladen ist okay als Puffer).
- **DeepSeek:** **5 €** reichen bei 4 Usern für Wochen (Flash ist extrem billig).
- **Replicate:** **10 €** = ~200–300 Stem-Jobs (à 3–5 Cent). Perfekt.

## Konfiguration (.env)

```bash
# Cloud-KI
DEEPSEEK_API_KEY=sk-...
HF_API_KEY=hf_...
MISTRAL_API_KEY=          # optional

# Stems via Replicate (Pay-per-Use)
STEM_AI_PROVIDER=replicate
REPLICATE_API_TOKEN=r8_...
REPLICATE_STEM_MODEL=ryan5453/demucs

# Lokale KI (ai-1)
OLLAMA_URL=http://<ai-1>:11434
OLLAMA_MODEL=qwen2.5:7b

# Admin/Root
ADMIN_TOKEN=<langes-zufalls-token>
```

## Flotte (5 Stunden-Instanzen, ohne GPU)

| # | Instanz | Typ | Rolle |
|---|---|---|---|
| 1 | ai-1 | CCX33 | Ollama (lokal) + Stem-CPU-Fallback |
| 2 | app-1 | CPX31 | App/API/Signaling |
| 3 | sfu-1 | CPX31 | Mediasoup-SFU |
| 4 | master-1 | CX23 | FFmpeg-Mastering |
| 5 | edge-1 | CX23 | Staging/Smoke/Monitoring |

Kosten: **≈ 0,36 €/h** + API-Verbrauch (Replicate ~3–5 Cent/Stem-Job).

## Offene AI-Punkte

- [x] Replicate-Token live testen (1 Stem-Job) – ✅ 2026-08-31 via `scripts/replicate-smoke.ts`: Account `kainplanmusic` gültig, Modell `cjwbw/demucs` (Version aufgelöst), **1 echter Stem-Job erfolgreich** (Prediction `7ksxd3mredrg80d0amh97pry1w`, Outputs: vocals/bass/drums/other)
- [x] HF-PRO-Entscheidung nach Free-Tier-Beobachtung – Entscheidung: **Free-Tier beibehalten** (DeepSeek + Hugging Face live verifiziert); PRO erst bei Limit-Erreichen
- [x] Mistral-Account optional (Function-Calling für MOA-Tools) – **bewusst zurückgestellt**: DeepSeek V4 deckt MOA/MCP-Planung ab
- [x] Groq-Alternative evaluieren (nur wenn HF/DPS-Limits erreicht werden) – **bewusst zurückgestellt**: Limits noch nicht erreicht

---

## Implementierungsstand 2026-08-31 (AI Orchestrator)

Die obige Rollenverteilung ist unverändert gültig. Neu implementiert:

- **AI Orchestrator** (`src/core/ai/orchestrator/`): JobManager (Dedup +
  Concurrency), SessionManager (Lifecycle/Idle→Scale-to-Zero), ModelManager
  (VRAM-Guard/LRU/Eviction), McpRuntime (Permissions), ProviderRouter
  (HF-Endpoint/Serverless/Replicate/Local), CostTracker, AiLogger
  (strukturiert + Secret-Redaction), aiPersistence (Supabase).
- **Server-Routen** (`/api/ai/*`): orchestrate, jobs, session, models, mcp/tools.
- **Custom Container** (`services/samplemonk-ai-runtime/`): FastAPI-Runtime mit
  `/health`, `/ready`, `/status`, `/models`, `/metrics`, `/infer`, `/mcp/tools`,
  Model Manager + Manifest (Revision-Pinning), Dockerfile, startup.sh.
- **Supabase-Migration** `database/ai_migration_001.sql` (Sessions/Jobs/Usage/
  Errors/Costs/MCP-Audit).
- **Deployment/CI**: `docker-compose.ai.yml`, `scripts/deploy-ai.sh`,
  `.github/workflows/ai.yml`.
- **Tests**: `tests/aiOrchestrator.test.ts` (18 Tests); Verify grün
  (tsc + 338 Tests + Boundary-Scan 0). Python-Runtime-Smoke verifiziert
  (simulated-Modus).

Details: `AITodo.md`, `docs/AI_DEPLOYMENT_GUIDE.md`, `docs/MODEL_REGISTRY_GUIDE.md`,
`docs/MCP_TOOL_GUIDE.md`, `docs/AI_OPERATIONS.md`, `docs/AI_COST_GUIDE.md`,
`docs/AI_SECURITY_GUIDE.md`.
