# Fehler-Register 2026 (GAP-8)

> Single Source of Truth für bekannte Fehler. Jede Zeile = ID, Quelle,
> Severity, Status, Task-Link.

| ID | Quelle | Severity | Beschreibung | Status | Task-Link |
|---|---|---|---|---|---|
| FR-001 | `npm run verify` | Hoch | Stem-Failure-Injection-Timeout (stem-ai down → kein 502) | ✅ Gefixt (D22) | AUD-P1-1 |
| FR-002 | Fremdaudit FA-3 | Kritisch | MCP-Permission vom Aufrufer selbst erteilt | ⬜ Offen | FA-P0-1 |
| FR-003 | Fremdaudit FA-5 | Kritisch | VRAM-Buchhaltung ohne echtes Modell-Laden | ⬜ Offen | FA-P0-2 |
| FR-004 | Fremdaudit FA-6 | Hoch | `/status` KeyError bei fehlender LoadClass | ✅ Gefixt | FA-P1-2 |
| FR-005 | Fremdaudit FA-7 | Kritisch | busboy 5 × fileSize im RAM | ✅ Gefixt (1 Datei + Summenlimit) | FA-P0-3 |
| FR-006 | Fremdaudit FA-8 | Hoch | HF-Endpoint-Fehler → A100-Create | ✅ Gefixt (nur 404 → create) | FA-P1-3 |
| FR-007 | Fremdaudit FA-9 | Hoch | HID 32-Bit Vorzeichenfehler | ✅ Gefixt (2**n) | FA-P1-4 |
| FR-008 | Fremdaudit FA-10 | Hoch | OSC ohne Bounds-Checks | ✅ Gefixt (need-Checks) | FA-P1-5 |
| FR-009 | Fremdaudit FA-12 | Hoch | Retry bis ~10,5 min ohne Gesamtlimit | ✅ Gefixt (Gesamt-Deadline) | FA-P1-7 |
| FR-010 | Fremdaudit FA-13 | Hoch | HALF_OPEN Thundering Herd | ✅ Gefixt (Probe-Lock) | FA-P1-8 |
| FR-011 | Fremdaudit FA-14 | Mittel | costTracker unbegrenzt/O(n) | ✅ Gefixt (Pruning+Index) | FA-P2-1 |
| FR-012 | Fremdaudit FA-15 | Mittel | `/infer` Exception-Leak | ✅ Gefixt (generische Meldung) | FA-P1-9 |
| FR-013 | Fremdaudit FA-16 | Kritisch | `hf_generate` NameError | ✅ Gefixt | FA-P0-4 |
| FR-014 | AM-E3-1 | Kritisch | Locking-Seiteneffekt im setState-Updater | ✅ Gefixt (Ref Source of Truth) | AM-E3-1 |
| FR-015 | AM-E1-1/2/4/5 | Hoch | Worklet-Hot-Path-Allokationen/Closures | ✅ Gefixt | AM-E1-1/2/4/5 |

## Verbleibend offen

- FA-P0-1 (MCP-Permission serverseitig), FA-P0-2 (ModelManager echtes Laden)
- FA-P2-2 (Regressionstests repository/revision) – Python-Smoke, nächster CI-Lauf
| FR-016 | HF live | Hoch | Endpoint samplemonk-ai nach AST-Test auf `failed` zurückgefallen (Orchestrator: BAD_REQUEST „endpoint is in error") | ⬜ Offen – Update neu angestoßen, CI baut aktuelles Image | 9g / hf-endpoint.yml |
