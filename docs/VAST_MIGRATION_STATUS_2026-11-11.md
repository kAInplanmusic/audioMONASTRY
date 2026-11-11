# Vast-Migration: Bau-, Prüf- und Übergabestand – 2026-11-11

Autorisierter Rahmen: acht GPU-Rollen, gleiche 22 ausgewählte Modell-IDs und gleiche Gewichte, maximal 8 EUR/h ohne Hetzner und Supabase. Ziel später 5–7,50 EUR/h. Ein gemeinsamer Test darf höchstens 28 Minuten laufen und muss seine eigenen Instanzen anschließend löschen.

## Nachgewiesen fertig

Sieben vollständige Rollen-Images sind erfolgreich gebaut, in GHCR veröffentlicht und per Digest festgeschrieben. Voice und Music teilen ein Image; dadurch sind alle acht Rollen abgedeckt. Erfolgreicher Imagebau einschließlich Offline-Import des Vast-Entrypoints und Abgleich der eingebetteten Modell-Repositories/Revisionen:

https://github.com/kAInplanmusic/audioMONASTRY/actions/runs/43102958171

Die Images übernehmen die bisherigen unveränderlichen Basisimages und enthalten den neuen TLS-Start und die überprüfte Cache-Wiederverwendung. Abhängigkeiten und Modellversionen werden dabei nicht durch neue Varianten ersetzt. Gewichte werden aus dem bestehenden R2-Spiegel beziehungsweise den bereits gepinnten Upstream-Repositories bezogen. Ein neuer Rechner braucht eine erste Kopie; ein erneutes manuelles Hochladen ist nicht vorgesehen.

| Rolle | Komprimiertes Image, GB dezimal |
|---|---:|
| Brain | 9,796 |
| Ears | 4,994 |
| Voice | 5,209 |
| Music | 5,209 |
| Studio | 10,943 |
| Audio-Brain | 4,800 |
| Song | 4,761 |
| Vis | 5,180 |

Digest-Zuordnung: `deploy/vast/images.json`; genaue Bytezahlen mit Digest-Bindung: `deploy/vast/image-sizes.json`. Größen wurden ohne Layer-Download aus den Registry-Manifests gelesen. Nachweis:

https://github.com/kAInplanmusic/audioMONASTRY/actions/runs/43105534024

## Aktive Konfiguration und Dateien

- `deploy/gpu-provider.json`: Vast, Hybrid-Regionen, 8-EUR-Grenze, 28 Minuten, Hetzner/Supabase ausdrücklich ausgenommen.
- `deploy/gpu/pod-fleet.json`: gemeinsame Modell-, Hardware- und Basisimage-Quelle. Die frühere kanonische Datei unter deploy/runpod wurde verschoben; es gibt keine zweite Modellliste.
- `.env.example`, Python-Dispatcher, Hauptstart/-teardown und aktive Shell-Start-/Stop-/Deploy-Einstiege verwenden Vast. Alte kostenpflichtige Runpod-CLIs sind durch eine explizite Provider-Auswahl geschützt. Historische Befunde und Kompatibilitätsimplementierungen bleiben als solche erhalten.
- Frühere Runpod-Build-/QA-Workflows verweisen auf die Vast-Workflows. Ein normaler Push startet keinen bezahlten GPU-Test.
- `gpuControl`, `podRouting`, `podStartTriggers`, `fleetAutostop` und LlmRouter verwenden die Vast-Adressen, Control-Plane und beobachteten Rollenpreise. Fehlende Vast-Konfiguration fällt nicht auf den alten Anbieter zurück. Allgemeine LLM-Aufrufe bleiben auf dem ausgewählten 27B-Brain; das 4B-Modell behält seinen eigenen GUI-Executor-Vertrag.
- `vast-pods.py` prüft Konto, Kosten, bestehende Instanzen, Image-Pins und Gewichtsbestand vor dem ersten Vertrag. Frische Angebote werden unmittelbar vor dem Kauf geprüft. Readiness verlangt alle acht Rollen und exakt passende geladene Modell-IDs, Repositories und Revisionen.
- HTTPS ist verpflichtend. Private TLS-Schlüssel und erzeugtes runtime.env bleiben im privaten Controller-State. Node nutzt ein CA-Bundle; TLS-Prüfung wird nicht abgeschaltet.
- `vast-promote-runtime.py` übernimmt geprüfte Runtime-Werte und das öffentliche CA-Bundle erst nach erfolgreichem Inventarabgleich. Es wurde keine Produktivadresse auf ungeprüfte Hosts umgebogen. hallerbans.de bleibt die Ziel-Domain; Betreiber-DNS wurde nicht verändert.
- Health-Guard und VRAM-/Inferenz-Collector unterstützen die acht Vast-Rollen. Der begrenzte QA-Lauf prüft Authentifizierung, Resident-Bestand und echte Inferenz aller 21 ausführbaren IDs; ACE Shared wird als Komponente geprüft. Chromium/NVENC auf dem tatsächlichen Vast-Host brauchen zusätzlich einen echten Renderbeleg.

## Tatsächlicher Provisionierungsversuch

Der erneute Vast-Abruf meldet inzwischen positives Guthaben. Der vorherige Null-Guthaben-Befund ist damit überholt. Es gab weiterhin keine bestehenden Instanzen.

Die authentifizierte Angebotsprüfung findet vollständige Acht-Rollen-Kombinationen. Der lokale Snapshot liegt bei 6,1124 EUR/h für die günstigste Zuordnung, 6,6492 EUR/h mit schnellem Executor/Song und 6,6784 EUR/h für die Variante mit niedrigen Transferpreisen. Arbeitsdisk, die dokumentierten Steuer-/Wechselkursannahmen und 0,40 EUR/h Reserve sind enthalten. Hetzner und Supabase sind ausgenommen. Das sind Angebote, keine Reservierungen; die Erstübertragung ist noch keine bestätigte Gesamtsumme unter 8 EUR/h.

Der CI-Provisionierungslauf hat Konto-, Angebots- und Image-Prüfungen bestanden und wurde vor einer Buchung abgebrochen. Cleanup erfolgreich, null laufende eigene Instanzen:

https://github.com/kAInplanmusic/audioMONASTRY/actions/runs/43105972619

Beim erneuten R2-Abruf liefern die vorhandenen S3-Zugangsdaten aktuell HTTP 403 `SignatureDoesNotMatch`. Dies wurde mit Header-Signatur, Presigned-GET und unabhängig mit boto3 reproduziert. Deshalb ist weder die erneute Gewichtsprüfung noch die vollständige Cold-Start-Kostenschätzung abgeschlossen. Kein R2-Objekt wurde verändert oder gelöscht.

`VAST_COLD_START_MAX_EUR=-1` bleibt bei den diagnostischen CI-Läufen absichtlich gesperrt: Ohne verifizierte Obergrenze der ersten Image-/Checkpoint-Übertragung wird keine GPU gebucht. Ein späterer bezahlter Lauf braucht die belegte Summe und einen Gesamtpreis unter 8 EUR/h; kein pauschales Nullsetzen.

## Gewichtsidentität

`model_manifest.json` enthält ausschließlich aktualisierte erklärende Pfadverweise auf deploy/gpu statt deploy/runpod; alle Modellobjekte und Gewichts-Komponenten sind gegenüber dem Stand vor der Provider-Umstellung identisch. `weight_assets.lock.json` ist bytegleich. Aktuelle SHA256:

- Modellmanifest: `89db46eab67281067c3567114ecd2071a471f9fccfc0e43ebaae76475e2adc75`
- Asset-Lock: `28d7323f4e67b8e7e69587887a22c77adb6e9ba355a82947b113a0620e41588e`

Der lokale Cache wird anhand tatsächlicher SHA256-Prüfungen wiederverwendet, einschließlich Extraktionsbelegen für TAR-Dateien. Nach Löschen einer Vast-Instanz ist deren lokale Kopie weg; R2 bleibt erhalten. Stoppen erhält die Disk und verursacht weitere Disk-Kosten. QA löscht ihre Verträge, um diesen Nachlauf zu vermeiden.

## Verifikation und offene Nachweise

Typecheck und ESLint bestanden. Gezielte Vast-/Routing-/Start-/Autostop-/Inventarprüfungen sowie Python-Migrations-/Planerprüfungen bestanden. Der komplette TypeScript-Testbestand ist noch nicht grün; verbliebene Fehler betreffen insbesondere alte Modell-/Rollenannahmen, Budgeterwartungen, Dokumentverweise und Audit-Umgebung. Letzter vollständiger TypeScript-Lauf: 3.771 bestanden, 36 fehlgeschlagen in 13 Dateien; 33 gezielte Vast-Prüfungen in fünf Dateien bestanden. Python: acht Migrations- und acht Planerprüfungen bestanden. Kein vollständiger Verify-Erfolg wird behauptet.

Offen bleiben: funktionierender aktueller R2-Abruf, vollständige Cold-Start-Kostenobergrenze, tatsächliche Miete und gemeinsamer Acht-Rollen-Inferenzlauf mit Cleanup, Vis-Renderprobe, anschließend Übernahme der geprüften privaten Runtime-Konfiguration auf den Orchestrator. Es existieren noch keine neuen Vast-Host-Adressen, die seriös in Produktionsdateien eingetragen werden könnten.

## Abschließender CI-Nachweis

https://github.com/kAInplanmusic/audioMONASTRY/actions/runs/43106374620

Der erneute diagnostische Lauf bestätigt `failureCode=R2_AUTH_REJECTED`, `cleanupPassed=true`, keine gestarteten Rollen und null gebuchte Instanzen. Seine frische Angebotszuordnung lag bei 6,2045 EUR/h inklusive der beschriebenen Disk-/Steuer-/Wechselkursannahmen und Reserve. Positives Vast-Guthaben wurde erneut bestätigt. Die Registry-Zugangsdaten in GitHub funktionieren; die auch aus der aktuellen gespeicherten Token-Datei gegengeprüften R2-Zugangsdaten sind derzeit der konkret belegte Blocker. Keine echte Vast-GPU-Inferenz und kein Vis-Renderlauf wurden ausgeführt.
