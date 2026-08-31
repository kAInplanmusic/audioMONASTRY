# audioMONASTRY – AI Local Development

> Ohne GPU/Docker lauffähig – alle AI-Komponenten sind auch offline testbar.

## Voraussetzungen

- Node 22, `npm ci`
- Python 3.11+ (für Runtime-Smoke; FastAPI/uvicorn optional)

## Orchestrator-Tests

```bash
npm run verify                                  # alles
npx vitest run tests/aiOrchestrator.test.ts     # nur AI
```

## Python-Runtime lokal (simulierter Modus, ohne GPU)

```bash
cd services/samplemonk-ai-runtime
pip install --target /tmp/smoke-ai-deps fastapi uvicorn
PYTHONPATH=/tmp/smoke-ai-deps:. AI_RUNTIME_DEVICE=simulated \
  /tmp/smoke-ai-deps/bin/uvicorn app:app --port 8000 --ws none
```

- `/health` → 200 (Prozess)
- `/ready` → 200 (Runtime bereit; Modelle simuliert geladen)
- `/status` → endpoint/gpu/runtime/models
- `/infer` → 503 `MODEL_UNAVAILABLE`, wenn Modell nicht geladen bzw. deps fehlen
  (kontrollierte Degradation, kein Fake-Ergebnis)

## Env (lokal)

```bash
AI_RUNTIME_DEVICE=simulated
AI_LOG_LEVEL=DEBUG
HF_ENDPOINT_URL=          # leer lassen → Serverless/Local-Provider
```

## Wichtig

- `AI_RUNTIME_DEVICE=cuda` nur auf GPU-Host (A100).
- Revision-Pinning: Manifest-Einträge mit `REVISION_PENDING` müssen vor dem
  ersten Produktions-Deployment auf echte Commit-Hashes gepinnt werden.
