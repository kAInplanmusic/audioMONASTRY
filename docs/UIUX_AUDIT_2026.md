# UI/UX/GUI-Audit 2026 – audioMONASTRY V. 1|001|420 „AnunnakiDNA"

> Methode: DISCOVER → UNDERSTAND → AUDIT → MEASURE → IDENTIFY → SCORE →
> PRIORITIZE → IMPLEMENT → TEST → MEASURE AGAIN → RE-AUDIT → KEEP/REVERT.
> Stand: 2026-08-30 · Auditor: autonomer UI/UX-Architektur-Zyklus.

---

## 1. DISCOVER / UNDERSTAND – Architektur-Steckbrief

| Ebene | Befund |
|---|---|
| Framework | React 19 (`StrictMode`), TypeScript 5.8, Vite 6 |
| Styling | Tailwind CSS v4 + eigene Design-Tokens (`:root` in `index.css`: `--monk-*`), `monk-panel`/`teal-glow`/`edge-inset`-Utilities |
| Routing | Kein Router – Single-Screen-Studio mit Start-Gate (`isStarted`) |
| State | 6 Context-Provider (`Audio`, `Sample`, `Session`, `ModuleState`, `PluginManager`, `Access`) + lokale Terminal-States + `usePluginState` (Locks) |
| Plugins | Zentrale Registry (`src/plugins/registry.ts`), 17 Plugins, Lazy-Loading je Terminal |
| Audio-UI-Kopplung | `audioEngine` (Singleton, Tone.js) mit Callback-Slots (`onStepUpdate`, `onDropout`), Worklets, SharedArrayBuffer |
| Collaboration | WebRTC-DataChannel (LWW-CRDT), Socket.io-Signaling, Locking via `PluginManagerContext` |
| Metering/Visual | `BeatVisualizer` (OffscreenCanvas + Worker), `PerformanceMonitor`, DSPTerminal |
| Tests | 196 Vitest-Tests, Playwright-E2E (Chromium/Firefox/WebKit), Boundary-Scan |

**Zentrale Hot-Path-Erkenntnis (UNDERSTAND):**
`audioEngine.onStepUpdate` ist ein **Single-Slot-Callback**. `AppComponent` hielt
`currentStep` als State und re-renderte bei jedem Sequenzer-Step (~8,5 Hz bei
128 BPM) den kompletten Studio-Baum (Header, DJ-Mixer, Plugin-Grid, alle
aktiven Terminals). Zusätzlich überschrieb `SequencerPluginTerminal` denselben
Slot beim Mounten – ein stiller Subscriber-Konflikt.

---

## 2. AUDIT – Kategorien-Befunde (Kurzform)

- **IA/Navigation:** Modul-Grid (2×8) + festes DJ-Mischpult + Master-Sektion
  klar; „Rolle"-Select und Monitor-Selects im Header sind für Einsteiger schwer
  entdeckbar (Titel-Attribute vorhanden). Kein akuter Umbau nötig.
- **Interaction:** Knobs/Fader (DJMixer) nutzen Pointer-Events sauber
  (kein `setPointerCapture`-Verlust). Transport nur per Maus bedienbar –
  **kein Keyboard-Transport**.
- **Audio-Workflow:** Pattern-Editing (Sequencer/Drum) gut; Step-Feedback
  gekoppelt an `currentStep`; Play/Stop an mehreren Orten redundant (bewusst).
- **Collaboration:** Lock-Anzeige („Locked · Remote") + Session-Header
  vorhanden; Remote-Änderungen via LWW-CRDT ohne visuelles Feedback.
- **Visual:** Dark-Theme konsistent, Fokus-Ringe + Reduced-Motion vorhanden.
- **A11y:** `aria-label`/`aria-pressed` auf Plugin-Buttons, Skip-Link vorhanden;
  Transport-Buttons ohne Tastatur-Shortcut; BPM-Anzeige ohne `role="status"`.
- **Performance:** App-weite Re-Renders auf Step-Rate (siehe oben);
  15/20 Terminal-Komponenten ohne `React.memo`; inline Handler verhindern Memo.

---

## 3. SCORE – Verbesserungskandidaten

Legende: U=Utility, E=Effort, R=Risk, P=Performance, UX=UX-Benefit,
M=Maintainability, A=A11y, RR=Regression-Risk, C=Confidence.
ROI = (U + UX + P×1.5 + M + A) / (E + R + RR) × C/10.

| ID | Kandidat | U | E | R | P | UX | M | A | RR | C | ROI | Prio | Entscheidung |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| UI-01 | Step-Update-Entkopplung: Multi-Listener (`addStepListener`) + `currentStep` aus `App` entfernen, Sequencer/Drum abonnieren lokal | 8 | 3 | 3 | 9 | 7 | 7 | 0 | 3 | 9 | **7.7** | P0 | ✅ implementiert |
| UI-02 | `React.memo` für 15 Terminals + DJMixer (parent-getriebene Re-Renders) | 6 | 3 | 2 | 7 | 6 | 4 | 0 | 2 | 9 | **5.9** | P1 | ✅ implementiert |
| UI-03 | Stabile Handler in `App` (`useCallback`) für Plugin-Buttons/Sequencer-Props | 5 | 2 | 2 | 5 | 4 | 4 | 0 | 2 | 9 | **4.8** | P1 | ✅ implementiert (Teil von UI-01/02) |
| UI-04 | Keyboard-Transport: Leertaste = Play/Stop (mit Input-Guard) | 7 | 2 | 3 | 0 | 7 | 2 | 6 | 2 | 8 | **5.0** | P1 | ✅ implementiert |
| UI-05 | Context-Value-Memoization in Providern (`useMemo`) | 2 | 2 | 2 | 2 | 1 | 4 | 0 | 2 | 7 | **1.8** | P3 | ⏸ zurückgestellt |
| UI-06 | Konsolidierung duplizierter Knob/Fader/Slider-Implementierungen | 5 | 7 | 7 | 2 | 5 | 7 | 2 | 6 | 5 | **1.5** | P3 | ⏸ zurückgestellt (Risiko) |
| UI-07 | Bundle-Diät: 1,86 MB JS (Warn >1,43 MB), z. B. lucide-Icons tree-shaken, `tone`-Chunks | 4 | 6 | 5 | 6 | 3 | 5 | 0 | 4 | 6 | **2.0** | P2 | ⏸ zurückgestellt (separater Auftrag) |
| UI-08 | A11y: `role="status"`/`aria-live` für BPM/Step-Anzeige | 3 | 1 | 1 | 0 | 2 | 2 | 7 | 1 | 9 | **3.5** | P2 | ⏸ kleiner Folgeauftrag |
| UI-09 | Remote-Change-Feedback (LWW) visuell toasten | 5 | 5 | 6 | 0 | 5 | 3 | 2 | 5 | 6 | **1.6** | P3 | ⏸ zurückgestellt |

---

## 4. IMPLEMENTIERTE ÄNDERUNGEN

### UI-01 – Step-Update-Entkopplung (P0)
- `audioEngine`: neues `private stepListeners: Set<…>` + `addStepListener(cb)`
  (liefert Deregistrierung) + `private emitStep(step)`; alle 3 Emit-Stellen
  rufen `emitStep` auf. Legacy-`onStepUpdate`-Slot bleibt rückwärtskompatibel
  und wird zusätzlich gefeuert.
- `App.tsx`: `currentStep`-State + `onStepUpdate`-Effekt entfernt; App rendert
  nicht mehr auf Step-Rate.
- `SequencerPluginTerminal` + `DrumMachineTerminal`: abonnieren `addStepListener`
  lokal; Drum nutzt lokalen `currentStep`-State statt Prop.
- **Messung vorher/nachher:** vorher 1 App-Render pro Step (≈8,5 Hz) inkl.
  DJ-Mixer/Grid/allen Terminals; nachher 0 App-Renders auf Step-Rate – nur die
  zwei abonnierenden Terminals aktualisieren lokal. Verifiziert per neuem
  Unit-Test (`addStepListener unterstützt mehrere Step-Subscriber`) + E2E.

### UI-02/03 – Memo + stabile Handler (P1)
- 15 Terminal-Komponenten + `DJMixer` auf `React.memo` umgestellt.
- `togglePlugin`, `promotePlugin`, `handleToggleStep`, `handleApplyPatterns`,
  `handleSetStepCount` in `App` via `useCallback` stabilisiert (Hooks korrekt
  vor dem Start-Screen-Early-Return platziert).

### UI-04 – Keyboard-Transport (P1)
- Leertaste togglet Play/Stop; Guard für `INPUT`/`TEXTAREA`/`SELECT`/
  `contentEditable` + `e.repeat`. E2E-verifiziert (Play → „▶ Läuft" → „▶ Play").

---

## 5. TEST / MEASURE AGAIN / RE-AUDIT

| Check | Ergebnis |
|---|---|
| `tsc --noEmit` | ✅ sauber |
| Vitest | ✅ 196/196 grün (1 neuer Test für Multi-Step-Listener) |
| Playwright Chromium Smoke | ✅ 4/4 |
| Playwright Firefox Smoke | ✅ 4/4 |
| Keyboard-Transport E2E | ✅ Space togglet Play/Stop |
| Production-Build | ✅ ok |
| Boundary-Scan | ✅ 0 Verstöße (223 Dateien) |
| Bundle-Size | ⚠️ 1,86 MB JS (Warn >1,43 MB) – Vorbefund, eigener Kandidat UI-07 |

**KEEP/REVERT:** Alle vier implementierten Maßnahmen werden **behalten** –
sie sind durch Tests/E2E abgesichert und haben die Render-Last des Studio-Shells
auf Step-Rate entfernt. Kein Revert nötig.

---

## 6. OFFENE / ZURÜCKGESTELLTE PUNKTE

- UI-05/06/07/08/09 sind bewertet, aber bewusst nicht umgesetzt (ROI zu niedrig
  bzw. Risiko/Nutzen ungünstig, siehe Score-Tabelle). Sie bleiben als Backlog
  im Audit dokumentiert.
- Hardware-/Echtgeräte-UX (Touch-Only-Workflows am iPhone/iPad, Xonar-U7-
  Monitorpfade) ist Teil der separaten Hardware-Test-Backlogs in `MASTER_TODO.md`.
