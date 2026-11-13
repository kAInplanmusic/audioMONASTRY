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
