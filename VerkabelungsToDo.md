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
- [ ] knip (`npm run check:deadcode`): 342 ungenutzte Exporte, 173 ungenutzte Typen, 3 doppelte Exporte (`PianoRollTerminal`, `PianoRoll`, `TICKS_PER_16TH`), 3 nicht auflösbare Importe in `scripts/ice-recovery-live-proof.mjs` und `scripts/webgpu-live-proof.mjs`. Ungenutzte Dateien `src/core/ai/vision/clipPipeline.ts`, `tests/wan-test.runner.ts`; **kein** Löschkandidat: `services/audiomonastry-ai-runtime/visual-src/podScene.ts`, `i420Pack.ts` und `services/audiomonastry-ai-runtime/visual/scene.js` (werden von `scripts/build-vis-scene.mjs` verwendet bzw. erzeugt) → in `knip.jsonc` eintragen.
- [ ] deep-audit (`npm run audit:deep:static`): 91 Befunde, keiner kritisch (50 Duplikate, 35 ungenutzte Variablen, 3 `exhaustive-deps`); Gate rot nur wegen `project-gate`.
- [ ] `check:library-links` bricht ohne `.env` mit ENOENT ab → ohne `.env` sauber überspringen.
- [ ] **Vorladelisten veraltet** (`endpointRegistry.ts` `GPU_ROLES[*].preload`, gefunden mit `scripts/sim/app-call-check.ts` am 2026-11-19): brain nennt `qwen3-30b-a3b-awq` (Flotte: `qwen38-27b-fp8`), ears 6 Modelle ohne Pod (`whisper-large-v3`, `mert-v2-330m`, `qwen2-audio-7b`, `pyannote-diarization`, `ast-audioset`, `essentia`), voiceGen `qwen3-tts-06b-base`, music `acestep-v15-xl-sft`, orchestrator `qwen3-8b`. Ohne Laufzeitwirkung (Pod ignoriert die Liste bei `warmup`, `pod_jobs.py:103`), aber falsche Anzeige/Doku. An `deploy/gpu/pod-fleet.json` angleichen, Drift-Test ergänzen.
- [ ] **Fehlender Pod-Preis blockt alle KI-Aufträge** mit „… kosten Infinity €/h“ (`podStartTriggers.ts:140`, gewolltes fail-closed). Die Startskripte setzen `VAST_POD_EUR_PER_HOUR_<ROLLE>` (`vast-pods.py:701`, `finalize-runtime-from-probe.py:45`); bei Handkonfiguration fehlt er leicht. Meldung verständlicher machen („Preis für Pod X fehlt“).

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
| `scripts/sim/*` | Ersatz-Flotte und Laufzeitprüfung der KI-Kette; Testauftrag: `docs/VERKABELUNG_TESTAUFTRAG.md` |

## 7. Architektur und Audio-Engine: Analyse aus Sicht eines einzelnen Samples (2026-11-19)
Blickwinkel: Wir folgen einem Sample vom Plugin im Browser bis zum Main-Ausgang und fragen bei jedem Schritt nur: *Wie viel Zeit kostet es, wie oft wird es kopiert, wer darf es verändern?* Alle Punkte sind am Code abgelesen, **nicht gemessen**. Vor jeder Änderung braucht es eine Messung; RT-/Audio-Gates und Schwellen bleiben unverändert.

Weg des Samples: Plugin-Ausgang → `backendMainSourceTap.ts` (SharedArrayBuffer-Ring) → `backendMainPublisher.ts` (bei Bedarf Abtastratenwandlung, PCM24, 10-ms-Pakete, WebSocket) → `server/backendMainTransport.ts` → Worker `backendMainWorker.ts` → `backendMainMixer.ts` (100-ms-Block) → `backendMainProcessors.ts` (EQ/DSP/FX/Spatial/Mixer/Master/Limiter) → PCM24 oder FLAC → Empfänger.

### 7.1 Qualität (höchste Priorität laut R9)
- [ ] **Harte Begrenzung vor dem Master.** In `backendMainPublisher.ts:66` wird jedes Plugin-Sample auf ±1,0 begrenzt, **bevor** es zum Server geht. Übersteuert ein Plugin (Summe von Stimmen, Resonanz), entsteht digitales Clipping im Beitragskanal. Der Master-Limiter (mit True-Peak) sieht diese Übersteuerung nie und kann sie nicht sauber auffangen. Vorschlag: Beitragskanal mit Reserve übertragen (z. B. PCM24 mit fester −12-dB-Vorabsenkung und Ausgleich im Mixer, oder Float32-Transport), dazu einen Zähler „Clipping im Beitragskanal“ je Plugin in perforMONK.
- [ ] **Fehlende Samples werden still mit Nullen gefüllt.** `backendMainMixer.ts` zählt `missingSamples`, mischt die Lücke aber als harte Stille ein. Das klickt hörbar. Vorschlag: kurze Ein-/Ausblendung (1–2 ms) an Lückenrändern; Lücken je Quelle in perforMONK anzeigen.

### 7.2 Funktionalität und Stabilität
- [ ] **Ein ffmpeg-Prozess je 100-ms-Block.** `encodeMainFlac()` (`backendMainTransport.ts:31`) startet für jeden Block einen neuen Prozess, also 10 Prozessstarts pro Sekunde und Session (bis 32 Sessions). Der Schalter auf RawPCM bei langsamer Kodierung greift erst nach einer Verspätung. Vorschlag: einen dauerhaften Encoder je Session (ein ffmpeg mit fortlaufendem FLAC-Strom, an Frame-Grenzen aufgeteilt) oder eine FLAC-Bibliothek im Worker. Bis dahin auf ausgelasteten Hosts RawPCM als Standard.
- [ ] **Berechtigungsprüfung im Ausgabepfad mit `await`.** `publish()` ruft `options.authorize()` je Quelle und je Empfänger **zweimal pro Block** auf (vor und nach der Kodierung). Liegt dahinter ein Netz- oder Redis-Zugriff, schwankt der Ausgabetakt. Vorschlag: Prüfung pro Generation zwischenspeichern; nur bei geändertem Delegations- oder Sperr-Ereignis neu prüfen (das Ereignis kommt ohnehin über den Koordinator). Fail-closed bleibt erhalten, wenn ein Widerruf den Speicher sofort leert.

### 7.3 Latenz (laut R9 nachrangig, aber Mandat „möglichst latenzfrei“)
- [ ] **Blockraster 100 ms im Main-Mixer** (`backendMainWorker.ts:10`, `frames = sampleRate / 10`), obwohl die Beiträge in 10-ms-Paketen kommen. Das Raster kostet bis zu 100 ms Taktung plus Kodierzeit, zusätzlich zum 1-s-Vorlauf (R10). Vorschlag: Blockgröße einstellbar machen (z. B. 20 ms bei RawPCM, 100 ms bei FLAC), vorher mit `audit:rt` die CPU-Last je Blockgröße messen.

### 7.4 Effizienz (Speicherbereinigung und Kopien im heißen Pfad)
- [ ] **Browser-Hauptthread:** `backendMainPublisher.ts` sammelt Samples in JS-Zahlenarrays (`pending[channel].push`) und kopiert sie pro Paket mit `slice()`. Bei 96 kHz Stereo sind das rund 192 000 Zahlen pro Sekunde und Plugin. Folge: häufige Speicherbereinigung, die die UI ruckeln lässt. Vorschlag: fester Float32-Ring mit Lese- und Schreibzeiger, ein vorab reservierter `Uint8Array` je Paket.
- [ ] **Server-Mixer:** je Block und Spur eine neue `Float32Array`, je Paket ein `Buffer.from`-Kopie, `sort()` bei jedem Paket, Dekodierung per `readIntLE()` je Sample (`backendMainMixer.ts:47–66`), Kodierung per `writeIntLE()` je Sample. Vorschlag: Puffer je Spur wiederverwenden, Segmente sortiert einfügen statt nachsortieren, 24-Bit-Wandlung per Byte-Arithmetik (wie im Publisher). Erwartung: deutlich weniger CPU je Session, wichtig bei 4 Beitragenden × 96/192 kHz.
- [ ] **Abtastratenwandler:** `backendMainResampler.ts:33` legt je Aufruf zwei neue Arrays an. Ausgabepuffer wiederverwenden.
- [ ] `backendMainProcessors.ts:117`: `JSON.stringify` als Konfigurations-Signatur je Block und Prozessor. Durch einen Vergleich von `epoch` und `active` ersetzen.

### 7.5 Architektur
- [ ] **Zwei Mastering-Wahrheiten.** Der Browser-Monitor (`V2MonitorGraph.ts:295`, Limiter-Lookahead + DSP-Latenz) und das Backend-Main (`backendMainProcessors.ts`) haben jeweils eigene Master- und Limiter-Ketten. Laut R9/R10 ist Backend-Mastering noch Integrationsarbeit. Vorschlag: eine gemeinsame Parameterquelle (Session-Einstellungen von `master`) und ein Drift-Test, der beide Ketten mit demselben Testsignal vergleicht (Pegel, True-Peak, Latenz in Samples).
- [ ] **PDC über die Netzstrecke fehlt als Kennzahl.** Die Monitor-Latenz wird berechnet, die Main-Strecke meldet `lagMs`. Es gibt aber keine Gesamtzahl „Plugin → Main in Samples“ je Quelle. Das Mandat verlangt Messen, Anzeigen und Ausgleichen. Vorschlag: `startFrame` der Quelle mit dem Main-Frame verrechnen, als Latenz je Quelle in perforMONK anzeigen und daraus einen Ausgleich je Quelle ableiten.
