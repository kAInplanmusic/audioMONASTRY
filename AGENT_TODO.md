# AGENT_TODO – Background-Coder Pipeline (HF + Cerebras #7)

Aktualisiert: 2026-09-05T22:36:21.715Z


TASK-025
CLASS: SCHWER
DOMAIN: AUDIO
DESCRIPTION: **CEREBRAS-1 · HOCH · V2-Echtzeit-Parität** – `V2StudioGraph`/`AudioGraph` als vollwertigen Echtzeit-Pfad neben `audioEngine` verdrahten oder bewusst zurückbauen; @deprecated V2/Native-Backends entscheiden (Umsetzung oder Löschung); Details in `VISIONS_TODO.md`.
IMPLEMENTATION_AGENT: #7
MODEL: gpt-oss-120b
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: COMPLETED

TASK-026
CLASS: SCHWER
DOMAIN: AUDIO
DESCRIPTION: **CEREBRAS-2 · HOCH · audioEngine-Monolith modularisieren** – `src/utils/audioEngine.ts` (2814 Zeilen) in Graph-Aufbau / Worklet-Factory / Routing / Monitoring schneiden; Kernpfad-Coverage erhöhen.
IMPLEMENTATION_AGENT: #7
MODEL: gpt-oss-120b
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: COMPLETED

TASK-027
CLASS: SCHWER
DOMAIN: BACKEND
DESCRIPTION: **CEREBRAS-3 · HOCH · dropMONK-Berechnung/Compute** – Drop-Physik-/Bounce-/Hit-Logik für dropMONK als deterministischen Kern ausarbeiten (SFZ/Voice-Management vorhanden) + Tests.
IMPLEMENTATION_AGENT: #7
MODEL: gpt-oss-120b
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: PENDING

TASK-028
CLASS: SCHWER
DOMAIN: AUDIO
DESCRIPTION: **CEREBRAS-4 · HOCH · DSP-Kernel-Deep-Dive** – Early-Reflections-Worklet-Integration, Oversampling-Entscheidung per Benchmark (Half-Band 2×), WebGPU-Kernel-/Rust-Mixer-Evaluierung (siehe `VISIONS_TODO.md`).
IMPLEMENTATION_AGENT: #7
MODEL: gpt-oss-120b
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
STATUS: PENDING

BLOCK-001
CLASS: SCHWER
DOMAIN: SECURITY
DESCRIPTION: **OG-2 · HOCH · Shell-Injection in GitHub-Actions-Run-Steps** – `.github/workflows/live-stress.yml:29,32`: `${{ inputs.base_url }}` nicht direkt in `run:` interpolieren, sondern via `env:` übergeben.
IMPLEMENTATION_AGENT: #7
MODEL: gpt-oss-120b
REVIEW_AGENT: #6
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED

BLOCK-002
CLASS: SCHWER
DOMAIN: SECURITY
DESCRIPTION: **OG-3 · HOCH · Script-Injection in actions/github-script** – `.github/workflows/live-stress.yml:46`: `github`-Context-Daten nicht direkt im `script:` interpolieren.
IMPLEMENTATION_AGENT: #7
MODEL: gpt-oss-120b
REVIEW_AGENT: #6
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED

BLOCK-003
CLASS: MITTEL
DOMAIN: DATABASE
DESCRIPTION: **OG-5 · MITTEL · 2x dynamic-urllib** – `scripts/hetzner/dns_setup.py:43`, `scripts/hetzner/provision.py:48`: URL-Schema-/Host-Allowlist + Validierung.
IMPLEMENTATION_AGENT: #2
MODEL: moonshotai/Kimi-K2.7-Code
REVIEW_AGENT: -
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED
