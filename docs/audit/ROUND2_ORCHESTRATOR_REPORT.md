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

A1b-Nebenfund unter Freeze: Das frühere Vast-Listen-API liefert HTTP410 statt einer leeren Liste. Nur der Audit-Client nutzt das offiziell dokumentierte paginierte v1; der vorhandene AI-/Lifecycle-Client bleibt unverändert. Dies ist als Folgearbeit gemeldet, nicht stillschweigend migriert.

**B3 Kosten Ist vs. Cap:** nicht gestartet, keine B3-Istkosten gemessen; Cap30EUR unverändert. Die für leere erfolgreiche Listen belegten Summen (0EUR/h Server im einen Hetzner-Scope und0USD/h Instanzen im Vast-Scope) sind keine globale Rechnung und keine Kostenfreigabe für unbekannte Accounts.
