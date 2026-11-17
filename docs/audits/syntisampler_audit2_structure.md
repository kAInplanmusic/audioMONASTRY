# Audit syntisampler — 2/2 Struktur-Audit (Architektur, Schnittstellen, Abhängigkeiten)

## Metadaten
- Plugin: syntisamplerMONK (id `syntisampler`, Rolle `source`, Kanal 4, Stereo, 0 In / 1 Out)
- Vertrag: `src/plugins/pluginContract.ts`; Registry: `src/plugins/registry.ts` (`syntisampler -> SyntiSamplerTerminal`); Signalkette: `src/plugins/signalChain.ts` (Stufe `sources`, nach `drumsampler`, vor `instru`)
- Geprüfte Dateien: `src/components/SyntiSamplerTerminal.tsx` (56 Zeilen), Verweise auf `SynthesizerTerminal`, `SamplerTerminal`, `McpTerminal` (statische Imports, nicht Teil dieses Audits)
- Stand: gemischter Master-Tag gm-v1.0.0 / f5538c63

## 1. Grundkonzept
syntisamplerMONK ist der gemergeierte Produzenten-Slot: Aus `synthesizerMONK + samplerMONK + mcp(Synth/Sampler-Steuerung)` (per AGENTS.md Konsolidierungs-Matrix) soll ein einziges Terminal mit drei Sektionen werden (SYNTH / SAMPLE / MPC), erreichbar per Tab-Umschaltung in einem gemeinsamen Rack-Modul. Laut Kommentar „kein Funktionsverlust: alle drei Terminals bleiben vollständig erhalten und sind als Sektionen in einem gemeinsamen Terminal erreichbar“.

## 2. Architektur-Analyse
**Komponenten-Hierarchie**: `SyntiSamplerTerminal` (`React.memo`) ist ein reines UI-Tab-Gehäuse. Es rendert einen Segment-Button (Sektion: synth/sampler/mpc) und bedingt `SynthesizerTerminal`, `SamplerTerminal` oder `McpTerminal`. Das Plugin enthält keinerlei eigene Logik, keinen DSP-Code, keine Parameter, keine Audio-Routing. Es delegiert vollständig an drei vorhandene Terminal-Komponenten.

**State-Management**: Ein einziger lokaler `tab`-State (`useState<Tab>('synth')`). Kein weiterer Zustand, kein Context, keine Persistenz.

**Datenfluss**: UI-Tab-Klick → `setTab` → bedingtes Rendern der gewählten Sektion. Keine Daten fließen zwischen den Sektionen; keine Kommunikation mit `audioEngine` oder Bridges auf dieser Ebene.

**Externe Abhängigkeiten**: Die drei Kinder (`SynthesizerTerminal`, `SamplerTerminal`, `McpTerminal`) werden statisch importiert. `registry.ts` lazy-lädt die Plugin-Terminals generell, aber `SyntiSamplerTerminal` selbst ist direkt importiert und seine Kinder sind statische Imports.

**Vertragsbindung**: `pluginContract.ts` deklariert `syntisampler` als Quelle (Kanal 4, Stereo, bypassable, sendsToFx post, syncCapable, producesAudio, Latenz 0 ohne `latencyNote`). `signalChain.ts` ordnet es der Stufe `sources` zu. `registry.ts` mappt `syntisampler -> SyntiSamplerTerminal`. Keine dieser Dateien erwähnt die drei Kinder oder deren Aufteilung in Sektionen.

## 3. Technische Fehlannahmen
1. **„alle drei Terminals bleiben vollständig erhalten, kein Funktionsverlust“**: Nicht verifizierbar. Die Kinder werden hier nicht instanziiert oder geprüft; ob `SynthesizerTerminal`, `SamplerTerminal` und `McpTerminal` in diesem Zusammenbau noch funktionieren (State-Konflikte, doppelte `audioEngine`-Anbindungen, doppelte MIDI-Bridges), ist ungeklärt.
2. **`producesAudio: true`**: syntisampler selbst erzeugt kein Audio; es ist ein Tab-Container. Ob die Kinder Audio erzeugen, liegt außerhalb dieses Plugins. Der Vertrag schreibt dem Container eine Eigenschaft zu, die er nicht besitzt.
3. **`intrinsicLatencyFrames: 0`**: Ein Synthesizer hat Voice-Allokation, Oszillator-Start, Filter-Latenz; ein Sampler hat Sample-Loading und Polyphonie. Keine dieser Latenzen ist erfasst. Der Wert 0 ist nicht begründet (`latencyNote` fehlt).
4. **`viaChannel: true / Kanal 4`**: Das Plugin routet nicht selbst in Kanal 4; die drei Kinder steuern vermutlich jeweils eigene `audioEngine`-Anbindungen. Welches Kind beschickt welchen Vertragskanal, ist undokumentiert.
5. **`syncCapable: true`**: Ob Synth, Sampler und MPC alle gegen die Main-Clock syncen können (UI2-P0-003), ist im Tab-Container nicht adressiert. Ein Tab, der nicht aktiv ist, kann nicht sinnvoll synced sein.

## 4. Designschwächen
- **Kein eigener Code, keine eigenen Tests möglich**: syntisampler ist ein leeres UI-Gerüst. Es gibt keine Props, keine Konfiguration, keine Schnittstelle, die man unit-testen könnte, außer dem Rendern der Tabs.
- **Lazy-Loading-Widerspruch**: `registry.ts` lazy-lädt die Plugin-Terminals (`lazy(() => import(...))`), um das Hauptbundle zu reduzieren. `SyntiSamplerTerminal` importiert seine Kinder aber statisch — alle drei Terminals werden mitgeladen, sobald das Plugin geladen wird. Die promise der Bundle-Reduktion wird für syntisampler-Kinder konterkariert.
- **Zustands-Isolierung ungeklärt**: Wenn der Nutzer zwischen Synth-, Sampler- und MPC-Tab wechselt, unklar ob Zustände (gespielte Noten, laufende Samples, Sequencer-Position) weiterlaufen, pausieren oder zurückgesetzt werden. Kein Tab-Exit-/Enter-Lifecycle.
- **„16 Plugins“-Konsolidierung ist Buchführung, nicht Architektur**: syntisampler existiert nur, um die Plugin-Zahl auf 16 zu bringen (Konsolidierungs-Matrix in AGENTS.md §5). Der Nutzwert als eigenständiges Plugin ist nicht erkennbar; es ist ein Ordner für drei andere.
- **Kein Lock**: `usePluginState` wird von syntisampler nicht abgefragt (im Gegensatz zu song/effect/drumsampler); fremder Besitzer kann die Tabs ungehindert umschalten.

## 5. Performance-/DSP-Risiken
- **Drei Audio-Engines in einem Plugin**: Wenn alle drei Kinder eigene `audioEngine`-Instanzen oder Worklets starten, dreifacher Speicher- und CPU-Fußabdruck für ein aktiv-ein-Seiten-Plugin. Kein shared-Pool, keine Lazy-Initialisierung der nicht-aktiven Sektion.
- **Keine Voice-Steuerung, keine Polyphonie-Limitierung**: Der Container setzt keine Obergrenzen für gleichzeitige Stimmen der drei Sektionen; Audio-Overload bei gleichzeitiger Nutzung nicht abfangbar.
- **Tab-Wechsel unter Audio**: Wenn ein Tab ein Sample abspielt und der Nutzer wechselt den Tab, läuft der Sound evtl. weiter (kein Cleanup bei Tab-Wechsel) — hörbare Ghost-Voices.

## 6. Schnittstellen- und Abhängigkeits-Probleme
- `SyntiSamplerTerminal` exportiert keine Props; Kinder-Komponenten sind interne Importe ohne dokumentierte Schnittstelle zum Container. Der Container kann keine Parameter an die Kinder übergeben und keine Zustände von ihnen empfangen.
- Keine Verbindung zu `pluginContract.ts`: Der Vertrag listet syntisampler mit Kanal 4, Rolle source; die Registry mappt `syntisampler -> SyntiSamplerTerminal`; die Kinder erscheinen nirgends im Vertrag oder der Registry. Die Kette id → Vertrag → Component → Kinder ist unterbrochen.
- `registry.ts` COMPONENT_MAP und `pluginContract.ts` PLUGIN_CONTRACTS sind doppelte Quellen für id → Rolle/Component; sie können auseinanderdriften (ein Plugin im Vertrag, das in der Registry fehlt, oder umgekehrt).
- Keine Typisierung der Tab-Sektionen oder der Daten, die zwischen Container und Kindern fließen sollten.

## 7. Empfohlene Korrekturen
1. Entweder syntisampler als reines UI-Meta-Plugin deklarieren (Vertrag: `producesAudio: false`, `viaChannel: false`, keine eigene Latenz) oder echte DSP/Audio-Logik nachrüsten.
2. `intrinsicLatencyFrames` mit `latencyNote` begründen oder die Kinder verpflichten, ihre Latenz zu melden und über den Container zu aggregieren (Maximum).
3. Kinder lazy-laden (entspricht `registry.ts`-Konzept), damit nicht alle drei Synth/Sampler/MPC-Bundles mitgeladen werden, wenn nur eine Sektion genutzt wird.
4. Tab-Lifecycle definieren: bei Tab-Wechsel aktive Stimmen stoppen/pausieren, Zustände konservieren oder zurücksetzen (dokumentiert).
5. Lock (`usePluginState('syntisampler', …)`) einbinden wie bei den anderen Plugins.
6. Vertrag, Registry und Kinder-Komponenten in einer Quelle abgleichen (wer bespielt Kanal 4? welche Sektion ist aktiv?).
