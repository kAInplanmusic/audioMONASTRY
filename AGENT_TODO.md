# AGENT_TODO – Background-Coder Pipeline

Erzeugt: 2026-09-06T13:32:16.634Z

LEICHT: 0 · MITTEL: 0 · SCHWER: 4 · BLOCKED: 1

Festes Modell-Routing: Orchestrator=DeepSeek V4 Flash Visionary (max thinking) · #2 Kimi K2.7-Code · #3 GLM-5.3 · #4 Qwen3-Coder-Next · #5 GLM-5.3-Flash · #6 DeepSeek V4 Pro · #7 Cerebras GPT-OSS-120B (SCHWER/komplex)
## LEICHT (1-12)


## MITTEL (13-24)


## SCHWER (25-36)


TASK-025
CLASS: SCHWER
PRIORITY: P0/P1
DOMAIN: UX
DESCRIPTION: **PREP-2 · HOCH · CI-Gate** – Workflow `ci.yml`: bei jedem PR `npm run verify` + `vite build` als Pflicht-Check.
IMPLEMENTATION_AGENT: #7
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
REVIEW_REQUIRED: NO
STATUS: PENDING


TASK-026
CLASS: SCHWER
PRIORITY: P0/P1
DOMAIN: SECURITY
DESCRIPTION: **PREP-6 · HOCH · Beat-synced aiMONK/dropMONK-Scheduling** – Drop/Fade an nächste Phrase (Tone.Transport-Events/Worklet-Clock) statt sofort.
IMPLEMENTATION_AGENT: #7
REVIEW_AGENT: #6
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
REVIEW_REQUIRED: YES
STATUS: PENDING


TASK-027
CLASS: SCHWER
PRIORITY: P0/P1
DOMAIN: BACKEND
DESCRIPTION: **PREP-7 · HOCH · midiMONK Mapping-Persistenz + Digitakt-16-Step-Editor** – Routing-Ansicht je Gerät, Pattern-Editor verdrahten.
IMPLEMENTATION_AGENT: #7
REVIEW_AGENT: -
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
REVIEW_REQUIRED: NO
STATUS: PENDING


TASK-028
CLASS: SCHWER
PRIORITY: P0/P1
DOMAIN: SECURITY
DESCRIPTION: **PREP-8 · MITTEL · Observability/Security-Betrieb** – Signaler-Logs → /api/telemetry, Alerting, HF-Secret-Rotation als Runbook.
IMPLEMENTATION_AGENT: #7
REVIEW_AGENT: #6
SERVER_REQUIRED: NO
HARDWARE_REQUIRED: NO
REVIEW_REQUIRED: YES
STATUS: PENDING


## BACKLOG / BLOCKED


BLOCKED
CLASS: SCHWER
DOMAIN: AUDIO
DESCRIPTION: **PREP-1 · HOCH · UI-Regressionstests (Playwright-Snapshots)** – `toHaveScreenshot`-Baselines für Startseite/MixerMONK/Settings/midiMONK + Audio-Health-Assert; GitHub-Action auf PR.
SERVER_REQUIRED: YES
HARDWARE_REQUIRED: NO
STATUS: BLOCKED

