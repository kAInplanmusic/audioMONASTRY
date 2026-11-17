# audioMONASTRY — Phase C Audit 1 (Idea Destroyer): eqMONK

**Plugin:** `eq` / `eqMONK`, Rolle `insert` (Master-Insert, `insertScope: 'master'`)
**Stand:** Commit f5538c63
**Art:** adversarial — die Idee eines einzelnen, konsistenten EQ wird systematisch zerstört.

---

## 1. Grundkonzept (wie behauptet)

`pluginContract.ts` (Zeile 330–346): `eq` ist Insert in der Master-Kette (`masterInserts: ['eq','dsp','master']`), 1×1 Stereo, Latenz 0 (IIR-Biquads, latenzfrei), bypassable. Die UI (`EQPluginTerminal.tsx`) wirbt mit einem "36-Band-Para-EQ" (RBJ-Biquad-Magnitudkurve, 20 Hz–20 kHz, ±18 dB, Q, A/B, Presets). Der Adapter (`EqPluginAdapter.ts`) beansprucht "3-Band-Tonregelung low/mid/high".

## 2. Architektur-Analyse (Ist-Zustand)

- Vertrag: `src/plugins/pluginContract.ts` — Master-Insert, latenzfrei.
- UI: `src/components/EQPluginTerminal.tsx` — 36 Band-RBJ-EQ, Canvas-Kurve, Analyzer-Tap, Presets, `writePluginSettings('eq')`.
- Adapter: `src/plugins/adapters/EqPluginAdapter.ts` — 3-Band Ein-Pol Crossover (LOW_SPLIT 250 Hz, HIGH_SPLIT 2500 Hz), Zustand `lowState`/`midState` je Kanal, in-place.
- Engine: `src/core/audio/nodes/processingNodes.ts` `ParametricEqNode` (3 Band low/mid/high), `audioEngine.updateToneShiftEQ`/`setChannelEQ`.
- Router: `src/core/pluginAudioRouter.ts` Zeile 70 — `['eq', 'ui-only', false]`.
- Signal chain: `src/plugins/signalChain.ts` — `processing` enthält `eq` (Master-Insert, konsistent mit Vertrag).
- C0: `WORKLET_BINDING.eq = 'eq-processor'`, `insertNodes.eq`.

## 3. Technische Fehlannahmen

1. **Fehlannahme: Es gibt einen EQ.** Falsch. Es gibt zwei unabhängige EQs, die nichts miteinander zu tun haben:
   - UI: 36-Band RBJ-Para-EQ (`rbjCoeffs`, `bandCoeffs`, `responseDb` in `EQPluginTerminal.tsx`), drückt via `pushEq` → `audioEngine.updateToneShiftEQ` in die Engine.
   - Adapter: 3-Band Ein-Pol Low/Mid/High (`EqPluginAdapter.ts`), arbeitet auf `PluginAudioBlock` im Bounce/Offline-Pfad.
   Der Nutzer stellt in der UI eine 36-Band-Kurve ein; der Bounce (`pluginChainBounce`) rendert den 3-Band-Adapter. Das gebouncte File klingt nicht wie das Monitoring. Die Idee "ein EQ" ist gebrochen.

2. **Fehlannahme: Die UI steuert den Adapter.** `EQPluginTerminal` ruft ausschließlich `audioEngine.updateToneShiftEQ` (Engine) auf. Der Adapter `EqPluginAdapter` bekommt nie die 36 Band-Gains; er arbeitet mit seinen eigenen 3 hartkodierten Bändern (250/1000/4000 Hz implizit über die Ein-Pol-Filter). UI und Adapter sind nicht verbunden.

3. **Fehlannahme: `onParameter` schreibt den richtigen Band/Kanal.** `EqPluginAdapter.ts` Zeile 87: `audioEngine.setChannelEQ('channel1', 'mid', value)` — **jeder** nicht-Band-Parameter landet hardcodiert auf Kanal 1, Band Mid. Automatisierung von Band 7 schreibt in Band 2 von Kanal 1. Die Idee der Band-spezifischen Automation ist funktionslos.

4. **Fehlannahme: Q ist einstellbar.** UI lässt Q 0.1–6 pro Band zu (`AmKnob` Q). Der Adapter hat gar kein Q (festes Ein-Pol, Übergangsfrequenzen fix bei 250/2500 Hz).

5. **Fehlannahme: Bypass ist konsistent.** UI `togglePower` sendet eine flache Kurve (alle Gains 0) an die Engine und merkt sich Zustand. Der Adapter nutzt `BaseAdapter.state === 'OFF'` (transparenter Durchlass). Es gibt keine Absprache, ob Bypass = flache Kurve (Engine) oder Durchlass (Adapter) ist; beide können divergieren.

6. **Fehlannahme: Der Vertrag beschreibt den Adapter.** Vertrag sagt Latenz 0, 1in/1out, Insert. Passt zu beiden EQ-Implementierungen, sagt aber nichts darüber, *welcher* EQ massgebend ist — der Vertrag ist zu schwach, um den Widerspruch sichtbar zu machen.

## 4. Designschwächen

- **Zwei EQs, keine Wahrheit.** Keine canonical EQ-Implementierung; UI und Adapter entwickeln sich unabhängig.
- **Hardcodierter Kanal und Band in `onParameter`.** `'channel1'`, `'mid'` unabhängig vom tatsächlich ausgewählten Band.
- **UI-Q wird nirgends fortgeschrieben.** Q-Werte aus der UI (`qValues`) werden in `pushEq` an die Engine gesendet, aber der Adapter ignoriert Q komplett.
- **Asynchrone Engine-Calls im Parameterpfad.** `onParameter` macht `void import('../../utils/audioEngine')` — Parameter-Änderungen lösen async Imports aus; keine Garantie, wann (oder ob) die Engine den Wert übernimmt.
- **36-Band-Kurve auf dem Hauptthread.** `bandCoeffs` + `responseDb` pro Frame in `useMemo`; der Canvas-Analyzer rufen `audioEngine.createVisualAnalyser` (Side-Effekt im UI).

## 5. Performance-/DSP-Risiken

- Der Adapter-Algorithmus (Ein-Pol, in-place, kein Allokation) ist realtime-sicher — das ist das Einzige, was stimmt.
- Die UI-Kurve-Berechnung (`bandCoeffs` über 36 Bänder × ~300 Frequenzpunkte) bei jeder Gain-Änderung belastet den UI-Thread; bei schnellen Fader-Bewegungen können Frames fallen (kein Audio-Risiko, nur UI).
- Bounce-Rendering nutzt den Adapter (3 Band), nicht die UI-Kurve (36 Band) → das Offline-Ergebnis weicht hörbar vom Live-Monitoring ab (Qualitätsrisiko bei Bounce/Export).
- Bei `power = false` sendet die UI flache Gains an die Engine; der Adapter bleibt ggf. in erstem Zustand (je nach `state`) — Asynchronität zwischen UI-Bypass und Adapter-State.

## 6. Schnittstellen-Probleme

| Schnittstelle | Problem |
|---|---|
| UI ↔ Adapter | Keine Verbindung: UI → Engine (`updateToneShiftEQ`), Adapter arbeitet autark (3 Band) |
| Adapter ↔ Vertrag | Vertrag lässt den Widerspruch UI-vs-Adapter nicht erkennen (keine Band-Anzahl, kein Algorithmus) |
| `onParameter` ↔ Engine | Hardcodiert `'channel1'`, `'mid'`; async Engine-Import |
| Vertrag ↔ Router | Vertrag: Insert Audio-Prozessor. Router Zeile 70: `'ui-only'` |
| Engine ↔ Bounce | Engine-EQ (`updateToneShiftEQ`) wird im Bounce (Adapter-basiert) nicht angewendet |

## 7. Empfohlene Korrekturen

1. **Einen canonical EQ festlegen.** Entweder die 36-Band-RBJ-Implementierung aus der UI in den Adapter überführen (und `EqPluginAdapter` ersetzen) ODER die UI auf den 3-Band-Adapter zurückbauen. Aktuell existiert kein einziger EQ, dem man vertrauen kann.
2. **`onParameter` reparieren.** Band- und Kanal-Information aus dem Parameter nehmen statt hartkodierter Werte; `automateEqBandGain` mit korrekter Band-Nummer und Kanal.
3. **Q-Wert durchreichen.** Adapter muss Q unterstützen (z. B. RBJ-Peaking statt Ein-Pol) oder die UI-Q-Regler entfernen.
4. **Router und Vertrag angleichen.** `eq` ist laut Vertrag ein Audio-Insert — Router-Eintrag auf `'insert'`/`'send'` heben oder Vertrag ändern.
5. **Bypass-Semantik vereinheitlichen.** Eine Regel: Bypass = transparenter Durchlass (Adapter `state === 'OFF'`) ODER flache Kurve (Engine), beides konsistent.
6. **Bounce auf UI-Zustand abstützen.** `pluginChainBounce` soll die aktuellen EQ-Gains (aus `readPluginSettings('eq')` oder Snapshots) in den Adapter einspielen, damit Offline = Online klingt.
7. **Async-Imports im Parameterpfad entfernen.** `setParameter` soll synchron über den Context laufen, nicht über `void import()`.

**Fazit Idea Destroyer:** eqMONK ist derzeit kein einzelnes Produkt, sondern zwei unabhängige EQ-Implementierungen, die zufällig denselben Namen tragen. UI und Adapter widersprechen sich, `onParameter` schreibt an den falschen Kanal/Band, und der Bounce rendert etwas anderes als das Monitoring. Die Idee eines konsistenten Master-EQ ist aktuell nicht realisiert.