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

---

## Stand 2026-08-31 (live)

- **Token:** gültig (Account `AnunnakiTools`, `canPay: true`), Gated-Access PyAnnote verifiziert (HTTP 200).
- **Pilot-Endpoint angelegt:** `samplemonk-ai-pilot` (Status: **running**)
  - URL: `https://yb0zuq4g09cjrqed.us-east-1.aws.endpoints.huggingface.cloud`
  - Modell: `openai/whisper-large-v3` (Revision `06f233fe…`), Task `automatic-speech-recognition`
  - A100 ×1, `minReplicas 0`, `maxReplicas 1`, Scale-to-Zero 20 min, type `authenticated`
  - (eu-central-1 A100 war nicht verfügbar → us-east-1 gewählt; GPU unverändert A100)
  - (AST-Standard-Endpoint scheiterte am HF-Toolkit → durch Whisper ersetzt; AST läuft später im Custom Container)
- **Custom-Container-Endpoint:** wird über GitHub Actions gebaut und angelegt:
  - Workflow: `.github/workflows/hf-endpoint.yml`
  - Image: `ghcr.io/<owner>/samplemonk-ai-runtime` (öffentlich, damit HF pullen kann)
  - Endpoint `samplemonk-ai`, Task `custom`, Health `/health`, A100 ×1 us-east-1,
    Scale-to-Zero 20 min, Secret `HF_TOKEN` für Gated-Gewichte.

### Erforderlicher GitHub-Secret

Damit der Workflow den Endpoint anlegen kann, muss das Token als
Repository-Secret hinterlegt sein:

1. GitHub → Repo `audioMONASTRY` → **Settings → Secrets and variables → Actions**
2. **New repository secret** → Name: `HF_TOKEN` → Wert: das HF-Token
3. Speichern. Danach Workflow `hf-endpoint` ausführen (Actions → Run workflow).

## GPU-Konsolidierung (2026-08-31) – maximal 1 A100

**Harte Kostenregel:** NIEMALS mehr als eine A100 gleichzeitig.

- **Einziger GPU-Endpoint:** `samplemonk-ai` (Custom Container,
  `services/samplemonk-ai-runtime`) – alle Modelle laufen dort über den
  gemeinsamen Model Manager.
- **Migrierte Services:** Whisper (ehem. `samplemonk-ai-pilot`), CLAP
  (ehem. `samplemonk-ai-clap`), AST, MusicGen-small/medium, MMS-TTS, Bark,
  PyAnnote, Qwen-Omni.
- **Deaktivierte GPU-Endpoints:** `samplemonk-ai-pilot`, `samplemonk-ai-clap`
  – entfernen mit:
  ```bash
  HF_TOKEN=hf_... python services/samplemonk-ai-runtime/hf_manage_endpoint.py delete-legacy
  ```
- **Guard:** `hf_manage_endpoint.py` erlaubt nur noch `samplemonk-ai`
  (`AI_MAX_GPU_ENDPOINTS=1`); ProviderRouter registriert
  `HfStandardEndpointProvider` nicht mehr.
- **Verifikation:** `scripts/hf-single-gpu-check.sh`
