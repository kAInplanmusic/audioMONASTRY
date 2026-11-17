# Audit drop — 2/2 Struktur-Audit (Architektur, Schnittstellen, Abhängigkeiten)

## Metadaten
- Plugin: dropMONK (id `drop`, Rolle `source`, Kanal 1, Stereo, 0 In / 1 Out)
- Vertrag: `src/plugins/pluginContract.ts`; Registry: `src/plugins/registry.ts` (`drop -> DropTerminal`); Signalkette: `src/plugins/signalChain.ts` (Stufe `sources`, Position vor `song`)
- Geprüfte Dateien: `src/components/DropTerminal.tsx`, `src/components/drop/*`, `src/context/DropContext.tsx`, `src/core/drop/` (DropEngine, DropContextAnalyzer, AiDropGenerator, MixerBridge, ClockBridge, PluginParameterBridge, types/DropProfile), `src/core/drop/index.ts`
- Stand: gemischter Master-Tag gm-v1.0.0 / f5538c63

## 1. Grundkonzept
dropMONK ist das DJ-Drop/Übergangs-Modul des Systems: 16 Pads feuern Profile ab, die Parameter-Sequenzen (Pitch, Level, Length, Kurven, Dauer) über Plugins und Mixer-Fader fahren; drei Modi (generator, dj_transition, sampler_top), Quantization auf Taktgrenzen, KI-generierte Profile und hörbare xl-turbo-Audio-Drops. Das Modul sitzt im Signalweg als Quelle auf Kanal 1, speist den Mixer und schickt post-fader in den FX-Bus (`effect`).

## 2. Architektur-Analyse
**Komponenten-Hierarchie**: `DropTerminal` (`React.memo`) kapselt `DropProvider` und `DropTerminalContent`. Das Content-Komponente rendert Kategorie-Liste, 16-Pad-Raster, Envelope-SVG, KI-Chat-Input, drei Modus-Panels (Generator/DJ-Transition/Sampler-Top) und ein erweitertes Details-Fenster (AiChatPanel, DropPresetBrowser, modusabhängiges Panel). Die Logik liegt nicht in den Komponenten, sondern in `DropContext` (React Context + Reducer-ähnliche Actions) und `DropEngine` (Klasse, Singleton).

**Datenfluss**: UI-Event (Pad-Klick, KI-Prompt, Transition) → `DropContext`-Action → `DropEngine.triggerDrop` / `aiDropGenerator.generateDropProfile` / `requestAudioDrop` → `pluginParameterBridge.setNormalizedParameter` / `mixerBridge.setMixerLevel` / `mixerBridge.crossfade`. `DropContextAnalyzer` liest den Mix-Zustand (`mixerBridge.getCurrentMixerState`, FFT-Energie) für KI-Vorschläge. Alles einseitig: UI steuert Bridges, Bridges schreiben in den globalen Audio-Graph/Engine.

**State-Management**: Ein monolither `DropContextType` (31 Felder, davon 16 Actions). `useDropContext()` liefert das gesamte Objekt an jeden Consumer → jede State-Änderung rendert alle Consumer neu. `DropProvider` initialisiert asynchron (`dropPresetStore.initialize()`, `suggestDropProfiles`) und hängt Brücken über `attachDropBridges()` an die `audioEngine`.

**Singleton-Graph**: `dropEngine = new DropEngine()` ist ein exportierter Modul-Singleton, ebenso `dropContextAnalyzer`, `mixerBridge`, `clockBridge`, `aiDropGenerator`. Keine Injektionsnaht, keine Factory.

**Vertragsbindung**: `pluginContract.ts` deklariert `drop` als Quelle (Kanal 1, Stereo, bypassable, sendsToFx post, syncCapable, producesAudio, latency 0). Der Vertrag wird von `signalChain.ts` gelesen (Rolle `source` → Stufe `sources`) und von `registry.ts` (id → Component) — aber beide Dateien kennen sich nicht; der Vertrag weiß nichts von der Komponente, die Registry nichts vom Vertrag.

## 3. Technische Fehlannahmen
1. **Vertrag `intrinsicLatencyFrames: 0` vs. reales Scheduling**: DropEngine arbeitet mit `requestAnimationFrame` (~16 ms) und `setTimeout` (quantized Fallback). Keine der Verzögerungen wird an die PDC (`v2Pdc.ts`, `masteringLookaheadFrames`) gemeldet. Ein quantisierter Drop startet unbestimmt spät relativ zum Audio-Thread; der Vertrag lügt über Latenzfreiheit.
2. **`producesAudio: true` vs. Implementierung**: drop erzeugt keinen eigenen Audio-Stream, es automatisiert nur Parameter anderer Plugins und fährt Mixer-Fader (`mixer:channel_fade` über alle aktiven Kanäle). Der Vertrag verwechselt Automatisierungs-Sender mit Audio-Quelle.
3. **`bypassable: true` ohne Bypass-Pfad**: Es gibt keinen stummschaltbaren Insert-Punkt oder Dry/Wet-Crossfade für drop im Graph. Der Vertrag fordert Crossfade statt Disconnect; drop hat gar keinen Disconnect-Punkt.
4. **Kanal-String `'channel1'` als Default**: `executeDrop(..., channelId = 'channel1')` validiert nicht gegen die Mixer-Kanäle (CH1–CH5 im UI) oder den Vertragskanal 1. Ungültige Kanäle still ignoriert.

## 4. Designschwächen
- **Gottes-Objekt `DropContext`**: 31 State-Actionen in einem Context; `useDropContext()` konsumiert das ganze Value-Objekt. Keine Teil-Subscriptions, keine Memoisierung von Teil-Zuständen → unnötige Re-Renders des gesamten Terminals bei jeder Pad-Interaktion.
- **Direkte Singleton-Importe statt Injektion**: `DropContext` importiert `dropEngine`, `mixerBridge`, `clockBridge`, `aiDropGenerator`, `dropContextAnalyzer` direkt. Unit-Tests ohne Audio-Kontext (wie vom Vertrag angedeutet) sind nicht möglich, weil `DropProvider` bei `init()` Brücken an die `audioEngine` hängt und `dropEngine.on(...)` registriert.
- **KI und Audio-Drop vermischen UI- und Serverzustand**: `generateAudioDrop` ruft einen Server-Endpunkt, schreibt aber nur ein lokales Pad (`setAudioDrops`, `setSelectedProfile`). Ob der Server das Audio erzeugt hat, sehen UI und andere Clients nicht; kein Sync-Status, kein Inhaber-Lock auf Clientseite.
- **Pad-Action-Modus vermischt Auswahl und Auslösung**: Ein Pad-Klick wählt immer aus (`selectProfile`) und feuert optional (`padAction === 'fire'`). Keine Trennung von Vorschau und Auslösung; ungewollte Drops sind ein Klick entfernt.
- **Audio-Drop landet „still in der Bibliothek“** — kein Consent, kein Quoten-Limit, keine Abhängigkeit vom Plugin-Inhaber-Lock (Kommentar behauptet Server-seitigen Lock, Client prüft nichts).

## 5. Performance-/DSP-Risiken
- **rAF-Parameterloop auf dem UI-Thread**: `DropEngine.ensureAnimationLoop` schreibt pro Frame jede Parameter-Animation über `pluginParameterBridge.setNormalizedParameter` (und bei `mixer:channel_fade` über alle aktiven Mixer-Kanäle). Keine Begrenzung auf Audio-Rate, keine Rate-Limitierung außer der trüben `lastWritten`-No-op-Erkennung auf den normalisierten Wert. Bei vielen gleichzeitig laufenden Drops blockiert der UI-Thread und verzögert das Rendering der anderen Rack-Module.
- **Kein Audio-Thread-Automatismus**: Alle Parameterfahrten laufen über React-State + Bridges, nicht über die Audio-Worklet-/Graph-Automatisierung. Bei Tab-Hintergrund oder niedrigem rAF-Takt frieren die Fahrten ein, während der Audio-Thread weiterläuft → hörbare Aussetzer oder Stopp der Parametrierung mitten im Drop.
- **`envelopePaths` rendert 24 Segmente pro Sequenz-Schritt als SVG-String im Render-Body**, nicht memoisiert über `selectedProfile`. Bei großen Presets und häufigen Profil-Wechseln unnötige String-Konkatenation und DOM-Updates.
- **Blob-Speicherleck**: `URL.createObjectURL`-Ergebnisse (Audio-Drops) werden nie mit `URL.revokeObjectURL` freigegeben; `audioDrops` wird auf `slice(-7)` gekappt, aber alte Blob-URLs bleiben im Browser-Speicher.

## 6. Schnittstellen- und Abhängigkeits-Probleme
- `DropContext` importiert ein Dutzend benannte Exporte aus `../../core/drop` (`dropEngine`, `mixerBridge`, `clockBridge`, `aiDropGenerator`, …) ohne eigenes Interface-Typ für die Bridges. Die Bridges (`MixerBridge`, `ClockBridge`, `PluginParameterBridge`) exportieren keine Typen; der Vertrag (`pluginContract.ts`) kennt none davon. Die Schnittstelle zwischen Context und Bridges ist undokumentiert.
- `executeDrop` Default-Channel `'channel1'` ist ein magischer String, der nicht gegen Mixer-Kanäle oder Vertrag validiert wird.
- `triggerDjTransition(fromCh, toCh, profile?)` akzeptiert Kanal-Strings ohne Prüfung gegen `CHANNELS`/Vertrag; `fromCh === toCh` (Crossfade auf sich selbst) wird nicht abgelehnt.
- `DropEngineEvents.onError` existiert, aber der Context fängt Engine-Fehler nur grob (`console.error`); UI zeigt nie einen Engine-Fehler an (außer `audioDropStatus` bei Audio-Drops).
- **Vertrag–Registry–SignalKette sind drei getrennte Quellen**: `pluginContract.ts` (Rollen, Kanäle, Latenz), `registry.ts` (id → Component, Metadaten, EXPECTED_PLUGIN_COUNT=16), `signalChain.ts` (Stufen, Reihenfolge). Sie können auseinanderdriften (z. B. Plugin im Vertrag, das in der Registry fehlt; Kanalbelegung im Vertrag vs. Kommentar-Nummerierung in der Registry, die ein anderes 1–16-Schema verwendet: DJ: mixer(1)·drop(2)·song(3)·effect(4) vs. Vertrag: drop=1, song=2, drumsampler=3, syntisampler=4).

## 7. Empfohlene Korrekturen
1. Vertrag `intrinsicLatencyFrames` für drop auf einen gemessenen Wert setzen (rAF-Scheduling + Audio-Thread-Puffer) bzw. `latencyNote` ergänzen; Drop-Engine-Latenz an `v2Pdc.ts`/PDC melden.
2. `producesAudio` auf `false` setzen (Automatisierungs-Sender, keine Quelle) oder eigenen Audio-Generator nachrüsten.
3. Bypass als echtes Dry/Wet auf der Drop-Ausgangsstufe implementieren oder Vertrag `bypassable: false` korrigieren.
4. Quantized-Drops sample-genau über die Audio-Clock (`AudioContext.currentTime` / v2Pdc) statt `setTimeout`/`rAF`; 120-BPM-Hartcodierung entfernen.
5. `DropContext` aufteilen (DropState, LoopState, PresetState, AiState) und selektive Subscriptions ermöglichen; Brücken über Dependency Injection statt direkter Module-Importe testbar machen.
6. `URL.createObjectURL`-Ergebnisse mit `revokeObjectURL` paaren; Audio-Drop-Cache begrenzt und revoken.
7. Kanal-Strings (`channelId`, `fromCh`, `toCh`) gegen Mixer-Kanäle/Vertrag validieren; `fromCh === toCh` ablehnen.
8. Engine-Fehler in UI sichtbar machen (Status-Banner), nicht nur in `console.error`.
9. Vertrag und Registry zu einer Quelle zusammenführen (Single Source of Truth für id ↔ Component ↔ Rolle).
