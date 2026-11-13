# audioMONASTRY – Server-Flotte

## Aktueller Produktionsbestand (2026-11-13 UTC)

**GPU-Gesamtzahl: unbekannt.** Dies ist die einzige kanonische Angabe zum
aktuellen GPU-Gesamtbestand. Fehlender Zugang ist kein Nachweis von null GPUs.
Hetzner-, Vast- und RunPod-Instanzen, Container, GPU-Typen und laufende Kosten
sind nicht feststellbar.

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
