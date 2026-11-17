# audioMONASTRY — Phase C Audit 2 (Struktur): dspMONK

**Plugin:** `dsp` / `dspMONK`
**Stand:** Commit f5538c63
**Art:** Struktur-Audit — Architektur, Schnittstellen, Abhängigkeiten, Konsistenz.

---

## 1. Grundkonzept

Mastering-DSP-Insert (Position 2 in der Master-Kette eq → dsp → master): resonanter Tiefpass, Vorverstärkung, tanh-Soft-Clip mit Oversampling, optionale Mod-Matrix (FEAT-P3-002).

## 2. Architektur-Analyse

**Schicht 1 — Vertrag (`src/plugins/pluginContract.ts`):**
- `id: 'dsp'`, `role: 'insert'`, `insertScope: 'master'`, `masterInserts[1]`
- `intrinsicLatencyFrames: 0` + `latencyNote` (dynamisch 3/4/23/28 Samples bei Drive > 0, je nach Oversampling)
- `bypassable: true`, `producesAudio: false`

**Schicht 2 — Adapter (`src/plugins/adapters/DspPluginAdapter.ts`):**
- Manifest: `kind: 'audio-processor'`, `latencySamples: 0`, `tailSamples: 0`
- `onProcess`: RBJ-Tiefpass (Transposed Direct Form II, Zustand `z1`/`z2` je Kanal), Pre-Gain, tanh-Shaper mit `Oversampler` (2x Default, 4x), `getLatencySamples()` dynamisch
- `onParameter`: `drive`/`cutoff`/`resonance`/`modIndex`/`gain` → `audioEngine.automateDsp`; `oversampling` → `setDspOversampling`; `modEnabled`/`modRate`/`modDepth` → `setOptionalModMatrix`
- `onCommand automate` / `optional-dsp`

**Schicht 3 — Oversampling (`src/core/dsp/oversampling.ts`):**
- `Oversampler`, `TanhDriveShaper`, `normalizeOversamplingFactor`, `oversamplingLatencySamples`, `DEFAULT_SATURATOR_OVERSAMPLING`

**Schicht 4 — UI (`src/components/`):**
- `DSPTerminal.tsx` (lazy), `OptionalDspPanel.tsx` (FEAT-P3-002: mod-matrix, hq-reverb, phase-distortion, electric-piano; schreibt direkt in `audioEngine`)

**Schicht 5 — Engine:**
- `src/utils/audioEngine.ts`: `automateDsp`, `setDspOversampling`, `setOptionalModMatrix`, `setDspParam`

**Schicht 6 — Router (`src/core/pluginAudioRouter.ts`):**
- Zeile 71: `['dsp', 'ui-only', false]` → `isolation: 'ui-only'`

**Schicht 7 — Signal chain & C0:**
- `src/plugins/signalChain.ts`: `processing` enthält `dsp`
- `src/core/audio/C0StudioChain.ts`: `WORKLET_BINDING.dsp = 'dsp-processor'`, `insertNodes.dsp`

## 3. Technische Fehlannahmen (Strukturell)

1. **Annahme: Latenz ist ein statischer Vertragswert.** Der Vertrag plant mit statischen `intrinsicLatencyFrames`; dspMONK macht Latenz parameterabhängig (Drive, Oversampling, Phase). Keine Struktur trägt diesen Sonderfall.
2. **Annahme: Manifest-Werte sind verlässlich.** `latencySamples: 0` widerspricht `getLatencySamples()`. Jede auf dem Manifest basierende Logik (PDC, Bounce, UI-Latenz-Anzeige) ist falsch, sobald Drive > 0.
3. **Annahme: Ein Adapter implementiert den gesamten dspMONK-Umfang.** `OptionalDspPanel` (FEAT-P3-002) betreibt DSP im V2-Engine-Pfad außerhalb des Adapters — keine Abbildung im Vertrag, kein Adapter, kein Bounce-Einbezug.
4. **Annahme: `onParameter` erreicht die Engine synchron.** `void import('../../utils/audioEngine')` ist asynchron; Parameteränderungen haben keine garantierte Ankunftszeit.

## 4. Designschwächen

- **Dynamische Latenz bricht das statische PDC-Modell.** Der Vertrag (`pathLatencyFrames`, `mergeLatencyFrames`, `compensationFrames`) geht von additiven, statischen Latenzen aus. dspMONK ist der einzige Plugin mit parameterabhängiger Latenz — Sonderfall ohne Einlese-Stelle.
- **Zwei DSP-Pfade.** Adapter (Block-basiert, tanh + Tiefpass) vs. OptionalDspPanel (Engine-basiert, Reverb/Mod/Synth). Keine Zuständigkeitsabgrenzung, keine Versionsbindung.
- **Oversampler-State außerhalb des Block-Kontexts.** `oversamplingActive`, `oversampler` als Instanz-Felder; `reset()` beim Einschalten, `ensureChannels` bei Kanal-Wechsel — zustandsbehaftet über Blockgrenzen hinweg, riskant bei Puffer-Wechseln.
- **`getLatencySamples()` liest Parameter neu statt Zustand.** Es liest `this.parameters` erneut (`numberFromParameters`) statt den internen Zustand zu nutzen — inkonsistent mit `onProcess`, das `this.parameters` ebenfalls liest, aber separat.
- **`onCommand 'optional-dsp'`** (FEAT-P3-002) ist ein Magie-String ohne Vertragsverankerung.

## 5. Performance-/DSP-Risiken

- Oversampling 2x/4x multipliziert Shaper-Kosten (FIR Up/Down + tanh pro Sample). Bei 4x linearphasig zusätzlich 23–28 Samples Latenz.
- `tanh` pro Sample ist teurer als lineare Verarbeitung; bei voller Kette (eq → dsp → master) additiv.
- RBJ-Koeffizienten-Neuberechnung bei jeder Cutoff/Resonance-Änderung — bei Automation CPU-Spikes pro Frame.
- `getLatencySamples()` ohne Caching: bei häufiger Abfrage (PDC pro Block) wiederholte `normalizeOversamplingFactor`-Aufrufe.
- Variierende CPU-Last je nach Drive-Einstellung (Sättigungspfad aktiv/inaktiv) → Dropout-Risiko bei kleinen Buffern.

## 6. Schnittstellen-Probleme

| Schnittstelle | Zustand | Problem |
|---|---|---|
| Vertrag ↔ Manifest | `intrinsicLatencyFrames: 0` vs. `latencySamples: 0` | Beide ignorieren die dynamische 3–28 Samples Latenz |
| Vertrag ↔ PDC | `pathLatencyFrames` addiert statische Werte | Keine Einlese-Stelle für `getLatencySamples()`; dynamische Latenz nicht integrierbar |
| Adapter ↔ Bounce | `pluginChainBounce` nutzt Adapter | Keine Latenz-Kompensation für dynamische DSP-Latenz im Offline-Render |
| Adapter ↔ UI (OptionalDspPanel) | Panel → `audioEngine` direkt | Zwei unabhängige DSP-Pfade, kein gemeinsamer Vertrag |
| `onParameter` ↔ Engine | Async `void import(...)` | Nicht deterministisch, kein synchroner Parameterpfad |
| Vertrag ↔ Router | Insert vs. `'ui-only'` (Zeile 71) | Router schließt dsp aus dem Graph aus |

## 7. Empfohlene Korrekturen

1. **Latenz-Modell entscheiden.** Entweder statisch (Worst-Case 28 Samples in `intrinsicLatencyFrames` und Manifest) oder explizit dynamisch mit einer Graph-Stelle, die `getLatencySamples()` abfragt und kompensiert. Aktuell ist beides halbherzig.
2. **Manifest korrigieren.** `latencySamples` auf echten Worst-Case oder auf `null`/`dynamic` mit entsprechender Graph-Unterstützung.
3. **FEAT-P3-002 integrieren oder entfernen.** Optionale Blöcke entweder in Vertrag + Adapter aufnehmen (und damit in den Bounce) oder als eigene Plugins führen. Kein DSP außerhalb des Adapter-Vertrags.
4. **Oversampling-Pfad vollständig machen.** Shaper und Filter sollten denselben oversamplerten Pfad teilen, sonst bleibt Aliasing ungelöst.
5. **Parameterpfad synchronisieren.** `setParameter` soll über den Context synchron erfolgen; Engine-Delegation außerhalb des Realtime-Pfads.
6. **Router konsistent.** `dsp` als Audio-Insert im Router (`'insert'`/`'send'`) oder Vertrag ändern.
7. **`onCommand`-Strings vertraglich verankern.** `'optional-dsp'` gehört in eine Schnittstellendefinition, nicht als Magie-String.

**Fazit Struktur:** dspMONK ist der einzige Plugin mit parameterabhängiger Latenz in einem statischen PDC-System, dessen Manifest diese Latenz leugnet, und der durch FEAT-P3-002 eine zweite, vertragslose DSP-Ebene duldet. Struktur ist nicht konsistent; der Vertrag muss entweder die dynamische Latenz formalisieren oder sie verbieten.