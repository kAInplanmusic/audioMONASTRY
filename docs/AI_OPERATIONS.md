# audioMONASTRY – AI Operations

## Täglicher Betrieb

- `GET /api/ai/orchestrator/status` → Session, Modelle, Speicher, Kosten.
- `GET /api/ai/jobs` → Job-Historie (Dedup/Fehler sichtbar).
- `GET /api/metrics` → Prometheus-Metriken der App.
- Container: `GET /metrics` → uptime, models_loaded, vram_used, inference_count.

## Scale-to-Zero

- Session-Idle-Timeout (Default 20 min) → Session IDLE → Scale-to-Zero-Anforderung.
- Beim nächsten Request wacht der Endpoint auf (502 → Retry/Backoff).
- Gewichte bleiben im persistenten `HF_HOME`-Cache – kein erneuter Download.

## GPU-Wechsel

Nur mit Betreiber-Freigabe. Trigger:
- VRAM dauerhaft > 85 % → Bericht + Vorschlag (Quantisierung/Unload).
- p95-Latenz über Zielwert → Bericht + Vorschlag (Optimierung).
- Queue-Tiefe > 3 über 10 min → Bericht + Freigabe für H100/H200 einholen.

## Backup/Recovery

- Supabase-Migrationen versioniert (`database/ai_migration_001.sql`), nicht-destruktiv.
- Rollback-SQL im Migrations-Header dokumentiert.
- AI-Daten sind rekonstruierbar (Jobs/Sessions/Kosten); Audio-Blobs bleiben in R2.

## Wartung

- `npm run verify` vor jedem Deployment.
- `scripts/deploy-ai.sh` für lokalen/Hetzner Runtime-Smoke.
- Manifest-Revisionen bei Modell-Updates pinnen und testen.

## Drittanbieter-Konfigurationsstand (2026-08-31)

| Dienst | Konfiguration | Status |
|---|---|---|
| Ollama (ai-1) | `OLLAMA_URL`, `OLLAMA_MODEL` | dokumentiert in `.env.example` |
| HF-Endpoint (samplemonk-ai) | `HF_ENDPOINT_URL`, `HF_TOKEN`, `HF_API_KEY`, `AI_MAX_GPU_ENDPOINTS=1` | **Einziger GPU-Endpoint (Konsolidierung)**; Whisper+CLAP migriert; pilot/clap deaktiviert |
| Replicate | `REPLICATE_API_TOKEN`, `REPLICATE_STEM_MODEL` | Token/Credit Live-Check bei nächstem Zugang |
| Supabase | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE`, `VITE_SUPABASE_ANON_PUB` | RLS für AI-Tabellen offen (FA-P1-1) |
| Cloudflare R2 | `CFR2_*` | dokumentiert |
| Caddy/SFU/master-player | Compose-Definitionen | Health-Check bei Deployment |
| Stem-ai | `STEM_AI_URL` (runtime, D22), `STEM_AI_PROVIDER` | Provider-Ausfall → schneller 502 verifiziert |

**Regel:** `npm run verify` vor jedem Deployment; `scripts/hetzner/smoke-test.sh`
als externer Health-Gate.
