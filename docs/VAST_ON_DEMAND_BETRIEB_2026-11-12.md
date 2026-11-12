# audioMONASTRY: Betrieb ohne bezahlte GPU-/CPU-Server im Ruhezustand

Stand: 12. November 2026, Europe/Berlin. Vorgabe: maximal 8 EUR/h für die gesamte aktive Vast-Flotte, ohne Hetzner und Supabase. Einzelne Instanzen dürfen mehr als 1 EUR/h kosten. Die Liste der Karten unter 1 EUR/h ergänzt die Alternativen; sie ersetzt weder die Modellauswahl noch das Gesamtbudget.

## Entscheidung

Nach abgeschlossener Nutzung die eigenen Vast-Instanzen vollständig löschen. Gewichte bleiben im vorhandenen R2-Bucket, die sieben geprüften Images für acht Rollen in GHCR. Für Vast sind keine vollständigen Betriebssystem-Snapshots erforderlich: Image-Digest, Modell-Pins und Provisionierung bilden die Maschine reproduzierbar ab.

Für die Hetzner-Rollen vor dem Löschen geprüfte Snapshots verwenden; Session-/Projektzustand muss zuvor dauerhaft gespeichert und rückgelesen sein. Die vorhandenen Start-/Teardown-Einstiege unterstützen dieses Muster bereits. Die aktuellen Prüfungen belegen den vorgesehenen Ablauf noch nicht vollständig vom ausgeschalteten Zustand bis zur fertigen DAW.

## Warum gestoppte Vast-Instanzen nicht die Baseline sind

Die acht tatsächlich gebuchten lokalen Disks umfassten zusammen 1.280 GB. Die vom Anbieter für diese laufenden Verträge gemeldeten Disk-Komponenten entsprechen bei 720 Stunden hochgerechnet rund **362 EUR pro Monat**, mit der verwendeten Umrechnung und Steuerannahme. Das ist ein Vergleichswert für genau diese Disk-Tarife, kein bestätigtes Angebot für den gestoppten Zustand. Laut Vast können gestoppte Disks anders und höher bepreist sein.

| Zustand | GPU-Kosten | Lokale Disk | Nächster Start |
|---|---|---|---|
| Instanz läuft | nach Laufzeit | läuft mit | Modelle können warm sein |
| Instanz gestoppt | keine laufende GPU-Berechnung | wird weiter berechnet | Cache vorhanden, GPU-Verfügbarkeit nicht garantiert |
| Instanz gelöscht | keine | keine für diesen Vertrag | neue Instanz und erste Gewichts-/Imagekopie nötig |

Standard deshalb: **Löschen statt dauerhaftes Stoppen**. Die bestehenden rund 375 GB R2-Daten bleiben erhalten; bei Standard Storage entsprechen sie mit Free Tier grob 6 EUR/Monat unter den dokumentierten Annahmen, zuzüglich etwaiger Operationen. Supabase-Tarife werden dadurch nicht automatisch beendet.

## Was erneut als Traffic anfällt

Beim Start auf einer neuen Maschine werden deren Rollen-Images und vollständige benötigte Gewichte kopiert. Die konservative Inventur umfasst über alle acht Rollen rund 180 GB Gewichte plus rund 51 GB komprimierte Images. Das ist keine 180-GB-Kopie pro Rolle. R2-Ausgang ist bei Standard Storage ohne Egressgebühr; Vast kann den Empfang je Host berechnen. Hugging-Face-Repositories und Zusatzkomponenten bleiben auf denselben Revisionen.

Ein erneutes Laden von vorhandener lokaler Disk in RAM/VRAM ist kein Internettransfer. Die bisher implementierte SHA-Prüfung vermeidet Downloads bei erhaltenem Cache. Nach vollständigem Löschen der Maschine ist ihr lokaler Cache weg.

Die zuletzt wirklich gebuchte Flotte hatte einen beobachteten laufenden Satz von **6,0557 EUR/h inklusive Disk und 0,40-EUR/h-Reserve**. Vor dem Start waren **0,8546 EUR Transferobergrenze**, **6,9103 EUR für eine volle erste Stunde** und **3,6806 EUR für den höchstens 28-minütigen Lauf** ausgewiesen. Das sind Planwerte, kein bestätigter Kontoauszug. Die neue Testdefinition misst komplette Antwortdaten und verwendet keine zusätzliche 250-MB-Grenze mehr; größere reale Ergebnisse müssen in der Nutzungskostenrechnung mit ihren tatsächlichen Bytes berücksichtigt werden.

## Start und Abschalten

1. Der ausgeschaltete Zustand benötigt einen erreichbaren Startpunkt ohne ständig bezahlten Anwendungsserver, beispielsweise eine statische Startseite mit geschützter serverloser Steuerung. Keine Provider-Geheimnisse in den Browser geben.
2. CPU-Rollen aus den vorgesehenen Snapshots anlegen; vorhandene vollständige App-Konfiguration erhalten.
3. Passende, frisch verfügbare Vast-Angebote suchen und alle acht Rollen aus den festen Image-Digests anlegen. Die Kartenwahl darf variieren; Modell-IDs, Revisionen, Gewichte und Produktionsparameter dürfen nicht heimlich wechseln.
4. Erst nach erfolgreicher Authentifizierung, Readiness und vollständigem Modellinventar die privaten Runtime-Adressen übernehmen. Danach echte Inferenz mit normalen Handler-Defaults prüfen.
5. Beim letzten Nutzer prüfen, ob noch Kollaborationsmitglieder oder Jobs aktiv sind. Laufende Arbeit zu Ende bringen, Zustand sichern und Sicherung verifizieren. Der bestehende Autostop berücksichtigt Mitgliederzahl und Warteschlangen.
6. Eigene Vast-Verträge löschen und die Löschung durch erneute Auflistung bestätigen. CPU-Snapshots abwarten, dann eigene Hetzner-Server löschen. Fremde Ressourcen unangetastet lassen.
7. Abschließend auch Volumes, reservierte IPs und andere Nebenressourcen inventarisieren. „Server aus“ ist kein Nachweis für einen vollständig kostenfreien Ruhezustand.

## Bereinigter Hetzner-Bestand, 12. November 2026, 14:17 UTC

Nach den Wiederanlaufprüfungen sind **0 Hetzner-Server, 0 primäre IPs, 0 Floating-IPs,
0 Volumes, 0 Load Balancer und 0 Netzwerke** bestätigt. Sieben weitere alte Snapshots
und acht nicht zugeordnete alte Firewalls wurden entfernt. Die ausgemusterten
AI-, Master- und Test-Rollen besitzen keine verbleibenden Snapshots.

Erhalten sind **acht verfügbare Wiederherstellungspunkte**: zwei je App-, SFU-,
Media- und Edge-Rolle, zusammen 130,54 GB. Der authentifizierte aktuelle API-Tarif
beträgt 0,017017 EUR brutto je GB und Monat; das ergibt ungefähr **2,22 EUR brutto
pro vollem Monat**. Die Bereinigung entfernt 104,35 GB und reduziert diesen
Speicheransatz um ungefähr 1,78 EUR pro Monat. Dies ist keine Rechnung.
Vier Deployment-Firewalls und vier SSH-Schlüssel bleiben kostenfrei erhalten.

Der vollständige Löschungsnachweis mit IDs und abschließendem Inventar steht in
`docs/HETZNER_CLEANUP_2026-11-12.json`. Die frühere unzugeordnete Floating-IP ist
nicht mehr vorhanden. Produktions-DNS für `origin`, `sfu` und `master` wurde bei den
Wiederanläufen auf die neuen Rollen-IP-Adressen abgeglichen.

Der vollständige Produktionsnachweis bleibt offen: CPU-, strenge Echtzeit- und
öffentliche RTP-Teilprüfungen sind vorhanden, aber die Hetzner-Flotte wurde in
weiteren Läufen vorzeitig gelöscht. Weitere Vollstarts sind bis zur Klärung
pausiert. Der ausgewählte ausführende 4B-LLM wird deshalb separat auf einem
GitHub-Runner mit **genau einer GPU**, 50 echten Befehlen und anschließender
Löschung geprüft. Ein solcher Einzeltest ersetzt die gemeinsame Acht-Rollen-
Abnahme und den sichtbaren DAW-Ausführungsnachweis nicht.

## Aktuelles Testergebnis und nächste Abnahme

Lauf: https://github.com/kAInplanmusic/audioMONASTRY/actions/runs/43112085254

Alle acht Verträge wurden angelegt. Die gemeinsame Readiness wurde vor dem Zeitlimit nicht erreicht. Der Lauf endete mit `Readiness deadline exceeded`; Cleanup erfolgreich. Währenddessen wurden sechs Container als laufend beobachtet. Music blieb beim Image-Pull, bei Song wurde zeitweise ein Registry-Loginfehler gemeldet. Ein Containerstatus ist kein Beleg für geladene Modelle oder funktionierende Inferenz.

Die aktuelle Abnahmedefinition entfernt die zusätzlichen kleinen Smoke-Overrides für Inferenzschritte, Tokenzahl und Dauer. Sie verwendet die normalen Handler-Defaults, vollständige Modellgewichte und komplette Antworten. Dieser aktualisierte Abnahmelauf ist **noch nicht erfolgreich ausgeführt**. Der fehlgeschlagene Vorlauf wird nicht als Produktionsabnahme verkauft.

Eine automatische Freigabeprüfung hat den Abruf roher Containerlogs über Vasts Logdienst abgelehnt, weil dabei sensible Inhalte an den externen Logdienst übertragen werden könnten. Stattdessen wurden Status-/Modell-Endpunkte und Provider-Metadaten geprüft. Die exakte interne Ursache aller fehlgeschlagenen Readiness-Zustände ist damit nicht vollständig belegt.

## Quellen

- Vast-Preismodell: https://docs.vast.ai/guides/instances/pricing
- R2-Preise und Egress: https://developers.cloudflare.com/r2/pricing/
- GPU-Angebote und Ressourcenkosten: authentifizierte Provider-APIs, Beobachtung 11./12. November 2026.
