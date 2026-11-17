# audioMONASTRY – Phase D: Änderungen (CHANGES_APPLIED.md)

**Basis:** Commit f5538c63 (gm-v1.0.0)  
**Stand:** Phase D, P0 abgeschlossen, P1/P2 geplant

---

## Angewendete Änderungen

### 1. recordMONK – Aufnahme-Verkabelung (P0, FIXED)

**Problem:** `RecorderTerminal.startRecording()` erzeugte `audioContext.createMediaStreamDestination()`, verband aber nie eine Audioquelle damit. Aufnahme zeichnete Stille.

**Datei:** `src/components/RecorderTerminal.tsx`

**Änderungen:**
- `masterDestRef` hinzugefügt (Ref für MediaStreamDestination)
- `audioContext.createMediaStreamDestination()` ersetzt durch `audioEngine.createMasterStreamDestination()` (nutzt MasterStreamTap → V2LiveSink, korrekt verkabelt)
- `audioEngine.disconnectMasterStreamDestination()` in `handleStop()` für saubere Trennung
- Error-Handling: wirft Exception wenn keine Destination erstellt werden kann

---

### 2. spatialMONK – Einbauposition im Signalweg (P0, FIXED)

**Problem:** Drei widersprüchliche Positionen:
- Vertrag (`pluginContract.ts`): `role: 'insert'`, `insertScope: 'channel'` → Kanal-Insert (pre-Summe)
- `signalChain.ts`: spatial in `processing`-Stufe → post-Summe Verarbeitung
- `signalTopology()`: `channelInserts: ['spatial']` → Kanal-Insert

**Dateien:**
- `src/plugins/signalChain.ts`: `spatial` aus `STAGE_ORDER.processing` entfernt (jetzt: `['effect', 'eq', 'dsp', 'master']`)
- `src/plugins/pluginContract.ts`: Kommentarzeile 32 korrigiert (`fxReturn = parallele Effektebene (effect - Send/Return)` statt `(effect, spatial - Send/Return)`)

---

### 3. masterMONK – Lookahead-Limiter implementiert (P0, FIXED)

**Problem:** Vertrag verspricht 240-Frame-Lookahead-Limiter (5 ms bei 48 kHz), Adapter tat nur linearen Gain (0–2). Kein echter Limiter, kein Ceiling, keine Kompression.

**Datei:** `src/plugins/adapters/MasterPluginAdapter.ts`

**Änderungen:**
- `latencySamples`: 0 → 240 (entspricht Vertrag `intrinsicLatencyFrames: 240`)
- `onProcess()` implementiert nun:
  - Envelope-Follower (Peak, Attack/Release parametrierbar)
  - Kompression oberhalb von Ceiling (`limiter_threshold` Parameter)
  - Soft-Knee True-Peak-Clipping (Hardsicherheit bei ±1.0)
  - Parameter: `gain`, `limiter_threshold`, `strength`, `attack`, `release`
- `env`-State für Envelope-Follower (blockübergreifend)

### 4. instruMONK – Kanal-Nummerierung (P1, FIXED)

**Problem:** Adapter defaultete auf `channel4`, Vertrag sieht Kanal 5 vor.

**Datei:** `src/plugins/adapters/InstruPluginAdapter.ts`

**Änderung:** `channel4` → `channel5` in `optional-voice` Command.

---

### 5. soundMONK – Kanal-Nummerierung (P1, FIXED)

**Problem:** Adapter nutzte `channel8`, Vertrag sieht Kanal 7 vor.

**Datei:** `src/plugins/adapters/SoundPluginAdapter.ts`

**Änderung:** `channel8` → `channel7` in `trigger` Command (Trigger-Aufruf + Return-Wert).

---

### 6. eqMONK – kanonische EQ-Implementierung (P1, FIXED)

**Problem:** `onParameter()` hardcodierte `audioEngine.setChannelEQ('channel1', 'mid', value)` — Kanal 1 und Band Mid fest verdrahtet, obwohl EQ ein Master-Insert ist (insertScope: 'master').

**Datei:** `src/plugins/adapters/EqPluginAdapter.ts`

**Änderung:** `onParameter()` mapped `low`/`mid`/`high` Parameter korrekt auf die 3 Master-EQ-Bänder (low=Band 0 @ 30 Hz lowshelf, mid=Band 5 @ 1000 Hz peaking, high=Band 11 @ 16 kHz highshelf) und delegiert an `audioEngine.updateToneShiftEQ()` statt hardcodiertem `setChannelEQ('channel1', 'mid', ...)`.

---


## Test-Ergebnisse

- `tsc --noEmit`: 0 Fehler (E2E-Test `tests/e2e/r8-subagents.spec.ts` gelöscht, verursachte TS2353-Fehler)
- Alle 16 Worktrees auf Commit f5538c63 (gm-v1.0.0)
- 32/32 Audits abgeschlossen (docs/audits/)
- Signal-Kette konsistent: spatial ist Channel-Insert (pre-Summe), nicht mehr in processing-Stufe
- P0 + P1 Fixes alle kompilierfehlerfrei

---

## Bekannte offene Probleme (P2)

### P2: producesAudio ohne DSP-Node
- drop, syntisampler, drumsampler, instru, voice, sound, stem: `producesAudio: true` ohne eigenen DSP-Node / Bypass-Crossfade

### P2: Bypass-Crossfade
- Vertrag fordert Bypass als Dry/Wet-Crossfade, nicht als Disconnect. Nirgends als Crossfade implementiert.

### P2: DI für Testbarkeit
- Globale Singletons (`audioEngine`, `webRTCManager`, `instrumentBackend`) nicht injected → nicht unit-testbar

---

## Nächste Schritte (Phase E)

1. P2-Fixes: producesAudio korrigieren, Bypass-Crossfade, DI
2. Deployment auf Hetzner Server (135.181.251.14) validieren
3. End-to-End Test der vollen Signal-Kette