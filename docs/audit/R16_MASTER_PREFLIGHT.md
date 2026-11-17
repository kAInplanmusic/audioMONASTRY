# R16 Phase2 – Vorabprüfung abgeschlossen, Implementierung durch P1 gesperrt

Stand: 15.11.2026, Europe/Berlin. Reviewbranch `fix/backend-mastering-r16`.
Basis `f432c18`, mit Produktfix `d35535a` als Vorfahr. Der auf dem Testhost
verwendete R15-Stand `ac2d37ff87e34a0a5754564b9e6d9d0c4238a608` hat gegenüber
`f432c18` keine abweichenden Dateien unter `server/` oder `src/`.
Vorhandener Hetzner CCX23/176142753, hel1, 4 vCPU/16 GB; kein Upgrade,
keine neue Provisionierung. Kein main-Merge, RT-Gate oder neuer Adapter.
Keine Modell-Subagenten verwendet.

**Ergebnis: P1 rot.** Sechs echte Quellen laufen mit zusätzlicher
12-Band-Stereo-EQ-Last länger als 60 Sekunden durch. Die gemessene gesamte
Testhost-CPU überschreitet jedoch 3,8 vCPU. Deshalb keine Produktimplementierung.
Die Backend-Waveform, der neue Main-Monitor und die Entkopplung der Master-
Berechtigung sind weiterhin offen. Die bestehenden R15-Ergebnisse bleiben
historisch unverändert; dieser zusätzliche EQ-Vorlauf ist ein eigener Versuch.

## 1. P1 – Quelle, Banddefinition und CPU vor Produktcode

Die zwölf Bänder stammen aus dem bisherigen masterMONK-Browser-Preset:
[`MASTERING_PRESETS.techno_club.tone_shift.bands`](../../src/data/masteringPresets.ts#L6).
`MasterRack` verwendet ohne gespeichertes Preset den ersten Eintrag
([MasterRack.tsx:18](../../src/components/master/MasterRack.tsx#L18)). Andere
Presets enthalten andere Frequenzen/Q-Werte; es gibt bisher keine gemeinsame
unveränderliche 12-Band-Backend-Definition. Der bestehende Standard-EQ-Kernel
hat hingegen drei Bänder ([processingNodes.ts:191](../../src/core/audio/nodes/processingNodes.ts#L191)).

Für diesen CPU-Vorlauf wurden die folgenden zwölf Frequenzen/Q-Werte des
bestehenden Standardpresets verwendet. Fehlender Filtertyp bedeutet `peaking`:

| Band | Frequenz Hz | Q | Typ | Test-Gain dB |
|---|---:|---:|---|---:|
| 1 | 40 | 1,5 | lowshelf | +3 |
| 2 | 80 | 2,0 | peaking | −3 |
| 3 | 150 | 2,5 | peaking | +3 |
| 4 | 300 | 2,0 | peaking | −3 |
| 5 | 500 | 1,0 | peaking | +3 |
| 6 | 1000 | 1,5 | peaking | −3 |
| 7 | 2500 | 2,0 | peaking | +3 |
| 8 | 4000 | 1,5 | peaking | −3 |
| 9 | 8000 | 1,0 | highshelf | +3 |
| 10 | 12000 | 1,0 | highshelf | −3 |
| 11 | 16000 | 1,0 | peaking | +3 |
| 12 | 20000 | 1,0 | peaking | −3 |

Alle zwölf Bänder sind auf beiden Kanälen aktiv: **24 Biquads bei 96 kHz**.
Der vorhandene `ParametricEqNode` wurde wiederverwendet, keine neue DSP-
Implementierung. Dessen verschachtelte Kanal-/Band-Schleife ist in
[processingNodes.ts:255](../../src/core/audio/nodes/processingNodes.ts#L255) belegt.

Messmethode: eigener Wegwerf-Checkout `/opt/am-r16-preflight` auf dem Testhost.
Ein ausdrücklich diagnostischer CJS-Hook im Worker ruft nach der bestehenden
R15-Prozessorkette den vorhandenen EQ auf. Stereo-Deinterleave/Reinterleave
ist eingeschlossen; Puffer und Filterzustände werden wiederverwendet.
Der Hook liegt für den Lasttest nach dem bestehenden Master-Gain. Er ist
**nicht** die fertige R16-Master-Stufe mit EQ vor Gain, Autorisierung,
5-ms-Bypass und Backend-Waveform und wird nicht als solche ausgegeben.

Unveränderter App-Prüfaufbau: vier echte Chromium-App-Kontexte, bestehende
Player mit festem WAV-Eingang, alle sechs R12-Prozessoren aktiv, PA-Browser
aktiv. Keine Main-Paket-/Ausgangs-Fixtures, keine gefalteten Panels,
keine Sampling-Profiler. Ein Durchlauf je 4/6/8 angeforderten Quellen.
Die CPU erfasst den **gesamten Testhost**, einschließlich Browser/PA/Devserver;
sie ist nicht allein die Backend-EQ-CPU. Die tatsächlichen zusätzlichen
Master-Monitor-Decoder und der neue Waveform-Transport sind noch nicht enthalten.

CPU-Messfenster: erste bis letzte Worker-Metrik innerhalb der tatsächlich
aufgezeichneten Browser-CPU-Messung, nach Start der Wiedergabe.
`Δcpu.stat.usage_usec / 1e6 / Δwall_seconds` liefert die mittleren vCPU.
Threadwerte aus `/proc/thread-self/stat`, CLK_TCK=100. EQ-Zeit ist ausdrücklich
Wall-Zeit der zusätzlichen Stufe, keine isolierte CPU-Attribution.

| Angeforderte Quellen | App-Proof Exit | Kontinuität | CPU-Fenster s | Gesamt-vCPU | Worker-vCPU | EQ-Wall ms/100-ms-Block | CPU ≤3,8 |
|---|---:|---|---:|---:|---:|---:|---|
| 4 | 0 | alle >60 s | 59.493 | 3.819693 | 0.242374 | 4.012 | rot |
| 6 | 0 | alle >60 s | 59.310 | 3.894116 | 0.311921 | 4.335 | rot |
| 8 | 1 | rot: sound fehlt; nur 5 ≥60 s | 59.385 | 3.931026 | 0.347565 | 3.768 | rot |

Entscheidender Rohwert bei sechs Quellen: **230960000 CPU-µs / 59,310 s =
3,894115663 vCPU**, gegenüber 3,8 um 0,094116 vCPU überschritten.
Alle sechs Quellen senden nichtleer über 61,578–62,211 s. Keine Mixer-
Paketabweisung. PA 61,833 s, fortlaufende Frames, keine beobachteten Close-
oder Playback-Fehler. Alle zehn vorhandenen App-Proof-Assertions bestanden.
Das ist funktionale Kontinuität des CPU-Probes, keine R16-Freigabe.
`throttled_usec=0` in allen drei Messfenstern bedeutet keine CPU-Reserve.

Acht angeforderte Quellen: rot, Exit1. `sound` sendet keine angenommenen
Pakete; Browserlog: `Main source start queue exceeded 1000ms`
(`app8/server.log:684`). Sieben Quellen liefern Pakete; fünf mindestens60s,
`song`59,947s und `instru`59,672s. Weil sound nie startet, greift die bestehende
Prüfaufbau-Verlängerung auf die letzte erste Quelle nicht; die beiden kürzeren
Spannen sind kein Nachweis eines späteren Streamabbruchs. CPU3,931026 ist
**kein erfolgreicher Acht-Quellen-Steady-State-Nachweis**. Keine Mixer-Rejects,
PA60,200s fortlaufend. Kein neuer Publisher-/Vorlauf-/Queue-Fix in R16.

Reproduktion/Rohdaten: `/workspace/work/r16-data/preflight-host.py`,
`eq-probe.cjs`, `analyze-preflight.py`, `analysis.json` und
`r16-preflight/app{4,6,8}/{result.json,server.log,browser-cpu.json}`.
Die vorhandene Prüfroutine ist `scripts/audit/backendMainWorkerAppProof.ts`,
mit `R14_SOURCE_COUNT=4/6/8`, `R14_DURATION_MS=60000`, frischem Artifact-Verzeichnis.
Der CPU-Probe muss ausdrücklich im separaten Checkout geladen werden.
Belege: **R16-P1-BANDS, R16-P1-CPU4, R16-P1-CPU6-STOP, R16-P1-CPU8-RED**.

## 2. P2 – Monitor-Main ist bisher kein Backend-Main

[usePrivateMonitor.ts:16](../../src/hooks/usePrivateMonitor.ts#L16) erzeugt beim
DJ `audioEngine.createMasterStreamDestination()`; die Audioengine erzeugt den
lokalen Master-Tap ([audioEngine.ts:2008](../../src/utils/audioEngine.ts#L2008)).
Diesen Browser-Stream verteilt `PrivateMonitorTransport` über WebRTC.
Empfänger verbinden ihn über
[audioEngine.ts:1740](../../src/utils/audioEngine.ts#L1740) mit ihrem lokalen
Audioausgang. Es ist kein Bezug aus dem Backend-Master-Insert.

Die Routing-Fassade ersetzt den lokalen Main-Abhörweg nur für Nicht-DJs mit
vorhandenem privaten Main:
[monitorRoutingFacade.ts:216](../../src/audio/monitorRoutingFacade.ts#L216).
Ohne diesen Stream bleibt der lokale Main-Abhörweg; beim DJ ebenfalls.
Damit wäre Backend-Mastering im aktuellen Main-Monitor nicht zuverlässig hörbar.

Die vom Betreiber ausdrücklich erlaubte Scope-Erweiterung ist notwendig:
Main-Abhörquelle aus dem autorisierten Backend-Main-Monitorzugang, lokaler
Pegel/Cue getrennt, kein Rückweg in die gemeinsame Summe. Für Waveform allein
werden keine Audiodaten zum Frontend geschickt; das ausdrücklich verlangte
Abhören von Backend-Main benötigt separat den autorisierten Audiomonitor.
**Nicht implementiert wegen P1-STOP**, keine Monitor-Korrelationsfreigabe.
Beleg **R16-P2-MONITOR-LOCAL**.

## 3. P3 – Header-Waveform bisher lokal

[StudioMastergraph.tsx:54](../../src/components/am/StudioMastergraph.tsx#L54)
liest `audioEngine.readMeterValues()`, Zeile72 legt `readMainLevel().raw` in den
Verlauf. [mainLevel.ts:33](../../src/core/audio/mainLevel.ts#L33) liest ebenfalls
das lokale V2-Meter. Das sind keine Backend-Master-Werte.

Benötigte, ausdrücklich beauftragte Erweiterung: Peak/RMS L/R je100ms aus dem
fertigen Backend-Master-Block, plus Clipping-Zähler, Frame-Position, Samplerate
und Audio-Epoche. `waveform-peak` über den bestehenden Session-WebSocket an
alle autorisierten Mitglieder. Keine Audioframes im Waveform-Payload.
Anzeige verwendet diese Daten; fehlende/veraltete Backend-Daten als solche
markieren, keinen stillen lokalen Ersatz. Peak/RMS ersetzt keinen True-Peak-
oder LUFS-Messalgorithmus; alte lokale Werte dürfen nicht als Backend-Messung
beschriftet werden. PCM24-Begrenzung bleibt am Ende
([backendMainMixer.ts:71](../../server/backendMainMixer.ts#L71)).
Generative Browser-Ausgabe bleibt die benannte Ausnahme vor ihrer Einspeisung;
die gemeinsame Main-Waveform kommt auch dann aus dem fertigen Backend-Mix.
**Nicht implementiert wegen P1-STOP.** Beleg **R16-P3-WAVEFORM-LOCAL**.

## 4. P4 – Autoritäts-Matrix, Soll und Ist getrennt

| Aktion/Anzeige | Bestätigte Zielautorität | Sichtbarkeit | Ist/Arbeit offen |
|---|---|---|---|
| Master-Gain/EQ | masterMONK-Halter oder gültige Delegation | alle, Backend-Waveform | Gain vorhanden, EQ fehlt, zusätzliche DJ-Pflicht noch vorhanden |
| Master-Clipping | Backend misst | alle, Backend-Waveform | Clipping-Zähler vorhanden, Header-Anbindung fehlt |
| Master-Halterwechsel | bestehende autoritative Locks | alle | Session-Replikation vorhanden; Master-DJ-Entkopplung fehlt |
| Master-OFF | masterMONK-Halter | alle | zusätzliche DJ-Pflicht muss gezielt entfernt werden |

Entkopplung betrifft mehr als die DSP-Stufe:
`server/backendMainProcessorControl.ts:16`,
`src/core/session/mainOutGuard.ts:26,105`,
`src/context/ModuleStateContext.tsx:199`,
`server/realtime.ts:871`,
`server/pluginDelegation.ts:20,41` und
`server/sessionRuntime.ts:277` (heute Master-Grant-Widerruf bei Mixer-Übergabe).
Nur die Master-spezifische Mixer-Kopplung ist freigegeben; Actor-/Ziel-/Generation-
Validierung, Ablauf und Widerruf der eigenen Master-Delegation bleiben erhalten.
Kein DJ-Override/Takeover und keine allgemeine Lockerung der Fremdsperren.
**Keine dieser Produktstellen geändert.** Beleg **R16-P4-AUTHORITY-INVENTORY**.

## 5. P5 – UI und Browser-EQ

Main hat aktuell nur den Gain-Regler
([BackendMainProcessorControls.tsx:12](../../src/components/BackendMainProcessorControls.tsx#L12));
Schreiben läuft bereits über die separate `backendMain`-Section, Zeile32.
Die vorhandenen zwölf Browser-Drehregler sind in
[MasterRack.tsx:109](../../src/components/master/MasterRack.tsx#L109),
ihr Handler ruft in Zeile59 `audioEngine.updateToneShiftEQ` auf.

Beauftragtes Ziel: zwölf Main-Slider plus Gain mit servergespeicherten Werten.
Betreiberempfehlung B für den alten Browser-EQ ist als geplante private
Monitor-Funktion dokumentiert: „Monitor-EQ (nicht PA-wirksam)“. Vor einer
solchen Beschriftung muss der tatsächliche private Abhörpfad geprüft sein;
beim Backend-Main-Referenztest darf der Browser-EQ die Referenz nicht unbemerkt
verändern. Keine stillschweigende Zuordnung der zwölf Browser-Regler zum
Backend-Master, keine Browser-Kompressor-/Limiter-Regler als Backend-Mastering.
**UI unverändert; kein Screenshot einer angeblich fertigen R16-UI.**
Beleg **R16-P5-UI-INVENTORY**.

## 6. Implementierungsstand und 7. Tests

Der Auftrag verlangt vor Produktcode: „Wenn 6 Quellen + 12-Band > 3,8 vCPU:
ehrlicher Blocker. NICHT still auf 3-Band reduzieren. Betreiber fragen.“
Dieser Fall ist eingetreten. Kein Produktcode geändert, keine Implementierung
von EQ/Monitor/Waveform/Entkopplung. Keine Verringerung auf drei Bänder,
kein Host-Upgrade, keine Queue-/Vorlauf-/Grenzenänderung.

Ausgeführt: einmaliger 4/6/8-Quellen-CPU-Probe auf Hetzner, vorhandene
App-Assertions jeweils unverändert, zusätzliche CPU-Auswertung. Lokaler
Diagnostik-Smoke prüft nur Ausführbarkeit/endliche Ausgabewerte des Hooks;
er ist weder R16-Unit-Test noch Host-CPU-Freigabe.

Nicht ausgeführt: neue R16-Unit-Tests und fertige R16-Integrationen,
Typecheck/Lint/gesamtes npm test,72Vergleichsblöcke/SRC-/R13-Mikrobenchmarks,
48State-Matrix. Produkt- und bestehende Testdateien unverändert; daraus wird
kein neuer grüner Testlauf behauptet. RT-/Audio-Gate nicht gestartet.
Bekannte Boundary-/masterRoutes-Fehler bleiben historisch rot.

Review umfasst ausschließlich diesen Bericht und zusätzliche append-only
R16-Evidenz. Rohdaten und frühere R15-Evidenz unverändert gesichert.
Temporären HTTP-Export beendet; keine Test-/Devserver mehr auf8196/8765,
Testhost ausdrücklich behalten. Details in `cleanup.json` und Console-Beleg.

**Schluss: R16 durch CPU-Vorabgate blockiert. Sechs Quellen funktional
kontinuierlich, aber3,894116>3,8vCPU. 12-Band-Mastering als Produkt, Backend-
Waveform und Backend-Main-Monitor sind offen.** Vor Fortsetzung benötigt der
Betreiber eine Entscheidung zur CPU-Entlastung auf dem unveränderten Testhost;
kein Upgrade oder Wechsel auf3Bänder als stillschweigende Alternative.

Rohdatensiegel: `/workspace/work/r16-data/raw-manifest.json`, 41 Dateien, SHA256 `736f1041c9c807c2fd8a755cc7bc557114a9dcf434909d79196449f6cefd9cba`.
Archiv-SHA256 per authentifizierter Hetzner-Konsole geprüft:
`0846855658c45a7085e8dc85338a7091d37206d63c61f7d121ae1b43dfeab7f9`.
Vorherige 3471 Registry-Einträge unverändert, 10 R16-Belege ergänzt.
