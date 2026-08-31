# audioMONASTRY – Hugging Face Setup

> Endpoint + Serverless + Gewichte-Cache.

## 1. Account

- Bezahltes Hub-Abo nötig für Dedicated Endpoints (PRO $9/Monat) + Zahlungsmittel.
- GPU-Wechsel nur mit Betreiber-Freigabe.

## 2. Token

- `HF_TOKEN` (read) für Gewichte-Download im Container + Endpoint-Auth.
- `HF_API_KEY` bleibt für Serverless-Inference (bestehender Voice-/LLM-Pfad).
- Tokens niemals ins Image, niemals mit `VITE_`-Prefix.

## 3. Endpoint

Siehe `services/samplemonk-ai-runtime/hf_endpoint.example.json`:
A100 ×1 (80 GB, AWS), min 0/max 1 Replicas, Scale-to-Zero, Idle 20 min.
Kaltstart: während des Hochfahrens liefert HF 502 → Orchestrator retried mit
Backoff (1/2/4/8/16 s).

## 4. Gewichte-Cache

- `HF_HOME=/data/hf-cache` (persistentes Volume).
- Revision-Pinning im `model_manifest.json`: echte Commit-Hashes gepinnt (2026-08-31).
- Keine Gewichte ins Image backen; keine manuelle Installation.

## 5. Modelle

Kanonische Liste: `docs/HF_MODEL_CAPABILITY_MATRIX.md`.
Ladeklassen: CORE (AST, Whisper), FREQUENT (CLAP, MusicGen-small, MMS-TTS),
ON_DEMAND (MusicGen-medium, Bark, PyAnnote), RARE (Qwen-Omni).
