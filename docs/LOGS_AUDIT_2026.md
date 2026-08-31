# Logs-Audit 2026 (GAP-1)

> Stand: 2026-08-31 · Systematische Auswertung aller lokalen Log-/Session-Quellen.

## Quellen & Ergebnis

| Quelle | Treffer | Klassifikation |
|---|---|---|
| `~/.continue/sessions/*.json` (325 MB + 174 MB) | 2 Sessions, 1535 Nachrichten | Vorgänger-Kontext (Hetzner-Test, Repo-Klone); keine offenen App-Fehler |
| `~/.deepcode/logs/error.log` | 1 Eintrag | DNS-Fehler `api.deepseek.com` (extern, bekannt) |
| `~/.deepcode/audit.log` + `agent-sessions.json` | 3 Einträge | 4-User-Session-Init (lila/tuerkis/orange/blau) – dokumentiert |
| `~/.xsession-errors*` | Desktop-Warnungen (thunar/xfwm4/blueman) | OS-Ebene, nicht App-relevant |
| `~/.npm/_logs/*` | 10 Läufe | `npm run verify`-Historie, wrangler deploys ok |
| `test-results/.last-run.json` | 1 | zuletzt `passed` (vor Testfix) |

## Klassifikation der 158 Fehler-/Fail-Treffer

- **Extern/DNS:** 1 (DeepSeek-API nicht erreichbar → LlmRouter-Fallback aktiv)
- **OS-/Desktop-Warnungen:** ~150 (thunar-volman, xfwm4, polkit – nicht App)
- **Bekannte App-Fehler:** 1 (Stem-Failure-Injection-Timeout → **gefixt D22**)
- **Offene App-Fehler:** 0

## Nachgezogene Tasks

- Stem-Timeout → AUD-P1-1 (erledigt)
- Sonst keine neuen Tasks erforderlich.
