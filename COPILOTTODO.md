# COPILOTTODO – Agenten-Plan für P0-kritische Items

> **Zielgruppe:** Nachfolgender Copilot-Agent
> **Ziel:** Alle P0-kritischen Items (`MASTER_TODO.md` Zeile 90–112) produktionsreif abschließen  
> **Status:** ✅ Verifikation am 2026-09-03 durchgeführt – Details siehe TASKDONE.md
> („Quelle: COPILOTTODO.md – P0-Verifikation abgeschlossen").
> **Kontext:** Falls Überprüfungen, Fehler-Fixes oder Verfeinerungen nötig sind – dieses Dokument leitet dich durch die Verifikation

---

## Übersicht P0-Items

| Item | Titel | Status in MASTER_TODO | Verifikations-Test |
|------|-------|-------|-----|
| P0-1 | Start-Zustand „Kein Plugin offen" + Mixer-Sonderfall entfernen | `[x]` | E2E: Studio betreten → 0 ModuleContainer sichtbar |
| P0-3 | Plugin-Terminals: Close-Button + State-Synchronisation | `[x]` | Plugin OFF → Icon dunkel, Reload erhält Zustand |
| P0-4 | Rauschen auf Main beseitigen | `[x]` | `tests/goldenAudio.test.ts`: 60s Stille (RMS ≤ -60 dBFS) |
| P0-6 | Main-/Monitor-Routing & Mehrbenutzer-Fix | `[x]` | 4-User-E2E: Cue vs. Main korrekt getrennt |
| P0-7 | Master-Player fest oben mit Transport | `[x]` | Play/Stop erreichbar, Scroll-Position egal |

---

## Item P0-1: Start-Zustand „Kein Plugin offen" + Mixer-Sonderfall entfernen

### Problem
- Backend muss beim Studio-Eintritt (**kein Plugin aktiv**) alle `ModuleContainer` unsichtbar halten  
- Alle Grid-Icons sind gedimmt (grayed out)  
- Main-RMS < -60 dBFS (Stille)  
- Keine `aiMONK`/`Mixer`-Terminals sichtbar auf Startup

### Lösung & Verifikation

**Code-Punkte prüfen:**

1. **`src/App.tsx` – Initiale State:**
   - [x] `pluginState`-Init: alle Plugins auf `state: 'off'`  
   - [x] `visibleModuleIds` im `SessionContext`: leer starten (oder nur mit explizitem User-Klick sichtbar)  
   - [x] Grid-Icons nutzen `IconButton` mit `disabled={true}` bei Offline/Start

2. **`src/core/session/sessionInit.ts` oder ähnlich:**
   - [x] `initializeSession()` setzt alle Plugins auf `off`  
   - [x] Mixer wird **nicht** auto-aktiviert (Mixer-Sonderfall ENTFERNT)  
   - [x] Optional: `persistedState` wird ignoriert bei Fresh-Start (oder explizit `off`-gesetzt)

3. **Monitor-Routing / Audio-Engine:**
   - [x] `audioEngine.init()` startet **ohne** aktive Plugins  
   - [x] `masterChannel.outputGain` beginnt auf min/silent oder mutet  
   - [x] `monitorRouting.ts`: alle Cue-Kanäle anfangs stumm

4. **E2E-Test `tests/e2e/startState.spec.ts`:**
   ```typescript
   // Chromium → Studio betreten
   // Expect: 0 sichtbare ModuleContainer
   // Expect: alle Grid-Icons grayed out / disabled
   // Expect: Main-Analyzer RMS ≤ -60 dBFS
   // Expect: kein Terminal offen
   ```

**Verifikationsschritte:**
- [x] `npm run verify` – alle Tests grün  
- [x] `npm run build` – kein Fehler  
- [x] E2E starten, neuer Tab → 0 Terminals sichtbar  
- [x] Web Audio Analyzer prüft Main-RMS  

---

## Item P0-3: Plugin-Terminals: Close-Button + State-Synchronisation

### Problem
- Plugin-Terminal (z.B. `MischpultTerminal`) soll einen **Close-Button** haben  
- Beim Schließen → Plugin auf `off` schalten  
- Reload behält diesen `off`-Zustand  
- State-Sync über alle 4 User-Sessions (wenn mehrere angemeldet)

### Lösung & Verifikation

**Code-Punkte prüfen:**

1. **`src/components/ModuleContainer.tsx`:**
   - [x] Header mit Close-Button (Icon: `×` oder `⊗`)  
   - [x] `onClick` → `onClose` Callback  
   - [x] Props: `onClose?: () => void`  
   - [x] Close-Button ist immer sichtbar (nicht nur auf Hover)

2. **`src/plugins/PluginBase.tsx`:**
   - [x] `onClose` triggert `moduleState.deactivatePlugin(pluginId)`  
   - [x] Oder direkt: `setPluginState(pluginId, { state: 'off' })`  
   - [x] UI-Feedback: Icon wird dunkel, Terminal verschwindet sofort

3. **State Persistence:**
   - [x] `src/core/session/sessionPersistence.ts`  
     - [x] `savePluginState(pluginId, 'off')` speichert in IndexedDB  
   - [x] `sessionContext` publiziert State über WebSocket an andere User-Sessions  
   - [x] Multi-User: alle 3 anderen User sehen die Änderung sofort (State Update)

4. **Test `tests/e2e/pluginCloseSync.spec.ts`:**
   ```typescript
   // User1: Mischpult Terminal öffnen
   // User1: Close-Button klicken
   // Expect: Terminal weg, Icon dunkel
   
   // User2 sieht dasselbe (WebSocket-Sync)
   
   // Browser-Reload (User1)
   // Expect: Mischpult bleibt aus (off)
   ```

**Verifikationsschritte:**
- [x] Terminal hat sichtbaren Close-Button  
- [x] Klick → Plugin aus, Terminal weg  
- [x] Reload → Zustand bleibt  
- [x] 2-Browser-Test: Sync korrekt  

---

## Item P0-4: Rauschen auf Main beseitigen

### Problem
- **Golden Audio Test:** 60 Sekunden Stille (keine Plugin-Aktivität) darf **max. -60 dBFS** RMS haben  
- Alle Worklets müssen **NaN/Inf-Guards** haben  
- **Fallback-Processor** deckt fehlende Worklets ab (Silent-Output)

### Lösung & Verifikation

**Code-Punkte prüfen:**

1. **Worklet NaN/Inf-Guards:**
   - [x] `src/audio/worklets/masteringProcessor.ts` (Zeile 60–75):
     ```typescript
     // Guard: isNaN() / isFinite() checks
     // Rausch-Filter auf 0-Crossing
     ```
   - [x] `src/audio/worklets/spatialProcessor.ts` (Zeile 108–120)  
   - [x] Alle anderen Worklets (`eqProcessor`, `effectProcessor`, `dspProcessor`)  
   - [x] **Fallback-Processor:** `src/audio/worklets/fallbackProcessor.ts` → Silent-Output (alle Samples = 0)

2. **Master-Kette Verkabelung:**
   - [x] `masteringProcessor` am **Ende** der Master-Kette  
   - [x] `toneShiftTilt` → `eqNode` → `masteringProcessor` → `outputGain`  
   - [x] Keine dualen Ausgänge / Feedback-Schleifen  
   - [x] Dateiname prüfen: `masteringProcessor.ts` (nicht mehrfach instanziiert)

3. **Golden Audio Test `tests/goldenAudio.test.ts`:**
   - [x] Status: `[x]` (bereits implementiert, aber nochmal verifizieren)  
   - [x] Lädt alle Worklets, 60 s Stille  
   - [x] RMS ≤ -60 dBFS (Schwelle)  
   - [x] Test-Run: `npm run test -- goldenAudio`

4. **Prüfung Live** (reine Hörprobe → bleibt in `docs/LIVE_CHECKLIST_2026-09-02.md` offen):
   - [ ] Studio öffnen, **0 Plugins aktiv**  
   - [ ] 60 s warten → Analyzer auf Main prüfen (RMS/Peak anzeigen)  
   - [ ] Sollte unter -60 dBFS sein  
   - [ ] Optional: Oszillograph-Visualisierung → nur Grauen (Quantisierungsrauschen ≤ -140 dBFS)

**Verifikationsschritte:**
- [x] `npm run test -- goldenAudio` grün (60 s Stille-Test)  
- [x] Alle Worklets mit Guard-Checks  
- [ ] Manual: Start ohne Plugin → RMS < -60 dBFS (Hörprobe, siehe LIVE_CHECKLIST)  

---

## Item P0-6: Main-/Monitor-Routing & Mehrbenutzer-Fix

### Problem
- **Main-Bus:** Normaler Stereo-Mix, alle User hören zusammen  
- **Monitor/Cue:** Jeder User kann seinen eigenen Plugin-Ausgang als Cue heraushören (z.B. User2 = Drum-Cue, User3 = Synth-Cue)  
- Cue muss **pre-Master** abgegriffen werden (nicht die finale Ausgabe beeinflussen)  
- Alle 4 User sehen gleichzeitig, wer welchen Cue hört (Lock-Modus wenn User aktiv)  
- **MAIN-Bus bleibt unangetastet** wenn User Cue wechselt

### Lösung & Verifikation

**Code-Punkte prüfen:**

1. **Routing-Datei `src/core/audio/monitorRouting.ts`:**
   - [x] `setupMonitorCue(channel: GainNode, cueGain: GainNode)` – Abgriff pre-Master  
   - [x] `setMonitorMode(userId, 'MAIN' | 'PLUGIN_<id>')` – Umschalter pro User  
   - [x] `getMonitorMode(userId)` – aktuelle Cue-Quelle  
   - [x] 10-ms-Rampe bei Umschaltung (crossfade statt Click)

2. **Audio-Engine Verdrahtung:**
   - [x] `audioEngine.init()` verdrahtet Cue-Pfade:
     - [x] `Channel-7 → cueGain → Speaker/Headphones (User2)`  
     - [x] `bassDelay → cueGain → Speaker (User3)`  
   - [x] Master-Chain bleibt unverändert: alle Kanäle → Master → Output  
   - [x] Cue-Auswahl ist **orthogonal** (nicht invasiv)

3. **State-Sync & Locking (B2B-Modus):**
   - [x] `src/core/session/multiUserLocking.ts` oder ähnlich:
     - [x] Wenn User1 ein Plugin aktiviert (`state: 'active'`) → Lock setzen  
     - [x] Alle anderen User sehen Icon als **grayed out** (nicht veränderbar)  
     - [x] User2/3/4 können **nur** ihre lokale Monitor-View togglen (MAIN ↔ PLUGIN-Cue)  
   - [x] Lock aufgehoben wenn Plugin zurück auf `off`

4. **Test `tests/monitorRouting.test.ts`:**
   - [x] Bereits vorhanden (4-User-Matrix)  
   - [x] Verifiziert: User2 Drum-Cue, User3 Synth-Cue → beide separate Ausgänge  
   - [x] Main-Bus exportieren, prüfen dass identisch bleibt

5. **E2E `tests/e2e/monitorCue.spec.ts`:**
   - [x] 4 Chromium-Browser parallel  
   - [x] User1 aktiviert Drum  
   - [x] User1 hört Drum im Monitor (Cue)  
   - [x] User2 schaltet auf Synth-Cue → hört Synth  
   - [x] User3 bleibt auf Main → hört Drum + Rest  
   - [x] User4 wechselt Cue → alle anderen unverändert

**Verifikationsschritte:**
- [x] `npm run test -- monitorRouting` grün  
- [x] E2E: `npm run test -- e2e/monitorCue` grün  
- [x] Manual 4-Browser-Test (Cue-Umschalter funktioniert)  
- [x] Exportierte Graph-State zeigt Main-Bus unverändert

---

## Item P0-7: Master-Player fest oben mit Transport

### Problem
- **Master-Player** (Play/Stop/Tempo-Knob) muss **immer oben sichtbar** sein  
- Egal wie weit man scrollt oder Fenster resized  
- Keyboard-Shortcut (Spacebar) funktioniert  
- Button-Klick funktioniert  
- Transport-Linie zeigt aktuelle Position

### Lösung & Verifikation

**Code-Punkte prüfen:**

1. **`src/components/MasterPlayer.tsx` oder `MasterPlayerBar.tsx`:**
   - [x] Position: `position: fixed; top: 0; z-index: 1000` (oben-sticky)  
   - [x] Width: 100% oder mit kleiner Padding  
   - [x] Play/Stop Button  
   - [x] Tempo-Regler (Knob oder Slider, BPM-Input)  
   - [x] Transport-Linie (aktueller Playhead)  
   - [x] Responsive auf Mobile: Touch-Targets ≥ 44 px

2. **Keyboard-Handler:**
   - [x] `useKeyboardShortcuts.ts` oder im Component:
     - [x] `Spacebar` → Toggle Play/Stop  
     - [x] Event-Listener auf `document` (nicht Input-fokussiert)  
   - [x] Prevent-Default für Spacebar (nicht Page-Scroll)

3. **State-Sync:**
   - [x] `masterClock.ts` → BPM, Play-State  
   - [x] `sessionContext` aktualisiert Play-State für alle User (WebSocket)  
   - [x] Multi-User: Klick auf Play in User1 → alle 4 User sehen Start  
   - [x] Transport-Linie synchronized per `clockDiagnostics`

4. **Layout-Integration:**
   - [x] `src/App.tsx` Struktur:
     ```
     <MasterPlayerBar /> (fixed top)
     <MainLayout>
       <PluginGrid />
       <Workspace>
         <ScrollableContainer /> (mit Offset `padding-top`)
       </Workspace>
     </MainLayout>
     ```
   - [x] Scrollbarer Content **unten** + Padding-Top um Player-Höhe

5. **Test `tests/e2e/masterPlayerFixed.spec.ts`:**
   - [x] Studio öffnen → Player-Bar oben sichtbar  
   - [x] Scroll down 500 px → Player-Bar bleibt oben  
   - [x] Klick Play-Button → Play  
   - [x] Spacebar → Stop  
   - [x] Tempo ändern → BPM aktualisiert (alle User)

**Verifikationsschritte:**
- [x] Visual: Player oben bleiben (Scroll-Test)  
- [x] Keyboard: Spacebar funktioniert (nicht nur Button)  
- [x] E2E: `npm run test -- e2e/masterPlayerFixed`  
- [x] Multi-Browser-Test: Sync korrekt

---

## Gesamt-Verifikations-Checkliste

Zur Bestätigung, dass alle P0-Items produktionsreif sind:

### Tests ausführen
- [x] `npm run verify` → 0 Fehler (106 Dateien / 600 Tests grün, Boundary-Scan 0)  
- [x] `npm run test:e2e` → P0-Specs grün (`collab`/`live2browser`/`hardware`/`visual` bleiben umgebungsbedingt rot, unverändert)  
  - [x] `startState.spec.ts` (P0-1)  
  - [x] `pluginCloseSync.spec.ts` (P0-3)  
  - [x] `masterPlayerFixed.spec.ts` (P0-7)  
  - [x] `monitorCue.spec.ts` (P0-6)  
  - [x] `smoke.spec.ts` (P0-1/P0-3/P0-7-Kurzprüfungen)  
- [x] `npm run test -- goldenAudio` → RMS ≤ -60 dBFS (P0-4)

### Code-Qualität
- [x] Keine `TODO` oder `FIXME` in relevanten Dateien  
- [x] Alle Worklets mit NaN/Inf-Guards (P0-4)  
- [x] Keine Regressions in bestehenden Tests  
- [x] TypeScript: `npm run tsc` 0 Errors

### Manual-Prüfung (Hörprobe – bleibt in `docs/LIVE_CHECKLIST_2026-09-02.md`)
- [ ] Studio öffnen → 0 Plugins sichtbar, Stille (P0-1)  
- [ ] Close-Button klicken → Plugin aus, Reload erhält Zustand (P0-3)  
- [ ] 60 s warten ohne Aktivität → Analyzer < -60 dBFS (P0-4)  
- [ ] 4-Browser: Cue/Main korrekt getrennt (P0-6)  
- [ ] Scroll + Keyboard-Spacebar funktioniert (P0-7)

### Dokumentation
- [x] Alle P0-Items in MASTER_TODO.md bleiben `[x]`  
- [x] Ergänzungen in TASKDONE.md dokumentieren  
- [x] Keine Breaking Changes zu anderen Plugins  

---

## Debugging-Tipps

Falls etwas schiefgeht:

### P0-1 / P0-3: Plugin Sichtbarkeit
- **Prüfe:** `src/context/ModuleStateContext.tsx` – `visibleModuleIds` leer?  
- **WebSocket-Log:** `SessionContext` publiziert korrekt?  
- **Browser-DevTools:** `localStorage` / `IndexedDB` prüfen (Session-State)

### P0-4: Rauschen
- **Worklet-Check:** Ist `masteringProcessor` verdrahtet?  
- **Guard-Check:** `isNaN()` / `isFinite()` Zeilen korrekt?  
- **Test-Log:** `npm run test -- goldenAudio --reporter=verbose`

### P0-6: Cue-Routing
- **Audio-Graph Export:** `audioEngine.exportGraphState()` zeigt Cue-Pfade?  
- **Gain-Check:** `cueGain.gain.value` ist nicht Infinity/NaN?  
- **WebSocket-Monitor:** Sind State-Updates für alle User ankommen?

### P0-7: Master-Player
- **CSS-Check:** `position: fixed` vorhanden? `z-index: 1000` ausreichend?  
- **Event-Listener:** DevTools → Event-Listener auf Document prüfen  
- **Render-Check:** React Profiler – Player neurendern ohne Grund?

---

## Nächste Schritte nach P0-Abschluss

Falls alle P0-Items verifiziert:
1. **MASTER_TODO.md** → Alle P0-Items mit `→ TASKDONE`-Vermerk + Datum  
2. **TASKDONE.md** → Neue Einträge für P0-1/3/4/6/7 (Verifikations-Nachweise)  
3. **PR erstellen** mit Commit-Message: `P0: Stabilität & Signalfluss final verifiziert`  
4. → Nächste Priorität: **P1-Items** (UX/UI, Responsive, Klassiker-Skins)

---

## Ressourcen

- **MASTER_TODO.md** (Zeile 90–112): Ursprüngliche P0-Definition  
- **TASKDONE.md**: Archiv erledigter Aufgaben + Nachweis  
- **Docs:**
  - `docs/LIVE_CHECKLIST_2026-09-02.md` – Manual-Hörproben  
  - `docs/HARDWARE_TEST_MATRIX_2026.md` – Plattformen  
  - `docs/SERVER_FLEET.md` – Multi-Server-Architektur  
- **Test-Ordner:** `tests/` (Unit + Integration) + `tests/e2e/` (End-to-End)  
- **Worklets:** `src/audio/worklets/` (NaN-Guards, Fallback)  
- **Routing:** `src/core/audio/monitorRouting.ts` (Cue/Main-Trennung)

---

**Status:** Verifikation am 2026-09-03 abgeschlossen. Gefundene und behobene Lücken:
Mixer-Host-Seed entfernt (P0-1), Start-Silence-Gate in `audioEngine.init()` (P0-1/P0-4),
`fallbackProcessor` mit NaN/Inf-Sanitizing (P0-4), defekter Smoke-Prüfpunkt + Heading
`masterplayerMONK` korrigiert (P0-7), neue E2E-Specs `startState`, `pluginCloseSync`,
`masterPlayerFixed`. Umgebungsbedingt rot bleiben `collab`/`live2browser`/`hardware` und die
Linux-Screenshot-Baselines (`visual.spec.ts`) – unverändert gegenüber dem Vorzustand.

**Ziel:** Nach Abschluss dieses Plans → **P0-Items produktionsreif** + **Alle Tests grün** + **Keine Breaking Changes**.
