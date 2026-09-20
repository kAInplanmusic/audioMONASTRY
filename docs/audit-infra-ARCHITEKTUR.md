# Architektur-Audit: RunPod + Hetzner (audioMONASTRY)

**Datum:** 2026-09-20
**Basis:** Branch `main`, HEAD `902e9c3`, Arbeitsbaum sauber (nur diese Dokumente neu)
**Methode:** Drei parallele, belegte Teil-Audits (RunPod, Hetzner-Flotte,
KI-Vermittlung/Prompts/Pipeline) plus **eigene Live-Verifikation** der
schwerwiegendsten Behauptungen. Jede Aussage trägt Datei:Zeile (in den
Teil-Dokumenten) bzw. ist als „eigene Prüfung" markiert.
**Geltung:** Diese Gesamtschau fasst zusammen und bewertet. Die Tiefe
(Zeilenbelege, Rohantworten, offene Punkte) steht in den drei Teil-Dokumenten:

- `docs/audit-infra-runpod.md` (512 Zeilen)
- `docs/audit-infra-hetzner.md` (722 Zeilen)
- `docs/audit-infra-ai-routing.md` (492 Zeilen)

> **Ehrlichkeits-Klausel.** Live-Zustand wird als solcher gekennzeichnet.
> Nicht gemessene Kosten, nicht abgerufene Templates, kein gefeuerter GPU-Job
> und keine SSH-/Container-Zustände sind ausdrücklich offen. Ein Agent-Befund
> wurde dort, wo ich ihn geprüft habe, bestätigt oder relativiert vermerkt.

---

## 1. Live-Ist-Stand (verifiziert)

### 1.1 RunPod — **eigene Prüfung: 8 Endpoints live**

`GET https://rest.runpod.io/v1/endpoints` (Key nie ausgegeben) ergab **8**
Endpoints, alle `workersMin:0` / `workersMax:1`, alle scale-to-zero, alle
`networkVolumeId` leer:

| Endpoint-ID | Name | GPU-Pool (Modellnamen) | min/max | idle |
|---|---|---|---|---|
| `ppxo7wrn599p0q` | audiomonastry-ai-brain | A40/A6000/6000-Ada/L40/L40S | 0/1 | **15 s** |
| `xeax6xrgd0csag` | audiomonastry-ai-ears | A40/A6000/6000-Ada/L40/L40S | 0/1 | **15 s** |
| `gajmangfldpzrk` | audiomonastry-ai-voice | A40/A6000/6000-Ada/L40/L40S | 0/1 | 120 s |
| `vsbjhw0nnnb47e` | audiomonastry-ai-music | A40/A6000/6000-Ada/L40/L40S | 0/1 | 120 s |
| `wzh9hcbitjnn95` | audiomonastry-ai-image | A40/A6000/6000-Ada/L40/L40S | 0/1 | 120 s |
| `6ghy4fh00zb0j9` | audiomonastry-ai-video-real | RTX 4090/5090 | 0/1 | 120 s |
| `fogwdyxp1zj8zv` | audiomonastry-ai-video-abstract | RTX 4090 | 0/1 | 120 s |
| `xu4sqszdfk8lp8` | audiomonastry-ai-orchestrator | A40/A6000/6000-Ada/L40/L40S | 0/1 | 120 s |

Die 8 IDs in der lokalen `.env` stimmen 1:1 mit den Live-Endpoints.

### 1.2 Hetzner — **eigene Prüfung: Flotte gelöscht**

`GET https://api.hetzner.cloud/v1/servers` → `{"servers": [], ...}` (**0 Server**),
`GET /floating_ips` → `[]` (**keine Floating-IP**). Das entspricht dem
Kostenstopp-Modell (`MASTERTODOENDE.json fleetState2026_09_11`:
„GELOESCHT (Kostenstopp)"), **widerlegt aber die Annahme**, eine Floating IP
bleibe reserviert (`SERVER_FLEET.md`, `delete-fleet.sh`). 10 Snapshots
(`samplemonk-snapshot-*`, ältester 2026-09-11) und 12 Firewalls (u. a. 6×
Legacy `samplemonk-*`) bleiben zurück.

**Merksatz: Die Hetzner-Flotte ist zurzeit tot. Jeder „Live-Test" gegen
anunnakitools.de trifft Cloudflare, nicht die App — 521 ist der Normalzustand,
kein Fehler.**

---

## 2. Architektur (wie gebaut)

```
Browser (React/TS, DAW-UI)
  │  HTTP/WS
  ▼
Cloudflare (Zone anunnakitools.de)
  └─ Worker-Route *  →  Portal-Worker (auth, studio-Cookie, x-studio-token)
        └─ resolveOverride origin.anunnakitools.de
              ▼
        app-1 (Hetzner cx23, Caddy 443 → Node 8080)
          ├─ server.ts: Express + Socket.io-Signaling (STUDIO_ACCESS_TOKEN-Gate)
          ├─ Redis (Lock-Relay, nur Profil)
          ├─ master-player (FFmpeg/NumPy)      sfu-1: mediasoup SFU, RTP 40000-40099
          ├─ midi-bridge
          └─ AI-Vermittlung: server/routes/{ai,voice,media,stem,visual,cloud}Routes.ts
                └─ services/audiomonastry-ai-runtime  (Python: FastAPI + Handler)
                      └─ RunPod Serverless (8 Endpoints, Rollen unten)

App-seitige KI-Schicht (Client + Server):
  src/core/ai/LlmRouter.ts      Provider-/Endpunkt-Auswahl + Fallback
  src/core/ai/MoaAgent.ts       Mixture-of-Agents (Plan → Merge → Prüfen)
  src/core/ai/orchestrator/*    PromptStore / PromptIteration / PromptSeed
  src/core/ai/vision/*          runpodVision / runpodVideo / Prompt
  src/core/ai/agentLoop.ts      aiMONK-Agent-Schleife (AI-P1-006)
```

**Rollen → Endpoint (RunPod):** brain (vLLM, Qwen3-14B-AWQ) · ears · voice ·
image (FLUX.1-dev) · music · video-real (Wan2.2) · video-abstract ·
orchestrator (ComfyUI-Workflow-Graphen, RUNPOD-P1-001).

**Kostenmodell:** Hetzner 5 Server ~0,054 €/h (~39 €/Monat nur bei 24/7),
RunPod scale-to-zero, ~2,35 €/h bei Vollbetrieb. SSOT-Budget:
`fleetEndpointsMax: 5`, `fleetMaxEurPerHour: 10`.

---

## 3. Kernbefunde (konsolidiert, nach Schwere)

### KRITISCH — die Kostengrenze und Mess-Gates sind unwirksam

1. **Konstitution live gebrochen.** `MASTERTODOENDE.json` widerspricht sich
   selbst: `architectureDecisions` sagt „max. 4 GPU-Endpoints", `budget` sagt 5,
   `fundamentals.aiFleet` sagt „3 Endpoints live" — live sind **8** (eigene
   Prüfung). Der Kostenguard ist **nirgends** technisch erzwungen:
   `providerRouter.ts:71` ruft `assertGpuEndpointBudget()`, das nur
   `1≤max≤8` mit Default 8 prüft (`aiInfrastructure.ts:75,130-136`) →
   selbstneutralisierend; `assertFleetHourlyBudget`/`assertStorageBudget` sind
   definiert und getestet, aber **unverdrahtet**; `runpod-deploy.py:491-509`
   legt Endpoints ohne Obergrenze an.
2. **Das Eval-Gate kann nicht fehlschlagen.** `scripts/eval-ai.ts:44,74-79`
   schreibt je Plugin `model:'mock'`, `provider:'offline'`,
   `actual = expected = "<plugin>:<cmd>"`, `score: 5` — **ohne LLM-Aufruf**
   (eigene Prüfung). Das speist das Nightly-Gate
   (`.github/workflows/nightly.yml`) und die Score-Spalte in
   `docs/PLUGIN_PROMPT_MATRIX.md`.
3. **Der Prompt-Loop misst sich selbst.** `promptIteration.ts`:
   `evaluatePromptCoverage` (`:38-48`) zählt Substrings des Kommandokatalogs im
   Prompt; `optimizePromptContent` (`:51-56`) hängt **genau diese Substrings**
   an → Konvergenz auf 1,0 ist garantiert und bedeutungslos.

### HOCH — doppelte Wahrheiten und nicht verdrahtete Fähigkeiten

4. **GPU-Pool doppelt wahr:** `runpod-deploy.py:120,129` = `ADA_24` vs.
   `model_manifest.json` + `endpointRegistry.ts` = `AMPERE_48`; zwei **je
   einzeln grüne** Tests zementieren den Widerspruch. Zusätzlich hebt
   `.github/workflows/runpod-deploy.yml:211-212` per Env `RUNPOD_GPU_ID:
   AMPERE_48` global die Defaults auf (`runpod-deploy.py:462` Env vor Datei).
5. **Brain hat drei Modell-Identitäten:** `Qwen/Qwen3-14B-AWQ` (live/vLLM) vs.
   `qwen3-14b` (`LlmRouter.ts:86`, ohne Manifest-Eintrag) vs.
   `qwen3-30b-a3b-awq` (Manifest/Registry).
6. **`LlmRouter` ohne Timeout/Abort:** `postJson` (`:109-115`) ist ein nacktes
   `fetch` ohne `AbortSignal` (eigene Prüfung); `circuitBreaker`/`costTracker`
   sind im Modul vorhanden, aber nicht verdrahtet; `available` prüft nur Env.
7. **`aiMode` (OFF/AI/PRO) hat keine Wirkung auf die Modellwahl** — es ist ein
   reines Lock-Flag (`aiMode.ts:9-17`) (eigene Prüfung).
8. **Hetzner-Deploy zerstört die Portal-Konfiguration.** `deploy.sh:46` setzt
   `DEPLOY_SYNC_ENV=1` als Default; `bring-up-fleet.sh:92` ruft `deploy.sh`
   ohne Override → die lokale `.env` überschreibt per Default die
   Portal-`.env` (Rollenskopierung + `TRUST_PROXY` verloren). Zusätzlich rsynct
   `deploy.sh` das Repo-`Caddyfile` ohne Ausschluss und kann damit das
   installierte Origin-TLS überschreiben.
9. **`dns_setup.py` ist nicht lauffähig.** Die eigene Pfad-Regex (`:40`,
   `^/[A-Za-z0-9_./-]*$`) verbietet `?`/`=`/`&`, aber `:72` baut
   `f"/zones?{query}"` → `ValueError` (eigene Prüfung; `provision.py:46` macht
   es richtig).
10. **MOS-Gate ohne Abnehmer:** `mosHarness.ts` gateFor/pass werden nur von
    Tests benutzt; kein Konsument von `AI_MOS_MIN_SCORE`.

### MITTEL — Betriebs-/Doku-Drift

- **Monitoring misst die edge-Kopie statt app-1** (`prometheus.yml`,
  `alertmanager.yml`); `auto-repair` wird von keinem Skript installiert;
  `edge-1` startet App+master+Caddy+Monitoring auf einem 4-GB-Typ.
- **Idle-Timeouts weichen live von der SSOT ab** (eigene Prüfung: brain/ears
  15 s, übrige 120 s; deklariert teils 900 s). `idleTimeout` wird nur beim
  **Anlegen** gesetzt, ein Template-Update ändert den Laufzeitwert nicht.
- **Live-Name `audiomonastry-ai-image` ≠ SSOT-Name `audiomonastry-ai-vision`**
  (gleiche ID/Template).
- **Zwei VRAM-Budgets:** `runtime_config.yaml` (141/8 GB) vs. Manifest
  (48/6 GB); die yaml wird von **nichts** gelesen.
  **Nachtrag 2026-09-20 (INFRA-RUNPOD-006): erledigt** — die yaml ist entfernt,
  das VRAM-Budget steht ausschließlich im Manifest (`runtime.vramBudgetGb`,
  Rollen-Override `roles.<rolle>.vramBudgetGb`).
- **Zwei unverbundene „MoA"-Implementierungen** (TS-Single-Planner vs.
  Python-4-Rollen) plus `taskWorker.ts` als paralleler Pfad ohne KI-Task-Typen.
- **`wakeFleet()`** weckt immer alle 8 Rollen ohne Kosten-Gate; `roleReady()`
  meldet unkonfigurierte Rollen als Erfolg.
- **Visual-Rollen umgehen** den gemeinsamen Provider-/Circuit-Breaker-Pfad.
- **Smoke kann für 4 Rollen grün sein ohne Job**; Gewichte werden trotz
  gegenteiliger Doku **nicht** gebacken.
- **Doku-Drift:** `PLUGIN_PROMPT_MATRIX.md` nennt nicht existierende
  Plugin-IDs; vier widersprüchliche Servertyp-Tabellen; Rolle `edge` nur in
  der Doku; H200-Rest-Doku; hartcodierte Endpoint-IDs in 4 Skripten (2 auf
  gelöschte Endpoints).

### NIEDRIG
Tote Module (`src/ai/embeddingCache.ts`, `modelRegistry.ts`, `localVoice.ts`
laut `knip.json`), `parameterPrediction` ohne Aufrufer, `MoaHistory` nicht in
den Loop eingespeist, nicht-atomarer Run-Store, veraltete Rollen-Aufzählung im
`Dockerfile.runpod`.

---

## 4. Querschnittsthemen

1. **Konstitution vs. Realität.** Die Kostengrenze existiert dreifach
   widersprüchlich und ist technisch nicht durchgesetzt. Bei scale-to-zero ist
   das Risiko akut: `wakeFleet()` kann 8 Endpoints gleichzeitig aufwecken
   (~2,35 €/h), ohne Guard.
2. **Zwei (oder drei) Wahrheiten pro Größe.** GPU-Pool, VRAM-Budget,
   Modell-ID, Endpoint-Name — jede an ≥2 Stellen anders. Tests, die je
   einzeln grün sind, verhindern die Entdeckung statt sie zu erzwingen.
3. **Gates, die nicht messen.** Eval-Score (mock), Prompt-Optimierung
   (selbstreferenziell) und Prompt-Matrix-Tests prüfen Zustand, nicht Wirkung.
   Ein rotes Gate wäre der einzige Schutz — es kann per Konstruktion nicht rot
   werden.
4. **Ungenutzte Sicherheits-/Budget-Mechanismen.** `circuitBreaker`,
   `costTracker`, `assertFleetHourlyBudget`, `AI_MOS_MIN_SCORE` — alle
   vorhanden, keiner verdrahtet.

---

## 5. Selbstlernen — Bewertung

**TEILWEISE geschlossen.**

- **Wirksam** ist der **Vision-Loop**: Generierung → DB (`aiRoutes.ts`) →
  UI-Bewertung (`VisualMonkOverlay`) → Ranking → Stilwahl → nächste
  Generierung. Einschränkungen: manueller Auslöser, Migration 008 laut
  SSOT noch nicht angewendet, Lernfläche nur das `style`-Enum.
- **Selbstreferenziell** (nicht wirksam) ist der **Prompt-Loop**
  (`promptIteration.ts`, s. o.) — und kein Produktionspfad liest den
  `promptStore`, die „optimierte" Version erreicht nie einen LLM-Call.
- **Offen/halb verdrahtet:** MOS-Gate (kein Abnehmer), `parameterPrediction`
  (kein Aufrufer), `embeddingCache`/`modelRegistry`/`localVoice` (tote
  Dateien), `MoaHistory` nicht in den Loop eingespeist.

---

## 6. Empfehlungen (priorisiert)

1. **Kostengrenze hart machen** (eine Quelle, technisch erzwungen): Zahl aus
   der Konstitution ableiten, `assertFleetHourlyBudget` vor `wakeFleet()` und
   vor `runpod-deploy.py` verdrahten; `wakeFleet()` auf bedarfsgerechtes Wecken
   der Zielrolle umstellen. **Bewusste Betreiber-Entscheidung** (Zahl + 8
   Rollen), nicht still ändern.
2. **Mess-Gates scharf machen:** `eval-ai.ts` echten Provider-Aufruf statt
   `mock`; `promptIteration`-Coverage durch eine inhaltliche Bewertung
   ersetzen oder als „heuristisch, nicht aussagekräftig" kennzeichnen.
3. **Doppelte Wahrheiten auflösen:** GPU-Pool (ADA_24 vs. AMPERE_48),
   VRAM-Budget, Brain-Modell-ID, Endpoint-Name (image/vision) je auf eine
   Quelle + einen Test, der die Abweichung rot macht.
4. **`LlmRouter` härten:** `AbortSignal`/Timeout, `circuitBreaker` +
   `costTracker` verdrahten, `available` real prüfen.
5. **Hetzner-Deploy sicher machen:** `DEPLOY_SYNC_ENV` explizit (nicht Default
   1) bzw. Portal-Werte mergen statt überschreiben; `Caddyfile` aus dem
   Standard-Rsync ausschließen; `dns_setup.py`-Regex um `?=&` erweitern.
6. **SSOT bereinigen:** `MASTERTODOENDE.json`-Widerspruch (4/5/3 vs. 8) und die
   Endpoint-Namens-/Idle-Drift richtigstellen.

---

## 7. Offen / nicht verifiziert

- **Kosten** nicht gemessen; kein GPU-Job gefeuert (read-only, keine
  GPU-Stunden); Live-Templates/Image-Tags nicht abgerufen.
- **Hetzner:** keine SSH-/UFW-/Interface-/Container-Zustände (kein Knoten
  läuft); Worker-Secrets, `eth0`-Hardcoding, Compose-`deploy.limits`-Wirkung
  offen.
- **KI:** Test-Suite im Auftrag nicht ausgeführt; ~40 AI-Testdateien nicht
  gelesen; Migrations-Anwendungsstatus in Live-Supabase nicht geprüft;
  Tote-Modul-Analyse per Import-Suche (dynamische/Alias-Referenzen möglich).
- **`runpod-8-instances-complete-plan.md`** und weitere AI-Docs wurden von den
  Teil-Audits nicht vollständig gelesen.
