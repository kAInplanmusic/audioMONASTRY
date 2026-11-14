# audioMONASTRY – Server-Flotte

## Aktueller Bestand (Runde8 aktualisiert, 2026-11-14 UTC)

**GPU-Gesamtzahl: unbekannt.** Dies ist die einzige kanonische Angabe zum
aktuellen GPU-Gesamtbestand. Fehlender Zugang ist kein Nachweis von null GPUs.
Der historische Zugangsbefund unten gilt für Runde2; Hetzner ist durch die
authentifizierte Runde8-Inventur am Dokumentende aktualisiert. Vast-/RunPod-
Bestand und tatsächliche Provider-Gesamtkosten bleiben unbekannt.

Beleg: `docs/audit/A1_INVENTORY.md`, `EVIDENCE_REGISTRY.json`:
`R2-A1-ACCESS`, `R2-A1-PROVIDER-SKIPS`, `R2-A1-TOOL-1` bis `R2-A1-TOOL-3`.
Die benannten Provider-ENV-Variablen und der SSH-Agent fehlen; die separate
PRAIN-Umgebung antwortet mit MCP -32603. A1-Übergabe:
`8d8a578d1e45c4102620a82502310c996d288069`,
`1b9ec91ad4e3623fcd8a5a2172ed656c1ab92bdb`.
Numerische Bestands-DoD bleibt bis zur authentifizierten Inventur blockiert.

## Konfiguration und Soll-Rollen (kein Live-Inventar)

GPU-Provider: `vast` laut `deploy/gpu-provider.json`; Dispatcher:
`scripts/gpu-pods.py`. Rollen-/Modellauswahl: `deploy/gpu/pod-fleet.json`
und `services/audiomonastry-ai-runtime/model_manifest.json`.
Die konfigurierte Grenze beträgt 8 EUR/h, ohne Hetzner und Supabase;
sie beweist weder tatsächliche Kosten noch laufende Instanzen.
Start-/Readiness-Bedingungen: [AI_FLEET_STARTPLAN.md](AI_FLEET_STARTPLAN.md).

### Rollen + Servertypen der Hetzner-Provisionierung

Beide Provisionierungspfade lesen `FLEET_TYPE_<ROLLE>`; die Fallbacks sind
Konfiguration, keine Aussage zu vorhandenen Hosts. Quellen:
`scripts/hetzner/provision-fleet.sh`, `services/portal-worker/src/index.js`.
`tests/test_hetzner_scripts.py::ServertypRollenDriftTest` prüft den Abgleich.

| Rolle | Knotenname | Typ-Override (Env) | Fallback CLI | Fallback Portal-Worker | Zweck |
|---|---|---|---|---|---|
| `app` | `audiomonastry-app-1` | `FLEET_TYPE_APP` | `cx43` | `cx43` | Caddy + API + Signaling + master-player + TURN, Floating IP |
| `sfu` | `audiomonastry-sfu-1` | `FLEET_TYPE_SFU` | `cx33` | `cx33` | mediasoup-SFU (RTP 40000–40099) |
| `media` | `audiomonastry-media-1` | `FLEET_TYPE_MEDIA` | `cx43` | `cx43` | R2-Sync-Worker + Audio-Streaming-Cache + Mediendaten auf lokaler NVMe |
| `edge` | `audiomonastry-edge-1` | `FLEET_TYPE_EDGE` | `cx23` | `cx23` | Monitoring-Stack (nur der Stack)


## Historie und Grenzen

Der alte Text dieses Dokuments enthielt unterschiedliche, datierte Hetzner-
und RunPod-Planstände sowie historische Messungen. Das unveränderte Original
steht als neuer Archivbeleg `R2-A2-HISTORY-SERVER-FLEET` in
`EVIDENCE_REGISTRY.json` (Quelle: `git show 8a2f1f9:docs/SERVER_FLEET.md`).
Diese Historie ist keine aktuelle Betriebsspezifikation.

Spätere historische Migrationstests und Cleanup-Beobachtungen:
[VAST_MIGRATION_STATUS_2026-11-11.md](VAST_MIGRATION_STATUS_2026-11-11.md),
[VAST_ON_DEMAND_BETRIEB_2026-11-12.md](VAST_ON_DEMAND_BETRIEB_2026-11-12.md).
Sie ersetzen die aktuelle authentifizierte Inventur nicht.
DNS allein belegt weder Eigentümer, Container, GPU-Zahl noch App-Gesundheit.
HTTPS-Prüfungen und verbleibende Domain-Defaults: [audit/A2_DOC_RECONCILIATION.md](audit/A2_DOC_RECONCILIATION.md).

## Runde 7 — belegte Hetzner-Tarifauswahl (2026-11-13, hel1)

Beleg `R7-P1-SERVER-TYPES-AND-RATES`, authentifizierte GETs auf `/servers`,
`/server_types`, `/pricing`, `/locations`. Der zugängliche Projekt-Scope enthält
aktuell **keine Server**; dies aktualisiert ausschließlich den Hetzner-Projektbefund,
keinen anderen Provider-/GPU-Bestand. Keine Provisionierung in Runde7.

Die vier physischen Rollen sind app/sfu/media/edge. Origin, API-Signaling und
master-player sind gemeinsam auf app vorgesehen; der Code definiert keine vier
separaten Server Origin/SFU/Master/Signaling. Diese Zuordnung wird nicht umgebaut.
Die Originalfallbacks bleiben unverändert (`provision-fleet.sh:44–47`,
`portal-worker/src/index.js:31–34`, ursprüngliche Tabelle oben).

| Physische Rolle / logische Dienste | Typ aus Code | Verfügbar hel1? | Tatsächlicher Typ | Gewählte Ausweichvariante | Brutto EUR/h |
|---|---|---|---|---|---|
| app: Origin + Master + Signaling | cx43 (`scripts/hetzner/provision-fleet.sh:44`) | nein | keiner, unprovisioniert | cpx42 | 0,112455 |
| sfu: RTP-SFU | cx33 (`scripts/hetzner/provision-fleet.sh:45`) | nein | keiner, unprovisioniert | ccx23 | 0,139230 |
| media: Cache/R2-Sync | cx43 (`scripts/hetzner/provision-fleet.sh:46`) | nein | keiner, unprovisioniert | cpx42 | 0,112455 |
| edge: Monitoring | cx23 (`scripts/hetzner/provision-fleet.sh:47`) | ja | keiner, unprovisioniert | cx23, unverändert | 0,010472 |

Alle ausgewählten Typen sind im abgefragten Angebot für hel1 verfügbar.
app/media: cpx42 hat wie cx43 x86/16GB/8vCPU, zusätzlich320GB Disk.
SFU: ccx23 bietet4 dedizierte vCPU/16GB/160GB statt nicht verfügbarem
cx33 mit4 geteilten vCPU/8GB/80GB; keine Annahme gemessener SFU-Latenz daraus.
Monitoring bleibt beim konfigurierten cx23. Auswahl verändert keine Provisionierungs-
Defaults und stellt keine bereits gebuchten Instanzen dar. Verfügbarkeit ist eine
Momentaufnahme. Vor einer späteren Provisionierung Angebot erneut berücksichtigen;
in dieser Runde wird nichts angelegt.

R_echt (vom Betreiber so benannte **Tarifsumme**, keine Istkosten) =
0,112455+0,139230+0,112455+0,010472 = **0,374612 EUR/h**.
R_guard = R_echt×1,5 = **0,561918 EUR/h**.
7h×R_guard = **3,933426 EUR <50 EUR**. Prüfung bestanden.
Zusätzlich vier primäre IPv4 wären zusammen0,003808EUR/h; selbst mit darauf
angewandtem1,5-Faktor ergäben sich3,973410EUR/7h. Das ist separat ausgewiesen,
nicht unbemerkt in die verlangte Typensumme eingerechnet.
Snapshots/Volumes, Mehrtraffic, GPU- und andere Dienste sind nicht Teil dieser
vier Servertyp-Tarife. Der Puffer ist eine Rechenobergrenze für diesen Scope,
keine attestierte vollständige Providerrechnung.
Maschinenlesbar: `deploy/live-audit-cost-bound.json`, Preis-/Inventarhash dort.

## Runde8 — tatsächlich erstellte Hetzner-Server

Alle vier in hel1, API-SSH-Key-ID132582018; öffentliche Adressen:

| Rolle | Server-ID | Typ | IPv4 | nachgewiesener Dienst |
|---|---|---|---|---|
| app | 176040173 | cpx42 | 135.181.111.103 | HTTP8080 /api/health200 |
| sfu | 176040174 | ccx23 | 135.181.251.14 | HTTP8080 /api/health200, SFU ready |
| media | 176040175 | cpx42 | 77.42.8.166 | Node-Exporter9100 /metrics200 |
| edge | 176040176 | cx23 | 204.168.157.44 | Node-Exporter9100 /metrics200 |

Origin/SFU aus Repo-Compose, Quellcommit f5538c6. Keine Behauptung, dass der
spätere Runde8-Monitorcode dort deployt ist. Media ist noch kein geprüfter
R2-Sync-/Streaming-Cache; Edge nur Monitoring. Lokale CloudInit-Healthchecks
und externe HTTP-Prüfungen belegt in r8-data/remote-health-current.json.
Direkter SSH-Zugriff aus dem Workspace scheitert mit Connection refused;
Installation erfolgte über CloudInit-Rebuild der frischen eigenen Server.
Keine DNS-/TLS-/Cloud-Firewall-API-Änderung. Server bleiben beauftragt in Betrieb.
Tarifsumme und R_guard siehe Runde7; keine gemessene Istkostenabrechnung.
