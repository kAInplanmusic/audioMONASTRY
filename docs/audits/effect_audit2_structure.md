# Audit effect — 2/2 Struktur-Audit (Architektur, Schnittstellen, Abhängigkeiten)

## Metadaten
- Plugin: effectMONK (id `effect`, Rolle `fxReturn`, kein Kanal, Stereo, 1 In / 1 Out)
- Vertrag: `src/plugins/pluginContract.ts` (`sendsToFx: false` — „er IST der FX-Bus“, `insertScope: null`, `producesAudio: false`); Registry: `src/plugins/registry.ts` (`effect -> FXEngineTerminal`); Signalkette: `src/plugins/signalChain.ts` (Stufe `processing`, zusammen mit eq/dsp/master/spatial)
- Geprüfte Dateien: `src/components/FXEngineTerminal.tsx`, `src/utils/audioEngine` (referenziert via `audioEngine.setEffectParams`, nicht gelesen), `src/utils/pluginSettings`
- Stand: gemischter Master-Tag gm-v1.0.0 / f5538c63

## 1. Grundkonzept
effectMONK ist die parallele Effektebene (FX-Return): Eine Quelle (Sample oder MASTER BUS) läuft durch einen wählbaren Algorithmus (DELAY, REVERB, FLANGER, PHASER, DISTORTION, BITCRUSHER, CHORUS, FILTER), einen Dry/Wet-Mix und einen Bypass. Ein XY-Feld steuert Mix (X) und Intensität (Y), ein Canvas-Scope visualisiert das Signal, und der Stand wird pro Session in `pluginSettings('effect')` persistiert. Die Engine-Anbindung erfolgt über `audioEngine.setEffectParams({type, wet, power, ...fxParams})`.

## 2. Architektur-Analyse
**Komponenten-Hierarchie**: `FXEngineTerminal` (`React.memo`) ist eine flache Komponente ohne Kind-Komponenten außer UI-Basisteilen (`AmCard`, `AmKnob`, `AmToggle`, `DropTarget`). Alles (State, DSP-Aufruf, Visualizer, Rendering) lebt in einer einzigen Datei (255 Zeilen).

**State-Management**: Lokaler React-State (`power`, `activeFx`, `wetDry`, `intensity`, `sourceSample`, `xyDrag`). Persistenz über `useState(() => mergeKnown(DEFAULT_FX, readPluginSettings('effect')))` beim Mount und ein `useEffect`, der bei jeder Änderung von `power`, `activeFx`, `wetDry`, `intensity` in `pluginSettings('effect')` schreibt.

**Datenfluss**: UI-Änderung → `applyFx(fx, wetDry)` → `audioEngine.setEffectParams({type: fx, wet: dryWet/100, power, ...fxParams(fx, intensity)})`. `fxParams` skaliert Preset-Werte mit `f = clamp(intensity,0,100)/50` und clamps hart. Ein `window`-Event gibt es nicht; das Plugin ist autark (keine externen Events außer Lock).

**Canvas-Visualizer**: Ein eigener `useEffect` startet einen `requestAnimationFrame`-Loop, der eine hardcodierte Sinuskurve zeichnet (keine echten Audio-Daten, kein AnalyserNode). Der Loop läuft weiter, wenn `power` false ist (zeichnet nur nichts).

**Externe Abhängigkeiten**: `audioEngine.setEffectParams` (globale Funktion, Quelle `src/utils/audioEngine`, nicht Teil dieses Audits, nicht typisiert), `usePluginState('effect', 'PRO')` (Lock), `webRTCManager.userId` (Lock-Vergleich), `random()` (Util).

**Vertragsbindung**: `pluginContract.ts` deklariert `effect` als `fxReturn` (kein Kanal, 1 In / 1 Out, `sendsToFx: false`, `viaChannel: false`, `producesAudio: false`, `insertScope: null`, Latenz 0 ohne `latencyNote`). `signalChain.ts` ordnet `effect` der Stufe `processing` zu — zusammen mit den seriellen Master-Inserts eq, dsp, master und dem channel-Insert spatial. `registry.ts` mappt `effect -> FXEngineTerminal`. Keine dieser Dateien bindet effect an einen echten FX-Send/Return-Graph.

## 3. Technische Fehlannahmen
1. **Vertrag `sendsToFx: false` / „er IST der FX-Bus“ vs. UI als Insert**: Die UI zeigt eine „Signalkette“ Quelle → Algorithmus → Mix → Ausgang zum Main. Das ist ein Insert-Verhalten, kein Return. Es gibt keinen Send-Eingang vom Mixer und keinen konfigurierbaren FX-Bus-Weg.
2. **Vertrag `intrinsicLatencyFrames: 0` ohne Begründung**: Effekte wie REVERB und DELAY benötigen inhärent Puffer (Hall-Schwanz, Delay-Linie). Kein Effekt im System ist latenzfrei; der Wert 0 ist nicht begründet (keine `latencyNote`, im Gegensatz zu eq/dsp/master im Vertrag).
3. **`power: false` ≠ Bypass-Crossfade**: Der Vertrag fordert Bypass als Dry/Wet-Crossfade, kein Disconnect. `power` schaltet nur UI-Zustand und überträgt `power: power` an `setEffectParams`. Ob `audioEngine` beim `power: false` einen durchgesteuerten Dry-Signalweg liefert oder den Effekt abschaltet, ist im Plugin nicht ersichtlich.
4. **`fxParams` lineare Intensitätsskalierung ohne Schutz**: `feedback 0.62 * 2 = 1.24 → 0.95` (clamped) bei Intensität 100. Ein Nutzer kann den Effekt in Selbstoszillation treiben; kein Limiter, kein DC-Block, kein Peak-Schutz.

## 4. Designschwächen
- **Keine echte Audio-Eingabe**: Der Canvas-Scope zeichnet eine hardcodierte Sinuskurve (`Math.sin(i * frequency + phase)`), nicht das tatsächliche Signal. Der „Scope“ ist eine Attrappe; der Nutzer sieht kein echtes FX-Eingangs-/Ausgangsspektrum.
- **`sourceSample` spielt keine Rolle im DSP**: `handleSampleDrop` setzt nur `setSourceSample(sample)` und zeigt den Namen an. `applyFx` sendet niemals die Sample-Daten an `audioEngine`. Der DropTarget ist tot — der Effekt verarbeitet nur den „MASTER BUS“ oder gar nichts.
- **XY-Feld überschreibt `wetDry` und `intensity` gleichzeitig**: X steuert Mix, Y steuert Intensität. Beide werden über dieselben Knobs („Makro“) bedient; es gibt keine Independent-Parameter (z. B. Delay-Zeit separat von Feedback). Der Effekt ist ein Schwarzkasten mit 2 Reglern.
- **Lock ist nur optisch**: `locked` graulegt die UI; `applyFx` wird im `useEffect` bei jeder Änderung von `activeFx, wetDry, power, intensity` ungehindert aufgerufen (die UI-Bedienung ist disabled, aber der Effekt läuft weiter und schreibt Parameter).
- **Keine Preset-Verwaltung**: 8 harte Algorithmen mit festen `FX_PRESETS`; kein Laden/Speichern von Effekt-Presets über die Session hinaus (nur der letzte Stand in pluginSettings).
- **Keine Abhängigkeit von `pluginContract.ts`**: Der Vertrag (Rolle fxReturn, 1 In / 1 Out) hat keine Entsprechung in der Component; effect implementiert keine Ports, keine Kanal-Format-Logik, keine Latenz-Meldung.

## 5. Performance-/DSP-Risiken
- **Canvas rAF-Loop läuft ständig, wenn `power` true**: `useEffect` startet `requestAnimationFrame(draw)` und stoppt nur beim Unmount oder wenn `canvas` fehlt — nicht wenn `power` false (die Bedingung `if (power)` zeichnet nur nichts, der Loop läuft weiter). Jede Instanz von effectMONK brennt einen rAF-Timer, auch wenn bypassed.
- **Kein Audio-Thread**: Der Effekt läuft vollständig außerhalb der Audio-Graph (angenommen, `audioEngine.setEffectParams` aktualisiert Parameter, aber das Plugin steuert keine AudioNode-Graphik). Bei Tab-Hintergrund friert der Canvas ein, der Effekt selbst hängt von `audioEngine` ab (unklar, ob das weiterarbeitet).
- **Feedback ohne Schutz**: `feedback` bis 0.95 bei DELAY/REVERB kann bei geschlossenem Loop (Sample als Quelle, Ausgang zurück in Quelle) zu Selbstoszillation führen; kein Limiter, kein DC-Block, kein Peak-Schutz im Plugin.

## 6. Schnittstellen- und Abhängigkeits-Probleme
- `audioEngine.setEffectParams` ist eine nicht näher definierte globale Funktion (`src/utils/audioEngine` nicht gelesen). Parameter-Namen (`type`, `wet`, `power`, `feedback`, `rate`, …) sind Vertrag zwischen Plugin und Engine, aber nirgends typisiert. Jede Änderung in `audioEngine` bricht effect still.
- `FX_LIST` IDs (`DELAY`, `REVERB`, …) und `audioEngine`-Erwartungen sind nicht abgeglichen; ein Tippfehler in einer ID führt zu stillschweigendem Default-Verhalten (`FX_PRESETS[fx] ?? {}` → leere Params).
- Vertrag und Component sind entkoppelt: `pluginContract.ts` listet effect als `fxReturn` mit 1 In / 1 Out, aber die UI hat keinen Send-Eingang vom Mixer und keinen Return-Ausgang in die Summe; die „Signalkette“ ist eine UI-Fiktion ohne Graph-Bindung.
- `DropTarget onDrop={handleSampleDrop}` akzeptiert jedes `AudioSample`, prüft nicht `isTrustedMediaUrl` (im Gegensatz zu drumsampler), und spielt es nie ab — der Drop ist rein dekorativ.
- `registry.ts` COMPONENT_MAP und `pluginContract.ts` PLUGIN_CONTRACTS sind doppelte Quellen für id → Rolle/Component; sie können auseinanderdriften.

## 7. Empfohlene Korrekturen
1. Vertrag klären: effect entweder als echter FX-Return mit Send/Return aus dem Mixer ausführen (dann `sendsToFx` und Signalweg im Graph bindend) oder als Insert mit `insertScope` neu klassifizieren; Bypass als echter Dry/Wet-Crossfade implementieren (Vertrag einlösen oder `bypassable: false`).
2. `intrinsicLatencyFrames` mit `latencyNote` versehen (Hall/Delay brauchen Puffer) oder auf den tatsächlichen Algorithmus messen.
3. Canvas-Loop an `power` koppeln (start/stop rAF) und echte Audio-Daten (AnalyserNode) anzeigen statt Sinus-Attrappe.
4. `sourceSample` an `audioEngine` durchreichen oder DropTarget entfernen; derzeit irreführend.
5. Feedback-Limiter und Peak-Schutz nachrüsten; Intensität nicht blind auf alle Parameter multiplizieren, sondern pro Algorithmus sichere Parameterbereiche definieren.
6. `audioEngine.setEffectParams`-Schnittstelle typisieren und dokumentieren; IDs und Parameter abgleichen.
7. Lock konsequent erzwingen (alle `applyFx`-Aufrufe unter `if (locked) return;`).
8. Vertrag und Registry zu einer Quelle zusammenführen.
