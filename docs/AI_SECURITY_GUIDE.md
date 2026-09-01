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

## HF-Token-Rotation (GAP-4, dokumentiert 2026-09-01)

Ziel: Kompromittierte HF-Tokens regelmäßig ersetzen (Empfehlung: alle 90 Tage).

1. Neues Token im HF-Dashboard erzeugen: **Settings → Access Tokens → Create token** (fein granular, z. B. `read` für Hub + `inference`/`manage` für Endpoint).
2. Auf allen Hetzner-Hosts/Containern aktualisieren:
   - `.env` → `HF_TOKEN=…` (bzw. `HF_API_KEY` falls verwendet)
   - Docker-Secrets/Compose-Umgebungen nicht committen
3. Runtime-Neustart: `docker compose up -d app ai` bzw. betroffene Services neu starten.
4. Altes Token im HF-Dashboard **revoken** und in `docs/FEHLER_REGISTER_2026.md` als FR-Eintrag mit Datum dokumentieren.
5. CI-Secret (`HF_TOKEN` in GitHub Actions) ebenfalls rotieren, falls dort hinterlegt.

## Offene Punkte (vor Produktion)

- HF-Token-Rotation dokumentiert ✅; **Rotation selbst** (Secret ersetzen) noch offen → getrackt in `MASTER_TODO.md` GAP-4
- Pen-Test der neuen Routen (`/api/ai/*`) → getrackt in `MASTER_TODO.md` GAP-4
- [x] Lizenz-Verifikation: privat/Forschung, CC-BY-NC ok (2026-08-31)
