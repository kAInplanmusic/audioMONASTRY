# Architektur-Audit: RunPod-Integration in audioMONASTRY

**Repo:** /home/patrick/audioMONASTRY · **Branch:** main · **HEAD:** 902e9c3 · **Arbeitsbaum:** sauber (Stand der Erstellung dieses Berichts)
**Audit-Typ:** lesend (read-only). Kein Quellcode geändert, kein Commit.
**Ausgeschlossen:** node_modules/, dist/, coverage/, logs/
**Beweisführung:** Jede Code-Aussage trägt `Datei:Zeile`. Nicht Zugreifbares/Nicht Gemessenes wird als solches gekennzeichnet. Es werden keine IDs, Zahlen oder Endpoint-Namen erfunden.

---

## Gliederung

1. [Methode & Quellenlage](#1-methode--quellenlage)
2. [SSOT: MASTERTODOENDE.json (Konstitution & Live-Stand)](#2-ssot-mastertodoendejson)
3. [V1 — Verwendete Instanzen/Endpoints (Rollen, IDs, Modelle, GPUs)](#3-v1--verwendete-instanzennendpoints)
4. [V1b — Live-Enumeration (RunPod REST/GraphQL)](#4-v1b--live-enumeration-runpod)
5. [V2 — Worker-Integration (Handler-Vertrag, Rollen, Fehler, Idempotenz)](#5-v2--worker-integration)
6. [V3 — App-Code-Integration (Rolle → Route → Endpoint, Ausfallverhalten)](#6-v3--app-code-integration)
7. [V4 — System-Integration (Smoke, Deploy, GHCR, Kosten-Guard)](#7-v4--system-integration)
8. [V5 — Schwachstellen](#8-v5--schwachstellen)
9. [Befund-Index nach Schwere](#9-befund-index-nach-schwere)
10. [Offene Punkte / Nicht verifiziert](#10-offene-punkte--nicht-verifiziert)

---

## 1. Methode & Quellenlage

- SSOT laut Projekt: `MASTERTODOENDE.json` (313.492 Bytes, mtime 2026-09-19 21:43).
- Primär belegte Quellen: `services/audiomonastry-ai-runtime/` (Python-Worker), `src/core/ai/` (TypeScript-Client), `server/routes/` (HTTP-Routen), `scripts/` (Deploy/Smoke), `docs/` (Doku).
- Live-Enumeration nur read-only, nur bei vorhandenem Key; Key wird nie ausgegeben.
- Kein repo-weites Test-/Build-Gate gestartet (Vorgabe).

---

## 2. SSOT: MASTERTODOENDE.json

Gelesen wurden die Felder `fundamentals`, `architectureDecisions`, `visionLive`, `fleetState2026_09_11`, `budget` (Datei: `MASTERTODOENDE.json`, 313.492 Bytes, mtime 2026-09-19 21:43).

### 2.1 Was die SSOT behauptet

| Feld | Inhalt (wörtlich, gekürzt) |
|---|---|
| `fundamentals.aiFleet` | „3 Endpoints live (brain=vLLM Qwen3-14B-AWQ, ears, voiceGen) + 4. Rolle `vision` geplant" |
| `architectureDecisions[5]` | „Brain = RunPod-vLLM-Worker (Qwen3-14B-AWQ); 4B-Ausfuehrer entfaellt (2026-09-11)." |
| `architectureDecisions[8]` | „Kostenregel: max. 4 GPU-Endpoints, <=10 EUR/h Flotte, <=5 EUR/Monat Storage/Snapshots." |
| `budget.fleetEndpointsMax` | `5` |
| `budget.fleetMaxEurPerHour` | `10` |
| `budget.fleetEndpointsNote` | „brain, ears, voiceGen, vision (FLUX), video (Wan2.2) - alle scale-to-zero; ~2,35 EUR/h bei Vollbetrieb." |
| `visionLive.endpointName` | `audiomonastry-ai-vision` |
| `visionLive.endpointId` | `wzh9hcbitjnn95` |
| `visionLive.worker` | `PrunaAI/runpod-worker-FLUX.1-dev 1.0.3`, `gpuPool="AMPERE_48"`, `model="FLUX.1-dev"` |
| `visionLive.measured` | „2026-09-13 neu deployed + verifiziert: Kaltstart 32,4 s, 4 Steps 512x512 = 4,19 s, data-URI-PNG 168.598 Zeichen (seed 36068)" |
| `visionLive.note` | „Ersetzt den alten Endpoint 4gts9y4zph7ik9, der an einem gebundenen Template hing (Update nicht moeglich)." |

### 2.2 Befund S-1 (HOCH) — SSOT widerspricht sich selbst bei der Kosten-Grenze

`architectureDecisions[8]` nennt „max. **4** GPU-Endpoints", `budget.fleetEndpointsMax` nennt **5**. Zwei Werte in derselben Datei, die als SSOT geführt wird. Der Wert ist damit nicht eindeutig — was jede technische Durchsetzung von vornherein unmöglich macht.

### 2.3 Befund S-2 (HOCH) — SSOT-Live-Stand ist veraltet gegenüber dem echten Konto

`fundamentals.aiFleet` behauptet „3 Endpoints live … + 4. Rolle `vision` geplant". Die Live-Enumeration (Abschnitt 4) findet **8** Endpoints. `budget.fleetEndpointsNote` listet dagegen bereits brain/ears/voiceGen/vision/video — also 5 Rollen — widerspricht damit `fundamentals.aiFleet` in derselben Datei.

### 2.4 Befund S-3 (MITTEL) — `visionLive` beschreibt einen anderen Endpoint als den, auf den die ID live zeigt

`visionLive.endpointId = wzh9hcbitjnn95` ist live vorhanden, heißt dort aber **`audiomonastry-ai-image`** (Live-Enumeration, Abschnitt 4). Der in `visionLive.endpointName` dokumentierte Name `audiomonastry-ai-vision` existiert live **nicht**. Zusätzlich nennt `visionLive.model` „FLUX.1-dev", während `budget.runpodCurrentImage` für dieselbe ID „prunaai-…flux-1-dev…" führt, die Rolle `imageHq` im Manifest aber **`flux2-dev`** als preload-Modell definiert (`model_manifest.json` roles.imageHq → preloadModels[0], s. Abschnitt 3). Drei Quellen, drei Modelle für dieselbe Rolle.

### 2.5 Befund S-4 (MITTEL) — `fleetState2026_09_11` betrifft Hetzner, nicht RunPod, liegt aber in derselben SSOT

`fleetState2026_09_11.state = "GELOESCHT (Kostenstopp) - 0 Server, 0 Floating-IPs"` beschreibt die **Hetzner**-Flotte (`budget.hetznerFleet: "5 Server (app/sfu/ai/master/edge)"`) und sagt nichts über RunPod aus. Wer die Datei liest, muss die Unterscheidung Hetzner↔RunPod selbst treffen; eine gemeinsame Flotten-Kostenaussage entsteht dadurch nicht.

---

## 3. V1 — Verwendete Instanzen/Endpoints

### 3.1 Code-Quelle der Rollen-Definition: `scripts/runpod-deploy.py`

`scripts/runpod-deploy.py:9-16` deklariert die Flotte als Kommentar-Header, `scripts/runpod-deploy.py:96-134` als `ROLE_DEFAULTS` (Python-Dikt):

| # | Rolle | Endpoint-Name (`suffix`) | `gpuPoolId` | idleTimeout (Header) | Volumen |
|---|---|---|---|---|---|
| 1 | brain | `audiomonastry-ai-brain` (`:96-97`) | `AMPERE_48` (`:96`) | 15 s (`:9`) | 50 GB |
| 2 | ears | `audiomonastry-ai-ears` (`:100-101`) | `AMPERE_48` (`:100`) | 15 s (`:10`) | 100 GB |
| 3 | voiceGen | `audiomonastry-ai-voice` (`:104-105`) | `AMPERE_48` (`:104`) | 900 s (`:11`) | 150 GB |
| 4 | music | `audiomonastry-ai-music` (`:108-109`) | `AMPERE_48` (`:108`) | 900 s (`:12`) | 200 GB |
| 5 | imageHq | `audiomonastry-ai-image` (`:113`) | `AMPERE_48` (`:113`) | 900 s (`:13`) | 200 GB |
| 6 | videoReal | `audiomonastry-ai-video-real` (`:120`) | **`ADA_24`** (`:120`) | 900 s (`:14`) | 200 GB |
| 7 | videoAbstract | `audiomonastry-ai-video-abstract` (`:129`) | **`ADA_24`** (`:129`) | 900 s (`:15`) | 200 GB |
| 8 | orchestrator | `audiomonastry-ai-orchestrator` (`:134`) | `AMPERE_48` (`:134`) | 900 s (`:16`) | 100 GB |

`scripts/runpod-deploy.py:462`: `gpu_id = env("RUNPOD_GPU_ID") or str(defaults.get("gpuPoolId", "AMPERE_48"))` — der GPU-Pool ist per Env übersteuerbar. Das ist der **einzige** Ort, an dem die Flotte tatsächlich als Objekt existiert; die Deploy-Skript-Konstanten sind damit die operative Quelle, nicht die SSOT und nicht das Manifest.

### 3.2 Manifest: `model_manifest.json`

Struktur: `{"runtime": …, "models": [39 Einträge], "roles": {8 Rollen}}`. Gesamtzahl Modelle: **39** (gezählt, nicht geschätzt).

`roles`-Block (`model_manifest.json:1116-1273`): alle 8 Rollen mit `gpuPoolId: "AMPERE_48"` an den Zeilen 1116 (brain), 1132 (ears), 1158 (voiceGen), 1178 (music), 1198 (imageHq), 1225 (videoReal), 1249 (videoAbstract), 1273 (orchestrator) — also **auch videoReal/videoAbstract auf `AMPERE_48`**, während `runpod-deploy.py:120,129` für dieselben Rollen `ADA_24` setzt.

| Rolle | Preload-Modelle (Manifest) | VRAM-Budget | maxConcurrent |
|---|---|---|---|
| brain | `qwen3-30b-a3b-awq`, `qwen3-4b` | 48 GB | 1 |
| ears | `whisper-large-v3`, `clap-music`, `mert-v1-330m`, `qwen2-audio-7b`, `pyannote-diarization`, `ast-audioset`, `essentia` | 48 GB | 2 |
| voiceGen | `qwen3-tts-17b`, `qwen3-tts-voicedesign`, `htdemucs-6s`, `stable-audio-open-1.0` | 48 GB | 1 |
| music | `acestep-v15-xl-base`, `-sft`, `-turbo`, `acestep-5hz-lm-4b` | 48 GB | 1 |
| imageHq | `flux2-dev`, `qwen-image-2512`, `controlnet-depth`, `controlnet-canny`, `ip-adapter-image`, `realesrgan-x4` (exclusiveGroup `image-base` → aktiv `flux2-dev`) | 48 GB | 1 |
| videoReal | `wan22-t2v-a14b` + 5 Aufsätze | 48 GB | 1 |
| videoAbstract | `ltx-video-13b` + 5 Aufsätze | 48 GB | 1 |
| orchestrator | `qwen3-4b`, `qwen3-8b` | 48 GB | 2 |

(Rollen-Zeilen: s. o.; Preload-Zuordnung rolle→modelle aus `roles[<rolle>].preloadModels`.)

### 3.3 Befund V1-1 (HOCH) — Zwei divergente GPU-Pool-Wahrheiten für dieselben zwei Rollen

`runpod-deploy.py:120,129` (ADA_24) vs. `model_manifest.json:1225,1249` (AMPERE_48) für `videoReal`/`videoAbstract`. Die Live-Werte (Abschnitt 4) zeigen für diese Rollen `NVIDIA GeForce RTX 4090`/`RTX 5090` — also **ADA-Klasse**, d. h. das Deploy-Skript hat gewonnen und das Manifest ist für diese Rollen faktisch falsch. Wer sich auf das Manifest verlässt (z. B. VRAM-Planung 48 GB), plant gegen die falsche Hardware. Ein 32-GB-`wan22-t2v-a14b` (Manifest: `estimatedVRAM: 32`) passt rechnerisch nicht in ein 24-GB-`ADA_24`-Fenster.

### 3.4 Befund V1-2 (MITTEL) — `runtime_config.yaml` und `model_manifest.json` widersprechen sich beim VRAM-Budget

`runtime_config.yaml:5`: `vram_budget_gb: 141  # physikalisches GPU-Gesamtbudget (H200 141 GB)`, `runtime_config.yaml:6`: `vram_safety_margin_gb: 8`.
`model_manifest.json` → `runtime.vramBudgetGb: 48`, `vramSafetyMarginGb: 6`.

Damit existieren zwei konfigurierbare VRAM-Budgets mit unterschiedlichem Wert und unterschiedlicher Margin. `startup.sh:2` deklariert „env hat Vorrang", `registry.py:57-58`/`registry.py:145-160` zeigt, dass die Rolle das Runtime-Budget übersteuern darf (`_ROLE_RUNTIME_KEYS` in `registry.py:46-54` enthält `vramBudgetGb`, `vramSafetyMarginGb`) — die yaml-Werte sind also ein dritter Kandidat derselben Größe, ohne Auflösungsregel zwischen yaml und Manifest.

> **Nachtrag 2026-09-20 (INFRA-RUNPOD-006): erledigt.** `runtime_config.yaml` ist entfernt; das VRAM-Budget hat genau EINE Quelle: `model_manifest.json` `runtime.vramBudgetGb` (Flotten-Default), je Rolle überschrieben durch `roles.<rolle>.vramBudgetGb` (`registry.py` `_ROLE_RUNTIME_KEYS` → `model_manager.py configure()`). Die Regel steht als `runtime.vramBudgetNote` im Manifest, als Kommentar in `configure()` und in `services/audiomonastry-ai-runtime/README.md`. Die Abschnitte dieses Audits bleiben als Beleg für den Zustand vom Audit-Datum stehen.

### 3.5 Befund V1-3 (NIEDRIG) — Rest-Doku verweist auf H200-Hardware, die nicht mehr die Zielplattform ist

`runtime_config.yaml:5` (H200 141 GB), `registry.py:175` („z. B. der bestehende H200-Endpoint"), `handlers_runpod.py:14` („auf einer echten GPU (RunPod H200) verifiziert"). Kein live-Endpoint nutzt eine H200 (`gpuTypeIds` in Abschnitt 4). Veraltete Kommentare/Defaults, die die VRAM-Wirklichkeit (48 GB) um Faktor ~3 überschätzen.

### 3.6 `registry.py` — Rollen-Loader

`registry.py:32-41` definiert `ROLE_IDS = ("brain","ears","voiceGen","music","imageHq","videoReal","videoAbstract","orchestrator")` — 8 Rollen, deckungsgleich mit `ROLE_DEFAULTS` in `runpod-deploy.py` und mit dem `roles`-Block im Manifest. Kommentar `registry.py:21`: „Spiegel der Rollen-IDs: `src/config/aiInfrastructure.ts`", Kommentar `registry.py:31`: „muss zu GPU_ROLE_IDS im TS-Spiegel passen" → **dritte** Rollenliste (TS), siehe Abschnitt 6.

Erzwungen wird in `registry.py`:
- Revisions-Pinning: `registry.py:65-76` wirft `ValueError` bei `revision` fehlend/`null`/`latest`; `registry.py:73-76` erlaubt `TBD…` nur mit `status: "planned"`. Aufgerufen für **jedes** Modell in `read_manifest()` (`registry.py:88-92`).
- Rollen-Filter: `registry.py:95-168` validiert unbekannte Rolle (`:100-101`), unbekannte Modelle (`:112-114`), `preloadModels` außerhalb der Rolle (`:119-121`), exklusive Gruppen (`:123-143`).
- `planned`-Modelle werden ohne `AI_INCLUDE_PLANNED` übersprungen (`registry.py:57-58`, `:145-155`).

**Nicht** erzwungen: irgendeine Kosten-, Endpoint-Anzahl- oder EUR/h-Grenze (kein Vorkommen in `registry.py`; s. Abschnitt 7).

### 3.7 `model_manager.py` — siehe Abschnitt 5.4

---

## 4. V1b — Live-Enumeration (RunPod)

**Ergebnis: JA, live verifiziert.** Read-only REST-Aufruf gegen `https://rest.runpod.io/v1/endpoints` mit Bearer-Token aus `RP_API_KEY` (aus `.env` geparst, nie ausgegeben). Abfragezeitpunkt: Audit-Lauf, Konto ist erreichbar. Die Antwort enthielt **8** Endpoints; Pflichtfelder ausgewertet, Token-/Secret-artige Felder nicht angezeigt.

### 4.1 Wörtliche Antwort (auf Felder reduziert, sonst unverändert)

```json
[
 {"id":"6ghy4fh00zb0j9","name":"audiomonastry-ai-video-real","templateId":"bgh1bodyeq","gpuTypeIds":["NVIDIA GeForce RTX 4090","NVIDIA GeForce RTX 5090"],"workersMin":0,"workersMax":1,"idleTimeout":120,"networkVolumeId":"","scalerType":"QUEUE_DELAY","scalerValue":4,"locations":null},
 {"id":"fogwdyxp1zj8zv","name":"audiomonastry-ai-video-abstract","templateId":"1pip14re7h","gpuTypeIds":["NVIDIA GeForce RTX 4090"],"workersMin":0,"workersMax":1,"idleTimeout":120,"networkVolumeId":"","scalerType":"QUEUE_DELAY","scalerValue":4,"locations":null},
 {"id":"gajmangfldpzrk","name":"audiomonastry-ai-voice","templateId":"4kjoanoc91","gpuTypeIds":["NVIDIA A40","NVIDIA RTX A6000","NVIDIA RTX 6000 Ada Generation","NVIDIA L40","NVIDIA L40S"],"workersMin":0,"workersMax":1,"idleTimeout":120,"networkVolumeId":"","scalerType":"QUEUE_DELAY","scalerValue":4,"locations":null},
 {"id":"ppxo7wrn599p0q","name":"audiomonastry-ai-brain","templateId":"42pqqc06vb","gpuTypeIds":["NVIDIA A40","NVIDIA RTX A6000","NVIDIA RTX 6000 Ada Generation","NVIDIA L40","NVIDIA L40S"],"workersMin":0,"workersMax":1,"idleTimeout":15,"networkVolumeId":"","scalerType":"QUEUE_DELAY","scalerValue":4,"locations":null},
 {"id":"vsbjhw0nnnb47e","name":"audiomonastry-ai-music","templateId":"9q9c60p6xh","gpuTypeIds":["NVIDIA A40","NVIDIA RTX A6000","NVIDIA RTX 6000 Ada Generation","NVIDIA L40","NVIDIA L40S"],"workersMin":0,"workersMax":1,"idleTimeout":120,"networkVolumeId":"","scalerType":"QUEUE_DELAY","scalerValue":4,"locations":null},
 {"id":"wzh9hcbitjnn95","name":"audiomonastry-ai-image","templateId":"7xzd1v17dx","gpuTypeIds":["NVIDIA A40","NVIDIA RTX A6000","NVIDIA RTX 6000 Ada Generation","NVIDIA L40","NVIDIA L40S"],"workersMin":0,"workersMax":1,"idleTimeout":120,"networkVolumeId":"","scalerType":"QUEUE_DELAY","scalerValue":4,"locations":null},
 {"id":"xeax6xrgd0csag","name":"audiomonastry-ai-ears","templateId":"4uzprwb5x8","gpuTypeIds":["NVIDIA A40","NVIDIA RTX A6000","NVIDIA RTX 6000 Ada Generation","NVIDIA L40","NVIDIA L40S"],"workersMin":0,"workersMax":1,"idleTimeout":15,"networkVolumeId":"","scalerType":"QUEUE_DELAY","scalerValue":4,"locations":null},
 {"id":"xu4sqszdfk8lp8","name":"audiomonastry-ai-orchestrator","templateId":"9q019cos0i","gpuTypeIds":["NVIDIA A40","NVIDIA RTX A6000","NVIDIA RTX 6000 Ada Generation","NVIDIA L40","NVIDIA L40S"],"workersMin":0,"workersMax":1,"idleTimeout":120,"networkVolumeId":"","scalerType":"QUEUE_DELAY","scalerValue":4,"locations":null}
]
```

### 4.2 Live-Befunde

- **8 Endpoints live**, alle `workersMin: 0` / `workersMax: 1` → **alle scale-to-zero**, kein Endpoint läuft dauerhaft warm. Alle `scalerType: QUEUE_DELAY`, `scalerValue: 4`.
- **`networkVolumeId` ist bei allen 8 Endpoints leer** → kein Network Volume gebunden; Container-Disk-Persistenz. Relevant für Cold-Start/Kaltstart-Kosten (jeder Kaltstart lädt Gewichte neu, wenn kein Volume/Image-Cache greift). Der im Deploy-Skript-Header dokumentierte Volumen-Bedarf (50–200 GB je Rolle, `runpod-deploy.py:9-16`) ist live **nicht** als Volume erkennbar.
- **Live-1 (HOCH): Kostenkonstitution ist live bereits gebrochen.** 8 Endpoints gegen „max. 4" (`architectureDecisions[8]`) bzw. 5 (`budget.fleetEndpointsMax`) — die Flotte liegt beim 1,6- bis 2,0-fachen der dokumentierten Obergrenze.
- **Live-2 (HOCH): `idleTimeout` live weicht von der deklarierten Rolle ab.** Deploy-Header `runpod-deploy.py:11-16` deklariert voiceGen/music/imageHq/videoReal/videoAbstract/orchestrator je 900 s; live stehen dort **120 s**. Nur brain/ears stimmen (15 s deklariert, 15 s live). Das deckt sich mit dem in `budget.runpodIdleTimeouts` dokumentierten Verhalten („die API setzt idleTimeout nur beim ANLEGEN … scripts/runpod-deploy.py meldet Abweichungen deshalb jetzt als Warnung"). Der dokumentierte 900-s-Vorsatz ist damit für 6 von 8 Rollen **nicht** in der Realität.
- **Live-3 (MITTEL): `wzh9hcbitjnn95` heißt live `audiomonastry-ai-image`** — Name und ID stimmen mit `runpod-deploy.py:113` (`suffix: "image"`) überein, nicht mit `visionLive.endpointName` (`audiomonastry-ai-vision`). Die Template-ID `7xzd1v17dx` entspricht exakt dem in `visionLive.templateId` dokumentierten Wert → derselbe Endpoint, umbenannt.
- **Live-4 (MITTEL): Der GPU-Pool ist live breiter als der Pool-Name suggeriert.** Für die sieben `AMPERE_48`-Rollen listet die API `NVIDIA A40`/`A6000` (Ampere) **plus** `RTX 6000 Ada`/`L40`/`L40S` (Ada/Lovelace/Ada) → sechs Klassen unter einem Namen. Eine VRAM- und Leistungsplanung „AMPERE_48" ist damit nicht auf eine GPU-Klasse pinnen.
- **Live-5 (NIEDRIG): `locations: null`** bei allen Endpoints → keine Region-/Rechenzentrums-Bindung sichtbar; Cold-Start-Streuung und Latenz sind damit nicht deterministisch planbar.
- Der in `visionLive.note` erwähnte Alt-Endpoint `4gts9y4zph7ik9` taucht live **nicht** auf → die dokumentierte Löschung ist konsistent mit dem Live-Stand.

### 4.3 Abgleich Live ↔ Code ↔ SSOT (Kurzmatrix)

| Rolle | Code-ID/Name-Quelle | SSOT erwartet | Live vorhanden | Abweichung |
|---|---|---|---|---|
| brain | `runpod-deploy.py:96` | „live" (`fundamentals`) | `ppxo7wrn599p0q` | idle 15 s ✓ |
| ears | `runpod-deploy.py:100` | „live" | `xeax6xrgd0csag` | idle 15 s ✓ |
| voiceGen | `runpod-deploy.py:104` | „live" | `gajmangfldpzrk` | idle 120 s statt 900 s |
| vision/imageHq | `runpod-deploy.py:113` (image) | `visionLive` = „geplant"/vision | `wzh9hcbitjnn95` | **Name divergiert** (image vs. vision) |
| videoReal | `runpod-deploy.py:120` | „video (Wan2.2)" in `budget` | `6ghy4fh00zb0j9` | Pool ADA vs. Manifest AMPERE_48 |
| videoAbstract | `runpod-deploy.py:129` | nicht erwähnt in `fundamentals` | `fogwdyxp1zj8zv` | Pool ADA vs. Manifest AMPERE_48 |
| music | `runpod-deploy.py:108` | nur in `budget.fleetEndpointsNote` implizit | `vsbjhw0nnnb47e` | nicht in `fundamentals` |
| orchestrator | `runpod-deploy.py:134` | **nirgends in der SSOT erwähnt** | `xu4sqszdfk8lp8` | SSOT-Lücke |

---

## 5. V2 — Worker-Integration

### 5.1 Bausteine

| Datei | Rolle im Worker |
|---|---|
| `services/audiomonastry-ai-runtime/runpod_worker.py` | Serverless-Einstiegspunkt: `handler(job)`, Rollen-Env, Warmup/Predownload-Sondertasks |
| `services/audiomonastry-ai-runtime/handlers.py` | eigentliche Task-Implementierungen (`run_inference`, gerufen von `model_manager.infer()`, `model_manager.py:416-418`) |
| `services/audiomonastry-ai-runtime/handlers_runpod.py` | zusätzliche GPU-Handler (LLM, Audio-Understanding, TTS, ACE-Step, Demucs, PyAnnote) |
| `services/audiomonastry-ai-runtime/startup.sh` | Startup für den **Nicht**-Serverless-Pfad (`uvicorn app:app`, `startup.sh:32-36`) |
| `services/audiomonastry-ai-runtime/app.py` | FastAPI-App (`app:app`) |
| `services/audiomonastry-ai-runtime/Dockerfile.runpod` | Serverless-Image, `ENTRYPOINT ["python", "runpod_worker.py"]` (`Dockerfile.runpod:135`) |

**Befund V2-1 (MITTEL) — `runtime_config.yaml` ist im Serverless-Betrieb toter Ballast.** Die Datei wird ins Image kopiert (`Dockerfile.runpod:128`), aber kein Worker-Skript liest sie: in `runpod_worker.py`, `model_manager.py`, `registry.py` und `app.py` gibt es kein Vorkommen von `runtime_config`. Der dokumentierte Wert `vram_budget_gb: 141` (`runtime_config.yaml:5`) erreicht damit nie den Serverless-Worker. `startup.sh:2` behauptet „Wird beim Container-Start von startup.sh gelesen" — `startup.sh` selbst liest die Datei ebenfalls nicht, es setzt nur Env (`startup.sh:17-26`). Ein `grep -rn "runtime_config"` über `services/audiomonastry-ai-runtime/` liefert als einzigen Treffer den Kommentar `startup.sh:3` — weder `app.py` noch ein Worker-Skript referenziert die Datei.

> **Nachtrag 2026-09-20 (INFRA-RUNPOD-006): erledigt (Variante „entfernen").** Die Datei ist gelöscht, ihre `COPY`-Zeilen und die `chown *.yaml`-Globs in `Dockerfile.runpod`/`Dockerfile`/`Dockerfile.manifest` sind bereinigt, und der `startup.sh`-Kopfkommentar sagt jetzt die Wahrheit (nur Umgebung; VRAM-Budget aus dem Manifest, siehe Nachtrag zu V1-2).

### 5.2 Handler-Vertrag (`runpod_worker.py`)

Dokumentierter Input (Docstring `runpod_worker.py:7-12`) und tatsächlich gelesener Input (`runpod_worker.py:339-347`):

```json
{"input": {"task": "...", "model": "...", "input": { ...modellspezifisch... }}}
```

- `job["input"]` muss Objekt sein, sonst `INVALID_JOB`/`INVALID_INPUT` (`runpod_worker.py:336-341`).
- `input.input` muss Objekt sein, sonst `INVALID_PAYLOAD` (`runpod_worker.py:346-347`).
- `task` gegen `_SAFE_TASK_RE` (`runpod_worker.py:59, 349-350`) → `INVALID_TASK`.
- `model` gegen `_SAFE_MODEL_RE` (`runpod_worker.py:60, 372-373`) → `INVALID_MODEL`.

Output Erfolg (`runpod_worker.py:383-389`): `{"status":"success","task","model","result","durationMs"}`.
Output Fehler: immer `{"status":"error","code":…,"message":…}`; Codes `INVALID_JOB|INVALID_INPUT|INVALID_PAYLOAD|INVALID_TASK|INVALID_MODEL|MODEL_UNAVAILABLE|WARMUP_FAILED|PREDOWNLOAD_FAILED|INFERENCE_FAILED|HF_HUB_MISSING` (`runpod_worker.py:337-407`, `:179`).

**Befund V2-2 (MITTEL) — Fehlerdetails sind per Default unterdrückt.** `_with_detail()` hängt die echte Exception nur bei `AI_RUNTIME_DEBUG` an (`runpod_worker.py:81-94`), Default AUS (Kommentar `:88-91`). Der Deploy setzt `AI_RUNTIME_DEBUG` aus `env("AI_RUNTIME_DEBUG","0")` (`runpod-deploy.py:206`) → im Live-Betrieb bleibt nur der generische Code. Details gehen nach stdout (`runpod_worker.py:78`, `flush=True`) und sind damit nur über die RunPod-Container-Konsole einsehbar — genau der Fall, den der eigene Kommentar `runpod_worker.py:397-401` beschreibt.

### 5.3 Rollen-Umschaltung

- Rolle aus `AI_ROLE` (`runpod_worker.py:97-102`); leere Rolle = Legacy-Single-Endpoint, unbekannte Rolle ⇒ `ValueError` mit Liste der `ROLE_IDS`.
- `_init_manager()` (`runpod_worker.py:105-122`) lädt `load_manifest(role or None)` und ruft `manager.configure(manifest)`; bei Fehler `FATAL` + `_ready=False`.
- `main()` beendet den Prozess mit Exit-Code 2, wenn der Manager nicht initialisiert wurde (`runpod_worker.py:416-418`) → RunPod sieht einen Crash statt eines falsch bedienten Workers. **Das ist eine echte Durchsetzung der Rolle auf Worker-Ebene.**
- Der Worker erzwingt **nicht**, dass ein Task zur Rolle passt: `handler()` reicht `task` unverändert an `manager.infer()` (`runpod_worker.py:380`). Die Grenze entsteht nur indirekt über `manager.load(model)` → `ModelUnavailableError("unknown model")` (`model_manager.py:248-250`), weil `configure()` nur die Modelle der Rolle ablegt (`model_manager.py:195-198`).

**Befund V2-3 (MITTEL) — der dokumentierte Rollen→Task-Vertrag wird nicht geprüft.** Docstring `runpod_worker.py:14-18` behauptet „brain → llm, nlu / ears → audio.* / voiceGen → tts/sing/song/generate/stem.separate". Im Worker existiert dazu keine Prüfung (nur die Regex-Validierung der Strings). Die disjunkte Task-Zuordnung lebt ausschließlich clientseitig (`endpointRegistry.ts:60-232` `tasks:`-Felder, `canRun()` in `runpodProvider.ts:147-149`). Ein direkter API-Aufruf am Client vorbei kann einen Task auf einen Worker schicken, der ihn nicht bedienen soll.

**Befund V2-4 (NIEDRIG) — `Dockerfile.runpod` beschreibt noch 3 Rollen.** `Dockerfile.runpod:3-7`: „Ein Image für alle drei Flotten-Rollen (brain | ears | voiceGen)". Tatsächlich spiegelt das Image 8 Rollen (`registry.py:32-41`); der Deploy nutzt es laut `runpod-deploy.py:37-39` für `ears`, `voiceGen`, `orchestrator`. Brain läuft auf einem fremden vLLM-Image (`runpod-deploy.py:40-41, 158-162`).

### 5.4 `model_manager.py` — Load/Evict/VRAM

- `configure()` übernimmt `vramBudgetGb`/`vramSafetyMarginGb` aus dem Manifest (`model_manager.py:190-192`) und legt **nur** die Modelle des gefilterten Manifests an (`:195-198`).
- VRAM-Regel: `_available_vram_gb() = budget − used − safetyMargin` (`model_manager.py:220-221`), Prüfung vor jedem Load (`:296-307`).
- LRU-Eviction **nie CORE** (`model_manager.py:312-325`), ein Retry, danach `ModelUnavailableError("VRAM exhausted…")` statt OOM-Crash (`:301-307`).
- Exklusive Gruppen: Geschwister werden vor dem Laden entladen (`model_manager.py:281-294`), Startbelegung aus dem Rollen-Block (`:199-205`), `preload()` überspringt nicht-aktive Gruppenmitglieder (`:236-240`).

**Befund V2-5 (MITTEL) — parallele identische Loads sind ein Fehler, keine Dedup.** `model_manager.py:254-255` wirft `ModelUnavailableError("model already loading")`, wenn dasselbe Modell gerade lädt; der Docstring `model_manager.py:10` behauptet dagegen „Parallele identische Load-Requests werden dedupliziert (loading-Set)". Dedupliziert wird nur die Buchhaltung — der zweite Aufrufer (z. B. ein `warmup`-Job parallel zur ersten echten Inferenz, bei `maxConcurrentInference: 2` für ears/orchestrator) erhält einen sichtbaren Fehler.

**Befund V2-6 (MITTEL) — der Modell-`timeout` aus dem Manifest wird nie durchgesetzt.** `ModelDefinition.timeout` wird geparst (`model_manager.py:89, 156`) und je Modell gepflegt (z. B. `stable-audio-open-1.0` timeout 300 im Manifest), aber im Worker nirgends verwendet. Die einzige Zeitgrenze ist aufruferseitig: `RUNPOD_AI_TASK_TIMEOUT_MS` Default 600 000 ms (`runpodProvider.ts:134-136`). Ein hängender Load/Inferenz blockiert bis zu diesem Wert, nicht bis zum deklarierten Modell-Timeout.

### 5.5 Idempotenz im Worker

**Befund V2-7 (NIEDRIG) — die zwei Sondertasks sind unterschiedlich streng idempotent.**
- `predownload`: idempotent über Modul-Flag `_predownload_done` (`runpod_worker.py:66-67, 168-174, 225`).
- `warmup`: **nicht** idempotent — läuft jedes Mal vollständig durch, inkl. Mini-Inferenz je Textmodell (`runpod_worker.py:262-303`), und wird per `/run` eingereiht (`runpodProvider.ts:233-256`). Ein wiederholtes `wakeFleet()` erzeugt neue Warmup-Jobs; ein In-Flight-Guard existiert nur für den Wake selbst (`fleetWake.ts:185-197`).
- Inferenz-Jobs: Idempotenz liegt nur app-seitig (`aiOrchestrator.ts:30-35`, `idempotencyKey`), nicht im Worker. Der Handler ist zustandslos, das Risiko beschränkt sich damit auf Doppel-Kosten, nicht auf inkonsistenten Zustand.

### 5.6 `handlers_runpod.py`

- Lazy-Imports (`_require_lib`, `handlers_runpod.py:33-37`); fehlende Abhängigkeit ⇒ `ModelUnavailableError` mit pip-Hinweis.
- Eigener LRU-Modell-Cache mit 4 Einträgen (`handlers_runpod.py:29-30, 45-54`) **zusätzlich** zum Instanz-Cache des ModelManagers (`model_manager.py:178-180, 276-279`) → zwei Caches für dieselben Gewichte.
- Kopf-Kommentar `handlers_runpod.py:13-15` nennt „RunPod H200" als Verifikationsziel (Befund V1-3) und listet `qwen3_llm (Qwen3-14B)` (`:6`) sowie `xtts_tts (XTTS-v2)` (`:8`) — weder `qwen3-14b` noch `xtts-v2` existieren in den 39 Manifest-Einträgen.

---

## 6. V3 — App-Code-Integration

### 6.1 Rolle → Route → Endpoint

| Rolle | Endpoint-ID-Feld | Genutzt von | Datei:Zeile |
|---|---|---|---|
| brain | `RP_ENDPOINT_ID_BRAIN` | `LlmRouter` (primärer LLM-Provider) + `ProviderRouter` (Task `llm`) | `endpointRegistry.ts:65`; `LlmRouter.ts:273-275, 370-375`; `providerRouter.ts:63, 80-86` |
| ears | `RP_ENDPOINT_ID_EARS` | `mediaRoutes` (Audio-Suche), `scripts/index-sample-audio-embeddings.ts` | `mediaRoutes.ts:120, 124`; `index-sample-audio-embeddings.ts:67` |
| voiceGen | `RP_ENDPOINT_ID_VOICE` | `ProviderRouter` via `aiOrchestrator`/`VoiceControlService` | `endpointRegistry.ts:115`; `VoiceControlService.ts:57-58` |
| music | `RP_ENDPOINT_ID_MUSIC` | `ProviderRouter` (Task `song`/`sing`) | `endpointRegistry.ts:132, 136` |
| imageHq | `RP_ENDPOINT_ID_IMAGE` | `runpodVision.generateVisionImage`, `aiRoutes` | `runpodVision.ts:50`; `aiRoutes.ts:40` |
| videoReal | `RP_ENDPOINT_ID_VIDEO_REAL` | `runpodVideo.generateVideo`, `aiRoutes` | `runpodVideo.ts:54`; `aiRoutes.ts:39` |
| videoAbstract | `RP_ENDPOINT_ID_VIDEO_ABSTRACT` | über `ProviderRouter` (Task `video.abstract`) | `endpointRegistry.ts:196, 200` |
| orchestrator | `RP_ENDPOINT_ID_ORCHESTRATOR` | `ProviderRouter` (Task `agent.orchestrate`) | `endpointRegistry.ts:216, 220` |

Auflösung: `resolveGpuRoles()` liest je Rolle `env(endpointIdEnv) || env(endpointIdEnv.replace(/^RP_/,'RUNPOD_'))` (`endpointRegistry.ts:293-307`) — `RP_ENDPOINT_ID_X` **und** `RUNPOD_ENDPOINT_ID_X` werden akzeptiert. Fehlt beides, fällt jede Rolle auf `RP_ENDPOINT_ID`/`RUNPOD_ENDPOINT_ID` zurück und loggt eine Warnung (`endpointRegistry.ts:294-305`).

**Befund V3-1 (HOCH) — der Legacy-Fallback kann alle acht Rollen auf eine einzige ID biegen.** `resolveGpuRoles()` liefert bei fehlenden Rollen-IDs für alle 8 Rollen dieselbe `legacy`-ID (`endpointRegistry.ts:294, 298-305`). Dann ist `RunPodProvider.available` für jede Rolle `true` (`runpodProvider.ts:142-144`), und `ProviderRouter.candidates()` (`providerRouter.ts:113-115`) akzeptiert jeden Provider, dessen `canRun(task)` passt — acht Provider auf derselben Ziel-ID, aber mit acht unterschiedlichen Provider-IDs und Kostenschätzungen (`runpodProvider.ts:38-59`). Es gibt keinen Wächter, der „Rolle X zeigt auf den Endpoint von Rolle Y" erkennt.

**Befund V3-2 (MITTEL) — die konfigurierte ID wird nie gegen den Endpoint-Namen geprüft.** `endpointNameForRole()` existiert als Namenskonvention (`aiInfrastructure.ts:110-123`), wird aber nirgends gegen eine Live-Antwort abgeglichen. Genau deshalb konnte live `RP_ENDPOINT_ID_IMAGE` auf `audiomonastry-ai-image` zeigen, während die SSOT `audiomonastry-ai-vision` dokumentiert (Befund S-3), ohne dass ein Test anschlägt.

### 6.2 Aufrufmechanik (`runpodProvider.ts`)

- API-Basis `https://api.runpod.ai/v2` (`runpodProvider.ts:35, 102-104`), überschreibbar per `RUNPOD_API_BASE`.
- Kurze Tasks → `POST /runsync` (`:169`); lange Tasks → `POST /run` + Polling `GET /status/{id}` (`:165-166, 213-226, 342-372`). Long-Running-Menge: `llm, song, sing, audio.generate, stem.separate, image.generate, video.generate, video.abstract` (`endpointRegistry.ts:243-254`).
- Kaltstart: `runsync` mit `IN_QUEUE`/`IN_PROGRESS` wird weitergerollt statt verworfen (`runpodProvider.ts:69-72, 174-179`).
- Retry: 3 Versuche, Backoff 1 s/2 s (`:295-309`); nicht-retrybare Fehler brechen sofort ab (`:306`).
- HTTP-Mapping: `402 → INSUFFICIENT_CREDIT` (nicht retrybar), `429 → RATE_LIMITED` (retrybar), sonst `HTTP_<status>` (`:329-338`).
- Worker-Fehlerabbildung: `MODEL_UNAVAILABLE`, `INVALID_TASK`, `INVALID_MODEL` **nicht** retrybar, alle anderen Worker-Codes retrybar (`:280-284`).

### 6.3 Ausfallverhalten

- **Provider-Fallback:** `ProviderRouter.run()` iteriert die Kandidaten (`providerRouter.ts:91-105`); nach dem Rollen-Provider folgen `CerebrasProvider` und `LocalProvider` (`providerRouter.ts:62-64`), ein Circuit Breaker je Provider (`:96, :99`). Alle fehlgeschlagen ⇒ `ALL_PROVIDERS_FAILED` (`:105`).
- **Task `llm`** umgeht die Provider-Liste und geht über `llmRouter.complete()` (`providerRouter.ts:80-86`); dort Rangfolge `runpod-local → ollama → externe` (`LlmRouter.ts:437-449`), externe nur mit `AI_ALLOW_EXTERNAL_LLM=true` (`:444-446`).
- **Queue/Concurrency/Timeout/Cancellation:** app-seitig in `AiJobRuntime` (`aiOrchestrator.ts:62-73`), Defaults `maxConcurrent: 4` und `AI_JOB_TIMEOUT_MS ?? 120_000` (`aiOrchestrator.ts:69-72`). Idle legt die Flotte schlafen: `SessionManager.onScaleToZero → sleepFleet()` (`aiOrchestrator.ts:75-80`).
- **Wake:** `POST /api/ai/fleet/wake`, `/sleep`, `GET /api/ai/fleet/status` (`aiRoutes.ts:763-780`).
- **Ausfall einer Rolle ohne Endpoint-ID:** `unconfiguredStatus()` (`fleetWake.ts:146-156`); `roleReady()` liefert für nicht-konfigurierte Rollen `true` (`fleetWake.ts:180`).
- **Sleep-Erfolg:** `ok` nur wenn für jede konfigurierte Rolle `workersMin=0` gesetzt werden konnte (`fleetWake.ts:257-258`).

**Befund V3-3 (MITTEL) — `roleReady()` maskiert fehlende Konfiguration als Erfolg.** `fleetWake.ts:179-183`: `if (!status.configured) return true;`. Mit `const ok = roles.every(roleReady)` (`fleetWake.ts:215`) meldet `/api/ai/fleet/wake` `ok: true`, auch wenn Rollen gar nicht angesprochen wurden — der Bericht ist damit kein Beleg dafür, dass die Flotte wach ist. Das Detail steht nur im Log (`fleetWake.ts:220`) und im `roles[]`-Feld.

**Befund V3-4 (MITTEL) — `wakeFleet()` weckt immer die komplette Flotte, ohne Kosten-Gate.** `resolveGpuRoles()` liefert alle acht Rollen, `Promise.all(resolved.map(wakeRole))` (`fleetWake.ts:201, 213`) setzt für jede `workersMin=1`, unabhängig vom anstehenden Task. Jeder geweckte Worker läuft danach mindestens `idleTimeout` Sekunden weiter (live 15 s bzw. 120 s, Abschnitt 4) und wird abgerechnet. Es gibt keinen rollenselektiven Wake-Einstiegspunkt und keine Prüfung gegen `AI_MAX_FLEET_EUR_PER_HOUR` vor dem Wecken.

> **KORREKTUR 2026-09-23 (Iteration 5) — dieser Befund ist BEHOBEN.** Der Abschnitt
> ist eine Momentaufnahme von vor dem Fix und sagt das selbst nicht; wer nur diese
> Datei liest, hält ein geschlossenes Loch für offen. Stand heute:
> `src/core/ai/orchestrator/fleetWake.ts:341` ruft `assertFleetHourlyBudget(toWakeRoles,
> AI_HETZNER_EUR_PER_HOUR)` **vor** dem ersten Netzwerkaufruf auf; bei
> Überschreitung startet nichts, der Bericht trägt `blocked: "budget"` und
> `POST /api/ai/fleet/wake` antwortet **409**. `wakeFleet()` weckt außerdem nur noch
> die Immer-Rollen, Visuals laufen über `wakeRoleOnDemand` beim Abruf. Belegt in
> `MASTERTODOENDE.json` (DONE 2026-09-20) und in `tests/aiInfrastructure.test.ts`.
> **Der strukturelle Teil des Befunds bleibt gültig und ist offen:** ein
> `workersMax` ist für keinen der acht Endpunkte gesetzt (Abschnitt 4 zeigt nur
> `n: 1` als Minimum), und `AI_RATE_CONCURRENCY_MAX` wird zwar gelesen, aber von
> keiner Produktionsdatei durchgesetzt — die Parallelität begrenzt der EUR/h-Wächter
> nicht. Details: `docs/SEC_BLOCK2_ATTACKS.md`, Angriff 1.


### 6.4 Vision-/Video-Pfade (Sonderweg außerhalb der Rollen-Registry)

`runpodVision.ts:50` und `runpodVideo.ts:54` lösen ihre Endpoint-ID direkt über `resolveGpuRoles().find(r => r.role === 'imageHq' | 'videoReal').endpointId` auf — **nicht** über `RunPodProvider`, mit eigenem HTTP-Pfad in je ~150 Zeilen.

**Befund V3-5 (MITTEL) — Visual-Endpoints haben keinen gemeinsamen Ausfall-Pfad.** `providerRouter.ts:63` instanziiert `RunPodProvider` für alle Rollen inkl. `imageHq`/`videoReal`/`videoAbstract`; der Vision-/Video-Pfad der Routen (`aiRoutes.ts:39-40`) geht daran vorbei. Ein RunPod-Ausfall (402/429/Timeout) wird dort je nach Client anders behandelt, und der Circuit Breaker aus `providerRouter.ts:96-99` greift für diese Aufrufe nicht.

### 6.5 Befund V3-6 (HOCH) — die Brain-Rolle hat drei divergente Modell-Identitäten

| Quelle | Modellname | Datei:Zeile |
|---|---|---|
| Live-Endpoint `ppxo7wrn599p0q` (vLLM) | `Qwen/Qwen3-14B-AWQ` | `MASTERTODOENDE.json:1515` (dokumentiert), `LlmRouter.ts:75`, `runpod-deploy.py:161` |
| `LlmRouter` nativer Worker-Pfad, Default | `qwen3-14b` | `LlmRouter.ts:86, 318` |
| Manifest/Rollen-Registry `brain` | `qwen3-30b-a3b-awq` (+ `qwen3-4b`) | `model_manifest.json` roles.brain.preloadModels; `endpointRegistry.ts:77-79` |

Die SSOT (`fundamentals.aiFleet`) und die Doku nennen „Qwen3-14B-AWQ", das Manifest führt für die Rolle `brain` **kein** 14B-Modell (die 39 Einträge enthalten `qwen3-4b`, `qwen3-8b`, `qwen3-30b-a3b`, `qwen3-30b-a3b-awq`, `phi-35-mini`, `ministral-8b` — kein `qwen3-14b`). Auch `Dockerfile.runpod:85` und `.github/workflows/runpod-deploy.yml:117-119` prüfen beim Build `Qwen/Qwen3-14B`. Der Kurzname `qwen3-14b` in `LlmRouter.ts:86` hat im Manifest keinen Eintrag und würde im nativen Worker-Pfad an `model_manager.load()` mit `ModelUnavailableError("unknown model")` scheitern (`model_manager.py:248-250`). Der native Pfad ist damit nur zufällig ungenutzt (weil `RP_BRAIN_OPENAI_URL` gesetzt ist, `LlmRouter.ts:286-288`).

### 6.6 Befund V3-7 (MITTEL) — Durchsetzung der Kostengrenze ist selbstneutralisierend

- `assertGpuEndpointBudget()` wird als „Harte Kostenregel" im Konstruktor von `ProviderRouter` aufgerufen (`providerRouter.ts:65-71`, Kommentar `:70`).
- Die geprüfte Zahl ist aber `AI_MAX_GPU_ENDPOINTS`, und deren Default ist `GPU_ENDPOINT_ROLES.length` = **8** (`aiInfrastructure.ts:75`). Der Wächter prüft nur `1 ≤ max ≤ 8` (`aiInfrastructure.ts:130-136`) — genau der Wert, der per Default gesetzt ist. Die Prüfung kann für die eigene Architektur also nie auslösen; sie prüft nur sich selbst.
- `assertFleetHourlyBudget()` (`aiInfrastructure.ts:148-156`) ist definiert und getestet (`tests/aiInfrastructure.test.ts:73-80`), wird aber **nirgends in `src/` oder `server/` aufgerufen** (Vorkommen nur in `aiInfrastructure.ts` und in Tests) → toter Wächter.
- `assertStorageBudget()` (`aiInfrastructure.ts:159-169`) ebenso: nur Definition + Test (`tests/aiInfrastructure.test.ts:84-86`).
- Die Flotten-Summe ist ohnehin unkritisch gegen das eigene Budget: 8 Rollen × 0,49 €/h = 3,92 €/h (`aiInfrastructure.ts:87-96`) gegen `AI_MAX_FLEET_EUR_PER_HOUR = 10` (`:78`). Der EUR/h-Deckel kann bei 8 Rollen strukturell nicht reißen.

---

## 7. V4 — System-Integration

### 7.1 Health/Smoke

**`scripts/runpod-smoke.py`** (223 Zeilen) ist der Health-/Smoke-Pfad. Verdrahtung:
- Aufruf über `npm run runpod:smoke` (`package.json:47`).
- Key: `RP_AGENT_KEY` → `RP_API_KEY` → `RUNPOD_API_KEY` (`runpod-smoke.py:97`).
- Endpoint-ID rollenselektiv über `ROLE_ENDPOINT_ENV` (`runpod-smoke.py:77-86`) — deckungsgleich mit `ENDPOINT_ENV_BY_ROLE` (`runpod-deploy.py:144-153`) und `endpointIdEnv` (`endpointRegistry.ts:65 ff.`). Fallback auf `RP_ENDPOINT_ID`/`RUNPOD_ENDPOINT_ID` (`runpod-smoke.py:102`).
- Smoke-Variablen: `RUNPOD_SMOKE_ROLE`, `RUNPOD_SMOKE_TASK`, `RUNPOD_SMOKE_MODEL`, `RUNPOD_SMOKE_WAV`, `RUNPOD_SMOKE_PAYLOAD`, `RUNPOD_POLL_SECONDS` (`runpod-smoke.py:12-20, 98-110`).
- Ergebnis wird sofort nach `logs/runpod-smoke-<timestamp>.json` persistiert (`runpod-smoke.py:182-197`) — Begründung im Docstring `:6-7` („RunPod bereinigt Job-Datensätze nach kurzer Zeit").
- Exit-Codes dokumentiert `runpod-smoke.py:25-31`.
- **Stärke:** ein `COMPLETED`-Job mit Fehler-Output wird als Fehler erkannt (`runpod-smoke.py:204-216`, Exit-Code 5) — genau die Lücke, die 2026-09-12 einen kaputten TTS-Pfad als „grün" gemeldet hat.

**Befund V4-1 (MITTEL) — der Smoke kann für vier von acht Rollen „grün" ohne jede Modellprüfung zurückgeben.** `runpod-smoke.py:118-123`: für `music`, `imageHq`, `videoReal`, `videoAbstract` ohne `RUNPOD_SMOKE_TASK` wird kein Job gefeuert, sondern nur die Endpoint-ID gedruckt und **Exit-Code 0** zurückgegeben. `WARMUP_ROLES` (`runpod-smoke.py:93`) enthält nur `brain, ears, voiceGen, orchestrator`. Ein `RUNPOD_SMOKE_ROLE=imageHq python3 scripts/runpod-smoke.py` ist damit grün, ohne dass der Endpoint überhaupt angesprochen wurde.

### 7.2 Deployment

**`scripts/runpod-deploy.py`** (614 Zeilen) ist der einzige Deployer der Flotte.
- Rollen-Matrix `ROLE_DEFAULTS` (`runpod-deploy.py:94-137`), Bildquellen je Rolle (`:37-47`), `PREBUILT_IMAGES` (`:166-182`).
- **Idempotenz:** `save_template()` listet vorhandene Templates und aktualisiert statt neu anzulegen (`runpod-deploy.py:385-455`, Kommentar `:393`); Endpoint-Existenzprüfung über `runpod.get_endpoints()` (`:491-509`), Update statt Create (`:493-496`).
- Idle-Drift wird als Warnung gemeldet (`runpod-deploy.py:497-507`), weil „die API `idleTimeout` nur beim ANLEGEN setzt".
- Erzeugung: `scaler_type="QUEUE_DELAY"`, `scaler_value=4`, `workers_min` aus Env (Default 0), `workers_max` Default 1, `flashboot=False` (`runpod-deploy.py:519-523`).
- Registry-Auth für das private GHCR-Image wird angelegt bzw. wiederverwendet (`runpod-deploy.py:355-382`), Warnung statt Abbruch wenn keine Credentials (`:370-376`).
- Legacy-Rollen-Aliase `vision→imageHq`, `video→videoReal` werden aufgelöst (`runpod-deploy.py:139-141, 561-565`) — die in der SSOT noch geführte Rolle `vision` ist damit code-seitig abgeschafft.

**Befund V4-2 (HOCH) — die CI überschreibt die GPU-Pool-Wahl global und hebt damit die Video-Rollen-Defaults auf.** `runpod-deploy.py:462`: `gpu_id = env("RUNPOD_GPU_ID") or str(defaults.get("gpuPoolId", "AMPERE_48"))` — Env gewinnt. Die Workflow-Umgebung setzt `RUNPOD_GPU_ID: AMPERE_48` **global für alle Rollen** (`.github/workflows/runpod-deploy.yml:211-212`). Ein CI-Deploy legt `videoReal`/`videoAbstract` also auf `AMPERE_48` an, obwohl `ROLE_DEFAULTS` `ADA_24` fordert (`runpod-deploy.py:120, 129`) und `tests/test_runpod_deploy_defaults.py:76-79` genau das festnagelt. Der Test bleibt grün, weil er nur die Konstante prüft, nicht die CI-Umgebung.

**Befund V4-3 (HOCH) — zwei grüne Tests kodieren widersprüchliche Hardware-Wahrheiten für dieselben Rollen.** `tests/test_runpod_deploy_defaults.py:76-79` verlangt `ADA_24` für `videoReal`/`videoAbstract`; `tests/manifestRoles.test.ts:52` verlangt `role.gpuPoolId === manifest.roles[role].gpuPoolId`, und der TS-Spiegel `endpointRegistry.ts:177, 197` führt `AMPERE_48` (ebenso `model_manifest.json:1225, 1249`). Beide Tests laufen grün, weil sie unterschiedliche Dateien prüfen — es gibt keinen Test, der Deploy-Skript und Manifest gegeneinander prüft. Genau deshalb blieb der Widerspruch aus Befund V1-1 unbemerkt.

**Befund V4-4 (MITTEL) — Einheiten-Verwechslung beim Idle-Timeout in der CI.** Der Workflow-Input heißt „Idle-Timeout in **Minuten**" mit Default `'15'` (`.github/workflows/runpod-deploy.yml:11-15`); dieselbe Zahl wird als `RUNPOD_IDLE_TIMEOUT` an das Skript gereicht (`:215`), das sie als **Sekunden** interpretiert (`runpod-deploy.py:467` `int(env(...))`, Vergleich gegen Live-Sekunden `:500-507`). Der Kommentar im Workflow nennt „15 min Untätigkeit" (`:214`), das Skript würde 15 s anfordern. Die Live-Werte (15 s brain/ears, 120 s übrige, Abschnitt 4) bestätigen Sekunden. Die Einheit ist im Repo nirgends eindeutig festgelegt.

**`services/audiomonastry-ai-runtime/hf_manage_endpoint.py`** verwaltet **HuggingFace** Inference Endpoints, nicht RunPod (`hf_manage_endpoint.py:3-20`: „Legt den Custom-Container-Endpoint `audiomonastry-ai` an", `create_inference_endpoint`-Import `:28-34`). Es ist der Rest der HF-Pilot-Infrastruktur, deren Endpunkte `audiomonastry-ai`, `-pilot`, `-clap` als Legacy geführt werden (`aiInfrastructure.ts:103-107`).

**Befund V4-5 (MITTEL) — die HF-Regel „MAXIMAL 1 A100" ist Prosa, kein Gate.** `hf_manage_endpoint.py:16-20` formuliert die Regel („nur der Endpoint `audiomonastry-ai` darf GPU betreiben", „Kein minReplicas=1"). Im Code existiert dafür keine Prüfung; die Aktionen sind `create|update|status|delete-legacy` (`hf_manage_endpoint.py:13, 149-158`). Die Grenze lebt damit in einem Docstring.

### 7.3 GHCR / Docker-Build

`.github/workflows/runpod-deploy.yml` baut und pusht das Serverless-Image:
- Trigger: Push auf `main`/`runpod-migration` bei Änderungen unter `services/audiomonastry-ai-runtime/**`, am Workflow selbst oder an `scripts/runpod-deploy.py` (`.github/workflows/runpod-deploy.yml:16-23`).
- Registry `ghcr.io`, Image-Name `audiomonastry-ai-runtime-runpod` (`:29-31`), Tags `:latest` + `:<sha>` (`:86-87`), danach Best-Effort-Öffentlichstellung (`:92-100`).
- Build-Args: `AI_INSTALL_AUDIO_AI=1`, `AI_INSTALL_VOICE_AI=1`, `AI_INSTALL_VLLM=0`, **`AI_BAKE_ROLE=` leer** (`:80-84`).
- Harte Build-Gates: `torch >= 2.6` (`:173-178`, Kommentar `:166-172`) und ein Import-Pfad-Test für `huggingface-hub < 1.0` (`Dockerfile.runpod:72-82`), dazu ein `AutoConfig`-Probe für `Qwen/Qwen3-14B` (`Dockerfile.runpod:85`; Workflow-Probe `:117-119`).

**Befund V4-6 (MITTEL) — die Gewichte werden nicht ins Image gebacken, obwohl Image und Doku das nahelegen.** `AI_BAKE_ROLE=` ist im CI leer (`.github/workflows/runpod-deploy.yml:84`), d. h. die Bake-Schritte `Dockerfile.runpod:118-121` laufen nie im CI. Der Workflow erklärt das als Betreiberentscheidung (`:67-73`, „Das Einbacken der 29,5 GB Qwen3-14B-Gewichte ist ZURUECKGEZOGEN"). Gleichzeitig trägt `Dockerfile.runpod:88-111` einen langen Begründungsblock für genau dieses Einbacken und die Prosa im Dateikopf `:3-7` beschreibt das Image als rollen-vollständig. Der im `budget.runpodCurrentImage` der SSOT genannte Image-Tag (`ghcr.io/kainplanmusic/audiomonastry-ai-runtime-runpod:f9bc71cc…`) ist zudem ein SHA-Tag, kein `latest` — die aktuelle Kopplung von Image-Tag zu Live-Endpoints ist in diesem Audit **nicht** verifiziert (die REST-Antwort liefert den Registry-Pfad nicht, s. Befund O-2).

**Befund V4-7 (NIEDRIG) — Netzwerk-Volume ist für die Rollen, die es brauchen, nicht angeschlossen.** Der Deploy bindet nur `RUNPOD_NETWORK_VOLUME_ID` aus dem Secret (`runpod-deploy.py:510`, Workflow `:216`); live ist bei **allen acht** Endpoints `networkVolumeId` leer (Abschnitt 4.2). `Dockerfile.runpod:90-94` begründet ausführlich, warum ein Volume in keinem der 18 volume-fähigen RZ nutzbar war (kein A40/A6000-Pool) und der Image-Bake stattdessen gewählt wurde — dieser Bake läuft aber nicht (V4-6). Beide Kaltstart-Minderungen sind damit live unwirksam.

### 7.4 Kosten-Guard (max. 4 Endpoints / ≤ 10 EUR/h)

**Ergebnis: nirgends technisch erzwungen.** Befunde:

| Prüfstelle | Was sie tatsächlich tut | Erzwingt die Grenze? |
|---|---|---|
| `providerRouter.ts:65-71` + `aiInfrastructure.ts:129-137` | prüft `1 ≤ AI_MAX_GPU_ENDPOINTS ≤ 8`, wobei der Default genau 8 ist | **nein** (selbstneutralisierend) |
| `aiInfrastructure.ts:148-156` `assertFleetHourlyBudget` | definiert + getestet (`tests/aiInfrastructure.test.ts:73-80`) | **nein** (kein Produktionsaufruf) |
| `aiInfrastructure.ts:159-169` `assertStorageBudget` | definiert + getestet (`tests/aiInfrastructure.test.ts:84-86`) | **nein** (kein Produktionsaufruf) |
| `scripts/runpod-deploy.py` | legt Endpoints an, wenn der Name fehlt (`:491-509`) | **nein** (keine Zählung, keine Obergrenze) |
| `scripts/runpod-smoke.py` | prüft Job-Status | **nein** |
| Monitoring/Alarme | `scripts/hetzner/prometheus-alerts.yml` (eine „AI-Kosten-Alarmregel" wird im MASTERTODOENDE-Changelog genannt) | **nicht geprüft** in diesem Audit |

**Befund V4-8 (HOCH) — die Kostenkonstitution wird nur an einer Stelle geprüft, und diese Stelle kann nicht auslösen.** Der einzige Produktions-Aufruf einer Kostenprüfung ist `assertGpuEndpointBudget()` (`providerRouter.ts:71`) mit dem Default `GPU_ENDPOINT_ROLES.length` (`aiInfrastructure.ts:75`) — siehe Abschnitt 6.6. Ein neunter Endpoint oder eine teurere GPU-Klasse löst **keinen** Fehler aus, weder beim Deploy (das Skript kennt keine Obergrenze) noch in der App (die nur Rollen-IDs zählt, nicht Endpoints im Konto).

**Befund V4-9 (MITTEL) — die Kostenschätzung im Code ist nicht an die Live-Realität gebunden.** `runpodProvider.estimateCostUsd()` rechnet pauschal `10 s × Rolle-Stundensatz`, Default 0,39 USD/h für **jede** Rolle (`runpodProvider.ts:50-62, 65, 152-156`). Real unterscheiden sich die Rollen: die Video-Endpoints laufen live auf RTX 4090/5090 (Abschnitt 4.1), für die `runpod-deploy.py:119` selbst 1,10 bzw. 1,58 USD/h nennt. Die im UI/`costTracker` gezeigte Kostenschätzung ist damit für Video-Rollen um Faktor ~3 zu niedrig — sie ist ausdrücklich als „Erfahrungswert … keine Abrechnung" deklariert (`aiInfrastructure.ts:83-86`), wird aber als Rollen-Stundensatz geführt.

---

## 8. V5 — Schwachstellen (konsolidiert)

**Single Points of Failure**
1. `RP_API_KEY`/`RP_AGENT_KEY` ist der einzige Zugang zu allen acht Endpoints und zur `workersMin`-Steuerung (`fleetWake.ts:65-67`, `runpodProvider.ts:130-132`). Läuft das Guthaben aus, sind alle Rollen gleichzeitig tot — `402 → INSUFFICIENT_CREDIT` nicht retrybar (`runpodProvider.ts:329-331`).
2. `model_manifest.json` ist für alle acht Rollen die Modell-Quelle; ein Validierungsfehler darin lässt `_init_manager()` scheitern und **jeden** Worker mit Exit-Code 2 sterben (`runpod_worker.py:105-122, 416-418`).
3. Für `brain` ist der vLLM-Fremdworker (`runpod-deploy.py:158-162`) der einzige LLM-Pfad im Default; der native Fallback würde an `qwen3-14b` scheitern (Befund V3-6).

**Hartcodierte IDs**
4. `scripts/runpod-brain-openai-test.py:19` — `ENDPOINT = "ppxo7wrn599p0q"` (entspricht live `brain`, aber ungeprüft und ungetestet gegen ein Umbenennen).
5. `scripts/runpod-brain-vllm.py:26` — `BRAIN_ENDPOINT = "ppxo7wrn599p0q"`.
6. `scripts/runpod-vision-test.py:79` — Default `5eiw6t03hjln9x`; **nicht** in der Live-Liste (Abschnitt 4.1) → verweist auf einen nicht mehr existierenden Endpoint.
7. `scripts/runpod-vllm-brain-test.py:49` — Default `bzpfqamg49bh6x`; **nicht** in der Live-Liste → ebenso veraltet.
8. `services/audiomonastry-ai-runtime/mcp_runtime.py` reicht Rollen-IDs über Env weiter (`runpod-deploy.py:220-227`), was überall gleichzeitig falsch sein kann (Befund V3-1).

**Doppelte/divergente Konfigurationsquellen (ID vs. OpenAI-Base-URL, Rolle, GPU-Pool, VRAM)**
9. Rolle+Preload existieren **vierfach**: `model_manifest.json roles` (Preload-Modelle + VRAM), `src/config/aiInfrastructure.ts:40-123` (Rollenliste + Namenskonvention), `src/core/ai/orchestrator/endpointRegistry.ts:60-232` (Preload + `gpuPoolId` + Tasks) und `scripts/runpod-deploy.py:94-137` (GPU-Pool + Idle + Disk + Bild). Nur zwei Paare sind durch Tests gekoppelt (TS↔Manifest via `tests/manifestRoles.test.ts:43-74`; Deploy-Konstanten gegen sich selbst via `tests/test_runpod_deploy_defaults.py`). Das Deploy-Skript ist gegen das Manifest **ungeprüft** → Befund V1-1/V4-3.
10. GPU-Pool: `ADA_24` (deploy + Test) vs. `AMPERE_48` (Manifest, TS-Spiegel) vs. globales CI-Env `AMPERE_48` (Befund V4-2).
11. VRAM-Budget: `runtime_config.yaml:5-6` (141 GB/8 GB) vs. `model_manifest.json runtime` (48 GB/6 GB) vs. `endpointRegistry.ts:68, 88, 118…` (48 GB je Rolle).
12. Modell-Identität `brain`: `Qwen/Qwen3-14B-AWQ` (vLLM/OpenAI-Pfad) vs. `qwen3-14b` (`LlmRouter.ts:86`) vs. `qwen3-30b-a3b-awq` (Manifest/Registry) → Befund V3-6.
13. Endpoint-**Name** vs. Endpoint-**ID**: `endpointNameForRole()` (`aiInfrastructure.ts:121-123`) und die IDs aus Env (`endpointRegistry.ts:293-307`) werden nie gegeneinander geprüft → Befund V3-2.
14. Zwei Aufrufwege für dieselben Visual-Endpoints: `RunPodProvider` (rollenbasiert, mit Retry/Circuit-Breaker) und die eigenen Clients `runpodVision.ts`/`runpodVideo.ts` (`:50`/`:54`) → Befund V3-5.

**Fehlende Tests / fehlende Gates (in diesem Audit belegt)**
15. Kein Test prüft `runpod-deploy.py:ROLE_DEFAULTS` gegen `model_manifest.json` (Befund V4-3).
16. Kein Test prüft die aufgelösten `RP_ENDPOINT_ID_*` gegen die Live-Endpoint-Namen (Befund V3-2). Positiv (in dieser Runde per Augenschein geprüft, **kein** automatisiertes Gate): die acht Rollen-IDs in der lokalen `.env` stimmen 1:1 mit den acht Live-Endpoints überein — `RP_ENDPOINT_ID_BRAIN=ppxo7wrn599p0q`, `_EARS=xeax6xrgd0csag`, `_VOICE=gajmangfldpzrk`, `_MUSIC=vsbjhw0nnnb47e`, `_IMAGE=wzh9hcbitjnn95`, `_VIDEO_REAL=6ghy4fh00zb0j9`, `_VIDEO_ABSTRACT=fogwdyxp1zj8zv`, `_ORCHESTRATOR=xu4sqszdfk8lp8`. Ein Legacy-`RP_ENDPOINT_ID` ist in der `.env` **nicht** gesetzt → Befund V3-1 ist im Live-Bestand nicht aktiv.
17. `assertFleetHourlyBudget`/`assertStorageBudget`/`estimateFleetEurPerHour` sind getestet, aber unverdrahtet (Befund V3-7/V4-8) — Testabdeckung ohne Wirkung.
18. Kein Gate zählt Endpoints vor dem Deploy (Befund V4-8).
19. Der Rollen→Task-Vertrag im Worker ist untested und unerzwungen (Befund V2-3).

**Veraltete Doku**
20. SSOT: `fundamentals.aiFleet` „3 Endpoints live" vs. 8 live (Befund S-2); `visionLive.endpointName` „audiomonastry-ai-vision" existiert nicht (Befund S-3); `architectureDecisions[8]` „max. 4" vs. `budget.fleetEndpointsMax: 5` (Befund S-1).
21. `Dockerfile.runpod:3-7` („drei Flotten-Rollen"), `runpodProvider.ts:5-14` („Die Flotte besteht aus drei Rollen" + Auflistung von acht), `providerRouter.ts:58-61` („3-Rollen-GPU-Flotte"), `handlers_runpod.py:6,8,14` (Qwen3-14B, XTTS-v2, H200), `registry.py:175` und `runtime_config.yaml:5` (H200).
22. `runpod-deploy.py:9-16` (Header-Tabelle: 900 s Idle und `AMPERE_48` für die Video-Rollen) widerspricht dem eigenen `ROLE_DEFAULTS` (`:105, 109, 114, 121, 130`) bzw. der eigenen Prosa `:18-31` (120 s) — ein Widerspruch **innerhalb einer Datei**.
23. `model_manager.py:10` („Parallele identische Load-Requests werden dedupliziert") widerspricht `model_manager.py:254-255`.
24. `docs/AI_COST_GUIDE.md:30` nennt „max. 4–5 €/h bei aktiver Inferenz" — eine **vierte** Kostenobergrenze neben 4 Endpoints (SSOT), 5 Endpoints (SSOT-Budget), 8 Endpoints/10 €/h (`aiInfrastructure.ts:19-20`).

---

## 9. Befund-Index nach Schwere

### HOCH
| ID | Befund | Beleg |
|---|---|---|
| S-1 | SSOT widerspricht sich selbst: „max. 4 GPU-Endpoints" vs. `fleetEndpointsMax: 5` | `MASTERTODOENDE.json` `architectureDecisions[8]` vs. `budget.fleetEndpointsMax` |
| S-2 | SSOT-Live-Stand veraltet: „3 Endpoints live" / „vision geplant" gegen 8 live | `MASTERTODOENDE.json` `fundamentals.aiFleet` vs. `REST /v1/endpoints` (Abschnitt 4.1) |
| Live-1 | Kostenkonstitution live gebrochen: 8 Endpoints statt 4/5 | Abschnitt 4.1/4.2 |
| V1-1 | Zwei divergente GPU-Pool-Wahrheiten für `videoReal`/`videoAbstract` | `runpod-deploy.py:120,129` vs. `model_manifest.json:1225,1249` |
| V3-1 | Legacy-Fallback kann alle acht Rollen auf eine Endpoint-ID biegen | `endpointRegistry.ts:294-305`, `runpodProvider.ts:142-144` |
| V3-6 | Brain hat drei divergente Modell-Identitäten, eine davon ohne Manifest-Eintrag | `LlmRouter.ts:86,318` vs. `model_manifest.json` roles.brain vs. `LlmRouter.ts:75` |
| V4-2 | CI-Env `RUNPOD_GPU_ID: AMPERE_48` global überschreibt die Video-Rollen-Defaults | `.github/workflows/runpod-deploy.yml:211-212` + `runpod-deploy.py:462` |
| V4-3 | Zwei grüne Tests kodieren widersprüchliche Hardware-Wahrheiten für dieselben Rollen | `tests/test_runpod_deploy_defaults.py:76-79` vs. `tests/manifestRoles.test.ts:52` |
| V4-8 | Kosten-Grenze wird nirgends technisch erzwungen (einziger Guard selbstneutralisierend) | `aiInfrastructure.ts:75,129-137`, `providerRouter.ts:71`, `runpod-deploy.py:491-509` |

### MITTEL
| ID | Befund | Beleg |
|---|---|---|
| S-3 | `visionLive` beschreibt anderen Endpoint/Modell als die ID live zeigt | `MASTERTODOENDE.json visionLive` vs. Abschnitt 4.1 |
| S-4 | `fleetState2026_09_11` = Hetzner, in derselben SSOT wie die RunPod-Aussagen | `MASTERTODOENDE.json fleetState2026_09_11` / `budget.hetznerFleet` |
| V1-2 | Zwei VRAM-Budgets (141/8 vs. 48/6) ohne Auflösungsregel | `runtime_config.yaml:5-6` vs. Manifest `runtime` |
| Live-2 | `idleTimeout` live 120 s statt deklariert 900 s (6 von 8 Rollen) | `runpod-deploy.py:11-16` vs. Abschnitt 4.1 |
| Live-3 | Live-Name `audiomonastry-ai-image` ≠ SSOT-Name `audiomonastry-ai-vision` | Abschnitt 4.1 vs. `visionLive.endpointName` |
| Live-4 | GPU-Pool `AMPERE_48` enthält live fünf GPU-Klassen (inkl. Ada/L40) | Abschnitt 4.1 `gpuTypeIds` |
| V2-1 | `runtime_config.yaml` wird im Serverless-Pfad von keinem Skript gelesen | `Dockerfile.runpod:128` + kein `runtime_config`-Vorkommen in `runpod_worker.py`/`model_manager.py`/`registry.py` |
| V2-2 | Worker-Fehlerdetails per Default unterdrückt (`AI_RUNTIME_DEBUG=0`) | `runpod_worker.py:81-94`, `runpod-deploy.py:206` |
| V2-3 | Rollen→Task-Vertrag im Worker ungeprüft | Docstring `runpod_worker.py:14-18` vs. `runpod_worker.py:380` |
| V2-5 | Paralleler identischer Load = Fehler, nicht Dedup | `model_manager.py:254-255` vs. Docstring `:10` |
| V2-6 | Manifest-Modell-`timeout` wird nie durchgesetzt | `model_manager.py:89,156` (kein Konsument) |
| V3-2 | Konfigurierte Endpoint-ID wird nie gegen den Namen geprüft | `aiInfrastructure.ts:121-123` (kein Abgleich) |
| V3-3 | `roleReady()` meldet fehlende Konfiguration als Erfolg | `fleetWake.ts:179-183, 215` |
| V3-4 | `wakeFleet()` weckt immer alle acht Rollen, ohne Kosten-Gate | `fleetWake.ts:201,213` |
| V3-5 | Visual-Rollen umgehen den gemeinsamen Provider-/Breaker-Pfad | `runpodVision.ts:50`, `runpodVideo.ts:54`, `aiRoutes.ts:39-40` |
| V4-1 | Smoke kann für 4 Rollen „grün" ohne Job liefern | `runpod-smoke.py:93, 118-123` |
| V4-4 | Idle-Timeout-Einheit (Minuten im Workflow, Sekunden im Skript) widersprüchlich | `.github/workflows/runpod-deploy.yml:11-15, 214-215` vs. `runpod-deploy.py:467` |
| V4-5 | HF-Regel „MAXIMAL 1 A100" ist Prosa, kein Gate | `hf_manage_endpoint.py:16-20` |
| V4-6 | Gewichte werden nicht ins Image gebacken, obwohl Doku/Dockerfile das nahelegen | `.github/workflows/runpod-deploy.yml:84, 67-73` vs. `Dockerfile.runpod:88-121` |
| V4-9 | Kostenschätzung pauschal 0,39 USD/h für jede Rolle, Video real 1,10–1,58 USD/h | `runpodProvider.ts:50-62,152-156` vs. `runpod-deploy.py:119` |
| V5-9/10/11/12/13/14 | Vierfache Rollen-Definition, doppelte GPU-/VRAM-/Modell-/Namens-Quellen | siehe Abschnitt 8 |

### NIEDRIG
| ID | Befund | Beleg |
|---|---|---|
| V1-3 | Rest-Doku/Kommentare verweisen auf H200-Hardware | `runtime_config.yaml:5`, `registry.py:175`, `handlers_runpod.py:14` |
| Live-5 | `locations: null` bei allen Endpoints → keine RZ-Bindung planbar | Abschnitt 4.1 |
| V2-4 | `Dockerfile.runpod` beschreibt noch 3 Rollen | `Dockerfile.runpod:3-7` |
| V2-7 | `warmup` nicht idempotent, `predownload` schon | `runpod_worker.py:168-174` vs. `:262-303` |
| V4-7 | Kein Network Volume an keinem Live-Endpoint, Bake läuft nicht | Abschnitt 4.1 + `runpod-deploy.py:510` + Workflow `:84` |
| V5-4…7 | Hartcodierte Endpoint-IDs in vier Skripten (zwei davon auf gelöschte Endpoints) | `runpod-brain-openai-test.py:19`, `runpod-brain-vllm.py:26`, `runpod-vision-test.py:79`, `runpod-vllm-brain-test.py:49` |
| V5-20…24 | Veraltete Doku an 5 Stellen | siehe Abschnitt 8 |

---

## 10. Offene Punkte / Nicht verifiziert

| # | Punkt | Status |
|---|---|---|
| O-1 | Objektiv gemessene Ist-Kosten der Flotte (USD/h) | **NICHT gemessen.** In diesem Audit wurde nur die Endpoint-Liste abgerufen, nicht `runpodctl user`/Billing. Die Zahl aus `budget.fleetEndpointsNote` („~2,35 EUR/h bei Vollbetrieb") ist **übernommen, nicht nachgerechnet**. |
| O-2 | Image-Tag/Registry-Pfad der live laufenden Endpoints | **NICHT verifiziert.** Die REST-Antwort (Abschnitt 4.1) enthält nur `templateId`, nicht das Image. Ob die Live-Endpoints das in `budget.runpodCurrentImage` genannte GHCR-SHA oder ein neueres Image ziehen, ist offen. |
| O-3 | Tatsächlicher Inhalt der Live-Templates (Env `AI_ROLE`, `MODEL_NAME`, `AI_RUNTIME_DEBUG`, Container-Disk) | **NICHT verifiziert** (kein Template-Abruf in diesem Audit). Damit ist z. B. offen, ob `AI_ROLE` auf den Live-Endpoints korrekt gesetzt ist. |
| O-4 | Ausgeführter Zustand: sind die acht Endpoints aktuell *erreichbar und funktionsfähig* (Job-Probe)? | **NICHT ausgeführt.** Der Audit war lesend und hat **keinen** Job gefeuert (kein `scripts/runpod-smoke.py`-Lauf, um keine GPU-Stunden zu erzeugen). |
| O-5 | `docs/runpod-8-instances-complete-plan.md` als Soll-Architektur | **NICHT gelesen** (40 KB; nur über Zitate `runpod-deploy.py:6` und `aiInfrastructure.ts:27` referenziert). Ein Abgleich Doku-Plan ↔ Code steht aus. |
| O-6 | `src/core/ai/orchestrator/mcpRuntime.ts` / `mcp_runtime.py` (Orchestrator→Fach-Endpoints) | **NICHT im Detail geprüft.** Belegt ist nur die Env-Durchreichung (`runpod-deploy.py:220-254`). |
| O-7 | Die Rolle `orchestrator` (Task `agent.orchestrate`, eigener Endpoint live) | **Kein Vorkommen in der SSOT** (Abschnitt 4.3) — ob das Absicht oder Doku-Lücke ist, ist offen. |
| O-8 | Verhalten bei `RP_API_KEY`-Guthaben = 0 | **NICHT live geprüft.** Der Code-Pfad ist belegt (`runpodProvider.ts:329-331`), ein echter 402 wurde nicht provoziert. |
| O-9 | Alerting auf Flotten-Kosten (`prometheus-alerts.yml`) | **NICHT geprüft** (nur der Dateiname im MASTERTODOENDE-Changelog). |
| O-10 | Es wurden **keine** Tests/Builds ausgeführt (Vorgabe: kein repo-weites Gate). Alle Testaussagen sind Code-/Dateilese-Belege, keine Laufzeitbelege. | per Vorgabe |

---

**Erstellung:** fortlaufend während des Audits. Es wurde **kein** Quellcode geändert und **nichts** committet; angelegt wurde ausschließlich diese Datei. Tokens/Keys wurden zu keinem Zeitpunkt ausgegeben. `git status` nach Abschluss: unveränderter Baum außer den nicht getrackten Audit-Berichten.

### Anhang: Reproduktion des Live-Belegs

```bash
# Schlüssel NICHT sourcen, nur selektiv parsen und nie ausgeben:
RPK=$(grep -E '^RP_API_KEY=' .env | head -1 | cut -d= -f2-)
curl -s -H "Authorization: Bearer $RPK" https://rest.runpod.io/v1/endpoints
```

Ausgewertete Felder je Endpoint: `id`, `name`, `templateId`, `gpuTypeIds`, `workersMin`, `workersMax`, `idleTimeout`, `networkVolumeId`, `scalerType`, `scalerValue`, `locations`. Die vollständige, auf diese Felder reduzierte Antwort steht in Abschnitt 4.1. Ein Abruf der Templates (`/v1/templates`) zur Prüfung von `AI_ROLE`/Image wurde **nicht** durchgeführt (offener Punkt O-3).
