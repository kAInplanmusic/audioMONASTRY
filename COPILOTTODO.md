# COPILOTTODO – Agenten-Plan für P0-kritische Items

> **Zielgruppe:** Nachfolgender Copilot-Agent
> **Ziel:** Alle P0-kritischen Items (`MASTER_TODO.md` Zeile 90–112) produktionsreif abschließen  
> **Status:** Basierend auf Stand 2026-09-03, alle Items bereits mit `[x]` markiert
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
   - [ ] `pluginState`-Init: alle Plugins auf `state: 'off'`  
   - [ ] `visibleModuleIds` im `SessionContext`: leer starten (oder nur mit explizitem User-Klick sichtbar)  
   - [ ] Grid-Icons nutzen `IconButton` mit `disabled={true}` bei Offline/Start

2. **`src/core/session/sessionInit.ts` oder ähnlich:**
   - [ ] `initializeSession()` setzt alle Plugins auf `off`  
   - [ ] Mixer wird **nicht** auto-aktiviert (Mixer-Sonderfall ENTFERNT)  
   - [ ] Optional: `persistedState` wird ignoriert bei Fresh-Start (oder explizit `off`-gesetzt)

3. **Monitor-Routing / Audio-Engine:**
   - [ ] `audioEngine.init()` startet **ohne** aktive Plugins  
   - [ ] `masterChannel.outputGain` beginnt auf min/silent oder mutet  
   - [ ] `monitorRouting.ts`: alle Cue-Kanäle anfangs stumm

4. **E2E-Test `tests/e2e/startState.spec.ts`:**
   ```typescript
   // Chromium → Studio betreten
   // Expect: 0 sichtbare ModuleContainer
   // Expect: alle Grid-Icons grayed out / disabled
   // Expect: Main-Analyzer RMS ≤ -60 dBFS
   // Expect: kein Terminal offen
   ```

**Verifikationsschritte:**
- [ ] `npm run verify` – alle Tests grün  
- [ ] `npm run build` – kein Fehler  
- [ ] E2E starten, neuer Tab → 0 Terminals sichtbar  
- [ ] Web Audio Analyzer prüft Main-RMS  

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
   - [ ] Header mit Close-Button (Icon: `×` oder `⊗`)  
   - [ ] `onClick` → `onClose` Callback  
   - [ ] Props: `onClose?: () => void`  
   - [ ] Close-Button ist immer sichtbar (nicht nur auf Hover)

2. **`src/plugins/PluginBase.tsx`:**
   - [ ] `onClose` triggert `moduleState.deactivatePlugin(pluginId)`  
   - [ ] Oder direkt: `setPluginState(pluginId, { state: 'off' })`  
   - [ ] UI-Feedback: Icon wird dunkel, Terminal verschwindet sofort

3. **State Persistence:**
   - [ ] `src/core/session/sessionPersistence.ts`  
     - [ ] `savePluginState(pluginId, 'off')` speichert in IndexedDB  
   - [ ] `sessionContext` publiziert State über WebSocket an andere User-Sessions  
   - [ ] Multi-User: alle 3 anderen User sehen die Änderung sofort (State Update)

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
- [ ] Terminal hat sichtbaren Close-Button  
- [ ] Klick → Plugin aus, Terminal weg  
- [ ] Reload → Zustand bleibt  
- [ ] 2-Browser-Test: Sync korrekt  

---

## Item P0-4: Rauschen auf Main beseitigen

### Problem
- **Golden Audio Test:** 60 Sekunden Stille (keine Plugin-Aktivität) darf **max. -60 dBFS** RMS haben  
- Alle Worklets müssen **NaN/Inf-Guards** haben  
- **Fallback-Processor** deckt fehlende Worklets ab (Silent-Output)

### Lösung & Verifikation

**Code-Punkte prüfen:**

1. **Worklet NaN/Inf-Guards:**
   - [ ] `src/audio/worklets/masteringProcessor.ts` (Zeile 60–75):
     ```typescript
     // Guard: isNaN() / isFinite() checks
     // Rausch-Filter auf 0-Crossing
     ```
   - [ ] `src/audio/worklets/spatialProcessor.ts` (Zeile 108–120)  
   - [ ] Alle anderen Worklets (`eqProcessor`, `effectProcessor`, `dspProcessor`)  
   - [ ] **Fallback-Processor:** `src/audio/worklets/fallbackProcessor.ts` → Silent-Output (alle Samples = 0)

2. **Master-Kette Verkabelung:**
   - [ ] `masteringProcessor` am **Ende** der Master-Kette  
   - [ ] `toneShiftTilt` → `eqNode` → `masteringProcessor` → `outputGain`  
   - [ ] Keine dualen Ausgänge / Feedback-Schleifen  
   - [ ] Dateiname prüfen: `masteringProcessor.ts` (nicht mehrfach instanziiert)

3. **Golden Audio Test `tests/goldenAudio.test.ts`:**
   - [ ] Status: `[x]` (bereits implementiert, aber nochmal verifizieren)  
   - [ ] Lädt alle Worklets, 60 s Stille  
   - [ ] RMS ≤ -60 dBFS (Schwelle)  
   - [ ] Test-Run: `npm run test -- goldenAudio`

4. **Prüfung Live:**
   - [ ] Studio öffnen, **0 Plugins aktiv**  
   - [ ] 60 s warten → Analyzer auf Main prüfen (RMS/Peak anzeigen)  
   - [ ] Sollte unter -60 dBFS sein  
   - [ ] Optional: Oszillograph-Visualisierung → nur Grauen (Quantisierungsrauschen ≤ -140 dBFS)

**Verifikationsschritte:**
- [ ] `npm run test -- goldenAudio` grün (60 s Stille-Test)  
- [ ] Alle Worklets mit Guard-Checks  
- [ ] Manual: Start ohne Plugin → RMS < -60 dBFS  

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
   - [ ] `setupMonitorCue(channel: GainNode, cueGain: GainNode)` – Abgriff pre-Master  
   - [ ] `setMonitorMode(userId, 'MAIN' | 'PLUGIN_<id>')` – Umschalter pro User  
   - [ ] `getMonitorMode(userId)` – aktuelle Cue-Quelle  
   - [ ] 10-ms-Rampe bei Umschaltung (crossfade statt Click)

2. **Audio-Engine Verdrahtung:**
   - [ ] `audioEngine.init()` verdrahtet Cue-Pfade:
     - [ ] `Channel-7 → cueGain → Speaker/Headphones (User2)`  
     - [ ] `bassDelay → cueGain → Speaker (User3)`  
   - [ ] Master-Chain bleibt unverändert: alle Kanäle → Master → Output  
   - [ ] Cue-Auswahl ist **orthogonal** (nicht invasiv)

3. **State-Sync & Locking (B2B-Modus):**
   - [ ] `src/core/session/multiUserLocking.ts` oder ähnlich:
     - [ ] Wenn User1 ein Plugin aktiviert (`state: 'active'`) → Lock setzen  
     - [ ] Alle anderen User sehen Icon als **grayed out** (nicht veränderbar)  
     - [ ] User2/3/4 können **nur** ihre lokale Monitor-View togglen (MAIN ↔ PLUGIN-Cue)  
   - [ ] Lock aufgehoben wenn Plugin zurück auf `off`

4. **Test `tests/monitorRouting.test.ts`:**
   - [ ] Bereits vorhanden (4-User-Matrix)  
   - [ ] Verifiziert: User2 Drum-Cue, User3 Synth-Cue → beide separate Ausgänge  
   - [ ] Main-Bus exportieren, prüfen dass identisch bleibt

5. **E2E `tests/e2e/monitorCue.spec.ts`:**
   - [ ] 4 Chromium-Browser parallel  
   - [ ] User1 aktiviert Drum  
   - [ ] User1 hört Drum im Monitor (Cue)  
   - [ ] User2 schaltet auf Synth-Cue → hört Synth  
   - [ ] User3 bleibt auf Main → hört Drum + Rest  
   - [ ] User4 wechselt Cue → alle anderen unverändert

**Verifikationsschritte:**
- [ ] `npm run test -- monitorRouting` grün  
- [ ] E2E: `npm run test -- e2e/monitorCue` grün  
- [ ] Manual 4-Browser-Test (Cue-Umschalter funktioniert)  
- [ ] Exportierte Graph-State zeigt Main-Bus unverändert

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
   - [ ] Position: `position: fixed; top: 0; z-index: 1000` (oben-sticky)  
   - [ ] Width: 100% oder mit kleiner Padding  
   - [ ] Play/Stop Button  
   - [ ] Tempo-Regler (Knob oder Slider, BPM-Input)  
   - [ ] Transport-Linie (aktueller Playhead)  
   - [ ] Responsive auf Mobile: Touch-Targets ≥ 44 px

2. **Keyboard-Handler:**
   - [ ] `useKeyboardShortcuts.ts` oder im Component:
     - [ ] `Spacebar` → Toggle Play/Stop  
     - [ ] Event-Listener auf `document` (nicht Input-fokussiert)  
   - [ ] Prevent-Default für Spacebar (nicht Page-Scroll)

3. **State-Sync:**
   - [ ] `masterClock.ts` → BPM, Play-State  
   - [ ] `sessionContext` aktualisiert Play-State für alle User (WebSocket)  
   - [ ] Multi-User: Klick auf Play in User1 → alle 4 User sehen Start  
   - [ ] Transport-Linie synchronized per `clockDiagnostics`

4. **Layout-Integration:**
   - [ ] `src/App.tsx` Struktur:
     ```
     <MasterPlayerBar /> (fixed top)
     <MainLayout>
       <PluginGrid />
       <Workspace>
         <ScrollableContainer /> (mit Offset `padding-top`)
       </Workspace>
     </MainLayout>
     ```
   - [ ] Scrollbarer Content **unten** + Padding-Top um Player-Höhe

5. **Test `tests/e2e/masterPlayerFixed.spec.ts`:**
   - [ ] Studio öffnen → Player-Bar oben sichtbar  
   - [ ] Scroll down 500 px → Player-Bar bleibt oben  
   - [ ] Klick Play-Button → Play  
   - [ ] Spacebar → Stop  
   - [ ] Tempo ändern → BPM aktualisiert (alle User)

**Verifikationsschritte:**
- [ ] Visual: Player oben bleiben (Scroll-Test)  
- [ ] Keyboard: Spacebar funktioniert (nicht nur Button)  
- [ ] E2E: `npm run test -- e2e/masterPlayerFixed`  
- [ ] Multi-Browser-Test: Sync korrekt

---

## Gesamt-Verifikations-Checkliste

Zur Bestätigung, dass alle P0-Items produktionsreif sind:

### Tests ausführen
- [ ] `npm run verify` → 0 Fehler (483+ Tests grün, Boundary-Scan 0)  
- [ ] `npm run test -- e2e` → Alle E2E-Tests grün  
  - [ ] `startState.spec.ts` (P0-1)  
  - [ ] `pluginCloseSync.spec.ts` (P0-3)  
  - [ ] `masterPlayerFixed.spec.ts` (P0-7)  
  - [ ] `monitorCue.spec.ts` (P0-6)  
- [ ] `npm run test -- goldenAudio` → RMS ≤ -60 dBFS (P0-4)

### Code-Qualität
- [ ] Keine `TODO` oder `FIXME` in relevanten Dateien  
- [ ] Alle Worklets mit NaN/Inf-Guards (P0-4)  
- [ ] Keine Regressions in bestehenden Tests  
- [ ] TypeScript: `npm run tsc` 0 Errors

### Manual-Prüfung (Hörprobe)
- [ ] Studio öffnen → 0 Plugins sichtbar, Stille (P0-1)  
- [ ] Close-Button klicken → Plugin aus, Reload erhält Zustand (P0-3)  
- [ ] 60 s warten ohne Aktivität → Analyzer < -60 dBFS (P0-4)  
- [ ] 4-Browser: Cue/Main korrekt getrennt (P0-6)  
- [ ] Scroll + Keyboard-Spacebar funktioniert (P0-7)

### Dokumentation
- [ ] Alle P0-Items in MASTER_TODO.md bleiben `[x]`  
- [ ] Ergänzungen in TASKDONE.md dokumentieren  
- [ ] Keine Breaking Changes zu anderen Plugins  

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

**Status:** Dieser Plan basiert auf dem Stand 2026-09-03. Alle Items sind bereits initial implementiert und mit `[x]` markiert. Der Agent soll diese Verifikation durchführen und ggf. Fehler beheben.

**Ziel:** Nach Abschluss dieses Plans → **P0-Items produktionsreif** + **Alle Tests grün** + **Keine Breaking Changes**.
