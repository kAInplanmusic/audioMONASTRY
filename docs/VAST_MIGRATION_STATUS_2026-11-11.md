# Vast-Migration: Stand und Übergabe – 2026-11-11

Die aktuelle Autorisierung lautet: acht GPU-Rollen auf Vast, unveränderte ausgewählte Modelle/Gewichte, maximal 8 EUR/h ohne Hetzner und Supabase. Die Kosten für Arbeitsplatten und Vast-Datenverkehr werden im GPU-Budget berücksichtigt. Die alten 11 EUR/h sind im aktiven Budget auf 8 gesenkt. Betriebsziel 5–7,50 EUR/h bleibt erhalten.

## Tatsächlicher Live-Befund

Der neue Vast-Key wurde erfolgreich authentifiziert und serverseitig als GitHub-Secret VAST_API_KEY hinterlegt. Das Konto meldet 0 USD Balance und 0 USD Credit; keine bestehenden Instanzen. Keine Guthabenaufladung, keine Buchung und keine R2-Schreiboperation wurden ausgeführt.

Die neue authentifizierte Hybrid-Suche findet acht passende Rollen. Die Variante mit niedrigeren Transferpreisen liegt bei 6,6665 EUR/h einschließlich Arbeitsdisk, bisheriger Steuer-/Wechselkursannahme und 0,40 EUR/h Reserve. Hetzner und Supabase sind nach der letzten Klarstellung ausdrücklich ausgenommen. Dies ist ein Angebots-/Kostenbefund und kein erfolgreicher GPU-Start. Die erste Übertragung von Docker-Layern und Checkpoints ist zusätzlich zu prüfen; der Startadapter blockiert ohne bezifferte Cold-Start-Schätzung und wenn diese den zeitlich begrenzten Test über 8 EUR/h hebt.

## Implementiert

- deploy/gpu-provider.json wählt Vast mit Hybrid-Regionen und 8-EUR-Grenze. Die physische Modell-/Basisimage-Zuordnung bleibt in deploy/runpod/pod-fleet.json, damit keine zweite Modellquelle entsteht.
- scripts/gpu-pods.py dispatcht den Python-Flottenstart/-stop an Vast. Der Hauptstart meldet einen fehlgeschlagenen GPU-Start nicht mehr als bereit.
- scripts/vast-pods.py prüft Konto, vollständige Zuordnung, frisch verfügbare Angebote, Preise, vorhandene R2-Gewichte und gepinnte Vast-Image-Digests. Keine Miete bei leerem Guthaben. Rollback und unabhängige Bereinigung nutzen nur eindeutig zugeordnete eigene Instanzen. Die neue v1-Listen-API wird mit after_token paginiert.
- Der Server kann über AI_GPU_PROVIDER=vast die unveränderten /ready, /models und /infer-Verträge verwenden. Vast-Adressen müssen HTTPS sein; fehlende Vast-Konfiguration fällt nicht heimlich auf Runpod zurück. Start/Stop, Adoption und Session-Teardown haben Vast-Control-Plane-Pfade. Kosten brauchen beobachtete Vast-Rollenpreise, keine erfundenen Ersatzwerte.
- Die neuen Images sind kleine TLS-Hüllen um die bisherigen unveränderlichen Rollen-Digests. Keine Neuinstallation oder Änderung der Modellabhängigkeiten. Voice und Music benutzen weiterhin dasselbe Basisimage und denselben neuen Digest.
- TLS-Schlüssel, Host-Adressen und generierte Runtime-Umgebung bleiben im privaten State-Verzeichnis. Der Node-Orchestrator benötigt das erzeugte CA-Bundle über NODE_EXTRA_CA_CERTS; TLS-Prüfung wird nicht abgeschaltet.
- scripts/vast-http-fleet-qa.py und der manuelle Workflow vast-http-fleet-qa prüfen acht gleichzeitig bereitstehende Rollen, falsche Authentifizierung, den vollständigen residenten Bestand und echte Inferenz aller ausführbaren Modell-IDs. ACE Shared wird als Komponente geprüft. Audios werden auf gültige endliche Samples geprüft. Testlauf maximal 28 Minuten mit unabhängigem Cleanup-Schritt; keine automatische kostenpflichtige Ausführung durch einen Push.

## Gewichte und Cache

model_manifest.json und weight_assets.lock.json sind bytegleich zum vorherigen Stand. Modell-IDs, Revisionen, Dateien und SHA-Pins werden nicht ersetzt. R2 bleibt bestehen; es gab keinen erneuten Upload und keine Löschung.

Neue Vast-Rechner können keinen Arbeitsspeicher oder lokalen Cache eines anderen Anbieters übernehmen. Ihre erste Kopie ist erforderlich. Der vorhandene R2-Spiegel und unveränderte gepinnte Upstream-Quellen werden dafür wiederverwendet. HF_HOME und temporäre Gewichte liegen im Vast-Profil unter /data. Bereits vorhandene Einzeldateien werden anhand ihres SHA256 wiederverwendet. TAR-Dateien erhalten nach geprüfter Extraktion eine an den Archiv-Pin gebundene Hash-Liste; auch hier werden beim Neustart die tatsächlichen Bytes geprüft und erneute Downloads vermieden. Beschädigte Dateien gelten nie als Cache-Hit.

Das hilft bei Neustarts auf derselben erhaltenen Disk. Nach vollständigem Löschen einer Instanz geht deren lokaler Cache verloren; R2 bleibt davon unberührt. Ein bloßes Stoppen behält die Disk, deren Speicherentgelt aber weiterläuft. Der QA-Cleanup löscht seine Instanzen, damit keine unbeabsichtigten laufenden Kosten entstehen.

## Noch nicht als erledigt behauptet

1. Kein gemieteter Vast-Start und kein Vast-Inferenzbeleg: Kontoguthaben ist null.
2. Der CPU-Imagebau wird per vast-fleet-images gestartet; sein abschließendes Ergebnis ist separat zu verifizieren. Aktueller CPU-Build: https://github.com/kAInplanmusic/audioMONASTRY/actions/runs/43097719331 (zuletzt queued, noch kein Image-Baunachweis).
3. Vor einer bezahlten QA sind die komprimierten Image-Layer, tatsächlich benötigten R2-/Upstream-Dateien und Host-Transferpreise zu einer Cold-Start-Obergrenze zusammenzuführen. VAST_COLD_START_MAX_EUR darf nicht ohne diesen Nachweis gesetzt werden.
4. Nach erfolgreicher QA müssen das private Runtime-Env und das CA-Bundle auf den Hetzner-Orchestrator übernommen und dessen Node-Prozess neu gestartet werden. scripts/vast-promote-runtime.py prüft alle acht TLS-Readiness-Endpunkte erneut, ergänzt eine vorhandene vollständige App-Env atomar und legt nur das öffentliche CA-Bundle im Compose-Mount vast-ca/ ab. Beispiel auf dem Orchestrator: python scripts/vast-promote-runtime.py --state-dir /data/vast-fleet --app-env /opt/audiomonastry/.env --ca-dir /opt/audiomonastry/vast-ca. Danach Node/Compose neu starten. Es wurde kein aktiver Server neu deployt und keine Produktionsadresse auf ungeprüfte Instanzen umgebogen. Alte zusätzliche Shell-Runbooks, die runpod-pods.py direkt aufrufen, sind explizite Legacy-Pfade und keine neuen Vast-Startwege; für Vast scripts/gpu-pods.py verwenden.
5. Die hallerbans.de-DNS-Umstellung bleibt beim Betreiber. Keine DNS-Änderung in dieser Migration.
6. Chromium/NVENC müssen nach Buchung auf dem tatsächlichen neuen Host nochmals überprüft werden; der API-Test allein belegt den Videoexport nicht.

## Bedienung nach Guthaben und Imagebau

```bash
# Servergeheimnisse aus der bestehenden privaten Umgebung laden, nicht ins Repo schreiben.
python scripts/gpu-pods.py preflight
# Das Image-Artefakt vast-images.json aus dem erfolgreichen Image-Workflow privat ablegen.
# Bezahlte QA über vast-http-fleet-qa mit verifizierter Transferobergrenze ausführen.
# Erst nach erfolgreicher QA Runtime-Env/CA auf den Orchestrator übernehmen.
```

Die Controller-State-Dateien dürfen weder in Git noch in öffentliche CI-Artefakte gelangen. Der Image-Workflow veröffentlicht nur Digest-Zuordnungen, der QA-Workflow nur das bereinigte Testergebnis.

## Lokale Validierung

32 TypeScript-Prüfungen in fünf betroffenen Dateien, Typecheck und ESLint bestanden. Python: acht neue Migration-/Cache-/Promotionsprüfungen, acht Angebotsplanerprüfungen, sieben SSOT-Prüfungen, 19 R2-/Budgetprüfungen, elf Gewichtsbereitstellungsprüfungen und vier Startup-Verzeichnisprüfungen bestanden. YAML und Python-Syntax geprüft. Dies ersetzt keinen echten Vast-GPU-Lauf.
