# audioMONASTRY – AI Operations

> Verbindliche Zahlen: siehe docs/INFRA_KONSTITUTION.md.

## Täglicher Betrieb

- `GET /api/ai/orchestrator/status` → Session, Modelle, Speicher, Kosten.
- `GET /api/ai/jobs` → Job-Historie (Dedup/Fehler sichtbar).
- `GET /api/metrics` → Prometheus-Metriken der App.
- Container: `GET /metrics` → uptime, models_loaded, vram_used, inference_count.

## Scale-to-Zero

- Session-Idle-Timeout (Default 20 min) → Session IDLE → Scale-to-Zero-Anforderung.
- Beim nächsten Request startet bei Bedarf der Vast.ai-Rollenworker (Retry/Backoff mit harten Kosten- und Readiness-Grenzen).
- Gewichte werden aus dem gepinnten R2-Mirror bereitgestellt; persistente lokale Caches sind nur bei tatsächlich vorhandenen Laufwerken garantiert.

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

## Drittanbieter-Konfigurationsstand (2026-11-17)

| Dienst | Konfiguration | Status |
|---|---|---|
| Vast.ai GPU-Flotte | `deploy/gpu/pod-fleet.json`, `deploy/gpu-provider.json` | Acht Rollen; budget- und readiness-gesteuert |
| Hugging Face Hub | `HF_TOKEN` nur für Modellgewichte | Kein eigener Inference-Endpoint |
| Replicate | `REPLICATE_API_TOKEN`, `REPLICATE_STEM_MODEL` | Token/Credit Live-Check bei nächstem Zugang |
| Supabase | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE`, `VITE_SUPABASE_ANON_PUB` | RLS für AI-Tabellen offen (FA-P1-1) |
| Cloudflare R2 | `CFR2_*` | dokumentiert |
| Caddy/SFU/master-player | Compose-Definitionen | Health-Check bei Deployment |
| Stem-ai | `STEM_AI_URL` (runtime, D22), `STEM_AI_PROVIDER` | Provider-Ausfall → schneller 502 verifiziert |

**Regel:** `npm run verify` vor jedem Deployment; `scripts/hetzner/smoke-test.sh`
als externer Health-Gate.

## Warm-Keep-Option (LOW PRIORITY, dokumentiert 2026-09-03)

Selten genutzte Fenster ohne Kaltstart: `AI_WARM_KEEP=true` aktiviert einen
15-minütigen Keep-Alive-Heartbeat der AI-Session, solange der Endpoint läuft.
Standard bleibt **aus** (Scale-to-Zero spart Kosten). Umsetzung im
`SessionManager` (Heartbeat-Timer), Config über Env – keine UI nötig.

## Modell-Splitting (OPTIONAL, dokumentiert 2026-09-03)

Erst bei **dauerhafter Überlast** und nur **mit Freigabe**:
- Modell-Splitting = ein Modell auf mehrere GPUs/Worker verteilen.
- Voraussetzung: VRAM-Benchmarks (AI-GPU-Benchmarks) zeigen dauerhaft > 90 %
  Auslastung eines GPU-Workers (A40 48 GB), und die Obergrenze „max. 8
  GPU-Rollen-Endpoints“ wird bewusst erweitert. Vorher NICHT umsetzen.
  (Stand 2026-09-20: die Flotte wird rollenbasiert verwaltet;
  kanonisch sind **max. 8 Vast.ai-Rollen**, `docs/INFRA_KONSTITUTION.md` §1.)