# Vast.ai: Acht-Rollen-Preflight und Testvorbereitung – 2026-11-11

> A2 (2026-11-13): Domainnamen in diesem historischen Dokument wurden redaktionell auf `hallerbans.de` migriert. Enthaltene alte Befehlsausgaben sind dadurch keine unveränderten Originalbelege; Originale stehen in der Git-Historie. Aktueller Infrastrukturstatus: `docs/INFRA_INVENTORY_STATUS.md`.


## Ehrlicher Status

Live-Angebote wurden über die offizielle Such-API tatsächlich abgefragt. Es wurden **keine Vast-Instanzen gemietet und keine Vast-Inferenzen ausgeführt**. Ein Vast-API-Key ist weder in der aktuellen Umgebung noch in den vorhandenen Provider-Zugangsdaten hinterlegt. Runpod-Schlüssel authentifizieren kein Vast-Konto. Der bestehende Runpod-Test 43082112869 ist abgeschlossen: kein passendes Brain-Angebot innerhalb der Vorgaben, keine gestarteten Rollen, Cleanup erfolgreich.

## Ergebnisse der Angebotsprüfung

| Variante | €/h inkl. Disk, Steuerannahme und Reserve | Bewertung |
|---|---:|---|
| Weltweit, minimale Angebotskosten | 5.76 | Für Live-Routing wegen Kontinentverteilung nicht empfohlen |
| Europa, minimale Angebotskosten | 7.24 | RTX 3090 für Executor/Song; noch kein Laufzeitbeleg |
| Europa, RTX 4090 für Executor/Song | 7.58 | Meine bevorzugte Ausgangskombination für den Vergleichstest |
| Europa, zusätzlich Transferpreise ≤ 0,005 USD/GB je Richtung | 9.51 | Alternative für häufige Cold Starts; teils größere GPUs |

Berechnung: USD/h × 0,92 × 1,19 + 0,40 EUR/h Reserve. Die Faktoren sind unsere Planungsannahmen, kein verifizierter Wechselkurs und keine Steuerrechnung. Der variable Datenverkehr ist nicht pauschal enthalten. Die Reserve garantiert nicht, dass Transfers gedeckt sind. Preise sind Momentaufnahmen, keine Reservierungen. Die Zuordnung ist kostenminimal unter den abgerufenen, zugelassenen Angeboten und der konservativen Vorgabe acht unterschiedlicher physischer Hosts. Sie beweist keine gleichzeitig buchbare Kapazität und keine minimale Inferenzlatenz. Es werden On-demand-Angebote geprüft, keine unterbrechbaren Spot-Preise.

## Bevorzugte Hardware-Zuordnung für den Europa-Test

| Rolle | Modelle | GPU | nutzbarer VRAM / zugeteilter RAM (GiB) | Standort | €/h inkl. Disk und Steuerannahme |
|---|---|---|---|---|---:|
| brain | qwen38-27b-fp8 | RTX 6000Ada | 47.99 / 83.92 | Estonia, EE | 0.828 |
| ears | moss-music-8b-instruct, clap-music, beat-this, songformer, dsp-analysis, basic-pitch | A40 | 44.99 / 500.96 | Belgium, BE | 0.828 |
| voice | qwen3-tts-17b, qwen3-tts-voicedesign, moss-soundeffect-v2.0, acestep-v15-xl-base, acestep-v15-shared | RTX PRO 5000 | 47.79 / 125.88 | Czechia, CZ | 1.168 |
| music | acestep-v15-xl-turbo, acestep-5hz-lm-4b, acestep-v15-shared | A40 | 47.99 / 500.96 | Belgium, BE | 0.850 |
| studio | sonicmaster, bs-roformer-sw-6stem, mvsep-mega-53, mel-roformer-bve | RTX PRO 6000 S | 95.59 / 124.77 | Spain, ES | 1.755 |
| audio-brain | qwen3-4b | RTX 4090 | 23.99 / 37.71 | Poland, PL | 0.464 |
| song | yue2-3b | RTX 4090 | 23.99 / 62.89 | Sweden, SE | 0.504 |
| vis | universr, mel-roformer-dereverb | RTX 6000Ada | 47.99 / 62.96 | Germany, DE | 0.785 |

GPU/Disk-Summe vor Reserve: 7.181 EUR/h. Reserve 0,40 EUR/h. Gesamt 7.581 EUR/h.

Brain braucht native FP8-Unterstützung und den CUDA-13-Treiberpfad. A40/A6000 werden dafür nicht freigegeben. Ears/Voice/Music können mit ihren bestehenden Images günstigere Ampere-Karten verwenden. Studio braucht mit den unveränderten Reserven 69 GiB und damit die 80/96-GB-Klasse. Executor und YuE2 erhalten bevorzugt 4090 für den anschließenden Geschwindigkeitsvergleich. Vis benötigt NVENC; das vorhandene Vis-Image unterstützt noch kein sm_120, deshalb werden dort auch RTX 5090 und andere Blackwell-Karten ausgeschlossen. Ada bleibt für den ersten Vast-Test der kompatible Ausgangspunkt. Eine endgültig beste Karte lässt sich erst nach gemessener Inferenz, VRAM-Spitzen und Netzwerklatenz bestimmen.

## Geprüfte Grenzen und Alternativen

Jede Rolle übernimmt Modell-IDs, gepinnte Image-Digests, CPU-RAM, CUDA-Minimum und Disk aus deploy/gpu/pod-fleet.json und dem Modellmanifest. Modellreserven werden beim Providerwechsel nicht verkleinert. Es werden genau eine GPU pro Rolle, verifizierte Hosts, ein Zuverlässigkeitswert von mindestens 0,99, mindestens vier effektive vCPUs und mindestens ein direkter Port verlangt. Der Zuverlässigkeitswert ist eine Anbieterkennzahl, kein gemessener SLA-Beleg. Unbekannte GPU-Namen werden verworfen. Ein Angebot darf inklusive Disk und Steuerannahme höchstens 2 EUR/h kosten.

| Rolle | VRAM-Untergrenze inkl. Reserven (GiB) | RAM-Untergrenze (GiB) | Europa-Kandidaten | verfügbare zugelassene GPU-Familien im Abruf |
|---|---:|---:|---:|---|
| brain | 47 | 64 | 6 | RTX 6000Ada, RTX PRO 5000, RTX PRO 6000 S, RTX PRO 6000 WS |
| ears | 42 | 80 | 6 | A40, RTX 6000Ada, RTX PRO 5000, RTX PRO 6000 S, RTX PRO 6000 WS |
| voice | 45 | 64 | 6 | A40, RTX 6000Ada, RTX PRO 5000, RTX PRO 6000 S, RTX PRO 6000 WS |
| music | 33 | 64 | 7 | A40, RTX 6000Ada, RTX PRO 5000, RTX PRO 6000 S, RTX PRO 6000 WS |
| studio | 69 | 88 | 2 | RTX PRO 6000 S, RTX PRO 6000 WS |
| audio-brain | 19 | 32 | 48 | A100 PCIE, A40, RTX 3090, RTX 4090, RTX 5090, RTX 6000Ada, RTX A5000, RTX A6000, RTX PRO 5000 |
| song | 23 | 40 | 51 | A100 PCIE, A40, RTX 3090, RTX 4090, RTX 5090, RTX 6000Ada, RTX A5000, RTX PRO 5000 |
| vis | 27 | 32 | 4 | A40, RTX 6000Ada |

Alle Angebote mit Offer-ID, Host-ID, GPU, zugesichertem RAM, CUDA, Preis und Transferkosten stehen in den beiden JSON-Dateien. Die Host-Zuordnung verhindert, dass dasselbe Angebot mehrfach als acht unabhängige Karten gezählt wird. Mehrere nachweislich getrennte GPUs desselben Hosts könnten später zusätzliche günstigere Kombinationen ermöglichen; dieser Preflight rechnet konservativ mit verschiedenen Hosts.

## Datenverkehr vor einer Buchung prüfen

Vast berechnet Datenverkehr zusätzlich. Beispiel: Beim Brain-Angebot in Estland sind 0,0390625 USD/GB angegeben. 100 GB eingehende Daten kosten damit 3,90625 USD zusätzlich, mit unseren Faktoren etwa 4,28 EUR. Das ist ein Rechenbeispiel, keine gemessene Downloadmenge. Auch Docker-Layer zählen zum Cold Start. Die günstigere Stundenrate allein reicht daher nicht zur Freigabe eines 28-Minuten-Tests. Zuerst müssen Image-Transfer, R2/Upstream-Gewichte, mögliche Host-Caches und verfügbare Kontoguthaben bewertet werden. Das Gesamtlimit 11 EUR/h gilt weiterhin; andere laufende Runpod/Vast-Ressourcen müssen in den gemeinsamen Rahmen eingerechnet werden. Kein automatisches Aufladen.

## Nächster tatsächlicher Miet- und Inferenztest

1. Vast-API-Zugang und Kontoguthaben prüfen. Vorhandene private GHCR-Images müssen mit dem vorhandenen CI-Registry-Zugang auf Vast tatsächlich abrufbar sein; die Runpod-Registry-ID ist nicht übertragbar. Dieser Pull-Nachweis steht noch aus.
2. Angebote unmittelbar vor Buchung neu abfragen. Budget einschließlich Bestandsressourcen und erwarteter Cold-Start-Transfers prüfen. Keine Buchung allein aufgrund dieses gespeicherten Snapshots.
3. Vast-Provisionierungsadapter mit Entrypoint-Modus, den acht unveränderten gepinnten Images und dem bestehenden pod_start.py-Vertrag verbinden. Der Adapter für bezahlte Vast-Tests ist noch nicht implementiert. Der neue Angebotsplaner mietet ausdrücklich keine Instanzen.
4. R2-Zugangsdaten beim Orchestrator lassen; nur kurzlebige Datei-URLs an die Instanzen geben. Die bestehende Startup-Hashprüfung und der explizite Modellbestand bleiben aktiv. Externe Ports sind dynamisch; API-Zugriff über TLS oder SSH-Tunnel bereitstellen, bevor Bearer-Token übertragen werden.
5. Bei acht gleichzeitig bereiten Rollen Authentifizierung, vollständigen Modellbestand, echte Inferenz für alle ausführbaren ausgewählten Modell-IDs und den Shared-Komponentenbestand prüfen. Vis zusätzlich Chromium-Render und NVENC-Export. Audio auf gültige, endliche Samples und sinnvolle Ausgabe prüfen; Laufzeiten und Spitzen-VRAM protokollieren. Kontinent- und Europavergleich ersetzen keine gemessene Netzwerklatenz zum Hetzner-Orchestrator.
6. Test maximal 28 Minuten ab erster kostenpflichtiger Buchung. Unabhängigen Cleanup-Wächter einrichten, neu erzeugte Testinstanzen am Ende zerstören und Löschung bestätigen. Stoppen allein beendet die Disk-Abrechnung nicht. Es gibt derzeit keinen solchen aktiven Vast-Test und keinen aktiven Vast-Cleanup-Job.

## Reproduzieren

```bash
python scripts/vast-fleet-plan.py --region europe --output /tmp/vast-europe.json
python scripts/vast-fleet-plan.py --region global --output /tmp/vast-global.json
python -m unittest discover -s tests -p test_vast_fleet_plan.py -v
```

Der Planer ist rein lesend. VAST_API_KEY wird optional aus der Umgebung verwendet und nicht gespeichert oder ausgegeben. Die öffentliche Angebotsabfrage funktionierte in dieser Sitzung ohne Key; daraus folgt keine Berechtigung zum Mieten.

## Quellen

- https://vast.ai/pricing
- https://docs.vast.ai/llms.txt
- https://docs.vast.ai/api-reference/search/search-offers
- https://docs.vast.ai/api-reference/instances/create-instance
- https://docs.vast.ai/cli/reference/create-instance
- https://docs.vast.ai/guides/instances/docker-environment
- https://docs.vast.ai/guides/instances/pricing

## Validierung

Acht gezielte Python-Regressionsprüfungen bestanden: Ressourcen aus dem bestehenden Manifest, zugeteilter statt Host-RAM, kein doppelter Disk-Aufschlag, harte Preisgrenze und unbekannte Karten, Vis/Blackwell-Sperre, Brain/FP8-Sperre, vollständige Zuordnung trotz Host-Konflikten sowie Europa-Filter mit unveränderten Ressourcenlimits. Typecheck und ESLint liefen im zusätzlich angestoßenen npm run verify durch. Der globale Testlauf zeigte danach mehrere Fehler unter anderem in aiInfrastructure, fleetWake, aiControl und da017LlmJsonGuard sowie EPERM bei lokalen tsx-Pipes. Diese Fehler wurden in dieser auf Angebotsplanung beschränkten Änderung nicht behoben. Die automatische Freigabeprüfung blockierte die weitere Ausführung wegen eines unerwarteten Kontakts zu hallerbans.de und ungeklärter ausgehender Daten. Kein vollständiges verify-Grün; die nachgelagerten Gates werden nicht als bestanden ausgegeben. Der neue rein lesende Vast-Planer hat seine acht gezielten Prüfungen bestanden. Kein Vast-Inferenzbeleg.
