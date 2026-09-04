# audioMONASTRY – AI Troubleshooting

| Symptom | Ursache | Lösung |
|---|---|---|
| `/api/ai/orchestrate` 502 | Alle Provider fehlgeschlagen | Logs prüfen (`AI_LOG_LEVEL=DEBUG`); HF-Token/Endpoint-URL prüfen |
| `MODEL_UNAVAILABLE` 503 | Modell nicht geladen / deps fehlen im Container | `model.load` via MCP; Container-Logs (`pip`-Deps) prüfen |
| `ENDPOINT_WAKING` (wiederholt) | Scale-to-Zero, Endpoint startet | Normal; Retry läuft automatisch (Backoff). Bei >5 Versuchen: Idle-Timeout/Quota prüfen |
| `INSUFFICIENT_CREDIT` 402 | Replicate-Guthaben leer | Guthaben aufladen oder lokal/stem-ai-Fallback nutzen |
| `STEM_QUEUE_FULL` 429 | Stem-Concurrency erreicht | `Retry-After` beachten; `STEM_MAX_JOBS` prüfen |
| `VRAM exhausted` | Modell passt nicht | Eviction greift automatisch; sonst `AI_MAX_VRAM`/Manifest prüfen |
| Job bleibt QUEUED | Concurrency-Limit | `GET /api/ai/jobs`; Limit je Task (`AI_MAX_CONCURRENCY_*`) |
| Duplicate request | Absichtlich dedupliziert | Gleiche jobId wird zurückgegeben (SampleMONK-Regel) |
| Runtime `/ready` 503 | Startup-Fehler/CORE-Modell fehlt | Container-Logs (JSON) prüfen; Manifest-Revisionen prüfen |

## Logs

Alle AI-Logs sind JSON (eine Zeile pro Event) mit `sessionId`, `jobId`,
`model`, `provider`, `durationMs`, `error`. Secrets werden redactiert.
