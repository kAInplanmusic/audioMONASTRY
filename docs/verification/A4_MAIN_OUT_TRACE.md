# Runde 2 – Soll vor Implementierung (2026-11-13)

Die folgenden Abschnitte werden vor jeder Codeänderung festgeschrieben. Historischer R1-Trace (Quelle Commit 9656e75) folgt unten; seine Zeilen gelten für den damaligen Stand, nicht als neue Laufzeitbelege.

1. **Studio / Veröffentlichung:** AGENTS.md:50 verlangt „exactly one device per main output“, UI_SPEC.md:80–86 trennt UI, Main-Ton und Visuals und bestimmt die Art aus dem Socketmodus des Servers. Die zusätzliche explizite Betreiber-Vorgabe aus dem Runde-2-Auftrag lautet: „Jeder Nutzer hört nur seinen eigenen Browser; der finale Main-Mix geht ausschließlich an genau ein Gerät auf /master-out“; dieser Own-browser-Satz steht nicht ausdrücklich in den beiden Bestandsdokumenten. Daher wird der tote Studio-Wiedergabepfad entfernt, Main-Audio nur an den serverbestätigten Audio-Ausgang gesendet und fremdes Audio im Studio/Visual-Ausgang verworfen; State/DataChannels bleiben erhalten.
2. **Listener / Fehler:** AGENTS.md:50 nennt `/master-out` als Audio-Adresse; UI_SPEC.md:87–89 verlangt eine sichtbare Ablehnung belegter Ausgänge. URL-Modus, Glare-Ausnahme, Recovery und Anzeigen müssen denselben kanonischen Modus verwenden; Signaling-/Aushandlungsfehler müssen die Audio-Seite sichtbar erreichen.
3. **Cue – Entscheidung nötig:** UI_SPEC.md:37 nennt „Nicht übernommen: … Booth/Kopfhörer/Mic“, der ältere Mixer-Entwurf in UI_SPEC.md nennt jedoch „Kopfhörer Cue/Mix“. Keine eindeutige Vorgabe entscheidet, ob Cue auf den fertigen Main-Tap gehört; Optionen: separater reiner Main-Tap oder ausdrücklich erlaubter Cue-Anteil. DSP bleibt unverändert.
4. **HTTP-Receiver:** AGENTS.md:50 und UI_SPEC.md:80–82 weisen Main-Ton allein `/master-out` zu; zusammen mit der oben ausdrücklich neuen Own-browser-Vorgabe darf der Legacy-HTTP-Receiver im Studio weder aufgebaut noch mit Tone.Destination verbunden werden. Auch ein verspäteter ontrack-Callback muss den aktuellen URL-Modus prüfen.

SFU-Grenze: Der SFU-Ticketvertrag enthält keine serverbestätigte Output-Rolle (server/realtime.ts:1197–1222); eine neue Client-Behauptung wäre kein Nachweis. Daher bleibt Main-Audio im autorisierten P2P-Ausgangspfad auch bei SFU-Auswahl; Studio abonniert keine SFU-Audio-Producer. Kein funktionierendes SFU-Audio-E2E wird behauptet.

## A4.2 Nachprüfung: Fehler nach Wiederherstellung (Soll vor Follow-up)

AGENTS.md:50 weist Main-Audio `/master-out` zu; UI_SPEC.md:81 nennt Zustand und Audioformat als Rückmeldung dieses Ausgangs. Daher muss eine erfolgreiche tatsächliche Wiedergabe wieder MAIN LIVE ohne überholten Fehlertext zeigen; ein beliebiger fremder Track darf den Verbindungsfehler nicht als behoben markieren. Der Manager verwirft seinen Fehlercache erst bei einem akzeptierten Owner-Stream, während die Page ihren sichtbaren Fehler erst nach erfolgreichem `play()` löscht.

## Runde-2-Ergebnis und aktuelle Datei:Zeile-Kette

Stand 2026-11-13 UTC, Basis P0 `8a2f1f9`, Branch `fix/a4-main-out-isolation`. **Status ⚠️:** Punkte 1/2/4 repariert und gemockt verifiziert, Cue-Entscheidung und echte Geräte-/Netzübertragung offen. Keine Infrastrukturaktionen, keine Secretdateien gelesen, Registry unverändert, kein Push/Merge.

| Stufe | Aktueller Beleg | Ergebnis |
|---|---|---|
| Mixer/Engine | `src/components/mixer/MixerDesk.tsx:394`, `src/utils/audioEngine.ts:1803` | Haltergeschützter Transport; unverändert. |
| Mix/Monitor | `src/core/audio/V2MonitorGraph.ts:129`, `src/core/audio/V2MonitorGraph.ts:139`, `src/core/audio/live/V2SinkEngine.ts:855` | Masterkette → Monitor einschließlich konfiguriertem Cue. DSP unverändert. |
| Worklet/Sink | `src/audio/worklets/v2SinkProcessor.ts:708`, `src/core/audio/backends/V2LiveSink.ts:261` | Worklet spielt lokale Engine; keine fremden Audioeingänge. |
| Tap | `src/utils/audioEngine.ts:1973`, `src/audio/masterStreamTap.ts:46`, `src/core/audio/backends/V2LiveSink.ts:222` | MediaStreamDestination am selben Sink, kein neuer Puffer/Delay. |
| Veröffentlichung | `src/App.tsx:319`, `src/App.tsx:323`, `src/utils/WebRTCManager.ts:306` | Nur Halter startet Main; toter Studio-Audioelement-Pfad entfernt. |
| Serverrolle/Exklusivität | `server/realtime.ts:560`, `server/realtime.ts:578`, `server/realtime.ts:434`, `server/realtime.ts:516` | Ein Socket pro Output; Offer-Absenderrolle wird serverseitig überschrieben; Endpointliste aus Socketzustand. Keine Client-Role-Claims werden ungeprüft als Empfängerrecht genutzt. |
| Peer-Fanout | `src/utils/WebRTCManager.ts:317`, `src/utils/WebRTCManager.ts:339`, `src/utils/WebRTCManager.ts:573`, `src/utils/WebRTCManager.ts:661` | Audio ausschließlich master-out, Video ausschließlich visual-out; unberechtigte Sender werden entfernt und auch bei reinem Entfernen neu ausgehandelt. Neue Peertracks: Zeile 745. |
| Listener-Offer | `src/utils/WebRTCManager.ts:739`, `src/utils/WebRTCManager.ts:888` | URL-basierter kanonischer Modus, recvonly Audio/Video-Transceiver, beide Listener umgehen Member-Glare. Recovery nutzt dieselbe Entscheidung (Zeile 860). |
| Empfang | `src/utils/WebRTCManager.ts:783`, `src/utils/WebRTCManager.ts:343` | Nur Listener; Absender muss servergelisteter Main-Out-Owner sein; Trackkind passt zum Ausgang. Studios bekommen keinen Wiedergabe-Callback. |
| Audioausgabe | `src/pages/MasterOutPage.tsx:40`, `src/pages/MasterOutPage.tsx:85` | Main-Audiotracks an Audioelement; Autoplay mit sichtbarem Aktivieren. Verbindungsfehler: Manager Zeile 708 → Page Zeile 53. |
| Visuals | `src/pages/VisualOutPage.tsx:85` | Nur Videotrack am Videoelement, keine Audioausgabe. |
| HTTP-Nebenpfad | `src/context/AudioContext.tsx:78`, `src/context/AudioContext.tsx:155`, `src/context/AudioContext.tsx:165` | Aufbau nur Audio-Ausgang; verspäteter ontrack prüft URL erneut vor Tone.Destination. In aktueller App ist AudioProvider nur am Studiozweig montiert (`src/main.tsx:88`, `src/main.tsx:99`), damit ist dieser Legacy-Receiver dort stillgelegt. |
| SFU-Nebenpfad | `src/utils/WebRTCManager.ts:306`, `src/utils/WebRTCManager.ts:442`, `src/utils/WebRTCManager.ts:464`, `src/utils/WebRTCManager.ts:470` | Main nutzt bewusst attestierte P2P-Listener auch bei SFU-Auswahl; kein Main-Audio-Producer/kein Audio-Abo. SFU-Callback prüft tatsächliches Trackkind und aktuellen Modus erneut. SFU-Video bleibt möglich; kein SFU-Audio-E2E behauptet. |

Die Absuche `rg -n 'createMediaStreamSource|srcObject\s*=|ontrack\s*=' src --glob '!**/compat/nativeAudioKit.ts'` liefert genau WebRTCManager, MasterOutPage, VisualOutPage und AudioContext. Diese Empfangs-/Wiedergabepfade sind oben einzeln behandelt; dies ist ein Quellcode- und Mocknachweis, kein Nachweis beliebiger konfigurierter externer Systeme.

### AGENTS.md §4 und DoD

- **Latenz:** Keine Audio-Thread-/DSP-/Pufferänderung; Änderungen liegen in Kontrollfluss/Peer-Autorisierung und verhindern ungewollten Fanout. Reale Ende-zu-Ende-Latenz unbekannt. Zusätzlich ausgeführtes `npm run audit:rt:gate` ist rot: 17/20 Grenzen; GCmax 34.538 ms, p99.9 26.335 ms, 246 Blöcke über Budget. Ohne Vergleichsmessung wird weder eine neue Regression noch ein grünes Latenzbudget behauptet.
- **4-User-Sync:** Studio-Peer/DataChannels bleiben bestehen (`src/utils/WebRTCManager.ts:893`); 14 relevante Testdateien / 138 Tests grün, darunter SessionCapacity, authoritativeSession, sessionSocketAccess.integration, sessionRuntimeLocks, sessionLockTransfer und SFU-Ticket-Handshake. Gemockte Studiopeers behalten DataChannels und bekommen keine Maintracks (`tests/mainOutIsolation.test.ts:38`). Kein Live-4-Gerätetest ausgeführt.
- **B2B:** Keine Server-Locklogik geändert; relevante bestehende Locks-/Handover-/Sessionrechte-Tests im genannten Lauf grün. Audio-Publishing wird bei Ownerverlust entzogen und Removal-only renegotiated (positiver Verhaltensnachweis im neuen SFU/P2P-Test).
- **Verify:** `npm run verify`: Typecheck PASS, lint FAIL wegen vorbestehendem `src/components/spatial/SpatialClubSetup.tsx:97` (unbenutztes `i`, 0 Fehler/1 Warnung; max-warnings=0). Daher nicht ausgeführt: test, test:python, security, audio:gate, audit:rt:gate, test:rls, check:deadfiles, audit:deep:static und verify:summary. Relevante Tests und audit:rt:gate wurden separat ausgeführt; vollständiges Verify ist ausdrücklich **nicht grün**. Abschließendes `npx tsc --noEmit` und ESLint nur aller geänderten Code-/Testdateien jeweils Exit 0.
- **Secrets:** Kein neuer Client-Key/Token; keine `.env` gelesen/übernommen, keine Livecredentials verwendet. Nur lokale Mocks und vorhandene Pakete genutzt.

### Tests und bewusste Verhaltensänderung

Neue Tests: `tests/mainOutIsolation.test.ts` (5), `tests/httpMasterIsolation.test.tsx` (2), `tests/masterOutErrors.test.tsx` (1). Es sind echte gemockte Peer-/MediaStream-/React-Verhaltenstests, keine negativen Quelltext-Greps. Vorher-Rot wurde durch temporäres Wiederherstellen der jeweiligen alten Produktionsdatei belegt, anschließend wiederhergestellt; die unten gesicherten Ausgaben enthalten Assertion-Differenzen, keine fehlende-Helper-TypeErrors als Regressionsbeweis.

Der bestehende Test „SFU: startMainStream produziert Audio UND Video“ verlangte das jetzt absichtlich untersagte ungerichtete Main-Publishing. Seine beiden Assertions wurden auf die neue Transportvorgabe umgestellt; sie wurden nicht entfernt. Zusätzlich beweist ein positiver neuer Test, dass trotz SFU-Auswahl Main-Audio tatsächlich im serverattestierten P2P-Output-Peer liegt, der SFU keine Main-Audiotracks erhält und Ownerverlust Sender entfernt. Ein zweiter zusätzlicher Test verwirft als Video deklarierte tatsächliche Audiotracks und verspätete Video-Subscriptions nach Navigation zurück zum Studio.

### Entscheidung nötig / Restgrenzen

**Cue unverändert:** `src/core/audio/live/V2SinkEngine.ts:855` nutzt renderMonitor, `src/core/audio/V2MonitorGraph.ts:139–140` summiert Main und Cue. `docs/UI_SPEC.md:37` und `docs/UI_SPEC.md:137` klären das Main-Tap-Soll nicht eindeutig. Optionen: separater reiner Main-Tap (Cue nur lokales Vorhören) oder ausdrücklich bestätigter Cue-Anteil im Main. Kein spekulatives DSP-Umpatchen.

**Livebetrieb unbekannt:** Keine echten Browser-/Audio-Geräte, ICE/TURN-/WAN-/LAN-Verbindungen oder SFU-End-to-End-Übertragung getestet. Die Tests modellieren zwei Studio-Peers und die getrennten Audio-/Video-Ausgänge lokal; es sind keine realen Browserkontexte. Bekannter vorbestehender Verify-Lintblocker bleibt außerhalb Scope. SFU braucht für künftig direkten Main-Audiotransport eine serverattestierte Outputrolle im Ticket-/Consumervertrag; der aktuelle Fix benutzt dafür bewusst P2P und behauptet keinen solchen SFU-Vertrag.

### Lokale Commits

`019c37f` Soll zuerst; `338a2ee` Punkt1; `bf188bf` Punkt2; `3090009` Punkt4; `c8cb219` Punkt1 SFU-/Widerrufsnachweis; `c05f3e2` Punkt2 sichtbare Fehler-Regressionsprüfung. Nachfolgender Dokumentationscommit sichert diesen Trace und Originalausgaben. Kein Push/Merge.

Originalausgaben, Datum und Befehle: [A4_R2_TEST_EVIDENCE.md](A4_R2_TEST_EVIDENCE.md).


---

## A4.2 Follow-up Ergebnis (2026-11-13T09:31:30Z)

Beide neuen Verhaltensregressionen gegen `744bd7e` rot: MAIN LIVE behielt den alten Fehlertext, und das Manager-Abo replayte nach einem gültigen Ownerstream weiterhin den alten Fehler. Jetzt leert `src/utils/WebRTCManager.ts:351` den Cache erst nach Owner-/Trackprüfung; fremde Tracks lösen kein Recovery aus. `src/pages/MasterOutPage.tsx:44` und `src/pages/MasterOutPage.tsx:67` löschen den sichtbaren Fehler erst nach erfolgreichem play(); der Test hält während ausstehendem play()-Promise den Fehler sichtbar.

Nachher: `npx vitest run tests/masterOutErrors.test.tsx tests/mainOutIsolation.test.ts tests/httpMasterIsolation.test.tsx tests/webrtcManager.test.ts` → 4 Dateien / 29 Tests PASS; abschließendes `npx tsc --noEmit` und ESLint der vier betroffenen Code-/Testdateien jeweils Exit 0. Keine Wiederholung des RT-Gates; sein dokumentiertes 17/20-Ergebnis bleibt bestehen. Cue und übriger Scope unverändert. Originalausgaben im Evidence-Dokument unter „A4.2 Follow-up“.

## A4 Testvertrag Opus/SFU (2026-11-13T10:10:04Z)

Der vollständige Integrationslauf des Orchestrators fand zusätzlich einen überholten Main-SFU-Publishing-Vertrag in `tests/opusMusicSdp.test.ts:88`. Lokal reproduziert: 1/7 rot, weil zwei music-SFU-Aufrufe erwartet wurden, obwohl Main jetzt bewusst nur attestiertes P2P verwendet. Ausschließlich diesen bestehenden Test/Bezeichnung angepasst: Voice-Klassifikation und Opus-SDP-Assertions unverändert; Main darf nicht ungerichtet per SFU veröffentlicht werden. Der positive Main-Empfangstest in `tests/mainOutIsolation.test.ts` bleibt unverändert erhalten.

`npx vitest run tests/opusMusicSdp.test.ts tests/mainOutIsolation.test.ts tests/webrtcManager.test.ts` → **3 Dateien / 32 Tests PASS**, Originalausgaben im Evidence-Dokument. Keine Produktionsänderung, kein RT-Neulauf, bestehender 17/20-RT-Befund und Cue-Entscheidung unverändert.

# Historischer R1-Trace (unverändert; alte Zeilennummern) – Main-Out-Pfad

Prüfstand: `5193d9e33142c00edd67712fc2f605a722e66db7` (`main`), Branch `fix/a4-main-out-trace`. Zeitpunkt: 2026-11-13T08:18:46+01:00. Ausschließlich Code gelesen. Keine Repo-Datei geändert, kein Commit, kein Push, kein Merge, keine Infrastrukturaktion.

**Status: ⚠️.** Die statische Kette ist bis zum Browser-Audioelement nachvollzogen, einschließlich benannter Unterbrechungsbedingungen. Eine erfolgreiche Übertragung zwischen echten Clients wurde nicht ausgeführt und wird nicht behauptet. Der Code enthält einen Versandpfad vom Browsermix des Halters an Peer-Verbindungen (`src/utils/WebRTCManager.ts:295`); die tatsächliche Audiozustellung ist unbekannt. Eine pauschale Aussage „Jeder hört nur seinen Browser“ ist damit durch diese statische Analyse nicht nachgewiesen. Die reguläre Studio-Empfangskette endet dagegen aktuell an einem unbesetzten Callback (`src/utils/WebRTCManager.ts:180`, `src/utils/WebRTCManager.ts:748`); `/master-out` besitzt einen tatsächlichen Wiedergabehandler (`src/pages/MasterOutPage.tsx:40`).

## Vom Mixer zum lokalen Audio-Ausgang

| Schritt | Beleg | Erklärung |
|---|---|---|
| Mixer-Transport | `src/components/mixer/MixerDesk.tsx:394` | PLAY ruft ausschließlich beim Main-Out-Owner `audioEngine.play()` auf. |
| Engine-Start | `src/utils/audioEngine.ts:1803` | Prüft den aktiven Halter, initialisiert Audio, verbindet V2, synchronisiert Patterns/Samples/Quellen und startet Transport. |
| V2-Verbindung | `src/utils/audioEngine.ts:2167` | Reicht den AudioContext an `v2LiveSink.connect()` weiter, synchronisiert danach den Mix und hängt vorhandenen Master-Tap nach. |
| Mixer-Parameter | `src/components/mixer/MixerDesk.tsx:358`, `src/utils/audioEngine.ts:1338` | Master-Fader setzt den Engine-Pegel; dieser Zustand wird über `syncV2FromV1()` in den Sink gespiegelt (`src/utils/audioEngine.ts:2253`, `src/audio/v2SyncMirror.ts:46`). Der Terminal-Proxy synchronisiert vor Methodenaufrufen (`src/utils/audioEngine.ts:2817`); dies ist keine Aussage über perfekte Parametertiming-Garantie. |
| Lokaler Worklet | `src/core/audio/backends/V2LiveSink.ts:255` | Erstellt AudioWorkletNode ohne Audioeingänge und verbindet seinen Ausgang direkt mit `ctx.destination` (Zeile 261). |
| Audioquellen | `src/audio/worklets/v2SinkProcessor.ts:606`, `src/audio/worklets/v2SinkProcessor.ts:686` | SFZ/Instrumente und sequenzierte Samples/Synths liefern Blöcke bzw. triggern Engine-Stimmen. |
| Kanalzüge / Summe | `src/core/audio/V2MonitorGraph.ts:142` | Pro Kanal Source → Gain → Pan → mainBus; paralleler Source → cueGain → cueBus. |
| Masterkette | `src/core/audio/V2MonitorGraph.ts:129` | mainBus → EQ → DSP → ModMatrix → Reverb → FX → Dynamics → Mastering → mainMonitorGain. |
| Monitor-Summe | `src/core/audio/V2MonitorGraph.ts:137` | Cue läuft über PDC und cueMonitorGain; MAIN und Cue gehen in monitorBus. |
| Gerendertes Signal | `src/core/audio/live/V2SinkEngine.ts:855`, `src/core/audio/V2MonitorGraph.ts:309` | Engine verwendet ausdrücklich `renderMonitor()`, also `render(ctx).monitor` (Ergebniszuweisung `src/core/audio/V2MonitorGraph.ts:285`). |
| Ausgangslayout | `src/core/audio/live/V2SinkEngine.ts:858`, `src/core/audio/V2OutputGraph.ts:58`, `src/core/audio/V2OutputGraph.ts:109` | Monitor-Stereo wird in den Layoutgraph gegeben und der Ausgangspuffer gerendert. |
| Worklet-Output | `src/audio/worklets/v2SinkProcessor.ts:708` | `engine.render()` liefert Puffer; Zeilen 710–716 kopieren sie in `outputs[0]`. Damit erreicht derselbe Worklet-Ausgang die lokale AudioContext-Destination. |

## Vom lokalen Ausgang über App.tsx bis /master-out (V2-Ausgangszweig)

| Schritt | Beleg | Erklärung |
|---|---|---|
| Initiator | `src/App.tsx:323` | `startHostMain()` verlangt `isMainOutOwner` und noch fehlenden Tap; ruft `createMasterStreamDestination()` auf (327). |
| Engine-Fassade | `src/utils/audioEngine.ts:1973`, `src/utils/audioEngine.ts:231` | Delegiert an MasterStreamTap mit genau dem oben verwendeten V2LiveSink. |
| MediaStream-Tap | `src/audio/masterStreamTap.ts:42` | Erstellt MediaStreamDestination; im hier verfolgten V2-Zweig verbindet ein verbundener Sink über `connectExtra()`. Alternativ wird ein echter `getLegacyTap()`-Knoten verbunden (Zeilen 54–59); nur ohne beide realen Quellen wird `null` geliefert. Der Legacy-Zweig wird hier nicht als V2-Verbindung dargestellt. |
| Physischer Fan-out | `src/core/audio/backends/V2LiveSink.ts:222` | `this.node.connect(dest)` hängt den MediaStream am selben Worklet-Ausgang ab. |
| Stream-Übergabe | `src/App.tsx:329` | Speichert Destination und übergibt `dest.stream` an `startMainStream()` (330). Wiederholversuch alle 2 s, höchstens 150 Versuche (`src/App.tsx:357`). |
| P2P-Sender | `src/utils/WebRTCManager.ts:295` | Speichert mainStream und ergänzt vorhandene PeerConnections via `addMainTracksToPeer()`. Dort `pc.addTrack(track, mainStream)` und Renegotiation (312–330). Neue Verbindungen erhalten mainStream-Tracks in Zeile 711. |
| Listener-URL | `src/core/session/listenerMode.ts:33`, `src/main.tsx:59`, `src/main.tsx:88` | `/master-out` wird als Listener erkannt und rendert MasterOutPage. |
| Session-Join | `src/utils/WebRTCManager.ts:492`, `src/utils/WebRTCManager.ts:362` | Verbindungsaufbau meldet `sessionMode()`; der Modus wird bei fehlenden expliziten Flags aus dem URL-Pfad abgeleitet. |
| Owner-Suche | `server/realtime.ts:492`, `src/utils/WebRTCManager.ts:498` | Server sendet Mitglieder und mainOutUserId; Listener ruft `connectToPeer()` nur für den gefundenen Owner auf (512–514). |
| SDP/ICE | `src/utils/WebRTCManager.ts:838`, `server/realtime.ts:422` | Client erstellt PeerConnection/Offer, Server relayed ausschließlich innerhalb derselben Session; Offer/Answer/ICE in Zeilen 433–446. Gegenstelle verarbeitet Offer und sendet Answer (`src/utils/WebRTCManager.ts:624`). Erfolgreiche SDP-/ICE-Aushandlung ist Voraussetzung, kein statisch nachgewiesenes Laufzeitergebnis. |
| Empfängertrack | `src/utils/WebRTCManager.ts:746` | `pc.ontrack` ruft `onRemoteStream(e.streams[0], targetId)` auf. |
| Listener-Wiedergabe | `src/pages/MasterOutPage.tsx:40` | Setzt `audioRef.current.srcObject = stream`, ruft `play()` auf; Autoplayfehler führen zu waiting. HTML-Audioelement in Zeile 94; manuelle Aktivierung in Zeile 73. |

## Fremde Clients, Nebenpfade und tatsächliche Lücken

1. **Andere Clients werden im untersuchten V2-Mixer nicht als WebRTC-Audiosource eingespeist.** Der Worklet hat `numberOfInputs: 0` (`src/core/audio/backends/V2LiveSink.ts:256`), und sein gerenderter Ausgang kommt aus der oben belegten lokalen Quellen-/Monitor-Kette. `rg -n 'onRemoteStream\s*=|onMainStream\(' src` findet nur Zuweisungen auf MasterOutPage und VisualOutPage; keine Studio-Zuweisung und keinen `onMainStream(...)`-Aufruf. Deshalb ist `App.tsx:316` mit seinem Audioelement-Handler für onMainStream im untersuchten Quellbaum kein geschlossener Empfangspfad. Der Default onRemoteStream ist leer (`src/utils/WebRTCManager.ts:180`). Dies belegt die Lücke, nicht, dass jedes Studio automatisch seinen eigenen Mix spielt: `audioEngine.play()` ist haltergeschützt (`src/utils/audioEngine.ts:1805`).
2. **Der Output wird an andere Clients geschickt.** `startMainStream()` iteriert alle existierenden PeerConnections (`src/utils/WebRTCManager.ts:303`), neue Member-Verbindungen bekommen Main-Tracks (`src/utils/WebRTCManager.ts:711`); normale Mitglieder werden Full-Mesh verbunden (`src/utils/WebRTCManager.ts:516`). Es gibt hier keinen exklusiven Versandfilter nur für `/master-out`. Ein Studio kann somit empfangen, obwohl sein Standardhandler nichts wiedergibt.
3. **Listener-Initiator hat eine konkrete bedingte Lücke.** Der raw Zustand `masterOutMode` initialisiert false (`src/utils/WebRTCManager.ts:110`), nur `setMasterOutMode()` setzt ihn (342). Die Page setzt ihn nicht; URL-Erkennung erfolgt über sessionMode(). `connectToPeer()` verwendet für die Glare-Ausnahme jedoch direkt `this.masterOutMode` (852). Wenn die Owner-Socket-ID kleiner als die Listener-Socket-ID ist, kehrt der Listener vor der Offer-Erstellung zurück. Der Server schließt Listener aus den Memberlisten aus (`server/realtime.ts:475`), die der Owner zur Verbindungsinitiation bekommt. Ein erfolgreicher initialer Verbindungsaufbau ist damit für diese Reihenfolge durch diese Kette nicht belegt. Derselbe raw-Modus-Konflikt betrifft die Anzeige: `isMasterOutMode` gibt ausschließlich `this.masterOutMode` zurück (`src/utils/WebRTCManager.ts:347–348`), während `MasterOutPage` bei `info.joined && !webRTCManager.isMasterOutMode` den Zustand auf `error` setzt (`src/pages/MasterOutPage.tsx:50–51`), obwohl die URL-basierte Session-Anmeldung Listener sein kann. Nicht korrigiert (A4 read-only).
4. **Main-Tap enthält den Monitor-Ausgang einschließlich des konfigurierten Cue-Anteils.** Tatsächlicher Renderweg ist `renderMonitor()` (`src/core/audio/live/V2SinkEngine.ts:855`), nicht die separat existierende `renderMain()`-Methode (`src/core/audio/V2MonitorGraph.ts:314`). MasterStreamTap hängt am fertigen Worklet-Ausgang, also hinter monitorBus und Layout. Die gegenteilige Beschreibung eines reinen pre-local-monitor Master-Abgriffs ist für diesen Pfad nicht durch die Verbindung gedeckt. Ob beim betrachteten Setup Cue aktiv ist, ist unbekannt.
5. **Separater konfigurierbarer HTTP-Masterreceiver:** `src/context/AudioContext.tsx:147` verbindet einen empfangenen Stream mit Tone.Destination (157). Das ist ein tatsächlicher fremder Audioeingang in den lokalen Tone-Ausgang, kein belegter Eingang in den V2Worklet-Mix. Ohne explizite HTTP-Signaling-Konfiguration kehrt der Signalingpfad vor dem Abruf zurück (170–175). Welche Produktionskonfiguration gilt, wurde nicht gelesen/verifiziert; darum ist die globale Aussage „nirgendwo Fremdaudio lokal“ ebenfalls nicht zulässig.
6. **Optionaler SFU-Pfad:** Initial `sfuMode=false` (`src/utils/WebRTCManager.ts:114`); Settings kann umschalten (`src/components/SettingsDialog.tsx:196`). Dann sendet startMainStream als SFU-Music-Track (`src/utils/WebRTCManager.ts:297`), und konsumierte Tracks enden ebenfalls in onRemoteStream (`src/utils/WebRTCManager.ts:437`). Die `/master-out`-Page initialisiert in ihrem Code keinen SFU-Transport. Eine funktionierende SFU-End-to-End-Verbindung zu dieser Page oder der tatsächlich deployte Modus ist nicht nachgewiesen. Die vorstehende vollständige statische Kette beschreibt den P2P-Zweig, keine erfundene SFU-Verbindung.

## Reproduzierbare Befehle / Originalausgaben

Arbeitsverzeichnis: `/workspace/work/a4`.

```text
$ git rev-parse HEAD
5193d9e33142c00edd67712fc2f605a722e66db7
$ git status --porcelain=v1
[keine Ausgabe]
$ date --iso-8601=seconds
2026-11-13T08:18:46+01:00
$ rg -n 'masterOutMode\s*=|setMasterOutMode\(' src
src/utils/WebRTCManager.ts:110:  private masterOutMode = false;
src/utils/WebRTCManager.ts:342:  public setMasterOutMode(enabled: boolean): void {
src/utils/WebRTCManager.ts:343:    this.masterOutMode = enabled;
```

Weitere reproduzierbare Lesebefehle:

```bash
rg -n 'onRemoteStream\s*=|onMainStream\(' src
rg -n 'masterOutMode\s*=|setMasterOutMode\(' src
nl -ba src/App.tsx | sed -n '315,385p'
nl -ba src/utils/audioEngine.ts | sed -n '1803,1830p;1969,1979p;2166,2179p;2253,2267p'
nl -ba src/core/audio/backends/V2LiveSink.ts | sed -n '217,285p'
nl -ba src/core/audio/V2MonitorGraph.ts | sed -n '128,164p;278,286p;308,318p'
nl -ba src/core/audio/live/V2SinkEngine.ts | sed -n '846,875p'
nl -ba src/audio/worklets/v2SinkProcessor.ts | sed -n '686,722p'
nl -ba src/audio/masterStreamTap.ts | sed -n '42,62p'
nl -ba src/utils/WebRTCManager.ts | sed -n '295,330p;498,520p;624,665p;684,749p;838,863p'
nl -ba server/realtime.ts | sed -n '422,446p;468,504p'
nl -ba src/pages/MasterOutPage.tsx | sed -n '35,94p'
```

Eine anfängliche Suche enthielt zwei nicht existierende vermutete Engine-Dateipfade; `rg` meldete `No such file or directory`, Exit 2. Danach wurde der wirkliche Import `src/audio/worklets/v2SinkProcessor.ts:56` verfolgt. Dies war kein negativer Implementierungsnachweis.

## DoD und offene Punkte

Die Quellcodekette ist für den P2P-Pfad mit Datei:Zeile bis zum Audioelement dokumentiert. Lücken/Abbruchbedingungen sind oben ausdrücklich benannt. Die pauschale Behauptung ist nicht bestätigt; erfolgreicher Live-Empfang und tatsächlicher Deploymentmodus bleiben unbekannt. Keine Laufzeitmessung, kein Geräte-/Autoplaytest, keine Netz-/ICE-Erfolgsbehauptung. Der Orchestrator soll den Status daher als verifizierte statische Analyse mit offenen Laufzeit-/Verbindungslücken darstellen, nicht als grünen End-to-End-Audiotest.

Geänderte Repo-Dateien: keine. Separates Arbeitsergebnis: `/workspace/work/a4-report.md`. Branch enthält unverändert den Basiscommit, kein A4-Commit wegen explizit read-only Aufgabe. Auffälligkeiten außerhalb A4: keine weiteren untersucht; die oben genannten Signal-/Modusbefunde nicht behoben.
