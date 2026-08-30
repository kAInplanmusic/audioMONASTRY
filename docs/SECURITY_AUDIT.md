# audioMONASTRY – Security-Audit (DCT-116/128)

Stand: 2026-08-27 · Scope: alle externen Eingaben.

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

**Automatisierte Gates:** `scripts/validate-interface-boundaries.mjs` → 0 Verstöße ·
`npm audit` auf dem Zielhost ausführen (Sandbox ohne Registry-Zugriff).
