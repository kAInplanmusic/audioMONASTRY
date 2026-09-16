# RunPod Model Handler Spec

> Ergänzung zu `docs/RUNPOD_AI_V1_SPEC.md`
> Ziel: pro AI-Modell den exakten Handler-Vertrag, Abhängigkeiten und Status festhalten.

## Handler-Vertrag

Alle Handler laufen im RunPod Worker (`services/audiomonastry-ai-runtime/runpod_worker.py`)
und nutzen `model_manager.infer(task, model_id, payload)`.

Eingang:

```json
{
  "task": "tts",
  "model": "xtts-v2",
  "input": { "...": "modellspezifisch" }
}
```

Ausgang (klein): direktes JSON.
Ausgang (groß): R2-URL(s), die der Worker vorher hochgeladen hat.

## Modell-Handler Übersicht

| Task | Modell-ID | Handler | Abhängigkeit | Status |
|---|---|---|---|---|
| `llm` / `nlu` | `qwen3-14b` | `qwen3_llm` | transformers >= 4.57 (Qwen3), torch | offen |
| `audio.understand` | `qwen2-audio-7b` | `qwen2_audio_understand` | transformers (Qwen2Audio), torch | offen |
| `tts` | `xtts-v2` | `xtts_tts` | TTS (Coqui), torch | offen |
| `sing` | `bark` oder ACE-Step | `sing_dispatch` | transformers / acestep | offen |
| `song` | `acestep-v15-xl-turbo` | `acestep_generate` | transformers/diffusers + acestep | offen |
| `audio.generate` | `stable-audio-open-1.0` | vorhanden `hf_stable_audio` | diffusers | vorhanden |
| `audio.transcribe` | `whisper-large-v3` | vorhanden `hf_transcribe` | transformers | vorhanden |
| `audio.diarize` | `pyannote-diarization` | `pyannote_diarize` | pyannote.audio | offen |
| `audio.analyze` | `essentia` | `essentia_analyze` | essentia, soundfile, numpy | offen |
| `audio.embed` | `clap-music` | vorhanden `hf_embed` | transformers | vorhanden |
| `audio.classify` | `ast-audioset` | vorhanden `hf_classify` | transformers | vorhanden |
| `stem.separate` | `bs-roformer` / `demucs` | `stem_separate_dispatch` | audiosep/demucs | offen |

## Orchestrator (Instanz 8): `agent.orchestrate`

| Task | Rolle | Handler | Modell(e) | Status |
|---|---|---|---|---|
| `agent.orchestrate` | orchestrator | `moa_orchestrate` (`moa_orchestrator.py`) | `qwen3-4b` (Classifier), `llama-32-3b` + `gemma-3-4b` (Planner A/B), `mistral-small-31` (Aggregator) | implementiert, GPU-Verifikation offen |

Ablauf: **Classifier → Planner A/B (unabhaengig) → Aggregator → optionale
MCP-Ausfuehrung**. Die Plan-Logik ist ohne GPU testbar
(`tests/test_moa_orchestrator.py`, 27 Tests); die Inferenz nutzt denselben
LLM-Pfad wie das Brain (`handlers_runpod.generate_chat`).

Eingang:

```json
{ "task": "agent.orchestrate", "model": "mistral-small-31",
  "input": { "prompt": "Baue einen Techno-Drop aus track.wav",
             "execute": true } }
```

Ausgang: `{ classification, plans: {a, b}, choice, reason, steps[], execution[]? }`.

Die MCP-Bruecke adressiert die Fach-Instanzen ueber `RP_ENDPOINT_ID_*` (das
Deploy-Skript reicht sie der Orchestrator-Rolle durch). `ears.*`/`voice.*`
sprechen unser `{task, model, input}`-Protokoll.

## ComfyUI-Adapter (Instanz 5/6/7 + music)

`music`/`image.*`/`video_*.*` laufen auf vorgefertigten Hub-Workern. Der
`comfyui_adapter.py` uebersetzt in beide Richtungen:

| Rolle | Worker | Protokoll | Antwortform (live gepinnt 2026-09-16) |
|---|---|---|---|
| `music` | ACE-Step 1.5 XL | Workflow | `files[]` (`kind: audio`); `{health_check:true}` → `system_stats` + `usage` |
| `videoAbstract` | Wan2.2 `wlsdml1114/generate-video-ksampler` (seit 2026-09-16, vorher: generischer worker-comfyui **ohne Gewichte**) | Prompt | `video` = rohes base64 MP4 (H.264, 480×720, 5,03 s im Probelauf) |
| `videoReal` | wlsdml1114 (Repo offline) | Prompt | `video` = **rohes base64 MP4** (kein `data:`-Praefix) |
| `imageHq` | PrunaAI FLUX (Repo offline) | Prompt | `image_url` **und** `images[0]` mit demselben `data:image/png`-URI, dazu `seed` |

Workflow-JSONs werden je Rolle aus `COMFY_WORKFLOW_<ROLLE>`, `workflows/<rolle>.json`
oder inline im Job geladen – siehe `services/audiomonastry-ai-runtime/workflows/README.md`.
Fehlt ein Workflow, meldet der Adapter das explizit statt still zu scheitern.
Die zwei nicht mehr oeffentlich dokumentierten Worker hat
`scripts/runpod-comfyui-probe.py --out <datei>` mit je einem Live-Job festgepinnt; die
Rohantworten liegen unter `logs/probes/`. `--out` schreibt die vollstaendige Antwort
(vorher war die Ausgabe bei 4000 Zeichen gedeckelt, also mitten im base64 zu Ende).


## R2-Audio-Transfer

Für große Audio-Dateien (Upload, Stems, Songs) gilt:

1. `server.ts` lädt Input nach R2 hoch und erzeugt **Signed GET URL**.
2. Worker erhält `input.audioUrl` statt Base64.
3. Worker lädt Datei herunter (validierter Host), verarbeitet sie.
4. Worker lädt Ergebnis per **Signed PUT URL** nach R2 hoch.
5. Worker gibt `result.outputUrl`/`result.stems.*` als R2-URLs zurück.

Damit braucht der Worker keine R2-Credentials.

## Manifest-Einträge (Muster)

```json
{
  "id": "qwen3-14b",
  "repository": "Qwen/Qwen3-14B",
  "revision": "40c069824f4251a91eefaf281ebe4c544efd3e18",
  "task": "llm",
  "framework": "transformers",
  "estimatedVRAM": 16000,
  "loadClass": "FREQUENT",
  "preload": false,
  "quantization": "int8",
  "license": "Apache-2.0",
  "trustRemoteCode": false
}
```

**`trustRemoteCode`** (Default `false`, nur echte Booleans) steuert, ob der
gemeinsame LLM-Lader den **Repo-eigenen** Modellcode lädt oder die native
Klasse aus `transformers`. Er ist bewusst **opt-in**: Repo-Code ist auf den
transformers-Stand seines Entstehungszeitpunkts geeicht und bricht auf neueren
Ständen. Live belegt am 2026-09-15 (Image `:moa-comfy-v5`): `microsoft/Phi-3.5-mini-instruct`
(Revision `2fe19245…`) liefert `modeling_phi3.py` mit, das in
`prepare_inputs_for_generation` `past_key_values.seen_tokens` liest — das
Attribut hat transformers ≥ 4.54 entfernt. Mit `trust_remote_code=true` starb
jeder Planungslauf mit `AttributeError: 'DynamicCache' object has no attribute
'seen_tokens'`; mit `false` lädt die native `Phi3ForCausalLM`. Vor `true` also
prüfen, ob `transformers.AutoConfig.from_pretrained(repo, trust_remote_code=False)`
eine native Klasse liefert (`transformers.models.<arch>` statt
`transformers_modules.<repo>`).

Weitere bekannte Revisions:
- `coqui/XTTS-v2` → `6c2b0d75eae4b7047358e3b6bd9325f857d43f77`
- `Qwen/Qwen2-Audio-7B-Instruct` → `0a095220c30b7b31434169c3086508ef3ea5bf0a`
- `Qwen/Qwen3-14B` → `40c069824f4251a91eefaf281ebe4c544efd3e18`
- `ACE-Step/acestep-v15-xl-turbo` → SHA noch ermitteln
- `ACE-Step/Ace-Step1.5` → SHA noch ermitteln

## Priorisierung Handler-Implementierung

1. `essentia_analyze` (CPU, kein großes Modell, schnell testbar)
2. `qwen3_llm` (transformers, Chat)
3. `qwen2_audio_understand` (transformers, Audio-Chat)
4. `xtts_tts` (Coqui TTS)
5. `acestep_generate` (Song/Music)
6. `stem_separate_dispatch` (Demucs + BS-RoFormer)
7. `pyannote_diarize`
