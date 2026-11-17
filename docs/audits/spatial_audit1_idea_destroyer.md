# audioMONASTRY — Phase C Audit 1 (Idea Destroyer): spatialMONK

**Plugin:** `spatial` (kanonische ID), Name `spatialMONK`, Rolle `insert` (channel scope)
**Stand:** Commit f5538c63, alle Worktrees identisch mit Hauptrepo
**Art:** adversarial / Idee zerstören — das Ziel ist es, das Konzept an jeder Stelle zum Einsturz zu bringen, nicht es zu schonen.

---

## 1. Grundkonzept (wie behauptet)

`pluginContract.ts` (Zeile 311–327) definiert spatialMONK als Insert im Kanalzug (`insertScope: 'channel'`, `channelInserts: ['spatial']` in `signalTopology()`), 1×1 Stereo, Latenz 0, bypassable, `producesAudio: false`, `sendsToFx: false`. Aufgabe: Pan/Distanz/Höhe je Quelle vor der Mixer-Summe. Die UI (`SpatialScene.tsx`) und der Adapter-Manifest beanspruchen darüber hinaus "Spatial Audio, 2.1/N.x, HRTF" (Zitat `SpatialPluginAdapter.ts` Zeile 4–11; WhitePaper §7 Presets/Szene).

## 2. Architektur-Analyse (Ist-Zustand)

- Vertrag: `src/plugins/pluginContract.ts` — spatial ist Channel-Insert (pre-Summe).
- UI: `src/components/SpatialScene.tsx` (+ `spatial/SpatialClubSetup.tsx`, `SpatialXYRoomController.tsx`), Zustand `SpatialSceneState` in `src/types.ts`, Presets in `src/presets.ts`.
- DSP-Adapter: `src/plugins/adapters/SpatialPluginAdapter.ts` — implementiert lediglich Pan + Stereobreite (konstantes Leistungs-Pan, -3 dB Mitte).
- Router: `src/core/pluginAudioRouter.ts` Zeile 69 — spatial ist `'ui-only'`, `mainFeeder: false` (kein Audio-Graph).
- Signal chain: `src/plugins/signalChain.ts` Zeile 56 — spatial steht in der `processing`-Stufe zusammen mit den Master-Inserts (`['effect','eq','dsp','spatial','master']`), also nach der Summe.
- C0-Graph: `src/core/audio/C0StudioChain.ts` — baut spatial in den Kanalstrip *vor* der Summe (dem Vertrag entsprechend).
- Worklet-Binding: `WORKLET_BINDING.spatial = 'spatial-processor'` (C0StudioChain Zeile 57).

## 3. Technische Fehlannahmen

1. **Fehlannahme: Es gibt einen einheitlichen Signalweg für spatial.** Falsch. Drei Stellen widersprechen sich über die Position:
   - Vertrag `signalTopology()`: Channel-Insert, pre-Summe.
   - `signalChain.ts`: processing-Stufe, nach Mixer/Master-Inserts.
   - `C0StudioChain`: Kanalstrip pre-Summe.
   Je nachdem welcher Pfad ausgeführt wird (Live-Graph vs. Bounce via `signalChain.ts`/`PluginAudioPipeline` vs. Vertrags-Checks), sitzt spatial an einer anderen Stelle. Ein Pan *nach* dem Master-Limiter ist klanglich sinnlos.

2. **Fehlannahme: spatial verarbeitet Audio im Graph.** Der Audio-Router markiert spatial als `'ui-only'` (pluginAudioRouter.ts:69). Wird der Router als Ausführungsebene genommen, verarbeitet spatial überhaupt kein Audio — die "Insert"-Idee ist tot, bevor sie startet.

3. **Fehlannahme: Die UI verspricht, was der Adapter liefert.** `SpatialScene.tsx` zeigt eine vollständige 3D-Szene (Objekte, Szene-Presets, HRTF-Anmutung, WhitePaper §7). Der Adapter kann nur Pan und Breite. Der Nutzer hört einen einfachen Stereo-Pan-Regler, glaubt aber an räumliches Rendering. Die "3D"-Idee existiert ausschließlich auf dem Bildschirm.

4. **Fehlannahme: Pan funktioniert für jede Quelle.** Bei monokanalem Input (`count === 1`, SpatialPluginAdapter.ts Zeile 66–71) kann Pan keine Links/Rechts-Richtung abbilden; das Signal bleibt unverändert. Stimme (`voice`, mono per Vertrag) kann also nicht gepannt werden — die häufigste Quelle fällt aus.

5. **Fehlannahme: Latenz ist immer 0.** Der Vertrag schreibt 0 Frames. Ein echtes HRTF/Convolution-Rendering (wie die UI andeutet) hätte Latenz und müsste im PDC angemeldet werden. Wird HRTF nachgeliefert, bricht die Latenz-Invariante.

6. **Fehlannahme: Bypass ist im Adapter abgedeckt.** `onProcess` leitet bei `pan === 0 && width === 1` bit-gleich durch, aber der Adapter hat keinen eigenen Wet/Dry- oder Bypass-Zustand. Bypass wird ausschließlich über `BaseAdapter.state === 'OFF'` (transparenter Durchlass) und `C0StudioChain.setBypass` (Dry/Delay-Frames aus Vertrag) gelöst. Der Adapter selbst weiß nichts von Bypass.

## 4. Designschwächen

- **Pan nach Summe vs. vor Summe nicht festgelegt.** Die drei Orte (Vertrag, signalChain, C0) uneins → nicht reproduzierbares Verhalten je Ausführungskontext.
- **UI/Adapter-Schere.** 3D-Szene vs. Pan/Breite. Keine Absprache, welche Darstellung massgebend ist.
- **Mono-Quellen ausgeschlossen.** Kein Mono→Stereo-Upmix oder Objekt-Platzierung vor dem Pan.
- **Kein Bezug auf den deklarierten `ISpatialRenderer`.** `plugin_interface.ts` definiert `ISpatialRenderer` im `PluginRuntimeContext`, aber `SpatialPluginAdapter` nutzt ihn nicht; die Capability `'spatial'` im Manifest ist nicht unterfüttert.
- **Szene-State und DSP-State entkoppelt.** `SpatialSceneState` (Presets, Quelle-Positionen) lives in React-State/LocalStorage; der Adapter kennt nur `pan`/`width`-Parameter. Es gibt keinen Pfad, über den Szene-Positionen in den Audio-Adapter gelangen.

## 5. Performance-/DSP-Risiken

- Die rAF-Analysator-Schleife in `SpatialScene` (30 fps, Canvas) läuft im UI-Thread und greift auf `audioEngine.createVisualAnalyser` zu — keine DSP-Auswirkung, aber UI-Last bei offenen Spatial-Tabs.
- Ein nachträglich hinzugefügtes HRTF/Convolution im Adapter würde blockweise arbeiten und Tail-Samples erzeugen; `tailSamples: 0` im Manifest wäre falsch, Bounce würde abgeschnitten.
- Pan mit `Math.cos`/`Math.sin` pro Sample ist günstig, aber bei 36-Band-Analogie (nicht hier) wäre die CPU-Last nicht das Problem — das Problem ist die semantische Leere.

## 6. Schnittstellen-Probleme

| Schnittstelle | Problem |
|---|---|
| Vertrag ↔ Router | Vertrag: Insert mit Audio-I/O. Router: `ui-only`, kein Graph. Widerspruch. |
| Vertrag ↔ signalChain | Vertrag: pre-Summe Channel-Insert. signalChain: processing-Stufe post-Summe. |
| Vertrag ↔ C0StudioChain | C0 implementiert Vertrag (pre-Summe), ist aber nur einer von drei Pfaden. |
| UI ↔ Adapter | UI: 3D/HRTF-Szene. Adapter: Pan + Breite. Keine gemeinsame Wahrheit. |
| Adapter ↔ Manifest | Manifest: `latencySamples: 0`, `kind: 'audio-router'`. HRTF hätte Latenz + Tail. |
| plugin_interface.ts | `ISpatialRenderer` im Context existiert, wird vom Adapter ignoriert. |

## 7. Empfohlene Korrekturen

1. **Eine verbindliche Position festlegen.** Entweder Vertrag ändern (spatial = Master-Insert, post-Summe, wie signalChain es vorsieht) ODER signalChain + C0 auf Channel-Insert pre-Summe einigen und den widersprüchlichen Eintrag in signalChain.ts entfernen. Aktuell ist das System nicht deterministisch.
2. **Router korrigieren.** `isolation` für spatial von `'ui-only'` auf `'insert'`/`'send'` heben — oder Vertrag auf `role: 'fxReturn'`/`'utility'` ändern, wenn spatial wirklich kein Audio verarbeitet.
3. **UI und Adapter angleichen.** Entweder den Adapter auf echtes Spatial-Rendering (HRTF/Ambisonics, `ISpatialRenderer` nutzen, Latenz + Tail deklarieren) heben ODER die UI auf Pan/Breite zurückbauen und "3D"-Marketing entfernen.
4. **Mono behandeln.** Vor dem Pan einen expliziten Mono→Stereo-Schritt (oder Objekt-Renderer) einführen, sonst bleiben monophone Quellen stumm für Pan.
5. **Bypass im Adapter kapseln.** Einen `bypassed`-Zustand im Adapter mit Dry/Delay-Ausgleich (laut Vertrag 0 Frames) führen, damit Bypass nicht nur über `state === 'OFF'` läuft.
6. **Dokumentieren.** WhitePaper §7 und die Kommentare in `SpatialScene.ts` müssen die tatsächliche Fähigkeit (Pan/Breite) widerspiegeln, nicht die geplante 3D-Szene.

**Fazit Idea Destroyer:** Die Idee "spatialMONK als räumlicher Kanal-Insert" ist aktuell eine Fassade: Die UI verspricht 3D, der Adapter liefert Pan, der Router verweigert Audio, und drei Stellen uneins über die Einbauposition. Das Konzept kollabiert bei jeder konsequenten Prüfung.