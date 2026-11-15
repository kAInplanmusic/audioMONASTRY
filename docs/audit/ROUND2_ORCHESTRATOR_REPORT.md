# audioMONASTRY – Runde 2: Integrationsbericht

Stand: 2026-11-13. **Nicht vollständig abgenommen:** `npm run verify` ist rot. Änderungen sind auf Aufgabenbranches und `fix/round2-integration` reviewbar; kein Merge und kein Push auf main. Infrastruktur wurde ausschließlich lesend untersucht. Test-Fixtures mit simuliertem Provisionieren/Abbau sind keine Produktionsaktionen.

## Ergebnis je Aufgabe

| Aufgabe | Status | Ergebnis / offene DoD | Branch und Quellcommits |
|---|---|---|---|
| Phase 0 | ⚠️ | Typecheck von 65 Diagnosen auf 0; bestehende Audio-/LLM-Funktionen für native Vast-Runtime übernommen. Gesamtprüfung und sechs Image-Verträge bleiben offen. | `fix/p0-vast-migration-typecheck`: 3ab8575, 69be659, 96abc9c, 72d56c2, 466bde9, 8a2f1f9, d6def2f, 3d1f130, 3ede26f, a2ea187 |
| 2a Inventur | ⚠️ | DNS dokumentiert, Registry gültig. Produktionshosts, Container, GPUs und Kosten mangels Zugang unbekannt; GPU-Gesamtzahl nicht belegt. | `fix/a1-inventory-live`: 8d8a578, 1b9ec91 |
| 2b Dokumentation | ⚠️ | Vier Kerndokumente abgeglichen; alleinige aktuelle Bestandsquelle `docs/SERVER_FLEET.md`, Bestand ausdrücklich unbekannt. Sechs Altdomain-Defaults wegen fehlender Ziel-Readiness erhalten. Nulltreffer-DoD nicht erfüllt. | `fix/a2-doc-reconciliation-live`: 5799a0a, b803433, 296eae5 |
| 3 Main-Out | ⚠️ | Punkte 1, 2 und 4 implementiert; Regressionen automatisiert belegt. Cue ungeklärt, keine reale Mehrgeräte-/WAN-Abnahme; Gesamtprüfung rot. | `fix/a4-main-out-isolation`: 019c37f, 338a2ee, bf188bf, 3090009, c8cb219, c05f3e2, 744bd7e, 56a282d, a90e2cc |

Tatsächliche main-Basis: `5193d9e33142c00edd67712fc2f605a722e66db7`; Phase 0 baut wie verlangt auf Regex-Fix `591dbd3` auf. Die Aufgabencommits wurden einzeln in den Integrationsbranch übernommen. Quell- und Integrations-SHAs unterscheiden sich durch Cherry-Picks; `git log main..fix/round2-integration --oneline` zeigt die vollständige Integrationsfolge. Die folgende Gate-Matrix gehört zum unveränderten Integrationsstand `e41d087`; danach kamen ausschließlich der Opus-Testvertrag, die historische Registry-Ausnahme und Belege/Bericht hinzu.

## Phase 0: beabsichtigte Migration

Vast erhält den begrenzten asynchronen `/run`-/`status`-Pollingpfad, Indexer-Vorprüfung und optionale Brain-Streams. Das vollständige Service-Runtime-Manifest ist die TS-Quelle. Die bereits vorhandene Python-Audio-/LLM-Geschäftslogik wurde providerneutral übernommen: unabhängiger AST-Vergleich mit `285ef5c` bestätigt das gesamte Modul einschließlich Imports und Konstanten, 18 Funktionen; nur der Moduldocstring weicht ab (`R2-ROOT-NATIVE-PARITY`).

Auf ausdrückliche Betreiberentscheidung wurden alte FLUX-/Wan-Generatorpfade sowie der verwaiste Trainingsstarter entfernt. Die einzelne aktuelle `vis`-Instanz für vorhandene Medien bleibt erhalten. Keine ganze Testdatei wurde gelöscht: 9 Starter-Gatefälle und 35 ausschließlich davon abhängige Trainingsfälle entfielen; aktuelle Medien/Kuration, Dataset/Staging/Bootstrap und AI-Toolkit-Verträge bleiben mit 19/19/16 erfolgreichen Tests bestehen. Kein neuer Vast-Trainer und keine echte Inferenz/Modellbeschaffung. Details: [Phase 0](P0_VAST_MIGRATION.md), [native Funktionen](P0_NATIVE_AUDIO_LLM_FOLLOWUP.md), [Trainingsbereinigung](P0_RETIRED_VISUAL_TRAINING.md).

## Inventur und Dokumentationsgrenzen

Die Laufzeitprüfung fand keine Provider-Tokens und keinen SSH-Agent. PRAIN-DEV lieferte interne Fehler. Die erwähnte Schlüsseldatei aus der ChatGPT-Bibliothek war hier nicht zugänglich; im Chat eingefügte Schlüssel wurden nicht in Dateien oder Logs übernommen. Ohne Credentials wurden keine authentifizierten Provider-Anfragen versucht. **Unbekannt bedeutet weder null GPUs noch null laufende Kosten.** Lokales leeres `docker ps` beweist nichts über Produktionshosts.

Mit echtem DiG wurden 208 getrackte Dokument-/Compose-Dateien konservativ nach Punktenamen untersucht: 2937 Kandidaten, darunter Dateinamen/Code, keine behaupteten 2937 Hosts. 17622 Abfragen: A/AAAA/CNAME, kurz und mit Headern. CNAME blieb wegen Resolver-NOTIMP und verweigerten TCP-Versuchen ungeklärt; 7 Exit-9-Abfragen bei 3 Nicht-Domain-Kandidaten und 4 fehlende Header sind dokumentiert. DNS-Adressen beweisen keine Rolle, Eigentümerschaft oder GPU-Ausstattung. [A1-Bericht](A1_INVENTORY.md) enthält Einzelbelege und Hosttabelle.

HTTPS-Prüfung über den normalen Proxy: Apex HTML 200, damit keine nachgewiesene App-Readiness; Origin und SFU HTTP 503. CONNECT 200 wurde nicht als Dienst-Erfolg gewertet. Deshalb bleiben sechs bestehende Defaults in drei Compose-Dateien unverändert. Der exakt verlangte Grep liefert sechs Treffer (`R2-FINAL-LEGACY-DOMAIN-GREP`); Exit 0 des Suchbefehls bedeutet Treffer, keine bestandene Nulltreffer-DoD. [A2-Bericht](A2_DOC_RECONCILIATION.md) dokumentiert jeden Zieltest und die zentrale unbekannte GPU-Zahl.

## Main-Out: Änderung und Nachweis

Studio setzt keinen toten Main-Empfangscallback mehr. Main-Audio wird nur einem serverseitig attestierten Master-Ausgabegerät und dem richtigen Tracktyp zugeordnet; Visual-Ausgabe erhält kein Audio. URL-Modus, Listener-Initiation, Receive-Transceiver und sichtbare Verbindungsfehler wurden korrigiert. Nur ein gültiger Stream bzw. erfolgreiche Wiedergabe räumt den passenden Fehler auf. Der HTTP-Masterreceiver wird ausschließlich auf `/master-out` erstellt und prüft vor Weiterleitung erneut den aktuellen URL-Modus.

Da der SFU-Pfad keine attestierte Main-Ausgabeidentität liefert, nutzt Main bewusst P2P auch bei aktivierter SFU-Einstellung; Main wird dort weder publiziert noch als Audio abonniert. Verspätete oder falsch klassifizierte SFU-Tracks werden verworfen. Eigentümerverlust widerruft Tracks und verhandelt die Entfernung neu. Cue und DSP bleiben unverändert.

Unabhängige Gegenprobe auf altem Stand: vier inhaltliche Assertion-Fehler, keine bloßen fehlenden Methoden (`R2-ROOT-ROUND2-BEFORE-ISOLATION-0`). Neue Verhaltenstests anschließend grün. Nach Korrektur des veralteten Opus-Quelltexttests: 47/47 Tests in sieben Dateien, inklusive positiver attestierter P2P-Ausgabe, HTTP-Isolation und historischer Dokumentationsgrenzen (`R2-FINAL-CONTRACT-RECHECK`). Voice-Klassifizierung exakt zweimal und sechs Opus-SDP-Aufrufe bleiben geprüft; Main-SFU-Publishing wird explizit ausgeschlossen.

AGENTS §4: Kein DSP-Diff (`R2-FINAL-DSP-UNCHANGED`), keine neue Audioverarbeitung oder Pufferung. Zusätzliche WAN-Latenz durch den geänderten Transport ist nicht real gemessen. Session-/Lock-/Output-Verträge sind automatisiert abgedeckt (A4: 14 Dateien/138 Tests); Backend-Locks unverändert. Reale Viernutzer-Synchronität, ICE/TURN und Mehrgeräte-Wiedergabe sind damit **nicht** bewiesen. Vollständige Kette und Zeilenbelege: [A4-Trace](../verification/A4_MAIN_OUT_TRACE.md), [A4-Testbelege](../verification/A4_R2_TEST_EVIDENCE.md).

## Unabhängige Integrationsprüfungen

Alle 22 Befehle wurden sequenziell auf demselben sauberen Stand ausgeführt, auch die durch das frühe Lint-Scheitern nicht mehr erreichten Gates. Exakte Befehle, Originalausgaben und Zeitstempel stehen unter `R2-FINAL-*` in `EVIDENCE_REGISTRY.json`. Node 22.23.5; Python-Venv mit gepinntem soundfile 0.12.1. Der benötigte historische Git-Testcommit wurde nachgeladen; der zugehörige Negativkontrolltest besteht. Audit nutzt vorhandenen Proxy/CA, keine Projektcredentials.

| Prüfung | Ergebnis |
|---|---|
| `npm run verify` | Rot: Typecheck besteht, Lint stoppt an bestehendem ungenutztem `i` in SpatialClubSetup:97. |
| Vollständige TS-Suite | 3871/3874 Tests bestanden, 449/452 Dateien grün. Fehler: historische Registry-Namensklassifizierung, veraltete Main-SFU-Erwartung, bestehender Spatial-Test zu -0/+0. Die ersten beiden wurden anschließend korrigiert und gezielt geprüft; **kein neuer vollständiger Lauf behauptet**. |
| `test:python` | 60/61 bestanden; unveränderter A100-40GB-Profilkonflikt. |
| Python LoRA / Segmente / AI-Toolkit | 19/19, 19/19, 16/16 bestanden. |
| Python Fleet / Services / Device | Fleet 295 insgesamt mit 1 Skip, sonst grün; Services 2/2, Device 15/15. |
| Python Runtime | 425/431 bestanden, 6 Fehler: statische Image-Verträge lesen das entfernte frühere Provider-Dockerfile. Keine fehlenden nativen Audio-/LLM-Imports mehr. |
| Python Production | 35/35 bestanden, ausschließlich Fixtures. |
| `security` | Bestanden: 667 Abhängigkeiten, 0 Advisory-Befunde; Interface-Grenzen bestanden. Kein umfassender Security-Audit behauptet. |
| `audio:gate` | Bestanden, eine Golden-Audio-Fixture. |
| `audit:rt:gate` | Rot: 19/20 Grenzen; 2 Renderblöcke über 2,67 ms (erlaubt 0). p99,9 0,537 ms; längste GC-Pause 0,436 ms. Frühere andere Ergebnisse bleiben erhalten, kein Wiederholen bis grün, keine Budgetänderung und keine belegte kausale Regression. |
| `test:rls` | Übersprungen mangels URL/Service-Key; Exit 0 ist kein bestandener Live-Test. |
| `check:deadfiles` | Rot: bestehendes SpatialSourceIcon. |
| `audit:deep:static` | Gate bestanden, 36 Findings / 0 gate-relevante kritische; offline, KI-Stages nicht ausgeführt. |
| `verify:summary` | Meldet RLS-Skip und Offline-Abdeckung ausdrücklich. |
| Registry / Diff-Check / DSP-Diff | Schema bestanden, whitespace sauber, kein Audio-DSP-Diff. Finaler Registry-Stand separat geprüft. |

Die bestehenden Spatial-Lint-/Spatial-Test-/A100-Fehler wurden unabhängig auf der vorherigen Basis reproduziert (`R2-ROOT-P0-BASELINE-CHECKS-*`). Sie wurden nicht für ein grünes Gesamtergebnis umgebogen.

## Beweiserhalt und Teständerungen

Die ersten 63 historischen Registry-Einträge und die ursprünglichen Inventurbelege bleiben unverändert. 56 frühere P0-Artefakte wurden bytegleich als Dateisnapshots mit SHA-256, tatsächlichem `git show`-Befehl und ursprünglicher Ausführungsmetadaten in der Registry archiviert; [Archivindex](p0/README.md). Alte Fehler und rote Ausgaben bleiben sichtbar. Die Quellcommits behalten die Originaldateien.

Dokumentations-, Legacy-Endpunkt- und Namenswächter behandeln exakt die Registry als historische Auditdaten. Aktive Source-/Deploy-Prüfungen und die Liste erlaubter fehlender Dokumente wurden nicht erweitert; ein zusätzlicher Guard verbietet Runtime-Konsumenten der Registry. Eine tatsächlich falsche Example-Metadatenreferenz wurde auf den bestehenden Vast-Dispatcher berichtigt. A2 prüfte die erste Archivierung (52 Artefakte) unabhängig byteweise gegen Git-Quellen und beurteilte die Guard-Verträge als erhalten. Keine Assertion wurde durch eine beliebige Erfolgsalternative ersetzt. Der spätere Opus-Test bildet das absichtlich geänderte Transportverhalten ab.

## Entscheidung nötig

1. **Cue:** Soll Monitor reines Main enthalten oder bewusst Main plus DJ-Cue? AGENTS/UI-Spezifikation klären die Kopfhörer-/Cue-Abgrenzung nicht eindeutig. Bis zur Betreiberentscheidung keine Änderung am Monitor-Tap.
2. **Image-Verträge:** Entweder tatsächliche gepinnte Vast-Basisimages samt Abhängigkeits-/Voice-Packaging-Nachweis validieren, oder einen eigenen vollständig gepinnten Buildvertrag festlegen und gegen gebaute Images prüfen. Sechs statische Tests nicht bloß auf einen anderen Dateinamen umstellen und damit Pin-Parität behaupten.

## Funde außerhalb des Scopes / externe Voraussetzungen

- Bestehende Spatial-Lintwarnung, -0/+0-Testabweichung, A100-Profilkonflikt und ungenutztes SpatialSourceIcon.
- Echtzeit-Gate überschritten; Originalwerte erhalten. Keine Schwellenwerte angepasst.
- Provider-/SSH-Zugriff bleibt Voraussetzung für echte Bestands- und Kosteninventur; keine bestätigte Aussage über laufende Kosten möglich.
- Origin/SFU benötigen Readiness, bevor die sechs Defaults geändert werden können.
- Live-RLS sowie reale Mehrgeräte-/WAN-/Viernutzer-Abnahme fehlen.

**Abnahme bleibt offen.** Es wurde weder Infrastruktur verändert noch gemergt. Die hier dokumentierten Änderungen und Belege sind der konkrete Reviewstand, keine Behauptung eines grünen Gesamtsystems.


# Nachlauf Live-Kern – 2026-11-13

Dieser Abschnitt ergänzt den abgeschlossenen Round-2-Stand. Neuer Arbeitsbranch `fix/live-core-instrumentation`, Basis `b737492`; kein Merge, kein Main-Push. KI-Logik, Visual-Renderer, die fünf geschützten vorbestehenden Checks und die sechs Domain-Defaults wurden in diesem Nachlauf nicht geändert. Keine neuen Markdown-Dokumente. Die spätere Betreiberkorrektur der UI wird gesondert geprüft.

| Ticket | Status | Bericht / Beleg-IDs |
|---|---|---|
| 0 | ✅ | Betreiberentscheidung zur bereits abgeschlossenen FLUX/Wan-/Starter-Entfernung in AGENTS dokumentiert. Quellcommits und erneute Bestätigung in `LIVE-T0-DECISION`. Commit a39a59b. |
| A1b | ⚠️ | Zugangsdaten auf ausdrückliche neue Betreiberanweisung geschützt außerhalb Git unter `/workspace/secrets/provider-tokens.env`, Datei 0600/Verzeichnis 0700. Primärer Hetzner-Token liefert HTTP200 und leere Serverliste; Vast v1 HTTP200 und leere Instanzliste. Zusätzliches Hetzner-Credential HTTP401; RunPod und SSH-Agent fehlen. Nur die erfolgreichen Credential-Scopes sind inventarisiert; globale GPUs/Kosten bleiben unbekannt. Drei angefragte IPs dort nicht gelistet, restliche Zuordnung unbekannt. Belege `LIVE-A1B-AUTH-INVENTORY`, `LIVE-A1B-V1-INVENTORY`, `LIVE-A1B-ALTERNATE-HETZNER`; Einzelheiten in A1_INVENTORY. Commit e928fe9. |
| A3 | ✅ | Bestehender A4-Trace trennt lokale Sample-Clock, NTP-/Transport-/Tempo-Sync und RTP-Playout. Kein aktiver geräteübergreifender Hardware-Sample-Clock-Servo im untersuchten Pfad belegt; vorhandene NTP-/PLL-Diagnose ist kein solcher Beweis. `LIVE-A3-CLOCK-PATHS`; bestehende Clocktests 19/19 in drei Dateien (`LIVE-A3-CLOCK-TESTS`). |
| A5 | ✅ | B1 enthält Netzwerk-Jitter und Browser-CPU mit p50/p95/p99; rt-bench importiert den Messbericht getrennt von unveränderten DSP-Gates. `LIVE-A5-B1-REPORT`; `LIVE-A5-GATE-SEPARATION` belegt die beabsichtigte Ablehnung von live-only plus gate. Kein RT-Gate neu ausgeführt. |
| B1 | ⚠️ | JSON-Template, Schema, Rohbeobachtungen, Statistik, opt-in RTC/CDP-Sammler und Schnittstelle für kalibrierte Audio-Probes implementiert. Zwei synthetische Nutzer, 200 Beobachtungen, Seed42; Schema-/Formatvalidierung bestanden (`LIVE-B1-SIMULATION`, `LIVE-B1-SCHEMA`). Vollständige CPU nur bei eindeutig einem optierten Nutzer pro Browser, Main-Thread separat. Physische PA-Latenz und echte Dropblock-Zähler benötigen reale kalibrierte Probes; bis dahin null und keine Live-Abnahme. |
| B2 | ❌ blockiert | Drei lokale Chaos-Szenarien implementiert: Holder-Tab-Freeze, ausdrücklich simuliertes WLAN-/Medien-Blackout, serverautorisierte Holder-Übergabe mit existierendem 2s-Retry. Echte lokale Browser wurden gestartet; Signaling/Offer/Answer funktionieren, aber keine ICE-Kandidaten und keine hörbare Baseline innerhalb 15s. Auch lokaler TURN/TCP-/Proxyversuch löste dies nicht. Kein Szenario wurde als bestanden gewertet; Ausfallzeit jeweils null statt erfundenem 0. `LIVE-B2-FINAL-BLOCKED`, vorherige Originalfehler und `LIVE-B2-LOCAL-POLICY` bleiben erhalten. |
| B3 | blockiert durch A1b, B1, B2 | Nicht gestartet. Kein authentifiziert belegter Testhostbestand, keine vollständigen realen Probes und keine drei grünen Chaosfälle. Keine vier echten Nutzer/Standorte oder 60min-Rohdaten behauptet. Vor-Start-Kostenrechnung mangels vollständiger Infra-/Billingdaten nicht möglich. Hard-Cap bleibt 30 EUR; keine Produktionsaktion veranlasst. |
| B4 | blockiert durch B3 | Ohne B3 keine echten p50/p95/p99, Glitchrate oder Istkosten; keine behauptete Netzwerk-/DSP-Dominanz und keine Architekturentscheidung. Das 128/48000-DSP-Blockbudget ist kein direkt vergleichbares Netzwerk-E2E-Latenzbudget. Server-Mix-Spike nicht umgesetzt. |

Implementierungscommit A3/A5/B1/B2: b1ed56b. Ausführung auf diesem Stand: Typecheck bestanden; 75/75 gezielte Mess-/Provider-/Routing-/Locktests in zehn Dateien (`LIVE-CORE-TESTS`); geänderte Dateien lintfrei (`LIVE-CORE-LINT`); weitere Dokumentationswächter 13/13 (`LIVE-CORE-DOC-GUARDS`). `npm run verify` erneut ausgeführt und bleibt am unveränderten Spatial-Lint rot (`LIVE-CORE-VERIFY`); spätere Kettengates dadurch nicht erneut ausgeführt. Keine Budgetanpassung, kein Wiederholen von audit:rt:gate bis grün, keine RLS-Änderung. Frühere rote Gate-Befunde dieses Berichts behalten ihre Gültigkeit als damalige Messungen.

## B2: Messmethode und belegte Grenzen

Die lokale Fixture benutzt Produktions-WebRTCManager, createRealtimeHub, Session-Locks und denselben aus App extrahierten 2s-/150-Versuche-Retry. Kein Import von server.ts und keine AI-Fleet-Hooks. Zwei Studio-Kontexte plus /master-out, Sinusquelle statt echter Mikrofon-/PA-Kette. Geplante Ausfallmessung: Empfänger-RMS alle20ms; keine physische PA-Messung. WLAN-Fall schaltet Signaling offline und unterbricht explizit den Sendertrack, weil CDP-offline WebRTC-UDP nicht zuverlässig unterbricht; dies wäre kein echter ICE-Ausfallbeweis.

Das Browser-Policy-Metadatum `WebRtcIPHandling=disable_non_proxied_udp` erklärt die direkte UDP-Beschränkung. Warum auch die konfigurierte lokale TURN-/CONNECT-Strecke keine Kandidaten lieferte, ist nicht abschließend geklärt; keine behauptete kausale App-Regression. Policy wurde nicht geändert. Der lokale, ausschließlich auf Loopback gebundene Test-TURN wurde danach gestoppt. Keine Cloudcontainer oder Produktionsinstanzen wurden verändert.

Die erste Mess-Unitprobe scheiterte an einer exakten Gleitkomma-Erwartung (19.999999999999996 statt20); korrigiert auf enge numerische Toleranz, keine Verhaltensalternative eingeführt. Der erste tsx-Browserprobe fehlte der serialisierte __name-Helfer; der Fixture-Shim wurde ergänzt. Alle Originalfehler bleiben in der Registry; spätere erfolglose ICE-Proben wurden nicht durch grüne Testdoubles ersetzt. Der Verdacht einer initialen ICE-Konfigurations-Race wurde durch Vorladen geprüft, beseitigte den Befund aber nicht und ist deshalb keine festgestellte Fehlerursache.

Korrektur nach zusätzlicher Quellprüfung (`CLAUDE-VAST-ALREADY-V1`): Die erste Audit-Probe verwendete einen veralteten v0-Listenpfad und erhielt HTTP410. Der native Lifecycle-Client verwendete bereits v1; die frühere daraus abgeleitete Aussage über einen veralteten Lifecycle-Client war falsch. Kein API-Pfad im Lifecycle-Code wurde geändert. Originalausgaben der tatsächlichen Audit-Anfragen bleiben erhalten.

**B3 Kosten Ist vs. Cap:** nicht gestartet, keine B3-Istkosten gemessen; Cap30EUR unverändert. Die für leere erfolgreiche Listen belegten Summen (0EUR/h Server im einen Hetzner-Scope und0USD/h Instanzen im Vast-Scope) sind keine globale Rechnung und keine Kostenfreigabe für unbekannte Accounts.

# Claude-Abgleich und Betreiberkorrektur – 2026-11-13

Reviewbranch: `fix/claude-continuation-ui`, Basis `7903862` von `fix/live-core-instrumentation`. Main wurde nur gelesen: beim Abgleich `ef28578`, Merge PR29 aus `fix/brainbench-regex`. Die Screenshots beschreiben Arbeitsschritte, beweisen aber keinen Commit; deshalb wurden die tatsächlichen Branches und Quellstände verglichen (`CLAUDE-BRANCH-COMMITS`). Kein Main-Push, Merge, Deployment oder Provider-Lifecycle-Aufruf.

| Gefundener Claude-Stand | Ergebnis des Abgleichs / Umsetzung |
|---|---|
| `591dbd3` Regex, `84e0a2d` Vast-Client | Gegen die bereits im Round-2-Zweig vorhandenen nativen Pfade abgeglichen; kein zweiter Client und keine Rückkehr zum alten Provider. |
| `25b8718` native CLI-Helfer | Die tatsächlich fehlenden gemeinsam verwendeten Funktionen übernommen: Manifestzugriff, Weight-Einträge, Imageauflösung und S3-Hilfen. Kanonisch bleibt das vollständige Runtime-Manifest; ungenutztes Deploy-Duplikat entfernt. Commit `d1a3fde`, zehn erhaltene Manifest-/Image-Verträge grün. |
| `7be6db7` Spatial-/Gate-Korrekturen | Spatial-Lint und +0/-0-Korrektur passend übernommen; unbenutztes SpatialSourceIcon nach Aufruferprüfung entfernt (`dc86d95`). Python-Gates an die tatsächlich erhaltenen nativen Funktionen angepasst. |
| `b61c8f4` Image-/Handler-Reparatur | Vollständige Basisrezeptur übernommen und auf bestehende native Handler/Entrypoints angepasst. Sämtliche COPY-Quellen vorhanden; geerbte Torch-, Voice-, Ears- und Quellpins bleiben geprüft. Offiziell aufgelöster PyTorch-Digest zusätzlich festgelegt (`bb917a8`, `1df424d`). Kein gebautes GPU-Image und keine GPU-Inferenz behauptet. |
| `1adce76` native Tests | Native Weight-/Image-Verträge übernommen; obsolete reine Provider-Admission-Fälle ausdrücklich mit dem entfernten Adapter ausgemustert. Quelltext archiviert, native Budget-/Ressourcen-/Rollback-Verträge bleiben bestehen. |
| `8ed826f` Bild-/Video-Routen | Kollidiert mit der ausdrücklichen Betreiberentscheidung zur Entfernung. Deshalb keine Wiederherstellung der generativen Routen. Der vorhandene Visuals-Live-Renderer und seine Medienbibliothek bleiben erhalten. |
| Screenshots: LoRA / visual-vorrat | Verwaiste Vorrats-/Trainer-Pipeline samt ausschließlich darauf bezogenen Tests fertig entfernt (`60885c3`). Erhaltene Kuration und Dataset-Export: 14/14. Genauer Löschumfang, Testzahlen und historische Quellen: [Ausmusterungsbericht](P0_RETIRED_VISUAL_TRAINING.md). |

## UI-Vertrag und tatsächliche Bedienung

`aiMONK` steht für alle Nutzer fest und immer offen nach dem Rack am unteren Ende der bestehenden Oberfläche. Kein Modusschalter, PRO-Schalter, Ausschalter oder Einklappen; die bisherige Feature-Flag-Abhängigkeit entfällt. Es ist kein kanonisches Audio-Plugin. Die vorhandenen Details des Agent-Laufs lassen sich weiterhin ansehen. [Tatsächliche lokale Browseransicht](../verification/CLAUDE_UI_PREVIEW.png).

Die regulären Plugins bieten ausdrücklich **Aus / An / KI-gesteuert**. Die Werte bleiben intern OFF / PRO / AUTO_AI; es gibt keinen sichtbaren STBY-Zwischenschritt. Aktivierung wartet auf die serverseitige Lock-Bestätigung. Schnelle aufeinanderfolgende Klicks verwenden einen Claim und nur den letzten Zielmodus; Denial, Abbruch und fehlende Bestätigung aktivieren nichts. Aus speichert Einstellungen und gibt den Lock frei. Fremde Nutzer sehen den replizierten Modus und dürfen ihn nicht ändern. Ein Halter darf sein KI-Plugin einklappen, ohne den bestehenden Automatiklauf allein dadurch auszuschalten. `mixerMONK` behält die bestehende Main-Invariante: immer an, genau ein serverseitiger Halter, Übergabe nur durch diesen.

Die vorhandene Plugin-Automatik war zusätzlich an `localUser` gebunden und konnte verspätete Pläne nach dem Ausschalten ausführen. Commit `100669a` bindet sie an die echte Session-Identität, erlaubt nur Schritte für das delegierte kanonische Plugin und benutzt den vorhandenen abbrechbaren Ausführer. Verlassen von KI bzw. Halterverlust beendet die Delegation und verwirft spätes Planungsergebnis. Bereits begonnene einzelne Befehle werden kooperativ beendet; es gibt keine behauptete Rückabwicklung oder Provider-Abbruch-API. Aktivitätsmeldungen schreiben nicht mehr den gewählten Plugin-Modus zurück. Keine Änderung an Planner, LLM-Provider, Modellen, GPU-Rollen oder Audio-DSP.

## Nachweise und Grenzen

- Gegenprobe der neuen UI-Assertions auf unverändertem `7903862`: vier inhaltliche Fehler, zwölf bestandene Assertions (`CLAUDE-UI-BEFORE-PROOF`). Anschließend neue Modus-/Autoritäts-/Komponententests grün.
- Zwei neue reale lokale Browserfälle grün (`CLAUDE-UI-BROWSER-INITIAL`). Der breitere Lauf bestand zehn Fälle, acht starteten wegen des fehlenden Playwright-Executable-Pfads nicht. Nach Wiederverwendung des vorhandenen verwalteten Chromium bestanden genau diese acht Fälle ohne Assertion-/Policy-Änderung (`CLAUDE-UI-COLLAB-PERSISTENCE`). Damit 18 verschiedene Verhaltensfälle bestanden, darunter Replikation, Tastatur, Freigabe, Persistenz und vier lokale Session-Kontexte. Kein Beleg für vier echte Standorte oder hörbare WAN-Audiowiedergabe.
- Nach abschließender Automatik-Korrektur: 37/37 gezielte Tests in sechs Dateien, einschließlich verspätetem Plan nach Aus/Unmount, tatsächlicher Identität, fremdem Zielplugin, AbortSignal und unverändertem Dokumentationswächter (`CLAUDE-AUTOMATION-MODE`).
- Vollständige native Runtime-Suite: 432/432 (`CLAUDE-NATIVE-RUNTIME`); native Weight-/Image-Verträge 10/10 (`CLAUDE-SHARED-HELPER-CONTRACTS`); erhaltene Medienkuration 14/14 (`CLAUDE-CURATION-PRESERVED`). Dies sind CPU-/Fixture-Verträge, kein gebauter GPU-Container.
- Der erste Gesamtaufruf scheiterte vor Tests am abgeschnittenen PATH; das Original bleibt erhalten. Der echte vollständige TS-Lauf danach bestand 3891/3892 Tests in 455/456 Dateien und fand nur zwei alte gelöschte Dokumentpfade. Kurze Ausmusterungs-Verweise beheben diese Referenzen; historische Fixture und Guard-Ausnahmen unverändert. Alle Originalausgaben bleiben in der Registry.

Die vorangehenden Live-Tickets und offenen Abnahmebedingungen bleiben gültig: insbesondere kein grünes B2, kein B3-Lauf und keine B3-Istkosten; Hard-Cap30EUR unverändert. Frühere RT-Überschreitung wird nicht durch wiederholte Läufe oder veränderte Schwellen ausgeblendet. Die native Inventur bleibt auf die erfolgreich gelesenen Credentials beschränkt, globale GPUs/Kosten unbekannt. Keys liegen auf ausdrückliche Betreiberanweisung geschützt außerhalb Git im Workspace.


Nachtrag zur gemeinsamen Automatik (`205a43a`): Die alten verstreuten Terminal-Aufrufe wurden durch genau einen Aufruf je kanonischem Rack-Plugin ersetzt. So erhalten auch die bereits zusammengelegten Plugins denselben KI-Modus; Systemmodule wie perforMONK erhalten keine Plugin-Automatik. Die zentrale Rack-Bindung setzt Halterschaft und KI-Modus voraus; Aktivitäts-Callbacks aus einzelnen Terminals können den Modus nicht mehr zurücksetzen. Der abschließende Browserlauf prüft ausdrücklich die tatsächlichen EQ-Bedienelemente: nur beim Halter vorhanden, beim Einklappen weiter eingehängt und verborgen, nach Aus entfernt. Beide Fälle bestanden in17,7s (`CLAUDE-OPERATOR-FINAL-BROWSER`).

Der Lauf `CLAUDE-VERIFY-AUTOMATION` bestand 3897/3897 TS-Tests (457 Dateien), stoppte anschließend am alten Ressourcen-Snapshot in `test_vast_fleet_plan.py` (70/71). Während dieses Zwischenlaufs wurde die gemeinsame Rack-Bindung fertiggestellt; er ist daher kein unveränderlicher finaler Quellstand-Nachweis. Die alte Erwartung bezog sich auf das entfernte Kurzmanifest. Commit `11f0fbd` hält nun die exakten Summen des vom Betreiber gewählten vollständigen Runtime-Manifests fest und ergänzt eine unabhängige kleine Rechnung für Reserve, Sicherheitszuschlag und Renderer-Schätzung. Kein Modellwert, keine Reserve, kein A100-Profil und keine Admission-Schwelle geändert. Anschließend native Vast-Suite72/72 (`CLAUDE-FLEET-CANONICAL-ESTIMATES`). Ein gesonderter finaler Gesamtlauf läuft auf unverändertem Quellstand11f0fbd.


Der geschützte A100-40GB-Test selbst und die GPU-Profil-/Survey-Logik sind unverändert. Er besteht in der nativen Suite jetzt mit der ausdrücklich gewählten vollständigen Manifestquelle: Für music beträgt die bestehende Gesamtschätzung dort33 statt44GiB im ausgemusterten Kurzmanifest. Damit ist nur die theoretische Einschätzung im Fixture erklärt, keine reale A100-Inferenz oder CUDA-Kompatibilität belegt.

Die zentrale Rack-Bindung machte zwölf bisherige Terminal-State-Destrukturierungen unbenutzt. Der unveränderte Prüflauf11f0fbd stoppte deshalb korrekt bei24 Lintwarnungen (`CLAUDE-VERIFY-FINAL-SOURCE`); Commit1013e4b entfernt nur diese unbenutzten Bindungen. Weder Lintschwelle noch Regeln geändert. `CLAUDE-VERIFY-STABLE` prüft danach den gesamten unveränderten Quellstand.


## Finaler unveränderter Gesamtlauf

`CLAUDE-VERIFY-STABLE`: `npm run verify` auf Commit1013e4b, Exit0. Typecheck und vollständiges Lint grün; 3897/3897 TS-Tests in457 Dateien. Python: Vast72, Medienkuration14, Fleet295 (ein vorhandener Skip), Services2, Device15, Runtime432 und Production35; ausgeführte Fälle grün. Production-Ausgaben stammen ausschließlich aus Fixtures und sind keine realen Cloudaktionen. Der eine Fleet-Skip betrifft die lokal nicht eingecheckte echte ONNX-Modellprüfung; kein Modell heruntergeladen und keine Assertion entfernt.

Security:667 Abhängigkeiten,0 Advisory-Befunde, Interface-Grenzen grün. Golden-Audio-Gate bestanden. Der einmal bis dahin gelangte finale RT-Lauf besteht20/20: p99,9=0,539ms, längste GC-Pause0,406ms,0 Blöcke über2,67ms. Derselbe Benchmark und dieselben Schwellen wie auf7903862; kein Wiederholen des RT-Gates zur Erzeugung eines grünen Resultats. Die frühere Round-2-Überschreitung bleibt erhalten, und dieser lokale Lauf beweist keine kausale DSP-Verbesserung oder WAN-/PA-Latenz.

Deadfiles-Gate grün. Deep-Audit offline:28 Findings,0 gate-relevante kritische, KI-Stages nicht ausgeführt. Live-RLS explizit **übersprungen**, weil die Test-Projektkonfiguration fehlt; Exit0 ist keine bestandene reale RLS-Prüfung. `verify:summary` meldet diesen einen übersprungenen Gate. Keine Supabase- oder Infrastrukturänderung. Vollständige Produktionsabnahme bleibt wegen der Live-Voraussetzungen oben offen.

Nach dem Lauf wurden nur zwei Leerzeilen von nachlaufenden Leerzeichen befreit und dieser Bericht/Evidenz/Vorschau ergänzt. Die TypeScript-Emit-Gegenprobe für beide Dateien bestätigt identischen ausführbaren Code gegenüber dem vollständig geprüften Commit1013e4b. Registry-Schema, ursprüngliche3134 Einträge,56 historische Archivhashes, Secret-Abgleich und Diff-Whitespace werden abschließend separat geprüft.

Abschlussbelege: `CLAUDE-FINAL-EMIT` (ausführbarer Code nach Whitespace-Korrektur identisch), `CLAUDE-FINAL-INTEGRITY` (3134 ursprüngliche Registry-Einträge unverändert,56 Archivhashes korrekt,27 tatsächliche Credential-Werte geprüft,0 Treffer; Datei0600/Ordner0700 außerhalb Git), `CLAUDE-FINAL-SCHEMA` und `CLAUDE-FINAL-WHITESPACE`. Modellmanifest, Flottenkonfiguration, A100-Test, Planner/LLM-Provider, Audio-DSP sowie RT-/Audio-Gates sind gegenüber7903862 unverändert. Die vollständige Inventur und reale Vier-Standorte-Abnahme bleiben offen; dieser Reviewbranch ist kein Produktionsdeployment.


# Runde 3: präzisierter Freeze und Live-Verifikation – 2026-11-13

Basis `2f813a0`, neuer Reviewbranch `fix/live-verification-round3`. Die frühere Verify-Exit0-Meldung gilt für den dort dokumentierten Stand, nicht als Produktionsabnahme. Der Betreiberauftrag und die spätere Klarstellung zum Textfeld bestimmen diesen Nachlauf. Keine neue Markdown-Datei, kein Merge, Main-Push, Deployment oder Miet-/Lifecycle-Aufruf. Alle Nachweise `R3-*` liegen mit tatsächlichen Befehlen, Ausgaben, ursprünglichen Exitcodes und Zeitstempeln in der Registry; die vorherigen3201 Einträge bleiben unverändert. Die Zusatzprüfungen wurden parallel ausgeführt, Registry-Integration anschließend sequenziell.

## Ticket 0a – aiMONK-Zugriff und Betreiberklärung

Der Diff `7903862..2f813a0` war **nicht insgesamt nur Zugriff**: Der eigentliche `AiMonkDock` war bytegleich und seine entfernte Feature-Flag bereitstrue. Zusätzlich wurden im exportierten Legacy-`AiMonkTerminal` Modus-State, Select und ein AUTO_AI-Aufruf entfernt (alter Stand7903862:15,27,36). Dieser Legacy-Pfad war im aktuellen Studio nicht verdrahtet: RACK_ORDER/COMPONENT_MAP enthalten16 kanonische Plugins ohneai; SYSTEM_MODULES.ai hatte keine Laufzeitkonsumenten. Das belegt keinen erreichbaren Produktfunktionsverlust, beseitigt aber nicht die Entfernung eines bestehenden KI-Codepfads. Deshalb zunächst **STOP nach Ticket0a**, keine pauschale reine-Zugriff-Ausnahme (`R3-0A-*`).

Betreiberantwort: AI ist kein Plugin, sondern für alle vier Nutzer unten dauerhaft ein Eingabefeld; der Nutzer schreibt Anforderungen hinein, die KI erledigt sie, und es kann auch ungenutzt bleiben. Diese Klarstellung ist die begrenzte Freigabe: **aiMONK ändert den Zugriff auf vorhandene manuell angeforderte KI und entfernt den nicht gewünschten globalen Legacy-Automatikzugriff; dauerhaft sichtbar startet keine Hintergrundausführung.** AGENTS:40 und `R3-T0A-OPERATOR-CLARIFICATION` dokumentieren diese Ausnahme, ohne zusätzliche Plugin-Automatik pauschal freizugeben.

Umgesetzt in `d1e1633`: `src/components/AiMonkDock.tsx:18` führt nur ausdrücklich abgeschickte nichtleere Texte aus; Form/Enter statt weiterer Buttons, keine Timer, kein Einschalten/Ausschalten/PRO, kein zusätzlicher Agent-/Transportknopf. Der Legacy-Import verwendet denselben manuellen Einstieg. Der Text bleibt erhalten; laufender Status und Fehler sind zugänglich, doppelte gleichzeitige Übermittlung wird abgefangen. Bestehender typedExecutor, Halterprüfung und serverseitige KI-Funktionen bleiben erhalten. Der nach Abbau der Zusatz-UI verwaiste React-Detailbildschirm wurde in `f7d3929` entfernt, vollständiger alter Quelltext archiviert (`R3-AIMONK-RETIRED-PANEL`); Agent-Server-APIs, Lauf-/Resume-/Abbruchlogik und deren Tests wurden nicht gelöscht oder geändert. Keine Knip-Ausnahme für die neue Waise.

25/25 gezielte Tests einschließlich bestehender Fremdsperren (`R3-AIMONK-MANUAL-RECHECK`). Der erste Lauf fand einen Testaufbaufehler: React.memo rendert bei identischen Props nicht wegen einer extern geänderten Mock-Variable neu; die Fehler-/Busy-Szenarien werden nun separat montiert, keine Produktassertion aufgeweicht. Vier echte lokale Studio-Kontexte: jedes genau ein Feld, keine Requests bei Öffnen/Tippen; Enter je Nutzer genau ein abgefangener **read-only Fixture**-Request. Zusammen mit bestehenden Operatorfällen3/3 Browserfälle (`R3-AIMONK-FOUR-LOCAL-USERS`). Das ist kein B2-/B3-Nachweis. [Aktuelle Feldansicht](../verification/CLAUDE_UI_PREVIEW.png).

## Ticket 0b – bestehende Modi und tatsächlicher Umbau

OFF/PRO/AUTO_AI existierten bereits vor dem UI-Branch (`7903862:src/plugins/types.ts:1`, `ModuleStateContext.tsx:14`, alter TerminalFrame-Select OFF/AI/ACTIVE). Diese internen Zustände sowie Server-Locks und Replikation blieben im Vergleich7903862..2f813a0 unverändert. **Rack-Projektion und App-Übergänge wurden dagegen in `cdb0644` neu umgesetzt:** vorher OFF/STBY/ON, wobei AUTO_AI als ON erschien; danach OFF/ON/AI mit expliziter Auswahl Aus/An/KI und serverbestätigter Aktivierung (`pluginMode.ts:17,33,47`, `RackRow.tsx:165`, `App.tsx:198`). Meine frühere Darstellung als bloße Wiederherstellung war ungenau. Die internen Modi waren im tatsächlichen Ausgangsstand nicht weg; ein Entfernungscommit ist nicht belegt. Die Historie wurde nachgeladen, bleibt aber flach; auch der nun lesbare Parent vonb263b12 enthielt bereits die alte Rack-Abbildung. Keine globale Behauptung über nicht verfügbare Vorgeschichte.

Fremdsperren sind mit37/37 Tests in fünf Dateien belegt (`R3-0B-*`): insbesondere `keeps every foreign plugin mode locked` (pluginModeUi), `rejects denial or another server-attested holder without activation` (pluginModeAuthority), `weist den Nicht-Halter ab, wenn der Server einen fremden Lock gemeldet hat` (moduleStateLockEnforcement) und `Fremdfreigabe ist auch ueber die Laufzeit unmoeglich` (sessionRuntimeLocks). Diese Runde baut die drei Zustände nicht erneut um.

**Zusätzlicher KI-Diff, separat offen:** `100669a` änderte Actor, WRITE-Gate, Schrittfilter und Abbruch-/Lebenszeit. `205a43a` aktivierte den periodischen MoaAssistant zentral auch für biblio/spatial/master, deren alte Einbettungen autoMode wegließen (vorherfalse). Das ist zusätzliche Ausführungslogik, keine bloße Beschriftung. Die Betreiberantwort zum manuellen aiMONK ist keine pauschale Freigabe dafür. Die gesonderte Entscheidung über Rücknahme dieses zusätzlichen Umfangs oder ausdrückliche Ausnahme steht aus; diese Runde änderte diese Plugin-Automatik bislang nicht. Der gesamte Branch wird damit nicht als uneingeschränkt KI-Freeze-konform abgenommen.

## Ticket 0c – endgültige FLUX/Wan-Entfernung

Erledigt: AGENTS:58 sagt ausdrücklich **endgültig entfernt**, Datum2026-11-13, Grund genau ein Renderer vorhandener Medien, kein Ersatz; neuer Bestätigungsbeleg `R3-T0C-FINAL-REMOVAL`, frühere Entscheidung `LIVE-T0-DECISION` erhalten. Kein Renderer, Modell oder Trainingspfad neu eingeführt.

## Ticket 0d – sechs Image-Verträge, M2 offen

**Alle sechs Verträge berührt**, nicht unberührt markieren: `bb917a8` änderte ihre gelesene Quelle von Dockerfile.runpod auf Dockerfile.base. Zwei Torch-, ein Ears-, ein Stem- und zwei Voice-Verträge; Assertion-Bodies sind nach exakter Normalisierung nur des Dateinamens unverändert. Sechs Vertrags- plus zwei Packaging-Prüfungen bestanden (`R3-0D-*`). Das ist ausdrücklich **keine Image-Parität und keine M2-Schließung**.

Die neue vollständige260-Zeilen-Rezeptur hat tatsächliche Herkunft b61c8f4/285ef5c, gepinnten PyTorch-Digest, native COPY-/Entrypoint-Änderungen. Der aktive Workflow `.github/workflows/vast-fleet-images.yml:32,54` baut jedoch `Dockerfile.vast` auf unveränderten Fleet-Digests, nicht diese neue Base-Rezeptur (`Dockerfile.vast:3`). Ohne attestierten Build-/Artefaktbezug zu den tatsächlich gestarteten Rollenimages bleibt **M2 OFFEN**. Kein Build/GPU-Test und keine aktive Image-Reparatur in dieser Runde behauptet.

## Ticket A1b – frische authentifizierte Inventur, weiterhin teilweise

Neue GET-Abfragen (`R3-A1B-INVENTORY`, `R3-A1B-SECONDARY-HETZNER`), Werte nur in Speicher gelesen, nichts neu in Env-Dateien geschrieben. Vorhandene Betreiber-Datei außerhalb Git bleibt0600/Ordner0700. Keine SSH-Versuche ohne authentifizierte Hostliste.

| Provider / Scope | Zugang / Antwort | Bestand, Rollen, Regionen | belegbare Kosten/h |
|---|---|---|---|
| Primärer Hetzner-Scope | HETZNER_TOKEN vorhanden; servers200, pricing200 | vollständige leere Serverliste; daher keine Servertypen/Regionen/Rollen in diesem Scope |0EUR/h nur gelistete Server; keine Gesamtrechnung |
| Zusätzlich bereitgestellter Hetzner-Scope | Variable vorhanden; servers401 unauthorized | nicht ermittelbar, nicht leer behauptet | unbekannt |
| Vast v1 | VAST_API_KEY vorhanden; instances200, vollständige Cursorliste |0 Instanzen,0 GPU-Instanzen im erfolgreichen Credential-Scope |0USD/h nur gelistete Instanzen |
| RunPod | RUNPOD_API_KEY nicht vorhanden | nicht ermittelbar | unbekannt |
| SSH | SSH_AUTH_SOCK nicht vorhanden; kein gelisteter Zielhost | nicht versucht | nicht ermittelbar |

| explizit geprüfte IP | Ergebnis / Rolle |
|---|---|
|135.181.111.103 | in erfolgreichen Hetzner-/Vast-Listen nicht gefunden; andere Scopes unbekannt, Rolle unbekannt |
|135.181.251.14 | ebenso, Rolle unbekannt |
|77.42.8.166 | **unbekannter Host, nicht in abgefragten eigenen Accounts**; weitere Accounts/RunPod nicht ermittelbar. Kein Beleg für „läuft nicht“. |

Globale GPU-Zahl und laufende Gesamtkosten weiterhin **unbekannt**. Leere erfolgreiche Scopes beweisen weder globale0GPUs noch0Gesamtkosten. Keine Accountvollständigkeit über die tatsächlich nutzbaren Credentials hinaus.

## Ticket A3 – drei Clock-Ebenen verifiziert

`R3-MEASUREMENT-SOURCE-CLOCK-PATHS`: lokale samplebasierte V2SampleClock (`src/core/audio/live/V2SampleClock.ts:97`) und NTP-/Offset-/RTT-Transport-Synchronisation (`ClockSync.ts:35`, `MonastryMasterClock.ts:132`) vorhanden. In `MonastryMasterClock.ts:146` wird der PLL-Regelrückgabewert verworfen; die Suche nach aktiven `audioEngine.syncClock`-Aufrufern fand keinen. Dessen Definition: `audioEngine.ts:1626`. Deshalb **keine aktive geräteübergreifende Hardware-Sampleclock-Regelung im untersuchten Pfad belegt**; kein pauschales „keine Clockschicht vorhanden“.

Transport-/Tempo-SYNC der Plugins ist davon getrennt (`App.tsx:316`, `AudioContext.tsx:117`). Der Master-Stream folgt dem Browser-RTP-/Decoder-/Playout-Pfad (`MasterOutPage.tsx:40`), was weder Hardware-Samplegleichlauf von vier Eingängen noch Ausrichtung einer physischen PA beweist. Ergänzung des vorhandenen A4-Traces, keine neue Clockimplementierung.

## Ticket A5 – Jitter/CPU-Diagnostik vorhanden

Implementierung auf Bestand bestätigt (`R3-MEASUREMENT-*`): `liveSessionAudit.ts:54,65,71,102`, `live-browser.ts:31,49`, `rt-bench.ts:44`. p50/p95/p99 für RTP-Empfänger-Jitter und Browser-CPU im B1-Format. CPU über alle Browserprozesse/Threads nur einem Nutzer zugeordnet, wenn genau eine optierte Nutzerseite existiert; Main-Thread gesondert. Erstes Fenster, Prozesswechsel oder uneindeutiger Scope bleibennull. RTP-Jitter ist keine Schwankung des JS-Abfrageintervalls. Live-only-Import lief mit `checks:[]`, **kein DSP-/RT-Gate ausgeführt oder geändert**. Reale Mixer-Holder/WAN-CPU-/Jitterwerte werden hier nicht behauptet.

## Ticket B1 – Format-/Simulations-DoD erfüllt, reale Probes teilweise

Template/Schema (`scripts/audit/live-session.template.json`, `.schema.json`) vorhanden und mit neuer CLI-Simulation geprüft: Seed42, zwei ausdrücklich synthetische Nutzer,200 Beobachtungen, Draft2020-12 und Datumformate validiert;47/47 gezielte Tests in sechs Dateien (`R3-MEASUREMENT-*`). Daten enthalten Seed, Sammlerhost, Version/Commit und Zeitstempel. Diese Metadaten attestieren keine entfernten Deployments oder deren Hostnamen.

Reale Audio-In→PA-E2E-Messung braucht eine kalibrierte gemeinsame Clock/Probe, echte Drop-/Renderblockzahlen einen realen Zähler. Ohne diese bleiben E2E/Drops/Glitchratenull. jitterBufferMs ist die mittlere Wartezeit des Intervalls, keine momentane Warteschlangentiefe. Die synthetischen2s Handover im Simulationsbeispiel sind **kein B2-Wert**. Funktionierendes Format ist damit belegt, vollständige Live-Messbereitschaft für B3 nicht.

## Ticket B2 – drei reale lokale Chaosfälle mit gemessenen Zahlen

Neue akzeptierte Rohdaten: `R3-B2-MEASURED-FINAL`, tatsächliche CLI Exit0. Ausschließlich lokale echte Chromium-Kontexte, Produktions-WebRTCManager/Signaling/Locks und vorhandener2s-/150-Versuche-Retry; synthetischer Sinus, kein Mikrofon/Cloud/Produktionsserver. Lokaler TURN/TCP und auf Testports begrenzter CONNECT-Proxy, unveränderte Browser-Policies. Empfänger misst RMS≤0,02 in ungefähr20ms-Abständen; Rohtrace, Host, Commit, Browserversion und Zeitpunkte im JSON. Keine physische PA-Messung.

| Fall | tatsächliche Injektion | gemessene Unterbrechung | Beobachtungsfenster |
|---|---|---:|---:|
| Tab-Throttle | Halterseite1500ms per CDP eingefroren, Audiothread darf weiterlaufen |0,000s beobachtet |4,516s |
| WLAN-/Medien-Simulation |1500ms Signaling offline plus Haltertrack aus; automatischer Halterwechsel möglich |0,180s |4,507s |
| Expliziter Mixerwechsel | echte serverautorisierte Übergabe an vorherigen Nicht-Halter ohne Stream; Quelle500ms zurückgehalten, bestehender2s-Retry |2,480s |5,497s |

0s bedeutet hier ausschließlich keine im Beobachtungsraster festgestellte Unterbrechung, nicht physisch bewiesene Null-Latenz. CDP-offline unterbricht WebRTC-UDP nicht zuverlässig; daher der ausdrücklich zusätzlich simulierte Medienausfall, **kein echter WLAN-/ICE-Ausfallbeweis**. Die kurze WLAN-Unterbrechung enthält den automatischen Wechsel auf den anderen Halter.

Ermittelte Fehler und Korrekturen (`a21c939`):
- Mit TURN/TCP funktionierte ICE; echte RTP-Pakete kamen an, im bisherigen Fixture zunächst0 dekodierte Samples. Ein explizites HTMLAudio.play wie im echten Master-Out initialisiert Chromium-Playout; Hardwareausgabe bleibt im Test stumm, der Analyser liest den tatsächlich dekodierten Remote-Stream.
- Ein voreiliger Probelauf meldete drei scheinbare Erfolge; dieser wurde **als Abnahme verworfen** (`R3-B2-PROVISIONAL-REJECTED`). Nach WLAN-Abbruch hatte der Server den Halter bereits gewechselt, sodass der nachfolgende Transfer wirkungslos sein konnte. Mehr Nachbeobachtung, tatsächliche neue Streamlieferung und geprüfter Ausgangshalter schließen dieses falsche0s aus. Der explizite Wechsel läuft jetzt vor dem WLAN-Fall; kein bloßes Wiederholen ohne Korrektur.
- Tatsächlicher Live-Kern-Bug: `main-out-owner` aktualisierte die Owner-ID, verband Listener aber nicht zum neuen attestierten Socket und benachrichtigte den bestehenden Studio-Starter nicht. Der Fix bindet nur Listener neu, schließt alte Listener-PCs, wartet bei unbekanntem Host auf Servermitgliedschaft und meldet die neue Autorität. Studio-/Voice-Verbindungen bleiben bestehen, Audio/Video-Filter und SFU-Audio-Ausschluss unverändert.
- Zwei weitere Races abgefangen: verspätete Offers des alten Senders dürfen keinen alten Listener-PC neu erzeugen; ein überholter asynchroner A→B→A-Versuch darf den neuen Ersatz-PC zuA nicht schließen.

Gegenproben: vier inhaltliche Fehler vor Owner-Fix (`R3-B2-OWNER-BEFORE`), danach62/62 gezielte Tests; drei weitere echte Race-Assertions vor Absicherung rot (`R3-B2-RACE-BEFORE`), nach Absicherung63/63 in vier Dateien (`R3-B2-RACE-FIXED`). Keine Assertion durch beliebige Erfolgsalternative ersetzt. Sämtliche Originalfehler und die verworfene Probescheinabnahme bleiben erhalten. Die früheren18 UI-Browserfälle sind weiterhin **nicht** B2.

## Ticket B3 – blockiert, nicht gestartet

B2 ist lokal jetzt mit drei akzeptierten Messfällen belegt. Es fehlen weiterhin vollständige A1b-Inventur/Gesamtkosten, reale B1-Probes und der erforderliche Merge des UI-/tatsächlich geprüften Live-Kern-Standes. Deshalb kein Vor-Start-Kostenversprechen, keine Mietinstanz und kein Vier-Standorte-Test. Vier lokale Testkontexte sind nicht vier reale Standorte. Die offene Plugin-Automatik-Freigabe wird ebenfalls nicht durch einen Merge umgangen.

**B3 Kosten Ist vs. Cap:** nicht gestartet, keine B3-Istkosten gemessen; Hard-Cap30EUR unverändert. Globale laufende Kosten unbekannt, keine Verrechnung leerer Credential-Scopes mit dem30EUR-Cap.

## Ticket B4 – blockiert durch B3

Keine60min-Rohdaten von vier echten Nutzern/Standorten, daher keine B3-Perzentile/Glitchrate/Istkosten und keine kausale Netzwerk-/DSP-Dominanz behauptet. Kein Server-Mix-Spike umgesetzt und keine Architekturentscheidung aus lokalen Fixtures abgeleitet. DSP-Blockbudget und Audio-E2E-Latenz sind unterschiedliche Größen.


## Runde3: abschließende Verifikation und verbleibende Freigabe

Vollständige TS-Suite auf stabilem f7d3929: **3906/3906 Tests in458 Dateien**, Exit0 (`R3-TS-FULL`). Finale Typecheck-/Lint-Läufe bestanden (`R3-FINAL-TYPECHECK`, `R3-FINAL-LINT`). Deadfiles zunächst rot am nach UI-Abbau verwaisten AgentRunPanel; dessen ausdrücklich ersetzte Zusatz-UI wurde archiviert/entfernt, danach grün (`R3-DEADFILES-FINAL`), keine Ausschlussliste erweitert. Acht gezielte Image-/Packaging-Tests bestanden, bleiben reine Sourceverträge und lassen M2 offen.

Die abschließende Drei-Fälle-UI-Probe auf dem B2-Fix bestand die beiden bestehenden Operatorfälle; der neue Vier-Kontexte-Fall erreichte laut Playwright-Trace alle App-Assertions und lief beim Screenshot in das30s-Gesamtbudget. Das ist als fehlgeschlagener Test erhalten, nicht als Erfolg gewertet. Nur für diesen neuen Fall erlaubt c1df747 nun60s für vier serielle Logins plus Screenshot/Aufräumen; keinerlei Assertion, Produktwartezeit, Audio-/RT-Schwelle oder alter Test geändert. Nur der zuvor fehlgeschlagene Vier-Kontexte-Fall wurde danach erneut ausgeführt (`R3-FOUR-USERS-FINAL`). Vollständige TS-Suite nicht für eine reine Playwright-Zeitbudgetänderung wiederholt.

In dieser Runde wurde **kein `npm run verify`-Gesamtaufruf, kein RT-Gate und kein Golden-Audio-Gate wiederholt**. Der frühere dokumentierte Verify-Exit0 bleibt historisch, nicht als neuer Lauf ausgegeben. Die fünf geschützten früheren Checks und sechs Domain-Defaults werden gegen2f813a0 unverändert geprüft; insbesondere weder Spatial/A100/RLS-Test noch Audio-/RT-Budget angefasst. Reale Live-RLS-Konfiguration/Prüfung fehlt weiterhin.

Die separate Betreiberentscheidung zur zusätzlichen Plugin-Automatik ist weiterhin ausstehend. Ihre Rücknahme oder Freigabe wird nicht aus der klaren Antwort zum manuellen aiMONK abgeleitet. Dieser Reviewstand ist kein uneingeschränktes Freeze-OK und kein Mergeauftrag.


Abschluss: Der Vier-Kontexte-Fall bestand mit unveränderten App-Assertions in23,4s (`R3-FOUR-USERS-FINAL`); zusammen mit den beiden auf finalem Runtime-Stand bestandenen Operatorfällen sind damit drei verschiedene aktuelle Browserfälle belegt. Security prüfte667 Abhängigkeiten mit0 Advisory-Befunden und545 Dateien auf Interface-Grenzen (`R3-SECURITY`); kein umfassender Security-Audit behauptet.

Evidenzgrenze beim UI-Timeout: Der ursprüngliche fehlgeschlagene CLI-Lauf ist vollständig erhalten (`R3-FINAL-UI-BROWSER-TIMEOUT`). Den Trace hatte ich vor dem Folgelauf ausgelesen, aber dessen ZIP nicht separat gesichert; Playwright bereinigte anschließend den gemeinsamen Outputordner. Ein späterer Wiederleseversuch scheiterte korrekt (`R3-UI-TIMEOUT-TRACE`). Nur der zuvor tatsächlich gelieferte Auszug ist unter `R3-UI-TIMEOUT-TRACE-OBSERVATION` erhalten, ausdrücklich kein vollständiger Trace und kein rekonstruierter ZIP-Nachweis. Diese Aufbewahrungslücke wird nicht verschwiegen. B2-Rohdaten und alle3201 vorherigen Registry-Einträge sind davon unberührt.

Nach separatem Integritätscheck:3201 ursprüngliche Einträge byteinhaltlich/strukturell erhalten,56 frühere Archivhashes korrekt, keine zusätzlichen Markdown-Dokumente;29 tatsächliche geschützte Credential-Variablen gegen Diff/Registry/Berichte geprüft,0 Werttreffer, Env-Datei0600/Ordner0700 außerhalb Git. Geschützte Tests/Budgets, DSP, kanonisches Modellmanifest, Flottenkonfiguration und die noch nicht freigegebene Plugin-Automatik sind gegenüber2f813a0 unverändert.

Endbelege: `R3-FINAL-INTEGRITY` enthält die vollständige ausführbare Integritätsprüfung im Befehlsfeld, `R3-B3-MERGE-PRECONDITION` die frischen Remote-Refs und den negativen Merge-Ancestry-Nachweis. Nur die nach PID, Arbeitsverzeichnis und Argumenten verifizierten lokalen UI-/TURN-Testdienste wurden mit SIGTERM beendet (`R3-LOCAL-SERVICES-STOPPED`); keine Produktionsdienste. Finale Registry-Schema-Prüfung: `R3-REGISTRY-FINAL`. Der neue Branch ist ein konkreter Reviewstand, kein Merge und keine B3-Freigabe trotz offener Voraussetzungen.

# Runde 4 – Betreiberklärung, bedingte Freigabe und getrennte Spuren (2026-11-13)

Basis des neuen Reviewbranches `fix/operator-round4`: `f551f68` von `fix/live-verification-round3` (dessen Basis2f813a0 bleibt nachvollziehbar). Ausschließlich Dokumentation und Nachweistests; **keine produktive KI-/Lock-/Modell-/Image-/DSP-Änderung**, kein Merge, Deployment, Build oder Provisionieren. Die Prüfungen der Flottenhistorie und B3-Betriebsbereitschaft liefen parallel und schrieben keine Repository-Dateien. Nachweise `R4-*` enthalten tatsächliche Befehle, Ausgaben und ursprüngliche Exitcodes; vorhandene Evidenz bleibt unverändert.

## Punkt 1 – Produktfreigabe A dokumentiert, B bleibt STOP

**A – Scope belegt, keine globale Automatik:** „205a43a aktiviert nur den KI-Modus für diese drei Plugins wie für die anderen13; es startet keinen globalen Automatiklauf ohne Halterbezug.“ Die produktive Einbindung ist ein einzelner Aufruf je Rack-Plugin mit `autoMode={ownedByMe && mode === 'AI'}` (`src/App.tsx:957`). Das Systemfeld aiMONK gehört nicht zu den kanonischen16; Mixer bleibt seine Immer-an-Ausnahme. Neue Tests für biblio/spatial/master: ungenutzt/manuell180s keine Planung, nach explizitem KI-Modus nur eigenes kanonisches Ziel und tatsächlicher Actor, nach Verlassen keine weiteren Timerläufe. Zusätzlich bleibt pluginId=ai selbst bei fälschlich gesetztem autoMode inaktiv und ein unbekannter Actor startet nichts. Zusammen mit bestehenden Scope-, Modus-/Unmount- und Fremdsperrentests25 bestanden (`R4-P1-COMPILE-CLEAN-STOP`). Das belegt die Anbindung, keine reale Modellinferenz oder Implementierung eines kontinuierlichen passiven Regelkreises.

Betreiberzitat: „205a43a (MoaAssistant zusätzlich für biblio/spatial/master) ist INHALTLICH GEWOLLT.“ In AGENTS als inhaltliche Freigabe mit Beleg und ausdrücklich technischer Sperre erfasst. Diese Produktfreigabe ersetzt **nicht** das geforderte B-Ergebnis.

**B – Sicherheitsbedingung NICHT erfüllt, STOP:** Drei Tests mit dem tatsächlichen `MoaAgent.executePlanGated` scheitern. Widerruf wird während der Bestätigung verarbeitet, Signal ist nachweislich abgebrochen und Halter bzw. Modus wurde im Testzustand tatsächlich geändert; trotzdem wird die Ausführungsfunktion einmal mit original-holder/eq/gain(0.5) aufgerufen. Fälle: Halterwechsel, OFF und Wechsel zu manuellON. Der erste Signaltestbefund und der verfeinerte Test mit expliziten Zustandsmutationen bleiben beide erhalten (`R4-P1-A-B-PROOF`, `R4-P1-COMPILE-CLEAN-STOP`: zuletzt25/28, **3 rot**).

Ursache: `src/core/ai/MoaAgent.ts:392` prüft Abbruch vor dem Schritt; `:403` wartet auf WRITE-Bestätigung; zwischen diesem await und dem Dispatch`:409` fehlt eine erneute Gültigkeitsprüfung. Kein „knapp bestanden“, kein Skip/xfail und keine Assertion abgeschwächt. Es wurde kein fremder Produktionsbefehl ausgeführt: Der reale Ausführer verwendet im Test einen Fake für den eigentlichen Seiteneffekt. Belegt ist der Dispatch trotz Widerruf, nicht eine Umgehung aller nachgelagerten Serverrechte. Bestehender Zielplugin-Filter/kanonische Aliasauflösung bleiben positiv geprüft; das macht die anderen drei Fehler nicht grün.

Der Betreiber wurde gemäß „Wenn(A) oder(B) nicht sauber belegbar ist: STOP“ informiert. **Keine Runtime-Reparatur oder Freischaltung an der STOP-Regel vorbei**, keine technische Ausführungsfreigabe und kein Mergeauftrag. Ein nächster Fix muss Gültigkeit nach asynchronen Grenzen und unmittelbar vor dem tatsächlichen Dispatch prüfen und die Abbruch-/Actor-/Zielverträge zusammen erhalten.

**Neue Lock-Semantik noch nicht umgesetzt:** Der Betreiber verlangt „OFF und KI geben den Lock frei“. Im Iststand gibt App.tsx:225 nur OFF frei; AI setzt AUTO_AI und behält den Lock. Die Automatik benötigt gleichzeitig ownedByMe. Eine isolierte releaseLock-Ergänzung bei KI würde daher den aktuellen Automatikpfad stoppen. Eine tragfähige Umsetzung benötigt eine separate serverattestierte Delegation (kanonisches Plugin, delegierender Nutzer, widerrufbare Generation) unabhängig vom frei gewordenen menschlichen Lock; neuer Halter/OFF/Verlassen widerrufen sie. Das ist hier ein konkreter Korrekturansatz, **kein implementierter oder aktivierter neuer Vertrag**. AiMONK bleibt separat und manuell. Kleines LLM/erweiterter Kontext selbst autorisierter KI-Plugins sind Betreiberziel, nicht in dieser STOP-Runde still umgeroutet oder als neue Fähigkeit behauptet.

## Punkt 2 – OFF/ON/AI bleibt; historische Variante im BACKLOG

`cdb0644` bleibt unverändert. Keine neue Projektion, kein Revert und kein erneuter Aufbau der bestehenden Modi. Betreiberentscheidung und Beleg `R4-P2-UI-PROJECTION` in AGENTS; frühere OFF/STBY/ON-Abbildung als nicht freigegebene historische Alternative im BACKLOG-Abschnitt des bestehenden DEPLOY_TODO.md. Keine neue Backlog-Datei angelegt.

## Punkt 3 – konkrete8/7/22-Liste, keine FLUX/Wan-Rückkehr

Der historische Definitionsstand ist **475f5c63712e0a2b7259f0b7bdce9a75e06e7822**. Nachweise `R4-P3-HISTORY-FOLLOW`, `R4-P3-DEFINING-COMMITS`, `R4-P3-COUNT-EVOLUTION`, `R4-P3-EXACT-HISTORICAL-CURRENT`:

- 0ad9ffd etablierte die acht Rollen-SSOT.
- 603a27f wies22 eindeutige Manifest-IDs den acht Rollen zu; das Gesamtmanifest enthielt damals noch weitere alte Metadaten.
- 5d85488 bereinigte das Manifest auf diese22 ohne FLUX/Wan/alte Generatoren.
- 475f5c6 pinnt sieben unterschiedliche immutable Image-Referenzen für acht Rollen. Aktuelle Rollen,22 Revisionen und historische Imagezuordnung stimmen damit exakt überein.

**Damit gibt es eine tatsächlich belegte8/7/22-Definition bereits nach Entfernung der alten Generierung. Kein Ersatzmodell und kein künstliches Auffüllen nötig.** Frühere Metadatenrollen imageHq/flux1-dev, videoReal/wan22-t2v-a14b, videoAbstract/ltx-video-13b und der Trainingsstarter bleiben entfernt; sie sind keine leeren Slots der bereinigten Acht-Rollen-Matrix.

Die [konkrete Bestätigungsliste](../AI_FLEET_STARTPLAN.md) enthält alle acht Slotzeilen, sieben getrennte geplante native Imageidentitäten, historische Herkunfts-Digests und alle22 exakten Repository-/Revisionszuordnungen. voice/music teilen I3; ACEshared zählt einmal und wird zweimal geladen (23 Rollenladungen).22 meint **Manifest-Einträge**, darunter CPU-DSP-Paket dsp-analysis ohne neuronalen Checkpoint und BasicPitch als CPU-ONNX, nicht22GPU-Modelle. Das wird vor Bestätigung offengelegt.

I1–I7 sind geplante native Vast-Ausgaben mit Tagform `...-vast:<role>-<approved-source-sha>`, **keine attestierten pullbaren Output-Digests**. Historische opake -runpod-Digests sind Herkunft/Buildinputs, kein Startbeleg. M2 bleibt offen: weder korrekte native Artefakte noch FLUX/Wan-freie Dateiinhalte dieser Images wurden durch eine Modell-Allowlist bewiesen. Unzulässige Basisinhalte erfordern sauberen Neubau, keine Wiederherstellung verbotener Modelle. Keine Images gebaut, gepullt oder gestartet.

Zusätzliche Präzisierung `R4-P3-VIS-RENDERER-BOUNDARY`: Slotvis trägt Audio-Upsampling/DeReverb, keine Visual-KI. Ein Supervisor und eine Renderdiagnose sind kein Beleg für einen tatsächlich gestarteten Produktions-Medienrenderer in diesem Image. Genau ein Renderer vorhandener Medien bleibt Ziel; Servicebindung/Start ungeprüft und für M2 offenzulegen.

**Explizite Bestätigungsfrage:** „Diese22 Modelle in diesen7 geplanten nativen Images auf diesen8 Instanzen — bestätigen?“ Bestätigung gilt für die vollständig offengelegte logische Belegung, nicht als erfundener Image-/GPU-Readiness-Nachweis. Bis dahin keine Vast-Provisionierung. Diese Spur blockiert B3 nicht.

## B3 – neue Startregeln übernommen, nicht gestartet

Die aktuelle Betreiberregel ersetzt die früheren Voraussetzungen: **Vast/GPU-Restore und physische Audio-E2E sind keine B3-Blocker.** Netzwerk-B1 darf reichen; die fehlende Audio-In→PA-E2E-Messung bleibt ausdrücklich dokumentiert. Eine vollständige globale GPU-Inventur wird nicht als B3-Vorbedingung weitergeführt.

Formale Voraussetzungen aktuell nicht erfüllt:

1. A inhaltlich dokumentiert, aber B rot/STOP (`R4-P1-COMPILE-CLEAN-STOP`).
2. `fix/live-verification-round3` ist nicht gemergt: Main ef28578, R3 f551f68, ancestry Exit1 (`R4-B3-REMOTE-REFS`, `R4-B3-MERGE-PREREQUISITE`). Kein Merge und kein „B3 light“.
3. Netzwerk-Instrumentierung vorhanden, aber kein attestierter laufender Sammler an vier tatsächlichen Standorten: LIVE_AUDIT_CDP/ORIGIN nicht gesetzt (`R4-B3-CDP-CONFIG-PRESENT-ONLY`).

Weitere reale Start-/Betriebsfragen, ohne neue künstliche GPU-Bedingung: frische Healthchecks gegen Origin und SFU jeweils **HTTP503** (`R4-B3-ORIGIN-HEALTH`, `R4-B3-SFU-HEALTH`; curlExit0 bedeutet nur ausgeführte HTTP-Anfrage). Vier echte Nutzer/Standorte und konkrete zugeordnete Hetzner-Testhosts samt aktueller Kosten/h sind nicht attestiert. Keine SSH-Zieladressen geraten, keine Cloudressource bestellt.

**Kostenbericht vor Start:** Für tatsächlich benannte Hosts `C_erwartet = Laufzeit_h × Summe(Hosttarif_EUR/h + IP/Volumen/Traffic_EUR/h) + einmalige Kosten + Reserve`. Ziel ist60min mit vier realen Standorten; Ab-/Aufbauzeit und separat berechneten Traffic einbeziehen. Numerischer Betrag derzeit **unbekannt**, weil die konkreten laufenden Testhosts/Kosten nicht zugeordnet sind. Das frühere0EUR/h im leeren erfolgreichen Credential-Scope ist keine Kostenrechnung für diesen Test.

**Harte Abbruchbedingungen:** Istkosten≥30EUR, gemessene Glitchrate>20%, Handover-Ausfall>5s; sofort Testlast beenden, Rohdaten sichern und Ergebnis melden. Bei unmessbaren Kosten oder unbrauchbarer Abbruchtelemetrie nicht starten bzw. fail-closed stoppen. Der jetzige Collector besitzt keinen laufenden Budget-/Glitch-/Handover-Abbruchwächter; handovers bleibt leer und stdout wird erst am Ende geschrieben (`R4-B3-CAP-AND-LIVE-GUARD-SEARCH`, `R4-B3-GLITCH-AND-HANDOVER-DEFINITION`). Das ist keine bereits laufende Hard-Cap-Absicherung.

Für einen ausdrücklich Netzwerk-only-Test ist concealmentRatio als separat benannte RTP-Metrik vorhanden. Es darf nicht still als physische Audio-/Block-Glitchrate ausgegeben werden: glitchRate bleibt ohne echten Blockzählernull. Vor Start muss der konkrete Netzwerk-Glitchzähler/Nenner samt Zeitfenster und laufendem >20%-Wächter eindeutig festgelegt und protokolliert sein; ebenso reale Handoverbeobachtung und regelmäßige dauerhafte Rohdatensicherung. Keine unbekannten Werte als0, keine still ersetzte Rate. Die Audio-E2E-Lücke selbst verhindert den erlaubten Netzwerk-Test nicht.

**B3 Kosten Ist vs. Cap:** nicht gestartet, keine B3-Istkosten gemessen; Cap30EUR unverändert. Keine60min-/Vier-Standorte-Daten oder Produktionsabnahme behauptet.

## Runde4 – Prüfstand und Evidenzerhalt

Nachweisstand: `R4-P1-COMPILE-CLEAN-STOP` **25 bestanden / 3 fehlgeschlagen**, alle drei Widerrufsfehler bleiben normale rote Assertions. Kein vollständiger grüner Verify-Lauf behauptet. Der erste Typecheck fand ausschließlich im neuen Teststub den unzulässigen Provider-Metadatenwert test; er wurde auf den vorhandenen zulässigen Wert vast-local korrigiert, ohne produktive Quelle, Prüfbedingung oder Ergebnis zu ändern. Danach Typecheck grün (`R4-TYPECHECK-FINAL`), geänderte Tests lintfrei (`R4-TEST-LINT`). Kein RT-/Audio-Gate wiederholt, keine geschützten Checks oder Legacy-Domain-Defaults geändert. Keine Tests übersprungen oder in erwartete Fehlschläge umgewandelt.

`R4-P3-CONCRETE-CONFIRMATION` fixiert die Bestätigungsliste auf den konkreten Build-Quellstand f551f689d55a0564052928be41b971f5d5a2f575 mit sieben eindeutig benannten geplanten nativen Ausgabetags. Alle Output-Digests bleiben unbekannt; Remote-Verfügbarkeit von Gewichten wird nicht aus Git-Sollwerten abgeleitet. Die komplette Tabelle samt historischen Herkunfts-Digests steht im bestehenden AI_FLEET_STARTPLAN. Keine Belegung, Revision oder Imagekonfiguration produktiv geändert.

Die vorherigen3279 Evidenzeinträge einschließlich früherer roter Gates und56 historischen Archivhashes werden unverändert erhalten. Finale Integritätsprüfung belegt unveränderte gesamte Runtime-/Deploy-/Workflow-Quellen, geschützte Checks und Budgets, keine neuen Markdown-Dokumente und keine Betreiber-Credentialwerte im Diff/Registry/Berichten. Punkt1 bleibt technisch STOP, Punkt2 dokumentiert, Punkt3 wartet auf ausdrückliche Listenbestätigung, B3 nicht gestartet. Keine pauschale Freigabe oder grünes Gesamtsystem behauptet.

# Runde 5 – Fixes, widerrufbare Delegation, echte Builds und Live-Guard (2026-11-13)

Reviewbranch `fix/operator-round5`, auf tatsächlichem Runde4-Head `fd9e5cd` aufgebaut. `f551f68` ist der darin bereits enthaltene Runde3-Head. Kein Merge nach main oder Runde4, kein Deployment, keine GPU-Allokation. Die folgenden Aussagen ersetzen den Runde4-Iststand, ohne dessen rote Belege umzuschreiben.

## Punkt 1 – 1B-Race repariert

Commit `2ed6732` ergänzt nach dem WRITE-await und unmittelbar vor Dispatch die erneute Abbruch-/Autorisierungsprüfung. Die produktive Plugin-Automatik prüft dort nun Servergeneration, kanonisches Ziel, delegierenden Actor, Ablauf und weiterbestehenden KI-Modus. Ungültigkeit beendet den Lauf; kein Folgeschritt. Die drei ursprünglichen roten Runde4-Assertions wurden unverändert grün (`R5-P1-RACE-FIX`). Kein Skip/xfail und keine abgeschwächte Assertion.

## Punkt 2 – menschlicher Lock und KI-Delegation getrennt

Commits `9deed42`, `6922b29`: Nur der tatsächliche Halter kann eine kurzlebige, serverattestierte Generation für sein kanonisches Plugin ausstellen. Der Einzelkoordinator setzt KI und gibt den menschlichen Lock synchron frei. Neuer Halter, Modusausstieg, OFF, Ablauf, Verlassen und Sessionende/Restore widerrufen die Freigabe. Begonnene Schritte enden kooperativ; keine späteren Schritte. Jede automatisierte Settings-Nachricht trägt die beim Schreiben erfasste Generation auch bei verzögertem Flush. Fremde Actors, alte Generationen und andere Ziele werden serverseitig abgewiesen. Für master gelten zusätzlich unverändert die Mixer-Halterrechte; Mixer-Übergabe widerruft diese Delegation. aiMONK/mixer sind keine Delegationsempfänger.

Die vier geforderten neuen Delegationsfälle, die ursprünglichen Racefälle, echte Socket.IO-Zugriffe, Settings, Main-Out-/Lockrechte und Guard/SFU-Verträge bestanden auf festgeschriebenem `56f8d3f` zusammen **110 Tests in17 Dateien** (`R5-POSTCOMMIT-TARGETS`). Drei echte Chromium-UI-Fälle bestanden, einschließlich vier Nutzer mit je einem manuellen aiMONK-Eingabefeld und Enter-Absendung sowie repliziertem KI-Modus bei freiem menschlichem Lock (`R5-UI-FINAL`). aiMONK hat keinen Modusschalter, keinen Delegationsempfang und keinen periodischen Lauf.

**Explizite Betriebsgrenze:** Die neue Ablage unterstützt einen Koordinator. Bei Redis-/Mehrkoordinator-Locks ist die Erteilung fail-closed gesperrt, bis eine atomare gemeinsame Delegationsablage implementiert ist. Keine Freigabe für einen produktiven Redis-Verbund aus diesen lokalen Tests ableiten. Der10-Minuten-Ablauf erneuert sich nicht heimlich durch einen Timer.

## Punkt 3 – 8/7/22 bestätigt, tatsächliche Artefakte in Prüfung

Die Betreiberbestätigung ist übernommen; weder Manifest,22 Einträge/Modellpins, acht Rollenbelegungen noch Voice/Music-Sharing wurden geändert. Quelle und Tests verwenden jetzt **Dockerfile.vast**, gewählt über `deploy/vast/build-contract.json`; YuE2 bleibt eine eigene Buildstufe. Eine bloße Änderung eines Dateinamens wäre kein Nachweis: der reale CI-Build läuft gegen diese Datei. Die sechs anderen Images bauen explizit ausgewählte Abhängigkeiten aus dem nativen Rezept.

Neue Allokation verlangt einen aktuellen, vollständigen Source-/Digest-Attest mit sieben verschiedenen Registry-Images, acht Rollenreferenzen und identischem Voice/Music-Image. Stale Quellen, fehlender Attest, geänderte Digests und Aliasdrift werden vor einem bezahlten Provider-Aufruf abgewiesen. Existierende alte Image-Digests alleine reichen nicht. Zwei Source-/Digest-Vertragstests und74 Vast-Tests bestanden;432 native Runtime-/Quelltests bestanden nach den ersten echten Buildfixes (`R5-M2-AFTER-FAIL-FIX`). Dies sind keine GPU-Inferenztests.

Lokal begrenzen rund5.2GB freier Speicher/vfs den vollständigen Sieben-Image-Build (`R5-M2-CAPACITY`). Docker `--check` prüfte die reale Datei ohne Warnungen (`R5-M2-BUILD-CHECK`). Deshalb wurde der beauftragte reale Build auf GitHub Actions ausgeführt: [Lauf43481044280](https://github.com/kAInplanmusic/audioMONASTRY/actions/runs/43481044280), Source56f8d3f. Song, audio-brain, studio und ears wurden gebaut und geprüft. Brain scheiterte am neuen vLLM-/Transformer-Stack gegen den alten Hub-Pin; Voice am ebenfalls hochgezogenen Hub; vis baute, aber seine Container-Vertragstests fanden fehlende Playwright/httpx-Abhängigkeiten. Diese echten roten Ergebnisse bleiben belegt (`R5-M2-CI-FIRST`); kein vollständiger Attest daraus.

Commit `315ca19` behebt genau diese Packagingfehler: getrennte Hub-Versionen für vLLM/Audio, festgelegter vLLM-/Transformer-Stack, Voice mit den vorhandenen Torch-/Hub-Constraints und Diffusers0.37.0, vis mit Playwright/httpx und tatsächlich im Image installiertem Chromium im unprivilegiert lesbaren Browserpfad. Kein Modellgewicht ergänzt. Der neue vollständige Sieben-Image-Build [43485634312](https://github.com/kAInplanmusic/audioMONASTRY/actions/runs/43485634312) läuft zum Zeitpunkt dieses Zwischenstands. Aktueller Erfolg/Digests werden nach Abschluss ergänzt; **M2 bis dahin offen**.

### vis: gemeinsame Last weiterhin unbekannt

vis bleibt dieselbe Instanz für UniversR, DeReverb und den vorgesehenen vorhandene-Medien-Renderer.48GB Budget,6GB Reserve,8GB geschätzte Audio-Modelllast sind Konfigurationswerte;34GB rechnerischer Rest sind **kein gemessener Headroom**. Keine GPU-Geräte/nvidia-smi hier; kein gemeinsamer GPU-/VRAM-Benchmark. Das vollständige Hybridkonzept kann deshalb nicht als „passt auf eine Instanz“ bestätigt werden.

Die konkrete Variante innerhalb der bestätigten22: modellfreier audio-reaktiver GLSL-/Medienpfad, begrenzte Frames/Auflösung, Audio-Post priorisieren, Canvas/FFmpeg als CPU-Fallback. StreamDiffusion SD-Turbo/LCM würde zusätzliche Gewichte außerhalb der22 benötigen und ist daher nicht eingebaut. ComfyUI nur als optionale vorhandene-/vorgerenderte-Medien-Anbindung ohne neuen Diffusionscheckpoint; kein aktiver Dienst behauptet. Falls gemeinsame Ziel-GPU-Messung scheitert: Resolution/Framerate reduzieren oder CPU; ein eigener Slot oder andere Neuralmodelle brauchen eine neue Betreiberentscheidung. Details im bestehenden AI_FLEET_STARTPLAN. Kein FLUX/Wan/Training und kein Text-zu-Bild-Generator.

## Punkt 4 – Live-Guard/Sammler nachgewiesen, echte Betriebskanäle offen

Commit `56f8d3f` erzwingt **50EUR pro Session**; ersetzt die historischen30EUR. Vor Start und alle30s vollständige aktuelle EUR-Istkosten derselben Session prüfen, bei>=50 stoppen. Fehlende/veraltete/falsche/abnehmende Kosten oder Fremdscope stoppen fail-closed; keine Tarif×Zeit-Schätzung als Istkosten. `LIVE_AUDIT_COST_API` beschreibt einen eindeutigen Provider-Istkostenvertrag, ist aber noch **kein angeschlossener tatsächlicher Hetzner-Billingkanal**.

Netzwerk-Wächter: rollende30s je Empfänger/Peer, Verhältnis der Intervall-Deltas concealedSamples / totalSamplesReceived, >20% stoppt. Dies ist Netzwerk-Concealment, keine Audio-Block-Glitchrate. Ohne Blockzähler bleibt `glitchRate=null`, ausdrücklich „nicht gemessen“. Der Output-Handover-Wächter prüft wirkliche RTP-Zustellung nach Ownerwechsel und stoppt bei>5s auch ohne Erholung; keine PA-Latenz daraus. Rohjournal alle10s fsync/atomarer Checkpoint, unmittelbar vor SIGTERM an den ausdrücklich gewählten eigenen Testprozess erneut dauerhaft sichern. Wiederholte Stops sind idempotent; alte Dateien werden nicht überschrieben.

Vier Simulationstests prüfen Kosten, Netzwerkgrenze, Handover und dauerhafte Sicherung jeweils vor dem Stop (`R5-P4-GUARD-TESTS`). Echter lokaler Sammler über CDP/Origin: **4 tatsächliche Chromium-Kontexte,4 Nutzer,120 Rohsnapshots,609 Journalrecords,6 Flushes**, echter POSIX-SIGTERM-Empfänger las zuvor608 dauerhaft gesicherte Records inklusive simuliertem50-EUR-Cap selbst zurück. Letzte Zeile609 ist run-end. Raw-SHA256 `daacf24a54510eea6199db11fd10d298737bb305e89c262fe944f5a0f5a639ec`, Dateien unter `test-results/local-collector-1794593648062/`; `R5-P4-COLLECTOR-STABLE`. Kosten49.9→50 waren ausdrücklich simuliert; diese EUR-Zahlen sind keine Providerausgabe.

Der Proof ist ein Idle-Lauf: keine aktiven RTP-Audiocounter, kein laufender Main-Handover, kein physischer Loopback. Entsprechend bleiben Concealment, reale Handover-Zeit und Audio-E2E unbekannt. Der frühere lokale B2-RTP-Nachweis bleibt historisch erhalten; er wird nicht zu neuen vier Standorten umetikettiert. Die korrigierte Kontextattestierung verwendet echte Chromium Target-BrowserContext-IDs; die erste CDP-Anbindung hatte die fremden Incognito-Kontexte in einem Playwright-Defaultkontext zusammengefasst und wurde korrekt abgebrochen. Auch ein späterer Navigationsabbruch wurde mit gesicherten Rohdaten beendet; kein fehlgeschlagener Lauf als erfolgreicher Ersatz ausgegeben.

Origin und SFU-Worker/Router waren lokal HTTP200/ready. Der echte, zur installierten Mediasoup-Version3.26.0 passende offizielle Worker wurde separat bereitgestellt und ein Opus-Router wirklich erzeugt; kein Mediasoup-Mock als Healthbeleg. Der Healthscope nennt ausdrücklich „local worker/router; WAN media reachability not attested“. Extern lieferten Origin/SFU weiterhin HTTP503. Keine DNS-, Cloud-, Firewall- oder Deployänderung. Ohne erreichbaren externen Host/SSH-Verwaltung lässt sich der dortige503 nicht durch einen lokalen grünen Endpoint reparieren.

### Kostenprognose für5–7h

**Nicht berechenbar**, weil die tatsächlichen Hetzner-/SFU-Testhosts und alle abrechenbaren Ressourcen keinem zugänglichen Provider-Scope zugeordnet sind. Frische GETs auf Hetzner servers/pricing und Vast instances waren200, die abgefragten Scopes leer; das ist **kein Nachweis0EUR Gesamtkosten** (`R5-P4-COST-SCOPE`). Keine Session-Istkosten-API angebunden. Für5/7h gilt lediglich `C5=5×R+F`, `C7=7×R+F`; R und F sind unbekannt. Rein aus50EUR folgen ohne Fixkosten höchstens10EUR/h für5h beziehungsweise50/7≈7.14EUR/h für7h. Das sind Budgetgrenzen, keine Infra-Preisprognose. Sobald echte R/F vorliegen: bei Überschreitung kürzer oder günstigere Infrastruktur, niemals stiller Capbruch. Vast-Restore bleibt weiterhin kein B3-Blocker.

### R3→R4 und Gesamtprüfstand

Der frühere ancestry Exit1 bezog sich auf **R3 gegen main**. Tatsächlich ist R3f551f68 bereits Vorfahr von Runde4fd9e5cd; Runde4 fügt genau den dokumentierten Reviewcommit hinzu. Es gibt hier keinen fehlenden R3-Commit und keinen Konflikt zu „reparieren“. Wegen roter Tests kein Merge ausgeführt; insbesondere kein zusätzlicher R5→R4-/main-Merge.

Erster breiter Lauf:3918/3922 Tests, vier Fehler im alten Preset-Mock durch die neue Delegationsschnittstelle; Mock ergänzt, Assertions unverändert. Zweiter breiter Lauf:3923/3926, drei Fehler (`R5-TS-BROAD-RED`). Zwei in geänderten Pfaden sind gezielt behoben und auf festgeschriebenem Code erneut grün: SFU-Healthprobe muss Opus **und VP8** prüfen; Auditbeleg-Schreiben gehört in den bestehenden Auditpfad statt historische Registrydateien als Deploymentkonsumenten zu führen. Die ursprüngliche Legacy-Wächter-Assertion blieb unverändert. **Unverändert rot bleibt `v2ControlRing`: Heapdelta480616B gegen Grenze16384B; Ursache ungeklärt.** DSP/Audio-Code, diese Assertion und die Schwelle wurden nicht verändert und nicht bis grün wiederholt. Keine pauschal grüne Gesamtsuite behauptet.

Postcommit Typecheck und vollständiges ESLint waren grün (`R5-TYPECHECK`, `R5-LINT`), Deadfiles grün. Die fünf geschützten früheren Checks, DSP, Audio-/RT-Gates und sechs Domain-Defaults bleiben unverändert; kein `npm run verify`, Audio-Gate oder `audit:rt:gate` neu gestartet. Alle3313 Runde4-Evidenzeinträge und56 historische Archivhashes bleiben erhalten; geschützte Schlüssel liegen weiterhin0600/0700 außerhalb Git, keine Werte in Diff/Belegen/Berichten.

**B3 nicht gestartet:** rote Heapprüfung, erlaubter Merge nicht ausgeführt, echter Istkostenkanal/Testhostscope und belastbarer aktiver Vier-Kontexte-Netzwerk-/Handoverbetrieb fehlen. Keine GPU-/PA-Messung als Ersatzvorbedingung erfunden. Noch laufende Image-Builds sind keine Merge-/B3-Freigabe.

## Runde5 – Abschluss der echten Image-Builds und zusätzliche Lebenszeitbelege

Der finale [Build43487555348](https://github.com/kAInplanmusic/audioMONASTRY/actions/runs/43487555348) auf nativen Buildquellen `2509042` ist **erfolgreich: sieben Imagejobs plus Artefakt-Aggregation**. Davor wurden die Zwischenläufe43485634312 und43486974655 gezielt beendet, nachdem Quellfingerprint-Prüfung und kanonischer LLM-Konfigurationsvertrag ergänzt wurden; keine vollständige Freigabe aus deren Teilresultaten. Die gesonderte Prüfung der tatsächlich gepinnten öffentlichen Konfigurationen lieferte für beide LLMs HTTP200 und `model_type=qwen3_5` (`R5-M2-CANONICAL-LLM-CONFIGS`). Der GUI-Executor verwendet deshalb ebenfalls Transformers5.20.2/Hub2.4.0, ohne vLLM. Audio-/Voice-Stapel bleiben getrennt; kein Modell oder Pin ersetzt.

Jeder erfolgreiche Imagejob schreibt seinen **eigenen** Buildquellfingerprint ins Artefakt. Aggregation verlangt genau sieben identische Fingerprints und Gleichheit mit den aktuellen GPU-Buildquellen. Ein während des Builds geänderter Runtime-/Buildstand kann so keinen Attest erhalten. Source-SHA256 `41517517421edc053cce061fe8aa174f245b1d580edbbc1d447c8960d2077401` ist nach dem Einlesen der tatsächlichen CI-Artefakte lokal erneut erfolgreich geprüft worden. `3760804` ist der automatisch erzeugte Artefaktcommit auf **fix/operator-round5**. Der CI-Jobname „merge“ bezeichnet hier JSON-/Artefakt-Aggregation, keinen Git-Branchmerge. Lokaler Reviewbranch wurde nur auf diesen direkten Nachfolgecommit vorgezogen; eigene neue Belege und Sourceänderungen blieben erhalten.

Die sieben vollständigen SHA256-Referenzen stehen in `deploy/vast/images.json`, der passende Quell-/Digest-Attest in `deploy/vast/image-attestation.json`, frische Registry-Größen in `image-sizes.json`. Sieben reale Auditbelege **`R5-IMAGE-<role>-2509042c9d52`** enthalten die Registry-Digests; voice/music teilen eine Referenz. **M2-Teil Buildquelle/Artefakt/Digest-Zulassung ist damit geschlossen.** GPU-Inferenz, Treiber-/CUDA-Kompatibilität auf einem konkreten Host, gemeinsame Audio-Post-/Rendererlast und dauerhaftes Renderer-Servicebinding sind damit ausdrücklich nicht gemessen. Keine GPU provisioniert oder gestartet.

Auch der Dispatch nach einer positiven **asynchronen** Serverantwort besitzt jetzt einen letzten rein synchronen lokalen Actor-/Generationscheck, ohne weiteres await bis zum Kommando. Ein zusätzlicher Microtask-Widerrufstest belegt dieses zweite Fenster (`R5-P1-FINAL-SYNCHRONOUS-FENCE`); die ursprünglichen drei Runde4-Tests bleiben unverändert. Die zugehörigen17 Control-Vertragsdateien bestanden anschließend111 Tests (`R5-FINAL-CONTROL-CONTRACTS`).

Der delegierende Nutzer behält die Plugin-Komponenten im KI-Modus verborgen gemountet, obwohl sein menschlicher Lock frei ist. So bleiben die bestehenden Listener/Bedienadapter aktiv. Die Komponente ist an ihre Generation gebunden und wird bei Übernahme entfernt; neue Generationen erzeugen neue Komponenteninstanzen. Unveränderte Grant-Nachrichten behalten ihre Objektidentität, damit eine andere Pluginmeldung keinen KI-Lauf abbricht/neustartet. Asynchrone Settings-Effekte nach Kommandoende dürfen unter dem aktuellen eigenen Grant speichern; eine ältere laufende Ausführung darf keinen neuen Grant übernehmen. Verzögerte Flushes tragen weiter die ursprüngliche Generation. Nach Server-Ablehnung wird die autoritative Session frisch angefordert (`R5-P2-CONTROLLER-CLIENT-FINAL`). Drei Browserfälle inklusive direktem KI→neuer menschlicher Halter bestanden; fremde Kopien starten keinen Controller.

Der frische lokale Healthcheck auf0512e5d belegt echten Worker-/Routerbetrieb (`R5-P4-LOCAL-HEALTH`). Der tatsächliche native VRAM-Probeaufruf ohne Test-Doubles lieferte dagegen `source=none`, `cudaAvailable=false`, `gpuVisible=false`, leere Geräte und „no_gpu_visible“ (`R5-VIS-GPU-UNAVAILABLE`): keine gemessenen0GB. Extern bleiben Origin und SFU HTTP503 (`R5-P4-EXTERNAL-HEALTH`, Exit1). Kostenprognose weiterhin **nicht berechenbar**; Zielprojekt-/Serverzuordnung wurde während der unabhängigen Buildarbeit angefragt. Eine noch ausstehende Antwort ist kein Einverständnis und keine Kostenangabe.

**Unverändertes End-Gate:** kein R3→R4-/R5→R4-/main-Merge, kein Deployment, kein B3-Start. R3 ist bereits Vorfahr vonR4; der breite Heap-Test bleibt480616B gegen16384B rot. Seine Ursache wurde hier nicht durch Wiederholen bis grün „gelöst“. Reale Provider-Istkosten, aktive Vier-Kontexte-Netzwerk-/Handoverlast und externe Dienste sind offen. Die fertig gebauten GPU-Images ändern diese B3-Entscheidung nicht.

### Finaler Reviewstand nach Controller-Integration

**112/112 betroffene Control-Verträge in18 Dateien** bestanden (`R5-FINAL-MOUNTED-CONTROL-CONTRACTS`), einschließlich des echten Client-Settings-Transports; die18-Dateien-Auswahl enthält keinen erneuten Heap-/RT-Gate-Lauf. Drei tatsächliche Browserfälle mit finalem Delegationsbetrieb bestanden (`R5-UI-DELEGATED-RUNTIME`). Vollständiger Typecheck, vollständiges ESLint mit0 Warnungen und Deadfiles bestanden (`R5-FINAL-TYPECHECK`, `R5-FINAL-LINT`, `R5-FINAL-DEADFILES`). Die vollständige breite Suite wird dadurch nicht grün umetikettiert: die dokumentierte unveränderte Heap-Grenzverletzung bleibt offen.

`R5-M2-ATTESTED-FINAL` prüft alle sieben tatsächlichen CI-Digestbelege gegen die aktuelle Source-/Imageattestierung und bestätigt acht Rollen/sieben Images/Voice-Music-Alias. Die Model-/Flotteneingaben bleiben dieselben bestätigten8/7/22. Die lokale Test-App/SFU wurde nach Prüfung ausschließlich anhand eigener PID, UID, CWD und Fixture-Kommando mit SIGTERM beendet; vollständige Sammler-Rohdaten bleiben gesichert. Kein dauerhafter Testdienst und kein produktiver Dienst wurde als Ersatz für B3 weiterbetrieben. R3 und R4 sowie main bleiben unverändert; neue Arbeit ausschließlich auf dem Reviewbranch.

# Runde6 – B3-Vorbereitung (Basis e64e3f4, R5 einschließlich3760804)

## 1. v2ControlRing-Diagnose – keine Reparatur/keine Gate-Freigabe

Der Betreiber hat genau die isolierte Reproduktion und getrennte Heap-Diagnostik autorisiert. Der ursprüngliche Test `tests/v2ControlRing.test.ts:88` wurde **einmal** mit dem Namensfilter ausgeführt:1 bestanden,11 nicht ausgewählt. Die ursprüngliche16KiB-Assertion blieb unverändert und bestand somit; der konkrete isolierte Vitest-Delta wird vom unveränderten Test bei Erfolg nicht ausgegeben. Kein Wiederholen bis grün. Beleg `R6-P1-ORIGINAL-ISOLATED`; Originalausgabe `/workspace/work/r6-data/heap/isolated-original.log`. Der alte breite Befund480616B bleibt erhalten.

Ein separater Node22.23.5-Diagnoseprozess importiert den tatsächlichen ControlRing:50×1000 Warmup, dann10000 vorab produzierte Records, Baseline direkt vor consumeAll, keine Vitest-Matcher/Logs/await/GC zwischen den beiden Heapablesungen. Rohdelta **616B** (9477088→9477704), kein beobachtetes GC-Ereignis im Messfenster, Ring danach leer. Trace meldet TurboFan-Optimierung von peek/advance. Dies ist ein eigener Diagnoseprozess, kein Zahlenersatz für den ursprünglichen Vitest-Lauf.

Ein zweiter, vorab festgelegter Prozess erfasst vor/nach demselben Workload Heap-Snapshots und ein Allokationsprofil. Auch dort616B (7509144→7509760). **Heap-Snapshots erzwingen GC und der Profiler verändert Laufzeit/JIT; deshalb keine Gleichsetzung mit dem roten ursprünglichen Lauf.** Vor/nach: genau1 ControlRing mit128B, unveränderte Anzahl der beobachteten TypedArrays, ArrayBuffers und SharedArrayBuffers. Root-Kette: GC-root shortcut→global.__ringDiagnosis→ring; dieselbe bewusst gehaltene Instanz in beiden Snapshots. Kein zusätzlicher Ring-/Buffer-Retainer in diesem einzelnen isolierten Batch. Das Profil führt getHeapStatistics mit1200 sampled bytes; kein aufgezeichneter Allokationsframe von peek/advance/consumeAll. Vor-Snapshot SHA2565b63bfaa31e3d3adbb87a3e2aafd3edd581304a8d53e0903b0dd19931980369c, Nach-Snapshot5c3ef80737d73716946855ecd23fecc6fa5855ab839975bf37b128e724269b62. Rohdaten/Profil/Snapshots bleiben unter `/workspace/work/r6-data/heap/` außerhalb Git. Beleg `R6-P1-RAW-AND-SNAPSHOTS`.

Baseline des ursprünglichen Tests: nach drei vorherigen Tests in derselben Suite (10000 verschränkte Nachrichten mit Matchern; Überlauf; attach-Sicht),50×1000 Warmup und `expect(ring.size).toBe(10000)`, dann before→consumeAll→after. Kein expliziter GC-Trigger im Test. Im isolierten Namenslauf werden die drei vorherigen Fälle nicht ausgeführt. Beim alten roten Lauf fehlen Heap-Snapshot/JIT-/GC-Zeitpunkte; sie lassen sich rückwirkend nicht erfinden.

**Ursache des alten480616B-Befunds bleibt ungeklärt.** Die Kontextabhängigkeit ist belegt; ein gehaltener Ring-/Buffer-Leak reproduziert sich in dieser Diagnose nicht.616B plus480000B könnte zu temporären HeapNumber-/JIT-Allokationen passen, ist jedoch ohne Allokationsprofil des fehlgeschlagenen Fensters nur eine Hypothese. Ein kleiner isolierter Wert beweist weder generell Allokationsfreiheit noch allein einen Fehler im Testdesign. Kein DSP-Fix und keine Leak-Datei:Zeile behauptet.

Vorschlag für eine belastbare Baseline bei **derselben16384B-Grenze**: dedizierter Node22-Prozess; feste, dokumentierte Vorbedingungen; vollständige10000er-Batches warm laufen lassen und JIT-Tier/Deopts protokollieren; Producer und Matcher vollständig vor das Messfenster; optional genau ein explizites GC **vor** der before-Ablesung, niemals GC zwischen before/after oder als nachträgliches Wegrechnen von temporären Allokationen. getHeapStatistics selbst vorab warmen. Snapshots/Profiler separat vom Gate ausführen. Das prüft weiterhin raw after-before<16384B und versteckt keine Konsum-Allokation durch ein Nach-GC. Diese Änderung ist nur ein Vorschlag, **nicht** in den ursprünglichen Test übernommen. Der breite rote Befund bleibt bis Ursachenklärung Blocker; keine Gesamtfreigabe aus dem isolierten Pass.

Die zwischenzeitlich angefragte Hetzner-Provisionierung ist für diesen neuen Scope geparkt: authentifizierte Inventur bestätigte0 Server und vorhandene vier Rollen-Snapshots, keine Ressource wurde angelegt. Origin/SFU extern, GPU-Inferenz und M2-Rest sind keine Arbeitsaufträge dieser Runde.

### R6 Punkt 2 — Istkosten blockiert, Produktionspfad geschlossen

Belege: `R6-P2-HETZNER-ACTUAL-BLOCKED`, `R6-P2-FAIL-CLOSED` (6 Tests).
Offizielle Referenz: https://docs.hetzner.cloud/reference/cloud ; tatsächlich geladene
Spezifikation https://docs.hetzner.cloud/cloud.spec.json, SHA256
`3f90e2a03d37da90cde0b14744419bde101bb20829d0d870c0c3b95c5b3d1225`.
152 Pfade, davon nur `/pricing` kostenbezogen. Dieser liefert Ressourcenpreise,
keinen aufgelaufenen Sessionverbrauch. Tokens sind laut Spezifikation projektgebunden.
Authentifizierte GETs: `/servers` 200, 0 Server; `/billing` und `/invoices` jeweils
404/not_found. Das beweist keine Abwesenheit anderer privater Betreiberkanäle.
Ein erster Node-fetch-Versuch scheiterte am Netzwerktransport; die belegten HTTP-Antworten
stammen vom anschließenden Python-Aufruf über die vorhandene Umgebungskonfiguration.

Fehlt konkret: ein vertrauenswürdiger, authentifizierter HTTPS-Istkosten-Endpunkt
mit zeitnaher Abrechnungsquelle und vollständiger Zuordnung aller Sessionressourcen
zu `sessionId`, EUR, monotonem tatsächlichem Gesamtverbrauch und Zeitstempel.
Vorhanden ist ein funktionierender Projekt-Token, kein nachgewiesener Account-Billing-
Scope/Key und kein solcher Endpoint. Zusätzliche Projekt-Schreibrechte ersetzen ihn
nicht. Leeres Serverinventar bedeutet nicht 0 EUR Session-Istkosten (z.B. Snapshots).
Keine Tarif×Zeit-Rechnung, keine Cloud-Provisionierung in dieser Runde.

Der Produktions-Einstieg `live-browser.ts` akzeptiert keine Simulation per ENV mehr.
Die gemeinsame Implementierung ist `live-collector.ts`; Simulation ist nur über den
expliziten Test-Einstieg `tests/fixtures/live-collector-simulation.ts` unter NODE_ENV=test
und Loopback möglich. Die Produktionsprüfung mit absichtlich gesetztem altem
local-staging-Flag stoppt wegen fehlender Istkosten vor CDP, speichert Rohdaten und
Checkpoint und signalisiert ausschließlich den eigenen Testprozess. Ein zusätzlicher
Guard-Test lehnt auch einen sonst gültigen simulierten Kostenwert ab.
Der 50-EUR-Cap bleibt unverändert; ohne Istkostenquelle ist B3 gesperrt, seine laufende
wirtschaftliche Durchsetzbarkeit ist nicht als grün attestiert.

### R6 Punkt 3 — echtes RTP in vier Kontexten, kein B3/WAN/PA-Nachweis

Beleg `R6-P3-REAL-RTP-FOUR-CONTEXTS`. Vier Chromium156-Kontexte mit vier
Member-Nutzern; eine zusätzliche `/master-out`-Seite im ersten Kontext (fünf Seiten,
vier CDP-Context-IDs). Echter Produktions-WebRTCManager, Signalisierung und
serverautorisierte Mixer-Übergaben. Lokale Testquelle: AudioContext-Oszillator,
kein Produktionsmix-/DSP-/Mikrofon-End-to-End-Beweis. Der Empfänger decodiert echte
RTP-Audiodaten; eigene Audio-RMS-Samples ergänzen die Transportprüfung.

Erster Lauf ist ausdrücklich fehlgeschlagen: TURN-Testbereich49200–49220 erschöpft,
Log `create_relay_ioa_sockets: no available ports 3`. Zwei Übergaben gelangen,
dritte blieb aus. Der echte Wächter stoppte bei5,006804813s Handover und signalisierte
den ausschließlich eigenen Testprozess. 1305 Rohrecords bleiben erhalten,
SHA256 `304efc56e919eae290a345100a800b73c8382391b496982acc46956f1c67a1a3`.
Keine produktive Schwelle/Policy/DSP-Änderung. Ausschließlich die lokale TURN-Fixture
wurde mit größerem Relay-Portbereich49200–49400 neu gestartet.

Zweiter Lauf: 68s Sammlerfenster, 67,973s zwischen erster/letzter positiver
Main-Out-RTP-Empfangsbeobachtung, einschließlich der Übergabeunterbrechungen.
66 Snapshots mit RTP-Empfang. Alle vier Senderkontexte nachgewiesen: maximale
empfangene Samples pro SSRC687360 /535680 /539040 /776160. Die Zuordnung erfolgt
über Empfänger-Peer-Nutzer-ID und CDP-Context-Inventar; keine behaupteten direkt
gemessenen Outbound-Paketzähler. Der vorhandene Datenschutz-Sanitizer exportiert
Samplezähler, aber keine Paket-/Bytezähler. Tatsächliche Paketanzahl unbekannt.
Drei vollständig protokollierte Handover:1,003777334s /1,991968958s /2,999957576s,
Abtastung ungefähr1s am RTP-Empfänger, keine physische PA-Ausfallzeit.

10464 concealedSamples /2443680 receivedSamples =0,004282066391671577
(0,428206639%).62 aus realen Intervall-Deltas berechnete Guard-Netzwerkfenster,
maximaler rollender Concealment-Anteil0,0459915611814346 (4,599156118%).
Keine Überschreitung der20%-Schwelle; echte Übergabewerte geprüft gegen5s.
Stopgrund `duration-complete`, SIGTERM an eigenen Testprozess belegt.
`glitchRate:null`, ausdrücklich „nicht gemessen: keine Blockzähler“.

Nach Ende des zweiten Laufs scheiterte zunächst eine neue Auswertungs-Assertion:
sie erwartete vom Sanitizer absichtlich nicht exportierte Paketzähler. Rohdaten
und Collector waren bereits vollständig; keine falsche Wiederholung des Medienlaufs.
`attestRtpContexts` wertet stattdessen die tatsächlich vorhandenen RTP-Samplezähler
und Identitäten aus. Korrigierte Nachauswertung derselben Rohdaten ist belegt;
die ursprüngliche fehlerhafte Ausgabe bleibt erhalten. Reproduktions-Harness ist
entsprechend berichtigt, Datenschutz-Allowlist/Produktivtransport unverändert.

1677 Rohrecords, SHA256
`ebf71a0a0e8914f789e84d1eae0d8ead27b279a93e3a4c8fcc56d6f8bee3e404`.
Private lokale Artefakte: `/workspace/work/r6-data/rtp-attempt1/` und
`/workspace/work/r6-data/rtp-attempt2/`, maßgeblich `rtp-attestation-corrected.json`,
`raw.ndjson`, `summary.json`, `checkpoint.json`; TURN-Logs in `turn/` bzw.
`turn-expanded/`. Kostenwerte ausschließlich Simulation im Test-Einstieg, keine
Istkosten-Attestierung. Der per SIGTERM gewählte Prozess ist ein eigener Signaltest,
keine produktive Laststeuerung. B3-Laststeuerung bleibt vor echtem Einsatz zu binden.
Lokaler echter Mediasoup-Worker/Router meldete Health; Medien in diesem Test sind
P2P über Loopback-TCP-TURN, kein SFU-Medien-/WAN-/geografischer oder PA-Latenzbeweis.
Browser-Policies unverändert, keine externen Dienste/Cloudressourcen angefasst.

Reproduktion: eigenes lokales coturn mit den bisherigen Parametern aus
`docs/verification/A4_MAIN_OUT_TRACE.md`, aber `--max-port=49400`, starten;
Node22, `LIVE_RTP_OUTPUT=<neues privates Verzeichnis> npm run audit:live:rtp-proof`.
Der Harness verlangt lokal `/usr/bin/chromium` und den vorhandenen Mediasoup-Worker
`/workspace/work/r5-mediasoup/mediasoup-worker`. Er startet keine AI-/GPU-Flotte.

### R6 Punkt 4 — konsolidierte B3-Vorbereitung, keine Freigabe

Benannter Stand: `fix/b3-preparation-round6`, direkt auf aktuellem R5/e64e3f4
(Artefaktcommit3760804 enthalten). R3 ist Vorfahr von R4, R4 von R5, R5 dieser Basis.
Kein main-Merge, kein R5→R4-Rückmerge, keine Provisionierung und kein B3-Start.

`R6-P4-B3-CONTRACT-TESTS`:114 Kontroll-/Delegations-/Main-Out-/Guard-Tests in19 Dateien
grün. Zusätzlich einmal die gesamte entdeckte Vitest-Suite mit ausdrücklich
`--exclude tests/v2ControlRing.test.ts`:3920 Tests in463 Dateien grün, keine
fehlgeschlagenen oder ausstehenden Tests innerhalb dieser Auswahl.
`R6-P4-RING-FUNCTIONAL-NONHEAP`:11 unveränderte funktionale Ringfälle grün;
der Allokationsfall per Namensfilter ausdrücklich nicht erneut ausgeführt.
Der rote ursprüngliche480616B-Befund bleibt trotz isoliertem Einzelpass ungeklärt
und blockierend. Keine Aussage „Gesamtverify grün“, keine Wiederholung von
RT-/Audio-Gates. Andere nicht ausgeführte externe/physische Gates bleiben unbekannt.
Typprüfung, Lint und Totdateiprüfung auf dem konsolidierten Quellstand separat
belegt; anfängliche neue TS-/Lint-/Entrypoint-Probleme behoben, unveränderte
Produktions-/geschützte Gates nicht abgeschwächt.

Blocker bleiben: Ursache des breiten Ring-Heapbefunds; fehlender echter
Session-Istkostenkanal samt produktiver Laststeuerungsanbindung; externer
Origin/SFU503 (außerhalb R6); physische Audio-E2E-/Blockzähler-Nachweise unbekannt;
kein erlaubter B3-Start oder main-Merge dieser Runde. Redis-Mehrkoordinator-
Delegation bleibt absichtlich fail-closed wie R5. Lokaler RTP-Erfolg hebt diese
Sperren nicht auf. Unveränderte sieben Image-Atteste und Build-Fingerprint gelten
weiter; GPU-Inferenz/M2-Rest sind nicht geprüft.

Rohdaten-Hashinventar privat lokal: `/workspace/work/r6-data/raw-manifest.json`.
Kein neuer Markdown-Bericht; historische Belege bleiben als exakter R5-Präfix
mit3360 Einträgen sowie56 geprüften Archivhashes erhalten. Die fünf geschützten
Checks, RT-/Audio-Gates, DSP, Original-Ringtest, Flotten-/Modellquellen, Image-CI
und sechs Legacy-Domain-Defaults sind unverändert.

Abschlussbelege: `R6-P4-CONSOLIDATED-STATIC-AND-SUITE` (3920/463, Typprüfung,
Lint, Totdateien, Abstammung und Image-Fingerprint) und `R6-P4-FINAL-INTEGRITY`
(Historie, Schutzdateien, Credentialprüfung). Register:3369 eindeutige Belege.
Reviewbasis ist der Tip von `fix/b3-preparation-round6`; kein vollständiges
B3-Freigabeattest, rote/unbekannte Gates bleiben wie oben ausgewiesen.

## Runde 7 — Kostenobergrenze, ControlRing-Testdesign, lokaler B3-Vorlauf

Basis `fix/b3-preparation-round6`/6ad93bf; Arbeitsbranch `fix/operator-round7`.
Kein main-Merge, keine Provisionierung, kein externer Origin/SFU-Fix und keine
GPU-Inferenz. Abgeschlossene Produktentscheidungen/Delegation/RTP-Attest R6 bleiben
unverändert und werden nicht erneut zur Entscheidung gestellt.

### R7 Punkt 1 — Servertypen und R_guard

Beleg `R7-P1-SERVER-TYPES-AND-RATES`; vollständige Tabelle mit Datei:Zeile in
`docs/SERVER_FLEET.md`, neuer Abschnitt Runde7. Die verlangten Suchbereiche
(SERVER_FLEET, deploy-YAML/JSON, sämtliche Compose-Dateien, GPU-Runtime-Manifest)
liefern die vier Hetzner-Rollenbindungen app/sfu/media/edge in der Flottendoku.
Compose enthält zusätzlich lediglich einen cx23-Monitoringkommentar.
Deploy-/GPU-Manifeste enthalten keine abweichenden Hetzner-Servertypen.
Die dahinterliegenden realen Fallbackdefinitionen wurden nur gelesen:
`scripts/hetzner/provision-fleet.sh:44–47` und
`services/portal-worker/src/index.js:31–34`. Origin/Master/Signaling sind gemeinsam
app; kein erfundener Vier-Server-Split dieser logischen Dienste.

Authentifizierter Projektbefund:0 Server, alle tatsächlichen Typen folglich
unprovisioniert. Live verfügbar gewählt in hel1:cpx42/ccx23/cpx42/cx23 statt
cx43/cx33/cx43/cx23. R_echt=0,374612EUR/h, R_guard=0,561918EUR/h,
7h=3,933426EUR<50. Bruttotarife, keine Istkosten. Der Guard-Scope ist die
Servertyp-Tarifsumme; IP/Storage/Mehrtraffic/GPU/andere Dienste nicht als
mitgemessene Rechnung behauptet. Keine Betreiberfreigabe zur Provisionierung
aus dieser Rechnung ableiten. Maschinenlesbar `deploy/live-audit-cost-bound.json`.

### R7 Punkt 2 — Test-Design war Ursache der Mehrallokation

`R7-P2-RED-BASELINE-AND-CAUSE`: erster separater Node22-Lauf mit100 vollständigen
10000er-Warmup-Batches, gewärmtem getHeapStatistics und genau einem expliziten GC
vor der Baseline war weiterhin rot: before7311352B, after7791976B,
Delta480624B gegen16384B. Kein GC zwischen den Ablesungen, kein Wegrechnen nach GC.
JIT-Rohlog enthält erneute OSR-Kompilation der Konsumschleife nach dem expliziten GC.
Das belegt die beobachtete Tiering-Abhängigkeit, nicht allein eine genaue V8-
Lebenszeitursache. Snapshot desselben roten PID200750 wurde erst nach den rohen
Messungen erzeugt und geschützt lokal aufbewahrt. Snapshot-GC kann tote temporäre
Objekte entfernen; deshalb kein nachträglicher Retained-Leak-Beweis daraus.
Snapshot-SHA256 `f2bcfb4d639c7ad0c27a52e6b88b8ec11007db2c494d4056956423ea89b1e619`.

Separate Profilerdiagnose (nicht Gate, verändert Ausführung) lokalisiert232256
sampled self bytes in der Akkumulatorschleife. TSX-Source-Map:
`scripts/audit/control-ring-allocation-profile.ts:15` (Funktionsanfang; keine
behauptete Zuordnung auf einen einzelnen Maschinenbefehl). Dazu zwei getrennte
Diagnosekontrollen mit gleicher vollständiger Erwärmung und Vor-GC:
reines peek/advance616B; reine `acc[0] += rec[CONTROL_FIELD.A]`-Arithmetik
**ohne Ringkonsum**480624B. Damit ist die Test-Prüfrechnung als Quelle des
480k-Anteils belegt (Originalstelle:6ad93bf, tests/v2ControlRing.test.ts:94); ein produktiver Ring-Leak wird dadurch nicht behauptet.
Exakte HeapNumber-Boxing-Innereien sind eine V8-Erklärungshypothese, nicht als
Objekttyp jedes einzelnen Bytes gemessen.

Korrektur misst ausschließlich echte peek/advance-Aufrufe plus Smi-fähigen
Ganzzahlzähler; der künstliche Float64-Akkumulator ist aus dem Fenster entfernt.
Stärkerer Korrektheitsnachweis:10000 konsumierte Datensätze, Ring leer,
zuletzt gelesener A-Wert9999. Alle Datenreihenfolgeprüfungen der funktionalen
Originaltests bleiben erhalten. Kein DSP-/Ring-Quellcode geändert.
`tests/v2ControlRing.test.ts` enthält weiterhin denselben obligatorischen Test,
ruft jetzt das dedizierte Node22-Gate auf und prüft dieselbe Grenze16384B.
Kein Skip und keine GC-Bereinigung nach der Messung. Profiler/Snapshots liegen
separat; nur im roten Fehlerpfad nach dem schon gespeicherten Messresultat
wird ein diagnostischer Snapshot erzeugt.

`R7-P2-CORRECTED-NODE22-GATE`: before7305800B, after7313432B,
Delta7632B, grün bei16384B. `R7-P2-MANDATORY-TEST-BRIDGE`: alle12 Ringtests
bestanden, kein Skip; separater Node22-Kindprozess Delta616B. Das ist die
Verifikation einer konkreten ursachenbelegten Testkorrektur, kein Wiederholen
des unveränderten roten Tests bis grün. Historischer roter Lauf bleibt erhalten.
Raw: `/workspace/work/r7-data/control-ring-gate/`, `control-ring-profile/`,
`differential-peek-advance-only/`, `differential-arithmetic-only/`,
`control-ring-gate-corrected/`, `control-ring-vitest-child/` und zugehörige JIT-Logs.

### R7 Punkt 3 — Obergrenzen-Guard

`R7-P3-RATE-GUARD-TESTS`:9 Tests grün, inklusive bestehender Guard-/Fail-Closed-
Verträge. Neue Methode `LiveGuard.budget` rechnet alle30s aus monoton verstrichener
Zeit und dem expliziten Manifest. Log enthält R_echt, R_guard und exakt
„Obergrenze (R_guard), keine Ist-Kosten“. Kein synthetischer CostSample im
Produktionspfad. Frische, vollständige validierte EUR-Session-Istkosten haben
Vorrang; ungültig gelieferte Istkosten stoppen weiterhin fail-closed. Bei fehlender
oder nicht erreichbarer Istkostenquelle wird ausschließlich mit gültigem
explizitem Manifest die beauftragte Tarifobergrenze verwendet. Der Quellstatus
und Fallback sind im Log ausgewiesen. Ohne gültige
Obergrenze und ohne Istkosten bleibt die bisherige Sperre bestehen.

Test mit virtueller Zeit/Rate: kurz vor50EUR kein Stop, bei50EUR
`session-cap-50-eur-upper-bound`, Rohdaten-Flush vor Stop nachgewiesen.
Zusätzliche Tests: echte Kosten haben Vorrang; ungültige Kosten, falscher Faktor,
NaN und rückläufige Zeit stoppen. Cap50EUR, bestehende Concealment-/Handover-
Schwellen und fsync-Implementierung unverändert. Dies ist die enge, ausdrücklich
beauftragte Ausnahme von der historischen R6-Istkostenpflicht, keine Behauptung,
Hetzner-Billing sei inzwischen angebunden.

Zusätzlicher Produktivpfad-Beleg `R7-P3-PRODUCTION-FALLBACK`: zwei Tests mit echtem
separatem Collectorprozess. Absichtlich nicht erreichbarer lokaler HTTPS-Billing-
Endpoint fällt ausschließlich mit explizitem Tarifmanifest aufR_guard zurück.
Die danach real fehlgeschlagene lokale Origin-Health-Prüfung stoppt weiterhin
mit dauerhaftem Journal vor SIGTERM. Kein Cloud-Billing-Erfolg aus diesem Test
behauptet. Ein Start ohne beide Kostenquellen bleibt fail-closed.

`R7-P3-CAP50-REAL-SIGNAL`: erweiterte vier Tarif-Guardtests grün. Ein zusätzlicher
Integrationstest erreicht mit virtueller Zeit/Testrate exakt50EUR und signalisiert
einen echten eigenen Kindprozess per SIGTERM, nachdem ein echtes LiveJournal
Rohmarker, Kostenobergrenze und Stopgrund per fsync samt Checkpoint gesichert hat.
Keine erfundenen Provider-Istkosten. Zusammen24 unterschiedliche gezielte Tests:
12 Ring,5 bestehende Guardverträge,4 Tarifpfad,2 Produktivcollector,1 RSS-Warnung.
`R7-STATIC-CHECKS` belegt Typprüfung/Lint/Totdateien; die letzte hinzugefügte
Signaltest-Datei wird zusätzlich in `R7-FINAL-TYPECHECK`/`R7-CAP-TEST-LINT` geprüft.
Kein Replay abgeschlossener Produktabnahmen, kein RT-/Audio-Gate-Lauf.

### R7 Punkt 4 — vollständige 30min-RTP-Daten, Abschlussfehler getrennt rot

Beleg `R7-P4-30MIN-METRICS-TEARDOWN-RED`, bewusst Exit1 für die formale
Abschlussprüfung. Der tatsächliche Collector lief1800,224s; RTP-Empfangsspanne
1799,968s einschließlich der Übergabeunterbrechungen. Vier echte CDP-Kontexte,
vier Member-URLs127.0.0.2/3/4/5; Main-Out-Seite zusätzlich im ersten Kontext.
Vier Sender eindeutig über Nutzer-ID→Kontext und Empfänger-RTP-Samples belegt.
1795 Empfängersnapshots mit RTP,1786 echte rollende Guard-Netzwerkfenster.

Concealment17876/84465600=0,00021163645318330777 (**0,0211636453%**).
Maximal rollender30s-Anteil5,4614978903%, unter20%.
Acht getStats-Handover, Sekunden:
2,001428 /3,000541 /3,000392 /0,993723 /1,000322 /1,002734 /2,005842 /1,002993.
Kein Handover über5s. `glitchRate:null`, „nicht gemessen: keine Blockzähler“.
Reale lokale Testmedienquelle (Oszillator), Produktions-WebRTCManager/Signalisierung,
P2P-RTP über lokalen TCP-TURN. Lokaler SFU-Worker/Router nur Health, kein SFU-
Mediennachweis; weder WAN noch physische PA-Latenz oder Produktions-DSP-E2E.

61 echte Obergrenzen-Polls alle ungefähr30s; letzter Wert0,2809700323EUR bei
1800,07068s, R_echt0,374612/R_guard0,561918EUR/h im Log. Keine simulierten
CostSamples im Produktivpfad, keine Istkostenbehauptung. Regulärer Guard-Stop
`duration-complete`, signalSent=true an den tatsächlichen Lastprozess201028.
43321 Rohrecords,183 fsync/Checkpoint-Flushes, Checkpoint exakt43321 Records.
Raw-SHA256 `379bfdbd1d93d642990872d658ccb58019ebebea4e9bd800354ccfcd1d6dee66`.

32 echte Speichermessungen über1801,120s, etwa60s-Abstand plus Endpunkt.
RSS-Summe des Lastprozessbaums: Start/Maximum1.956.352.000B,
Ende/Minimum1.641.607.168B. Maximum22,7749348% von8GiB;0 Warnungen>80%.
Node-heapUsed des Lastprozesses116.694.656→101.291.088B. Kein erzwungener GC.
Geteilte RSS-Seiten können mehrfach gezählt sein; Collector als Geschwisterprozess
nicht in dieser RSS-Summe. Das ist ein Verlauf dieses Laufs, kein allgemeiner
Langzeit-Leak-Freiheitsbeweis.

**Abschluss bleibt formal rot:** Nach gesichertem run-end und regulärem SIGTERM
konkurrierten das Auslesen der RMS-Seite im Lastprozess und das CDP-Aufräumen des
Collectors mit dem Schließen des Browserbesitzers. Lastprozess: `page.evaluate:
Target page, context or browser has been closed` (Exit1); Collector: unsettled
top-level await beim Freigeben von CDP-Ressourcen (Exit13). Eigener Lastprozess
und Browser sind beendet; Stop-Acknowledgement-Datei im ursprünglichen Lauf fehlt.
Der komplette Messzeitraum und die Rohdaten waren vorher bereits gesichert.
Kein finanzieller/Concealment-/Handover-Sicherheitsabbruch, aber auch kein formal
grüner 30min-Prozessabschluss. Ursprüngliche Dateien/Exitcodes werden nicht verändert.

Konkrete Korrektur: keine Browser-Evaluation mehr nach SIGTERM; jede CDP-Freigabe
mit begrenzter Wartezeit und eigener referenzierter Timer-Lebenszeit, damit ein
verschwundener Target keine offene Toplevel-Promise hinterlässt.
`R7-P4-CLEANUP-REGRESSION`: ausdrücklich **5s Abschluss-Test**, derselbe
Produktivcollector signalisiert echten Lastprozess; beide Exit0, dauerhaftes
Stop-Acknowledgement enthält den vorher geflushten Checkpoint. Das belegt den
behobenen Abschlussweg, ersetzt aber kein neues30min-Attest des bereinigten Stands.
Der neue Testoverride ist nur unter NODE_ENV=test mit1..60s zulässig und als
cleanup-only markiert; Standard bleibt1800s. Kein kurzer Lauf wird als30min
oder Vier-Sender-RTP-Abnahme umetikettiert.

Artefakte privat im Workspace:
`/workspace/work/r7-data/preflight-30min/`: raw.ndjson,summary.json,checkpoint.json,
ready.json,memory.ndjson,final-attestation.json,rss-history.csv,rss-history.svg/png,
load.log,collector.log,preflight-report.json; separater Kurztest in
`/workspace/work/r7-data/preflight-cleanup-regression/`.
Start erfolgte vor dem ersten R7-Commit auf dem vorbereiteten Arbeitsstand der
Basis6ad93bf. Spätere Kostenquell-/Abschlusskorrekturen sind separat kurzgeprüft;
kein unveränderliches30min-Releaseattest für den finalen Branch behauptet.

Status: Tarifrechnung/ControlRing/Ursachenbeleg/50EUR-Signaltest erfüllt;
30min-Transport-, Speicher- und Guard-Daten vollständig; formaler Langlaufabschluss
historisch rot, konkrete Abschlusskorrektur kurz grün. Kein main-Merge, keine
Provisionierung und keine weitergehende B3-/WAN-/PA-Freigabe. Andere rote oder
unbekannte Gates bleiben unverändert. Es wurden keine Tickets für abgeschlossene
Punkte geöffnet und keine geschützten Checks/RT-/Audio-Gates geändert.

Abschlussbelege `R7-P4-CLEANUP-LABELED-5S` (aktueller explizit5s beschrifteter
Kurztest in `preflight-cleanup-regression-v2/`), `R7-FINAL-CLEANUP-STATIC` und
`R7-FINAL-INTEGRITY`. Der ältere Kurztest hatte trotz requestedSeconds=5 noch
einen kopierten30min-Scope-Text; die Generatorbeschriftung ist korrigiert und
separat erneut5s geprüft. Alte Rohdateien werden nicht überschrieben; allein
die Langlaufdateien belegen30min. Rohdaten-Hashinventar:
`/workspace/work/r7-data/raw-manifest.json`.3385 Belege mit unverändertem3369er-
R6-Präfix. Eigene lokale Testprozesse und TURN beendet; keine Cloudressourcen
angelegt, keine externen Nachrichten gesendet, kein main-Merge.

## Runde 8 Zwischenstand und Betreiber-Monitorfreigabe

Basis f5538c6. Vier tatsächliche Sub-Agenten führten je600s im lokalen
funktionalen App-Smoke aus: Producer rot (anfänglichesMainOutRMS0),
Generator/Mastering/EQ grün. JSON: /workspace/work/r8-data/functional/combined-result.json.
Kein B3-/WAN-/PA-Nachweis. Frühere abgebrochene Starts bleiben archiviert.
Rerun mit korrigierter Streamstart-Fixture weiterhin rot: Stop
handover-over-5-seconds, CollectorExit0/LastExit1, RTP-Spanne947,006s;
kein bestandener30min-Abschluss. Rohdaten preflight-30min-rerun/ bleiben erhalten.
Vier Hetzner-Server erstellt, SSH-Key132582018, IDs176040173/174/175/176,
Typen cpx42/ccx23/cpx42/cx23 inhel1. DirekteSSH-Verbindungen abgewiesen;
Installation auf den frischen eigenen Servern über APICloudInit-Rebuild.
OriginHTTP200, SFUHTTP200+ready; Media/EdgeNodeExporterHTTP200.
Keine DNS-/TLS-/CloudFirewall-API-Änderung. Belege privat r8-data/provision.log,
bootstrap.log,remote-health-first.json; Key unter /workspace/secrets/round8/.
Betreiber beantwortete Cue-Frage ausdrücklich: Mixer-Halter Main+DJ-Cue,
andere3 lokal Main/Main+eigeneaktivePlugins/nureigeneaktivePlugins.
Monitor-Implementierung3c8a791 umfasst eigeneMehrquellenfilter, privaten
Audio-Abhörtransport, serverautorisierte Punkt-zu-Punkt-Signalisierung,
keine Rückführung inMain. Monitor-Routingtests undClient/Backendtests grün;
echterBrowser-Loopback-ProofExit0, keinWAN/PA; Typprüfung nach Korrektur grün.
Belege r8-data/monitor-*-tests.log,private-monitor-proof/ und
monitor-sealed-typecheck.log. VollständigeIntegration/Abschlussbericht und
formalergrüner30min-Nachweis stehen noch aus. Kein main-Merge.

### Runde8 Fortsetzung: Ressourcen, Monitorintegration und echte Fehler

Betreiber präzisiert höchstens zwei Terra-Subagenten mit geringer Denktiefe.
Der neue Funktionstest verwendet deshalb einen tatsächlichen Modellagenten für
vier deterministische Playwright-Rollen-Worker; das ist kein neuer Vier-LLM-
Agenten-Beleg. Frühere echte Vier-Agenten-Läufe und deren rote Ergebnisse
bleiben archiviert. B3 mit Menschen bleibt getrennt; kein WAN/PA-Nachweis.

R8-MONITOR-TARGETED-41: acht Dateien,41 Tests grün. Hook-Mitgliederliste nimmt
nun den lokalen Nutzer explizit auf: sessionPeers enthält nur andere Nutzer.
Ohne diesen Eintrag konnte der private Transport in der tatsächlichen App
nicht starten. Separater Browser-Proof R8-MONITOR-NATIVE-PRIVATE-PROOF:
drei Empfänger, Audio-only, jeweils5s RMS>0; feste lokale Oszillator-Fixture.
Im neuen Full-App-Versuch nach realer Dateiwiedergabe zusätzlich privateMainSource
bei allen drei Nicht-DJs vorhanden; private-main-readonly.json. Das ist noch
kein vollständiger Nachweis aller drei Abhörmodi unter Cloud-/WAN-Bedingungen.

Sender-Lebenszeitfehler: bei Verlust des Main-Out-Halters schloss bisher nur
der Output-Empfänger die alte Verbindung. Wiedererwerb konnte eine alte
Sender-ICE-Verbindung gegen das frische Output-Angebot neu verhandeln.
Nun werden auf dem ehemaligen Sender ausschließlich Output-Listener-Peers
geschlossen; Studio-DataChannels bleiben bestehen. Neue Regression gegen
alten Stand rot, mit Fix grün; handover-sender-prefixed-baseline.log und
handover-sender-tests.log. Keine Aussage, dass damit jeder ältere Guard-Stopp
allein erklärt ist. Schwellen/Cap/ControlRing/Delegationscode unverändert.

Der beaufsichtigte600s-Funktionstest hat einen realen roten Befund gefunden:
biblioMONK OFF und PLUGIN_UNLOCK erfolgreich, danach erneute PLUGIN_LOCK-
Anforderungen des Producer-Clients im20s-Rhythmus. Serverzustand weiterhin
OFF mit Halter. Primärer Test bleibt rot; geschützte Lock-/Delegationslogik
bleibt unangetastet. Separate Wiederherstellung über reale UI: erneut aktivieren,
freigeben und Mixer übertragen. Mastering auf eigenem soundMONK/CH7, Preset Goa,
Fremdsperren bei drei Nutzern und5s Main-Out-RMS0,048359 geprüft. Das ersetzt
den roten Primärlauf nicht. Frühere DOM-detach-Probleme der Library-Menübedienung
sind als Testfehler getrennt protokolliert; begrenztes Wiederöffnen des echten
Menüs statt Force-Click oder Rechteumgehung.

R8-HETZNER-FOUR-HEALTH: vier öffentliche HTTP200-Prüfungen, Quellef5538c6
auf Origin/SFU, Media/Edge nur Node-Exporter. SSH-Key132582018; direkter SSH-
Zugang aus Workspace abgewiesen. Erfolgreiche Installation über CloudInit
der neu erstellten eigenen Server, keine DNS/TLS/Cloud-Firewall-Änderung.
R8-STATIC-CHECKS: typecheck/lint/deadfiles grün. R8-INTEGRITY-REVIEW:
3385 historische Einträge als exakter Präfix und56 Archivhashes erhalten;
keine geheimen Werte in versionierten Quellen/Belegen.

### Runde8 Abschluss dieses Reviewstands

**Funktional-Gate rot**, Beleg R8-FUNCTIONAL-600S-RED: alle vier Rollen
liefen600s gleichzeitig in vier Kontexten, ein tatsächlicher Modellagent
wegen Betreiberlimit max2. Producer600,052s rot, Generator600,068s grün,
Mastering600,072s rot, EQ600,065s grün. Producer5s Main-OutRMS0,0091699,
ausschließlich Audio; genau ein aiMONK-Feld in allen vier Kontexten.
Generator: echte Delegation/Modusreplikation/Fremdsperre, Ergebnis-Fixture statt
GPU-Inferenz. EQ: eigene Aktion/Replikation/Fremdsperren grün. Mastering-Primärlauf
durch fehlende Freigabe/Übergabe blockiert; separate Recovery grün, RMS0,048359.
Lock-Diagnose: functional/lock-diagnosis.json; ursprüngliche API-Rohantworten
nicht gespeichert, genaue Callback-Reihenfolge ungeklärt. Keine Änderung der
geschützten Lock-/Delegationslogik und keine Umdeutung der Recovery als Pass.

**30-Minuten-Rerun formal grün**, Beleg R8-30MIN-COMPLETE-EXIT0:
1800s angefordert, Beobachtungsspanne1799,996s, RTP-Spanne1799,983s,
alle vier Senderkontexte mit echten empfangenen RTP-Samplezählern.
CollectorExit0, LastExit0, stopReason duration-complete. Stop-Acknowledgement
SIGTERM enthält denselben finalen Checkpoint wie raw.ndjson:43380 Records,
182 Flushes. Concealment31828/81998880 =0,0388152%; acht Handovers,
maximal2,003607s.32 RSS-Messpunkte, Maximum22,391987% des Speicherlimits,
keine80%-Warnung. Guard50EUR unverändert, R_guard0,561918EUR/h, letzte
**Obergrenze0,28097077EUR, keine Ist-Kosten**. Kein Guard-Sicherheitsabbruch.
glitchRate bleibt null/„nicht gemessen“, keine Blockzähler/PA-Latenz.
Lokaler P2P-Main-Out über TCP-TURN auf127.0.0.2/3/4/5, kein WAN-/SFU-Medienbeweis.
Gestartet auf09c197b mit Sender-Lebenszeitkorrektur im Arbeitsbaum, danach
alsb081e82 committed; keine Behauptung eines vorab unveränderlichen Releaseattests.
Frühere rote/abgebrochene Versuche bleiben erhalten.

Artefakte: /workspace/work/r8-data/preflight-budget-final/ mit raw.ndjson,
summary.json,checkpoint.json,load-stopped.json,preflight-report.json,
final-attestation.json,memory.ndjson,rss-history.csv/svg,load.log,collector.log.
Funktional: /workspace/work/r8-data/functional/{combined-result.json,compact-result.json},
Einzelrollen und separate Recovery. Hashinventar r8-artifact-manifest.json.
Vier Hetzner-Server bleiben in Betrieb; kein weiterer Ressourcenaufbau.
Eigene lokale Testprozesse und TURN nach Abschluss beendet.
Reviewbranch fix/operator-round8; kein main-Merge, kein menschlicher B3-Start,
kein B3 bestanden. Kein DNS/TLS/Cloud-Firewall-Eingriff.
Rote Gates bleiben rot, unbekannte Eigenschaften unbekannt.

## R9 — Architektur-Umbau: Backend-Main und verlustfreier PA-Transport

### 1. Stand

Datum: 14.11.2026, Europe/Berlin. Basis `fix/operator-round8` / `fd54143`;
separater Reviewbranch `fix/backend-main-architecture-r9`, Implementierung
`2aca5fa`, Berichtabschluss separat. Kein main-Merge, Deployment, menschlicher
B3-, WAN- oder physischer PA-Test. Die früheren R9-Lock-/Mastering-Änderungen
wurden nicht übernommen. Geschützte Quellen und R8-Rohdaten sind unverändert
(`R9-ARCH-INTEGRITY`). MIDI/USB bleiben lokal im unveränderten Browserpfad;
eine Hardwareprobe wurde nicht durchgeführt (`R9-ARCH-FINAL-INTEGRITY`).
Dies ist ein **Teilumbau, keine vollständig integrierte
oder freigegebene App** (`R9-ARCH-INTEGRATION-GAPS`).

Abweichung im Vorgehen: Quellpfade wurden vor Änderungen geprüft; die vollständige
Dokumentensuche mit dem ausdrücklichen Gegenbeleg im Audit vom07.10. wurde erst
später ergänzt. Die geforderte100%-Vorabprüfung war insoweit nicht vollständig
vor den Codeänderungen belegt. Die zeitliche Reihenfolge bleibt im Beleg erhalten
(`R9-ARCH-IST`, `R9-ARCH-DOC-CONFLICT`).

### 2. Ist-Zustand der unveränderten Basis

Die folgenden Zeilen beziehen sich ausdrücklich auf `fd54143`, nicht auf die
spätere Zeilennummerierung dieses Branches (`R9-ARCH-IST`).

| Punkt | Datei:Zeile und Zitat | Ist / Soll / Abweichung |
|---|---|---|
|1.1 Main-Rendering|`src/App.tsx:335–341`: „mixerMONK-Halter … Master-Stream-Sender“, `createMasterStreamDestination()` → `startMainStream(dest.stream)`|Ist: aktiver Main aus DJ-Browser. Soll: Backend. Abweichung: **ja**.|
|1.2 Main→PA|`WebRTCManager.ts:328–343`: Browsertracks an `master-out`; `opusMusicSdp.ts:32–35`: `opus/48000`; `MasterOutPage.tsx:40–44`: empfangener MediaStream am Audioelement|Ist: RTC/Opus, verlustbehaftet48kHz. Soll: verlustfreies Backend-Main,96kHz Standard. Abweichung: **ja**.|
|1.3 Monitor|`src/core/audio/live/V2SinkEngine.ts:761–767`, `src/audio/monitorRoutingFacade.ts:195–196`: lokale Blockberechnung und `planMonitorRouting`|Ist: lokaler Browser-Renderer. Soll: lokaler Browser-Renderer. Abweichung beim Renderort: **nein**; physische<20ms zunächst unbekannt.|
|1.4 Rate|`audioEngine.ts:25–26`: konfigurierte AudioContext-Rate; `V2SinkEngine.ts:428`: Standard48000; `services/master-player/server.py:39,130`: `TARGET_SR=48000`|Ist: Browseroptionen ohne garantierten96k-PA-Pfad, alter Backend-Decoder fest48k. Soll:96k Standard,48/192k wählbar. Abweichung: **ja**.|
|1.5 Import|`audioAnalyzer.ts:42–58`: `decodeAudioData`; `master-player/server.py:204,228`: vorhandener FFmpeg-Dateidecoder|Ist: browserabhängiger Import plus Backend-Dateidecoder48k. Soll: belegte sieben Formate und passende Ausgaberate. Abweichung: **ja beim Nachweis/96–192k-Pfad**; keine unbelegte Behauptung, FFmpeg könne die Formate grundsätzlich nicht lesen.|
|1.6 Dokumente|`AGENTS.md:11`: „master audio engine lives within the core backend“|Dokument-Soll entspricht dem Auftrag; aktiver Browser-Main widerspricht ihm.|

**Zusätzlicher ausdrücklicher Widerspruch:**
`docs/audit/AUDIT_2026-10-07_ECHTZEIT.md:124` fordert „**Browser behalten**“ und
nennt als Begründung die Latenz. Das widerspricht dem neuen verbindlichen Auftrag.
Auch `docs/verification/A4_MAIN_OUT_TRACE.md:5,121` beschreibt ältere Browser-/PA-
Annahmen. Die Texte bleiben als Historie erhalten und werden hier als Widerspruch
markiert; daraus wird keine neue Latenzbegründung für Browser-Main abgeleitet.
`docs/ARCHITECTURE.md` existiert in der Basis nicht. Beleg `R9-ARCH-DOC-CONFLICT`.

### 3. Umbau-Status pro Aufgabe2–5

**Aufgabe2 — Backend-Main: Teilstand.**
`server/backendMainMixer.ts:10,17,23,43` mischt zeitgestempelte Stereo-PCM24-Spuren
im Backend. `server/backendMainTransport.ts` besitzt Sitzungstimer, begrenzte
Eingabequeues, Clipping-/Missing-Sample-Zähler und den Ausgabetransport.
`server/backendMainAccess.ts:18,31,64` bindet Einmaltickets an eine bestehende
Studio-Sitzung und prüft bei Beiträgen den aktuellen menschlichen Plugin-Lock.
`server.ts:1290` verdrahtet den Dienst. Keine neue Grant- oder Lock-Implementierung
(`R9-ARCH-CODE-STATUS`, `R9-ARCH-TARGETED-FINAL`, `R9-ARCH-INTEGRITY`).

`src/App.tsx` publiziert den DJ-Main nicht mehr; der alte SFU-Main-Hook wurde
entfernt. `WebRTCManager.ts:343` erlaubt im bisherigen Main-Medienweg nur noch
Visual-Video. `MasterOutPage.tsx:26–32` verbindet sich mit Backend-Main, nicht
mit einer empfangenen RTC-Audiospur. Visual- und Studio-Isolation sind geprüft
(`R9-ARCH-CODE-STATUS`, `R9-ARCH-TARGETED-FINAL`).

Vier echte App-Kontexte mit tatsächlichen Plugin-Locks und Tickets schicken
PCM-Testbeiträge durch die öffentliche Schnittstelle. Die echte PA-Seite erhält
den Backend-Mix; nach DJ-Browserschließung kommen die Beiträge der drei übrigen
Kontexte weiter an. Der vierfache Referenzwert10000/8388608 und danach9000/8388608
sind in den geplanten Audiobuffern vorhanden. **Die Beiträge sind injizierte
Transport-Fixtures, keine automatisch abgegriffenen Plugin-Ausgänge.** Der
zunächst verwendete Ausgabecodec wurde nicht protokolliert; das frühere Stage-Label
„FLAC“ war kein Codec-Nachweis (`R9-ARCH-APP-FOUR-CONTEXTS`). Der verschärfte
Nachweis identifiziert den tatsächlichen DJ eindeutig, schließt dessen Browser-Kontext
und prüft vier komplette PA-Puffer/400ms. Jeweils19200 Samples pro Stereo-Puffer
sind uniform und haben die beobachteten Referenzwerte10000/8388608 beziehungsweise
9000/8388608. Vier fortlaufende Metadatenpakete protokollieren96000Hz, PCM24,
`encoder-slow`,84,908ms vorherige FLAC-Encodingzeit, keine fehlenden oder
abgeschnittenen Samples. Das ist kein Langlauf oder autonomer Asset-Wiedergabe-
Nachweis (`R9-ARCH-APP-EXPLICIT-DJ`).

Offen bleiben automatische Ausgänge aller16 Plugins, KI-grantgebundene Audio-
Einspeisung, autonome Backend-Asset-/Playlist-Wiedergabe, DJ-Steuer-/Tick-Brücke
und Backend-Mastering-DSP. Der normale App-Datei-/Plugin-Workflow liefert dem
neuen Main noch keine automatischen Beiträge. Der bestehende Main-Monitorinput
kommt weiterhin aus der privaten Browser-Vorschau; seine Versorgung mit dem
Backend-Main ist ebenfalls offen. Kein Produktions-Main-Nachweis für diesen
Gesamtworkflow (`R9-ARCH-INTEGRATION-GAPS`).

**Aufgabe3 — Monitor lokal bestätigt, physischer Nachweis offen.**
Monitor-Renderer, Routing, Opus-Abhörtransport und DSP wurden nicht verändert.
Die lokale Tick-/Frame-Quantisierung liegt unter anderem in
`C0StudioChain.ts:317–324`, `nodes/pluginSourceNode.ts:93,136–138`; das lokale
Rendern und Cue-PDC in `V2MonitorGraph.ts:278–324`. Die Impulsprüfung führt den
realen Graphen mit128er-Blöcken aus, ohne Server-Roundtrip im Renderfenster.
MAIN/MIX/PLUGIN ergeben mit Standard-DSP nach eingeschwungenen Routing-Gains bei
48/96/192kHz jeweils240/480/960 Samples = **5ms Software-Graphverzögerung**.
CPU-Ausführungszeit wird separat erfasst. Das belegt weder Audiohardware noch
Netzempfang/Trigger-zu-Kopfhörer unter20ms. Diese physische DoD bleibt unbekannt
(`R9-ARCH-MONITOR`, `R9-ARCH-INTEGRITY`).

**Aufgabe4 — verlustfreier Zwischenstand, WebTransport offen.**
`BACKEND_MAIN_SAMPLE_RATE` in `server.ts:1254–1255` erlaubt48000/96000/192000,
Standard96000. Der Main verwendet WebSocket+FLAC. Überschreitet das Encoding80ms
oder verzögert es einen Render-Tick, schaltet der Dienst für die Sitzung auf
Raw-PCM24LE um; Metadaten enthalten Format, Ursache und Encodezeit. Sequenz und
Samplefolge bleiben erhalten. Alte PA-Unterläufe und verspätet zurückgewiesene
Testpakete sind gesichert; sie werden nicht als Pass umetikettiert
(`R9-ARCH-CODE-STATUS`, `R9-ARCH-TARGETED-FINAL`).

Native Chromium-AudioContexts und geplante AudioBuffers sind für FLAC **und**
RawPCM24 bei allen drei Raten getestet:4800/9600/19200 Stereo-Frames pro100ms,
null abweichende Samples. Das ist ein digitaler Wellenformvergleich gegen die
**PCM24-Referenz**; keine pauschale Bitgleichheitszusage gegenüber beliebigen
vorherigen Float32-Pluginwerten oder der physischen PA. Übersteuerung ist als
Clipping-Zähler sichtbar; ein transparenter Backend-Mastering-/Headroompfad ist
noch nicht angeschlossen. Kein allgemeiner Hörbeweis „artefaktfrei“
(`R9-ARCH-NATIVE-RATES-WAVEFORM`, `R9-ARCH-INTEGRATION-GAPS`).

Chromium156 meldet im sicheren localhost-Kontext einen WebTransport-Konstruktor.
Ein HTTP/3-/QUIC-Server und eine erfolgreiche WebTransport-Sitzung sind **nicht**
implementiert. Damit wird die ausdrücklich erlaubte Zwischenlösung geliefert.
DAC-/Treiber-Raten und ein Browser-/Gerätematrixlauf bleiben unbelegt
(`R9-ARCH-NATIVE-RATES-WAVEFORM`).

**Aufgabe5 — Backend-Decoder und Formatnachweis vorhanden, UI-Verdrahtung offen.**
`server/backendAudioDecode.ts:30–67` dekodiert begrenzt mit FFmpeg nach Stereo-
PCM24; `server.ts:1112` bietet den authentifizierten Binär-Endpunkt
`POST /api/main-audio/decode?sampleRate=96000`. Eingabe-/Ausgabe-/Zeitlimits und
maximal zwei gleichzeitige HTTP-Decodes sind gesetzt. Der Endpunkt begrenzt
seine Ausgabe auf64MiB; lange DJ-Dateien benötigen einen Streaming-Decoder statt
vollständiger In-Memory-Dekodierung. Der bestehende UI-Import wurde noch nicht
vollständig auf diesen Dienst umgestellt (`R9-ARCH-CODE-STATUS`,
`R9-ARCH-INTEGRATION-GAPS`).

Bei der MP3-Probe ergab stdin11614 statt9600 Frames. Dieselbe Datei als seekbare
Eingabe entspricht der FFprobe-Referenz. Identifizierte MP3-Eingaben verwenden
nun eine private temporäre Datei, erzwungenes MP3-Demuxing und anschließende
Bereinigung; andere Formate bleiben pipe-only. Das alte rote Ergebnis bleibt
vorhanden. Die exakten96k-Ausgabezahlen der sieben Dateien sind:
WAV9600, MP39600, FLAC9600, AAC11264, AIFF9600, OGG9472, M4A10240. Alle stimmen
mit der unabhängig gezählten, gegebenenfalls rate-skalierten FFprobe-Referenz
überein. Codec-Padding wird nicht als ursprüngliche Quelldauer ausgegeben
(`R9-ARCH-FORMAT-COUNTS`, `R9-ARCH-TARGETED-FINAL`).

### 4. Gezielte Tests: Befehl, Ausgabe, Exit

Alle Node-Befehle liefen mit Node22 im PATH. Vollständige Ausgaben liegen unter
`/workspace/work/r9-architecture-data/`; Belege enthalten Kommando, Ausgabe,
Exit, Zeitstempel und Quellbezug.

| Befehl | Ergebnis | Exit / Beleg |
|---|---|---|
|`vitest run tests/backendMainMixer.test.ts tests/backendMainTransport.test.ts tests/backendMainAccess.test.ts`|10 Tests grün, darunter Bytegleichheit, Berechtigungsentzug, PCM-Fallback und zusammenhängende Frame-/Sequenznummern|0, `R9-ARCH-TARGETED-FINAL`|
|`vitest run tests/backendAudioDecode.test.ts`|10 Tests grün; MP3-Regressionsbefund vor Fix rot gesichert|0, `R9-ARCH-TARGETED-FINAL`|
|`vitest run tests/mainOutIsolation.test.ts tests/masterOutErrors.test.tsx`|14 Tests grün; PA ohne RTC-Audio, Visual-Video weiterhin erlaubt, erster Fehler bleibt sichtbar, späte Callbacks heilen Fehler nicht|0, `R9-ARCH-TARGETED-FINAL`|
|`node --import tsx scripts/audit/backendMainAppProof.ts`|vier reale App-Kontexte, menschliche Locks, PA-Buffernachweis und Fortsetzung nach DJ-Schließen; nur Transport-Fixture|0 mit gespeicherter `.exit`-Datei; exaktes Kommando/Provenienz in `backend-main-app-command-explicit-dj.json`, `R9-ARCH-APP-EXPLICIT-DJ`|
|`node --import tsx scripts/audit/backendMainPlaybackBrowserProof.ts`|sechs native Browserfälle FLAC/RawPCM ×48/96/192kHz, Samplevergleich exakt|0, `R9-ARCH-NATIVE-RATES-WAVEFORM`|
|`node --import tsx scripts/audit/backendDecodeFrameProof.ts`|alle sieben Dateien gegen exakte FFprobe-Framezahl; vorheriger MP3-Fehler separat erhalten|0, `R9-ARCH-FORMAT-COUNTS`|
|`node --import tsx scripts/audit/monitorGraphImpulseProof.ts`|neun Fälle, lokale Softwareverzögerung5ms; keine physische E2E-Messung|0, `R9-ARCH-MONITOR`|

Die erste grüne App-Probe speicherte keine ursprüngliche `.exit`-Datei und
schloss Kontext0 ohne ausdrückliche Abfrage des Mixer-Halters; deren Tool-Exit und spätere Dateiprüfung bleiben getrennt. Der spätere strengere
DJ-Nachweis hat eine echte `.exit`-Datei. Ein zusätzliches Metadaten-Assert war
hatte zunächst keine eigene Wartebedingung für alle vier Metadatenpakete;
der rote Lauf sicherte nur drei relevante Audiobuffer und keine Metadatenliste.
Nach Ergänzung der Wartebedingung, ohne Abschwächung der
Vier-Paket-Assertion, bestand die Probe. Dieser rote Zwischenlauf, die frühen
PA-Unterläufe/Paketablehnungen und Decoderfehler bleiben separat erhalten
(`R9-ARCH-APP-FOUR-CONTEXTS`, `R9-ARCH-APP-EXPLICIT-DJ`, `R9-ARCH-ARTIFACTS`).

### 5. Gesamttests und rote Gates

Erster vollständiger `npm run verify`-Aufruf: Exit1,3961 Tests grün/9 rot.
Nachgewiesene Codekorrekturen waren MP3-Framezahl, Plattformkapselung,
verlustfreier PCM-Fallback und Umstellung der alten PA-Verträge. Danach wurde
`npm run verify` auf dem eingefrorenen Stand erneut ausgeführt: Exit1,
**3970 grün/2 rot in475 Dateien**. Übrig bleiben ausschließlich
`boundaryTokenizer.test.mjs` und `userExportBoundary.test.mjs`; beide beanstanden
`src/utils/privateMonitorTransport.ts:17,55`. Dieser Monitor-Quelltext entspricht
unverändert der R8-Basis. Keine Scanner-Ausnahme/Assertion wurde abgeschwächt
(`R9-ARCH-VERIFY-FULL`, `R9-ARCH-INTEGRITY`).

Die durch `&&` nach dem ersten Fehler nicht gestarteten Gates wurden einmal
separat aufgerufen. Der zweite Kettenlauf stoppt ebenfalls bei den bekannten
Boundary-Tests; insbesondere wurde das RT-Gate **nicht** bis grün wiederholt.
Die getrennten Quellstände und Befehle sind in `overall-checks.json`, den beiden
Verify-Logs und den gezielten Nachprüfungen erkennbar (`R9-ARCH-VERIFY-FULL`).

| Befehl | Exit | Befund |
|---|---|---|
|`npm run typecheck`|0|auch im abschließenden Kettenlauf grün|
|`npm run lint`|0|auch abschließend grün|
|`npm run test`|1|abschließend2 Boundary-Tests rot,3970 grün|
|`npm run test:python`|0|vollständiger definierter Paketbefehl,867 Fälle gemeldet,1 eingebauter Skip; dessen genaue Ursache steht nicht im nicht-verbose Log|
|`npm run security`|3|strikter npm-Audit nicht messbar: bulk/full HTTP0;667 Abhängigkeiten nicht geprüft, kein Sicherheits-Pass|
|`npm run audio:gate`|0|Software-Gate grün, kein Hardware-Audio-Beweis|
|`npm run audit:rt:gate`|1|17/20 Grenzen; GCmax13,138ms statt<1ms, p99,9 2,991ms statt<1,33ms,26 Blöcke über2,67ms statt0. Ursache nicht isoliert; Quellcode/Schwellen unverändert|
|`npm run test:rls`|0|bestehender Wrapper meldet mangels ENV einen Skip, kein RLS-Nachweis|
|`npm run verify:rls-live` zusätzlich strikt/read-only|2|mit geschützten Zugangsdaten versucht, RPC-Aufruf scheitert an `fetch failed`; Zustand unbekannt|
|`npm run check:deadfiles`|zunächst1, danach0|entfernter alter SFU-Main-Hook zunächst ungenutzt; nach Entfernung gezielt grün|
|`npm run audit:deep:static`|1|37 Findings; Boundary-Check und React.memo-Gate (`AiMonkTerminal.tsx`) rot. Keine Gleichsetzung mit einem grünen Gesamtaudit|
|`npm run verify:summary`|0|meldet die vorhandene RLS-Auslassung; hebt rote Gates nicht auf|

Belege: `R9-ARCH-VERIFY-FULL`, `R9-ARCH-PYTHON-SKIP`,
`R9-ARCH-INTEGRITY`. Python-Skips und der interne RLS-Skip werden nicht als
„alles ausgeführt“ ausgegeben; der Auftrag ohne jede Auslassung ist insoweit
nicht vollständig erfüllt. Weder RT-Grenzen noch bestehende Monitor-/aiMONK-
Quellen wurden zur Berichtsbereinigung geändert.

### 6. Fertig und offen

Fertig sind der getestete Backend-Misch-/Transportkern, die angeschlossene
PA-Seite, menschlich autorisierte Testbeiträge,96k-Standard mit48/192k,
FLAC/PCM24-Samplegleichheit, sieben Backend-Formate samt korrigierter MP3-
Framezahl und der lokale Monitor-Softwaregraphnachweis. Grenzen der Belege
stehen jeweils oben (`R9-ARCH-CODE-STATUS`, `R9-ARCH-APP-FOUR-CONTEXTS`,
`R9-ARCH-NATIVE-RATES-WAVEFORM`, `R9-ARCH-FORMAT-COUNTS`, `R9-ARCH-MONITOR`).

Offen sind die automatisch sendenden16 Plugin-Adapter, KI-Grant-Audioeingang,
autonomer Backend-Datei-/Playlist-Renderer mit DJ-Steuerung und musikalischer
Clock-Brücke, Backend-Mastering-/Headroompfad, Backend-Main als Monitorinput,
Streaming-Import langer Dateien und HTTP/3-WebTransport. Das neue Binärformat
hat derzeit32-Bit-Framepositionen und einen2s-Eingabevorlauf; lange Sitzungen
sind nicht attestiert. Hardware-/WAN-/Mehrbrowsermatrix und physische<20ms
bleiben unbelegt. Daher kein vollständiger Produktions-/Qualitäts-/Stabilitäts-
Pass (`R9-ARCH-INTEGRATION-GAPS`, `R9-ARCH-CODE-STATUS`,
`R9-ARCH-NATIVE-RATES-WAVEFORM`, `R9-ARCH-VERIFY-FULL`).

### 7. Offene Architekturfragen an den Betreiber

- Soll die Bitgleichheits-Referenz verbindlich PCM24 sein, oder müssen ursprüngliche Float32-Pluginwerte vollständig erhalten bleiben? Der geprüfte Vertrag ist momentan PCM24.
- Welche konkrete PA-Kette aus Betriebssystem, Browser, Audiointerface und Treiber soll96/192kHz physisch attestieren? Die bisherigen Belege enden am nativen Browser-Audiobuffer.
- Welche Messstrecke bezeichnet die<20ms-Monitorforderung: lokaler DSP-Graph, oder einschließlich Controller/Quellenempfang, OS und Ausgabegerät?5ms Graphdelay ist kein Nachweis dieser Gesamtstrecke.

Diese offenen Punkte ändern weder das verbindliche Backend-Main-Ziel noch die
festgelegte Prioritätenreihenfolge. Sie sind keine Begründung für Browser-Main
(`R9-ARCH-INTEGRATION-GAPS`, `R9-ARCH-MONITOR`,
`R9-ARCH-NATIVE-RATES-WAVEFORM`).

### 8. Endbelege

Belegregister `EVIDENCE_REGISTRY.json`, Präfix `R9-ARCH-*` mit Befehlen,
Ausgaben, Exits, Zeitstempeln und Quellbezügen. Rohdaten/gescheiterte Versuche:
`/workspace/work/r9-architecture-data/`. Runtime-Quellhashes:
`runtime-source-hashes.json`. Versiegeltes Inventar:
`architecture-artifact-manifest.json` (`R9-ARCH-ARTIFACTS`).

3396 historische Belege als exakter Präfix,56 Archivhashes und87 versiegelte
R8-Artefakte bleiben unverändert. Keine geheimen Providerwerte in den geprüften
versionierten Quellen. Kein main-Merge, Cloud-DNS-/TLS-/Firewall-Eingriff,
Imagebau, GPU-Inferenz oder B3-Start; lokale Prüf-Fixtures beendet
(`R9-ARCH-INTEGRITY`, `R9-ARCH-ARTIFACTS`).

**Fertig:** getesteter Backend-Mix-/PA-Transportkern und Backend-Formatnachweise.
**Offen:** vollständige Plugin-/DSP-/Clock-/Monitor-Anbindung, WebTransport und
physische Abnahme. **Blockiert durch:** fehlende Integrationspfade und Messhardware
sowie die dokumentierten roten/unmessbaren Gates.

## R11 – Zeitachsen-Diagnose: gemeinsamer Lastblocker, kein Laufzeitfix (2026-11-14)

Basis exakt `2b93487`, Branch `fix/source-timeline-r11`. Keine Produktionsdatei,
kein Adapter, kein Mastering, keine State-Matrix, kein Boundary-Test und kein
Gate verändert. Das neue Auditwerkzeug
`scripts/audit/backendMainTimelineDiagnosis.ts` betreibt vorhandene App-/Player-
Ausgänge mit festem WAV-Input; es injiziert keine Ausgangspakete. Kein PA-
Empfänger, keine WAN-Messung, keine GPU-Inferenz, kein main-Merge. Node22.

**Ergebnis: drumsampler rot, instru rot im Vier-Quellen-Lauf. Kein Fix ohne
hinreichend isolierte Ursache.** Belegt ist ein gemeinsamer, lastabhängiger
AudioContext-/Server-Zeitachsenrückstand auf dem auf2 CPUs begrenzten Testhost.
Nicht belegt ist ein exklusiver Defekt dieser beiden Adapter. Die konkrete
Verteilung auf Audio-Thread, Chromium-/OS-Scheduler und UI-/DSP-Last bleibt
weiter offen; CPU-Drosselung allein wird nicht als vollständig isolierter
Browser-Root-Cause ausgegeben. Es gibt keinen grünen30s-Vier-Quellen-Nachweis.

### Reproduktion und Eingrenzung

Rohdaten: `/workspace/work/r11-data/`, je Lauf `result.json` und `server.log`.
`timings.json` enthält alle Einzelmessungen. Der Sammlerexit0 bedeutet nur
„Diagnose erfasst“, nicht „Audio bestanden“.

| Versuch | Ergebnis |
|---|---|
| `mixed1`, drop/song/syntisampler/drumsampler | Alle4 mit verspäteten Frames abgebrochen; Quellzeit/Wanduhr0,682–0,741 |
| `mixed2`, identische Gruppe | Wiederholbar:3 Frame-Abweisungen, ein weiterer Start-/Verbindungsabbruch; Verhältnis0,702–0,755 |
| `instrumented-mixed`, zusätzliche AudioContext-/SRC-Messung | Wieder derselbe gemeinsame Rückstand,0,713–0,752; alle Tabs melden sichtbar |
| `drum-alone` | Rund12s beobachtet, kein Abbruch;12039ms Wanduhr vs12056,96ms AudioContext-/Quellzeit |
| `instru-alone` | Rund12s beobachtet, kein Abbruch;11991ms Wanduhr vs11952,47ms AudioContext-/Quellzeit |
| `drop-8251` bis `drop-8254`, vier echte Drop-Instanzen | Drei Frame-Abweisungen, einmal Startqueue-Abbruch; Quellzeit/Wanduhr0,731–0,759 |
| `both-targets`, drop/song/drumsampler/instru,30s Beobachtungsfenster | Beide Zielplugins und die Vergleichsquellen brechen früh ab; kein30s-Erfolg |
| `post-abort-clock`, CPU-Profile und Takt nach Streamende | AudioContext läuft nach gestopptem Publisher/SRC weiterhin nur mit ca70–79% der Wanduhr weiter |
| `release-load`, gezieltes Schließen dreier anderer Apps | Derselbe verbleibende AudioContext erholt sich von75,89% auf99,44%, ohne Code-/DJ-Rollenwechsel |

Vier gleichnamige Drop-Plugins dürfen nicht von vier Menschen im selben Raum
gehalten werden. Der gültige4×Drop-Kontrollversuch benutzt daher vier getrennte
Server/Sessions auf8251–8254, je eine echte App mit Drop-Halter. Ein Dateibarrier
startet die vier Player innerhalb65ms. Das ist ein Vergleich gleicher
Plugin-/Renderer-Codes unter gemeinsamer Hostlast; wegen der vier Server ist
es kein identischer Serverqueue-Versuch. Der frühere Vorversuch `drop4` hatte
bei drei Rollen „kein Audio-Adapter“ und zählt ausdrücklich NICHT als gültiger
4×Drop-Nachweis. Seine Rohdaten bleiben erhalten. Die ersten beiden JSON-Scope-Texte waren
noch aus R10 übernommen; tatsächlich öffnete auch dort der R11-Sammler keinen
PA-Empfänger. Die spätere Scope-Beschriftung ist korrigiert.

### Wo die Zeit verloren geht

Produktionsstellen, unverändert gegenüber2b93487:

- `src/audio/worklets/v2SinkProcessor.ts:711,714`: rendern und Schreiben der
  vorhandenen Quellpuffer in den Capture-Ring.
- `src/core/audio/backendMainSourceTap.ts:42,60`: Zählen geschriebener Frames
  und Source-Timestamp aus dem Ringcursor/Samplerate.
- `src/core/audio/backends/V2LiveSink.ts:133,137,140`: Main-Thread-Tap mit25ms-
  Polling und gebündelter Entnahme. Dessen beobachtete Lücken sind zusätzlich
  in den Rohdaten enthalten.
- `src/core/audio/backendMainPublisher.ts:45,74`: Startframe aus Server-ready
  plus1s; danach Fortschritt nach tatsächlich gelieferten Audioframes.
- `server/backendMainTransport.ts:47,59,82`: Backend mischt in100ms-Ticks.
- `server/backendMainMixer.ts:25`: `startFrame < this.frame` wird abgewiesen.
  Größere Eingangsqueues würden diese Bedingung nicht verändern.

Im Lauf `both-targets` nach Signalstart:

| Quelle | Wanduhr | AudioContext | geschriebene Quellzeit | Abgewiesenes Paket / Mixer |
|---|---:|---:|---:|---|
| drop |5491ms|4214,42ms|4214,42ms|496320 /499200 |
| song |4573ms|3401,72ms|3390,11ms|390720 /393600 |
| drumsampler |4000ms|2911,20ms|2911,20ms|344640 /345600 (10ms zu spät) |
| instru |4539ms|3381,41ms|3381,41ms|402240 /403200 (10ms zu spät) |

Die Quellframes folgen also weitgehend dem langsameren AudioContext. Es liegt
nicht nur ein Ring vor, dessen Entnahme spät erfolgt und anschließend alle
fehlenden Wanduhr-Samples nachliefert. Der1s-Vorlauf wird durch das anhaltende
Zuflussdefizit verbraucht. Die einzelnen Endabweichungen müssen deshalb nicht
exakt die130/40ms aus R10 wiederholen, um denselben Fehler zu reproduzieren.

Lokale Timestamp-Zuordnung: Beobachtung der Tap-Entnahme (`Date.now`,
`performance.now`, Quellcursor, Producer-/Consumer-Cursor und AudioContext),
Markierung des betreffenden Float32-Inputblocks per WeakMap, WebSocket-send-
Zeit und originale erfolgreiche `BackendMainMixer.enqueue`-Ausführung mit
Paket-/Mixerframe. `enqueue` wird passiv umschlossen, unverändert aufgerufen;
Fehler werden ebenfalls protokolliert und weitergeworfen. Samples jedes
zehnten Pakets werden korreliert. Der Inputblock ist der SRC-Aufruf, der das
Paket auslöst; bis zu10ms Paketrest können aus dem vorigen Block stammen.
Es wird kein absoluter Wanduhr-Schreibstempel innerhalb des Worklets behauptet.
Die Zahlen sind keine WAN-/PA- oder samplegenauen Hardwarelatenzen.

| Gepaarter Lauf / Quelle | Tap→enqueue Median / Maximum | Tap→send Median / Maximum | send→enqueue Median / Maximum |
|---|---|---|---|
| `paired-timings`, drop |25,5 /716ms|21 /715ms|1 /36ms |
| gleicher Lauf, song |51 /1141ms|28 /1102ms|2 /44ms |
| gleicher Lauf, drumsampler |18 /435ms|15,5 /432ms|1 /36ms |
| gleicher Lauf, instru |nicht messbar: Startqueue endet vor korrelierbaren Paketen|nicht messbar|nicht messbar |
| `instru-paired`, instru einzeln,120 Paketsamples |6 /49ms|6 /48ms|1 /4ms |

Für instru unter Vierfachlast liegt zusätzlich in `both-targets` eine
send→enqueue-Messung von1ms Median/6ms Maximum vor, aber keine gepaarte
Tap-Zuordnung dieses älteren Laufs. Diese Lücke bleibt ausdrücklich offen.

### Hypothesenprüfung und Ressourcenbeleg

- **Main-Thread:** Lange Tasks und Vor-send-Verzögerungen sind belegt.
  CPU-Profile zeigen u.a. SRC `process` und React `jsxDEV` als Hotspots.
  Der Takt fällt aber auch nach dem Stream-/SRC-Ende weiter zurück.
  Nur Capture/SRC in einen Worker zu verlegen ist damit noch kein bewiesener Fix.
- **Tab:** `document.hidden=false` in sämtlichen Capture-Zeilen. Kein Nachweis
  klassischen Hidden-Tab-Throttlings; andere Chromium-/OS-Priorisierung ist
  dadurch nicht ausgeschlossen. Keine Throttling-Flags als vermeintlicher Fix.
- **Server/Netz:** In den akzeptierten Paketsamples sind Median1–3ms zwischen
  send und enqueue üblich. Im Zielgruppenlauf bleibt clientseitiges
  `bufferedAmount` maximal317680 Bytes und damit unter1MiB. Kein Nachweis einer
  erschöpften128-Paket-/1MiB-Serverqueue. Die gemessene Strecke fasst Netzwerk,
  Serverqueue und Autorisierung zusammen; sie wird nicht künstlich getrennt.
- **Handshake:** Kaltstarts bis894ms sind beobachtet, im Zielgruppenlauf33–409ms.
  Das verbraucht Startreserve, erklärt aber nicht allein die danach anhaltend
  langsamere Quell-/AudioContext-Zeit. Kein voreiliges Vorziehen des Handshakes.
- **Hostlast:** `/sys/fs/cgroup/cpu.max` ist `200000 100000`, also2 CPUs.
  Im30s-Signalfenster werden60043216µs CPU-Zeit verbraucht; alle300 von300
  Quotenperioden werden gedrosselt, `throttled_usec` steigt um28387290µs.
  Die Quote ist für den aktuellen Prozess nicht schreibbar. Es wurde keine
  Host-/Cloud-Konfiguration verändert. Der Sampler lief ohne parallele Unit-Suite.

Der Lastwechsel hält Code, Hostquote, verbleibenden Kontext und DJ-Rolle
konstant: mit vier Apps4387ms Wanduhr/3329,16ms AudioContext, nach Schließen der
anderen drei und3s Beruhigung6985ms Wanduhr/6945,67ms AudioContext. Die reine
Stream-/SRC-Abschaltung hatte diesen Effekt zuvor nicht. Belegt ist damit ein
lastabhängiger lokaler Testaufbau-Blocker, der nicht auf drumsampler/instru
beschränkt ist. Vier Browser/komplette V2-Graphen teilen sich hier2 CPUs; das
ist kein Nachweis des Verhaltens vier separater Nutzerrechner. Die exakte
Thread-/Scheduler-Ursache innerhalb dieser Überlastung bleibt ungeklärt.

### Kein spekulativer Fix, Gates bleiben rot

Keine Laufzeitänderung, kein neuer Adapter, kein Puffer-/Schwellen-Aufweiten,
kein Main-Thread-/Worker-Umbau auf Verdacht. Größere Queues können einen
anhaltenden Frame-Zufluss unter Backendtempo nicht dauerhaft kompensieren.
Ein belastbarer nächster Nachweis benötigt CPU-Reserve im lokalen Testhost
oder eine gezielte Audio-Thread-/Scheduler-Isolation. Weder Ressourcenänderung
noch ein erfolgreicher neuer30s-Vier-Quellen-Lauf werden hier behauptet.
R11 bleibt daher blockiert; die engere Ursache und ein daraus abgeleiteter Fix
sind noch offen. Kein „gefixt“ und keine Freigabe aus den Einzeltests.

| Prüfung | Ergebnis |
|---|---|
| `npm run typecheck` | Exit0, finale Diagnoseinstrumentierung geprüft |
| `npm run lint` | Exit0, vollständiges ESLint |
| `npm run test` | Exit1,4042 bestanden/2 fehlgeschlagen in480 Dateien |

Die zwei Fehler bleiben `boundaryTokenizer.test.mjs` und
`userExportBoundary.test.mjs`, wegen der bestehenden WebRTC-Konstruktoren in
`src/utils/privateMonitorTransport.ts:17,55`. Tests und Allowlist bleiben gleich.
Die volle Suite lief einmal; spätere Änderungen betreffen ausschließlich die
separaten Diagnosefelder/Profilierung des Auditwerkzeugs, für die typecheck und
lint nochmals liefen. Produktionscode und sämtliche Tests blieben unverändert.
Der anfängliche Typecheck-Fehler im Auditwerkzeug wurde nur durch Typisierung
der Atomics-Ansicht behoben; sein Rohlog ist erhalten.

Reproduktion (jeweils frisches `R11_ARTIFACT_DIR`, Node22, gebaute Worklets):
`node --import tsx scripts/audit/backendMainTimelineDiagnosis.ts` für die
Standardgruppe; Zielgruppe mit `R11_PLUGINS=drop,song,drumsampler,instru` und
`R11_DURATION_MS=30000`; Einzelversuche mit `R11_PLUGINS=drumsampler` bzw.
`instru`; Profile mit `R11_PROFILE=1`, Lastwechsel mit `R11_RELEASE_OTHERS=1`.
Vier Drop-Kontrollen parallel mit `R11_PLUGINS=drop`, den vier
`R11_PORT=8251..8254` und gemeinsamem frischem `R11_BARRIER`-Verzeichnis.
Das Werkzeug verweigert das Überschreiben vorhandener Ergebnis-/Serverlogs.

**drumsampler: rot. instru: rot. Ursache: gemeinsamer lastabhängiger
AudioContext-/Server-Zeitachsenrückstand unter ausgeschöpfter2-CPU-Hostquote;
der genaue Scheduler-/Thread-Auslöser bleibt offen.**

Beleg-IDs: `R11-REPRO-CLOCKS`, `R11-PAIRED-TIMINGS`,
`R11-RESOURCE-RELEASE`, `R11-FOUR-SOURCE-RED`, `R11-TYPECHECK`, `R11-LINT`,
`R11-NPM-TEST`, `R11-INITIAL-TOOL-TYPECHECK`, `R11-SCOPE`, `R11-RAW-SEAL`.
`R11-FOUR-SOURCE-RED` ist der separate Exit1 der gespeicherten funktionalen
Akzeptanzprüfung, nicht der erfolgreiche Exit0 des reinen Datensammlers.
Alle Produktions-/Testdateien sind gegen2b93487 unverändert. Die Registry
behält den exakten3412er-Präfix; nun3422 Einträge, Schema geprüft.
Die Rohdaten inklusive CPU-Profile und Fehlläufe sind durch
`/workspace/work/r11-data/raw-manifest.json` versiegelt; Hash und Dateizahl
stehen in `R11-RAW-SEAL`. Keine neue Markdown-Datei angelegt.


## R11 – Nachtrag: dedizierter Hetzner-Testhost, zwei Vier-Quellen-Läufe

Betreiberauftrag: zusätzlichen passenden Hetzner-Server für den Test erstellen.
Die nachfolgende ausdrückliche Änderung lautet, ihn bis zum Gesamtziel über
weitere Runden zu behalten und erst danach zu löschen. Server176142753,
`am-r11-temp-1794693008`, CCX23/4 dedizierte vCPU/16GB, hel1,
2.29.205.185 ist eingerichtet und bleibt bestehen. Vier bestehende
Produktionsserver blieben unangetastet. Größere CCX-/CPX-Typen wurden wegen
Projekt-Corekontingenten abgelehnt; daraus entstand kein weiterer Server.
Der API-Tarif des Testservers beträgt0,139230EUR/h brutto, circa3,34EUR/Tag
zuzüglich IPv4; das sind Tarife, keine abgerechneten Istkosten.

Automatische Löschung ist deaktiviert. Der frühere lokale Watchdog wurde
beendet; Watchdog und Teardown verweigern bei gesetzter Retention die Löschung,
der Provisionierer verweigert eine zweite Allokation bei vorhandenem Zustand.
Inventar und Löschanweisung: `/workspace/work/r11-hetzner/retained-host.json`.
Zugangsdaten bleiben geschützt im Workspace und stehen nicht im Repository.
Direktes SSH ist aus dieser verwalteten Umgebung nicht erreichbar;
Einrichtung erfolgte über die authentifizierte Hetzner-HTTPS-Konsole.
Keine DNS-, TLS- oder Firewalländerung. Der kurzzeitige Artefakt-Downloadserver
wurde nach der SHA256-geprüften Übertragung beendet; nur SSH lauscht öffentlich.

Reproduzierbarer Bootstrap: `scripts/audit/bootstrap-test-host.sh`,
Commit7b7dc3fe11adb6fedeb7d38b0dc21d214a98d5d3,
SHA256 a2962ee355405736fca4247ddce48e94606f27c8a7554ede3850e9702afa01a9.
Quellstand cddd5cd0e54919c41ac8b6c21abfc196bbc54953,
Node22.16.0, Chromium151.0.7922.34. Tatsächliche Laufzeitquelle unverändert
gegen2b93487. Vier echte Apps auf127.0.0.1 mit den vorhandenen V2-Playern und
festem WAV-Input; keine injizierten Main-Pakete. PulseAudio `auto_null` stellt
ein Software-Audiogerät bereit, native44100Hz; bestehender SRC nach96000Hz.
Kein Hardware-, WAN-, PA- oder Monitorlatenzbeweis. Kein Mastering.

Der Bootstrap adaptiert ausschließlich die Diagnose an den nativen Host:
fehlende cgroup-root-Dateien ehrlich als nicht exponiert ausgeben, Server an
Loopback binden und Chromium-UDP-Policy angleichen. Kein Gate oder DSP geändert.
Zwei unabhängige40s-Messfenster liefen nacheinander. Tatsächliche beobachtete
Sendespanne zwischen den jeweils ersten/letzten protokollierten Paketen:

| Plugin | Lauf1 Sendespanne | Lauf2 Sendespanne | Source-Clock/Wanduhr1/2 | Abbrüche/Ablehnungen |
|---|---:|---:|---|---|
| drop |39,575s|39,627s|1,00043 /1,00036|0 /0|
| song |39,566s|39,512s|1,00044 /1,00043|0 /0|
| drumsampler |39,816s|39,847s|1,00056 /1,00037|0 /0|
| instru |39,528s|39,574s|1,00021 /1,00070|0 /0|

Alle acht Quellläufe haben nichtleere Audiodaten, mindestens30s Sendespanne,
keine Browserfehler, keine Stream-Schließung während der Messung und keine
`R11-REJECT`-Meldung. Bootstrap regulär beendet; separate funktionale Auswertung
Exit0,8/8. Der Datensammlerstatus `diagnostic` allein wird nicht als Gate gewertet.

Je Quelle sind401–402 gepaarte Timingproben vorhanden. `send` bis
`BackendMainMixer.enqueue` beträgt Median1ms/p954ms, Maximalwert36ms;
Source-Ring-**Read** bis enqueue Median13–16ms/p9529–31ms, maximal430ms
inklusive Anlauf. Das sind Software-Zeitmarken, keine Ausgabegerätlatenzen;
der Worklet-Write-Zeitpunkt wird weiterhin über Framezähler angenähert.
Der minimale zeitliche Vorsprung bei enqueue liegt je Quelle bei700–900ms;
kein Paket wird hinter der Mixerzeit eingereicht. `enqueue` dauert höchstens2ms.
Messstellen: `backendMainSourceTap.ts:42,45,60`,
`backendMainPublisher.ts:45,74`, `backendMainMixer.ts:25`,
`backendMainTransport.ts:136`; Instrumentierung in
`backendMainTimelineDiagnosis.ts:13,96,101,108`.

**Bewertung:** Die30s-Vier-Quellen-Anforderung ist auf diesem Testhost zweimal
grün, ohne Laufzeitfix. Zusammen mit dem früheren Lastwechsel belegt das einen
abhängigen Testumgebungs-/Lastbefund statt eines nachgewiesenen speziellen
Adapterfehlers. Die genaue Scheduler-/Audio-Thread-Ursache auf dem alten
2-CPU-Quotenhost bleibt unbekannt; der VM-Vergleich isoliert CPU, Audiogerät
und Host-Scheduler nicht einzeln. Kein allgemeiner Produktionsfix und keine
Freigabe beliebiger Hintergrund-Tabs daraus ableiten. Die historischen roten
Läufe bleiben unverändert erhalten.

Die Rohdaten sind vollständig im Workspace angekommen:
`/workspace/work/r11-hetzner/results.tar.gz`, SHA256
`a44de74365416da0d9eeaa9944379d6d68776df535047738f2f802408f6d474e`.
Entpackt unter `r11-results/`, zusätzliche Auswertung `analysis.json`.
Neues Manifest versiegelt16 Dateien, SHA256
`89ce7a834b94900c07c3952945aebdf08fa7cacfc529193c72f7252ee4024516`.
Das frühere82-Dateien-Manifest bleibt bytegleich.

Typecheck und Lint bleiben die bereits protokollierten Exit0-Prüfungen des
unveränderten Diagnose-/TypeScriptstands; dieser Nachtrag ergänzt ausschließlich
Shell-Bootstrap, Dokumentation und Belege. `bash -n` für den Bootstrap: Exit0.
Volle Suite zuletzt Exit1,4042 bestanden/2 bestehende Boundary-Fehler;
keine Wiederholung oder Änderung der verbotenen Boundary-Tests,
48 State-Matrix-Tests, RT-/Audio-Gates oder Schutzchecks. Kein main-Merge.

Belege: `R11-HETZNER-RETAINED`, `R11-HETZNER-BOOTSTRAP`,
`R11-HETZNER-FOUR-SOURCE-GREEN`, `R11-HETZNER-TIMINGS`,
`R11-HETZNER-RAW-SEAL`.

**drumsampler: grün auf dem dedizierten Testhost. instru: grün auf dem
 dedizierten Testhost. Ursache: früherer gemeinsamer lastabhängiger
 Testumgebungsbefund; genauer Scheduler-/Thread-Auslöser weiterhin unbekannt.**


## R12 Phase2 – Backend-Prozessoren implementiert, Acht-Quellen-Gate rot

**Reviewbranch `fix/backend-main-processors-r12`; geprüfter Runtime-/Teststand
ca7b5be7f4b9e829be05498dc80551c677ade413. Kein main-Merge.**
Runtimebasis2b93487; die mitgeführte R11-Historie enthält ausschließlich Audit-
Werkzeuge, Bericht und Belege. Die ausdrückliche Betreiberfreigabe erlaubt die
begrenzte Erweiterung von Mixer/Transport, Master ausschließlich als Gain,
Spatial ausschließlich als Stereo-Return. Keine R10-Quellen-, R5-, Monitor-/Cue-,
Boundary-, RT-/Audio-Gate-, Flotten- oder Legacy-Domain-Änderung.

### Umsetzung und tatsächlicher Funktionsumfang

`server/backendMainProcessors.ts` verarbeitet die aus der bestehenden Queue
samplegenau ausgerichteten Stereo-Quellblöcke. Je Quelle EQ→DSP, danach
Kanalpegel/Balance/Mute und Post-Fader-Sends; trockene Summe + zwei interne
Differenz-Returns → einmal Master-Gain → abschließende PCM24-Rundung/Begrenzung.
Keine zusätzlichen Browser-Contributor-Streams für Prozessoren, keine zweite
Einspeisung der unbearbeiteten Quelle. Der Prozessor rechnet auf der bestehenden
Serverzeitachse; keine Queue-/Vorlauf-/Tick-Schwelle wurde verändert.

| Prozessor | Umsetzung / Wiederverwendung | Linearität bei festen Parametern | Funktionsbeleg | Vollständiger Acht-Quellen-Nachweis |
|---|---|---|---|---|
| eq | Bestehender ParametricEqNode; Low/Mid/High je ausgewählter Quelle, separate Filterzustände | linear | Unit + echte Signaländerung auf Hetzner grün | offen, gemeinsamer Lauf rot |
| dsp | Bestehender DspFilterNode; Cutoff/Resonanz/Envelope-Tiefe/Drive | nichtlinear bei Envelope-Modulation oder Drive | Unit + echte Signaländerung grün | offen |
| effect | Bestehender EffectNode auf dem gemeinsamen Send-Bus; Return=F(Send)−Send | nichtlinear durch Quantisierung; zusätzlich Modulation/Feedback/Verzögerungen | Unit + echte Signaländerung grün | offen |
| spatial | Stereo-Mid/Side-Breite und Balance; Return=F(Send)−Send | linear | Unit + echte Signaländerung grün | offen |
| mixer | Quellpegel, lineare Stereo-Balance mit Einheitspegel in der Mitte, Mute, zwei Sends; kein Stream | linear | Unit + echte Signaländerung grün | offen |
| master | Einmaliger Gain0…2 hinter Summe/Returns | linear; abschließendes PCM24-Clipping separat | Unit + echte Signaländerung grün | offen |

Die vorhandenen DSP-Knoten bleiben unverändert. Es wurde kein R13-Mastering,
Limiter oder Mehrkanalausgang ergänzt. DSP-Oversampling1 ist der Default;
bestehende2/4-Verarbeitung kann per Parameter genutzt werden. Ein vollständiger
PDC-Nachweis für unterschiedlich konfigurierte serielle Quellpfade ist damit
nicht erbracht. Die belegten parallelen Returns verwenden dieselben bereits
verarbeiteten Send-Blöcke wie ihr trockener Bezug.

### P1, P2 und P3

**P1:** Beide Returns subtrahieren exakt ihren zugehörigen ausgerichteten Send-
Block. Effect wird einmal auf der Send-Summe gerechnet; die Nichtlinearität wird
nicht durch Summieren einzeln bearbeiteter Quellen umgedeutet. Ein unabhängiger
EffectNode-Referenzaufruf prüft trocken+Return gegen die direkte Bearbeitung mit
nichtneutraler Quantisierung; Differenz innerhalb der geprüften1e−7-Toleranz.
Keine darüber hinausgehenden Subtraktionsartefakte wurden in diesem Signal
gefunden. Quantisierung, Modulation und Nachhall des Effekts selbst bleiben
beabsichtigte Signaländerungen; kein allgemeiner Hör-/Aliasfreiheitsnachweis.
Neutraler Effect-/Spatial-Return verdoppelt den trockenen Pegel nicht.

**P2:** Eigene Impulsprüfung für Effect und Spatial: Position des betragsgrößten
Return-Peaks minus trockene Peakposition jeweils0 Samples, Assertion strikt<1.
Kein zusätzlicher Ausgleich für diese geprüften Einstellungen nötig.
Beabsichtigte spätere Effektanteile werden nicht als Transportversatz entfernt.

**P3:** `backendMainMixer.ts` begrenzt erst nach `processors.process()` auf
PCM24. Die DSP-Blöcke bleiben Float32; der trockene Summenakkumulator ist
Float64, damit sich große Zwischenwerte ohne Verlust eines neutralen PCM24-
Bits aufheben können. Die Regression mit −8388608,−8388608,+1,+8388607,+8388607
liefert korrekt−1 statt−2. Das ist keine vorgezogene Begrenzung.
Zwei Quellen mit je6000000 ergeben bei Master0,5 unverzerrt6000000. Erhöhung
auf2 im selben laufenden Mixer führt erst am Ausgang zu8388607 und expliziten
Clippingzählern; kein vorheriges Abschneiden der Summe.

### Steuerung und Autorität

Neue, gesonderte Main-Regler in den sechs Rack-Modulen schreiben ausschließlich
`pluginSettings.<id>.settings.backendMain` über den vorhandenen autorisierten
Settings-Pfad. Keine neue ungeschützte Parameterroute. Bestehende lokale
Monitor-/Legacy-Regler werden nicht umgedeutet; insbesondere ist dies kein
Nachweis, dass sämtliche bisherigen12-Band-/Dynamics-/HRTF-/Preset-Regler der
Legacy-Panels bereits den Backend-Main steuern. Die neuen Main-Regler bieten
nur die oben beschriebenen R12-Funktionen.

`backendMainProcessorControl.ts` liest vor jedem Mixblock den kanonischen
Modus, Halter und gegebenenfalls gültigen R5-Grant. Alte Actor-Schreibversuche
werden vom unveränderten Serverpfad abgewiesen; Parameter bleiben beim
Halterwechsel erhalten. Preset-/Legacy-Saves ohne Main-Abschnitt löschen diesen
unabhängigen Abschnitt nicht. Der Mixer behält seine Immer-an-Sonderstellung.
Master behält die bestehende Mixer-Halterberechtigung; sie wurde nicht geändert.

Unit-Prüfungen decken Autoritätsverlust/Halterwechsel aller sechs Steuerungen
und Widerruf der fünf delegierbaren Prozessoren während laufender Quellblöcke
ab. Im Browserlauf wurden EQ OFF→neuer Halter ON sowie Erteilung/Widerruf einer
realen R5-Generation durchgeführt. Kein neuer KI-Modelllauf-/Tool-Mapping-
Nachweis aus diesen Autoritätstests ableiten.

Gain/Pan/Master und Insert-/Return-Aktivierung wechseln über5ms-Rampen.
Andere Prozessorparameter ändern sich derzeit unmittelbar. Bei Aktivierungs-
oder Epochwechsel werden Filter-/Effektzustände zurückgesetzt; alte Tails
werden nicht nahtlos weitergeführt. Keine pauschale klickfreie Automation
behauptet.

### Hetzner: zwei echte Vier-App-/Acht-Quellen-Versuche

Derselbe behaltene CCX23/176142753 in hel1, keine neue Provisionierung. Vier
App-Kontexte halten je zwei Quellen, zusätzlicher Software-PA-Kontext liest
`/master-out`. Feste WAV-Eingänge werden in die vorhandenen V2-Player geladen;
keine injizierten Ausgangspakete. Native Browser44100Hz, Backend96000Hz;
PulseAudio-Softwaregerät unverändert. Loopback, keine WAN-/physische PA-Messung.

Beide Versuche belegen alle sechs Signalverarbeitungen und den echten EQ-
Halterwechsel/Delegationswiderruf. **Beide Gesamtprüfungen enden Exit1.**
Der erste kurze lokale Diagnoseversuch wurde gesichert und zählt ausdrücklich
nicht als vorgeschriebener Hetzner-Nachweis.

Der zweite Hetzner-Versuch lief60118ms. Nichtleere angenommene Beiträge:
song51,124s, instru49,052s, syntisampler33,453s, stem0,804s, sound0,560s.
Für drop/drumsampler/voice ist damit kein angenommener nichtleerer Dauerbeitrag
belegt. Die geforderten acht dauerhaft sendenden Quellen fehlen; das sind
keine acht grünen Quellen. Die Software-PA empfing zeitweise echtes Audio,
stoppte aber mit `Main playback underrun; output stopped`.

Vier Capture-Overflow-Meldungen sind für drop/sound/stem/drumsampler gespeichert.
Dazu vier protokollierte Paketablehnungen: drumsampler schon bei Sequence0
200ms hinter dem Mixer; syntisampler/instru/song später bei genau2s Vorsprung,
wodurch das Paketende außerhalb des unveränderten2s-Fensters liegt.
Es wäre falsch, alle Fehler als verspätete Pakete zu beschreiben.

Die ergänzten passiven Messungen zeigen:

| App | AudioContext/Wanduhr | Größte500ms-Messlücke | kumulierte SRC-Zeit |
|---|---:|---:|---:|
| DJ / drop+song |1,00021|1579ms|25,48s|
| drumsampler+syntisampler |1,00024|1337ms|20,05s|
| instru+voice |1,00031|1137ms|24,39s|
| sound+stem |1,00047|969ms|1,18s bis früher Abbruch|

Alle Kontexte meldeten `document.hidden=false`. Der größte noch protokollierte
Capture-Rückstand erreichte669,8ms;32768 Frames bei44100Hz entsprechen743,0ms
Kapazität. Der Source-Ring meldet Overflow in `backendMainSourceTap.ts:32`,
die Main-Thread-Abholung erfolgt in `backends/V2LiveSink.ts:137`.

Backend-Prozessorzeit,114 Stichproben: Median29,73ms, p9569,95ms,
Maximum104,99ms pro100ms-Audioblock. Die neue Last und der Browser-Capture-/SRC-
Pfad müssen deshalb gemeinsam betrachtet werden. AudioContext-Uhren laufen
anders als im früheren2-CPU-Fall nahezu korrekt; Hauptthread-Abholung und
Serverzeitachse halten im Acht-Quellen-Szenario trotzdem nicht durch.
**Genaue kausale Aufteilung zwischen UI, SRC, Serververarbeitung und Scheduler
bleibt ungeklärt.** Kein spekulatives Vergrößern von Queues, kein Zeitachsen-
Reset, kein R10-Adapter-Fix, keine Behauptung, dass zusätzliche CPU allein genügt.
R11s grüner Vier-Quellen-Nachweis wird dadurch nicht umetikettiert.

### Prüfungen und zusätzliche rote Befunde

| Prüfung am Runtime-Stand ca7b5be | Exit / Ergebnis |
|---|---|
| Typecheck auf Hetzner |0|
| Lint auf Hetzner |0|
| Gezielte fünf Testdateien |0;86 Tests grün, darunter26 neue Prozessor-/Autoritätstests|
| R10-Matrix |48 State-Matrix-Fälle unverändert; Datei insgesamt51 Tests grün|
| Vollständige Suite auf Hetzner |1;4066 bestanden/4 fehlgeschlagen,5 fehlgeschlagene Dateien einschließlich Cleanup-Hook|
| Echter Vier-App-/Acht-Quellen-Test |1; sechs Prozessor-Signalassertions grün, Dauerbeiträge/keine Ablehnung rot|

Die volle Suite enthält die zwei unveränderten Boundary-Fehler sowie zwei
EACCES-bedingte Startfehler in agentRoutes/rateLimitScopes und einen
`masterRoutes.test.ts:157`-afterAll-Timeout. Erster Exportversuch zusätzlich
ohne.git und unter Root: ebenfalls rot, Rohdaten erhalten. Danach echter
Git-Checkout und unprivilegierter Nutzer; keine Tests abgeschwächt.

Die beiden EACCES-Fälle entstanden durch vom ersten Root-Lauf hinterlassene
`/tmp/audiomonastry-agent-runs`-Dateirechte. Ein frisches privates TMPDIR wurde
in einem getrennten Folgelauf geprüft:17 Einzeltests der drei betroffenen
Dateien grün, agentRoutes/rateLimitScopes grün, aber masterRoutes-afterAll
weiterhin30s-Timeout und Exit1. Die vollständige Suite wurde danach nicht als
„nur zwei rot“ umetikettiert. Ursache des Cleanup-Hängers bleibt offen;
Mastering-/Boundary-Code und Tests bleiben unverändert. Der Host-Runner nutzt
für künftige volle Läufe ebenfalls ein privates temporäres Verzeichnis.
Keine Wiederholung von RT-/Audio-Gates.

### Rohdaten, Scope und Abschluss

Alle Ergebnisse unter `/workspace/work/r12-data`, darunter unveränderte lokale
Vorprobe, zwei Hetzner-Archive, vollständige Logs, Diagnosefelder und separate
Umgebungsnachprüfung. Archivhashes gegen authentifizierte Hetzner-Konsole geprüft:

- erster Hetzner-Lauf: eca72b63e708ac6bbc43f0cd56557d8c53edadcccbd334ed260002b3e24b2fdb
- zweiter Hetzner-Lauf:1323171ec6964ae914d9c335d90953deff2377b6757a41470b7eb8a644f7dc7c
- Folgelog:813c98b1590851839f15e982a698298ea14f37bc204deec51a8893ccc57e94d7

`raw-manifest.json` versiegelt51 Dateien, SHA256
befc55fc523e05301c52ea407adc5de79322c8bff550708e629bb20c3e4a5dfb.
Frühere R11-Belege bleiben unverändert. Downloadserver beendet, keine App-
Testprozesse weiter aktiv; der Testhost selbst bleibt wie beauftragt erhalten.
Kein DNS/TLS/Firewall-Eingriff, kein neuer Server, kein Merge.

Belege `R12-SCOPE`, `R12-PROCESSORS`, `R12-RETURNS`, `R12-HEADROOM`,
`R12-AUTHORITY`, `R12-HETZNER-APP-RED`, `R12-TIMING-DIAGNOSIS`,
`R12-TYPECHECK-LINT`, `R12-NPM-TEST-RED`, `R12-ENV-FOLLOWUP`, `R12-RAW-SEAL`.

**Sechs Prozessoren implementiert und einzeln funktional belegt. Gemeinsame
Integration mit acht dauerhaft aktiven Quellen offen. R12 nicht abgeschlossen;
keine „6/6 fertig“- oder Freigabebehauptung.**


## R13 – Prozessor-/SRC-Last reduziert; Acht-Quellen-Integration weiterhin rot

Stand2026-11-15 (Europe/Berlin), Reviewbranch `fix/processor-performance-r13`.
Runtime-Basis `ca7b5be`; Diagnose `ba672bd`; gemessene Optimierung `5ca5237`;
Codec-Kontrolle `ac0509a` (Standard bleibt auto). Kein main-Merge, kein RT-Gate,
kein Mastering. Der vorhandene Hetzner-Testhost176142753 (CCX23, hel1,
4 vCPU/16GB, Node22.16.0, native PulseAudio44100Hz) wurde weiterverwendet.
Kein neuer Server. Genau zwei Terra-Agenten, geringe Reasoning-Stufe,
für getrennte Profil-/App-Arbeiten; keine zusätzlichen Modelle angefordert.

**Ergebnis:** Die isolierte Backend-Kette und der Browser-SRC werden deutlich
billiger. Der ursprüngliche R11-Vier-Quellen-Test bleibt für sein Messfenster
grün. Das erweiterte Szenario mit sechs Prozessoren und PA scheitert weiterhin
mit4/6/8 Quellen. Weder eine Gesamtfreigabe noch ein gerettetes Acht-Quellen-
Gate wird behauptet. Belege `R13-PROFILE`, `R13-SCALING`, `R13-APP-RED`.

### Methode und Grenzen der Messung

Vor jeder Runtime-Optimierung wurde der unveränderte R12-Code auf dem Testhost
profiliert. Isolierte Prozessorläufe: feste synthetische Stereo-Signale,
96kHz,9600Frames=100ms je Block;24 Fälle (Basis, sechs Einzelaktivierungen,
Gesamtkette ×4/6/8 Quellen),20 Warmblöcke,50 Messblöcke.
`process.cpuUsage()` liefert CPU user+system, `hrtime` Wall-Zeit. Die CPU-Werte
können GC-/Runtime-Arbeit des Prozesses enthalten. Profiling, Heap-Sampling und
Konstruktorzähler laufen getrennt von den Zeitmessungen. Alle Rohstichproben
stehen in `processor/result.json`;48 Vorher-/Nachher-Zeilen zusätzlich in
`/workspace/work/r13-data/processor-profile.csv`.

Ein Einzelprozessor-Fall umfasst den gemeinsamen Dry-/Mess-/Bus-Code.
Effect/Spatial benötigen zusätzlich aktiven Mixer mit Sends; deren ganze
Fallzeit ist deshalb nicht die reine Kernelzeit. Kein Addieren aller
Einzelfallzeiten zur Gesamtkette. Synthetische Werte sind weder echte App-
Messung noch Live-/Latenz-/WAN-/PA-Beweis. R12s29,73ms-Median aus einem
belasteten App-Lauf ist nicht direkt mit diesem warmen Mikrobenchmark gleichzusetzen.

### Prozessor-Profil: acht Quellen, CPU ms je100ms-Audioblock

| Fall | vorher CPU p50/p95/max | nachher CPU p50/p95/max | vorher Wall p50 | nachher Wall p50 |
|---|---:|---:|---:|---:|
|baseline|9.988/18.788/44.501|2.940/2.995/3.004|9.883|2.935|
|eq|12.758/13.815/26.583|5.662/5.888/6.732|12.494|5.656|
|dsp|15.001/15.334/31.906|7.912/8.119/9.066|14.655|7.906|
|effect|11.024/11.362/11.434|3.829/4.155/4.482|10.821|3.824|
|spatial|10.041/10.368/12.094|3.122/3.266/3.859|9.855|3.117|
|mixer|9.916/10.256/27.279|3.102/3.397/3.942|9.779|3.098|
|master|9.887/10.229/27.366|3.056/3.761/4.115|9.737|3.052|
|full|18.559/19.432/35.541|11.657/13.727/29.444|18.215|11.547|

Getrennte instrumentierte Kernel-Stichprobe der vollen Acht-Quellen-Kette:
vorher EQ2,412ms, DSP5,172ms, Effect0,596ms, übriger gemessener Code11,831ms;
nachher EQ2,452ms, DSP5,394ms, Effect0,624ms, übriger Code3,807ms.
Dies ist jeweils eine Attribution mit Wrapper-Overhead, keine Quantilverteilung.
**Effect ist nicht der größte Kostentreiber.** DSP ist der teuerste der drei
bestehenden AudioNode-Kernels; großer Teil der alten Last steckt im gemeinsamen
Kopier-/Energie-/Ramp-/Allokationscode. Relevante Stellen:
`server/backendMainProcessors.ts:13` (Energie),`:42` (Rampen),`:87`
(Block-Scratch),`:195` (Node-Kontext),
`src/core/audio/nodes/processingNodes.ts:234` (EQ),`:338` (DSP),`:485` (Effect).

### Speicher pro Block – drei verschiedene Messgrößen

| Acht-Quellen-Fall | neue Typed-Array-Backing-Bytes vorher→nachher | V8-Sampling-Schätzung JS-Heap-Bytes/Block vorher→nachher | netto heapUsed p50 vorher→nachher |
|---|---:|---:|---:|
|eq|2342400→76800|47744140.8→5613.2|-1824576→9056|
|dsp|2342400→76800|47796951.6→126661.2|-1702368→130944|
|effect|2342400→76800|48647376.4→6667.2|-752176→8064|
|spatial|2342400→76800|47666366.4→5801.2|-1830944→6328|
|mixer|2342400→76800|47673104.0→4355.6|-1827096→6216|
|master|2342400→76800|47566413.2→7464.0|-1826448→6536|
|full|2342400→76800|48871472.4→150723.2|-601672→139728|

Konstruktorzähler: vorher56Float32Array+2Float64Array=2342400Bytes,
nachher nur der unabhängige öffentliche Float32-Ausgang=76800Bytes. Das zählt
keine gewöhnlichen JS-Objekte und keine anderen Konstruktoren; Views auf
vorhandenen Speicher werden nicht als neuer Backing-Store gezählt.
V8-Heap-Sampling mit4096Byte-Samplingintervall über20 separate warme Blöcke
schätzt auch kurzlebige JS-Allokationen, schließt externe Typed-Array-Speicher
jedoch aus. Diese statistische Schätzung ist kein exakter Gesamtallokationszähler.
`heapUsed`-Deltas enthalten GC und sind ausdrücklich Nettowerte; negative
Deltas sind kein negativer Allokationsbedarf. Rohprofile bleiben erhalten.
Belege `R13-MEMORY`, `R13-FIX-PARITY`.

### Skalierung4/6/8 Quellen

Volle Backend-Kette, Wall ms je100ms Audio:

| Quellen | vorher p50/p95/max | nachher p50/p95/max |
|---|---:|---:|
|4|10.558/10.966/14.939|6.094/6.447/6.555|
|6|14.100/16.069/21.911|8.173/8.897/9.258|
|8|18.215/19.057/22.084|11.547/13.354/14.055|

Sampleratenwandlung44100→96000Hz, separate serielle Mikrobenchmark-Aggregation
für4/6/8 Wandler (in der App über vier Renderer verteilt):

| Wandler | vorher p50/p95/max ms | nachher p50/p95/max ms |
|---|---:|---:|
|4|61.854/74.922/80.150|10.522/11.947/28.865|
|6|89.902/91.484/91.607|15.964/16.677/24.792|
|8|117.879/118.556/118.993|21.044/22.033/27.727|

SRC ist signifikant: sauber gemessener Acht-Wandler-Median117,879→21,044ms.
Vorher4914960sin- und ebenso vielecos-Aufrufe je100ms, nach Warmup0.
Frühe SRC-Messung aus `ba672bd` instrumentierte Math zwischen Zeitfällen und
beeinflusste damit JIT-Annahmen. Ihr alter209ms-Wert wird nicht für den
Vorher-/Nachher-Vergleich verwendet. Der obige Vergleich nutzt in beiden
Richtungen dieselbe korrigierte Methode: sämtliche Timings vor globalen
Math-Wrappers; alter Wandler aus unverändertem Checkout separat importiert.
96000→96000 wird wie im echten Publisher übersprungen, nicht als SRC-Leistung
ausgegeben. Alle vier Raten und Rohwerte liegen im SRC-JSON. Kurve als
`/workspace/work/r13-data/scaling.svg` und `.png`. Beleg `R13-SRC`.

### Messungsbasierte Optimierungen und Korrektheitsnachweis

`5ca5237` ersetzt wiederholte interne Backend-Buffer/Kontexte durch
blockgrößenabhängige Scratch-Puffer und ersetzt die heißen Typed-Array-
Iteratoren bei der Energieermittlung durch indexbasierte Schleifen. Der
öffentliche Ausgang und vergangene Reports bleiben unabhängig; Inputs werden
nicht verändert. Node-Kontexte liegen in einer WeakMap, sodass ersetzte
Prozessoren nicht durch den Scratch-Cache festgehalten werden.

Der bestehende64-Tap-Sinc-SRC behält Cutoff0,94,32Frames Lookahead und
Streaming-Längenbedingung. Er cached wiederkehrende rationale Phasen
(44100→96000:320Phasen) bis maximal1024Phasen und schreibt direkt in passend
große Float32-Ausgänge. Große Phasenperioden nutzen die ursprüngliche skalare
Berechnung mit wiederverwendetem64-Koeffizienten-Puffer. Kein Rate-Downgrade,
keine Änderung des Filters und keine zusätzliche Pufferlatenz.
`src/core/audio/backendMainResampler.ts:15`,`:30`,`:38`.

72Vergleichsblöcke gegen den eingefrorenen R12-Prozessor: exakt gleiche
Float32-Ausgänge und Stage-Reports,48/96/192kHz,0/4/6/8Quellen, verschiedene
Blocklängen, Settings/Modi/Epoch-Wechsel. SRC: unabhängige alte Referenz,
16Ratenpaare, Zufall/Sweep,200000Frames Langlauf und Fallbackrate44101Hz;
maximal beobachtete absolute Abweichung5,960464477539063e-8 (Float32-
Rundungsgröße; keine bitgleiche SRC-Behauptung). Bestehende DC-/Nyquist-/
Blockgrenzen-Tests unverändert. Beleg `R13-FIX-PARITY`.

### Echte Apps: Integration bleibt rot

Vier echte Browser-App-Kontexte, feste WAV-Eingänge über vorhandenen V2-
Player, tatsächliche R10-Source-Taps und Backend-Transport; separate
`/master-out`-App. Keine injizierten Audio-Ausgangspakete, keine KI-API,
kein WAN und keine physische PA. Alle Apps und Server auf demselben CCX23;
das ist keine Aussage über getrennte Nutzermaschinen.

4Quellen: drop/song/drumsampler/instru.
6Quellen: zusätzlich syntisampler/voice.
8Quellen: zusätzlich sound/stem.

Der erweiterte Test startet PA und Quellen, danach die sechs Prozessor-Panels
und schreibt deren Parameter. Er enthält deshalb UI-/Dev-Server-Aufwärmarbeit
während Audio läuft. Diese Bedingungen wurden nicht still geändert. Cold-
Module/Tab-/Server-Scheduling bleiben mögliche Ursachen, keine bewiesene
Einzelursache. Keine Parameter-/Grenz-/Assertion-Abschwächung zum Grünmachen.

| Lauf | Messfenster | Exit | Ergebnis |
|---|---:|---:|---|
| R12-Runtime,4/6/8 jeweils |40s|je1|rot; sechs Signalverarbeitungsassertions jeweils grün, Kontinuität rot|
| optimiert,4Quellen |60s|1|sechs Signalassertions grün; Quellen nur2,32–21,29s, PA-Unterversorgung|
| optimiert,6Quellen |60s|1|sechs Signalassertions grün; Quellen nur0,10–25,18s, PA-Unterversorgung|
| optimiert,8Quellen |60s|1|acht Quellen akzeptiert, nur1,90–3,84s; auch sechs Stage-Signalassertions rot|

Zusätzliche Rohstichproben im optimierten App-Lauf: Backend-Prozessor-
Median/Maximum4Quellen14,613/105,327ms,6Quellen24,747/81,667ms,
8Quellen5,215/180,181ms. Der niedrige Acht-Quellen-Median enthält nach frühen
Abbrüchen leere/fehlende Beiträge und ist **kein** Beweis einer schnellen
vollen Acht-Quellen-Kette. Browser-AudioContext-Uhren liegen nahe1,0002–1,0005
pro Wanduhrsekunde; Main-Thread-Beobachtungslücken erreichen bis1352ms.
Die Verteilung der Scheduler-/Render-/Dev-Server-Last bleibt nicht vollständig
kausal aufgelöst. Beleg `R13-APP-RED`.

### Codec-Kontrolle und verbleibender Zeitachsenblocker

`ac0509a` reicht die bestehende verlustfreie Codec-Option über validiertes
`BACKEND_MAIN_ENCODING=auto|flac|pcm24` durch. Default bleibt auto. Passive
Chunk-/ffmpeg-Metadaten ergänzen den Test. Kein produktiver Codecwechsel als
vermeintlicher Fix.

| Kontrolllauf,je60s angefordert | ffmpeg | PA-Chunk-Maximallücke | Audio-Zeit / Wanduhr zwischen erstem/letztem Chunk | Ergebnis |
|---|---:|---:|---:|---|
| auto,4Quellen |einmal120ms; dann PCM-Fallback|204ms|3,200s /3,734s|Exit1, PA stoppt|
| PCM24,4Quellen |keiner|262ms|3,600s /4,134s|Exit1, PA stoppt|
| PCM24,8Quellen |keiner|402ms|1,700s /2,288s|Exit1, PA stoppt|

PCM24-Kontrollläufe melden0 encoder-delayed-Ticks und scheitern trotzdem.
FLAC alleine erklärt den Fehler damit nicht. Im Acht-Quellen-PCM-Lauf fehlen
innerhalb2,288s bereits588ms ausgegebene Audiolaufzeit. Der Client startet mit
500ms Vorlauf (`src/core/transport/backendMainClient.ts:64`) und wirft dann
korrekt den dokumentierten Underrun (`:65`). In diesem Lauf sieben nichtleere
Quellen belegt, drop ohne belegten nichtleeren Dauerbeitrag; alle sechs Stage-
Signalassertions grün, aber Gate weiterhin rot.

Spätere Quellenabweisungen liegen exakt192000Frames=2s vor dem Mixer, nicht
hinter ihm. `BackendMainMixer.enqueue` prüft bei`:28` das unveränderte2s-
Vorausfenster. Die Backend-Zeitachse wird nur durch einen100ms-Timer je um
einen Block weiterbewegt (`server/backendMainTransport.ts:50–65`,
`server/backendMainMixer.ts:75`). Bei Encoding/Prüfung wird ein Tick
übersprungen und die Zeitachse angehalten. Allgemein langsame Timeraufrufe
holen verstrichene Zeit ebenfalls nicht nach. Render/DSP läuft synchron auf
demselben Node-Thread (`backendMainTransport.ts:63`,
`backendMainMixer.ts:65`); kein Worker. Das erklärt den sichtbaren
Zeitachsenmechanismus, beweist aber noch nicht, welcher Anteil der realen
Timer-Verzögerung aus UI-Kompilation, Serverlast oder anderem Scheduling stammt.

**Ehrlicher Blocker:** Gemeinsamer Backend-Takt/PA-Kontinuität bleibt rot;
feine kausale Aufteilung der verlorenen Taktzeit ungeklärt. Keine Queue-/
Ring-/Vorausfenster-Vergrößerung, keine Uhr-Resets, kein schnelleres Abspielen
oder Wegwerfen von Audio als unbelegter Fix. Beleg `R13-CODEC-CONTROL`.

### Ursprüngliche R11-Referenz getrennt nachgeprüft

Der unveränderte native R11-Diagnoseläufer wurde in den optimierten Checkout
kopiert; vier Quellen,40s, keine PA-Receiver und keine sechs aktivierten
Prozessoren. Runnerstatus bleibt ehrlich `diagnostic`; ein separater,
offengelegter Auswerter prüft mindestens30s angenommene Beiträge pro Quelle,
nichtleere Samples, keine Capture-Closes/Fehler, keine Enqueue-Abweisung und
abgeschlossenen Runner ohne Fehlermeldung. Ergebnis in `analysis.json`:

| Quelle | beobachtete angenommene Spanne | Capture/Enqueue |
|---|---:|---|
|drop|41.883s|keine Abbrüche/Fehler/Ablehnungen|
|song|42.083s|keine Abbrüche/Fehler/Ablehnungen|
|drumsampler|41.786s|keine Abbrüche/Fehler/Ablehnungen|
|instru|42.020s|keine Abbrüche/Fehler/Ablehnungen|

Alle vier geprüft grün. Prozess-Exit wurde vom Referenzlauncher nicht separat
gespeichert und wird nicht nachträglich als0 erfunden. Diagnoserunner beendet
sich ohne gemeldeten Fehler; Rohlog und kompletter Runner sind archiviert.
Auch hier wächst der Source-Vorsprung auf1,5–1,6s am Messende. Das grüne endliche
Fenster ist kein Beweis unbegrenzter Stabilität, keiner PA-Kontinuität und
keine Umdeutung des erweiterten roten4Quellen-Szenarios. Beleg `R13-R11-REFERENCE`.

### Prüfungen, Scope und Belegsicherung

Gezielte acht Dateien auf Hetzner:96Tests grün, einschließlich unveränderter
R10-Datei mit51Tests (davon48State-Matrix). Typecheck und Lint auf dem
Optimierungsstand Exit0. Abschlussprüfungen auf `ac0509a`: Typecheck0, Lint0,
gezielte acht Dateien Exit0/96Tests grün; separate Rohlogs/Exitdateien gesichert.

Die vollständige `npm run test`-Suite wurde in R13 nicht erneut ausgeführt:
Der bereits rote masterRoutes-Cleanup gehört laut Auftrag in eine separate
Test-Infra-Spur. Letzter vollständiger R12-Lauf bleibt Exit1,
4066bestanden/4fehlgeschlagen plus Cleanup-Hook; nach privatem TMPDIR die zwei
EACCES-Fälle einzeln gelöst, masterRoutes-Hook und zwei geschützte Boundary-
Fehler weiter rot. Kein aktuelles Gesamtgrün und keine Aussage „nur zwei rot“
für einen nicht ausgeführten Gesamtlauf. Beleg `R13-CHECKS`.

R10-Quelladapter, deren48State-Matrix-Fälle, BackendMainAccess, R5-Delegation/
Locks, aiMONK, Monitor/Cue, Boundary-Tests, RT-/Audio-Gates, Legacy-Domains,
GPU-/Deploy-Konfiguration unverändert. Vergleich gegen `ca7b5be` Exit0 für
diese geschützten Pfade. Keine spekulative Queue-Vergrößerung, kein Mastering,
keine neue Infrastruktur, kein Merge. Alter R11- und R12-Rohdatensiegelhash
unverändert. Temporärer Artefakt-HTTP-Export wird nach Sicherung beendet;
Testhost bleibt ausdrücklich erhalten. Belege `R13-SCOPE`, `R13-RAW-SEAL`.

**R13: Prozessor-/SRC-Optimierungen belegt, ursprüngliche Vier-Quellen-
Referenz grün; erweiterte4/6/8Quellen-Integration rot. Gemeinsamer
Zeitachsen-/PA-Blocker nicht vollständig diagnostiziert und nicht behoben.**

R13-Rohdatensiegel: `/workspace/work/r13-data/raw-manifest.json`, 138 Dateien, SHA256
`d9367fe48575602e4d12fcbeba1b23eb0e6b18b772040a3badcfb6a48afdc35c`. Sieben Archive gegen authentifizierte Hetzner-Konsole
verifiziert (`archive-verification.json`). Abschluss-Export beendet; keine
Testprozesse/-Listener mehr auf den geprüften Ports, Host176142753 bleibt.
