# audioMONASTRY — Infrastruktur-Konstitution (verbindlich)

**Stand:** 2026-09-29 (Korrektur GPU-Preise + Idle-Timeout, Paket B; Grundlagen
vom 2026-09-20 bleiben) · **Vorgabe:** Betreiber · **Geltung:** Alle Hetzner- und
RunPod-Themen. Dieses Dokument ist die **einzige Quelle der Wahrheit** für
Flotten-Größen, Kosten und Betriebsmodi. Jede andere Doku (SERVER_FLEET,
HETZNER_DEPLOY, AI_*, RUNPOD_*, OPS_RUNBOOK, READMEs) verweist hierher und darf
die Zahlen **nicht** eigenständig wiederholen oder abweichen lassen.

---

## 0. Entscheidung 2026-10-07 (geht den Abschnitten unten vor)

- **AI-Flotte = 5 RunPod-Pods** (brain+orchestrator, ears, voice, stems, music), alle Modelle
  resident, **Pods statt Serverless**, AI-Aufpreis **max. 4 €/h** (Ist: 2,25–2,44 €/h).
  Quelle: `deploy/runpod/pod-fleet.json`, Betrieb: `docs/RUNPOD_PODS_RUNBOOK.md`.
- **Keine Bild-/Video-Generierung** auf GPUs; `imageHq`, `videoReal`, `videoAbstract` entfallen.
  Visuals entstehen aus vorhandenem Material auf einer **eigenen Vis-Instanz** (GPU-Pod mit NVENC,
  ≈ 0,25 €/h, vorbereitet, aus).
- **Gewichte** liegen als Archive in R2 (≈ 2 €/Monat); Pods laden sie beim Start.
- **Medien-Archiv** (BRAIN-Platte u. a.) über `scripts/media-ingest.py`; eine volle 2-TB-Platte
  kostet 13–28 €/Monat und sprengt die 5 €/Monat unten → Betreiber entscheidet Budget/Auswahl.
- Die Zahlen in §1–§3 zur 8-Endpoint-Serverless-Flotte gelten nur noch für den Serverless-Weg,
  bis er nach dem ersten erfolgreichen Pod-Lauf entfernt wird.

## 1. Harte Obergrenzen

| Größe | Grenze | Zielband | Quelle im Code |
|---|---|---|---|
| RunPod-Endpoints | **max. 8** (eine Rolle je Endpoint) | — | `AI_MAX_GPU_ENDPOINTS` (`src/config/aiInfrastructure.ts`) |
| Hetzner-Server | **max. 5** (Rollen app/sfu/ai/master/edge) | — | `AI_MAX_HETZNER_SERVERS` |
| Laufende Kosten Flotte | **max. 10 €/h** (Hetzner + RunPod zusammen) | **5–7,5 €/h** | `AI_MAX_FLEET_EUR_PER_HOUR` / `AI_TARGET_FLEET_EUR_PER_HOUR` |
| Speicher (Snapshots/ISOs) | **max. 5 €/Monat** | ~0,3 €/Monat | `AI_MAX_STORAGE_EUR_PER_MONTH` |

### 1.1 Die 8 RunPod-Rollen (je ein Endpoint)

`brain` · `ears` · `voiceGen` · `music` · `imageHq` · `videoReal` ·
`videoAbstract` · `orchestrator`
(Kanonische Liste = `GPU_ROLE_IDS` in `src/config/aiInfrastructure.ts`; der
Drift-Guard `tests/manifestRoles.test.ts` hält Code und Manifest zusammen.)

**Rollen-Charakter:** `brain`, `ears`, `voiceGen`, `music`, `orchestrator` sind
**immer-verfügbar** (werden mit der AI aktiviert). `imageHq`, `videoReal`,
`videoAbstract` sind die **Visual-Rollen** und starten **nur bei Abruf**
(siehe §2).

**VRAM-Budget — genau eine Quelle mit Auflösungsregel (INFRA-RUNPOD-006):**
`model_manifest.json` → `runtime.vramBudgetGb` ist der Flotten-Default,
`roles.<rolle>.vramBudgetGb` übersteuert ihn je Rolle (gelesen in
`model_manager.configure()` über `registry.py`). Eine frühere
`runtime_config.yaml` (141/8 GB aus der H200-Pod-Ära) ist **gelöscht** – kein
Worker hat sie je gelesen; `AI_MAX_VRAM` in der TS-Simulation ist keine
Flottenquelle.

### 1.2 Die 4 Hetzner-Rollen

`app` (Caddy + API + Signaling + master-player + TURN) · `sfu` (mediasoup, RTP 40000–40099) ·
`media` (R2-Sync-Worker + Audio-Streaming-Cache + Mediendaten auf lokaler NVMe, KEIN Hetzner-Volume) ·
`edge` (Monitoring/Smoke).
Typen per `FLEET_TYPE_*`-Env überschreibbar (Placement-Scarcity), Default app cx43, sfu cx33, media cx43, edge cx23.
AI_MODE=off, kein ai-1.

---

## 2. Betriebsmodi (AI-Schalter)

Die AI-Flotte hängt an **einer Einstellung** (aiMONK-Modus, OFF ⇄ AUTO_AI/PRO).
Umgesetzt ist sie als **Betriebsmodus** in `src/core/ai/aiGate.ts` (SSOT im Code):

| Modus | aiMONK | Wirkung | Kostenrahmen |
|---|---|---|---|
| **AI aus** (`off`) | OFF | Kein RunPod-Job, kein `workersMin=1`, keine `LlmRouter`-Aufrufe an die GPU-Flotte, keine Visual-Abrufe. | **Nur Hetzner** (~0,054 €/h, ~39 €/Monat @24/7) + Speicher |
| **AI an ohne Visuals** (`on-no-visuals`) | AUTO_AI | **Alle immer-verfügbaren Rollen Vollgas** (brain, ears, voiceGen, music, orchestrator); Visual-Rollen gesperrt. | bis ~2,0 $/h (5 Rollen × ~0,40 $/h, A6000-Klasse; Stand 2026-09-29, s. §3) |
| **AI an mit Visuals** (`on-with-visuals`) | PRO | Zusätzlich `imageHq`/`videoReal`/`videoAbstract` beim Abruf. | +~0,40 $/h je AMPERE_48-Visual-Rolle (`imageHq`), ~1,10 $/h je ADA_24-Rolle (RTX 4090; 5090 ~1,58 $/h), danach scale-to-zero — Stand 2026-09-29, Quelle `model_manifest.json` (`gpuPoolNote`) |

**Default ohne Einstellung:** `on-no-visuals` (Konstitution: „AI an“, Visuals
erst bei Anforderung). `AI_MODE=off` in der Umgebung ist der harte
Server-Kill-Schalter, unabhängig von der UI.

**Regel für Visuals (ausdrücklich):** Visual-Rollen laufen **NICHT** dauerhaft.
Sie starten **erst, wenn eine Visual-Aktion abgerufen/aktiviert wird**
(Bild-/Video-Generierung), und fallen danach auf Null zurück
(`AI_VISUAL_IDLE_MS`, Default 900 s). Das ist die **einzige** bewusste
Lazy-Load-Ausnahme — alle übrigen Rollen laufen bei „AI an" voll, nicht
bedarfsgesteuert.

> **Korrektur 2026-09-29 (Paket B):** `AI_VISUAL_IDLE_MS` ist das App-seitige
> Wake-Fenster, nicht die Endpoint-Abrechnung. Der Serverless-`idleTimeout` der
> Visual-Endpoints liegt bei **120 s** (gemessen 2026-09-16, `ROLE_DEFAULTS` in
> `scripts/runpod-deploy.py`, Gate `tests/test_runpod_deploy_defaults.py`).
> Die 900 s oben bleiben als Historie des Stands 2026-09-20 stehen.

---

## 3. Kostenmodell (Rechenbeispiele)

- **Vollast AI** (5 Rollen AMPERE_48 × ~0,40 $/h + 3 Visual-Rollen: `imageHq`
  ~0,40 $/h, `videoReal`/`videoAbstract` je ~1,10 $/h auf ADA_24/RTX 4090 —
  5090 ~1,58 $/h; Quelle `model_manifest.json` `gpuPoolNote`, Stand 2026-09-29)
  + Hetzner 0,054 €/h → **~2,3 $/h + 0,05 €/h** Vollbetrieb, deutlich unter der
  10-€-Grenze. (Altstand 2026-09-20: pauschal 8 × ~0,49 €/h ≈ 3,9 €/h —
  zurückgerechnet auf die alte 0,40-€-A6000-Basis.)
- **Nur Hetzner** (AI aus): **~0,054 €/h** (~39 €/Monat bei 24/7-Betrieb).
- **Speicher:** 10 Snapshots (Retention: 2 je Rolle) ~50,4 GB ≈ **0,50 €/Monat**
  (live gemessen 2026-09-20) — weit unter 5 €/Monat.
- `idleTimeout` wird abgerechnet: scale-to-zero greift erst nach `idleTimeout`s.
  Werte je Rolle (Stand 2026-09-29): immer-Rollen klein (brain/ears 15 s,
  live; `ROLE_DEFAULTS` in `scripts/runpod-deploy.py`), voiceGen/Music/Visual-
  Rollen **120 s** (gemessen 2026-09-16; mit 900 s blieben Worker nach kurzen
  Probes über die Zeitgrenze hinaus auf `RUNNING` und wurden weiter abgerechnet,
  bis zu 3,66 $/h — `runpod-8-instances-complete-plan.md`). Altstand 2026-09-20:
  Visual-Rollen 900 s deklariert.

### 3.1 Knotengrößen und 2–3-Knoten-Betriebsprofil (Stand 2026-10-05)

**Vorgabe des Betreibers (2026-10-05, verbindlich):** Hetzner ≤ **5–6 €/h**;
**2–3 Knoten** sind der Zielrahmen (mehr nur bei echtem Mehrwert);
**lieber ein stärkerer als mehrere schwache**; **keine dauerhaften Kosten** —
bezahlt wird Nutzung, nicht Besitz.

**Live gemessen** über `GET /v1/pricing` und `GET /v1/server_types`
(Hetzner API, 2026-10-05, netto, ohne MwSt.; Monat = Preis-Cap):

| Typ | vCPU (shared) | RAM | Disk | €/h | €/Monat (Cap) |
|---|---|---|---|---|---|
| `cx23` | 2 | 4 GB | 40 GB | 0,0088 | 5,49 |
| `cx33` | 4 | 8 GB | 80 GB | 0,0136 | 8,49 |
| `cx43` | 8 | 16 GB | 160 GB | 0,0256 | 15,99 |
| `cx53` | 16 | 32 GB | 320 GB | 0,0473 | 29,49 |
| `cpx21` | 3 | 4 GB | 80 GB | 0,0152 | 9,49 |
| `cpx31` | 4 | 8 GB | 160 GB | 0,0280 | 17,49 |
| `cpx41` | 8 | 16 GB | 240 GB | 0,0521 | 32,49 |
| `cax21` (ARM) | 4 | 8 GB | 80 GB | 0,0168 | 10,49 |
| `ccx13` (dediziert) | 2 | 8 GB | 80 GB | 0,0697 | 43,49 |

**Dauerhafte Posten (existenz-basiert, unabhängig von Last):**
Volume `0,0572 €/GB/Monat` · Snapshot `0,0143 €/GB/Monat` ·
Primär-IPv4 `0,50 €/Monat` je Knoten · Backup `+20 %` der Serverrate.
Ein **gestoppter** Server wird zum vollen Satz weiterberechnet —
Abrechnung endet **nur durch Löschen** (Hetzner-FAQ: „we will bill you for
them, regardless of their state“).

**Profil „3 Knoten“ (Standard):**

| Rolle | Typ | €/h | €/Monat | Dienste |
|---|---|---|---|---|
| `app` | `cpx41` (8 vCPU/16 GB) | 0,0521 | 32,49 | Caddy + API/Signaling + master-player |
| `sfu` | `cpx31` (4 vCPU/8 GB) | 0,0280 | 17,49 | mediasoup + coturn, eigene öffentliche IP, UDP 40000–40099 |
| `edge` | `cx23` (2 vCPU/4 GB) | 0,0088 | 5,49 | Monitoring (Prometheus/Grafana/cAdvisor/node-exporter) |
| **Summe** | | **0,0889** | **55,47** | 24/7-Betrieb, netto |

**Profil „2 Knoten“ (schlank):** `cpx41` (app+master+sfu) + `cx23` (edge)
= **0,0609 €/h · 37,98 €/Monat**. Der zusätzliche SFU-Knoten im 3-Knoten-Profil
kostet 17,49 €/Monat und ist die empfohlene Trennung: eigene öffentliche IP,
eigene CPU für RTP, kein Konflikt mit dem App-Prozess.

**Kein Dauerposten im Standardprofil:** keine Volumes, keine Snapshots,
keine Floating IPs — alles drei ist per Live-Abfrage 2026-10-05 zu **0** gezählt.
Medien liegen in Cloudflare R2 (Nutzungspreis, `$0,015/GB-Monat`, 10 GB frei,
Egress frei) und in Supabase; AI läuft als RunPod-Serverless mit
scale-to-zero. Das früher diskutierte 500-GB-Volume (28,60 €/Monat) entfällt.

**Was gegenüber dem 5-Knoten-Bestand entfällt:** die Rolle `ai`
(CPU-Fallback/Stem). Ihre Aufgabe ist mit der RunPod-Flotte (8 Rollen) und dem
lokalen, bei Bedarf als Container auf `app` mitlaufenden Diensten abgedeckt.
`app`, `sfu`, `master` und `edge` bleiben in allen Profilen erhalten; die
Obergrenze von 5 Knoten (§1) bleibt unverändert gültig.

---

## 4. Durchsetzung im Code

- `src/config/aiInfrastructure.ts` hält die Konstanten und Helfer
  (`assertGpuEndpointBudget`, `assertFleetHourlyBudget`, `assertStorageBudget`,
  `isVisualRole`, `alwaysOnRoles`) sowie die **Laufzeit-Grenzen**
  (`getBudgetLimits`/`setBudgetLimits`/`resetBudgetLimits`) und den Kostenbericht
  `fleetBudgetReport` (GPU + Hetzner + Speicher).
- `providerRouter.ts` ruft `assertGpuEndpointBudget()` beim Start und
  `auditRoleEndpointIds()` (INFRA-RUNPOD-007): der Start bricht ab, wenn zwei
  Rollen ohne Legacy-Modus auf dieselbe Endpoint-ID zeigen; der dokumentierte
  Legacy-Migrationspfad (`RP_ENDPOINT_ID` für alle Rollen) bleibt erlaubt und
  wird nur laut gemeldet. `GET /api/ai/fleet/status` berichtet ihn unter
  `endpointAudit` (`strict: false`).
- `runpod-deploy.py` (`ROLE_DEFAULTS`) ist die Deploy-Seite derselben 8 Rollen.
- **AI-Schalter (wirksam):** `src/core/ai/aiGate.ts` ist der eine Zustand
  (`off` / `on-no-visuals` / `on-with-visuals`). Er wird an jeder RunPod-Kante
  geprüft — `fleetWake.ts` (Wake/Sleep), `runpodProvider.ts` (`run`/`runLong`/
  `warmup`) und den Visual-Pfaden (`vision/runpodVision.ts`,
  `vision/runpodVideo.ts`). Bei `off` entsteht **kein** Netzwerkaufruf.
- **Visual-Rollen (wirksam):** `wakeFleet()` weckt nur die immer-Rollen;
  Visuals kommen über `wakeRoleOnDemand()` bei Abruf hoch und fallen nach
  `AI_VISUAL_IDLE_MS` wieder auf `workersMin=0`.
- **Visual-Sonderweg (begründet, INFRA-RUNPOD-007):** `vision/runpodVision.ts`
  und `vision/runpodVideo.ts` gehen NICHT durch `RunPodProvider`, weil ihre
  vorgefertigten ComfyUI-/Hub-Worker das `{task, model, input}`-Protokoll nicht
  kennen (§1.1, `warmupMode: 'endpoint'`) – ein Umbiegen würde sie mit
  ungültigen Requests treffen. Alles, was nicht worker-spezifisch ist, teilen
  beide über `vision/runpodJobClient.ts`: Gate-Prüfung, Retry mit Backoff nur
  bei wiederholbaren Fehlern (429/5xx/Netz), Deadline über den ganzen Job und
  ein Circuit Breaker je Rolle (`visionBreakerStates()`, sichtbar als
  `visionBreakers` im Flotten-Status).
- **Budget-Guards (verdrahtet):** der Wake-Pfad bricht **vor** dem ersten
  Netzwerkaufruf beim gerissenen Stundenbudget ab (`blocked: 'budget'`); die
  Speicherkosten werden in `GET /api/ai/fleet/status` und `POST /api/ai/budget/check`
  gegen `assertStorageBudget` geprüft (Überschreitung = Log-Alarm bzw. HTTP 409).
- **Betriebs-API:** `GET /api/ai/mode` (Status), `POST /api/ai/mode`
  (`{mode, source}`) — die UI spiegelt den aiMONK-Modus dorthin.

---

## 5. Aufräum-/Abweichungsliste (Doku-Drift)

Diese Dokumente nannten abweichende Zahlen und sind auf die Konstitution zu
ziehen (Stand vor dieser Anpassung):

| Dokument | Falscher Stand | Korrekt |
|---|---|---|
| `MASTERTODOENDE.json` `budget.fleetEndpointsMax` | 5 | **8** |
| `MASTERTODOENDE.json` `architectureDecisions` | „max. 4 GPU-Endpoints" | **8** |
| `MASTERTODOENDE.json` `fundamentals.aiFleet` | „3 Endpoints live" | **8** |
| `docs/SERVER_FLEET.md` | „5-Instanzen-Architektur", KI lokal auf ai-1 | 5 Hetzner + 8 RunPod-Rollen |
| `docs/RUNPOD_AI_V1_SPEC.md` | „3-Rollen-GPU-Flotte" | von `runpod-8-instances-complete-plan.md` überholt |
| `docs/PRODUKTIONSREIFE_WEGPLAN.md` | Kostendeckel „1,50 €" | 10 €/h-Grenze, Ziel 5–7,5 €/h |

**Regel: Neue Zahlen nie in einer Einzeldoku erfinden — immer hier ändern und
dort referenzieren.**
