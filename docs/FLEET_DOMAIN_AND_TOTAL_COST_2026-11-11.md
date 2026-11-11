# audioMONASTRY: Domain, Gesamtkosten und weltweite GPU-Rollen

Stand: 11. November 2026. Reine Bestands-/Preisabfragen, keine Buchung, Migration oder DNS-Änderung. Beträge sind Szenarien und keine ausgelesene Gesamtrechnung. USD-Umrechnung: 0,92 EUR/USD; zusätzlich 1,19 Steuerfaktor. Die tatsächliche Rechnung kann je nach Kurs und Umsatzsteuerbehandlung abweichen.

## Domain-Umstellung

Die aktiven Quellcode-, Worker-, TURN-, Caddy-, Monitoring-, Deployment- und Test-Verweise sind auf hallerbans.de umgestellt. Das betrifft auch origin.hallerbans.de und sfu.hallerbans.de. Aktuelle Betriebsrunbooks wurden angepasst. Historische Auditberichte behalten ihre damaligen URLs. DNS/Nameserver bei Speed IT, Zertifikate und ein tatsächliches Worker-/Server-Deployment wurden nicht verändert. Eine für die alte Domain gültige Cloudflare-Zone oder ein altes Zertifikat darf nicht automatisch als gültig für hallerbans.de angenommen werden. Vor Live-Tests zunächst DNS, neue Zone/Route und TLS prüfen; insbesondere keine Studio-Zugangsdaten an eine noch falsch aufgelöste Domain senden.

## Tatsächlich ausgelesener Bestand

| Baustein | Ergebnis |
|---|---|
| R2-Dateien | 8,004 Objekte, 375.28 GB dezimal |
| Davon weights/ | 344.95 GB |
| Andere R2-Dateien | 30.33 GB |
| Supabase-Projekt audioMONASTRY | Storage-Objektabfrage erfolgreich; keine Zeilen in storage.objects. Keine Aussage über andere Projekte, DB-Größe oder gebuchten Tarif. |
| Zugängliches Hetzner-Projekt | Zum Abfragezeitpunkt keine Server; 14 Snapshots mit zusammen 49,84 GB, eine Floating-IP, keine Volumes oder Load Balancer. |

Die R2-Gewichte umfassen auch nicht mehr ausgewählte Modellbestände. Die 344,95 GB sind daher weder der RAM-Bedarf noch eine gemessene Downloadmenge pro Neustart der ausgewählten Flotte. Einige ausgewählte Modelle werden direkt von Hugging Face geladen; Docker-Layer kommen zusätzlich hinzu. Keine Daten wurden gelöscht oder verschoben.

## Speicherung ist etwas anderes als Datenverkehr

Speicherung = GB, die einen Monat liegen bleiben. Datenverkehr = GB, die tatsächlich eine Verbindung passieren. Die 375 GB im Bucket werden nicht bei jeder Inferenz übertragen. Gewichte laden beim Cold Start und bleiben auf der GPU-Instanz. Eine Inferenz überträgt danach Prompt/Audio-Eingabe und Ergebnis. Ein Host ist einfach der physische Anbieterrechner hinter einer Vast-Instanz; acht Rollen können auf acht verschiedenen solchen Rechnern laufen. Das ist keine zusätzliche Storage-Schicht.

R2 → GPU ist aus R2-Sicht kostenloser Egress (Standard ohne Retrievalgebühr); der Vast-Host kann trotzdem seinen empfangenen Traffic berechnen. GPU → R2 kann aus Vast-Sicht ausgehenden Traffic kosten. Cloudflare als Zwischenstation hebt die Host-Gebühr nicht auf. Die üblichen WebRTC/SFU-Streams laufen über die Medien-/Hetzner-Strecke, nicht zwangsläufig über jede KI-Karte.

## Speichervergleich

| Speicher für konstanten Bestand | 375,28 GB | 500 GB | Anmerkung |
|---|---:|---:|---|
| R2 Standard nach 10 GB Freimenge | 6.00 €/Monat | 8.05 €/Monat | Requests oberhalb der Freimengen separat; direkter Egress gratis |
| Supabase Pro: nur zusätzlicher Storage oberhalb 100 GB | 6.42 €/Monat | 9.33 €/Monat | Pro-Grundpreis und Egress kommen dazu |
| Vast-Lokaldisk: beobachteter Tarif 0,20 USD/GB/Monat | 82.17 €/Monat | 109.48 €/Monat | Isolierter Kapazitätsvergleich, keine gleichwertige persistente R2-Ablage |

Der Vast-Tarif ist das niedrigste beobachtete Storage-Entgelt unter den in einer zusätzlichen Stichprobe gefundenen kompatiblen Einzel-GPU-Angeboten mit mindestens 500 GB freier Disk, kein globales Marktminimum. Vorhandene freie, ohnehin bezahlte Pod-Disk könnte Dateien ohne zusätzliche Kapazitätskosten aufnehmen. Deshalb darf diese Speicherzeile NICHT pauschal zusätzlich auf den bereits disk-inklusiven GPU-Preis geschlagen werden. Sie zeigt den Preis einer separat bepreisten Kapazität. Verteilung auf freie Restplatten erfordert außerdem einen Speicher-/Replikationsplan und bindet Daten an den Lebenszyklus der Hosts. Eine sichere komplette Vast-Migration von Core, DB/Auth und dauerhaftem Objektspeicher ist damit nicht bepreist oder umgesetzt.

Die genannten ungefähr 5 EUR für 333 GB sind als Speicherbetrag plausibel. Bei Supabase Pro sind 100 GB enthalten; weitere 233 GB kosten rechnerisch 4,96 USD vor Umrechnung/Steuer. Das ist kein vollständiger Supabase-Tarif. Der aktuelle bekannte Dateibestand ist auf R2; die tatsächliche Supabase-Rechnung wurde nicht ausgelesen.

## Weltweite Rollen sind sinnvoll, wenn die Aufgaben asynchron sind

Die pauschale Europa-Empfehlung war zu streng. Generierung, Stem-Trennung, Restoration und viele Analysen können weltweit laufen, ohne den AudioWorklet-/Master-Audiotakt über diese Strecke zu führen. Latenz muss pro Aufgabenkette bewertet werden. Audio-Brain/GUI-Ausführung bleibt im bevorzugten Vergleichsprofil in Europa; Vis bleibt in Deutschland. Ears muss bei laufender Analyse anhand tatsächlicher Chunk-Größen und Antwortfristen gemessen werden. Das große Brain kann weltweite Planung übernehmen, solange der direkte GUI-Pfad nicht bei jedem Schritt auf dessen lange Kette wartet.

Ein Zahlenbeispiel, keine Ping-Messung: 40 ms RTT gegenüber 200 ms RTT bedeutet bei fünf nacheinander abhängigen Nachrichten 0,8 s zusätzliche Netzwartezeit. Bei 30 Sekunden Generierungszeit wenig; beim unmittelbaren GUI-Kommando merklich. Über Kontinente sind nicht bloß 2 ms Differenz anzusetzen. Große Dateien werden stärker durch nutzbare Bandbreite und Wiederholungen beeinflusst als durch einen einzelnen Ping. 100 MB benötigen bei effektiv 100 Mbit/s bereits 8 Sekunden reine Übertragungszeit. Weltweite Angebote müssen deshalb nach tatsächlicher API-Latenz, Upload/Download und Inferenzleistung gemessen werden.

## Bevorzugtes gemischtes Vast-Profil

Abgeleitet aus den gespeicherten globalen und europäischen Angebotsabfragen. Acht unterschiedliche Hosts; keine Kapazitätsreservierung. RTX 4090/5090 für Executor und Song bevorzugt. Der gemischte Plan ist nun mit --region hybrid reproduzierbar.

| Rolle | GPU | Standort | €/h mit Disk/Steuerannahme |
|---|---|---|---:|
| brain | RTX PRO 5000 | Jiangsu, CN | 0.772 |
| ears | RTX A6000 | India, IN | 0.511 |
| voice | RTX A6000 | India, IN | 0.557 |
| music | L40 | New York, US | 0.585 |
| studio | RTX PRO 6000 S | Spain, ES | 1.755 |
| audio-brain | RTX 4090 | Poland, PL | 0.464 |
| song | RTX 4090 | Sweden, SE | 0.504 |
| vis | RTX 6000Ada | Germany, DE | 0.785 |

Summe erwarteter GPU-/Disk-Entgelte: **5.932 EUR/h**. Mit bisheriger 0,40-EUR/h-Planungsreserve: **6.332 EUR/h**. Die Reserve ist kein Rechnungsbetrag. CPU-Kernserver, R2, Supabase und variabler Traffic sind davon getrennt.

## Reale Gesamtkosten als Nutzungs-Szenario

Gemeinsame Basis: bisherige vier Hetzner-Rollen 2×cx43 + cx33 + cx23 in Nürnberg, dauerhaft 30 Tage betrieben; vier primäre IPv4 angenommen; vorhandene Snapshots und eine Floating-IPv4 angenommen; R2 konstant in obiger Größe; Supabase Pro mit einem durch Compute-Credits gedeckten Micro-Projekt angenommen. Keine erfundene Ist-Rechnung: aktuell sind keine Hetzner-Server sichtbar, und Supabase-Tarif/Steuer sind Annahmen. Worker-/Domainkosten und sonstige Add-ons sind nicht bestätigt.

| Gemeinsamer Monatsbaustein | EUR/Monat |
|---|---:|
| Vier Hetzner-Server, Monatsdeckel aus API | 54.69 |
| Vier primäre IPv4, angenommen | 2.38 |
| Vorhandene Snapshots + Floating-IPv4, angenommen | 4.42 |
| R2 Standard | 6.00 |
| Supabase Pro, angenommener Grundtarif | 27.37 |
| Gemeinsame Basis | **94.86** |

| GPU-Variante | EUR je Stunde aller acht Rollen, mit Arbeitsdisk, ohne Reserve/Transfers |
|---|---:|
| Vast weltweit, preisoptimiert | 5.355 |
| Vast weltweit, schnellere kleine Modelle | 5.910 |
| Vast gemischt, bevorzugt | 5.932 |
| Vast ausschließlich Europa, schnellere kleine Modelle | 7.181 |
| Runpod: aktueller Katalog + 1.280 GB Containerdisk | 7.004 |

Runpod-Katalog wurde neu gelesen: zur Abfragezeit gab es eine rechnerische Kombination aller acht Rollen innerhalb der Limits. Dies ist kein erfolgreicher Start- oder Inferenznachweis. Für Runpod wurden 0,10 USD/GB/Monat für die Containerdisk mit einem 720-Stunden-Rechenmonat auf die Laufzeit umgelegt. Vast-Preise enthalten die im Suchauftrag allokierte Disk bereits. Das ist ein Tarif-/Planvergleich, kein Durchsatz-normalisierter Benchmark; gleiche Modelle auf anderer Hardware können unterschiedliche Jobs pro Stunde schaffen.

| Stunden pro Monat mit allen acht GPUs | Vast preisoptimiert weltweit | Vast gemischt | Runpod | Vast Europa |
|---:|---:|---:|---:|---:|
| 120 | 737.51 € | 806.70 € | 935.37 € | 956.61 € |
| 200 | 1165.94 € | 1281.26 € | 1495.72 € | 1531.11 € |
| 240 | 1380.15 € | 1518.54 € | 1775.89 € | 1818.36 € |
| 720 | 3950.74 € | 4365.89 € | 5137.95 € | 5265.35 € |

Alle Monatszeilen enthalten die gemeinsame Basis von 94,86 EUR, aber noch keine Cold-Start-Transfers und keinen variablen KI-/Video-Traffic. Für 200 Flottenstunden ergibt das gemischte Profil etwa **1.281 EUR/Monat**. Die 0,40-EUR/h-Reserve entspräche weiteren 80 EUR Budgetpuffer, nicht einem sicheren Mehrverbrauch. Wenn auch die Hetzner-Flotte on demand läuft, wird die gemeinsame Basis niedriger; Snapshots/IP/R2/Supabase bleiben teilweise bestehen.

## Audio-/Visual-Traffic grob hochgerechnet

GB sind dezimale GB. Formel für einen kontinuierlichen Stream: Mbit/s × 0,45 = GB/h. Für WebRTC-Musik sind im Code maximal 256 kbit/s vorgesehen (kein garantierter Ist-Verbrauch). 1080p mit 6 Mbit/s und 4K mit 25 Mbit/s sind Rechenszenarien; eine feste entsprechende Video-Bitrate ist im Code nicht erzwungen. Audio-Konfiguration: src/core/transport/opusMusicSdp.ts; tatsächlicher Video-Uploadpfad: src/hooks/useVisualStream.ts und MediasoupTransport.ts.

| Strecke | Payload-Volumen |
|---|---:|
| Ein Musikstream, 256 kbit/s | 0,115 GB/h |
| Vier Musiker, jeder an die drei anderen weitergeleitet: 12 ausgehende Streams | 1,382 GB/h |
| Zusätzlich ein Master-Ausgang mit 256 kbit/s | 0,115 GB/h |
| Ein Visual-Ausgang, angenommene 6 Mbit/s | 2,700 GB/h |
| Ein Visual-Ausgang, angenommene 25 Mbit/s | 11,250 GB/h |
| 200 Stunden: 12 Peer-Musikstreams + Master + 1080p, plus 15 % | **965 GB/Monat** |
| Gleicher Fall mit 4K statt 1080p | **2932 GB/Monat** |

Das ist ein begrenztes Viernutzer-Szenario, keine unbegrenzte Zuschauerzahl. Mehrere Audiospuren pro Person, Voicechat, erneutes Laden, TURN-Relay und zusätzliche Videoziele können weitere Transfers verursachen. Ein Master-/Visual-Ausgang ist laut Projekt je einmal vorgesehen. Die tatsächliche SFU-Streamzahl ist nach Verbindungsgraph zu messen; nicht jede Session sendet dauerhaft zwölf Musikstreams. Die vier Eingangsstreams zum SFU umfassen zusätzlich 0,461 GB/h, also rund 92 GB in 200 Stunden vor Aufschlag; sie sind nicht Teil der obigen ausgehenden Verkehrssumme.

Hetzner nennt für die gewählten EU-Server 20 TiB enthaltenen ausgehenden Traffic pro Server (API: 21.990.232.555.520 Bytes). 965 GB oder 2.932 GB auf dem SFU-Knoten liegen deutlich darunter; deshalb im Szenario kein zusätzlicher Hetzner-Trafficpreis. Bei kurzen Serverlebenszeiten muss die zeitanteilige Inklusivmenge beachtet werden. Quoten werden nicht ungeprüft über Server zusammengezählt.

Der MJPEG-Fallback ist ein anderer Kostenpfad: im Code maximal 12 fps und 512 KiB pro Bild. Bei angenommenen 100 kB pro JPEG sind das 4,32 GB/h Payload zum einen Empfänger. Das technische Bildgrößenlimit ergäbe maximal ca. 22,65 GB/h; dieser Wert ist ein theoretisches Limit, kein gemessener Normalfall. Zusätzlich wird jedes Bild vom Studio zum Relay hochgeladen. WebRTC-Video daher bevorzugen.

## KI-Dateien und Startkosten

Im vorhandenen Stem-Pfad werden die fünf Standard-Stems bei funktionierender R2-Konfiguration direkt per presigned PUT nach R2 geschrieben. Der Server schickt die Audioeingabe als Base64; die Antwort enthält dann keine fünf riesigen Base64-Audios. Belegt in server/stemSeparation.ts und handlers_stems.py. Im Fallback werden die Stems inline übertragen. Die Ausgabe ist standardmäßig Float32-WAV.

Beispiel 200 Stem-Jobs pro Monat, je vier Minuten Stereo mit 48 kHz: Bei 24-Bit-WAV als Eingang ergeben sich mit Base64 **18.43 GB GPU-Ingress**; fünf Float32-WAV-Ausgaben ergeben **92.16 GB GPU-Egress** direkt zu R2. Optional mitgesendete Roh-Modellstems und weitere Jobs sind nicht enthalten. Bei unserem Studio-Angebot kosten diese beiden Strecken zusammen rechnerisch etwa 0.45 EUR. Speicherung der neuen Stems und spätere Nutzerdownloads sind davon getrennt.

Falls die Vis-GPU wirklich 200 Stunden lang durchgehend einen 6-Mbit/s-Stream erzeugt und ausliefert, entstehen dort 540 GB Payload-Egress. Am deutschen Vis-Angebot sind das ca. 2,39 EUR Host-Egress; danach kann Hetzner das Video innerhalb seines enthaltenen Traffics weitergeben. Der aktuelle Canvas→SFU→Visual-out-Pfad beweist aber keinen solchen kontinuierlichen GPU-Stream: nicht jeden Visual-Stream pauschal doppelt als Vast-Traffic berechnen.

Cold-Start-Sensitivität: Eine einmalige vollständige Kopie der aktuellen 375.28 GB kostet bei einem angenommenen Vast-Ingress-Tarif von 0,002604 USD/GB ungefähr 1.07 EUR; bei 0,0390625 USD/GB ungefähr 16.05 EUR. Das ist kein gemessener Flottenstart. Im tatsächlichen Start werden nur die benötigten Gewichte je Rolle geladen, manche direkt upstream, und zusätzlich Docker-Layer; mehrere Rollen können gemeinsame Dateien erneut herunterladen. Ein genauer Cold-Start-Preis braucht diese Mengen je Host. Tagesneustarts multiplizieren diese Kosten; ein warmer Prozess lädt seine Gewichte nicht pro Anfrage neu.

## Empfehlung

R2 als dauerhaften Datei-/Gewichtsspeicher behalten, Supabase weiterhin für DB/Auth und Metadaten einsetzen, Hetzner für Core/SFU/Live-Ausgabe und Vast rollenweise weltweit zulassen. GUI-Ausführung zunächst Europa, Vis Deutschland. Die GPU-Stunden dominieren die Kosten, nicht der 375-GB-Objektbestand. Vor einer Migration genau dieses gemischte Profil auf echte Inferenz, API-Latenz, Downloadrate, Cache-Verhalten und Outputqualität prüfen. Kein kostenpflichtiger Vast-Test wurde durchgeführt; VAST_API_KEY fehlt weiterhin.

## Nachweise und Grenzen

Rohwerte ohne Secrets: FLEET_TOTAL_COST_INPUTS_2026-11-11.json. Host-/GPU-Zuordnung: VAST_HYBRID_PROFILE_2026-11-11.json. Die API-Daten enthalten keine privaten Datei-Inhalte, Tokens, signierten URLs oder Server-IP-Adressen. Kosten sind bei konstantem Datenbestand und den benannten Nutzungsannahmen berechnet, keine Garantie für verfügbare Kapazität oder eine zukünftige Rechnung.

Quellen:
- https://developers.cloudflare.com/r2/pricing/
- https://supabase.com/pricing
- https://supabase.com/docs/guides/platform/manage-your-usage/storage-size
- https://supabase.com/docs/guides/platform/manage-your-usage/egress
- https://docs.hetzner.com/de/robot/general/traffic/
- https://www.runpod.io/pricing
- https://docs.vast.ai/guides/instances/pricing
- https://www.cloudflare.com/en-gb/learning/performance/glossary/what-is-latency/

Validierung der Domainänderung: 96 gezielte TypeScript-Prüfungen in neun Testdateien bestanden; Typecheck und ESLint bestanden. Acht gezielte Vast-Planerprüfungen bestanden. DNS/TLS/Live-Deployment bewusst ausstehend. Die gesamte Anwendungssuite wurde nicht erneut als grün behauptet.
