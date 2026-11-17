# Audit drop — 1/2 Idea Destroyer (adversarial)

## Metadaten
- Plugin: dropMONK (id `drop`, Rolle `source`, Kanal 1, Stereo)
- Vertrag: `src/plugins/pluginContract.ts` (`PLUGIN_CONTRACTS`, `intrinsicLatencyFrames: 0`, `bypassable: true`, `sendsToFx: true` / `fxSendTap: 'post'`, `syncCapable: true`, `viaChannel: true`, `producesAudio: true`)
- Geprüfte Dateien: `src/components/DropTerminal.tsx`, `src/components/drop/*` (DropGeneratorPanel, DJTransitionPanel, SamplerTopPanel, AiChatPanel, DropPresetBrowser, LoopControls, PadParamControls, QuantizationControl), `src/context/DropContext.tsx`, `src/core/drop/DropEngine.ts`, `src/core/drop/DropContextAnalyzer.ts`, `src/core/drop/AiDropGenerator.ts`, `src/core/drop/MixerBridge.ts`, `src/plugins/registry.ts` (`drop -> DropTerminal`)
- Stand: gemischter Master-Tag gm-v1.0.0 / f5538c63

## 1. Grundkonzept
dropMONK soll der DJ-Drop- und Übergangsgenerator des Systems sein: Pads feuern Profile ab, die Parameter-Sequenzen (Pitch/Level/Length, Kurven, Dauer) über Plugins und den Mixer fahren; ein KI-Chat generiert neue Profile aus Prompts (DROP-P1-001), und über `generateAudioDrop` landen hörbare xl-turbo-Drops in der Bibliothek. Drei Modi (generator, dj_transition, sampler_top) plus Quantization auf 4-Takt-Grenzen. Insgesamt ein UI-verwenderischer "Drop-Knopf"-Komplex mit begleitendem DSP-Parameter-Automatisierungs-Engine.

## 2. Architektur-Analyse
Die Architektur ist strikt clientseitig/React-zentriert: `DropTerminal` kapselt `DropProvider` (Zustand) + `DropTerminalContent` (UI). Die Logik lebt in `DropContext` (zustand + Effekte), die Ausführung in `DropEngine` (rAF-Animationsloop, Parameter-Animationen über `pluginParameterBridge` / `mixerBridge`), Timing über `clockBridge` (quantized) bzw. `setTimeout`-Fallback. `DropContextAnalyzer` bereitet den realen Mix-Zustand (Kanalpegel, FFT, BPM) für KI-Vorschläge auf. Audio-Drops gehen über `requestAudioDrop` gegen einen Server-Endpunkt (Cache, Bibliothek). Alles hing an einem globalen Singleton (`dropEngine = new DropEngine()`), der direkt aus dem Context importiert und verwendet wird.

## 3. Technische Fehlannahmen
1. **„intrinsicLatencyFrames: 0 ist korrekt“** — Falsch. Der Drop-Engine-Thread arbeitet mit `requestAnimationFrame` (~16 ms Jitter) und `setTimeout` auf realer BPM. Keine dieser Verzögerungen wird an die PDC (v2Pdc / pluginContract) gemeldet. Ein quantisierter Drop auf die nächste 4-Takt-Grenze startet unbestimmt spät gegenüber dem Audio-Thread; der Vertrag behauptet Latenz 0, die Engine liefert nicht-deterministische UI-Thread-Latenz.
2. **„Bypass ist ein Dry/Wet-Crossfade“** — Vertrag fordert Crossfade, kein Disconnect. drop hat gar keinen Bypass-DSP-Weg; `bypassable: true` im Vertrag hat keine Entsprechung im Code. Es gibt keinen stummschaltbaren Insert-Punkt für drop im Graph.
3. **„producesAudio: true“** — drop erzeugt keinen eigenen Audio-Stream; es steuert nur Parameter anderer Plugins und fährt Mixer-Fader. Der Vertrag verwechselt „Parameter automatisieren“ mit „Audio erzeugen“.
4. **„Quantization auf Takt genau“** — `clockBridge.scheduleDrop` löst bei laufendem Transport aus; im Nicht-laufenden Zustand fällt die Engine auf `setTimeout(calculateQuantizationDelay(...))` mit hartem 120-BPM-Fallback im Kommentar (Code: `bpm || 120`). Kein Sample-genauer Start, keine Transport-Synchronisation zur Audio-Wiedergabe.
5. **„5 Kanäle CH1–CH5 inkl. Master“** — `CHANNELS = ['CH1'..'CH5 (Master)']` im Terminal, aber der Vertrag weist drop Kanal 1 (Mixer) zu. Es gibt keine Abbildung, welchen der 5 UI-Kanäle welcher Mixer-Kanal oder welche Plugin-Ausgabe bedient.

## 4. Designschwächen
- **Gottes-Objekt DropContext**: 31 State-Actionen (mode, Profile, KI, Audio-Drops, Presets, Favoriten, Loop, Pad-Parameter, Quantization, Transition) in einem Context. Jede Pad-Interaktion rendert das gesamte `DropTerminalContent` neu, weil `useDropContext()` das ganze Value-Objekt liefert. Keine Memoisierung von Teil-Zuständen.
- **Singletons ohne Injektionsnaht**: `dropEngine`, `mixerBridge`, `clockBridge`, `dropContextAnalyzer` sind direkte Module-Importe. Unit-Tests ohne Audio-Kontext (der Vertrag wirbt mit „auch in Tests ohne Audio-Kontext nutzbar“) sind für drop praktisch nicht möglich, weil `DropProvider` bei `init()` Brücken an die `audioEngine` hängt und `dropEngine.on(...)` Ereignisse registriert.
- **KI und Audio-Drop vermischen UI- und Serverzustand**: `generateAudioDrop` ruft einen Server-Endpunkt, schreibt aber nur ein lokales Pad (`setAudioDrops`, `setSelectedProfile`). Ob der Server das Audio wirklich erzeugt hat, sehen UI und andere Clients nicht (kein Sync-Status, kein Owner-Lock für die Bibliotheks-Datei).
- **Pad-Action-Modus `'select' | 'fire'` feuert implizit**: Ein Pad-Klick wählt immer aus (`selectProfile`) und feuert optional. Es gibt keine Trennung zwischen Vorschau und Auslösung; ungewollte Drops sind bei `padAction === 'fire'` nur einen Klick entfernt.
- **Audio-Drop landet „still in der Bibliothek“** (Kommentar) — kein Benutzer-Consent, kein Quoten-Limit, keine Abhängigkeit vom Plugin-Inhaber-Lock (der Kommentar behauptet Server-seitigen Lock, der Client prüft nichts).

## 5. Performance-/DSP-Risiken
- **rAF-Parameterloop auf dem UI-Thread**: `DropEngine.ensureAnimationLoop` schreibt pro Frame jede Parameter-Animation über `pluginParameterBridge.setNormalizedParameter` (und bei `mixer:channel_fade` über alle aktiven Mixer-Kanäle). Keine Begrenzung auf die Audio-Rate, keine Rate-Limitierung außer der trüben `lastWritten`-No-op-Erkennung auf den *normalisierten* Wert. Bei vielen gleichzeitig laufenden Drops blockiert der UI-Thread und verzögert das Rendering der anderen Rack-Module.
- **Kein Audio-Thread-Automatismus**: Alle Parameterfahrten laufen über React-State + Bridges, nicht über die Audio-Worklet-/Graph-Automatisierung des Systems. Bei Tab-Hintergrund oder niedrigem rAF-Takt frieren die Drop-Fahrten ein, während der Audio-Thread weiterläuft → hörbare Aussetzer oder Stopp der Parametrierung mitten im Drop.
- **`envelopePaths` rendert 24 Segmente pro Sequenz-Schritt als SVG-String bei jedem Render** (`paths` wird im Render-Body berechnet, nicht memoisiert über `selectedProfile`). Bei großen Presets und häufigen Profil-Wechseln unnötige String-Konkatenation und DOM-Updates.
- **`audioDrops`-Array wächst ungebunden nach `slice(-7)`** — nur die letzten 7 Audio-Drops bleiben, aber jedes `generateAudioDrop` erzeugt eine neue Blob-URL (`URL.createObjectURL` in `SongMonkTerminal`-Muster; bei drop ähnlich über `requestAudioDrop` Ergebnis), die nie mit `URL.revokeObjectURL` freigegeben wird → Speicherleck bei längerer Session.

## 6. Schnittstellen-Probleme
- `DropContext` importiert aus `../../core/drop` ein Dutzend benannter Exporte (`dropEngine`, `mixerBridge`, `clockBridge`, `aiDropGenerator`, …) ohne eigenes Interface-Typ für die Bridges. Die Bridges (`MixerBridge`, `ClockBridge`, `PluginParameterBridge`) haben keine exported Typen; der Vertrag (`pluginContract.ts`) kennt none davon. Schnittstelle zwischen Context und Bridges ist undokumentiert.
- `executeDrop(profile, quantized, channelId = 'channel1', padParams)` — Default-Channel `'channel1'` ist ein String-Rate, der nirgends gegen die Mixer-Kanäle (CH1–CH5) oder die Vertrags-Kanäle validiert wird. Ungültige Kanäle still ignoriert (`playAudioDrop` gibt `false`, setzt nur einen Status-String).
- `triggerDjTransition(fromCh, toCh, profile?)` akzeptiert Kanal-Strings, die nicht gegen `CHANNELS` oder den Vertrag geprüft werden; `transitionInProgress`-Flag verhindert doppelte Ausläufe, aber nicht, dass `fromCh === toCh` (Crossfade auf sich selbst).
- `DropEngineEvents.onError` existiert, aber der Context fängt Engine-Fehler nur grob (`console.error`); UI zeigt nie einen Engine-Fehler an (außer `audioDropStatus` bei Audio-Drops).
- Registry-Auflösung `resolveComponent('drop') -> DropTerminal` ist entkoppelt vom Vertrag (`pluginContract.ts` weiß nichts von `registry.ts` COMPONENT_MAP und umgekehrt). Beide Listen können auseinanderdriften (z. B. ein Plugin im Vertrag, das in der Registry fehlt).

## 7. Empfohlene Korrekturen
1. Vertrag `intrinsicLatencyFrames` für drop auf einen gemessenen Wert setzen (rAF-Scheduling + Audio-Thread-Puffer) bzw. `latencyNote` ergänzen; Drop-Engine Latenz an `v2Pdc.ts` / PDC melden.
2. Bypass für drop als echtes Dry/Wet auf der Drop-Ausgangsstufe implementieren oder Vertrag `bypassable: false` korrigieren und Dokumentation anpassen.
3. `producesAudio` auf `false` setzen (drop ist Automatisierungs-Sender, keine Quelle) oder einen eigenen Audio-Generator nachrüsten.
4. Quantized-Drops sample-genau über die Audio-Clock (`AudioContext.currentTime` / v2Pdc) statt `setTimeout`/`rAF` ausführen; 120-BPM-Hartcodierung entfernen.
5. DropContext aufteilen (DropState, LoopState, PresetState, AiState) und selektive Subscriptions ermöglichen; Brücken über Dependency Injection statt direkter Module-Importe testbar machen.
6. `URL.createObjectURL`-Ergebnisse mit `revokeObjectURL` paaren; Audio-Drop-Cache begrenzten und revoken.
7. Kanal-Strings (`channelId`, `fromCh`, `toCh`) gegen die Mixer-Kanäle / Vertrag validieren; `fromCh === toCh` ablehnen.
8. Engine-Fehler in UI sichtbar machen (Status-Banner), nicht nur in `console.error`.
9. Vertrag und Registry zu einer Quelle zusammenführen (Single Source of Truth für id ↔ component ↔ Rolle).
