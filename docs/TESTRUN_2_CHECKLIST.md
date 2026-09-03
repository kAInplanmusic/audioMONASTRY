# TESTRUN 2 – Workflow-Checkliste (audioMONASTRY)

> Stand: 2026-09-03 (AUD-P2-1-Abgleich) · Zweck: Nach jeder Optimierung
> reproduzierbar prüfen.
> Legende: ✅ bestanden · ⚠️ bekannt/limitiert · ❌ fehlgeschlagen · ⬜ offen
> Regeln: Erst messen, dann abhaken. Hardware-/Live-Checks nur mit echtem Gerät.
> `[x]` = automatisiert nachgewiesen (Test/Skript in Klammern), `[ ]` = bleibt
> ein Live-/Hörprobe-Schritt am echten Gerät.

## 1. Start & Basis

- [x] `npm run verify` läuft durch (tsc + Vitest + Boundary-Scan) – **AUD-1 gefixt (D22)**
- [x] Studio startet ohne geöffnetes Plugin-Terminal (außer aiMONK-Dock) – `tests/e2e/startState.spec.ts` (P0-1)
- [ ] Main-RMS < -60 dBFS bei inaktiven Plugins – Silence-Gate automatisiert (`tests/e2e/startState.spec.ts`); dBFS-Messung am Interface bleibt Live-Schritt
- [x] masterplayerMONK als Plugin 0 fest oben sichtbar (alle User) – `tests/e2e/masterPlayerFixed.spec.ts` (P0-7)
- [ ] aiMONK-Bottom-Dock sichtbar, ausblendbar – Sichtprüfung im Browser (P0-8); kein automatisierter Nachweis

## 2. Plugin-Lifecycle (je Plugin)

- [x] Plugin OFF → keine Verbindung Plugin→GLOBAL_MASTER – `tests/pluginAudit.test.ts`, `tests/pluginAudioRouter.test.ts` (AUD-P0-1)
- [x] Plugin PRO → genau eine Verbindung auf Ziel-Kanal – `tests/pluginAudit.test.ts`, `tests/routingValidator.test.ts`
- [x] Close-Button (✕) im Terminal setzt OFF und gibt Lock frei – `tests/e2e/pluginCloseSync.spec.ts` (P0-3)
- [ ] OFF während Play stoppt Klang sofort (< 50 ms) – Ramp-Logik getestet (`tests/pluginAudioRouter.test.ts`); Hörprobe bleibt Live
- [ ] Sanftes Ramp-Down bei MAIN-verbundenen Plugins / hart bei Monitor-only

## 3. Routing & Mixer

- [x] mixerMONK ist einzige MAIN-Einspeiseinstanz – `tests/routingValidator.test.ts`, `tests/mixer.test.ts` (P0-6)
- [ ] Nur Halter von mixerMONK kann MAIN beeinflussen
- [ ] Halter OFF → Main-Ausgabe + MainClock/Tick stoppen
- [ ] Nicht-DJ-User können Plugins aktivieren und hören MAIN (Host-Stream oder lokal)
- [x] CUE1–4 unabhängig von MAIN; PLUGIN-Solo trennt MAIN nicht – `tests/monitorRouting.test.ts`, `tests/e2e/monitorCue.spec.ts`

## 4. Latenz & Clock

- [ ] Lokale Roundtrip-Latenz < 15 ms (Ziel < 1 ms Audio-Thread p99.99)
- [ ] Netz-Latenz < 50 ms one-way
- [ ] 120 BPM, 10 min: Jitter < 1 ms – Clock-Audit offline grün (`tests/clockAudit.test.ts`); Langzeitmessung bleibt Live (AM-E5-4)
- [ ] 0 Xruns/Dropouts im Normallauf

## 5. AI & MOA/MCP

- [x] aiMONK führt „Tempo 128, Sequencer an, Pattern laden“ aus – `tests/aiEvaluation.test.ts`, `tests/pluginCommandRegistry.test.ts` (Mock-LLM); echter DeepSeek-Lauf bleibt Live
- [ ] Fehlerfall zeigt verständliche Meldung (kein roher Traceback)
- [ ] A100/HF-Endpoint bevorzugt; DevSettings „AI Server Shutdown“ aktiviert Fallbacks
- [x] Jedes Plugin hat Systemprompt + Eval-Datensatz (GAP-5) – `tests/promptMatrix.test.ts`, `tests/evalMatrix.test.ts`, `npm run eval:ai` (Report je Plugin: Score/Dauer/Fehler)

## 6. Kollaboration (4 User)

- [ ] 4 Browser sehen identischen State
- [x] Locking deterministisch (User-ID, kein Seiteneffekt im Updater) – `tests/lockFuzz.test.ts` (4 User × 1000 Ops), Server-RBAC in `tests/security.test.ts` (P4-2)
- [ ] Gäste hören Main via Host-Stream; Cue separat
- [ ] Rollenwechsel ohne Audio-Unterbrechung

## 7. Persistenz & Zwischenspeicher

- [ ] Session-Scratchpad (halbtransparente Overlay-Sidebar) speichert/lädt
- [ ] Drag & Drop funktioniert
- [ ] „In Zwischenablage senden“ liefert gültiges JSON

## 8. Cross-Platform & Geräte

- [ ] iOS/Android: Touch-Ziele ≥ 44 px, Safe-Areas, kein Hover-only
- [ ] USB-Default: Xonar bevorzugt, sonst erste USB-Karte
- [ ] 2.1-Layout: Sub < 80 Hz auf drittem Kanal oder Phantom-Fallback
- [ ] Output-Layouts 2.0/2.1/2.2/12.x/18.x/24.x konfigurierbar

## 9. Fehlerfälle & Robustheit

- [x] stem-ai down → schneller 502 (D22, verifiziert – AUD-P1-1 gefixt, `tests/stemRouter.test.ts`)
- [x] Upload: 1 Datei + Summenlimit; kein RAM-Exploit – `tests/sampleUpload.test.ts`, `tests/server.test.ts` (415/413-Pfade)
- [x] OSC/HID-Malformed-Chunks → kein Crash – `tests/malformedChunks.test.ts`
- [x] MCP ohne Permission → denied (serverseitig) – `tests/mcpPluginTools.test.ts`, `tests/aiSecurityPenTest.test.ts` (unbekanntes Tool → 404)
- [x] RLS für AI-Tabellen aktiv – statisches Gate `tests/supabaseRls.test.ts` über `database/*.sql`; Live-Abgleich in Supabase = Betreiber-Schritt (P3-1)

## 10. Ergebnis

- [ ] Alle kritischen (P0) und hohen (P1) Punkte grün
- [ ] Befunde in `MASTER_TODO.md` eingetragen, Checkboxen aktualisiert

---

## 11. AUD-Abgleich (AUD-P2-1, 2026-09-03)

Die Befunde aus dem Audit-Lauf (2026-08-31) sind gegen diese Checkliste
gespiegelt:

| AUD-Befund | Checklisten-Punkt | Status |
|---|---|---|
| AUD-P0-1 `audioEngine`-Plugin-Lifecycle (OFF trennt die Kette) | 2. Plugin-Lifecycle | ✅ automatisiert (`tests/pluginAudit.test.ts`, `tests/pluginAudioRouter.test.ts`) |
| AUD-P0-4 `SynthesizerTerminal` an `audioEngine` verdrahtet | 2. Plugin-Lifecycle | ✅ automatisiert (`tests/instrumentControl.test.ts`, P0-5) |
| AUD-P1-1 stem-ai down → schneller 502 | 9. Fehlerfälle | ✅ automatisiert (`tests/stemRouter.test.ts`, D22) |
| AUD-P1-3 Migration 002 (Prompt-/Eval-Tabellen) | 5. AI & MOA/MCP, 9. RLS | ✅ Datei + RLS-Gate (`tests/migrations.test.ts`, `tests/supabaseRls.test.ts`); Anwenden in Supabase = Betreiber-Schritt (P3-1) |
| GAP-4 Pen-Test `/api/ai/*` | 9. Fehlerfälle | ✅ automatisiert (`tests/aiSecurityPenTest.test.ts`: Auth, Rate-Limit, Input, SSRF) |
| GAP-5 Prompt-/Eval-Matrix je Plugin | 5. AI & MOA/MCP | ✅ automatisiert (`tests/promptMatrix.test.ts`, `tests/evalMatrix.test.ts`, `npm run eval:ai`) |

**Offen bleiben ausschließlich Live-/Hörprobe-Schritte** (Main-RMS-Messung,
Latenz/Jitter am Gerät, 4-Browser-Lauf, Cross-Platform, echter LLM-Lauf) –
sie sind in `docs/LIVE_CHECKLIST_2026-09-02.md` geführt.
