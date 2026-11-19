# To-do: Verdrahtung der App (Bedienelemente, Plugins, Events, KI-Modelle)

Stand 2026-11-19, Basis `main` @ `2db9ffe`. Jeder Eintrag ist am Code geprüft (Datei:Zeile). **P0** = Fehler mit Wirkung auf Audio/Bedienung, **P1** = fehlende Verdrahtung, **P2** = Aufräumen/Optimierung.
Wiederholen ohne neue Analyse: `python3 scripts/audit-wiring/{routes,events,ai,stateonly}.py` und `node scripts/audit-wiring/ui-controls.cjs` (Abschnitt 6).

## 1. P0 – Fehler

- [ ] **DSP-Limiter: Ceiling-Standardwert in falscher Einheit.** `src/components/am/DspRack.tsx:73` setzt `limCeiling: 0.98` (alter Linearwert), Zeile 102 rechnet ihn aber als dB um (`dbToLin(s.limCeiling)`). Ergebnis: Obergrenze **+0,98 dB über Vollaussteuerung**, bis jemand den Regler bewegt (Regler-Bereich −12…0 dB, `def={-1}` in Zeile 218). Fix: Standard auf `-1` (dB) und gespeicherte Altwerte > 0 beim Laden auf −1 setzen; Test für Default und Migration.
- [ ] **Drop-Preset löschen tut nichts.** `src/components/drop/DropPresetBrowser.tsx:137`: Papierkorb-Button ohne `onClick`. Fix: `DropPresetStore`-Löschfunktion anbinden, Rückfrage, Test.
- [ ] **KI-Agent bietet entfernte Modelle als Werkzeuge an.** `src/core/ai/orchestrator/mcpRuntime.ts:173-180` listet `image.generate` (FLUX.1-dev, Qwen-Image, Real-ESRGAN), `video_real.*` (Wan 2.2) und `video_abstract.*` (LTXVideo). Diese Modelle sind laut Betreiber (2026-11-13) entfernt, kein Pod und kein Runtime-Handler kennt die Aufgaben `image.generate`, `video.generate`, `video.abstract` (`handlers.py:679 HANDLERS`). Aufrufe des Agenten laufen ins Leere. Fix: Werkzeuge entfernen, ebenso die Einträge in `endpointRegistry.ts:172/199/221/276-278`, `jobManager.ts`, `types.ts` (`AiTask`), `toolArgs.ts`, `vision/vastVisual.ts`.

## 2. P1 – Fehlende Verdrahtung

### 2.1 Mischpult (mixerMONK, `src/components/mixer/MixerDesk.tsx`)
Kanal-Pegel, Trim, EQ hi/mid/low, Pan, Mute, Solo, Crossfader-Zuordnung und -Kurve, Master und CUE (`setChannelPfl`) sind **korrekt** an `audioEngine` angebunden (Zeilen 138-145, 497-499). Nicht angebunden:
- [ ] **Filter je Kanal** (`c.filter`, Zeile 172): wird nur gespeichert, `pushChannel()` (Zeile 138) setzt ihn nicht; `audioEngine` hat keine Filter-Funktion je Kanal.
- [ ] **Send je Kanal** (`c.send`, Zeile 174): nur gespeichert, kein Effekt-Send in der Engine.
- [ ] **Makro 1-3** (`macros.flt/fx/build`, Zeilen 526-528): nur gespeichert, keine Wirkung auf Summe/Returns/Build-up.
- [ ] **FX LOCK** (Zeile 455): schaltet nur den Zustand; ohne wirksame Makros wirkungslos.
- [ ] **„Main Out" in der Signalkette** (Zeile 443): Anzeige als `<button>` ohne Aktion → als Statusanzeige (`<span role="status">`) darstellen oder Aktion zuweisen.
Fix-Vorschlag: `audioEngine.setChannelFilter/setChannelSend`, Makro-Mapping auf Summenfilter/FX-Return/Build-up, Tests auf `pushChannel`.

### 2.2 Deck-Controller (`src/components/mixer/DeckControllers.tsx:278-281`)
- [ ] **Sechs Pad-Regler je Deck** (`s.knobs[i]`): nur Zustand, kein Verbraucher im Code. Ziel festlegen (Pad-FX? Sampler-Parameter?) und anbinden oder entfernen.

### 2.3 Interne Befehle ohne Empfänger (`controlBus`)
Gesendet, aber kein Bauteil hört zu (Sprach-/Agentenbefehle laufen ins Leere):
| Event | Sender | fehlt |
| --- | --- | --- |
| `monk:sound-generate` | `plugins/adapters/SoundPluginAdapter.ts:37` | Listener in `SoundTerminal` |
| `monk:library-load` | `core/voice/pluginCommandRegistry.ts:260`, `BiblioPluginAdapter.ts:42` | Listener in `LibraryTerminal` (hört nur `library-search`) |
| `monk:drop-auto` | `pluginCommandRegistry.ts:213`, `DropPluginAdapter.ts:55` | Listener im Drop-Modul |
| `monk:stem-status` | `StemPluginAdapter.ts:98` | Listener in `StemExtractorTerminal` |
| `monk:song-result` | `SongPluginAdapter.ts:59` | Listener in `SongMonkTerminal` |
| `monk:ai-plan` | `pluginCommandRegistry.ts:177` | Empfänger (aiMONK?) |
| `monk:midi-learn`, `monk:midi-mapping` | `pluginCommandRegistry.ts:302/305` | Empfänger im MIDI-Modul |
| `monk:plugin-route` | `pluginCommandRegistry.ts:324` | Empfänger im Routing |
- [ ] je Event: Listener ergänzen **oder** Befehl aus `pluginCommandRegistry` entfernen; Test „Befehl → sichtbare Wirkung".

### 2.4 Server-Meldungen, die der Client nie anzeigt (Socket)
- [ ] `rbac-denied` (`server/realtime.ts:932/948/955/967/1178`), `session-join-denied`, `store-rejected`, `main-out-update-rejected` (`realtime.ts`), `monitor-signal-denied` (`monitorSignaling.ts`), `session-reset` (`routes/sessionRoutes.ts:197`). Folge: Nutzer sieht bei verweigerter Übernahme/Änderung nichts. Fix: zentraler Listener mit Hinweis im UI; bei `session-reset` Zustand neu laden.

### 2.5 Plugin-Zustand in der Session (Regel: Einstellungen leben serverseitig, `pluginSettingsSync`)
- [ ] **drop**: kein `writePluginSettings('drop', …)`; Drop-Zustand (Pattern, Quantisierung, Loop) geht beim Halterwechsel verloren. Presets liegen im Studio-Speicher, der laufende Zustand nicht.
- [ ] **biblio**: Ordner, Suche, Seite nur lokaler `useState` (`LibraryTerminal.tsx:104-117`); kein Session-Stand.

### 2.6 KI-Kette (App → Pod-Rolle → Modell → Runtime-Handler)
Geprüft und **stimmig**: 22 Manifest-Modelle, alle einer Rolle in `pod-fleet.json` zugeordnet; `MODEL_POD` (`podRouting.ts`) deckt alle Modelle außer der Komponente `acestep-v15-shared` ab und stimmt mit der Flotte überein; jede Modell-ID ist im Runtime-Code bekannt; `warmup` wird in `pod_jobs.py:103` behandelt.
- [ ] **Aufgaben ohne Runtime-Handler:** `nlu` (Brain-Endpunkt `endpointRegistry.ts:85`, aber nirgends gesendet) und `multimodal` (`endpointRegistry.ts:108`, erlaubt in `server/routes/aiRoutes.ts:248`). Würde ein Client sie senden, antwortet der Pod „no handler for task". Fix: entfernen oder Handler ergänzen.
- [ ] Runtime-Handler `image.embed` (CLIP) wird von der App nie aufgerufen; `src/core/ai/vision/clipPipeline.ts` ist laut knip ungenutzt. Entscheiden: anbinden oder entfernen.
- [ ] **vis-Pod nicht verdrahtet:** Kein App-Code ruft die Pod-Endpunkte `/visual/*` auf; die App nutzt ihre eigene Visual-Pipeline (`server/visualStream.ts`). Der Pod wird gemietet, aber nicht genutzt (siehe `docs/FLEET_INTERFACES_AND_GATES.md`, I10).
- [ ] **Autostop/Wake ohne Vast-Schlüssel** auf dem App-Server (`fleetAutostop.ts:231/254`, `fleetWake.ts:120`): Pods werden von der App nicht beendet (I11).

## 3. P2 – Aufräumen und Optimierung

- [ ] `DropPresetStore.persistToStorage()` schreibt denselben Schlüssel zweimal in den Studio-Speicher (`largeSetJson` + `storageSetJson`, `src/core/drop/DropPresetStore.ts:226-240`); Kommentare sprechen noch von IndexedDB/localStorage, obwohl beides auf den Server geht. Einmal schreiben, Kommentare korrigieren.
- [ ] Clipboard-Menü (`src/components/Scratchpad.tsx:18`) öffnet nur per Maus-Hover; auf Touch-Geräten und per Tastatur nicht bedienbar → Klick/Fokus öffnen.
- [ ] Lint: 41 Warnungen in 15 Dateien halten `npm run lint` (`--max-warnings=0`) und damit `verify` auf `main` rot (`tests/llmRouterHardening.test.ts`, `tests/wan-test.runner.ts` u. a.).
- [ ] Workflow „Audio Flow" ist auf `main` rot (seit mindestens 2026-11-17); Ursache prüfen.
- [ ] knip (`npm run check:deadcode`): 342 ungenutzte Exporte, 173 ungenutzte Typen, 3 doppelte Exporte (`PianoRollTerminal`, `PianoRoll`, `TICKS_PER_16TH`), 3 nicht auflösbare Importe in `scripts/ice-recovery-live-proof.mjs` und `scripts/webgpu-live-proof.mjs`. Ungenutzte Dateien `src/core/ai/vision/clipPipeline.ts`, `tests/wan-test.runner.ts`; **kein** Löschkandidat: `src/core/visual/podScene.ts`, `i420Pack.ts` und `services/audiomonastry-ai-runtime/visual/scene.js` (werden von `scripts/build-vis-scene.mjs` verwendet bzw. erzeugt) → in `knip.jsonc` eintragen.
- [ ] deep-audit (`npm run audit:deep:static`): 91 Befunde, keiner kritisch (50 Duplikate, 35 ungenutzte Variablen, 3 `exhaustive-deps`); Gate rot nur wegen `project-gate`.
- [ ] `check:library-links` bricht ohne `.env` mit ENOENT ab → ohne `.env` sauber überspringen.

## 4. Geprüft, ohne Befund
- REST: alle 39 `/api`-Aufrufe aus `src/` treffen eine Server-Route (6 Treffer des Skripts waren Vorlagen-Pfade, Router-Präfixe bzw. das WebSocket-Upgrade `/api/main-audio` in `server/backendMainTransport.ts:136`). 54 Server-Routen werden nicht aus `src/` aufgerufen (Skripte, Beamer, Studio-Knoten).
- Bedienelemente: 357 Elemente in 97 Dateien; keine leeren oder „TODO"-Handler, keine dauerhaft deaktivierten Elemente; ohne Handler nur die drei in 1/2.1/3 genannten.
- EQ (`EQPluginTerminal.tsx:248` `updateToneShiftEQ`), DSP-Kompressor/Limiter-Werte (`DspRack.tsx:99-102`), Spatial-Pfadgeschwindigkeit, Synth-Transponierung, Main-Out-Regler im Mastering (`MasteringOverlay.tsx:180-184`): angebunden.
- Session-Persistenz vorhanden für 14 von 16 Plugins (Ausnahmen drop, biblio, siehe 2.5).

## 5. Grenzen dieser Prüfung
Statisch, ohne laufende App: Ob ein angebundener Wert hörbar das Richtige tut, prüft das nicht. Die Regler-Heuristik (`stateonly.py`) erkennt nur Werte, die nirgends neben einem Engine-Aufruf vorkommen; Treffer wurden einzeln nachgeprüft, Fehlalarme sind oben nicht aufgeführt. Werte, die indirekt (über ganze Zustandsobjekte) übergeben werden, können übersehen werden.

## 6. Prüfskripte (wiederholbar, schreiben nichts)
| Skript | prüft |
| --- | --- |
| `scripts/audit-wiring/routes.py` | `/api`-Aufrufe im Client ↔ Server-Routen |
| `scripts/audit-wiring/events.py` | Socket-/Bus-Events: gesendet ↔ empfangen |
| `scripts/audit-wiring/ai.py` | `AiTask` ↔ Runtime-Handler, Manifest ↔ Flotte ↔ `MODEL_POD` |
| `scripts/audit-wiring/ui-controls.cjs` | Bedienelemente ohne/mit leerem Handler, dauerhaft deaktiviert |
| `scripts/audit-wiring/stateonly.py` | Regler, deren Wert keinen Engine-Aufruf erreicht (Heuristik) |
