# Echtzeit-Audit 2026-10-07 · V2-Live-Pfad, Plugins, AI, Betrieb

> **Status:** Grundlage der Aufgaben `RT-AUDIT-*` in `MASTERTODOENDE.json`.
> **Ausgangs-Commit:** `653fa02` · **Messwerkzeug:** `npm run audit:rt` (`scripts/audit/rt-bench.ts`)
> **Regel für alle Agenten:** Diese Datei ist die Begründung, die To-Do ist der Auftrag. Wer einen `RT-AUDIT`-Punkt bearbeitet, liest zuerst den passenden Abschnitt hier.

## 0. Zusammenfassung

Die Infrastruktur ist gesund (tsc, ESLint, Boundary-Scan, 2511/2511 Vitest grün). Der **hörbare** Pfad hat aber Fehler, die man sofort hört und die keine bestehende Test-Suite findet, weil kein Test über mehrere Render-Blöcke prüft:

| # | ID | Befund | Messwert (Ausgangslage) | Schwere |
|---|---|---|---|---|
| 1 | RT-AUDIT-P0-001 | Stimmen brechen nach einem Block ab | Kick hörbar **2,67 ms** (soll ≥ 100 ms) | 95 % |
| 2 | RT-AUDIT-P0-002 | Allokationen + GC im Audio-Thread | **46 neue Arrays/Block**, GC bis **9,6 ms** | 90 % |
| 3 | RT-AUDIT-P0-003 | Swing verwirft Steps, Sample-Trigger auf Blockanfang | **7–8 von 16** Steps fehlen bei Swing > 0 | 85 % |
| 4 | RT-AUDIT-P0-004 | Masterkette verzerrt immer | **THD 17,4 %** bei −6 dBFS, 5,5 % bei −12 dBFS | 85 % |
| 5 | RT-AUDIT-P0-005 | Dropout-Erkennung blind, Meter tot | Chromium: Audio bei 35 % Echtzeit, **0** erkannte Lücken | 75 % |
| 6 | RT-AUDIT-P0-006 | itSynth (polyphon) unhörbar | Ausgang endet an nie verbundenem `GLOBAL_MASTER` | 75 % |
| 7 | RT-AUDIT-P0-007 | Kein Fehlerpfad im Worklet | 1 Exception = dauerhafte Stille, keine Meldung | 70 % |
| 8 | RT-AUDIT-P1-008 | Session-State nur im RAM | Neustart = alle Plugin-Settings + Studio-Store weg | 70 % |
| 9 | RT-AUDIT-P1-009 | Sample-Resampling Nearest-Neighbor | **SINAD 13,6 dB** (5 kHz, 44,1→48 kHz) | 70 % |
| 10 | RT-AUDIT-P1-010 | Große Daten werden im Audio-Thread geklont | Jeder Pad-Schlag sendet das **ganze Sample** erneut | 75 % |

Weitere Befunde (P1/P2) stehen in Abschnitt 3.

---

## 1. Die zehn größten Punkte im Detail

Jeder Abschnitt: **Fundstelle → Wirkung → Ursache → Sofort-Fix → bessere Methode → Akzeptanz.**

### 1.1 RT-AUDIT-P0-001 · Stimmen brechen nach einem Block ab (95 %)

- **Fundstelle:** `src/core/audio/live/V2SinkEngine.ts` `render()` (Kanäle ohne Event werden auf Stille gesetzt, ~Z. 430) und `renderStepBurst()` (~Z. 510, Puffer nur so lang wie der aktuelle Block). Aufrufer: `v2SinkProcessor.process()` (Sequencer-Steps), `synthTrigger` aus `instrumentNoteBridge.noteOn`, `audioEngine.playSynthesisInstrument`, `audioEngine.triggerEvent` (Fallback ohne Sample).
- **Wirkung:** Jeder Synth-Step, jeder Pad-Schlag ohne Sample und jede Instrument-Note ist genau 128 Samples (2,67 ms) lang: ein Klick statt Kick/Bass/Lead. Zusätzlich teilen sich alle Bass-Stimmen einen globalen Filterzustand (`bassFilterState`).
- **Ursache:** Das Design kennt „Events pro Block“, aber keinen Stimmzustand über Blockgrenzen.
- **Sofort-Fix = bessere Methode:** Persistenter **Voice-Pool** (Standard jeder Sampler-/Synth-Engine, z. B. JUCE `Synthesiser`): feste Zahl vorallokierter Stimmen (32) mit eigenem Zustand (Phase, Hüllkurve, Filter, Rauschen, Startoffset). Stimmen laufen, bis die Hüllkurve < −80 dB fällt. Voice-Stealing (älteste), Choke für monophone Rollen (Kick/Bass) mit 64-Sample-Fade.
- **Akzeptanz:** `audit:rt` Zeile `RT-AUDIT-P0-001` ≥ 100 ms; Tests für Polyphonie, Choke ohne Klick, Mute, Pool-Überlauf.

### 1.2 RT-AUDIT-P0-002 · Allokationen und GC im Audio-Thread (90 %)

- **Fundstelle:** `src/core/audio/BufferPool.ts` (`release()` wird nirgends aufgerufen → jedes `acquire()` alloziert), alle Nodes in `nodes/basicNodes.ts`, `nodes/processingNodes.ts`, `V2OutputGraph`; dazu pro Block `new Set`, `[...a, ...b]`, `{...sample}`, `renderSampleBlock` (2 neue `Float32Array`), `renderToneBlock`, `V2MonitorGraph.render()` (neues Ergebnisobjekt), `ParametricEqNode` (`bands.map` + `co.slice` pro Block), `DspFilterNode` (Koeffizienten-Array pro **Sample**), `V2SampleClock.processBlock` (Array + Objekte pro Block).
- **Wirkung (gemessen, 60 s):** 46 neue Arrays/Block (1.035.000 total), 2,6 GC/s, längste Pause 9,6 ms = 3,6× Blockbudget, p99,9 = 4,8 ms, 85 Blöcke über Budget, obwohl die mittlere Last nur 14 % beträgt. **Die GC-Pausen begrenzen die Latenz, nicht die CPU.** Ohne Fix braucht es ≥ 512 Frames Gerätepuffer (≈ 10,7 ms).
- **Sofort-Fix:** Pro Ausgangsport einen festen Puffer beim `compile()` anlegen (`ensureBuffers(channels, length)`), `process()` schreibt in diesen Puffer; `BufferPool` entfernen. Alle Hilfsstrukturen (Event-Arrays, Kanal-Flags, Ergebnisobjekte) als Felder vorallozieren.
- **Bessere Methode (mittelfristig):** Den Mix-/DSP-Kern als **Rust→WASM** im selben Worklet (Grundgerüst existiert: `src/audio/wasm/dspKernel_rs`, Vision `V1.1`). WASM-Linearspeicher hat keinen GC → deterministische Laufzeit, dazu SIMD. **Reihenfolge:** erst JS allokationsfrei machen (schnell, messbar), WASM nur portieren, wenn `audit:rt` bei 4×8 Kanälen das Budget nicht hält.
- **Akzeptanz:** `RT-AUDIT-P0-002/*`: 0 neue Arrays/Block, GC < 0,2/s, keine Pause ≥ 1 ms, p99,9 < 1,33 ms, 0 Blöcke über Budget.

### 1.3 RT-AUDIT-P0-003 · Swing verwirft Steps, Sample-Trigger jittern (85 %)

- **Fundstelle:** `V2SampleClock.processBlock()` (~Z. 95: Swing-Versatz auf den Frame), `v2SinkProcessor.process()` (~Z. 293: `startSample >= length → continue`), `engine.triggerSample()` ohne `startSample`.
- **Wirkung:** Bei Swing 0,2/0,5 fehlen alle ungeraden Steps (gemessen 8 gespielt, 7 verworfen). Step-getriggerte Samples starten bis 2,67 ms zu früh (Blockanfang).
- **Bessere Methode:** **Event-Queue mit absoluten Frames** (Ringpuffer fester Kapazität): Die Clock plant, der Processor feuert jedes Event in dem Block, in den sein Frame fällt, mit exaktem Startsample. Das ist das Muster aller sample-genauen Sequencer (MIDI-Event-Listen mit Sample-Offset in VST/CLAP/AU).
- **Akzeptanz:** 32/32 Steps bei Swing 0,5 über 2 Takte, ungerade Steps auf ±0 Samples; Sample startet exakt am Startsample.

### 1.4 RT-AUDIT-P0-004 · Masterkette verzerrt immer (85 %)

- **Fundstelle:** `nodes/processingNodes.ts` `MasteringNode.process()` (Verstärkung pro Sample aus dem Momentanpegel), `nodes/basicNodes.ts` `MasterSumNode` (`Math.tanh(v) * 0.98` immer aktiv). Der Legacy-Worklet `masteringProcessor.ts` (mit Delay-Line) hängt **nicht** im Live-Pfad und hat denselben Fehler (Detektor liest das verzögerte statt des kommenden Signals).
- **Wirkung (gemessen, Default-Einstellungen):** THD 0,13 % bei −18, **5,5 % bei −12, 17,4 % bei −6 dBFS**; −6 dBFS kommt mit −10,3 dBFS heraus. Die Latenzanzeige rechnet zusätzlich 5 ms Lookahead ein, die es im V2-Pfad nicht gibt (`audioEngine.getLatencyBudgetMs`).
- **Ursache:** Ohne Attack/Release-Glättung verhält sich ein Kompressor, der pro Sample aus |x| regelt, wie ein **statischer Waveshaper**; `tanh` auf dem Summenbus färbt jedes Signal.
- **Bessere Methode (Fachliteratur, Standard):**
  1. Kompressor: Feed-forward, Pegeldetektor im **log-Bereich** mit *smooth decoupled peak detector* (Attack/Release getrennt), Gain-Computer mit Soft-Knee (Giannoulis/Massberg/Reiss, *Digital Dynamic Range Compressor Design*, JAES 2012).
  2. Limiter: **echter Lookahead** (5 ms Delay-Line, Detektor auf dem *Eingang*, gleitendes Minimum der Ziel-Gains über das Lookahead-Fenster, Attack-Rampe = Lookahead, exponentielles Release).
  3. True-Peak: 4× Oversampling (polyphasiges FIR) nach ITU-R BS.1770-4 statt linearer Interpolation.
  4. Summenbus linear lassen; Clipping-Schutz nur als harte Sicherung ≥ 0 dBFS hinter dem Limiter.
  5. PDC: Die Clock kompensiert den Lookahead bereits (`v2Pdc.ts`); nach dem Fix gilt die Kompensation wieder wirklich.
- **Akzeptanz:** THD < 0,1 % bei −18 dBFS, < 0,5 % bei −6 dBFS; Ausgang nie > Ceiling (Test mit Sinus-Burst +6 dBFS); Latenzanzeige = reale Graph-Latenz.

### 1.5 RT-AUDIT-P0-005 · Dropout-Erkennung blind, Meter tot (75 %)

- **Fundstelle:** `v2SinkProcessor.trackFrameGap()` und `analyzerProcessor.ts` erkennen Dropouts an Sprüngen in `currentFrame`/`currentTime`. `analyzerNode` und `lufsNode` werden erzeugt, aber **nie angeschlossen** (`audioEngine.ts` init) → LUFS-Anzeigen (MasterRack, MasteringOverlay, Masterplayer) und `sharedWaveformBuffer` zeigen Konstanten. Der Peak-Meter (`core/audio/mainLevel.ts`) fragt alle 60 ms 1024 Samples ab und liest nur jedes zweite Sample.
- **Wirkung (in Chromium gemessen, `scratch browser_probe`):** Bei 4 bzw. 8 ms CPU pro Block lief die Audio-Uhr mit 72 % bzw. 35 % Echtzeit (massive Aussetzer), `currentFrame` zeigte **0 Lücken**. Der Render-Zähler zählt Blöcke, nicht Wanduhrzeit; er kann Underruns grundsätzlich nicht sehen.
- **Bessere Methode:**
  1. **Drift Audio-Uhr gegen Wanduhr:** Main-Thread: `ctx.getOutputTimestamp()` liefert Paare `(contextTime, performanceTime)`; wächst `Δperformance − Δcontext` über 1 Quantum, gab es einen Underrun. Im Worklet zusätzlich `Date.now()` gegen `currentFrame/sampleRate` (über 250 Blöcke gemittelt, 1-ms-Auflösung reicht für die Drift).
  2. Messwerte im Sink selbst berechnen (Peak, True-Peak, LUFS-M/S nach BS.1770 mit K-Filter, Korrelation) und per **SharedArrayBuffer** (COOP/COEP sind gesetzt, `crossOriginIsolated` = true) an die UI geben; die UI liest mit `requestAnimationFrame`, kein Polling-Verlust.
- **Akzeptanz:** Künstliche Überlast im Test-Worklet → Underrun-Zähler > 0; ohne Überlast 0 über 60 s. LUFS ändert sich mit dem Signal (Test: −23-LUFS-Sinus → Anzeige −23 ± 0,5).

### 1.6 RT-AUDIT-P0-006 · itSynth unhörbar, Instrumente nur als Klick (75 %)

- **Fundstelle:** `audioEngine.tryInitItSynthWorklet()` verbindet `itSynthNode → Tone.Gain → channelStrip.inputNode('channel4') ?? masterBuses.GLOBAL_MASTER`; `GLOBAL_MASTER` (`audioEngine.ts:446`) ist ein `Tone.Volume`, das nie mit `ctx.destination` verbunden wird („kein zweiter Pfad“, Phase 9). Chromium rendert unverbundene Knoten nicht.
- **Wirkung:** Der einzige polyphone, sample-genaue Instrument-Synth (502 Zeilen DSP) ist unhörbar. Hörbar ist nur der monophone V2-Burst (siehe 1.1) auf `channel4`/`channel8`.
- **Bessere Methode:** Instrument-Stimmen **im Sink** rendern (eine Engine, ein Thread, keine Synchronisationsprobleme). Konkret: `itSynth`-Stimmklasse als reine TS-Klasse aus dem Worklet herauslösen (wie `SfzVoiceBank`) und im `v2SinkProcessor` als externe Kanalquelle mischen (gleiches Muster wie SFZ, ~Z. 255). Der separate itSynth-Knoten entfällt.
- **Akzeptanz:** Note-On über `playSynthesisInstrument` → Kanal 4 hörbar mit Release; 8 gleichzeitige Noten hörbar; `noteOff` startet Release.

### 1.7 RT-AUDIT-P0-007 · Kein Fehlerpfad im Audio-Thread (70 %)

- **Fundstelle:** `v2SinkProcessor.process()` ohne `try/catch`; im ganzen Code kein `onprocessorerror`. Beispiel-Auslöser: `V2ChannelStripGraph.setSourceBuffer()` nutzt `this.sources.get(track)!` (unbekannter Kanal → TypeError im Render-Pfad).
- **Wirkung:** Nach einer einzigen Exception schaltet Chromium den Prozessor ab; die gesamte DAW ist stumm, niemand wird informiert, nichts startet neu.
- **Bessere Methode:** Mehrstufige Fehlerisolation.
  1. `process()` fängt Fehler, gibt Stille aus, meldet **einmal** `{type:'render-error'}` und zählt mit.
  2. Main-Thread: `node.onprocessorerror` und `render-error` → Sink neu aufbauen (`disconnect` + `connect` + `syncV2FromV1`), Hinweis in der UI.
  3. Mittelfristig Fehlerdomänen trennen: Quellen-Gruppen als eigene `AudioWorkletNode`s im selben Graphen. Knoten im selben Graphen werden im selben Render-Quantum verarbeitet, also **ohne zusätzliche Latenz**; ein Fehler legt dann nur seine Gruppe still.
- **Akzeptanz:** Test injiziert eine Exception in `render()` → Ausgang Stille, Meldung genau einmal, nächster Block läuft wieder; Main-Thread baut nach `processorerror` neu auf (Unit-Test mit Fake-Node).

### 1.8 RT-AUDIT-P1-008 · Session-State nur im RAM (70 %)

- **Fundstelle:** `server/sessionRuntime.ts` (Default `MemorySessionPersistence`); Redis nur bei `REDIS_URL` (`server/realtime.ts:251`). `.env.hetzner.example:99` hat `REDIS_URL` auskommentiert, `docker-compose.hetzner.yml:195` aktiviert Redis erst ab 2 App-Knoten.
- **Wirkung:** Weil „nichts auf Geräten“ gilt, liegen Plugin-Settings und Studio-Store nur in der Session. Jeder Neustart, Deploy oder OOM löscht alles.
- **Bessere Methode:** Redis mit **AOF (`appendonly yes`, `appendfsync everysec`)** auch auf dem Einzelknoten (Code für Restore existiert: `restoreFromRedis`). Alternative ohne Redis: atomare Datei-Persistenz (`writeFile` temp + `rename`) als Rückfall. Beide asynchron, wie heute entprellt (250 ms).
- **Akzeptanz:** Server-Neustart im Integrationstest → Plugin-Settings und Store-Einträge identisch; Startlog meldet „Session wiederhergestellt (rev=…)“.

### 1.9 RT-AUDIT-P1-009 · Sample-Resampling per Nearest-Neighbor (70 %)

- **Fundstelle:** `V2SinkEngine.renderSampleBlock()` (`state.left[Math.floor(position)]`).
- **Wirkung:** SINAD 13,6 dB bei 5 kHz, 44,1→48 kHz: deutliches Aliasing bei jedem Bibliotheks-Sample (meist 44,1 kHz).
- **Bessere Methode:** **Beim Laden** auf die Context-Rate umrechnen, außerhalb des Audio-Threads (`OfflineAudioContext` mit Ziel-Rate: browsereigener Resampler, hohe Qualität, kein eigener Code). Dann spielt der Sink mit Rate 1 ohne Interpolation. Für Pitch/Rate ≠ 1 im Sink 4-Punkt-Hermite (oder gefensterter Sinc für HQ).
- **Akzeptanz:** `RT-AUDIT-P1-009` SINAD ≥ 60 dB.

### 1.10 RT-AUDIT-P1-010 · Große Daten werden im Audio-Thread geklont (75 %)

- **Fundstelle:** `V2LiveSink.post()` sendet `sample-set` (L/R-Arrays) und `sfz-load` (Text + Quellen) **ohne Transfer-Liste**; `v2SinkProcessor` parst SFZ im `onmessage` (Audio-Thread, ~Z. 190). Zusätzlich ruft `audioEngine.triggerEvent()` (~Z. 1420) bei **jedem Pad-Schlag** `bridgeAudioBufferToV2()` auf und schickt das komplette Sample erneut.
- **Wirkung:** Strukturiertes Klonen wird im **empfangenden** Thread deserialisiert, hier also im Audio-Thread: ein 5-MB-Sample pro Schlag kostet dort Millisekunden, also Dropouts genau beim Spielen.
- **Bessere Methode:**
  1. **Sample-Pool mit IDs:** Sample einmal laden (Transfer: `postMessage(msg, [left.buffer, right.buffer])`), danach nur `sample-trigger {channel, id}`. Noch besser: Samples in einem `SharedArrayBuffer`-Pool, Worklet bekommt nur Offset/Länge.
  2. **Steuerdaten (Gain, Pan, Trigger) über einen lock-freien SPSC-Ringpuffer im SharedArrayBuffer** (Muster `ringbuf.js`, Atomics) statt `postMessage`: keine Allokation, keine Event-Loop-Abhängigkeit im Worklet.
  3. SFZ im Main-Thread oder einem Worker parsen; ins Worklet nur fertige Regionen-Tabellen schicken.
- **Akzeptanz:** `triggerEvent` sendet nachweislich kein Sample mehr (Unit-Test auf `post`-Aufrufe), `sample-set` nutzt Transfer (Quell-Array danach `byteLength === 0`), kein SFZ-Parsing im Processor.

---

## 2. Gibt es insgesamt bessere Methoden? Architektur-Bewertung

| Thema | Heute | Besser | Empfehlung |
|---|---|---|---|
| Ort der Engine | Browser des mixerMONK-Halters (V2-Sink), Stream per WebRTC an `/master-out` | Server-Render (AGENTS §1.1 „Main Sound im Backend“) würde jedem Performer Netz-Latenz aufzwingen | **Browser behalten** (Halter hört 0 ms Netz-Latenz). AGENTS §1.1 per ADR an die Realität anpassen. |
| Steuer-IPC UI → Engine | `MessagePort.postMessage` (Klonen + Allokation im Audio-Thread) | SPSC-Ringpuffer im SharedArrayBuffer (Atomics), SAB ist verfügbar | Umstellen (RT-AUDIT-P1-010, Schritt 2). ZeroMQ/gRPC/Shared Memory zwischen Prozessen sind hier ohne Nutzen: alles läuft in einem Browser-Prozess. |
| Speicher im Audio-Thread | JS mit GC | Vorallozierung (kurzfristig), Rust/WASM-Kern (mittelfristig) | Erst JS allokationsfrei (P0-002), WASM nur bei Budget-Verfehlung. |
| Stimmen/Events | Burst pro Block | Voice-Pool + Event-Queue mit Sample-Offset | P0-001/P0-003. |
| Dynamics | Momentanwert-Regelung, `tanh` immer an | Log-Domain-Detektor, echter Lookahead-Limiter, BS.1770-True-Peak | P0-004. |
| Plugin-Format | 16 interne TS-Adapter; `process()` nur im Offline-Bounce | Live-Graph = Plugin-Runtime (je Plugin ein Knoten); Drittanbieter über **WAM 2.0** (Web Audio Modules) | `PLUGIN-V2-C1` mit P0-007 zusammendenken (Fehlerdomänen). VST3/CLAP/AU sind im Browser nicht hostbar. |
| Dropout-Diagnose | Frame-Sprünge (blind) | Drift Wanduhr/Audio-Uhr über `getOutputTimestamp()` | P0-005. |
| Persistenz | RAM | Redis AOF auf Einzelknoten | P1-008. |
| AI | Router lokal-zuerst; Cloud-Wege per Schalter | Runpod-Brain (Qwen 3.8 int4, vLLM, Streaming, warm), DeepSeek V4 nur per Positivliste | RT-AUDIT-P1-014/015. |

---

## 3. Weitere Befunde (P1/P2)

| ID | Befund | Fundstelle | Schwere |
|---|---|---|---|
| RT-AUDIT-P1-011 | EffectNode/effectProcessor teilen Delay-Lines für L und R (Übersprechen, halbe Delay-Zeiten) | `processingNodes.ts` `EffectNode.process`, `worklets/effectProcessor.ts` | 60 % |
| RT-AUDIT-P1-012 | Latenz-Einstellung wirkungslos (`latencyHint`/Sample-Rate nie angewendet), Latenzanzeige rechnet 5 ms Phantom-Lookahead | `compat/nativeAudioKit.ts:27`, `audioEngine.applyLatencyProfile`, `getLatencyBudgetMs` | 55 % |
| RT-AUDIT-P1-013 | Master-Out-Producer ohne `codecOptions` (Opus mono/Standardbitrate, im Code geprüft) | `core/transport/MediasoupTransport.ts:148,159` | 55 % |
| RT-AUDIT-P1-014 | AI-Isolation: Orchestrator-`CerebrasProvider` (`nlu`) umgeht die Lokal-Sperre; Sperre nur alles/nichts; HF-Voice-Endpoint und Replicate-Stems als Cloud-Reste | `orchestrator/providerRouter.ts:64`, `LlmRouter.rankProviders`, `routes/voiceRoutes.ts`, `routes/stemRoutes.ts` | 60 % |
| RT-AUDIT-P1-015 | Brain: Qwen 3.8 int4 nicht im Manifest, Streaming fehlt, Kaltstart durch `idleTimeoutSeconds: 15` | `model_manifest.json` (roles.brain), `handlers_runpod.py`, `LlmRouter` | 55 % |
| RT-AUDIT-P2-016 | Parameter-Zipper: Gain/Pan/EQ springen pro Block | `basicNodes.ts`, `processingNodes.ts` | 40 % |
| RT-AUDIT-P2-017 | DspFilterNode rechnet Koeffizienten pro Sample (mit Allokation) | `processingNodes.ts` `DspFilterNode` | 45 % |
| RT-AUDIT-P2-018 | Demucs-OLA blendet erste/letzte 1,95 s jedes Stems aus; OLA im Main-Thread | `src/ai/localDemucs.ts:138` | 50 % |
| RT-AUDIT-P2-019 | Torch-Drift: AI-Image 2.5.1 (Hetzner, `simulated`) vs. Runpod ≥ 2.6 | `services/audiomonastry-ai-runtime/Dockerfile`, `Dockerfile.runpod` | 45 % |
| RT-AUDIT-P2-020 | Tote Pfade: Rust-`audio-runtime`, `WasmBackend`, Legacy-Worklets ohne Anschluss | `services/audio-runtime`, `core/audio/backends/WasmBackend.ts`, `audioEngine` init | 20 % |
| RT-AUDIT-P2-021 | Mixer fest auf 8 Kanäle (`V2_CHANNELS`) | `core/audio/V2StudioGraph.ts` | 40 % |
| RT-AUDIT-P2-022 | Test-Lücke: keine Mehrblock-, THD-, Stereo-, Resampling-Tests | `tests/` | 50 % |

---

## 4. Messungen (Ausgangslage, reproduzierbar)

```bash
npm run audit:rt            # Tabelle mit SOLL-Grenzen
npm run audit:rt -- --gate  # Exit 1, solange eine Grenze verletzt ist
```

Ausgangslage 2026-10-07 (`653fa02`): **1/12 Grenzen eingehalten**.

| Messung | Wert | SOLL |
|---|---|---|
| Kick hörbar | 2,67 ms | ≥ 100 ms |
| Swing 0,5: verworfene Steps | 8 | 0 |
| Neue Pool-Arrays pro Block | 46 | 0 |
| Längste GC-Pause | 4–9,6 ms | < 1 ms |
| GC pro Sekunde | 2,5 | < 0,2 |
| Renderzeit p99,9 | 2,1–4,8 ms | < 1,33 ms |
| THD −18 / −6 dBFS | 0,13 % / 17,4 % | < 0,1 % / < 0,5 % |
| EffectNode Energie rechts (Impuls links) | 0,435 | < 1e-9 |
| Resampling-SINAD | 13,6 dB | ≥ 60 dB |

Zusätzlich gemessen (nicht im Skript, Werkzeug bei Bedarf neu schreiben):
- **Skalierung:** 1 Engine mit allen Master-Inserts 14 % Budget; 4×8 Kanäle 55 % (144/3750 Blöcke über Budget); 8×8 Kanäle 121 % → Dauer-XRuns.
- **Chromium 1194 headless, Fake-Gerät, 44,1 kHz:** `interactive` 10 + 32 ms, `playback` 23,2 + 72 ms. Überlast 4/8 ms pro Block → Audio-Uhr 72 %/35 % Echtzeit, `currentFrame`-Lücken: 0.
- **Theoretische Latenz bei 48 kHz:** 128 Frames 2,67 ms · 256: 5,33 · 512: 10,67 · 1024: 21,3 ms.
- **LLM (nur Entwicklungs-Provider, nicht Produkt):** DeepSeek v4-flash TTFT 0,9–1,3 s. Runpod-Brain nicht gemessen (kein `RUNPOD_API_KEY` in der Agent-Umgebung).

## 5. Nicht verifiziert

- Klangwirkung von RT-AUDIT-P1-013 (Opus mono) nur aus dem Code abgeleitet.
- Echte Hardware-Latenz (nur Fake-Audiogerät).
- Runpod-Brain-Latenz, Demucs-Laufzeit (Modell nicht im Repo).
