# audioMONASTRY — Phase C Audit 1 (Idea Destroyer): dspMONK

**Plugin:** `dsp` / `dspMONK`, Rolle `insert` (Master-Insert, `insertScope: 'master'`, Position 2 von 3: eq → dsp → master)
**Stand:** Commit f5538c63
**Art:** adversarial — die Idee eines konsistenten, latenzgerechten DSP-Inserts wird angegriffen.

---

## 1. Grundkonzept (wie behauptet)

`pluginContract.ts` (Zeile 348–371): `dsp` ist Master-Insert, 1×1 Stereo, Latenz deklariert 0, aber die `latencyNote` räumt ein: Der tanh-Sättiger läuft oversampled (Default 2x, minimalphasige Halbband-FIR) und verzögert bei Drive > 0 um 3 Samples (4x: 4; linearphasig 23/28), "dynamisch in `V2MonitorGraph.mainLatencySamples` und der Cue-PDC ausgeglichen". Im Grundzustand (Drive 0) latenzfrei. Funktionen: resonanter Tiefpass, Vorverstärkung + Soft-Clip (tanh), optionale Mod-Matrix (FEAT-P3-002).

UI: `DSPTerminal` (lazy), `OptionalDspPanel.tsx` (FEAT-P3-002: mod-matrix, hq-reverb, phase-distortion, electric-piano als "optionaler DSP" direkt im V2-Pfad).

Adapter: `src/plugins/adapters/DspPluginAdapter.ts` — RBJ-Tiefpass, Pre-Gain `1 + drive*8`, tanh-Soft-Clip mit Oversampling (2x Default, 4x), `getLatencySamples()` dynamisch.

## 2. Architektur-Analyse (Ist-Zustand)

- Vertrag: `src/plugins/pluginContract.ts` — Master-Insert, Latenz 0 + dynamische Ausnahme.
- Adapter: `src/plugins/adapters/DspPluginAdapter.ts` (onProcess, getLatencySamples, onParameter, onCommand).
- UI: `src/components/dsp/OptionalDspPanel.tsx` (FEAT-P3-002, schreibt direkt in `audioEngine`), `src/components/DSPTerminal.tsx` (lazy).
- Oversampling: `src/core/dsp/oversampling.ts` (`Oversampler`, `TanhDriveShaper`, `normalizeOversamplingFactor`, `oversamplingLatencySamples`).
- Engine: `audioEngine.automateDsp`, `setDspOversampling`, `setOptionalModMatrix`, `setDspParam`.
- Router: `src/core/pluginAudioRouter.ts` Zeile 71 — `['dsp', 'ui-only', false]`.
- Signal chain: `processing` enthält `dsp` (konsistent mit Master-Insert).
- C0: `WORKLET_BINDING.dsp = 'dsp-processor'`, `insertNodes.dsp`.

## 3. Technische Fehlannahmen

1. **Fehlannahme: Die Latenz ist konstant 0.** Falsch. Der Vertrag schreibt `intrinsicLatencyFrames: 0`, räumt aber eine dynamische Latenz von 3–28 Samples ein, je nach Drive und Oversampling-Faktor. Eine Latenz, die vom Parameter abhängt, bricht die PDC-Invariante: Pfade müssen vor dem Summieren *konstant* verzögert sein. Wird Drive automatisiert, wandert die Latenz mit — Phasenverschiebungen gegenüber den anderen Pfaden sind die Folge.

2. **Fehlannahme: Das Manifest sagt die Wahrheit.** `DspPluginAdapter.MANIFEST.latencySamples = 0` (Zeile 23) obwohl `getLatencySamples()` bei Drive > 0 > 0 liefert. Jede Komponente, die auf den Manifest-Wert vertraut (PDC, Bounce, Delay-Kompensation), rechnet mit 0 und hört 3–28 Samples zu spät oder zu früh.

3. **Fehlannahme: Die Latenz wird korrekt ausgeglichen.** Die `latencyNote` verweist auf `V2MonitorGraph.mainLatencySamples` und "die Cue-PDC". Dieser Ausgleich ist im gelesenen Code nicht nachvollziehbar (keine zentrale Stelle, die `getLatencySamples()` des Adapters liest und in den Graph einspeist). Der Bounce (`pluginChainBounce`) kennt gar keine dynamische Latenz-Kompensation.

4. **Fehlannahme: "Sättigung" funktioniert wie beworben.** `preGain = 1 + drive*8`, dann `tanh(x * preGain) * norm` mit `norm = 1/tanh(preGain)`. Bei niedrigem Drive wird vorverstärkt, aber tanh greift erst nahe an ±1.0 — das Signal wird leiser (Normalisierung), ohne hörbare Sättigung. Die Idee "Drive treibt an und sättigt" gilt nur für extreme Drive-Werte.

5. **Fehlannahme: Oversampling heilt alle Aliasing-Probleme.** Oversampling wird nur auf den tanh-Shaper angewendet (`this.oversampler.process(c, channel[i], this.shaper)`), der nachfolgende RBJ-Tiefpass arbeitet weiterhin auf Basisrate. Sättigungsoberwellen oberhalb Nyquist, die vor dem Filter entstehen, werden nicht durch das Oversampling des Shapers eliminiert.

6. **Fehlannahme: FEAT-P3-002 gehört zu dspMONK.** `OptionalDspPanel` (mod-matrix, hq-reverb, phase-distortion, electric-piano) schreibt direkt in `audioEngine` (V2-Pfad), erscheint nirgends im Vertrag, in keinem Adapter-Manifest und nicht im Bounce (außer über den Engine-Zustand). Die Idee "dspMONK ist der einzige DSP-Slot" wird durch eine versteckte zweite DSP-Ebene unterlaufen.

7. **Fehlannahme: `onParameter` ist typsicher.** `case 'modIndex': audioEngine.automateDsp(parameter.name as 'drive', ...)` — `modIndex` wird als `drive` gecastet und automatisiert. Copy-Paste-Fehler ohne Laufzeitprüfung.

## 4. Designschwächen

- **Dynamische Latenz in einem statischen PDC-System.** Der Vertrag begründet statische Latenzwerte; dspMONK macht die Latenz parameterabhängig. Keine Stelle im Code trägt dies konsistent zusammen.
- **Manifest lügt über Latenz.** `latencySamples: 0` ist nur im Grundzustand (Drive 0) wahr.
- **Zwei DSP-Welten.** Adapter (Tiefpass + Sättiger) vs. OptionalDspPanel (Reverb, Mod-Matrix, Synth-Stimmen) im V2-Pfad — keine Abgrenzung, keine Zuständigkeit.
- **Async Engine-Imports im Parameterpfad.** Jeder `onParameter`-Aufruf triggert `void import('../../utils/audioEngine')` — Parameter werden nicht synchron verarbeitet.
- **Oversampler-State ist adapter-global, nicht block-lokal.** `oversamplingActive`, `oversampler` Zustand überlebt Blockgrenzen; bei Sample-Rate-Wechsel oder Kanalanzahl-Wechsel (`ensureChannels`) gibt es Reset-Logik, die race-anfällig sein kann.

## 5. Performance-/DSP-Risiken

- Oversampling 2x/4x vervielfacht die Rechenlast des Shapers (FIR-Up-/Downsampling pro Sample). Bei großen Blocks und 4x linearphasig (23–28 Samples Latenz) spürbar.
- `getLatencySamples()` wird vermutlich pro Block oder pro Automation-Event abgefragt; keine Caching-Strategie sichtbar.
- RBJ-Koeffizienten werden nur bei Änderung neu berechnet (`coeffKey`-Check) — gut, aber bei Automatisierung von Cutoff/Resonance jeder Frame neu → CPU-Last.
- `tanh` und `Math.exp`/`Math.pow` pro Sample im Shaper-Pfad — teurer als linear, aber akzeptabel.
- Bei `drive === 0 && cutoff < nyquist` läuft der Tiefpass; bei `drive > 0` wird zusätzlich gesättigt. Der Pfad ist nicht symmetrisch in der Komplexität → variierende CPU-Last je nach Einstellung (Dropout-Risiko bei engen Buffern).

## 6. Schnittstellen-Probleme

| Schnittstelle | Problem |
|---|---|
| Vertrag ↔ Manifest | Vertrag: dynamische Latenz 3–28 Samples. Manifest: `latencySamples: 0` |
| Vertrag ↔ PDC | Vertrag verweist auf `V2MonitorGraph.mainLatencySamples`; keine Einlese-Stelle für `getLatencySamples()` im Graph sichtbar |
| Adapter ↔ Bounce | `pluginChainBounce` kennt keine dynamische Latenz-Kompensation; Drive-Automatisierung im Bounce verschiebt das Signal |
| Adapter ↔ UI (OptionalDspPanel) | Panel schreibt in `audioEngine` (V2), nicht in den Adapter; zwei unabhängige DSP-Pfade |
| `onParameter` ↔ Engine | `modIndex` als `drive` gecastet (Typsicherheit verletzt); async Engine-Import |
| Vertrag ↔ Router | Vertrag: Audio-Insert. Router Zeile 71: `'ui-only'` |

## 7. Empfohlene Korrekturen

1. **Latenz ehrlich deklarieren.** Entweder `intrinsicLatencyFrames` auf den Worst-Case (28 Samples bei 4x linearphasig) setzen und statisch kompensieren, ODER Drive/Oversampling so ändern, dass die Latenz wirklich konstant 0 bleibt (keine dynamische Latenz in einem statischen PDC).
2. **Manifest anpassen.** `latencySamples` muss den tatsächlichen Worst-Case abbilden oder das Feld auf "dynamisch" mit expliziter `getLatencySamples()`-Abfrage im Graph umgestellt werden.
3. **PDC-Anbindung herstellen.** Eine zentrale Stelle muss `getLatencySamples()` des Adapters lesen und in die Delay-Kompensation einspeisen (statt auf nicht nachvollziehbare `V2MonitorGraph`-Referenz).
4. **FEAT-P3-002 klären.** Entweder die optionalen Blöcke (Reverb, Mod-Matrix, Synth-Stimmen) in den Vertrag und Adapter aufnehmen oder aus dem dspMONK-Kontext entfernen und als eigene Plugins führen. Keine versteckte zweite DSP-Ebene.
5. **Sättigungs-Verhalten überarbeiten.** `preGain`/`norm` so gestalten, dass Drive hörbar sättigt (nicht nur leiser macht), oder Dokumentation anpassen.
6. **Oversampling-Scope prüfen.** Oversampling sollte den gesamten nichtlinearen Pfad abdecken oder den Filter auf die oversamplerte Rate heben, sonst bleibt Aliasing.
7. **`onParameter` typsicher machen.** Keine `as 'drive'`-Casts; dedizierte Handler pro Parameter.
8. **Router konsistent.** `dsp` ist Audio-Insert — Router-Eintrag auf `'insert'`/`'send'` heben oder Vertrag ändern.

**Fazit Idea Destroyer:** dspMONK behauptet latenzfrei zu sein, liefert aber parameterabhängige Latenz (3–28 Samples), die nirgends konsistent kompensiert wird; das Manifest lügt mit `latencySamples: 0`; und eine versteckte zweite DSP-Ebene (FEAT-P3-002) unterläuft den "einzigen DSP-Slot". Die Idee eines berechenbaren Mastering-Inserts ist aktuell nicht haltbar.