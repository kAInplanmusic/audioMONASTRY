# RunPod Model Handler Spec

> Ergänzung zu `docs/RUNPOD_AI_V1_SPEC.md`
> Ziel: pro AI-Modell den exakten Handler-Vertrag, Abhängigkeiten und Status festhalten.

## Handler-Vertrag

Alle Handler laufen im RunPod Worker (`services/samplemonk-ai-runtime/runpod_worker.py`)
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
  "license": "Apache-2.0"
}
```

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
