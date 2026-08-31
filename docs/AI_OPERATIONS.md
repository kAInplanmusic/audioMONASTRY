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
