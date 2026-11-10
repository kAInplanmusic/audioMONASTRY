# audioMONASTRY — Aktuelle KI-Architektur (SSOT 2026-11-10)

**Aktuelle GPU-/Modellquellen:**
[RunPod Fleet SSOT](RUNPOD_FLEET_SSOT.md) · [pod-fleet.json](../deploy/runpod/pod-fleet.json) · [model_manifest.json](../services/audiomonastry-ai-runtime/model_manifest.json).

Alte 5-Pod-Pläne, pauschales `8×A40`, Serverless-Rollen `imageHq/videoReal/videoAbstract/orchestrator/audio-gen` und Modelllisten aus September/Oktober sind **historisch und nicht deploybar als die aktuelle Pod-Flotte**.

## Schichten

| Schicht | Ort | Aktueller Vertrag |
|---|---|---|
| App + Audio | Browser (DAW/AudioWorklets) | Audio-Thread bleibt vom GPU-Netzwerk unabhängig |
| Planung | `src/core/ai/MoaAgent.ts` und Orchestrator | Aufgaben in validierte Plugins/Tasks auflösen |
| Brücke | Hetzner-API, `mcpRuntime.ts`, Pod-Routing | Auth, Task-Routing, Job-Persistenz, Resultate |
| Inferenz | RunPod-Pods, `services/audiomonastry-ai-runtime/` | Je Pod nur freigegebene residente Modelle |
| Modelle / GPU | `model_manifest.json` / `pod-fleet.json` | Eindeutige aktive Rollen, Revisionen und GPU-Prioritäten |
| Artefakte | Cloudflare R2 + Supabase | Gewichte und Outputdateien; Verfügbarkeit separat live prüfen |

## Aktive RunPod-Flotte

| Pod-ID | AI_ROLE in der Runtime | GPU-Pool | Zweck |
|---|---|---|---|
| `brain` | `brain` | 48ada | `qwen38-27b-fp8` |
| `ears` | `ears` | 48ada | MOSS-Music, CLAP, Beat, SongFormer und CPU-DSP |
| `voice` | `voiceGen` | 48economy | Qwen-TTS, MOSS-SFX, ACE-Step Base/Shared |
| `music` | `music` | 48ada | ACE-Step Turbo + LM + Shared |
| `studio` | `studio` | 96pro | SonicMaster, 6-Stem RoFormer, MVSEP, BVE |
| `audio-brain` | `executor` | 32fast | Qwen3.5-4B GUI-Kommandos |
| `song` | `song` | 32fast | YuE2-3B |
| `vis` | `vis` | 48economy | UniverSR + DeReverb (Audio-Restauration, **keine** Bild-/Video-KI) |

**Benennung:** `voice` ist die reale Pod-ID, `voiceGen` bleibt eine interne Runtime-/Legacy-API-ID. `audio-brain` ist die reale Pod-ID, `executor` die Runtime-ID. `vis` ist der achte **Audio-Restaurierungs**-Pod und kein Visual-Generator.

Alle acht JSON-Pods besitzen `startTrigger=always`. Dies belegt lediglich die Plan-Konfiguration: ein Live-Start oder GPU-Warmup ist nicht nachgewiesen.

## Kontrolle und finanzielle Limits

- **Hartes Gesamtkostenlimit RunPod:** 8,00 EUR/h (Richtwerte, inkl. konfigurierter Steuer-/Pufferrechnung). **Kein individueller GPU-Preisdeckel.**
- Vor Provisionierung: `scripts/runpod-ssot-preflight.py` → `scripts/runpod-pods.py plan` → R2-Gewichte → GPU-Verfügbarkeit und Live-Preise.
- Produktionsfreigabe erst nach tatsächlich bestandenem Loader-/CUDA-/VRAM-/Audio-/Vierbenutzertest.
- `scripts/runpod-deploy.py` und `.github/workflows/runpod-deploy.yml` gehören zur alten Serverless-Architektur; nicht für diese Flotte verwenden.
- Pod-Lebenszyklus und Jobs dürfen ausschließlich neu erstellte Test-Pods löschen. `runpod-pods.py down --yes` beendet dagegen die gesamte Flotte und ist **kein** sicherer Smoke-Test-Cleanup.

## MoA / Agent-Planung

Die App-Planung über `MoaAgent.ts` ist eine logische Schicht, keine zusätzliche GPU-Instanz. Der alte dedizierte Serverless-`orchestrator` ist nicht mehr Teil der Flotte; KI-Planung liegt auf `brain`, die ausführende GUI-Steuerung auf `audio-brain`. `moa_orchestrator.py` ist bestehender Legacy-/Framework-Code und darf nicht als Beleg für einen neunten aktiven Pod verstanden werden.

## Noch nicht verifiziert

- Im Manifest ist `mel-roformer-bve` noch mit der Kurz-SHA `c73a679` gekennzeichnet. Die vollständige Revision muss mit dem Checkpoint-Hash erfolgreich aufgelöst werden.
- Vollständiger R2-Bestand und SHA256-Prüfung, exakte Container-Builds, CUDA-/Torch-/Loader-Tests, tatsächlich erreichte VRAM-Spitzen und Hörtests sind offene Live-Gates.
- CI-Freigabe und Produktionsstatus werden ausschließlich anhand des konkreten Commit-SHA und der GitHub-Actions-Ergebnisse erteilt.

Siehe [Prüfprotokoll](RUNPOD_LIVE_VERIFICATION_AUDIT_2026-11-10.md).
