# audioMONASTRY – Security-Audit (DCT-116/128)

Stand: 2026-09-03 · Scope: alle externen Eingaben.

| Bereich | Maßnahme | Status |
|---|---|---|
| Secrets | Alle API-Keys nur serverseitig in `.env` (600, gitignored); Bundle-Check ohne Keys | ✅ |
| Uploads | Extension+MIME-Validierung, Größen-Limit, sanitized Object-Key (`safeName`), multipart-Parsing | ✅ (Tests: 415/415/413-Pfade) |
| AI-Prompts | Längen-Limits (8000/500 Zeichen), Modell-Regex-Whitelist, keine Keys in Logs | ✅ |
| WebSocket/WebRTC-Messages | `PLUGIN_STATE_UPDATE`-Payload validiert (Typ/State-Enum), Relay nur im Session-Room | ✅ |
| Plugin-Manifest | `EXPECTED_PLUGIN_COUNT`-Validierung + Fallback-Registry | ✅ |
| XSS/Injection | React-Escaping, keine HTML-Injection, Supabase-RLS | ✅ |
| COOP/COEP/CORP | Cross-Origin-Isolation-Header gesetzt | ✅ |
| Rate-Limiting | `/api` 60 req/min/IP | ✅ |
| Path-Traversal | Upload-Key wird aus `safeName` + Zeitstempel erzeugt (kein User-Pfad) | ✅ |

## Pen-Test `/api/ai/*` (GAP-4, 2026-09-03)

Automatisiert in `tests/aiSecurityPenTest.test.ts` (läuft in `npm run verify`
und in der Nightly-CI). Geprüfte Angriffsflächen:

| Angriffsfläche | Prüfung | Ergebnis |
|---|---|---|
| Auth | Request ohne Token, Token falscher Inhalt (gleiche Länge), Token per Header und per Cookie | ✅ 401 `STUDIO_TOKEN_REQUIRED`, gültiger Token 200, `/api/health` bleibt offen |
| Rate-Limit | Wiederholte Calls auf `/api/ai/compose` gegen den Expensive-Limiter (Key = Studio-Token) | ✅ 429 nach Limit, kein Bypass über Token-Key |
| Input-Validierung | fehlende `task`/`model`, typfremde Felder (Objekt/Array/Zahl), leerer Prompt, 200 000-Zeichen-Prompt, Path-Traversal im MCP-Tool-Namen, SQLi-artige Job-ID | ✅ 400/404/422, kein Crash, kein Stacktrace im Response-Body |
| SSRF | `model`/`prompt` mit `http://169.254.169.254/...`, lokaler Sentinel-URL und `file:///etc/passwd` | ✅ Sentinel-Server erhält **0** Requests; Outbound geht ausschließlich an das server-seitig konfigurierte `HF_ENDPOINT_URL` |

**Offen (Betreiber-Schritt):** Rotation des HF-Endpoint-Secrets (Token-Rotation
ist in `docs/AI_SECURITY_GUIDE.md` dokumentiert, die eigentliche Rotation
erfolgt in der HF-/Hetzner-Konsole).

**Automatisierte Gates:** `scripts/validate-interface-boundaries.mjs` → 0 Verstöße ·
`npm audit` auf dem Zielhost ausführen (Sandbox ohne Registry-Zugriff) ·
`tests/aiSecurityPenTest.test.ts` (Pen-Test `/api/ai/*`) ·
`tests/supabaseRls.test.ts` (RLS über alle `database/*.sql`).
