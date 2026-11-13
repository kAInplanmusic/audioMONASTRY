# A1 – Inventur und Belegbereinigung

Status: **Schema-DoD erfüllt; Produktionsinventur blockiert.** Keine aktuelle
Produktions-GPU-Anzahl ist verifiziert. Eine fehlende Provider-Antwort ist kein
Nachweis für null Server oder null GPUs.

Basis: `5193d9e33142c00edd67712fc2f605a722e66db7`, Branch `fix/a1-inventory`.
Messzeitpunkte mit UTC-Zeitzone stehen pro Probe in `EVIDENCE_REGISTRY.json`.

## Befunde und Zugangsgrenzen

| Host | Rolle | Container | GPU |
|---|---|---|---|
| Codex Cloud (diese Ausführungsumgebung) | Prüfwerkzeug, kein Produktionsknoten | `docker ps --format '{{json .}}'`: exit 0, leere Ausgabe | nicht geprüft |
| `audiomonastry-app-1` | dokumentierte App-Rolle | unbekannt, kein verifizierter Hostzugang | unbekannt |
| `audiomonastry-sfu-1` | dokumentierte SFU-Rolle | unbekannt, kein verifizierter Hostzugang | unbekannt |
| `audiomonastry-media-1` | dokumentierte Medien-Rolle | unbekannt, kein verifizierter Hostzugang | unbekannt |
| `audiomonastry-edge-1` | dokumentierte Monitoring-Rolle | unbekannt, kein verifizierter Hostzugang | unbekannt |
| GPU-Providerbestand | unbekannt | unbekannt | **unbekannt** |

Die vier Produktionsnamen/Rollen sind ausschließlich Dokumentation
(`docs/SERVER_FLEET.md:25`–`30`), kein Live-Bestand. Ihre Adressen werden nicht
aus veralteten Dokumenten übernommen. Die Namensauflösung aus einer aktuellen
Serverliste ist im Code vorgesehen (`scripts/lib/fleetnodes.py:32`, `:48`).
Da diese Liste fehlt, wurden keine vermuteten Produktionshosts per SSH kontaktiert.

Originalbelege (jeweils vollständiger Befehl, Ausgabe, Datum, Quelle im Registry):

- `A1-access-preflight`: `HCLOUD_TOKEN`, `HETZNER_API_TOKEN`, `RUNPOD_API_KEY`
  und `VAST_API_KEY` sind nicht gesetzt; das SSH-Konfigurationsverzeichnis fehlt.
- `A1-provider-hetzner`: `BLOCKED: HCLOUD_TOKEN missing; provider GET not executed`.
- `A1-provider-runpod`: `BLOCKED: RUNPOD_API_KEY missing; provider GET not executed`.
- `A1-prain-access`: `pwd` über PRAIN-DEV endet mit `Mcp error: -32603: Internal error`.
- `A1-docker-ps-local`: nur lokale Docker-Sicht, leere stdout bei exit 0.
- `A1-dig-availability`: `bash: line 1: dig: command not found`, exit 127.

Die Provider-Kommandos dokumentieren den tatsächlich ausgeführten Credential-Gate;
eine authentifizierte Server-/Podliste wurde ausdrücklich **nicht** abgerufen.
Produktions-`docker ps`, echte Hetzner-/RunPod-Listen und GPU-Zählung bleiben offen.

Der vorgesehene Installer `/usr/local/bin/cloud-agent-packages` fehlt ebenfalls
(`A1-package-helper`: `ls` exit 2, `No such file or directory`). Deshalb bleibt
der verlangte `dig`-Nachweis offen.

## DNS

55 Domainkandidaten aus `README.md`, `AGENTS.md` und Textdateien unter `docs/`
wurden mit `socket.getaddrinfo(..., type=socket.SOCK_STREAM)` als Ersatz für das
fehlende `dig` abgefragt. Jeder Eintrag `A1-dns-<domain>` enthält den exakt
wiederholbaren Python-Befehl, die unveränderte JSON-Ausgabe und die erste
Fundstelle der Domain. Der Scope umfasst ausdrücklich auch fremde Dienst-Domains
und dokumentierte Platzhalter. Er ist keine Liste verwalteter Infrastruktur.
Die Extraktion berücksichtigte die in den Texten gefundenen Suffixe
`de/com/net/org/io/ai/cloud/dev/app/co/eu/uk/xyz/tech/me/tv`.
Die syntaktischen Fehlkandidaten `40gmail.com`, `docker-compose.ai`, `labels.app`
wurden vor DNS-Abfragen ausgeschlossen. Damit ist keine Vollständigkeit für
andere TLDs oder dynamisch zusammengesetzte Domains behauptet.

DNS-Antworten beweisen Erreichbarkeit im Resolver, keine Container, Rollen oder
Besitzverhältnisse. Die Rohbelege enthalten alte Projektdomains aus der Basis
unverändert. Ihr Ersetzen würde historische Originalausgaben verfälschen und
steht deshalb mit A2s globalem Null-Treffer-Grep in Konflikt.

## Registry-Bereinigung und DoD

Alle 24 alten `sources`-Einträge wurden entfernt: keiner enthielt zugleich
`command`, `output` und `date`. Die alten Metadaten und die auf entfernte IDs
verweisenden `evidenceByFinding`-Verknüpfungen werden nicht als Belege fortgeführt.
Kein alter Eintrag wurde durch nachträglich erfundene Messdaten repariert.
Das Registry ist jetzt ein flaches Array ausschließlich mit den sieben
angeforderten Feldern. Ein Prüfer verwirft fehlende/zusätzliche Felder, leere
Werte, IDs ohne Eindeutigkeit sowie Datumswerte ohne Zeitzone.

Reproduktion der Schema-DoD:

```text
$ python3 scripts/audit/check-evidence-registry.py
PASS: 63 entries; exact schema, nonempty command/output/date, timezone, unique IDs
```

Die einzelnen Proben lassen sich über ihre `command`-Felder erneut ausführen;
Providerzugang und Produktionshosts müssen dafür erst bereitstehen. Es wurden
keine Container oder Provider-Ressourcen gestartet, gestoppt oder geändert.

Außerhalb A1: `docs/SERVER_FLEET.md:1`, `:10`, `:40` enthalten unterschiedliche
historische Flottenaussagen; A2 muss sie gegenüber dem unbekannten Live-Bestand
einordnen. Diese Aussagen sind kein Ersatz für fehlende Messungen.

## Weitere Prüfung

`git diff --check` endete mit exit 0 ohne Ausgabe. `npm run verify` wurde
ausgeführt, endet aber in `typecheck` mit exit 127: `sh: 1: tsc: not found`.
Abhängigkeiten sind in diesem Worktree nicht installiert; die vollständige
Verify-Kette ist hier deshalb nicht als bestanden ausgewiesen.
