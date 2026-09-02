# LIVE-CHECKLISTE 2026-09-02 – Offene Prüfpunkte

> Alle Punkte aus `MASTER_TODO.md`, die erst mit echter Flotte/Browser/Hardware
> verifiziert werden können. Vor Ort abhaken und Ergebnis (Wert + Datum) eintragen.
> Ziel: kein offener Prüfpunkt bleibt „still" offen – jeder bekommt Messwert oder
> wird bewusst auf später verschoben.

## Automatisiert grün (lokal, 2026-09-02)

- `npm run verify` → **535 Tests + Boundary-Scan 0**
- `npm run build` → ok · `check:memo` → ok · `check:bundle` → **grün** (1,62 MB,
  Warn <1,5 MB bleibt offen; lazy onnxruntime-web zählt nicht zum UI-Budget)
- `npm run eval:ai` → **21/21 PASS** · `npm run iterate:prompts` → **21 Plugins, 0 nicht konvergiert**
- Playwright: smoke **7/7** · responsive **9/9** (7 skipped Firefox-Mobile) ·
  keyboard+visual **5/5** · audioAction **2/2**
- Bekannt: `collab.spec.ts` schlägt auch auf dem Basis-Commit fehl (Signaling
  über mehrere Browser-Kontexte lokal) → kein Regressionsbefund, bleibt Live-Punkt.

## 1 · Flotte / OPS

- [ ] **OPS-Snapshot (Wake-Zeit):** Flotten-Start (wake→ready) vorher/nachher messen.
      Ziel **< 90 s**. Messung: Portal-Ladebildschirm-Zeit bzw. `/api/status`-Polling
      bis `state: 'ready'`.
- [ ] **OPS-Snapshot (Refresh):** Einmal `POST /api/refresh-snapshots` nach
      erfolgreichem Bootstrap ausführen; `GET /api/snapshots` zeigt je Rolle
      `samplemonk-snapshot-<role>`; danach Wake mit Snapshot-Image prüfen.
- [ ] **LB11 (bewusst später):** Erst bei ≥ 2 App-Knoten – Trigger dokumentiert,
      derzeit **NICHT** installieren. Prüfpunkt (erst bei Skalierung):
      2 App-Knoten hinter LB, 4-User-E2E grün, Failover-Test.

## 2 · Browser / UI / Geräte

- [ ] **P1-1 (manuell):** iPhone vor Ort – UI nicht persistent, Panels schließbar,
      keine Zoom-/Overflow-Probleme (Safe-Area, Touch-Ziele ≥ 44 px).
- [ ] **P1-2:** `visual.spec.ts` für alle 21 Plugins anlegen; Screenshots mit
      Referenz-Hardware-Look vergleichen (Komponenten-Neubau mittlere Priorität).
- [ ] **P1-3:** USB-Gerät angeschlossen → wird automatisch ausgewählt; Einstellungen
      nach Reload stabil; 2.1-Modus sichtbar (Xonar U7).
- [ ] **P1-4:** Zwischenspeicher: Speichern/Laden überlebt Reload; DnD (Modul →
      Ablage → Modul) funktioniert; Clipboard-Roundtrip (Copy → Paste) liefert
      gültiges JSON.
- [ ] **P1-6:** Keyboard-E2E (Space, Ctrl/Cmd+1..9, Escape) – kein Hotkey bricht
      Eingabefelder; MIDI-Codec-Tests grün (Unit-Suite läuft lokal).

## 3 · Audio / DSP / Clock

- [ ] **P0-4:** 60 s Dauerlauf ohne aktives Plugin → RMS ≤ -60 dBFS; mit aktivem
      Sequencer → nur erwartete Steps hörbar.
- [ ] **P2-1:** Latenz-Messung vorher/nachher dokumentieren; `goldenAudio`-Tests
      ohne Artefakte; Dropout-Zähler bleibt 0 im Normalbetrieb.
- [ ] **P2-2:** 120 BPM, 10 min Lauf: Jitter < 1 ms; zwei Browser starten
      gleichzeitig und bleiben < 5 ms zueinander.
- [ ] **P2-3:** Frequenzanalyse: Sub-Kanal enthält < 120 Hz, L/R ohne volle
      Bass-Einbuße; Testton 40 Hz auf Sub, 1 kHz auf L/R (Xonar U7 2.1).
- [ ] **P2-4:** Performance-Messung zeigt < 70 % CPU (Graph-Validierung + Insert
      sind grün).
- [ ] **P2-5:** Playwright-Stress-Test grün; Bundle < 1,5 MB JS (aktuell nur
      Warn-Schwelle; 2.0-MiB-Gate ist grün).

## 4 · Kollaboration / 4-User

- [ ] **P0-6:** 4-User-E2E: User2 aktiviert Drum → auf MAIN hörbar; User3 wählt
      PLUGIN-Cue → hört nur sein Plugin, MAIN unverändert; zurück auf MAIN →
      sofort Gesamtmix.
- [ ] **P4-1:** Live-Latenz < 50 ms one-way beim echten 4-Browser-Lauf verifizieren.
- [ ] **P4-2:** Audio-Unterbrechungsfreiheit beim Rollenwechsel im Live-Test.

## 5 · KI / Eval / Datenbank

- [ ] **P3-1:** Daten in Supabase sichtbar (Migration 002: `system_prompts`,
      `plugin_prompt_versions`, `ai_evaluations`, `ai_eval_runs`).
- [ ] **P3-2:** Echter MOA-LLM-Lauf (DeepSeek) je Plugin – 100 % der Kern-Kommandos
      werden korrekt geplant und ausgeführt; Scores in Supabase sichtbar.
      (Automatisierte Mock-Variante grün: `tests/aiEvaluation.test.ts`, 21 Plugins.)
- [ ] **P3-3:** Nightly-CI-Lauf grün; Report enthält je Plugin Score, Dauer, Fehler;
      `ai_eval_runs` in Supabase gefüllt.
- [ ] **GAP-5:** Jedes Plugin hat ≥ 1 Eval-Datensatz und ≥ 1 Score in der DB;
      Score-Abfall blockiert Release.

## 6 · Sicherheit / Betrieb

- [ ] **GAP-4:** Security-Checkliste aus `docs/SECURITY_AUDIT.md` vollständig
      abgehakt oder mit offenem Task verknüpft.
- [ ] **GAP-4:** HF-Endpoint-Secret rotieren (Betreiber-Schritt).
- [ ] **GAP-4:** Pen-Test `/api/ai/*` (Auth, Rate-Limit, Input-Validierung, SSRF).
- [ ] **GAP-4:** Supabase RLS prüfen (Prompts/Evals: anon read, service_role write).
- [ ] **AUD-P2-1:** `docs/TESTRUN_2_CHECKLIST.md` mit den AUD-Befunden abgleichen.

## Messwerte (eintragen)

| Prüfpunkt | Datum | Messwert | Ergebnis |
|---|---|---|---|
| Wake→ready (Snapshot) | | s | |
| RMS ohne Plugin (60 s) | | dBFS | |
| Jitter 120 BPM / 10 min | | ms | |
| 2-Browser-Clock-Offset | | ms | |
| 4-Browser-Latenz (one-way) | | ms | |
| CPU-Last (4 User) | | % | |
