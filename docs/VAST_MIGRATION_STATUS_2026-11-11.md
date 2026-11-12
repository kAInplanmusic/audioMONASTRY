# Vast-Migration: aktueller Bau-, Prüf- und Übergabestand – 2026-11-11

Acht Rollen auf acht Instanzen; sieben unterschiedliche Images, weil Voice und Music ein gemeinsames Image mit getrennter Modellauswahl verwenden. Die 22 ausgewählten IDs, Repository-Revisionen und Gewichte bleiben erhalten. Obergrenze: 8 EUR/h ohne Hetzner und Supabase; ein GPU-Test höchstens 28 Minuten mit anschließendem Löschen seiner Verträge.

## Aktueller Nachweis

| Bereich | Stand |
|---|---|
| R2-Zugang | Neuer Schlüssel authentifiziert, HTTP 200; aktuelle Zugangsdaten gespeichert und CI-Secrets aktualisiert |
| R2-Modellobjekte | 151 referenzierte Einträge über paginierten Objektbestand auf Existenz, Größe und Standard Storage geprüft |
| Upstream-Modelle | Byte-Metadaten der gepinnten Revisionen einschließlich Zusatzkomponenten abrufbar |
| Gewichtsübertragung | Konservative Obergrenze rund 180 GB, einschließlich bewusst doppelt gezählter Hilfsdateien |
| Images | Sieben neue Images für acht Rollen erfolgreich gebaut und per Digest gespeichert |
| Gemeinsamer GPU-/Inferenztest | Abschließendes Ergebnis separat unten; kein Erfolg allein aus dem Imagebau abgeleitet |
| Produktionsadressen | Werden erst nach echtem Readiness-/Inventarabgleich übernommen; keine erfundenen Host-Adressen |

Erfolgreicher neuer Imagebau mit komprimierter Startkonfiguration:

https://github.com/kAInplanmusic/audioMONASTRY/actions/runs/43109676783

Die Images übernehmen exakt die bisherigen Basisimages, Modellabhängigkeiten und Revisionen. Der Offline-Smoke prüft den Import des Vast-Entrypoints und die eingebetteten Modellidentitäten. Er ersetzt keinen GPU-Inferenztest.

## Behobene Provisionierungsprobleme

Der frühere R2-Fehler `SignatureDoesNotMatch` ist mit dem neu bereitgestellten Schlüssel behoben. Der Kontobefund bei Vast ist ebenfalls aktualisiert: positives Guthaben und hinterlegte Abrechnung. Der alte Null-Guthaben-Befund ist historisch.

Vast hat einen Start mit `invalid env arguments, total length > 32KB` abgelehnt. Signierte Gewichtslisten werden deshalb jetzt verlustfrei zlib-komprimiert und Base64-kodiert übertragen. Der Container stellt vor dem eigentlichen Modellstart die ursprüngliche Liste wieder her. Vor der ersten Buchung werden alle acht vollständigen Startumgebungen geprüft; die eigene Grenze liegt konservativ bei 28 KB. TLS-Schlüssel und komprimierte Bootstrap-Werte werden beim Start aus der Prozessumgebung entfernt. Gewichte werden weder ersetzt noch inhaltlich verändert.

Angebote können zwischen Suche und Buchung verschwinden. Der Controller prüft sie frisch, parallelisiert die acht Vorprüfungen und bucht die knappe Studio-Rolle zuerst. Der QA-Lauf darf vor jeder möglichen Buchung neu planen. Nach einer möglichen kostenpflichtigen Erzeugung wiederholt er keine unkontrollierten Image-/Gewichtskopien. Bereinigung prüft eigene aufgezeichnete IDs und Labels.

## Kosten und Regionen

Die globale Suche ist entsprechend der Betreiberfreigabe für alle acht Rollen aktiviert. Das betrifft auch Vis und den GUI-Executor; deren praktische Latenz muss im Live-Test gemessen werden. GPU-Modelle müssen weiterhin in der rollenbezogenen Kompatibilitätsliste stehen. Vis erhält mit seinem bisherigen CUDA-Image keine ungeprüfte Blackwell-Karte. Der aktuelle QA-Lauf und der normale Planer verwenden dieselbe Untergrenze von 99 Prozent gemeldeter Zuverlässigkeit auf verifizierten Hosts. Die frühere QA-Ausnahme mit 98 Prozent ist entfernt. Pro GPU gilt weiterhin höchstens 2 EUR/h gemäß den dokumentierten Steuer-/Wechselkursannahmen.

Die Auswahl minimiert die Kosten einer vollen ersten Betriebsstunde einschließlich einmaliger Übertragung. Der konkrete Test bleibt auf höchstens 28 Minuten begrenzt. Ihre Belege enthalten:

- Komprimierte Layer-/Config-Bytes, an die konkreten Image-Digests gebunden.
- R2-Objekte mit bestätigter Größe und Standard Storage; keine unberücksichtigte Infrequent-Access-Abrufgebühr.
- Gepinnte HF-Repositories und Zusatzkomponenten mit konservativen Dateiumfängen.
- Frische Host-Ingresspreise, 10 Prozent Übertragungsaufschlag, 0,01 EUR Requestreserve und die vorhandene 0,40-EUR/h-Betriebsreserve.

Die Erstübertragung wird einmal in der ersten Betriebsstunde berücksichtigt. Der Controller weist laufende EUR/h, die gesamte erste Stunde und den maximalen Geldbetrag für den 28-Minuten-Test getrennt aus. Eine frühere konservative Prüfung hatte den einmaligen Transfer auf 28 Minuten umgelegt und dadurch als mehrfach wiederkehrende Stundenlast behandelt; diese Fehlannahme ist korrigiert. Nur ein vollständiger Acht-Host-Plan mit laufendem Stundensatz und voller erster Stunde unter 8 EUR darf starten. Preise und Übertragungsobergrenze werden nach den frischen Host-Prüfungen erneut berechnet; beobachtete Vertragspreise werden ebenfalls kontrolliert. Ein manueller Transferdeckel kann zusätzlich begrenzen. `-1` bedeutet jetzt automatische Prüfung der Byte-Belege, kein ungeprüftes Nullsetzen.

R2-Bestand und Byte-Belege: `docs/VAST_WEIGHT_TRANSFER_INVENTORY_2026-11-11.json`. Image-Zuordnung: `deploy/vast/images.json`; komprimierte Größen: `deploy/vast/image-sizes.json`. Künftige Imagebauten aktualisieren Zuordnung und Größen gemeinsam.

## Aktive Dateien und Betrieb

- `deploy/gpu-provider.json`: Vast, globale Regionen, 8-EUR-Grenze, 28 Minuten, Hetzner/Supabase ausgenommen.
- `deploy/gpu/pod-fleet.json`: kanonische physische Rollen-/Modell-/Basisimage-Quelle; keine doppelte Auswahl unter deploy/runpod.
- `.env.example`, Python-Dispatcher und aktive Shell-Einstiege für Start/Stop/Deploy verwenden Vast. Alte kostenpflichtige Runpod-CLIs verlangen eine ausdrückliche Kompatibilitätsauswahl; historische Nachweise bleiben erhalten.
- Neue Start-/Stop-/Adoptions-/Autostop-Pfade verwenden Vast-Adressen und beobachtete Kosten. Fehlende Konfiguration fällt nicht auf den früheren Anbieter zurück.
- Allgemeine LLM-Aufrufe verwenden das ausgewählte 27B-Brain; das 4B-Modell behält den eigenen GUI-Executor-Vertrag.
- HTTPS ist verpflichtend. Private Schlüssel, signierte URLs, API-Geheimnisse und Runtime-Dateien bleiben im privaten Controller-State. Node verwendet `NODE_EXTRA_CA_CERTS`; TLS-Prüfung wird nicht abgeschaltet.
- Alle acht `/ready`- und `/models`-Antworten müssen die genaue resident geladene Auswahl mit passender Repository-/Revisionsidentität bestätigen, bevor Runtime-Adressen erzeugt werden.
- Der QA-Lauf prüft Authentifizierung und alle 21 ausführbaren IDs; ACE Shared wird als Komponente geprüft. Audio muss endliche, nicht leere Samples liefern. Chromium/NVENC brauchen zusätzlich einen echten Rendernachweis auf dem neuen Host.
- `vast-promote-runtime.py` kann geprüfte private Runtime-Werte und das öffentliche CA-Bundle in eine vorhandene vollständige Orchestrator-Konfiguration übernehmen. DNS für hallerbans.de wurde nicht geändert.

## Gewichtsidentität und Cache

Alle Modellobjekte und Zusatzkomponenten sind gegenüber dem Stand vor der Provider-Umstellung identisch. Im Modellmanifest wurden nur erklärende Pfadverweise auf deploy/gpu aktualisiert. Der Asset-Lock ist bytegleich.

- Modellmanifest SHA256: `89db46eab67281067c3567114ecd2071a471f9fccfc0e43ebaae76475e2adc75`
- Asset-Lock SHA256: `28d7323f4e67b8e7e69587887a22c77adb6e9ba355a82947b113a0620e41588e`

Es gab keinen erneuten Upload und keine Löschung von R2-Modellobjekten. Neue Vast-Rechner brauchen eine erste Kopie aus R2 beziehungsweise den bereits gepinnten Quellen. Lokale Dateien werden bei Neustarts anhand echter SHA256-Prüfungen wiederverwendet; TAR-Extraktionen besitzen eigene Hash-Belege. Vollständiges Löschen einer Instanz entfernt ihren lokalen Cache. Stoppen erhält die Disk und verursacht weitere Disk-Kosten; QA löscht seine Verträge.

## Prüfstand

33 Python-Prüfungen für Migration, Angebotsplanung, Transferbudget, R2-Pagination, GPU-Klassifikation und Startup-/Kompressionsübergabe bestanden (12. November, 01:10 Uhr deutscher Zeit). Darunter ist der Nachweis, dass eine nach HTTP 429 bereits vorhandene Buchung anhand ihres Labels übernommen statt erneut bezahlt wird. Die letzten 33 gezielten TypeScript-Prüfungen bestanden, ebenso Typecheck/ESLint. Der frühere vollständige TypeScript-Lauf hatte 3.771 bestandene und 36 fehlgeschlagene Tests in 13 Dateien; dieser Gesamtbestand ist nicht als grün bestätigt. Die Python-/Workflow-/Entrypoint-Änderungen dieses Schritts ändern diesen Befund nicht ohne neuen vollständigen Lauf.

## Tatsächlich angelegte Acht-Rollen-Flotte

Lauf: https://github.com/kAInplanmusic/audioMONASTRY/actions/runs/43112085254

Alle acht Rollen wurden im selben Lauf erfolgreich als Vast-Verträge angelegt: Studio, Brain, Ears, Voice, Music, Audio-Brain, Song und Vis. Der unmittelbar beobachtete gesamte laufende Stundensatz einschließlich Disk, dokumentierter Steuer-/Wechselkursannahme und 0,40-EUR/h-Reserve betrug 6,0557 EUR/h. Dies ist ein Buchungsbeleg, noch kein gemeinsamer Readiness-/Inferenzbeleg. Während des Tests läuft zusätzlich eine unabhängige, auf die eigenen Labels/IDs begrenzte 28-Minuten-Bereinigung.

Die zusätzliche 250-MB-Antwortgrenze ist aus der aktuellen Abnahmedefinition entfernt. Auch kleine Smoke-Overrides für Inferenzschritte, Tokenzahl und Dauer werden bei der Abnahme nicht mehr vorgegeben; es gelten die normalen Handler-Defaults. Vollständige Antworten werden gemessen. Die 0,40-EUR/h-Reserve bleibt eine Prognose für variable Betriebskosten, keine Garantie für unbegrenzt große Ausgaben.

## Abschluss des gebuchten Vorlaufs und aktualisierte Vorgaben

Der gebuchte Lauf endete am 11. November um 23:55 Uhr deutscher Zeit mit `Readiness deadline exceeded`, bevor der gemeinsame externe Inferenzteil erreicht wurde. Alle acht Verträge waren angelegt; Cleanup erfolgreich. Die spätere Kontoprüfung bestätigt null Vast-Instanzen. Es gibt keinen neuen Nachweis 22/22 auf Vast. Der aktualisierte Abnahmetest mit normalen Handler-Defaults und vollständigen Antworten ist noch nicht erfolgreich ausgeführt.

Die theoretische Unter-1-EUR-Kartenliste ist eine Ergänzung. Die Obergrenze bleibt 8 EUR/h für die gesamte Flotte, nicht 1 EUR/h je Instanz. Mehr als 1 EUR/h teure passende Karten bleiben im bestehenden Hardwareprofil erhalten. Rollenübersicht und Quotenstatus: `docs/VAST_GPU_ALTERNATIVEN_UNTER_1EUR_2026-11-12.md`. Betrieb ohne dauerhaft bezahlte Server und der noch vorhandene IPv4-Kostenrest: `docs/VAST_ON_DEMAND_BETRIEB_2026-11-12.md`.

Die nativen Vast-Namen RTX PRO 6000 Max-Q, RTX PRO 4500 und RTX PRO 4000 werden auf die bereits im kanonischen Profil vorgesehenen Hardwaretypen abgebildet. Dadurch wird keine neue Modell-/Gewichtsvariante eingeführt; ein bisher übersehener 96-GB-Max-Q-Studio-Kandidat wird nicht mehr allein wegen der Schreibweise verworfen.


## Kaltstart-Bandbreite – 12. November

Der dritte gemeinsame Lauf `43124573067` verwendet die gepinnten vollständigen Images und normale Handler-Defaults. Nach der API-Drosselung wurden wieder alle acht Verträge angelegt. Beobachteter laufender Gesamtpreis: 5,6273 EUR/h einschließlich Disk und 0,40 EUR/h Reserve. Das ist noch kein Readiness- oder Inferenznachweis.

Ein konkreter Planungsfehler wurde aus Host-Metadaten erkannt: Die ausgewählte Music-Maschine meldet 131,5 Mbit/s Download; die konservative vollständige Image-/Gewichtsmenge beträgt 45,23 GB. Selbst bei durchgehend dieser Datenrate ergibt die Prognose 45,86 Minuten. Die bisherige Auswahl prüfte Geld und vollständige Bytes, aber keine Übertragungsdauer.

Der Planer schließt künftig Kandidaten aus, deren prognostizierte vollständige Übertragung allein das vorhandene 26-Minuten-Readinessfenster erreicht. Fehlende oder ungültige Bandbreitenangaben autorisieren keinen Kaltstart. Vor der ersten Buchung werden die frischen Angaben nochmals geprüft; ein verändertes Angebot darf nur ohne bereits angelegten Controller-State neu geplant werden. Der Prognosewert ist ausdrücklich keine gemessene oder garantierte Übertragungsgeschwindigkeit: Laden, Entpacken, Kompilieren und Inferenz brauchen zusätzliche Zeit. Die laufende Flotte wurde für diese Änderung nicht neu gebucht; Modellbestand und Qualitätsparameter bleiben unverändert.


## Strukturierter Live-Nachweis und UniverSR-Korrektur

Read-only-Lauf https://github.com/kAInplanmusic/audioMONASTRY/actions/runs/43126115777 bestätigte um 01:16 Uhr deutscher Zeit drei Rollen mit `/ready` HTTP 200: Brain, Ears und Song. Dort stimmen alle geladenen IDs und Repository-/Revisionsidentitäten. Zusammen mit dem geladenen DeReverb auf Vis sind neun Modell-IDs als geladen beobachtet. Vis blieb HTTP 503; UniverSR war nicht geladen. Diese Beobachtung ist kein gemeinsamer 22/22-Abnahmetest.

Ohne Container-Rohlogs wurde ein deterministischer Fehler im Startpfad gefunden: `runtime_probe.fixture()` lieferte 44,1-kHz-Audio auch für UniverSR; `universr_enhance()` lehnt diesen Eingang vor dem Modellaufruf ausdrücklich ab. Commit `419cb16` erzeugt für UniverSR eine unterstützte 24-kHz-Quelle bei unveränderter Länge von vier Sekunden und zwei Kanälen. Normale Handler-Defaults und Gewichte ändern sich nicht. Die Vast-Images übernehmen nun auch die korrigierte `runtime_probe.py`; Build `43126381339` ist für die erneute Prüfung gestartet.

Der bezahlte Vorlauf wurde nach diesem Befund vorzeitig beendet, statt bis zum garantierten Readiness-Fehlschlag weiterzulaufen. Strukturierte Belege ohne Rohlogs: `docs/VAST_STATUS_EVIDENCE_2026-11-12.json`. Ein neuer kostenpflichtiger Lauf darf erst nach erfolgreichem Imagebau, aktualisierten Größenbelegen und vollständiger Planung mit der neuen Transferzeitprüfung beginnen.
