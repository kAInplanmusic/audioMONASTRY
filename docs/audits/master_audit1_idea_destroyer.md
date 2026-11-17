# audioMONASTRY — Phase C Audit 1 (Idea Destroyer): masterMONK

**Plugin:** `master` / `masterMONK`, Rolle `insert` (Master-Insert, Position 3 von 3, `insertScope: 'master'`)
**Stand:** Commit f5538c63
**Art:** adversarial — die Idee eines echten Mastering-Inserts mit Limiter und Lookahead wird angegriffen.

---

## 1. Grundkonzept (wie behauptet)

`pluginContract.ts` (Zeile 373–394): `master` ist der letzte Master-Insert, 1×1 Stereo, `intrinsicLatencyFrames: 240` (5 ms Lookahead-Limiter bei 48 kHz, die *einzige* echte Systemlatenz), bypassable, `producesAudio: false`. Die UI (`MasterRack.tsx`) wirbt mit einer vollständigen Mastering-Kette: Input, Hochpass, EQ, Kompressor, Limiter, Ziel-LUFS, Ceiling (True Peak), 12-Band-Klangbild, LUFS-Metering.

Adapter: `src/plugins/adapters/MasterPluginAdapter.ts` — wendet **nur einen linearen Gain (0–2)** an.

## 2. Architektur-Analyse (Ist-Zustand)

- Vertrag: `src/plugins/pluginContract.ts` — Master-Insert, 240 Frames Lookahead-Limiter.
- UI: `src/components/master/MasterRack.tsx` (+ `MasteringOverlay` lazy in Registry), `data/masteringPresets.ts` (`MASTERING_PRESETS`), `useMainLevel` für LUFS-Anzeige.
- Adapter: `src/plugins/adapters/MasterPluginAdapter.ts` — `onProcess`: linearer Gain, geklemmt 0–2; `onParameter`: `masterVolumeDb` → `audioEngine.setMasterVolumeDb`, `inputGain` → `updateMasterMe`; `onCommand preset` → `updateMasterMe` + `updateToneShiftEQ`.
- Engine: `audioEngine.setMasterVolumeDb`, `updateMasterMe`, `updateToneShiftEQ`, `getLufsValue`.
- C0: `WORKLET_BINDING.master = 'mastering-processor'`, `mastering = MasteringNode('master')` mit 240-Frames-Zustand, `insertNodes.master = WorkletChainNode`.
- Router: `src/core/pluginAudioRouter.ts` Zeile 72 — `['master', 'ui-only', false]`.
- Signal chain: `masterInserts[2]` — konsistent mit Vertrag.
- Bounce: `pluginChainBounce` rendert alle Adapter inklusive Master-Adapter (also linearen Gain).

## 3. Technische Fehlannahmen

1. **Fehlannahme: Der Master limitiert.** Falsch. Der Adapter `MasterPluginAdapter.onProcess` (Zeile 42–51) multipliziert jeden Sample mit einem statischen Gain (0–2). Es gibt **keinen Limiter, keinen Kompressor, keinen Hochpass, kein EQ, keine True-Peak-Kontrolle**. Der Vertrag verspricht einen 5-ms-Lookahead-Limiter (240 Frames), der im Adapter nicht existiert.

2. **Fehlannahme: Die 240 Frames Latenz haben einen Zweck.** Der Lookahead dient einem Limiter. Da kein Limiter im Adapter (und im Bounce-Pfad) existiert, kompensiert das System 240 Frames (5 ms) für eine Verarbeitung, die nicht stattfindet. Jeder andere Pfad wird um 5 ms verzögert, um auf einen nicht vorhandenen Limiter zu warten — unnötige Systemlatenz.

3. **Fehlannahme: UI und Adapter bilden dieselbe Mastering-Kette ab.** `MasterRack.tsx` zeigt Input, HP, EQ, Comp, Limiter, Ceiling, LUFS, 12-Band-Klangbild. Nichts davon erreicht den Adapter. Die Mastering-Idee ist reines UI-Theater; der hörbare Pfad ist ein Lautstärkeregler.

4. **Fehlannahme: Presets wirken im Master.** `onCommand 'preset'` schreibt `MASTERING_PRESETS` via `audioEngine.updateMasterMe`/`updateToneShiftEQ` in die Engine — nie in den Adapter. Der Bounce (`pluginChainBounce`) rendert Adapter, nicht Engine-Zustand → gebounctes Master ignoriert Presets völlig.

5. **Fehlannahme: "Ziel LUFS" steuert etwas.** Der LUFS-Regler in der UI liest `audioEngine.getLufsValue()` (250-ms-Intervall) und zeigt einen Balken. Es gibt keine Rückkopplung auf den Adapter (keine automatische Gain-Korrektur, kein True-Peak-Limiter). Ziel-LUFS ist eine Anzeige, kein Regler.

6. **Fehlannahme: Der Master sei der letzte wirkende Knoten.** Vertraglich ja; strukturell folgt nach dem Master-Insert in `C0StudioChain` noch `itSynth` (Zeile 232–233) vor dem Recorder — ein nicht-vertraglicher Knoten, der nach dem Master sitzt und den "letzten Insert"-Anspruch unterläuft.

7. **Fehlannahme: Bypass ist sicher.** `BaseAdapter.state === 'OFF'` → transparenter Durchlass. Aber `bypassable: true` bei einem Limiter bedeutet: Bypass entfernt den Ceiling-Schutz → Clipping am Ausgang möglich, ohne dass der Nutzer eine Warnung sieht.

## 4. Designschwächen

- **Adapter implementiert none der deklarierten Mastering-Funktionen.** Gain-only statt Limiter/Comp/EQ.
- **Latenz ohne Verarbeitung.** 240 Frames werden deklariert, aber der Adapter tut nichts, was eine Lookahead-Pufferung rechtfertigen würde.
- **UI/Engine/Adapter-Dreieck ohne Abstimmung.** Presets, LUFS, Mastering-Parameter leben in der UI und Engine; der Adapter ist aus der Schleife ausgeschlossen.
- **`itSynth` nach dem Master.** C0StudioChain schaltet `itSynth` zwischen letztem Insert und Recorder — nicht im Vertrag, nicht in `signalTopology()`.
- **Kein True-Peak-/Ceiling-Schutz trotz angekündigtem Limiter.** Clipping am Master-Ausgang nicht verhindert.
- **LUFS-Messung ohne Regelkreis.** Messung existiert, Korrektur nicht.

## 5. Performance-/DSP-Risiken

- Der Adapter-Gain ist in-place und billig — kein DSP-Risiko, aber eben keine Verarbeitung.
- Das deklarierte 240-Frames-Lookahead erfordert bei echter Implementierung einen Puffer (Lookahead-Delay-Line). Aktuell nicht vorhanden; bei Nachrüstung müssten `tailSamples` und `intrinsicLatencyFrames` konsistent werden.
- Bounce durch die Kette rendert Master = Gain only → gebounctes Material kann übersteuern (kein Ceiling), weil kein Limiter im Offline-Pfad wirkt.
- `setInterval(..., 250)` für LUFS in `MasterRack` läuft, solange das Rack offen ist — geringer, aber unnötiger Hauptthread-Overhead.

## 6. Schnittstellen-Probleme

| Schnittstelle | Problem |
|---|---|
| Vertrag ↔ Adapter | Vertrag: Lookahead-Limiter, 240 Frames. Adapter: linearer Gain 0–2. Totaler Widerspruch. |
| UI ↔ Adapter | UI zeigt komplette Mastering-Kette; Adapter erhält nichts davon. |
| Engine ↔ Adapter | Presets/LUFS/MasterMe leben in der Engine; Adapter wird nie aktualisiert. |
| Bounce ↔ Mastering | `pluginChainBounce` rendert Adapter (Gain), nicht Engine-Mastering → Bounce ignoriert alle Mastering-Einstellungen. |
| Vertrag ↔ C0 | `itSynth` sitzt nach dem Master-Insert (C0 Zeile 232–233), ist aber nicht im Vertrag/signalTopology. |
| Vertrag ↔ Router | Master ist Insert; Router Zeile 72: `'ui-only'` |
| LUFS ↔ Regelkreis | `getLufsValue()` wird nur angezeigt, nie in Gain/Limiter zurückgekoppelt. |

## 7. Empfohlene Korrekturen

1. **Entscheidung: echter Mastering-Adapter oder keine Mastering-Latenz.** Entweder Limiter + Kompressor + EQ + True-Peak-Ceiling in `MasterPluginAdapter` implementieren (und 240 Frames + `tailSamples` rechtfertigen) ODER `intrinsicLatencyFrames` auf 0 setzen und den "Lookahead-Limiter" aus dem Vertrag streichen.
2. **Mastering in den Adapter holen.** Alle UI-Parameter (Input, HP, EQ, Comp, Limiter, Ceiling, Ziel-LUFS) müssen den Adapter erreichen, damit Live, UI und Bounce identisch klingen.
3. **Bounce konsistent.** `pluginChainBounce` soll den Mastering-Zustand (Presets, Engine-Parameter) vor dem Render anwenden oder den Master-Adapter vollständig implementieren.
4. **`itSynth` aus dem Master-Pfad entfernen oder vertraglich verankern.** Der Knoten nach dem Master-Insert unterläuft den "letzten Insert"-Anspruch.
5. **True-Peak-Ceiling implementieren.** Wenn Limiter behauptet wird, muss ein Hard-Ceiling am Master-Ausgang stehen (Clipping-Schutz).
6. **LUFS-Regelkreis oder Anzeige als solche kennzeichnen.** Entweder automatische Gain-Korrektur zum Ziel-LUFS oder explizit als reine Messung ohne Einfluss deklarieren.
7. **Router konsistent.** `master` als Audio-Insert im Router oder Vertrag ändern.
8. **Bypass-Verhalten dokumentieren.** Bei einem Limiter entfernt Bypass den Ceiling-Schutz — das muss kommuniziert werden (ggf. kein Bypass für den Limiter-Teil, nur für Gain).

**Fazit Idea Destroyer:** masterMONK ist derzeit ein Lautstärkeregler mit einem 240-Frames-Latenz-Versprechen, das nichts rechtfertigt. Die UI suggeriert eine vollständige Mastering-Kette (Limiter, Kompressor, EQ, LUFS, Ceiling), der Adapter liefert linearen Gain, und der Bounce rendert genau das: Gain ohne Limiter. Die Idee eines echten Mastering-Endstufens ist nicht implementiert.