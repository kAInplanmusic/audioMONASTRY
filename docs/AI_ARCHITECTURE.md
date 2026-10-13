# audioMONASTRY – AI-Architektur

> **Verbindlich:** `AGENTS.md` (Technik), `PRINCIPLES.md` (Haltung),
> `docs/AI_FLEET_STARTPLAN.md` (Pod-/Modell-Zielbild und Start-Trigger).
> Diese Datei ist die Übersicht der AI-Schichten und ihrer Zuständigkeiten; die
> Zahlen je Modell stehen im Manifest (`services/audiomonastry-ai-runtime/model_manifest.json`)
> und im Zielbild (`src/config/aiInfrastructure.ts` → `AI_RESIDENT_FLEET`).

## Schichten

| Schicht | Ort | Aufgabe |
|---|---|---|
| Planung (client-/appseitig) | `src/core/ai/MoaAgent.ts`, `src/core/ai/orchestrator/` | Aufgabe → Plugin-Schritte, UI-nah, ohne GPU |
| Brücke | `src/core/ai/orchestrator/mcpRuntime.ts` | MCP-Tools, Permissions, die EINE Kante zur Server-Seite |
| Ausführung (serverseitig) | `services/audiomonastry-ai-runtime/` (FastAPI-Runtime auf den Pods) | Jobs, Modell-Handler, Rollen-Routing |
| Flotte | `deploy/runpod/pod-fleet.json`, `scripts/runpod-pods.py` | 5 Pods RP1–RP5 (brain, ears, music, voice, stems) |

Rollen und Modelle: RP1 brain (Steuerung/Executor), RP2 ears (ASR, Audio-LLM,
Diarisierung, Embeddings, Struktur/Beat), RP3 music (ACE-Step), RP4 voice
(TTS/SFX/LEGO), RP5 stems (Trennung). Start-Trigger je Pod: `startTrigger` in
`deploy/runpod/pod-fleet.json` (`always`, `aiGeneration`, `stemMONK`), ausgelöst
von `src/core/ai/orchestrator/podStartTriggers.ts`.

## Hetzner-Flotte (4 Rollen, ohne GPU)

Typ je Rolle per `FLEET_TYPE_<ROLLE>` überschreibbar; Vorgabe im Skript
`scripts/hetzner/provision-fleet.sh`. Verbindliche Tabelle: `docs/SERVER_FLEET.md`.

| # | Knoten | Typ | Rolle |
|---|---|---|---|
| 1 | app-1 | cx43 | App/API/Signaling + master-player + TURN, Floating IP |
| 2 | sfu-1 | cx33 | Mediasoup-SFU (UDP/TCP 40000–40099) |
| 3 | media-1 | cx43 | R2-Sync-Worker + Audio-Streaming-Cache |
| 4 | edge-1 | cx23 | Monitoring-Stack (Prometheus/Grafana) |

GPU-Inferenz läuft **nicht** auf diesen Knoten, sondern auf den RunPod-Pods
(RP1–RP5, s. o.).

**Produkt-AI läuft lokal auf der eigenen GPU-Flotte.** Cloud-Anbieter sind aus dem
Code entfernt; einzige Ausnahme ist DeepSeek V4 per `AI_EXTERNAL_LLM_ALLOWLIST`
(Notfall/Zweitmeinung). Ein Modell gilt erst als ausgerollt, wenn es im Manifest
ohne `status: "neu"` steht und in `pod-fleet.json` einer Rolle zugeordnet ist –
**kein stiller Modellwechsel**.

## MoA-Zuständigkeiten (INFRA-AI-006, Stand 2026-09-20)

„MoA" ist im Projekt genau **zwei** Dinge – bewusst getrennt, ohne gemeinsamen
Code, verbunden über **eine** Kante.

| | MoA-Planung (client-/appseitig) | MoA-Ausführung (serverseitig) |
|---|---|---|
| Datei | `src/core/ai/MoaAgent.ts` | `services/audiomonastry-ai-runtime/moa_orchestrator.py` |
| Aufbau | ein LLM-Call, Schema `[{pluginId, command, prompt}]` | Classifier → Planner A/B → Aggregator → MCP-Tools, Schema `{steps:[{tool,args,why}]}` |
| Ausführung | Client-Plugin-Registry / VoiceControlService | Fach-Rollen der GPU-Flotte |
| Läuft | im App-/Client-Prozess (schnell, UI-nah) | auf der Rolle `orchestrator` |

**Die einzige Kante** ist das MCP-Tool `agent.orchestrate`
(`POST /api/ai/mcp/tools/agent.orchestrate`, Brücke in
`src/core/ai/orchestrator/mcpRuntime.ts`). Wer einen der beiden Wege ändert,
lässt den anderen unberührt; `tests/moaBoundary.test.ts` hält die Rollen und die
Kante fest.

**Entfernt (Legacy, 2026-09-20):** `services/taskWorker.ts` (Datei-Queue
`TASK_QUEUE.json` → `BACKEND_CORE_URL`) war ein dritter, paralleler Pfad ohne
einen einzigen KI-Task-Typ und ohne Produzenten im Repo. Er ist entfernt statt
verbunden; das Muster liegt in der Git-Historie. Der RunPod-Worker
(`services/audiomonastry-ai-runtime/runpod_worker.py`) bleibt bestehen.

## Kosten und Sperren

- AI-Aufpreis der Flotte: Deckel in `AI_MAX_AI_EUR_PER_HOUR` /
  `AI_TARGET_FLEET_EUR_PER_HOUR`; Sperren (AI-Schalter, Kill-Switch, Stundendeckel)
  greifen vor jedem Netzwerkaufruf.
- Zustand und Warteschlangen: `fleetStatus().podStartTriggers` /
  `.podQueues`; Logzeilen `fleet pod ...`. TTS hat Vorrang vor LEGO
  (`src/core/ai/orchestrator/podJobQueue.ts`, `PREEMPTED_BY_TTS`).

## Herkunft

Konzepte dürfen übernommen werden, fremder Code, Texte und Assets nicht –
Nachweis und Lizenzgrundsatz: `docs/KONZEPT_HERKUNFT.md`.
