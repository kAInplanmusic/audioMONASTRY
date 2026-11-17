# audioMONASTRY — Phase C Audit 2 (Struktur): eqMONK

**Plugin:** `eq` / `eqMONK`
**Stand:** Commit f5538c63
**Art:** Struktur-Audit — Architektur, Schnittstellen, Abhängigkeiten, Konsistenz.

---

## 1. Grundkonzept

Parametrischer Equalizer als letzter Master-Insert vor dem Limiter (dsp, master), latenzfrei (IIR-Biquads), 1×1 Stereo, bypassable.

## 2. Architektur-Analyse

**Schicht 1 — Vertrag (`src/plugins/pluginContract.ts`):**
- `id: 'eq'`, `role: 'insert'`, `insertScope: 'master'`, `masterInserts[0]`
- `intrinsicLatencyFrames: 0` ("IIR-Biquads sind latenzfrei"), `bypassable: true`
- `signalTopology().masterInserts = ['eq','dsp','master']`

**Schicht 2 — UI (`src/components/EQPluginTerminal.tsx`):**
- 36 Band (logarithmisch 20 Hz–20 kHz), RBJ-Biquad (lowshelf/peaking/highshelf), ±12 dB Fader, Q 0.1–6, Presets (12), A/B, Canvas-Kurve + Analyzer (~30 fps rAF)
- Persistenz: `readPluginSettings/writePluginSettings('eq')` (gains, qs, power, ab)
- Push an Engine: `audioEngine.updateToneShiftEQ({bands: [...]})` bei jeder Änderung

**Schicht 3 — Adapter (`src/plugins/adapters/EqPluginAdapter.ts`):**
- Manifest: `kind: 'audio-processor'`, `latencySamples: 0`, `tailSamples: 0`
- 3-Band Ein-Pol Crossover (LOW_SPLIT 250 Hz, HIGH_SPLIT 2500 Hz), Zustand `lowState`/`midState` je Kanal, in-place, frühzeitiger Return bei Neutral
- `onParameter`: hardcodiert `audioEngine.setChannelEQ('channel1','mid',value)` für alles, was kein `bandN` ist; `bandN` → `audioEngine.automateEqBandGain`
- `onCommand automate`: `automateEqBandGain(band, gain, ramp)`

**Schicht 4 — Engine/Nodes (`src/core/audio/nodes/processingNodes.ts`):**
- `ParametricEqNode` (3 Band: low 220 Hz lowshelf, mid 1000 Hz peaking, high 4000 Hz highshelf), Koeffizienten nur bei Änderung neu, Biquad-State je Band/Kanal

**Schicht 5 — Router (`src/core/pluginAudioRouter.ts`):**
- Zeile 70: `['eq', 'ui-only', false]` → `isolation: 'ui-only'`, `mainFeeder: false`, `chainStage` aus `signalStageOf` (processing)

**Schicht 6 — Signal chain & C0:**
- `src/plugins/signalChain.ts`: `processing` enthält `eq` (konsistent mit Master-Insert)
- `src/core/audio/C0StudioChain.ts`: `WORKLET_BINDING.eq = 'eq-processor'`, `insertNodes.eq = WorkletChainNode('chain:eq','eq')`

## 3. Technische Fehlannahmen (Strukturell)

1. **Annahme: UI und Adapter bilden denselben EQ ab.** UI = 36 Band RBJ; Adapter = 3 Band Ein-Pol. Keine Abbildung, kein Mapping, keine Versionsbindung.
2. **Annahme: `onParameter` ist generisch.** Es ist hardcodiert auf Kanal 1, Band Mid — kein generischer Pfad von UI zu DSP.
3. **Annahme: Der Vertrag beschreibt die DSP-Realität ausreichend.** Der Vertrag sagt nur "Insert, latenzfrei", nicht welche Band-Anzahl, welcher Algorithmus, welcher Frequenzgang. Er schützt nicht vor dem UI/Adapter-Widerspruch.
4. **Annahme: `'ui-only'` im Router ist harmlos für einen Insert.** Der Router schließt eq aus dem Audio-Graph aus (`isolation: 'ui-only'`), während Vertrag und C0 es als Audio-Node einbauen.

## 4. Designschwächen

- **Zwei EQ-Implementierungen ohne canonical Quelle.** UI und Adapter leben nebeneinander her.
- **Hardcodierte Parameter-Routierung in `onParameter`.** Keine generische Band/Kanal-Auflösung.
- **Q-Wert existiert nur in der UI.** Der Adapter hat kein Q.
- **Asynchrone Engine-Calls aus dem Parameterpfad.** `void import('../../utils/audioEngine')` in `onParameter` und `onCommand` — Audio-Parameter werden über asynchrone Dynamic-Imports an die Engine geschickt, keine deterministische Reihenfolge.
- **Doppelter Persistenzpfad.** UI speichert in LocalStorage (`writePluginSettings('eq')`), Engine-Zustand über `updateToneShiftEQ` — kein Abgleich, welcher Stand nach einem Holder-Wechsel gewinnt.

## 5. Performance-/DSP-Risiken

- Adapter-Algorithmus ist realtime-sicher (in-place, keine Allokation, Zustand = 2 Floats/Kanal).
- UI-Kurve-Berechnung (`bandCoeffs` × 36 Bänder × ~300 Punkte) pro `useMemo`-Neuberechnung — UI-Thread-Last, kein Audio-Risiko.
- Bounce-Risk: `pluginChainBounce` rendert den Adapter (3 Band), nicht die UI-Kurve (36 Band) → hörbar abweichendes Offline-Ergebnis.
- Analyzer-Tap (`audioEngine.createVisualAnalyser`) im UI-Effect ohne sauberen Teardown bei jedem Render — potenzielle Ressourcen-Häufung bei schnellem Ein-/Ausblenden.

## 6. Schnittstellen-Probleme

| Schnittstelle | Zustand | Problem |
|---|---|---|
| UI ↔ Adapter | UI → Engine; Adapter autark | Keine Verbindung, zwei EQs |
| Adapter ↔ Vertrag | Vertrag: latenzfreier Insert | Vertrag erfasst nicht Band-Anzahl/Algorithmus → Widerspruch nicht sichtbar |
| `onParameter` ↔ Engine | Hardcodiert `'channel1'`, `'mid'`; async Import | Falscher Kanal/Band, nicht deterministisch |
| Vertrag ↔ Router | Insert vs. `'ui-only'` (Zeile 70) | Router schließt eq aus dem Graph aus |
| Engine ↔ Bounce | `updateToneShiftEQ` (Engine) vs. Adapter-Bounce | Bounce wendet Engine-EQ nicht an |
| `plugin_interface.ts` ↔ Adapter | `PluginAudioBlock` in-place | Adapter hält Zustande (`lowState`, `midState`) — snapshot/restore muss diese erfassen (tut es nicht explizit, aber `BasePluginAdapter.snapshot` erfasst nur `parameters`, nicht Filter-Zustand) |

## 7. Empfohlene Korrekturen

1. **Canonical EQ festlegen.** 36-Band RBJ aus der UI in den Adapter überführen (ein EQ für Live und Bounce) ODER UI auf 3-Band reduzieren. Entscheidend: eine Implementierung.
2. **`onParameter` generisch machen.** Band-Index und Kanal aus dem Parameter entnehmen, nicht hardcodiert; `automateEqBandGain(band, kanal, wert, rampe)`.
3. **Q in den Adapter bringen** (RBJ-Peaking statt Ein-Pol) oder UI-Q entfernen.
4. **Router korrigieren.** `eq` auf `'insert'`/`'send'` heben (Vertrag konsistent) oder Vertrag auf Nicht-Audio ändern.
5. **Bounce konsistent.** `pluginChainBounce` soll EQ-Snapshot (36 Band Gains/Q) vor dem Render in den Adapter einspielen.
6. **Snapshot/Restore erweitern.** Filter-Zustände (`lowState`, `midState`) und die 36 Band-Werte in `snapshot()`/`restore()` erfassen, damit Holder-Wechsel deterministisch sind.
7. **Async-Imports entfernen.** Parameterpfad synchron über Context; Engine-Calls außerhalb von `setParameter`.

**Fazit Struktur:** eqMONK ist strukturell gespalten (UI 36 Band vs. Adapter 3 Band), `onParameter` ist hardcodiert, und der Vertrag ist zu schwach, um den Widerspruch zu verhindern. Vor jedem weiteren Feature (z. B. weitere Bands) muss eine einzelne canonical EQ-Implementierung verbindlich werden.