# Agenten-Aufträge 2026-10-07 (wörtlich archiviert)

> Diese Datei hält die Aufträge fest, die in der Audit-Sitzung vom 2026-10-07 an Hintergrund-Agenten bzw. als eigene Arbeitspakete vergeben wurden. Zweck: Nachvollziehbarkeit, Wiederaufnahme nach Abbruch, gleiche Maßstäbe für spätere Agenten.
> Begründungen: [`AUDIT_2026-10-07_ECHTZEIT.md`](AUDIT_2026-10-07_ECHTZEIT.md), [`AUDIT_2026-10-07_GESAMTBERICHT.md`](AUDIT_2026-10-07_GESAMTBERICHT.md), [`AUDIT_2026-10-07_AI_LOKAL.md`](AUDIT_2026-10-07_AI_LOKAL.md). Aufgaben: `MASTERTODOENDE.json` → `rtAudit2026_10_07`.

| Auftrag | To-Do-IDs | Ausführung | Status (bei Archivierung) |
|---|---|---|---|
| A1 · Voice-Pool + Event-Queue | RT-AUDIT-P0-001, RT-AUDIT-P0-003 | Hintergrund-Agent, eigener Worktree; einmal durch API-Rate-Limit unterbrochen und fortgesetzt | **DONE** (e07fdcf, Merge d5fe48b) – Kick 2,67 → 395 ms, Swing 0 verworfene Steps |
| A2 · Feature Capture (Idee A) | IDEA-2026-10-07-A | Hintergrund-Agent, eigener Worktree | **DONE** (3e35260, Merge 8969ed9) – offene Punkte: IDEA-2026-10-07-A-F1 |
| A3 · AI nur lokal | RT-AUDIT-P1-014 | Haupt-Sitzung, Branch `ai/local-only` | **DONE** (a1c6a77) – Folgepunkte P1-014-F1/F2 |
| A4 · Mastering ohne Verzerrung | RT-AUDIT-P0-004 | Hintergrund-Agent, eigener Worktree | **DONE** (c62e071) – THD −6 dBFS 17,4 % → 0,00034 %; Bericht: `docs/audit/AGENTENBERICHTE_2026-10-08.md`; Folgepunkte P0-004-F1/F2/F3 |
| A5 · Keine Klone im Audio-Thread | RT-AUDIT-P1-010 | Hintergrund-Agent, eigener Worktree | **DONE** (d23bdf1, fbfcc79) – 0 Sample-Versand pro Schlag, SAB-Ring; Bericht: `docs/audit/AGENTENBERICHTE_2026-10-08.md`; Folgepunkt P1-010-F1 |
| — · Secret-Provisionierung | RT-AUDIT-P1-014-F1 | Haupt-Sitzung | **DONE** (845a366) |

---

## A1 · P0 Voice-Pool + Event-Queue

**Auftrag (P0, schlimmster Audit-Befund):** Stimmen im V2-Live-Pfad dürfen nicht nach einem Block abbrechen, Swing darf keine Steps verwerfen.

Der hörbare Ausgang läuft AUSSCHLIESSLICH über `src/audio/worklets/v2SinkProcessor.ts` → `src/core/audio/live/V2SinkEngine.ts` → `V2MonitorGraph`. Gemessen (`npm run audit:rt`):
- RT-AUDIT-P0-001: Kick-Step genau 1 Block = 2,67 ms hörbar. Ursache: `V2SinkEngine.render()` rendert Step-/Synth-Events (`renderStepBurst`) nur in den AKTUELLEN Block und setzt im nächsten Block unbelegte Kanäle auf Stille. Betroffen: Sequencer-Steps ohne Sample, `synthTrigger` (Pads, `instrumentNoteBridge.noteOn`, `audioEngine.playSynthesisInstrument`, `audioEngine.triggerEvent`-Fallback). `bassFilterState` ist global.
- RT-AUDIT-P0-003: Swing > 0 verwirft 7–8 von 16 Steps (`V2SampleClock.processBlock` + Filter `startSample >= length → continue` im Processor).
- Nebenbefund: Step-getriggerte Samples starten am Blockanfang.

**Geforderte Lösung:**
1. Persistenter Voice-Pool (`MAX_VOICES = 32`, vorallokiert; Zustand je Stimme: aktiv, Kanal, Stimme, Frequenz, Amplitude, Phase, verstrichene Samples, Rauschen, Hochpass, eigener Bass-Filter, Startoffset). Rendern bis Hüllkurve < 1e-4 oder 2 s. Klang identisch zu `renderStepBurst`, nur fortgesetzt. Stealing: älteste. Kick/Bass monophon mit 64-Sample-Choke.
2. Mischen ohne Allokation (vorallokierter Mono-Puffer + `[puffer]` je Kanal; `new Set`/Spread in `render()` ersetzen).
3. E-Piano pro Sample; falls nicht 1:1 möglich, Puffer einmal pro Trigger, Allokation dokumentieren.
4. Event-Queue mit absoluten Frames (Ringpuffer 64) im Processor; `step`-Meldung beim Feuern; `processBlock` API-kompatibel, zusätzlich allokationsfreie Variante; Logik testbar ausgelagert (`V2StepQueue`).
5. `triggerSample(..., startSample)`; `{...sample}` durch Wiederverwendung ersetzen.
6. Mute: keine neuen Stimmen, klingende in 64 Samples ausblenden; `reset()` leert den Pool.

**Tests:** Kick ≥ 100 ms hörbar und nach 2,1 s still; Polyphonie Lead; Kick-Choke ohne Sprung > 0,1; Swing 0,5 → 32/32 Steps exakt; Sample-Trigger mit startSample 77; Mute-Fade; 40 Trigger → max. 32 aktiv.

**Pflichtprüfungen:** `npx tsc --noEmit`, `npx eslint . --max-warnings=0`, `npm test` (nichts abschwächen; Bug-festschreibende Tests nur mit Begründung ändern), `npm run check:deadfiles`, `npm run audit:rt` vorher/nachher (P0-001 und Swing-Zeile OK; Swing-Messung auf `V2StepQueue` umstellen; p99,9 nicht > 20 % schlechter).

**Regeln:** nur diese Aufgabe; keine Allokation im neuen Render-Code; Commit im Worktree, nicht pushen; Bericht mit Branch, Hash, Dateien, Tests, audit:rt vorher/nachher, Einschränkungen.

---

## A2 · Feature „Capture“ (Idee A, vom Betreiber gewählt)

**Ziel:** Die letzten 60 s Main-Audio und die letzten 16 Takte an Eingaben (Pad-Trigger, Instrument-Noten) liegen immer bereit. Ein Klick legt das Audio still in der Server-Bibliothek ab und schlägt ein Sequencer-Pattern vor.

**Andockpunkte (geprüft):** `V2LiveSink.connectExtra()`; `audioEngine.connectV2LiveOutput()` → `masterTap.reattach()` als Muster; Worklet-Build über `build-worklets.mjs`; COOP/COEP gesetzt → SharedArrayBuffer; `useSamples().addSample()` lädt `blob:`-Audio still hoch (kind `recording`); `encodeWavFromChannels`; Eingaben in `audioEngine.triggerEvent`, `playSynthesisInstrument`, `sfzNoteOn`, `instrumentNoteBridge.noteOn`; Studio-Speicher server-seitig (`storage.ts`, nicht `MEMORY_ONLY_KEYS`).

**Umsetzung:**
1. `src/core/capture/eventCaptureLog.ts` – Ringpuffer 4096 Slots, `snapshot(nowSec, bpm, bars = 16)`.
2. `src/core/capture/quantizeCapture.ts` – Events → Takte (`Record<TrackType, boolean[16]>` + Noten), Vorschlag = letzter Takt mit Treffer; Raster an Transport-Start oder erstem Event.
3. `src/audio/worklets/captureTapProcessor.ts` – 1 Eingang, 1 Ausgang (Nullen, an `destination` für sicheres Rendern), schreibt planar in SAB-Ring, `Atomics.store` Schreibindex; Logik in `captureRing.writeCaptureBlock`.
4. `src/core/capture/captureRing.ts` – `writeCaptureBlock`, `readCaptureRing` (Wraparound), `trimLeadingSilence`.
5. `src/core/capture/audioCapture.ts` – Start/Stop/Reattach/isSupported (Boundary-Regeln beachten).
6. audioEngine minimal: `captureLog`-Einzeiler in den Eingabepfaden, Abgriff in `connectV2LiveOutput`, `captureNow()`.
7. UI im masterplayerMONK: nur Mixer-Halter; WAV → `addSample` (type `recording`, tags capture/bpm); Pattern-Overlay 8×16 mit Takt-Auswahl; „In Sequencer übernehmen“ nur mit Sequencer-Lock; „Als Pattern merken“ im Server-Studio-Speicher (max. 32).
8. Tests für Ring, Fenster, Quantisierung, Ring-Lesen/Wraparound, Stille-Trimmen, UI-Sperre.
9. Optional Live-Nachweis per Playwright mit `/opt/pw-browsers/chromium`.

**Pflichtprüfungen:** tsc, eslint, `npm test`, `check:deadfiles`, `verify:boundary`, `node build-worklets.mjs`, `audit:rt` nicht schlechter. **Regeln:** keine Allokation im Tap-`process()`, nichts auf dem Gerät, Locking respektieren, Dateien des A1-Agenten nicht anfassen, Commit im Worktree, nicht pushen.

---

## A3 · AI nur lokal (RT-AUDIT-P1-014)

Umsetzung in der Haupt-Sitzung auf Branch `ai/local-only`. Plan und Abnahme: `MASTERTODOENDE.json` → `RT-AUDIT-P1-014` (Positivliste DeepSeek, Cerebras-NLU-Sperre, Cloud-Provider entfernen, HF-Voice → Runpod `voiceGen`, Replicate-Stems entfernen, CSP bereinigen, Tests mit fetch-Spy).
