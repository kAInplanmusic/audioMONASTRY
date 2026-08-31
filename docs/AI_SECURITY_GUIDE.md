# audioMONASTRY – AI Security Guide

## Grundsätze

- Keine Secrets im Client, keine `VITE_*`-Secrets, Boundary-Scan erzwingt Kapselung.
- Keine Shell-Ausführung durch AI; MCP ruft nur registrierte Tools auf.
- Destruktive MCP-Aktionen (project.delete, track.delete, overwrite) sind
  nicht freigeschaltet und erfordern `DESTRUCTIVE`-Permission.

## Umgesetzte Maßnahmen

| Bereich | Maßnahme |
|---|---|
| Auth | Bestehendes Studio-Token (`x-studio-token`) + Portal-Cookie; Admin nur mit `ADMIN_TOKEN` |
| Secrets | `aiLogger.redactSecrets` (Keys/Tokens/Bearer) vor jedem Log |
| MCP | Permission-Level READ<WRITE<EXECUTION<DESTRUCTIVE, Tool-Whitelist |
| Input | task/model-Längenlimits, Modell-Override-Regex (bestehend), Audio-Größenlimit 25 MB (Container) |
| SSRF | HF-Endpoint-URL nur serverseitig aus `HF_ENDPOINT_URL`; keine Client-URLs |
| Command-Injection | Keine `exec`/`spawn` in AI-Pfaden; Python-Runtime führt nur registrierte Handler aus |
| Resource-Exhaustion | Job-Concurrency-Limits, Dedup, Timeouts, 25-MB-Audio-Deckel, VRAM-Guard |
| Logging | Keine privaten Audio-Daten in Logs; Fehlertexte gekürzt |

## Offene Punkte (vor Produktion)

- [ ] HF-Token-Rotation dokumentieren (Endpoint-Secret)
- [ ] Pen-Test der neuen Routen (`/api/ai/*`)
- [x] Lizenz-Verifikation: privat/Forschung, CC-BY-NC ok (2026-08-31)
