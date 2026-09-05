# Offene Punkte konsolidiert – Stand 2026-09-05

> Automatisch erzeugter Abgleich zwischen `MASTER_TODO.md` und `AGENT_TODO.json`
> sowie manuelle Konsolidierung der übrigen TODO-/Checklisten-Dateien.
> Legende: `[ ]` = offen · `[x]` = erledigt / nur Doku nachziehen.
> Stand nach Cleanup: Die 172 als `COMPLETED` erkannten Einträge wurden am 2026-09-05
> nach `TASKDONE.md` verschoben und aus `MASTER_TODO.md` entfernt.

---

## 1. Abgleich MASTER_TODO ↔ AGENT-Pipeline

| Kennzahl | Wert |
|---|---|
| Offene Checkboxen in `MASTER_TODO.md` (vor Cleanup) | 220 |
| Davon laut `AGENT_TODO.json` als `COMPLETED` erkannt | 172 (166 direkte Zuordnungen + 6 Audit-Pläne) |
| Davon laut `AGENT_TODO.json` noch `BLOCKED` | 48 (46 direkte Zuordnungen + 2 semantische Zuordnungen) |
| Offene MASTER-Punkte ohne Pipeline-Treffer | 0 |
| Nach Cleanup verbleibende offene Checkboxen in `MASTER_TODO.md` | 48 |
| In `TASKDONE.md` neu archivierte Einträge | 172 |
| Pipeline-BLOCKED, die in MASTER bereits als erledigt markiert waren | 2 (`BLOCK-004` = S-7/CSP, `BLOCK-200` = DA-221/SFU-Producer) → wurden auf `COMPLETED` gesetzt |

**Konsequenz:** Die 220 MASTER-Checkboxen waren inhaltlich vollständig durch die Pipeline abgedeckt.
Die 172 als `COMPLETED` erkannten Einträge wurden am 2026-09-05 nach `TASKDONE.md` verschoben und aus `MASTER_TODO.md` entfernt.

**Wichtige Einschränkung:** Manche Pipeline-`COMPLETED`-Einträge sind nur „formal completed“,
weil es manuelle Betreiber-/Live-Schritte sind (z. B. HF-Secret-Rotation, CI-Bestätigung, GPU-Test).
Diese sind in Abschnitt 3 weiterhin als offen geführt.

---

## 2. Konsolidierte offene Arbeit – Code/Audit/ESLint/Refactoring

> Quelle: Pipeline-Status `BLOCKED` bzw. verbleibende MASTER-Einträge mit `[ ]`.

### 2.1 Einzelaufgaben

- [ ] **AD-M4b Python-Supply-Chain** (Pipeline `TASK-025`)
  - `services/samplemonk-ai-runtime/pyproject.toml`: Hash-Pins/Lockfile + `torch==2.4.1`-Upgrade – Betriebsentscheidung/Test nötig.
- [ ] **AD-M1 React-Hooks-ESLint** (Pipeline `BLOCK-005`)
  - `set-state-in-effect`, `refs`, `immutability` in mehreren Terminals/Hooks/Contexts.
- [ ] **AD-M2 ESLint-Reste** (Pipeline `BLOCK-006`)
  - `no-require-imports` in `server.ts:1454`; `import/no-dynamic-require` in `LocalEmbeddingProvider.ts:41`.
- [ ] **AD-M6a / DA-220 SFU-Umschalt-Race** (Pipeline `BLOCK-007` + `BLOCK-199`)
  - `WebRTCManager.ts:150`: Race bei P2P→SFU-Umschaltung beheben.
- [ ] **AD-N1 jscpd-Code-Duplikate** (Pipeline `BLOCK-008`)
  - u. a. `eqProcessor.ts`, `celery_app.py`, `drumSynth.ts`, `fmEngine.ts`, `VoiceMonkService.ts`, `RecorderTerminal.tsx`, `AiMonkDock.tsx`, `midiCodec.ts`, `presets.ts`, `DspEnginePlugin.tsx`, `sfu-rtp-*.js`.
- [ ] **P1-2 Unit-Tests V1-Verkabelung** (Pipeline `BLOCK-009`)
  - Node-In/Out-Counts + Signalfluss-Spion analog `tests/audioEngine.test.ts` / `tests/monitorRouting.test.ts` ausbauen.
- [ ] **P3-6 Schutz der Algorithmenkerne** (Pipeline `BLOCK-018`)
  - Build-/Bundle-Schutz und Objekt-Code-Review prüfen; TEE im Browser als „nicht sinnvoll“ markieren.
- [ ] **AUD-2026-09-05-D6 Code-Duplikate DSP/Synth** (Pipeline `BLOCK-206`)
  - `computeLocal.ts` ↔ `computeWorker.ts`, `midiCodec.ts`, `drumSynth.ts`, `fmEngine.ts`, `DspEnginePlugin.tsx`, `presets.ts`, `aiRhythmGenerator.ts`, SFU-RTP-Skripte.

### 2.2 ESLint-Detailreste in Hetzner-Skripten

- [ ] `sfu-rtp-multi-run.mjs:66` – no-unused-vars (Pipeline `BLOCK-047`)
- [ ] `sfu-rtp-multi-run.mjs:84` – no-unused-vars (Pipeline `BLOCK-048`)
- [ ] `sfu-rtp-multi-run.mjs:101` – no-unused-vars (Pipeline `BLOCK-049`)
- [ ] `stress-test.mjs:76` – no-unused-vars (Pipeline `BLOCK-050`)

### 2.3 ESLint no-require-imports in `services/midi-bridge/index.js`

- [ ] Zeile 27 (Pipeline `BLOCK-067`)
- [ ] Zeile 28 (Pipeline `BLOCK-068`)
- [ ] Zeile 40 (Pipeline `BLOCK-069`)
- [ ] Zeile 80 (Pipeline `BLOCK-070`)
- [ ] Zeile 100 (Pipeline `BLOCK-071`)

### 2.4 React-Hooks-ESLint

- [ ] `MappingLearnPanel.tsx:28` – refs (Pipeline `BLOCK-137`)
- [ ] `useMIDI.ts:175` – set-state-in-effect (Pipeline `BLOCK-155`)
- [ ] `useMidiClockOut.ts:43` – refs (Pipeline `BLOCK-156`)
- [ ] `useMidiClockOut.ts:46` – refs (Pipeline `BLOCK-157`)
- [ ] `useMidiClockOut.ts:62` – set-state-in-effect (Pipeline `BLOCK-158`)
- [ ] `useMidiClockOut.ts:86` – refs (Pipeline `BLOCK-159`)

---

## 3. Konsolidierte offene Arbeit – Live-/Hardware-/Betreiber-Prüfpunkte

> Mehrfachnennungen (MASTER/AGENT/TASKDONE/Checklisten) wurden zusammengefasst.

### 3.1 Infrastruktur & Flotte

- [ ] **OPS-Load-Balancer LB11** (Pipeline `BLOCK-001`/`BLOCK-019`, TASKDONE L96)
  - 2 App-Knoten hinter LB11, 4-User-E2E (State-Sync, Locking, Main-Stream), Failover-Test.
- [ ] **Live-Checklist gesamt** (Pipeline `BLOCK-003`)
  - `docs/LIVE_CHECKLIST_2026-09-02.md` abarbeiten (Flotte, Browser, Audio/DSP, 4-User, KI/Eval, Security).
- [ ] **P2-1/P2-2 Rest** (Pipeline `BLOCK-002`)
  - Resampling-/Filter-Qualität, BPM sample-genau, Multi-User-PLL, Latenz-/Jitter-Prüfpunkte.
- [ ] **Supabase-Live-Abgleich / RLS** (TASKDONE L88)
  - Tatsächliche Supabase-Instanz gegen Migrations-/RLS-Stand prüfen.

### 3.2 Browser-/Geräte-Prüfpunkte

- [ ] **iPhone-Test vor Ort** (Pipeline `BLOCK-020`)
  - Keine persistenten UI-Probleme, Panels schließbar, Safe-Area, Touch-Ziele ≥ 44 px.
- [ ] **iOS/Android-Test** (Pipeline `BLOCK-021`)
  - Touch-Ziele ≥ 44 px, Safe-Areas, kein Hover-only, kein Zoom/Overflow.
- [ ] **USB/Xonar U7** (Pipeline `BLOCK-022`/`BLOCK-023`)
  - Automatische Auswahl, Xonar-Default, Einstellungen nach Reload stabil, 2.1 sichtbar.

### 3.3 Audio-/Latenz-Prüfpunkte

- [ ] **Latenzmessung vorher/nachher** (Pipeline `BLOCK-024`)
  - `goldenAudio`-Tests ohne Artefakte, Dropout-Zähler = 0.
- [ ] **Roundtrip-/Netz-Latenz** (Pipeline `BLOCK-025`)
  - Lokal < 15 ms, Audio-Thread p99.99 < 1 ms, Netz one-way < 50 ms, 0 Xruns.
- [ ] **Jitter-Langzeitmessung** (Pipeline `BLOCK-026`)
  - 120 BPM / 10 min: Jitter < 1 ms; zwei Browser bleiben < 5 ms zueinander.
- [ ] **2.1-Frequenzanalyse** (Pipeline `BLOCK-027`/`BLOCK-028`)
  - Sub < 80–120 Hz, L/R ohne Bass-Einbuße; Testton 40 Hz / 1 kHz; Layouts hörbar.
- [ ] **0 Xruns/Dropouts im Normallauf** (Pipeline `BLOCK-036`)

### 3.4 Multi-User-/KI-Prüfpunkte

- [ ] **4-User-Livelauf** (Pipeline `BLOCK-033`/`BLOCK-034`/`BLOCK-035`)
  - Identischer State, Gäste hören Main, Cue separat, Rollenwechsel ohne Audio-Unterbrechung.
- [ ] **Echter MOA/DeepSeek-LLM-Lauf je Plugin** (Pipeline `BLOCK-029`, TASKDONE L137)
  - 100 % der Kern-Kommandos; Scores in Supabase sichtbar.
- [ ] **Fehlerfall-Anzeige** (Pipeline `BLOCK-030`)
  - Kein roher Traceback, verständliche Meldung.
- [ ] **A100/HF-Endpoint bevorzugt** (Pipeline `BLOCK-031`)
  - DevSettings „AI Server Shutdown“ aktiviert Fallbacks.
- [ ] **AI-E2E-Szenario gegen echten HF-Endpoint** (Pipeline `BLOCK-037`)
- [ ] **AI-Failure-Suite gegen Live-Infrastruktur** (Pipeline `BLOCK-038`)
- [ ] **AI-GPU-Benchmarks** (Pipeline `BLOCK-039`)
  - Cold/Warm/VRAM-Messwerte, sobald Endpoint läuft.
- [ ] **INT8-Kalibrierung** (Pipeline `BLOCK-041`)
  - Je Modell vorab messen.

### 3.5 Betreiber-Schritte (trotz Pipeline-„COMPLETED“ faktisch offen)

- [ ] **HF-Endpoint-Secret rotieren** (TASKDONE L41; Pipeline `TASK-026` ist nur formal completed)
- [ ] **Nightly-CI-Lauf auf GitHub bestätigen** (TASKDONE L41/L145; Pipeline `BACKLOG-032` formal completed)
- [ ] **AI-Docker-Build/GPU-Test lokal** (TASKDONE; Pipeline `BACKLOG-040` formal completed)
- [ ] **Migration 002 in Live-Supabase final verifizieren / Daten sichtbar** (TASKDONE L41/L88, LIVE_CHECKLIST P3-1)

### 3.6 Hörproben & UX-Neubau

- [ ] **Hardware-Hörprobe MIDI-Out/Clock** (TASKDONE L63)
  - TR-8S / Beatstep Pro: Clock-Lock, Notenzuordnung, SysEx.
- [ ] **DropMONK-Hörprobe** (TASKDONE L54, `docs/dropMONK_MVP_SUMMARY.md`)
  - Sweep/Crossfade am laufenden Mix + Latenzmessung des Drop-Pfads unter Last.
- [ ] **4-User-Hörprobe Pump-/Zipper-Freiheit** (TASKDONE L72)
- [ ] **Komponenten-Neubau Hardware-Look** (TASKDONE L104)
  - DJM-A9/XONE, MiniMoog/Prophet, TR-808, API/SSL … inkl. Screenshot-Baselines.

---

## 4. Weitere offene Checklisten-Punkte ohne Pipeline-Bezug

### `docs/LICENSE_EXTERNAL_RESOURCES.md`

- [ ] Kein Audiomaterial der gelisteten Anbieter im Repo/Image/Snapshot.
- [ ] Keine Presets, die fremde Samples einbetten (nur Referenzen auf lokale/CC0-Dateien).
- [ ] Attribution für CC-BY-Quellen im Export dokumentiert.
- [ ] Neue Fremdressourcen zuerst dort eintragen, dann verwenden.

### `docs/PGVECTOR_LINT0014.md`

- [ ] Keine `CREATE EXTENSION vector`-Statements im `public`-Schema.
- [ ] Keine SQL-Funktionen mit unqualifiziertem `public.vector`.
- [ ] Keine Client-Typdefinitionen, die `public.vector` annehmen.
- [ ] Keine `search_path`-Einstellungen, die angepasst werden müssten.
- [ ] Datenbank-Backup vorhanden (Supabase-Best-Practice).

---

## 5. Erledigte Doku-/Statuspflege (Cleanup 2026-09-05)

Die folgenden Punkte waren laut MASTER_TODO bzw. Tests bereits erledigt und sind
im Rahmen des Cleanups nun in den jeweiligen Listen korrigiert bzw. archiviert:

- [x] **S-7 Content-Security-Policy**: Pipeline `BLOCK-004` auf `COMPLETED` gesetzt.
- [x] **DA-221 SFU-Producer-Fehlerbehandlung**: Pipeline `BLOCK-200` auf `COMPLETED` gesetzt.
- [x] **AUD-2026-09-05-D1…D5**: Aus MASTER_TODO entfernt und in TASKDONE archiviert.
- [x] **AUDIT-PLAN-MOA / AUDIT-PLAN-2…6**: Aus MASTER_TODO entfernt und in TASKDONE archiviert.
- [ ] **Flotten-Start < 90 s**: Messung 72,4 s bereits dokumentiert (MASTER_TODO); TASKDONE L81-Restposten kann beim nächsten Aufräumen entfernt werden.
- [ ] **Scratchpad Reload/DnD/Clipboard**: Inzwischen automatisiert (`tests/e2e/scratchpad.spec.ts`); TASKDONE L113-Restposten kann beim nächsten Aufräumen entfernt werden.
- [ ] **Performance-Messung < 70 % CPU**: Inzwischen automatisiert (20,6 % CPU); TASKDONE L128-Restposten kann beim nächsten Aufräumen entfernt werden.

---

## 6. Zusammenfassung

| Kategorie | Anzahl offener Punkte |
|---|---|
| Code/Audit/ESLint/Refactoring (Abschnitt 2) | 20 gruppierte Einträge (inkl. Detailzeilen) |
| Live-/Hardware-/Betreiber-Prüfpunkte (Abschnitt 3) | 29 gruppierte Einträge |
| Weitere Checklisten ohne Pipeline (Abschnitt 4) | 9 Einträge |
| Verbleibende TASKDONE-Restposten (Abschnitt 5) | 3 Einträge |

**Nächste sinnvolle Schritte:**
1. `MASTER_TODO.md` mit Abschnitt 1 abgleichen (172 Punkte auf `[x]`/nach `TASKDONE.md` verschieben). → erledigt durch Cleanup.
2. Pipeline-Status für `BLOCK-004` und `BLOCK-200` korrigieren. → erledigt durch Cleanup.
3. Danach die verbleibenden 48 BLOCKED-Punkte priorisieren – zuerst Code-/ESLint-Reste ohne Server/Hardware.
