# Reproduzierbarer Produktions-Deploy: vier CPU-Rollen und acht GPU-Rollen

Der Workflow stellt fehlende, eindeutig zugeordnete Hetzner-Rollen aus den neuesten
vorhandenen Rollen-Snapshots wieder her. Vorhandene Knoten und Daten bleiben erhalten.
Er gleicht die drei Produktions-DNS-Einträge ab, baut und prüft die CPU-Dienste,
misst das strenge Echtzeit-Gate auf dem App-Host und echte öffentliche SFU-RTP-
Übertragung zwischen Browsern und startet erst danach die
begrenzte Vast-Abnahme. Die Modell- und Gewichtsidentitäten bleiben unverändert.

## Start und Voraussetzungen

Benötigte GitHub-Actions-Secrets: `HETZNER_PRODUCTION_TOKEN`, `AUDIO_PROD_SSH_KEY`,
`AUDIO_PROD_PROVIDER_ENV`, `GHCR_USERNAME`, `GHCR_PASSWORD`, `CF_DNS_API_TOKEN`,
`VAST_API_KEY`, `AI_POD_TOKEN` und die vier `CFS3_*`-Bindings aus dem Workflow.
Werte gehören ausschließlich in die privaten Bindings. Der gepackte Provider-Block
enthält die bestehenden Produktionsbindungen für R2, Supabase und Studio-Zugang.
Quellcode-Download und GHCR-Package-Lesezugang besitzen getrennte Berechtigungen;
die dedizierte GHCR-Bindung muss alle acht Manifest-Digests lesen können.

Vor dem bezahlten Lauf einen erfolgreichen `vast-fleet-images`-Build ausführen.
Dieser übernimmt die unveränderten Basisimages und schreibt verifizierte Digests
und komprimierte Layer-Größen nach `deploy/vast/`. Danach den Branch aktualisieren.
Ein grüner Image-Build ist noch kein GPU-Inferenznachweis.

Solange der neue Hauptworkflow noch nicht auf `main` registriert ist, steht der
bereits registrierte Dispatcher zur Verfügung:

```sh
gh workflow run vast-http-fleet-qa.yml \
  --ref codex/full-production-deploy-20261112 \
  -f production_mode=full \
  -f image_run_id=ERFOLGREICHE_IMAGE_RUN_ID \
  -f cold_start_max_eur=-1
```

`full` liest die eingecheckte Digest-Liste des gewählten Commits. Die Image-Run-ID
ist für den Dispatcher erforderlich; beim direkten QA-Modus wird daraus das
verifizierte Artifact geladen. Nach Registrierung ist auch
`production-deploy.yml` mit `mode=full` verfügbar. Beide mutierenden Einstiege
verwenden dieselbe Concurrency-Gruppe. Statusabfragen bleiben unabhängig möglich.

## Tatsächliche Abnahmekriterien

- Alle vier CPU-Rollen: Dienste gestartet, passende Build-Identität, Cloud- und
  Idle-Prüfungen; öffentliche HTTPS-Prüfung für App und SFU.
- App: Master-Audio-Selbsttest, vier gleichzeitige Socket.IO-Nutzer, Abweisung
  eines fünften Nutzers, Uhr-Austausch und gemessene HTTP-Latenz.
- Echtzeit: derselbe RT-Benchmark im laufenden App-Container, mit explizit leerem
  `CI`. Ein großzügigeres CI-Profil ersetzt diesen Produktionsnachweis nicht.
- Mediennetz: zwei echte Chromium-Produzenten, zwei gekreuzte Konsumenten und
  ein Echo über den öffentlichen SFU. Empfangene RTP-Pakete und Audio-Bytes
  müssen positiv sein. Fake-Mikrofone liefern die Testquelle; CORS, Auth, TLS
  und der echte externe WebRTC-Transport bleiben aktiv.
- Acht GPU-Rollen auf acht getrennten Hosts: exakte residente Modell-IDs und
  Repository-/Revisionsidentitäten, Bearer-Auth und echte Inferenz für alle
  ausführbaren Modelle. Der gemeinsame ACE-Step-Eintrag ist eine Gewichtsquelle,
  kein separat ausführbarer Handler. Produktions-Defaults und komplette Antworten
  gelten ohne zusätzliche kurze Smoke-Parameter.
- Der ausführende `qwen3-4b` startet zuerst. Vor den weiteren sieben Buchungen
  müssen seine Modellidentität, Readiness und 50 echte Befehlsvorschläge mit dem
  produktiven DAW-Validator bestehen. Der CPU-Prüfer verwendet das vorhandene
  App-Image; er mietet keine weitere GPU und führt die Vorschläge nicht aus.
  Nach der Umschaltung wiederholt die Abnahme je einen Fall aller 20 Plugin-
  und Systemfamilien über `/api/ai/executor`. Der separate Modus `control`
  prüft anschließend den sichtbaren AUSFÜHREN-Knopf und die tatsächliche
  Tempoänderung im Audio-Engine-Zustand und stellt das Ausgangstempo wieder her.
- Vis: Chromium erzeugt einen PNG-Frame; `h264_nvenc` kodiert genau diesen Frame
  zu einem H.264-Video. `ffprobe` bestätigt Auflösung und 24 Frames. Der Befund
  enthält Hashes und Bytezahlen; ein bloßer Encoder-Listeneintrag genügt nicht.
- Normale und unabhängige GPU-Bereinigung bestätigt; die vorübergehend gesetzte
  App-Umgebung wird wiederhergestellt.

Der Kollaborations-Smoke allein belegt keinen mehrstündigen Browser-/RTP-Stresstest.
Die vollständige lokale `npm run verify`-Kette und der Live-RLS-Abgleich sind
zusätzliche Nachweise; Umfang und Skip-Bedingungen stehen in `docs/VERIFY_MATRIX.md`.

## Kostengrenze und Fehlerfall

Die aktive Vast-Flotte muss einschließlich Disk, dokumentierter Währungs- und
Steuerannahme, Reserve und konservativem Kaltstart unter 8 EUR in der ersten
Stunde bleiben. Hetzner und Supabase sind laut kanonischer Richtlinie ausgenommen.
Ein Durchlauf ist auf 28 Minuten begrenzt. Es gibt keine automatische Aufladung.
Ein Replan nach einem Fehler ist nur vor der allerersten bezahlten Buchung erlaubt.
Für eine noch ungemietete Rolle darf vor dem Kauf ein anderes verfügbares Angebot
gewählt werden; Identität, Ressourcen, getrennte Hosts und Gesamtbudget werden
erneut geprüft. Jeder Create-Fehler nach bezahlter Buchung bricht den Lauf ab.

Registry-, Image-Pull-, Disk- und terminale Readiness-Fehler brechen früh ab.
Für die zuerst gemietete Executor-Rolle gilt ein achtminütiges Start-Gate.
Bereits vor dem Kauf muss die Prognose für vollständige Images und Gewichte
unter sechs Minuten liegen; zwei Minuten bleiben für Prüfung und Modellladen.
Auch eine unmittelbar vor dem Kauf erneuerte Quote muss diese Grenze bestehen.
Gemeldete Bandbreite bleibt eine Prognose und ersetzt keine gemessene Readiness.
Der eigene Zustand enthält exakte Run-Labels und eine erhaltene Buchungshistorie.
Normale Bereinigung, ein unabhängiger Systemd-Timer und ein separater Actions-Job
sind drei begrenzte Wege zur Löschung derselben eigenen Ressourcen.

Eine vorhandene Run-Flotte ohne neue Buchung prüfen:

```sh
gh workflow run vast-http-fleet-qa.yml \
  --ref codex/full-production-deploy-20261112 \
  -f production_mode=none -f status_only=true \
  -f label_timestamp=URSPRUENGLICHE_RUN_ID \
  -f image_run_id=ERFOLGREICHE_IMAGE_RUN_ID -f cold_start_max_eur=-1
```

Für eine gezielte Notbereinigung denselben Aufruf um `-f cleanup_existing=true`
ergänzen. Ausschließlich die acht exakten Rollen-Labels dieser Run-ID sind
zulässig. Danach bestätigt eine erneute Provider-Auflistung null eigene Treffer.
Gestoppte Vast-Disks sind keine kostenlose Baseline; die QA löscht ihre Verträge.

## Nachweise und Betriebszustand

Der vollständige Lauf exportiert `production-evidence/summary.json` als
Actions-Artifact. Einzelberichte liegen zusätzlich unter
`deployment/runs/<run-id>/<attempt>/` im bestehenden R2-Bucket. Die Zusammenfassung
prüft den erwarteten Commit, führt fehlende Berichte auf und setzt
`allProductionGatesPassed` nur bei gemeinsamen CPU-, DNS-, RT-, GPU- und
Bereinigungsnachweisen. Controller-Zustand, Umgebungsdateien und Rohlogs werden
nicht als Artifact veröffentlicht.

Ein bestandener Abnahmelauf hinterlässt absichtlich keine acht kostenpflichtigen
GPU-Instanzen. Dies entspricht dem bestehenden On-Demand-Betrieb. Hetzner-Idle-
Regeln bleiben aktiv; Deployments halten zeitlich begrenzte sichtbare Wartungs-
Sitzungen und den bestehenden PID-Lock. Nach Ende der Wartung gilt wieder die
normale Idle-Policy. Statische DNS-Adressen allein ersetzen keinen späteren
Wake-/Wiring-Lauf, wenn Knoten nach Idle neu angelegt werden.

Nach 15 Minuten ohne Nutzung beginnt der vollständige Teardown: Vast-Verträge
werden gelöscht, Hetzner-Knoten nach verfügbarer Sicherung entfernt. Die
Snapshot-Dauer kommt zur Inaktivitätsfrist hinzu. App und Edge überwachen dies
alle 15 Sekunden; ein ausgeschalteter Hetzner-Server gilt weiterhin als bezahlt.
Die bestehende Aufbewahrung von zwei verfügbaren Snapshots je Betriebsrolle
gilt auch im CLI-Pfad, damit alte Sicherungen das Providerkontingent nicht
blockieren. Geschützte, unfertige und fremde Images werden nicht entfernt.
Snapshot-/R2-/Datenbank-Speicher ist von null laufenden Recheninstanzen getrennt
zu betrachten. GET-Statusabfragen zählen nicht als Nutzung; laufende Jobs zählen.

`idle-inspect` liest die tatsächliche Entscheidung und feste Diagnosefelder,
ohne Wartungs-Lock oder Nutzeraktivität zu erzeugen. Es ist kein Nachweis einer
erfolgten Löschung; dafür sind die Inventare beider Provider erforderlich.
