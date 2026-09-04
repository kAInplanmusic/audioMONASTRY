# audioMONASTRY – Handover (2026-08-31)

## Startanleitung

```bash
# 1) Abhängigkeiten
npm ci

# 2) Verifikation (tsc + Tests + Boundary-Scan)
npm run verify

# 3) Dev-Server
npm run dev                # http://localhost:8080

# 4) Production-Build + Start
npm run build && npm start # dist/server.cjs, Port 8080
```

**AI-Runtime lokal (ohne GPU, Simulationsmodus):**
```bash
cd services/samplemonk-ai-runtime
pip install --target /tmp/smoke-ai-deps fastapi uvicorn
PYTHONPATH=/tmp/smoke-ai-deps:. AI_RUNTIME_DEVICE=simulated \
  /tmp/smoke-ai-deps/bin/uvicorn app:app --port 8000 --ws none
```

**HF-Endpoint (produktiv):**
- Endpoint `samplemonk-ai` wird durch GitHub Actions `.github/workflows/hf-endpoint.yml`
  gebaut und angelegt (Image → GHCR → HF-Endpoint, A100 ×1 us-east-1, Scale-to-Zero 20 min).
- Nach erfolgreichem Lauf `HF_ENDPOINT_URL` in `.env` der Hetzner-App eintragen.

## Bekannte Einschränkungen

1. **GPU-Benchmarks ausstehend** – Cold/Warm-Start, Model-Load/Switch, VRAM-Peaks
   werden erst nach dem ersten erfolgreichen Endpoint-Lauf gemessen.
2. **Revision-Pins** – 9 Modelle sind auf echte Commit-Hashes gepinnt; bei
   Modell-Updates neue Hashes per HF-API auflösen und Manifest + TS-Registry
   synchron aktualisieren.
3. **Lizenz** – Projekt privat/Forschung; CC-BY-NC-Modelle (MusicGen/Bark/MMS/MERT)
   sind für diesen Zweck freigegeben, vor kommerzieller Nutzung neu bewerten.
4. **Supabase-Migration `ai_migration_001.sql`** muss einmalig im Supabase-SQL-Editor
   ausgeführt werden (nicht-destruktiv, Rollback im Datei-Header).
5. **GitHub-Secrets erforderlich:** `HF_TOKEN`, `GHCR_USERNAME`, `GHCR_PASSWORD`,
   `SONAR_TOKEN` (für Actions-Workflows).
6. **CI-Workflows:** `build`, `nightly`, `ai`, `hf-endpoint`, `sonarcloud`,
   `live-stress` (manuell), `main` (manuell). `midi.yml`/`wasm.yml` wurden entfernt.

## Rollback

- App: `deploy.sh` nutzt Rollback-Image; alternativ vorherigen Commit deployen.
- AI-Runtime: `docker compose -f docker-compose.ai.yml down`.
- HF-Endpoint: im Dashboard auf vorherige Image-/Modell-Version zurücksetzen oder
  `python services/samplemonk-ai-runtime/hf_manage_endpoint.py` mit altem `IMAGE`.
- Supabase: Rollback-SQL im Header von `database/ai_migration_001.sql`.
