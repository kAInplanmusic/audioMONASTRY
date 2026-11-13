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


## Live-Kern-Runde 2026-11-13: A3 – drei Clock-Ebenen

Beleg `LIVE-A3-CLOCK-PATHS` enthält ausgeführten Suchbefehl, Ausgabe und Datum. Die folgenden Aussagen beziehen sich auf die untersuchte aktive Main-/Transport-Kette; sie behaupten keine Abwesenheit browserinterner RTP-Regelung.

| Ebene | Vorhanden? | Mechanik und belegte Grenze |
|---|---|---|
| Sample-Clock / Drift zwischen Geräten | Lokale samplebasierte Clock vorhanden; keine an die Hardware-Samplerate angeschlossene geräteübergreifende Regelung im untersuchten Main-Pfad belegt. | `src/core/audio/live/V2SampleClock.ts:98` plant Frames der lokalen Clock. `src/core/clock/MonastryMasterClock.ts:132` berechnet NTP-Offset/Drift, ruft die PLL aber nur zur Fortschreibung auf; deren Rückgabe wird dort keinem Resampler oder AudioContext zugeführt. `getDiagnostics()` liest die PLL (`:171`). Das ist kein Nachweis einer disziplinierten Hardware-Clock. |
| Transport / Tempo / SYNC | Ja, Code vorhanden; live zwischen vier Standorten weiterhin unbewiesen. | `src/App.tsx` sendet Clock-Pings und speist Antworten in `applyServerClock`; `src/utils/ClockSync.ts:40` rechnet die Vier-Zeitstempel-Formel. `src/core/session/pluginSync.ts` hält Quantisierungs-/SYNC-Zustand. Der separate ältere Providerpfad in `src/context/AudioContext.tsx:117` gleicht Tempo und grobe Transportposition an. Das ist Beat-/Transport-Sync, keine gemeinsame Hardware-Sample-Clock. |
| Master-Audio-Stream | Ein Mixer-Halter sendet einen RTP-Audiostream; Browser übernimmt Empfang/Playout. | `src/utils/WebRTCManager.ts` attestiert Halter/Ausgabe, `src/pages/MasterOutPage.tsx:45` setzt Stream und Wiedergabe. Jitter-Buffer-Ziel im Manager ist ein Ziel, keine gemessene Tiefe. RTP/WebRTC gleicht einen empfangenen Stream browserintern aus; das beweist keine Sample-Synchronität mehrerer Nutzerquellen oder physischer PA-Geräte. |

`src/utils/audioEngine.ts:1626` enthält zusätzlich `syncClock()` mit einem Transportpositions-Update. Die Suche zeigt im untersuchten Quellbaum keinen aktiven Aufrufer dieser Engine-Methode, nur Definitionen/Adapter-Verträge; daraus folgt kein laufender Drift-Servo. Die Datenkanal-Clock ist außerdem von Initialisierung und tatsächlich geöffnetem Kanal abhängig. A3 ist eine belegte Bestandsklärung, keine neue Sync-Implementierung.

## Live-Kern-Runde: A5/B1 – JSON-Messvertrag

Keine neuen Dokumente, Plugins oder Rack-Module. Artefakte sind Code/Datenschemata:

- `scripts/audit/live-session.template.json`: auszufüllendes B1-Template, ausdrücklich keine Messung.
- `scripts/audit/live-session.schema.json`: JSON Schema Draft 2020-12, `schemaVersion: 1`.
- `scripts/audit/live-session.ts --simulate --seed=42`: reproduzierbare synthetische Messwerte für zwei Nutzer; Host, Version, Commit und Zeitstempel kennzeichnen die Erfassung. Gleicher Seed reproduziert Werte, nicht reale Ausführungszeit oder Host-Metadaten.
- `scripts/audit/live-browser.ts`: explizites CDP-Anhängen an bereits geöffnete Seiten derselben angegebenen Origin mit `?liveAudit=1`. Es öffnet keine Produktivsession. Opt-in-API ist ausschließlich lesend; ohne Opt-in weder neue Timer noch zusätzliche Stats-Abfragen. Kein Dashboard und kein Browserspeicher.
- `scripts/audit/rt-bench.ts --live-only --live-report=<JSON> --json`: wertet B1-Daten aus, führt dabei keine DSP-Benchmarks aus. Kombination mit `--gate` ist verboten. Ohne diese Flags bleibt die DSP-Gate-Logik unverändert; neue Netzwerk-/CPU-Daten haben keine erfundene Gate-Schwelle.

Aufruf mit Node 22: `node --import tsx scripts/audit/live-session.ts --simulate --seed=42 > test-results/live-simulation.json`. Anschließend `node --import tsx scripts/audit/rt-bench.ts --live-only --live-report=test-results/live-simulation.json --json`. Browsererfassung: `LIVE_AUDIT_CDP=http://127.0.0.1:<CDP-Port> LIVE_AUDIT_ORIGIN=https://<eigene-App-Origin> LIVE_AUDIT_SECONDS=10 node --import tsx scripts/audit/live-browser.ts`. CDP-Adresse/Origin sind Konfiguration, keine Zugangs- oder Studiotokens; Nutzer authentifiziert die Seiten selbst. Der Sammler hängt nur an explizit freigegebenen Seiten und trennt sich anschließend vom Browser.

### Schema und Einheiten

Metadaten: `mode` trennt `simulation`, `local-staging` und `live`; `runId`, uint32-`seed`, Erfassungshost, Repositoryversion/-commit, `startedAt` (ISO mit Zeitzone). `observations[]` enthält `userId` (zugeordnetes Subjekt), `observerId` (messender Browser), Rolle, ISO-Zeit, lokale monotone Zeit, `values`, `methods`. Monotone Uhren verschiedener Geräte dürfen nicht direkt subtrahiert werden. CPU am Ausgabebrowser wird diesem Browser zugeordnet, nicht dem Sender des empfangenen RTP.

| B1-Feld | Einheit / Herkunft / Grenze |
|---|---|
| `audioInToPaOutMs` | ms; nur echte gemeinsame kalibrierte Acquisition-Clock für Eingangsmarker und physisch rückgemessenen PA-Marker. `audioProbeObservation()` verlangt Clock-/Kalibrierungs-ID und Unsicherheit. Kein Ableiten aus RTT, Browserzeit oder Buffer-Schätzung. Ohne externen Loopback-Probe `null`. |
| `jitterBufferMs` | ms; Differenz kumulierter `jitterBufferDelay` durch Differenz `jitterBufferEmittedCount` pro SSRC und Fenster. Gemessene mittlere Buffer-Wartezeit, keine momentane Queue-Tiefe. Erstes Fenster, Counterreset oder fehlende Browserfelder → `null`. |
| `droppedBlocks`, `renderedBlocks` | Explizite Intervallzähler eines externen Blockprobes. Ohne Probe `null`; Paketverlust, Silence und Concealment werden nicht als echte Blockdrops umbenannt. |
| `cpuPercent` | CDP `SystemInfo.getProcessInfo` CPU-Zeit aller Browserprozesse/-threads / monotone Erfassungszeit × 100. Nur bei genau einer optierten Teilnehmerseite zugeordnet; bei mehreren optierten Nutzern im selben Browser `null`, damit keine gemeinsame CPU mehrfach als individuelle ausgegeben wird. Erstes Fenster, Prozesswechsel oder nicht unterstütztes CDP → `null`; Mehrkernwerte dürfen über 100 liegen. |
| `rendererMainThreadCpuPercent` | Separat CDP `TaskDuration` / monotone Erfassungszeit × 100; nur Renderer-Main-Thread. Kein Ersatz für die vollständige Browser-CPU. |
| `networkRttMs` | ms; nominierter/ausgewählter erfolgreicher ICE-Candidate-Pair. Keine Signaling-RTT als Audiopfad ausgegeben. |
| `networkJitterMs` | ms; inbound-RTP `jitter` (RFC3550) am Empfänger, Sekunden × 1000. Bei mehreren Audioströmen konservativ größter Wert, Quelle/Observer bleiben erkennbar. Keine JS-Polling-Varianz als Netzjitter ausgegeben. |
| `concealedSamples`, `receivedSamples` | Explizite Intervall-Deltas pro SSRC; Resetfenster unbekannt. `concealmentRatio` ist Sample-Concealment, kein gemessener Block-Glitch-Anteil. |

`summary.users[userId].metrics[field]` enthält Count und p50/p95/p99 nach Nearest-Rank, nur aus endlichen nichtnegativen Messungen. Fehlende Daten sind `null` und Count 0; echte gemessene Null bleibt Null. `glitchRate = dropped / (rendered + dropped)` nur bei expliziten Blockzählungen, sonst `null`. `handovers[]` enthält From/To, gemessene Ausfallsekunden oder `null` und Methode; die Zusammenfassung liefert deren Perzentile. Ein echter Vierstandorte-Lauf braucht zusätzlich belegte lokale Host-/Build-Zuordnung und physische Probe-Kalibrierungen; Collector-Repositoryversion ist kein Beweis für die Version eines entfernten Deployments.

A5 ergänzt damit die zwei angeforderten Felder Netzwerk-Jitter und CPU samt Perzentilen im B1-Vertrag. B1 ist erst live-abnahmefähig, wenn physischer Loopback, echte Block-Probes und Teilnehmer-Browser mit verfügbarer vollständiger CPU-Messung eingerichtet sind; das JSON-Template allein ersetzt diese Sensoren nicht.


## Runde3-Präzisierung (2026-11-13)

Clock: lokale V2SampleClock und NTP-/Transport-Abgleich sind vorhanden, eine aktive geräteübergreifende Hardware-Clock-Disziplin ist im untersuchten Pfad nicht belegt. MonastryMasterClock.ts:146 verwirft den PLL-Rückgabewert; audioEngine.syncClock hat keinen gefundenen aktiven Aufrufer. RTP-/Master-Playout ist eine weitere getrennte Ebene. Belege R3-MEASUREMENT-SOURCE-CLOCK-PATHS und Folgebefehle. jitterBufferMs bezeichnet mittlere Intervallwartezeit, nicht momentane Queue-Tiefe; reale Audio-In/PA- und Dropblock-Probes fehlen weiterhin.

B2: main-out-owner musste Listener bei tatsächlicher Übergabe zum neuen serverattestierten Host verbinden und den bestehenden Studio-Starter benachrichtigen. Vier Gegenproben davor rot, danach gezielt grün; verspätetes Alt-Offer und A→B→A ersetzen keine neue Verbindung mehr. Akzeptierte lokale Rohdaten R3-B2-MEASURED-FINAL: Tab-Freeze0,000s beobachteter Ausfall, explizite Übergabe2,480s, ausdrücklich simuliertes Signaling-/Medien-WLAN0,180s; ca.20ms RMS-Raster, keine physische PA. Mehrsekündige Nachbeobachtung und echte neue Streamlieferung geprüft. Verworfenes0s-Scheinergebnis und alle Fehlproben bleiben archiviert. Der sortierte vollständige Ticketbericht steht im bestehenden ROUND2_ORCHESTRATOR_REPORT. B3 bleibt durch Inventur, reale Probes und Merge blockiert.

B2 erneut ausführen (nur lokale Testdienste; `local-audit` ist ein synthetisches Fixture-Credential, kein Betreiber-Secret). Verwendete vorhandene Coturn-Binary und Bibliotheken stammen aus der früher dokumentierten offiziellen Paketextraktion; SHA/Policy/Loopback-Sockets: `R3-B2-STAGING-METADATA`. Terminal 1 hält nur den lokalen Prozess offen:

```sh
env LD_LIBRARY_PATH=/workspace/work/live-turn/root/usr/lib/x86_64-linux-gnu /workspace/work/live-turn/root/usr/bin/turnserver -n --listening-ip=127.0.0.1 --relay-ip=127.0.0.1 --listening-port=3479 --min-port=49200 --max-port=49220 --realm=local-audit --user=local-audit:local-audit --lt-cred-mech --no-tls --no-dtls --no-cli --no-multicast-peers --allow-loopback-peers --relay-threads=1 --pidfile=/workspace/work/r3-turn/turn.pid --log-file=/workspace/work/r3-turn/turn.log --no-stdout-log
```

Terminal 2 im Repo mit Node22 und installierten Projektabhängigkeiten:

```sh
env LOCAL_TURN_URL='turn:127.0.0.1:3479?transport=tcp' node --import tsx scripts/audit/live-chaos.ts
```

CLI gibt JSON mit allen Rohsamples aus und liefert nur bei drei bestandenen lokalen Szenarien Exit0. Quelle bleibt Produktions-WebRTCManager; ausschließlich Fixture-Playout/Fehlereinjektion wird lokal aufgebaut. Nach dem Lauf den ausschließlich eigenen Test-TURN beenden; keine Produktionsdienste stoppen. Browser-Policies wurden nicht geändert.

## Runde 5 – laufender Sammler und 50-EUR-Live-Guard

Der frühere Aufruf nur mit CDP/Origin/Seconds ist durch den strengeren Startvertrag ersetzt. Vorbedingungen: exakte `LIVE_AUDIT_ORIGIN`, `LIVE_AUDIT_CDP`, eindeutiges neues `LIVE_AUDIT_OUTPUT`, `LIVE_AUDIT_SESSION_ID`, ausdrücklich ausgewählte eigene `LIVE_AUDIT_SESSION_PID` (keine Vorfahren/Systemprozesse; UID/Prozessstart werden geprüft), `LIVE_AUDIT_SFU_HEALTH` und `LIVE_AUDIT_COST_API`. Der gewählte Testcontroller muss seine Last beim SIGTERM beenden. Kein beliebiger produktiver Browser-/Cloudprozess wird automatisch gestoppt.

Der EUR-Kostenendpunkt muss tatsächliche, vollständige Provider-Istkosten derselben Session liefern: `{sessionId,currency:"EUR",totalEur,observedAt,source:"provider-api-actual-spend",scopeComplete:true}`. HTTPS, Token optional nur über `LIVE_AUDIT_COST_TOKEN`; keine Tokens in URL/Logs. Das ist der Adaptervertrag, kein bereits angeschlossener Hetzner-Billingkanal. Fehlend/falsch/veraltet (>30s), negative/abnehmende Kosten oder Fremdscope stoppen fail-closed. Kein Rückfall auf Preis×Zeit. Alle30s prüfen; erster berichteter Wert>=50EUR stoppt. Anbieter-Abrechnungsverzug ist damit nicht beseitigt; keine auf den Cent genaue Rechnungsgarantie behaupten.

Raw-NDJSON enthält die tatsächlichen getStats-Snapshots, daraus abgeleitete Beobachtungen, Kosten-/Health-/Handover-Ereignisse und Stopgrund. Alle10s fsync, atomarer Checkpoint; vor SIGTERM erneut dauerhaft schreiben. Ein Stop überschreibt/entfernt keine Rohdaten. Dauer1..25200s (bis7h). Vier echte Chromium-BrowserContext-IDs werden über CDP Target.getTargetInfo attestiert, weil eine zweite Playwright-CDP-Verbindung fremde Incognito-Kontexte sonst in einem Defaultkontext abbildet. Vier Kontexte sind vier simulierte Standorte auf einem Rechner, kein Geografienachweis.

Netzwerk-Wächter: pro Empfänger/Peer rollende30s, Summe concealedSamples / Summe totalSamplesReceived als Intervall-Deltas; >20% stoppt. `glitchRate` ohne echte Blockzähler bleibt null/„nicht gemessen“. Output-Handover-Beobachtung beginnt erst nach tatsächlicher Audiozustellung, hält die Ausfalluhr auch bei weiteren Ownerwechseln fest und stoppt bei>5s; Messmethode ist RTP-Empfang mit ungefähr1s Abtastung, keine PA-Ausfallmessung. Ein Sammlerlauf ohne aktiven Output liefert dafür keinen Wert.

Reproduzierbarer lokaler Proof: `LIVE_PROOF_ORIGIN=http://127.0.0.1:8181 npm run audit:live:local-proof`. Er verlangt eine bereits laufende lokale App mit echter SFU-Worker-/Router-Health, öffnet4 App-Kontexte, setzt CDP/Origin und erzeugt ausdrücklich synthetische Kosten49.9→50EUR. Er prüft regelmäßige Flushes, vollständige Journal-/Checkpoint-Zählung und einen echten SIGTERM-Empfänger, der den vorher dauerhaft gespeicherten Cap-Marker selbst zurückliest. Kein B3-Start und keine Provider-Ausgabe.

Aktueller Proof: `test-results/local-collector-1794593648062/`,4 Nutzer/4 Chromium-Kontexte,120 Rohsnapshots,609 Journalrecords,6 Flushes, SHA256 `daacf24a54510eea6199db11fd10d298737bb305e89c262fe944f5a0f5a639ec`. Beim Signal waren608 Records inklusive Cap-Marker bereits auf Platte; Record609 ist die abschließende run-end-Metadateizeile. RTP/PA-Latenz, Concealment und realer Handover bleiben in diesem absichtlich idle Lauf unbekannt. Das belegt Betrieb/Sicherung/Stop, keine Netzwerk-Audio-Abnahme. Belege `R5-P4-GUARD-TESTS`, `R5-P4-COLLECTOR-STABLE`.
