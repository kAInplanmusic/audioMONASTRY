# audioMONASTRY — Infrastruktur-Konstitution (verbindlich)

**Stand:** 2026-09-20 · **Vorgabe:** Betreiber · **Geltung:** Alle Hetzner- und
RunPod-Themen. Dieses Dokument ist die **einzige Quelle der Wahrheit** für
Flotten-Größen, Kosten und Betriebsmodi. Jede andere Doku (SERVER_FLEET,
HETZNER_DEPLOY, AI_*, RUNPOD_*, OPS_RUNBOOK, READMEs) verweist hierher und darf
die Zahlen **nicht** eigenständig wiederholen oder abweichen lassen.

---

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

### 1.2 Die 5 Hetzner-Rollen

`app` (Caddy + API + Signaling) · `sfu` (mediasoup, RTP 40000–40099) ·
`ai` (CPU-Fallback/Stem) · `master` (master-player, FFmpeg/NumPy) ·
`edge` (Monitoring/Smoke).
Typen per `FLEET_TYPE_*`-Env überschreibbar (Placement-Scarcity), Default cx23.

---

## 2. Betriebsmodi (AI-Schalter)

Die AI-Flotte hängt an **einer Einstellung** (aiMONK-Modus, OFF ⇄ AUTO_AI/PRO).
Umgesetzt ist sie als **Betriebsmodus** in `src/core/ai/aiGate.ts` (SSOT im Code):

| Modus | aiMONK | Wirkung | Kostenrahmen |
|---|---|---|---|
| **AI aus** (`off`) | OFF | Kein RunPod-Job, kein `workersMin=1`, keine `LlmRouter`-Aufrufe an die GPU-Flotte, keine Visual-Abrufe. | **Nur Hetzner** (~0,054 €/h, ~39 €/Monat @24/7) + Speicher |
| **AI an ohne Visuals** (`on-no-visuals`) | AUTO_AI | **Alle immer-verfügbaren Rollen Vollgas** (brain, ears, voiceGen, music, orchestrator); Visual-Rollen gesperrt. | bis ~2,5–3,0 €/h (5 Rollen × ~0,49–0,60) |
| **AI an mit Visuals** (`on-with-visuals`) | PRO | Zusätzlich `imageHq`/`videoReal`/`videoAbstract` beim Abruf. | +~0,49 €/h je aktiver Visual-Rolle, danach scale-to-zero |

**Default ohne Einstellung:** `on-no-visuals` (Konstitution: „AI an“, Visuals
erst bei Anforderung). `AI_MODE=off` in der Umgebung ist der harte
Server-Kill-Schalter, unabhängig von der UI.

**Regel für Visuals (ausdrücklich):** Visual-Rollen laufen **NICHT** dauerhaft.
Sie starten **erst, wenn eine Visual-Aktion abgerufen/aktiviert wird**
(Bild-/Video-Generierung), und fallen danach auf Null zurück
(`AI_VISUAL_IDLE_MS`, Default 900 s). Das ist die **einzige** bewusste
Lazy-Load-Ausnahme — alle übrigen Rollen laufen bei „AI an" voll, nicht
bedarfsgesteuert.

---

## 3. Kostenmodell (Rechenbeispiele)

- **Vollast AI** (8 Rollen × ~0,49 €/h ≈ 3,9 €/h; lt.
  `runpod-8-instances-complete-plan.md` ~3,2 €/h) + Hetzner 0,054 €/h
  → **~3,3–4,0 €/h**, deutlich unter der 10-€/h-Grenze und innerhalb des
  Zielbands nur bei den günstigeren Pools.
- **Nur Hetzner** (AI aus): **~0,054 €/h** (~39 €/Monat bei 24/7-Betrieb).
- **Speicher:** 5 Snapshots ~25,5 GB ≈ **0,30 €/Monat** — weit unter 5 €/Monat.
- `idleTimeout` wird abgerechnet: scale-to-zero greift erst nach `idleTimeout`s.
  Werte je Rolle: immer-Rollen klein (15–20 s), Visual-Rollen höher (900 s
  deklariert) für Iterations-Läufe.

---

## 4. Durchsetzung im Code

- `src/config/aiInfrastructure.ts` hält die Konstanten und Helfer
  (`assertGpuEndpointBudget`, `assertFleetHourlyBudget`, `assertStorageBudget`,
  `isVisualRole`, `alwaysOnRoles`) sowie die **Laufzeit-Grenzen**
  (`getBudgetLimits`/`setBudgetLimits`/`resetBudgetLimits`) und den Kostenbericht
  `fleetBudgetReport` (GPU + Hetzner + Speicher).
- `providerRouter.ts` ruft `assertGpuEndpointBudget()` beim Start.
- `runpod-deploy.py` (`ROLE_DEFAULTS`) ist die Deploy-Seite derselben 8 Rollen.
- **AI-Schalter (wirksam):** `src/core/ai/aiGate.ts` ist der eine Zustand
  (`off` / `on-no-visuals` / `on-with-visuals`). Er wird an jeder RunPod-Kante
  geprüft — `fleetWake.ts` (Wake/Sleep), `runpodProvider.ts` (`run`/`runLong`/
  `warmup`) und den Visual-Pfaden (`vision/runpodVision.ts`,
  `vision/runpodVideo.ts`). Bei `off` entsteht **kein** Netzwerkaufruf.
- **Visual-Rollen (wirksam):** `wakeFleet()` weckt nur die immer-Rollen;
  Visuals kommen über `wakeRoleOnDemand()` bei Abruf hoch und fallen nach
  `AI_VISUAL_IDLE_MS` wieder auf `workersMin=0`.
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
