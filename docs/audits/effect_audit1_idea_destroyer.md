# Audit effect — 1/2 Idea Destroyer (adversarial)

## Metadaten
- Plugin: effectMONK (id `effect`, Rolle `fxReturn`, kein Kanal, Stereo, 1 In / 1 Out)
- Vertrag: `src/plugins/pluginContract.ts` (`intrinsicLatencyFrames: 0`, `bypassable: true`, `sendsToFx: false` — „er IST der FX-Bus“, `syncCapable: false`, `viaChannel: false`, `producesAudio: false`, `insertScope: null`)
- Geprüfte Dateien: `src/components/FXEngineTerminal.tsx`, `src/plugins/registry.ts` (`effect -> FXEngineTerminal`), `src/utils/audioEngine` (referenziert via `audioEngine.setEffectParams`), `src/utils/pluginSettings`
- Stand: gemischter Master-Tag gm-v1.0.0 / f5538c63

## 1. Grundkonzept
effectMONK ist die parallele Effektebene (FX-Return): Eine Quelle (Sample oder MASTER BUS) läuft durch einen wählbaren Algorithmus (DELAY, REVERB, FLANGER, PHASER, DISTORTION, BITCRUSHER, CHORUS, FILTER), einen Dry/Wet-Mix und einen Bypass. Ein XY-Feld steuert Mix (X) und Intensität (Y), ein Canvas-Scope visualisiert das Signal, und der Stand wird pro Session in `pluginSettings('effect')` persistiert. Die Engine-Anbindung erfolgt über `audioEngine.setEffectParams({type, wet, power, ...fxParams})`.

## 2. Architektur-Analyse
Reines React-UI-Terminal ohne eigenen DSP-Code. `FXEngineTerminal` hält lokalen Zustand (power, activeFx, wetDry, intensity, sourceSample), ruft bei Änderungen `applyFx` → `audioEngine.setEffectParams` auf, rendert einen Canvas-Visualizer (rAF-Loop, Sinus-Placeholder, kein echtes Audio-Eingangssignal) und einen DropTarget für Samples. `usePluginState('effect', 'PRO')` liefert einen Lock. Keine eigene Audio-Worklet- oder Graph-Integration; der eigentliche Effekt-Algorithmus liegt in `audioEngine` (nicht Teil dieses Audits, nicht gelesen).

## 3. Technische Fehlannahmen
1. **„Bypass ist ein Dry/Wet-Crossfade, kein Disconnect“** (Vertrag) — Falsch. `power` schaltet nur UI-Zustand und überträgt `power: power` an `setEffectParams`. Ob `audioEngine` beim `power: false` einen durchgesteuerten Dry-Signalweg liefert oder den Effekt abschaltet (Disconnect), ist nicht im Plugin ersichtlich. Der Vertragsversprechen kann effect nicht einlösen.
2. **„intrinsicLatencyFrames: 0“** — Effekte wie REVERB und DELAY benötigen inhärent Puffer (Hall-Schwanz, Delay-Linie). Kein Effekt im System ist latenzfrei; der Wert 0 ist nicht begründet (`latencyNote` fehlt völlig, im Gegensatz zu eq/dsp/master im Vertrag).
3. **„producesAudio: false“** — Korrekt für einen Insert/Return, aber der Vertrag sagt `inputs: 1, outputs: 1` (FX-Bus). Die UI zeigt aber als Quelle entweder „MASTER BUS“ oder ein einzelnes `sourceSample` — kein echter FX-Send/Return-Weg vom Mixer ist im Plugin konfigurierbar; `sendsToFx: false` widerspricht der UI-Idee „Sample hierher ziehen → Effekt → Main“ (das ist ein Insert, kein Return).
4. **„sendsToFx: false“** — effect ist selbst der FX-Bus, darf aber nicht in den FX-Bus senden (Feedback-Schleife verhindert). Das ist konsistent, aber die UI bietet keinen Send-Level an; der Mix erfolgt nur über `wetDry` lokal.
5. **„Algorithmus-Parameter skalieren linear mit Intensität“** — `fxParams` multipliziert Preset-Werte mit `f = intensity/50`, clamped hart. Bei Intensität 100 wird z. B. `feedback 0.62 * 2 = 1.24 → 0.95` (clamped). Kein Unterschied zwischen „starkem Effekt“ und „instabilem Feedback“; ein Nutzer kann den Effekt in Selbstoszillation treiben, ohne Schutz.

## 4. Designschwächen
- **Keine echte Audio-Eingabe**: Der Canvas-Scope zeichnet eine hardcodierte Sinuskurve (`Math.sin(i * frequency + phase)`), nicht das tatsächliche Signal. Der „Scope“ ist eine Attrappe; der Nutzer sieht kein echtes FX-Eingangs-/Ausgangsspektrum.
- **`sourceSample` spielt keine Rolle im DSP**: `handleSampleDrop` setzt nur `setSourceSample(sample)` und zeigt den Namen an. `applyFx` sendet niemals die Sample-Daten an `audioEngine`. Der DropTarget ist tot — der Effekt verarbeitet nur den „MASTER BUS“ oder gar nichts.
- **XY-Feld überschreibt `wetDry` und `intensity` gleichzeitig**: X steuert Mix, Y steuert Intensität. Beide werden über dieselben Knobs („Makro“) bedient; es gibt keine Independent-Parameter (z. B. Delay-Zeit separat von Feedback). Der Effekt ist ein Schwarzkasten mit 2 Reglern.
- **Lock ist nur optisch**: Wie bei song — `locked` graulegt UI, `handleFxChange`, `setPower`, XY-Feld prüfen `disabled` teilweise, aber `applyFx` wird im `useEffect` bei jeder Änderung von `activeFx, wetDry, power, intensity` ungehindert aufgerufen (auch wenn locked? — `disabled` verhindert UI-Bedienung, aber der Effekt läuft weiter).
- **Keine Preset-Verwaltung**: 8 harte Algorithmen mit festen `FX_PRESETS`; kein Laden/Speichern von Effekt-Presets über die Session hinaus (nur der letzte Stand in pluginSettings).

## 5. Performance-/DSP-Risiken
- **Canvas rAF-Loop läuft ständig, wenn `power` true**: `useEffect` startet `requestAnimationFrame(draw)` und stoppt nur beim Unmount oder wenn `canvas` fehlt — nicht wenn `power` false (die Bedingung `if (power)` zeichnet nur nichts, der Loop läuft weiter). Jede Instanz von effectMONK brennt einen rAF-Timer, auch wenn bypassed.
- **Kein Audio-Thread**: Der Effekt läuft vollständig außerhalb der Audio-Graph (angenommen, `audioEngine.setEffectParams` aktualisiert Parameter, aber das Plugin steuert keine AudioNode-Graphik). Bei Tab-Hintergrund friert der Canvas ein, der Effekt selbst hängt von `audioEngine` ab (unklar, ob das weiterarbeitet).
- **Feedback ohne Schutz**: `feedback` bis 0.95 bei DELAY/REVERB kann bei geschlossenem Loop (Sample als Quelle, Ausgang zurück in Quelle) zu Selbstoszillation führen; kein Limiter, kein DC-Block, kein Peak-Schutz im Plugin.

## 6. Schnittstellen-Probleme
- `audioEngine.setEffectParams` ist eine nicht näher definierte globale Funktion (`src/utils/audioEngine` nicht gelesen). Parameter-Namen (`type`, `wet`, `power`, `feedback`, `rate`, …) sind Vertrag zwischen Plugin und Engine, aber nirgends typisiert. Jede Änderung in `audioEngine` bricht effect still.
- `FX_LIST` IDs (`DELAY`, `REVERB`, …) und `audioEngine`-Erwartungen sind nicht abgeglichen; ein Tippfehler in einer ID führt zu stillschweigendem Default-Verhalten (`FX_PRESETS[fx] ?? {}` → leere Params).
- `pluginContract.ts` listet effect als `fxReturn` mit 1 In / 1 Out, aber die UI hat keinen Send-Eingang vom Mixer und keinen Return-Ausgang in die Summe; die „Signalkette“ (Quelle → Algorithmus → Mix → Ausgang) ist eine UI-Fiktion ohne Graph-Bindung.
- `DropTarget onDrop={handleSampleDrop}` akzeptiert jedes `AudioSample`, prüft nicht `isTrustedMediaUrl` (im Gegensatz zu drumsampler), und spielt es nie ab — der Drop ist rein dekorativ.

## 7. Empfohlene Korrekturen
1. Vertrag klären: effect entweder als echter FX-Return mit Send/Return aus dem Mixer ausführen (dann `sendsToFx` und Signalweg im Graph bindend) oder als Insert mit `insertScope` neu klassifizieren; Bypass als echter Dry/Wet-Crossfade implementieren (Vertrag einlösen oder `bypassable: false`).
2. `intrinsicLatencyFrames` mit `latencyNote` versehen (Hall/Delay brauchen Puffer) oder auf den tatsächlichen Algorithmus messen.
3. Canvas-Loop an `power` koppeln (start/stop rAF) und echte Audio-Daten (AnalyserNode) anzeigen statt Sinus-Attrappe.
4. `sourceSample` an `audioEngine` durchreichen oder DropTarget entfernen; derzeit irreführend.
5. Feedback-Limiter und Peak-Schutz nachrüsten; Intensität nicht blind auf alle Parameter multiplizieren, sondern pro Algorithmus sichere Parameterbereiche definieren.
6. `audioEngine.setEffectParams`-Schnittstelle typisieren und dokumentieren; IDs und Parameter abgleichen.
7. Lock konsequent erzwingen (alle `applyFx`-Aufrufe unter `if (locked) return;`).
