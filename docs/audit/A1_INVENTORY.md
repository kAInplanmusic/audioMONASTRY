# A1 – Live-Inventur, Runde 2

Stand: 2026-11-13 UTC. **Status: teilweise belegt, Produktionsinventur blockiert.**
Die aktuelle Produktions-GPU-Gesamtzahl ist **unbekannt**. Fehlender Zugang ist
kein Nachweis einer leeren Flotte. Laufende Instanzen, deren Kosten/h und
vergessene RunPod-Pods lassen sich daher nicht feststellen.

Alle nachstehenden Beleg-IDs stehen in `EVIDENCE_REGISTRY.json` mit exaktem
Befehl, Originalausgabe, ISO-Datum mit Zeitzone und Quelle. Historische Belege
bleiben historisch: Die ersten 63 Einträge und der Schema-Checker wurden aus
`e810771` unverändert übernommen; sie belegen keine aktuelle Produktion.
Ausgangsbasis dieser Inventur: `8a2f1f9ca57d3fe504484ace4f2c5d45a280c480`
(`R2-A1-BASE`).

## Zugriff und Host-Tabelle

`R2-A1-ACCESS` prüft ausschließlich die Präsenz der benannten Variablen:
`HCLOUD_TOKEN`, `HETZNER_TOKEN`, `VAST_API_KEY`, `RUNPOD_API_KEY` und
`SSH_AUTH_SOCK` sind jeweils `false`. Es wurden keine Credential-Dateien,
`.env`-Dateien oder geheimen Werte gelesen, gespeichert oder ausgegeben.
Der Cloud-Status (`R2-A1-TOOL-0`) meldet `secrets: []`, keine Identitäten,
aktuelle Beobachtungen und eine durchgesetzte unbeschränkte Netzwerkpolicy.
PRAIN-DEV wurde einmal erneut mit `pwd`, Verzeichnisliste und reinem
Boolean-ENV-Test geprüft: alle drei Aufrufe scheitern mit MCP `-32603`
(`R2-A1-TOOL-1` bis `R2-A1-TOOL-3`). Das ist kein Inventarbeleg dieses Systems.

| Host | Provider | Rolle | Container | GPU-Typ × Anzahl | Status |
| --- | --- | --- | --- | --- | --- |
| nicht ermittelt | Hetzner | unbekannt | unbekannt | unbekannt | Inventur gesperrt, `R2-A1-ACCESS`, `R2-A1-PROVIDER-SKIPS` |
| nicht ermittelt | Vast.ai | unbekannt | unbekannt | unbekannt | Inventur gesperrt, `R2-A1-ACCESS`, `R2-A1-PROVIDER-SKIPS` |
| nicht ermittelt | RunPod | unbekannt | unbekannt | unbekannt | mangels Token ausgelassen, `R2-A1-ACCESS`, `R2-A1-PROVIDER-SKIPS` |
| lokaler Audit-Executor | Codex Cloud | Arbeitsumgebung dieses Audits | `docker ps --format json`: leere Ausgabe | unbekannt | kein Produktionshost; `nvidia-smi` fehlt, `R2-A1-CLOUD-CONTAINERS`, `R2-A1-CLOUD-GPU` |

Die ersten drei Zeilen kennzeichnen fehlende Account-Inventare, keine
entdeckten Hosts. Es wurde ohne Token kein Provider-Request gesendet; ein
unauthentifiziertes HTTP-401 wäre ebenfalls kein Inventarbeleg. Ohne Agent
und authentifizierte Hostliste wurden keine Produktions-SSH-Verbindungen
versucht. Ein möglicher lokaler Alias `HETZNER_TOKEN` → `HCLOUD_TOKEN` hilft
hier nicht, weil beide fehlen. Die Tabelle enthält keine erfundenen Hosts,
Rollen, Container oder Kosten.

## DNS – getrennt von der Account-Inventur

Die Abfragen erfolgen mit echtem BIND `dig`, userlokal aus offiziellen
Debian-Snapshot-Paketen unter `/workspace/work/a1-dig/root` extrahiert.
`R2-A1-PACKAGES` dokumentiert Paketversionen und SHA-256;
`R2-A1-PACKAGE-SOURCES` die offiziellen Snapshot-URLs;
`R2-A1-DIG-VERSION` und `R2-A1-DIG-DEPS` belegen die ausführbare Binary
und ihre Bibliotheken. Es erfolgte keine Systempaket- oder DNS-Änderung.

Reproduzierbarer Aufruf, für `AAAA` und `CNAME` analog:

```sh
LD_LIBRARY_PATH=/workspace/work/a1-dig/root/usr/lib/x86_64-linux-gnu \
  /workspace/work/a1-dig/root/usr/bin/dig +time=2 +tries=1 +short A hallerbans.de
```

Der DNS-Scope ist ein konservatives Superset: alle zum Zeitpunkt der
Erhebung Git-getrackten decodierbaren Dateien unter `docs/`, zusätzlich alle
getrackten `.md`/`.rst`/`.txt`-Dokumente und Dateien mit `compose` im Namen.
Dateien mit `.env` im Namen sind ausgeschlossen. Der Beleg `R2-A1-DNS-SCOPE`
enthält das vollständige Dateimanifest und jeden Kandidaten mit allen
`Datei:Zeile`-Fundstellen. Der Extraktor in
`scripts/audit/inventory-dns.py` verwendet keine feste TLD-Liste. Er behält
auch Dateinamen und Codebezeichner mit Punkten bei; die Zahl der Kandidaten
ist daher ausdrücklich keine Zahl realer Domains oder Produktionshosts.
Es werden keine Aussagen über ungetrackte externe Dokumente oder erst nach
Beginn des Snapshots hinzugefügte Dateien gemacht.

Der Snapshot enthält **208 Textdateien, 2937 Kandidaten und 17622
Abfragen** (je Recordtyp kurze Ausgabe und gesonderter Statusheader).
Die Headerläufe liefern 5697 × NXDOMAIN, 2937 × NOTIMP und 173 × NOERROR.
Bei drei Kandidaten treten zusammen sieben Exitcode-9-Abfragen auf:
`R2-A1-DNS-0860` (`deploy.sh`), `R2-A1-DNS-1890` (`p.id`) und
`R2-A1-DNS-2673` (`tk.id`). Vier dieser fehlgeschlagenen Abfragen sind
Headerläufe; deshalb liegen für sie keine DNS-Statusheader vor.
Diese Supersetnamen sind keine behaupteten Produktionsendpunkte.

| DNS-Endpunkt | beobachtetes A | AAAA | CNAME | Beleg |
| --- | --- | --- | --- | --- |
| hallerbans.de | 104.21.78.253; 172.67.138.231 | 2606:4700:3034::ac43:8ae7; 2606:4700:3037::6815:4efd | unbekannt (NOTIMP) | R2-A1-DNS-1257 |
| www.hallerbans.de | 104.21.78.253; 172.67.138.231 | 2606:4700:3034::ac43:8ae7; 2606:4700:3037::6815:4efd | unbekannt (NOTIMP) | R2-A1-DNS-2919 |
| origin.hallerbans.de | 135.181.111.103 | Resolver: NXDOMAIN | unbekannt (NOTIMP) | R2-A1-DNS-1865 |
| sfu.hallerbans.de | 135.181.251.14 | Resolver: NXDOMAIN | unbekannt (NOTIMP) | R2-A1-DNS-2424 |
| master.hallerbans.de | 77.42.8.166 | Resolver: NXDOMAIN | unbekannt (NOTIMP) | R2-A1-DNS-1598 |

Jeder Kandidat wurde per `dig +short` für A, AAAA und CNAME abgefragt.
Zusätzliche `+noall +comments`-Abfragen bewahren die DNS-Statusheader, da
leere `+short`-Ausgaben weder NXDOMAIN noch fehlende CNAME beweisen.
Die Einzelbelege enthalten Exitcodes, stdout und stderr unverändert.

Der Standardresolver meldet für CNAME **NOTIMP**. Der gezielte Retry
`+noedns` bleibt NOTIMP (`R2-A1-CNAME-NOEDNS`). TCP zum Standardresolver
und die gezielte echte `dig @1.1.1.1`-Abfrage scheitern jeweils mit
`connection refused`, Exitcode 9 (`R2-A1-CNAME-TCP`,
`R2-A1-CNAME-PUBLIC`). CNAME ist damit **unbekannt**, nicht „kein Record“.
A/AAAA-NXDOMAIN sind Antworten dieses Resolvers auf den jeweiligen
Recordtyp, kein Account- oder Erreichbarkeitsbeweis. Timeouts werden ebenfalls
als unbekannt behandelt. Es kam keine andere Resolver-Software zum Einsatz.

DNS-Adressen belegen keine Eigentümerschaft, Provider-Zuordnung, laufenden
Container, GPU-Bestände, TLS-Gültigkeit oder Dienst-Erreichbarkeit. Der
Doc-Abgleich einschließlich HTTPS-Prüfungen folgt in A2.

## Grenzen und Abschlussprüfung

- Registry-Schema: `python3 scripts/audit/check-evidence-registry.py` →
  `PASS: 3018 entries; exact schema, nonempty command/output/date, timezone, unique IDs`.
  `R2-A1-REGISTRY-CHECK` bewahrt die unmittelbar vorhergehende Prüfung mit 3017 Einträgen.
- Die ersten 63 Einträge sind strukturell identisch zur historischen Quelle;
  der Checker ist bytegleich. `git diff --check` ist erfolgreich.
- Aktuelle GPU-Gesamtzahl: **nicht feststellbar**; dieser Teil der DoD bleibt offen.
- Jeder tatsächlich beobachtete lokale Host hat eigene Belege; Produktionshosts sind mangels Zugang nicht auflistbar.
- Produktions-Infrastruktur blieb vollständig unverändert; laufende Kosten bleiben unbekannt.
- Keine Runtime-/Audio-Codeänderung: keine neue Audio-Latenz, keine Änderung an Vier-Nutzer-Synchronisation oder B2B-Lock.
- `npm run verify` wird auf dem Integrationsbranch geprüft; dieser Dokumentationszweig beansprucht keinen vollständigen grünen Verify-Lauf.

Für den Abschluss der Produktionsinventur müssen die benannten ENV-Secrets
und ein SSH-Agent im ausführenden Environment verfügbar werden. Eine
behauptete Schlüsseldatei in einer separaten Bibliothek ist ohne bereitgestellten
Anhang und verfügbaren Zugriff kein verwendbares Credential.


## A1b – authentifizierter Nachlauf 2026-11-13

Dieser Abschnitt ergänzt die historischen Zugangsfehler; er schreibt sie nicht um. Auf neue ausdrückliche Betreiberanweisung liegt die bereitgestellte Datei geschützt außerhalb aller Git-Repositories unter `/workspace/secrets/provider-tokens.env`, Datei `0600`, Verzeichnis `0700`. Werte erscheinen nicht in Registry/Antworten. Die Datei ist nicht Teil dieser Branches.

| Provider / Credential-Scope | Authentifizierte Beobachtung | Bestand / Kosten | Beleg |
|---|---|---|---|
| Hetzner, HETZNER_TOKEN | GET Serverliste und Pricing jeweils HTTP 200 | Serverliste leer; Server-Stundentarifsumme dieses Scopes 0 EUR/h. Keine Aussage über IP-, Volume-, Snapshot-, Traffic-Kosten oder andere Projekte. | `LIVE-A1B-V1-INVENTORY` |
| Hetzner, zusätzlicher Alias HetznerPRAIN | GET Serverliste HTTP 401 | Nicht ermittelbar; keine leere Flotte behauptet. | `LIVE-A1B-ALTERNATE-HETZNER` |
| Vast | Früherer Listenendpunkt HTTP 410. Offiziell dokumentiertes v1 mit Keyset-Pagination liefert HTTP 200, total_instances 0, next_token null. | Keine Instanzen in diesem Credential-Scope; Instanzkostensumme 0 USD/h. Keine Rechnung und keine EUR-Umrechnung. | `LIVE-A1B-AUTH-INVENTORY`, `LIVE-A1B-V1-INVENTORY` |
| RunPod | Variable fehlt in Prozess und Datei | Pods, GPUs, Kosten nicht ermittelbar. | `LIVE-A1B-V1-INVENTORY` |
| SSH | Kein Agent; keine authentifiziert aufgelisteten Hosts | Nicht versucht; keine Container-/GPU-Behauptung. | `LIVE-A1B-V1-INVENTORY` |

| Explizit geprüfte IP | Authentifizierte Zuordnung / Rolle |
|---|---|
| 135.181.111.103 | Nicht in den erfolgreich gelisteten Beständen; Zuordnung/Rolle wegen übriger unbekannter Scopes nicht ermittelbar. |
| 135.181.251.14 | Nicht in den erfolgreich gelisteten Beständen; Zuordnung/Rolle wegen übriger unbekannter Scopes nicht ermittelbar. |
| 77.42.8.166 | Unbekannter Host, nicht in den erfolgreich abgefragten eigenen Beständen. Nicht als ausgeschaltet interpretieren; übrige Accounts nicht abschließend geprüft. |

Es existiert in diesen erfolgreichen Antworten keine Hostzeile, für die Rolle, Region, GPU oder SSH-Containerdaten ergänzt werden könnten. API-Paginierung wird auf Vollständigkeit geprüft; fehlerhafte Strukturen, HTTP-Fehler und fehlende Preise werden nicht zu null umgedeutet. API-Antworten werden nur als Allowlist-Projektion ausgegeben, nie vollständig mit möglichen Jupyter-Tokens, extra_env oder Credentials.

**A1b-DoD teilweise:** Authentifizierte Inventur und ehrliche Unbekannt-Angaben pro Scope liegen vor; eine globale GPU-Gesamtzahl und vollständige Kosten/h sind weiterhin unbekannt. Die zentrale aktuelle Bestandsaussage bleibt `docs/SERVER_FLEET.md`. B3 ist dadurch blockiert.

Nebenfund unter KI-Freeze: Der vorhandene Runtime-/Lifecycle-Client verwendet weiterhin den früheren Vast-Listenpfad (`scripts/vast-pods.py`). Der reine Inventur-Client verwendet das dokumentierte v1; der KI-/Lifecycle-Code wurde ausdrücklich nicht geändert. Offizielle Quelle: https://docs.vast.ai/api-reference/openapi/yaml/show_instances.yaml (GET /api/v1/instances/, Bearer, limit max25, after_token/next_token). HTTP 410 ist keine leere Instanzliste.
