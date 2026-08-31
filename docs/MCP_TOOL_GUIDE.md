# audioMONASTRY – MCP Tool Guide

## Server-MCP (`/api/ai/mcp/tools/*`)

Nur serverseitig existierende Funktionen sind exponiert (keine Fake-Tools).

| Tool | Kategorie | Permission |
|---|---|---|
| `session.getState` | session | READ |
| `runtime.status` | session | READ |
| `models.list` | session | READ |
| `model.load` | session | EXECUTION |
| `model.unload` | session | EXECUTION |
| `audio.classify` | analysis | EXECUTION |
| `audio.transcribe` | analysis | EXECUTION |
| `audio.embed` | analysis | EXECUTION |
| `audio.analyze` | analysis | EXECUTION |
| `audio.generate` | generation | EXECUTION |
| `stem.separate` | audio | EXECUTION |
| `sample.search` | sample | READ |

## Permissions

`READ(1) < WRITE(2) < EXECUTION(3) < DESTRUCTIVE(4)`.
DESTRUCTIVE-Aktionen erfordern explizit `permission: "DESTRUCTIVE"` und sind
im aktuellen Tool-Set nicht freigeschaltet (Schutz vor project.delete,
track.delete, overwrite assets).

## Aufruf

```bash
curl -X POST https://<app>/api/ai/mcp/tools/models.list \
  -H 'Content-Type: application/json' -d '{"permission":"READ"}'

curl -X POST https://<app>/api/ai/mcp/tools/audio.classify \
  -H 'Content-Type: application/json' \
  -d '{"permission":"EXECUTION","model":"ast-audioset","audioBase64":"..."}'
```

## Client-seitige DAW-Tools

`project/track/mixer/plugin`-Zustand liegt client-seitig und läuft über die
bestehende `pluginCommandRegistry` (VoiceControlService) – nicht über das
Server-MCP (bewusst, um keine Fake-Tools zu bauen).
